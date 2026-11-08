import { describe, expect, it } from 'vitest';
import { permuteRefsInFormula } from '../src';

// Move rows 2..3 (zero-based 1..2) below row 5: 1,2 -> 3,4 and 3,4 -> 1,2.
const map = (i: number) => (i === 1 || i === 2 ? i + 2 : i === 3 || i === 4 ? i - 2 : i);

describe('permuteRefsInFormula', () => {
  it('moves single references with the cell they point at', () => {
    expect(permuteRefsInFormula('=A2+A5+A6', 'S', 'S', 'row', map)).toBe('=A4+A3+A6');
  });
  it('keeps absolute markers and other sheets alone', () => {
    expect(permuteRefsInFormula('=$A$2+Other!A2', 'S', 'S', 'row', map)).toBe('=$A$4+Other!A2');
  });
  it('normalises a range whose ends swap order', () => {
    expect(permuteRefsInFormula('=SUM(A2:A5)', 'S', 'S', 'row', map)).toBe('=SUM(A3:A4)');
  });
  it('only changes the axis that was reordered', () => {
    expect(permuteRefsInFormula('=B2', 'S', 'S', 'row', map)).toBe('=B4');
    expect(permuteRefsInFormula('=A:A', 'S', 'S', 'row', map)).toBe('=A:A');
  });
});
