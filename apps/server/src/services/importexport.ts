import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import PDFDocument from 'pdfkit';
import {
  CellStyle,
  colToLetters,
  Engine,
  formatValue,
  isDateFormat,
  jsDateToSerial,
  normalizeStyle,
  parseRangeA1,
  type Merge,
  type SheetMetadata,
  type StoredValue,
  toStored,
  serialToJsDate,
} from '@opensheet/engine';
import { prisma } from '../db';
import { badRequest } from '../lib/http';
import { loadSheetCells, writeSnapshot } from './cells';
import { loadEngine } from './imports';
import { styleIdFor } from './styles';

export const MAX_IMPORT_CELLS = 500_000;

export interface ImportedSheet {
  title: string;
  cells: { row: number; col: number; raw: string; style: CellStyle | null }[];
  metadata: SheetMetadata;
  frozenRows: number;
  frozenColumns: number;
}

// ---------- XLSX import ----------

function argb(c?: { argb?: string; theme?: number }): string | undefined {
  if (!c?.argb || c.argb.length < 6) return undefined;
  return `#${c.argb.slice(-6).toUpperCase()}`;
}

const BORDER_MAP: Record<string, NonNullable<NonNullable<CellStyle['borders']>['top']>['style']> = {
  thin: 'thin', hair: 'thin', medium: 'medium', thick: 'thick', dashed: 'dashed', mediumDashed: 'dashed',
  dotted: 'dotted', dashDot: 'dashed', double: 'double',
};

function styleFromExcel(cell: ExcelJS.Cell): CellStyle | null {
  const s: CellStyle = {};
  const f = cell.font;
  if (f) {
    if (f.bold) s.bold = true;
    if (f.italic) s.italic = true;
    if (f.underline) s.underline = true;
    if (f.strike) s.strike = true;
    if (f.size && f.size !== 11) s.fontSize = Math.round(f.size);
    if (f.name && f.name !== 'Calibri') s.fontFamily = f.name;
    const c = argb(f.color as never);
    if (c && c !== '#000000') s.textColor = c;
  }
  const fill = cell.fill as ExcelJS.FillPattern | undefined;
  if (fill?.type === 'pattern' && fill.pattern === 'solid') {
    const c = argb(fill.fgColor as never);
    if (c) s.backgroundColor = c;
  }
  const a = cell.alignment;
  if (a) {
    if (a.horizontal === 'left' || a.horizontal === 'center' || a.horizontal === 'right') s.hAlign = a.horizontal;
    if (a.vertical === 'top' || a.vertical === 'bottom') s.vAlign = a.vertical;
    if (a.vertical === 'middle') s.vAlign = 'middle';
    if (a.wrapText) s.wrap = true;
    if (typeof a.textRotation === 'number' && a.textRotation >= -90 && a.textRotation <= 90) s.rotation = a.textRotation;
    if (a.indent) s.indent = Math.min(15, a.indent);
  }
  if (cell.numFmt && cell.numFmt !== 'General') s.numberFormat = cell.numFmt;
  const b = cell.border;
  if (b) {
    const borders: NonNullable<CellStyle['borders']> = {};
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      const x = b[side];
      if (x?.style && BORDER_MAP[x.style]) borders[side] = { style: BORDER_MAP[x.style], color: argb(x.color as never) ?? '#000000' };
    }
    if (Object.keys(borders).length) s.borders = borders;
  }
  if (cell.hyperlink && /^(https?:|mailto:)/i.test(cell.hyperlink)) s.link = cell.hyperlink;
  return normalizeStyle(s);
}

function rawFromExcel(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (cell.formula) return '=' + cell.formula;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return String(jsDateToSerial(v));
  if (typeof v === 'string') return needsQuote(v) ? `'${v}` : v;
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v && typeof v.text === 'string') return v.text;
    if ('error' in v) return String(v.error);
    if ('result' in v && v.result !== undefined) return String(v.result);
  }
  return String(v);
}

/** Text that our input parser would otherwise read as a number or date keeps its text type. */
function needsQuote(s: string): boolean {
  return /^[-+]?[\d.,]+%?$/.test(s.trim()) || /^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}/.test(s.trim()) || s.startsWith("'") || /^(TRUE|FALSE)$/i.test(s.trim());
}

