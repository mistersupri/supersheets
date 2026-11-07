import { MAX_COLS, MAX_ROWS, RangeAddress } from './address';
import { EvalContext, evaluate, Grid, MAX_ARRAY_CELLS } from './evaluator';
import { isVolatile } from './functions';
import './arrays';
import { parseInput } from './format';
import { collectFunctions, Node, parseFormula } from './parser';
import { err, FormulaError, isError, Scalar } from './values';

interface CellRec {
  raw: string;
  ast: Node | null; // formula AST, null for constants
  parseError: boolean;
  value: Scalar;
  volatile: boolean;
}

interface SheetState {
  id: string;
  name: string;
  cells: Map<string, CellRec>;
  rows: number; // used size
  cols: number;
}

interface Deps {
  cells: string[]; // global keys
  ranges: { sheetId: string; range: RangeAddress }[];
  sheetNames: string[]; // referenced sheet names that did not resolve
}

export interface CellChange {
  sheetId: string;
  row: number;
  col: number;
  raw: string;
}

export interface ValueChange {
  sheetId: string;
  row: number;
  col: number;
  value: Scalar;
}

const WIDE = 64;

function gk(sheetId: string, row: number, col: number): string {
  return `${sheetId}|${row}:${col}`;
}
function splitGk(key: string): { sheetId: string; row: number; col: number } {
  const bar = key.lastIndexOf('|');
  const colon = key.indexOf(':', bar);
  return { sheetId: key.slice(0, bar), row: Number(key.slice(bar + 1, colon)), col: Number(key.slice(colon + 1)) };
}

/**
 * The calculation engine. It owns raw cell input for every sheet in a workbook,
 * tracks formula dependencies and recalculates only what a change affects.
 * It has no UI or network dependencies.
 */
export class Engine {
  private sheets = new Map<string, SheetState>();
  private dependents = new Map<string, Set<string>>();
  /** sheetId -> column -> range dependencies touching that column. */
  private rangeIndex = new Map<string, Map<number, Map<string, RangeAddress[]>>>();
  /** sheetId -> range dependencies spanning many columns. */
  private wideRanges = new Map<string, Map<string, RangeAddress[]>>();
  private deps = new Map<string, Deps>();
  private volatileCells = new Set<string>();
  /** Cells using IMPORTRANGE, refreshed when external data arrives. */
  private externalCells = new Set<string>();
  private nowFn: () => Date = () => new Date();
  private importFn?: EvalContext['importRange'];
  /** Array formulas: anchor -> area it wants to fill (ok=false when blocked by data). */
  private spills = new Map<string, Spill>();
  /** sheetId -> "r:c" -> value written by an array formula. */
  private spillVals = new Map<string, Map<string, { anchor: string; v: Scalar }>>();
  /** Cells whose spilled value changed during the current recalculation. */
  private spillChanged = new Set<string>();

  /** Supplies data for IMPORTRANGE (other workbooks). */
  setImportProvider(fn: EvalContext['importRange']): void {
    this.importFn = fn;
  }

  /** Recalculates IMPORTRANGE formulas, e.g. after their data arrived. */
  refreshExternal(): ValueChange[] {
    if (!this.externalCells.size) return [];
    return this.recalc(this.collectDirty([...this.externalCells]), new Set());
  }

  setClock(fn: () => Date): void {
    this.nowFn = fn;
  }

  // ---------- sheets ----------

  addSheet(id: string, name: string): ValueChange[] {
    if (this.sheets.has(id)) return [];
    this.sheets.set(id, { id, name, cells: new Map(), rows: 0, cols: 0 });
    // Formulas that referenced this name before it existed now resolve.
    return this.hasFormulas() ? this.rebuildGraph() : [];
  }

  renameSheet(id: string, name: string): ValueChange[] {
    const s = this.sheets.get(id);
    if (!s) return [];
    s.name = name;
    return this.rebuildGraph();
  }

  removeSheet(id: string): ValueChange[] {
    if (!this.sheets.delete(id)) return [];
    return this.rebuildGraph();
  }

  private hasFormulas(): boolean {
    return this.deps.size > 0 || [...this.sheets.values()].some((s) => [...s.cells.values()].some((c) => c.parseError));
  }

