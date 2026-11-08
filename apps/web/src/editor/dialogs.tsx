import { Dialog as BDialog } from '@base-ui/react/dialog';
import {
  CellStyle,
  colToLetters,
  ConditionalRule,
  ConditionOp,
  formatRangeA1,
  formatValue,
  listFunctions,
  parseRangeA1,
  type ChartSpec,
  ProtectedRangeRecord,
  RuleRecord,
  ValidationRule,
} from '@opensheet/engine';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Icon } from '../components/icons';
import { Avatar, Button, Checkbox, Dialog, Field, IconButton, Input, Select, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { setPicking } from '../lib/picking';
import { useMe } from '../lib/auth';
import { dateTime } from '../lib/format';
import { clipboardAction, insertCheckbox, useWorkbookActions } from './chrome';
import { SuggestChips } from './CellEditor';
import { ChartSvg } from './ChartSvg';
import { CHART_TYPES, readChart } from './charts';
import { ColorPicker } from './ColorPicker';
import { useCtrl, useEditor } from './context';
import { roleLabel } from './controller';
import { applySuggestion, AssistPanel, useFormulaAssist } from './formulaAssist';

function useDialog(name: string) {
  const ctrl = useCtrl();
  const open = useEditor((s) => s.dialog === name);
  const close = () => {
    ctrl.set({ dialog: null });
    window.dispatchEvent(new Event('opensheet:focus-grid'));
  };
  return { open, close, ctrl };
}

export function EditorDialogs() {
  return (
    <>
      <ShareDialog />
      <FindDialog />
      <FormatCellsDialog />
      <ConditionalDialog />
      <ValidationDialog />
      <ProtectDialog />
      <ConfirmDialog />
      <ChartDialog />
      <FeedDialog />
      <RangePickBar />
      <SortDialog />
      <SplitDialog />
      <DedupeDialog />
      <LinkDialog />
      <ShortcutsDialog />
      <FunctionsDialog />
      <ImportDialog />
      <FilterViewDialog />
      <CreateFilterDialog />
      <FilesDialog />
      <MobileFormulaSheet />
      <MobileFormatSheet />
      <MobileMenuSheet />
    </>
  );
}

// ---------- Google Sheets feed ----------

interface FeedKey {
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const copy = async (text: string, what: string) => {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} disalin`);
  } catch {
    toast.error('Tidak bisa menyalin. Pilih teksnya lalu salin manual.');
  }
};

function appsScript(url: string, key: string, sheet: string, range: string) {
  return `// OpenSheet -> Google Sheets. Tempel di Extensions > Apps Script, jalankan installTrigger() sekali.
const OPENSHEET = {
  url: '${url}',
  key: '${key}',
  sheet: '${sheet.replace(/'/g, "\\'")}',
  range: '${range}', // kosong = seluruh sheet
  target: 'OpenSheet', // nama sheet tujuan di Google Sheets
};

function syncOpenSheet() {
  const props = PropertiesService.getScriptProperties();
  let q = '?format=json&sheet=' + encodeURIComponent(OPENSHEET.sheet);
  if (OPENSHEET.range) q += '&range=' + encodeURIComponent(OPENSHEET.range);
  const headers = { Authorization: 'Bearer ' + OPENSHEET.key };
  const last = props.getProperty('etag');
  if (last) headers['If-None-Match'] = last; // data tidak berubah: OpenSheet menjawab 304, tidak ada yang ditulis
  const res = UrlFetchApp.fetch(OPENSHEET.url + q, { headers: headers, muteHttpExceptions: true });
  const code = res.getResponseCode();
  if (code === 304) return;
  if (code !== 200) throw new Error('OpenSheet ' + code + ': ' + res.getContentText());
  const values = JSON.parse(res.getContentText()).values;
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(OPENSHEET.target) || ss.insertSheet(OPENSHEET.target);
  sh.clearContents();
  if (values.length && values[0].length) sh.getRange(1, 1, values.length, values[0].length).setValues(values);
  const h = res.getAllHeaders();
  const k = Object.keys(h).find(function (x) { return x.toLowerCase() === 'etag'; });
  if (k) props.setProperty('etag', h[k]);
}

