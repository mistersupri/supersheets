import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useCtrl, useEditor } from './context';
import { applySuggestion, AssistPanel, useFormulaAssist } from './formulaAssist';

/** The in-cell editor, drawn over the canvas at the active cell. */
export function CellEditor({ rect, viewport, onDone }: { rect: { x: number; y: number; w: number; h: number }; viewport: { w: number; h: number }; onDone: () => void }) {
  const ctrl = useCtrl();
  const editing = useEditor((s) => s.editing)!;
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(editing.value.length);
  const [active, setActive] = useState(0);
  const assist = useFormulaAssist(editing.value, caret);
  const style = ctrl.model.style(editing.sheetId, editing.row, editing.col);
  const px = Math.round(((style?.fontSize ?? 10) * 4) / 3);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || editing.source !== 'cell') return;
    el.focus({ preventScroll: true });
    const end = el.value.length;
    el.setSelectionRange(end, end);
    setCaret(end);
    // Only on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing.row, editing.col, editing.sheetId]);

  useEffect(() => setActive(0), [assist.suggestions.length]);

  // Grow with the content, up to the viewport.
  const [box, setBox] = useState({ w: rect.w, h: rect.h });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.width = '0px';
    el.style.height = '0px';
    const w = Math.min(Math.max(rect.w, el.scrollWidth + 12), Math.max(rect.w, viewport.w - rect.x - 8));
    el.style.width = `${w}px`;
    const h = Math.min(Math.max(rect.h, el.scrollHeight), Math.max(rect.h, viewport.h - rect.y - 8));
    el.style.height = `${h}px`;
    setBox({ w, h });
  }, [editing.value, rect.w, rect.h, rect.x, rect.y, viewport.w, viewport.h]);

  const pick = (name: string) => {
    if (!assist.token) return;
    const r = applySuggestion(editing.value, assist.token, name);
    ctrl.updateEdit(r.value, 'cell');
    requestAnimationFrame(() => {
      ref.current?.setSelectionRange(r.caret, r.caret);
      setCaret(r.caret);
    });
  };

  const finish = (move: Parameters<typeof ctrl.commitEdit>[0]) => {
    if (ctrl.commitEdit(move)) onDone();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    const open = assist.suggestions.length > 0;
    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + assist.suggestions.length) % assist.suggestions.length);
      return;
    }
    if (open && (e.key === 'Tab' || e.key === 'Enter')) {
      e.preventDefault();
      pick(assist.suggestions[active].name);
      return;
    }
    if (e.key === 'Enter' && e.altKey) {
      e.preventDefault();
      const el = e.currentTarget;
      const s = el.selectionStart;
      const v = el.value.slice(0, s) + '\n' + el.value.slice(el.selectionEnd);
      ctrl.updateEdit(v, 'cell');
      requestAnimationFrame(() => el.setSelectionRange(s + 1, s + 1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      return finish(e.shiftKey ? 'up' : 'down');
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      return finish(e.shiftKey ? 'left' : 'right');
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      ctrl.cancelEdit();
      onDone();
      return;
    }
    // In "quick" mode (typing replaced the cell) arrows commit and move, unless pointing in a formula.
    if (editing.quick && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && !editing.value.startsWith('=')) {
      e.preventDefault();
      const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' } as const;
      return finish(dir[e.key as keyof typeof dir]);
    }
  };

  return (
    <div className="pointer-events-none absolute top-0 left-0" style={{ transform: `translate(${rect.x}px, ${rect.y}px)` }}>
      <textarea
        ref={ref}
        data-active-editor={editing.source === 'cell' ? 'true' : undefined}
        aria-label="Isi sel"
        aria-autocomplete="list"
        aria-controls={assist.suggestions.length ? 'cell-assist' : undefined}
        aria-activedescendant={assist.suggestions.length ? `cell-assist-${active}` : undefined}
        className="pointer-events-auto block resize-none overflow-hidden border-2 border-brand bg-surface px-[3px] py-[2px] leading-tight text-ink outline-none"
        style={{
          minWidth: rect.w,
          minHeight: rect.h,
          width: box.w,
          height: box.h,
          fontSize: px,
          fontWeight: style?.bold ? 600 : 400,
          fontStyle: style?.italic ? 'italic' : 'normal',
          fontFamily: editing.value.startsWith('=') ? 'var(--font-mono)' : 'var(--font-sans)',
          whiteSpace: style?.wrap ? 'pre-wrap' : 'pre',
        }}
        value={editing.value}
        spellCheck={false}
        onChange={(e) => {
          ctrl.updateEdit(e.target.value, 'cell');
          setCaret(e.target.selectionStart);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onFocus={() => ctrl.updateEdit(editing.value, 'cell')}
        onKeyDown={onKeyDown}
      />
      <div className="pointer-events-auto mt-1">
        <AssistPanel assist={assist} active={active} onPick={pick} id="cell-assist" />
      </div>
    </div>
  );
}