  /** Re-resolves every dependency (sheet names may have changed) and recalculates. */
  private rebuildGraph(): ValueChange[] {
    for (const [a, sp] of this.spills) {
      if (!this.sheets.has(sp.sheetId)) this.spills.delete(a);
    }
    for (const sid of [...this.spillVals.keys()]) if (!this.sheets.has(sid)) this.spillVals.delete(sid);
    this.dependents.clear();
    this.rangeIndex.clear();
    this.wideRanges.clear();
    this.deps.clear();
    for (const s of this.sheets.values()) {
      for (const [k, rec] of s.cells) if (rec.ast) this.registerDeps(`${s.id}|${k}`, s.id, rec.ast);
    }
    return this.recalcAll();
  }

  sheetIds(): string[] {
    return [...this.sheets.keys()];
  }

  sheetName(id: string): string | undefined {
    return this.sheets.get(id)?.name;
  }

  resolveSheet(name: string): string | null {
    const lower = name.toLowerCase();
    for (const s of this.sheets.values()) if (s.name.toLowerCase() === lower) return s.id;
    return null;
  }

  usedSize(sheetId: string): { rows: number; cols: number } {
    const s = this.sheets.get(sheetId);
    return s ? { rows: s.rows, cols: s.cols } : { rows: 0, cols: 0 };
  }

  // ---------- reads ----------

  getValue(sheetId: string, row: number, col: number): Scalar {
    const key = `${row}:${col}`;
    const rec = this.sheets.get(sheetId)?.cells.get(key);
    if (rec) return rec.value;
    return this.spillVals.get(sheetId)?.get(key)?.v ?? null;
  }

  /** Values written by array formulas on a sheet (cells without their own input). */
  *spillCells(sheetId: string): Generator<{ row: number; col: number; value: Scalar }> {
    const m = this.spillVals.get(sheetId);
    if (!m) return;
    for (const [k, e] of m) {
      const i = k.indexOf(':');
      yield { row: Number(k.slice(0, i)), col: Number(k.slice(i + 1)), value: e.v };
    }
  }

  /** The array-formula area covering a cell, if any (for highlighting in the UI). */
  spillAreaAt(sheetId: string, row: number, col: number): (RangeAddress & { anchorRow: number; anchorCol: number; ok: boolean }) | null {
    for (const [a, sp] of this.spills) {
      if (sp.sheetId !== sheetId || row < sp.r1 || row > sp.r2 || col < sp.c1 || col > sp.c2) continue;
      const { row: ar, col: ac } = splitGk(a);
      return { r1: sp.r1, c1: sp.c1, r2: sp.r2, c2: sp.c2, anchorRow: ar, anchorCol: ac, ok: sp.ok };
    }
    return null;
  }

  getRaw(sheetId: string, row: number, col: number): string {
    return this.sheets.get(sheetId)?.cells.get(`${row}:${col}`)?.raw ?? '';
  }

  isFormula(sheetId: string, row: number, col: number): boolean {
    return !!this.sheets.get(sheetId)?.cells.get(`${row}:${col}`)?.ast;
  }

  /** Iterates non-empty cells of a sheet. */
  *cells(sheetId: string): Generator<{ row: number; col: number; raw: string; value: Scalar }> {
    const s = this.sheets.get(sheetId);
    if (!s) return;
    for (const [k, rec] of s.cells) {
      const i = k.indexOf(':');
      yield { row: Number(k.slice(0, i)), col: Number(k.slice(i + 1)), raw: rec.raw, value: rec.value };
    }
  }

  /**
   * Evaluates a formula as if it lived in (row, col) without storing it.
   * Used for conditional-format rules and data validation.
   */
  evaluateFormula(sheetId: string, row: number, col: number, formula: string): Scalar {
    let ast: Node;
    try {
      ast = parseFormula(formula.startsWith('=') ? formula.slice(1) : formula);
    } catch {
      return err.parse();
    }
    const ctx: EvalContext = {
      sheetId,
      row,
      col,
      getValue: (sid, r, c) => this.getValue(sid, r, c),
      resolveSheet: (name) => this.resolveSheet(name),
      usedSize: (sid) => this.usedSize(sid),
      now: () => this.nowFn(),
      importRange: this.importFn,
    };
    try {
      const out = evaluate(ast, ctx);
      if (out instanceof Grid) return out.rows === 1 && out.cols === 1 ? out.get(0, 0) : err.value();
      return out;
    } catch {
      return err.value();
    }
  }

