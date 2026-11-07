import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';
import {
  CellStyle,
  colToLetters,
  dateToSerial,
  isDateFormat,
  Node,
  normalizeStyle,
  parseFormula,
  quoteSheetName,
  serialToParts,
  toStored,
  type Engine,
  type Merge,
  type RefPart,
  type SheetMetadata,
} from '@opensheet/engine';
import { badRequest } from '../lib/http';
import type { ImportedSheet } from './importexport';

/**
 * OpenDocument Spreadsheet (.ods) import and export: values, formulas
 * (OpenFormula syntax), basic formatting, merged cells and column widths.
 */

// ---------- formula syntax ----------

function ofRef(r: RefPart): string {
  return `${r.colAbs ? '$' : ''}${colToLetters(r.col)}${r.rowAbs ? '$' : ''}${r.row + 1}`;
}

function ofSheet(sheet?: string): string {
  if (sheet === undefined) return '';
  return `$'${sheet.replace(/'/g, "''")}'`;
}

/** Our formula text to OpenFormula ("of:=SUM([.A1:.A3])"). */
export function toOpenFormula(raw: string): string | null {
  let ast: Node;
  try {
    ast = parseFormula(raw.slice(1));
  } catch {
    return null;
  }
  const ser = (n: Node): string => {
    switch (n.type) {
      case 'num':
        return String(n.value);
      case 'str':
        return `"${n.value.replace(/"/g, '""')}"`;
      case 'bool':
        return n.value ? 'TRUE()' : 'FALSE()';
      case 'err':
        return n.code;
      case 'name':
        return n.name;
      case 'ref':
        return `[${ofSheet(n.sheet)}.${ofRef(n.ref)}]`;
      case 'range': {
        const s = ofSheet(n.sheet);
        if (n.kind === 'cols') return `[${s}.${colToLetters(n.start.col)}:.${colToLetters(n.end.col)}]`;
        if (n.kind === 'rows') return `[${s}.${n.start.row + 1}:.${n.end.row + 1}]`;
        return `[${s}.${ofRef(n.start)}:.${ofRef(n.end)}]`;
      }
      case 'func':
        return `${n.name}(${n.args.map(ser).join(';')})`;
      case 'unary':
        return `${n.op}${ser(n.arg)}`;
      case 'percent':
        return `${ser(n.arg)}%`;
      case 'paren':
        return `(${ser(n.inner)})`;
      case 'binary':
        return `${ser(n.left)}${n.op}${ser(n.right)}`;
    }
  };
  return `of:=${ser(ast)}`;
}

/** OpenFormula (or LibreOffice "of:"/"oooc:" text) to our syntax. */
export function fromOpenFormula(of: string): string {
  let f = of.replace(/^(of|oooc|msoxl):/i, '');
  if (!f.startsWith('=')) f = '=' + f;
  let out = '';
  let i = 0;
  while (i < f.length) {
    const ch = f[i];
    if (ch === '"') {
      const j = f.indexOf('"', i + 1);
      const end = j < 0 ? f.length : j + 1;
      out += f.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '[') {
      const j = f.indexOf(']', i);
      const inner = f.slice(i + 1, j < 0 ? f.length : j);
      out += convertRef(inner);
      i = j < 0 ? f.length : j + 1;
      continue;
    }
    out += ch === ';' ? ',' : ch;
    i++;
  }
  return out.replace(/TRUE\(\)/gi, 'TRUE').replace(/FALSE\(\)/gi, 'FALSE');
}

function convertRef(inner: string): string {
  // [$'Sheet'.A1:.B2] or [.A1] or [Sheet1.A1:Sheet1.B2]
  const parts = inner.split(':');
  const conv = (p: string) => {
    const dot = p.lastIndexOf('.');
    const sheetPart = p.slice(0, dot).replace(/^\$/, '');
    const cell = p.slice(dot + 1);
    const sheet = sheetPart ? (sheetPart.startsWith("'") ? sheetPart.slice(1, -1).replace(/''/g, "'") : sheetPart) : '';
    return { sheet, cell };
  };
  const a = conv(parts[0]);
  const prefix = a.sheet ? `${quoteSheetName(a.sheet)}!` : '';
  if (parts.length === 1) return prefix + a.cell;
  const b = conv(parts[1]);
  return `${prefix}${a.cell}:${b.cell}`;
}

// ---------- reading ----------

