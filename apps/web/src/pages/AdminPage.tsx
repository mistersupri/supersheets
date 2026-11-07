import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button, Checkbox, Dialog, ErrorState, Field, Input, Select, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useMe } from '../lib/auth';
import { dateTime } from '../lib/format';
import { PageShell, Section } from './PageShell';

interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
  createdAt: string;
  lockedUntil: string | null;
  workbookCount: number;
}

interface Log {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  createdAt: string;
  ip: string | null;
  user: { name: string; email: string } | null;
}

const ACTIONS: Record<string, string> = {
  'auth.login': 'Masuk',
  'auth.login_failed': 'Gagal masuk',
  'auth.register': 'Daftar',
  'auth.reset_requested': 'Minta atur ulang sandi',
  'auth.reset_done': 'Atur ulang sandi',
  'auth.password_changed': 'Ganti sandi',
  'workbook.create': 'Buat workbook',
  'workbook.duplicate': 'Salin workbook',
  'workbook.trash': 'Buang workbook',
  'workbook.restore': 'Pulihkan workbook',
  'workbook.delete_permanent': 'Hapus permanen',
  'share.grant': 'Beri akses',
  'share.invite': 'Undang',
  'share.update': 'Ubah akses',
  'share.revoke': 'Cabut akses',
  'share.link': 'Ubah akses tautan',
  'history.restore': 'Pulihkan versi',
  'import.xlsx': 'Impor XLSX',
  'import.csv': 'Impor CSV',
  'import.tsv': 'Impor TSV',
  'admin.user_create': 'Admin: buat pengguna',
  'admin.user_update': 'Admin: ubah pengguna',
  'admin.settings': 'Admin: ubah pengaturan',
};

