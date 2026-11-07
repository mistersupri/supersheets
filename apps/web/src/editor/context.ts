import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import type { EditorController, EditorState } from './controller';

export const EditorContext = createContext<EditorController | null>(null);

export function useCtrl(): EditorController {
  const c = useContext(EditorContext);
  if (!c) throw new Error('EditorContext missing');
  return c;
}

export function useEditor<T>(selector: (s: EditorState) => T): T {
  const c = useCtrl();
  return useStore(c.store, selector);
}

export function isMobile(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches;
}