type XNode = Record<string, unknown> & { ':@'?: Record<string, string> };

function tag(n: XNode): string {
  return Object.keys(n).find((k) => k !== ':@') ?? '';
}
function kids(n: XNode): XNode[] {
  return (n[tag(n)] as XNode[]) ?? [];
}
function attr(n: XNode, name: string): string | undefined {
  return n[':@']?.[`@_${name}`];
}
function text(n: XNode): string {
  const parts: string[] = [];
  const walk = (x: XNode) => {
    const t = tag(x);
    if (t === '#text') parts.push(String(x['#text']));
    else if (t === 'text:s') parts.push(' '.repeat(Number(attr(x, 'text:c') ?? 1)));
    else if (t === 'text:tab') parts.push('\t');
    else if (t === 'text:line-break') parts.push('\n');
    else kids(x).forEach(walk);
  };
  kids(n).forEach(walk);
  return parts.join('');
}

function lengthToPx(v?: string): number | null {
  if (!v) return null;
  const m = /^([\d.]+)(cm|mm|in|pt|px)$/.exec(v);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const f = { cm: 37.795, mm: 3.7795, in: 96, pt: 4 / 3, px: 1 }[m[2] as 'cm'];
  return Math.round(n * f);
}

function color(v?: string): string | undefined {
  return v && /^#[0-9a-f]{6}$/i.test(v) ? v.toUpperCase() : undefined;
}

