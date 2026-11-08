import {
  adjustFormulaForStructure,
  CellOp,
  shiftA1,
  shiftFrozen,
  shiftIndex,
  shiftMetadata,
  type StructureOp,
  CellStyle,
  colToLetters,
  compareValues,
  ConditionalRule,
  formatA1,
  formatRangeA1,
  formatValue,
  FormulaError,
  fromStored,
  isError,
  Merge,
  moveRefsInFormula,
  normalizeStyle,
  parseInput,
  parseRangeA1,
  PresenceUser,
  ProtectedRangeRecord,
  RangeAddress,
  rangeContains,
  rangesIntersect,
  RuleRecord,
  Scalar,
  SheetFilter,
  SheetMetadata,
  translateFormula,
  ValidationRule,
  type FilterCriterion,
} from '@opensheet/engine';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { toast } from 'sonner';
import { api, errorMessage } from '../lib/api';
import { Axis } from './geometry';
import { fontFor, wrapLines } from './render';
import { CellSnapshot, CellWrite, SheetPatch, SheetPayload, UndoEntry, WorkbookModel } from './model';
import { SaveStatus, SyncManager } from './sync';

export type Role = 'owner' | 'manager' | 'editor' | 'commenter' | 'viewer';
export interface Caps {
  view: boolean;
  comment: boolean;
  edit: boolean;
  share: boolean;
  manage: boolean;
  own: boolean;
}

export interface WorkbookInfo {
  id: string;
  title: string;
  color: string;
  revision: number;
  linkAccess: string;
  starred: boolean;
  owner: { id: string; name: string; email: string };
  updatedAt: string;
}

export interface Selection {
  anchor: { row: number; col: number };
  focus: { row: number; col: number };
}

export interface EditState {
  row: number;
  col: number;
  sheetId: string;
  value: string;
  source: 'cell' | 'bar';
  /** True when typing replaced the content (arrow keys then commit, like Sheets). */
  quick: boolean;
}

export interface CommentThread {
  id: string;
  worksheetId: string;
  cellReference: string;
  content: string;
  resolved: boolean;
  createdAt: string;
  user: { id: string; name: string };
  replies: { id: string; content: string; createdAt: string; user: { id: string; name: string } }[];
}

export type DialogName =
  | 'share'
  | 'find'
  | 'formatCells'
  | 'conditional'
  | 'validation'
  | 'protect'
  | 'sort'
  | 'split'
  | 'dedupe'
  | 'link'
  | 'shortcuts'
  | 'functions'
  | 'rename'
  | 'import'
  | 'files'
  | 'filterViews'
  | 'createFilter'
  | 'mobileFormula'
  | 'mobileFormat'
  | 'mobileMenu'
  | null;

export interface EditorState {
  loading: 'loading' | 'ready' | 'error' | 'forbidden';
  loadError?: string;
  workbook: WorkbookInfo | null;
  role: Role;
  can: Caps;
  activeSheetId: string;
  selection: Selection;
  editing: EditState | null;
  status: SaveStatus;
  statusDetail?: string;
  presence: PresenceUser[];
  remoteSelections: Record<string, { userId: string; sheetId?: string; selection?: PresenceUser['selection'] }>;
  panel: 'history' | 'comments' | null;
  dialog: DialogName;
  copyRange: ({ sheetId: string; cut: boolean } & RangeAddress) | null;
  comments: CommentThread[];
  commentDraftCell: string | null;
  users: Record<string, string>;
  version: number;
  showFormulas: boolean;
  /** A filter only this user sees: a saved filter view, or one made with "Hanya untuk saya". */
  tempFilter: { sheetId: string; filter: SheetFilter; name: string; personal?: boolean } | null;
  /** Range being typed in the create-filter dialog, highlighted on the grid. */
  filterPreview: RangeAddress | null;
  /** Numbers a visible formula suggestion would use, highlighted on the grid. */
  suggestPreview: RangeAddress | null;
  canUndo: boolean;
  canRedo: boolean;
  findOpenReplace: boolean;
  extraRows: number;
  extraCols: number;
  lastEditedAt: string | null;
  /** What the last right click landed on, so the context menu can show the right actions. */
  contextKind: 'cell' | 'col' | 'row';
}

const NO_CAPS: Caps = { view: false, comment: false, edit: false, share: false, manage: false, own: false };

interface Clipboard {
  text: string;
  sheetId: string;
  range: RangeAddress;
  cells: CellSnapshot[][];
  cut: boolean;
}

export const DEFAULT_COL_W = 100;
export const DEFAULT_ROW_H = 24;
const BASE_ROWS = 1000;
const BASE_COLS = 26;

export class EditorController {
  readonly store: StoreApi<EditorState>;
  readonly model = new WorkbookModel();
  sync!: SyncManager;
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private clipboard: Clipboard | null = null;
  userId = '';
  userName = '';
  /** Signed-out visitor opening a shared link (read-only). */
  guest = false;
  private axisCache = new Map<string, { version: number; key: string; rows: Axis; cols: Axis }>();
  private filterCache = new Map<string, { version: number; key: string; rows: Set<number> }>();
  private metaTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingMeta = new Map<string, SheetPatch>();

