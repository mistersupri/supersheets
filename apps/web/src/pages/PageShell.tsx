import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Icon } from '../components/icons';
import { UserMenu } from '../components/UserMenu';

export function PageShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-line bg-surface px-3 py-2 md:px-6">
        <Link to="/" className="press inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-sm text-ink-2 hover:bg-surface-2 max-md:min-h-11">
          <Icon.ChevronLeft /> Dasbor
        </Link>
        <div className="ml-auto">
          <UserMenu />
        </div>
      </header>
      <main className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8">
        <div className="mx-auto max-w-4xl">
          <h1 className="text-xl font-semibold text-ink">{title}</h1>
          {children}
        </div>
      </main>
    </div>
  );
}

export function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="mt-8 grid gap-4 border-t border-line pt-6 md:grid-cols-[220px_1fr]">
      <div>
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {description && <p className="mt-1 text-xs text-ink-2">{description}</p>}
      </div>
      <div>{children}</div>
    </section>
  );
}
