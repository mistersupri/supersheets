import { CellStyle, colToLetters, formatGeneralNumber, isError, Merge, parseRangeA1, RangeAddress, rangeContains, resolvePattern, Scalar, translateFormula as translate } from '@opensheet/engine';
import { conditionMatches, displayText, EditorController } from './controller';
import { HEADER_H, HEADER_W } from './geometry';

export interface Theme {
  paper: string;
  ink: string;
  ink2: string;
  grid: string;
  headerBg: string;
  headerInk: string;
  headerActive: string;
  brand: string;
  brandInk: string;
  selFill: string;
  accent: string;
  danger: string;
  line2: string;
  refs: string[];
  dark: boolean;
}

export function readTheme(el: Element): Theme {
  const cs = getComputedStyle(el);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    paper: v('--surface'),
    ink: v('--ink'),
    ink2: v('--ink-2'),
    grid: v('--grid-line'),
    headerBg: v('--header-bg'),
    headerInk: v('--header-ink'),
    headerActive: v('--header-active'),
    brand: v('--brand'),
    brandInk: v('--brand-ink'),
    selFill: v('--sel-fill'),
    accent: v('--accent'),
    danger: v('--danger'),
    line2: v('--line-2'),
    refs: [1, 2, 3, 4, 5, 6].map((i) => v(`--ref-${i}`)),
    dark: cs.colorScheme === 'dark',
  };
}

export interface View {
  w: number;
  h: number;
  scrollLeft: number;
  scrollTop: number;
}

export interface Overlay {
  fillPreview?: RangeAddress | null;
  /** Where dragged cells would land. */
  movePreview?: RangeAddress | null;
  resizeGuide?: { axis: 'row' | 'col'; pos: number } | null;
  /** The header border under the pointer (it can be dragged to resize). */
  hoverEdge?: { axis: 'row' | 'col'; pos: number } | null;
  /** The pointer is over the fill handle in the corner of the selection. */
  handleHover?: boolean;
  /** Ranges referenced by the formula being typed; `index` picks the theme colour. */
  refHighlights?: { range: RangeAddress; index: number }[];
  presenceColors: Record<string, { color: string; name: string }>;
}

const FONT_FAMILY = '"IBM Plex Sans", system-ui, sans-serif';
export const DEFAULT_FONT_PT = 10;

export function fontFor(style: CellStyle | null): { font: string; px: number } {
  const px = Math.round(((style?.fontSize ?? DEFAULT_FONT_PT) * 4) / 3);
  const family = style?.fontFamily ? `"${style.fontFamily}", ${FONT_FAMILY}` : FONT_FAMILY;
  return { font: `${style?.italic ? 'italic ' : ''}${style?.bold ? '600' : '400'} ${px}px ${family}`, px };
}

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Keeps user-chosen colours readable in both themes. */
function textColorFor(style: CellStyle | null, bg: string | undefined, t: Theme): string {
  const surface = bg ?? t.paper;
  if (style?.textColor) {
    if (contrast(style.textColor, surface) >= 2.5) return style.textColor;
  }
  if (bg) return luminance(bg) > 0.4 ? '#1A1E1C' : '#F2F4F3';
  return t.ink;
}

/** A pair of small arrows in a header where manually hidden rows or columns sit; double-click shows them again. */
export interface HiddenMark {
  axis: 'row' | 'col';
  indices: number[];
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Runs of consecutive indices, e.g. [2,3,4,9] becomes [[2,3,4],[9]]. */
function runsOf(list: number[]): number[][] {
  const runs: number[][] = [];
  for (const i of [...list].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1] === i - 1) last.push(i);
    else if (!last || last[last.length - 1] !== i) runs.push([i]);
  }
  return runs;
}

export class Renderer {
  private measureCache = new Map<string, number>();
  /** Hit areas of the hidden-row/column arrows from the last draw. */
  marks: HiddenMark[] = [];

  constructor(private ctrl: EditorController) {}

  measure(ctx: CanvasRenderingContext2D, font: string, text: string): number {
    const key = font + '\u0000' + text;
    let w = this.measureCache.get(key);
    if (w === undefined) {
      if (ctx.font !== font) ctx.font = font;
      w = ctx.measureText(text).width;
      if (this.measureCache.size > 20_000) this.measureCache.clear();
      this.measureCache.set(key, w);
    }
    return w;
  }

