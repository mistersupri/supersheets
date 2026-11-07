import { MAX_COLS, MAX_ROWS } from './address';
import { formatGeneralNumber } from './format';
import { Node } from './parser';
import { err, FormulaError, isError, Scalar } from './values';

export interface EvalContext {
  /** Sheet the formula lives in. */
  sheetId: string;
  row: number;
  col: number;
  getValue(sheetId: string, row: number, col: number): Scalar;
  resolveSheet(name: string): string | null;
  /** Size of the used area, used to clip whole-row and whole-column ranges. */
  usedSize(sheetId: string): { rows: number; cols: number };
  now(): Date;
}

export class RangeRef {
  constructor(
    readonly ctx: EvalContext,
    readonly sheetId: string,
    readonly r1: number,
    readonly c1: number,
    readonly r2: number,
    readonly c2: number,
  ) {}
  get rows(): number {
    return this.r2 - this.r1 + 1;
  }
  get cols(): number {
    return this.c2 - this.c1 + 1;
  }
  get(r: number, c: number): Scalar {
    return this.ctx.getValue(this.sheetId, this.r1 + r, this.c1 + c);
  }
  /** Row-major iteration over every value. */
  *values(): Generator<Scalar> {
    for (let r = this.r1; r <= this.r2; r++) {
      for (let c = this.c1; c <= this.c2; c++) yield this.ctx.getValue(this.sheetId, r, c);
    }
  }
}

export type Arg = Scalar | RangeRef;

// ---------- coercion helpers ----------

export function toNumber(v: Scalar): number | FormulaError {
  if (v === null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof FormulaError) return v;
  const t = v.trim();
  if (t === '') return 0;
  const pct = t.endsWith('%');
  const n = Number((pct ? t.slice(0, -1) : t).replace(/,/g, ''));
  if (Number.isNaN(n)) return err.value(`"${v}" bukan angka`);
  return pct ? n / 100 : n;
}

export function toText(v: Scalar): string | FormulaError {
  if (v === null) return '';
  if (v instanceof FormulaError) return v;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return formatGeneralNumber(v);
  return v;
}

export function toBool(v: Scalar): boolean | FormulaError {
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v instanceof FormulaError) return v;
  const up = v.trim().toUpperCase();
  if (up === 'TRUE') return true;
  if (up === 'FALSE') return false;
  return err.value(`"${v}" bukan nilai logika`);
}

/** Collapses a range argument to one value (top-left), as a scalar context would. */
export function scalarOf(a: Arg): Scalar {
  if (a instanceof RangeRef) {
    if (a.rows === 1 && a.cols === 1) return a.get(0, 0);
    return err.value('Rentang dipakai di tempat yang membutuhkan satu nilai');
  }
  return a;
}

/** Spreadsheet ordering: numbers < text < booleans; text compares case-insensitively. */
export function compareValues(a: Scalar, b: Scalar): number {
  const rank = (v: Scalar) => (v === null ? 0 : typeof v === 'number' ? 1 : typeof v === 'string' ? 2 : 3);
  if (a === null && typeof b === 'number') a = 0;
  if (b === null && typeof a === 'number') b = 0;
  if (a === null && typeof b === 'string') a = '';
  if (b === null && typeof a === 'string') b = '';
  if (a === null && typeof b === 'boolean') a = false;
  if (b === null && typeof a === 'boolean') b = false;
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === 'string' && typeof b === 'string') {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x === y ? 0 : x < y ? -1 : 1;
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  return 0;
}

// ---------- evaluation ----------

export type FunctionImpl = (args: Arg[], ctx: EvalContext) => Scalar;

export interface FunctionSpec {
  impl: FunctionImpl;
  minArgs: number;
  maxArgs: number;
  /** Arguments evaluated only on demand (IF, IFERROR). */
  lazy?: boolean;
  volatile?: boolean;
  category: string;
  syntax: string;
  description: string;
}

export type LazyImpl = (args: Node[], ctx: EvalContext, ev: (n: Node) => Arg) => Arg;

export const functionRegistry = new Map<string, FunctionSpec>();
export const lazyRegistry = new Map<string, LazyImpl>();

