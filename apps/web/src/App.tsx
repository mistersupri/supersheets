import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { Toaster } from 'sonner';
import { Spinner, TooltipProvider } from './components/ui';
import { useMe } from './lib/auth';
import { useTheme } from './lib/theme';
import { ForgotPage, LoginPage, RegisterPage, ResetPage } from './auth/AuthPages';

const Dashboard = lazy(() => import('./dashboard/Dashboard'));
const EditorPage = lazy(() => import('./editor/EditorPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const AdminPage = lazy(() => import('./pages/AdminPage'));

function FullPageLoading() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner className="size-6" />
    </div>
  );
}

function RequireAuth({ children, admin }: { children: ReactNode; admin?: boolean }) {
  const me = useMe();
  const loc = useLocation();
  if (me.isLoading) return <FullPageLoading />;
  if (me.isError)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-ink">Server tidak dapat dihubungi.</p>
        <button className="press rounded-md border border-line-2 px-3 py-2 text-sm" onClick={() => me.refetch()}>
          Coba lagi
        </button>
      </div>
    );
  if (!me.data) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (admin && me.data.user.role !== 'super_admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function App() {
  const { resolved } = useTheme();
  return (
    <TooltipProvider delay={500}>
      <BrowserRouter>
        <Suspense fallback={<FullPageLoading />}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/forgot-password" element={<ForgotPage />} />
            <Route path="/reset-password" element={<ResetPage />} />
            <Route path="/" element={<RequireAuth><Dashboard /></RequireAuth>} />
            <Route path="/folders/:folderId" element={<RequireAuth><Dashboard /></RequireAuth>} />
            {/* Signed-out visitors may open shared links when the admin allows guests. */}
            <Route path="/w/:id" element={<EditorPage />} />
            <Route path="/settings" element={<RequireAuth><SettingsPage /></RequireAuth>} />
            <Route path="/admin" element={<RequireAuth admin><AdminPage /></RequireAuth>} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
      <Toaster theme={resolved} position="bottom-center" toastOptions={{ className: 'font-sans' }} />
    </TooltipProvider>
  );
}

function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="addr text-sm text-ink-2">404</p>
      <h1 className="text-lg font-semibold">Halaman tidak ditemukan</h1>
      <a className="text-sm text-brand underline underline-offset-2" href="/">
        Kembali ke dasbor
      </a>
    </div>
  );
}
