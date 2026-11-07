/**
 * One axis (rows or columns) of the grid. Sizes default to `base`; only
 * overrides and hidden indices are stored, so the axis can be millions long.
 * Positions use sorted override keys with prefix sums: O(log n) lookups.
 */
export class Axis {
  private keys: number[];
  private deltas: number[]; // prefix sums of (size - base) up to and including keys[i]
  readonly total: number;

  constructor(
    readonly base: number,
    readonly count: number,
    private sizes: Map<number, number>,
  ) {
    this.keys = [...sizes.keys()].filter((k) => k < count).sort((a, b) => a - b);
    this.deltas = [];
    let acc = 0;
    for (const key of this.keys) {
      acc += sizes.get(key)! - base;
      this.deltas.push(acc);
    }
    this.total = count * base + acc;
  }

  size(i: number): number {
    return this.sizes.get(i) ?? this.base;
  }

  hidden(i: number): boolean {
    return this.size(i) === 0;
  }

  /** Offset of the start of index i. */
  pos(i: number): number {
    // number of keys < i
    let lo = 0;
    let hi = this.keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.keys[mid] < i) lo = mid + 1;
      else hi = mid;
    }
    return i * this.base + (lo > 0 ? this.deltas[lo - 1] : 0);
  }

  /** Index containing offset px (clamped). Skips zero-size (hidden) indices. */
  indexAt(px: number): number {
    if (px <= 0) return this.firstVisible(0);
    if (px >= this.total) return this.count - 1;
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.pos(mid) <= px) lo = mid;
      else hi = mid - 1;
    }
    // Hidden indices share a position with the next visible one.
    while (lo < this.count - 1 && this.size(lo) === 0) lo++;
    return lo;
  }

  firstVisible(from: number): number {
    let i = from;
    while (i < this.count - 1 && this.size(i) === 0) i++;
    return i;
  }

  nextVisible(i: number, dir: 1 | -1): number {
    let j = i + dir;
    while (j >= 0 && j < this.count && this.size(j) === 0) j += dir;
    if (j < 0 || j >= this.count) return i;
    return j;
  }
}

export const HEADER_W = 46;
export const HEADER_H = 24;