export async function parseXlsx(buffer: Buffer): Promise<ImportedSheet[]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as never);
  } catch {
    throw badRequest('Berkas XLSX tidak dapat dibaca');
  }
  const out: ImportedSheet[] = [];
  let total = 0;
  const used = new Set<string>();
  for (const ws of wb.worksheets) {
    let title = (ws.name || `Sheet${out.length + 1}`).replace(/[[\]*?/\\:]/g, '_').slice(0, 100);
    while (used.has(title.toLowerCase())) title = `${title}_`;
    used.add(title.toLowerCase());
    const cells: ImportedSheet['cells'] = [];
    const metadata: SheetMetadata = { colWidths: {}, rowHeights: {}, hiddenRows: [], hiddenCols: [], merges: [] };
    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      if (row.height) metadata.rowHeights![rowNumber - 1] = Math.round((row.height * 4) / 3);
      if (row.hidden) metadata.hiddenRows!.push(rowNumber - 1);
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        if (cell.isMerged && cell.master !== cell) return;
        let raw = rawFromExcel(cell);
        let style = styleFromExcel(cell);
        if (cell.value instanceof Date && !isDateFormat(style?.numberFormat)) style = normalizeStyle({ ...(style ?? {}), numberFormat: 'date' });
        if (raw === '' && !style) return;
        if (raw.length > 50_000) raw = raw.slice(0, 50_000);
        cells.push({ row: rowNumber - 1, col: colNumber - 1, raw, style });
        if (++total > MAX_IMPORT_CELLS) throw badRequest(`Berkas terlalu besar (lebih dari ${MAX_IMPORT_CELLS.toLocaleString('id-ID')} sel)`);
      });
    });
    ws.columns?.forEach((col, i) => {
      if (col.width) metadata.colWidths![i] = Math.round(col.width * 7 + 5);
      if (col.hidden) metadata.hiddenCols!.push(i);
    });
    const merges = ((ws as unknown as { model: { merges?: string[] } }).model.merges ?? [])
      .map((m) => parseRangeA1(m))
      .filter((m): m is Merge => !!m);
    metadata.merges = merges;
    const view = ws.views?.[0] as { state?: string; xSplit?: number; ySplit?: number } | undefined;
    out.push({
      title,
      cells,
      metadata,
      frozenRows: view?.state === 'frozen' ? Math.min(100, view.ySplit ?? 0) : 0,
      frozenColumns: view?.state === 'frozen' ? Math.min(50, view.xSplit ?? 0) : 0,
    });
  }
  if (!out.length) throw badRequest('Berkas tidak berisi worksheet');
  return out;
}

// ---------- CSV / TSV import ----------

export function parseDelimited(text: string, title: string, delimiter?: string): ImportedSheet {
  const parsed = Papa.parse<string[]>(text.replace(/^﻿/, ''), { delimiter: delimiter ?? '', skipEmptyLines: false });
  const cells: ImportedSheet['cells'] = [];
  parsed.data.forEach((row, r) => {
    row.forEach((v, c) => {
      if (v === '') return;
      cells.push({ row: r, col: c, raw: v.slice(0, 50_000), style: null });
    });
  });
  if (cells.length > MAX_IMPORT_CELLS) throw badRequest('Berkas terlalu besar');
  return { title: title.replace(/[[\]*?/\\:]/g, '_').slice(0, 100) || 'Sheet1', cells, metadata: {}, frozenRows: 0, frozenColumns: 0 };
}

// ---------- write imported sheets ----------

function valuesFor(sheets: { id: string; title: string; cells: ImportedSheet['cells'] }[]): Map<string, StoredValue> {
  const engine = new Engine();
  for (const s of sheets) engine.addSheet(s.id, s.title);
  for (const s of sheets) engine.load(s.id, s.cells);
  engine.recalcAll();
  const out = new Map<string, StoredValue>();
  for (const s of sheets) for (const c of s.cells) out.set(`${s.id}|${c.row}:${c.col}`, toStored(engine.getValue(s.id, c.row, c.col)));
  return out;
}