  // ---------- writes ----------

  /** Loads cells without recalculating each one; call recalcAll() afterwards. */
  load(sheetId: string, cells: { row: number; col: number; raw: string }[]): void {
    for (const c of cells) this.writeRaw(sheetId, c.row, c.col, c.raw);
  }

  /** Applies a batch of edits and returns every value that changed. */
  setCells(changes: CellChange[]): ValueChange[] {
    const touched: string[] = [];
    const anchors = new Set<string>();
    for (const c of changes) {
      if (!this.sheets.has(c.sheetId)) continue;
      this.writeRaw(c.sheetId, c.row, c.col, c.raw);
      const g = gk(c.sheetId, c.row, c.col);
      touched.push(g);
      // Typing into (or clearing) a cell inside an array result re-runs that array.
      for (const [a, sp] of this.spills) {
        if (a !== g && sp.sheetId === c.sheetId && c.row >= sp.r1 && c.row <= sp.r2 && c.col >= sp.c1 && c.col <= sp.c2) anchors.add(a);
      }
    }
    const dirty = this.collectDirty([...touched, ...anchors]);
    return this.recalc(dirty, new Set(touched));
  }

  recalcAll(): ValueChange[] {
    const dirty = new Set<string>();
    for (const s of this.sheets.values()) {
      for (const [k, rec] of s.cells) if (rec.ast || rec.parseError) dirty.add(`${s.id}|${k}`);
    }
    return this.recalc(dirty, new Set());
  }

  /** Recalculates TODAY()/NOW() and everything that depends on them. */
  recalcVolatile(): ValueChange[] {
    const dirty = this.collectDirty([...this.volatileCells]);
    return this.recalc(dirty, new Set());
  }

  private writeRaw(sheetId: string, row: number, col: number, raw: string): void {
    const s = this.sheets.get(sheetId)!;
    const key = `${row}:${col}`;
    const g = gk(sheetId, row, col);
    this.clearDeps(g);
    this.externalCells.delete(g);
    if (this.spills.has(g)) this.diffSpill(sheetId, this.takeSpill(g));
    if (raw === '') {
      s.cells.delete(key);
      return;
    }
    const parsed = parseInput(raw);
    const rec: CellRec = { raw, ast: null, parseError: false, value: null, volatile: false };
    if (parsed.kind === 'formula') {
      try {
        rec.ast = parseFormula(raw.slice(1));
        const fns = collectFunctions(rec.ast);
        rec.volatile = [...fns].some(isVolatile);
        this.registerDeps(g, sheetId, rec.ast);
        if (rec.volatile) this.volatileCells.add(g);
        if (fns.has('IMPORTRANGE')) this.externalCells.add(g);
      } catch {
        rec.parseError = true;
        rec.value = err.parse('Formula tidak dapat dibaca');
      }
    } else {
      rec.value = parsed.value;
    }
    s.cells.set(key, rec);
    if (row + 1 > s.rows) s.rows = row + 1;
    if (col + 1 > s.cols) s.cols = col + 1;
  }

  // ---------- dependency graph ----------

