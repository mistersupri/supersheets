import type { CellOp, PresenceUser } from '@opensheet/engine';
import { io, type Socket } from 'socket.io-client';
import { api, ApiError, setSocketId } from '../lib/api';

export type SaveStatus = 'saved' | 'saving' | 'offline' | 'error' | 'conflict';

export interface SyncCallbacks {
  onStatus: (s: SaveStatus, detail?: string) => void;
  onRemoteOps: (ops: CellOp[], revision: number, userId: string) => void;
  /** The server rejected our changes or we fell behind: reload cells from the server. */
  onResync: (reason: 'conflict' | 'rejected' | 'gap', cells?: { sheetId: string; row: number; col: number }[], message?: string) => void;
  onPresence: (users: PresenceUser[]) => void;
  onSelection: (p: { socketId: string; userId: string; sheetId?: string; selection?: PresenceUser['selection'] }) => void;
  onSheetUpdate: (payload: unknown) => void;
  onWorkbookUpdate: (payload: unknown) => void;
  onComment: (payload: unknown) => void;
  onRevision: (payload: { revision: number; restored?: boolean; userId?: string }) => void;
  onAccess: (kind: 'revoked' | 'changed', payload: { role?: string }) => void;
}

const DEBOUNCE_MS = 700;
const opKey = (o: { sheetId: string; row: number; col: number }) => `${o.sheetId}|${o.row}:${o.col}`;

/**
 * Batches local edits and sends them with the last known revision.
 * - edits are optimistic (already applied to the model);
 * - a 409 means another user changed the same cell: the server copy wins and
 *   the affected cells are reloaded;
 * - network failures keep the batch and retry with backoff.
 */
