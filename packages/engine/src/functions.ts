import { dateToSerial, localNowSerial, serialToParts } from './dates';
import {
  Arg,
  compareValues,
  EvalContext,
  functionRegistry,
  FunctionImpl,
  lazyRegistry,
  LazyImpl,
  RangeRef,
  scalarOf,
  toBool,
  toNumber,
  toText,
} from './evaluator';
import { formatValue } from './format';
import { err, FormulaError, isError, Scalar } from './values';

function def(
  name: string,
  category: string,
  syntax: string,
  description: string,
  minArgs: number,
  maxArgs: number,
  impl: FunctionImpl,
  volatile = false,
) {
  functionRegistry.set(name, { impl, minArgs, maxArgs, category, syntax, description, volatile });
}

function defLazy(name: string, category: string, syntax: string, description: string, impl: LazyImpl) {
  functionRegistry.set(name, {
    impl: () => err.value(),
    minArgs: 0,
    maxArgs: 255,
    lazy: true,
    category,
    syntax,
    description,
  });
  lazyRegistry.set(name, impl);
}

const MANY = 255;

/**
 * Numbers for aggregate functions. Values inside ranges skip text, booleans and
 * blanks; values typed directly as arguments are coerced.
 */
function collectNumbers(args: Arg[]): number[] | FormulaError {
  const out: number[] = [];
  for (const a of args) {
    if (a instanceof RangeRef) {
      for (const v of a.values()) {
        if (isError(v)) return v;
        if (typeof v === 'number') out.push(v);
      }
    } else {
      if (a === null) continue;
      const n = toNumber(a);
      if (isError(n)) return n;
      out.push(n);
    }
  }
  return out;
}

function num(a: Arg): number | FormulaError {
  return toNumber(scalarOf(a));
}
function text(a: Arg): string | FormulaError {
  return toText(scalarOf(a));
}

function roundTo(n: number, digits: number, mode: 'round' | 'up' | 'down'): number {
  const f = Math.pow(10, digits);
  const x = Math.abs(n) * f;
  // Nudge by epsilon so 1.005 rounds the way people expect.
  const eps = 1e-9;
  let r: number;
  if (mode === 'round') r = Math.round(x + eps);
  else if (mode === 'up') r = Math.ceil(x - eps);
  else r = Math.floor(x + eps);
  return (Math.sign(n) * r) / f;
}

// ---------- Mathematical ----------

def('SUM', 'Matematika', 'SUM(nilai1, [nilai2, ...])', 'Menjumlahkan angka dan rentang.', 1, MANY, (args) => {
  const ns = collectNumbers(args);
  return isError(ns) ? ns : ns.reduce((a, b) => a + b, 0);
});
def('PRODUCT', 'Matematika', 'PRODUCT(nilai1, [nilai2, ...])', 'Mengalikan angka dan rentang.', 1, MANY, (args) => {
  const ns = collectNumbers(args);
  return isError(ns) ? ns : ns.length === 0 ? 0 : ns.reduce((a, b) => a * b, 1);
});
def('ABS', 'Matematika', 'ABS(angka)', 'Nilai absolut.', 1, 1, ([a]) => {
  const n = num(a);
  return isError(n) ? n : Math.abs(n);
});
def('ROUND', 'Matematika', 'ROUND(angka, [digit])', 'Membulatkan ke jumlah digit tertentu.', 1, 2, ([a, d]) => {
  const n = num(a);
  const k = d === undefined ? 0 : num(d);
  if (isError(n)) return n;
  if (isError(k)) return k;
  return roundTo(n, Math.trunc(k), 'round');
});
def('ROUNDUP', 'Matematika', 'ROUNDUP(angka, [digit])', 'Membulatkan menjauhi nol.', 1, 2, ([a, d]) => {
  const n = num(a);
  const k = d === undefined ? 0 : num(d);
  if (isError(n)) return n;
  if (isError(k)) return k;
  return roundTo(n, Math.trunc(k), 'up');
});
def('ROUNDDOWN', 'Matematika', 'ROUNDDOWN(angka, [digit])', 'Membulatkan mendekati nol.', 1, 2, ([a, d]) => {
  const n = num(a);
  const k = d === undefined ? 0 : num(d);
  if (isError(n)) return n;
  if (isError(k)) return k;
  return roundTo(n, Math.trunc(k), 'down');
});
def('INT', 'Matematika', 'INT(angka)', 'Membulatkan ke bawah ke bilangan bulat.', 1, 1, ([a]) => {
  const n = num(a);
  return isError(n) ? n : Math.floor(n);
});
def('MOD', 'Matematika', 'MOD(angka, pembagi)', 'Sisa hasil bagi.', 2, 2, ([a, b]) => {
  const n = num(a);
  const d = num(b);
  if (isError(n)) return n;
  if (isError(d)) return d;
  if (d === 0) return err.div0();
  return n - d * Math.floor(n / d);
});
def('POWER', 'Matematika', 'POWER(angka, pangkat)', 'Perpangkatan.', 2, 2, ([a, b]) => {
  const n = num(a);
  const p = num(b);
  if (isError(n)) return n;
  if (isError(p)) return p;
  const r = Math.pow(n, p);
  return Number.isFinite(r) ? r : err.num();
});
def('SQRT', 'Matematika', 'SQRT(angka)', 'Akar kuadrat.', 1, 1, ([a]) => {
  const n = num(a);
  if (isError(n)) return n;
  return n < 0 ? err.num('Akar dari bilangan negatif') : Math.sqrt(n);
});

