import { CellOp, parseRangeA1, type SheetMetadata } from '@opensheet/engine';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { badRequest, h, jsonSafe, parse } from '../lib/http';
import { broadcast } from '../realtime';
import { requireCapability, worksheetWorkbook } from '../services/access';
import { applyBatch, computeValues, loadSheetCells } from '../services/cells';
import { loadStyles } from '../services/styles';
import { applyStructure, MAX_INSERT } from '../services/structure';
import { formulaOpsForSheetChange, sheetPayload } from '../services/workbooks';

export const worksheetsRouter = Router();

const MAX_OPS = 50_000;
const intIdx = z.number().int().min(0).max(1_048_575);
const colIdx = z.number().int().min(0).max(16_383);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const border = z.object({ style: z.enum(['thin', 'medium', 'thick', 'dashed', 'dotted', 'double']), color }).optional();

const styleSchema = z
  .object({
    fontFamily: z.string().max(80).optional(),
    fontSize: z.number().int().min(6).max(96).optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strike: z.boolean().optional(),
    textColor: color.optional(),
    backgroundColor: color.optional(),
    hAlign: z.enum(['left', 'center', 'right']).optional(),
    vAlign: z.enum(['top', 'middle', 'bottom']).optional(),
    wrap: z.boolean().optional(),
    rotation: z.number().int().min(-90).max(90).optional(),
    indent: z.number().int().min(0).max(15).optional(),
    numberFormat: z.string().max(80).optional(),
    borders: z.object({ top: border, right: border, bottom: border, left: border }).optional(),
    link: z
      .string()
      .max(2000)
      .regex(/^(https?:\/\/|mailto:)/i, 'Tautan harus diawali http://, https:// atau mailto:')
      .optional(),
  })
  .strict();

const storedValue = z.union([z.number(), z.string().max(50_000), z.boolean(), z.null(), z.object({ error: z.string().max(10) })]);

const cellOp = z.object({
  sheetId: z.string().uuid(),
  row: intIdx,
  col: colIdx,
  raw: z.string().max(50_000).optional(),
  value: storedValue.optional(),
  style: styleSchema.nullable().optional(),
});

const batchBody = z.object({
  baseRevision: z.number().int().min(0),
  clientId: z.string().min(4).max(64),
  ops: z.array(cellOp).min(1).max(MAX_OPS),
  label: z.string().max(80).optional(),
});

async function runBatch(userId: string, workbookId: string, body: z.infer<typeof batchBody>, socketId?: string) {
  const { role } = await requireCapability(userId, workbookId, 'edit');
  const result = await applyBatch({
    workbookId,
    userId,
    role,
    clientId: body.clientId,
    baseRevision: body.baseRevision,
    ops: body.ops as CellOp[],
    label: body.label,
  });
  if (result.ops.length) {
    broadcast(workbookId, 'cell:batch-update', { revision: result.revision, ops: result.ops, userId, clientId: body.clientId }, socketId);
  }
  return result;
}

worksheetsRouter.get(
  '/:id/range',
  h(async (req, res) => {
    const id = req.params.id as string;
    await requireCapability(req.user?.id ?? null, await worksheetWorkbook(id), 'view');
    const range = typeof req.query.range === 'string' ? parseRangeA1(req.query.range) : null;
    if (typeof req.query.range === 'string' && !range) throw badRequest('Rentang tidak valid');
    res.json(jsonSafe({ cells: await loadSheetCells(id, range ?? undefined) }));
  }),
);

/** Single-sheet edit: { baseRevision, clientId, cells: [{ row, col, raw?, style?, value? }] } */
worksheetsRouter.patch(
  '/:id/cells',
  h(async (req, res) => {
    const id = req.params.id as string;
    const body = parse(
      z.object({ baseRevision: z.number().int().min(0), clientId: z.string().min(4).max(64), cells: z.array(cellOp.omit({ sheetId: true })).min(1).max(MAX_OPS) }),
      req.body,
    );
    const workbookId = await worksheetWorkbook(id);
    const result = await runBatch(req.user!.id, workbookId, { ...body, ops: body.cells.map((c) => ({ ...c, sheetId: id })) }, req.get('x-socket-id'));
    res.json(result);
  }),
);

