/**
 * Formula engine benchmarks against PRD section 10:
 *   cell edit response < 100 ms, formula recalculation < 200 ms (simple).
 *   pnpm --filter @opensheet/engine bench
 */
import { Engine } from '../src';

function time<T>(label: string, fn: () => T, target?: number, runs = 1, reset?: () => void): T {
  const samples: number[] = [];
  let out!: T;
  for (let i = 0; i < runs; i++) {
    if (i > 0) reset?.();
    const t = performance.now();
    out = fn();
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  const ms = samples[Math.floor(samples.length / 2)];
  if (runs > 1) label += ` (median of ${runs})`;
  console.log(`${label.padEnd(58)} ${ms.toFixed(1).padStart(8)} ms${target ? (ms <= target ? `  (target < ${target} ms: OK)` : `  (target < ${target} ms: MISSED)`) : ''}`);
  return out;
}

const ROWS = 50_000;
const e = new Engine();
e.addSheet('s', 'Data');
time(`load ${ROWS * 3} cells (${ROWS} formulas)`, () => {
  const cells = [];
  for (let r = 0; r < ROWS; r++) {
    cells.push({ row: r, col: 0, raw: String(r % 997) });
    cells.push({ row: r, col: 1, raw: `Item ${r}` });
    cells.push({ row: r, col: 2, raw: `=A${r + 1}*2+1` });
  }
  cells.push({ row: 0, col: 4, raw: `=SUM(C1:C${ROWS})` });
  cells.push({ row: 1, col: 4, raw: `=AVERAGE(A1:A${ROWS})` });
  cells.push({ row: 2, col: 4, raw: `=COUNTIF(A1:A${ROWS},">500")` });
  cells.push({ row: 3, col: 4, raw: `=VLOOKUP("Item 49999",B1:C${ROWS},2,FALSE)` });
  e.load('s', cells);
});
time('full recalculation of the sheet', () => e.recalcAll());
let n = 0;
time('edit 1 cell with 1 dependant + 4 aggregates over 50k rows', () => e.setCells([{ sheetId: 's', row: 10, col: 0, raw: String(100 + n++) }]), 100, 7);
time('edit a text cell read by one VLOOKUP over 50k rows', () => e.setCells([{ sheetId: 's', row: 10, col: 1, raw: `baru ${n++}` }]), 100, 7);

// A 2,000-step running total: a change at the top ripples through every row.
const c = new Engine();
c.addSheet('s', 'Chain');
const chain = [{ row: 0, col: 0, raw: '1' }, { row: 0, col: 1, raw: '=A1' }];
for (let r = 1; r < 2000; r++) chain.push({ row: r, col: 0, raw: '1' }, { row: r, col: 1, raw: `=B${r}+A${r + 1}` });
c.load('s', chain);
c.recalcAll();
time('edit at the top of a 2,000-row running total', () => c.setCells([{ sheetId: 's', row: 0, col: 0, raw: '5' }]), 200);

// Typical form-sized workbook (PRD "simple operations").
const f = new Engine();
f.addSheet('s', 'Form');
const small = [];
for (let r = 0; r < 500; r++) small.push({ row: r, col: 0, raw: String(r) }, { row: r, col: 1, raw: `=IF(A${r + 1}>250,"tinggi","rendah")` });
small.push({ row: 0, col: 3, raw: '=SUM(A1:A500)' }, { row: 1, col: 3, raw: '=COUNTIF(B1:B500,"tinggi")' });
f.load('s', small);
f.recalcAll();
time('edit in a 1,000-cell sheet (simple recalculation)', () => f.setCells([{ sheetId: 's', row: 3, col: 0, raw: '400' }]), 200);

// Array formulas.
const clear = (col: number) => () => e.setCells([{ sheetId: 's', row: 0, col, raw: '' }]);
time('FILTER + SORT over 50k rows (spill of ~25k cells)', () => e.setCells([{ sheetId: 's', row: 0, col: 6, raw: `=SORT(FILTER(A1:A${ROWS},A1:A${ROWS}>500),1,FALSE)` }]), 200, 7, clear(6));
time('QUERY group by over 50k rows', () => e.setCells([{ sheetId: 's', row: 0, col: 8, raw: `=QUERY(A1:C${ROWS},"select A, sum(C) group by A",0)` }]), 200, 7, clear(8));
