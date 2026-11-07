import { describe, expect, it } from 'vitest';
import { Engine, FormulaError, parseA1, Scalar } from '../src';

function wb(cells: Record<string, string>) {
  const e = new Engine();
  e.addSheet('s1', 'Sheet1');
  e.load(
    's1',
    Object.entries(cells).map(([a1, raw]) => {
      const p = parseA1(a1)!;
      return { row: p.row, col: p.col, raw };
    }),
  );
  e.recalcAll();
  return e;
}
const v = (e: Engine, a1: string): Scalar => {
  const p = parseA1(a1)!;
  return e.getValue('s1', p.row, p.col);
};
const code = (x: Scalar) => (x instanceof FormulaError ? x.code : null);
const set = (e: Engine, a1: string, raw: string) => {
  const p = parseA1(a1)!;
  return e.setCells([{ sheetId: 's1', row: p.row, col: p.col, raw }]);
};

const data = {
  A1: 'Nama', B1: 'Kelas', C1: 'Nilai',
  A2: 'Ani', B2: 'X', C2: '80',
  A3: 'Budi', B3: 'XI', C3: '65',
  A4: 'Citra', B4: 'X', C4: '92',
  A5: 'Dodi', B5: 'XI', C5: '70',
};

describe('spill', () => {
  it('SEQUENCE spills into neighbours', () => {
    const e = wb({ A1: '=SEQUENCE(3,2)' });
    expect([v(e, 'A1'), v(e, 'B1'), v(e, 'A2'), v(e, 'B3')]).toEqual([1, 2, 3, 6]);
  });
  it('range arithmetic spills (dynamic arrays)', () => {
    const e = wb({ A1: '1', A2: '2', A3: '3', B1: '=A1:A3*10' });
    expect([v(e, 'B1'), v(e, 'B2'), v(e, 'B3')]).toEqual([10, 20, 30]);
  });
  it('blocked spill gives #REF! and recovers when the cell is cleared', () => {
    const e = wb({ A1: '=SEQUENCE(3)', A3: 'menghalangi' });
    expect(code(v(e, 'A1'))).toBe('#REF!');
    set(e, 'A3', '');
    expect([v(e, 'A1'), v(e, 'A2'), v(e, 'A3')]).toEqual([1, 2, 3]);
    set(e, 'A2', 'x');
    expect(code(v(e, 'A1'))).toBe('#REF!');
    expect(v(e, 'A3')).toBe(null);
  });
  it('formulas reading spilled cells update when the array changes', () => {
    const e = wb({ A1: '=SEQUENCE(D1)', D1: '3', C1: '=SUM(A1:A10)', C2: '=A3*2' });
    expect(v(e, 'C1')).toBe(6);
    expect(v(e, 'C2')).toBe(6);
    set(e, 'D1', '5');
    expect(v(e, 'C1')).toBe(15);
    set(e, 'D1', '2');
    expect(v(e, 'C1')).toBe(3);
    expect(v(e, 'C2')).toBe(0);
  });
  it('removing the anchor clears its spill', () => {
    const e = wb({ A1: '=SEQUENCE(3)', B1: '=SUM(A1:A3)' });
    expect(v(e, 'B1')).toBe(6);
    set(e, 'A1', '');
    expect(v(e, 'A2')).toBe(null);
    expect(v(e, 'B1')).toBe(0);
  });
  it('spill area is reported for the UI', () => {
    const e = wb({ B2: '=SEQUENCE(2,3)' });
    expect(e.spillAreaAt('s1', 2, 3)).toMatchObject({ r1: 1, c1: 1, r2: 2, c2: 3, anchorRow: 1, anchorCol: 1, ok: true });
  });
});