export async function parseOds(buffer: Buffer): Promise<ImportedSheet[]> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw badRequest('Berkas ODS tidak dapat dibaca');
  }
  const content = await zip.file('content.xml')?.async('string');
  if (!content) throw badRequest('Berkas ODS tidak berisi content.xml');
  const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: false, processEntities: true });
  const doc = parser.parse(content) as XNode[];
  const find = (nodes: XNode[], name: string): XNode | undefined => {
    for (const n of nodes) {
      if (tag(n) === name) return n;
      const deep = find(kids(n), name);
      if (deep) return deep;
    }
    return undefined;
  };
  // Automatic styles: cell and column styles by name.
  const cellStyles = new Map<string, CellStyle>();
  const colWidths = new Map<string, number>();
  const rowHeights = new Map<string, number>();
  const auto = find(doc, 'office:automatic-styles');
  for (const st of auto ? kids(auto) : []) {
    if (tag(st) !== 'style:style') continue;
    const name = attr(st, 'style:name') ?? '';
    const family = attr(st, 'style:family');
    const s: CellStyle = {};
    for (const p of kids(st)) {
      const t = tag(p);
      if (t === 'style:table-column-properties') {
        const w = lengthToPx(attr(p, 'style:column-width'));
        if (w) colWidths.set(name, w);
      }
      if (t === 'style:table-row-properties') {
        const h = lengthToPx(attr(p, 'style:row-height'));
        if (h) rowHeights.set(name, h);
      }
      if (t === 'style:text-properties') {
        if (attr(p, 'fo:font-weight') === 'bold') s.bold = true;
        if (attr(p, 'fo:font-style') === 'italic') s.italic = true;
        if (attr(p, 'style:text-underline-style') && attr(p, 'style:text-underline-style') !== 'none') s.underline = true;
        if (attr(p, 'style:text-line-through-style') && attr(p, 'style:text-line-through-style') !== 'none') s.strike = true;
        const c = color(attr(p, 'fo:color'));
        if (c && c !== '#000000') s.textColor = c;
        const size = attr(p, 'fo:font-size');
        if (size?.endsWith('pt') && parseFloat(size) !== 10) s.fontSize = Math.round(parseFloat(size));
      }
      if (t === 'style:table-cell-properties') {
        const bg = color(attr(p, 'fo:background-color'));
        if (bg) s.backgroundColor = bg;
        if (attr(p, 'fo:wrap-option') === 'wrap') s.wrap = true;
        const va = attr(p, 'style:vertical-align');
        if (va === 'top' || va === 'bottom') s.vAlign = va;
        if (va === 'middle') s.vAlign = 'middle';
      }
      if (t === 'style:paragraph-properties') {
        const ta = attr(p, 'fo:text-align');
        if (ta === 'center') s.hAlign = 'center';
        if (ta === 'end' || ta === 'right') s.hAlign = 'right';
        if (ta === 'start' || ta === 'left') s.hAlign = 'left';
      }
    }
    if (family === 'table-cell') {
      const n = normalizeStyle(s);
      if (n) cellStyles.set(name, n);
    }
  }

  const spreadsheet = find(doc, 'office:spreadsheet');
  if (!spreadsheet) throw badRequest('Berkas ODS tidak berisi spreadsheet');
  const out: ImportedSheet[] = [];
  const used = new Set<string>();
  let total = 0;
  for (const table of kids(spreadsheet)) {
    if (tag(table) !== 'table:table') continue;
    let title = (attr(table, 'table:name') || `Sheet${out.length + 1}`).replace(/[[\]*?/\\:]/g, '_').slice(0, 100);
    while (used.has(title.toLowerCase())) title += '_';
    used.add(title.toLowerCase());
    const cells: ImportedSheet['cells'] = [];
    const metadata: SheetMetadata = { colWidths: {}, rowHeights: {}, merges: [], hiddenCols: [], hiddenRows: [] };
    let col = 0;
    let row = 0;
    const rowNodes: XNode[] = [];
    const collect = (nodes: XNode[]) => {
      for (const n of nodes) {
        const t = tag(n);
        if (t === 'table:table-column') {
          const rep = Math.min(Number(attr(n, 'table:number-columns-repeated') ?? 1), 16_384);
          const w = colWidths.get(attr(n, 'table:style-name') ?? '');
          const hidden = attr(n, 'table:visibility') === 'collapse';
          for (let k = 0; k < rep && col < 16_384; k++, col++) {
            if (w && rep < 1000) metadata.colWidths![col] = w;
            if (hidden && rep < 1000) metadata.hiddenCols!.push(col);
          }
        } else if (t === 'table:table-row') rowNodes.push(n);
        else if (t === 'table:table-header-rows' || t === 'table:table-rows' || t === 'table:table-row-group' || t === 'table:table-header-columns' || t === 'table:table-columns' || t === 'table:table-column-group')
          collect(kids(n));
      }
    };
    collect(kids(table));
    for (const rn of rowNodes) {
      const rep = Number(attr(rn, 'table:number-rows-repeated') ?? 1);
      const rowCells = kids(rn).filter((c) => tag(c) === 'table:table-cell' || tag(c) === 'table:covered-table-cell');
      const empty = rowCells.every((c) => !kids(c).length && !attr(c, 'office:value-type'));
      if (empty) {
        row += Math.min(rep, 1_048_576 - row);
        continue;
      }
      for (let k = 0; k < Math.min(rep, 1000); k++) {
        const h = rowHeights.get(attr(rn, 'table:style-name') ?? '');
        if (h && Math.abs(h - 24) > 2) metadata.rowHeights![row] = h;
        let c = 0;
        for (const cn of rowCells) {
          const crep = Math.min(Number(attr(cn, 'table:number-columns-repeated') ?? 1), 16_384);
          if (tag(cn) === 'table:covered-table-cell') {
            c += crep;
            continue;
          }
          const type = attr(cn, 'office:value-type');
          const formula = attr(cn, 'table:formula');
          let style = cellStyles.get(attr(cn, 'table:style-name') ?? '') ?? null;
          let raw = '';
          if (formula) raw = fromOpenFormula(formula);
          else if (type === 'float' || type === 'percentage' || type === 'currency') raw = attr(cn, 'office:value') ?? '';
          else if (type === 'boolean') raw = attr(cn, 'office:boolean-value') === 'true' ? 'TRUE' : 'FALSE';
          else if (type === 'date') {
            const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?/.exec(attr(cn, 'office:date-value') ?? '');
            if (m) {
              const serial = dateToSerial(+m[1], +m[2], +m[3]) + (m[4] ? (+m[4] * 3600 + +m[5] * 60 + +m[6]) / 86400 : 0);
              raw = String(serial);
              const hasTime = !!m[4] && (+m[4] || +m[5] || +m[6]);
              if (!isDateFormat(style?.numberFormat)) style = normalizeStyle({ ...(style ?? {}), numberFormat: hasTime ? 'datetime' : 'date' });
            }
          } else if (type === 'time') {
            const m = /^PT(\d+)H(\d+)M([\d.]+)S$/.exec(attr(cn, 'office:time-value') ?? '');
            if (m) {
              raw = String((+m[1] * 3600 + +m[2] * 60 + parseFloat(m[3])) / 86400);
              style = normalizeStyle({ ...(style ?? {}), numberFormat: 'time' });
            }
          } else if (type === 'string' || kids(cn).length) {
            const t = text(cn);
            raw = /^[-+]?[\d.,]+%?$/.test(t.trim()) || /^(TRUE|FALSE)$/i.test(t.trim()) || t.startsWith('=') ? `'${t}` : t;
          }
          if (type === 'percentage' && !style?.numberFormat) style = normalizeStyle({ ...(style ?? {}), numberFormat: 'percent' });
          const spanC = Number(attr(cn, 'table:number-columns-spanned') ?? 1);
          const spanR = Number(attr(cn, 'table:number-rows-spanned') ?? 1);
          for (let j = 0; j < crep && c < 16_384; j++, c++) {
            if (raw || style) {
              cells.push({ row, col: c, raw: raw.slice(0, 50_000), style });
              if (++total > 500_000) throw badRequest('Berkas terlalu besar (lebih dari 500.000 sel)');
            }
            if (spanC > 1 || spanR > 1) metadata.merges!.push({ r1: row, c1: c, r2: row + spanR - 1, c2: c + spanC - 1 } as Merge);
            if (crep > 100 && !raw && !style) {
              c += crep - j - 1;
              break;
            }
          }
        }
        row++;
      }
      if (rep > 1000) row += rep - 1000;
    }
    out.push({ title, cells, metadata, frozenRows: 0, frozenColumns: 0 });
  }
  if (!out.length) throw badRequest('Berkas tidak berisi sheet');
  return out;
}