/** Batch edit that may span several sheets of the same workbook. */
worksheetsRouter.post(
  '/:id/cells/batch',
  h(async (req, res) => {
    const body = parse(batchBody, req.body);
    const workbookId = await worksheetWorkbook(req.params.id as string);
    const result = await runBatch(req.user!.id, workbookId, body, req.get('x-socket-id'));
    res.json(result);
  }),
);

/** Insert (count > 0) or delete (count < 0) rows or columns. */
worksheetsRouter.post(
  '/:id/structure',
  h(async (req, res) => {
    const id = req.params.id as string;
    const body = parse(
      z.object({
        axis: z.enum(['row', 'col']),
        index: z.number().int().min(0).max(1_048_575),
        count: z.number().int().min(-1_048_576).max(MAX_INSERT),
        clientId: z.string().min(4).max(64),
      }),
      req.body,
    );
    const workbookId = await worksheetWorkbook(id);
    const { role } = await requireCapability(req.user!.id, workbookId, 'edit');
    const result = await applyStructure({ workbookId, sheetId: id, userId: req.user!.id, role, clientId: body.clientId, op: { axis: body.axis, index: body.index, count: body.count } });
    const sheet = await sheetPayload(id);
    broadcast(workbookId, 'worksheet:structure', { sheet, revision: result.revision, clientId: body.clientId, op: { axis: body.axis, index: body.index, count: body.count } }, req.get('x-socket-id'));
    res.json({ ...result, sheet });
  }),
);

worksheetsRouter.delete(
  '/:id/range',
  h(async (req, res) => {
    const id = req.params.id as string;
    const body = parse(z.object({ baseRevision: z.number().int().min(0), clientId: z.string().min(4).max(64), range: z.string().max(40) }), req.body);
    const r = parseRangeA1(body.range);
    if (!r) throw badRequest('Rentang tidak valid');
    const workbookId = await worksheetWorkbook(id);
    const cells = await prisma.cell.findMany({
      where: { worksheetId: id, rowIndex: { gte: r.r1, lte: r.r2 }, columnIndex: { gte: r.c1, lte: r.c2 } },
      select: { rowIndex: true, columnIndex: true },
    });
    if (!cells.length) {
      res.json({ revision: null, ops: [] });
      return;
    }
    const ops = await computeValues(workbookId, cells.map((c) => ({ sheetId: id, row: c.rowIndex, col: c.columnIndex, raw: '' })));
    const result = await runBatch(req.user!.id, workbookId, { baseRevision: body.baseRevision, clientId: body.clientId, ops }, req.get('x-socket-id'));
    res.json(result);
  }),
);

const metadataSchema = z
  .object({
    colWidths: z.record(z.string(), z.number().int().min(0).max(2000)).optional(),
    rowHeights: z.record(z.string(), z.number().int().min(0).max(2000)).optional(),
    hiddenRows: z.array(intIdx).max(100_000).optional(),
    hiddenCols: z.array(colIdx).max(16_384).optional(),
    merges: z.array(z.object({ r1: intIdx, c1: colIdx, r2: intIdx, c2: colIdx })).max(10_000).optional(),
    filter: z.any().nullable().optional(),
    filterViews: z.array(z.any()).max(50).optional(),
    charts: z
      .array(
        z
          .object({
            id: z.string().min(1).max(40),
            type: z.enum(['column', 'bar', 'line', 'area', 'pie', 'scatter']),
            title: z.string().max(200),
            range: rangeString(),
            headerRow: z.boolean(),
            headerCol: z.boolean(),
            seriesIn: z.enum(['cols', 'rows']),
            stacked: z.boolean(),
            legend: z.enum(['none', 'top', 'bottom', 'right']),
            row: intIdx,
            col: colIdx,
            dx: z.number().int().min(0).max(5000),
            dy: z.number().int().min(0).max(5000),
            w: z.number().int().min(160).max(2000),
            h: z.number().int().min(120).max(1500),
          })
          .strict(),
      )
      .max(50)
      .optional(),
    showGridlines: z.boolean().optional(),
    tabColor: color.nullable().optional(),
  })
  .strict();