describe('array functions', () => {
  it('FILTER rows by one or more conditions', () => {
    const e = wb({ ...data, E1: '=FILTER(A2:A5,B2:B5="X")', F1: '=FILTER(A2:C5,C2:C5>=70,B2:B5="XI")', J1: '=FILTER(A2:A5,C2:C5>100)' });
    expect([v(e, 'E1'), v(e, 'E2'), v(e, 'E3')]).toEqual(['Ani', 'Citra', null]);
    expect([v(e, 'F1'), code(v(e, 'J1'))]).toEqual(['Dodi', '#N/A']);
    expect(v(e, 'H1')).toBe(70);
  });
  it('SORT by column and direction', () => {
    const e = wb({ ...data, E1: '=SORT(A2:C5,3,FALSE)' });
    expect([v(e, 'E1'), v(e, 'E2'), v(e, 'G1'), v(e, 'E4')]).toEqual(['Citra', 'Ani', 92, 'Budi']);
  });
  it('UNIQUE keeps the first occurrence', () => {
    const e = wb({ ...data, E1: '=UNIQUE(B2:B5)' });
    expect([v(e, 'E1'), v(e, 'E2'), v(e, 'E3')]).toEqual(['X', 'XI', null]);
  });
  it('TRANSPOSE and ARRAYFORMULA with IF', () => {
    const e = wb({ ...data, E1: '=TRANSPOSE(A1:A3)', E3: '=ARRAYFORMULA(IF(C2:C5>=75,"Lulus","Remedial"))' });
    expect([v(e, 'E1'), v(e, 'F1'), v(e, 'G1')]).toEqual(['Nama', 'Ani', 'Budi']);
    expect([v(e, 'E3'), v(e, 'E4'), v(e, 'E5'), v(e, 'E6')]).toEqual(['Lulus', 'Remedial', 'Lulus', 'Remedial']);
  });
  it('aggregates accept computed arrays', () => {
    const e = wb({ ...data, E1: '=SUM(C2:C5*2)', E2: '=SUM(FILTER(C2:C5,B2:B5="X"))', E3: '=COUNTA(UNIQUE(B2:B5))' });
    expect([v(e, 'E1'), v(e, 'E2'), v(e, 'E3')]).toEqual([614, 172, 2]);
  });
});

describe('QUERY', () => {
  it('select, where, order by, limit with header detection', () => {
    const e = wb({ ...data, E1: '=QUERY(A1:C5,"select A, C where C > 66 order by C desc limit 2")' });
    expect([v(e, 'E1'), v(e, 'F1')]).toEqual(['Nama', 'Nilai']);
    expect([v(e, 'E2'), v(e, 'F2'), v(e, 'E3'), v(e, 'E4')]).toEqual(['Citra', 92, 'Ani', null]);
  });
  it('group by with aggregates and labels', () => {
    const e = wb({ ...data, E1: `=QUERY(A1:C5,"select B, avg(C), count(A) group by B label avg(C) 'Rata-rata'",1)` });
    expect([v(e, 'E1'), v(e, 'F1'), v(e, 'G1')]).toEqual(['Kelas', 'Rata-rata', 'count Nama']);
    expect([v(e, 'E2'), v(e, 'F2'), v(e, 'G2')]).toEqual(['X', 86, 2]);
    expect([v(e, 'E3'), v(e, 'F3')]).toEqual(['XI', 67.5]);
  });
  it('text operators and boolean logic', () => {
    const e = wb({ ...data, E1: `=QUERY(A2:C5,"select A where A contains 'i' and not B = 'XI'",0)` });
    expect([v(e, 'E1'), v(e, 'E2'), v(e, 'E3')]).toEqual(['Ani', 'Citra', null]);
  });
  it('reports a readable error for bad queries', () => {
    const e = wb({ ...data, E1: '=QUERY(A1:C5,"select Z")' });
    expect(code(v(e, 'E1'))).toBe('#VALUE!');
  });
});

describe('IMPORTRANGE', () => {
  it('uses the provider and refreshes when data arrives', () => {
    const e = new Engine();
    let ready = false;
    e.setImportProvider((src, range) => (src === 'wb-2' && range === 'Data!A1:B2' ? (ready ? [[1, 2], [3, 4]] : 'pending') : new FormulaError('#REF!')));
    e.addSheet('s1', 'Sheet1');
    e.load('s1', [
      { row: 0, col: 0, raw: '=IMPORTRANGE("wb-2","Data!A1:B2")' },
      { row: 0, col: 3, raw: '=SUM(A1:B2)' },
    ]);
    e.recalcAll();
    expect(code(e.getValue('s1', 0, 0))).toBe('#N/A');
    ready = true;
    e.refreshExternal();
    expect(e.getValue('s1', 1, 1)).toBe(4);
    expect(e.getValue('s1', 0, 3)).toBe(10);
  });
});
