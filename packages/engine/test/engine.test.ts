import { describe, expect, it } from 'vitest';
import {
  adjustFormulaForStructure,
  Engine,
  FormulaError,
  formatValue,
  parseA1,
  parseFormula,
  parseInput,
  renameSheetInFormula,
  Scalar,
  serialize,
  translateFormula,
  dateToSerial,
} from '../src';

function wb(cells: Record<string, string>, sheet = 's1', name = 'Sheet1') {
  const e = new Engine();
  e.addSheet(sheet, name);
  e.load(
    sheet,
    Object.entries(cells).map(([a1, raw]) => {
      const p = parseA1(a1)!;
      return { row: p.row, col: p.col, raw };
    }),
  );
  e.recalcAll();
  return e;
}

function v(e: Engine, a1: string, sheet = 's1'): Scalar {
  const p = parseA1(a1)!;
  return e.getValue(sheet, p.row, p.col);
}

function code(x: Scalar): string | null {
  return x instanceof FormulaError ? x.code : null;
}

function set(e: Engine, a1: string, raw: string, sheet = 's1') {
  const p = parseA1(a1)!;
  return e.setCells([{ sheetId: sheet, row: p.row, col: p.col, raw }]);
}

describe('parser', () => {
  it('parses references of every kind', () => {
    expect(serialize(parseFormula('$A$1+A$2+$B3+C4'))).toBe('$A$1+A$2+$B3+C4');
    expect(serialize(parseFormula("SUM('Data 2024'!A1:B2, Sheet2!C:C, 3:5)"))).toBe("SUM('Data 2024'!A1:B2,Sheet2!C:C,3:5)");
  });
  it('respects precedence', () => {
    const e = wb({ A1: '=1+2*3', A2: '=(1+2)*3', A3: '=-2^2', A4: '=2^3^2', A5: '=50%*10', A6: '="a"&1+1' });
    expect(v(e, 'A1')).toBe(7);
    expect(v(e, 'A2')).toBe(9);
    expect(v(e, 'A3')).toBe(4);
    expect(v(e, 'A4')).toBe(64);
    expect(v(e, 'A5')).toBe(5);
    expect(v(e, 'A6')).toBe('a2');
  });
  it('reports malformed formulas as #ERROR!', () => {
    const e = wb({ A1: '=SUM(1,' });
    expect(code(v(e, 'A1'))).toBe('#ERROR!');
  });
});

