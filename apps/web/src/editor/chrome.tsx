import { Menu as BMenu } from '@base-ui/react/menu';
import { Menubar } from '@base-ui/react/menubar';
import { formatA1, formatRangeA1, isError, parseA1, parseRangeA1 } from '@opensheet/engine';
import clsx from 'clsx';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { BorderGlyph, Icon } from '../components/icons';
import { Avatar, Button, Dialog, DropdownMenu, gridFocusTarget, IconButton, MenuItem, MenuSeparator, menuItemClass, menuPopupClass, SubMenu } from '../components/ui';
import { UserMenu } from '../components/UserMenu';
import { api, errorMessage } from '../lib/api';
import { relativeTime } from '../lib/format';
import { useTheme } from '../lib/theme';
import { ColorPicker } from './ColorPicker';
import { isMobile, useCtrl, useEditor } from './context';
import { roleLabel } from './controller';
import { applySuggestion, AssistPanel, useFormulaAssist } from './formulaAssist';
import { highlightFormula } from './FormulaHighlight';

// ---------- top bar ----------

export function TopBar() {
  const ctrl = useCtrl();
  const wb = useEditor((s) => s.workbook)!;
  const can = useEditor((s) => s.can);
  const role = useEditor((s) => s.role);
  const presence = useEditor((s) => s.presence);
  const panel = useEditor((s) => s.panel);
  const comments = useEditor((s) => s.comments);
  const [title, setTitle] = useState(wb.title);
  useEffect(() => setTitle(wb.title), [wb.title]);
  const others = uniqueBy(presence.filter((p) => p.userId !== ctrl.userId), (p) => p.userId);
  const open = comments.filter((c) => !c.resolved).length;

  const saveTitle = async () => {
    const t = title.trim();
    if (!t || t === wb.title) return setTitle(wb.title);
    try {
      await ctrl.renameWorkbook(t);
    } catch (e) {
      toast.error(errorMessage(e));
      setTitle(wb.title);
    }
  };

  return (
    <header className="flex items-center gap-2 border-b border-line bg-surface px-2 py-1.5 md:px-3">
      <Link to="/" className="press shrink-0 rounded-md px-1.5 py-1 text-[15px] font-semibold tracking-tight text-ink hover:bg-surface-2 max-md:hidden" aria-label="Kembali ke dasbor">
        OpenSheet
      </Link>
      <Link to="/" className="press inline-flex size-11 items-center justify-center rounded-md text-ink-2 md:hidden" aria-label="Kembali ke dasbor">
        <Icon.ChevronLeft />
      </Link>
      <div className="flex min-w-0 flex-1 items-center gap-1">
        {can.edit ? (
          <input
            aria-label="Judul spreadsheet"
            className="h-8 min-w-0 max-w-[420px] flex-1 truncate rounded border border-transparent bg-transparent px-1.5 text-[15px] font-medium text-ink hover:border-line focus:border-brand focus:outline-none max-md:h-11"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                setTitle(wb.title);
                e.currentTarget.blur();
              }
            }}
            maxLength={200}
          />
        ) : (
          <h1 className="truncate px-1.5 text-[15px] font-medium text-ink">{wb.title}</h1>
        )}
        {!ctrl.guest && <IconButton className="max-sm:hidden" label={wb.starred ? 'Hapus bintang' : 'Beri bintang'} onClick={() => ctrl.toggleStar().catch((e) => toast.error(errorMessage(e)))}>
          <Icon.Star filled={wb.starred} className={wb.starred ? 'text-accent' : undefined} />
        </IconButton>}
        <SaveStatus />
      </div>
      {!can.edit && <span className="hidden rounded border border-line px-2 py-0.5 text-xs text-ink-2 sm:inline">{roleLabel(role)}</span>}
      <div className="hidden items-center -space-x-1.5 sm:flex" aria-label={`${others.length} orang lain sedang membuka`}>
        {others.slice(0, 4).map((p) => (
          <span key={p.userId} title={p.name} className="rounded-full ring-2 ring-surface">
            <Avatar name={p.name} color={p.color} size={28} />
          </span>
        ))}
        {others.length > 4 && <span className="tnum pl-2 text-xs text-ink-2">+{others.length - 4}</span>}
      </div>
      <IconButton label={`Komentar${open ? ` (${open})` : ''}`} active={panel === 'comments'} onClick={() => ctrl.set({ panel: panel === 'comments' ? null : 'comments' })}>
        <span className="relative">
          <Icon.Comment />
          {open > 0 && <span className="absolute -top-1 -right-1.5 size-2 rounded-full bg-accent" />}
        </span>
      </IconButton>
      <IconButton className="max-md:hidden" label="Riwayat versi" active={panel === 'history'} onClick={() => ctrl.set({ panel: panel === 'history' ? null : 'history' })}>
        <Icon.History />
      </IconButton>
      {!ctrl.guest && <button
        type="button"
        className="press inline-flex h-9 items-center gap-2 rounded-md bg-brand px-3 text-sm font-medium text-brand-ink hover:bg-brand-hover max-md:size-11 max-md:justify-center max-md:px-0"
        onClick={() => ctrl.set({ dialog: 'share' })}
        aria-label="Bagikan"
      >
        <Icon.Share />
        <span className="max-md:hidden">Bagikan</span>
      </button>}
      {ctrl.guest ? (
        <Link
          to={`/login?next=${encodeURIComponent(window.location.pathname)}`}
          className="press inline-flex h-9 items-center rounded-md border border-line-2 px-3 text-sm font-medium hover:bg-surface-2 max-md:h-11"
        >
          Masuk
        </Link>
      ) : (
        <UserMenu />
      )}
    </header>
  );
}

function uniqueBy<T>(list: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return list.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
}

function SaveStatus() {
  const status = useEditor((s) => s.status);
  const detail = useEditor((s) => s.statusDetail);
  const at = useEditor((s) => s.lastEditedAt);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const map = {
    saved: { icon: <Icon.Cloud />, text: at ? `Tersimpan ${relativeTime(at)}` : 'Tersimpan', cls: 'text-ink-2' },
    saving: { icon: <Icon.Cloud />, text: 'Menyimpan...', cls: 'text-ink-2' },
    offline: { icon: <Icon.CloudOff />, text: 'Offline, disimpan saat tersambung', cls: 'text-accent' },
    error: { icon: <Icon.Warning />, text: 'Gagal menyimpan', cls: 'text-danger' },
    conflict: { icon: <Icon.Warning />, text: 'Konflik terdeteksi', cls: 'text-accent' },
  } as const;
  const m = map[status];
  return (
    <span role="status" aria-live="polite" title={detail} className={clsx('ml-1 inline-flex min-w-0 items-center gap-1.5 text-xs whitespace-nowrap', m.cls)}>
      <span className="shrink-0">{m.icon}</span>
      <span className="truncate max-sm:sr-only">{m.text}</span>
    </span>
  );
}

// ---------- menu bar ----------