/** Creates worksheets for imported data inside an existing workbook (or a new one). */
export async function writeImported(workbookId: string, userId: string, sheets: ImportedSheet[], startPosition: number, snapshot: boolean) {
  const created: { id: string; title: string; cells: ImportedSheet['cells'] }[] = [];
  await prisma.$transaction(
    async (tx) => {
      const existing = new Set((await tx.worksheet.findMany({ where: { workbookId }, select: { title: true } })).map((t) => t.title.toLowerCase()));
      for (let i = 0; i < sheets.length; i++) {
        const s = sheets[i];
        let title = s.title;
        for (let n = 2; existing.has(title.toLowerCase()); n++) title = `${s.title} (${n})`.slice(0, 100);
        existing.add(title.toLowerCase());
        const ws = await tx.worksheet.create({
          data: {
            workbookId,
            title,
            position: startPosition + i,
            frozenRows: s.frozenRows,
            frozenColumns: s.frozenColumns,
            metadata: { create: { data: s.metadata as never } },
          },
        });
        created.push({ id: ws.id, title, cells: s.cells });
      }
      // Formulas may reference other imported sheets, so values are computed together.
      const values = valuesFor(created);
      const styleCache = new Map<string, string | null>();
      for (const s of created) {
        for (let i = 0; i < s.cells.length; i += 1000) {
          const chunk = s.cells.slice(i, i + 1000);
          const data = [];
          for (const c of chunk) {
            const value = values.get(`${s.id}|${c.row}:${c.col}`) ?? null;
            data.push({
              worksheetId: s.id,
              rowIndex: c.row,
              columnIndex: c.col,
              rawValue: c.raw,
              formula: c.raw.startsWith('=') && c.raw.length > 1 ? c.raw : null,
              calculatedValue: value as never,
              dataType: value === null ? 'empty' : typeof value === 'object' ? 'error' : typeof value,
              styleId: await styleIdFor(tx, c.style, styleCache),
              updatedBy: userId,
            });
          }
          await tx.cell.createMany({ data });
        }
      }
      if (snapshot) await writeSnapshot(tx, workbookId, 0);
    },
    { timeout: 300_000, maxWait: 10_000 },
  );
  return created.map((c) => c.id);
}

// ---------- export ----------

interface ExportSheet {
  id: string;
  title: string;
  frozenRows: number;
  frozenColumns: number;
  defaultColumnWidth: number;
  metadata: SheetMetadata;
  cells: Awaited<ReturnType<typeof loadSheetCells>>;
}

async function loadForExport(workbookId: string, sheetId?: string, userId?: string): Promise<{ sheets: ExportSheet[]; engine: Engine }> {
  const rows = await prisma.worksheet.findMany({ where: { workbookId, ...(sheetId ? { id: sheetId } : {}) }, orderBy: { position: 'asc' }, include: { metadata: true } });
  if (!rows.length) throw badRequest('Worksheet tidak ditemukan');
  // Formulas are recomputed so exported values never rely on a stale cache.
  const all = await prisma.worksheet.findMany({ where: { workbookId }, select: { id: true, title: true } });
  const engine = await loadEngine(workbookId, { userId });
  const sheets: ExportSheet[] = [];
  for (const s of all) {
    const cells = await loadSheetCells(s.id);
    const row = rows.find((r) => r.id === s.id);
    if (row)
      sheets.push({
        id: s.id,
        title: s.title,
        frozenRows: row.frozenRows,
        frozenColumns: row.frozenColumns,
        defaultColumnWidth: row.defaultColumnWidth,
        metadata: (row.metadata?.data ?? {}) as SheetMetadata,
        cells,
      });
  }
  sheets.sort((a, b) => rows.findIndex((r) => r.id === a.id) - rows.findIndex((r) => r.id === b.id));
  return { sheets, engine };
}

function hex(c?: string) {
  return c ? { argb: 'FF' + c.replace('#', '').toUpperCase() } : undefined;
}