worksheetsRouter.patch(
  '/:id',
  h(async (req, res) => {
    const id = req.params.id as string;
    const body = parse(
      z.object({
        title: z.string().trim().min(1).max(100).regex(/^[^[\]*?/\\:]+$/, 'Nama sheet tidak boleh berisi [ ] * ? / \\ :').optional(),
        frozenRows: z.number().int().min(0).max(100).optional(),
        frozenColumns: z.number().int().min(0).max(50).optional(),
        defaultColumnWidth: z.number().int().min(20).max(500).optional(),
        defaultRowHeight: z.number().int().min(12).max(200).optional(),
        metadata: metadataSchema.optional(),
        baseRevision: z.number().int().min(0).optional(),
        clientId: z.string().min(4).max(64).optional(),
      }),
      req.body,
    );
    const workbookId = await worksheetWorkbook(id);
    await requireCapability(req.user!.id, workbookId, 'edit');
    const ws = await prisma.worksheet.findUniqueOrThrow({ where: { id }, include: { metadata: true } });
    let revision: number | undefined;
    if (body.title && body.title !== ws.title) {
      const clash = await prisma.worksheet.findFirst({ where: { workbookId, title: { equals: body.title, mode: 'insensitive' }, NOT: { id } } });
      if (clash) throw badRequest('Nama sheet sudah dipakai');
      await prisma.worksheet.update({ where: { id }, data: { title: body.title } });
      const ops = await formulaOpsForSheetChange(workbookId, ws.title, body.title);
      if (ops.length) {
        const wb = await prisma.workbook.findUniqueOrThrow({ where: { id: workbookId } });
        const r = await runBatch(req.user!.id, workbookId, { baseRevision: Number(wb.revision), clientId: body.clientId ?? 'server', ops: await computeValues(workbookId, ops), label: 'Ganti nama sheet' });
        revision = r.revision;
      }
    }
    const data: Record<string, unknown> = {};
    for (const k of ['frozenRows', 'frozenColumns', 'defaultColumnWidth', 'defaultRowHeight'] as const) if (body[k] !== undefined) data[k] = body[k];
    if (Object.keys(data).length) await prisma.worksheet.update({ where: { id }, data });
    if (body.metadata) {
      const merged: SheetMetadata = { ...((ws.metadata?.data ?? {}) as SheetMetadata), ...(body.metadata as SheetMetadata) };
      await prisma.worksheetMetadata.upsert({ where: { worksheetId: id }, create: { worksheetId: id, data: merged as never }, update: { data: merged as never } });
    }
    const sheet = await sheetPayload(id);
    broadcast(workbookId, 'worksheet:update', { action: 'update', sheet, renamedFrom: body.title && body.title !== ws.title ? ws.title : undefined }, req.get('x-socket-id'));
    res.json({ sheet, revision });
  }),
);

worksheetsRouter.delete(
  '/:id',
  h(async (req, res) => {
    const id = req.params.id as string;
    const workbookId = await worksheetWorkbook(id);
    await requireCapability(req.user!.id, workbookId, 'edit');
    const count = await prisma.worksheet.count({ where: { workbookId } });
    if (count <= 1) throw badRequest('Workbook harus memiliki minimal satu sheet');
    const ws = await prisma.worksheet.findUniqueOrThrow({ where: { id } });
    await prisma.worksheet.delete({ where: { id } });
    const rest = await prisma.worksheet.findMany({ where: { workbookId }, orderBy: { position: 'asc' } });
    for (let i = 0; i < rest.length; i++) if (rest[i].position !== i) await prisma.worksheet.update({ where: { id: rest[i].id }, data: { position: i } });
    const ops = await formulaOpsForSheetChange(workbookId, ws.title, null);
    if (ops.length) {
      const wb = await prisma.workbook.findUniqueOrThrow({ where: { id: workbookId } });
      await runBatch(req.user!.id, workbookId, { baseRevision: Number(wb.revision), clientId: 'server', ops: await computeValues(workbookId, ops), label: 'Hapus sheet' });
    }
    broadcast(workbookId, 'worksheet:update', { action: 'delete', sheetId: id });
    res.json({ ok: true });
  }),
);