const NUMBER_FORMATS: [string, string, string][] = [
  ['auto', 'Otomatis', ''],
  ['number', 'Angka', '1,000.12'],
  ['integer', 'Bilangan bulat', '1,000'],
  ['currency', 'Rupiah', 'Rp1,000'],
  ['currency2', 'Rupiah dengan sen', 'Rp1,000.12'],
  ['percent', 'Persen', '10.12%'],
  ['date', 'Tanggal', '07/11/2026'],
  ['date_long', 'Tanggal panjang', '7 November 2026'],
  ['time', 'Waktu', '13:30:00'],
  ['datetime', 'Tanggal dan waktu', '07/11/2026 13:30'],
  ['text', 'Teks biasa', ''],
];

function MenuTrigger({ children }: { children: ReactNode }) {
  return (
    <BMenu.Trigger className="h-7 rounded px-2.5 text-[13px] text-ink outline-none select-none hover:bg-surface-2 focus-visible:bg-surface-2 data-popup-open:bg-surface-2">{children}</BMenu.Trigger>
  );
}

function MenuPanel({ children }: { children: ReactNode }) {
  return (
    <BMenu.Portal>
      <BMenu.Positioner sideOffset={2} align="start" className="z-50 outline-none">
        <BMenu.Popup className={menuPopupClass} finalFocus={gridFocusTarget}>
          {children}
        </BMenu.Popup>
      </BMenu.Positioner>
    </BMenu.Portal>
  );
}

function Check({ on, children, onClick, disabled }: { on: boolean; children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <BMenu.Item className={menuItemClass} onClick={onClick} disabled={disabled}>
      <span className="w-4">{on && <Icon.Check size={14} />}</span>
      <span className="flex-1">{children}</span>
    </BMenu.Item>
  );
}