  private registerDeps(g: string, sheetId: string, ast: Node): void {
    const d: Deps = { cells: [], ranges: [], sheetNames: [] };
    const walk = (n: Node) => {
      switch (n.type) {
        case 'ref': {
          const sid = n.sheet === undefined ? sheetId : this.resolveSheet(n.sheet);
          if (sid === null) d.sheetNames.push(n.sheet!);
          else d.cells.push(gk(sid, n.ref.row, n.ref.col));
          break;
        }
        case 'range': {
          const sid = n.sheet === undefined ? sheetId : this.resolveSheet(n.sheet);
          if (sid === null) {
            d.sheetNames.push(n.sheet!);
            break;
          }
          let r: RangeAddress;
          if (n.kind === 'cols') r = { r1: 0, r2: MAX_ROWS - 1, c1: Math.min(n.start.col, n.end.col), c2: Math.max(n.start.col, n.end.col) };
          else if (n.kind === 'rows') r = { c1: 0, c2: MAX_COLS - 1, r1: Math.min(n.start.row, n.end.row), r2: Math.max(n.start.row, n.end.row) };
          else
            r = {
              r1: Math.min(n.start.row, n.end.row),
              r2: Math.max(n.start.row, n.end.row),
              c1: Math.min(n.start.col, n.end.col),
              c2: Math.max(n.start.col, n.end.col),
            };
          d.ranges.push({ sheetId: sid, range: r });
          break;
        }
        case 'func':
          n.args.forEach(walk);
          break;
        case 'unary':
        case 'percent':
          walk(n.arg);
          break;
        case 'binary':
          walk(n.left);
          walk(n.right);
          break;
        case 'paren':
          walk(n.inner);
          break;
      }
    };
    walk(ast);
    this.deps.set(g, d);
    for (const c of d.cells) {
      let set = this.dependents.get(c);
      if (!set) this.dependents.set(c, (set = new Set()));
      set.add(g);
    }
    for (const { sheetId: sid, range } of d.ranges) {
      if (range.c2 - range.c1 + 1 > WIDE) {
        let m = this.wideRanges.get(sid);
        if (!m) this.wideRanges.set(sid, (m = new Map()));
        const list = m.get(g) ?? [];
        list.push(range);
        m.set(g, list);
      } else {
        let byCol = this.rangeIndex.get(sid);
        if (!byCol) this.rangeIndex.set(sid, (byCol = new Map()));
        for (let c = range.c1; c <= range.c2; c++) {
          let m = byCol.get(c);
          if (!m) byCol.set(c, (m = new Map()));
          const list = m.get(g) ?? [];
          list.push(range);
          m.set(g, list);
        }
      }
    }
  }

  private clearDeps(g: string): void {
    this.volatileCells.delete(g);
    const d = this.deps.get(g);
    if (!d) return;
    for (const c of d.cells) this.dependents.get(c)?.delete(g);
    for (const { sheetId: sid, range } of d.ranges) {
      if (range.c2 - range.c1 + 1 > WIDE) this.wideRanges.get(sid)?.delete(g);
      else {
        const byCol = this.rangeIndex.get(sid);
        if (byCol) for (let c = range.c1; c <= range.c2; c++) byCol.get(c)?.delete(g);
      }
    }
    this.deps.delete(g);
  }

  private directDependents(g: string, out: (k: string) => void): void {
    this.dependents.get(g)?.forEach(out);
    const { sheetId, row, col } = splitGk(g);
    const byCol = this.rangeIndex.get(sheetId)?.get(col);
    if (byCol) {
      for (const [dep, ranges] of byCol) if (ranges.some((r) => row >= r.r1 && row <= r.r2)) out(dep);
    }
    const wide = this.wideRanges.get(sheetId);
    if (wide) {
      for (const [dep, ranges] of wide) if (ranges.some((r) => row >= r.r1 && row <= r.r2 && col >= r.c1 && col <= r.c2)) out(dep);
    }
  }

  private collectDirty(start: string[]): Set<string> {
    const dirty = new Set<string>();
    const queue: string[] = [];
    for (const g of start) {
      const { sheetId, row, col } = splitGk(g);
      const rec = this.sheets.get(sheetId)?.cells.get(`${row}:${col}`);
      if (rec && (rec.ast || rec.parseError)) dirty.add(g);
      queue.push(g);
    }
    while (queue.length) {
      const g = queue.pop()!;
      this.directDependents(g, (d) => {
        if (!dirty.has(d)) {
          dirty.add(d);
          queue.push(d);
        }
      });
    }
    return dirty;
  }

  // ---------- recalculation ----------