// ---------- Statistical ----------

def('AVERAGE', 'Statistik', 'AVERAGE(nilai1, [nilai2, ...])', 'Rata-rata aritmetika.', 1, MANY, (args) => {
  const ns = collectNumbers(args);
  if (isError(ns)) return ns;
  if (ns.length === 0) return err.div0('Tidak ada angka untuk dirata-rata');
  return ns.reduce((a, b) => a + b, 0) / ns.length;
});
def('COUNT', 'Statistik', 'COUNT(nilai1, [nilai2, ...])', 'Menghitung sel berisi angka.', 1, MANY, (args) => {
  let c = 0;
  for (const a of args) {
    if (a instanceof RangeRef) {
      for (const v of a.values()) if (typeof v === 'number') c++;
    } else if (typeof a === 'number' || (typeof a === 'string' && !isError(toNumber(a)) && a.trim() !== '') || typeof a === 'boolean') c++;
  }
  return c;
});
def('COUNTA', 'Statistik', 'COUNTA(nilai1, [nilai2, ...])', 'Menghitung sel yang tidak kosong.', 1, MANY, (args) => {
  let c = 0;
  for (const a of args) {
    if (a instanceof RangeRef) {
      for (const v of a.values()) if (v !== null && v !== '') c++;
    } else if (a !== null) c++;
  }
  return c;
});
def('COUNTBLANK', 'Statistik', 'COUNTBLANK(rentang)', 'Menghitung sel kosong.', 1, 1, ([a]) => {
  if (!(a instanceof RangeRef)) return err.value('Argumen harus berupa rentang');
  let c = 0;
  for (const v of a.values()) if (v === null || v === '') c++;
  return c;
});
def('MAX', 'Statistik', 'MAX(nilai1, [nilai2, ...])', 'Nilai terbesar.', 1, MANY, (args) => {
  const ns = collectNumbers(args);
  if (isError(ns)) return ns;
  return ns.length === 0 ? 0 : ns.reduce((a, b) => (b > a ? b : a), -Infinity);
});
def('MIN', 'Statistik', 'MIN(nilai1, [nilai2, ...])', 'Nilai terkecil.', 1, MANY, (args) => {
  const ns = collectNumbers(args);
  if (isError(ns)) return ns;
  return ns.length === 0 ? 0 : ns.reduce((a, b) => (b < a ? b : a), Infinity);
});
def('MEDIAN', 'Statistik', 'MEDIAN(nilai1, [nilai2, ...])', 'Nilai tengah.', 1, MANY, (args) => {
  const ns = collectNumbers(args);
  if (isError(ns)) return ns;
  if (ns.length === 0) return err.num();
  const s = [...ns].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
});

// ---------- Logical ----------

