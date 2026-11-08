import { Dialog as BDialog } from '@base-ui/react/dialog';
import { Menu as BMenu } from '@base-ui/react/menu';
import { Tooltip as BTooltip } from '@base-ui/react/tooltip';
import clsx from 'clsx';
import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { usePicking } from '../lib/picking';
import { Icon } from './icons';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }>(
  function Button({ variant = 'secondary', size = 'md', className, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        className={clsx(
          'press inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap select-none disabled:opacity-50 disabled:cursor-not-allowed',
          size === 'md' ? 'h-9 px-3.5 text-sm' : 'h-8 px-2.5 text-[13px]',
          'max-md:min-h-11',
          variant === 'primary' && 'bg-brand text-brand-ink hover:bg-brand-hover',
          variant === 'secondary' && 'border border-line-2 bg-surface text-ink hover:bg-surface-2',
          variant === 'ghost' && 'text-ink hover:bg-surface-2',
          variant === 'danger' && 'bg-danger text-white hover:opacity-90',
          className,
        )}
        {...rest}
      />
    );
  },
);

/** Square icon button with an accessible label and a tooltip. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; shortcut?: string; tooltip?: boolean }
>(function IconButton({ label, active, shortcut, className, children, tooltip = true, ...rest }, ref) {
  const btn = (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      className={clsx(
        'press inline-flex h-8 min-w-8 items-center justify-center rounded-md px-1.5 text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed',
        'max-md:h-11 max-md:min-w-11',
        active && 'bg-brand-soft text-ink',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
  if (!tooltip) return btn;
  return (
    <BTooltip.Root>
      <BTooltip.Trigger render={btn} />
      <BTooltip.Portal>
        <BTooltip.Positioner sideOffset={6}>
          <BTooltip.Popup className="pop rounded bg-ink px-2 py-1 text-xs text-surface shadow-pop">
            {label}
            {shortcut && <span className="ml-2 opacity-70 addr">{shortcut}</span>}
          </BTooltip.Popup>
        </BTooltip.Positioner>
      </BTooltip.Portal>
    </BTooltip.Root>
  );
});

export const TooltipProvider = BTooltip.Provider;

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={clsx(
        'h-9 w-full rounded-md border border-line-2 bg-surface px-3 text-sm text-ink placeholder:text-ink-3',
        'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-brand max-md:h-11 max-md:text-base',
        'aria-invalid:border-danger',
        className,
      )}
      {...rest}
    />
  );
});

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: string; error?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-ink-2">{hint}</p>}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function Select({ className, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={clsx(
        'h-9 rounded-md border border-line-2 bg-surface px-2.5 text-sm text-ink max-md:h-11 max-md:text-base',
        'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-brand',
        className,
      )}
      {...rest}
    />
  );
}

export function Checkbox({ label, checked, onChange, id }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; id?: string }) {
  return (
    <label className="inline-flex min-h-8 cursor-pointer items-center gap-2 text-sm text-ink max-md:min-h-11">
      <input id={id} type="checkbox" className="size-4 accent-[var(--brand)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Spinner({ className, label = 'Memuat' }: { className?: string; label?: string }) {
  return (
    <span role="status" aria-label={label} className={clsx('inline-block size-4 animate-spin rounded-full border-2 border-line-2 border-t-brand [animation-duration:600ms]', className)} />
  );
}

export function Avatar({ name, color, size = 28 }: { name: string; color?: string; size?: number }) {
  const parts = name.split(/\s+/).filter(Boolean);
  const text = parts.slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.4, background: color ?? 'var(--ink-2)' }}
    >
      {text}
    </span>
  );
}

// ---------- Dialog ----------

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 440,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const picking = usePicking();
  return (
    // While a field picks a range on the sheet the popup steps aside; the parent keeps its draft state.
    <BDialog.Root open={open && !picking} onOpenChange={onOpenChange}>
      <BDialog.Portal>
        <BDialog.Backdrop className="scrim fixed inset-0 z-40 bg-[var(--scrim)]" />
        <BDialog.Popup
          className="dialog fixed top-1/2 left-1/2 z-50 flex max-h-[min(88dvh,760px)] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-line bg-surface text-ink shadow-pop outline-none"
          style={{ maxWidth: width }}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 pt-4 pb-3">
            <div className="min-w-0">
              <BDialog.Title className="text-base font-semibold">{title}</BDialog.Title>
              {description && <BDialog.Description className="mt-1 text-[13px] text-ink-2">{description}</BDialog.Description>}
            </div>
            <BDialog.Close aria-label="Tutup" className="press -mr-1.5 inline-flex size-8 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 max-md:size-11">
              <Icon.Close />
            </BDialog.Close>
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </BDialog.Popup>
      </BDialog.Portal>
    </BDialog.Root>
  );
}

// ---------- Menu ----------

export const menuPopupClass =
  'pop min-w-52 max-h-[var(--available-height)] overflow-y-auto rounded-md border border-line bg-surface py-1 text-sm text-ink shadow-pop outline-none scroll-thin';

export const menuItemClass =
  'flex min-h-8 cursor-pointer items-center gap-3 px-3 py-1.5 outline-none select-none data-highlighted:bg-brand-soft data-disabled:cursor-not-allowed data-disabled:opacity-45 max-md:min-h-11';

export function MenuItem({ children, shortcut, onClick, disabled, danger, icon }: { children: ReactNode; shortcut?: string; onClick?: () => void; disabled?: boolean; danger?: boolean; icon?: ReactNode }) {
  return (
    <BMenu.Item className={clsx(menuItemClass, danger && 'text-danger')} onClick={onClick} disabled={disabled}>
      {icon !== undefined && <span className="flex w-4 shrink-0 justify-center text-ink-2">{icon}</span>}
      <span className="flex-1">{children}</span>
      {shortcut && <span className="addr text-xs text-ink-2">{shortcut}</span>}
    </BMenu.Item>
  );
}

export function MenuSeparator() {
  return <BMenu.Separator className="my-1 h-px bg-line" />;
}

export function SubMenu({ label, children, disabled, icon }: { label: string; children: ReactNode; disabled?: boolean; icon?: ReactNode }) {
  return (
    <BMenu.SubmenuRoot>
      <BMenu.SubmenuTrigger className={clsx(menuItemClass, 'data-popup-open:bg-brand-soft')} disabled={disabled}>
        {icon !== undefined && <span className="flex w-4 shrink-0 justify-center text-ink-2">{icon}</span>}
        <span className="flex-1">{label}</span>
        <Icon.ChevronRight size={14} />
      </BMenu.SubmenuTrigger>
      <BMenu.Portal>
        <BMenu.Positioner sideOffset={0} alignOffset={-4} className="z-50 outline-none">
          <BMenu.Popup className={menuPopupClass}>{children}</BMenu.Popup>
        </BMenu.Positioner>
      </BMenu.Portal>
    </BMenu.SubmenuRoot>
  );
}

export function DropdownMenu({
  trigger,
  children,
  align = 'start',
  label,
  finalFocus,
}: {
  trigger: ReactNode;
  children: ReactNode;
  align?: 'start' | 'end' | 'center';
  label?: string;
  /** Where focus goes when the menu closes (default: back to the trigger). */
  finalFocus?: () => HTMLElement | boolean | null;
}) {
  return (
    <BMenu.Root>
      <BMenu.Trigger render={trigger as React.ReactElement} aria-label={label} />
      <BMenu.Portal>
        <BMenu.Positioner sideOffset={4} align={align} className="z-50 outline-none">
          <BMenu.Popup className={menuPopupClass} finalFocus={finalFocus}>
            {children}
          </BMenu.Popup>
        </BMenu.Positioner>
      </BMenu.Portal>
    </BMenu.Root>
  );
}

/** The spreadsheet's keyboard target, so menus can hand focus back to the grid. */
export function gridFocusTarget(): HTMLElement | true {
  return document.querySelector<HTMLElement>('[aria-roledescription="spreadsheet"]') ?? true;
}

export function EmptyState({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 py-12">
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      {body && <p className="max-w-md text-sm text-ink-2">{body}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-md border border-danger/40 bg-danger-soft p-4">
      <p className="text-sm text-ink">{message}</p>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Coba lagi
        </Button>
      )}
    </div>
  );
}
