/** Excel limits: these bound every reference the parser accepts. */
export const MAX_ROWS = 1_048_576;
export const MAX_COLS = 16_384;

export interface CellAddress {
  row: number; // zero based
  col: number; // zero based
}

export interface RangeAddress {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export function colToLetters(col: number): string {
  let n = col + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function lettersToCol(letters: string): number {
  let n = 0;
  const up = letters.toUpperCase();
  for (let i = 0; i < up.length; i++) {
    const code = up.charCodeAt(i);
    if (code < 65 || code > 90) return -1;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

export function formatA1(row: number, col: number): string {
  return `${colToLetters(col)}${row + 1}`;
}

const A1_RE = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;

export function parseA1(text: string): CellAddress | null {
  const m = A1_RE.exec(text.trim());
  if (!m) return null;
  const col = lettersToCol(m[1]);
  const row = parseInt(m[2], 10) - 1;
  if (row < 0 || row >= MAX_ROWS || col < 0 || col >= MAX_COLS) return null;
  return { row, col };
}

export function normalizeRange(r: RangeAddress): RangeAddress {
  return {
    r1: Math.min(r.r1, r.r2),
    c1: Math.min(r.c1, r.c2),
    r2: Math.max(r.r1, r.r2),
    c2: Math.max(r.c1, r.c2),
  };
}

/** Parses "A1", "A1:B5". Sheet prefixes are not accepted here. */
export function parseRangeA1(text: string): RangeAddress | null {
  const parts = text.trim().split(':');
  if (parts.length === 1) {
    const a = parseA1(parts[0]);
    return a ? { r1: a.row, c1: a.col, r2: a.row, c2: a.col } : null;
  }
  if (parts.length !== 2) return null;
  const a = parseA1(parts[0]);
  const b = parseA1(parts[1]);
  if (!a || !b) return null;
  return normalizeRange({ r1: a.row, c1: a.col, r2: b.row, c2: b.col });
}

export function formatRangeA1(r: RangeAddress): string {
  const n = normalizeRange(r);
  if (n.r1 === n.r2 && n.c1 === n.c2) return formatA1(n.r1, n.c1);
  return `${formatA1(n.r1, n.c1)}:${formatA1(n.r2, n.c2)}`;
}

export function rangeContains(r: RangeAddress, row: number, col: number): boolean {
  return row >= r.r1 && row <= r.r2 && col >= r.c1 && col <= r.c2;
}

export function rangesIntersect(a: RangeAddress, b: RangeAddress): boolean {
  return a.r1 <= b.r2 && b.r1 <= a.r2 && a.c1 <= b.c2 && b.c1 <= a.c2;
}

export function cellKey(row: number, col: number): string {
  return `${row}:${col}`;
}

export function parseCellKey(key: string): CellAddress {
  const i = key.indexOf(':');
  return { row: Number(key.slice(0, i)), col: Number(key.slice(i + 1)) };
}

/** Quotes a sheet name for use inside a formula when needed. */
export function quoteSheetName(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name)) return name;
  return `'${name.replace(/'/g, "''")}'`;
}