const NAMED_TO_EXCEL: Record<string, string> = {
  number: '#,##0.00',
  integer: '#,##0',
  currency: '"Rp"#,##0',
  currency2: '"Rp"#,##0.00',
  percent: '0.00%',
  date: 'dd/mm/yyyy',
  date_long: 'd mmmm yyyy',
  time: 'hh:mm:ss',
  datetime: 'dd/mm/yyyy hh:mm',
  text: '@',
};

export async function exportXlsx(workbookId: string, userId?: string): Promise<Buffer> {
  const { sheets, engine } = await loadForExport(workbookId, undefined, userId);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'OpenSheet';
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.title, {
      views: s.frozenRows || s.frozenColumns ? [{ state: 'frozen', xSplit: s.frozenColumns, ySplit: s.frozenRows }] : undefined,
    });
    for (const [c, w] of Object.entries(s.metadata.colWidths ?? {})) ws.getColumn(Number(c) + 1).width = Math.max(1, (w - 5) / 7);
    for (const c of s.metadata.hiddenCols ?? []) ws.getColumn(c + 1).hidden = true;
    for (const [r, h] of Object.entries(s.metadata.rowHeights ?? {})) ws.getRow(Number(r) + 1).height = (h * 3) / 4;
    for (const r of s.metadata.hiddenRows ?? []) ws.getRow(r + 1).hidden = true;
    for (const c of s.cells) {
      const cell = ws.getCell(c.row + 1, c.col + 1);
      const v = engine.getValue(s.id, c.row, c.col);
      const stored = toStored(v);
      if (c.raw.startsWith('=') && c.raw.length > 1) {
        const result = stored !== null && typeof stored === 'object' ? { error: stored.error } : stored;
        cell.value = { formula: c.raw.slice(1), result: result as never };
      } else if (stored !== null && typeof stored !== 'object') {
        cell.value = isDateFormat(c.style?.numberFormat) && typeof stored === 'number' ? serialToJsDate(stored) : stored;
      } else if (c.raw.startsWith("'")) cell.value = c.raw.slice(1);
      const st = c.style;
      if (!st) continue;
      if (st.bold || st.italic || st.underline || st.strike || st.fontSize || st.fontFamily || st.textColor)
        cell.font = { bold: st.bold, italic: st.italic, underline: st.underline, strike: st.strike, size: st.fontSize, name: st.fontFamily, color: hex(st.textColor) };
      if (st.backgroundColor) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: hex(st.backgroundColor)! };
      if (st.hAlign || st.vAlign || st.wrap || st.rotation || st.indent)
        cell.alignment = { horizontal: st.hAlign, vertical: st.vAlign, wrapText: st.wrap, textRotation: st.rotation, indent: st.indent };
      if (st.numberFormat) cell.numFmt = NAMED_TO_EXCEL[st.numberFormat] ?? st.numberFormat;
      if (st.borders) {
        const b: Partial<ExcelJS.Borders> = {};
        for (const side of ['top', 'right', 'bottom', 'left'] as const) {
          const x = st.borders[side];
          if (x) b[side] = { style: x.style === 'dashed' ? 'dashed' : x.style === 'dotted' ? 'dotted' : x.style === 'double' ? 'double' : x.style, color: hex(x.color) };
        }
        cell.border = b;
      }
      if (st.link) cell.value = { text: String(cell.value ?? st.link), hyperlink: st.link };
    }
    // Array formulas: the anchor keeps its formula over the whole result range, the
    // other cells carry the computed values.
    for (const c of engine.spillCells(s.id)) {
      const stored = toStored(c.value);
      if (stored !== null && typeof stored !== 'object') ws.getCell(c.row + 1, c.col + 1).value = stored;
    }
    for (const c of s.cells) {
      if (!c.raw.startsWith('=')) continue;
      const area = engine.spillAreaAt(s.id, c.row, c.col);
      if (!area || !area.ok || area.anchorRow !== c.row || area.anchorCol !== c.col) continue;
      const cell = ws.getCell(c.row + 1, c.col + 1);
      const stored = toStored(engine.getValue(s.id, c.row, c.col));
      cell.value = {
        formula: c.raw.slice(1),
        result: (stored !== null && typeof stored === 'object' ? undefined : stored) as never,
        shareType: 'array',
        ref: `${colToLetters(area.c1)}${area.r1 + 1}:${colToLetters(area.c2)}${area.r2 + 1}`,
      } as never;
    }
    for (const m of s.metadata.merges ?? []) ws.mergeCells(m.r1 + 1, m.c1 + 1, m.r2 + 1, m.c2 + 1);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function displayGrid(s: ExportSheet, engine: Engine): string[][] {
  let rows = 0;
  let cols = 0;
  const spilled = [...engine.spillCells(s.id)];
  for (const c of [...s.cells, ...spilled]) {
    rows = Math.max(rows, c.row + 1);
    cols = Math.max(cols, c.col + 1);
  }
  const grid: string[][] = Array.from({ length: rows }, () => Array<string>(cols).fill(''));
  // Values produced by array formulas (FILTER, SORT, ...) are exported too.
  for (const c of spilled) grid[c.row][c.col] = formatValue(c.value, null);
  for (const c of s.cells) grid[c.row][c.col] = formatValue(engine.getValue(s.id, c.row, c.col), c.style?.numberFormat);
  return grid;
}