export class SyncManager {
  readonly clientId = `c-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  revision = 0;
  /** Each queued write remembers the revision it was based on, so a remote change to the same cell is detected as a conflict. */
  private pending = new Map<string, { op: CellOp; base: number }>();
  private inflight: Map<string, { op: CellOp; base: number }> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 1000;
  socket: Socket | null = null;
  private status: SaveStatus = 'saved';
  private disposed = false;

  constructor(
    private workbookId: string,
    private firstSheetId: () => string | undefined,
    private cb: SyncCallbacks,
  ) {}

  connect(): void {
    const s = io({ withCredentials: true, transports: ['websocket', 'polling'] });
    this.socket = s;
    s.on('connect', () => {
      setSocketId(s.id);
      s.emit('workbook:join', { workbookId: this.workbookId }, (r: { ok: boolean; presence?: PresenceUser[] }) => {
        if (r?.ok && r.presence) this.cb.onPresence(r.presence);
      });
      if (this.status === 'offline') this.setStatus(this.pending.size ? 'saving' : 'saved');
      // Catch up on anything missed while disconnected.
      this.cb.onResync('gap');
      this.flushSoon(0);
    });
    s.on('disconnect', () => {
      setSocketId(undefined);
      if (!this.disposed) this.setStatus('offline');
    });
    s.on('cell:batch-update', (p: { revision: number; ops: CellOp[]; userId: string; clientId: string }) => {
      if (p.clientId === this.clientId) return;
      if (p.revision > this.revision + 1 && !this.inflight) {
        // We missed a revision; a full reload is the only safe option.
        this.revision = p.revision;
        this.cb.onResync('gap');
        return;
      }
      this.revision = Math.max(this.revision, p.revision);
      this.cb.onRemoteOps(p.ops, p.revision, p.userId);
    });
    s.on('user:presence', (u: PresenceUser[]) => this.cb.onPresence(u));
    s.on('cell:selection', (p: Parameters<SyncCallbacks['onSelection']>[0]) => this.cb.onSelection(p));
    s.on('worksheet:update', (p: unknown) => this.cb.onSheetUpdate(p));
    // Someone inserted or deleted rows/columns: cell positions moved, so reload.
    s.on('worksheet:structure', (p: { sheet: unknown; clientId: string }) => {
      if (p.clientId === this.clientId) return;
      this.cb.onSheetUpdate({ action: 'update', sheet: p.sheet });
      this.cb.onResync('gap');
    });
    s.on('workbook:update', (p: unknown) => this.cb.onWorkbookUpdate(p));
    s.on('comment:update', (p: unknown) => this.cb.onComment(p));
    s.on('revision:created', (p: { revision: number; restored?: boolean; userId?: string }) => this.cb.onRevision(p));
    s.on('access:revoked', () => this.cb.onAccess('revoked', {}));
    s.on('access:changed', (p: { role?: string }) => this.cb.onAccess('changed', p));
    window.addEventListener('online', this.onOnline);
    window.addEventListener('beforeunload', this.onBeforeUnload);
  }

  dispose(): void {
    this.disposed = true;
    this.socket?.emit('workbook:leave', { workbookId: this.workbookId });
    this.socket?.disconnect();
    setSocketId(undefined);
    if (this.timer) clearTimeout(this.timer);
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
  }

  private onOnline = () => this.flushSoon(0);

  private onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (this.hasUnsaved()) {
      e.preventDefault();
      e.returnValue = '';
    }
  };

  hasUnsaved(): boolean {
    return this.pending.size > 0 || this.inflight !== null;
  }

  isPending(op: { sheetId: string; row: number; col: number }): boolean {
    const key = opKey(op);
    return this.pending.has(key) || !!this.inflight?.has(key);
  }

  sendSelection(sheetId: string, selection: { r1: number; c1: number; r2: number; c2: number }): void {
    this.socket?.emit('cell:selection', { workbookId: this.workbookId, sheetId, selection });
  }

  queue(ops: CellOp[]): void {
    for (const op of ops) {
      const key = opKey(op);
      const prev = this.pending.get(key);
      // Merge with an earlier queued write to the same cell, keeping the older base.
      this.pending.set(
        key,
        prev ? { op: { ...prev.op, ...op, style: op.style !== undefined ? op.style : prev.op.style }, base: prev.base } : { op, base: this.revision },
      );
    }
    if (ops.length) {
      this.setStatus('saving');
      this.flushSoon(DEBOUNCE_MS);
    }
  }

  /** Sends everything now (e.g. before a structural server call that needs a fresh revision). */
  async flushNow(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    while (this.inflight) await new Promise((r) => setTimeout(r, 50));
    await this.flush();
  }

  private flushSoon(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  private setStatus(s: SaveStatus, detail?: string): void {
    this.status = s;
    this.cb.onStatus(s, detail);
  }

  private async flush(): Promise<void> {
    if (this.inflight || this.pending.size === 0 || this.disposed) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.setStatus('offline');
      return;
    }
    const batch = this.pending;
    this.pending = new Map();
    this.inflight = batch;
    const ops = [...batch.values()].map((p) => p.op);
    const baseRevision = Math.min(this.revision, ...[...batch.values()].map((p) => p.base));
    const sheetId = ops[0]?.sheetId ?? this.firstSheetId();
    this.setStatus('saving');
    try {
      const r = await api.post<{ revision: number; ops: CellOp[] }>(`/api/worksheets/${sheetId}/cells/batch`, {
        baseRevision,
        clientId: this.clientId,
        ops,
      });
      this.revision = Math.max(this.revision, r.revision);
      this.inflight = null;
      this.retryDelay = 1000;
      if (this.pending.size) this.flushSoon(DEBOUNCE_MS);
      else this.setStatus('saved');
    } catch (e) {
      this.inflight = null;
      if (e instanceof ApiError && e.status === 409) {
        const details = e.details as { revision?: number; cells?: { sheetId: string; row: number; col: number }[] } | undefined;
        if (details?.revision) this.revision = details.revision;
        // Retry the cells that did not clash; the clashing ones take the server value.
        const clash = new Set((details?.cells ?? []).map(opKey));
        for (const [key, p] of batch) if (!clash.has(key) && !this.pending.has(key)) this.pending.set(key, { op: p.op, base: this.revision });
        this.setStatus('conflict', `${clash.size} sel diubah pengguna lain`);
        this.cb.onResync('conflict', details?.cells, e.message);
        if (this.pending.size) this.flushSoon(300);
        return;
      }
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        // Permission, protection or validation failure: roll back to the server copy.
        this.setStatus('error', e.message);
        this.cb.onResync('rejected', ops, e.message);
        return;
      }
      // Network or server error: keep the edits and retry.
      for (const [key, p] of batch) if (!this.pending.has(key)) this.pending.set(key, p);
      this.setStatus(e instanceof ApiError && e.status === 0 ? 'offline' : 'error', e instanceof Error ? e.message : undefined);
      this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
      this.flushSoon(this.retryDelay);
    }
  }
}
