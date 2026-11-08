import { Dialog as BDialog } from '@base-ui/react/dialog';
import { Menu as BMenu } from '@base-ui/react/menu';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Icon } from '../components/icons';
import { Button, Dialog, DropdownMenu, EmptyState, ErrorState, Field, IconButton, Input, MenuItem, MenuSeparator, Select, Spinner, SubMenu } from '../components/ui';
import { UserMenu } from '../components/UserMenu';
import { api, errorMessage } from '../lib/api';
import { relativeTime } from '../lib/format';
import { DOC_COLORS, docColor } from './colors';

type View = 'recent' | 'mine' | 'shared' | 'starred' | 'trash';

interface Item {
  id: string;
  title: string;
  color: string;
  folderId: string | null;
  owner: { id: string; name: string };
  role: string;
  starred: boolean;
  updatedAt: string;
  openedAt: string | null;
  trashedAt: string | null;
}

interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  count: number;
}

const VIEWS: { id: View; label: string; empty: string; icon: React.ReactNode }[] = [
  { id: 'recent', label: 'Terakhir dibuka', empty: 'Spreadsheet yang Anda buka akan muncul di sini.', icon: <Icon.Recent size={17} /> },
  { id: 'mine', label: 'Milik saya', empty: 'Anda belum membuat spreadsheet.', icon: <Icon.Sheet size={17} /> },
  { id: 'shared', label: 'Dibagikan kepada saya', empty: 'Belum ada yang membagikan spreadsheet kepada Anda.', icon: <Icon.Users size={17} /> },
  { id: 'starred', label: 'Berbintang', empty: 'Beri bintang pada spreadsheet penting agar mudah ditemukan.', icon: <Icon.Star size={17} /> },
  { id: 'trash', label: 'Sampah', empty: 'Sampah kosong.', icon: <Icon.Trash size={17} /> },
];

function useLayoutPref() {
  const [layout, setLayout] = useState<'grid' | 'list'>(() => {
    try {
      // Grid with previews is the default; a saved choice of the list wins.
      return localStorage.getItem('opensheet-layout') === 'list' ? 'list' : 'grid';
    } catch {
      return 'grid';
    }
  });
  const set = (l: 'grid' | 'list') => {
    setLayout(l);
    try {
      localStorage.setItem('opensheet-layout', l);
    } catch {
      // Not persisted; the choice still applies now.
    }
  };
  return [layout, set] as const;
}