export function useWorkbookActions() {
  const ctrl = useCtrl();
  const nav = useNavigate();
  const download = (kind: 'xlsx' | 'ods' | 'csv' | 'tsv' | 'pdf') => {
    const sid = ctrl.s.activeSheetId;
    const q = kind === 'csv' || kind === 'tsv' ? `?sheetId=${sid}` : '';
    // Flush first so the download includes the latest edits.
    void ctrl.sync.flushNow().then(() => {
      const a = document.createElement('a');
      a.href = `/api/workbooks/${ctrl.workbookId}/export/${kind}${q}`;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  };
  return {
    download,
    newWorkbook: async () => {
      try {
        const r = await api.post<{ id: string }>('/api/workbooks', {});
        window.open(`/w/${r.id}`, '_blank', 'noopener');
      } catch (e) {
        toast.error(errorMessage(e));
      }
    },
    duplicate: async () => {
      try {
        await ctrl.sync.flushNow();
        const r = await api.post<{ id: string }>(`/api/workbooks/${ctrl.workbookId}/duplicate`, {});
        toast.success('Salinan dibuat');
        nav(`/w/${r.id}`);
      } catch (e) {
        toast.error(errorMessage(e));
      }
    },
    trash: async () => {
      try {
        await ctrl.sync.flushNow();
        await api.del(`/api/workbooks/${ctrl.workbookId}`);
        toast.success('Dipindahkan ke sampah');
        nav('/');
      } catch (e) {
        toast.error(errorMessage(e));
      }
    },
  };
}

export function MenuBar() {
  const ctrl = useCtrl();
  const can = useEditor((s) => s.can);
  const canUndo = useEditor((s) => s.canUndo);
  const canRedo = useEditor((s) => s.canRedo);
  const showFormulas = useEditor((s) => s.showFormulas);
  const tempFilter = useEditor((s) => s.tempFilter);
  useEditor((s) => s.version);
  useEditor((s) => s.selection);
  const sheet = ctrl.sheet()!;
  const a = ctrl.s.selection.anchor;
  const actions = useWorkbookActions();
  const { pref, setTheme } = useTheme();
  useEditor((s) => s.tempFilter);
  const hasFilter = !!ctrl.activeFilter();
  const ro = !can.edit;
  const after = () => window.dispatchEvent(new Event('opensheet:focus-grid'));
  const M = ({ children, onClick, disabled, shortcut, danger, icon }: { children: ReactNode; onClick: () => void; disabled?: boolean; shortcut?: string; danger?: boolean; icon?: ReactNode }) => (
    <MenuItem
      onClick={() => {
        onClick();
        after();
      }}
      disabled={disabled}
      shortcut={shortcut}
      danger={danger}
      icon={icon ?? null}
    >
      {children}
    </MenuItem>
  );

  return (
    <Menubar className="flex items-center gap-0.5 overflow-x-auto px-2 py-0.5 max-md:hidden" aria-label="Menu">
      <BMenu.Root>
        <MenuTrigger>File</MenuTrigger>
        <MenuPanel>
          <M icon={<Icon.Plus size={15} />} onClick={actions.newWorkbook}>Spreadsheet baru</M>
          <M icon={<Icon.Copy size={15} />} onClick={actions.duplicate}>Buat salinan</M>
          <M icon={<Icon.Upload size={15} />} onClick={() => ctrl.set({ dialog: 'import' })} disabled={ro}>
            Impor berkas
          </M>
          <SubMenu icon={<Icon.Download size={15} />} label="Unduh">
            <M onClick={() => actions.download('xlsx')}>Microsoft Excel (.xlsx)</M>
            <M onClick={() => actions.download('ods')}>OpenDocument (.ods)</M>
            <M onClick={() => actions.download('csv')}>CSV, sheet aktif (.csv)</M>
            <M onClick={() => actions.download('tsv')}>TSV, sheet aktif (.tsv)</M>
            <M onClick={() => actions.download('pdf')}>PDF (.pdf)</M>
          </SubMenu>
          {!ctrl.guest && <M onClick={() => ctrl.set({ dialog: 'files' })}>Berkas asli impor</M>}
          <MenuSeparator />
          <M icon={<Icon.Share size={15} />} onClick={() => ctrl.set({ dialog: 'share' })}>Bagikan</M>
          <M icon={<Icon.History size={15} />} onClick={() => ctrl.set({ panel: 'history' })}>Riwayat versi</M>
          {can.own && (
            <>
              <MenuSeparator />
              <M icon={<Icon.Trash size={15} />} onClick={actions.trash} danger>
                Pindahkan ke sampah
              </M>
            </>
          )}
        </MenuPanel>
      </BMenu.Root>
      <BMenu.Root>
        <MenuTrigger>Edit</MenuTrigger>
        <MenuPanel>
          <M icon={<Icon.Undo size={15} />} onClick={() => ctrl.undo()} disabled={!canUndo || ro} shortcut="Ctrl+Z">
            Urungkan
          </M>
          <M icon={<Icon.Redo size={15} />} onClick={() => ctrl.redo()} disabled={!canRedo || ro} shortcut="Ctrl+Y">
            Ulangi
          </M>
          <MenuSeparator />
          <M icon={<Icon.Cut size={15} />} onClick={() => clipboardAction(ctrl, 'cut')} disabled={ro} shortcut="Ctrl+X">
            Potong
          </M>
          <M icon={<Icon.Copy size={15} />} onClick={() => clipboardAction(ctrl, 'copy')} shortcut="Ctrl+C">
            Salin
          </M>
          <M icon={<Icon.Paste size={15} />} onClick={() => clipboardAction(ctrl, 'paste')} disabled={ro} shortcut="Ctrl+V">
            Tempel
          </M>
          <M onClick={() => ctrl.paste(null, { valuesOnly: true })} disabled={ro || !ctrl.s.copyRange}>
            Tempel nilai saja
          </M>
          <M onClick={() => ctrl.paste(null, { formatOnly: true })} disabled={ro || !ctrl.s.copyRange}>
            Tempel format saja
          </M>
          <MenuSeparator />
          <M icon={<Icon.Eraser size={15} />} onClick={() => ctrl.clearContents()} disabled={ro} shortcut="Del">
            Hapus isi
          </M>
          <M onClick={() => ctrl.deleteRows()} disabled={ro}>
            Hapus baris terpilih
          </M>
          <M onClick={() => ctrl.deleteCols()} disabled={ro}>
            Hapus kolom terpilih
          </M>
          <MenuSeparator />
          <M icon={<Icon.Search size={15} />} onClick={() => ctrl.set({ dialog: 'find', findOpenReplace: !ro })} shortcut="Ctrl+H">
            Cari dan ganti
          </M>
        </MenuPanel>
      </BMenu.Root>
      <BMenu.Root>
        <MenuTrigger>Tampilan</MenuTrigger>
        <MenuPanel>
          <SubMenu icon={<Icon.Freeze size={15} />} label="Bekukan" disabled={ro}>
            <Check on={sheet.frozenRows === 0} onClick={() => ctrl.freeze(0, null)}>
              Tanpa baris
            </Check>
            <Check on={sheet.frozenRows === 1} onClick={() => ctrl.freeze(1, null)}>
              1 baris
            </Check>
            <Check on={sheet.frozenRows === 2} onClick={() => ctrl.freeze(2, null)}>
              2 baris
            </Check>
            <Check on={sheet.frozenRows === a.row + 1 && a.row > 1} onClick={() => ctrl.freeze(a.row + 1, null)}>
              Sampai baris {a.row + 1}
            </Check>
            <MenuSeparator />
            <Check on={sheet.frozenColumns === 0} onClick={() => ctrl.freeze(null, 0)}>
              Tanpa kolom
            </Check>
            <Check on={sheet.frozenColumns === 1} onClick={() => ctrl.freeze(null, 1)}>
              1 kolom
            </Check>
            <Check on={sheet.frozenColumns === 2} onClick={() => ctrl.freeze(null, 2)}>
              2 kolom
            </Check>
            <Check on={sheet.frozenColumns === a.col + 1 && a.col > 1} onClick={() => ctrl.freeze(null, a.col + 1)}>
              Sampai kolom {formatA1(0, a.col).replace(/\d+/, '')}
            </Check>
          </SubMenu>
          <Check on={sheet.metadata.showGridlines !== false} onClick={() => ctrl.patchSheet(sheet.id, { metadata: { showGridlines: sheet.metadata.showGridlines === false } }, 'Garis kisi')} disabled={ro}>
            Garis kisi
          </Check>
          <Check on={showFormulas} onClick={() => ctrl.set({ showFormulas: !showFormulas })}>
            Tampilkan formula
          </Check>
          <MenuSeparator />
          <SubMenu icon={<Icon.Sun size={15} />} label="Tema">
            <Check on={pref === 'system'} onClick={() => setTheme('system')}>
              Ikuti sistem
            </Check>
            <Check on={pref === 'light'} onClick={() => setTheme('light')}>
              Terang
            </Check>
            <Check on={pref === 'dark'} onClick={() => setTheme('dark')}>
              Gelap
            </Check>
          </SubMenu>
        </MenuPanel>
      </BMenu.Root>
      <BMenu.Root>
        <MenuTrigger>Sisipkan</MenuTrigger>
        <MenuPanel>
          <M onClick={() => ctrl.insertRows('above')} disabled={ro}>
            Baris di atas
          </M>
          <M onClick={() => ctrl.insertRows('below')} disabled={ro}>
            Baris di bawah
          </M>
          <M onClick={() => ctrl.insertCols('left')} disabled={ro}>
            Kolom di kiri
          </M>
          <M onClick={() => ctrl.insertCols('right')} disabled={ro}>
            Kolom di kanan
          </M>
          <MenuSeparator />
          <M onClick={() => ctrl.addSheet().catch((e) => toast.error(errorMessage(e)))} disabled={ro}>
            Sheet baru
          </M>
          <M icon={<Icon.Link size={15} />} onClick={() => ctrl.set({ dialog: 'link' })} disabled={ro} shortcut="Ctrl+K">
            Tautan
          </M>
          <M icon={<Icon.Comment size={15} />} onClick={() => ctrl.openCommentDraft()} disabled={!can.comment}>
            Komentar
          </M>
          <MenuSeparator />
          <M icon={<Icon.ChartColumn size={15} />} onClick={() => ctrl.insertChart()} disabled={ro}>
            Bagan
          </M>
          <M onClick={() => insertCheckbox(ctrl)} disabled={ro}>
            Kotak centang
          </M>
          <M onClick={() => ctrl.set({ dialog: 'validation' })} disabled={ro}>
            Dropdown
          </M>
          <M onClick={() => ctrl.set({ dialog: 'functions' })}>Fungsi</M>
        </MenuPanel>
      </BMenu.Root>
      <BMenu.Root>
        <MenuTrigger>Format</MenuTrigger>
        <MenuPanel>
          <SubMenu icon={null} label="Angka" disabled={ro}>
            {NUMBER_FORMATS.map(([id, label, sample]) => (
              <BMenu.Item key={id} className={menuItemClass} onClick={() => (ctrl.applyStyle({ numberFormat: id === 'auto' ? undefined : id }, 'Format angka'), after())}>
                <span className="flex-1">{label}</span>
                <span className="addr text-xs text-ink-2">{sample}</span>
              </BMenu.Item>
            ))}
            <MenuSeparator />
            <M onClick={() => ctrl.set({ dialog: 'formatCells' })}>Format kustom</M>
          </SubMenu>
          <SubMenu icon={null} label="Teks" disabled={ro}>
            <M onClick={() => ctrl.toggleStyle('bold')} shortcut="Ctrl+B">
              Tebal
            </M>
            <M onClick={() => ctrl.toggleStyle('italic')} shortcut="Ctrl+I">
              Miring
            </M>
            <M onClick={() => ctrl.toggleStyle('underline')} shortcut="Ctrl+U">
              Garis bawah
            </M>
            <M onClick={() => ctrl.toggleStyle('strike')} shortcut="Ctrl+5">
              Coret
            </M>
          </SubMenu>
          <SubMenu icon={<Icon.AlignLeft size={15} />} label="Perataan" disabled={ro}>
            <M onClick={() => ctrl.applyStyle({ hAlign: 'left' })} shortcut="Ctrl+Shift+L">Kiri</M>
            <M onClick={() => ctrl.applyStyle({ hAlign: 'center' })} shortcut="Ctrl+Shift+E">Tengah</M>
            <M onClick={() => ctrl.applyStyle({ hAlign: 'right' })} shortcut="Ctrl+Shift+R">Kanan</M>
            <MenuSeparator />
            <M onClick={() => ctrl.applyStyle({ vAlign: 'top' })}>Atas</M>
            <M onClick={() => ctrl.applyStyle({ vAlign: 'middle' })}>Tengah vertikal</M>
            <M onClick={() => ctrl.applyStyle({ vAlign: 'bottom' })}>Bawah</M>
          </SubMenu>
          <M onClick={() => ctrl.toggleStyle('wrap')} disabled={ro}>
            Bungkus teks
          </M>
          <MenuSeparator />
          <M icon={<Icon.Merge size={15} />} onClick={() => ctrl.merge()} disabled={ro}>
            Gabungkan sel
          </M>
          <M onClick={() => ctrl.unmerge()} disabled={ro}>
            Pisahkan sel
          </M>
          <MenuSeparator />
          <M onClick={() => ctrl.set({ dialog: 'formatCells' })} disabled={ro}>
            Format sel
          </M>
          <M onClick={() => ctrl.set({ dialog: 'conditional' })} disabled={ro}>
            Format bersyarat
          </M>
          <M onClick={() => ctrl.clearFormatting()} disabled={ro} shortcut="Ctrl+\">
            Hapus format
          </M>
        </MenuPanel>
      </BMenu.Root>
      <BMenu.Root>
        <MenuTrigger>Data</MenuTrigger>
        <MenuPanel>
          <M icon={<Icon.SortAsc size={15} />} onClick={() => ctrl.sortSelection(true)} disabled={ro}>
            Urutkan A ke Z
          </M>
          <M icon={<Icon.SortDesc size={15} />} onClick={() => ctrl.sortSelection(false)} disabled={ro}>
            Urutkan Z ke A
          </M>
          <M onClick={() => ctrl.set({ dialog: 'sort' })} disabled={ro}>
            Urutkan rentang
          </M>
          <MenuSeparator />
          <M icon={<Icon.Filter size={15} />} onClick={() => ctrl.createFilter()}>
            {hasFilter ? 'Hapus filter' : 'Buat filter'}
          </M>
          <SubMenu icon={<Icon.Filter size={15} />} label="Tampilan filter">
            <Check on={!tempFilter} onClick={() => ctrl.applyFilterView(null)}>
              Filter bersama
            </Check>
            {(sheet.metadata.filterViews ?? []).map((v) => (
              <Check key={v.id} on={tempFilter?.name === v.name} onClick={() => ctrl.applyFilterView(v.id)}>
                {v.name}
              </Check>
            ))}
            <MenuSeparator />
            <M onClick={() => ctrl.set({ dialog: 'filterViews' })} disabled={ro || !ctrl.activeFilter()}>
              Simpan sebagai tampilan filter
            </M>
          </SubMenu>
          <MenuSeparator />
          <M onClick={() => ctrl.set({ dialog: 'validation' })} disabled={ro}>
            Validasi data
          </M>
          <M onClick={() => ctrl.set({ dialog: 'dedupe' })} disabled={ro}>
            Hapus duplikat
          </M>
          <M onClick={() => ctrl.set({ dialog: 'split' })} disabled={ro}>
            Pisahkan teks ke kolom
          </M>
          <M icon={<Icon.Lock size={15} />} onClick={() => ctrl.set({ dialog: 'protect' })} disabled={!can.manage}>
            Sheet dan rentang dilindungi
          </M>
        </MenuPanel>
      </BMenu.Root>
      <BMenu.Root>
        <MenuTrigger>Alat</MenuTrigger>
        <MenuPanel>
          <M onClick={() => ctrl.set({ dialog: 'protect' })} disabled={!can.manage}>
            Lindungi sheet dan rentang
          </M>
          <M onClick={() => ctrl.set({ panel: 'history' })}>Riwayat versi</M>
          <M onClick={() => ctrl.set({ panel: 'comments' })}>Komentar</M>
        </MenuPanel>
      </BMenu.Root>
      <BMenu.Root>
        <MenuTrigger>Bantuan</MenuTrigger>
        <MenuPanel>
          <M onClick={() => ctrl.set({ dialog: 'shortcuts' })} shortcut="Ctrl+/">
            Pintasan keyboard
          </M>
          <M onClick={() => ctrl.set({ dialog: 'functions' })}>Daftar fungsi</M>
        </MenuPanel>
      </BMenu.Root>
    </Menubar>
  );
}

export function insertCheckbox(ctrl: ReturnType<typeof useCtrl>) {
  const r = ctrl.selectionRange();
  const sheet = ctrl.sheet()!;
  const range = formatRangeA1(r);
  const items = [...sheet.validations.filter((v) => v.range !== range), { id: '', range, rule: { kind: 'checkbox' as const } }];
  ctrl.saveValidations(items, true).then(
    () => toast.success(`Kotak centang ditambahkan di ${range}`),
    (e) => toast.error(errorMessage(e)),
  );
}

export async function clipboardAction(ctrl: ReturnType<typeof useCtrl>, kind: 'cut' | 'copy' | 'paste') {
  if (kind === 'paste') {
    let text: string | null = null;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = null;
    }
    if (text === null && !ctrl.s.copyRange) return void toast.message('Browser memblokir akses papan klip. Gunakan Ctrl+V.');
    ctrl.paste(text);
    return;
  }
  const t = ctrl.copy(kind === 'cut');
  try {
    await navigator.clipboard.writeText(t);
  } catch {
    /* internal clipboard still works */
  }
}

// ---------- toolbar ----------

const FONTS = ['IBM Plex Sans', 'Arial', 'Calibri', 'Times New Roman', 'Georgia', 'Courier New', 'Verdana'];
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 24, 30, 36];