describe('MVP functions', () => {
  const data = {
    A1: '10', A2: '20', A3: '30', A4: 'teks', A5: '',
    B1: 'apel', B2: 'jeruk', B3: 'apel',
    D1: 'kode', E1: 'nama', D2: 'K1', E2: 'Budi', D3: 'K2', E3: 'Sari', D4: 'K3', E4: 'Tono',
  };
  it('SUM, AVERAGE, COUNT, COUNTA, MAX, MIN, PRODUCT', () => {
    const e = wb({ ...data, C1: '=SUM(A1:A5)', C2: '=AVERAGE(A1:A4)', C3: '=COUNT(A1:A5)', C4: '=COUNTA(A1:A5)', C5: '=MAX(A1:A3,45)', C6: '=MIN(A1:A3)', C7: '=PRODUCT(A1:A2)' });
    expect(v(e, 'C1')).toBe(60);
    expect(v(e, 'C2')).toBe(20);
    expect(v(e, 'C3')).toBe(3);
    expect(v(e, 'C4')).toBe(4);
    expect(v(e, 'C5')).toBe(45);
    expect(v(e, 'C6')).toBe(10);
    expect(v(e, 'C7')).toBe(200);
  });
  it('IF, AND, OR, NOT, IFERROR', () => {
    const e = wb({ ...data, C1: '=IF(A1>15,"besar","kecil")', C2: '=IF(AND(A1>5,A2>5),1,0)', C3: '=OR(FALSE,A3=30)', C4: '=NOT(TRUE)', C5: '=IFERROR(1/0,"aman")', C6: '=IF(TRUE,1,1/0)' });
    expect(v(e, 'C1')).toBe('kecil');
    expect(v(e, 'C2')).toBe(1);
    expect(v(e, 'C3')).toBe(true);
    expect(v(e, 'C4')).toBe(false);
    expect(v(e, 'C5')).toBe('aman');
    expect(v(e, 'C6')).toBe(1);
  });
  it('COUNTIF, SUMIF, AVERAGEIF with criteria and wildcards', () => {
    const e = wb({ ...data, C1: '=COUNTIF(B1:B3,"apel")', C2: '=COUNTIF(A1:A3,">15")', C3: '=SUMIF(B1:B3,"apel",A1:A3)', C4: '=AVERAGEIF(A1:A3,"<>20")', C5: '=COUNTIF(B1:B3,"j*")' });
    expect(v(e, 'C1')).toBe(2);
    expect(v(e, 'C2')).toBe(2);
    expect(v(e, 'C3')).toBe(40);
    expect(v(e, 'C4')).toBe(20);
    expect(v(e, 'C5')).toBe(1);
  });
  it('VLOOKUP, HLOOKUP, INDEX, MATCH', () => {
    const e = wb({ ...data, F1: '=VLOOKUP("K2",D2:E4,2,FALSE)', F2: '=VLOOKUP("K9",D2:E4,2,FALSE)', F3: '=INDEX(D2:E4,3,2)', F4: '=MATCH("Sari",E2:E4,0)', F5: '=HLOOKUP("nama",D1:E4,3,FALSE)', F6: '=VLOOKUP("K2",D2:E4,3,FALSE)' });
    expect(v(e, 'F1')).toBe('Sari');
    expect(code(v(e, 'F2'))).toBe('#N/A');
    expect(v(e, 'F3')).toBe('Tono');
    expect(v(e, 'F4')).toBe(2);
    expect(v(e, 'F5')).toBe('Sari');
    expect(code(v(e, 'F6'))).toBe('#REF!');
  });
  it('approximate VLOOKUP finds the largest value not above the key', () => {
    const e = wb({ A1: '0', B1: 'E', A2: '60', B2: 'C', A3: '80', B3: 'A', C1: '=VLOOKUP(75,A1:B3,2)' });
    expect(v(e, 'C1')).toBe('C');
  });
  it('text functions', () => {
    const e = wb({ A1: '  halo   dunia ', B1: '=TRIM(A1)', B2: '=LEFT("OpenSheet",4)', B3: '=RIGHT("OpenSheet",5)', B4: '=MID("OpenSheet",5,3)', B5: '=LEN("abc")', B6: '=CONCATENATE("a","b",1)', B7: '=CONCAT(B2:B3)' });
    expect(v(e, 'B1')).toBe('halo dunia');
    expect(v(e, 'B2')).toBe('Open');
    expect(v(e, 'B3')).toBe('Sheet');
    expect(v(e, 'B4')).toBe('She');
    expect(v(e, 'B5')).toBe(3);
    expect(v(e, 'B6')).toBe('ab1');
    expect(v(e, 'B7')).toBe('OpenSheet');
  });
  it('date functions', () => {
    const e = wb({ A1: '=DATE(2026,11,7)', A2: '=YEAR(A1)', A3: '=MONTH(A1)', A4: '=DAY(A1)', A5: '=DATE(2026,13,1)' });
    expect(v(e, 'A1')).toBe(dateToSerial(2026, 11, 7));
    expect(v(e, 'A2')).toBe(2026);
    expect(v(e, 'A3')).toBe(11);
    expect(v(e, 'A4')).toBe(7);
    expect(v(e, 'A5')).toBe(dateToSerial(2027, 1, 1));
  });
  it('TODAY uses the injected clock', () => {
    const e = new Engine();
    e.setClock(() => new Date(2026, 10, 7, 9, 30));
    e.addSheet('s1', 'Sheet1');
    e.load('s1', [{ row: 0, col: 0, raw: '=TODAY()' }]);
    e.recalcAll();
    expect(e.getValue('s1', 0, 0)).toBe(dateToSerial(2026, 11, 7));
  });
  it('information functions', () => {
    const e = wb({ A1: '5', A2: 'x', B1: '=ISBLANK(A3)', B2: '=ISNUMBER(A1)', B3: '=ISTEXT(A2)', B4: '=ISNUMBER(A2)' });
    expect(v(e, 'B1')).toBe(true);
    expect(v(e, 'B2')).toBe(true);
    expect(v(e, 'B3')).toBe(true);
    expect(v(e, 'B4')).toBe(false);
  });
  it('ROUND and ABS', () => {
    const e = wb({ A1: '=ROUND(1.005,2)', A2: '=ROUND(1234.5,-2)', A3: '=ABS(-3)' });
    expect(v(e, 'A1')).toBe(1.01);
    expect(v(e, 'A2')).toBe(1200);
    expect(v(e, 'A3')).toBe(3);
  });
});