  private recalc(dirty: Set<string>, directlySet: Set<string>): ValueChange[] {
    const before = new Map<string, Scalar>();
    for (const g of dirty) {
      const { sheetId, row, col } = splitGk(g);
      before.set(g, this.sheets.get(sheetId)?.cells.get(`${row}:${col}`)?.value ?? null);
    }
    const pending = new Set(dirty);
    const visiting = new Set<string>();
    const stack: string[] = [];
    const cycle = new Set<string>();
    const now = this.nowFn();

    const compute = (g: string): void => {
      const { sheetId, row, col } = splitGk(g);
      const rec = this.sheets.get(sheetId)?.cells.get(`${row}:${col}`);
      pending.delete(g);
      if (!rec || !rec.ast) return;
      visiting.add(g);
      stack.push(g);
      const ctx: EvalContext = {
        sheetId,
        row,
        col,
        getValue: (sid, r, c) => {
          const key = gk(sid, r, c);
          if (visiting.has(key)) {
            const idx = stack.indexOf(key);
            for (let i = idx; i < stack.length; i++) cycle.add(stack[i]);
            return err.cycle('Referensi melingkar');
          }
          if (pending.has(key)) compute(key);
          else {
            // A value spilled by an array formula that has not been recalculated yet.
            const sv = this.spillVals.get(sid)?.get(`${r}:${c}`);
            if (sv && pending.has(sv.anchor)) compute(sv.anchor);
          }
          return this.getValue(sid, r, c);
        },
        resolveSheet: (name) => this.resolveSheet(name),
        usedSize: (sid) => this.usedSize(sid),
        now: () => now,
        importRange: this.importFn,
      };
      const prevSpill = this.takeSpill(g);
      let result: Scalar;
      try {
        const out = evaluate(rec.ast, ctx);
        if (out instanceof Grid) {
          result = out.rows === 1 && out.cols === 1 ? out.get(0, 0) : this.applySpill(g, sheetId, row, col, out);
        } else result = out;
        if (result === null) result = 0;
        if (typeof result === 'number' && !Number.isFinite(result)) result = err.num();
      } catch (e) {
        result = e instanceof RangeError ? err.value('Rantai formula terlalu dalam') : err.value(String(e));
      }
      if (cycle.has(g)) {
        result = err.cycle('Referensi melingkar');
        this.takeSpill(g);
      }
      this.diffSpill(sheetId, prevSpill, g);
      rec.value = result;
      stack.pop();
      visiting.delete(g);
    };

    // Evaluate in sheet order so typical top-down chains recurse shallowly.
    const order = [...dirty].sort((a, b) => {
      const x = splitGk(a);
      const y = splitGk(b);
      return x.sheetId < y.sheetId ? -1 : x.sheetId > y.sheetId ? 1 : x.row - y.row || x.col - y.col;
    });
    for (const g of order) if (pending.has(g)) compute(g);
    // Array results that moved or changed: recalculate what reads those cells.
    const spillTouched = new Set<string>();
    for (let pass = 0; pass < 8 && this.spillChanged.size; pass++) {
      const changedCells = [...this.spillChanged];
      this.spillChanged.clear();
      changedCells.forEach((c) => spillTouched.add(c));
      const more = this.collectDirty(changedCells);
      for (const g of more) {
        if (!dirty.has(g)) {
          dirty.add(g);
          const { sheetId, row, col } = splitGk(g);
          before.set(g, this.sheets.get(sheetId)?.cells.get(`${row}:${col}`)?.value ?? null);
        }
        pending.add(g);
      }
      const next = [...more].sort((a, b) => {
        const x = splitGk(a);
        const y = splitGk(b);
        return x.sheetId < y.sheetId ? -1 : x.sheetId > y.sheetId ? 1 : x.row - y.row || x.col - y.col;
      });
      for (const g of next) if (pending.has(g)) compute(g);
    }
    this.spillChanged.clear();
    // Cycle members found late may have been computed before the cycle was known.
    for (const g of cycle) {
      const { sheetId, row, col } = splitGk(g);
      const rec = this.sheets.get(sheetId)?.cells.get(`${row}:${col}`);
      if (rec) rec.value = err.cycle('Referensi melingkar');
    }

    const changes: ValueChange[] = [];
    const seen = new Set<string>();
    const emit = (g: string) => {
      if (seen.has(g)) return;
      seen.add(g);
      const { sheetId, row, col } = splitGk(g);
      changes.push({ sheetId, row, col, value: this.getValue(sheetId, row, col) });
    };
    for (const g of directlySet) emit(g);
    for (const g of spillTouched) emit(g);
    for (const g of dirty) {
      const { sheetId, row, col } = splitGk(g);
      const now2 = this.getValue(sheetId, row, col);
      if (!sameValue(before.get(g) ?? null, now2)) emit(g);
    }
    return changes;
  }