worksheetsRouter.post(
  '/:id/reorder',
  h(async (req, res) => {
    const id = req.params.id as string;
    const body = parse(z.object({ position: z.number().int().min(0) }), req.body);
    const workbookId = await worksheetWorkbook(id);
    await requireCapability(req.user!.id, workbookId, 'edit');
    const sheets = await prisma.worksheet.findMany({ where: { workbookId }, orderBy: { position: 'asc' } });
    const from = sheets.findIndex((s) => s.id === id);
    const [moved] = sheets.splice(from, 1);
    sheets.splice(Math.min(body.position, sheets.length), 0, moved);
    await prisma.$transaction(sheets.map((s, i) => prisma.worksheet.update({ where: { id: s.id }, data: { position: i } })));
    broadcast(workbookId, 'worksheet:update', { action: 'reorder', order: sheets.map((s) => s.id) });
    res.json({ order: sheets.map((s) => s.id) });
  }),
);

worksheetsRouter.post(
  '/:id/duplicate',
  h(async (req, res) => {
    const id = req.params.id as string;
    const workbookId = await worksheetWorkbook(id);
    await requireCapability(req.user!.id, workbookId, 'edit');
    const src = await prisma.worksheet.findUniqueOrThrow({ where: { id }, include: { metadata: true, dataValidations: true, conditionalFormats: true } });
    const titles = new Set((await prisma.worksheet.findMany({ where: { workbookId }, select: { title: true } })).map((t) => t.title.toLowerCase()));
    let title = `Salinan ${src.title}`.slice(0, 90);
    for (let i = 2; titles.has(title.toLowerCase()); i++) title = `Salinan ${src.title} (${i})`.slice(0, 100);
    const count = await prisma.worksheet.count({ where: { workbookId } });
    const ns = await prisma.$transaction(async (tx) => {
      const ns = await tx.worksheet.create({
        data: {
          workbookId,
          title,
          position: count,
          defaultColumnWidth: src.defaultColumnWidth,
          defaultRowHeight: src.defaultRowHeight,
          frozenRows: src.frozenRows,
          frozenColumns: src.frozenColumns,
          metadata: { create: { data: (src.metadata?.data ?? {}) as never } },
        },
      });
      if (src.dataValidations.length) await tx.dataValidation.createMany({ data: src.dataValidations.map((v) => ({ worksheetId: ns.id, range: v.range, rule: v.rule as never })) });
      if (src.conditionalFormats.length)
        await tx.conditionalFormat.createMany({ data: src.conditionalFormats.map((v) => ({ worksheetId: ns.id, range: v.range, rule: v.rule as never, position: v.position })) });
      return ns;
    });
    // Copy cells through the batch path so the copy shows up in version history.
    const cells = await prisma.cell.findMany({ where: { worksheetId: id } });
    const styles = await loadStyles(cells.map((c) => c.styleId).filter((x): x is string => !!x));
    if (cells.length) {
      const wb = await prisma.workbook.findUniqueOrThrow({ where: { id: workbookId } });
      await runBatch(req.user!.id, workbookId, {
        baseRevision: Number(wb.revision),
        clientId: 'server',
        label: 'Duplikat sheet',
        ops: cells.map((c) => ({
          sheetId: ns.id,
          row: c.rowIndex,
          col: c.columnIndex,
          raw: c.rawValue ?? '',
          value: c.calculatedValue as never,
          style: c.styleId ? styles.get(c.styleId) ?? null : null,
        })),
      });
    }
    const sheet = await sheetPayload(ns.id);
    broadcast(workbookId, 'worksheet:update', { action: 'create', sheet });
    res.status(201).json({ sheet });
  }),
);

