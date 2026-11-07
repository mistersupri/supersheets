import { lettersToCol, MAX_COLS, MAX_ROWS } from './address';
import { ERROR_CODES, ErrorCode } from './values';

export interface RefPart {
  row: number; // -1 when the reference is a whole column
  col: number; // -1 when the reference is a whole row
  rowAbs: boolean;
  colAbs: boolean;
}

export type Node =
  | { type: 'num'; value: number }
  | { type: 'str'; value: string }
  | { type: 'bool'; value: boolean }
  | { type: 'err'; code: ErrorCode }
  | { type: 'ref'; sheet?: string; ref: RefPart }
  | { type: 'range'; sheet?: string; start: RefPart; end: RefPart; kind: 'cells' | 'cols' | 'rows' }
  | { type: 'name'; name: string }
  | { type: 'func'; name: string; args: Node[] }
  | { type: 'unary'; op: '-' | '+'; arg: Node }
  | { type: 'percent'; arg: Node }
  | { type: 'binary'; op: BinaryOp; left: Node; right: Node }
  | { type: 'paren'; inner: Node };

export type BinaryOp = '+' | '-' | '*' | '/' | '^' | '&' | '=' | '<>' | '<' | '>' | '<=' | '>=';

export class ParseError extends Error {}

type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'err'; v: ErrorCode }
  | { t: 'ident'; v: string }
  | { t: 'func'; v: string }
  | { t: 'ref'; node: Node }
  | { t: 'op'; v: string }
  | { t: 'lparen' }
  | { t: 'rparen' }
  | { t: 'comma' }
  | { t: 'eof' };

const SHEET = `(?:'((?:[^']|'')+)'|([A-Za-z_\\u00C0-\\uFFFF][A-Za-z0-9_.\\u00C0-\\uFFFF]*))!`;
const CELL = `(\\$?)([A-Za-z]{1,3})(\\$?)(\\d{1,7})`;
const COL = `(\\$?)([A-Za-z]{1,3})`;
const ROW = `(\\$?)(\\d{1,7})`;

const RE_CELL_RANGE = new RegExp(`^(?:${SHEET})?${CELL}(?::${CELL})?(?![A-Za-z0-9_(!])`);
const RE_COL_RANGE = new RegExp(`^(?:${SHEET})?${COL}:${COL}(?![A-Za-z0-9_(!])`);
const RE_ROW_RANGE = new RegExp(`^(?:${SHEET})?${ROW}:${ROW}(?![A-Za-z0-9_(!.])`);

function sheetFrom(quoted?: string, bare?: string): string | undefined {
  if (quoted !== undefined) return quoted.replace(/''/g, "'");
  return bare;
}

function cellPart(colAbs: string, letters: string, rowAbs: string, digits: string): RefPart {
  const col = lettersToCol(letters);
  const row = parseInt(digits, 10) - 1;
  if (col < 0 || col >= MAX_COLS || row < 0 || row >= MAX_ROWS) throw new ParseError('Reference out of range');
  return { row, col, rowAbs: rowAbs === '$', colAbs: colAbs === '$' };
}

