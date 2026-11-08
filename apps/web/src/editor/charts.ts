import { colToLetters, isError, parseRangeA1, type ChartSpec, type RangeAddress, type Scalar } from '@opensheet/engine';

export interface ChartSeries {
  name: string;
  values: (number | null)[];
}

export interface ChartData {
  categories: string[];
  /** For scatter: the numeric x of each point. */
  xs: (number | null)[];
  series: ChartSeries[];
  truncated: boolean;
  valid: boolean;
}

/** Charts read at most this many categories; more would be unreadable and slow to draw. */
export const MAX_POINTS = 500;

export const CHART_TYPES: { type: ChartSpec['type']; label: string }[] = [
  { type: 'column', label: 'Kolom' },
  { type: 'bar', label: 'Batang' },
  { type: 'line', label: 'Garis' },
  { type: 'area', label: 'Area' },
  { type: 'pie', label: 'Lingkaran' },
  { type: 'scatter', label: 'Sebar' },
];

const labelOf = (v: Scalar): string => (v === null || v === undefined ? '' : isError(v) ? v.code : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v));
const numOf = (v: Scalar): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Reads the chart's range into categories and series, honouring header and orientation options. */
export function readChart(spec: ChartSpec, get: (row: number, col: number) => Scalar): ChartData {
  const r = parseRangeA1(spec.range);
  if (!r) return { categories: [], xs: [], series: [], truncated: false, valid: false };
  const rowsN = r.r2 - r.r1 + 1;
  const colsN = r.c2 - r.c1 + 1;
  // Work in a "grid" where lines are series; `at(line, pos)` hides the orientation.
  const lines = spec.seriesIn === 'cols' ? colsN : rowsN;
  const len = spec.seriesIn === 'cols' ? rowsN : colsN;
  const at = (line: number, pos: number): Scalar => (spec.seriesIn === 'cols' ? get(r.r1 + pos, r.c1 + line) : get(r.r1 + line, r.c1 + pos));
  const firstLine = spec.headerCol ? 1 : 0; // the first line holds category labels
  const firstPos = spec.headerRow ? 1 : 0; // the first position holds series names
  const count = Math.min(Math.max(0, len - firstPos), MAX_POINTS);
  const categories: string[] = [];
  const xs: (number | null)[] = [];
  for (let p = 0; p < count; p++) {
    const v = spec.headerCol ? at(0, p + firstPos) : null;
    categories.push(spec.headerCol ? labelOf(v as Scalar) : String(p + 1));
    xs.push(spec.headerCol ? numOf(v as Scalar) : p + 1);
  }
  const series: ChartSeries[] = [];
  for (let l = firstLine; l < lines; l++) {
    const values: (number | null)[] = [];
    for (let p = 0; p < count; p++) values.push(numOf(at(l, p + firstPos)));
    const name = spec.headerRow ? labelOf(at(l, 0)) : '';
    series.push({ name: name || `Seri ${series.length + 1}`, values });
  }
  return { categories, xs, series, truncated: len - firstPos > MAX_POINTS, valid: series.length > 0 && count > 0 };
}

/** Round-number axis ticks covering [min, max]. */
export function niceTicks(min: number, max: number, target = 5): { min: number; max: number; ticks: number[] } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, ticks: [0, 1] };
  if (min === max) {
    if (min === 0) return { min: 0, max: 1, ticks: [0, 0.5, 1] };
    max = min > 0 ? min * 1.2 : min * 0.8;
    if (max < min) [min, max] = [max, min];
  }
  const span = max - min;
  const raw = span / Math.max(1, target);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / pow;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return { min: lo, max: hi, ticks };
}

/** Short axis labels: 1.2K, 3.4M; plain numbers below a thousand. */
export function compact(n: number): string {
  const a = Math.abs(n);
  const f = (v: number, s: string) => `${Number(v.toFixed(1)).toLocaleString('id-ID')}${s}`;
  if (a >= 1e12) return f(n / 1e12, ' T');
  if (a >= 1e9) return f(n / 1e9, ' M');
  if (a >= 1e6) return f(n / 1e6, ' jt');
  if (a >= 1e3) return f(n / 1e3, ' rb');
  return Number(n.toFixed(2)).toLocaleString('id-ID');
}

export const chartColor = (i: number) => `var(--chart-${(i % 8) + 1})`;

/** A sensible first chart for a selection: line for a time-like first column, column otherwise. */
export function defaultChart(range: RangeAddress, id: string, anchor: { row: number; col: number }, firstColumnLooksLikeDates: boolean): ChartSpec {
  return {
    id,
    type: firstColumnLooksLikeDates ? 'line' : 'column',
    title: '',
    range: `${colToLetters(range.c1)}${range.r1 + 1}:${colToLetters(range.c2)}${range.r2 + 1}`,
    headerRow: true,
    headerCol: true,
    seriesIn: 'cols',
    stacked: false,
    legend: 'bottom',
    row: anchor.row,
    col: anchor.col,
    dx: 8,
    dy: 8,
    w: 480,
    h: 300,
  };
}
