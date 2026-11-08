import { CellOp, renameSheetInFormula, removeSheetFromFormula, SheetMetadata } from '@opensheet/engine';
import { prisma } from '../db';
import { writeSnapshot } from './cells';

export async function sheetPayload(worksheetId: string) {
  const ws = await prisma.worksheet.findUniqueOrThrow({
    where: { id: worksheetId },
    include: { metadata: true, dataValidations: true, conditionalFormats: { orderBy: { position: 'asc' } }, protectedRanges: true },
  });
  return {
    id: ws.id,
    title: ws.title,
    position: ws.position,
    defaultColumnWidth: ws.defaultColumnWidth,
    defaultRowHeight: ws.defaultRowHeight,
    frozenRows: ws.frozenRows,
    frozenColumns: ws.frozenColumns,
    metadata: (ws.metadata?.data ?? {}) as SheetMetadata,
    validations: ws.dataValidations.map((v) => ({ id: v.id, range: v.range, rule: v.rule })),
    conditionalFormats: ws.conditionalFormats.map((v) => ({ id: v.id, range: v.range, rule: v.rule })),
    protectedRanges: ws.protectedRanges.map((p) => ({ id: p.id, range: p.range, description: p.description, editorIds: p.editorIds, exceptRanges: p.exceptRanges })),
  };
}

export async function createWorkbook(ownerId: string, title: string, folderId?: string | null, sheetTitles = ['Sheet1']) {
  return prisma.$transaction(async (tx) => {
    const wb = await tx.workbook.create({ data: { ownerId, title, folderId: folderId ?? null } });
    const sheets = [];
    for (let i = 0; i < sheetTitles.length; i++) {
      sheets.push(await tx.worksheet.create({ data: { workbookId: wb.id, title: sheetTitles[i], position: i, metadata: { create: { data: {} } } } }));
    }
    return { workbook: wb, sheets };
  });
}

/** Records the base snapshot every history reconstruction starts from. */
export async function baseSnapshot(workbookId: string) {
  await prisma.$transaction((tx) => writeSnapshot(tx, workbookId, 0));
}

export async function nextSheetTitle(workbookId: string, base = 'Sheet'): Promise<string> {
  const titles = new Set((await prisma.worksheet.findMany({ where: { workbookId }, select: { title: true } })).map((t) => t.title.toLowerCase()));
  for (let i = 1; ; i++) {
    const t = `${base}${i}`;
    if (!titles.has(t.toLowerCase())) return t;
  }
}

/** Cell ops that rewrite formulas after a sheet was renamed or removed. */
export async function formulaOpsForSheetChange(workbookId: string, oldName: string, newName: string | null): Promise<CellOp[]> {
  const cells = await prisma.cell.findMany({
    where: { worksheet: { workbookId }, formula: { not: null } },
    select: { worksheetId: true, rowIndex: true, columnIndex: true, rawValue: true },
  });
  const ops: CellOp[] = [];
  for (const c of cells) {
    const raw = c.rawValue ?? '';
    if (!raw.toLowerCase().includes(oldName.toLowerCase())) continue;
    const next = newName === null ? removeSheetFromFormula(raw, oldName) : renameSheetInFormula(raw, oldName, newName);
    if (next !== raw) ops.push({ sheetId: c.worksheetId, row: c.rowIndex, col: c.columnIndex, raw: next });
  }
  return ops;
}

export async function recordOpen(userId: string, workbookId: string) {
  await prisma.workbookOpen.upsert({
    where: { userId_workbookId: { userId, workbookId } },
    create: { userId, workbookId },
    update: { openedAt: new Date() },
  });
}
