import { formatValue, fromStored, isError, type SheetMetadata, type StoredValue } from '@opensheet/engine';
import { prisma } from '../db';
import { styleFromRow } from './styles';

/**
 * A small SVG preview of the top-left of a workbook's first sheet, drawn from the
 * stored (already calculated) values. It is served as an image, so no script in
 * it could ever run; all text is escaped.
 */
const W = 360;
const H = 225;
const MAX_COLS = 10;
const MAX_ROWS = 14;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export async function workbookThumbnail(workbookId: string): Promise<string> {
  const sheet = await prisma.worksheet.findFirst({ where: { workbookId }, orderBy: { position: 'asc' }, include: { metadata: true } });
  const cells = sheet
    ? await prisma.cell.findMany({
        where: { worksheetId: sheet.id, rowIndex: { lt: MAX_ROWS }, columnIndex: { lt: MAX_COLS } },
        include: { style: true },
      })
    : [];
  const md = (sheet?.metadata?.data ?? {}) as SheetMetadata;
  const colW = (c: number) => md.colWidths?.[c] ?? sheet?.defaultColumnWidth ?? 100;
  const rowH = (r: number) => md.rowHeights?.[r] ?? sheet?.defaultRowHeight ?? 24;

  // Column and row offsets for the area that fits the preview.
  const xs = [0];
  while (xs.length <= MAX_COLS && xs[xs.length - 1] < W) xs.push(xs[xs.length - 1] + colW(xs.length - 1));
  const ys = [0];
  while (ys.length <= MAX_ROWS && ys[ys.length - 1] < H) ys.push(ys[ys.length - 1] + rowH(ys.length - 1));

  let grid = '';
  for (const x of xs) grid += `<line x1="${x - 0.5}" y1="0" x2="${x - 0.5}" y2="${H}"/>`;
  for (const y of ys) grid += `<line x1="0" y1="${y - 0.5}" x2="${W}" y2="${y - 0.5}"/>`;

  let fills = '';
  let texts = '';
  for (const c of cells) {
    const x0 = xs[c.columnIndex];
    const y0 = ys[c.rowIndex];
    if (x0 === undefined || y0 === undefined || x0 >= W || y0 >= H) continue;
    const w = (xs[c.columnIndex + 1] ?? x0 + colW(c.columnIndex)) - x0;
    const h = (ys[c.rowIndex + 1] ?? y0 + rowH(c.rowIndex)) - y0;
    const st = c.style ? styleFromRow(c.style) : null;
    if (st?.backgroundColor && /^#[0-9a-f]{6}$/i.test(st.backgroundColor)) fills += `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="${st.backgroundColor}"/>`;
    const v = fromStored((c.calculatedValue ?? null) as StoredValue);
    const raw = v === null && c.rawValue && !c.formula ? c.rawValue : null;
    const shown = isError(v) ? v.code : v === null ? (raw ?? '') : formatValue(v, st?.numberFormat);
    if (!shown) continue;
    const size = Math.min(15, Math.round(((st?.fontSize ?? 10) * 4) / 3));
    const maxChars = Math.max(1, Math.floor((w - 8) / (size * 0.56)));
    const text = shown.length > maxChars ? shown.slice(0, Math.max(1, maxChars - 1)) + '…' : shown;
    const right = typeof v === 'number' && st?.hAlign !== 'left';
    const center = st?.hAlign === 'center' || typeof v === 'boolean';
    const anchor = center ? 'middle' : right ? 'end' : 'start';
    const tx = center ? x0 + w / 2 : right ? x0 + w - 4 : x0 + 4;
    const color = st?.textColor && /^#[0-9a-f]{6}$/i.test(st.textColor) ? st.textColor : isError(v) ? '#B42318' : '#1A1E1C';
    texts += `<text x="${tx}" y="${y0 + h / 2 + size * 0.35}" text-anchor="${anchor}" font-size="${size}" fill="${color}"${st?.bold ? ' font-weight="600"' : ''}${st?.italic ? ' font-style="italic"' : ''}>${esc(text)}</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="'IBM Plex Sans', system-ui, sans-serif"><rect width="${W}" height="${H}" fill="#FFFFFF"/>${fills}<g stroke="#E2E3DD" stroke-width="1">${grid}</g>${texts}</svg>`;
}