// ---------- writing ----------

interface ExportSheet {
  id: string;
  title: string;
  metadata: SheetMetadata;
  defaultColumnWidth: number;
  cells: { row: number; col: number; raw: string; style?: CellStyle | null }[];
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function buildOds(sheets: ExportSheet[], engine: Engine): Promise<Buffer> {
  const styleNames = new Map<string, string>();
  const styleXml: string[] = [];
  const colStyleXml = new Map<number, string>();
  const styleFor = (s: CellStyle | null | undefined): string | null => {
    if (!s) return null;
    const key = JSON.stringify(s);
    let name = styleNames.get(key);
    if (name) return name;
    name = `ce${styleNames.size + 1}`;
    styleNames.set(key, name);
    const text = [
      s.bold ? 'fo:font-weight="bold"' : '',
      s.italic ? 'fo:font-style="italic"' : '',
      s.underline ? 'style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"' : '',
      s.strike ? 'style:text-line-through-style="solid"' : '',
      s.textColor ? `fo:color="${s.textColor}"` : '',
      s.fontSize ? `fo:font-size="${s.fontSize}pt"` : '',
    ].join(' ');
    const cell = [s.backgroundColor ? `fo:background-color="${s.backgroundColor}"` : '', s.wrap ? 'fo:wrap-option="wrap"' : '', s.vAlign ? `style:vertical-align="${s.vAlign}"` : ''].join(' ');
    const para = s.hAlign ? `fo:text-align="${s.hAlign === 'left' ? 'start' : s.hAlign === 'right' ? 'end' : 'center'}"` : '';
    styleXml.push(
      `<style:style style:name="${name}" style:family="table-cell"><style:table-cell-properties ${cell}/>${para ? `<style:paragraph-properties ${para}/>` : ''}<style:text-properties ${text}/></style:style>`,
    );
    return name;
  };
  const colStyle = (px: number) => {
    let n = colStyleXml.get(px);
    if (!n) {
      n = `co${colStyleXml.size + 1}`;
      colStyleXml.set(px, n);
    }
    return n;
  };

  const tables: string[] = [];
  for (const s of sheets) {
    const grid = new Map<string, { raw: string; style?: CellStyle | null }>();
    let rows = 0;
    let cols = 0;
    for (const c of s.cells) {
      grid.set(`${c.row}:${c.col}`, c);
      rows = Math.max(rows, c.row + 1);
      cols = Math.max(cols, c.col + 1);
    }
    for (const c of engine.spillCells(s.id)) {
      if (!grid.has(`${c.row}:${c.col}`)) grid.set(`${c.row}:${c.col}`, { raw: '' });
      rows = Math.max(rows, c.row + 1);
      cols = Math.max(cols, c.col + 1);
    }
    const covered = new Set<string>();
    const spans = new Map<string, Merge>();
    for (const m of s.metadata.merges ?? []) {
      spans.set(`${m.r1}:${m.c1}`, m);
      for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) if (r !== m.r1 || c !== m.c1) covered.add(`${r}:${c}`);
      rows = Math.max(rows, m.r2 + 1);
      cols = Math.max(cols, m.c2 + 1);
    }
    let xml = `<table:table table:name="${esc(s.title)}">`;
    for (let c = 0; c < Math.max(cols, 1); c++) xml += `<table:table-column table:style-name="${colStyle(s.metadata.colWidths?.[c] ?? s.defaultColumnWidth)}"/>`;
    for (let r = 0; r < rows; r++) {
      xml += '<table:table-row>';
      for (let c = 0; c < cols; c++) {
        const key = `${r}:${c}`;
        if (covered.has(key)) {
          xml += '<table:covered-table-cell/>';
          continue;
        }
        const cell = grid.get(key);
        const m = spans.get(key);
        const span = m ? ` table:number-columns-spanned="${m.c2 - m.c1 + 1}" table:number-rows-spanned="${m.r2 - m.r1 + 1}"` : '';
        if (!cell) {
          xml += `<table:table-cell${span}/>`;
          continue;
        }
        const st = styleFor(cell.style);
        const stAttr = st ? ` table:style-name="${st}"` : '';
        const v = toStored(engine.getValue(s.id, r, c));
        const f = cell.raw.startsWith('=') && cell.raw.length > 1 ? toOpenFormula(cell.raw) : null;
        const fAttr = f ? ` table:formula="${esc(f)}"` : '';
        if (typeof v === 'number') {
          if (isDateFormat(cell.style?.numberFormat) && v >= 0) {
            const p = serialToParts(v);
            const iso = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}T${String(p.hours).padStart(2, '0')}:${String(p.minutes).padStart(2, '0')}:${String(p.seconds).padStart(2, '0')}`;
            xml += `<table:table-cell${stAttr}${fAttr}${span} office:value-type="date" office:date-value="${iso}"><text:p>${esc(iso.slice(0, 10))}</text:p></table:table-cell>`;
          } else
            xml += `<table:table-cell${stAttr}${fAttr}${span} office:value-type="${cell.style?.numberFormat === 'percent' ? 'percentage' : 'float'}" office:value="${v}"><text:p>${v}</text:p></table:table-cell>`;
        } else if (typeof v === 'boolean') {
          xml += `<table:table-cell${stAttr}${fAttr}${span} office:value-type="boolean" office:boolean-value="${v}"><text:p>${v ? 'TRUE' : 'FALSE'}</text:p></table:table-cell>`;
        } else if (v !== null && typeof v === 'object') {
          xml += `<table:table-cell${stAttr}${fAttr}${span} office:value-type="string" office:string-value="${esc(v.error)}"><text:p>${esc(v.error)}</text:p></table:table-cell>`;
        } else if (v !== null && v !== '') {
          const lines = String(v)
            .split('\n')
            .map((l) => `<text:p>${esc(l)}</text:p>`)
            .join('');
          xml += `<table:table-cell${stAttr}${fAttr}${span} office:value-type="string">${lines}</table:table-cell>`;
        } else xml += `<table:table-cell${stAttr}${fAttr}${span}/>`;
      }
      xml += '</table:table-row>';
    }
    xml += '</table:table>';
    tables.push(xml);
  }
  const colStyles = [...colStyleXml.entries()]
    .map(([px, name]) => `<style:style style:name="${name}" style:family="table-column"><style:table-column-properties style:column-width="${(px / 37.795).toFixed(3)}cm"/></style:style>`)
    .join('');
  const ns =
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2"';
  const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ns} office:version="1.2"><office:automatic-styles>${colStyles}${styleXml.join('')}</office:automatic-styles><office:body><office:spreadsheet>${tables.join('')}</office:spreadsheet></office:body></office:document-content>`;
  const zip = new JSZip();
  // The mimetype entry must come first and be stored uncompressed.
  zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet', { compression: 'STORE' });
  zip.file(
    'META-INF/manifest.xml',
    `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>`,
  );
  zip.file('styles.xml', `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${ns} office:version="1.2"/>`);
  zip.file('content.xml', content);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: 'application/vnd.oasis.opendocument.spreadsheet' });
}

export { XMLBuilder };