  draw(ctx: CanvasRenderingContext2D, view: View, t: Theme, overlay: Overlay) {
    const ctrl = this.ctrl;
    const sheet = ctrl.sheet();
    if (!sheet) return;
    const { rows, cols } = ctrl.axes();
    const fr = Math.min(sheet.frozenRows, rows.count);
    const fc = Math.min(sheet.frozenColumns, cols.count);
    const fh = rows.pos(fr);
    const fw = cols.pos(fc);
    const colX = (c: number) => HEADER_W + cols.pos(c) - (c >= fc ? view.scrollLeft : 0);
    const rowY = (r: number) => HEADER_H + rows.pos(r) - (r >= fr ? view.scrollTop : 0);

    const visCols: number[] = [];
    const scrollCols: number[] = [];
    for (let c = 0; c < fc; c++) if (!cols.hidden(c)) visCols.push(c);
    for (let c = cols.indexAt(fw + view.scrollLeft); c < cols.count && colX(c) < view.w; c++) if (!cols.hidden(c)) scrollCols.push(c);
    const frozenRows: number[] = [];
    const scrollRows: number[] = [];
    for (let r = 0; r < fr; r++) if (!rows.hidden(r)) frozenRows.push(r);
    for (let r = rows.indexAt(fh + view.scrollTop); r < rows.count && rowY(r) < view.h; r++) if (!rows.hidden(r)) scrollRows.push(r);

    ctx.fillStyle = t.paper;
    ctx.fillRect(0, 0, view.w, view.h);

    const gx = HEADER_W + fw;
    const gy = HEADER_H + fh;
    const regions: [number[], number[], [number, number, number, number]][] = [
      [scrollRows, scrollCols, [gx, gy, view.w - gx, view.h - gy]],
      [scrollRows, visCols, [HEADER_W, gy, fw, view.h - gy]],
      [frozenRows, scrollCols, [gx, HEADER_H, view.w - gx, fh]],
      [frozenRows, visCols, [HEADER_W, HEADER_H, fw, fh]],
    ];
    for (const [rs, cs, clip] of regions) {
      if (!rs.length || !cs.length || clip[2] <= 0 || clip[3] <= 0) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(...clip);
      ctx.clip();
      this.drawCells(ctx, t, rs, cs, colX, rowY, rows.size.bind(rows), cols.size.bind(cols));
      ctx.restore();
    }

    // Overlays (selection, filter range, copy outline, collaborators) are painted pane by pane:
    // frozen corner, frozen rows, frozen columns and the scrolling body. Each pane clips to its own
    // screen area, so a selection that has scrolled behind the frozen rows or columns is hidden
    // there instead of being drawn on top of the frozen cells.
    const panes = [
      { r: [0, fr - 1], c: [0, fc - 1], clip: [HEADER_W, HEADER_H, fw, fh] },
      { r: [0, fr - 1], c: [fc, Infinity], clip: [gx, HEADER_H, view.w - gx, fh] },
      { r: [fr, Infinity], c: [0, fc - 1], clip: [HEADER_W, gy, fw, view.h - gy] },
      { r: [fr, Infinity], c: [fc, Infinity], clip: [gx, gy, view.w - gx, view.h - gy] },
    ];
    type Box = { x: number; y: number; w: number; h: number };
    interface Paint {
      fill?: { color: string; alpha: number };
      stroke?: { color: string; width: number; dash?: number[] };
      /** Called for the piece that holds the range's top right / bottom right corner. */
      onTopRight?: (b: Box) => void;
      onBottomRight?: (b: Box) => void;
    }
    const paint = (R: RangeAddress, p: Paint) => {
      for (const pane of panes) {
        const sub = { r1: Math.max(R.r1, pane.r[0]), r2: Math.min(R.r2, pane.r[1]), c1: Math.max(R.c1, pane.c[0]), c2: Math.min(R.c2, pane.c[1]) };
        if (sub.r1 > sub.r2 || sub.c1 > sub.c2) continue;
        const [cx, cy, cw, ch] = pane.clip;
        if (cw <= 0 || ch <= 0) continue;
        const x1 = colX(sub.c1);
        const y1 = rowY(sub.r1);
        const x2 = colX(sub.c2) + cols.size(sub.c2);
        const y2 = rowY(sub.r2) + rows.size(sub.r2);
        const b = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
        ctx.save();
        ctx.beginPath();
        ctx.rect(cx, cy, cw, ch);
        ctx.clip();
        if (p.fill) {
          ctx.globalAlpha = p.fill.alpha;
          ctx.fillStyle = p.fill.color;
          ctx.fillRect(b.x, b.y, b.w, b.h);
          ctx.globalAlpha = 1;
        }
        if (p.stroke) {
          // Only the edges that belong to the range itself: the seam between two panes is not an edge.
          const w = p.stroke.width;
          const i = w / 2;
          ctx.strokeStyle = p.stroke.color;
          ctx.lineWidth = w;
          ctx.setLineDash(p.stroke.dash ?? []);
          const line = (ax: number, ay: number, bx: number, by: number) => {
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
            ctx.stroke();
          };
          if (sub.r1 === R.r1) line(b.x, b.y + i, b.x + b.w, b.y + i);
          if (sub.r2 === R.r2) line(b.x, b.y + b.h - i, b.x + b.w, b.y + b.h - i);
          if (sub.c1 === R.c1) line(b.x + i, b.y, b.x + i, b.y + b.h);
          if (sub.c2 === R.c2) line(b.x + b.w - i, b.y, b.x + b.w - i, b.y + b.h);
          ctx.setLineDash([]);
        }
        if (p.onTopRight && sub.r1 === R.r1 && sub.c2 === R.c2) p.onTopRight(b);
        if (p.onBottomRight && sub.r2 === R.r2 && sub.c2 === R.c2) p.onBottomRight(b);
        ctx.restore();
      }
    };
    const st = ctrl.s;
    // The range a filter covers: header row tinted, whole range outlined. Shared filters use the
    // brand colour; a filter only this user sees uses the accent, so the difference is visible.
    const flt = ctrl.activeFilter();
    if (flt && flt.c2 >= flt.c1) {
      const shared = ctrl.filterIsShared();
      const color = shared ? t.brand : t.accent;
      paint({ r1: flt.r1, r2: flt.r1, c1: flt.c1, c2: flt.c2 }, { fill: { color, alpha: 0.12 } });
      paint(flt, { stroke: { color, width: 1.5, dash: shared ? [] : [6, 3] } });
    }
    if (st.filterPreview) paint(st.filterPreview, { fill: { color: t.brand, alpha: 0.1 }, stroke: { color: t.brand, width: 2, dash: [5, 3] } });
    // The numbers a formula suggestion would use.
    if (st.suggestPreview) paint(st.suggestPreview, { fill: { color: t.accent, alpha: 0.12 }, stroke: { color: t.accent, width: 2, dash: [5, 3] } });
    for (const h of overlay.refHighlights ?? []) {
      const color = t.refs[h.index % t.refs.length];
      paint(h.range, { fill: { color, alpha: 0.08 }, stroke: { color, width: 2 } });
    }
    for (const [socketId, rs] of Object.entries(st.remoteSelections)) {
      if (rs.sheetId !== sheet.id || !rs.selection) continue;
      const p = overlay.presenceColors[socketId];
      if (!p) continue;
      paint(rs.selection, {
        stroke: { color: p.color, width: 2 },
        onTopRight: (b) => {
          ctx.font = `500 10px ${FONT_FAMILY}`;
          const tw = ctx.measureText(p.name).width + 8;
          ctx.fillStyle = p.color;
          ctx.fillRect(b.x + b.w - tw, b.y - 14, tw, 14);
          ctx.fillStyle = '#FFFFFF';
          ctx.textBaseline = 'middle';
          ctx.textAlign = 'left';
          ctx.fillText(p.name, b.x + b.w - tw + 4, b.y - 7);
        },
      });
    }
    const sel = ctrl.selectionRange();
    const a = st.selection.anchor;
    const am = ctrl.mergeAt(a.row, a.col) ?? { r1: a.row, c1: a.col, r2: a.row, c2: a.col };
    if (sel.r1 !== sel.r2 || sel.c1 !== sel.c2) paint(sel, { fill: { color: t.selFill, alpha: 1 }, stroke: { color: t.brand, width: 1 } });
    if (!st.editing) {
      paint(am, { stroke: { color: t.brand, width: 2 } });
      if (st.can.edit) {
        // The fill handle grows when hovered, so it is clear this corner does something. It is only
        // drawn where its own pane shows it.
        const hs = overlay.handleHover ? 11 : 7;
        const ho = Math.floor(hs / 2);
        paint(sel, {
          onBottomRight: (b) => {
            ctx.fillStyle = t.brand;
            ctx.fillRect(b.x + b.w - ho, b.y + b.h - ho, hs, hs);
            ctx.strokeStyle = t.paper;
            ctx.lineWidth = 1;
            ctx.strokeRect(b.x + b.w - ho - 0.5, b.y + b.h - ho - 0.5, hs + 1, hs + 1);
          },
        });
      }
    }
    // Outline the result area of an array formula when the cursor is inside it.
    const spill = ctrl.model.engine.spillAreaAt(sheet.id, a.row, a.col);
    if (spill) paint(spill, { stroke: { color: spill.ok ? t.brand : t.danger, width: 1, dash: [3, 3] } });
    if (overlay.movePreview) paint(overlay.movePreview, { fill: { color: t.brand, alpha: 0.1 }, stroke: { color: t.brand, width: 2, dash: [5, 3] } });
    if (overlay.fillPreview) paint(overlay.fillPreview, { stroke: { color: t.ink2, width: 1, dash: [4, 3] } });
    if (st.copyRange && st.copyRange.sheetId === sheet.id) paint(st.copyRange, { stroke: { color: t.brand, width: 1.5, dash: [5, 3] } });

    // Frozen dividers.
    ctx.fillStyle = t.line2;
    if (fc > 0) ctx.fillRect(gx - 1, 0, 2, view.h);
    if (fr > 0) ctx.fillRect(0, gy - 1, view.w, 2);

    this.drawHeaders(ctx, t, view, [...visCols, ...scrollCols], [...frozenRows, ...scrollRows], colX, rowY, rows.size.bind(rows), cols.size.bind(cols), sel, fw, fh);

    if (overlay.hoverEdge && !overlay.resizeGuide) {
      const e = overlay.hoverEdge;
      ctx.fillStyle = t.brand;
      // A thick bar in the header, and a faint line through the grid to show what will move.
      if (e.axis === 'col') {
        ctx.fillRect(e.pos - 1.5, 0, 3, HEADER_H);
        ctx.globalAlpha = 0.35;
        ctx.fillRect(e.pos - 0.5, HEADER_H, 1, view.h);
      } else {
        ctx.fillRect(0, e.pos - 1.5, HEADER_W, 3);
        ctx.globalAlpha = 0.35;
        ctx.fillRect(HEADER_W, e.pos - 0.5, view.w, 1);
      }
      ctx.globalAlpha = 1;
    }
    if (overlay.resizeGuide) {
      ctx.fillStyle = t.brand;
      if (overlay.resizeGuide.axis === 'col') ctx.fillRect(overlay.resizeGuide.pos - 1, 0, 2, view.h);
      else ctx.fillRect(0, overlay.resizeGuide.pos - 1, view.w, 2);
    }
  }