function tryRef(src: string): { len: number; node: Node } | null {
  let m = RE_CELL_RANGE.exec(src);
  if (m) {
    const sheet = sheetFrom(m[1], m[2]);
    // A bare identifier such as "LOG10" followed by "(" is a function, which the
    // negative lookahead already excludes.
    const start = cellPart(m[3], m[4], m[5], m[6]);
    if (m[7] !== undefined) {
      const end = cellPart(m[7], m[8], m[9], m[10]);
      return { len: m[0].length, node: { type: 'range', sheet, start, end, kind: 'cells' } };
    }
    return { len: m[0].length, node: { type: 'ref', sheet, ref: start } };
  }
  m = RE_COL_RANGE.exec(src);
  if (m) {
    const sheet = sheetFrom(m[1], m[2]);
    const c1 = lettersToCol(m[4]);
    const c2 = lettersToCol(m[6]);
    if (c1 < 0 || c2 < 0 || c1 >= MAX_COLS || c2 >= MAX_COLS) return null;
    return {
      len: m[0].length,
      node: {
        type: 'range',
        sheet,
        kind: 'cols',
        start: { row: -1, col: c1, rowAbs: false, colAbs: m[3] === '$' },
        end: { row: -1, col: c2, rowAbs: false, colAbs: m[5] === '$' },
      },
    };
  }
  m = RE_ROW_RANGE.exec(src);
  if (m) {
    const sheet = sheetFrom(m[1], m[2]);
    const r1 = parseInt(m[4], 10) - 1;
    const r2 = parseInt(m[6], 10) - 1;
    if (r1 < 0 || r2 < 0 || r1 >= MAX_ROWS || r2 >= MAX_ROWS) return null;
    return {
      len: m[0].length,
      node: {
        type: 'range',
        sheet,
        kind: 'rows',
        start: { row: r1, col: -1, rowAbs: m[3] === '$', colAbs: false },
        end: { row: r2, col: -1, rowAbs: m[5] === '$', colAbs: false },
      },
    };
  }
  return null;
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let prevSignificant: Tok | null = null;
  const push = (t: Tok) => {
    out.push(t);
    prevSignificant = t;
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let s = '';
      for (;;) {
        if (j >= src.length) throw new ParseError('Unterminated string');
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            s += '"';
            j += 2;
            continue;
          }
          break;
        }
        s += src[j++];
      }
      push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (ch === '#') {
      const code = ERROR_CODES.find((c) => src.startsWith(c, i) || src.toUpperCase().startsWith(c, i));
      if (!code) throw new ParseError('Unknown error literal');
      push({ t: 'err', v: code });
      i += code.length;
      continue;
    }
    const rest = src.slice(i);
    // A row range like 1:3 must win over the number 1, but only where an operand is expected.
    const operandExpected =
      prevSignificant === null ||
      (prevSignificant as Tok).t === 'op' ||
      (prevSignificant as Tok).t === 'lparen' ||
      (prevSignificant as Tok).t === 'comma';
    if (operandExpected || ch === "'" || /[A-Za-z_$]/.test(ch)) {
      const ref = operandExpected || ch === "'" || /[A-Za-z_$]/.test(ch) ? tryRef(rest) : null;
      if (ref && (operandExpected || ref.node.type !== 'range' || ref.node.kind !== 'rows')) {
        push({ t: 'ref', node: ref.node });
        i += ref.len;
        continue;
      }
    }
    if (/[0-9.]/.test(ch)) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(rest);
      if (!m) throw new ParseError('Bad number');
      push({ t: 'num', v: parseFloat(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_À-￿]/.test(ch)) {
      const m = /^[A-Za-z_À-￿][A-Za-z0-9_.À-￿]*/.exec(rest)!;
      const word = m[0];
      let j = i + word.length;
      while (src[j] === ' ') j++;
      if (src[j] === '(') push({ t: 'func', v: word.toUpperCase() });
      else push({ t: 'ident', v: word });
      i += word.length;
      continue;
    }
    if (ch === '(') {
      push({ t: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')') {
      push({ t: 'rparen' });
      i++;
      continue;
    }
    if (ch === ',' || ch === ';') {
      push({ t: 'comma' });
      i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '<>' || two === '<=' || two === '>=') {
      push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('+-*/^&=<>%'.includes(ch)) {
      push({ t: 'op', v: ch });
      i++;
      continue;
    }
    throw new ParseError(`Unexpected character "${ch}"`);
  }
  out.push({ t: 'eof' });
  return out;
}

class Parser {
  private pos = 0;
  constructor(private toks: Tok[]) {}

  private peek(): Tok {
    return this.toks[this.pos];
  }
  private next(): Tok {
    return this.toks[this.pos++];
  }
  private isOp(...ops: string[]): string | null {
    const t = this.peek();
    return t.t === 'op' && ops.includes(t.v) ? t.v : null;
  }

  parse(): Node {
    const n = this.comparison();
    if (this.peek().t !== 'eof') throw new ParseError('Unexpected token');
    return n;
  }

  private comparison(): Node {
    let left = this.concat();
    let op: string | null;
    while ((op = this.isOp('=', '<>', '<', '>', '<=', '>='))) {
      this.next();
      left = { type: 'binary', op: op as BinaryOp, left, right: this.concat() };
    }
    return left;
  }
  private concat(): Node {
    let left = this.additive();
    while (this.isOp('&')) {
      this.next();
      left = { type: 'binary', op: '&', left, right: this.additive() };
    }
    return left;
  }
  private additive(): Node {
    let left = this.multiplicative();
    let op: string | null;
    while ((op = this.isOp('+', '-'))) {
      this.next();
      left = { type: 'binary', op: op as BinaryOp, left, right: this.multiplicative() };
    }
    return left;
  }
  private multiplicative(): Node {
    let left = this.power();
    let op: string | null;
    while ((op = this.isOp('*', '/'))) {
      this.next();
      left = { type: 'binary', op: op as BinaryOp, left, right: this.power() };
    }
    return left;
  }
  private power(): Node {
    let left = this.postfix();
    while (this.isOp('^')) {
      this.next();
      left = { type: 'binary', op: '^', left, right: this.postfix() };
    }
    return left;
  }
  private postfix(): Node {
    let n = this.unary();
    while (this.isOp('%')) {
      this.next();
      n = { type: 'percent', arg: n };
    }
    return n;
  }
  private unary(): Node {
    const op = this.isOp('+', '-');
    if (op) {
      this.next();
      return { type: 'unary', op: op as '+' | '-', arg: this.unary() };
    }
    return this.primary();
  }
  private primary(): Node {
    const t = this.next();
    switch (t.t) {
      case 'num':
        return { type: 'num', value: t.v };
      case 'str':
        return { type: 'str', value: t.v };
      case 'err':
        return { type: 'err', code: t.v };
      case 'ref':
        return t.node;
      case 'ident': {
        const up = t.v.toUpperCase();
        if (up === 'TRUE') return { type: 'bool', value: true };
        if (up === 'FALSE') return { type: 'bool', value: false };
        return { type: 'name', name: t.v };
      }
      case 'func': {
        if (this.next().t !== 'lparen') throw new ParseError('Expected (');
        const args: Node[] = [];
        if (this.peek().t === 'rparen') {
          this.next();
          return { type: 'func', name: t.v, args };
        }
        for (;;) {
          // Empty argument, e.g. VLOOKUP(a,b,2,)
          if (this.peek().t === 'comma' || this.peek().t === 'rparen') args.push({ type: 'str', value: '' } as Node);
          else args.push(this.comparison());
          const sep = this.next();
          if (sep.t === 'rparen') break;
          if (sep.t !== 'comma') throw new ParseError('Expected , or )');
        }
        return { type: 'func', name: t.v, args };
      }
      case 'lparen': {
        const inner = this.comparison();
        if (this.next().t !== 'rparen') throw new ParseError('Expected )');
        return { type: 'paren', inner };
      }
      default:
        throw new ParseError('Unexpected token');
    }
  }
}

/** Parses the formula body, without the leading "=". */
export function parseFormula(body: string): Node {
  return new Parser(tokenize(body)).parse();
}

/** Lists the function names used in a formula, for validation and autocomplete. */
export function collectFunctions(node: Node, out = new Set<string>()): Set<string> {
  switch (node.type) {
    case 'func':
      out.add(node.name);
      node.args.forEach((a) => collectFunctions(a, out));
      break;
    case 'unary':
    case 'percent':
      collectFunctions(node.arg, out);
      break;
    case 'binary':
      collectFunctions(node.left, out);
      collectFunctions(node.right, out);
      break;
    case 'paren':
      collectFunctions(node.inner, out);
      break;
  }
  return out;
}
