import type { ReactNode } from 'react';
import { REF_COLORS } from './render';

/**
 * Colours a formula for display behind a transparent input: cell references
 * use the same colours, in the same order, as the boxes drawn on the grid.
 */
const TOKEN =
  /("(?:[^"]|"")*"?)|((?:'(?:[^']|'')+'|[A-Za-z_][\w.]*)!)?(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)(?![\w(!])|([A-Za-z_][\w.]*)(?=\s*\()|(\d+(?:\.\d+)?(?:[eE][-+]?\d+)?%?)|(#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!))/g;

export function highlightFormula(text: string): ReactNode[] {
  if (!text.startsWith('=')) return [text];
  const out: ReactNode[] = [];
  let last = 0;
  let refIndex = 0;
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const [whole, str, sheet, ref, fn, num, errTok] = m;
    let style: React.CSSProperties | undefined;
    if (str !== undefined) style = { color: 'var(--accent)' };
    else if (ref !== undefined) {
      // Only same-sheet references get a grid box, so only they take a box colour.
      style = sheet ? { color: 'var(--brand)' } : { color: REF_COLORS[refIndex++ % REF_COLORS.length], fontWeight: 500 };
    } else if (fn !== undefined) style = { color: 'var(--ink)', fontWeight: 600 };
    else if (num !== undefined) style = { color: 'var(--ink-2)' };
    else if (errTok !== undefined) style = { color: 'var(--danger)' };
    out.push(
      <span key={m.index} style={style}>
        {whole}
      </span>,
    );
    last = m.index + whole.length;
    if (whole.length === 0) TOKEN.lastIndex++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
