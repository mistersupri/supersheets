import { useSyncExternalStore } from 'react';

/**
 * True while a dialog field is picking a range on the sheet. Dialogs read it to step aside
 * (unmounting their popup also lifts the modal "inert" state, so the grid receives pointer events).
 */
let active = false;
const subs = new Set<() => void>();

export function setPicking(v: boolean) {
  if (active === v) return;
  active = v;
  subs.forEach((f) => f());
}

export function usePicking(): boolean {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => active,
    () => false,
  );
}
