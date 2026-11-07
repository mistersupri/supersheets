import {
  CellData,
  CellOp,
  Engine,
  parseInput,
  parseRangeA1,
  rangeContains,
  StoredValue,
  toStored,
  valueType,
  fromStored,
  shiftIndex,
  type StructureOp,
} from '@opensheet/engine';
import { config } from '../config';
import { prisma, type Tx } from '../db';
import { conflict, forbidden, notFound } from '../lib/http';
import { can, type Role } from './access';
import { loadEngine } from './imports';
import { loadStyles, styleFromRow, styleIdFor } from './styles';

/** Compact cell entry stored in revisions and snapshots: [raw, styleId]. */
type Entry = [string, string | null];
export type WorkbookState = Record<string, Record<string, Entry>>; // sheetId -> "r:c" -> entry

export interface RevisionChanges {
  clientId?: string;
  label?: string;
  cells: { s: string; r: number; c: number; b: Entry | null; a: Entry | null }[];
  /** Row/column insert or delete applied before `cells` (positions in `cells` are after the shift). */
  op?: { sheetId: string; axis: 'row' | 'col'; index: number; count: number };
  /** Cells removed by a delete, at their old positions. */
  deleted?: { r: number; c: number; e: Entry }[];
}

export interface BatchInput {
  workbookId: string;
  userId: string;
  role: Role;
  clientId: string;
  baseRevision: number;
  ops: CellOp[];
  kind?: 'cells' | 'restore' | 'import';
  label?: string;
}

export interface BatchResult {
  revision: number;
  ops: CellOp[];
}

interface ExistingCell {
  id: string;
  worksheet_id: string;
  row_index: number;
  column_index: number;
  raw_value: string | null;
  calculated_value: StoredValue | null;
  style_id: string | null;
}

function key(s: string, r: number, c: number) {
  return `${s}|${r}:${c}`;
}

export async function lockRevision(tx: Tx, workbookId: string): Promise<number> {
  const rows = await tx.$queryRaw<{ revision: bigint }[]>`SELECT revision FROM workbooks WHERE id = ${workbookId}::uuid FOR UPDATE`;
  if (!rows.length) throw notFound('Workbook tidak ditemukan');
  return Number(rows[0].revision);
}

async function checkProtection(tx: Tx, input: BatchInput, sheetIds: string[]) {
  if (can(input.role, 'manage')) return;
  const ranges = await tx.protectedRange.findMany({ where: { worksheetId: { in: sheetIds } } });
  if (!ranges.length) return;
  for (const op of input.ops) {
    for (const p of ranges) {
      if (p.worksheetId !== op.sheetId || p.editorIds.includes(input.userId)) continue;
      const r = p.range ? parseRangeA1(p.range) : null;
      if (!p.range || (r && rangeContains(r, op.row, op.col))) {
        throw forbidden(p.range ? `Rentang ${p.range} dilindungi` : 'Sheet ini dilindungi');
      }
    }
  }
}

async function fetchExisting(tx: Tx, ops: CellOp[]): Promise<Map<string, ExistingCell>> {
  const out = new Map<string, ExistingCell>();
  const bySheet = new Map<string, CellOp[]>();
  for (const op of ops) {
    const list = bySheet.get(op.sheetId) ?? [];
    list.push(op);
    bySheet.set(op.sheetId, list);
  }
  for (const [sheetId, list] of bySheet) {
    for (let i = 0; i < list.length; i += 1000) {
      const chunk = list.slice(i, i + 1000);
      const rows = chunk.map((o) => o.row);
      const cols = chunk.map((o) => o.col);
      const found = await tx.$queryRaw<ExistingCell[]>`
        SELECT c.id, c.worksheet_id, c.row_index, c.column_index, c.raw_value, c.calculated_value, c.style_id
        FROM cells c
        JOIN unnest(${rows}::int[], ${cols}::int[]) AS k(r, cc) ON c.row_index = k.r AND c.column_index = k.cc
        WHERE c.worksheet_id = ${sheetId}::uuid`;
      for (const f of found) out.set(key(f.worksheet_id, f.row_index, f.column_index), f);
    }
  }
  return out;
}

function storedForRaw(raw: string, provided: StoredValue | undefined): StoredValue {
  if (raw.startsWith('=') && raw.length > 1) return provided ?? null;
  const p = parseInput(raw);
  return p.kind === 'empty' ? null : (p.value as StoredValue);
}

/**
 * Applies a batch of cell edits under the workbook's revision lock.
 * A batch based on an older revision is accepted only when none of its cells
 * were changed by another client since that revision.
 */
