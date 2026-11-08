import { MAX_COLS, MAX_ROWS } from './address';
import { Node, parseFormula, RefPart } from './parser';
import { serialize } from './serialize';

type RefMapper = (
  node: Extract<Node, { type: 'ref' }> | Extract<Node, { type: 'range' }>,
) => Node;

function mapRefs(node: Node, fn: RefMapper): Node {
  switch (node.type) {
    case 'ref':
    case 'range':
      return fn(node);
    case 'func':
      return { ...node, args: node.args.map((a) => mapRefs(a, fn)) };
    case 'unary':
    case 'percent':
      return { ...node, arg: mapRefs(node.arg, fn) };
    case 'binary':
      return { ...node, left: mapRefs(node.left, fn), right: mapRefs(node.right, fn) };
    case 'paren':
      return { ...node, inner: mapRefs(node.inner, fn) };
    default:
      return node;
  }
}

const REF_ERROR: Node = { type: 'err', code: '#REF!' };

function rewrite(formula: string, fn: RefMapper): string {
  if (!formula.startsWith('=')) return formula;
  let ast: Node;
  try {
    ast = parseFormula(formula.slice(1));
  } catch {
    return formula;
  }
  const out = mapRefs(ast, fn);
  if (out === ast) return formula;
  const text = '=' + serialize(out);
  // Keep the user's original spacing when nothing actually changed.
  return text === '=' + serialize(ast) ? formula : text;
}

/** Shifts relative references, as when copying a formula dr rows and dc columns away. */
export function translateFormula(formula: string, dr: number, dc: number): string {
  if (dr === 0 && dc === 0) return formula;
  const shift = (p: RefPart): RefPart | null => {
    const row = p.row < 0 || p.rowAbs ? p.row : p.row + dr;
    const col = p.col < 0 || p.colAbs ? p.col : p.col + dc;
    if ((p.row >= 0 && (row < 0 || row >= MAX_ROWS)) || (p.col >= 0 && (col < 0 || col >= MAX_COLS))) return null;
    return { ...p, row, col };
  };
  return rewrite(formula, (n) => {
    if (n.type === 'ref') {
      const r = shift(n.ref);
      return r ? { ...n, ref: r } : REF_ERROR;
    }
    const s = shift(n.start);
    const e = shift(n.end);
    return s && e ? { ...n, start: s, end: e } : REF_ERROR;
  });
}

export interface StructuralOp {
  sheetName: string;
  axis: 'row' | 'col';
  /** Zero-based index where rows/cols are inserted or the first deleted one. */
  index: number;
  /** Positive inserts, negative deletes. */
  count: number;
}

function sameSheet(refSheet: string | undefined, formulaSheet: string, target: string): boolean {
  const name = refSheet ?? formulaSheet;
  return name.toLowerCase() === target.toLowerCase();
}

/** Adjusts one coordinate for an insert/delete. Returns null when the coordinate was deleted. */
function adjustIndex(i: number, op: StructuralOp): number | null {
  if (op.count > 0) return i >= op.index ? i + op.count : i;
  const del = -op.count;
  if (i < op.index) return i;
  if (i >= op.index + del) return i - del;
  return null;
}

/**
 * Rewrites references in a formula living on `formulaSheet` after rows/columns
 * were inserted or deleted on `op.sheetName`.
 */
