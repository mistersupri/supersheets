import { parseRangeA1, colToLetters } from './address';
import { Arg, ArrayValue, compareValues, functionRegistry, Grid, MAX_ARRAY_CELLS, RangeRef, scalarOf, toBool, toNumber, toText, type EvalContext, type FunctionImpl } from './evaluator';
import { err, FormulaError, isError, Scalar } from './values';

/** Array functions. Their results spill into neighbouring cells (see engine.ts). */

function def(name: string, syntax: string, description: string, minArgs: number, maxArgs: number, impl: FunctionImpl, category = 'Array') {
  functionRegistry.set(name, { impl, minArgs, maxArgs, category, syntax, description });
}

function grid(a: Arg): Grid {
  return a instanceof Grid ? a : new ArrayValue([[a]]);
}

function num(a: Arg): number | FormulaError {
  return toNumber(scalarOf(a));
}

function rowsOf(g: Grid): Scalar[][] {
  return g.toArray();
}

// ---------- SEQUENCE, TRANSPOSE, ARRAYFORMULA ----------

def('SEQUENCE', 'SEQUENCE(baris, [kolom], [mulai], [langkah])', 'Deret angka sebagai array.', 1, 4, ([r, c, s, st]) => {
  const rows = num(r);
  const cols = c === undefined || c === '' ? 1 : num(c);
  const start = s === undefined || s === '' ? 1 : num(s);
  const step = st === undefined || st === '' ? 1 : num(st);
  for (const x of [rows, cols, start, step]) if (isError(x)) return x;
  const R = Math.trunc(rows as number);
  const C = Math.trunc(cols as number);
  if (R < 1 || C < 1) return err.value('Jumlah baris dan kolom harus minimal 1');
  if (R * C > MAX_ARRAY_CELLS) return err.num('Hasil array terlalu besar');
  const out: Scalar[][] = [];
  for (let i = 0; i < R; i++) {
    const row: Scalar[] = [];
    for (let j = 0; j < C; j++) row.push((start as number) + (i * C + j) * (step as number));
    out.push(row);
  }
  return new ArrayValue(out) as never;
});

def('TRANSPOSE', 'TRANSPOSE(rentang)', 'Menukar baris dan kolom.', 1, 1, ([a]) => {
  const g = grid(a);
  const out: Scalar[][] = [];
  for (let c = 0; c < g.cols; c++) {
    const row: Scalar[] = [];
    for (let r = 0; r < g.rows; r++) row.push(g.get(r, c));
    out.push(row);
  }
  return new ArrayValue(out) as never;
});

def('ARRAYFORMULA', 'ARRAYFORMULA(formula_array)', 'Menghitung formula untuk seluruh rentang sekaligus.', 1, 1, ([a]) => a as never);

// ---------- FILTER ----------

def('FILTER', 'FILTER(rentang, kondisi1, [kondisi2, ...])', 'Baris atau kolom yang memenuhi semua kondisi.', 2, 30, ([src, ...conds]) => {
  const g = grid(src);
  const cs = conds.map(grid);
  // Conditions are a column (filter rows) or a row (filter columns).
  const byRows = cs.every((c) => c.rows === g.rows && c.cols === 1);
  const byCols = !byRows && cs.every((c) => c.cols === g.cols && c.rows === 1);
  if (!byRows && !byCols) return err.value('Ukuran kondisi FILTER harus sama dengan rentang');
  const n = byRows ? g.rows : g.cols;
  const keep: number[] = [];
  for (let i = 0; i < n; i++) {
    let ok = true;
    for (const c of cs) {
      const v = byRows ? c.get(i, 0) : c.get(0, i);
      if (isError(v)) return v;
      const b = typeof v === 'number' ? v !== 0 : toBool(v);
      if (isError(b) || !b) {
        ok = false;
        break;
      }
    }
    if (ok) keep.push(i);
  }
  if (!keep.length) return err.na('FILTER tidak menemukan baris yang cocok');
  const data = rowsOf(g);
  if (byRows) return new ArrayValue(keep.map((i) => data[i])) as never;
  return new ArrayValue(data.map((row) => keep.map((i) => row[i]))) as never;
});

// ---------- SORT, UNIQUE ----------

