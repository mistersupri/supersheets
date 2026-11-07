import { parseA1 } from '@opensheet/engine';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Icon } from '../components/icons';
import { Avatar, Button, Checkbox, ErrorState, IconButton, Select, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { dateTime, relativeTime } from '../lib/format';
import { ConfirmDialog } from './chrome';
import { useCtrl, useEditor } from './context';
import type { CommentThread } from './controller';

function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <aside
      aria-label={title}
      className="panel-in flex w-full shrink-0 flex-col border-l border-line bg-surface max-md:absolute max-md:inset-0 max-md:z-30 md:w-[340px]"
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-2">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        <IconButton label="Tutup panel" onClick={onClose}>
          <Icon.Close />
        </IconButton>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">{children}</div>
    </aside>
  );
}

// ---------- version history ----------

interface Revision {
  id: string;
  revision: number;
  kind: string;
  label: string | null;
  user: { id: string; name: string } | null;
  createdAt: string;
  count: number;
  sample: { sheet: string; cell: string; before: string; after: string }[];
}

const KIND_LABEL: Record<string, string> = { cells: 'Edit', restore: 'Pemulihan', import: 'Impor' };

export function HistoryPanel() {
  const ctrl = useCtrl();
  const can = useEditor((s) => s.can);
  const [userId, setUserId] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Revision | null>(null);
  const qc = useQueryClient();
  const key = ['revisions', ctrl.workbookId, userId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ revisions: Revision[]; editors: { id: string; name: string }[] }>(`/api/workbooks/${ctrl.workbookId}/revisions${userId ? `?userId=${userId}` : ''}`),
    refetchInterval: 15_000,
  });
  const detail = useQuery({
    queryKey: ['revision', open],
    enabled: !!open,
    queryFn: () =>
      api.get<{ changes: { sheetId: string; sheet: string; cell: string; before: string; after: string; styleChanged: boolean }[]; truncated: boolean }>(
        `/api/workbooks/${ctrl.workbookId}/revisions/${open}`,
      ),
  });

  const restore = async (r: Revision) => {
    setConfirm(null);
    try {
      await ctrl.sync.flushNow();
      const res = await api.post<{ revision: number; changed: number }>(`/api/workbooks/${ctrl.workbookId}/revisions/${r.id}/restore`, {});
      await ctrl.resync();
      qc.invalidateQueries({ queryKey: ['revisions', ctrl.workbookId] });
      toast.success(res.changed ? `Dipulihkan ke versi #${r.revision} (${res.changed} sel berubah)` : 'Isi sudah sama dengan versi itu');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <Panel title="Riwayat versi" onClose={() => ctrl.set({ panel: null })}>
      <div className="border-b border-line px-4 py-3">
        <label htmlFor="hist-user" className="text-xs text-ink-2">
          Tampilkan perubahan dari
        </label>
        <Select id="hist-user" className="mt-1 w-full" value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Semua orang</option>
          {(q.data?.editors ?? []).map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </Select>
      </div>
      {q.isLoading ? (
        <div className="flex items-center gap-2 p-4 text-sm text-ink-2">
          <Spinner /> Memuat riwayat
        </div>
      ) : q.isError ? (
        <div className="p-4">
          <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />
        </div>
      ) : !q.data?.revisions.length ? (
        <p className="p-4 text-sm text-ink-2">Belum ada perubahan tercatat. Setiap edit yang tersimpan akan muncul di sini.</p>
      ) : (
        <ol>
          {q.data.revisions.map((r, i) => (
            <li key={r.id} className="border-b border-line">
              <button
                type="button"
                aria-expanded={open === r.id}
                className={clsx('w-full px-4 py-3 text-left hover:bg-surface-2', open === r.id && 'bg-surface-2')}
                onClick={() => setOpen(open === r.id ? null : r.id)}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-ink">{r.label ?? KIND_LABEL[r.kind] ?? r.kind}</span>
                  <span className="addr text-xs text-ink-2">#{r.revision}</span>
                </div>
                <div className="mt-0.5 text-xs text-ink-2" title={dateTime(r.createdAt)}>
                  {r.user?.name ?? 'Sistem'} · {relativeTime(r.createdAt)} · {r.count} sel
                  {i === 0 && !userId && <span className="ml-1 font-medium text-brand">versi terkini</span>}
                </div>
                {open !== r.id && r.sample.length > 0 && (
                  <div className="addr mt-1 truncate text-xs text-ink-2">
                    {r.sample
                      .slice(0, 3)
                      .map((s) => s.cell)
                      .join(', ')}
                    {r.count > 3 ? ', ...' : ''}
                  </div>
                )}
              </button>
              {open === r.id && (
                <div className="px-4 pb-3">
                  {detail.isLoading ? (
                    <Spinner />
                  ) : detail.isError ? (
                    <p className="text-xs text-danger">{errorMessage(detail.error)}</p>
                  ) : (
                    <ul className="flex flex-col gap-1.5">
                      {detail.data?.changes.slice(0, 200).map((c, n) => (
                        <li key={n} className="text-xs">
                          <button
                            type="button"
                            className="addr text-brand underline underline-offset-2"
                            onClick={() => {
                              const p = parseA1(c.cell);
                              if (p && ctrl.model.sheet(c.sheetId)) ctrl.goTo(c.sheetId, p.row, p.col);
                            }}
                          >
                            {c.sheet}!{c.cell}
                          </button>{' '}
                          <span className="text-ink-2 line-through">{c.before || '(kosong)'}</span>
                          <span className="text-ink-2"> → </span>
                          <span className="text-ink">{c.after || '(kosong)'}</span>
                          {c.styleChanged && <span className="ml-1 text-ink-2">(format)</span>}
                        </li>
                      ))}
                      {(detail.data?.changes.length ?? 0) > 200 && <li className="text-xs text-ink-2">dan {detail.data!.changes.length - 200} perubahan lain</li>}
                    </ul>
                  )}
                  {can.edit && !(i === 0 && !userId) && (
                    <Button size="sm" className="mt-3" onClick={() => setConfirm(r)}>
                      <Icon.Restore /> Pulihkan versi ini
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {confirm && (
        <ConfirmDialog
          title={`Pulihkan ke versi #${confirm.revision}?`}
          body="Isi semua sheet dikembalikan seperti setelah perubahan ini. Pemulihan dicatat sebagai versi baru, jadi bisa dibatalkan lewat riwayat."
          confirm="Pulihkan"
          onCancel={() => setConfirm(null)}
          onConfirm={() => restore(confirm)}
        />
      )}
    </Panel>
  );
}

// ---------- comments ----------

export function CommentsPanel() {
  const ctrl = useCtrl();
  const comments = useEditor((s) => s.comments);
  const draftCell = useEditor((s) => s.commentDraftCell);
  const can = useEditor((s) => s.can);
  const activeSheetId = useEditor((s) => s.activeSheetId);
  const [showResolved, setShowResolved] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (draftCell) draftRef.current?.focus();
  }, [draftCell]);

  const sheetTitle = (id: string) => ctrl.model.sheet(id)?.title ?? '(sheet dihapus)';
  const list = comments.filter((c) => showResolved || !c.resolved).sort((a, b) => Number(a.resolved) - Number(b.resolved) || +new Date(b.createdAt) - +new Date(a.createdAt));

  const submit = async () => {
    if (!text.trim() || !draftCell) return;
    setBusy(true);
    try {
      const r = await api.post<{ comment: CommentThread }>(`/api/workbooks/${ctrl.workbookId}/comments`, { worksheetId: activeSheetId, cellReference: draftCell, content: text.trim() });
      ctrl.set({ comments: [...ctrl.s.comments.filter((c) => c.id !== r.comment.id), r.comment], commentDraftCell: null });
      setText('');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Komentar" onClose={() => ctrl.set({ panel: null, commentDraftCell: null })}>
      {draftCell && can.comment && (
        <form
          className="border-b border-line p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="comment-draft" className="text-xs text-ink-2">
            Komentar baru di <span className="addr text-ink">{sheetTitle(activeSheetId)}!{draftCell}</span>
          </label>
          <textarea
            id="comment-draft"
            ref={draftRef}
            className="mt-1 min-h-20 w-full rounded-md border border-line-2 bg-surface p-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-brand max-md:text-base"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit();
            }}
            maxLength={5000}
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => ctrl.set({ commentDraftCell: null })}>
              Batal
            </Button>
            <Button size="sm" variant="primary" type="submit" disabled={busy || !text.trim()}>
              Kirim
            </Button>
          </div>
        </form>
      )}
      <div className="flex items-center justify-between border-b border-line px-4 py-2">
        <Checkbox label="Tampilkan yang selesai" checked={showResolved} onChange={setShowResolved} />
      </div>
      {list.length === 0 ? (
        <p className="p-4 text-sm text-ink-2">{can.comment ? 'Belum ada komentar. Pilih sel, lalu klik kanan dan pilih "Tambah komentar".' : 'Belum ada komentar.'}</p>
      ) : (
        <ul>
          {list.map((c) => (
            <Thread key={c.id} c={c} sheetTitle={sheetTitle(c.worksheetId)} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Thread({ c, sheetTitle }: { c: CommentThread; sheetTitle: string }) {
  const ctrl = useCtrl();
  const can = useEditor((s) => s.can);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const update = (comment: CommentThread) => ctrl.set({ comments: [...ctrl.s.comments.filter((x) => x.id !== comment.id), comment] });
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={clsx('border-b border-line p-4', c.resolved && 'opacity-70')}>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="addr text-xs text-brand underline underline-offset-2"
          onClick={() => {
            const p = parseA1(c.cellReference);
            if (p) ctrl.goTo(c.worksheetId, p.row, p.col);
          }}
        >
          {sheetTitle}!{c.cellReference}
        </button>
        {c.resolved && <span className="text-xs text-ink-2">Selesai</span>}
      </div>
      <div className="mt-2 flex gap-2">
        <Avatar name={c.user.name} size={24} />
        <div className="min-w-0">
          <p className="text-xs text-ink-2">
            <span className="font-medium text-ink">{c.user.name}</span> · {relativeTime(c.createdAt)}
          </p>
          <p className="mt-0.5 text-sm break-words whitespace-pre-wrap text-ink">{c.content}</p>
        </div>
      </div>
      {c.replies.map((r) => (
        <div key={r.id} className="mt-3 ml-8 flex gap-2">
          <Avatar name={r.user.name} size={20} />
          <div className="min-w-0">
            <p className="text-xs text-ink-2">
              <span className="font-medium text-ink">{r.user.name}</span> · {relativeTime(r.createdAt)}
            </p>
            <p className="mt-0.5 text-sm break-words whitespace-pre-wrap text-ink">{r.content}</p>
          </div>
        </div>
      ))}
      {can.comment && (
        <>
          {!c.resolved && (
            <form
              className="mt-3 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!reply.trim()) return;
                void run(async () => {
                  const r = await api.post<{ comment: CommentThread }>(`/api/comments/${c.id}/replies`, { content: reply.trim() });
                  update(r.comment);
                  setReply('');
                });
              }}
            >
              <input
                aria-label="Balas"
                placeholder="Balas"
                className="h-8 min-w-0 flex-1 rounded-md border border-line-2 bg-surface px-2 text-sm focus-visible:outline-2 focus-visible:outline-brand max-md:h-11 max-md:text-base"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                maxLength={5000}
              />
              <Button size="sm" type="submit" disabled={busy || !reply.trim()}>
                Balas
              </Button>
            </form>
          )}
          <div className="mt-2 flex gap-3 text-xs">
            <button
              type="button"
              className="min-h-8 text-brand underline underline-offset-2 max-md:min-h-11"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const r = await api.patch<{ comment: CommentThread }>(`/api/comments/${c.id}`, { resolved: !c.resolved });
                  update(r.comment);
                })
              }
            >
              {c.resolved ? 'Buka kembali' : 'Tandai selesai'}
            </button>
            {(c.user.id === ctrl.userId || can.manage) && (
              <button type="button" className="min-h-8 text-danger underline underline-offset-2 max-md:min-h-11" disabled={busy} onClick={() => setConfirm(true)}>
                Hapus
              </button>
            )}
          </div>
        </>
      )}
      {confirm && (
        <ConfirmDialog
          title="Hapus komentar ini?"
          body="Komentar dan semua balasannya akan dihapus."
          confirm="Hapus"
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            void run(async () => {
              await api.del(`/api/comments/${c.id}`);
              ctrl.set({ comments: ctrl.s.comments.filter((x) => x.id !== c.id) });
            });
          }}
        />
      )}
    </li>
  );
}
