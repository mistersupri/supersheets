import { ContextMenu } from '@base-ui/react/context-menu';
import clsx from 'clsx';
import { Icon } from '../components/icons';
import { formatA1, parseRangeA1, RangeAddress } from '@opensheet/engine';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { gridFocusTarget, menuItemClass, menuPopupClass } from '../components/ui';
import { subscribeTheme } from '../lib/theme';
import { CellEditor } from './CellEditor';
import { isMobile, useCtrl, useEditor } from './context';
import { displayText } from './controller';
import { FilterPopover, ListPopover } from './GridPopovers';
import { HEADER_H, HEADER_W } from './geometry';
import { readTheme, Renderer, type Theme } from './render';
import { ChartLayer } from './ChartLayer';

type Drag =
  | { kind: 'select'; pointerId: number }
  | { kind: 'rows' | 'cols'; anchor: number; pointerId: number }
  | { kind: 'resize'; axis: 'row' | 'col'; index: number; start: number; startSize: number; pointerId: number; indices: number[] }
  | { kind: 'fill'; src: RangeAddress; pointerId: number }
  | { kind: 'moveLines'; axis: 'row' | 'col'; a: number; b: number; grabbed: number; start: number; started: boolean; to: number | null; pointerId: number }
  | { kind: 'moveCells'; src: RangeAddress; row: number; col: number; x: number; y: number; started: boolean; dr: number; dc: number; pointerId: number }
  | { kind: 'touch'; x: number; y: number; moved: boolean; pointerId: number }
  | { kind: 'point'; anchor: { row: number; col: number }; pointerId: number; insertAt: number; insertLen: number }
  | { kind: 'open'; run: () => void; pointerId: number };

/** Pixels around a header border that grab it for resizing, and around the fill handle. */
const EDGE = 6;
const HANDLE = 8;

