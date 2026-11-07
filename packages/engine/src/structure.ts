import { formatRangeA1, parseRangeA1, RangeAddress } from './address';
import type { Merge, SheetFilter, SheetMetadata } from './model';

/**
 * Row/column insert and delete, shared by the client (instant local update)
 * and the server (authoritative SQL shift) so both produce the same result.
 * `count` > 0 inserts before `index`; `count` < 0 deletes starting at `index`.
 */
export interface StructureOp {
  axis: 'row' | 'col';
  index: number;
  count: number;
}

export function shiftIndex(i: number, op: StructureOp): number | null {
  if (op.count > 0) return i >= op.index ? i + op.count : i;
  const del = -op.count;
  if (i < op.index) return i;
  if (i >= op.index + del) return i - del;
  return null;
}

export function shiftRange<T extends RangeAddress>(r: T, op: StructureOp): T | null {
  const lo = op.axis === 'row' ? r.r1 : r.c1;
  const hi = op.axis === 'row' ? r.r2 : r.c2;
  let nlo: number;
  let nhi: number;
  if (op.count > 0) {
    nlo = lo >= op.index ? lo + op.count : lo;
    nhi = hi >= op.index ? hi + op.count : hi;
  } else {
    const del = -op.count;
    const end = op.index + del - 1;
    if (lo >= op.index && hi <= end) return null;
    nlo = lo < op.index ? lo : lo > end ? lo - del : op.index;
    nhi = hi < op.index ? hi : hi > end ? hi - del : op.index - 1;
  }
  return op.axis === 'row' ? { ...r, r1: nlo, r2: nhi } : { ...r, c1: nlo, c2: nhi };
}

export function shiftA1(range: string | null, op: StructureOp): string | null | undefined {
  if (range === null) return null;
  const r = parseRangeA1(range);
  if (!r) return range;
  const n = shiftRange(r, op);
  return n ? formatRangeA1(n) : undefined; // undefined: the range was deleted
}

export function shiftMetadata(md: SheetMetadata, op: StructureOp): SheetMetadata {
  const out: SheetMetadata = { ...md };
  const shiftMap = (m?: Record<number, number>) => {
    const res: Record<number, number> = {};
    for (const [i, v] of Object.entries(m ?? {})) {
      const n = shiftIndex(Number(i), op);
      if (n !== null) res[n] = v;
    }
    return res;
  };
  const shiftList = (l?: number[]) => (l ?? []).map((i) => shiftIndex(i, op)).filter((x): x is number => x !== null);
  if (op.axis === 'row') {
    out.rowHeights = shiftMap(md.rowHeights);
    out.hiddenRows = shiftList(md.hiddenRows);
  } else {
    out.colWidths = shiftMap(md.colWidths);
    out.hiddenCols = shiftList(md.hiddenCols);
  }
  out.merges = (md.merges ?? []).map((m) => shiftRange(m, op)).filter((m): m is Merge => !!m && (m.r1 !== m.r2 || m.c1 !== m.c2));
  const shiftFilter = (f: SheetFilter | null | undefined): SheetFilter | null => {
    if (!f) return null;
    const n = shiftRange(f, op);
    if (!n) return null;
    if (op.axis === 'col') {
      const crit: SheetFilter['criteria'] = {};
      for (const [c, v] of Object.entries(f.criteria ?? {})) {
        const k = shiftIndex(Number(c), op);
        if (k !== null) crit[k] = v;
      }
      n.criteria = crit;
    }
    return n;
  };
  if (md.filter !== undefined) out.filter = shiftFilter(md.filter);
  if (md.filterViews) out.filterViews = md.filterViews.map((v) => ({ ...v, filter: shiftFilter(v.filter) })).filter((v) => v.filter) as SheetMetadata['filterViews'];
  return out;
}

/** Frozen rows/columns move when the change happens inside the frozen band. */
export function shiftFrozen(frozen: number, op: StructureOp): number {
  if (frozen <= op.index) return frozen;
  if (op.count > 0) return frozen + op.count;
  return Math.max(op.index, frozen + op.count);
}