export async function applyBatch(input: BatchInput): Promise<BatchResult> {
  const sheetIds = [...new Set(input.ops.map((o) => o.sheetId))];
  return prisma.$transaction(
    async (tx) => {
      const current = await lockRevision(tx, input.workbookId);
      const sheets = await tx.worksheet.findMany({ where: { id: { in: sheetIds }, workbookId: input.workbookId }, select: { id: true } });
      if (sheets.length !== sheetIds.length) throw notFound('Worksheet tidak ditemukan pada workbook ini');

      if (input.baseRevision < current) {
        const newer = await tx.workbookRevision.findMany({
          where: { workbookId: input.workbookId, revisionNumber: { gt: input.baseRevision } },
          select: { changes: true, userId: true },
        });
        const mine = new Set(input.ops.map((o) => key(o.sheetId, o.row, o.col)));
        const clashes: { sheetId: string; row: number; col: number }[] = [];
        for (const rev of newer) {
          const ch = rev.changes as unknown as RevisionChanges;
          if (ch.clientId && ch.clientId === input.clientId) continue;
          // Rows or columns moved since this batch was made: its positions are stale.
          if (ch.op && input.ops.some((o) => o.sheetId === ch.op!.sheetId)) {
            for (const o of input.ops) if (o.sheetId === ch.op.sheetId) clashes.push({ sheetId: o.sheetId, row: o.row, col: o.col });
            continue;
          }
          for (const c of ch.cells ?? []) {
            if (mine.has(key(c.s, c.r, c.c))) clashes.push({ sheetId: c.s, row: c.r, col: c.c });
          }
        }
        if (clashes.length) throw conflict('Sel yang sama telah diubah pengguna lain', { revision: current, cells: clashes.slice(0, 200) });
      }

      await checkProtection(tx, input, sheetIds);

      const existing = await fetchExisting(tx, input.ops);
      const styleCache = new Map<string, string | null>();
      const upserts: { s: string; r: number; c: number; raw: string; value: StoredValue; styleId: string | null }[] = [];
      const deletes: string[] = [];
      const changes: RevisionChanges['cells'] = [];
      const finalOps = new Map<string, CellOp>();
      for (const op of input.ops) finalOps.set(key(op.sheetId, op.row, op.col), op); // last write wins inside a batch

      for (const op of finalOps.values()) {
        const k = key(op.sheetId, op.row, op.col);
        const ex = existing.get(k);
        const before: Entry | null = ex ? [ex.raw_value ?? '', ex.style_id] : null;
        const raw = op.raw !== undefined ? op.raw : ex?.raw_value ?? '';
        const styleId = op.style !== undefined ? await styleIdFor(tx, op.style, styleCache) : ex?.style_id ?? null;
        const value = op.raw !== undefined ? storedForRaw(raw, op.value) : op.value !== undefined ? op.value : (ex?.calculated_value ?? null);
        const after: Entry | null = raw === '' && !styleId ? null : [raw, styleId];
        if (JSON.stringify(before) === JSON.stringify(after) && op.value === undefined) continue;
        changes.push({ s: op.sheetId, r: op.row, c: op.col, b: before, a: after });
        if (!after) {
          if (ex) deletes.push(ex.id);
        } else upserts.push({ s: op.sheetId, r: op.row, c: op.col, raw, value, styleId });
      }

      if (deletes.length) await tx.cell.deleteMany({ where: { id: { in: deletes } } });
      for (let i = 0; i < upserts.length; i += 500) {
        const chunk = upserts.slice(i, i + 500);
        const params: unknown[] = [];
        const tuples = chunk.map((u) => {
          const base = params.length;
          const isFormula = u.raw.startsWith('=') && u.raw.length > 1;
          params.push(u.s, u.r, u.c, u.raw, isFormula ? u.raw : null, JSON.stringify(u.value), valueType(fromStored(u.value)), u.styleId, input.userId);
          const p = (n: number) => `$${base + n}`;
          return `(gen_random_uuid(), ${p(1)}::uuid, ${p(2)}::int, ${p(3)}::int, ${p(4)}, ${p(5)}, ${p(6)}::jsonb, ${p(7)}, ${p(8)}::uuid, ${p(9)}::uuid, now())`;
        });
        await tx.$executeRawUnsafe(
          `INSERT INTO cells (id, worksheet_id, row_index, column_index, raw_value, formula, calculated_value, data_type, style_id, updated_by, updated_at)
           VALUES ${tuples.join(',')}
           ON CONFLICT (worksheet_id, row_index, column_index) DO UPDATE SET
             raw_value = EXCLUDED.raw_value, formula = EXCLUDED.formula, calculated_value = EXCLUDED.calculated_value,
             data_type = EXCLUDED.data_type, style_id = EXCLUDED.style_id, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          ...params,
        );
      }

      if (!changes.length) return { revision: current, ops: [] };
      const revision = current + 1;
      await tx.workbookRevision.create({
        data: {
          workbookId: input.workbookId,
          revisionNumber: BigInt(revision),
          userId: input.userId,
          kind: input.kind ?? 'cells',
          changes: { clientId: input.clientId, label: input.label, cells: changes } as never,
        },
      });
      await tx.workbook.update({ where: { id: input.workbookId }, data: { revision: BigInt(revision), updatedAt: new Date() } });
      if (revision % config.snapshotEvery === 0) await writeSnapshot(tx, input.workbookId, revision);

      const styles = await loadStylesTx(tx, upserts.map((u) => u.styleId).filter((x): x is string => !!x));
      const upsertByKey = new Map(upserts.map((u) => [key(u.s, u.r, u.c), u]));
      const applied: CellOp[] = changes.map((c) => {
        const u = upsertByKey.get(key(c.s, c.r, c.c));
        return {
          sheetId: c.s,
          row: c.r,
          col: c.c,
          raw: c.a ? c.a[0] : '',
          value: u ? u.value : null,
          style: c.a && c.a[1] ? styles.get(c.a[1]) ?? null : null,
        };
      });
      return { revision, ops: applied };
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
}

async function loadStylesTx(tx: Tx, ids: string[]) {
  const list = [...new Set(ids)];
  const rows = list.length ? await tx.cellStyle.findMany({ where: { id: { in: list } } }) : [];
  return new Map(rows.map((r) => [r.id, styleFromRow(r)]));
}

export async function buildState(tx: Tx, workbookId: string): Promise<WorkbookState> {
  const sheets = await tx.worksheet.findMany({ where: { workbookId }, select: { id: true } });
  const state: WorkbookState = {};
  for (const s of sheets) state[s.id] = {};
  const cells = await tx.cell.findMany({
    where: { worksheet: { workbookId } },
    select: { worksheetId: true, rowIndex: true, columnIndex: true, rawValue: true, styleId: true },
  });
  for (const c of cells) state[c.worksheetId][`${c.rowIndex}:${c.columnIndex}`] = [c.rawValue ?? '', c.styleId];
  return state;
}

export async function writeSnapshot(tx: Tx, workbookId: string, revision: number) {
  const data = await buildState(tx, workbookId);
  await tx.workbookSnapshot.create({ data: { workbookId, revisionNumber: BigInt(revision), data: data as never } });
}

/** Reconstructs the workbook's cells as they were at `revision`: nearest snapshot plus incremental changes. */
export async function stateAt(workbookId: string, revision: number): Promise<WorkbookState> {
  const snap = await prisma.workbookSnapshot.findFirst({
    where: { workbookId, revisionNumber: { lte: BigInt(revision) } },
    orderBy: { revisionNumber: 'desc' },
  });
  const state: WorkbookState = snap ? structuredClone(snap.data as unknown as WorkbookState) : {};
  const from = snap ? Number(snap.revisionNumber) : 0;
  const revs = await prisma.workbookRevision.findMany({
    where: { workbookId, revisionNumber: { gt: BigInt(from), lte: BigInt(revision) } },
    orderBy: { revisionNumber: 'asc' },
    select: { changes: true },
  });
  for (const r of revs) {
    const ch = r.changes as unknown as RevisionChanges;
    if (ch.op && state[ch.op.sheetId]) state[ch.op.sheetId] = shiftState(state[ch.op.sheetId], ch.op);
    for (const c of ch.cells ?? []) {
      const sheet = (state[c.s] ??= {});
      if (c.a) sheet[`${c.r}:${c.c}`] = c.a;
      else delete sheet[`${c.r}:${c.c}`];
    }
  }
  return state;
}

function shiftState(cells: Record<string, Entry>, op: StructureOp): Record<string, Entry> {
  const out: Record<string, Entry> = {};
  for (const [k, e] of Object.entries(cells)) {
    const [r, c] = k.split(':').map(Number);
    const nr = op.axis === 'row' ? shiftIndex(r, op) : r;
    const nc = op.axis === 'col' ? shiftIndex(c, op) : c;
    if (nr !== null && nc !== null) out[`${nr}:${nc}`] = e;
  }
  return out;
}

/** Computes cached values for ops by running the formula engine over the workbook. */
export async function computeValues(workbookId: string, ops: CellOp[], userId?: string): Promise<CellOp[]> {
  const engine = await loadEngine(workbookId, { userId });
  engine.setCells(ops.filter((o) => o.raw !== undefined).map((o) => ({ sheetId: o.sheetId, row: o.row, col: o.col, raw: o.raw! })));
  return ops.map((o) => (o.raw === undefined ? o : { ...o, value: toStored(engine.getValue(o.sheetId, o.row, o.col)) }));
}

export async function loadSheetCells(worksheetId: string, range?: { r1: number; c1: number; r2: number; c2: number }): Promise<CellData[]> {
  const rows = await prisma.cell.findMany({
    where: {
      worksheetId,
      ...(range ? { rowIndex: { gte: range.r1, lte: range.r2 }, columnIndex: { gte: range.c1, lte: range.c2 } } : {}),
    },
    orderBy: [{ rowIndex: 'asc' }, { columnIndex: 'asc' }],
  });
  const styles = await loadStyles(rows.map((r) => r.styleId).filter((x): x is string => !!x));
  return rows.map((r) => ({
    row: r.rowIndex,
    col: r.columnIndex,
    raw: r.rawValue ?? '',
    value: (r.calculatedValue ?? null) as StoredValue,
    style: r.styleId ? styles.get(r.styleId) ?? null : null,
    updatedBy: r.updatedBy,
    updatedAt: r.updatedAt.toISOString(),
  }));
}
