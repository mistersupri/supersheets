import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button, ErrorState, Field, Input, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useMe } from '../lib/auth';
import { dateTime } from '../lib/format';
import { useTheme, type ThemePref } from '../lib/theme';
import { PageShell, Section } from './PageShell';

export default function SettingsPage() {
  const me = useMe();
  const qc = useQueryClient();
  const user = me.data!.user;
  const [name, setName] = useState(user.name);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const { pref, setTheme } = useTheme();
  useEffect(() => setName(user.name), [user.name]);
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.get<{ sessions: { id: string; current: boolean; createdAt: string; expiresAt: string; userAgent: string | null; ip: string | null }[] }>('/api/auth/sessions'),
  });

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('name');
    try {
      await api.patch('/api/auth/me', { name });
      await qc.invalidateQueries({ queryKey: ['me'] });
      toast.success('Nama diperbarui');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const savePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (next.length < 8) return toast.error('Kata sandi baru minimal 8 karakter.');
    setBusy('pw');
    try {
      await api.patch('/api/auth/me', { currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      sessions.refetch();
      toast.success('Kata sandi diganti. Sesi di perangkat lain telah keluar.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <PageShell title="Pengaturan akun">
      <Section title="Profil" description={user.email}>
        <form onSubmit={saveName} className="flex max-w-md flex-col gap-3">
          <Field label="Nama" htmlFor="s-name">
            <Input id="s-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </Field>
          <div>
            <Button type="submit" variant="primary" disabled={busy === 'name' || !name.trim() || name === user.name}>
              Simpan nama
            </Button>
          </div>
        </form>
      </Section>
      <Section title="Kata sandi" description="Mengganti kata sandi akan mengeluarkan sesi di perangkat lain.">
        <form onSubmit={savePassword} className="flex max-w-md flex-col gap-3">
          <Field label="Kata sandi saat ini" htmlFor="s-cur">
            <Input id="s-cur" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
          <Field label="Kata sandi baru" htmlFor="s-new" hint="Minimal 8 karakter.">
            <Input id="s-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <div>
            <Button type="submit" variant="primary" disabled={busy === 'pw' || !current || !next}>
              Ganti kata sandi
            </Button>
          </div>
        </form>
      </Section>
      <Section title="Tampilan">
        <fieldset className="flex flex-col gap-1">
          <legend className="sr-only">Tema</legend>
          {(
            [
              ['system', 'Ikuti sistem'],
              ['light', 'Terang'],
              ['dark', 'Gelap'],
            ] as [ThemePref, string][]
          ).map(([v, l]) => (
            <label key={v} className="flex min-h-9 items-center gap-2 text-sm max-md:min-h-11">
              <input type="radio" name="theme" checked={pref === v} onChange={() => setTheme(v)} className="accent-[var(--brand)]" /> {l}
            </label>
          ))}
        </fieldset>
      </Section>
      <Section title="Sesi aktif" description="Perangkat yang sedang masuk ke akun Anda.">
        {sessions.isLoading ? (
          <Spinner />
        ) : sessions.isError ? (
          <ErrorState message={errorMessage(sessions.error)} onRetry={() => sessions.refetch()} />
        ) : (
          <>
            <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
              {sessions.data!.sessions.map((s) => (
                <li key={s.id} className="px-3 py-2 text-sm">
                  <p className="truncate text-ink">
                    {s.userAgent ?? 'Peramban tidak dikenal'} {s.current && <span className="ml-1 text-xs font-medium text-brand">(sesi ini)</span>}
                  </p>
                  <p className="text-xs text-ink-2">
                    Masuk {dateTime(s.createdAt)} · berakhir {dateTime(s.expiresAt)}
                    {s.ip ? ` · ${s.ip}` : ''}
                  </p>
                </li>
              ))}
            </ul>
            <Button
              className="mt-3"
              disabled={sessions.data!.sessions.length <= 1}
              onClick={async () => {
                try {
                  const r = await api.post<{ revoked: number }>('/api/auth/sessions/revoke-others');
                  toast.success(`${r.revoked} sesi lain dikeluarkan`);
                  sessions.refetch();
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            >
              Keluarkan sesi lain
            </Button>
          </>
        )}
      </Section>
    </PageShell>
  );
}
