/**
 * Small in-process caches for hot lookups (session, workbook role, settings).
 * Entries expire after a short TTL and are dropped immediately on writes via
 * the invalidation bus, which also fans out across processes when Redis is
 * configured (see lib/bus.ts).
 */
export class TtlCache<V> {
  private map = new Map<string, { v: V; exp: number }>();

  constructor(
    private ttlMs: number,
    private max = 20_000,
  ) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e.v;
  }

  set(key: string, v: V): void {
    if (this.map.size >= this.max) {
      // Drop the oldest entry (Map keeps insertion order).
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
    this.map.set(key, { v, exp: Date.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  deleteWhere(pred: (key: string, v: V) => boolean): void {
    for (const [k, e] of this.map) if (pred(k, e.v)) this.map.delete(k);
  }

  clear(): void {
    this.map.clear();
  }
}