  private conditional(sheetId: string, row: number, col: number, v: Scalar, text: string): Partial<CellStyle> | null {
    const sheet = this.ctrl.model.sheet(sheetId)!;
    if (!sheet.conditionalFormats.length) return null;
    let out: Partial<CellStyle> | null = null;
    for (const cf of sheet.conditionalFormats) {
      const r = parseRangeA1(cf.range);
      if (!r || !rangeContains(r, row, col)) continue;
      let hit: boolean;
      if (cf.rule.op === 'formula') {
        const f = cf.rule.value ?? '';
        const res = this.ctrl.model.engine.evaluateFormula(sheetId, row, col, shiftRuleFormula(f, row - r.r1, col - r.c1));
        hit = res === true || (typeof res === 'number' && res !== 0);
      } else hit = conditionMatches(cf.rule.op, cf.rule.value, cf.rule.value2, v, text);
      if (hit) out = { ...cf.rule.style, ...(out ?? {}) };
    }
    return out;
  }

  private drawCells(
    ctx: CanvasRenderingContext2D,
    t: Theme,
    rows: number[],
    cols: number[],
    colX: (c: number) => number,
    rowY: (r: number) => number,
    rowH: (r: number) => number,
    colW: (c: number) => number,
  ) {
    const ctrl = this.ctrl;
    const st = ctrl.s;
    const sheet = ctrl.sheet()!;
    const sid = sheet.id;
    const model = ctrl.model;
    const merges = (sheet.metadata.merges ?? []).filter((m) => rows.some((r) => r >= m.r1 && r <= m.r2) && cols.some((c) => c >= m.c1 && c <= m.c2));
    const inMerge = (r: number, c: number): Merge | null => {
      for (const m of merges) if (r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2) return m;
      return null;
    };
    const x0 = colX(cols[0]);
    const x1 = colX(cols[cols.length - 1]) + colW(cols[cols.length - 1]);
    const y0 = rowY(rows[0]);
    const y1 = rowY(rows[rows.length - 1]) + rowH(rows[rows.length - 1]);

    // Gather cell info once for the region.
    type Info = { r: number; c: number; v: Scalar; text: string; style: CellStyle | null; bg?: string };
    const infos: Info[] = [];
    for (const r of rows) {
      for (const c of cols) {
        if (inMerge(r, c)) continue;
        const raw = model.raw(sid, r, c);
        let style = model.style(sid, r, c);
        // Cells filled by an array formula have a value but no input of their own.
        const v = model.value(sid, r, c);
        if (!raw && !style && v === null) continue;
        const text = st.showFormulas && raw.startsWith('=') ? raw : displayText(v, style);
        const cf = this.conditional(sid, r, c, v, text);
        if (cf) style = { ...(style ?? {}), ...cf };
        infos.push({ r, c, v, text, style, bg: style?.backgroundColor });
      }
    }

    // 1. Backgrounds.
    for (const i of infos) {
      if (!i.bg) continue;
      ctx.fillStyle = i.bg;
      ctx.fillRect(colX(i.c), rowY(i.r), colW(i.c), rowH(i.r));
    }

    // 2. Grid lines.
    if (sheet.metadata.showGridlines !== false) {
      ctx.fillStyle = t.grid;
      for (const c of cols) ctx.fillRect(colX(c) + colW(c) - 1, y0, 1, y1 - y0);
      for (const r of rows) ctx.fillRect(x0, rowY(r) + rowH(r) - 1, x1 - x0, 1);
    }

    // 3. Merged blocks cover the grid lines inside them.
    for (const m of merges) {
      const mx = colX(m.c1);
      const my = rowY(m.r1);
      let mw = 0;
      for (let c = m.c1; c <= m.c2; c++) mw += colW(c);
      let mh = 0;
      for (let r = m.r1; r <= m.r2; r++) mh += rowH(r);
      let style = model.style(sid, m.r1, m.c1);
      const v = model.value(sid, m.r1, m.c1);
      const raw = model.raw(sid, m.r1, m.c1);
      const text = st.showFormulas && raw.startsWith('=') ? raw : displayText(v, style);
      const cf = this.conditional(sid, m.r1, m.c1, v, text);
      if (cf) style = { ...(style ?? {}), ...cf };
      ctx.fillStyle = style?.backgroundColor ?? t.paper;
      ctx.fillRect(mx, my, mw - 1, mh - 1);
      if (sheet.metadata.showGridlines !== false) {
        ctx.fillStyle = t.grid;
        ctx.fillRect(mx + mw - 1, my, 1, mh);
        ctx.fillRect(mx, my + mh - 1, mw, 1);
      }
      if (text) this.drawText(ctx, t, text, v, style, mx, my, mw, mh, mw);
      this.drawBorders(ctx, style, mx, my, mw, mh);
    }

    // 4. Text, with overflow into empty neighbours for unwrapped left-aligned text.
    const lastCol = cols[cols.length - 1];
    const filter = ctrl.activeFilter();
    for (const i of infos) {
      if (!i.text) continue;
      const x = colX(i.c);
      const y = rowY(i.r);
      // Leave room for the filter button in the header row of a filter.
      const onFilterHeader = !!filter && i.r === filter.r1 && i.c >= filter.c1 && i.c <= filter.c2;
      const w = colW(i.c) - (onFilterHeader ? 20 : 0);
      const h = rowH(i.r);
      const align = i.style?.hAlign ?? defaultAlign(i.v);
      let clipW = w;
      if (!onFilterHeader && !i.style?.wrap && align === 'left' && typeof i.v !== 'number') {
        const { font } = fontFor(i.style);
        const need = this.measure(ctx, font, i.text) + 6 + (i.style?.indent ?? 0) * 10;
        let c = i.c;
        while (clipW < need && c < lastCol) {
          const next = cols[cols.indexOf(c) + 1];
          if (next === undefined || model.raw(sid, i.r, next) !== '' || model.value(sid, i.r, next) !== null || inMerge(i.r, next)) break;
          clipW += colW(next);
          c = next;
        }
      }
      this.drawText(ctx, t, i.text, i.v, i.style, x, y, w, h, clipW);
    }

    // 5. Borders.
    for (const i of infos) if (i.style?.borders) this.drawBorders(ctx, i.style, colX(i.c), rowY(i.r), colW(i.c), rowH(i.r));

    // 6. Indicators: comments, validation, filter buttons, links.
    const commented = new Set(st.comments.filter((c) => c.worksheetId === sid && !c.resolved).map((c) => c.cellReference));
    for (const r of rows) {
      for (const c of cols) {
        const x = colX(c);
        const y = rowY(r);
        const w = colW(c);
        const h = rowH(r);
        if (commented.size && commented.has(`${colToLetters(c)}${r + 1}`)) {
          ctx.fillStyle = t.accent;
          ctx.beginPath();
          ctx.moveTo(x + w - 10, y);
          ctx.lineTo(x + w - 1, y);
          ctx.lineTo(x + w - 1, y + 9);
          ctx.fill();
        }
      }
    }
    for (const v of sheet.validations) {
      const vr = parseRangeA1(v.range);
      if (!vr) continue;
      for (const r of rows) {
        if (r < vr.r1 || r > vr.r2) continue;
        for (const c of cols) {
          if (c < vr.c1 || c > vr.c2) continue;
          const x = colX(c);
          const y = rowY(r);
          const w = colW(c);
          const h = rowH(r);
          if (v.rule.kind === 'list' && v.rule.showDropdown) {
            ctx.strokeStyle = t.ink2;
            ctx.lineWidth = 1.25;
            ctx.beginPath();
            ctx.moveTo(x + w - 13, y + h / 2 - 2);
            ctx.lineTo(x + w - 9.5, y + h / 2 + 1.5);
            ctx.lineTo(x + w - 6, y + h / 2 - 2);
            ctx.stroke();
          }
          if (v.rule.kind === 'checkbox') {
            const val = model.value(sid, r, c);
            const s = 13;
            const bx = x + (w - s) / 2;
            const by = y + (h - s) / 2;
            ctx.fillStyle = t.paper;
            ctx.fillRect(bx, by, s, s);
            ctx.strokeStyle = val === true ? t.brand : t.ink2;
            ctx.lineWidth = 1.5;
            ctx.strokeRect(bx + 0.75, by + 0.75, s - 1.5, s - 1.5);
            if (val === true) {
              ctx.fillStyle = t.brand;
              ctx.fillRect(bx, by, s, s);
              ctx.strokeStyle = t.brandInk;
              ctx.beginPath();
              ctx.moveTo(bx + 3, by + 6.5);
              ctx.lineTo(bx + 5.5, by + 9);
              ctx.lineTo(bx + 10, by + 4);
              ctx.stroke();
            }
          }
          if (ctrl.isInvalid(sid, r, c)) {
            ctx.fillStyle = t.danger;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + 7, y);
            ctx.lineTo(x, y + 7);
            ctx.fill();
          }
        }
      }
    }
    const f = ctrl.activeFilter();
    if (f && rows.includes(f.r1)) {
      const y = rowY(f.r1);
      const h = rowH(f.r1);
      for (const c of cols) {
        if (c < f.c1 || c > f.c2) continue;
        const x = colX(c) + colW(c) - 20;
        const active = !!f.criteria?.[c];
        ctx.fillStyle = active ? t.brand : t.paper;
        ctx.fillRect(x, y + (h - 16) / 2, 16, 16);
        ctx.strokeStyle = active ? t.brand : t.line2;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + (h - 16) / 2 + 0.5, 15, 15);
        ctx.fillStyle = active ? t.brandInk : t.ink2;
        const cy = y + h / 2;
        ctx.beginPath();
        ctx.moveTo(x + 4, cy - 3);
        ctx.lineTo(x + 12, cy - 3);
        ctx.lineTo(x + 9, cy + 1);
        ctx.lineTo(x + 9, cy + 4);
        ctx.lineTo(x + 7, cy + 5);
        ctx.lineTo(x + 7, cy + 1);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  private drawText(ctx: CanvasRenderingContext2D, t: Theme, text: string, v: Scalar, style: CellStyle | null, x: number, y: number, w: number, h: number, clipW: number) {
    const { font, px } = fontFor(style);
    if (ctx.font !== font) ctx.font = font;
    const align = style?.hAlign ?? defaultAlign(v);
    const valign = style?.vAlign ?? 'bottom';
    const pad = 4;
    const indent = (style?.indent ?? 0) * 10;
    let display = text;
    const isNumber = typeof v === 'number';
    if (isNumber && !style?.wrap) {
      const avail = w - pad * 2;
      if (this.measure(ctx, font, display) > avail) {
        // Numbers never spill: shorten precision for General, otherwise show ###.
        if (!resolvePattern(style?.numberFormat)) {
          for (let p = 9; p >= 1; p--) {
            const s = formatGeneralNumber(Number((v as number).toPrecision(p)));
            if (this.measure(ctx, font, s) <= avail) {
              display = s;
              break;
            }
          }
        }
        if (this.measure(ctx, font, display) > avail) display = '#'.repeat(Math.max(1, Math.floor(avail / this.measure(ctx, font, '#'))));
      }
    }
    ctx.fillStyle = style?.link ? t.brand : isError(v) ? t.danger : textColorFor(style, style?.backgroundColor, t);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, clipW - 1, h - 1);
    ctx.clip();
    ctx.textBaseline = 'alphabetic';
    const lineH = Math.round(px * 1.3);
    if (style?.rotation) {
      ctx.translate(x + w / 2, y + h / 2);
      ctx.rotate((-style.rotation * Math.PI) / 180);
      ctx.textAlign = 'center';
      ctx.fillText(display, 0, px / 3);
      ctx.restore();
      return;
    }
    let lines = [display];
    if (style?.wrap) lines = wrapLines(display, w - pad * 2 - indent, (s) => this.measure(ctx, font, s));
    else if (display.includes('\n')) lines = [display.split('\n')[0]];
    const blockH = lines.length * lineH;
    let ty: number;
    if (valign === 'top') ty = y + pad + px;
    else if (valign === 'middle') ty = y + (h - blockH) / 2 + px * 0.95;
    else ty = y + h - pad - (blockH - lineH) - Math.round(px * 0.28);
    for (const line of lines) {
      const tw = this.measure(ctx, font, line);
      let tx: number;
      if (align === 'right') tx = x + w - pad - tw - indent;
      else if (align === 'center') tx = x + (w - tw) / 2;
      else tx = x + pad + indent;
      ctx.textAlign = 'left';
      ctx.fillText(line, tx, ty);
      if (style?.underline || style?.link) ctx.fillRect(tx, ty + 2, tw, 1);
      if (style?.strike) ctx.fillRect(tx, ty - px * 0.3, tw, 1);
      ty += lineH;
    }
    ctx.restore();
  }