describe('errors', () => {
  it('recognises every required error', () => {
    const e = wb({ A1: '=1/0', A2: '="a"+1', A3: '=FOO(1)', A4: '=SQRT(-1)', A5: '=VLOOKUP(1,B1:B2,1,FALSE)', A6: '=Nope!A1', A7: '=A8', A8: '=A7' });
    expect(code(v(e, 'A1'))).toBe('#DIV/0!');
    expect(code(v(e, 'A2'))).toBe('#VALUE!');
    expect(code(v(e, 'A3'))).toBe('#NAME?');
    expect(code(v(e, 'A4'))).toBe('#NUM!');
    expect(code(v(e, 'A5'))).toBe('#N/A');
    expect(code(v(e, 'A6'))).toBe('#REF!');
    expect(code(v(e, 'A7'))).toBe('#CYCLE!');
    expect(code(v(e, 'A8'))).toBe('#CYCLE!');
  });
  it('propagates errors through dependants', () => {
    const e = wb({ A1: '=1/0', A2: '=A1+1', A3: '=SUM(A1:A2)' });
    expect(code(v(e, 'A2'))).toBe('#DIV/0!');
    expect(code(v(e, 'A3'))).toBe('#DIV/0!');
  });
  it('a self reference is a cycle and recovers when fixed', () => {
    const e = wb({ A1: '=A1+1' });
    expect(code(v(e, 'A1'))).toBe('#CYCLE!');
    set(e, 'A1', '5');
    expect(v(e, 'A1')).toBe(5);
  });
});