function rangeString() {
  return z
    .string()
    .max(40)
    .refine((s) => !!parseRangeA1(s), 'Rentang tidak valid');
}

const conditionalRule = z.object({
  op: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'between', 'contains', 'notContains', 'startsWith', 'endsWith', 'empty', 'notEmpty', 'formula']),
  value: z.string().max(500).optional(),
  value2: z.string().max(500).optional(),
  style: z.object({ backgroundColor: color.optional(), textColor: color.optional(), bold: z.boolean().optional(), italic: z.boolean().optional(), strike: z.boolean().optional() }),
});

const validationRule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('list'), items: z.array(z.string().max(200)).min(1).max(500), strict: z.boolean(), showDropdown: z.boolean() }),
  z.object({ kind: z.literal('number'), op: z.enum(['between', 'gt', 'gte', 'lt', 'lte', 'eq']), min: z.number().optional(), max: z.number().optional(), strict: z.boolean() }),
  z.object({ kind: z.literal('textLength'), max: z.number().int().min(0), strict: z.boolean() }),
  z.object({ kind: z.literal('checkbox') }),
]);

worksheetsRouter.put(
  '/:id/validations',
  h(async (req, res) => {
    const id = req.params.id as string;
    const body = parse(z.object({ items: z.array(z.object({ range: rangeString(), rule: validationRule })).max(500) }), req.body);
    const workbookId = await worksheetWorkbook(id);
    await requireCapability(req.user!.id, workbookId, 'edit');
    await prisma.$transaction([
      prisma.dataValidation.deleteMany({ where: { worksheetId: id } }),
      prisma.dataValidation.createMany({ data: body.items.map((i) => ({ worksheetId: id, range: i.range, rule: i.rule as never })) }),
    ]);
    const sheet = await sheetPayload(id);
    broadcast(workbookId, 'worksheet:update', { action: 'update', sheet }, req.get('x-socket-id'));
    res.json({ sheet });
  }),
);

worksheetsRouter.put(
  '/:id/conditional-formats',
  h(async (req, res) => {
    const id = req.params.id as string;
    const body = parse(z.object({ items: z.array(z.object({ range: rangeString(), rule: conditionalRule })).max(200) }), req.body);
    const workbookId = await worksheetWorkbook(id);
    await requireCapability(req.user!.id, workbookId, 'edit');
    await prisma.$transaction([
      prisma.conditionalFormat.deleteMany({ where: { worksheetId: id } }),
      prisma.conditionalFormat.createMany({ data: body.items.map((i, n) => ({ worksheetId: id, range: i.range, rule: i.rule as never, position: n })) }),
    ]);
    const sheet = await sheetPayload(id);
    broadcast(workbookId, 'worksheet:update', { action: 'update', sheet }, req.get('x-socket-id'));
    res.json({ sheet });
  }),
);

worksheetsRouter.put(
  '/:id/protected-ranges',
  h(async (req, res) => {
    const id = req.params.id as string;
    const body = parse(
      z.object({
        items: z.array(z.object({ range: rangeString().nullable(), description: z.string().max(200).nullable().optional(), editorIds: z.array(z.string().uuid()).max(100), exceptRanges: z.array(rangeString()).max(50).optional() })).max(100),
      }),
      req.body,
    );
    const workbookId = await worksheetWorkbook(id);
    await requireCapability(req.user!.id, workbookId, 'manage');
    await prisma.$transaction([
      prisma.protectedRange.deleteMany({ where: { worksheetId: id } }),
      prisma.protectedRange.createMany({ data: body.items.map((i) => ({ worksheetId: id, range: i.range, description: i.description ?? null, editorIds: i.editorIds, exceptRanges: i.range === null ? (i.exceptRanges ?? []) : [] })) }),
      prisma.worksheet.update({ where: { id }, data: { isProtected: body.items.some((i) => i.range === null) } }),
    ]);
    const sheet = await sheetPayload(id);
    broadcast(workbookId, 'worksheet:update', { action: 'update', sheet }, req.get('x-socket-id'));
    res.json({ sheet });
  }),
);
