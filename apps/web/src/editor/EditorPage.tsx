import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useStore } from 'zustand';
import { Icon } from '../components/icons';
import { Button, Select, Spinner } from '../components/ui';
import { useMe } from '../lib/auth';
import { FormulaBar, MenuBar, SheetTabs, StatusBar, Toolbar, TopBar } from './chrome';
import { EditorContext, useCtrl, useEditor } from './context';
import { EditorController } from './controller';
import { EditorDialogs } from './dialogs';
import { Grid } from './Grid';
import { CommentsPanel, HistoryPanel } from './panels';

export default function EditorPage() {
  const { id } = useParams();
  const me = useMe();
  const ctrl = useMemo(() => new EditorController(id!), [id]);
  const loading = useStore(ctrl.store, (s) => s.loading);
  const loadError = useStore(ctrl.store, (s) => s.loadError);
  const title = useStore(ctrl.store, (s) => s.workbook?.title);

  useEffect(() => {
    if (me.isLoading) return;
    ctrl.guest = !me.data;
    void ctrl.load(me.data?.user ?? { id: 'guest', name: 'Tamu' });
    return () => ctrl.dispose();
  }, [ctrl, me.data, me.isLoading]);

  useEffect(() => {
    document.title = title ? `${title} - OpenSheet` : 'OpenSheet';
    return () => {
      document.title = 'OpenSheet';
    };
  }, [title]);

  if (loading === 'loading')
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-ink-2" role="status">
        <Spinner className="size-6" />
        Membuka spreadsheet
      </div>
    );
  if (loading === 'forbidden' || loading === 'error')
    return (
      <main className="flex h-full flex-col items-start justify-center gap-3 px-6 md:items-center">
        <h1 className="text-lg font-semibold text-ink">{loading === 'forbidden' ? 'Tidak dapat membuka spreadsheet' : 'Spreadsheet gagal dimuat'}</h1>
        <p className="max-w-md text-sm text-ink-2 md:text-center">
          {loading === 'forbidden'
            ? (loadError ?? 'Spreadsheet ini tidak ada, sudah dihapus, atau Anda tidak memiliki akses. Minta pemilik untuk membagikannya kepada Anda.')
            : loadError}
        </p>
        <div className="flex gap-2">
          {!me.data && (
            <Link to={`/login?next=${encodeURIComponent(window.location.pathname)}`} className="press inline-flex h-9 items-center rounded-md bg-brand px-3.5 text-sm font-medium text-brand-ink hover:bg-brand-hover max-md:h-11">
              Masuk untuk membuka
            </Link>
          )}
          {loading === 'error' && (
            <Button variant="primary" onClick={() => window.location.reload()}>
              Muat ulang
            </Button>
          )}
          <Link to="/" className="press inline-flex h-9 items-center rounded-md border border-line-2 bg-surface px-3.5 text-sm font-medium hover:bg-surface-2 max-md:h-11">
            Kembali ke dasbor
          </Link>
        </div>
      </main>
    );

  return (
    <EditorContext.Provider value={ctrl}>
      <EditorShell />
    </EditorContext.Provider>
  );
}

function EditorShell() {
  const panel = useEditor((s) => s.panel);
  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg">
      <TopBar />
      <MenuBar />
      <div className="max-md:hidden">
        <Toolbar />
      </div>
      <FormulaBar />
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <Grid />
        </div>
        {panel === 'history' && <HistoryPanel />}
        {panel === 'comments' && <CommentsPanel />}
      </div>
      <div className="max-md:hidden">
        <SheetTabs />
        <StatusBar />
      </div>
      <MobileBar />
      <EditorDialogs />
    </div>
  );
}

/** Phone layout: compact sheet switcher plus menu and format panels (PRD 5.4). */
function MobileBar() {
  const ctrl = useCtrl();
  useEditor((s) => s.version);
  const active = useEditor((s) => s.activeSheetId);
  const can = useEditor((s) => s.can);
  const [, force] = useState(0);
  return (
    <div className="flex items-center gap-2 border-t border-line bg-surface px-2 py-1.5 pb-[max(6px,env(safe-area-inset-bottom))] md:hidden">
      <button type="button" aria-label="Menu" className="press inline-flex size-11 shrink-0 items-center justify-center rounded-md border border-line-2" onClick={() => ctrl.set({ dialog: 'mobileMenu' })}>
        <Icon.Menu />
      </button>
      {can.edit && (
        <button type="button" className="press inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md border border-line-2 px-3 text-sm" onClick={() => ctrl.set({ dialog: 'mobileFormat' })}>
          <span className="font-bold">B</span>
          <span className="font-serif italic">I</span> Format
        </button>
      )}
      <label className="sr-only" htmlFor="m-sheet">
        Sheet
      </label>
      <Select
        id="m-sheet"
        className="min-w-0 flex-1"
        value={active}
        onChange={(e) => {
          if (e.target.value === '__new') {
            void ctrl.addSheet().then(() => force((n) => n + 1));
            return;
          }
          ctrl.setActiveSheet(e.target.value);
        }}
      >
        {ctrl.model.sheets.map((s) => (
          <option key={s.id} value={s.id}>
            {s.title}
          </option>
        ))}
        {can.edit && <option value="__new">+ Sheet baru</option>}
      </Select>
    </div>
  );
}