def('SORT', 'SORT(rentang, [kolom], [naik], [kolom2, naik2, ...])', 'Mengurutkan baris rentang.', 1, 31, ([src, ...rest]) => {
  const g = grid(src);
  const keys: { col: number; asc: boolean }[] = [];
  if (rest.length === 0) keys.push({ col: 0, asc: true });
  for (let i = 0; i < rest.length; i += 2) {
    const c = num(rest[i]);
    if (isError(c)) return c;
    const ascArg = rest[i + 1];
    const asc = ascArg === undefined ? true : toBool(scalarOf(ascArg));
    if (isError(asc)) return asc;
    if (c < 1 || c > g.cols) return err.value('Kolom pengurutan di luar rentang');
    keys.push({ col: Math.trunc(c) - 1, asc });
  }
  const data = rowsOf(g);
  const sorted = data
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      for (const k of keys) {
        const x = a.row[k.col];
        const y = b.row[k.col];
        // Blanks last, regardless of direction.
        const ex = x === null || x === '';
        const ey = y === null || y === '';
        if (ex !== ey) return ex ? 1 : -1;
        const c = compareValues(x, y);
        if (c) return k.asc ? c : -c;
      }
      return a.i - b.i;
    })
    .map((x) => x.row);
  return new ArrayValue(sorted) as never;
});

