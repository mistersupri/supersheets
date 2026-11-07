import { useSyncExternalStore } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'opensheet-theme';
const listeners = new Set<() => void>();

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function setTheme(pref: ThemePref) {
  try {
    if (pref === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    // Storage may be blocked; the choice still applies for this page view.
  }
  if (pref === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = pref;
  listeners.forEach((l) => l());
}

const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
media?.addEventListener('change', () => listeners.forEach((l) => l()));

export function resolvedTheme(): 'light' | 'dark' {
  const p = read();
  if (p !== 'system') return p;
  return media?.matches ? 'dark' : 'light';
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useTheme() {
  const pref = useSyncExternalStore(subscribe, read, () => 'system' as ThemePref);
  const resolved = useSyncExternalStore(subscribe, resolvedTheme, () => 'light' as const);
  return { pref, resolved, setTheme };
}

export function subscribeTheme(cb: () => void) {
  return subscribe(cb);
}