function installTrigger() {
  ScriptApp.newTrigger('syncOpenSheet').timeBased().everyMinutes(1).create();
  syncOpenSheet();
}
`;
}

function FeedDialog() {
  const { open, close, ctrl } = useDialog('feed');
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ['feed', ctrl.workbookId], enabled: open, queryFn: () => api.get<{ items: FeedKey[] }>(`/api/workbooks/${ctrl.workbookId}/feed-tokens`) });
  const [label, setLabel] = useState('Google Sheets');
  const [fresh, setFresh] = useState<string | null>(null);
  const [sheet, setSheet] = useState('');
  const [range, setRange] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setFresh(null);
      setSheet(ctrl.sheet()?.title ?? '');
      setRange('');
    }
  }, [open, ctrl]);
  const base = `${window.location.origin}/api/feed/${ctrl.workbookId}`;
  const key = fresh ?? 'KUNCI_ANDA';
  const rangeOk = range === '' || !!parseRangeA1(range.toUpperCase());
  const q = `?token=${key}&sheet=${encodeURIComponent(sheet)}${range ? `&range=${range.toUpperCase()}` : ''}`;
  const formula = `=IMPORTDATA("${base}${q}")`;
  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ token: string }>(`/api/workbooks/${ctrl.workbookId}/feed-tokens`, { label: label.trim() || 'Google Sheets' });
      setFresh(r.token);
      await qc.invalidateQueries({ queryKey: ['feed', ctrl.workbookId] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    try {
      await api.del(`/api/workbooks/${ctrl.workbookId}/feed-tokens/${id}`);
      await qc.invalidateQueries({ queryKey: ['feed', ctrl.workbookId] });
      toast.success('Kunci dicabut. Google Sheets yang memakainya berhenti menerima data.');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Hubungkan ke Google Sheets"
      description="Google Sheets membaca nilai workbook ini lewat kunci baca-saja. Isinya tidak bisa diubah dari sana."
      width={680}
      footer={<Button onClick={close}>Tutup</Button>}
    >
      <div className="flex flex-col gap-5">
        <section>
          <h3 className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium">
            <Icon.Lock size={14} /> Kunci
          </h3>
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
            {(keys.data?.items ?? []).length === 0 && <li className="px-3 py-2 text-xs text-ink-2">Belum ada kunci.</li>}
            {(keys.data?.items ?? []).map((k) => (
              <li key={k.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                <span className="min-w-0 flex-1 truncate">
                  {k.label} <span className="addr text-xs text-ink-2">{k.prefix}…</span>
                </span>
                <span className="text-xs text-ink-2">{k.lastUsedAt ? `Terakhir dipakai ${dateTime(k.lastUsedAt)}` : 'Belum dipakai'}</span>
                <button type="button" aria-label={`Cabut kunci ${k.label}`} title="Cabut kunci" className="press inline-flex size-8 items-center justify-center rounded-md text-danger hover:bg-danger-soft" onClick={() => revoke(k.id)}>
                  <Icon.Trash size={15} />
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-end gap-2">
            <Field label="Nama kunci baru" htmlFor="fd-label">
              <Input id="fd-label" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} />
            </Field>
            <Button onClick={create} disabled={busy}>
              <Icon.Plus /> Buat kunci
            </Button>
          </div>
          {fresh && (
            <div className="mt-2 rounded-md border border-accent bg-accent-soft p-3">
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-ink">
                <Icon.Warning size={14} /> Salin sekarang. Kunci ini tidak akan ditampilkan lagi.
              </p>
              <div className="flex gap-2">
                <Input readOnly aria-label="Kunci baru" className="addr" value={fresh} onFocus={(e) => e.target.select()} />
                <Button onClick={() => copy(fresh, 'Kunci')}>
                  <Icon.Copy /> Salin
                </Button>
              </div>
            </div>
          )}
        </section>

        <section className="grid gap-3 sm:grid-cols-2">
          <Field label="Sheet yang dibagikan" htmlFor="fd-sheet">
            <Select id="fd-sheet" value={sheet} onChange={(e) => setSheet(e.target.value)}>
              {ctrl.model.sheets.map((s) => (
                <option key={s.id} value={s.title}>
                  {s.title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Rentang (opsional)" htmlFor="fd-range" error={rangeOk ? undefined : 'Contoh: A1:D20'}>
            <RangeInput id="fd-range" value={range} onChange={setRange} />
          </Field>
        </section>

        <section>
          <h3 className="mb-1.5 text-[13px] font-medium">Cara 1: rumus IMPORTDATA</h3>
          <p className="mb-1.5 text-xs text-ink-2">Paling sederhana. Google menyegarkan IMPORTDATA sekitar tiap satu jam, bukan seketika.</p>
          <div className="flex gap-2">
            <Input readOnly aria-label="Rumus IMPORTDATA" className="addr text-xs" value={formula} onFocus={(e) => e.target.select()} />
            <Button disabled={!rangeOk} onClick={() => copy(formula, 'Rumus')}>
              <Icon.Copy /> Salin
            </Button>
          </div>
        </section>

        <section>
          <h3 className="mb-1.5 text-[13px] font-medium">Cara 2: Apps Script, diperbarui tiap menit</h3>
          <p className="mb-1.5 text-xs text-ink-2">Skrip menanyakan OpenSheet tiap menit dan hanya menulis bila datanya berubah. Ini batas tercepat dari pemicu waktu Google.</p>
          <textarea readOnly aria-label="Skrip Apps Script" className="addr h-40 w-full resize-y rounded-md border border-line-2 bg-surface-2 p-2 text-xs" value={appsScript(base, key, sheet, range.toUpperCase())} onFocus={(e) => e.target.select()} />
          <Button className="mt-2" disabled={!rangeOk} onClick={() => copy(appsScript(base, key, sheet, range.toUpperCase()), 'Skrip')}>
            <Icon.Copy /> Salin skrip
          </Button>
        </section>

        <p className="flex gap-2 text-xs text-ink-2">
          <Icon.Warning size={14} className="mt-0.5 shrink-0" />
          <span>Server Google harus bisa menjangkau alamat OpenSheet ini dari internet. Siapa pun yang memegang kunci dapat membaca seluruh workbook, jadi jangan dibagikan dan cabut bila bocor.</span>
        </p>
      </div>
    </Dialog>
  );
}

// ---------- charts ----------

const CHART_ICONS = { column: Icon.ChartColumn, bar: Icon.ChartBar, line: Icon.ChartLine, area: Icon.ChartArea, pie: Icon.ChartPie, scatter: Icon.ChartScatter } as const;

function ChartDialog() {
  const { open, close, ctrl } = useDialog('chart');
  const draft = useEditor((s) => s.chartDraft);
  const [spec, setSpec] = useState<ChartSpec | null>(null);
  useEffect(() => {
    if (open && draft) setSpec(structuredClone(draft.spec));
  }, [open, draft]);
  if (!spec) return <Dialog open={false} onOpenChange={() => undefined} title="Bagan" />;
  const set = (p: Partial<ChartSpec>) => setSpec({ ...spec, ...p });
  const valid = !!parseRangeA1(spec.range);
  const data = readChart(spec, (r, c) => ctrl.model.value(ctrl.s.activeSheetId, r, c));
  const stackable = spec.type === 'column' || spec.type === 'bar' || spec.type === 'area';
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          ctrl.set({ chartDraft: null });
          close();
        }
      }}
      title={draft?.isNew ? 'Bagan baru' : 'Ubah bagan'}
      width={720}
      footer={
        <>
          <Button
            onClick={() => {
              ctrl.set({ chartDraft: null });
              close();
            }}
          >
            Batal
          </Button>
          <Button
            variant="primary"
            disabled={!valid || !data.valid}
            onClick={() => {
              ctrl.saveChartDraft(spec);
              close();
            }}
          >
            <Icon.Check /> {draft?.isNew ? 'Sisipkan' : 'Simpan'}
          </Button>
        </>
      }
    >
      <div className="grid gap-5 md:grid-cols-[250px_1fr]">
        <div className="flex flex-col gap-4">
          <fieldset>
            <legend className="mb-1.5 text-[13px] font-medium">Jenis</legend>
            <div className="grid grid-cols-3 gap-1.5">
              {CHART_TYPES.map((t) => {
                const I = CHART_ICONS[t.type];
                return (
                  <button
                    key={t.type}
                    type="button"
                    aria-pressed={spec.type === t.type}
                    onClick={() => set({ type: t.type })}
                    className={clsx('press flex flex-col items-center gap-1 rounded-md border px-1 py-2 text-xs', spec.type === t.type ? 'border-brand bg-brand-soft text-ink' : 'border-line text-ink-2 hover:bg-surface-2')}
                  >
                    <I size={20} />
                    {t.label}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <Field label="Judul" htmlFor="ch-title">
            <Input id="ch-title" value={spec.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} />
          </Field>
          <Field label="Rentang data" htmlFor="ch-range" error={valid ? (data.valid ? undefined : 'Tidak ada angka di rentang ini.') : 'Contoh: A1:C10'}>
            <RangeInput id="ch-range" value={spec.range} onChange={(v) => set({ range: v })} />
          </Field>
          <div className="flex flex-col">
            <Checkbox label="Baris pertama berisi nama seri" checked={spec.headerRow} onChange={(v) => set({ headerRow: v })} />
            <Checkbox label="Kolom pertama berisi label" checked={spec.headerCol} onChange={(v) => set({ headerCol: v })} />
            {stackable && <Checkbox label="Ditumpuk" checked={spec.stacked} onChange={(v) => set({ stacked: v })} />}
          </div>
          <Field label="Seri berada di" htmlFor="ch-in">
            <Select id="ch-in" value={spec.seriesIn} onChange={(e) => set({ seriesIn: e.target.value as ChartSpec['seriesIn'] })}>
              <option value="cols">Kolom</option>
              <option value="rows">Baris</option>
            </Select>
          </Field>
          <Field label="Legenda" htmlFor="ch-legend">
            <Select id="ch-legend" value={spec.legend} onChange={(e) => set({ legend: e.target.value as ChartSpec['legend'] })}>
              <option value="bottom">Bawah</option>
              <option value="right">Kanan</option>
              <option value="top">Atas</option>
              <option value="none">Tanpa legenda</option>
            </Select>
          </Field>
        </div>
        <div>
          <p className="mb-1.5 text-[13px] font-medium">Pratinjau</p>
          <div className="rounded-md border border-line bg-surface" style={{ height: 320 }}>
            <ChartSvg spec={spec} data={data} w={420} h={318} />
          </div>
        </div>
      </div>
    </Dialog>
  );
}

// ---------- range picking ----------

/** A range field with a button to drag the range on the sheet instead of typing it. */
function RangeInput({ value, onChange, id, className, autoFocus }: { value: string; onChange: (v: string) => void; id: string; className?: string; autoFocus?: boolean }) {
  const ctrl = useCtrl();
  return (
    <div className="flex gap-1.5">
      <Input id={id} className={clsx('addr', className)} value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} autoFocus={autoFocus} />
      <button
        type="button"
        aria-label="Pilih rentang di sheet"
        title="Pilih rentang di sheet"
        className="press inline-flex h-9 min-w-9 shrink-0 items-center justify-center rounded-md border border-line-2 text-ink-2 hover:bg-surface-2 max-md:h-11 max-md:min-w-11"
        onClick={() => ctrl.pickRange(value, onChange)}
      >
        <Icon.PickRange />
      </button>
    </div>
  );
}

/** While a dialog field is picking, the dialog steps aside and this bar shows the live range. */
function RangePickBar() {
  const ctrl = useCtrl();
  const pick = useEditor((s) => s.rangePick);
  useEditor((s) => s.selection);
  useEffect(() => {
    if (!pick) return;
    setPicking(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      ctrl.finishRangePick(e.key === 'Enter');
      window.dispatchEvent(new Event('opensheet:focus-grid'));
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      setPicking(false);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [pick, ctrl]);
  if (!pick) return null;
  return (
    <div role="status" className="fixed bottom-6 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-3 rounded-lg border border-line bg-surface py-2 pr-2 pl-4 shadow-pop">
      <Icon.PickRange className="text-brand" />
      <span className="text-sm text-ink-2 max-sm:hidden">Seret sel untuk memilih</span>
      <span className="addr min-w-16 text-sm font-medium text-ink">{formatRangeA1(ctrl.selectionRange())}</span>
      <Button size="sm" onClick={() => ctrl.finishRangePick(false)}>
        <Icon.Close size={14} /> Batal
      </Button>
      <Button size="sm" variant="primary" onClick={() => ctrl.finishRangePick(true)}>
        <Icon.Check size={14} /> Pilih
      </Button>
    </div>
  );
}

// ---------- confirm ----------

function ConfirmDialog() {
  const ctrl = useCtrl();
  const confirm = useEditor((s) => s.confirm);
  const close = () => {
    ctrl.set({ confirm: null });
    window.dispatchEvent(new Event('opensheet:focus-grid'));
  };
  return (
    <Dialog
      open={!!confirm}
      onOpenChange={(o) => !o && close()}
      title={confirm?.title ?? ''}
      description={confirm?.message}
      width={420}
      footer={
        <>
          <Button onClick={close}>Batal</Button>
          <Button
            variant="primary"
            autoFocus
            onClick={() => {
              const go = confirm?.onConfirm;
              ctrl.set({ confirm: null });
              go?.();
              window.dispatchEvent(new Event('opensheet:focus-grid'));
            }}
          >
            {confirm?.action}
          </Button>
        </>
      }
    />
  );
}

// ---------- share ----------

interface Perms {
  owner: { id: string; name: string; email: string };
  linkAccess: string;
  linkSharingEnabled: boolean;
  guestLinkEnabled?: boolean;
  permissions: { id: string; permission: string; user: { id: string; name: string; email: string } }[];
  invitations: { id: string; email: string; permission: string }[];
}

function ShareDialog() {
  const { open, close, ctrl } = useDialog('share');
  const can = useEditor((s) => s.can);
  const role = useEditor((s) => s.role);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['perms', ctrl.workbookId], enabled: open, queryFn: () => api.get<Perms>(`/api/workbooks/${ctrl.workbookId}/permissions`) });
  const [email, setEmail] = useState('');
  const [perm, setPerm] = useState('editor');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['perms', ctrl.workbookId] });
  const link = `${window.location.origin}/w/${ctrl.workbookId}`;

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post<{ kind: string }>(`/api/workbooks/${ctrl.workbookId}/share`, { email, permission: perm, message: message || undefined });
      toast.success(r.kind === 'invitation' ? `Undangan dikirim ke ${email}. Akses aktif setelah mereka mendaftar.` : `Akses diberikan ke ${email}`);
      setEmail('');
      setMessage('');
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} title={`Bagikan "${ctrl.s.workbook?.title ?? ''}"`} width={560} footer={<Button onClick={close}>Selesai</Button>}>
      {!can.share && <p className="mb-4 rounded-md border border-line bg-surface-2 p-3 text-sm text-ink-2">Anda adalah {roleLabel(role)}. Hanya pemilik atau pengelola yang dapat mengubah akses.</p>}
      {can.share && (
        <form onSubmit={invite} className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Input type="email" aria-label="Email orang yang diundang" placeholder="nama@instansi.go.id" value={email} onChange={(e) => setEmail(e.target.value)} className="min-w-0 flex-1" required />
            <Select aria-label="Izin" value={perm} onChange={(e) => setPerm(e.target.value)}>
              <option value="viewer">Pembaca</option>
              <option value="commenter">Komentator</option>
              <option value="editor">Editor</option>
              {can.own && <option value="manager">Editor + kelola akses</option>}
            </Select>
          </div>
          <Input aria-label="Pesan (opsional)" placeholder="Pesan (opsional)" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} />
          <div className="flex justify-end">
            <Button type="submit" variant="primary" disabled={busy || !email}>
              Kirim undangan
            </Button>
          </div>
        </form>
      )}
      <h3 className="mt-5 text-[13px] font-semibold text-ink">Orang yang memiliki akses</h3>
      {q.isLoading ? (
        <Spinner className="mt-3" />
      ) : q.isError ? (
        <p className="mt-2 text-sm text-danger">{errorMessage(q.error)}</p>
      ) : q.data ? (
        <ul className="mt-2 flex flex-col">
          <li className="flex items-center gap-3 py-2">
            <Avatar name={q.data.owner.name} size={30} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-ink">{q.data.owner.name}</p>
              <p className="truncate text-xs text-ink-2">{q.data.owner.email}</p>
            </div>
            <span className="text-xs text-ink-2">Pemilik</span>
          </li>
          {q.data.permissions.map((p) => (
            <li key={p.id} className="flex items-center gap-3 py-2">
              <Avatar name={p.user.name} size={30} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-ink">{p.user.name}</p>
                <p className="truncate text-xs text-ink-2">{p.user.email}</p>
              </div>
              <Select aria-label={`Izin ${p.user.name}`} value={p.permission} disabled={!can.share || (p.permission === 'manager' && !can.own)} onChange={(e) => run(() => api.patch(`/api/workbooks/${ctrl.workbookId}/permissions/${p.id}`, { permission: e.target.value }))}>
                <option value="viewer">Pembaca</option>
                <option value="commenter">Komentator</option>
                <option value="editor">Editor</option>
                {(can.own || p.permission === 'manager') && <option value="manager">Editor + kelola</option>}
              </Select>
              {can.share && (
                <IconButton label={`Cabut akses ${p.user.name}`} onClick={() => run(() => api.del(`/api/workbooks/${ctrl.workbookId}/permissions/${p.id}`))}>
                  <Icon.Close />
                </IconButton>
              )}
            </li>
          ))}
          {q.data.invitations.map((i) => (
            <li key={i.id} className="flex items-center gap-3 py-2">
              <span className="inline-flex size-[30px] items-center justify-center rounded-full border border-dashed border-line-2 text-ink-2">
                <Icon.Users size={14} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-ink">{i.email}</p>
                <p className="text-xs text-ink-2">Menunggu pendaftaran · {roleLabel(i.permission)}</p>
              </div>
              {can.share && (
                <IconButton label={`Batalkan undangan ${i.email}`} onClick={() => run(() => api.del(`/api/workbooks/${ctrl.workbookId}/invitations/${i.id}`))}>
                  <Icon.Close />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <h3 className="mt-5 text-[13px] font-semibold text-ink">Akses lewat tautan</h3>
      {q.data && (
        <div className="mt-2 flex flex-col gap-2">
          <Select
            aria-label="Akses lewat tautan"
            value={q.data.linkAccess}
            disabled={!can.share || (!q.data.linkSharingEnabled && q.data.linkAccess === 'restricted')}
            onChange={(e) => run(() => api.patch(`/api/workbooks/${ctrl.workbookId}/link`, { linkAccess: e.target.value }))}
          >
            <option value="restricted">Terbatas: hanya orang yang ditambahkan</option>
            <option value="view">Siapa pun yang login dan punya tautan: Pembaca</option>
            <option value="comment">Siapa pun yang login dan punya tautan: Komentator</option>
            <option value="edit">Siapa pun yang login dan punya tautan: Editor</option>
          </Select>
          {!q.data.linkSharingEnabled && <p className="text-xs text-ink-2">Admin menonaktifkan berbagi lewat tautan.</p>}
          {q.data.linkSharingEnabled && q.data.guestLinkEnabled && q.data.linkAccess !== 'restricted' && (
            <p className="text-xs text-ink-2">Pengunjung tanpa akun juga dapat membuka tautan ini, hanya sebagai Pembaca.</p>
          )}
          <div className="flex gap-2">
            <Input readOnly value={link} aria-label="Tautan workbook" className="addr" onFocus={(e) => e.target.select()} />
            <Button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(link);
                  toast.success('Tautan disalin');
                } catch {
                  toast.message('Salin tautan secara manual dari kolom di sebelahnya.');
                }
              }}
            >
              <Icon.Copy /> Salin
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ---------- find & replace ----------

function FindDialog() {
  const { open, close, ctrl } = useDialog('find');
  const can = useEditor((s) => s.can);
  const replaceMode = useEditor((s) => s.findOpenReplace);
  const [query, setQuery] = useState('');
  const [rep, setRep] = useState('');
  const [opts, setOpts] = useState({ matchCase: false, whole: false, formulas: false, allSheets: false, regex: false });
  const [index, setIndex] = useState(-1);
  const version = useEditor((s) => s.version);
  const matches = useMemo(() => (open ? ctrl.findMatches(query, opts) : []), [open, query, opts, version, ctrl]);
  useEffect(() => setIndex(-1), [query, opts]);

  const goto = (i: number) => {
    if (!matches.length) return;
    const n = (i + matches.length) % matches.length;
    setIndex(n);
    const m = matches[n];
    ctrl.goTo(m.sheetId, m.row, m.col);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} title={replaceMode && can.edit ? 'Cari dan ganti' : 'Cari'} width={480}>
      <div className="flex flex-col gap-3">
        <Field label="Cari" htmlFor="find-q">
          <Input
            id="find-q"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                goto(e.shiftKey ? index - 1 : index + 1);
              }
            }}
          />
        </Field>
        {replaceMode && can.edit && (
          <Field label="Ganti dengan" htmlFor="find-r">
            <Input id="find-r" value={rep} onChange={(e) => setRep(e.target.value)} />
          </Field>
        )}
        <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
          <Checkbox label="Cocokkan huruf besar/kecil" checked={opts.matchCase} onChange={(v) => setOpts({ ...opts, matchCase: v })} />
          <Checkbox label="Seluruh isi sel" checked={opts.whole} onChange={(v) => setOpts({ ...opts, whole: v })} />
          <Checkbox label="Cari di dalam formula" checked={opts.formulas} onChange={(v) => setOpts({ ...opts, formulas: v })} />
          <Checkbox label="Semua sheet" checked={opts.allSheets} onChange={(v) => setOpts({ ...opts, allSheets: v })} />
          <Checkbox label="Ekspresi reguler" checked={opts.regex} onChange={(v) => setOpts({ ...opts, regex: v })} />
        </div>
        <p className="text-sm text-ink-2" role="status">
          {query ? (matches.length ? `${index >= 0 ? `${index + 1} dari ` : ''}${matches.length}${matches.length > 5000 ? '+' : ''} hasil` : 'Tidak ditemukan') : 'Ketik untuk mencari'}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={() => goto(index - 1)} disabled={!matches.length}>
            Sebelumnya
          </Button>
          <Button onClick={() => goto(index + 1)} disabled={!matches.length}>
            Berikutnya
          </Button>
          {replaceMode && can.edit && (
            <>
              <Button
                onClick={() => {
                  if (index < 0) return goto(0);
                  const n = ctrl.replaceMatches([matches[index]], query, rep, opts);
                  if (n) goto(index);
                }}
                disabled={!matches.length}
              >
                Ganti
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  const n = ctrl.replaceMatches(matches, query, rep, opts);
                  toast.success(n ? `${n} sel diganti` : 'Tidak ada yang diganti');
                }}
                disabled={!matches.length}
              >
                Ganti semua
              </Button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

// ---------- format cells ----------

const PRESETS: [string, string][] = [
  ['auto', 'Otomatis'],
  ['number', 'Angka (#,##0.00)'],
  ['integer', 'Bilangan bulat (#,##0)'],
  ['currency', 'Rupiah'],
  ['currency2', 'Rupiah dengan sen'],
  ['percent', 'Persen'],
  ['date', 'Tanggal (dd/mm/yyyy)'],
  ['date_long', 'Tanggal panjang'],
  ['time', 'Waktu'],
  ['datetime', 'Tanggal dan waktu'],
  ['text', 'Teks biasa'],
  ['custom', 'Kustom'],
];

function FormatCellsDialog() {
  const { open, close, ctrl } = useDialog('formatCells');
  const [st, setSt] = useState<CellStyle>({});
  const [preset, setPreset] = useState('auto');
  const [custom, setCustom] = useState('');
  useEffect(() => {
    if (!open) return;
    const s = ctrl.activeStyle();
    setSt(s);
    const nf = s.numberFormat ?? 'auto';
    const known = PRESETS.some(([id]) => id === nf);
    setPreset(known ? nf : 'custom');
    setCustom(known ? '' : nf);
  }, [open, ctrl]);
  const a = ctrl.s.selection.anchor;
  const sample = ctrl.model.value(ctrl.s.activeSheetId, a.row, a.col);
  const fmt = preset === 'custom' ? custom : preset === 'auto' ? undefined : preset;
  const preview = formatValue(typeof sample === 'number' ? sample : 1234.5678, fmt);

  const apply = () => {
    ctrl.applyStyle((cur) => ({ ...cur, ...st, numberFormat: fmt || undefined }), 'Format sel');
    close();
  };
  const set = (p: Partial<CellStyle>) => setSt({ ...st, ...p });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Format sel"
      description={`Berlaku untuk ${formatRangeA1(ctrl.selectionRange())}`}
      width={560}
      footer={
        <>
          <Button onClick={close}>Batal</Button>
          <Button variant="primary" onClick={apply}>
            Terapkan
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <section className="flex flex-col gap-3">
          <h3 className="text-[13px] font-semibold">Angka</h3>
          <Select aria-label="Format angka" value={preset} onChange={(e) => setPreset(e.target.value)}>
            {PRESETS.map(([id, l]) => (
              <option key={id} value={id}>
                {l}
              </option>
            ))}
          </Select>
          {preset === 'custom' && (
            <Field label="Pola kustom" htmlFor="custom-fmt" hint='Contoh: #,##0.00 · "Rp"#,##0 · dd mmm yyyy · 0.0%'>
              <Input id="custom-fmt" className="addr" value={custom} onChange={(e) => setCustom(e.target.value)} />
            </Field>
          )}
          <p className="text-xs text-ink-2">
            Contoh: <span className="addr text-ink">{preview}</span>
          </p>
          <h3 className="mt-2 text-[13px] font-semibold">Perataan</h3>
          <div className="grid grid-cols-2 gap-2">
            <Select aria-label="Perataan horizontal" value={st.hAlign ?? ''} onChange={(e) => set({ hAlign: (e.target.value || undefined) as CellStyle['hAlign'] })}>
              <option value="">Horizontal: otomatis</option>
              <option value="left">Kiri</option>
              <option value="center">Tengah</option>
              <option value="right">Kanan</option>
            </Select>
            <Select aria-label="Perataan vertikal" value={st.vAlign ?? ''} onChange={(e) => set({ vAlign: (e.target.value || undefined) as CellStyle['vAlign'] })}>
              <option value="">Vertikal: bawah</option>
              <option value="top">Atas</option>
              <option value="middle">Tengah</option>
              <option value="bottom">Bawah</option>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Rotasi (derajat)" htmlFor="rot">
              <Input id="rot" type="number" min={-90} max={90} value={st.rotation ?? 0} onChange={(e) => set({ rotation: Math.max(-90, Math.min(90, Number(e.target.value) || 0)) || undefined })} />
            </Field>
            <Field label="Indentasi" htmlFor="ind">
              <Input id="ind" type="number" min={0} max={15} value={st.indent ?? 0} onChange={(e) => set({ indent: Math.max(0, Math.min(15, Number(e.target.value) || 0)) || undefined })} />
            </Field>
          </div>
          <Checkbox label="Bungkus teks" checked={!!st.wrap} onChange={(v) => set({ wrap: v || undefined })} />
        </section>
        <section className="flex flex-col gap-3">
          <h3 className="text-[13px] font-semibold">Huruf</h3>
          <div className="grid grid-cols-2 gap-x-2">
            <Checkbox label="Tebal" checked={!!st.bold} onChange={(v) => set({ bold: v || undefined })} />
            <Checkbox label="Miring" checked={!!st.italic} onChange={(v) => set({ italic: v || undefined })} />
            <Checkbox label="Garis bawah" checked={!!st.underline} onChange={(v) => set({ underline: v || undefined })} />
            <Checkbox label="Coret" checked={!!st.strike} onChange={(v) => set({ strike: v || undefined })} />
          </div>
          <Field label="Ukuran (pt)" htmlFor="fsize">
            <Input id="fsize" type="number" min={6} max={96} value={st.fontSize ?? 10} onChange={(e) => set({ fontSize: Number(e.target.value) === 10 ? undefined : Math.max(6, Math.min(96, Number(e.target.value) || 10)) })} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <ColorPicker
              label="Warna teks"
              resetLabel="Warna teks bawaan"
              value={st.textColor}
              onChange={(c) => set({ textColor: c })}
              trigger={
                <Button>
                  <span className="size-3.5 rounded-sm border border-line" style={{ background: st.textColor ?? 'var(--ink)' }} /> Warna teks
                </Button>
              }
            />
            <ColorPicker
              label="Warna isian"
              resetLabel="Tanpa isian"
              value={st.backgroundColor}
              onChange={(c) => set({ backgroundColor: c })}
              trigger={
                <Button>
                  <span className="size-3.5 rounded-sm border border-line" style={{ background: st.backgroundColor ?? 'transparent' }} /> Warna isian
                </Button>
              }
            />
          </div>
          <h3 className="mt-2 text-[13px] font-semibold">Batas</h3>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ['all', 'Semua'],
                ['outer', 'Luar'],
                ['bottom', 'Bawah'],
                ['none', 'Hapus'],
              ] as const
            ).map(([k, l]) => (
              <Button key={k} size="sm" onClick={() => ctrl.setBorders(k)}>
                {l}
              </Button>
            ))}
          </div>
          <p className="text-xs text-ink-2">Tombol batas langsung diterapkan pada rentang.</p>
        </section>
      </div>
    </Dialog>
  );
}

// ---------- conditional formatting ----------

const OPS: { op: ConditionOp; label: string; arity: 0 | 1 | 2 }[] = [
  { op: 'gt', label: 'Lebih besar dari', arity: 1 },
  { op: 'gte', label: 'Lebih besar atau sama dengan', arity: 1 },
  { op: 'lt', label: 'Lebih kecil dari', arity: 1 },
  { op: 'lte', label: 'Lebih kecil atau sama dengan', arity: 1 },
  { op: 'eq', label: 'Sama dengan', arity: 1 },
  { op: 'neq', label: 'Tidak sama dengan', arity: 1 },
  { op: 'between', label: 'Di antara', arity: 2 },
  { op: 'contains', label: 'Teks berisi', arity: 1 },
  { op: 'notContains', label: 'Teks tidak berisi', arity: 1 },
  { op: 'startsWith', label: 'Teks diawali', arity: 1 },
  { op: 'endsWith', label: 'Teks diakhiri', arity: 1 },
  { op: 'empty', label: 'Kosong', arity: 0 },
  { op: 'notEmpty', label: 'Tidak kosong', arity: 0 },
  { op: 'formula', label: 'Formula kustom', arity: 1 },
];

function ConditionalDialog() {
  const { open, close, ctrl } = useDialog('conditional');
  const sheetVersion = useEditor((s) => s.version);
  const [items, setItems] = useState<RuleRecord<ConditionalRule>[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setItems(structuredClone(ctrl.sheet()?.conditionalFormats ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  void sheetVersion;
  const add = () =>
    setItems([...items, { id: '', range: formatRangeA1(ctrl.selectionRange()), rule: { op: 'gt', value: '0', style: { backgroundColor: '#D9EAD3', textColor: '#274E13' } } }]);
  const update = (i: number, p: Partial<RuleRecord<ConditionalRule>>) => setItems(items.map((it, n) => (n === i ? { ...it, ...p } : it)));
  const updateRule = (i: number, p: Partial<ConditionalRule>) => update(i, { rule: { ...items[i].rule, ...p } });
  const valid = items.every((i) => parseRangeA1(i.range));
  const save = async () => {
    setBusy(true);
    try {
      await ctrl.saveConditional(items);
      close();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Format bersyarat"
      description="Aturan diperiksa dari atas. Aturan pertama yang cocok menentukan warna."
      width={620}
      footer={
        <>
          <Button onClick={close}>Batal</Button>
          <Button variant="primary" onClick={save} disabled={busy || !valid}>
            Simpan aturan
          </Button>
        </>
      }
    >
      {items.length === 0 && <p className="text-sm text-ink-2">Belum ada aturan di sheet ini.</p>}
      <ol className="flex flex-col gap-4">
        {items.map((it, i) => {
          const arity = OPS.find((o) => o.op === it.rule.op)?.arity ?? 0;
          return (
            <li key={i} className="rounded-md border border-line p-3">
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Rentang" htmlFor={`cf-r-${i}`} error={parseRangeA1(it.range) ? undefined : 'Contoh: B2:B100'}>
                  <RangeInput id={`cf-r-${i}`} className="w-32" value={it.range} onChange={(v) => update(i, { range: v })} />
                </Field>
                <Field label="Jika sel" htmlFor={`cf-op-${i}`}>
                  <Select id={`cf-op-${i}`} value={it.rule.op} onChange={(e) => updateRule(i, { op: e.target.value as ConditionOp })}>
                    {OPS.map((o) => (
                      <option key={o.op} value={o.op}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                {arity >= 1 && (
                  <Field label={it.rule.op === 'formula' ? 'Formula' : 'Nilai'} htmlFor={`cf-v-${i}`}>
                    <Input id={`cf-v-${i}`} className={clsx(it.rule.op === 'formula' && 'addr', 'w-40')} placeholder={it.rule.op === 'formula' ? '=B2>C2' : ''} value={it.rule.value ?? ''} onChange={(e) => updateRule(i, { value: e.target.value })} />
                  </Field>
                )}
                {arity === 2 && (
                  <Field label="dan" htmlFor={`cf-v2-${i}`}>
                    <Input id={`cf-v2-${i}`} className="w-24" value={it.rule.value2 ?? ''} onChange={(e) => updateRule(i, { value2: e.target.value })} />
                  </Field>
                )}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span
                  className="rounded border border-line px-3 py-1 text-sm"
                  style={{ background: it.rule.style.backgroundColor, color: it.rule.style.textColor, fontWeight: it.rule.style.bold ? 600 : 400, fontStyle: it.rule.style.italic ? 'italic' : undefined }}
                >
                  Contoh 123
                </span>
                <ColorPicker label="Warna isian" resetLabel="Tanpa isian" value={it.rule.style.backgroundColor} onChange={(c) => updateRule(i, { style: { ...it.rule.style, backgroundColor: c } })} trigger={<Button size="sm">Isian</Button>} />
                <ColorPicker label="Warna teks" resetLabel="Bawaan" value={it.rule.style.textColor} onChange={(c) => updateRule(i, { style: { ...it.rule.style, textColor: c } })} trigger={<Button size="sm">Teks</Button>} />
                <Checkbox label="Tebal" checked={!!it.rule.style.bold} onChange={(v) => updateRule(i, { style: { ...it.rule.style, bold: v || undefined } })} />
                <Button size="sm" variant="ghost" className="ml-auto text-danger" onClick={() => setItems(items.filter((_, n) => n !== i))}>
                  <Icon.Trash /> Hapus
                </Button>
              </div>
              {it.rule.op === 'formula' && <p className="mt-2 text-xs text-ink-2">Tulis formula untuk sel kiri atas rentang. Referensi relatif bergeser untuk sel lainnya.</p>}
            </li>
          );
        })}
      </ol>
      <Button className="mt-4" onClick={add}>
        <Icon.Plus /> Tambah aturan
      </Button>
    </Dialog>
  );
}

// ---------- data validation ----------

function ValidationDialog() {
  const { open, close, ctrl } = useDialog('validation');
  const [range, setRange] = useState('');
  const [kind, setKind] = useState<ValidationRule['kind']>('list');
  const [items, setItems] = useState('');
  const [op, setOp] = useState<'between' | 'gt' | 'gte' | 'lt' | 'lte' | 'eq'>('between');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [strict, setStrict] = useState(true);
  const [dropdown, setDropdown] = useState(true);
  const [busy, setBusy] = useState(false);
  const sheet = ctrl.sheet();
  useEffect(() => {
    if (!open) return;
    const r = formatRangeA1(ctrl.selectionRange());
    setRange(r);
    const existing = ctrl.sheet()?.validations.find((v) => v.range === r);
    if (existing) {
      const rule = existing.rule;
      setKind(rule.kind);
      if (rule.kind === 'list') {
        setItems(rule.items.join('\n'));
        setStrict(rule.strict);
        setDropdown(rule.showDropdown);
      }
      if (rule.kind === 'number') {
        setOp(rule.op);
        setMin(String(rule.min ?? ''));
        setMax(String(rule.max ?? ''));
        setStrict(rule.strict);
      }
      if (rule.kind === 'textLength') {
        setMax(String(rule.max));
        setStrict(rule.strict);
      }
    } else {
      setKind('list');
      setItems('');
    }
  }, [open, ctrl]);
  const build = (): ValidationRule | null => {
    if (kind === 'list') {
      const list = items.split(/\n|,/).map((s) => s.trim()).filter(Boolean);
      return list.length ? { kind, items: [...new Set(list)], strict, showDropdown: dropdown } : null;
    }
    if (kind === 'number') return { kind, op, min: min === '' ? undefined : Number(min), max: max === '' ? undefined : Number(max), strict };
    if (kind === 'textLength') return max ? { kind, max: Number(max), strict } : null;
    return { kind: 'checkbox' };
  };
  const rule = build();
  const save = async (remove = false) => {
    if (!parseRangeA1(range)) return toast.error('Rentang tidak valid');
    setBusy(true);
    try {
      const rest = (sheet?.validations ?? []).filter((v) => v.range !== range.toUpperCase());
      await ctrl.saveValidations(remove ? rest : [...rest, { id: '', range: range.toUpperCase(), rule: rule! }]);
      close();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Validasi data"
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={() => save(true)} disabled={busy || !sheet?.validations.some((v) => v.range === range.toUpperCase())}>
            Hapus aturan
          </Button>
          <Button onClick={close}>Batal</Button>
          <Button variant="primary" onClick={() => save()} disabled={busy || !rule}>
            Simpan
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Rentang" htmlFor="dv-range">
          <RangeInput id="dv-range" value={range} onChange={setRange} />
        </Field>
        <Field label="Kriteria" htmlFor="dv-kind">
          <Select id="dv-kind" value={kind} onChange={(e) => setKind(e.target.value as ValidationRule['kind'])}>
            <option value="list">Daftar pilihan (dropdown)</option>
            <option value="number">Angka</option>
            <option value="textLength">Panjang teks maksimal</option>
            <option value="checkbox">Kotak centang</option>
          </Select>
        </Field>
        {kind === 'list' && (
          <>
            <Field label="Pilihan" htmlFor="dv-items" hint="Satu pilihan per baris, atau pisahkan dengan koma.">
              <textarea id="dv-items" className="min-h-28 rounded-md border border-line-2 bg-surface p-2 text-sm focus-visible:outline-2 focus-visible:outline-brand" value={items} onChange={(e) => setItems(e.target.value)} />
            </Field>
            <Checkbox label="Tampilkan tombol dropdown di sel" checked={dropdown} onChange={setDropdown} />
          </>
        )}
        {kind === 'number' && (
          <div className="flex flex-wrap items-end gap-2">
            <Select aria-label="Operator" value={op} onChange={(e) => setOp(e.target.value as typeof op)}>
              <option value="between">di antara</option>
              <option value="gte">minimal</option>
              <option value="gt">lebih dari</option>
              <option value="lte">maksimal</option>
              <option value="lt">kurang dari</option>
              <option value="eq">sama dengan</option>
            </Select>
            {op !== 'lt' && op !== 'lte' && <Input aria-label="Nilai minimum" className="w-28" type="number" value={min} onChange={(e) => setMin(e.target.value)} />}
            {(op === 'between' || op === 'lt' || op === 'lte') && <Input aria-label="Nilai maksimum" className="w-28" type="number" value={max} onChange={(e) => setMax(e.target.value)} />}
          </div>
        )}
        {kind === 'textLength' && (
          <Field label="Maksimal karakter" htmlFor="dv-len">
            <Input id="dv-len" type="number" min={0} value={max} onChange={(e) => setMax(e.target.value)} />
          </Field>
        )}
        {kind !== 'checkbox' && (
          <Checkbox label="Tolak isian yang tidak valid (jika tidak dicentang, sel ditandai merah)" checked={strict} onChange={setStrict} />
        )}
      </div>
    </Dialog>
  );
}

// ---------- protected ranges ----------

function ProtectDialog() {
  const { open, close, ctrl } = useDialog('protect');
  const [items, setItems] = useState<ProtectedRangeRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const q = useQuery({
    queryKey: ['perms', ctrl.workbookId],
    enabled: open,
    queryFn: () => api.get<Perms>(`/api/workbooks/${ctrl.workbookId}/permissions`),
  });
  useEffect(() => {
    if (open) setItems(structuredClone(ctrl.sheet()?.protectedRanges ?? []));
  }, [open, ctrl]);
  const editors = (q.data?.permissions ?? []).filter((p) => p.permission === 'editor');
  const save = async () => {
    setBusy(true);
    try {
      await ctrl.saveProtected(items);
      close();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const update = (i: number, p: Partial<ProtectedRangeRecord>) => setItems(items.map((it, n) => (n === i ? { ...it, ...p } : it)));
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Sheet dan rentang dilindungi"
      description="Pemilik dan pengelola selalu dapat mengedit. Pilih editor lain yang tetap diizinkan."
      width={560}
      footer={
        <>
          <Button onClick={close}>Batal</Button>
          <Button variant="primary" onClick={save} disabled={busy || items.some((i) => (i.range !== null && !parseRangeA1(i.range)) || (i.exceptRanges ?? []).some((x) => !parseRangeA1(x)))}>
            Simpan
          </Button>
        </>
      }
    >
      {items.length === 0 && <p className="text-sm text-ink-2">Belum ada perlindungan di sheet ini.</p>}
      <ul className="flex flex-col gap-3">
        {items.map((it, i) => (
          <li key={i} className="rounded-md border border-line p-3">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Cakupan" htmlFor={`pr-k-${i}`}>
                <Select id={`pr-k-${i}`} value={it.range === null ? 'sheet' : 'range'} onChange={(e) => update(i, e.target.value === 'sheet' ? { range: null, exceptRanges: it.exceptRanges ?? [] } : { range: formatRangeA1(ctrl.selectionRange()) })}>
                  <option value="range">Rentang</option>
                  <option value="sheet">Seluruh sheet</option>
                </Select>
              </Field>
              {it.range !== null && (
                <Field label="Rentang" htmlFor={`pr-r-${i}`}>
                  <RangeInput id={`pr-r-${i}`} className="w-32" value={it.range} onChange={(v) => update(i, { range: v })} />
                </Field>
              )}
              <Field label="Keterangan" htmlFor={`pr-d-${i}`}>
                <Input id={`pr-d-${i}`} value={it.description ?? ''} onChange={(e) => update(i, { description: e.target.value })} />
              </Field>
            </div>
            {it.range === null && (
              <div className="mt-3">
                <p className="text-xs font-medium text-ink">Kecuali rentang ini (tetap bisa diedit semua orang)</p>
                {(it.exceptRanges ?? []).length === 0 && <p className="text-xs text-ink-2">Tidak ada pengecualian: seluruh sheet terkunci.</p>}
                <ul className="mt-1.5 flex flex-col gap-1.5">
                  {(it.exceptRanges ?? []).map((x, n) => (
                    <li key={n} className="flex items-center gap-1.5">
                      <RangeInput id={`pr-x-${i}-${n}`} className="w-36" value={x} onChange={(v) => update(i, { exceptRanges: (it.exceptRanges ?? []).map((y, m) => (m === n ? v : y)) })} />
                      {!parseRangeA1(x) && <span className="text-xs text-danger">Tidak valid</span>}
                      <button
                        type="button"
                        aria-label={`Hapus pengecualian ${x}`}
                        className="press inline-flex size-8 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 max-md:size-11"
                        onClick={() => update(i, { exceptRanges: (it.exceptRanges ?? []).filter((_, m) => m !== n) })}
                      >
                        <Icon.Close size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
                <Button size="sm" className="mt-2" onClick={() => update(i, { exceptRanges: [...(it.exceptRanges ?? []), formatRangeA1(ctrl.selectionRange())] })}>
                  <Icon.Unlock size={14} /> Kecualikan rentang terpilih
                </Button>
              </div>
            )}
            <p className="mt-3 text-xs font-medium text-ink">Editor yang tetap diizinkan</p>
            {editors.length === 0 ? (
              <p className="text-xs text-ink-2">Tidak ada editor lain di workbook ini.</p>
            ) : (
              <div className="flex flex-col">
                {editors.map((p) => (
                  <Checkbox
                    key={p.user.id}
                    label={`${p.user.name} (${p.user.email})`}
                    checked={it.editorIds.includes(p.user.id)}
                    onChange={(on) => update(i, { editorIds: on ? [...it.editorIds, p.user.id] : it.editorIds.filter((x) => x !== p.user.id) })}
                  />
                ))}
              </div>
            )}
            <Button size="sm" variant="ghost" className="mt-2 text-danger" onClick={() => setItems(items.filter((_, n) => n !== i))}>
              <Icon.Trash /> Hapus perlindungan
            </Button>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button onClick={() => setItems([...items, { id: '', range: formatRangeA1(ctrl.selectionRange()), description: '', editorIds: [] }])}>
          <Icon.Lock /> Lindungi rentang terpilih
        </Button>
        <Button disabled={items.some((i) => i.range === null)} onClick={() => setItems([...items, { id: '', range: null, description: '', editorIds: [], exceptRanges: [] }])}>
          <Icon.Shield /> Lindungi seluruh sheet
        </Button>
      </div>
    </Dialog>
  );
}

// ---------- sort / split / dedupe ----------

function ColumnSelect({ range, value, onChange, id }: { range: { c1: number; c2: number }; value: number; onChange: (c: number) => void; id: string }) {
  const cols = [];
  for (let c = range.c1; c <= range.c2; c++) cols.push(c);
  return (
    <Select id={id} value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {cols.map((c) => (
        <option key={c} value={c}>
          Kolom {colToLetters(c)}
        </option>
      ))}
    </Select>
  );
}

function SortDialog() {
  const { open, close, ctrl } = useDialog('sort');
  const [r, setR] = useState(ctrl.selectionRange());
  const [col, setCol] = useState(0);
  const [asc, setAsc] = useState(true);
  const [header, setHeader] = useState(false);
  useEffect(() => {
    if (!open) return;
    let sel = ctrl.selectionRange();
    if (sel.r1 === sel.r2 && sel.c1 === sel.c2) sel = ctrl.dataRegion(sel.r1, sel.c1);
    setR(ctrl.clampToUsed(sel));
    setCol(ctrl.s.selection.anchor.col);
  }, [open, ctrl]);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Urutkan rentang"
      description={`Rentang ${formatRangeA1(r)}`}
      footer={
        <>
          <Button onClick={close}>Batal</Button>
          <Button variant="primary" onClick={() => (ctrl.sortRange(r, col, asc, header), close())}>
            Urutkan
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Checkbox label="Baris pertama adalah judul kolom" checked={header} onChange={setHeader} />
        <Field label="Urutkan berdasarkan" htmlFor="sort-col">
          <ColumnSelect id="sort-col" range={r} value={col} onChange={setCol} />
        </Field>
        <Select aria-label="Arah" value={asc ? 'asc' : 'desc'} onChange={(e) => setAsc(e.target.value === 'asc')}>
          <option value="asc">A ke Z (kecil ke besar)</option>
          <option value="desc">Z ke A (besar ke kecil)</option>
        </Select>
      </div>
    </Dialog>
  );
}

function SplitDialog() {
  const { open, close, ctrl } = useDialog('split');
  const [delim, setDelim] = useState('auto');
  const [custom, setCustom] = useState('');
  const r = ctrl.selectionRange();
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Pisahkan teks ke kolom"
      description={`Teks di kolom ${colToLetters(r.c1)} (baris ${r.r1 + 1}-${r.r2 + 1}) dipecah ke kolom di sebelah kanannya. Isi kolom di kanan akan ditimpa.`}
      footer={
        <>
          <Button onClick={close}>Batal</Button>
          <Button variant="primary" disabled={delim === 'custom' && !custom} onClick={() => (ctrl.splitToColumns(r, delim === 'custom' ? custom : delim), close())}>
            Pisahkan
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Select aria-label="Pemisah" value={delim} onChange={(e) => setDelim(e.target.value)}>
          <option value="auto">Deteksi otomatis</option>
          <option value=",">Koma</option>
          <option value=";">Titik koma</option>
          <option value=" ">Spasi</option>
          <option value=".">Titik</option>
          <option value="custom">Lainnya</option>
        </Select>
        {delim === 'custom' && <Input aria-label="Pemisah kustom" value={custom} onChange={(e) => setCustom(e.target.value)} maxLength={10} />}
      </div>
    </Dialog>
  );
}

function DedupeDialog() {
  const { open, close, ctrl } = useDialog('dedupe');
  const [r, setR] = useState(ctrl.selectionRange());
  const [header, setHeader] = useState(true);
  const [cols, setCols] = useState<number[]>([]);
  useEffect(() => {
    if (!open) return;
    let sel = ctrl.selectionRange();
    if (sel.r1 === sel.r2 && sel.c1 === sel.c2) sel = ctrl.dataRegion(sel.r1, sel.c1);
    const c = ctrl.clampToUsed(sel);
    setR(c);
    setCols(Array.from({ length: c.c2 - c.c1 + 1 }, (_, i) => c.c1 + i));
  }, [open, ctrl]);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Hapus duplikat"
      description={`Rentang ${formatRangeA1(r)}. Baris yang sama pada kolom terpilih dihapus; baris pertama dipertahankan.`}
      footer={
        <>
          <Button onClick={close}>Batal</Button>
          <Button
            variant="primary"
            disabled={!cols.length}
            onClick={() => {
              const n = ctrl.removeDuplicates(r, cols, header);
              toast.success(n ? `${n} baris duplikat dihapus` : 'Tidak ada duplikat');
              close();
            }}
          >
            Hapus duplikat
          </Button>
        </>
      }
    >
      <Checkbox label="Data memiliki baris judul" checked={header} onChange={setHeader} />
      <p className="mt-3 text-xs font-medium">Bandingkan kolom</p>
      <div className="grid grid-cols-3 gap-x-3">
        {Array.from({ length: r.c2 - r.c1 + 1 }, (_, i) => r.c1 + i).map((c) => (
          <Checkbox key={c} label={`Kolom ${colToLetters(c)}`} checked={cols.includes(c)} onChange={(on) => setCols(on ? [...cols, c] : cols.filter((x) => x !== c))} />
        ))}
      </div>
    </Dialog>
  );
}

// ---------- link ----------

function LinkDialog() {
  const { open, close, ctrl } = useDialog('link');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  useEffect(() => {
    if (!open) return;
    setUrl(ctrl.activeStyle().link ?? '');
    const a = ctrl.s.selection.anchor;
    setText(ctrl.model.raw(ctrl.s.activeSheetId, a.row, a.col));
  }, [open, ctrl]);
  const normalized = url && !/^(https?:\/\/|mailto:)/i.test(url) ? (url.includes('@') && !url.includes('/') ? `mailto:${url}` : `https://${url}`) : url;
  const ok = !url || /^(https?:\/\/[^\s]+|mailto:[^\s@]+@[^\s@]+)$/i.test(normalized);
  const apply = () => {
    const a = ctrl.s.selection.anchor;
    const sid = ctrl.s.activeSheetId;
    const style = ctrl.model.style(sid, a.row, a.col) ?? {};
    ctrl.write([{ sheetId: sid, row: a.row, col: a.col, raw: text || normalized, style: { ...style, link: normalized || undefined } }], url ? 'Sisipkan tautan' : 'Hapus tautan');
    close();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Tautan"
      footer={
        <>
          {ctrl.activeStyle().link && (
            <Button variant="ghost" onClick={() => (setUrl(''), apply())}>
              Hapus tautan
            </Button>
          )}
          <Button onClick={close}>Batal</Button>
          <Button variant="primary" onClick={apply} disabled={!ok || !url}>
            Simpan
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Teks" htmlFor="ln-text">
          <Input id="ln-text" value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        <Field label="Alamat" htmlFor="ln-url" hint="http://, https:// atau alamat email." error={ok ? undefined : 'Alamat tidak valid'}>
          <Input id="ln-url" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus placeholder="https://" />
        </Field>
      </div>
    </Dialog>
  );
}