export function adjustFormulaForStructure(formula: string, formulaSheet: string, op: StructuralOp): string {
  const key = op.axis === 'row' ? 'row' : 'col';
  return rewrite(formula, (n) => {
    if (!sameSheet(n.sheet, formulaSheet, op.sheetName)) return n;
    if (n.type === 'ref') {
      const v = adjustIndex(n.ref[key], op);
      if (v === null) return REF_ERROR;
      return v === n.ref[key] ? n : { ...n, ref: { ...n.ref, [key]: v } };
    }
    // Whole-row ranges are unaffected by column changes and vice versa.
    if ((n.kind === 'cols' && key === 'row') || (n.kind === 'rows' && key === 'col')) return n;
    const a = Math.min(n.start[key], n.end[key]);
    const b = Math.max(n.start[key], n.end[key]);
    let na: number;
    let nb: number;
    if (op.count > 0) {
      na = a >= op.index ? a + op.count : a;
      // Inserting inside a range grows it.
      nb = b >= op.index ? b + op.count : b;
    } else {
      const del = -op.count;
      const dEnd = op.index + del - 1;
      if (a >= op.index && b <= dEnd) return REF_ERROR;
      na = a < op.index ? a : a > dEnd ? a - del : op.index;
      nb = b < op.index ? b : b > dEnd ? b - del : op.index - 1;
    }
    if (na === a && nb === b) return n;
    const startFirst = n.start[key] <= n.end[key];
    return {
      ...n,
      start: { ...n.start, [key]: startFirst ? na : nb },
      end: { ...n.end, [key]: startFirst ? nb : na },
    };
  });
}

/** Rewrites references to a renamed sheet. */
export function renameSheetInFormula(formula: string, oldName: string, newName: string): string {
  return rewrite(formula, (n) => {
    if (n.sheet !== undefined && n.sheet.toLowerCase() === oldName.toLowerCase()) return { ...n, sheet: newName };
    return n;
  });
}

/** Replaces references to a deleted sheet with #REF!. */
export function removeSheetFromFormula(formula: string, name: string): string {
  return rewrite(formula, (n) => (n.sheet !== undefined && n.sheet.toLowerCase() === name.toLowerCase() ? REF_ERROR : n));
}

/**
 * Rewrites references after a block of cells was cut and pasted elsewhere on the
 * same sheet: references pointing into the source block follow the move.
 */
export function moveRefsInFormula(
  formula: string,
  formulaSheet: string,
  sheetName: string,
  src: { r1: number; c1: number; r2: number; c2: number },
  dr: number,
  dc: number,
): string {
  const inside = (p: RefPart) => p.row >= src.r1 && p.row <= src.r2 && p.col >= src.c1 && p.col <= src.c2;
  return rewrite(formula, (n) => {
    if (!sameSheet(n.sheet, formulaSheet, sheetName)) return n;
    if (n.type === 'ref') {
      return inside(n.ref) ? { ...n, ref: { ...n.ref, row: n.ref.row + dr, col: n.ref.col + dc } } : n;
    }
    if (n.kind === 'cells' && inside(n.start) && inside(n.end)) {
      return {
        ...n,
        start: { ...n.start, row: n.start.row + dr, col: n.start.col + dc },
        end: { ...n.end, row: n.end.row + dr, col: n.end.col + dc },
      };
    }
    return n;
  });
}

/**
 * Rewrites references after rows or columns were reordered: `map` gives the new index of an
 * old one (identity outside the moved span). A reference follows the cell it pointed at; the
 * two ends of a range are mapped one by one, so a range that straddles the move is normalised.
 */
export function permuteRefsInFormula(formula: string, formulaSheet: string, sheetName: string, axis: 'row' | 'col', map: (i: number) => number): string {
  return rewrite(formula, (n) => {
    if (!sameSheet(n.sheet, formulaSheet, sheetName)) return n;
    if (n.type === 'ref') {
      const v = n.ref[axis];
      if (v < 0) return n;
      const m = map(v);
      return m === v ? n : { ...n, ref: { ...n.ref, [axis]: m } };
    }
    if ((n.kind === 'cols' && axis === 'row') || (n.kind === 'rows' && axis === 'col')) return n;
    const s = n.start[axis];
    const e = n.end[axis];
    if (s < 0 || e < 0) return n;
    const ms = map(s);
    const me = map(e);
    if (ms === s && me === e) return n;
    const lo = Math.min(ms, me);
    const hi = Math.max(ms, me);
    const startFirst = s <= e;
    return { ...n, start: { ...n.start, [axis]: startFirst ? lo : hi }, end: { ...n.end, [axis]: startFirst ? hi : lo } };
  });
}