defLazy('IF', 'Logika', 'IF(kondisi, nilai_jika_benar, [nilai_jika_salah])', 'Memilih nilai berdasarkan kondisi.', (args, _ctx, ev) => {
  if (args.length < 2 || args.length > 3) return err.value('IF membutuhkan 2 atau 3 argumen');
  const c = toBool(scalarOf(ev(args[0])));
  if (isError(c)) return c;
  if (c) return ev(args[1]);
  return args.length === 3 ? ev(args[2]) : false;
});
defLazy('IFERROR', 'Logika', 'IFERROR(nilai, nilai_jika_error)', 'Mengganti hasil error dengan nilai lain.', (args, _ctx, ev) => {
  if (args.length !== 2) return err.value('IFERROR membutuhkan 2 argumen');
  const v = ev(args[0]);
  const s = v instanceof RangeRef ? scalarOf(v) : v;
  return isError(s) ? ev(args[1]) : v;
});
defLazy('IFNA', 'Logika', 'IFNA(nilai, nilai_jika_na)', 'Mengganti #N/A dengan nilai lain.', (args, _ctx, ev) => {
  if (args.length !== 2) return err.value('IFNA membutuhkan 2 argumen');
  const v = ev(args[0]);
  const s = v instanceof RangeRef ? scalarOf(v) : v;
  return isError(s) && s.code === '#N/A' ? ev(args[1]) : v;
});

function logicalValues(args: Arg[]): boolean[] | FormulaError {
  const out: boolean[] = [];
  for (const a of args) {
    if (a instanceof RangeRef) {
      for (const v of a.values()) {
        if (isError(v)) return v;
        if (typeof v === 'boolean') out.push(v);
        else if (typeof v === 'number') out.push(v !== 0);
      }
    } else {
      const b = toBool(a);
      if (isError(b)) return b;
      out.push(b);
    }
  }
  return out;
}

def('AND', 'Logika', 'AND(logika1, [logika2, ...])', 'TRUE jika semua argumen benar.', 1, MANY, (args) => {
  const bs = logicalValues(args);
  if (isError(bs)) return bs;
  if (bs.length === 0) return err.value();
  return bs.every(Boolean);
});
def('OR', 'Logika', 'OR(logika1, [logika2, ...])', 'TRUE jika salah satu argumen benar.', 1, MANY, (args) => {
  const bs = logicalValues(args);
  if (isError(bs)) return bs;
  if (bs.length === 0) return err.value();
  return bs.some(Boolean);
});
def('NOT', 'Logika', 'NOT(logika)', 'Membalik nilai logika.', 1, 1, ([a]) => {
  const b = toBool(scalarOf(a));
  return isError(b) ? b : !b;
});

// ---------- Conditional ----------

type Matcher = (v: Scalar) => boolean;

function wildcardToRegex(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '~' && i + 1 < pattern.length) {
      re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/** Builds a matcher for COUNTIF-style criteria such as ">5", "<>x", "a*". */
export function buildCriteria(criteria: Scalar): Matcher {
  if (typeof criteria === 'number') return (v) => typeof v === 'number' && v === criteria;
  if (typeof criteria === 'boolean') return (v) => v === criteria;
  if (criteria === null) return (v) => v === null || v === '';
  if (isError(criteria)) return (v) => isError(v) && v.code === criteria.code;
  const m = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(criteria)!;
  const op = m[1] ?? '=';
  const operand = m[2];
  const asNum = operand.trim() === '' ? NaN : Number(operand);
  if (!Number.isNaN(asNum)) {
    return (v) => {
      if (typeof v !== 'number') return op === '<>';
      switch (op) {
        case '=':
          return v === asNum;
        case '<>':
          return v !== asNum;
        case '<':
          return v < asNum;
        case '>':
          return v > asNum;
        case '<=':
          return v <= asNum;
        case '>=':
          return v >= asNum;
      }
      return false;
    };
  }
  if (op === '=' || op === '<>') {
    if (operand === '') {
      return op === '=' ? (v) => v === null || v === '' : (v) => !(v === null || v === '');
    }
    const re = wildcardToRegex(operand);
    const test = (v: Scalar) => {
      if (v === null || isError(v)) return false;
      const t = typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);
      return re.test(t);
    };
    return op === '=' ? test : (v) => !test(v);
  }
  return (v) => {
    if (typeof v !== 'string') return false;
    const c = compareValues(v, operand);
    return op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0;
  };
}

function rangeArg(a: Arg): RangeRef | FormulaError {
  if (a instanceof RangeRef) return a;
  if (isError(a)) return a;
  return err.value('Argumen harus berupa rentang');
}