// ---------- help ----------

const SHORTCUTS: [string, string][] = [
  ['Panah', 'Pindah sel'],
  ['Shift + Panah', 'Perluas pilihan'],
  ['Ctrl + Panah', 'Lompat ke tepi data'],
  ['Enter / Shift + Enter', 'Edit sel, lalu pindah ke bawah / atas'],
  ['Tab / Shift + Tab', 'Pindah ke kanan / kiri'],
  ['F2', 'Edit sel aktif'],
  ['Alt + Enter', 'Baris baru di dalam sel'],
  ['Esc', 'Batalkan edit'],
  ['Delete', 'Hapus isi'],
  ['Ctrl + C / X / V', 'Salin / potong / tempel'],
  ['Ctrl + Z / Y', 'Urungkan / ulangi'],
  ['Ctrl + B / I / U', 'Tebal / miring / garis bawah'],
  ['Ctrl + 5', 'Coret'],
  ['Ctrl + Shift + L / E / R', 'Rata kiri / tengah / kanan'],
  ['Ctrl + A', 'Pilih semua'],
  ['Ctrl + Spasi / Shift + Spasi', 'Pilih kolom / baris'],
  ['Ctrl + F / H', 'Cari / cari dan ganti'],
  ['Ctrl + K', 'Sisipkan tautan'],
  ['Ctrl + Alt + M', 'Tambah komentar'],
  ['Ctrl + `', 'Tampilkan formula'],
  ['Alt + Panah bawah', 'Buka dropdown validasi'],
  ['Ctrl + /', 'Daftar pintasan ini'],
];