export function Grid() {
  const ctrl = useCtrl();
  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sinkRef = useRef<HTMLTextAreaElement>(null);
  const rendererRef = useRef<Renderer>(new Renderer(ctrl));
  const themeRef = useRef<Theme | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  const [fillPreview, setFillPreview] = useState<RangeAddress | null>(null);
  const [movePreview, setMovePreview] = useState<RangeAddress | null>(null);
  const [resizeGuide, setResizeGuide] = useState<{ axis: 'row' | 'col'; pos: number } | null>(null);
  const [listCell, setListCell] = useState<{ row: number; col: number } | null>(null);
  const [filterCol, setFilterCol] = useState<number | null>(null);
  const [cursor, setCursor] = useState('cell');
  const [hoverEdge, setHoverEdge] = useState<{ axis: 'row' | 'col'; pos: number } | null>(null);
  const [handleHover, setHandleHover] = useState(false);
  const frame = useRef(0);

  const state = useEditor((s) => s);
  const { activeSheetId, editing } = state;

  const presenceColors = useMemo(() => {
    const m: Record<string, { color: string; name: string }> = {};
    for (const p of state.presence) m[p.socketId] = { color: p.color, name: p.name.split(' ')[0] };
    return m;
  }, [state.presence]);

  const refHighlights = useMemo(() => {
    if (!editing || !editing.value.startsWith('=') || editing.sheetId !== activeSheetId) return [];
    const out: { range: RangeAddress; index: number }[] = [];
    const re = /(?<![A-Za-z0-9_!'.])\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?(?![A-Za-z0-9_(!])/g;
    let m: RegExpExecArray | null;
    let i = 0;
    // Strings are skipped so text like "A1" inside quotes is not highlighted.
    const src = editing.value.replace(/"[^"]*"/g, (s) => ' '.repeat(s.length));
    while ((m = re.exec(src))) {
      const r = parseRangeA1(m[0].replace(/\$/g, ''));
      if (r) out.push({ range: r, index: i++ });
    }
    return out;
  }, [editing, activeSheetId]);

  // ---------- drawing ----------

  const draw = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      const scrollEl = scrollRef.current;
      if (!canvas || !scrollEl || !ctrl.sheet()) return;
      if (!themeRef.current) themeRef.current = readTheme(document.documentElement);
      const dpr = window.devicePixelRatio || 1;
      const w = scrollEl.clientWidth;
      const h = scrollEl.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      const g = canvas.getContext('2d');
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      rendererRef.current.draw(g, { w, h, scrollLeft: scrollEl.scrollLeft, scrollTop: scrollEl.scrollTop }, themeRef.current, {
        fillPreview,
        movePreview,
        resizeGuide,
        hoverEdge,
        handleHover,
        refHighlights,
        presenceColors,
      });
    });
  }, [ctrl, fillPreview, movePreview, resizeGuide, hoverEdge, handleHover, refHighlights, presenceColors]);

  useEffect(() => {
    draw();
  }, [draw, state]);

  useEffect(() => {
    const off = subscribeTheme(() => {
      // Wait for the new CSS variables to apply.
      requestAnimationFrame(() => {
        themeRef.current = readTheme(document.documentElement);
        draw();
      });
    });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onMq = () => {
      themeRef.current = readTheme(document.documentElement);
      draw();
    };
    mq.addEventListener('change', onMq);
    document.fonts?.ready.then(() => draw());
    const onFonts = () => draw();
    document.fonts?.addEventListener?.('loadingdone', onFonts);
    return () => {
      off();
      mq.removeEventListener('change', onMq);
      document.fonts?.removeEventListener?.('loadingdone', onFonts);
    };
  }, [draw]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
      draw();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [draw]);

  // Reset scroll when switching sheets.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTo({ left: 0, top: 0 });
      setScroll({ left: 0, top: 0 });
    }
  }, [activeSheetId]);

  // ---------- geometry helpers ----------

  const sheet = ctrl.sheet();
  const axes = sheet ? ctrl.axes() : null;
  const frozen = sheet && axes ? { fr: sheet.frozenRows, fc: sheet.frozenColumns, fh: axes.rows.pos(sheet.frozenRows), fw: axes.cols.pos(sheet.frozenColumns) } : { fr: 0, fc: 0, fh: 0, fw: 0 };

  const colX = (c: number) => HEADER_W + axes!.cols.pos(c) - (c >= frozen.fc ? scroll.left : 0);
  const rowY = (r: number) => HEADER_H + axes!.rows.pos(r) - (r >= frozen.fr ? scroll.top : 0);

  const local = (e: { clientX: number; clientY: number }) => {
    const rect = scrollRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const hitCol = (x: number) => {
    const { cols } = ctrl.axes();
    const left = scrollRef.current!.scrollLeft;
    return x < HEADER_W + frozen.fw ? cols.indexAt(x - HEADER_W) : cols.indexAt(x - HEADER_W + left);
  };
  const hitRow = (y: number) => {
    const { rows } = ctrl.axes();
    const top = scrollRef.current!.scrollTop;
    return y < HEADER_H + frozen.fh ? rows.indexAt(y - HEADER_H) : rows.indexAt(y - HEADER_H + top);
  };
  const liveColX = (c: number) => HEADER_W + ctrl.axes().cols.pos(c) - (c >= frozen.fc ? scrollRef.current!.scrollLeft : 0);
  const liveRowY = (r: number) => HEADER_H + ctrl.axes().rows.pos(r) - (r >= frozen.fr ? scrollRef.current!.scrollTop : 0);

  // ---------- keep the focus cell visible ----------

  const ensureVisible = useCallback(
    (row: number | null, col: number | null) => {
      const el = scrollRef.current;
      const sh = ctrl.sheet();
      if (!el || !sh) return;
      const { rows, cols } = ctrl.axes();
      const fw = cols.pos(sh.frozenColumns);
      const fh = rows.pos(sh.frozenRows);
      if (col !== null && col >= sh.frozenColumns) {
        const x1 = cols.pos(col);
        const x2 = x1 + cols.size(col);
        const viewL = el.scrollLeft + fw;
        const viewR = el.scrollLeft + el.clientWidth - HEADER_W;
        if (x1 < viewL) el.scrollLeft = x1 - fw;
        else if (x2 > viewR) el.scrollLeft = x2 - el.clientWidth + HEADER_W + 2;
      }
      if (row !== null && row >= sh.frozenRows) {
        const y1 = rows.pos(row);
        const y2 = y1 + rows.size(row);
        const viewT = el.scrollTop + fh;
        const viewB = el.scrollTop + el.clientHeight - HEADER_H;
        if (y1 < viewT) el.scrollTop = y1 - fh;
        else if (y2 > viewB) el.scrollTop = y2 - el.clientHeight + HEADER_H + 2;
      }
    },
    [ctrl],
  );

  const focusSel = state.selection.focus;
  const anchorSel = state.selection.anchor;
  useEffect(() => {
    if (dragRef.current?.kind === 'select') return;
    // A whole column (or row) puts the focus at its far end; scrolling there would throw the view away.
    const { rows, cols } = ctrl.axes();
    const wholeCol = anchorSel.row === 0 && focusSel.row >= rows.count - 1;
    const wholeRow = anchorSel.col === 0 && focusSel.col >= cols.count - 1;
    if (wholeCol && wholeRow) return;
    ensureVisible(wholeCol ? null : focusSel.row, wholeRow ? null : focusSel.col);
  }, [focusSel.row, focusSel.col, anchorSel.row, anchorSel.col, ensureVisible, ctrl]);

  // ---------- focus management ----------

  const focusSink = useCallback(() => {
    if (!isMobile()) sinkRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!editing) focusSink();
  }, [editing, focusSink]);

  useEffect(() => {
    const onFocusGrid = () => focusSink();
    window.addEventListener('opensheet:focus-grid', onFocusGrid);
    return () => window.removeEventListener('opensheet:focus-grid', onFocusGrid);
  }, [focusSink]);

  // ---------- scroll ----------

  const onScroll = () => {
    const el = scrollRef.current!;
    setScroll({ left: el.scrollLeft, top: el.scrollTop });
    // Grow the grid when the user reaches the end.
    const { rows, cols } = ctrl.axes();
    if (el.scrollTop + el.clientHeight > rows.total - 400 && rows.count < 1_048_576) ctrl.set({ extraRows: ctrl.s.extraRows + 1000 });
    if (el.scrollLeft + el.clientWidth > cols.total - 300 && cols.count < 16_384) ctrl.set({ extraCols: ctrl.s.extraCols + 10 });
    draw();
  };

  // ---------- pointer ----------

  const autoScroll = useRef<{ vx: number; vy: number; raf: number } | null>(null);
  const stopAutoScroll = () => {
    if (autoScroll.current) cancelAnimationFrame(autoScroll.current.raf);
    autoScroll.current = null;
  };

  function canPoint(): { at: number; len: number } | null {
    const e = ctrl.s.editing;
    if (!e || !e.value.startsWith('=')) return null;
    const input = document.querySelector<HTMLTextAreaElement | HTMLInputElement>('[data-active-editor="true"]');
    const caret = input?.selectionStart ?? e.value.length;
    const before = e.value.slice(0, caret);
    if (/[=(,+\-*/^&<>:;]\s*$/.test(before)) return { at: caret, len: 0 };
    return null;
  }

  function insertRef(text: string, at: number, len: number) {
    const e = ctrl.s.editing!;
    const next = e.value.slice(0, at) + text + e.value.slice(at + len);
    ctrl.updateEdit(next);
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLTextAreaElement | HTMLInputElement>('[data-active-editor="true"]');
      if (input) {
        input.focus();
        input.setSelectionRange(at + text.length, at + text.length);
      }
    });
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (ctrl.s.chartSelected) ctrl.set({ chartSelected: null });
    if (e.button === 2) {
      // Right click targets what is under the pointer; the selection follows unless it already covers it.
      const { x, y } = local(e);
      const { rows, cols } = ctrl.axes();
      const r = ctrl.selectionRange();
      if (y < HEADER_H && x > HEADER_W) {
        const col = hitCol(x);
        const covered = r.r1 === 0 && r.r2 >= rows.count - 1 && col >= r.c1 && col <= r.c2;
        if (!covered) ctrl.select({ row: 0, col }, { row: rows.count - 1, col });
        ctrl.set({ contextKind: 'col' });
      } else if (x < HEADER_W && y > HEADER_H) {
        const row = hitRow(y);
        const covered = r.c1 === 0 && r.c2 >= cols.count - 1 && row >= r.r1 && row <= r.r2;
        if (!covered) ctrl.select({ row, col: 0 }, { row, col: cols.count - 1 });
        ctrl.set({ contextKind: 'row' });
      } else if (x > HEADER_W && y > HEADER_H) {
        const row = hitRow(y);
        const col = hitCol(x);
        if (!(row >= r.r1 && row <= r.r2 && col >= r.c1 && col <= r.c2)) ctrl.select({ row, col });
        ctrl.set({ contextKind: 'cell' });
      }
      return;
    }
    if (e.button !== 0) return;
    const { x, y } = local(e);
    const el = scrollRef.current!;
    if (x > el.clientWidth || y > el.clientHeight) return; // scrollbar
    const { rows, cols } = ctrl.axes();
    const touch = e.pointerType === 'touch';
    // Keep keyboard focus in the grid: the default mousedown would move it to <body>.
    if (!touch) e.preventDefault();

    if (x < HEADER_W && y < HEADER_H) {
      if (ctrl.s.editing) ctrl.commitEdit('none');
      ctrl.select({ row: 0, col: 0 }, { row: rows.count - 1, col: cols.count - 1 });
      return;
    }

    // The arrows for hidden rows or columns act on double-click only; a single click leaves the selection alone.
    if (markAt(x, y)) return;

    if (y < HEADER_H) {
      const c = hitCol(x);
      const edge = liveColX(c) + cols.size(c);
      const prevEdge = liveColX(c);
      if (!touch && ctrl.s.can.edit && (Math.abs(x - edge) <= EDGE || (Math.abs(x - prevEdge) <= EDGE && c > 0))) {
        const idx = Math.abs(x - edge) <= EDGE ? c : cols.nextVisible(c, -1);
        const r = ctrl.selectionRange();
        const indices = r.r1 === 0 && r.r2 >= rows.count - 1 && idx >= r.c1 && idx <= r.c2 ? range(r.c1, r.c2) : [idx];
        dragRef.current = { kind: 'resize', axis: 'col', index: idx, start: x, startSize: cols.size(idx), pointerId: e.pointerId, indices };
        setResizeGuide({ axis: 'col', pos: liveColX(idx) + cols.size(idx) });
        el.setPointerCapture(e.pointerId);
        return;
      }
      const lines = !touch && !e.shiftKey ? movableLines('col') : null;
      if (lines && c >= lines.a && c <= lines.b) {
        dragRef.current = { kind: 'moveLines', axis: 'col', a: lines.a, b: lines.b, grabbed: c, start: x, started: false, to: null, pointerId: e.pointerId };
        el.setPointerCapture(e.pointerId);
        return;
      }
      if (ctrl.s.editing) ctrl.commitEdit('none');
      const anchor = e.shiftKey ? ctrl.s.selection.anchor.col : c;
      ctrl.select({ row: 0, col: anchor }, { row: rows.count - 1, col: c });
      if (!touch) {
        dragRef.current = { kind: 'cols', anchor, pointerId: e.pointerId };
        el.setPointerCapture(e.pointerId);
      }
      return;
    }
    if (x < HEADER_W) {
      const r = hitRow(y);
      const edge = liveRowY(r) + rows.size(r);
      const prevEdge = liveRowY(r);
      if (!touch && ctrl.s.can.edit && (Math.abs(y - edge) <= EDGE || (Math.abs(y - prevEdge) <= EDGE && r > 0))) {
        const idx = Math.abs(y - edge) <= EDGE ? r : rows.nextVisible(r, -1);
        const sel = ctrl.selectionRange();
        const indices = sel.c1 === 0 && sel.c2 >= cols.count - 1 && idx >= sel.r1 && idx <= sel.r2 ? range(sel.r1, sel.r2) : [idx];
        dragRef.current = { kind: 'resize', axis: 'row', index: idx, start: y, startSize: rows.size(idx), pointerId: e.pointerId, indices };
        setResizeGuide({ axis: 'row', pos: liveRowY(idx) + rows.size(idx) });
        el.setPointerCapture(e.pointerId);
        return;
      }
      const lines = !touch && !e.shiftKey ? movableLines('row') : null;
      if (lines && r >= lines.a && r <= lines.b) {
        dragRef.current = { kind: 'moveLines', axis: 'row', a: lines.a, b: lines.b, grabbed: r, start: y, started: false, to: null, pointerId: e.pointerId };
        el.setPointerCapture(e.pointerId);
        return;
      }
      if (ctrl.s.editing) ctrl.commitEdit('none');
      const anchor = e.shiftKey ? ctrl.s.selection.anchor.row : r;
      ctrl.select({ row: anchor, col: 0 }, { row: r, col: cols.count - 1 });
      if (!touch) {
        dragRef.current = { kind: 'rows', anchor, pointerId: e.pointerId };
        el.setPointerCapture(e.pointerId);
      }
      return;
    }

    const row = hitRow(y);
    const col = hitCol(x);

    if (touch) {
      dragRef.current = { kind: 'touch', x, y, moved: false, pointerId: e.pointerId };
      return;
    }

    // Formula point mode: clicking a cell while typing a formula inserts its address.
    const point = canPoint();
    if (point && ctrl.s.editing && ctrl.s.editing.sheetId === ctrl.s.activeSheetId) {
      e.preventDefault();
      const ref = formatA1(row, col);
      insertRef(ref, point.at, point.len);
      dragRef.current = { kind: 'point', anchor: { row, col }, pointerId: e.pointerId, insertAt: point.at, insertLen: ref.length };
      el.setPointerCapture(e.pointerId);
      return;
    }

    // Fill handle.
    const sel = ctrl.selectionRange();
    const hx = liveColX(sel.c2) + cols.size(sel.c2);
    const hy = liveRowY(sel.r2) + rows.size(sel.r2);
    if (ctrl.s.can.edit && !ctrl.s.editing && Math.abs(x - hx) <= HANDLE && Math.abs(y - hy) <= HANDLE) {
      dragRef.current = { kind: 'fill', src: sel, pointerId: e.pointerId };
      el.setPointerCapture(e.pointerId);
      return;
    }

    // The outline of the selection is a grip: dragging it moves the cells.
    if (!e.shiftKey && onSelectionBorder(x, y)) {
      dragRef.current = { kind: 'moveCells', src: sel, row, col, x, y, started: false, dr: 0, dc: 0, pointerId: e.pointerId };
      el.setPointerCapture(e.pointerId);
      return;
    }

    // Filter buttons in the filter header row.
    const f = ctrl.activeFilter();
    if (f && row === f.r1 && col >= f.c1 && col <= f.c2) {
      const bx = liveColX(col) + cols.size(col) - 20;
      if (x >= bx && x <= bx + 16) {
        ctrl.select({ row, col });
        // Opened on pointerup so the same click is not read as an outside press.
        dragRef.current = { kind: 'open', run: () => setFilterCol(col), pointerId: e.pointerId };
        return;
      }
    }

    if (ctrl.s.editing) {
      if (!ctrl.commitEdit('none')) return;
    }

    // Validation dropdown arrow and checkboxes.
    const rule = ctrl.validationAt(ctrl.s.activeSheetId, row, col);
    if (rule?.kind === 'list' && rule.showDropdown && x >= liveColX(col) + cols.size(col) - 18) {
      ctrl.select({ row, col });
      if (ctrl.canEditCells([{ sheetId: ctrl.s.activeSheetId, row, col }])) dragRef.current = { kind: 'open', run: () => setListCell({ row, col }), pointerId: e.pointerId };
      return;
    }
    if (rule?.kind === 'checkbox') {
      ctrl.select({ row, col });
      ctrl.toggleCheckbox(row, col);
      return;
    }

    const m = ctrl.mergeAt(row, col);
    if (e.shiftKey) ctrl.select(ctrl.s.selection.anchor, { row, col });
    else ctrl.select(m ? { row: m.r1, col: m.c1 } : { row, col });
    dragRef.current = { kind: 'select', pointerId: e.pointerId };
    el.setPointerCapture(e.pointerId);
    focusSink();
  };

  const tickAutoScroll = () => {
    const a = autoScroll.current;
    const el = scrollRef.current;
    if (!a || !el) return;
    el.scrollLeft += a.vx;
    el.scrollTop += a.vy;
    a.raf = requestAnimationFrame(tickAutoScroll);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const { x, y } = local(e);
    const d = dragRef.current;
    const el = scrollRef.current!;
    const { rows, cols } = ctrl.axes();
    if (!d) {
      // Hover feedback: the cursor and a drawn cue show what a drag would do here.
      let edge: { axis: 'row' | 'col'; pos: number } | null = null;
      let onHandle = false;
      let next = 'default';
      if (markAt(x, y)) {
        next = ctrl.s.can.edit ? 'pointer' : 'default';
      } else if (y < HEADER_H && x > HEADER_W && ctrl.s.can.edit) {
        const c = hitCol(x);
        const right = liveColX(c) + cols.size(c);
        const left = liveColX(c);
        if (Math.abs(x - right) <= EDGE) edge = { axis: 'col', pos: right };
        else if (Math.abs(x - left) <= EDGE && c > 0) edge = { axis: 'col', pos: left };
        const lines = movableLines('col');
        next = edge ? 'col-resize' : lines && c >= lines.a && c <= lines.b ? 'grab' : 'pointer';
      } else if (x < HEADER_W && y > HEADER_H && ctrl.s.can.edit) {
        const r = hitRow(y);
        const bottom = liveRowY(r) + rows.size(r);
        const top = liveRowY(r);
        if (Math.abs(y - bottom) <= EDGE) edge = { axis: 'row', pos: bottom };
        else if (Math.abs(y - top) <= EDGE && r > 0) edge = { axis: 'row', pos: top };
        const lines = movableLines('row');
        next = edge ? 'row-resize' : lines && r >= lines.a && r <= lines.b ? 'grab' : 'pointer';
      } else if (x > HEADER_W && y > HEADER_H) {
        const sel = ctrl.selectionRange();
        const hx = liveColX(sel.c2) + cols.size(sel.c2);
        const hy = liveRowY(sel.r2) + rows.size(sel.r2);
        onHandle = ctrl.s.can.edit && !ctrl.s.editing && Math.abs(x - hx) <= HANDLE && Math.abs(y - hy) <= HANDLE;
        const link = ctrl.model.style(ctrl.s.activeSheetId, hitRow(y), hitCol(x))?.link;
        next = onHandle ? 'crosshair' : onSelectionBorder(x, y) ? 'grab' : link ? 'pointer' : 'cell';
      }
      setCursor((c) => (c === next ? c : next));
      setHoverEdge((cur) => (cur?.axis === edge?.axis && cur?.pos === edge?.pos ? cur : edge));
      setHandleHover((h) => (h === onHandle ? h : onHandle));
      return;
    }
    if (d.kind === 'touch') {
      if (Math.hypot(x - d.x, y - d.y) > 8) d.moved = true;
      return;
    }
    if (d.kind === 'open') return;
    if (d.kind === 'resize') {
      const delta = (d.axis === 'col' ? x : y) - d.start;
      const sizeNow = Math.max(d.axis === 'col' ? 20 : 12, d.startSize + delta);
      const base = d.axis === 'col' ? liveColX(d.index) : liveRowY(d.index);
      setResizeGuide({ axis: d.axis, pos: base + sizeNow });
      return;
    }
    // Auto-scroll near the edges while dragging.
    const margin = 24;
    const vx = x > el.clientWidth - margin ? 12 : x < HEADER_W + frozen.fw + 4 && el.scrollLeft > 0 ? -12 : 0;
    const vy = y > el.clientHeight - margin ? 12 : y < HEADER_H + frozen.fh + 4 && el.scrollTop > 0 ? -12 : 0;
    if (vx || vy) {
      if (!autoScroll.current) {
        autoScroll.current = { vx, vy, raf: 0 };
        autoScroll.current.raf = requestAnimationFrame(tickAutoScroll);
      } else Object.assign(autoScroll.current, { vx, vy });
    } else stopAutoScroll();
    const row = hitRow(Math.max(HEADER_H + 1, Math.min(y, el.clientHeight - 1)));
    const col = hitCol(Math.max(HEADER_W + 1, Math.min(x, el.clientWidth - 1)));
    if (d.kind === 'moveLines') {
      const pos = d.axis === 'col' ? x : y;
      if (!d.started && Math.abs(pos - d.start) < 5) return;
      if (!d.started) {
        d.started = true;
        setCursor('grabbing');
      }
      const to = dropIndex(d.axis, Math.max(d.axis === 'col' ? HEADER_W + 1 : HEADER_H + 1, pos));
      d.to = to;
      const noop = to >= d.a && to <= d.b + 1;
      const count = d.axis === 'col' ? cols.count : rows.count;
      const at = d.axis === 'col' ? (to >= count ? liveColX(count - 1) + cols.size(count - 1) : liveColX(to)) : to >= count ? liveRowY(count - 1) + rows.size(count - 1) : liveRowY(to);
      setResizeGuide(noop ? null : { axis: d.axis, pos: at });
    } else if (d.kind === 'moveCells') {
      if (!d.started && Math.hypot(x - d.x, y - d.y) < 5) return;
      if (!d.started) {
        d.started = true;
        setCursor('grabbing');
      }
      const dr = Math.max(row - d.row, -d.src.r1);
      const dc = Math.max(col - d.col, -d.src.c1);
      d.dr = dr;
      d.dc = dc;
      setMovePreview(dr || dc ? { r1: d.src.r1 + dr, r2: d.src.r2 + dr, c1: d.src.c1 + dc, c2: d.src.c2 + dc } : null);
    } else if (d.kind === 'select') ctrl.select(ctrl.s.selection.anchor, { row, col });
    else if (d.kind === 'cols') ctrl.select({ row: 0, col: d.anchor }, { row: rows.count - 1, col });
    else if (d.kind === 'rows') ctrl.select({ row: d.anchor, col: 0 }, { row, col: cols.count - 1 });
    else if (d.kind === 'point') {
      const ref = d.anchor.row === row && d.anchor.col === col ? formatA1(row, col) : `${formatA1(Math.min(d.anchor.row, row), Math.min(d.anchor.col, col))}:${formatA1(Math.max(d.anchor.row, row), Math.max(d.anchor.col, col))}`;
      insertRef(ref, d.insertAt, d.insertLen);
      d.insertLen = ref.length;
    } else if (d.kind === 'fill') {
      const s = d.src;
      const down = row > s.r2 ? row - s.r2 : 0;
      const up = row < s.r1 ? s.r1 - row : 0;
      const right = col > s.c2 ? col - s.c2 : 0;
      const left = col < s.c1 ? s.c1 - col : 0;
      const vertical = Math.max(down, up) >= Math.max(right, left);
      let target: RangeAddress | null = null;
      if (vertical && down) target = { ...s, r2: row };
      else if (vertical && up) target = { ...s, r1: row };
      else if (!vertical && right) target = { ...s, c2: col };
      else if (!vertical && left) target = { ...s, c1: col };
      setFillPreview(target);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    stopAutoScroll();
    const el = scrollRef.current!;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.kind === 'open') {
      setTimeout(d.run, 0);
      return;
    }
    if (d.kind !== 'point' && d.kind !== 'touch' && !ctrl.s.editing) focusSink();
    const { x, y } = local(e);
    if (d.kind === 'touch' && !d.moved) {
      if (y > HEADER_H && x > HEADER_W) {
        const row = hitRow(y);
        const col = hitCol(x);
        const a = ctrl.s.selection.anchor;
        const rule = ctrl.validationAt(ctrl.s.activeSheetId, row, col);
        if (rule?.kind === 'checkbox') {
          ctrl.select({ row, col });
          ctrl.toggleCheckbox(row, col);
        } else if (rule?.kind === 'list' && rule.showDropdown && a.row === row && a.col === col) {
          if (ctrl.canEditCells([{ sheetId: ctrl.s.activeSheetId, row, col }])) setListCell({ row, col });
        } else if (a.row === row && a.col === col && !ctrl.s.editing) {
          // Second tap on the selected cell opens the editing panel.
          if (ctrl.s.can.edit) {
            ctrl.startEdit();
            if (ctrl.s.editing) ctrl.set({ dialog: 'mobileFormula' });
          }
        } else {
          const m = ctrl.mergeAt(row, col);
          ctrl.select(m ? { row: m.r1, col: m.c1 } : { row, col });
        }
      }
      return;
    }
    if (d.kind === 'resize') {
      const delta = (d.axis === 'col' ? x : y) - d.start;
      setResizeGuide(null);
      if (Math.abs(delta) >= 2) ctrl.resize(d.axis, d.indices, d.startSize + delta);
      return;
    }
    if (d.kind === 'moveLines') {
      setResizeGuide(null);
      setCursor('default');
      const { rows, cols } = ctrl.axes();
      if (d.started && d.to !== null) ctrl.moveLines(d.axis, d.a, d.b, d.to);
      else if (!d.started) {
        // A plain click on an already selected header selects just that one.
        if (d.axis === 'col') ctrl.select({ row: 0, col: d.grabbed }, { row: rows.count - 1, col: d.grabbed });
        else ctrl.select({ row: d.grabbed, col: 0 }, { row: d.grabbed, col: cols.count - 1 });
      }
      return;
    }
    if (d.kind === 'moveCells') {
      setMovePreview(null);
      setCursor('cell');
      if (d.started) ctrl.moveCells(d.dr, d.dc);
      else ctrl.select({ row: d.row, col: d.col });
      return;
    }
    if (d.kind === 'fill') {
      if (fillPreview) ctrl.fill(d.src, fillPreview);
      setFillPreview(null);
      return;
    }
    if (d.kind === 'select') {
      // A click on a link with Ctrl/Cmd opens it.
      const a = ctrl.s.selection.anchor;
      const link = ctrl.model.style(ctrl.s.activeSheetId, a.row, a.col)?.link;
      if (link && (e.ctrlKey || e.metaKey)) window.open(link, '_blank', 'noopener,noreferrer');
    }
  };

  /** The whole rows or columns selected, when a drag from their header should move them. */
  const movableLines = (axis: 'row' | 'col') => {
    if (!ctrl.s.can.edit || ctrl.s.editing) return null;
    const { rows, cols } = ctrl.axes();
    const r = ctrl.selectionRange();
    const allRows = r.r1 === 0 && r.r2 >= rows.count - 1;
    const allCols = r.c1 === 0 && r.c2 >= cols.count - 1;
    if (allRows && allCols) return null;
    if (axis === 'col' && allRows) return { a: r.c1, b: r.c2 };
    if (axis === 'row' && allCols) return { a: r.r1, b: r.r2 };
    return null;
  };

  /** True when (x, y) is on the outline of the selected cells, which can be dragged to move them. */
  const onSelectionBorder = (x: number, y: number) => {
    if (!ctrl.s.can.edit || ctrl.s.editing || x <= HEADER_W || y <= HEADER_H) return false;
    const { rows, cols } = ctrl.axes();
    const s = ctrl.selectionRange();
    if ((s.r1 === 0 && s.r2 >= rows.count - 1) || (s.c1 === 0 && s.c2 >= cols.count - 1)) return false;
    const T = 3;
    const left = liveColX(s.c1);
    const right = liveColX(s.c2) + cols.size(s.c2);
    const top = liveRowY(s.r1);
    const bottom = liveRowY(s.r2) + rows.size(s.r2);
    const hx = right;
    const hy = bottom;
    if (Math.abs(x - hx) <= HANDLE && Math.abs(y - hy) <= HANDLE) return false;
    const inX = x >= left - T && x <= right + T;
    const inY = y >= top - T && y <= bottom + T;
    const nearV = Math.abs(x - left) <= T || Math.abs(x - right) <= T;
    const nearH = Math.abs(y - top) <= T || Math.abs(y - bottom) <= T;
    return (nearV && inY) || (nearH && inX);
  };

  /** Where a dragged block of rows or columns would be dropped: the boundary closest to the pointer. */
  const dropIndex = (axis: 'row' | 'col', pos: number) => {
    const { rows, cols } = ctrl.axes();
    if (axis === 'col') {
      const c = hitCol(pos);
      return pos < liveColX(c) + cols.size(c) / 2 ? c : c + 1;
    }
    const r = hitRow(pos);
    return pos < liveRowY(r) + rows.size(r) / 2 ? r : r + 1;
  };

  /** The hidden-row/column arrows under the pointer, if any. */
  const markAt = (x: number, y: number) => rendererRef.current.marks.find((m) => x >= m.x && x <= m.x + m.w && y >= m.y && y <= m.y + m.h && (m.axis === 'col' ? y < HEADER_H : x < HEADER_W));

  const onDoubleClick = (e: React.MouseEvent) => {
    const { x, y } = local(e);
    const { rows, cols } = ctrl.axes();
    const mark = ctrl.s.can.edit ? markAt(x, y) : undefined;
    if (mark) {
      ctrl.setHidden(mark.axis, mark.indices, false);
      return;
    }
    if (y < HEADER_H && x > HEADER_W && ctrl.s.can.edit) {
      const c = hitCol(x);
      const edge = liveColX(c) + cols.size(c);
      if (Math.abs(x - edge) <= 4) {
        autofit(c);
        return;
      }
    }
    if (x < HEADER_W && y > HEADER_H && ctrl.s.can.edit) {
      const r = hitRow(y);
      if (Math.abs(y - (liveRowY(r) + rows.size(r))) <= 3) {
        ctrl.resize('row', [r], ctrl.sheet()!.defaultRowHeight);
        return;
      }
    }
    if (x > HEADER_W && y > HEADER_H && !isMobile()) {
      const rule = ctrl.validationAt(ctrl.s.activeSheetId, hitRow(y), hitCol(x));
      if (rule?.kind === 'checkbox') return;
      ctrl.startEdit();
    }
  };

  function autofit(col: number) {
    const sid = ctrl.s.activeSheetId;
    const canvas = canvasRef.current!.getContext('2d')!;
    let max = 30;
    for (const c of ctrl.model.engine.cells(sid)) {
      if (c.col !== col) continue;
      const style = ctrl.model.style(sid, c.row, c.col);
      const px = Math.round(((style?.fontSize ?? 10) * 4) / 3);
      canvas.font = `${style?.bold ? 600 : 400} ${px}px "IBM Plex Sans"`;
      max = Math.max(max, canvas.measureText(displayText(c.value, style)).width + 14);
    }
    ctrl.resize('col', [col], Math.min(600, max));
  }

  // ---------- keyboard ----------

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.nativeEvent.isComposing) return;
    if (ctrl.s.chartSelected && !ctrl.s.editing) {
      if (key === 'Delete' || key === 'Backspace') return handled(), ctrl.deleteChart(ctrl.s.chartSelected);
      if (key === 'Escape') return handled(), ctrl.set({ chartSelected: null });
    }
    if (mod && !e.altKey) {
      const k = key.toLowerCase();
      if (k === 'z') return handled(), e.shiftKey ? ctrl.redo() : ctrl.undo();
      if (k === 'y') return handled(), ctrl.redo();
      if (k === 'b') return handled(), ctrl.toggleStyle('bold');
      if (k === 'i') return handled(), ctrl.toggleStyle('italic');
      if (k === 'u') return handled(), ctrl.toggleStyle('underline');
      if (k === '5') return handled(), ctrl.toggleStyle('strike');
      if (e.shiftKey && (k === 'l' || k === 'e' || k === 'r')) {
        handled();
        return ctrl.applyStyle({ hAlign: k === 'l' ? 'left' : k === 'e' ? 'center' : 'right' }, 'Perataan');
      }
      if (k === 'a') {
        handled();
        const { rows, cols } = ctrl.axes();
        return ctrl.select({ row: 0, col: 0 }, { row: rows.count - 1, col: cols.count - 1 });
      }
      if (k === 'f') return handled(), ctrl.set({ dialog: 'find', findOpenReplace: false });
      if (k === 'h') return handled(), ctrl.set({ dialog: 'find', findOpenReplace: true });
      if (k === 'k') return handled(), ctrl.set({ dialog: 'link' });
      if (k === '/') return handled(), ctrl.set({ dialog: 'shortcuts' });
      if (k === '`') return handled(), ctrl.set({ showFormulas: !ctrl.s.showFormulas });
      if (key === ' ') {
        handled();
        const a = ctrl.s.selection.anchor;
        return ctrl.select({ row: 0, col: a.col }, { row: ctrl.axes().rows.count - 1, col: ctrl.s.selection.focus.col });
      }
      if (key === 'Home') return handled(), ctrl.select({ row: 0, col: 0 });
      if (key === 'End') {
        handled();
        const u = ctrl.model.usedSize(ctrl.s.activeSheetId);
        return ctrl.select({ row: Math.max(0, u.rows - 1), col: Math.max(0, u.cols - 1) });
      }
      if (e.altKey && k === 'm') return handled(), ctrl.openCommentDraft();
    }
    if (mod && e.altKey && key.toLowerCase() === 'm') return handled(), ctrl.openCommentDraft();
    if (e.shiftKey && key === ' ' && !mod) {
      handled();
      const a = ctrl.s.selection.anchor;
      return ctrl.select({ row: a.row, col: 0 }, { row: ctrl.s.selection.focus.row, col: ctrl.axes().cols.count - 1 });
    }
    switch (key) {
      case 'ArrowUp':
        return handled(), ctrl.move(-1, 0, e.shiftKey, mod);
      case 'ArrowDown':
        if (e.altKey) {
          handled();
          const a = ctrl.s.selection.anchor;
          const rule = ctrl.validationAt(ctrl.s.activeSheetId, a.row, a.col);
          if (rule?.kind === 'list' && ctrl.canEditCells([{ sheetId: ctrl.s.activeSheetId, ...a }])) setListCell(a);
          return;
        }
        return handled(), ctrl.move(1, 0, e.shiftKey, mod);
      case 'ArrowLeft':
        return handled(), ctrl.move(0, -1, e.shiftKey, mod);
      case 'ArrowRight':
        return handled(), ctrl.move(0, 1, e.shiftKey, mod);
      case 'Tab':
        return handled(), ctrl.move(0, e.shiftKey ? -1 : 1, false);
      case 'Enter':
        handled();
        if (e.shiftKey) return ctrl.move(-1, 0, false);
        if (isMobile()) {
          ctrl.startEdit();
          if (ctrl.s.editing) ctrl.set({ dialog: 'mobileFormula' });
          return;
        }
        return ctrl.startEdit();
      case 'F2':
        return handled(), ctrl.startEdit();
      case 'Delete':
      case 'Backspace':
        return handled(), ctrl.clearContents();
      case 'Escape':
        return handled(), ctrl.clearCopy();
      case 'Home':
        return handled(), ctrl.select({ row: ctrl.s.selection.anchor.row, col: 0 });
      case 'PageDown':
      case 'PageUp': {
        handled();
        const el = scrollRef.current!;
        const rowsPerPage = Math.max(1, Math.floor((el.clientHeight - HEADER_H) / (ctrl.sheet()!.defaultRowHeight || 24)) - 1);
        return ctrl.move(key === 'PageDown' ? rowsPerPage : -rowsPerPage, 0, e.shiftKey);
      }
      case ' ':
        if (!mod) {
          const a = ctrl.s.selection.anchor;
          const rule = ctrl.validationAt(ctrl.s.activeSheetId, a.row, a.col);
          if (rule?.kind === 'checkbox') return handled(), ctrl.toggleCheckbox(a.row, a.col);
        }
    }
    // Printable character starts editing with that character.
    if (!mod && !e.altKey && key.length === 1) {
      handled();
      if (!ctrl.s.can.edit) return void toast.message('Anda hanya dapat melihat workbook ini.');
      ctrl.startEdit(key);
      if (isMobile() && ctrl.s.editing) ctrl.set({ dialog: 'mobileFormula' });
    }
  };

  const onCopy = (e: React.ClipboardEvent, cut: boolean) => {
    e.preventDefault();
    if (cut && !ctrl.s.can.edit) return void toast.message('Anda hanya dapat melihat workbook ini.');
    const text = ctrl.copy(cut);
    e.clipboardData.setData('text/plain', text);
    e.clipboardData.setData('text/html', ctrl.copyHtml());
  };

  const onPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    const html = e.clipboardData.getData('text/html');
    ctrl.paste(text || (html ? htmlTableToTsv(html) : ''));
  };

  // ---------- accessibility text ----------

  const a = state.selection.anchor;
  const sr = ctrl.selectionRange();
  const ariaCell = sheet
    ? `${formatA1(a.row, a.col)}${sr.r1 !== sr.r2 || sr.c1 !== sr.c2 ? `, rentang ${formatA1(sr.r1, sr.c1)} sampai ${formatA1(sr.r2, sr.c2)}` : ''}: ${displayText(ctrl.model.value(activeSheetId, a.row, a.col), ctrl.model.style(activeSheetId, a.row, a.col)) || 'kosong'}`
    : '';

  if (!sheet || !axes) return null;

  const editRect = editing && editing.sheetId === activeSheetId
    ? (() => {
        const m = ctrl.mergeAt(editing.row, editing.col) ?? { r1: editing.row, c1: editing.col, r2: editing.row, c2: editing.col };
        let w = 0;
        for (let c = m.c1; c <= m.c2; c++) w += axes.cols.size(c);
        let h = 0;
        for (let r = m.r1; r <= m.r2; r++) h += axes.rows.size(r);
        return { x: colX(m.c1), y: rowY(m.r1), w, h };
      })()
    : null;

  const anchorRect = (cell: { row: number; col: number }) => {
    const rect = scrollRef.current?.getBoundingClientRect();
    const x = colX(cell.col) + (rect?.left ?? 0);
    const y = rowY(cell.row) + (rect?.top ?? 0);
    return new DOMRect(x, y, axes.cols.size(cell.col), axes.rows.size(cell.row));
  };

  return (
    <div ref={wrapRef} className="relative min-h-0 flex-1 overflow-hidden bg-surface">
      <ContextMenu.Root>
        <ContextMenu.Trigger
          render={
            <div
              ref={scrollRef}
              className="scroll-thin absolute inset-0 overflow-auto overscroll-contain"
              style={{ cursor, touchAction: 'pan-x pan-y' }}
              onScroll={onScroll}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onPointerLeave={() => {
                setHoverEdge(null);
                setHandleHover(false);
              }}
              onDoubleClick={onDoubleClick}
              role="grid"
              aria-label={`Sheet ${sheet.title}`}
              aria-rowcount={axes.rows.count}
              aria-colcount={axes.cols.count}
            />
          }
        >
          <div style={{ width: HEADER_W + axes.cols.total, height: HEADER_H + axes.rows.total, position: 'relative' }}>
            <canvas ref={canvasRef} style={{ position: 'sticky', top: 0, left: 0, display: 'block', width: size.w, height: size.h }} aria-hidden="true" />
          </div>
        </ContextMenu.Trigger>
        <GridContextMenu onAfter={focusSink} onAutofit={autofit} />
      </ContextMenu.Root>

      <ChartLayer scrollEl={() => scrollRef.current} scroll={scroll} />

      {/* Keyboard sink: receives keys, copy, cut and paste for the grid. */}
      <textarea
        ref={sinkRef}
        aria-label={`Lembar kerja. Sel aktif ${ariaCell}`}
        aria-roledescription="spreadsheet"
        className="absolute top-0 left-0 h-px w-px resize-none overflow-hidden border-0 p-0 opacity-0"
        onKeyDown={onKeyDown}
        onCopy={(e) => onCopy(e, false)}
        onCut={(e) => onCopy(e, true)}
        onPaste={onPaste}
        value=""
        onChange={() => undefined}
        tabIndex={0}
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
      />
      <div aria-live="polite" className="sr-only">
        {ariaCell}
      </div>

      {editRect && editing?.source !== undefined && !isMobile() && (
        <CellEditor rect={editRect} viewport={{ w: size.w, h: size.h }} onDone={focusSink} />
      )}

      {listCell && (
        <ListPopover
          anchor={() => anchorRect(listCell)}
          cell={listCell}
          onClose={() => {
            setListCell(null);
            focusSink();
          }}
        />
      )}
      {filterCol !== null && (
        <FilterPopover
          anchor={() => anchorRect({ row: ctrl.activeFilter()?.r1 ?? 0, col: filterCol })}
          col={filterCol}
          onClose={() => {
            setFilterCol(null);
            focusSink();
          }}
        />
      )}
    </div>
  );
}