export default function Dashboard() {
  const { folderId } = useParams();
  const [params, setParams] = useSearchParams();
  const view = (folderId ? 'mine' : (params.get('view') as View | null) ?? 'recent') as View;
  const [q, setQ] = useState(params.get('q') ?? '');
  const [owner, setOwner] = useState('any');
  const [modified, setModified] = useState('any');
  const [layout, setLayout] = useLayoutPref();
  const [navOpen, setNavOpen] = useState(false);
  const nav = useNavigate();
  const qc = useQueryClient();

  // Debounce the search so typing does not fire a request per key.
  const [debouncedQ, setDebouncedQ] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  const listKey = ['workbooks', view, folderId ?? null, debouncedQ, owner, modified];
  const list = useQuery({
    queryKey: listKey,
    queryFn: () => {
      const sp = new URLSearchParams({ view: debouncedQ && view === 'recent' ? 'all' : view, owner, modified });
      if (debouncedQ) sp.set('q', debouncedQ);
      if (folderId) sp.set('folderId', folderId);
      return api.get<{ items: Item[] }>(`/api/workbooks?${sp}`);
    },
  });
  const folders = useQuery({ queryKey: ['folders'], queryFn: () => api.get<{ folders: Folder[] }>('/api/folders') });
  const folder = folders.data?.folders.find((f) => f.id === folderId);

  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>('/api/workbooks', { folderId: folderId ?? null }),
    onSuccess: (r) => nav(`/w/${r.id}`),
    onError: (e) => toast.error(errorMessage(e)),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['workbooks'] });
    qc.invalidateQueries({ queryKey: ['folders'] });
  };

  const heading = folder ? folder.name : debouncedQ ? `Hasil pencarian "${debouncedQ}"` : VIEWS.find((v) => v.id === view)!.label;
  const items = list.data?.items ?? [];

  const sidebar = (
    <Sidebar
      view={folderId ? null : view}
      folderId={folderId}
      folders={folders.data?.folders ?? []}
      onCreate={() => create.mutate()}
      creating={create.isPending}
      onNavigate={() => setNavOpen(false)}
      onFoldersChanged={refresh}
    />
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-64 shrink-0 border-r border-line bg-surface md:flex md:flex-col">{sidebar}</aside>
      <BDialog.Root open={navOpen} onOpenChange={setNavOpen}>
        <BDialog.Portal>
          <BDialog.Backdrop className="scrim fixed inset-0 z-40 bg-[var(--scrim)] md:hidden" />
          <BDialog.Popup className="fixed inset-y-0 left-0 z-50 flex w-[min(300px,86vw)] flex-col bg-surface shadow-pop outline-none transition-transform duration-[250ms] ease-[var(--ease-drawer)] data-starting-style:-translate-x-full data-ending-style:-translate-x-full md:hidden">
            <BDialog.Title className="sr-only">Navigasi</BDialog.Title>
            {sidebar}
          </BDialog.Popup>
        </BDialog.Portal>
      </BDialog.Root>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-line bg-surface px-3 py-2 md:px-6">
          <IconButton label="Buka navigasi" className="md:hidden" onClick={() => setNavOpen(true)} tooltip={false}>
            <Icon.Menu />
          </IconButton>
          <div className="relative min-w-0 flex-1 md:max-w-xl">
            <Icon.Search className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-2" />
            <Input
              type="search"
              aria-label="Cari spreadsheet"
              placeholder="Cari spreadsheet"
              className="pl-9"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                const sp = new URLSearchParams(params);
                if (e.target.value) sp.set('q', e.target.value);
                else sp.delete('q');
                setParams(sp, { replace: true });
              }}
            />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <UserMenu />
          </div>
        </header>

        <main className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-8">
          <div className="mx-auto max-w-6xl">
            <div className="flex flex-wrap items-end gap-3">
              <h1 className="mr-auto text-xl font-semibold text-ink">{heading}</h1>
              {view !== 'trash' && <ImportButton folderId={folderId} />}
              <Button variant="primary" className="md:hidden" onClick={() => create.mutate()} disabled={create.isPending}>
                <Icon.Plus /> Baru
              </Button>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor="f-owner">
                Pemilik
              </label>
              <span className="relative inline-flex items-center">
                <Icon.Users size={15} className="pointer-events-none absolute left-2.5 text-ink-2" />
                <Select id="f-owner" className="pl-8" value={owner} onChange={(e) => setOwner(e.target.value)}>
                  <option value="any">Semua pemilik</option>
                  <option value="me">Milik saya</option>
                  <option value="others">Milik orang lain</option>
                </Select>
              </span>
              <label className="sr-only" htmlFor="f-mod">
                Terakhir diubah
              </label>
              <span className="relative inline-flex items-center">
                <Icon.Recent size={15} className="pointer-events-none absolute left-2.5 text-ink-2" />
                <Select id="f-mod" className="pl-8" value={modified} onChange={(e) => setModified(e.target.value)}>
                  <option value="any">Kapan saja</option>
                  <option value="7">7 hari terakhir</option>
                  <option value="30">30 hari terakhir</option>
                  <option value="365">Tahun ini</option>
                </Select>
              </span>
              <div className="ml-auto flex rounded-md border border-line-2 bg-surface p-0.5" role="group" aria-label="Tampilan">
                <IconButton label="Tampilan daftar" active={layout === 'list'} onClick={() => setLayout('list')}>
                  <Icon.ListView />
                </IconButton>
                <IconButton label="Tampilan kisi" active={layout === 'grid'} onClick={() => setLayout('grid')}>
                  <Icon.GridView />
                </IconButton>
              </div>
            </div>

            <section className="mt-5" aria-live="polite" aria-busy={list.isLoading}>
              {list.isLoading ? (
                <div className="flex items-center gap-3 py-12 text-sm text-ink-2">
                  <Spinner /> Memuat spreadsheet
                </div>
              ) : list.isError ? (
                <ErrorState message={errorMessage(list.error)} onRetry={() => list.refetch()} />
              ) : items.length === 0 ? (
                <EmptyState
                  title={debouncedQ ? 'Tidak ada yang cocok' : 'Belum ada spreadsheet'}
                  body={debouncedQ ? 'Coba kata kunci lain atau ubah filter pemilik dan tanggal.' : (VIEWS.find((v) => v.id === view)?.empty ?? '')}
                  action={
                    view !== 'trash' && view !== 'shared' && !debouncedQ ? (
                      <Button variant="primary" onClick={() => create.mutate()} disabled={create.isPending}>
                        <Icon.Plus /> Spreadsheet baru
                      </Button>
                    ) : undefined
                  }
                />
              ) : layout === 'list' ? (
                <ListView items={items} view={view} folders={folders.data?.folders ?? []} onChanged={refresh} />
              ) : (
                <GridView items={items} view={view} folders={folders.data?.folders ?? []} onChanged={refresh} />
              )}
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}

