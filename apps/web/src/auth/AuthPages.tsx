import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { PasswordField } from '../components/PasswordField';
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

const GOOGLE_ERRORS: Record<string, string> = {
  google_denied: 'Masuk dengan Google dibatalkan.',
  google_state: 'Sesi masuk dengan Google sudah kedaluwarsa. Coba lagi.',
  google_failed: 'Tidak dapat menyelesaikan masuk dengan Google. Coba lagi.',
  google_unverified: 'Email akun Google ini belum terverifikasi.',
  registration_closed: 'Pendaftaran akun baru dinonaktifkan. Hubungi admin.',
  account_disabled: 'Akun dinonaktifkan. Hubungi admin.',
};

function GoogleMark() {
  // The multicolour "G" is Google's brand mark and is used as supplied.
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.5-4.1 7-10.2 7-17.6z" />
      <path fill="#FBBC05" d="M10.5 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.4 0 20.1 0 24s.9 7.6 2.6 10.8l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}

/** "Lanjutkan dengan Google" plus a divider, shown only when the server has Google configured. */
function GoogleButton({ next }: { next?: string }) {
  const config = useQuery({ queryKey: ['auth-config'], queryFn: () => api.get<{ registrationEnabled: boolean; googleEnabled?: boolean }>('/api/auth/config') });
  if (!config.data?.googleEnabled) return null;
  const href = `/api/auth/google${next ? `?next=${encodeURIComponent(next)}` : ''}`;
  return (
    <>
      <a
        href={href}
        className="press inline-flex h-10 items-center justify-center gap-3 rounded-md border border-line-2 bg-surface text-sm font-medium text-ink hover:bg-surface-2 max-md:h-12"
      >
        <GoogleMark />
        Lanjutkan dengan Google
      </a>
      <div className="flex items-center gap-3 text-xs text-ink-2" role="separator" aria-label="atau">
        <span className="h-px flex-1 bg-line" />
        atau dengan email
        <span className="h-px flex-1 bg-line" />
      </div>
    </>
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
  const [error, setError] = useState<string | null>(GOOGLE_ERRORS[params.get('error') ?? ''] ?? null);
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
      <div className="flex flex-col gap-4">
        <FormError message={error} />
        <GoogleButton next={params.get('next') ? safeNext(params.get('next')) : undefined} />
      </div>
      <form onSubmit={submit} className="mt-4 flex flex-col gap-4" noValidate>
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Field label="Kata sandi" htmlFor="password">
          <PasswordField id="password" autoComplete="current-password" value={password} onChange={setPassword} />
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
      <div className="flex flex-col gap-4">
        <GoogleButton />
      </div>
      <form onSubmit={submit} className="mt-4 flex flex-col gap-4" noValidate>
        <FormError message={error} />
        <Field label="Nama" htmlFor="name">
          <Input id="name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Kata sandi" htmlFor="password">
          <PasswordField id="password" autoComplete="new-password" value={password} onChange={setPassword} strength hints={[name, email]} />
        </Field>
        <Button type="submit" variant="primary" disabled={busy || !name || !email || password.length < 8}>
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
        <Field label="Kata sandi baru" htmlFor="password">
          <PasswordField id="password" autoComplete="new-password" value={password} onChange={setPassword} strength autoFocus />
        </Field>
        <Field label="Ulangi kata sandi" htmlFor="confirm" error={confirm && confirm !== password ? 'Konfirmasi belum sama dengan kata sandi baru.' : undefined}>
          <PasswordField id="confirm" autoComplete="new-password" value={confirm} onChange={setConfirm} invalid={!!confirm && confirm !== password} />
        </Field>
        <Button type="submit" variant="primary" disabled={busy || !password}>
          {busy && <Spinner className="border-white/40 border-t-white" />}
          Simpan kata sandi
        </Button>
      </form>
    </Shell>
  );
}