  // ---------- array results (spill) ----------

  /** Removes an anchor's spilled values and returns them for change detection. */
  private takeSpill(anchor: string): Map<string, Scalar> {
    const sp = this.spills.get(anchor);
    const old = new Map<string, Scalar>();
    if (!sp) return old;
    this.spills.delete(anchor);
    const m = this.spillVals.get(sp.sheetId);
    if (m && sp.ok) {
      for (let r = sp.r1; r <= sp.r2; r++)
        for (let c = sp.c1; c <= sp.c2; c++) {
          const k = `${r}:${c}`;
          const e = m.get(k);
          if (e && e.anchor === anchor) {
            old.set(k, e.v);
            m.delete(k);
          }
        }
    }
    return old;
  }

  /** Marks cells whose spilled value differs from before. */
  private diffSpill(sheetId: string, old: Map<string, Scalar>, anchor?: string) {
    const m = this.spillVals.get(sheetId);
    const now = new Map<string, Scalar>();
    const sp = anchor ? this.spills.get(anchor) : undefined;
    if (sp && sp.ok && m) {
      for (let r = sp.r1; r <= sp.r2; r++)
        for (let c = sp.c1; c <= sp.c2; c++) {
          const e = m.get(`${r}:${c}`);
          if (e && e.anchor === anchor) now.set(`${r}:${c}`, e.v);
        }
    }
    for (const [k, v] of old) if (!now.has(k) || !sameValue(now.get(k)!, v)) this.spillChanged.add(`${sheetId}|${k}`);
    for (const [k] of now) if (!old.has(k)) this.spillChanged.add(`${sheetId}|${k}`);
  }

  /** Writes an array result next to its anchor. Returns the anchor's own value. */
  private applySpill(anchor: string, sheetId: string, row: number, col: number, grid: Grid): Scalar {
    if (grid.rows === 0 || grid.cols === 0) return err.na('Tidak ada hasil');
    if (grid.rows * grid.cols > MAX_ARRAY_CELLS) return err.num('Hasil array terlalu besar');
    const area = { sheetId, r1: row, c1: col, r2: row + grid.rows - 1, c2: col + grid.cols - 1, ok: false };
    if (area.r2 >= MAX_ROWS || area.c2 >= MAX_COLS) {
      this.spills.set(anchor, area);
      return err.ref('Hasil array melewati batas sheet');
    }
    const s = this.sheets.get(sheetId)!;
    let m = this.spillVals.get(sheetId);
    if (!m) this.spillVals.set(sheetId, (m = new Map()));
    for (let r = area.r1; r <= area.r2; r++)
      for (let c = area.c1; c <= area.c2; c++) {
        if (r === row && c === col) continue;
        const k = `${r}:${c}`;
        const other = m.get(k);
        if (s.cells.has(k) || (other && other.anchor !== anchor)) {
          this.spills.set(anchor, area);
          return err.ref('Hasil array tidak dapat ditampilkan karena sel tujuan sudah berisi data');
        }
      }
    for (let r = area.r1; r <= area.r2; r++)
      for (let c = area.c1; c <= area.c2; c++) {
        if (r === row && c === col) continue;
        m.set(`${r}:${c}`, { anchor, v: grid.get(r - row, c - col) });
      }
    area.ok = true;
    this.spills.set(anchor, area);
    if (area.r2 + 1 > s.rows) s.rows = area.r2 + 1;
    if (area.c2 + 1 > s.cols) s.cols = area.c2 + 1;
    const first = grid.get(0, 0);
    return first;
  }
}

interface Spill {
  sheetId: string;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  ok: boolean;
}

function sameValue(a: Scalar, b: Scalar): boolean {
  if (a instanceof FormulaError || b instanceof FormulaError) {
    return a instanceof FormulaError && b instanceof FormulaError && a.code === b.code;
  }
  return a === b;
}

export { isError };
