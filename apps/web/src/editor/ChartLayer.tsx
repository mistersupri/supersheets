import { useRef, useState } from 'react';
import type { ChartSpec } from '@opensheet/engine';
import { Icon } from '../components/icons';
import { ChartSvg } from './ChartSvg';
import { useCtrl, useEditor, isMobile } from './context';
import { HEADER_H, HEADER_W } from './geometry';

type Gesture = { id: string; mode: 'move' | 'resize'; x: number; y: number; moved: boolean; spec: ChartSpec; px: number; py: number; w: number; h: number };

/** Charts float over the grid. They scroll with the cells and are clipped to the cell area, under the headers. */
export function ChartLayer({ scrollEl, scroll }: { scrollEl: () => HTMLElement | null; scroll: { left: number; top: number } }) {
  const ctrl = useCtrl();
  useEditor((s) => s.version);
  useEditor((s) => s.activeSheetId);
  const selected = useEditor((s) => s.chartSelected);
  const can = useEditor((s) => s.can);
  const charts = ctrl.charts();
  const [g, setG] = useState<Gesture | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  if (!charts.length) return null;
  const { rows, cols } = ctrl.axes();
  const editable = can.edit && !isMobile();

  const place = (c: ChartSpec) => {
    if (g && g.id === c.id) return { x: g.px, y: g.py, w: g.w, h: g.h };
    return { x: cols.pos(c.col) + c.dx, y: rows.pos(c.row) + c.dy, w: c.w, h: c.h };
  };

  const start = (e: React.PointerEvent, c: ChartSpec, mode: Gesture['mode']) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    // Keep keyboard focus in the grid (the default mousedown would move it to <body>), so Delete reaches it.
    e.preventDefault();
    ctrl.set({ chartSelected: c.id });
    window.dispatchEvent(new Event('opensheet:focus-grid'));
    if (!editable) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = place(c);
    const next = { id: c.id, mode, x: e.clientX, y: e.clientY, moved: false, spec: c, px: p.x, py: p.y, w: p.w, h: p.h };
    gestureRef.current = next;
    setG(next);
  };
  const move = (e: React.PointerEvent) => {
    const cur = gestureRef.current;
    if (!cur) return;
    const dx = e.clientX - cur.x;
    const dy = e.clientY - cur.y;
    if (!cur.moved && Math.hypot(dx, dy) < 4) return;
    const base = { x: cols.pos(cur.spec.col) + cur.spec.dx, y: rows.pos(cur.spec.row) + cur.spec.dy };
    const next: Gesture =
      cur.mode === 'move'
        ? { ...cur, moved: true, px: Math.max(0, base.x + dx), py: Math.max(0, base.y + dy) }
        : { ...cur, moved: true, w: Math.max(160, Math.min(2000, cur.spec.w + dx)), h: Math.max(120, Math.min(1500, cur.spec.h + dy)) };
    gestureRef.current = next;
    setG(next);
  };
  const end = () => {
    const cur = gestureRef.current;
    gestureRef.current = null;
    setG(null);
    if (!cur || !cur.moved) return;
    if (cur.mode === 'move') {
      const col = cols.indexAt(cur.px);
      const row = rows.indexAt(cur.py);
      ctrl.updateChart(cur.id, { col, row, dx: Math.round(cur.px - cols.pos(col)), dy: Math.round(cur.py - rows.pos(row)) }, 'Pindahkan bagan');
    } else ctrl.updateChart(cur.id, { w: Math.round(cur.w), h: Math.round(cur.h) }, 'Ubah ukuran bagan');
  };

  return (
    <div className="pointer-events-none absolute overflow-hidden" style={{ left: HEADER_W, top: HEADER_H, right: 12, bottom: 12 }}>
      {charts.map((c) => {
        const p = place(c);
        const isSel = selected === c.id;
        return (
          <div
            key={c.id}
            className="pointer-events-auto absolute rounded-md border bg-surface shadow-pop"
            style={{ left: p.x - scroll.left, top: p.y - scroll.top, width: p.w, height: p.h, borderColor: isSel ? 'var(--brand)' : 'var(--line)', boxShadow: isSel ? '0 0 0 1px var(--brand), var(--shadow-pop)' : undefined, cursor: editable ? (g?.id === c.id && g.moved ? 'grabbing' : 'grab') : 'default', touchAction: 'none' }}
            onPointerDown={(e) => start(e, c, 'move')}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onDoubleClick={() => editable && ctrl.editChart(c.id)}
            onWheel={(e) => scrollEl()?.scrollBy(e.deltaX, e.deltaY)}
          >
            <ChartSvg spec={c} data={ctrl.chartData(c)} w={p.w - 2} h={p.h - 2} />
            {isSel && editable && (
              <>
                <div className={`absolute right-0 flex gap-0.5 rounded-md border border-line bg-surface p-0.5 shadow-pop ${p.y - scroll.top < 44 ? 'top-1' : '-top-10'}`} onPointerDown={(e) => e.stopPropagation()}>
                  <button type="button" aria-label="Ubah bagan" title="Ubah bagan" className="press inline-flex size-8 items-center justify-center rounded text-ink-2 hover:bg-surface-2" onClick={() => ctrl.editChart(c.id)}>
                    <Icon.Pencil size={15} />
                  </button>
                  <button type="button" aria-label="Gandakan bagan" title="Gandakan bagan" className="press inline-flex size-8 items-center justify-center rounded text-ink-2 hover:bg-surface-2" onClick={() => ctrl.duplicateChart(c.id)}>
                    <Icon.Copy size={15} />
                  </button>
                  <button type="button" aria-label="Hapus bagan" title="Hapus bagan" className="press inline-flex size-8 items-center justify-center rounded text-danger hover:bg-danger-soft" onClick={() => ctrl.deleteChart(c.id)}>
                    <Icon.Trash size={15} />
                  </button>
                </div>
                <div
                  aria-hidden="true"
                  className="absolute -right-1.5 -bottom-1.5 size-3 rounded-sm border border-surface bg-brand"
                  style={{ cursor: 'nwse-resize' }}
                  onPointerDown={(e) => start(e, c, 'resize')}
                  onPointerMove={move}
                  onPointerUp={end}
                  onPointerCancel={end}
                />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