function Sidebar({
  view,
  folderId,
  folders,
  onCreate,
  creating,
  onNavigate,
  onFoldersChanged,
}: {
  view: View | null;
  folderId?: string;
  folders: Folder[];
  onCreate: () => void;
  creating: boolean;
  onNavigate: () => void;
  onFoldersChanged: () => void;
}) {
  const [newFolder, setNewFolder] = useState(false);
  return (
    <div className="flex h-full flex-col">
      <div className="px-5 pt-5 pb-4">
        <Link to="/" className="text-lg font-semibold tracking-tight text-ink" onClick={onNavigate}>
          OpenSheet
        </Link>
      </div>
      <div className="px-4">
        <Button variant="primary" className="w-full justify-start" onClick={onCreate} disabled={creating}>
          {creating ? <Spinner className="border-white/40 border-t-white" /> : <Icon.Plus />}
          Spreadsheet baru
        </Button>
      </div>
      <nav aria-label="Dokumen" className="mt-4 flex flex-col gap-0.5 px-2">
        {VIEWS.map((v) => (
          <Link
            key={v.id}
            to={v.id === 'recent' ? '/' : `/?view=${v.id}`}
            onClick={onNavigate}
            aria-current={view === v.id ? 'page' : undefined}
            className={clsx(
              'flex h-9 items-center gap-3 rounded-md px-3 text-sm text-ink hover:bg-surface-2 max-md:h-11',
              view === v.id && 'bg-brand-soft font-medium',
            )}
          >
            <span className="text-ink-2">{v.icon}</span>
            {v.label}
          </Link>
        ))}
      </nav>
      <div className="mt-6 flex items-center justify-between px-5">
        <h2 className="text-xs font-medium text-ink-2">Folder</h2>
        <IconButton label="Folder baru" onClick={() => setNewFolder(true)}>
          <Icon.Plus size={14} />
        </IconButton>
      </div>
      <nav aria-label="Folder" className="scroll-thin mt-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-4">
        {folders.length === 0 && <p className="px-3 py-1 text-xs text-ink-2">Belum ada folder.</p>}
        {folders.map((f) => (
          <FolderLink key={f.id} folder={f} active={folderId === f.id} onNavigate={onNavigate} onChanged={onFoldersChanged} />
        ))}
      </nav>
      <NameDialog
        open={newFolder}
        onOpenChange={setNewFolder}
        title="Folder baru"
        label="Nama folder"
        initial=""
        submitLabel="Buat folder"
        onSubmit={async (name) => {
          await api.post('/api/folders', { name });
          onFoldersChanged();
        }}
      />
    </div>
  );
}