describe('dependency tracking', () => {
  it('recalculates dependants when a precedent changes', () => {
    const e = wb({ A1: '1', A2: '2', A3: '=SUM(A1:A2)', A4: '=A3*10' });
    expect(v(e, 'A4')).toBe(30);
    const changes = set(e, 'A1', '5');
    expect(v(e, 'A3')).toBe(7);
    expect(v(e, 'A4')).toBe(70);
    expect(changes.map((c) => `${c.row}:${c.col}`).sort()).toEqual(['0:0', '2:0', '3:0']);
  });
  it('whole-column ranges pick up new rows', () => {
    const e = wb({ A1: '1', B1: '=SUM(A:A)' });
    set(e, 'A500', '9');
    expect(v(e, 'B1')).toBe(10);
  });
  it('handles a long top-down chain', () => {
    const cells: Record<string, string> = { A1: '1' };
    for (let r = 2; r <= 5000; r++) cells[`A${r}`] = `=A${r - 1}+1`;
    const e = wb(cells);
    expect(v(e, 'A5000')).toBe(5000);
    set(e, 'A1', '10');
    expect(v(e, 'A5000')).toBe(5009);
  });
  it('cross-sheet references and sheet renames', () => {
    const e = new Engine();
    e.addSheet('s1', 'Data');
    e.addSheet('s2', 'Ringkasan');
    e.load('s1', [{ row: 0, col: 0, raw: '42' }]);
    e.load('s2', [{ row: 0, col: 0, raw: '=Data!A1*2' }, { row: 1, col: 0, raw: "='Tahun Lalu'!A1" }]);
    e.recalcAll();
    expect(e.getValue('s2', 0, 0)).toBe(84);
    expect(code(e.getValue('s2', 1, 0))).toBe('#REF!');
    e.addSheet('s3', 'Tahun Lalu');
    e.setCells([{ sheetId: 's3', row: 0, col: 0, raw: '7' }]);
    expect(e.getValue('s2', 1, 0)).toBe(7);
    e.setCells([{ sheetId: 's1', row: 0, col: 0, raw: '1' }]);
    expect(e.getValue('s2', 0, 0)).toBe(2);
  });
  it('never uses eval or Function', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src');
    for (const f of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(src).not.toMatch(/\beval\s*\(/);
      expect(src).not.toMatch(/new\s+Function\s*\(/);
    }
  });
});

describe('formula translation', () => {
  it('shifts relative references only', () => {
    expect(translateFormula('=A1+$B$1+$C1+D$1', 2, 1)).toBe('=B3+$B$1+$C3+E$1');
    expect(translateFormula('=SUM(A1:B2)', 1, 0)).toBe('=SUM(A2:B3)');
    expect(translateFormula('=A1', -1, 0)).toBe('=#REF!');
  });
  it('adjusts for inserted and deleted rows', () => {
    const ins = { sheetName: 'Sheet1', axis: 'row' as const, index: 2, count: 1 };
    expect(adjustFormulaForStructure('=A1+A3', 'Sheet1', ins)).toBe('=A1+A4');
    expect(adjustFormulaForStructure('=SUM(A1:A5)', 'Sheet1', ins)).toBe('=SUM(A1:A6)');
    const del = { sheetName: 'Sheet1', axis: 'row' as const, index: 2, count: -1 };
    expect(adjustFormulaForStructure('=A3', 'Sheet1', del)).toBe('=#REF!');
    expect(adjustFormulaForStructure('=SUM(A1:A5)', 'Sheet1', del)).toBe('=SUM(A1:A4)');
    expect(adjustFormulaForStructure('=Other!A5', 'Sheet1', del)).toBe('=Other!A5');
    expect(adjustFormulaForStructure('=Sheet1!A5', 'Other', del)).toBe('=Sheet1!A4');
  });
  it('renames sheet references', () => {
    expect(renameSheetInFormula('=Data!A1+data!B2', 'Data', 'Data 2026')).toBe("='Data 2026'!A1+'Data 2026'!B2");
  });
});

describe('input parsing and formats', () => {
  it('reads numbers, percents, currency, dates and times', () => {
    expect(parseInput('1,234.5')).toMatchObject({ kind: 'number', value: 1234.5 });
    expect(parseInput('12%')).toMatchObject({ kind: 'number', value: 0.12, formatHint: 'percent' });
    expect(parseInput('Rp 15,000')).toMatchObject({ kind: 'number', value: 15000, formatHint: 'currency' });
    expect(parseInput('07/11/2026')).toMatchObject({ kind: 'number', value: dateToSerial(2026, 11, 7), formatHint: 'date' });
    expect(parseInput('2026-11-07')).toMatchObject({ value: dateToSerial(2026, 11, 7) });
    expect(parseInput('31/02/2026')).toMatchObject({ kind: 'string' });
    expect(parseInput('08:30')).toMatchObject({ kind: 'number', value: 8.5 / 24, formatHint: 'time' });
    expect(parseInput("'0812")).toMatchObject({ kind: 'string', value: '0812' });
    expect(parseInput('0812')).toMatchObject({ kind: 'number', value: 812 });
  });
  it('formats numbers', () => {
    expect(formatValue(1234567.891, 'number')).toBe('1,234,567.89');
    expect(formatValue(15000, 'currency')).toBe('Rp15,000');
    expect(formatValue(0.125, 'percent')).toBe('12.50%');
    expect(formatValue(-5, '#,##0;(#,##0)')).toBe('(5)');
    expect(formatValue(3.5, '0.0#')).toBe('3.5');
    expect(formatValue(1 / 3, 'auto')).toBe('0.3333333333');
  });
  it('formats dates and times', () => {
    const d = dateToSerial(2026, 11, 7) + 0.75;
    expect(formatValue(d, 'date')).toBe('07/11/2026');
    expect(formatValue(d, 'date_long')).toBe('7 November 2026');
    expect(formatValue(d, 'time')).toBe('18:00:00');
    expect(formatValue(d, 'dddd, d mmm yyyy')).toBe('Sabtu, 7 Nov 2026');
    expect(formatValue(d, 'h:mm AM/PM')).toBe('6:00 PM');
  });
});