function Divider() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden="true" />;
}

export function Toolbar() {
  const ctrl = useCtrl();
  const can = useEditor((s) => s.can);
  const canUndo = useEditor((s) => s.canUndo);
  const canRedo = useEditor((s) => s.canRedo);
  useEditor((s) => s.selection);
  useEditor((s) => s.version);
  const st = ctrl.activeStyle();
  const ro = !can.edit;
  const after = () => window.dispatchEvent(new Event('opensheet:focus-grid'));
  useEditor((s) => s.tempFilter);
  const hasFilter = !!ctrl.activeFilter();
  const selectCls = 'h-8 rounded border border-transparent bg-transparent px-1.5 text-[13px] text-ink hover:border-line focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-40 max-md:h-11';

  return (
    <div role="toolbar" aria-label="Format" className="scroll-thin flex items-center gap-0.5 overflow-x-auto border-b border-line bg-surface px-2 py-1">
      <IconButton label="Urungkan" shortcut="Ctrl+Z" onClick={() => ctrl.undo()} disabled={!canUndo || ro}>
        <Icon.Undo />
      </IconButton>
      <IconButton label="Ulangi" shortcut="Ctrl+Y" onClick={() => ctrl.redo()} disabled={!canRedo || ro}>
        <Icon.Redo />
      </IconButton>
      <Divider />
      <IconButton label="Format Rupiah" onClick={() => (ctrl.applyStyle({ numberFormat: 'currency' }, 'Format angka'), after())} disabled={ro}>
        <span className="text-[12px] font-semibold">Rp</span>
      </IconButton>
      <IconButton label="Format persen" onClick={() => (ctrl.applyStyle({ numberFormat: 'percent' }, 'Format angka'), after())} disabled={ro}>
        <span className="text-[13px] font-semibold">%</span>
      </IconButton>
      <IconButton label="Kurangi desimal" onClick={() => (ctrl.changeDecimals(-1), after())} disabled={ro}>
        <span className="addr text-[11px]">.0</span>
      </IconButton>
      <IconButton label="Tambah desimal" onClick={() => (ctrl.changeDecimals(1), after())} disabled={ro}>
        <span className="addr text-[11px]">.00</span>
      </IconButton>
      <label className="sr-only" htmlFor="tb-numfmt">
        Format angka
      </label>
      <select
        id="tb-numfmt"
        className={clsx(selectCls, 'w-28')}
        disabled={ro}
        value={NUMBER_FORMATS.some(([id]) => id === (st.numberFormat ?? 'auto')) ? st.numberFormat ?? 'auto' : 'custom'}
        onChange={(e) => {
          if (e.target.value === 'custom') ctrl.set({ dialog: 'formatCells' });
          else ctrl.applyStyle({ numberFormat: e.target.value === 'auto' ? undefined : e.target.value }, 'Format angka');
          after();
        }}
      >
        {NUMBER_FORMATS.map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
        <option value="custom">Kustom...</option>
      </select>
      <Divider />
      <label className="sr-only" htmlFor="tb-font">
        Jenis huruf
      </label>
      <select id="tb-font" className={clsx(selectCls, 'w-32')} disabled={ro} value={st.fontFamily ?? 'IBM Plex Sans'} onChange={(e) => (ctrl.applyStyle({ fontFamily: e.target.value === 'IBM Plex Sans' ? undefined : e.target.value }), after())}>
        {FONTS.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
      <label className="sr-only" htmlFor="tb-size">
        Ukuran huruf
      </label>
      <select id="tb-size" className={clsx(selectCls, 'w-16 tnum')} disabled={ro} value={st.fontSize ?? 10} onChange={(e) => (ctrl.applyStyle({ fontSize: Number(e.target.value) === 10 ? undefined : Number(e.target.value) }), after())}>
        {SIZES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <Divider />
      <IconButton label="Tebal" shortcut="Ctrl+B" active={!!st.bold} onClick={() => (ctrl.toggleStyle('bold'), after())} disabled={ro}>
        <span className="text-[14px] font-bold">B</span>
      </IconButton>
      <IconButton label="Miring" shortcut="Ctrl+I" active={!!st.italic} onClick={() => (ctrl.toggleStyle('italic'), after())} disabled={ro}>
        <span className="font-serif text-[15px] italic">I</span>
      </IconButton>
      <IconButton label="Garis bawah" shortcut="Ctrl+U" active={!!st.underline} onClick={() => (ctrl.toggleStyle('underline'), after())} disabled={ro}>
        <span className="text-[14px] underline underline-offset-2">U</span>
      </IconButton>
      <IconButton label="Coret" shortcut="Ctrl+5" active={!!st.strike} onClick={() => (ctrl.toggleStyle('strike'), after())} disabled={ro}>
        <span className="text-[14px] line-through">S</span>
      </IconButton>
      <ColorPicker
        label="Warna teks"
        resetLabel="Warna teks bawaan"
        value={st.textColor}
        onChange={(c) => (ctrl.applyStyle({ textColor: c }, 'Warna teks'), after())}
        trigger={
          <button type="button" aria-label="Warna teks" disabled={ro} className="press inline-flex h-8 min-w-8 flex-col items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 disabled:opacity-40 max-md:h-11 max-md:min-w-11">
            <Icon.TextColor />
            <span className="-mt-0.5 h-[3px] w-4 rounded-sm" style={{ background: st.textColor ?? 'var(--ink)' }} />
          </button>
        }
      />
      <ColorPicker
        label="Warna isian"
        resetLabel="Tanpa isian"
        value={st.backgroundColor}
        onChange={(c) => (ctrl.applyStyle({ backgroundColor: c }, 'Warna isian'), after())}
        trigger={
          <button type="button" aria-label="Warna isian" disabled={ro} className="press inline-flex h-8 min-w-8 flex-col items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 disabled:opacity-40 max-md:h-11 max-md:min-w-11">
            <Icon.Fill />
            <span className="-mt-0.5 h-[3px] w-4 rounded-sm border border-line" style={{ background: st.backgroundColor ?? 'transparent' }} />
          </button>
        }
      />
      <Divider />
      <DropdownMenu
        label="Batas"
        finalFocus={gridFocusTarget}
        trigger={
          <button type="button" aria-label="Batas" disabled={ro} className="press inline-flex h-8 min-w-8 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 disabled:opacity-40 max-md:h-11 max-md:min-w-11">
            <Icon.Borders />
          </button>
        }
      >
        {(
          [
            ['all', 'Semua batas'],
            ['outer', 'Batas luar'],
            ['inner', 'Batas dalam'],
            ['top', 'Batas atas'],
            ['bottom', 'Batas bawah'],
            ['left', 'Batas kiri'],
            ['right', 'Batas kanan'],
            ['none', 'Hapus batas'],
          ] as const
        ).map(([k, l]) => (
          <MenuItem key={k} icon={<BorderGlyph kind={k} />} onClick={() => (ctrl.setBorders(k), after())}>
            {l}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem icon={<BorderGlyph kind="outer" />} onClick={() => (ctrl.setBorders('outer', '#1A1E1C', 'thick'), after())}>
          Batas luar tebal
        </MenuItem>
        <MenuItem icon={<BorderGlyph kind="bottom" />} onClick={() => (ctrl.setBorders('bottom', '#1A1E1C', 'double'), after())}>
          Garis ganda bawah
        </MenuItem>
        <MenuItem icon={<BorderGlyph kind="all" />} onClick={() => (ctrl.setBorders('all', '#1A1E1C', 'dashed'), after())}>
          Semua batas putus-putus
        </MenuItem>
      </DropdownMenu>
      <IconButton label="Gabungkan sel" onClick={() => (ctrl.mergeAt(ctrl.s.selection.anchor.row, ctrl.s.selection.anchor.col) ? ctrl.unmerge() : ctrl.merge(), after())} disabled={ro}>
        <Icon.Merge />
      </IconButton>
      <Divider />
      <IconButton label="Rata kiri" shortcut="Ctrl+Shift+L" active={st.hAlign === 'left'} onClick={() => (ctrl.applyStyle({ hAlign: 'left' }), after())} disabled={ro}>
        <Icon.AlignLeft />
      </IconButton>
      <IconButton label="Rata tengah" shortcut="Ctrl+Shift+E" active={st.hAlign === 'center'} onClick={() => (ctrl.applyStyle({ hAlign: 'center' }), after())} disabled={ro}>
        <Icon.AlignCenter />
      </IconButton>
      <IconButton label="Rata kanan" shortcut="Ctrl+Shift+R" active={st.hAlign === 'right'} onClick={() => (ctrl.applyStyle({ hAlign: 'right' }), after())} disabled={ro}>
        <Icon.AlignRight />
      </IconButton>
      <DropdownMenu
        label="Perataan vertikal"
        finalFocus={gridFocusTarget}
        trigger={
          <button type="button" aria-label="Perataan vertikal" disabled={ro} className="press inline-flex h-8 min-w-8 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 disabled:opacity-40 max-md:h-11 max-md:min-w-11">
            {st.vAlign === 'top' ? <Icon.VTop /> : st.vAlign === 'middle' ? <Icon.VMiddle /> : <Icon.VBottom />}
          </button>
        }
      >
        <MenuItem onClick={() => (ctrl.applyStyle({ vAlign: 'top' }), after())}>Atas</MenuItem>
        <MenuItem onClick={() => (ctrl.applyStyle({ vAlign: 'middle' }), after())}>Tengah</MenuItem>
        <MenuItem onClick={() => (ctrl.applyStyle({ vAlign: 'bottom' }), after())}>Bawah</MenuItem>
      </DropdownMenu>
      <IconButton label="Bungkus teks" active={!!st.wrap} onClick={() => (ctrl.toggleStyle('wrap'), after())} disabled={ro}>
        <Icon.Wrap />
      </IconButton>
      <DropdownMenu
        label="Rotasi teks"
        finalFocus={gridFocusTarget}
        trigger={
          <button type="button" aria-label="Rotasi teks" disabled={ro} className="press inline-flex h-8 min-w-8 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 disabled:opacity-40 max-md:h-11 max-md:min-w-11">
            <Icon.Rotate />
          </button>
        }
      >
        {[0, 45, 90, -45, -90].map((d) => (
          <MenuItem key={d} onClick={() => (ctrl.applyStyle({ rotation: d || undefined }, 'Rotasi'), after())}>
            {d === 0 ? 'Tanpa rotasi' : `${d}°`}
          </MenuItem>
        ))}
      </DropdownMenu>
      <Divider />
      <IconButton label="Sisipkan bagan" onClick={() => ctrl.insertChart()} disabled={ro}>
        <Icon.ChartColumn />
      </IconButton>
      <IconButton label="Sisipkan tautan" shortcut="Ctrl+K" onClick={() => ctrl.set({ dialog: 'link' })} disabled={ro}>
        <Icon.Link />
      </IconButton>
      <IconButton label="Tambah komentar" onClick={() => ctrl.openCommentDraft()} disabled={!can.comment}>
        <Icon.Comment />
      </IconButton>
      <IconButton label={hasFilter ? 'Hapus filter' : 'Buat filter'} active={hasFilter} onClick={() => (ctrl.createFilter(), after())}>
        <Icon.Filter />
      </IconButton>
      <IconButton label="Hapus format" onClick={() => (ctrl.clearFormatting(), after())} disabled={ro}>
        <Icon.ClearFormat />
      </IconButton>
    </div>
  );
}

// ---------- formula bar ----------

export function FormulaBar() {
  const ctrl = useCtrl();
  const sel = useEditor((s) => s.selection);
  const editing = useEditor((s) => s.editing);
  const sheetId = useEditor((s) => s.activeSheetId);
  const can = useEditor((s) => s.can);
  useEditor((s) => s.version);
  const r = ctrl.selectionRange();
  const addr = r.r1 === r.r2 && r.c1 === r.c2 ? formatA1(r.r1, r.c1) : formatRangeA1(r);
  const [nameBox, setNameBox] = useState(addr);
  useEffect(() => setNameBox(addr), [addr]);
  const raw = ctrl.model.raw(sheetId, sel.anchor.row, sel.anchor.col);
  const value = editing ? editing.value : raw;
  const inputRef = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [barScroll, setBarScroll] = useState(0);
  const assist = useFormulaAssist(editing?.source === 'bar' ? value : '', caret);
  // In a cell filled by an array formula, show the anchor's formula as a hint.
  const spillArea = !raw ? ctrl.model.engine.spillAreaAt(sheetId, sel.anchor.row, sel.anchor.col) : null;
  const spillFormula = spillArea ? ctrl.model.raw(sheetId, spillArea.anchorRow, spillArea.anchorCol) : undefined;

  const go = () => {
    const t = nameBox.trim().toUpperCase();
    const cell = parseA1(t);
    const rg = parseRangeA1(t);
    if (rg) ctrl.select({ row: rg.r1, col: rg.c1 }, { row: rg.r2, col: rg.c2 });
    else if (cell) ctrl.select(cell);
    else {
      toast.error('Alamat tidak valid. Contoh: B12 atau A1:D20');
      setNameBox(addr);
      return;
    }
    window.dispatchEvent(new Event('opensheet:focus-grid'));
  };

  const pick = (name: string) => {
    if (!assist.token || !editing) return;
    const res = applySuggestion(editing.value, assist.token, name);
    ctrl.updateEdit(res.value, 'bar');
    requestAnimationFrame(() => {
      inputRef.current?.setSelectionRange(res.caret, res.caret);
      setCaret(res.caret);
    });
  };

  const mobile = isMobile();

  return (
    <div className="relative flex items-stretch border-b border-line bg-surface">
      <label className="sr-only" htmlFor="name-box">
        Kotak nama
      </label>
      <input
        id="name-box"
        className="addr h-8 w-24 shrink-0 border-r border-line bg-transparent px-2 text-[13px] text-ink focus:bg-surface-2 focus:outline-none max-md:h-11 md:w-28"
        value={nameBox}
        onChange={(e) => setNameBox(e.target.value)}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') go();
          if (e.key === 'Escape') {
            setNameBox(addr);
            window.dispatchEvent(new Event('opensheet:focus-grid'));
          }
        }}
      />
      <span className="addr flex w-8 shrink-0 items-center justify-center text-[13px] text-ink-2 italic select-none" aria-hidden="true">
        fx
      </span>
      {mobile ? (
        <button
          type="button"
          className="addr min-h-11 min-w-0 flex-1 truncate px-2 text-left text-[13px] text-ink"
          onClick={() => {
            if (!can.edit) return;
            ctrl.startEdit(undefined, 'bar');
            if (ctrl.s.editing) ctrl.set({ dialog: 'mobileFormula' });
          }}
          aria-label={`Isi sel ${addr}. Ketuk untuk mengedit.`}
        >
          {value || <span className="text-ink-3">{can.edit ? 'Ketuk untuk mengisi' : ''}</span>}
        </button>
      ) : (
        <div className="relative min-w-0 flex-1">
        {value.startsWith('=') && (
          <div aria-hidden="true" className="addr pointer-events-none absolute inset-0 overflow-hidden px-2 text-[13px] leading-8 whitespace-pre text-ink">
            <span className="inline-block" style={{ transform: `translateX(${-barScroll}px)` }}>
              {highlightFormula(value)}
            </span>
          </div>
        )}
        <input
          ref={inputRef}
          aria-label="Bilah formula"
          data-active-editor={editing?.source === 'bar' ? 'true' : undefined}
          aria-autocomplete="list"
          readOnly={!can.edit}
          placeholder={spillFormula}
          onScroll={(e) => setBarScroll(e.currentTarget.scrollLeft)}
          onKeyUp={(e) => setBarScroll(e.currentTarget.scrollLeft)}
          className={clsx(
            'relative h-8 w-full min-w-0 bg-transparent px-2 text-[13px] text-ink placeholder:text-ink-3 focus:outline-none',
            value.startsWith('=') && 'addr text-transparent caret-[var(--ink)] selection:bg-brand-soft',
          )}
          value={value}
          onFocus={() => {
            if (!ctrl.s.editing && can.edit) ctrl.startEdit(undefined, 'bar');
            else if (ctrl.s.editing) ctrl.updateEdit(ctrl.s.editing.value, 'bar');
          }}
          onChange={(e) => {
            if (!ctrl.s.editing) ctrl.startEdit(undefined, 'bar');
            ctrl.updateEdit(e.target.value, 'bar');
            setCaret(e.target.selectionStart ?? 0);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={(e) => {
            const open = assist.suggestions.length > 0;
            if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault();
              setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + assist.suggestions.length) % assist.suggestions.length);
              return;
            }
            if (open && (e.key === 'Tab' || e.key === 'Enter')) {
              e.preventDefault();
              pick(assist.suggestions[active].name);
              return;
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              if (ctrl.commitEdit('down')) window.dispatchEvent(new Event('opensheet:focus-grid'));
            }
            if (e.key === 'Tab') {
              e.preventDefault();
              if (ctrl.commitEdit('right')) window.dispatchEvent(new Event('opensheet:focus-grid'));
            }
            if (e.key === 'Escape') {
              ctrl.cancelEdit();
              window.dispatchEvent(new Event('opensheet:focus-grid'));
            }
          }}
        />
        </div>
      )}
      {editing?.source === 'bar' && !mobile && (
        <div className="absolute top-full left-36 z-30 mt-1">
          <AssistPanel assist={assist} active={active} onPick={pick} id="bar-assist" />
        </div>
      )}
    </div>
  );
}

// ---------- sheet tabs ----------

export function SheetTabs() {
  const ctrl = useCtrl();
  useEditor((s) => s.version);
  const active = useEditor((s) => s.activeSheetId);
  const can = useEditor((s) => s.can);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const sheets = ctrl.model.sheets;

  const commitRename = async (id: string) => {
    const t = name.trim();
    setRenaming(null);
    if (!t || t === ctrl.model.sheet(id)?.title) return;
    try {
      await ctrl.renameSheet(id, t);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const safe = (p: Promise<unknown>) => p.catch((e) => toast.error(errorMessage(e)));

  const tabMenu = (id: string, index: number) => (
    <>
      <MenuItem onClick={() => (setRenaming(id), setName(ctrl.model.sheet(id)!.title))} disabled={!can.edit}>
        Ganti nama
      </MenuItem>
      <MenuItem onClick={() => safe(ctrl.duplicateSheet(id))} disabled={!can.edit}>
        Duplikat
      </MenuItem>
      <SubMenu label="Warna tab" disabled={!can.edit}>
        {[null, '#2E8B57', '#3B73C4', '#C2582B', '#B07A12', '#8E5BB5', '#6E7B86'].map((c) => (
          <BMenu.Item key={c ?? 'none'} className={menuItemClass} onClick={() => ctrl.setTabColor(id, c)}>
            <span className="size-3.5 rounded-sm border border-line" style={{ background: c ?? 'transparent' }} />
            <span className="flex-1">{c ?? 'Tanpa warna'}</span>
          </BMenu.Item>
        ))}
      </SubMenu>
      <MenuItem onClick={() => safe(ctrl.moveSheet(id, index - 1))} disabled={!can.edit || index === 0}>
        Pindah ke kiri
      </MenuItem>
      <MenuItem onClick={() => safe(ctrl.moveSheet(id, index + 1))} disabled={!can.edit || index === sheets.length - 1}>
        Pindah ke kanan
      </MenuItem>
      <MenuSeparator />
      <MenuItem danger onClick={() => setConfirmDelete(id)} disabled={!can.edit || sheets.length <= 1}>
        Hapus sheet
      </MenuItem>
    </>
  );

  const toDelete = confirmDelete ? ctrl.model.sheet(confirmDelete) : null;

  return (
    <div className="flex items-stretch border-t border-line bg-bg">
      {can.edit && (
        <IconButton label="Tambah sheet" onClick={() => safe(ctrl.addSheet())} className="m-1">
          <Icon.Plus />
        </IconButton>
      )}
      <DropdownMenu
        label="Semua sheet"
        trigger={
          <button type="button" aria-label="Semua sheet" className="press m-1 inline-flex size-8 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 max-md:size-11">
            <Icon.Menu />
          </button>
        }
      >
        {sheets.map((s) => (
          <MenuItem key={s.id} onClick={() => ctrl.setActiveSheet(s.id)}>
            <span className={clsx(s.id === active && 'font-semibold')}>{s.title}</span>
          </MenuItem>
        ))}
      </DropdownMenu>
      <div role="tablist" aria-label="Sheet" className="scroll-thin flex min-w-0 flex-1 items-end overflow-x-auto">
        {sheets.map((s, i) =>
          renaming === s.id ? (
            <input
              key={s.id}
              autoFocus
              aria-label="Nama sheet"
              className="addr mx-0.5 mb-1 h-8 w-36 rounded border border-brand bg-surface px-2 text-[13px] outline-none max-md:h-11"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => commitRename(s.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') setRenaming(null);
              }}
              maxLength={100}
            />
          ) : (
            <div key={s.id} className={clsx('group relative flex items-center border-r border-line', s.id === active ? 'bg-surface' : 'hover:bg-surface-2')}>
              {s.metadata.tabColor && <span className="absolute inset-x-0 bottom-0 h-[3px]" style={{ background: s.metadata.tabColor }} aria-hidden="true" />}
              <button
                type="button"
                role="tab"
                aria-selected={s.id === active}
                className={clsx('h-9 max-w-48 truncate pr-1 pl-3 text-[13px] max-md:h-11', s.id === active ? 'font-semibold text-brand' : 'text-ink-2')}
                onClick={() => ctrl.setActiveSheet(s.id)}
                onDoubleClick={() => {
                  if (!can.edit) return;
                  setRenaming(s.id);
                  setName(s.title);
                }}
              >
                {s.title}
              </button>
              <DropdownMenu
                label={`Opsi sheet ${s.title}`}
                trigger={
                  <button type="button" aria-label={`Opsi sheet ${s.title}`} className="press mr-1 inline-flex size-6 items-center justify-center rounded text-ink-2 hover:bg-surface-3 max-md:size-11">
                    <Icon.ChevronDown size={12} />
                  </button>
                }
              >
                {tabMenu(s.id, i)}
              </DropdownMenu>
            </div>
          ),
        )}
      </div>
      <SelectionStats />
      {toDelete && (
        <ConfirmDialog
          title={`Hapus sheet "${toDelete.title}"?`}
          body="Isi sheet akan dihapus. Formula yang merujuk ke sheet ini akan menampilkan #REF!."
          confirm="Hapus sheet"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            const id = confirmDelete!;
            setConfirmDelete(null);
            safe(ctrl.deleteSheet(id));
          }}
        />
      )}
    </div>
  );
}


export function ConfirmDialog({ title, body, confirm, onCancel, onConfirm }: { title: string; body: string; confirm: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onCancel()}
      title={title}
      description={body}
      footer={
        <>
          <Button onClick={onCancel}>Batal</Button>
          <Button variant="danger" onClick={onConfirm}>
            {confirm}
          </Button>
        </>
      }
    />
  );
}

/** Sum, average and more for the selected cells. Each value copies when clicked. */
function SelectionStats() {
  const ctrl = useCtrl();
  useEditor((s) => s.selection);
  useEditor((s) => s.version);
  const r = ctrl.clampToUsed(ctrl.selectionRange());
  const sid = ctrl.s.activeSheetId;
  const cells = (r.r2 - r.r1 + 1) * (r.c2 - r.c1 + 1);
  if (cells < 2 || cells > 200_000) return null;
  let sum = 0;
  let nums = 0;
  let count = 0;
  let min = Infinity;
  let max = -Infinity;
  ctrl.forEachInRange(r, (row, col) => {
    const v = ctrl.model.value(sid, row, col);
    if (v === null || v === '') return;
    count++;
    if (typeof v === 'number' && !isError(v)) {
      sum += v;
      nums++;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  });
  if (!count) return null;
  const show = (n: number) => n.toLocaleString('id-ID', { maximumFractionDigits: 4 });
  const stats: { key: string; label: string; value: number }[] = [];
  if (nums > 0) stats.push({ key: 'sum', label: 'Jumlah', value: sum }, { key: 'avg', label: 'Rata-rata', value: sum / nums }, { key: 'min', label: 'Min', value: min }, { key: 'max', label: 'Maks', value: max });
  stats.push({ key: 'count', label: 'Terisi', value: count });
  const copy = async (label: string, value: number) => {
    // Plain digits, so the value pastes into a cell or a formula as a number.
    const text = String(Number(value.toPrecision(12)));
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} disalin: ${show(value)}`);
    } catch {
      toast.error('Browser memblokir akses papan klip.');
    }
  };
  return (
    <div className="tnum scroll-thin hidden max-w-[55%] items-center gap-0.5 overflow-x-auto px-1 sm:flex" role="group" aria-label="Ringkasan pilihan. Klik untuk menyalin.">
      {stats.map((s) => (
        <button
          key={s.key}
          type="button"
          title={`Klik untuk menyalin ${s.label.toLowerCase()}`}
          className="press group inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs whitespace-nowrap text-ink-2 hover:bg-surface-3 hover:text-ink"
          onClick={() => copy(s.label, s.value)}
        >
          <span>{s.label}</span>
          <span className="font-medium text-ink">{show(s.value)}</span>
          <Icon.Copy size={12} className="opacity-0 transition-opacity group-hover:opacity-70 group-focus-visible:opacity-70" />
        </button>
      ))}
    </div>
  );
}

// ---------- status bar ----------

export function StatusBar() {
  const ctrl = useCtrl();
  useEditor((s) => s.tempFilter);
  const sel = useEditor((s) => s.selection);
  const users = useEditor((s) => s.users);
  useEditor((s) => s.version);
  const sheet = ctrl.sheet();
  const info = sheet?.info.get(`${sel.anchor.row}:${sel.anchor.col}`);
  const protectedReason = ctrl.protectedReason(ctrl.s.activeSheetId, sel.anchor.row, sel.anchor.col);
  const link = ctrl.model.style(ctrl.s.activeSheetId, sel.anchor.row, sel.anchor.col)?.link;
  const spill = ctrl.model.engine.spillAreaAt(ctrl.s.activeSheetId, sel.anchor.row, sel.anchor.col);
  const spillNote =
    spill && !(spill.anchorRow === sel.anchor.row && spill.anchorCol === sel.anchor.col)
      ? `Hasil array dari ${formatA1(spill.anchorRow, spill.anchorCol)}`
      : spill && !spill.ok
        ? 'Hasil array terhalang data di sel tujuan'
        : null;
  return (
    <div className="flex min-h-7 items-center gap-3 border-t border-line bg-surface px-3 text-xs text-ink-2">
      <span className="addr">{formatA1(sel.anchor.row, sel.anchor.col)}</span>
      {info?.at && (
        <span className="truncate">
          Terakhir diubah {info.by ? `oleh ${users[info.by] ?? 'kolaborator'} ` : ''}
          {relativeTime(info.at)}
        </span>
      )}
      {ctrl.activeFilter() && (
        <span className="inline-flex items-center gap-1.5 rounded-md border border-line px-1.5 py-0.5">
          <Icon.Filter size={12} className={ctrl.filterIsShared() ? 'text-brand' : 'text-accent'} />
          <span className="addr">{formatRangeA1(ctrl.activeFilter()!)}</span>
          <span>{ctrl.filterIsShared() ? 'untuk semua' : 'hanya saya'}</span>
          <button type="button" aria-label="Hapus filter" className="press -mr-0.5 inline-flex size-4 items-center justify-center rounded hover:bg-surface-3" onClick={() => ctrl.removeFilter()}>
            <Icon.Close size={12} />
          </button>
        </span>
      )}
      {spillNote && <span className={clsx(spill?.ok ? 'text-ink-2' : 'text-danger')}>{spillNote}</span>}
      {protectedReason && (
        <span className="inline-flex items-center gap-1 text-accent">
          <Icon.Lock size={12} /> {protectedReason}
        </span>
      )}
      {link && (
        <a className="ml-auto inline-flex items-center gap-1 truncate text-brand underline underline-offset-2" href={link} target="_blank" rel="noopener noreferrer">
          <Icon.Open size={12} /> Buka tautan
        </a>
      )}
    </div>
  );
}
