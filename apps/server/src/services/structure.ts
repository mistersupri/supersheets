import { adjustFormulaForStructure, shiftA1, shiftFrozen, shiftMetadata, type SheetMetadata, type StructureOp } from '@opensheet/engine';
import { config } from '../config';
import { prisma } from '../db';
import { badRequest, forbidden, notFound } from '../lib/http';
import { can, type Role } from './access';
import { lockRevision, writeSnapshot, type RevisionChanges } from './cells';

export const MAX_INSERT = 10_000;

/**
 * Inserts or deletes rows/columns with set-based SQL, so the cost does not grow
 * with the number of cells that move. Formulas anywhere in the workbook that
 * point at the sheet are rewritten; metadata and rule ranges shift with it.
 */
export async function applyStructure(input: { workbookId: string; sheetId: string; userId: string; role: Role; clientId: string; op: StructureOp }) {
  const { workbookId, sheetId, op } = input;
  if (op.count === 0) throw badRequest('Jumlah tidak boleh nol');
  if (op.count > MAX_INSERT) throw badRequest(`Maksimal ${MAX_INSERT} baris/kolom sekaligus`);
  const axisCol = op.axis === 'row' ? 'row_index' : 'column_index';
  const del = op.count < 0 ? -op.count : 0;

  return prisma.$transaction(
    async (tx) => {
      const current = await lockRevision(tx, workbookId);
      const ws = await tx.worksheet.findFirst({ where: { id: sheetId, workbookId }, include: { metadata: true, dataValidations: true, conditionalFormats: true, protectedRanges: true } });
      if (!ws) throw notFound('Worksheet tidak ditemukan');
      if (!can(input.role, 'manage')) {
        const blocking = ws.protectedRanges.filter((p) => !p.editorIds.includes(input.userId));
        if (blocking.length) throw forbidden('Sheet ini memiliki rentang yang dilindungi. Hanya pemilik atau pengelola yang dapat menyisipkan atau menghapus baris dan kolom.');
      }

      // 1. Remove deleted cells (kept in the revision so history can restore them).
      const deleted: RevisionChanges['deleted'] = [];
      if (del) {
        const rows = await tx.$queryRawUnsafe<{ row_index: number; column_index: number; raw_value: string | null; style_id: string | null }[]>(
          `DELETE FROM cells WHERE worksheet_id = $1::uuid AND ${axisCol} >= $2 AND ${axisCol} < $3 RETURNING row_index, column_index, raw_value, style_id`,
          sheetId,
          op.index,
          op.index + del,
        );
        for (const r of rows) deleted.push({ r: r.row_index, c: r.column_index, e: [r.raw_value ?? '', r.style_id] });
      }
      // 2. Shift in two steps through negative values so the unique index never clashes mid-update.
      const from = op.count > 0 ? op.index : op.index + del;
      await tx.$executeRawUnsafe(`UPDATE cells SET ${axisCol} = -(${axisCol} + $2) - 1 WHERE worksheet_id = $1::uuid AND ${axisCol} >= $3`, sheetId, op.count, from);
      await tx.$executeRawUnsafe(`UPDATE cells SET ${axisCol} = -${axisCol} - 1 WHERE worksheet_id = $1::uuid AND ${axisCol} < 0`, sheetId);

      // 3. Rewrite formulas that point at this sheet (in every sheet of the workbook).
      const sheets = await tx.worksheet.findMany({ where: { workbookId }, select: { id: true, title: true } });
      const titles = new Map(sheets.map((s) => [s.id, s.title]));
      const formulas = await tx.$queryRaw<{ id: string; worksheet_id: string; row_index: number; column_index: number; raw_value: string; style_id: string | null }[]>`
        SELECT c.id, c.worksheet_id, c.row_index, c.column_index, c.raw_value, c.style_id
        FROM cells c JOIN worksheets w ON w.id = c.worksheet_id
        WHERE w.workbook_id = ${workbookId}::uuid AND c.formula IS NOT NULL`;
      const changed: RevisionChanges['cells'] = [];
      const ids: string[] = [];
      const raws: string[] = [];
      for (const f of formulas) {
        const next = adjustFormulaForStructure(f.raw_value, titles.get(f.worksheet_id) ?? '', { sheetName: ws.title, ...op });
        if (next === f.raw_value) continue;
        ids.push(f.id);
        raws.push(next);
        changed.push({ s: f.worksheet_id, r: f.row_index, c: f.column_index, b: [f.raw_value, f.style_id], a: [next, f.style_id] });
      }
      if (ids.length) {
        await tx.$executeRaw`
          UPDATE cells SET raw_value = u.raw, formula = u.raw, updated_by = ${input.userId}::uuid, updated_at = now()
          FROM unnest(${ids}::uuid[], ${raws}::text[]) AS u(id, raw) WHERE cells.id = u.id`;
      }

      // 4. Sheet metadata, frozen panes and rule ranges.
      const md = shiftMetadata((ws.metadata?.data ?? {}) as SheetMetadata, op);
      await tx.worksheetMetadata.upsert({ where: { worksheetId: sheetId }, create: { worksheetId: sheetId, data: md as never }, update: { data: md as never } });
      await tx.worksheet.update({
        where: { id: sheetId },
        data: {
          frozenRows: op.axis === 'row' ? shiftFrozen(ws.frozenRows, op) : undefined,
          frozenColumns: op.axis === 'col' ? shiftFrozen(ws.frozenColumns, op) : undefined,
        },
      });
      for (const v of ws.dataValidations) {
        const r = shiftA1(v.range, op);
        if (r === undefined) await tx.dataValidation.delete({ where: { id: v.id } });
        else if (r !== v.range) await tx.dataValidation.update({ where: { id: v.id }, data: { range: r! } });
      }
      for (const v of ws.conditionalFormats) {
        const r = shiftA1(v.range, op);
        if (r === undefined) await tx.conditionalFormat.delete({ where: { id: v.id } });
        else if (r !== v.range) await tx.conditionalFormat.update({ where: { id: v.id }, data: { range: r! } });
      }
      for (const v of ws.protectedRanges) {
        const r = shiftA1(v.range, op);
        if (r === undefined) await tx.protectedRange.delete({ where: { id: v.id } });
        else if (r !== v.range) await tx.protectedRange.update({ where: { id: v.id }, data: { range: r } });
        if (v.exceptRanges.length) {
          const next = v.exceptRanges.map((x) => shiftA1(x, op)).filter((x): x is string => typeof x === 'string');
          if (next.join() !== v.exceptRanges.join()) await tx.protectedRange.update({ where: { id: v.id }, data: { exceptRanges: next } });
        }
      }

      // 5. One revision for the whole change.
      const revision = current + 1;
      const what = op.axis === 'row' ? 'baris' : 'kolom';
      const label = op.count > 0 ? `Sisipkan ${op.count} ${what}` : `Hapus ${-op.count} ${what}`;
      const changes: RevisionChanges = { clientId: input.clientId, label, op: { sheetId, ...op }, deleted, cells: changed };
      await tx.workbookRevision.create({
        data: { workbookId, revisionNumber: BigInt(revision), userId: input.userId, kind: 'structure', changes: changes as never },
      });
      await tx.workbook.update({ where: { id: workbookId }, data: { revision: BigInt(revision), updatedAt: new Date() } });
      if (revision % config.snapshotEvery === 0) await writeSnapshot(tx, workbookId, revision);
      return { revision, label, deleted: deleted.length, formulas: changed.length };
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
}