  constructor(readonly workbookId: string) {
    this.store = createStore<EditorState>(() => ({
      loading: 'loading',
      workbook: null,
      role: 'viewer',
      can: NO_CAPS,
      activeSheetId: '',
      selection: { anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } },
      editing: null,
      status: 'saved',
      presence: [],
      remoteSelections: {},
      panel: null,
      dialog: null,
      copyRange: null,
      comments: [],
      commentDraftCell: null,
      users: {},
      version: 0,
      showFormulas: false,
      tempFilter: null,
      filterPreview: null,
      suggestPreview: null,
      canUndo: false,
      canRedo: false,
      findOpenReplace: false,
      extraRows: 0,
      extraCols: 0,
      lastEditedAt: null,
      contextKind: 'cell',
    }));
    this.model.subscribe(() => this.set({ version: this.model.version }));
  }

  get s(): EditorState {
    return this.store.getState();
  }
  set(p: Partial<EditorState>) {
    this.store.setState(p);
  }

  // ---------- loading ----------

  async load(user: { id: string; name: string }): Promise<void> {
    this.userId = user.id;
    this.userName = user.name;
    try {
      const meta = await api.get<{ workbook: WorkbookInfo; role: Role; can: Caps; sheets: SheetPayload[] }>(`/api/workbooks/${this.workbookId}`);
      const cells = await api.get<{ revision: number; sheets: Record<string, never[]>; users: { id: string; name: string }[] }>(`/api/workbooks/${this.workbookId}/cells`);
      this.model.load(meta.sheets, cells.sheets);
      this.installImportProvider();
      const users: Record<string, string> = { [user.id]: user.name };
      for (const u of cells.users) users[u.id] = u.name;
      const hash = new URLSearchParams(window.location.hash.slice(1));
      const wantSheet = hash.get('gid');
      const first = meta.sheets.find((s) => s.id === wantSheet) ?? [...meta.sheets].sort((a, b) => a.position - b.position)[0];
      this.set({
        loading: 'ready',
        workbook: meta.workbook,
        role: meta.role,
        can: meta.can,
        activeSheetId: first.id,
        users,
        lastEditedAt: meta.workbook.updatedAt,
      });
      this.sync = new SyncManager(this.workbookId, () => this.s.activeSheetId, this.syncCallbacks());
      this.sync.revision = cells.revision;
      this.sync.connect();
      this.loadPersonalFilter(first.id);
      void this.loadComments();
      const rangeParam = hash.get('range');
      if (rangeParam) {
        const r = parseRangeA1(rangeParam);
        if (r) this.select({ row: r.r1, col: r.c1 }, { row: r.r2, col: r.c2 });
      }
    } catch (e) {
      const status = (e as { status?: number }).status;
      this.set({ loading: status === 404 || status === 403 ? 'forbidden' : 'error', loadError: errorMessage(e) });
    }
  }

  private importCache = new Map<string, { state: 'pending' | 'ok' | 'error'; data?: Scalar[][]; error?: FormulaError }>();
  private importTimer: ReturnType<typeof setInterval> | null = null;

  /** IMPORTRANGE asks the server, then recalculates when the data arrives (and every 2 minutes). */
  private installImportProvider() {
    const engine = this.model.engine;
    engine.setImportProvider((source, range) => {
      const key = `${source}\u0000${range}`;
      const hit = this.importCache.get(key);
      if (hit?.state === 'ok') return hit.data!;
      if (hit?.state === 'error') return hit.error!;
      if (!hit) {
        this.importCache.set(key, { state: 'pending' });
        const q = new URLSearchParams({ source, range });
        api
          .get<{ values: unknown[][] }>(`/api/workbooks/${this.workbookId}/import-range?${q}`)
          .then((r) => this.importCache.set(key, { state: 'ok', data: r.values.map((row) => row.map((v) => fromStored(v as never))) }))
          .catch((e) => this.importCache.set(key, { state: 'error', error: new FormulaError('#REF!', errorMessage(e)) }))
          .finally(() => {
            this.model.engine.refreshExternal();
            this.model.notify();
          });
      }
      return 'pending';
    });
    engine.refreshExternal();
    this.importTimer = setInterval(() => {
      if (!this.importCache.size) return;
      this.importCache.clear();
      this.model.engine.refreshExternal();
      this.model.notify();
    }, 120_000);
  }

  dispose() {
    if (this.importTimer) clearInterval(this.importTimer);
    this.sync?.dispose();
    for (const t of this.metaTimers.values()) clearTimeout(t);
  }

  /** Reloads cell data from the server, keeping cells that still have unsent local edits. */
  async resync(cells?: { sheetId: string; row: number; col: number }[]) {
    try {
      const data = await api.get<{ revision: number; sheets: Record<string, { row: number; col: number; raw: string; style?: CellStyle | null; updatedBy?: string | null; updatedAt?: string }[]>; users: { id: string; name: string }[] }>(
        `/api/workbooks/${this.workbookId}/cells`,
      );
      const writes: CellWrite[] = [];
      const only = cells ? new Set(cells.map((c) => `${c.sheetId}|${c.row}:${c.col}`)) : null;
      for (const sheet of this.model.sheets) {
        const server = new Map((data.sheets[sheet.id] ?? []).map((c) => [`${c.row}:${c.col}`, c]));
        const keys = new Set<string>([...server.keys(), ...sheet.styles.keys()]);
        for (const c of this.model.engine.cells(sheet.id)) keys.add(`${c.row}:${c.col}`);
        for (const key of keys) {
          const [row, col] = key.split(':').map(Number);
          if (only && !only.has(`${sheet.id}|${key}`)) continue;
          if (!only && this.sync.isPending({ sheetId: sheet.id, row, col })) continue;
          const sv = server.get(key);
          const want: CellSnapshot = { raw: sv?.raw ?? '', style: sv?.style ?? null };
          if (!WorkbookModel.sameSnapshot(want, this.model.snapshot(sheet.id, row, col))) writes.push({ sheetId: sheet.id, row, col, raw: want.raw, style: want.style });
          if (sv?.updatedAt) sheet.info.set(key, { by: sv.updatedBy ?? null, at: sv.updatedAt });
        }
      }
      if (writes.length) this.model.applyCells(writes);
      const users = { ...this.s.users };
      for (const u of data.users) users[u.id] = u.name;
      this.set({ users });
      this.sync.revision = Math.max(this.sync.revision, data.revision);
    } catch (e) {
      toast.error(`Gagal memuat ulang data: ${errorMessage(e)}`);
    }
  }

  private syncCallbacks() {
    return {
      onStatus: (status: SaveStatus, statusDetail?: string) => {
        this.set({ status, statusDetail, ...(status === 'saved' ? { lastEditedAt: new Date().toISOString() } : {}) });
      },
      onRemoteOps: (ops: CellOp[], _rev: number, userId: string) => {
        this.model.applyRemote(ops, (op) => this.sync.isPending(op));
        for (const op of ops) this.model.sheet(op.sheetId)?.info.set(`${op.row}:${op.col}`, { by: userId, at: new Date().toISOString() });
        this.set({ lastEditedAt: new Date().toISOString() });
      },
      onResync: (reason: 'conflict' | 'rejected' | 'gap', cells?: { sheetId: string; row: number; col: number }[], message?: string) => {
        if (reason === 'conflict') toast.warning('Sebagian sel diubah pengguna lain pada saat yang sama. Versi mereka dipertahankan.');
        if (reason === 'rejected') toast.error(`Perubahan tidak tersimpan: ${message ?? 'ditolak server'}`);
        void this.resync(reason === 'gap' ? undefined : cells);
      },
      onPresence: (presence: PresenceUser[]) => {
        const users = { ...this.s.users };
        for (const p of presence) users[p.userId] = p.name;
        const live = new Set(presence.map((p) => p.socketId));
        const remoteSelections = Object.fromEntries(Object.entries(this.s.remoteSelections).filter(([sid]) => live.has(sid)));
        for (const p of presence) if (p.selection && !remoteSelections[p.socketId]) remoteSelections[p.socketId] = { userId: p.userId, sheetId: p.sheetId, selection: p.selection };
        this.set({ presence, users, remoteSelections });
      },
      onSelection: (p: { socketId: string; userId: string; sheetId?: string; selection?: PresenceUser['selection'] }) => {
        this.set({ remoteSelections: { ...this.s.remoteSelections, [p.socketId]: { userId: p.userId, sheetId: p.sheetId, selection: p.selection } } });
      },
      onSheetUpdate: (raw: unknown) => {
        const p = raw as { action: string; sheet?: SheetPayload; sheetId?: string; order?: string[]; cellsChanged?: boolean };
        if (p.action === 'create' && p.sheet) {
          this.model.addSheet(p.sheet);
          if (p.cellsChanged) void this.resync();
        } else if (p.action === 'update' && p.sheet) this.model.updateSheet(p.sheet);
        else if (p.action === 'delete' && p.sheetId) {
          this.model.removeSheet(p.sheetId);
          if (this.s.activeSheetId === p.sheetId) this.setActiveSheet(this.model.sheets[0]?.id);
        } else if (p.action === 'reorder' && p.order) this.model.reorder(p.order);
      },
      onWorkbookUpdate: (raw: unknown) => {
        const p = raw as Partial<WorkbookInfo>;
        if (this.s.workbook) this.set({ workbook: { ...this.s.workbook, ...p } });
      },
      onComment: (raw: unknown) => {
        const p = raw as { comment?: CommentThread; deletedId?: string };
        if (p.deletedId) this.set({ comments: this.s.comments.filter((c) => c.id !== p.deletedId) });
        else if (p.comment) {
          const rest = this.s.comments.filter((c) => c.id !== p.comment!.id);
          this.set({ comments: [...rest, p.comment] });
        }
      },
      onRevision: (p: { revision: number; restored?: boolean; userId?: string }) => {
        if (p.restored) {
          this.undoStack = [];
          this.redoStack = [];
          this.updateUndoFlags();
          void this.resync();
          if (p.userId !== this.userId) toast.message('Workbook dipulihkan ke versi sebelumnya oleh kolaborator.');
        }
      },
      onAccess: (kind: 'revoked' | 'changed', p: { role?: string }) => {
        if (kind === 'revoked') {
          this.set({ loading: 'forbidden', loadError: 'Akses Anda ke workbook ini telah dicabut.' });
          this.sync.dispose();
        } else if (p.role) void this.refreshRole();
      },
    };
  }

  async refreshRole() {
    try {
      const meta = await api.get<{ workbook: WorkbookInfo; role: Role; can: Caps }>(`/api/workbooks/${this.workbookId}`);
      this.set({ role: meta.role, can: meta.can, workbook: { ...meta.workbook } });
      toast.message(`Izin Anda sekarang: ${roleLabel(meta.role)}`);
    } catch {
      /* the revoke path handles lost access */
    }
  }

  async loadComments() {
    try {
      const r = await api.get<{ comments: CommentThread[] }>(`/api/workbooks/${this.workbookId}/comments`);
      this.set({ comments: r.comments });
    } catch {
      /* comments are optional; the panel shows its own error */
    }
  }

  // ---------- geometry ----------

  sheet() {
    return this.model.sheet(this.s.activeSheetId);
  }

  rowCount(): number {
    const used = this.model.usedSize(this.s.activeSheetId);
    return Math.min(1_048_576, Math.max(BASE_ROWS, used.rows + 100) + this.s.extraRows);
  }

  colCount(): number {
    const used = this.model.usedSize(this.s.activeSheetId);
    return Math.min(16_384, Math.max(BASE_COLS, used.cols + 4) + this.s.extraCols);
  }

  axes(): { rows: Axis; cols: Axis } {
    const sheet = this.sheet()!;
    const hiddenFilter = this.filteredRows();
    const rowCount = this.rowCount();
    const colCount = this.colCount();
    const key = `${sheet.id}|${rowCount}|${colCount}|${JSON.stringify(this.activeFilter() ?? null)}`;
    const cached = this.axisCache.get(sheet.id);
    if (cached && cached.version === this.model.version && cached.key === key) return cached;
    const md = sheet.metadata;
    const rowSizes = new Map<number, number>();
    for (const [r, h] of Object.entries(md.rowHeights ?? {})) rowSizes.set(Number(r), h);
    for (const r of md.hiddenRows ?? []) rowSizes.set(r, 0);
    for (const r of hiddenFilter) rowSizes.set(r, 0);
    // Rows without a manual height grow to fit wrapped text and large fonts.
    for (const [r, h] of this.autoRowHeights(sheet.id)) {
      if (md.rowHeights?.[r] !== undefined || rowSizes.get(r) === 0) continue;
      if (h > (sheet.defaultRowHeight || DEFAULT_ROW_H)) rowSizes.set(r, h);
    }
    const colSizes = new Map<number, number>();
    for (const [c, w] of Object.entries(md.colWidths ?? {})) colSizes.set(Number(c), w);
    for (const c of md.hiddenCols ?? []) colSizes.set(c, 0);
    const out = {
      version: this.model.version,
      key,
      rows: new Axis(sheet.defaultRowHeight || DEFAULT_ROW_H, rowCount, rowSizes),
      cols: new Axis(sheet.defaultColumnWidth || DEFAULT_COL_W, colCount, colSizes),
    };
    this.axisCache.set(sheet.id, out);
    return out;
  }

  private measureCtx: CanvasRenderingContext2D | null = null;
  private autoHeightCache = new Map<string, { version: number; heights: Map<number, number> }>();

  /** Heights needed by wrapped or large text, per row. */
  autoRowHeights(sheetId: string): Map<number, number> {
    const cached = this.autoHeightCache.get(sheetId);
    if (cached && cached.version === this.model.version) return cached.heights;
    const heights = new Map<number, number>();
    const sheet = this.model.sheet(sheetId);
    if (sheet && typeof document !== 'undefined') {
      this.measureCtx ??= document.createElement('canvas').getContext('2d');
      const ctx = this.measureCtx;
      const colW = (c: number) => sheet.metadata.colWidths?.[c] ?? sheet.defaultColumnWidth ?? DEFAULT_COL_W;
      for (const [key, style] of sheet.styles) {
        if (!style.wrap && !(style.fontSize && style.fontSize > 11)) continue;
        const [r, c] = key.split(':').map(Number);
        if (this.mergeAtSheet(sheet, r, c)) continue;
        const text = displayText(this.model.value(sheetId, r, c), style);
        if (!text) continue;
        const { font, px } = fontFor(style);
        const lineH = Math.round(px * 1.3);
        let lines = 1;
        if (style.wrap && ctx) {
          ctx.font = font;
          lines = wrapLines(text, colW(c) - 8 - (style.indent ?? 0) * 10, (t) => ctx.measureText(t).width).length;
        }
        const need = Math.min(400, lines * lineH + 8);
        if (need > (heights.get(r) ?? 0)) heights.set(r, need);
      }
    }
    this.autoHeightCache.set(sheetId, { version: this.model.version, heights });
    return heights;
  }

  private mergeAtSheet(sheet: { metadata: SheetMetadata }, row: number, col: number) {
    return (sheet.metadata.merges ?? []).some((m) => row >= m.r1 && row <= m.r2 && col >= m.c1 && col <= m.c2);
  }

  activeFilter(): SheetFilter | null {
    const t = this.s.tempFilter;
    if (t && t.sheetId === this.s.activeSheetId) return t.filter;
    return this.sheet()?.metadata.filter ?? null;
  }

  filteredRows(): Set<number> {
    const sheet = this.sheet();
    const f = this.activeFilter();
    if (!sheet || !f) return new Set();
    const key = JSON.stringify(f);
    const cached = this.filterCache.get(sheet.id);
    if (cached && cached.version === this.model.version && cached.key === key) return cached.rows;
    const rows = new Set<number>();
    const tests = Object.entries(f.criteria ?? {}).map(([c, crit]) => ({ col: Number(c), test: criterionTest(crit) }));
    if (tests.length) {
      for (let r = f.r1 + 1; r <= f.r2; r++) {
        for (const t of tests) {
          const v = this.model.value(sheet.id, r, t.col);
          const style = this.model.style(sheet.id, r, t.col);
          if (!t.test(v, displayText(v, style), style)) {
            rows.add(r);
            break;
          }
        }
      }
    }
    this.filterCache.set(sheet.id, { version: this.model.version, key, rows });
    return rows;
  }

  mergeAt(row: number, col: number): Merge | null {
    const merges = this.sheet()?.metadata.merges;
    if (!merges) return null;
    for (const m of merges) if (row >= m.r1 && row <= m.r2 && col >= m.c1 && col <= m.c2) return m;
    return null;
  }

  // ---------- selection ----------

  selectionRange(): RangeAddress {
    const { anchor, focus } = this.s.selection;
    let r: RangeAddress = {
      r1: Math.min(anchor.row, focus.row),
      c1: Math.min(anchor.col, focus.col),
      r2: Math.max(anchor.row, focus.row),
      c2: Math.max(anchor.col, focus.col),
    };
    // Expand to cover merged cells that the range touches.
    const merges = this.sheet()?.metadata.merges ?? [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const m of merges) {
        if (rangesIntersect(r, m) && (m.r1 < r.r1 || m.c1 < r.c1 || m.r2 > r.r2 || m.c2 > r.c2)) {
          r = { r1: Math.min(r.r1, m.r1), c1: Math.min(r.c1, m.c1), r2: Math.max(r.r2, m.r2), c2: Math.max(r.c2, m.c2) };
          changed = true;
        }
      }
    }
    return r;
  }

  select(anchor: { row: number; col: number }, focus = anchor) {
    const clamp = (p: { row: number; col: number }) => ({ row: Math.max(0, Math.min(1_048_575, p.row)), col: Math.max(0, Math.min(16_383, p.col)) });
    const a = clamp(anchor);
    const f = clamp(focus);
    // Selecting a whole column or row (or everything) must not add rows or columns to the grid.
    const wholeCol = Math.min(a.row, f.row) === 0 && Math.max(a.row, f.row) >= this.rowCount() - 1;
    const wholeRow = Math.min(a.col, f.col) === 0 && Math.max(a.col, f.col) >= this.colCount() - 1;
    const extraRows = wholeCol ? this.s.extraRows : Math.max(this.s.extraRows, Math.max(a.row, f.row) + 50 - Math.max(BASE_ROWS, this.model.usedSize(this.s.activeSheetId).rows + 100));
    const extraCols = wholeRow ? this.s.extraCols : Math.max(this.s.extraCols, Math.max(a.col, f.col) + 5 - Math.max(BASE_COLS, this.model.usedSize(this.s.activeSheetId).cols + 4));
    this.set({ selection: { anchor: a, focus: f }, extraRows: Math.max(0, extraRows), extraCols: Math.max(0, extraCols) });
    const r = this.selectionRange();
    this.sync?.sendSelection(this.s.activeSheetId, r);
  }

  /** Arrow-key movement. `jump` (Ctrl) goes to the edge of the data block. */
  move(dr: number, dc: number, extend: boolean, jump = false) {
    const { rows, cols } = this.axes();
    const sel = this.s.selection;
    const from = extend ? sel.focus : sel.anchor;
    let row = from.row;
    let col = from.col;
    if (jump) {
      [row, col] = this.jumpTarget(row, col, dr, dc, rows.count, cols.count);
    } else {
      // Step out of a merged cell in one move.
      const m = this.mergeAt(row, col);
      if (m && !extend) {
        if (dr > 0) row = m.r2;
        if (dc > 0) col = m.c2;
        if (dr < 0) row = m.r1;
        if (dc < 0) col = m.c1;
      }
      if (dr) row = rows.nextVisible(row, dr > 0 ? 1 : -1);
      if (dc) col = cols.nextVisible(col, dc > 0 ? 1 : -1);
    }
    if (extend) this.select(sel.anchor, { row, col });
    else {
      const m = this.mergeAt(row, col);
      this.select(m ? { row: m.r1, col: m.c1 } : { row, col });
    }
  }

  private jumpTarget(row: number, col: number, dr: number, dc: number, maxR: number, maxC: number): [number, number] {
    const sid = this.s.activeSheetId;
    const filled = (r: number, c: number) => this.model.raw(sid, r, c) !== '';
    const step = (r: number, c: number) => [r + dr, c + dc] as [number, number];
    const inside = (r: number, c: number) => r >= 0 && c >= 0 && r < maxR && c < maxC;
    let [r, c] = step(row, col);
    if (!inside(r, c)) return [row, col];
    if (filled(row, col) && filled(r, c)) {
      // Run to the last filled cell of this block.
      while (inside(...step(r, c)) && filled(...step(r, c))) [r, c] = step(r, c);
      return [r, c];
    }
    // Run to the next filled cell, or the edge.
    while (inside(r, c) && !filled(r, c)) {
      const n = step(r, c);
      if (!inside(...n)) return [r, c];
      [r, c] = n;
    }
    return [r, c];
  }

  setActiveSheet(id: string | undefined) {
    if (!id || !this.model.sheet(id)) return;
    if (this.s.editing) this.commitEdit('none');
    this.loadPersonalFilter(id);
    this.set({ activeSheetId: id, selection: { anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } }, copyRange: null, extraRows: 0, extraCols: 0 });
    history.replaceState(null, '', `#gid=${id}`);
  }

  // ---------- permissions ----------

  protectedReason(sheetId: string, row: number, col: number): string | null {
    if (this.s.can.manage) return null;
    const sheet = this.model.sheet(sheetId);
    for (const p of sheet?.protectedRanges ?? []) {
      if (p.editorIds.includes(this.userId)) continue;
      if (!p.range) return 'Sheet ini dilindungi.';
      const r = parseRangeA1(p.range);
      if (r && rangeContains(r, row, col)) return `Rentang ${p.range} dilindungi.`;
    }
    return null;
  }

  canEditCells(writes: { sheetId: string; row: number; col: number }[], quiet = false): boolean {
    if (!this.s.can.edit) {
      if (!quiet) toast.message('Anda hanya dapat melihat workbook ini.');
      return false;
    }
    for (const w of writes) {
      const reason = this.protectedReason(w.sheetId, w.row, w.col);
      if (reason) {
        if (!quiet) toast.error(reason);
        return false;
      }
    }
    return true;
  }

  // ---------- cell writes with undo ----------

  write(writes: CellWrite[], label: string, sheetPatches: { sheetId: string; patch: SheetPatch }[] = []): boolean {
    const real = writes.filter((w) => {
      const cur = this.model.snapshot(w.sheetId, w.row, w.col);
      const next: CellSnapshot = { raw: w.raw ?? cur.raw, style: w.style !== undefined ? w.style : cur.style };
      return !WorkbookModel.sameSnapshot(cur, next);
    });
    if (!real.length && !sheetPatches.length) return false;
    if (real.length && !this.canEditCells(real)) return false;
    if (sheetPatches.length && !this.s.can.edit) return false;
    const entry: UndoEntry = { label, cells: [], sheets: [] };
    for (const w of real) {
      const before = this.model.snapshot(w.sheetId, w.row, w.col);
      const after: CellSnapshot = { raw: w.raw ?? before.raw, style: w.style !== undefined ? normalizeStyle(w.style) : before.style };
      entry.cells.push({ sheetId: w.sheetId, row: w.row, col: w.col, before, after });
    }
    for (const sp of sheetPatches) entry.sheets.push({ sheetId: sp.sheetId, before: this.model.sheetPatchSnapshot(sp.sheetId, sp.patch), after: sp.patch });
    this.applyEntry(entry, 'after');
    this.undoStack.push(entry);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.updateUndoFlags();
    return true;
  }

  private applyEntry(entry: UndoEntry, side: 'before' | 'after') {
    if (entry.cells.length) {
      const ops = this.model.applyCells(
        entry.cells.map((c) => ({ sheetId: c.sheetId, row: c.row, col: c.col, raw: c[side].raw, style: c[side].style })),
        { by: this.userId },
      );
      this.sync.queue(ops);
    }
    for (const sp of entry.sheets) this.patchSheetNow(sp.sheetId, sp[side]);
  }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return;
    if (e.structure) {
      void this.undoStructure(e.structure).then((ok) => {
        if (ok) this.redoStack.push(e);
        else this.undoStack.push(e);
        this.updateUndoFlags();
      });
      return;
    }
    if (!this.canEditCells(e.cells)) {
      this.undoStack.push(e);
      return;
    }
    this.applyEntry(e, 'before');
    this.redoStack.push(e);
    this.updateUndoFlags();
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return;
    if (e.structure) {
      const { sheetId, op } = e.structure;
      if (this.s.activeSheetId !== sheetId) this.setActiveSheet(sheetId);
      void this.structural(op.axis, op.index, op.count, true).then((ok) => {
        if (ok) this.undoStack.push(e);
        else this.redoStack.push(e);
        this.updateUndoFlags();
      });
      return;
    }
    if (!this.canEditCells(e.cells)) {
      this.redoStack.push(e);
      return;
    }
    this.applyEntry(e, 'after');
    this.undoStack.push(e);
    this.updateUndoFlags();
  }

  private updateUndoFlags() {
    this.set({ canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 });
  }

  /** Applies a sheet patch locally and persists it (debounced per sheet). */
  private patchSheetNow(sheetId: string, patch: SheetPatch) {
    this.model.patchSheet(sheetId, patch);
    const prev = this.pendingMeta.get(sheetId) ?? {};
    this.pendingMeta.set(sheetId, { ...prev, ...patch, metadata: { ...(prev.metadata ?? {}), ...(patch.metadata ?? {}) } });
    const t = this.metaTimers.get(sheetId);
    if (t) clearTimeout(t);
    this.metaTimers.set(
      sheetId,
      setTimeout(async () => {
        const p = this.pendingMeta.get(sheetId);
        this.pendingMeta.delete(sheetId);
        if (!p) return;
        try {
          const body: Record<string, unknown> = {};
          if (p.frozenRows !== undefined) body.frozenRows = p.frozenRows;
          if (p.frozenColumns !== undefined) body.frozenColumns = p.frozenColumns;
          if (p.metadata && Object.keys(p.metadata).length) body.metadata = p.metadata;
          await api.patch(`/api/worksheets/${sheetId}`, body);
        } catch (e) {
          toast.error(`Pengaturan sheet tidak tersimpan: ${errorMessage(e)}`);
        }
      }, 400),
    );
  }

  patchSheet(sheetId: string, patch: SheetPatch, label: string) {
    if (!this.s.can.edit) return void toast.message('Anda hanya dapat melihat workbook ini.');
    this.write([], label, [{ sheetId, patch }]);
  }

  // ---------- editing ----------

  startEdit(initial?: string, source: 'cell' | 'bar' = 'cell') {
    const { anchor } = this.s.selection;
    const m = this.mergeAt(anchor.row, anchor.col);
    const row = m ? m.r1 : anchor.row;
    const col = m ? m.c1 : anchor.col;
    const sheetId = this.s.activeSheetId;
    if (!this.canEditCells([{ sheetId, row, col }])) return;
    const v = this.validationAt(sheetId, row, col);
    if (v?.kind === 'checkbox' && initial === undefined) {
      this.toggleCheckbox(row, col);
      return;
    }
    this.set({
      editing: { row, col, sheetId, value: initial ?? this.model.raw(sheetId, row, col), source, quick: initial !== undefined },
      copyRange: this.s.copyRange,
    });
  }

  updateEdit(value: string, source?: 'cell' | 'bar') {
    const e = this.s.editing;
    if (!e) return;
    this.set({ editing: { ...e, value, source: source ?? e.source } });
  }

  cancelEdit() {
    this.set({ editing: null });
  }

  /** Commits the editor and moves. Returns false when validation rejected the value. */
  commitEdit(move: 'down' | 'up' | 'right' | 'left' | 'none'): boolean {
    const e = this.s.editing;
    if (!e) return true;
    let value = e.value;
    // Auto-close parentheses in formulas, like other spreadsheets do.
    if (value.startsWith('=')) {
      const open = (value.match(/\(/g) || []).length - (value.match(/\)/g) || []).length;
      if (open > 0 && open < 10) value += ')'.repeat(open);
    }
    const problem = this.validateInput(e.sheetId, e.row, e.col, value);
    if (problem) {
      toast.error(problem);
      return false;
    }
    const writes: CellWrite[] = [{ sheetId: e.sheetId, row: e.row, col: e.col, raw: value }];
    // Typing a date, percent or currency sets a matching format when none is set.
    const parsed = parseInput(value);
    const style = this.model.style(e.sheetId, e.row, e.col);
    if (parsed.formatHint && !style?.numberFormat) writes[0].style = { ...(style ?? {}), numberFormat: parsed.formatHint };
    this.set({ editing: null });
    this.write(writes, 'Edit sel');
    const dirs = { down: [1, 0], up: [-1, 0], right: [0, 1], left: [0, -1], none: [0, 0] } as const;
    const [dr, dc] = dirs[move];
    if (dr || dc) this.move(dr, dc, false);
    return true;
  }

  validationAt(sheetId: string, row: number, col: number): ValidationRule | null {
    const sheet = this.model.sheet(sheetId);
    for (const v of sheet?.validations ?? []) {
      const r = parseRangeA1(v.range);
      if (r && rangeContains(r, row, col)) return v.rule;
    }
    return null;
  }

  validateInput(sheetId: string, row: number, col: number, raw: string): string | null {
    const rule = this.validationAt(sheetId, row, col);
    if (!rule || raw === '' || raw.startsWith('=')) return null;
    const bad = validationProblem(rule, raw);
    if (bad && 'strict' in rule && rule.strict) return bad;
    return null;
  }

  isInvalid(sheetId: string, row: number, col: number): boolean {
    const rule = this.validationAt(sheetId, row, col);
    if (!rule) return false;
    const raw = this.model.raw(sheetId, row, col);
    if (raw === '' || raw.startsWith('=')) return false;
    return validationProblem(rule, raw) !== null;
  }

  toggleCheckbox(row: number, col: number) {
    const sid = this.s.activeSheetId;
    const v = this.model.value(sid, row, col);
    this.write([{ sheetId: sid, row, col, raw: v === true ? 'FALSE' : 'TRUE' }], 'Kotak centang');
  }

  setCellValue(row: number, col: number, raw: string) {
    this.write([{ sheetId: this.s.activeSheetId, row, col, raw }], 'Pilih dari daftar');
  }

  // ---------- range helpers ----------

  forEachInRange(r: RangeAddress, fn: (row: number, col: number) => void) {
    for (let row = r.r1; row <= r.r2; row++) for (let col = r.c1; col <= r.c2; col++) fn(row, col);
  }

  /** Limits whole-row/column selections to the used area so we never touch millions of cells. */
  clampToUsed(r: RangeAddress): RangeAddress {
    const used = this.model.usedSize(this.s.activeSheetId);
    return { r1: r.r1, c1: r.c1, r2: Math.min(r.r2, Math.max(r.r1, used.rows - 1)), c2: Math.min(r.c2, Math.max(r.c1, used.cols - 1)) };
  }

  clearContents(range = this.selectionRange()) {
    const r = this.clampToUsed(range);
    const sid = this.s.activeSheetId;
    const writes: CellWrite[] = [];
    this.forEachInRange(r, (row, col) => {
      if (this.model.raw(sid, row, col) !== '') writes.push({ sheetId: sid, row, col, raw: '' });
    });
    this.write(writes, 'Hapus isi');
  }

  clearFormatting(range = this.selectionRange()) {
    const r = this.clampToUsed(range);
    const sid = this.s.activeSheetId;
    const writes: CellWrite[] = [];
    this.forEachInRange(r, (row, col) => {
      if (this.model.style(sid, row, col)) writes.push({ sheetId: sid, row, col, style: null });
    });
    this.write(writes, 'Hapus format');
  }

  // ---------- formatting ----------

  activeStyle(): CellStyle {
    const { anchor } = this.s.selection;
    return this.model.style(this.s.activeSheetId, anchor.row, anchor.col) ?? {};
  }

  applyStyle(patch: Partial<CellStyle> | ((s: CellStyle) => CellStyle), label = 'Format') {
    const r = this.clampToUsedForStyle(this.selectionRange());
    const sid = this.s.activeSheetId;
    const writes: CellWrite[] = [];
    this.forEachInRange(r, (row, col) => {
      const cur = this.model.style(sid, row, col) ?? {};
      const next = typeof patch === 'function' ? patch(cur) : { ...cur, ...patch };
      writes.push({ sheetId: sid, row, col, style: next });
    });
    this.write(writes, label);
  }

  private clampToUsedForStyle(r: RangeAddress): RangeAddress {
    // Formatting a whole column formats the used rows plus a margin.
    const MAX = 5000;
    return { r1: r.r1, c1: r.c1, r2: Math.min(r.r2, r.r1 + MAX), c2: Math.min(r.c2, r.c1 + 200) };
  }

  toggleStyle(key: 'bold' | 'italic' | 'underline' | 'strike' | 'wrap') {
    const on = !this.activeStyle()[key];
    this.applyStyle({ [key]: on }, 'Format');
  }

  setBorders(kind: 'all' | 'outer' | 'inner' | 'top' | 'bottom' | 'left' | 'right' | 'none', color = '#1A1E1C', style: 'thin' | 'medium' | 'thick' | 'dashed' | 'dotted' | 'double' = 'thin') {
    const r = this.clampToUsedForStyle(this.selectionRange());
    const sid = this.s.activeSheetId;
    const side = { style, color };
    const writes: CellWrite[] = [];
    this.forEachInRange(r, (row, col) => {
      const cur = this.model.style(sid, row, col) ?? {};
      const b = { ...(cur.borders ?? {}) };
      const top = row === r.r1;
      const bottom = row === r.r2;
      const left = col === r.c1;
      const right = col === r.c2;
      if (kind === 'none') {
        writes.push({ sheetId: sid, row, col, style: { ...cur, borders: undefined } });
        return;
      }
      if (kind === 'all') Object.assign(b, { top: side, bottom: side, left: side, right: side });
      if (kind === 'outer') {
        if (top) b.top = side;
        if (bottom) b.bottom = side;
        if (left) b.left = side;
        if (right) b.right = side;
      }
      if (kind === 'inner') {
        if (!bottom) b.bottom = side;
        if (!right) b.right = side;
      }
      if (kind === 'top' && top) b.top = side;
      if (kind === 'bottom' && bottom) b.bottom = side;
      if (kind === 'left' && left) b.left = side;
      if (kind === 'right' && right) b.right = side;
      writes.push({ sheetId: sid, row, col, style: { ...cur, borders: b } });
    });
    this.write(writes, 'Batas');
  }

  changeDecimals(delta: 1 | -1) {
    const { anchor } = this.s.selection;
    const v = this.model.value(this.s.activeSheetId, anchor.row, anchor.col);
    const cur = this.activeStyle().numberFormat;
    const pattern = cur && !['auto'].includes(cur) ? cur : typeof v === 'number' && !Number.isInteger(v) ? '0.' + '0'.repeat(Math.min(10, String(v).split('.')[1]?.length ?? 2)) : '0';
    const named: Record<string, string> = { number: '#,##0.00', integer: '#,##0', currency: '"Rp"#,##0', currency2: '"Rp"#,##0.00', percent: '0.00%' };
    const base = named[pattern] ?? pattern;
    const m = /0(\.0*)?/.exec(base.replace(/"[^"]*"/g, (x) => x.replace(/0/g, 'O')));
    if (!m) return;
    const decimals = m[1] ? m[1].length - 1 : 0;
    const nd = Math.max(0, Math.min(10, decimals + delta));
    const replaced = base.replace(/0(\.0*)?/, nd ? '0.' + '0'.repeat(nd) : '0');
    this.applyStyle({ numberFormat: replaced }, 'Format angka');
  }

  // ---------- clipboard ----------

  copy(cut: boolean): string {
    const sid = this.s.activeSheetId;
    const r = this.clampToUsed(this.selectionRange());
    const cells: CellSnapshot[][] = [];
    const lines: string[] = [];
    for (let row = r.r1; row <= r.r2; row++) {
      const line: string[] = [];
      const rowCells: CellSnapshot[] = [];
      for (let col = r.c1; col <= r.c2; col++) {
        rowCells.push(this.model.snapshot(sid, row, col));
        const v = this.model.value(sid, row, col);
        const t = displayText(v, this.model.style(sid, row, col));
        line.push(/[\t\n"]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
      }
      cells.push(rowCells);
      lines.push(line.join('\t'));
    }
    const text = lines.join('\n');
    this.clipboard = { text, sheetId: sid, range: r, cells, cut };
    this.set({ copyRange: { sheetId: sid, cut, ...r } });
    return text;
  }

  copyHtml(): string {
    if (!this.clipboard) return '';
    const sid = this.clipboard.sheetId;
    const r = this.clipboard.range;
    let html = '<table>';
    for (let row = r.r1; row <= r.r2; row++) {
      html += '<tr>';
      for (let col = r.c1; col <= r.c2; col++) {
        const t = displayText(this.model.value(sid, row, col), this.model.style(sid, row, col));
        html += `<td>${t.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</td>`;
      }
      html += '</tr>';
    }
    return html + '</table>';
  }

  paste(text: string | null, opts: { valuesOnly?: boolean; formatOnly?: boolean } = {}) {
    const sid = this.s.activeSheetId;
    const sel = this.selectionRange();
    const dest = { row: sel.r1, col: sel.c1 };
    const clip = this.clipboard;
    const internal = clip && (text === null || normalizeEol(text) === normalizeEol(clip.text));
    const writes: CellWrite[] = [];
    if (internal && clip) {
      const h = clip.cells.length;
      const w = clip.cells[0]?.length ?? 0;
      // Tile the copied block over a larger selection, like Sheets.
      const tilesR = sel.r2 - sel.r1 + 1 > h && (sel.r2 - sel.r1 + 1) % h === 0 ? (sel.r2 - sel.r1 + 1) / h : 1;
      const tilesC = sel.c2 - sel.c1 + 1 > w && (sel.c2 - sel.c1 + 1) % w === 0 ? (sel.c2 - sel.c1 + 1) / w : 1;
      const srcSheet = this.model.sheet(clip.sheetId);
      const dstSheet = this.sheet()!;
      for (let tr = 0; tr < tilesR; tr++)
        for (let tc = 0; tc < tilesC; tc++)
          for (let i = 0; i < h; i++)
            for (let j = 0; j < w; j++) {
              const src = clip.cells[i][j];
              const row = dest.row + tr * h + i;
              const col = dest.col + tc * w + j;
              const dr = row - (clip.range.r1 + i);
              const dc = col - (clip.range.c1 + j);
              let raw = src.raw;
              if (raw.startsWith('=') && !clip.cut) raw = translateFormula(raw, dr, dc);
              if (opts.valuesOnly) {
                const v = this.model.value(clip.sheetId, clip.range.r1 + i, clip.range.c1 + j);
                raw = v === null ? '' : isError(v) ? v.code : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : typeof v === 'string' && parseInput(v).kind !== 'string' ? `'${v}` : String(v);
                writes.push({ sheetId: sid, row, col, raw });
              } else if (opts.formatOnly) writes.push({ sheetId: sid, row, col, style: src.style });
              else writes.push({ sheetId: sid, row, col, raw, style: src.style });
            }
      if (clip.cut && !opts.formatOnly) {
        const dr = dest.row - clip.range.r1;
        const dc = dest.col - clip.range.c1;
        const target = { r1: dest.row, c1: dest.col, r2: dest.row + h - 1, c2: dest.col + w - 1 };
        // Clear the source cells that are not overwritten.
        for (let row = clip.range.r1; row <= clip.range.r2; row++)
          for (let col = clip.range.c1; col <= clip.range.c2; col++)
            if (clip.sheetId !== sid || !rangeContains(target, row, col)) writes.push({ sheetId: clip.sheetId, row, col, raw: '', style: null });
        // References to the moved block follow it (same sheet only).
        if (clip.sheetId === sid) {
          for (const s of this.model.sheets) {
            for (const c of this.model.engine.cells(s.id)) {
              if (!c.raw.startsWith('=')) continue;
              if (s.id === sid && rangeContains(target, c.row, c.col)) continue;
              const next = moveRefsInFormula(c.raw, s.title, dstSheet.title, clip.range, dr, dc);
              if (next !== c.raw) writes.push({ sheetId: s.id, row: c.row, col: c.col, raw: next });
            }
          }
        }
        void srcSheet;
        this.clipboard = null;
        this.set({ copyRange: null });
      }
      if (this.write(writes, clip.cut ? 'Potong dan tempel' : 'Tempel')) {
        this.select({ row: dest.row, col: dest.col }, { row: dest.row + h * tilesR - 1, col: dest.col + w * tilesC - 1 });
      }
      return;
    }
    if (text === null) return;
    const rows = parseTsv(text);
    rows.forEach((line, i) =>
      line.forEach((v, j) => {
        writes.push({ sheetId: sid, row: dest.row + i, col: dest.col + j, raw: v });
      }),
    );
    if (this.write(writes, 'Tempel')) {
      const maxW = Math.max(...rows.map((r) => r.length));
      this.select({ row: dest.row, col: dest.col }, { row: dest.row + rows.length - 1, col: dest.col + maxW - 1 });
    }
  }

  clearCopy() {
    this.set({ copyRange: null });
  }

  // ---------- fill handle ----------

  fill(src: RangeAddress, dst: RangeAddress) {
    const sid = this.s.activeSheetId;
    const writes: CellWrite[] = [];
    const vertical = dst.c1 === src.c1 && dst.c2 === src.c2;
    if (vertical) {
      const h = src.r2 - src.r1 + 1;
      for (let col = src.c1; col <= src.c2; col++) {
        const series = numericSeries([...Array(h)].map((_, i) => this.model.raw(sid, src.r1 + i, col)));
        const down = dst.r2 > src.r2;
        const rowsToFill = down ? range(src.r2 + 1, dst.r2) : range(dst.r1, src.r1 - 1).reverse();
        rowsToFill.forEach((row, n) => {
          const k = n + 1;
          const srcRow = down ? src.r1 + ((row - src.r1) % h) : src.r2 - ((src.r2 - row) % h);
          const snap = this.model.snapshot(sid, srcRow, col);
          let raw = snap.raw;
          if (series) raw = String(roundFloat(down ? series.last + series.step * k : series.first - series.step * k));
          else if (raw.startsWith('=')) raw = translateFormula(raw, row - srcRow, 0);
          writes.push({ sheetId: sid, row, col, raw, style: snap.style });
        });
      }
    } else {
      const w = src.c2 - src.c1 + 1;
      for (let row = src.r1; row <= src.r2; row++) {
        const series = numericSeries([...Array(w)].map((_, i) => this.model.raw(sid, row, src.c1 + i)));
        const right = dst.c2 > src.c2;
        const colsToFill = right ? range(src.c2 + 1, dst.c2) : range(dst.c1, src.c1 - 1).reverse();
        colsToFill.forEach((col, n) => {
          const k = n + 1;
          const srcCol = right ? src.c1 + ((col - src.c1) % w) : src.c2 - ((src.c2 - col) % w);
          const snap = this.model.snapshot(sid, row, srcCol);
          let raw = snap.raw;
          if (series) raw = String(roundFloat(right ? series.last + series.step * k : series.first - series.step * k));
          else if (raw.startsWith('=')) raw = translateFormula(raw, 0, col - srcCol);
          writes.push({ sheetId: sid, row, col, raw, style: snap.style });
        });
      }
    }
    if (this.write(writes, 'Isi otomatis')) {
      this.select({ row: Math.min(src.r1, dst.r1), col: Math.min(src.c1, dst.c1) }, { row: Math.max(src.r2, dst.r2), col: Math.max(src.c2, dst.c2) });
    }
  }

  // ---------- rows & columns ----------

  /**
   * Inserts (count > 0) or deletes (count < 0) rows/columns on the active sheet.
   * The model updates immediately; the server applies the same shift with SQL
   * and rewrites formulas, so the size of the sheet does not matter.
   */
  async structural(axis: 'row' | 'col', index: number, count: number, fromHistory = false): Promise<boolean> {
    if (!this.s.can.edit) {
      toast.message('Anda hanya dapat melihat workbook ini.');
      return false;
    }
    if (count === 0) return false;
    const sheet = this.sheet()!;
    const sid = sheet.id;
    const op: StructureOp = { axis, index, count };
    await this.sync.flushNow();
    // Remember what a delete removes, and every formula as it was, for undo.
    const removed: { row: number; col: number; snap: CellSnapshot }[] = [];
    const formulas: { sheetId: string; row: number; col: number; raw: string }[] = [];
    const inDeleted = (r: number, c: number) => count < 0 && (axis === 'row' ? r : c) >= index && (axis === 'row' ? r : c) < index - count;
    const keys = new Set<string>(sheet.styles.keys());
    for (const c of this.model.engine.cells(sid)) keys.add(`${c.row}:${c.col}`);
    for (const key of keys) {
      const [r, c] = key.split(':').map(Number);
      if (inDeleted(r, c)) removed.push({ row: r, col: c, snap: this.model.snapshot(sid, r, c) });
    }
    for (const s of this.model.sheets) for (const c of this.model.engine.cells(s.id)) if (c.raw.startsWith('=')) formulas.push({ sheetId: s.id, row: c.row, col: c.col, raw: c.raw });

    this.applyStructureLocal(sid, op);
    try {
      const r = await api.post<{ revision: number; sheet: SheetPayload }>(`/api/worksheets/${sid}/structure`, { ...op, clientId: this.sync.clientId });
      this.sync.revision = Math.max(this.sync.revision, r.revision);
      this.model.updateSheet(r.sheet);
    } catch (e) {
      toast.error(`Gagal mengubah baris/kolom: ${errorMessage(e)}`);
      const meta = await api.get<{ sheets: SheetPayload[] }>(`/api/workbooks/${this.workbookId}`).catch(() => null);
      meta?.sheets.forEach((sh) => this.model.updateSheet(sh));
      await this.resync();
      return false;
    }
    if (!fromHistory) {
      const what = axis === 'row' ? 'baris' : 'kolom';
      this.undoStack.push({
        label: count > 0 ? `Sisipkan ${count} ${what}` : `Hapus ${-count} ${what}`,
        cells: [],
        sheets: [],
        structure: { sheetId: sid, op, removed, formulas },
      });
      this.redoStack = [];
      this.updateUndoFlags();
    }
    return true;
  }

  /** Applies a row/column shift to the local model only (the server does its own). */
  private applyStructureLocal(sid: string, op: StructureOp) {
    const sheet = this.model.sheet(sid)!;
    const writes: CellWrite[] = [];
    const newRaw = new Map<string, string>();
    for (const s of this.model.sheets) {
      for (const c of this.model.engine.cells(s.id)) {
        if (!c.raw.startsWith('=')) continue;
        const next = adjustFormulaForStructure(c.raw, s.title, { sheetName: sheet.title, ...op });
        if (next === c.raw) continue;
        if (s.id === sid) newRaw.set(`${c.row}:${c.col}`, next);
        else writes.push({ sheetId: s.id, row: c.row, col: c.col, raw: next });
      }
    }
    const keys = new Set<string>(sheet.styles.keys());
    for (const c of this.model.engine.cells(sid)) keys.add(`${c.row}:${c.col}`);
    const target = new Map<string, CellSnapshot>();
    for (const key of keys) {
      const [r, c] = key.split(':').map(Number);
      const snap = this.model.snapshot(sid, r, c);
      const nr = op.axis === 'row' ? shiftIndex(r, op) : r;
      const nc = op.axis === 'col' ? shiftIndex(c, op) : c;
      if (nr === null || nc === null) continue;
      target.set(`${nr}:${nc}`, { raw: newRaw.get(key) ?? snap.raw, style: snap.style });
    }
    for (const key of new Set([...keys, ...target.keys()])) {
      const [r, c] = key.split(':').map(Number);
      const want = target.get(key) ?? { raw: '', style: null };
      writes.push({ sheetId: sid, row: r, col: c, raw: want.raw, style: want.style });
    }
    this.model.applyCells(writes, { by: this.userId });
    this.model.patchSheet(sid, {
      metadata: shiftMetadata(sheet.metadata, op),
      frozenRows: op.axis === 'row' ? shiftFrozen(sheet.frozenRows, op) : undefined,
      frozenColumns: op.axis === 'col' ? shiftFrozen(sheet.frozenColumns, op) : undefined,
    });
    const remap = <T extends { range: string | null }>(items: T[]) =>
      items
        .map((it) => {
          const r = shiftA1(it.range, op);
          return r === undefined ? null : { ...it, range: r };
        })
        .filter((x): x is T => !!x);
    sheet.validations = remap(sheet.validations);
    sheet.conditionalFormats = remap(sheet.conditionalFormats);
    sheet.protectedRanges = remap(sheet.protectedRanges);
    this.model.notify();
  }

  /** Undo of a row/column change: the inverse shift, then the old contents and formulas. */
  private async undoStructure(e: NonNullable<UndoEntry['structure']>) {
    const { sheetId, op } = e;
    if (this.s.activeSheetId !== sheetId) this.setActiveSheet(sheetId);
    const ok = await this.structural(op.axis, op.index, -op.count, true);
    if (!ok) return false;
    const writes: CellWrite[] = [];
    for (const r of e.removed) writes.push({ sheetId, row: r.row, col: r.col, raw: r.snap.raw, style: r.snap.style });
    for (const f of e.formulas) if (this.model.raw(f.sheetId, f.row, f.col) !== f.raw) writes.push({ ...f });
    if (writes.length) this.sync.queue(this.model.applyCells(writes, { by: this.userId }));
    return true;
  }

  insertRows(where: 'above' | 'below') {
    const r = this.selectionRange();
    const n = r.r2 - r.r1 + 1;
    this.structural('row', where === 'above' ? r.r1 : r.r2 + 1, Math.min(n, 1000));
  }
  insertCols(where: 'left' | 'right') {
    const r = this.selectionRange();
    const n = r.c2 - r.c1 + 1;
    this.structural('col', where === 'left' ? r.c1 : r.c2 + 1, Math.min(n, 100));
  }
  deleteRows() {
    const r = this.selectionRange();
    this.structural('row', r.r1, -(Math.min(r.r2, this.rowCount() - 1) - r.r1 + 1));
    this.select({ row: r.r1, col: this.s.selection.anchor.col });
  }
  deleteCols() {
    const r = this.selectionRange();
    this.structural('col', r.c1, -(Math.min(r.c2, this.colCount() - 1) - r.c1 + 1));
    this.select({ row: this.s.selection.anchor.row, col: r.c1 });
  }

  setHidden(axis: 'row' | 'col', indices: number[], hide: boolean) {
    const sheet = this.sheet()!;
    const key = axis === 'row' ? 'hiddenRows' : 'hiddenCols';
    const cur = new Set(sheet.metadata[key] ?? []);
    for (const i of indices) hide ? cur.add(i) : cur.delete(i);
    this.patchSheet(sheet.id, { metadata: { [key]: [...cur].sort((a, b) => a - b) } }, hide ? 'Sembunyikan' : 'Tampilkan');
  }

  /** Indices hidden next to (or inside) the selection, for the "unhide" menu item. */
  hiddenNear(axis: 'row' | 'col'): number[] {
    const sheet = this.sheet()!;
    const r = this.selectionRange();
    const list = (axis === 'row' ? sheet.metadata.hiddenRows : sheet.metadata.hiddenCols) ?? [];
    const lo = (axis === 'row' ? r.r1 : r.c1) - 1;
    const hi = (axis === 'row' ? r.r2 : r.c2) + 1;
    const out = list.filter((i) => i >= lo && i <= hi);
    // Extend through adjacent runs of hidden indices.
    const set = new Set(list);
    for (const i of [...out]) {
      for (let j = i - 1; set.has(j); j--) out.push(j);
      for (let j = i + 1; set.has(j); j++) out.push(j);
    }
    return [...new Set(out)];
  }

  resize(axis: 'row' | 'col', indices: number[], size: number) {
    const sheet = this.sheet()!;
    const key = axis === 'row' ? 'rowHeights' : 'colWidths';
    const cur = { ...(sheet.metadata[key] ?? {}) };
    const base = axis === 'row' ? sheet.defaultRowHeight : sheet.defaultColumnWidth;
    for (const i of indices) {
      if (Math.round(size) === base) delete cur[i];
      else cur[i] = Math.max(axis === 'row' ? 12 : 20, Math.min(1000, Math.round(size)));
    }
    this.patchSheet(sheet.id, { metadata: { [key]: cur } }, 'Ubah ukuran');
  }

  freeze(rows: number | null, cols: number | null) {
    const sheet = this.sheet()!;
    const patch: SheetPatch = {};
    if (rows !== null) patch.frozenRows = Math.max(0, Math.min(100, rows));
    if (cols !== null) patch.frozenColumns = Math.max(0, Math.min(50, cols));
    this.patchSheet(sheet.id, patch, 'Bekukan');
  }

  merge() {
    const r = this.selectionRange();
    if (r.r1 === r.r2 && r.c1 === r.c2) return;
    const sheet = this.sheet()!;
    const sid = sheet.id;
    const merges = (sheet.metadata.merges ?? []).filter((m) => !rangesIntersect(m, r));
    merges.push({ r1: r.r1, c1: r.c1, r2: r.r2, c2: r.c2 });
    // Only the top-left value is kept, as in other spreadsheets.
    const writes: CellWrite[] = [];
    this.forEachInRange(this.clampToUsed(r), (row, col) => {
      if ((row !== r.r1 || col !== r.c1) && this.model.raw(sid, row, col) !== '') writes.push({ sheetId: sid, row, col, raw: '' });
    });
    if (writes.length) toast.message('Hanya nilai sel kiri atas yang dipertahankan.');
    this.write(writes, 'Gabungkan sel', [{ sheetId: sid, patch: { metadata: { merges } } }]);
    this.select({ row: r.r1, col: r.c1 }, { row: r.r2, col: r.c2 });
  }

  unmerge() {
    const r = this.selectionRange();
    const sheet = this.sheet()!;
    const merges = (sheet.metadata.merges ?? []).filter((m) => !rangesIntersect(m, r));
    this.patchSheet(sheet.id, { metadata: { merges } }, 'Pisahkan sel');
  }

  // ---------- data tools ----------

  /** Rows of a range sorted by one column. Formulas move with their row. */
  sortRange(r: RangeAddress, byCol: number, asc: boolean, hasHeader: boolean) {
    const sid = this.s.activeSheetId;
    const range = this.clampToUsed(r);
    const start = hasHeader ? range.r1 + 1 : range.r1;
    if (start >= range.r2) return;
    const rows = [];
    for (let row = start; row <= range.r2; row++) {
      const cells = [];
      for (let col = range.c1; col <= range.c2; col++) cells.push(this.model.snapshot(sid, row, col));
      rows.push({ row, key: this.model.value(sid, row, byCol), cells });
    }
    rows.sort((a, b) => {
      // Blanks always last.
      const ea = a.key === null || a.key === '';
      const eb = b.key === null || b.key === '';
      if (ea !== eb) return ea ? 1 : -1;
      const c = compareValues(a.key, b.key);
      return asc ? c : -c;
    });
    const writes: CellWrite[] = [];
    rows.forEach((src, i) => {
      const row = start + i;
      src.cells.forEach((snap, j) => {
        let raw = snap.raw;
        if (raw.startsWith('=')) raw = translateFormula(raw, row - src.row, 0);
        writes.push({ sheetId: sid, row, col: range.c1 + j, raw, style: snap.style });
      });
    });
    this.write(writes, asc ? 'Urutkan A-Z' : 'Urutkan Z-A');
  }

  sortSelection(asc: boolean) {
    const r = this.selectionRange();
    const f = this.activeFilter();
    // Sorting inside a filter range sorts the whole filtered table by the active column.
    if (f && rangeContains(f, r.r1, r.c1)) return this.sortRange(f, this.s.selection.anchor.col, asc, true);
    if (r.r1 === r.r2) {
      // A single row: sort the data block around it by this column.
      const used = this.model.usedSize(this.s.activeSheetId);
      return this.sortRange({ r1: 0, c1: 0, r2: used.rows - 1, c2: used.cols - 1 }, this.s.selection.anchor.col, asc, true);
    }
    this.sortRange(r, this.s.selection.anchor.col, asc, false);
  }

  /** Toolbar and menu entry: removes the active filter, or opens the dialog to create one. */
  createFilter() {
    if (this.activeFilter()) return this.removeFilter();
    this.set({ dialog: 'createFilter' });
  }

  /** A sensible default range for a new filter: the selection, or the data block around the cell. */
  defaultFilterRange(): RangeAddress {
    const sheet = this.sheet()!;
    let r = this.selectionRange();
    if (r.r1 === r.r2 && r.c1 === r.c2) r = this.dataRegion(r.r1, r.c1);
    if (r.r1 === r.r2) {
      const used = this.model.usedSize(sheet.id);
      r = { r1: r.r1, c1: r.c1, r2: Math.max(used.rows - 1, r.r1 + 1), c2: r.c2 };
    }
    return r;
  }

  /** Creates a filter over `range`. `shared` filters change what everyone sees; the rest only affect this user. */
  createFilterOn(range: RangeAddress, shared: boolean) {
    const sheet = this.sheet()!;
    const filter: SheetFilter = { ...range, criteria: {} };
    if (shared) {
      if (!this.s.can.edit) return void toast.message('Hanya editor yang dapat membuat filter untuk semua orang.');
      this.setPersonalFilter(null);
      this.patchSheet(sheet.id, { metadata: { filter } }, 'Buat filter');
    } else {
      this.setPersonalFilter({ sheetId: sheet.id, filter, name: 'Filter saya', personal: true });
    }
  }

  removeFilter() {
    const sheet = this.sheet()!;
    const t = this.s.tempFilter;
    if (t && t.sheetId === sheet.id) {
      this.setPersonalFilter(null);
      return;
    }
    if (sheet.metadata.filter) this.patchSheet(sheet.id, { metadata: { filter: null } }, 'Hapus filter');
  }

  /** Whether the filter in effect for this user is shared with everyone. */
  filterIsShared(): boolean {
    const t = this.s.tempFilter;
    return !(t && t.sheetId === this.s.activeSheetId) && !!this.sheet()?.metadata.filter;
  }

  private personalKey(sheetId: string) {
    return `opensheet-filter:${this.workbookId}:${sheetId}`;
  }

  /** Personal filters live in this browser, so they survive a reload and never reach other users. */
  setPersonalFilter(t: EditorState['tempFilter']) {
    this.set({ tempFilter: t });
    const sid = t?.sheetId ?? this.s.activeSheetId;
    try {
      if (t?.personal) localStorage.setItem(this.personalKey(sid), JSON.stringify({ filter: t.filter, name: t.name }));
      else if (!t) localStorage.removeItem(this.personalKey(sid));
    } catch {
      /* private mode: the filter still works until the page closes */
    }
  }

  loadPersonalFilter(sheetId: string) {
    try {
      const raw = localStorage.getItem(this.personalKey(sheetId));
      if (!raw) return;
      const { filter, name } = JSON.parse(raw) as { filter: SheetFilter; name: string };
      if (filter && typeof filter.r1 === 'number') this.set({ tempFilter: { sheetId, filter, name, personal: true } });
    } catch {
      /* ignore a corrupt entry */
    }
  }

  /**
   * Formulas worth offering for an empty cell that sits below a column of numbers or
   * to the right of a row of numbers. Columns above win over rows on the left.
   */
  suggestFormulas(row: number, col: number): { range: string; area: RangeAddress; orientation: 'column' | 'row'; items: { fn: string; formula: string }[] } | null {
    const sid = this.s.activeSheetId;
    if (this.model.raw(sid, row, col) !== '') return null;
    const isNum = (r: number, c: number) => typeof this.model.value(sid, r, c) === 'number';
    let range: string | null = null;
    let area: RangeAddress = { r1: row, c1: col, r2: row, c2: col };
    let orientation: 'column' | 'row' = 'column';
    let n = 0;
    while (row - 1 - n >= 0 && isNum(row - 1 - n, col)) n++;
    if (n >= 2) {
      range = `${formatA1(row - n, col)}:${formatA1(row - 1, col)}`;
      area = { r1: row - n, c1: col, r2: row - 1, c2: col };
    }
    else {
      n = 0;
      while (col - 1 - n >= 0 && isNum(row, col - 1 - n)) n++;
      if (n >= 2) {
        range = `${formatA1(row, col - n)}:${formatA1(row, col - 1)}`;
        orientation = 'row';
        area = { r1: row, c1: col - n, r2: row, c2: col - 1 };
      }
    }
    if (!range) return null;
    const items = (['SUM', 'AVERAGE', 'COUNT', 'MAX', 'MIN'] as const).map((fn) => ({ fn, formula: `=${fn}(${range})` }));
    return { range, area, orientation, items };
  }

  /** The contiguous block of non-empty cells around (row, col). */
  dataRegion(row: number, col: number): RangeAddress {
    const sid = this.s.activeSheetId;
    const filled = (r: number, c: number) => r >= 0 && c >= 0 && this.model.raw(sid, r, c) !== '';
    let r: RangeAddress = { r1: row, c1: col, r2: row, c2: col };
    let grew = true;
    while (grew) {
      grew = false;
      const rowHas = (rr: number) => [...Array(r.c2 - r.c1 + 3)].some((_, i) => filled(rr, r.c1 - 1 + i));
      const colHas = (cc: number) => [...Array(r.r2 - r.r1 + 3)].some((_, i) => filled(r.r1 - 1 + i, cc));
      if (r.r1 > 0 && rowHas(r.r1 - 1)) (r = { ...r, r1: r.r1 - 1 }), (grew = true);
      if (rowHas(r.r2 + 1)) (r = { ...r, r2: r.r2 + 1 }), (grew = true);
      if (r.c1 > 0 && colHas(r.c1 - 1)) (r = { ...r, c1: r.c1 - 1 }), (grew = true);
      if (colHas(r.c2 + 1)) (r = { ...r, c2: r.c2 + 1 }), (grew = true);
      if (r.r2 - r.r1 > 100_000) break;
    }
    return r;
  }

  setFilterCriterion(col: number, criterion: FilterCriterion | null) {
    const sheet = this.sheet()!;
    const t = this.s.tempFilter;
    if (t && t.sheetId === sheet.id) {
      const criteria = { ...t.filter.criteria };
      if (criterion) criteria[col] = criterion;
      else delete criteria[col];
      this.setPersonalFilter({ ...t, filter: { ...t.filter, criteria } });
      return;
    }
    const f = sheet.metadata.filter;
    if (!f) return;
    const criteria = { ...f.criteria };
    if (criterion) criteria[col] = criterion;
    else delete criteria[col];
    this.patchSheet(sheet.id, { metadata: { filter: { ...f, criteria } } }, 'Filter');
  }

  /** Distinct display values of a column inside the filter range (excluding the header). */
  columnValues(col: number): { text: string; count: number }[] {
    const f = this.activeFilter();
    if (!f) return [];
    const sid = this.s.activeSheetId;
    const counts = new Map<string, number>();
    for (let r = f.r1 + 1; r <= f.r2; r++) {
      const t = displayText(this.model.value(sid, r, col), this.model.style(sid, r, col));
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()].map(([text, count]) => ({ text, count })).sort((a, b) => a.text.localeCompare(b.text, 'id', { numeric: true }));
  }

  columnColors(col: number): string[] {
    const f = this.activeFilter();
    if (!f) return [];
    const sid = this.s.activeSheetId;
    const set = new Set<string>();
    for (let r = f.r1 + 1; r <= f.r2; r++) {
      const bg = this.model.style(sid, r, col)?.backgroundColor;
      if (bg) set.add(bg.toUpperCase());
    }
    return [...set];
  }

  saveFilterView(name: string) {
    const sheet = this.sheet()!;
    const f = this.activeFilter();
    if (!f) return;
    const views = [...(sheet.metadata.filterViews ?? []), { id: crypto.randomUUID(), name, filter: structuredClone(f) }];
    this.patchSheet(sheet.id, { metadata: { filterViews: views } }, 'Simpan tampilan filter');
  }

  applyFilterView(id: string | null) {
    const sheet = this.sheet()!;
    if (!id) return this.setPersonalFilter(null);
    const v = sheet.metadata.filterViews?.find((x) => x.id === id);
    if (v) this.set({ tempFilter: { sheetId: sheet.id, filter: structuredClone(v.filter), name: v.name } });
  }

  deleteFilterView(id: string) {
    const sheet = this.sheet()!;
    this.patchSheet(sheet.id, { metadata: { filterViews: (sheet.metadata.filterViews ?? []).filter((v) => v.id !== id) } }, 'Hapus tampilan filter');
    if (this.s.tempFilter && !this.s.tempFilter.personal) this.set({ tempFilter: null });
  }

  removeDuplicates(r: RangeAddress, cols: number[], hasHeader: boolean): number {
    const sid = this.s.activeSheetId;
    const range = this.clampToUsed(r);
    const start = hasHeader ? range.r1 + 1 : range.r1;
    const seen = new Set<string>();
    const keep: CellSnapshot[][] = [];
    let removed = 0;
    for (let row = start; row <= range.r2; row++) {
      const key = cols.map((c) => displayText(this.model.value(sid, row, c), null).toLowerCase()).join('\u0001');
      if (seen.has(key)) {
        removed++;
        continue;
      }
      seen.add(key);
      const cells: CellSnapshot[] = [];
      for (let col = range.c1; col <= range.c2; col++) cells.push(this.model.snapshot(sid, row, col));
      keep.push(cells);
    }
    if (!removed) return 0;
    const writes: CellWrite[] = [];
    for (let i = 0; start + i <= range.r2; i++) {
      const row = start + i;
      for (let j = 0; j <= range.c2 - range.c1; j++) {
        const snap = keep[i]?.[j] ?? { raw: '', style: null };
        writes.push({ sheetId: sid, row, col: range.c1 + j, raw: snap.raw, style: snap.style });
      }
    }
    this.write(writes, 'Hapus duplikat');
    return removed;
  }

  splitToColumns(r: RangeAddress, delimiter: string) {
    const sid = this.s.activeSheetId;
    const range = this.clampToUsed(r);
    const writes: CellWrite[] = [];
    for (let row = range.r1; row <= range.r2; row++) {
      const raw = this.model.raw(sid, row, range.c1);
      if (!raw || raw.startsWith('=')) continue;
      const parts = delimiter === 'auto' ? raw.split(/[,;\t]|\s{2,}/) : raw.split(delimiter);
      parts.forEach((p, j) => writes.push({ sheetId: sid, row, col: range.c1 + j, raw: p.trim() }));
    }
    this.write(writes, 'Pisahkan teks ke kolom');
  }

  findMatches(query: string, opts: { matchCase: boolean; whole: boolean; formulas: boolean; allSheets: boolean; regex: boolean }) {
    if (!query) return [];
    let re: RegExp;
    try {
      const src = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      re = new RegExp(opts.whole ? `^(?:${src})$` : src, opts.matchCase ? '' : 'i');
    } catch {
      return [];
    }
    const out: { sheetId: string; row: number; col: number }[] = [];
    const sheets = opts.allSheets ? this.model.sheets : [this.sheet()!];
    for (const s of sheets) {
      const list = [...this.model.engine.cells(s.id)].sort((a, b) => a.row - b.row || a.col - b.col);
      for (const c of list) {
        const text = opts.formulas && c.raw.startsWith('=') ? c.raw : displayText(c.value, this.model.style(s.id, c.row, c.col));
        if (re.test(text)) out.push({ sheetId: s.id, row: c.row, col: c.col });
        if (out.length > 5000) return out;
      }
    }
    return out;
  }

  replaceMatches(matches: { sheetId: string; row: number; col: number }[], query: string, replacement: string, opts: { matchCase: boolean; whole: boolean; regex: boolean }) {
    const src = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(opts.whole ? `^(?:${src})$` : src, opts.matchCase ? 'g' : 'gi');
    const writes: CellWrite[] = [];
    for (const m of matches) {
      const raw = this.model.raw(m.sheetId, m.row, m.col);
      const next = raw.replace(re, replacement);
      if (next !== raw) writes.push({ ...m, raw: next });
    }
    if (writes.length && this.write(writes, 'Ganti')) return writes.length;
    return 0;
  }

  goTo(sheetId: string, row: number, col: number) {
    if (sheetId !== this.s.activeSheetId) this.setActiveSheet(sheetId);
    this.select({ row, col });
  }

  // ---------- rules (server-backed) ----------

  async saveValidations(items: RuleRecord<ValidationRule>[], quiet = false) {
    const sid = this.s.activeSheetId;
    const r = await api.put<{ sheet: SheetPayload }>(`/api/worksheets/${sid}/validations`, { items: items.map(({ range, rule }) => ({ range, rule })) });
    this.model.updateSheet(r.sheet);
    if (!quiet) toast.success('Validasi data disimpan');
  }

  async saveConditional(items: RuleRecord<ConditionalRule>[], quiet = false) {
    const sid = this.s.activeSheetId;
    const r = await api.put<{ sheet: SheetPayload }>(`/api/worksheets/${sid}/conditional-formats`, { items: items.map(({ range, rule }) => ({ range, rule })) });
    this.model.updateSheet(r.sheet);
    if (!quiet) toast.success('Format bersyarat disimpan');
  }

  async saveProtected(items: ProtectedRangeRecord[], quiet = false) {
    const sid = this.s.activeSheetId;
    const r = await api.put<{ sheet: SheetPayload }>(`/api/worksheets/${sid}/protected-ranges`, {
      items: items.map(({ range, description, editorIds }) => ({ range, description: description ?? null, editorIds })),
    });
    this.model.updateSheet(r.sheet);
    if (!quiet) toast.success('Perlindungan disimpan');
  }

  // ---------- sheets ----------

  async addSheet() {
    await this.sync.flushNow();
    const r = await api.post<{ sheet: SheetPayload }>(`/api/workbooks/${this.workbookId}/worksheets`, {});
    this.model.addSheet(r.sheet);
    this.setActiveSheet(r.sheet.id);
  }

  async renameSheet(id: string, title: string) {
    await this.sync.flushNow();
    const r = await api.patch<{ sheet: SheetPayload; revision?: number }>(`/api/worksheets/${id}`, { title, clientId: this.sync.clientId });
    this.model.updateSheet(r.sheet);
  }

  async deleteSheet(id: string) {
    await this.sync.flushNow();
    await api.del(`/api/worksheets/${id}`);
    this.model.removeSheet(id);
    if (this.s.activeSheetId === id) this.setActiveSheet(this.model.sheets[0]?.id);
    this.undoStack = this.undoStack.filter((e) => !e.cells.some((c) => c.sheetId === id));
    this.updateUndoFlags();
  }

  async duplicateSheet(id: string) {
    await this.sync.flushNow();
    const r = await api.post<{ sheet: SheetPayload }>(`/api/worksheets/${id}/duplicate`, {});
    await this.resync();
    this.model.addSheet(r.sheet);
    await this.resync();
    this.setActiveSheet(r.sheet.id);
  }

  async moveSheet(id: string, position: number) {
    const r = await api.post<{ order: string[] }>(`/api/worksheets/${id}/reorder`, { position });
    this.model.reorder(r.order);
  }

  async setTabColor(id: string, color: string | null) {
    this.patchSheet(id, { metadata: { tabColor: color } }, 'Warna tab');
  }

  // ---------- comments ----------

  commentsAt(sheetId: string, row: number, col: number): CommentThread[] {
    const ref = formatA1(row, col);
    return this.s.comments.filter((c) => c.worksheetId === sheetId && c.cellReference === ref && !c.resolved);
  }

  openCommentDraft() {
    const { anchor } = this.s.selection;
    this.set({ panel: 'comments', commentDraftCell: formatA1(anchor.row, anchor.col) });
  }

  // ---------- workbook ----------

  async renameWorkbook(title: string) {
    await api.patch(`/api/workbooks/${this.workbookId}`, { title });
    if (this.s.workbook) this.set({ workbook: { ...this.s.workbook, title } });
  }

  async toggleStar() {
    const wb = this.s.workbook;
    if (!wb) return;
    await api.patch(`/api/workbooks/${this.workbookId}`, { starred: !wb.starred });
    this.set({ workbook: { ...wb, starred: !wb.starred } });
  }
}

// ---------- helpers ----------

export function roleLabel(role: string): string {
  return ({ owner: 'Pemilik', manager: 'Editor + kelola akses', editor: 'Editor', commenter: 'Komentator', viewer: 'Pembaca' } as Record<string, string>)[role] ?? role;
}

export function displayText(v: Scalar, style: CellStyle | null): string {
  return formatValue(v, style?.numberFormat);
}

function normalizeEol(s: string) {
  return s.replace(/\r\n/g, '\n').replace(/\n$/, '');
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

function roundFloat(n: number): number {
  return Number(n.toPrecision(12));
}

/** Detects a numeric series (1, 2, 3 or 5, 10) in the fill source. */
function numericSeries(raws: string[]): { first: number; last: number; step: number } | null {
  const nums = raws.map((r) => {
    const p = parseInput(r);
    return p.kind === 'number' && !r.startsWith('=') ? (p.value as number) : null;
  });
  if (nums.some((n) => n === null)) return null;
  const ns = nums as number[];
  if (ns.length === 1) return null; // a single number is copied, not incremented
  const step = ns[1] - ns[0];
  for (let i = 2; i < ns.length; i++) if (Math.abs(ns[i] - ns[i - 1] - step) > 1e-9) return null;
  return { first: ns[0], last: ns[ns.length - 1], step };
}

/** Parses tab-separated text (Excel/Sheets clipboard), honouring quoted cells. */
export function parseTsv(text: string): string[][] {
  const t = text.replace(/\r\n/g, '\n').replace(/\n$/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quoted) {
      if (ch === '"' && t[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === '\t') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

export function criterionTest(c: FilterCriterion): (v: Scalar, text: string, style: CellStyle | null) => boolean {
  if (c.kind === 'values') {
    const hidden = new Set(c.hidden);
    return (_v, text) => !hidden.has(text);
  }
  if (c.kind === 'color') return (_v, _t, style) => (style?.backgroundColor ?? '').toUpperCase() === c.color.toUpperCase();
  return (v, text) => conditionMatches(c.op, c.value, c.value2, v, text);
}

export function conditionMatches(op: ConditionalRule['op'], a: string | undefined, b: string | undefined, v: Scalar, text: string): boolean {
  const num = (s?: string) => (s === undefined || s.trim() === '' ? NaN : Number(s));
  const isNum = typeof v === 'number';
  const lower = text.toLowerCase();
  const av = (a ?? '').toLowerCase();
  switch (op) {
    case 'empty':
      return v === null || v === '';
    case 'notEmpty':
      return !(v === null || v === '');
    case 'contains':
      return lower.includes(av);
    case 'notContains':
      return !lower.includes(av);
    case 'startsWith':
      return lower.startsWith(av);
    case 'endsWith':
      return lower.endsWith(av);
    case 'eq':
      return isNum && !Number.isNaN(num(a)) ? v === num(a) : lower === av;
    case 'neq':
      return isNum && !Number.isNaN(num(a)) ? v !== num(a) : lower !== av;
    case 'gt':
      return isNum && v > num(a);
    case 'gte':
      return isNum && v >= num(a);
    case 'lt':
      return isNum && v < num(a);
    case 'lte':
      return isNum && v <= num(a);
    case 'between':
      return isNum && v >= Math.min(num(a), num(b)) && v <= Math.max(num(a), num(b));
    default:
      return false;
  }
}

export function validationProblem(rule: ValidationRule, raw: string): string | null {
  const p = parseInput(raw);
  switch (rule.kind) {
    case 'list':
      return rule.items.some((i) => i.toLowerCase() === raw.trim().toLowerCase()) ? null : `Nilai harus salah satu dari: ${rule.items.slice(0, 8).join(', ')}${rule.items.length > 8 ? ', ...' : ''}`;
    case 'number': {
      if (p.kind !== 'number') return 'Nilai harus berupa angka.';
      const n = p.value as number;
      const { min = -Infinity, max = Infinity } = rule;
      const ok =
        rule.op === 'between' ? n >= min && n <= max : rule.op === 'gt' ? n > min : rule.op === 'gte' ? n >= min : rule.op === 'lt' ? n < max : rule.op === 'lte' ? n <= max : n === min;
      return ok ? null : 'Angka di luar batas yang diizinkan.';
    }
    case 'textLength':
      return raw.length <= rule.max ? null : `Maksimal ${rule.max} karakter.`;
    case 'checkbox':
      return p.kind === 'boolean' ? null : 'Nilai harus TRUE atau FALSE.';
  }
}

export function colLabel(c: number) {
  return colToLetters(c);
}