function evalRef(node: Extract<Node, { type: 'ref' }>, ctx: EvalContext): Arg {
  const sheetId = node.sheet === undefined ? ctx.sheetId : ctx.resolveSheet(node.sheet);
  if (sheetId === null) return err.ref(`Sheet "${node.sheet}" tidak ditemukan`);
  return ctx.getValue(sheetId, node.ref.row, node.ref.col);
}

function evalRange(node: Extract<Node, { type: 'range' }>, ctx: EvalContext): Arg {
  const sheetId = node.sheet === undefined ? ctx.sheetId : ctx.resolveSheet(node.sheet);
  if (sheetId === null) return err.ref(`Sheet "${node.sheet}" tidak ditemukan`);
  const used = ctx.usedSize(sheetId);
  if (node.kind === 'cols') {
    const c1 = Math.min(node.start.col, node.end.col);
    const c2 = Math.max(node.start.col, node.end.col);
    return new RangeRef(ctx, sheetId, 0, c1, Math.max(0, Math.min(used.rows, MAX_ROWS) - 1), c2);
  }
  if (node.kind === 'rows') {
    const r1 = Math.min(node.start.row, node.end.row);
    const r2 = Math.max(node.start.row, node.end.row);
    return new RangeRef(ctx, sheetId, r1, 0, r2, Math.max(0, Math.min(used.cols, MAX_COLS) - 1));
  }
  return new RangeRef(
    ctx,
    sheetId,
    Math.min(node.start.row, node.end.row),
    Math.min(node.start.col, node.end.col),
    Math.max(node.start.row, node.end.row),
    Math.max(node.start.col, node.end.col),
  );
}

function arith(op: string, a: number, b: number): Scalar {
  switch (op) {
    case '+':
      return a + b;
    case '-':
      return a - b;
    case '*':
      return a * b;
    case '/':
      return b === 0 ? err.div0('Pembagian dengan nol') : a / b;
    case '^': {
      if (a === 0 && b < 0) return err.div0();
      const r = Math.pow(a, b);
      return Number.isFinite(r) ? r : err.num();
    }
  }
  return err.value();
}

export function evaluate(node: Node, ctx: EvalContext): Arg {
  switch (node.type) {
    case 'num':
      return node.value;
    case 'str':
      return node.value;
    case 'bool':
      return node.value;
    case 'err':
      return new FormulaError(node.code);
    case 'name':
      return err.name(`Nama "${node.name}" tidak dikenal`);
    case 'ref':
      return evalRef(node, ctx);
    case 'range':
      return evalRange(node, ctx);
    case 'paren':
      return evaluate(node.inner, ctx);
    case 'unary': {
      const v = scalarOf(evaluate(node.arg, ctx));
      const n = toNumber(v);
      if (isError(n)) return n;
      return node.op === '-' ? -n : n;
    }
    case 'percent': {
      const n = toNumber(scalarOf(evaluate(node.arg, ctx)));
      return isError(n) ? n : n / 100;
    }
    case 'binary': {
      const l = scalarOf(evaluate(node.left, ctx));
      const r = scalarOf(evaluate(node.right, ctx));
      if (isError(l)) return l;
      if (isError(r)) return r;
      if (node.op === '&') {
        const a = toText(l);
        const b = toText(r);
        if (isError(a)) return a;
        if (isError(b)) return b;
        return a + b;
      }
      if (['=', '<>', '<', '>', '<=', '>='].includes(node.op)) {
        const c = compareValues(l, r);
        switch (node.op) {
          case '=':
            return c === 0;
          case '<>':
            return c !== 0;
          case '<':
            return c < 0;
          case '>':
            return c > 0;
          case '<=':
            return c <= 0;
          case '>=':
            return c >= 0;
        }
      }
      const a = toNumber(l);
      const b = toNumber(r);
      if (isError(a)) return a;
      if (isError(b)) return b;
      return arith(node.op, a, b);
    }
    case 'func': {
      const lazy = lazyRegistry.get(node.name);
      if (lazy) return lazy(node.args, ctx, (n) => evaluate(n, ctx));
      const spec = functionRegistry.get(node.name);
      if (!spec) return err.name(`Fungsi ${node.name} tidak dikenal`);
      if (node.args.length < spec.minArgs || node.args.length > spec.maxArgs) {
        return err.value(`Jumlah argumen ${node.name} tidak sesuai`);
      }
      const args = node.args.map((a) => evaluate(a, ctx));
      return spec.impl(args, ctx);
    }
  }
}