  private drawBorders(ctx: CanvasRenderingContext2D, style: CellStyle | null, x: number, y: number, w: number, h: number) {
    const b = style?.borders;
    if (!b) return;
    const side = (s: NonNullable<typeof b.top>, x1: number, y1: number, x2: number, y2: number) => {
      const width = s.style === 'thick' ? 3 : s.style === 'medium' ? 2 : 1;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = width;
      ctx.setLineDash(s.style === 'dashed' ? [4, 2] : s.style === 'dotted' ? [1, 2] : []);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      if (s.style === 'double') {
        const dx = y1 === y2 ? 0 : 2;
        const dy = y1 === y2 ? 2 : 0;
        ctx.beginPath();
        ctx.moveTo(x1 + dx, y1 + dy);
        ctx.lineTo(x2 + dx, y2 + dy);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    };
    if (b.top) side(b.top, x, y + 0.5, x + w, y + 0.5);
    if (b.bottom) side(b.bottom, x, y + h - 0.5, x + w, y + h - 0.5);
    if (b.left) side(b.left, x + 0.5, y, x + 0.5, y + h);
    if (b.right) side(b.right, x + w - 0.5, y, x + w - 0.5, y + h);
  }

  private drawHeaders(
    ctx: CanvasRenderingContext2D,
    t: Theme,
    view: View,
    cols: number[],
    rows: number[],
    colX: (c: number) => number,
    rowY: (r: number) => number,
    rowH: (r: number) => number,
    colW: (c: number) => number,
    sel: RangeAddress,
    fw: number,
    fh: number,
  ) {
    const ctrl = this.ctrl;
    const { rows: rAxis, cols: cAxis } = ctrl.axes();
    const allRows = sel.r1 === 0 && sel.r2 >= rAxis.count - 1;
    const allCols = sel.c1 === 0 && sel.c2 >= cAxis.count - 1;
    // Column header band.
    ctx.fillStyle = t.headerBg;
    ctx.fillRect(0, 0, view.w, HEADER_H);
    ctx.fillRect(0, 0, HEADER_W, view.h);
    ctx.font = `500 11px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const sheet = ctrl.sheet()!;
    const fc = sheet.frozenColumns;
    const fr = sheet.frozenRows;
    const drawCol = (c: number) => {
      const x = colX(c);
      const w = colW(c);
      const inSel = c >= sel.c1 && c <= sel.c2;
      if (inSel) {
        ctx.fillStyle = allRows ? t.brand : t.headerActive;
        ctx.fillRect(x, 0, w, HEADER_H);
      }
      ctx.fillStyle = t.grid;
      ctx.fillRect(x + w - 1, 0, 1, HEADER_H);
      ctx.fillStyle = inSel ? (allRows ? t.brandInk : t.ink) : t.headerInk;
      ctx.font = `${inSel ? 600 : 500} 11px ${FONT_FAMILY}`;
      ctx.fillText(colToLetters(c), x + w / 2, HEADER_H / 2 + 0.5);
    };
    ctx.save();
    ctx.beginPath();
    ctx.rect(HEADER_W + fw, 0, view.w, HEADER_H);
    ctx.clip();
    for (const c of cols) if (c >= fc) drawCol(c);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(HEADER_W, 0, fw, HEADER_H);
    ctx.clip();
    for (const c of cols) if (c < fc) drawCol(c);
    ctx.restore();

    const drawRow = (r: number) => {
      const y = rowY(r);
      const h = rowH(r);
      const inSel = r >= sel.r1 && r <= sel.r2;
      if (inSel) {
        ctx.fillStyle = allCols ? t.brand : t.headerActive;
        ctx.fillRect(0, y, HEADER_W, h);
      }
      ctx.fillStyle = t.grid;
      ctx.fillRect(0, y + h - 1, HEADER_W, 1);
      ctx.fillStyle = inSel ? (allCols ? t.brandInk : t.ink) : t.headerInk;
      ctx.font = `${inSel ? 600 : 500} 11px ${FONT_FAMILY}`;
      ctx.fillText(String(r + 1), HEADER_W / 2, y + h / 2 + 0.5);
    };
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, HEADER_H + fh, HEADER_W, view.h);
    ctx.clip();
    for (const r of rows) if (r >= fr) drawRow(r);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, HEADER_H, HEADER_W, fh);
    ctx.clip();
    for (const r of rows) if (r < fr) drawRow(r);
    ctx.restore();

    // Arrows where rows or columns were hidden by hand, so they can be found and shown again.
    this.marks = [];
    const arrows = (cx: number, cy: number, vertical: boolean) => {
      ctx.fillStyle = t.ink2;
      ctx.beginPath();
      if (vertical) {
        ctx.moveTo(cx, cy - 8);
        ctx.lineTo(cx - 4, cy - 3);
        ctx.lineTo(cx + 4, cy - 3);
        ctx.moveTo(cx, cy + 8);
        ctx.lineTo(cx - 4, cy + 3);
        ctx.lineTo(cx + 4, cy + 3);
      } else {
        ctx.moveTo(cx - 8, cy);
        ctx.lineTo(cx - 3, cy - 4);
        ctx.lineTo(cx - 3, cy + 4);
        ctx.moveTo(cx + 8, cy);
        ctx.lineTo(cx + 3, cy - 4);
        ctx.lineTo(cx + 3, cy + 4);
      }
      ctx.fill();
    };
    const md = sheet.metadata;
    for (const run of runsOf(md.hiddenCols ?? [])) {
      const next = run[run.length - 1] + 1;
      if (next >= cAxis.count) continue;
      const bx = colX(next);
      const [lo, hi] = next < fc ? [HEADER_W, HEADER_W + fw] : [HEADER_W + fw, view.w];
      if (bx < lo - 4 || bx > hi + 4) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(lo, 0, hi - lo, HEADER_H);
      ctx.clip();
      arrows(bx, HEADER_H / 2, false);
      ctx.restore();
      this.marks.push({ axis: 'col', indices: run, x: bx - 10, y: 0, w: 20, h: HEADER_H });
    }
    for (const run of runsOf(md.hiddenRows ?? [])) {
      const next = run[run.length - 1] + 1;
      if (next >= rAxis.count) continue;
      const by = rowY(next);
      const [lo, hi] = next < fr ? [HEADER_H, HEADER_H + fh] : [HEADER_H + fh, view.h];
      if (by < lo - 4 || by > hi + 4) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, lo, HEADER_W, hi - lo);
      ctx.clip();
      arrows(HEADER_W / 2, by, true);
      ctx.restore();
      this.marks.push({ axis: 'row', indices: run, x: 0, y: by - 10, w: HEADER_W, h: 20 });
    }

    // Header edges and the corner.
    ctx.fillStyle = t.line2;
    ctx.fillRect(0, HEADER_H - 1, view.w, 1);
    ctx.fillRect(HEADER_W - 1, 0, 1, view.h);
    ctx.fillStyle = t.headerBg;
    ctx.fillRect(0, 0, HEADER_W - 1, HEADER_H - 1);
    ctx.fillStyle = t.line2;
    ctx.beginPath();
    ctx.moveTo(HEADER_W - 5, HEADER_H - 14);
    ctx.lineTo(HEADER_W - 5, HEADER_H - 5);
    ctx.lineTo(HEADER_W - 14, HEADER_H - 5);
    ctx.fill();
  }
}

export function defaultAlign(v: Scalar): 'left' | 'center' | 'right' {
  if (typeof v === 'number') return 'right';
  if (typeof v === 'boolean' || isError(v)) return 'center';
  return 'left';
}

export function wrapLines(text: string, width: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const next = line + w;
      if (measure(next) <= width || line === '') {
        // Break very long words.
        if (line === '' && measure(w) > width) {
          let chunk = '';
          for (const ch of w) {
            if (measure(chunk + ch) > width && chunk) {
              out.push(chunk);
              chunk = ch;
            } else chunk += ch;
          }
          line = chunk;
        } else line = next;
      } else {
        out.push(line.trimEnd());
        line = w.trimStart();
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** Conditional-format formulas are written for the top-left cell and shift with the range. */
function shiftRuleFormula(f: string, dr: number, dc: number): string {
  if (!dr && !dc) return f;
  return translate(f.startsWith('=') ? f : '=' + f, dr, dc);
}