def('COUNTIF', 'Kondisional', 'COUNTIF(rentang, kriteria)', 'Menghitung sel yang memenuhi kriteria.', 2, 2, ([r, c]) => {
  const range = rangeArg(r);
  if (isError(range)) return range;
  const match = buildCriteria(scalarOf(c));
  let n = 0;
  for (const v of range.values()) if (match(v)) n++;
  return n;
});

function sumOrAvgIf(args: Arg[], avg: boolean): Scalar {
  const range = rangeArg(args[0]);
  if (isError(range)) return range;
  const match = buildCriteria(scalarOf(args[1]));
  const sumRange = args[2] === undefined ? range : rangeArg(args[2]);
  if (isError(sumRange)) return sumRange;
  let total = 0;
  let count = 0;
  for (let r = 0; r < range.rows; r++) {
    for (let c = 0; c < range.cols; c++) {
      if (!match(range.get(r, c))) continue;
      const v = sumRange.ctx.getValue(sumRange.sheetId, sumRange.r1 + r, sumRange.c1 + c);
      if (isError(v)) return v;
      if (typeof v === 'number') {
        total += v;
        count++;
      }
    }
  }
  if (avg) return count === 0 ? err.div0() : total / count;
  return total;
}

def('SUMIF', 'Kondisional', 'SUMIF(rentang, kriteria, [rentang_jumlah])', 'Menjumlahkan sel yang memenuhi kriteria.', 2, 3, (args) => sumOrAvgIf(args, false));
def('AVERAGEIF', 'Kondisional', 'AVERAGEIF(rentang, kriteria, [rentang_rata])', 'Rata-rata sel yang memenuhi kriteria.', 2, 3, (args) => sumOrAvgIf(args, true));

function multiCriteria(ranges: Arg[], criteria: Arg[]): { ok: (r: number, c: number) => boolean; rows: number; cols: number } | FormulaError {
  const rs: RangeRef[] = [];
  for (const r of ranges) {
    const x = rangeArg(r);
    if (isError(x)) return x;
    rs.push(x);
  }
  const rows = rs[0].rows;
  const cols = rs[0].cols;
  if (rs.some((r) => r.rows !== rows || r.cols !== cols)) return err.value('Ukuran rentang kriteria harus sama');
  const ms = criteria.map((c) => buildCriteria(scalarOf(c)));
  return { ok: (r, c) => rs.every((rg, i) => ms[i](rg.get(r, c))), rows, cols };
}

def('COUNTIFS', 'Kondisional', 'COUNTIFS(rentang1, kriteria1, ...)', 'Menghitung dengan beberapa kriteria.', 2, MANY, (args) => {
  if (args.length % 2) return err.value();
  const mc = multiCriteria(args.filter((_, i) => i % 2 === 0), args.filter((_, i) => i % 2 === 1));
  if (isError(mc)) return mc;
  let n = 0;
  for (let r = 0; r < mc.rows; r++) for (let c = 0; c < mc.cols; c++) if (mc.ok(r, c)) n++;
  return n;
});
def('SUMIFS', 'Kondisional', 'SUMIFS(rentang_jumlah, rentang1, kriteria1, ...)', 'Menjumlahkan dengan beberapa kriteria.', 3, MANY, (args) => {
  const [sr, ...rest] = args;
  if (rest.length % 2) return err.value();
  const sum = rangeArg(sr);
  if (isError(sum)) return sum;
  const mc = multiCriteria(rest.filter((_, i) => i % 2 === 0), rest.filter((_, i) => i % 2 === 1));
  if (isError(mc)) return mc;
  if (sum.rows !== mc.rows || sum.cols !== mc.cols) return err.value();
  let t = 0;
  for (let r = 0; r < mc.rows; r++)
    for (let c = 0; c < mc.cols; c++)
      if (mc.ok(r, c)) {
        const v = sum.get(r, c);
        if (isError(v)) return v;
        if (typeof v === 'number') t += v;
      }
  return t;
});

// ---------- Text ----------

function concatAll(args: Arg[]): Scalar {
  let s = '';
  for (const a of args) {
    if (a instanceof RangeRef) {
      for (const v of a.values()) {
        const t = toText(v);
        if (isError(t)) return t;
        s += t;
      }
    } else {
      const t = toText(a);
      if (isError(t)) return t;
      s += t;
    }
  }
  return s;
}

