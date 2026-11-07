import {
  CellData,
  CellOp,
  CellStyle,
  ConditionalRule,
  Engine,
  fromStored,
  normalizeStyle,
  ProtectedRangeRecord,
  RuleRecord,
  Scalar,
  SheetMetadata,
  styleKey,
  toStored,
  ValidationRule,
} from '@opensheet/engine';

export interface SheetPayload {
  id: string;
  title: string;
  position: number;
  defaultColumnWidth: number;
  defaultRowHeight: number;
  frozenRows: number;
  frozenColumns: number;
  metadata: SheetMetadata;
  validations: RuleRecord<ValidationRule>[];
  conditionalFormats: RuleRecord<ConditionalRule>[];
  protectedRanges: ProtectedRangeRecord[];
}

export interface SheetState extends SheetPayload {
  styles: Map<string, CellStyle>;
  info: Map<string, { by: string | null; at: string }>;
}

/** Fields of a sheet that undo can restore. */
export interface SheetPatch {
  frozenRows?: number;
  frozenColumns?: number;
  metadata?: Partial<SheetMetadata>;
}

export interface CellSnapshot {
  raw: string;
  style: CellStyle | null;
}

export interface CellWrite {
  sheetId: string;
  row: number;
  col: number;
  raw?: string;
  /** `null` clears the style; `undefined` leaves it unchanged. */
  style?: CellStyle | null;
}

export interface UndoEntry {
  label: string;
  cells: { sheetId: string; row: number; col: number; before: CellSnapshot; after: CellSnapshot }[];
  sheets: { sheetId: string; before: SheetPatch; after: SheetPatch }[];
}

const k = (r: number, c: number) => `${r}:${c}`;

/**
 * Client-side workbook: the formula engine owns raw input and values, this
 * class adds styles, sheet metadata and change notifications. It has no React
 * or network code; the sync layer and commands build on it.
 */