export async function exportDelimited(workbookId: string, sheetId: string | undefined, delimiter: ',' | '\t', userId?: string): Promise<{ text: string; title: string }> {
  const { sheets, engine } = await loadForExport(workbookId, sheetId, userId);
  const s = sheets[0];
  const grid = displayGrid(s, engine);
  return { text: '﻿' + Papa.unparse(grid, { delimiter, newline: '\r\n' }), title: s.title };
}

export async function exportPdf(workbookId: string, title: string, sheetId?: string, userId?: string): Promise<Buffer> {
  const { sheets, engine } = await loadForExport(workbookId, sheetId, userId);
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, info: { Title: title, Creator: 'OpenSheet' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const pageW = doc.page.width - 72;
  const pageH = doc.page.height - 72;
  const rowH = 16;
  sheets.forEach((s, si) => {
    if (si > 0) doc.addPage();
    const grid = displayGrid(s, engine);
    const cols = grid[0]?.length ?? 0;
    doc.font('Helvetica-Bold').fontSize(12).text(`${title} / ${s.title}`, 36, 30);
    if (!grid.length) {
      doc.font('Helvetica').fontSize(10).text('Sheet ini kosong.', 36, 56);
      return;
    }
    const widths = Array.from({ length: cols }, (_, c) => (s.metadata.colWidths?.[c] ?? s.defaultColumnWidth) * 0.75);
    // Split wide sheets into column bands that fit the page.
    const bands: [number, number][] = [];
    let start = 0;
    let acc = 0;
    for (let c = 0; c < cols; c++) {
      if (acc + widths[c] > pageW - 30 && c > start) {
        bands.push([start, c - 1]);
        start = c;
        acc = 0;
      }
      acc += widths[c];
    }
    bands.push([start, cols - 1]);
    bands.forEach(([c1, c2], bi) => {
      if (bi > 0) doc.addPage();
      let y = 52;
      const header = () => {
        let x = 36 + 30;
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#555555');
        for (let c = c1; c <= c2; c++) {
          doc.text(colToLetters(c), x + 2, y + 4, { width: widths[c] - 4, lineBreak: false });
          x += widths[c];
        }
        y += rowH;
      };
      header();
      for (let r = 0; r < grid.length; r++) {
        if (y + rowH > pageH + 36) {
          doc.addPage();
          y = 36;
          header();
        }
        let x = 36 + 30;
        doc.font('Helvetica').fontSize(8).fillColor('#555555').text(String(r + 1), 36, y + 4, { width: 26, align: 'right', lineBreak: false });
        doc.fillColor('#111111');
        for (let c = c1; c <= c2; c++) {
          doc.rect(x, y, widths[c], rowH).strokeColor('#D0D5D2').lineWidth(0.5).stroke();
          const t = grid[r][c];
          if (t) doc.text(t, x + 3, y + 4, { width: widths[c] - 6, height: rowH - 4, lineBreak: false, ellipsis: true });
          x += widths[c];
        }
        y += rowH;
      }
    });
  });
  doc.end();
  return done;
}