def('CONCAT', 'Teks', 'CONCAT(teks1, [teks2, ...])', 'Menggabungkan teks dan rentang.', 1, MANY, concatAll);
def('CONCATENATE', 'Teks', 'CONCATENATE(teks1, [teks2, ...])', 'Menggabungkan beberapa teks.', 1, MANY, concatAll);
def('LEFT', 'Teks', 'LEFT(teks, [jumlah])', 'Karakter dari kiri.', 1, 2, ([a, n]) => {
  const t = text(a);
  const k = n === undefined ? 1 : num(n);
  if (isError(t)) return t;
  if (isError(k)) return k;
  if (k < 0) return err.value();
  return t.slice(0, Math.trunc(k));
});
def('RIGHT', 'Teks', 'RIGHT(teks, [jumlah])', 'Karakter dari kanan.', 1, 2, ([a, n]) => {
  const t = text(a);
  const k = n === undefined ? 1 : num(n);
  if (isError(t)) return t;
  if (isError(k)) return k;
  if (k < 0) return err.value();
  const kk = Math.trunc(k);
  return kk === 0 ? '' : t.slice(-kk);
});
def('MID', 'Teks', 'MID(teks, mulai, jumlah)', 'Karakter dari posisi tertentu.', 3, 3, ([a, s, n]) => {
  const t = text(a);
  const st = num(s);
  const k = num(n);
  if (isError(t)) return t;
  if (isError(st)) return st;
  if (isError(k)) return k;
  if (st < 1 || k < 0) return err.value();
  return t.substr(Math.trunc(st) - 1, Math.trunc(k));
});
def('LEN', 'Teks', 'LEN(teks)', 'Panjang teks.', 1, 1, ([a]) => {
  const t = text(a);
  return isError(t) ? t : t.length;
});
def('TRIM', 'Teks', 'TRIM(teks)', 'Menghapus spasi berlebih.', 1, 1, ([a]) => {
  const t = text(a);
  return isError(t) ? t : t.trim().replace(/ {2,}/g, ' ');
});
def('UPPER', 'Teks', 'UPPER(teks)', 'Huruf kapital.', 1, 1, ([a]) => {
  const t = text(a);
  return isError(t) ? t : t.toUpperCase();
});
def('LOWER', 'Teks', 'LOWER(teks)', 'Huruf kecil.', 1, 1, ([a]) => {
  const t = text(a);
  return isError(t) ? t : t.toLowerCase();
});
def('TEXT', 'Teks', 'TEXT(angka, format)', 'Memformat angka sebagai teks.', 2, 2, ([a, f]) => {
  const v = scalarOf(a);
  const p = text(f);
  if (isError(v)) return v;
  if (isError(p)) return p;
  return formatValue(v, p);
});
def('TEXTJOIN', 'Teks', 'TEXTJOIN(pemisah, abaikan_kosong, teks1, ...)', 'Menggabungkan teks dengan pemisah.', 3, MANY, ([d, ig, ...rest]) => {
  const delim = text(d);
  const ignore = toBool(scalarOf(ig));
  if (isError(delim)) return delim;
  if (isError(ignore)) return ignore;
  const parts: string[] = [];
  for (const a of rest) {
    const vals = a instanceof RangeRef ? [...a.values()] : [a];
    for (const v of vals) {
      const t = toText(v);
      if (isError(t)) return t;
      if (ignore && t === '') continue;
      parts.push(t);
    }
  }
  return parts.join(delim);
});

function safeRegex(pattern: string): RegExp | FormulaError {
  if (pattern.length > 500) return err.value('Pola terlalu panjang');
  try {
    return new RegExp(pattern);
  } catch {
    return err.value('Pola regex tidak valid');
  }
}

def('REGEXMATCH', 'Teks', 'REGEXMATCH(teks, pola)', 'TRUE jika teks cocok dengan pola.', 2, 2, ([a, p]) => {
  const t = text(a);
  const pt = text(p);
  if (isError(t)) return t;
  if (isError(pt)) return pt;
  const re = safeRegex(pt);
  return isError(re) ? re : re.test(t);
});
def('REGEXEXTRACT', 'Teks', 'REGEXEXTRACT(teks, pola)', 'Mengambil bagian teks yang cocok.', 2, 2, ([a, p]) => {
  const t = text(a);
  const pt = text(p);
  if (isError(t)) return t;
  if (isError(pt)) return pt;
  const re = safeRegex(pt);
  if (isError(re)) return re;
  const m = re.exec(t);
  if (!m) return err.na('Tidak ada yang cocok');
  return m[1] ?? m[0];
});

