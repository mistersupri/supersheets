import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { Button, Checkbox, Field, Input, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useMe, type User } from '../lib/auth';

function safeNext(next: string | null): string {
  // Only same-site paths, never protocol-relative or absolute URLs.
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

function Shell({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="flex min-h-full flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-[380px]">
        <p className="mb-8 text-lg font-semibold tracking-tight text-ink">OpenSheet</p>
        <h1 className="text-[22px] font-semibold leading-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1.5 text-sm text-ink-2">{subtitle}</p>}
        <div className="mt-6">{children}</div>
        {footer && <div className="mt-6 border-t border-line pt-4 text-sm text-ink-2">{footer}</div>}
      </div>
    </main>
  );
}

function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-ink">
      {message}
    </p>
  );
}

export function LoginPage() {
  const me = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const config = useQuery({ queryKey: ['auth-config'], queryFn: () => api.get<{ registrationEnabled: boolean }>('/api/auth/config') });
  if (me.data) return <Navigate to={safeNext(params.get('next'))} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ user: User }>('/api/auth/login', { email, password, remember });
      qc.setQueryData(['me'], { user: r.user, settings: { linkSharingEnabled: true } });
      await qc.invalidateQueries({ queryKey: ['me'] });
      nav(safeNext(params.get('next')), { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell
      title="Masuk"
      subtitle="Lanjutkan pekerjaan di spreadsheet Anda."
      footer={
        config.data?.registrationEnabled ? (
          <>
            Belum punya akun?{' '}
            <Link className="font-medium text-brand underline underline-offset-2" to="/register">
              Daftar
            </Link>
          </>
        ) : (
          'Pendaftaran akun baru dinonaktifkan. Hubungi admin untuk dibuatkan akun.'
        )
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <FormError message={error} />
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Field label="Kata sandi" htmlFor="password">
          <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <div className="flex items-center justify-between gap-2">
          <Checkbox label="Ingat saya" checked={remember} onChange={setRemember} />
          <Link to="/forgot-password" className="text-sm text-brand underline underline-offset-2">
            Lupa kata sandi?
          </Link>
        </div>
        <Button type="submit" variant="primary" disabled={busy || !email || !password}>
          {busy && <Spinner className="border-white/40 border-t-white" />}
          Masuk
        </Button>
      </form>
    </Shell>
  );
}

export function RegisterPage() {
  const me = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const config = useQuery({ queryKey: ['auth-config'], queryFn: () => api.get<{ registrationEnabled: boolean }>('/api/auth/config') });
  if (me.data) return <Navigate to="/" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 8) return setError('Kata sandi minimal 8 karakter.');
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/register', { name, email, password });
      await qc.invalidateQueries({ queryKey: ['me'] });
      nav('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (config.isLoading) return <Shell title="Daftar"><Spinner /></Shell>;
  if (config.data && !config.data.registrationEnabled)
    return (
      <Shell title="Pendaftaran ditutup" subtitle="Admin menonaktifkan pendaftaran mandiri. Minta admin membuatkan akun untuk Anda.">
        <Link className="text-sm font-medium text-brand underline underline-offset-2" to="/login">
          Kembali ke halaman masuk
        </Link>
      </Shell>
    );

  return (
    <Shell
      title="Buat akun"
      footer={
        <>
          Sudah punya akun?{' '}
          <Link className="font-medium text-brand underline underline-offset-2" to="/login">
            Masuk
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <FormError message={error} />
        <Field label="Nama" htmlFor="name">
          <Input id="name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Kata sandi" htmlFor="password" hint="Minimal 8 karakter.">
          <Input id="password" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" disabled={busy || !name || !email || !password}>
          {busy && <Spinner className="border-white/40 border-t-white" />}
          Buat akun
        </Button>
      </form>
    </Shell>
  );
}

export function ForgotPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/forgot-password', { email });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Shell
      title="Atur ulang kata sandi"
      subtitle="Kami kirimkan tautan untuk membuat kata sandi baru."
      footer={
        <Link className="font-medium text-brand underline underline-offset-2" to="/login">
          Kembali ke halaman masuk
        </Link>
      }
    >
      {sent ? (
        <p role="status" className="rounded-md border border-line bg-surface px-3 py-3 text-sm text-ink">
          Jika <strong>{email}</strong> terdaftar, tautan pengaturan ulang sudah dikirim. Tautan berlaku 1 jam.
        </p>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <FormError message={error} />
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </Field>
          <Button type="submit" variant="primary" disabled={busy || !email}>
            {busy && <Spinner className="border-white/40 border-t-white" />}
            Kirim tautan
          </Button>
        </form>
      )}
    </Shell>
  );
}

export function ResetPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 8) return setError('Kata sandi minimal 8 karakter.');
    if (password !== confirm) return setError('Konfirmasi kata sandi tidak sama.');
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/reset-password', { token, password });
      nav('/login', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  if (!token)
    return (
      <Shell title="Tautan tidak lengkap" subtitle="Buka tautan dari email pengaturan ulang, atau minta tautan baru.">
        <Link className="text-sm font-medium text-brand underline underline-offset-2" to="/forgot-password">
          Minta tautan baru
        </Link>
      </Shell>
    );
  return (
    <Shell title="Buat kata sandi baru">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <FormError message={error} />
        <Field label="Kata sandi baru" htmlFor="password" hint="Minimal 8 karakter.">
          <Input id="password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </Field>
        <Field label="Ulangi kata sandi" htmlFor="confirm">
          <Input id="confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" disabled={busy || !password}>
          {busy && <Spinner className="border-white/40 border-t-white" />}
          Simpan kata sandi
        </Button>
      </form>
    </Shell>
  );
}
