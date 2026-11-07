import { listFunctions } from '@opensheet/engine';
import clsx from 'clsx';
import { useMemo } from 'react';

const FUNCTIONS = listFunctions();
const BY_NAME = new Map(FUNCTIONS.map((f) => [f.name, f]));

export interface Assist {
  suggestions: typeof FUNCTIONS;
  token: { start: number; end: number } | null;
  hint: (typeof FUNCTIONS)[number] | null;
  argIndex: number;
}

/** Works out function suggestions and the signature hint at the caret. */
export function useFormulaAssist(value: string, caret: number): Assist {
  return useMemo(() => {
    const empty: Assist = { suggestions: [], token: null, hint: null, argIndex: 0 };
    if (!value.startsWith('=')) return empty;
    const before = value.slice(0, caret);
    // Ignore anything inside an unterminated string.
    if ((before.match(/"/g) || []).length % 2 === 1) return empty;
    const m = /(^|[=(,+\-*/^&<>:;\s])([A-Za-z][A-Za-z0-9.]*)$/.exec(before);
    let suggestions: typeof FUNCTIONS = [];
    let token: Assist['token'] = null;
    if (m && !/^[A-Za-z]{1,3}\d+$/.test(m[2])) {
      const prefix = m[2].toUpperCase();
      suggestions = FUNCTIONS.filter((f) => f.name.startsWith(prefix)).slice(0, 8);
      token = { start: caret - m[2].length, end: caret };
      if (suggestions.length === 1 && suggestions[0].name === prefix) suggestions = [];
    }
    // Innermost open function call for the signature hint.
    let depth = 0;
    let argIndex = 0;
    let hint: Assist['hint'] = null;
    for (let i = before.length - 1; i >= 0; i--) {
      const ch = before[i];
      if (ch === ')') depth++;
      else if (ch === '(') {
        if (depth === 0) {
          const nm = /([A-Za-z][A-Za-z0-9.]*)$/.exec(before.slice(0, i));
          if (nm) hint = BY_NAME.get(nm[1].toUpperCase()) ?? null;
          break;
        }
        depth--;
      } else if ((ch === ',' || ch === ';') && depth === 0) argIndex++;
    }
    return { suggestions, token, hint, argIndex };
  }, [value, caret]);
}

export function applySuggestion(value: string, token: { start: number; end: number }, name: string): { value: string; caret: number } {
  const after = value.slice(token.end);
  const insert = after.startsWith('(') ? name : `${name}(`;
  const next = value.slice(0, token.start) + insert + after;
  return { value: next, caret: token.start + insert.length };
}

export function AssistPanel({
  assist,
  active,
  onPick,
  className,
  id,
}: {
  assist: Assist;
  active: number;
  onPick: (name: string) => void;
  className?: string;
  id: string;
}) {
  if (!assist.suggestions.length && !assist.hint) return null;
  return (
    <div className={clsx('w-80 max-w-[calc(100vw-24px)] overflow-hidden rounded-md border border-line bg-surface text-sm shadow-pop', className)}>
      {assist.suggestions.length > 0 ? (
        <ul role="listbox" id={id} aria-label="Saran fungsi" className="py-1">
          {assist.suggestions.map((f, i) => (
            <li
              key={f.name}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === active}
              className={clsx('cursor-default px-3 py-1.5', i === active && 'bg-brand-soft')}
              onPointerDown={(e) => {
                e.preventDefault();
                onPick(f.name);
              }}
            >
              <div className="addr text-[13px] font-medium text-ink">{f.name}</div>
              <div className="text-xs text-ink-2">{f.description}</div>
            </li>
          ))}
        </ul>
      ) : assist.hint ? (
        <div className="px-3 py-2">
          <div className="addr text-[13px] text-ink">{highlightArg(assist.hint.syntax, assist.argIndex)}</div>
          <div className="mt-0.5 text-xs text-ink-2">{assist.hint.description}</div>
        </div>
      ) : null}
    </div>
  );
}

function highlightArg(syntax: string, index: number) {
  const open = syntax.indexOf('(');
  const name = syntax.slice(0, open + 1);
  const args = syntax.slice(open + 1, -1).split(/,\s*/);
  return (
    <>
      {name}
      {args.map((a, i) => (
        <span key={i}>
          {i > 0 && ', '}
          <span className={i === Math.min(index, args.length - 1) ? 'font-semibold text-brand underline underline-offset-2' : ''}>{a}</span>
        </span>
      ))}
      )
    </>
  );
}