def('UNIQUE', 'UNIQUE(rentang)', 'Baris unik dari rentang, urutan pertama dipertahankan.', 1, 1, ([src]) => {
  const g = grid(src);
  const seen = new Set<string>();
  const out: Scalar[][] = [];
  for (const row of rowsOf(g)) {
    const key = row.map((v) => (v instanceof FormulaError ? v.code : typeof v === 'string' ? `s:${v.toLowerCase()}` : `${typeof v}:${String(v)}`)).join('\u0001');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return new ArrayValue(out) as never;
});

// ---------- IMPORTRANGE ----------

def(
  'IMPORTRANGE',
  'IMPORTRANGE(url_workbook, "Sheet1!A1:C10")',
  'Mengambil rentang dari workbook OpenSheet lain yang dapat Anda akses.',
  2,
  2,
  ([u, r], ctx: EvalContext) => {
    const src = toText(scalarOf(u));
    const range = toText(scalarOf(r));
    if (isError(src)) return src;
    if (isError(range)) return range;
    if (!ctx.importRange) return err.ref('IMPORTRANGE tidak tersedia di sini');
    const res = ctx.importRange(src.trim(), range.trim());
    if (res === 'pending') return err.na('Memuat data dari workbook lain');
    if (isError(res)) return res;
    return new ArrayValue(res) as never;
  },
  'Pencarian',
);

// ---------- QUERY ----------

type QTok = { t: 'id' | 'num' | 'str' | 'op' | 'punc'; v: string };

function qTokenize(q: string): QTok[] | FormulaError {
  const out: QTok[] = [];
  let i = 0;
  while (i < q.length) {
    const ch = q[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const j = q.indexOf(ch, i + 1);
      if (j < 0) return err.value('QUERY: tanda kutip tidak ditutup');
      out.push({ t: 'str', v: q.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (ch === '`') {
      const j = q.indexOf('`', i + 1);
      if (j < 0) return err.value('QUERY: tanda ` tidak ditutup');
      out.push({ t: 'id', v: q.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    const two = q.slice(i, i + 2);
    if (two === '!=' || two === '<>' || two === '<=' || two === '>=') {
      out.push({ t: 'op', v: two === '<>' ? '!=' : two });
      i += 2;
      continue;
    }
    if ('=<>'.includes(ch)) {
      out.push({ t: 'op', v: ch });
      i++;
      continue;
    }
    if ('(),*'.includes(ch)) {
      out.push({ t: 'punc', v: ch });
      i++;
      continue;
    }
    const m = /^(-?\d+(\.\d+)?)/.exec(q.slice(i));
    if (m) {
      out.push({ t: 'num', v: m[1] });
      i += m[1].length;
      continue;
    }
    const w = /^[A-Za-z_][A-Za-z0-9_]*/.exec(q.slice(i));
    if (w) {
      out.push({ t: 'id', v: w[0] });
      i += w[0].length;
      continue;
    }
    return err.value(`QUERY: karakter "${ch}" tidak dikenal`);
  }
  return out;
}

type QExpr =
  | { k: 'col'; i: number }
  | { k: 'lit'; v: Scalar }
  | { k: 'agg'; fn: string; i: number }
  | { k: 'cmp'; op: string; a: QExpr; b: QExpr }
  | { k: 'and' | 'or'; a: QExpr; b: QExpr }
  | { k: 'not'; a: QExpr }
  | { k: 'null'; a: QExpr; neg: boolean };

const AGGS = new Set(['sum', 'avg', 'count', 'max', 'min']);

class QueryParser {
  pos = 0;
  constructor(
    readonly toks: QTok[],
    private colIndex: (name: string) => number,
  ) {}
  peek(o = 0) {
    return this.toks[this.pos + o];
  }
  kw(word: string) {
    const t = this.peek();
    if (t && t.t === 'id' && t.v.toLowerCase() === word) {
      this.pos++;
      return true;
    }
    return false;
  }
  expect(v: string) {
    const t = this.peek();
    if (!t || t.v.toLowerCase() !== v) throw new Error(`diharapkan "${v}"`);
    this.pos++;
  }
  col(): number {
    const t = this.toks[this.pos++];
    if (!t || t.t !== 'id') throw new Error('nama kolom diharapkan');
    const i = this.colIndex(t.v);
    if (i < 0) throw new Error(`kolom ${t.v} tidak ada`);
    return i;
  }
  item(): QExpr {
    const t = this.peek();
    if (t?.t === 'id' && AGGS.has(t.v.toLowerCase()) && this.peek(1)?.v === '(') {
      this.pos += 2;
      const i = this.col();
      this.expect(')');
      return { k: 'agg', fn: t.v.toLowerCase(), i };
    }
    return { k: 'col', i: this.col() };
  }
  operand(): QExpr {
    const t = this.peek();
    if (!t) throw new Error('kondisi tidak lengkap');
    if (t.t === 'num') {
      this.pos++;
      return { k: 'lit', v: Number(t.v) };
    }
    if (t.t === 'str') {
      this.pos++;
      return { k: 'lit', v: t.v };
    }
    if (t.t === 'id' && (t.v.toLowerCase() === 'true' || t.v.toLowerCase() === 'false')) {
      this.pos++;
      return { k: 'lit', v: t.v.toLowerCase() === 'true' };
    }
    if (t.v === '(') {
      this.pos++;
      const e = this.or();
      this.expect(')');
      return e;
    }
    return this.item();
  }
  cmp(): QExpr {
    if (this.kw('not')) return { k: 'not', a: this.cmp() };
    const a = this.operand();
    const t = this.peek();
    if (t?.t === 'op') {
      this.pos++;
      return { k: 'cmp', op: t.v, a, b: this.operand() };
    }
    if (this.kw('is')) {
      const neg = this.kw('not');
      this.expect('null');
      return { k: 'null', a, neg };
    }
    if (this.kw('contains')) return { k: 'cmp', op: 'contains', a, b: this.operand() };
    if (this.kw('starts')) {
      this.expect('with');
      return { k: 'cmp', op: 'starts', a, b: this.operand() };
    }
    if (this.kw('ends')) {
      this.expect('with');
      return { k: 'cmp', op: 'ends', a, b: this.operand() };
    }
    if (this.kw('matches')) return { k: 'cmp', op: 'matches', a, b: this.operand() };
    if (this.kw('like')) return { k: 'cmp', op: 'like', a, b: this.operand() };
    return a;
  }
  and(): QExpr {
    let a = this.cmp();
    while (this.kw('and')) a = { k: 'and', a, b: this.cmp() };
    return a;
  }
  or(): QExpr {
    let a = this.and();
    while (this.kw('or')) a = { k: 'or', a, b: this.and() };
    return a;
  }
}

interface Query {
  select: QExpr[] | null;
  where: QExpr | null;
  groupBy: number[];
  orderBy: { e: QExpr; asc: boolean }[];
  limit: number | null;
  offset: number;
  labels: Map<string, string>;
}

function exprKey(e: QExpr): string {
  return e.k === 'col' ? `c${e.i}` : e.k === 'agg' ? `${e.fn}(c${e.i})` : JSON.stringify(e);
}

function parseQuery(text: string, colIndex: (n: string) => number): Query | FormulaError {
  const toks = qTokenize(text);
  if (isError(toks)) return toks;
  const p = new QueryParser(toks, colIndex);
  const q: Query = { select: null, where: null, groupBy: [], orderBy: [], limit: null, offset: 0, labels: new Map() };
  try {
    if (p.kw('select')) {
      if (p.peek()?.v === '*') p.pos++;
      else {
        q.select = [p.item()];
        while (p.peek()?.v === ',') {
          p.pos++;
          q.select.push(p.item());
        }
      }
    }
    if (p.kw('where')) q.where = p.or();
    if (p.kw('group')) {
      p.expect('by');
      q.groupBy.push(p.col());
      while (p.peek()?.v === ',') {
        p.pos++;
        q.groupBy.push(p.col());
      }
    }
    if (p.kw('order')) {
      p.expect('by');
      do {
        if (p.peek()?.v === ',') p.pos++;
        const e = p.item();
        let asc = true;
        if (p.kw('desc')) asc = false;
        else p.kw('asc');
        q.orderBy.push({ e, asc });
      } while (p.peek()?.v === ',');
    }
    if (p.kw('limit')) q.limit = Number(p.toks[p.pos++]?.v);
    if (p.kw('offset')) q.offset = Number(p.toks[p.pos++]?.v);
    if (p.kw('label')) {
      do {
        if (p.peek()?.v === ',') p.pos++;
        const e = p.item();
        const t = p.toks[p.pos++];
        if (!t || t.t !== 'str') throw new Error('label harus berupa teks');
        q.labels.set(exprKey(e), t.v);
      } while (p.peek()?.v === ',');
    }
    if (p.pos < p.toks.length) throw new Error(`bagian "${p.peek()!.v}" tidak dipahami`);
  } catch (e) {
    return err.value(`QUERY: ${(e as Error).message}`);
  }
  if (q.limit !== null && (!Number.isFinite(q.limit) || q.limit < 0)) return err.value('QUERY: limit tidak valid');
  return q;
}

function evalExpr(e: QExpr, row: Scalar[]): Scalar {
  switch (e.k) {
    case 'col':
      return row[e.i] ?? null;
    case 'lit':
      return e.v;
    case 'agg':
      return err.value('Agregat tidak boleh di WHERE');
    case 'not': {
      const v = evalExpr(e.a, row);
      return !(v === true);
    }
    case 'and':
      return evalExpr(e.a, row) === true && evalExpr(e.b, row) === true;
    case 'or':
      return evalExpr(e.a, row) === true || evalExpr(e.b, row) === true;
    case 'null': {
      const v = evalExpr(e.a, row);
      const isNull = v === null || v === '';
      return e.neg ? !isNull : isNull;
    }
    case 'cmp': {
      const a = evalExpr(e.a, row);
      const b = evalExpr(e.b, row);
      if (a === null || a === '') return e.op === '!=' ? b !== null && b !== '' : false;
      const ta = String(a).toLowerCase();
      const tb = String(b ?? '').toLowerCase();
      switch (e.op) {
        case 'contains':
          return ta.includes(tb);
        case 'starts':
          return ta.startsWith(tb);
        case 'ends':
          return ta.endsWith(tb);
        case 'matches':
          try {
            return new RegExp(`^(?:${String(b)})$`).test(String(a));
          } catch {
            return false;
          }
        case 'like':
          return new RegExp(`^${String(b).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`, 'i').test(String(a));
      }
      const c = compareValues(a, b);
      switch (e.op) {
        case '=':
          return c === 0;
        case '!=':
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
      return false;
    }
  }
}

function aggregate(fn: string, values: Scalar[]): Scalar {
  const nums = values.filter((v): v is number => typeof v === 'number');
  switch (fn) {
    case 'count':
      return values.filter((v) => v !== null && v !== '').length;
    case 'sum':
      return nums.reduce((a, b) => a + b, 0);
    case 'avg':
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
    case 'max':
      return nums.length ? Math.max(...nums) : null;
    case 'min':
      return nums.length ? Math.min(...nums) : null;
  }
  return null;
}

def(
  'QUERY',
  'QUERY(data, "select A, sum(C) where B > 0 group by A", [baris_judul])',
  'Memilih, menyaring, mengelompokkan dan mengurutkan data dengan bahasa query.',
  2,
  3,
  ([d, qArg, hArg]) => {
    const g = grid(d);
    const text = toText(scalarOf(qArg));
    if (isError(text)) return text;
    const data = rowsOf(g);
    let headers: number;
    if (hArg === undefined || hArg === '') {
      // Guess: a first row of text above rows that contain numbers is a header.
      headers = data.length > 1 && data[0].every((v) => typeof v === 'string' || v === null) && data[1].some((v) => typeof v === 'number') ? 1 : 0;
    } else {
      const h = num(hArg);
      if (isError(h)) return h;
      headers = Math.max(0, Math.trunc(h));
    }
    const firstCol = g instanceof RangeRef ? g.c1 : 0;
    const colIndex = (name: string) => {
      const m = /^Col(\d+)$/i.exec(name);
      if (m) {
        const i = Number(m[1]) - 1;
        return i < g.cols ? i : -1;
      }
      if (/^[A-Za-z]{1,3}$/.test(name)) {
        const r = parseRangeA1(`${name}1`);
        if (!r) return -1;
        const i = r.c1 - firstCol;
        return i >= 0 && i < g.cols ? i : -1;
      }
      return -1;
    };
    const colName = (i: number) => (g instanceof RangeRef ? colToLetters(firstCol + i) : `Col${i + 1}`);
    const q = parseQuery(text, colIndex);
    if (isError(q)) return q;
    const headerText = (i: number) =>
      headers > 0
        ? data
            .slice(0, headers)
            .map((r) => (r[i] === null ? '' : String(r[i])))
            .join(' ')
            .trim()
        : '';
    let body = data.slice(headers);
    if (q.where) body = body.filter((r) => evalExpr(q.where!, r) === true);

    const hasAgg = (q.select ?? []).some((e) => e.k === 'agg') || q.groupBy.length > 0;
    let select: QExpr[] = q.select ?? Array.from({ length: g.cols }, (_, i) => ({ k: 'col', i }) as QExpr);
    let outRows: Scalar[][];
    if (hasAgg) {
      if (!q.select) select = q.groupBy.map((i) => ({ k: 'col', i }) as QExpr);
      for (const e of select) if (e.k === 'col' && !q.groupBy.includes(e.i)) return err.value(`QUERY: kolom ${colName(e.i)} harus ada di GROUP BY`);
      const groups = new Map<string, Scalar[][]>();
      for (const r of body) {
        const key = q.groupBy.map((i) => JSON.stringify(r[i] ?? null)).join('\u0001');
        groups.set(key, [...(groups.get(key) ?? []), r]);
      }
      if (!q.groupBy.length && !groups.size) groups.set('', []);
      outRows = [...groups.values()].map((rows) =>
        select.map((e) => (e.k === 'agg' ? aggregate(e.fn, rows.map((r) => r[e.i] ?? null)) : (rows[0]?.[(e as { i: number }).i] ?? null))),
      );
      if (q.orderBy.length) {
        const idx = q.orderBy.map((o) => ({ pos: select.findIndex((s) => exprKey(s) === exprKey(o.e)), asc: o.asc }));
        if (idx.some((x) => x.pos < 0)) return err.value('QUERY: ORDER BY harus memakai kolom yang dipilih');
        outRows.sort((a, b) => {
          for (const x of idx) {
            const c = compareValues(a[x.pos], b[x.pos]);
            if (c) return x.asc ? c : -c;
          }
          return 0;
        });
      } else {
        // Groups come out sorted by their keys, as in the spreadsheet QUERY.
        outRows.sort((a, b) => {
          for (let k = 0; k < select.length; k++) {
            if (select[k].k !== 'col') continue;
            const c = compareValues(a[k], b[k]);
            if (c) return c;
          }
          return 0;
        });
      }
    } else {
      if (q.orderBy.length) {
        body = [...body].sort((a, b) => {
          for (const o of q.orderBy) {
            const c = compareValues(evalExpr(o.e, a), evalExpr(o.e, b));
            if (c) return o.asc ? c : -c;
          }
          return 0;
        });
      }
      outRows = body.map((r) => select.map((e) => evalExpr(e, r)));
    }
    outRows = outRows.slice(q.offset, q.limit === null ? undefined : q.offset + q.limit);
    const showHeader = headers > 0 || hasAgg || q.labels.size > 0;
    const header = select.map((e) => {
      const label = q.labels.get(exprKey(e));
      if (label !== undefined) return label;
      if (e.k === 'agg') {
        const base = headerText(e.i) || colName(e.i);
        return `${e.fn} ${base}`;
      }
      return headerText((e as { i: number }).i);
    });
    const out = showHeader ? [header as Scalar[], ...outRows] : outRows;
    if (!out.length) return err.na('QUERY tidak menghasilkan baris');
    return new ArrayValue(out) as never;
  },
  'Pencarian',
);