function range(a: number, b: number) {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

function htmlTableToTsv(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const rows = [...doc.querySelectorAll('tr')];
  if (!rows.length) return doc.body.textContent ?? '';
  return rows.map((tr) => [...tr.querySelectorAll('td,th')].map((td) => (td.textContent ?? '').replace(/\t|\n/g, ' ')).join('\t')).join('\n');
}

function GridContextMenu({ onAfter, onAutofit }: { onAfter: () => void; onAutofit: (col: number) => void }) {
  const ctrl = useCtrl();
  const can = useEditor((s) => s.can);
  const kind = useEditor((s) => s.contextKind);
  useEditor((s) => s.selection);
  const r = ctrl.selectionRange();
  const sheet = ctrl.sheet()!;
  const nRows = r.r2 - r.r1 + 1;
  const nCols = r.c2 - r.c1 + 1;
  const hiddenRows = ctrl.hiddenNear('row');
  const hiddenCols = ctrl.hiddenNear('col');
  const run = (fn: () => void) => () => {
    fn();
    onAfter();
  };
  const clip = async (cut: boolean) => {
    const text = ctrl.copy(cut);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* the internal clipboard still works for pasting inside OpenSheet */
    }
  };
  const paste = async (opts?: { valuesOnly?: boolean; formatOnly?: boolean }) => {
    let text: string | null = null;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = null;
    }
    if (text === null && !ctrl.s.copyRange) return void toast.message('Browser memblokir akses papan klip. Gunakan Ctrl+V.');
    ctrl.paste(text, opts);
  };
  const sortSheet = (col: number, asc: boolean) => {
    const used = ctrl.model.usedSize(sheet.id);
    ctrl.sortRange({ r1: 0, c1: 0, r2: Math.max(0, used.rows - 1), c2: Math.max(0, used.cols - 1) }, col, asc, false);
  };
  const Item = ({ children, onClick, disabled, hint, icon, danger }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; hint?: string; icon?: React.ReactNode; danger?: boolean }) => (
    <ContextMenu.Item className={clsx(menuItemClass, danger && 'text-danger')} onClick={run(onClick)} disabled={disabled}>
      <span className="flex w-4 shrink-0 justify-center text-ink-2">{icon}</span>
      <span className="flex-1">{children}</span>
      {hint && <span className="addr text-xs text-ink-2">{hint}</span>}
    </ContextMenu.Item>
  );
  const Sep = () => <ContextMenu.Separator className="my-1 h-px bg-line" />;
  const ic = { size: 15 };
  const colLabel = nCols > 1 ? `${colName(r.c1)}-${colName(r.c2)}` : colName(r.c1);
  const rowLabel = nRows > 1 ? `${r.r1 + 1}-${r.r2 + 1}` : String(r.r1 + 1);
  return (
    <ContextMenu.Portal>
      <ContextMenu.Positioner className="z-50 outline-none">
        <ContextMenu.Popup className={menuPopupClass} finalFocus={gridFocusTarget}>
          {kind !== 'cell' && (
            <div className="px-3 pt-1.5 pb-1 text-xs font-medium text-ink-2">{kind === 'col' ? `Kolom ${colLabel}` : `Baris ${rowLabel}`}</div>
          )}
          {can.edit && <Item icon={<Icon.Cut {...ic} />} onClick={() => clip(true)} hint="Ctrl+X">Potong</Item>}
          <Item icon={<Icon.Copy {...ic} />} onClick={() => clip(false)} hint="Ctrl+C">Salin</Item>
          {can.edit && (
            <>
              <Item icon={<Icon.Paste {...ic} />} onClick={() => paste()} hint="Ctrl+V">Tempel</Item>
              {kind === 'cell' && (
                <>
                  <Item onClick={() => paste({ valuesOnly: true })} disabled={!ctrl.s.copyRange}>Tempel nilai saja</Item>
                  <Item onClick={() => paste({ formatOnly: true })} disabled={!ctrl.s.copyRange}>Tempel format saja</Item>
                </>
              )}
              <Sep />
              {kind === 'col' ? (
                <>
                  <Item icon={<Icon.Plus {...ic} />} onClick={() => ctrl.insertCols('left')}>Sisipkan {nCols} kolom di kiri</Item>
                  <Item icon={<Icon.Plus {...ic} />} onClick={() => ctrl.insertCols('right')}>Sisipkan {nCols} kolom di kanan</Item>
                  <Item icon={<Icon.Trash {...ic} />} danger onClick={() => ctrl.deleteCols()}>Hapus kolom {colLabel}</Item>
                  <Item icon={<Icon.Eraser {...ic} />} onClick={() => ctrl.clearContents()} hint="Del">Hapus isi</Item>
                  <Sep />
                  <Item icon={<Icon.EyeOff {...ic} />} onClick={() => ctrl.setHidden('col', range(r.c1, r.c2), true)}>Sembunyikan kolom</Item>
                  {hiddenCols.length > 0 && <Item icon={<Icon.Eye {...ic} />} onClick={() => ctrl.setHidden('col', hiddenCols, false)}>Tampilkan {hiddenCols.length} kolom tersembunyi</Item>}
                  <Item icon={<Icon.Cols {...ic} />} onClick={() => onAutofit(r.c1)}>Lebar sesuai isi</Item>
                  <Item onClick={() => ctrl.resize('col', range(r.c1, r.c2), sheet.defaultColumnWidth)}>Atur ulang lebar</Item>
                  <Item icon={<Icon.Freeze {...ic} />} onClick={() => ctrl.freeze(null, r.c2 + 1)}>Bekukan sampai kolom {colName(r.c2)}</Item>
                  <Sep />
                  <Item icon={<Icon.SortAsc {...ic} />} onClick={() => sortSheet(r.c1, true)}>Urutkan sheet A ke Z</Item>
                  <Item icon={<Icon.SortDesc {...ic} />} onClick={() => sortSheet(r.c1, false)}>Urutkan sheet Z ke A</Item>
                </>
              ) : kind === 'row' ? (
                <>
                  <Item icon={<Icon.Plus {...ic} />} onClick={() => ctrl.insertRows('above')}>Sisipkan {nRows} baris di atas</Item>
                  <Item icon={<Icon.Plus {...ic} />} onClick={() => ctrl.insertRows('below')}>Sisipkan {nRows} baris di bawah</Item>
                  <Item icon={<Icon.Trash {...ic} />} danger onClick={() => ctrl.deleteRows()}>Hapus baris {rowLabel}</Item>
                  <Item icon={<Icon.Eraser {...ic} />} onClick={() => ctrl.clearContents()} hint="Del">Hapus isi</Item>
                  <Sep />
                  <Item icon={<Icon.EyeOff {...ic} />} onClick={() => ctrl.setHidden('row', range(r.r1, r.r2), true)}>Sembunyikan baris</Item>
                  {hiddenRows.length > 0 && <Item icon={<Icon.Eye {...ic} />} onClick={() => ctrl.setHidden('row', hiddenRows, false)}>Tampilkan {hiddenRows.length} baris tersembunyi</Item>}
                  <Item icon={<Icon.Rows {...ic} />} onClick={() => ctrl.resize('row', range(r.r1, r.r2), sheet.defaultRowHeight)}>Atur ulang tinggi</Item>
                  <Item icon={<Icon.Freeze {...ic} />} onClick={() => ctrl.freeze(r.r2 + 1, null)}>Bekukan sampai baris {r.r2 + 1}</Item>
                </>
              ) : (
                <>
                  <Item icon={<Icon.Plus {...ic} />} onClick={() => ctrl.insertRows('above')}>Sisipkan {nRows} baris di atas</Item>
                  <Item icon={<Icon.Plus {...ic} />} onClick={() => ctrl.insertRows('below')}>Sisipkan {nRows} baris di bawah</Item>
                  <Item icon={<Icon.Plus {...ic} />} onClick={() => ctrl.insertCols('left')}>Sisipkan {nCols} kolom di kiri</Item>
                  <Item icon={<Icon.Plus {...ic} />} onClick={() => ctrl.insertCols('right')}>Sisipkan {nCols} kolom di kanan</Item>
                  <Item icon={<Icon.Trash {...ic} />} danger onClick={() => ctrl.deleteRows()}>Hapus baris {rowLabel}</Item>
                  <Item icon={<Icon.Trash {...ic} />} danger onClick={() => ctrl.deleteCols()}>Hapus kolom {colLabel}</Item>
                  <Sep />
                  <Item icon={<Icon.Eraser {...ic} />} onClick={() => ctrl.clearContents()} hint="Del">Hapus isi</Item>
                  <Item icon={<Icon.Paint {...ic} />} onClick={() => ctrl.set({ dialog: 'formatCells' })}>Format sel</Item>
                  <Item icon={<Icon.Link {...ic} />} onClick={() => ctrl.set({ dialog: 'link' })} hint="Ctrl+K">Sisipkan tautan</Item>
                  <Sep />
                  <Item icon={<Icon.SortAsc {...ic} />} onClick={() => ctrl.sortSelection(true)}>Urutkan A ke Z</Item>
                  <Item icon={<Icon.SortDesc {...ic} />} onClick={() => ctrl.sortSelection(false)}>Urutkan Z ke A</Item>
                  <Item icon={<Icon.Filter {...ic} />} onClick={() => ctrl.set({ dialog: 'createFilter' })}>Buat filter dari rentang ini</Item>
                </>
              )}
            </>
          )}
          {can.comment && kind === 'cell' && (
            <>
              <Sep />
              <Item icon={<Icon.Comment {...ic} />} onClick={() => ctrl.openCommentDraft()} hint="Ctrl+Alt+M">Tambah komentar</Item>
            </>
          )}
        </ContextMenu.Popup>
      </ContextMenu.Positioner>
    </ContextMenu.Portal>
  );
}

function colName(c: number) {
  return formatA1(0, c).replace(/\d+$/, '');
}
