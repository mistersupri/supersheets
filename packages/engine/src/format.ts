import { dateToSerial, serialToParts } from './dates';
import { FormulaError, Scalar } from './values';

/**
 * Named number formats map to pattern strings. A cell's `numberFormat` is either
 * one of these keys or a custom pattern.
 */
export const NAMED_FORMATS: Record<string, string> = {
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

export function resolvePattern(fmt?: string | null): string | null {
  if (!fmt || fmt === 'auto') return null;
  return NAMED_FORMATS[fmt] ?? fmt;
}

const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const DAYS = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const DAYS_SHORT = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

/** General display for numbers: up to 10 significant digits, no grouping. */
export function formatGeneralNumber(n: number): string {
  if (!Number.isFinite(n)) return '#NUM!';
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e11 || abs < 1e-9) return n.toExponential(5).replace(/\.?0+e/, 'E').replace('e', 'E');
  const s = Number(n.toPrecision(10)).toString();
  return s;
}

export function formatScalar(v: Scalar): string {
  if (v === null) return '';
  if (v instanceof FormulaError) return v.code;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return formatGeneralNumber(v);
  return v;
}

type Tok = { k: 'lit'; v: string } | { k: 'date'; v: string } | { k: 'num'; v: string } | { k: 'ampm' } | { k: 'text' };