// ---------- Lookup ----------

function lookupInVector(key: Scalar, get: (i: number) => Scalar, n: number, exact: boolean): number {
  if (exact) {
    const wildcard = typeof key === 'string' && /[*?~]/.test(key);
    const match = wildcard ? buildCriteria(key) : null;
    for (let i = 0; i < n; i++) {
      const v = get(i);
      if (match ? match(v) : compareValues(v, key) === 0 && v !== null) return i;
    }
    return -1;
  }
  // Approximate: largest value <= key, assuming ascending order (binary search).
  let lo = 0;
  let hi = n - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = get(mid);
    if (v === null) {
      hi = mid - 1;
      continue;
    }
    const c = compareValues(v, key);
    if (c <= 0) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

def('VLOOKUP', 'Pencarian', 'VLOOKUP(kunci, rentang, indeks_kolom, [urut])', 'Mencari di kolom pertama dan mengembalikan nilai dari kolom lain.', 3, 4, ([k, r, i, s]) => {
  const key = scalarOf(k);
  if (isError(key)) return key;
  const range = rangeArg(r);
  if (isError(range)) return range;
  const idx = num(i);
  if (isError(idx)) return idx;
  if (idx < 1) return err.value('Indeks kolom harus >= 1');
  if (idx > range.cols) return err.ref('Indeks kolom di luar rentang');
  const sorted = s === undefined ? true : s === '' ? false : toBool(scalarOf(s));
  if (isError(sorted)) return sorted;
  const row = lookupInVector(key, (n) => range.get(n, 0), range.rows, !sorted);
  if (row < 0) return err.na(`Nilai ${String(key)} tidak ditemukan`);
  return range.get(row, Math.trunc(idx) - 1);
});
def('HLOOKUP', 'Pencarian', 'HLOOKUP(kunci, rentang, indeks_baris, [urut])', 'Mencari di baris pertama dan mengembalikan nilai dari baris lain.', 3, 4, ([k, r, i, s]) => {
  const key = scalarOf(k);
  if (isError(key)) return key;
  const range = rangeArg(r);
  if (isError(range)) return range;
  const idx = num(i);
  if (isError(idx)) return idx;
  if (idx < 1) return err.value();
  if (idx > range.rows) return err.ref();
  const sorted = s === undefined ? true : s === '' ? false : toBool(scalarOf(s));
  if (isError(sorted)) return sorted;
  const col = lookupInVector(key, (n) => range.get(0, n), range.cols, !sorted);
  if (col < 0) return err.na();
  return range.get(Math.trunc(idx) - 1, col);
});
def('INDEX', 'Pencarian', 'INDEX(rentang, baris, [kolom])', 'Nilai pada posisi tertentu dalam rentang.', 2, 3, ([r, rr, cc]) => {
  const range = rangeArg(r);
  if (isError(range)) return range;
  const row = num(rr);
  const col = cc === undefined ? (range.rows === 1 ? row : 1) : num(cc);
  if (isError(row)) return row;
  if (isError(col)) return col;
  let ri = Math.trunc(row);
  let ci = Math.trunc(col);
  if (range.rows === 1 && cc === undefined) {
    ci = ri;
    ri = 1;
  }
  if (ri < 1 || ci < 1 || ri > range.rows || ci > range.cols) return err.ref('Posisi di luar rentang');
  return range.get(ri - 1, ci - 1);
});
def('MATCH', 'Pencarian', 'MATCH(kunci, rentang, [jenis])', 'Posisi nilai dalam rentang.', 2, 3, ([k, r, t]) => {
  const key = scalarOf(k);
  if (isError(key)) return key;
  const range = rangeArg(r);
  if (isError(range)) return range;
  if (range.rows > 1 && range.cols > 1) return err.na('MATCH membutuhkan satu baris atau satu kolom');
  const type = t === undefined ? 1 : num(t);
  if (isError(type)) return type;
  const n = Math.max(range.rows, range.cols);
  const get = (i: number) => (range.rows > 1 ? range.get(i, 0) : range.get(0, i));
  if (type === 0) {
    const i = lookupInVector(key, get, n, true);
    return i < 0 ? err.na() : i + 1;
  }
  if (type > 0) {
    const i = lookupInVector(key, get, n, false);
    return i < 0 ? err.na() : i + 1;
  }
  // Descending: smallest value >= key.
  let best = -1;
  for (let i = 0; i < n; i++) {
    const v = get(i);
    if (v !== null && compareValues(v, key) >= 0) best = i;
    else break;
  }
  return best < 0 ? err.na() : best + 1;
});
def('XLOOKUP', 'Pencarian', 'XLOOKUP(kunci, rentang_cari, rentang_hasil, [jika_tidak_ada])', 'Pencarian dengan kecocokan persis.', 3, 4, ([k, lr, rr, nf]) => {
  const key = scalarOf(k);
  if (isError(key)) return key;
  const look = rangeArg(lr);
  const ret = rangeArg(rr);
  if (isError(look)) return look;
  if (isError(ret)) return ret;
  const vertical = look.cols === 1;
  const n = vertical ? look.rows : look.cols;
  const i = lookupInVector(key, (x) => (vertical ? look.get(x, 0) : look.get(0, x)), n, true);
  if (i < 0) return nf === undefined ? err.na() : scalarOf(nf);
  return vertical ? ret.get(i, 0) : ret.get(0, i);
});

// ---------- Date ----------

def('TODAY', 'Tanggal', 'TODAY()', 'Tanggal hari ini.', 0, 0, (_a, ctx) => Math.floor(localNowSerial(ctx.now())), true);
def('NOW', 'Tanggal', 'NOW()', 'Tanggal dan waktu saat ini.', 0, 0, (_a, ctx) => localNowSerial(ctx.now()), true);
def('DATE', 'Tanggal', 'DATE(tahun, bulan, hari)', 'Membuat tanggal.', 3, 3, ([y, m, d]) => {
  const yy = num(y);
  const mm = num(m);
  const dd = num(d);
  if (isError(yy)) return yy;
  if (isError(mm)) return mm;
  if (isError(dd)) return dd;
  let year = Math.trunc(yy);
  if (year < 1900) year += 1900;
  const s = dateToSerial(year, 1, 1);
  // Let Date.UTC roll months and days over.
  const ms = Date.UTC(year, Math.trunc(mm) - 1, Math.trunc(dd));
  const serial = s + (ms - Date.UTC(year, 0, 1)) / 86_400_000;
  return serial < 0 ? err.num() : serial;
});
const datePart = (pick: (p: ReturnType<typeof serialToParts>) => number): FunctionImpl => ([a]) => {
  const n = num(a);
  if (isError(n)) return n;
  if (n < 0) return err.num();
  return pick(serialToParts(n));
};
def('YEAR', 'Tanggal', 'YEAR(tanggal)', 'Tahun dari tanggal.', 1, 1, datePart((p) => p.year));
def('MONTH', 'Tanggal', 'MONTH(tanggal)', 'Bulan dari tanggal.', 1, 1, datePart((p) => p.month));
def('DAY', 'Tanggal', 'DAY(tanggal)', 'Hari dari tanggal.', 1, 1, datePart((p) => p.day));

// ---------- Information ----------

def('ISBLANK', 'Informasi', 'ISBLANK(nilai)', 'TRUE jika sel kosong.', 1, 1, ([a]) => scalarOf(a) === null);
def('ISNUMBER', 'Informasi', 'ISNUMBER(nilai)', 'TRUE jika nilai berupa angka.', 1, 1, ([a]) => typeof scalarOf(a) === 'number');
def('ISTEXT', 'Informasi', 'ISTEXT(nilai)', 'TRUE jika nilai berupa teks.', 1, 1, ([a]) => typeof scalarOf(a) === 'string');
def('ISERROR', 'Informasi', 'ISERROR(nilai)', 'TRUE jika nilai berupa error.', 1, 1, ([a]) => isError(scalarOf(a)));

export function listFunctions(): { name: string; category: string; syntax: string; description: string }[] {
  return [...functionRegistry.entries()]
    .map(([name, s]) => ({ name, category: s.category, syntax: s.syntax, description: s.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function isVolatile(name: string): boolean {
  return functionRegistry.get(name)?.volatile === true;
}

export type { EvalContext };