function FolderLink({ folder, active, onNavigate, onChanged }: { folder: Folder; active: boolean; onNavigate: () => void; onChanged: () => void }) {
  const [rename, setRename] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const nav = useNavigate();
  return (
    <div className={clsx('group flex items-center rounded-md hover:bg-surface-2', active && 'bg-brand-soft')}>
      <Link
        to={`/folders/${folder.id}`}
        onClick={onNavigate}
        aria-current={active ? 'page' : undefined}
        className="flex h-9 min-w-0 flex-1 items-center gap-2 px-3 text-sm text-ink max-md:h-11"
      >
        <Icon.Folder className="shrink-0 text-ink-2" />
        <span className="truncate">{folder.name}</span>
        <span className="tnum ml-auto text-xs text-ink-2">{folder.count}</span>
      </Link>
      <DropdownMenu
        label={`Tindakan folder ${folder.name}`}
        align="end"
        trigger={
          <button type="button" className="press mr-1 inline-flex size-7 items-center justify-center rounded text-ink-2 hover:bg-surface-3 max-md:size-11">
            <Icon.More />
          </button>
        }
      >
        <MenuItem onClick={() => setRename(true)}>Ganti nama</MenuItem>
        <MenuItem danger onClick={() => setConfirmDelete(true)}>
          Hapus folder
        </MenuItem>
      </DropdownMenu>
      <NameDialog
        open={rename}
        onOpenChange={setRename}
        title="Ganti nama folder"
        label="Nama folder"
        initial={folder.name}
        submitLabel="Simpan"
        onSubmit={async (name) => {
          await api.patch(`/api/folders/${folder.id}`, { name });
          onChanged();
        }}
      />
      <Dialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Hapus folder "${folder.name}"?`}
        description="Spreadsheet di dalamnya tidak dihapus. Spreadsheet akan dipindahkan ke luar folder."
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Batal</Button>
            <Button
              variant="danger"
              onClick={async () => {
                try {
                  await api.del(`/api/folders/${folder.id}`);
                  setConfirmDelete(false);
                  onChanged();
                  if (active) nav('/?view=mine');
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            >
              Hapus folder
            </Button>
          </>
        }
      />
    </div>
  );
}

export function NameDialog({
  open,
  onOpenChange,
  title,
  label,
  initial,
  submitLabel,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  label: string;
  initial: string;
  submitLabel: string;
  onSubmit: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setValue(initial);
      setError(null);
    }
  }, [open, initial]);
  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!value.trim()) return setError('Nama wajib diisi.');
    setBusy(true);
    try {
      await onSubmit(value.trim());
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Batal</Button>
          <Button variant="primary" onClick={() => submit()} disabled={busy}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form onSubmit={submit}>
        <Field label={label} htmlFor="name-input" error={error ?? undefined}>
          <Input id="name-input" value={value} onChange={(e) => setValue(e.target.value)} autoFocus maxLength={200} />
        </Field>
      </form>
    </Dialog>
  );
}

function useItemActions(item: Item, onChanged: () => void) {
  const [renaming, setRenaming] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const nav = useNavigate();
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      if (done) toast.success(done);
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return {
    renaming,
    setRenaming,
    confirmPurge,
    setConfirmPurge,
    open: () => nav(`/w/${item.id}`),
    star: () => run(() => api.patch(`/api/workbooks/${item.id}`, { starred: !item.starred })),
    color: (c: string) => run(() => api.patch(`/api/workbooks/${item.id}`, { color: c })),
    move: (folderId: string | null) => run(() => api.patch(`/api/workbooks/${item.id}`, { folderId }), folderId ? 'Dipindahkan ke folder' : 'Dikeluarkan dari folder'),
    duplicate: () => run(() => api.post(`/api/workbooks/${item.id}/duplicate`), 'Salinan dibuat'),
    trash: () => run(() => api.del(`/api/workbooks/${item.id}`), 'Dipindahkan ke sampah'),
    restore: () => run(() => api.post(`/api/workbooks/${item.id}/restore`), 'Dipulihkan'),
    purge: () => run(() => api.del(`/api/workbooks/${item.id}?permanent=1`), 'Dihapus permanen'),
    rename: (title: string) => api.patch(`/api/workbooks/${item.id}`, { title }).then(onChanged),
  };
}

function ItemMenu({ item, view, folders, onChanged, actions }: { item: Item; view: View; folders: Folder[]; onChanged: () => void; actions: ReturnType<typeof useItemActions> }) {
  void onChanged;
  const isOwner = item.role === 'owner';
  const canEdit = isOwner || item.role === 'editor' || item.role === 'manager';
  return (
    <DropdownMenu
      label={`Tindakan untuk ${item.title}`}
      align="end"
      trigger={
        <button type="button" className="press inline-flex size-8 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 max-md:size-11">
          <Icon.More />
        </button>
      }
    >
      {view === 'trash' ? (
        <>
          <MenuItem icon={<Icon.Restore size={15} />} onClick={actions.restore}>Pulihkan</MenuItem>
          <MenuItem icon={<Icon.Trash size={15} />} danger onClick={() => actions.setConfirmPurge(true)}>
            Hapus permanen
          </MenuItem>
        </>
      ) : (
        <>
          <MenuItem icon={<Icon.Sheet size={15} />} onClick={actions.open}>Buka</MenuItem>
          <MenuItem icon={<Icon.Open size={15} />} onClick={() => window.open(`/w/${item.id}`, '_blank', 'noopener')}>Buka di tab baru</MenuItem>
          <MenuSeparator />
          {canEdit && <MenuItem icon={<Icon.Pencil size={15} />} onClick={() => actions.setRenaming(true)}>Ganti nama</MenuItem>}
          {canEdit && (
            <SubMenu label="Warna dokumen">
              {DOC_COLORS.map((c) => (
                <BMenu.Item key={c.id} className="flex min-h-8 cursor-pointer items-center gap-3 px-3 py-1.5 outline-none data-highlighted:bg-brand-soft max-md:min-h-11" onClick={() => actions.color(c.id)}>
                  <span className="size-3.5 rounded-sm" style={{ background: c.hex }} />
                  <span className="flex-1">{c.label}</span>
                  {item.color === c.id && <Icon.Check size={14} />}
                </BMenu.Item>
              ))}
            </SubMenu>
          )}
          {isOwner && (
            <SubMenu label="Pindahkan ke folder">
              <MenuItem onClick={() => actions.move(null)} disabled={!item.folderId}>
                Tanpa folder
              </MenuItem>
              {folders.map((f) => (
                <MenuItem key={f.id} onClick={() => actions.move(f.id)} disabled={item.folderId === f.id}>
                  {f.name}
                </MenuItem>
              ))}
              {folders.length === 0 && <MenuItem disabled>Buat folder dari panel kiri</MenuItem>}
            </SubMenu>
          )}
          <MenuItem icon={<Icon.Copy size={15} />} onClick={actions.duplicate}>Buat salinan</MenuItem>
          <MenuItem icon={<Icon.Star size={15} filled={item.starred} />} onClick={actions.star}>{item.starred ? 'Hapus bintang' : 'Beri bintang'}</MenuItem>
          {isOwner && (
            <>
              <MenuSeparator />
              <MenuItem icon={<Icon.Trash size={15} />} danger onClick={actions.trash}>
                Pindahkan ke sampah
              </MenuItem>
            </>
          )}
        </>
      )}
    </DropdownMenu>
  );
}

function ItemDialogs({ item, actions }: { item: Item; actions: ReturnType<typeof useItemActions> }) {
  return (
    <>
      <NameDialog
        open={actions.renaming}
        onOpenChange={actions.setRenaming}
        title="Ganti nama spreadsheet"
        label="Judul"
        initial={item.title}
        submitLabel="Simpan"
        onSubmit={actions.rename}
      />
      <Dialog
        open={actions.confirmPurge}
        onOpenChange={actions.setConfirmPurge}
        title={`Hapus "${item.title}" secara permanen?`}
        description="Semua sheet, riwayat versi, dan komentar ikut terhapus. Tindakan ini tidak bisa dibatalkan."
        footer={
          <>
            <Button onClick={() => actions.setConfirmPurge(false)}>Batal</Button>
            <Button
              variant="danger"
              onClick={() => {
                actions.setConfirmPurge(false);
                actions.purge();
              }}
            >
              Hapus permanen
            </Button>
          </>
        }
      />
    </>
  );
}

const ROLE_LABEL: Record<string, string> = { owner: 'Pemilik', manager: 'Pengelola', editor: 'Editor', commenter: 'Komentator', viewer: 'Pembaca', link: 'Lewat tautan' };

function DocMark({ color }: { color: string }) {
  return <Icon.Sheet className="shrink-0" style={{ color: docColor(color) }} />;
}

function ListView({ items, view, folders, onChanged }: { items: Item[]; view: View; folders: Folder[]; onChanged: () => void }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="hidden grid-cols-[1fr_180px_160px_40px] gap-4 border-b border-line px-4 py-2 text-xs font-medium text-ink-2 md:grid">
        <span>Nama</span>
        <span>Pemilik</span>
        <span>{view === 'trash' ? 'Dihapus' : view === 'recent' ? 'Dibuka' : 'Diubah'}</span>
        <span className="sr-only">Tindakan</span>
      </div>
      <ul>
        {items.map((it) => (
          <ListRow key={it.id} item={it} view={view} folders={folders} onChanged={onChanged} />
        ))}
      </ul>
    </div>
  );
}

function ListRow({ item, view, folders, onChanged }: { item: Item; view: View; folders: Folder[]; onChanged: () => void }) {
  const actions = useItemActions(item, onChanged);
  const when = view === 'trash' ? item.trashedAt : view === 'recent' ? item.openedAt : item.updatedAt;
  const Title: ReactNode = (
    <>
      <DocMark color={item.color} />
      <span className="truncate font-medium text-ink">{item.title}</span>
      {item.starred && <Icon.Star filled size={13} className="shrink-0 text-accent" aria-label="Berbintang" />}
    </>
  );
  return (
    <li className="grid grid-cols-[1fr_40px] items-center gap-4 border-b border-line px-4 py-1.5 last:border-b-0 hover:bg-surface-2 md:grid-cols-[1fr_180px_160px_40px]">
      {view === 'trash' ? (
        <div className="flex min-h-9 min-w-0 items-center gap-3 text-sm">{Title}</div>
      ) : (
        <Link to={`/w/${item.id}`} className="flex min-h-9 min-w-0 items-center gap-3 rounded text-sm max-md:min-h-11">
          {Title}
        </Link>
      )}
      <span className="hidden truncate text-sm text-ink-2 md:block">{item.role === 'owner' ? 'Saya' : item.owner.name}</span>
      <span className="hidden text-sm text-ink-2 md:block">{when ? relativeTime(when) : '-'}</span>
      <div className="flex justify-end">
        <ItemMenu item={item} view={view} folders={folders} onChanged={onChanged} actions={actions} />
      </div>
      <p className="col-span-2 -mt-1 pb-1 pl-7 text-xs text-ink-2 md:hidden">
        {item.role === 'owner' ? 'Saya' : item.owner.name} · {when ? relativeTime(when) : '-'}
      </p>
      <ItemDialogs item={item} actions={actions} />
    </li>
  );
}

function GridView({ items, view, folders, onChanged }: { items: Item[]; view: View; folders: Folder[]; onChanged: () => void }) {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {items.map((it) => (
        <GridCard key={it.id} item={it} view={view} folders={folders} onChanged={onChanged} />
      ))}
    </ul>
  );
}

function GridCard({ item, view, folders, onChanged }: { item: Item; view: View; folders: Folder[]; onChanged: () => void }) {
  const actions = useItemActions(item, onChanged);
  const when = view === 'trash' ? item.trashedAt : item.updatedAt;
  const [thumbFailed, setThumbFailed] = useState(false);
  const preview = (
    <div className="relative aspect-[8/5] overflow-hidden border-b border-line bg-white">
      {thumbFailed ? (
        <div className="flex size-full items-center justify-center text-ink-3">
          <Icon.Sheet size={32} />
        </div>
      ) : (
        <img
          src={`/api/workbooks/${item.id}/thumbnail?v=${encodeURIComponent(item.updatedAt)}`}
          alt={`Pratinjau ${item.title}`}
          loading="lazy"
          decoding="async"
          draggable={false}
          className="size-full object-cover object-left-top"
          onError={() => setThumbFailed(true)}
        />
      )}
      {item.starred && (
        <span className="absolute top-2 left-2 inline-flex size-6 items-center justify-center rounded-full bg-surface/90 text-accent shadow-sm">
          <Icon.Star filled size={13} aria-label="Berbintang" />
        </span>
      )}
    </div>
  );
  return (
    <li className="group flex flex-col overflow-hidden rounded-lg border border-line bg-surface transition-colors duration-150 hover:border-line-2 focus-within:border-brand">
      {view === 'trash' ? (
        preview
      ) : (
        <Link to={`/w/${item.id}`} aria-label={`Buka ${item.title}`} tabIndex={-1}>
          {preview}
        </Link>
      )}
      <div className="flex items-start gap-2 p-3">
        <span className="mt-0.5">
          <DocMark color={item.color} />
        </span>
        <div className="min-w-0 flex-1">
          {view === 'trash' ? (
            <span className="block truncate text-sm font-medium text-ink">{item.title}</span>
          ) : (
            <Link to={`/w/${item.id}`} className="block truncate text-sm font-medium text-ink hover:underline">
              {item.title}
            </Link>
          )}
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-ink-2">
            {item.role !== 'owner' && <Icon.Users size={12} className="shrink-0" aria-label="Dibagikan" />}
            <span className="truncate">
              {item.role !== 'owner' ? `${item.owner.name} · ` : ''}
              {when ? relativeTime(when) : '-'}
            </span>
          </p>
        </div>
        <ItemMenu item={item} view={view} folders={folders} onChanged={onChanged} actions={actions} />
      </div>
      <ItemDialogs item={item} actions={actions} />
    </li>
  );
}

function ImportButton({ folderId }: { folderId?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  async function onFile(f: File) {
    const kind = /\.xlsx$/i.test(f.name) ? 'xlsx' : /\.ods$/i.test(f.name) ? 'ods' : /\.(csv|tsv|txt)$/i.test(f.name) ? 'csv' : null;
    if (!kind) return toast.error('Format yang didukung: .xlsx, .ods, .csv, .tsv');
    const fd = new FormData();
    fd.append('file', f);
    if (folderId) fd.append('folderId', folderId);
    setBusy(true);
    const t = toast.loading(`Mengimpor ${f.name}`);
    try {
      const r = await api.post<{ id: string }>(`/api/import/${kind}`, fd);
      toast.success('Impor selesai', { id: t });
      nav(`/w/${r.id}`);
    } catch (e) {
      toast.error(errorMessage(e), { id: t });
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".xlsx,.ods,.csv,.tsv,application/vnd.oasis.opendocument.spreadsheet,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />
      <Button onClick={() => input.current?.click()} disabled={busy}>
        <Icon.Upload /> Impor berkas
      </Button>
    </>
  );
}
