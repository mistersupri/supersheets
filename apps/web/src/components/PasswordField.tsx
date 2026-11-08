import clsx from 'clsx';
import { useId, useState } from 'react';
import { checkPassword } from '../lib/password';
import { Icon } from './icons';
import { Input } from './ui';

const BAR = ['', 'bg-danger', 'bg-accent', 'bg-brand', 'bg-brand'] as const;
const TEXT = ['text-ink-2', 'text-danger', 'text-accent', 'text-brand', 'text-brand'] as const;

/**
 * Password input with a show/hide button. With `strength`, it also shows a meter,
 * a one-line tip and a checklist of what is still missing.
 */
export function PasswordField({
  id,
  value,
  onChange,
  autoComplete,
  strength,
  hints,
  autoFocus,
  invalid,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: 'current-password' | 'new-password';
  strength?: boolean;
  /** Words from the form (name, email) that should not appear in the password. */
  hints?: string[];
  autoFocus?: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [visible, setVisible] = useState(false);
  const helpId = useId();
  const check = strength ? checkPassword(value, hints) : null;
  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Input
          id={id}
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          required
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={invalid || undefined}
          aria-describedby={[strength ? helpId : null, describedBy].filter(Boolean).join(' ') || undefined}
          spellCheck={false}
          autoCapitalize="none"
          className="pr-11"
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi'}
          aria-pressed={visible}
          title={visible ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi'}
          className="press absolute top-1/2 right-1 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 hover:text-ink max-md:size-10"
        >
          {visible ? <Icon.EyeOff size={17} /> : <Icon.Eye size={17} />}
        </button>
      </div>
      {check && (
        <div id={helpId} className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <div className="flex flex-1 gap-1" aria-hidden="true">
              {[1, 2, 3, 4].map((i) => (
                <span key={i} className={clsx('h-1.5 flex-1 rounded-full transition-colors duration-150', i <= check.score ? BAR[check.score] : 'bg-surface-3')} />
              ))}
            </div>
            <span aria-live="polite" className={clsx('min-w-24 text-right text-xs font-medium', TEXT[check.score])}>
              {check.label}
            </span>
          </div>
          <p className="text-xs text-ink-2">{check.tip}</p>
          <ul className="grid gap-1 sm:grid-cols-2">
            {check.rules.map((r) => (
              <li key={r.id} className={clsx('flex items-start gap-1.5 text-xs', r.ok ? 'text-ink' : 'text-ink-2')}>
                <span className={clsx('mt-px shrink-0', r.ok ? 'text-brand' : 'text-ink-3')}>{r.ok ? <Icon.Check size={13} /> : <Icon.Minus size={13} />}</span>
                <span>
                  {r.label}
                  <span className="sr-only">{r.ok ? ', terpenuhi' : ', belum terpenuhi'}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