export default function AdminPage() {
  const me = useMe();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const users = useQuery({ queryKey: ['admin-users', q], queryFn: () => api.get<{ users: AdminUser[] }>(`/api/admin/users${q ? `?q=${encodeURIComponent(q)}` : ''}`) });
  const settings = useQuery({ queryKey: ['admin-settings'], queryFn: () => api.get<{ settings: { registrationEnabled: boolean; linkSharingEnabled: boolean } }>('/api/admin/settings') });
  const logs = useQuery({ queryKey: ['admin-logs'], queryFn: () => api.get<{ logs: Log[] }>('/api/admin/audit-logs') });

  const patchUser = async (id: string, body: Record<string, unknown>) => {
    try {
      await api.patch(`/api/admin/users/${id}`, body);
      qc.invalidateQueries({ queryKey: ['admin-users'] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const patchSettings = async (body: Record<string, boolean>) => {
    const prev = qc.getQueryData(['admin-settings']);
    // Optimistic: the checkbox reflects the click immediately, and an older refetch may not overwrite it.
    qc.setQueryData(['admin-settings'], (old: { settings: Record<string, boolean> } | undefined) => (old ? { settings: { ...old.settings, ...body } } : old));
    void qc.cancelQueries({ queryKey: ['admin-settings'] }, { revert: false });
    try {
      await api.patch('/api/admin/settings', body);
      qc.invalidateQueries({ queryKey: ['admin-settings'] });
      toast.success('Pengaturan disimpan');
    } catch (e) {
      qc.setQueryData(['admin-settings'], prev);
      toast.error(errorMessage(e));
    }
  };

  return (
    <PageShell title="Administrasi">
      <p className="mt-1 text-sm text-ink-2">Peran aplikasi terpisah dari akses workbook: Super Admin mengelola pengguna dan sistem, tetapi tidak otomatis bisa membuka isi workbook orang lain.</p>
      <Section title="Pengaturan sistem">
        {settings.isLoading ? (
          <Spinner />
        ) : settings.isError ? (
          <ErrorState message={errorMessage(settings.error)} onRetry={() => settings.refetch()} />
        ) : (
          <div className="flex flex-col gap-1">
            <Checkbox label="Izinkan pendaftaran akun baru" checked={settings.data!.settings.registrationEnabled} onChange={(v) => patchSettings({ registrationEnabled: v })} />
            <Checkbox label="Izinkan berbagi lewat tautan" checked={settings.data!.settings.linkSharingEnabled} onChange={(v) => patchSettings({ linkSharingEnabled: v })} />
          </div>
        )}
      </Section>
      <Section title="Pengguna" description="Nonaktifkan akun untuk mencabut semua sesinya.">
        <div className="flex flex-wrap gap-2">
          <Input aria-label="Cari pengguna" placeholder="Cari nama atau email" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
          <Button variant="primary" onClick={() => setCreating(true)}>
            Tambah pengguna
          </Button>
        </div>
        {users.isLoading ? (
          <Spinner className="mt-4" />
        ) : users.isError ? (
          <ErrorState message={errorMessage(users.error)} onRetry={() => users.refetch()} />
        ) : users.data!.users.length === 0 ? (
          <p className="mt-4 text-sm text-ink-2">Tidak ada pengguna yang cocok.</p>
        ) : (
          <ul className="mt-3 flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
            {users.data!.users.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink">
                    {u.name} {!u.isActive && <span className="ml-1 text-xs text-danger">nonaktif</span>}
                    {u.lockedUntil && new Date(u.lockedUntil) > new Date() && <span className="ml-1 text-xs text-accent">terkunci</span>}
                  </p>
                  <p className="truncate text-xs text-ink-2">
                    {u.email} · {u.workbookCount} workbook · sejak {dateTime(u.createdAt)}
                  </p>
                </div>
                <Select aria-label={`Peran ${u.name}`} value={u.role} disabled={u.id === me.data?.user.id} onChange={(e) => patchUser(u.id, { role: e.target.value })}>
                  <option value="user">Pengguna</option>
                  <option value="super_admin">Super Admin</option>
                </Select>
                {u.lockedUntil && new Date(u.lockedUntil) > new Date() && (
                  <Button size="sm" onClick={() => patchUser(u.id, { unlock: true })}>
                    Buka kunci
                  </Button>
                )}
                <Button size="sm" disabled={u.id === me.data?.user.id} onClick={() => patchUser(u.id, { isActive: !u.isActive })}>
                  {u.isActive ? 'Nonaktifkan' : 'Aktifkan'}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Log audit" description="100 aktivitas penting terakhir.">
        {logs.isLoading ? (
          <Spinner />
        ) : logs.isError ? (
          <ErrorState message={errorMessage(logs.error)} onRetry={() => logs.refetch()} />
        ) : logs.data!.logs.length === 0 ? (
          <p className="text-sm text-ink-2">Belum ada aktivitas.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface text-sm">
            {logs.data!.logs.map((l) => (
              <li key={l.id} className="px-3 py-2">
                <p className="text-ink">
                  {ACTIONS[l.action] ?? l.action} <span className="text-ink-2">oleh {l.user?.name ?? 'tidak dikenal'}</span>
                </p>
                <p className="text-xs text-ink-2">
                  {dateTime(l.createdAt)}
                  {l.ip ? ` · ${l.ip}` : ''}
                  {l.targetType ? ` · ${l.targetType}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <CreateUserDialog open={creating} onOpenChange={setCreating} onCreated={() => qc.invalidateQueries({ queryKey: ['admin-users'] })} />
    </PageShell>
  );
}

function CreateUserDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('user');
  const [busy, setBusy] = useState(false);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    try {
      await api.post('/api/admin/users', { name, email, password, role });
      toast.success('Pengguna dibuat');
      onCreated();
      onOpenChange(false);
      setName('');
      setEmail('');
      setPassword('');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Tambah pengguna"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Batal</Button>
          <Button variant="primary" onClick={() => submit()} disabled={busy || !name || !email || password.length < 8}>
            Buat akun
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Nama" htmlFor="u-name">
          <Input id="u-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Email" htmlFor="u-email">
          <Input id="u-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Kata sandi awal" htmlFor="u-pw" hint="Minimal 8 karakter. Sampaikan ke pengguna lewat jalur aman.">
          <Input id="u-pw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Peran" htmlFor="u-role">
          <Select id="u-role" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="user">Pengguna</option>
            <option value="super_admin">Super Admin</option>
          </Select>
        </Field>
      </form>
    </Dialog>
  );
}