function tokenizePattern(p: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < p.length) {
    const ch = p[i];
    if (ch === '"') {
      const j = p.indexOf('"', i + 1);
      const end = j < 0 ? p.length : j;
      out.push({ k: 'lit', v: p.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (ch === '\\') {
      out.push({ k: 'lit', v: p[i + 1] ?? '' });
      i += 2;
      continue;
    }
    if (ch === '[') {
      // Colour / condition blocks are skipped.
      const j = p.indexOf(']', i);
      i = j < 0 ? p.length : j + 1;
      continue;
    }
    if (ch === '_' ) {
      out.push({ k: 'lit', v: ' ' });
      i += 2;
      continue;
    }
    if (ch === '*') {
      i += 2;
      continue;
    }
    if (ch === '@') {
      out.push({ k: 'text' });
      i++;
      continue;
    }
    if (/^AM\/PM/i.test(p.slice(i))) {
      out.push({ k: 'ampm' });
      i += 5;
      continue;
    }
    const lower = ch.toLowerCase();
    if ('dmyhs'.includes(lower)) {
      let j = i;
      while (j < p.length && p[j].toLowerCase() === lower) j++;
      out.push({ k: 'date', v: p.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if ('0#?,.%'.includes(ch) || (ch === 'E' && /[+-]/.test(p[i + 1] ?? ''))) {
      let j = i;
      while (j < p.length && '0#?,.%'.includes(p[j])) j++;
      if (j === i) j = i + 2;
      out.push({ k: 'num', v: p.slice(i, j) });
      i = j;
      continue;
    }
    out.push({ k: 'lit', v: ch });
    i++;
  }
  return out;
}

function isDatePattern(toks: Tok[]): boolean {
  return toks.some((t) => t.k === 'date');
}

function formatDate(serial: number, toks: Tok[]): string {
  const p = serialToParts(serial);
  const hasAmPm = toks.some((t) => t.k === 'ampm');
  let out = '';
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k === 'lit') out += t.v;
    else if (t.k === 'ampm') out += p.hours < 12 ? 'AM' : 'PM';
    else if (t.k === 'num') out += t.v.replace(/[#0?]/g, '');
    else if (t.k === 'date') {
      const v = t.v;
      const c = v[0];
      if (c === 'y') out += v.length <= 2 ? String(p.year).slice(-2) : String(p.year);
      else if (c === 'd') {
        if (v.length === 1) out += p.day;
        else if (v.length === 2) out += String(p.day).padStart(2, '0');
        else if (v.length === 3) out += DAYS_SHORT[p.weekday];
        else out += DAYS[p.weekday];
      } else if (c === 'h') {
        let h = p.hours;
        if (hasAmPm) h = h % 12 === 0 ? 12 : h % 12;
        out += v.length >= 2 ? String(h).padStart(2, '0') : String(h);
      } else if (c === 's') out += v.length >= 2 ? String(p.seconds).padStart(2, '0') : String(p.seconds);
      else if (c === 'm') {
        // "m" after an hour token or before a seconds token means minutes.
        const prev = toks.slice(0, i).reverse().find((x) => x.k === 'date');
        const nextTok = toks.slice(i + 1).find((x) => x.k === 'date');
        const isMinute = (prev && prev.k === 'date' && prev.v[0] === 'h') || (nextTok && nextTok.k === 'date' && nextTok.v[0] === 's');
        if (isMinute) out += v.length >= 2 ? String(p.minutes).padStart(2, '0') : String(p.minutes);
        else if (v.length === 1) out += p.month;
        else if (v.length === 2) out += String(p.month).padStart(2, '0');
        else if (v.length === 3) out += MONTHS_SHORT[p.month - 1];
        else out += MONTHS[p.month - 1];
      }
    }
  }
  return out;
}

function groupThousands(intDigits: string): string {
  return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatNumberPattern(n: number, toks: Tok[]): string {
  const numToks = toks.filter((t) => t.k === 'num').map((t) => (t as { v: string }).v).join('');
  const percent = (numToks.match(/%/g) || []).length;
  let value = n * Math.pow(100, percent);
  const core = numToks.replace(/%/g, '');
  const dot = core.indexOf('.');
  const intPart = dot >= 0 ? core.slice(0, dot) : core;
  const fracPart = dot >= 0 ? core.slice(dot + 1).replace(/,/g, '') : '';
  // Trailing commas scale by 1000.
  const trailingCommas = (/,+$/.exec(intPart)?.[0].length) ?? 0;
  value = value / Math.pow(1000, trailingCommas);
  const grouping = intPart.replace(/,+$/, '').includes(',');
  const minInt = (intPart.match(/0/g) || []).length;
  const fracZeros = (fracPart.match(/0/g) || []).length;
  const fracMax = fracPart.replace(/[^0#?]/g, '').length;

  const abs = Math.abs(value);
  let fixed = abs.toFixed(fracMax);
  let [ip, fp = ''] = fixed.split('.');
  // Trim optional fraction digits (#).
  while (fp.length > fracZeros && fp.endsWith('0')) fp = fp.slice(0, -1);
  if (ip === '0' && minInt === 0) ip = '';
  ip = ip.padStart(minInt, '0');
  if (grouping) ip = groupThousands(ip);
  let numStr = ip + (fp.length > 0 || (fracMax > 0 && fracZeros > 0) ? '.' + fp : '');
  if (numStr === '') numStr = '0';
  fixed = numStr;

  let out = '';
  let placed = false;
  for (const t of toks) {
    if (t.k === 'lit') out += t.v;
    else if (t.k === 'num') {
      if (!placed) {
        out += fixed;
        placed = true;
      }
      out += '%'.repeat((t.v.match(/%/g) || []).length);
    } else if (t.k === 'text') out += String(n);
  }
  if (!placed) out += fixed;
  return out;
}

function splitSections(pattern: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '"') inQuote = !inQuote;
    if (ch === ';' && !inQuote) {
      out.push(cur);
      cur = '';
      continue;
    }
    if (ch === '\\' && i + 1 < pattern.length) {
      cur += ch + pattern[++i];
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Formats a value for display using a named format or custom pattern. */
export function formatValue(v: Scalar, fmt?: string | null): string {
  const pattern = resolvePattern(fmt);
  if (pattern === null || v === null || v instanceof FormulaError || typeof v === 'boolean') return formatScalar(v);
  const sections = splitSections(pattern);
  if (typeof v === 'string') {
    const textSection = sections[3] ?? (sections.find((s) => s.includes('@')) || null);
    if (!textSection) return v;
    return tokenizePattern(textSection)
      .map((t) => (t.k === 'text' ? v : t.k === 'lit' ? t.v : ''))
      .join('');
  }
  if (pattern === '@') return formatScalar(v);
  let section = sections[0];
  let n = v;
  if (n < 0 && sections.length > 1 && sections[1] !== '') {
    section = sections[1];
    n = -n;
  } else if (n === 0 && sections.length > 2 && sections[2] !== '') {
    section = sections[2];
  }
  const toks = tokenizePattern(section);
  if (isDatePattern(toks)) {
    if (n < 0) return '#NUM!';
    return formatDate(n, toks);
  }
  const negativeInFirst = n < 0;
  const s = formatNumberPattern(negativeInFirst ? -n : n, toks);
  return negativeInFirst ? '-' + s : s;
}

export function isDateFormat(fmt?: string | null): boolean {
  const p = resolvePattern(fmt);
  if (!p) return false;
  return isDatePattern(tokenizePattern(splitSections(p)[0]));
}

export interface ParsedInput {
  kind: 'empty' | 'formula' | 'number' | 'string' | 'boolean';
  value: number | string | boolean | null;
  /** Suggested number format when the input implied one (date, percent, currency). */
  formatHint?: string;
}

/**
 * Interprets what a user typed into a cell.
 * Numbers use "." as the decimal separator and "," for grouping.
 * Dates are read day first (dd/mm/yyyy) or ISO (yyyy-mm-dd).
 */
export function parseInput(raw: string): ParsedInput {
  if (raw === '') return { kind: 'empty', value: null };
  if (raw.startsWith("'")) return { kind: 'string', value: raw.slice(1) };
  if (raw.startsWith('=') && raw.length > 1) return { kind: 'formula', value: raw };
  const t = raw.trim();
  const up = t.toUpperCase();
  if (up === 'TRUE') return { kind: 'boolean', value: true };
  if (up === 'FALSE') return { kind: 'boolean', value: false };

  let m = /^([-+]?)(Rp\s?)?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(%?)$/i.exec(t);
  if (m) {
    let n = parseFloat(m[3].replace(/,/g, ''));
    if (m[1] === '-') n = -n;
    if (m[4]) return { kind: 'number', value: n / 100, formatHint: 'percent' };
    if (m[2]) return { kind: 'number', value: n, formatHint: 'currency' };
    return { kind: 'number', value: n };
  }
  m = /^[-+]?\d+(\.\d+)?[eE][-+]?\d+$/.exec(t);
  if (m) return { kind: 'number', value: parseFloat(t) };

  m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (validDate(y, mo, d)) {
      const time = m[4] ? (+m[4] * 3600 + +m[5] * 60 + +(m[6] ?? 0)) / 86400 : 0;
      return { kind: 'number', value: dateToSerial(y, mo, d) + time, formatHint: m[4] ? 'datetime' : 'date' };
    }
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
  if (m) {
    const d = +m[1], mo = +m[2];
    let y = +m[3];
    if (m[3].length === 2) y += y < 50 ? 2000 : 1900;
    if (validDate(y, mo, d)) {
      const time = m[4] ? (+m[4] * 3600 + +m[5] * 60 + +(m[6] ?? 0)) / 86400 : 0;
      return { kind: 'number', value: dateToSerial(y, mo, d) + time, formatHint: m[4] ? 'datetime' : 'date' };
    }
  }
  m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (m && +m[1] < 24 && +m[2] < 60 && +(m[3] ?? 0) < 60) {
    return { kind: 'number', value: (+m[1] * 3600 + +m[2] * 60 + +(m[3] ?? 0)) / 86400, formatHint: 'time' };
  }
  return { kind: 'string', value: raw };
}

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