function ShortcutsDialog() {
  const { open, close } = useDialog('shortcuts');
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} title="Pintasan keyboard" width={520}>
      <p className="mb-3 text-xs text-ink-2">Di macOS, gunakan Cmd sebagai pengganti Ctrl.</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        {SHORTCUTS.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="addr text-[13px] text-ink">{k}</dt>
            <dd className="text-ink-2">{v}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}

function FunctionsDialog() {
  const { open, close, ctrl } = useDialog('functions');
  const can = useEditor((s) => s.can);
  const [q, setQ] = useState('');
  const fns = useMemo(() => listFunctions(), []);
  const shown = fns.filter((f) => !q || f.name.includes(q.toUpperCase()) || f.description.toLowerCase().includes(q.toLowerCase()));
  const byCat = new Map<string, typeof fns>();
  for (const f of shown) byCat.set(f.category, [...(byCat.get(f.category) ?? []), f]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} title="Daftar fungsi" description={`${fns.length} fungsi tersedia. Pilih untuk menyisipkan ke sel aktif.`} width={560}>
      <Input aria-label="Cari fungsi" placeholder="Cari fungsi" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      {[...byCat.entries()].map(([cat, list]) => (
        <section key={cat} className="mt-4">
          <h3 className="text-xs font-medium text-ink-2">{cat}</h3>
          <ul className="mt-1">
            {list.map((f) => (
              <li key={f.name}>
                <button
                  type="button"
                  disabled={!can.edit}
                  className="w-full rounded px-2 py-1.5 text-left hover:bg-surface-2 disabled:cursor-default disabled:hover:bg-transparent"
                  onClick={() => {
                    ctrl.set({ dialog: null });
                    ctrl.startEdit(`=${f.name}(`);
                  }}
                >
                  <span className="addr text-[13px] text-ink">{f.syntax}</span>
                  <span className="block text-xs text-ink-2">{f.description}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </Dialog>
  );
}

// ---------- import ----------

function ImportDialog() {
  const { open, close, ctrl } = useDialog('import');
  const [target, setTarget] = useState<'here' | 'new'>('here');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const run = async () => {
    if (!file) return;
    const kind = /\.xlsx$/i.test(file.name) ? 'xlsx' : /\.ods$/i.test(file.name) ? 'ods' : /\.(csv|tsv|txt)$/i.test(file.name) ? 'csv' : null;
    if (!kind) return toast.error('Format yang didukung: .xlsx, .ods, .csv, .tsv');
    const fd = new FormData();
    fd.append('file', file);
    if (target === 'here') fd.append('workbookId', ctrl.workbookId);
    setBusy(true);
    try {
      await ctrl.sync.flushNow();
      const r = await api.post<{ id: string }>(`/api/import/${kind}`, fd);
      toast.success('Impor selesai');
      close();
      if (target === 'new') nav(`/w/${r.id}`);
      else await ctrl.resync();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Impor berkas"
      description="XLSX, ODS, CSV atau TSV, maksimal 10 MB. Nilai, formula, format dasar, sel gabungan dan lebar kolom dibaca dari XLSX dan ODS."
      footer={
        <>
          <Button onClick={close}>Batal</Button>
          <Button variant="primary" onClick={run} disabled={!file || busy}>
            {busy && <Spinner className="border-white/40 border-t-white" />} Impor
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <input ref={inputRef} type="file" accept=".xlsx,.ods,.csv,.tsv" className="sr-only" tabIndex={-1} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <div className="flex items-center gap-3">
          <Button onClick={() => inputRef.current?.click()}>
            <Icon.Upload /> Pilih berkas
          </Button>
          <span className="truncate text-sm text-ink-2">{file ? file.name : 'Belum ada berkas dipilih'}</span>
        </div>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-[13px] font-medium">Tujuan</legend>
          <label className="flex min-h-8 items-center gap-2 text-sm max-md:min-h-11">
            <input type="radio" name="imp" checked={target === 'here'} onChange={() => setTarget('here')} className="accent-[var(--brand)]" /> Tambahkan sebagai sheet baru di workbook ini
          </label>
          <label className="flex min-h-8 items-center gap-2 text-sm max-md:min-h-11">
            <input type="radio" name="imp" checked={target === 'new'} onChange={() => setTarget('new')} className="accent-[var(--brand)]" /> Buat workbook baru
          </label>
        </fieldset>
      </div>
    </Dialog>
  );
}

function CreateFilterDialog() {
  const { open, close, ctrl } = useDialog('createFilter');
  const [text, setText] = useState('');
  const [shared, setShared] = useState(false);
  const range = useMemo(() => parseRangeA1(text.trim().toUpperCase()), [text]);
  const can = useEditor((s) => s.can);
  useEffect(() => {
    if (!open) return;
    const r = ctrl.defaultFilterRange();
    setText(formatRangeA1(r));
    setShared(false);
  }, [open, ctrl]);
  // Highlight the range on the grid while the dialog is open, and scroll to it.
  useEffect(() => {
    ctrl.set({ filterPreview: open && range ? range : null });
    return () => ctrl.set({ filterPreview: null });
  }, [open, range, ctrl]);
  const tooSmall = !!range && range.r1 === range.r2;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Buat filter"
      width={480}
      footer={
        <>
          <Button onClick={close}>Batal</Button>
          <Button
            variant="primary"
            disabled={!range || tooSmall}
            onClick={() => {
              ctrl.createFilterOn(range!, shared);
              close();
            }}
          >
            <Icon.Filter /> Buat filter
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Rentang filter"
          htmlFor="flt-range"
          hint="Baris pertama rentang menjadi judul kolom. Rentang disorot di sheet."
          error={text && !range ? 'Rentang tidak valid. Contoh: A1:D20' : tooSmall ? 'Rentang minimal dua baris: judul dan satu baris data.' : undefined}
        >
          <RangeInput id="flt-range" value={text} onChange={setText} autoFocus />
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[13px] font-medium">Siapa yang terpengaruh</legend>
          {(
            [
              [false, <Icon.Eye key="e" size={16} />, 'Hanya untuk saya', 'Orang lain tetap melihat semua baris. Tersimpan di browser ini.'],
              [true, <Icon.Users key="u" size={16} />, 'Untuk semua orang', 'Baris yang disaring ikut tersembunyi bagi semua pengguna workbook ini.'],
            ] as const
          ).map(([value, icon, label, desc]) => {
            const disabled = value && !can.edit;
            return (
              <label key={label} className={clsx('flex cursor-pointer items-start gap-3 rounded-md border p-3', shared === value ? 'border-brand bg-brand-soft' : 'border-line hover:bg-surface-2', disabled && 'cursor-not-allowed opacity-50')}>
                <input type="radio" name="flt-scope" className="mt-1 accent-[var(--brand)]" checked={shared === value} disabled={disabled} onChange={() => setShared(value)} />
                <span className="mt-0.5 text-ink-2">{icon}</span>
                <span>
                  <span className="block text-sm font-medium text-ink">{label}</span>
                  <span className="block text-xs text-ink-2">{desc}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
      </div>
    </Dialog>
  );
}

function FilesDialog() {
  const { open, close, ctrl } = useDialog('files');
  const q = useQuery({
    queryKey: ['files', ctrl.workbookId],
    enabled: open,
    queryFn: () => api.get<{ files: { id: string; filename: string; size: number; createdAt: string }[] }>(`/api/workbooks/${ctrl.workbookId}/files`),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} title="Berkas asli impor" description="Salinan berkas yang diimpor ke workbook ini, persis seperti saat diunggah.">
      {q.isLoading ? (
        <Spinner />
      ) : q.isError ? (
        <p className="text-sm text-danger">{errorMessage(q.error)}</p>
      ) : !q.data?.files.length ? (
        <p className="text-sm text-ink-2">Belum ada berkas yang diimpor ke workbook ini.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {q.data.files.map((f) => (
            <li key={f.id} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-ink">{f.filename}</p>
                <p className="text-xs text-ink-2">
                  {(f.size / 1024).toLocaleString('id-ID', { maximumFractionDigits: 1 })} KB · {dateTime(f.createdAt)}
                </p>
              </div>
              <a className="press inline-flex h-8 items-center gap-1.5 rounded-md border border-line-2 px-2.5 text-[13px] hover:bg-surface-2 max-md:h-11" href={`/api/workbooks/${ctrl.workbookId}/files/${f.id}`} download>
                <Icon.Download size={14} /> Unduh
              </a>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function FilterViewDialog() {
  const { open, close, ctrl } = useDialog('filterViews');
  const [name, setName] = useState('');
  useEffect(() => {
    if (open) setName('');
  }, [open]);
  const views = ctrl.sheet()?.metadata.filterViews ?? [];
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Tampilan filter"
      description="Simpan filter saat ini dengan nama. Tampilan filter hanya mengubah apa yang Anda lihat, bukan kolaborator lain."
      footer={
        <>
          <Button onClick={close}>Tutup</Button>
          <Button
            variant="primary"
            disabled={!name.trim()}
            onClick={() => {
              ctrl.saveFilterView(name.trim());
              toast.success('Tampilan filter disimpan');
              close();
            }}
          >
            Simpan
          </Button>
        </>
      }
    >
      <Field label="Nama tampilan" htmlFor="fv-name">
        <Input id="fv-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={60} />
      </Field>
      {views.length > 0 && (
        <ul className="mt-4 flex flex-col gap-1">
          {views.map((v) => (
            <li key={v.id} className="flex items-center justify-between text-sm">
              <span>{v.name}</span>
              <Button size="sm" variant="ghost" className="text-danger" onClick={() => ctrl.deleteFilterView(v.id)}>
                Hapus
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

// ---------- mobile sheets ----------

function BottomSheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  return (
    <BDialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <BDialog.Portal>
        <BDialog.Backdrop className="scrim fixed inset-0 z-40 bg-[var(--scrim)]" />
        <BDialog.Popup className="sheet fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-xl border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] text-ink shadow-pop outline-none">
          <div className="flex items-center justify-between border-b border-line px-4 py-2">
            <BDialog.Title className="text-sm font-semibold">{title}</BDialog.Title>
            <BDialog.Close aria-label="Tutup" className="press inline-flex size-11 items-center justify-center rounded-md text-ink-2">
              <Icon.Close />
            </BDialog.Close>
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        </BDialog.Popup>
      </BDialog.Portal>
    </BDialog.Root>
  );
}

/** On phones the formula bar opens as a panel with a large input (PRD 5.4). */
function MobileFormulaSheet() {
  const ctrl = useCtrl();
  const open = useEditor((s) => s.dialog === 'mobileFormula');
  const editing = useEditor((s) => s.editing);
  const [caret, setCaret] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const assist = useFormulaAssist(editing?.value ?? '', caret);
  const addr = editing ? `${colToLetters(editing.col)}${editing.row + 1}` : '';
  const close = () => {
    ctrl.cancelEdit();
    ctrl.set({ dialog: null });
  };
  const commit = (move: 'down' | 'right' | 'none') => {
    if (ctrl.commitEdit(move)) ctrl.set({ dialog: null });
  };
  const insert = (s: string) => {
    if (!editing) return;
    const el = ref.current;
    const at = el?.selectionStart ?? editing.value.length;
    const v = editing.value.slice(0, at) + s + editing.value.slice(at);
    ctrl.updateEdit(v);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + s.length, at + s.length);
      setCaret(at + s.length);
    });
  };
  return (
    <BottomSheet open={open && !!editing} onClose={close} title={`Edit ${addr}`}>
      {editing && (
        <div className="flex flex-col gap-3">
          <textarea
            ref={ref}
            autoFocus
            aria-label={`Isi sel ${addr}`}
            className={clsx('min-h-24 w-full rounded-md border border-line-2 bg-surface p-3 text-base text-ink focus-visible:outline-2 focus-visible:outline-brand', editing.value.startsWith('=') && 'addr')}
            value={editing.value}
            onChange={(e) => {
              ctrl.updateEdit(e.target.value);
              setCaret(e.target.selectionStart);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          />
          <div className="flex flex-wrap gap-2">
            {['=', '(', ')', ',', ':', '+', '-', '*', '/', '"'].map((s) => (
              <button key={s} type="button" className="press addr inline-flex size-11 items-center justify-center rounded-md border border-line-2 text-base" onClick={() => insert(s)}>
                {s}
              </button>
            ))}
          </div>
          {(editing.value === '' || editing.value === '=') && (
            <SuggestChips
              row={editing.row}
              col={editing.col}
              onPick={(formula) => {
                ctrl.updateEdit(formula);
                commit('down');
              }}
            />
          )}
          <AssistPanel
            assist={assist}
            active={0}
            id="mobile-assist"
            className="w-full"
            onPick={(name) => {
              if (!assist.token) return;
              const r = applySuggestion(editing.value, assist.token, name);
              ctrl.updateEdit(r.value);
              requestAnimationFrame(() => {
                ref.current?.setSelectionRange(r.caret, r.caret);
                setCaret(r.caret);
              });
            }}
          />
          <div className="flex gap-2">
            <Button className="flex-1" onClick={close}>
              Batal
            </Button>
            <Button className="flex-1" onClick={() => commit('right')}>
              Simpan, ke kanan
            </Button>
            <Button className="flex-1" variant="primary" onClick={() => commit('down')}>
              Simpan
            </Button>
          </div>
        </div>
      )}
    </BottomSheet>
  );
}

function MobileFormatSheet() {
  const { open, close, ctrl } = useDialog('mobileFormat');
  useEditor((s) => s.version);
  useEditor((s) => s.selection);
  const st = ctrl.activeStyle();
  const T = ({ on, label, onClick, children }: { on?: boolean; label: string; onClick: () => void; children: ReactNode }) => (
    <button type="button" aria-label={label} aria-pressed={on} className={clsx('press inline-flex h-11 min-w-11 items-center justify-center rounded-md border px-2', on ? 'border-brand bg-brand-soft' : 'border-line-2')} onClick={onClick}>
      {children}
    </button>
  );
  return (
    <BottomSheet open={open} onClose={close} title="Format">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          <T label="Tebal" on={!!st.bold} onClick={() => ctrl.toggleStyle('bold')}>
            <b>B</b>
          </T>
          <T label="Miring" on={!!st.italic} onClick={() => ctrl.toggleStyle('italic')}>
            <i className="font-serif">I</i>
          </T>
          <T label="Garis bawah" on={!!st.underline} onClick={() => ctrl.toggleStyle('underline')}>
            <u>U</u>
          </T>
          <T label="Coret" on={!!st.strike} onClick={() => ctrl.toggleStyle('strike')}>
            <s>S</s>
          </T>
          <T label="Bungkus teks" on={!!st.wrap} onClick={() => ctrl.toggleStyle('wrap')}>
            <Icon.Wrap />
          </T>
        </div>
        <div className="flex flex-wrap gap-2">
          <T label="Rata kiri" on={st.hAlign === 'left'} onClick={() => ctrl.applyStyle({ hAlign: 'left' })}>
            <Icon.AlignLeft />
          </T>
          <T label="Rata tengah" on={st.hAlign === 'center'} onClick={() => ctrl.applyStyle({ hAlign: 'center' })}>
            <Icon.AlignCenter />
          </T>
          <T label="Rata kanan" on={st.hAlign === 'right'} onClick={() => ctrl.applyStyle({ hAlign: 'right' })}>
            <Icon.AlignRight />
          </T>
          <T label="Gabungkan sel" onClick={() => ctrl.merge()}>
            <Icon.Merge />
          </T>
          <T label="Semua batas" onClick={() => ctrl.setBorders('all')}>
            <Icon.Borders />
          </T>
        </div>
        <div className="flex flex-wrap gap-2">
          <ColorPicker label="Warna teks" resetLabel="Warna teks bawaan" value={st.textColor} onChange={(c) => ctrl.applyStyle({ textColor: c })} trigger={<Button>Warna teks</Button>} />
          <ColorPicker label="Warna isian" resetLabel="Tanpa isian" value={st.backgroundColor} onChange={(c) => ctrl.applyStyle({ backgroundColor: c })} trigger={<Button>Warna isian</Button>} />
        </div>
        <Field label="Format angka" htmlFor="m-nf">
          <Select id="m-nf" value={st.numberFormat ?? 'auto'} onChange={(e) => ctrl.applyStyle({ numberFormat: e.target.value === 'auto' ? undefined : e.target.value })}>
            {PRESETS.filter(([id]) => id !== 'custom').map(([id, l]) => (
              <option key={id} value={id}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Button onClick={() => ctrl.clearFormatting()}>
          <Icon.ClearFormat /> Hapus format
        </Button>
      </div>
    </BottomSheet>
  );
}

function MobileMenuSheet() {
  const { open, close, ctrl } = useDialog('mobileMenu');
  const can = useEditor((s) => s.can);
  const canUndo = useEditor((s) => s.canUndo);
  const canRedo = useEditor((s) => s.canRedo);
  const actions = useWorkbookActions();
  const me = useMe();
  void me;
  const go = (fn: () => void) => () => {
    ctrl.set({ dialog: null });
    fn();
  };
  const Row = ({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) => (
    <button type="button" disabled={disabled} className="flex min-h-11 w-full items-center rounded-md px-2 text-left text-sm hover:bg-surface-2 disabled:opacity-40" onClick={onClick}>
      {children}
    </button>
  );
  const ro = !can.edit;
  return (
    <BottomSheet open={open} onClose={close} title="Menu">
      <div className="grid grid-cols-1 gap-4">
        <section>
          <h3 className="px-2 text-xs text-ink-2">Edit</h3>
          <Row onClick={go(() => ctrl.undo())} disabled={!canUndo || ro}>
            Urungkan
          </Row>
          <Row onClick={go(() => ctrl.redo())} disabled={!canRedo || ro}>
            Ulangi
          </Row>
          <Row onClick={go(() => clipboardAction(ctrl, 'copy'))}>Salin</Row>
          <Row onClick={go(() => clipboardAction(ctrl, 'cut'))} disabled={ro}>
            Potong
          </Row>
          <Row onClick={go(() => clipboardAction(ctrl, 'paste'))} disabled={ro}>
            Tempel
          </Row>
          <Row onClick={go(() => ctrl.clearContents())} disabled={ro}>
            Hapus isi
          </Row>
          <Row onClick={go(() => ctrl.set({ dialog: 'find', findOpenReplace: !ro }))}>Cari dan ganti</Row>
        </section>
        <section>
          <h3 className="px-2 text-xs text-ink-2">Baris dan kolom</h3>
          <Row onClick={go(() => ctrl.insertRows('below'))} disabled={ro}>
            Sisipkan baris di bawah
          </Row>
          <Row onClick={go(() => ctrl.insertCols('right'))} disabled={ro}>
            Sisipkan kolom di kanan
          </Row>
          <Row onClick={go(() => ctrl.deleteRows())} disabled={ro}>
            Hapus baris
          </Row>
          <Row onClick={go(() => ctrl.deleteCols())} disabled={ro}>
            Hapus kolom
          </Row>
          <Row onClick={go(() => ctrl.freeze(ctrl.sheet()!.frozenRows ? 0 : 1, null))} disabled={ro}>
            {ctrl.sheet()?.frozenRows ? 'Lepas baris beku' : 'Bekukan baris pertama'}
          </Row>
        </section>
        <section>
          <h3 className="px-2 text-xs text-ink-2">Data</h3>
          <Row onClick={go(() => ctrl.sortSelection(true))} disabled={ro}>
            Urutkan A ke Z
          </Row>
          <Row onClick={go(() => ctrl.sortSelection(false))} disabled={ro}>
            Urutkan Z ke A
          </Row>
          <Row onClick={go(() => ctrl.createFilter())} disabled={ro}>
            {ctrl.activeFilter() ? 'Hapus filter' : 'Buat filter'}
          </Row>
          <Row onClick={go(() => ctrl.set({ dialog: 'validation' }))} disabled={ro}>
            Validasi data
          </Row>
          <Row onClick={go(() => insertCheckbox(ctrl))} disabled={ro}>
            Kotak centang
          </Row>
          <Row onClick={go(() => ctrl.openCommentDraft())} disabled={!can.comment}>
            Tambah komentar
          </Row>
        </section>
        <section>
          <h3 className="px-2 text-xs text-ink-2">Berkas</h3>
          <Row onClick={go(() => ctrl.set({ dialog: 'import' }))} disabled={ro}>
            Impor berkas
          </Row>
          <Row onClick={go(() => actions.download('xlsx'))}>Unduh .xlsx</Row>
          <Row onClick={go(() => actions.download('ods'))}>Unduh .ods</Row>
          <Row onClick={go(() => actions.download('csv'))}>Unduh .csv (sheet aktif)</Row>
          <Row onClick={go(() => actions.download('pdf'))}>Unduh .pdf</Row>
          <Row onClick={go(() => actions.duplicate())}>Buat salinan</Row>
          <Row onClick={go(() => ctrl.set({ panel: 'history' }))}>Riwayat versi</Row>
        </section>
      </div>
    </BottomSheet>
  );
}