export class WorkbookModel {
  engine = new Engine();
  sheets: SheetState[] = [];
  version = 0;
  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify(): void {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  load(sheets: SheetPayload[], cells: Record<string, CellData[]>): void {
    this.engine = new Engine();
    this.sheets = [];
    for (const s of [...sheets].sort((a, b) => a.position - b.position)) this.addSheetState(s);
    for (const s of this.sheets) {
      const list = cells[s.id] ?? [];
      this.engine.load(
        s.id,
        list.filter((c) => c.raw !== ''),
      );
      for (const c of list) {
        if (c.style) s.styles.set(k(c.row, c.col), c.style);
        if (c.updatedAt) s.info.set(k(c.row, c.col), { by: c.updatedBy ?? null, at: c.updatedAt });
      }
    }
    this.engine.recalcAll();
    this.notify();
  }

  private addSheetState(s: SheetPayload): SheetState {
    const state: SheetState = { ...s, metadata: s.metadata ?? {}, styles: new Map(), info: new Map() };
    this.sheets.push(state);
    this.engine.addSheet(s.id, s.title);
    return state;
  }

  addSheet(s: SheetPayload): void {
    if (this.sheet(s.id)) return this.updateSheet(s);
    this.addSheetState(s);
    this.sheets.sort((a, b) => a.position - b.position);
    this.notify();
  }

  updateSheet(s: SheetPayload): void {
    const cur = this.sheet(s.id);
    if (!cur) return this.addSheet(s);
    const renamed = cur.title !== s.title;
    Object.assign(cur, { ...s, metadata: s.metadata ?? {} });
    if (renamed) this.engine.renameSheet(s.id, s.title);
    this.sheets.sort((a, b) => a.position - b.position);
    this.notify();
  }

  removeSheet(id: string): void {
    this.sheets = this.sheets.filter((s) => s.id !== id);
    this.engine.removeSheet(id);
    this.notify();
  }

  reorder(order: string[]): void {
    for (const s of this.sheets) s.position = order.indexOf(s.id);
    this.sheets.sort((a, b) => a.position - b.position);
    this.notify();
  }

  sheet(id: string): SheetState | undefined {
    return this.sheets.find((s) => s.id === id);
  }

  raw(sheetId: string, row: number, col: number): string {
    return this.engine.getRaw(sheetId, row, col);
  }

  value(sheetId: string, row: number, col: number): Scalar {
    return this.engine.getValue(sheetId, row, col);
  }

  style(sheetId: string, row: number, col: number): CellStyle | null {
    return this.sheet(sheetId)?.styles.get(k(row, col)) ?? null;
  }

  snapshot(sheetId: string, row: number, col: number): CellSnapshot {
    return { raw: this.raw(sheetId, row, col), style: this.style(sheetId, row, col) };
  }

  usedSize(sheetId: string): { rows: number; cols: number } {
    const s = this.sheet(sheetId);
    const used = this.engine.usedSize(sheetId);
    let rows = used.rows;
    let cols = used.cols;
    if (s) {
      for (const key of s.styles.keys()) {
        const [r, c] = key.split(':').map(Number);
        if (r + 1 > rows) rows = r + 1;
        if (c + 1 > cols) cols = c + 1;
      }
    }
    return { rows, cols };
  }

  /** Applies writes locally and returns the ops to send to the server. */
  applyCells(writes: CellWrite[], info?: { by: string | null }): CellOp[] {
    const engineChanges: { sheetId: string; row: number; col: number; raw: string }[] = [];
    for (const w of writes) {
      const s = this.sheet(w.sheetId);
      if (!s) continue;
      if (w.raw !== undefined && w.raw !== this.raw(w.sheetId, w.row, w.col)) engineChanges.push({ sheetId: w.sheetId, row: w.row, col: w.col, raw: w.raw });
      if (w.style !== undefined) {
        const n = normalizeStyle(w.style);
        if (n) s.styles.set(k(w.row, w.col), n);
        else s.styles.delete(k(w.row, w.col));
      }
      if (info) s.info.set(k(w.row, w.col), { by: info.by, at: new Date().toISOString() });
    }
    if (engineChanges.length) this.engine.setCells(engineChanges);
    this.notify();
    return writes
      .filter((w) => this.sheet(w.sheetId))
      .map((w) => {
        const op: CellOp = { sheetId: w.sheetId, row: w.row, col: w.col };
        if (w.raw !== undefined) {
          op.raw = w.raw;
          if (w.raw.startsWith('=')) op.value = toStored(this.value(w.sheetId, w.row, w.col));
        }
        if (w.style !== undefined) op.style = normalizeStyle(w.style);
        return op;
      });
  }

  /** Applies ops that came from the server (another user, or a reload). */
  applyRemote(ops: CellOp[], skip?: (op: CellOp) => boolean): void {
    const writes: CellWrite[] = [];
    for (const op of ops) {
      if (skip?.(op)) continue;
      writes.push({ sheetId: op.sheetId, row: op.row, col: op.col, raw: op.raw ?? '', style: op.style ?? null });
    }
    if (writes.length) this.applyCells(writes);
  }

  patchSheet(sheetId: string, patch: SheetPatch): void {
    const s = this.sheet(sheetId);
    if (!s) return;
    if (patch.frozenRows !== undefined) s.frozenRows = patch.frozenRows;
    if (patch.frozenColumns !== undefined) s.frozenColumns = patch.frozenColumns;
    if (patch.metadata) s.metadata = { ...s.metadata, ...patch.metadata };
    this.notify();
  }

  sheetPatchSnapshot(sheetId: string, patch: SheetPatch): SheetPatch {
    const s = this.sheet(sheetId)!;
    const out: SheetPatch = {};
    if (patch.frozenRows !== undefined) out.frozenRows = s.frozenRows;
    if (patch.frozenColumns !== undefined) out.frozenColumns = s.frozenColumns;
    if (patch.metadata) {
      out.metadata = {};
      for (const key of Object.keys(patch.metadata) as (keyof SheetMetadata)[]) {
        (out.metadata as Record<string, unknown>)[key] = structuredClone(s.metadata[key] ?? defaultMeta(key));
      }
    }
    return out;
  }

  static sameSnapshot(a: CellSnapshot, b: CellSnapshot): boolean {
    return a.raw === b.raw && styleKey(normalizeStyle(a.style)) === styleKey(normalizeStyle(b.style));
  }
}

function defaultMeta(key: keyof SheetMetadata): unknown {
  switch (key) {
    case 'colWidths':
    case 'rowHeights':
      return {};
    case 'hiddenRows':
    case 'hiddenCols':
    case 'merges':
    case 'filterViews':
      return [];
    case 'filter':
    case 'tabColor':
      return null;
    case 'showGridlines':
      return true;
  }
}

export function storedToScalar(v: unknown): Scalar {
  return fromStored(v as never);
}
