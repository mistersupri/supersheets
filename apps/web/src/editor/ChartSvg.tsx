import type { ChartSpec } from '@opensheet/engine';
import { useId, useMemo, useState } from 'react';
import { chartColor, compact, niceTicks, type ChartData } from './charts';

const FONT = 11;
const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

interface Hover {
  index: number;
  x: number;
  y: number;
}

/**
 * A chart drawn as SVG from already-read data. No chart library: six kinds share one layout
 * (title, legend, axes), and the colours come from the --chart-N tokens so both themes work.
 */
export function ChartSvg({ spec, data, w, h }: { spec: ChartSpec; data: ChartData; w: number; h: number }) {
  const uid = useId();
  const [hover, setHover] = useState<Hover | null>(null);
  const L = useMemo(() => layout(spec, data, w, h), [spec, data, w, h]);
  const summary = `${spec.title || 'Bagan'}. ${data.series.map((s) => s.name).join(', ')}.`;

  if (!data.valid) {
    return (
      <div className="flex size-full items-center justify-center p-4 text-center text-[13px] text-ink-2" role="img" aria-label="Bagan tanpa data">
        Rentang {spec.range} belum berisi data angka untuk digambar.
      </div>
    );
  }
  const pieTotal = spec.type === 'pie' ? data.series[0].values.reduce<number>((a, v) => a + Math.max(0, v ?? 0), 0) : 0;

  return (
    <div className="relative size-full select-none">
      <svg width={w} height={h} role="img" aria-label={summary} fontFamily="var(--font-sans)" fontSize={FONT}>
        <title>{summary}</title>
        {spec.title && (
          <text x={w / 2} y={20} textAnchor="middle" fontSize={13} fontWeight={600} fill="var(--ink)">
            {trunc(spec.title, Math.floor(w / 7))}
          </text>
        )}
        {L.legend.map((it) => (
          <g key={it.label + it.i} transform={`translate(${it.x},${it.y})`}>
            <rect width={10} height={10} y={-9} rx={2} fill={chartColor(it.i)} />
            <text x={15} fill="var(--ink-2)">
              {trunc(it.label, it.max)}
            </text>
          </g>
        ))}

        {spec.type === 'pie' ? (
          <Pie spec={spec} data={data} L={L} total={pieTotal} hover={hover} setHover={setHover} />
        ) : (
          <>
            {L.valTicks.map((t) => (
              <g key={t.value}>
                {L.horizontal ? <line x1={t.pos} x2={t.pos} y1={L.py} y2={L.py + L.ph} stroke="var(--grid-line)" /> : <line x1={L.px} x2={L.px + L.pw} y1={t.pos} y2={t.pos} stroke="var(--grid-line)" />}
                {L.horizontal ? (
                  <text x={t.pos} y={L.py + L.ph + 16} textAnchor="middle" fill="var(--ink-2)">
                    {t.label}
                  </text>
                ) : (
                  <text x={L.px - 6} y={t.pos + 4} textAnchor="end" fill="var(--ink-2)">
                    {t.label}
                  </text>
                )}
              </g>
            ))}
            <line x1={L.px} x2={L.px} y1={L.py} y2={L.py + L.ph} stroke="var(--line-2)" />
            <line x1={L.px} x2={L.px + L.pw} y1={L.horizontal ? L.py + L.ph : L.base} y2={L.horizontal ? L.py + L.ph : L.base} stroke="var(--line-2)" />
            {L.horizontal && <line x1={L.base} x2={L.base} y1={L.py} y2={L.py + L.ph} stroke="var(--line-2)" />}
            {L.catLabels.map((t) =>
              L.horizontal ? (
                <text key={t.i} x={L.px - 6} y={t.pos + 4} textAnchor="end" fill="var(--ink-2)">
                  {t.label}
                </text>
              ) : (
                <text key={t.i} x={t.pos} y={L.py + L.ph + 16} textAnchor="middle" fill="var(--ink-2)">
                  {t.label}
                </text>
              ),
            )}
            <clipPath id={`${uid}-plot`}>
              <rect x={L.px} y={L.py} width={L.pw} height={L.ph} />
            </clipPath>
            <g clipPath={`url(#${uid}-plot)`}>{L.marks.map((m, i) => <g key={i}>{m(hover?.index ?? null)}</g>)}</g>
            {hover && L.guide && <line {...L.guide(hover.index)} stroke="var(--ink-2)" strokeDasharray="3 3" opacity={0.6} />}
            <rect
              x={L.px}
              y={L.py}
              width={L.pw}
              height={L.ph}
              fill="transparent"
              onPointerMove={(e) => {
                const box = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
                const x = e.clientX - box.left;
                const y = e.clientY - box.top;
                setHover({ index: L.indexAt(x, y), x, y });
              }}
              onPointerLeave={() => setHover(null)}
            />
          </>
        )}
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute z-10 min-w-24 rounded-md border border-line bg-surface px-2 py-1.5 text-xs shadow-pop"
          style={{ left: Math.min(hover.x + 12, w - 130), top: Math.max(4, Math.min(hover.y + 12, h - 24 - 16 * (spec.type === 'pie' ? 1 : data.series.length))) }}
        >
          {spec.type === 'pie' ? (
            <>
              <p className="font-medium text-ink">{data.categories[hover.index] || `Data ${hover.index + 1}`}</p>
              <p className="tnum text-ink-2">
                {compact(data.series[0].values[hover.index] ?? 0)} ({pieTotal ? Math.round((Math.max(0, data.series[0].values[hover.index] ?? 0) / pieTotal) * 100) : 0}%)
              </p>
            </>
          ) : (
            <>
              <p className="font-medium text-ink">{spec.type === 'scatter' ? `x: ${data.xs[hover.index] ?? data.categories[hover.index]}` : data.categories[hover.index]}</p>
              {data.series.map((s, i) => (
                <p key={s.name + i} className="flex items-center gap-1.5 text-ink-2">
                  <span className="size-2 rounded-sm" style={{ background: chartColor(i) }} />
                  <span>{trunc(s.name, 16)}</span>
                  <span className="tnum ml-auto pl-2 text-ink">{s.values[hover.index] === null || s.values[hover.index] === undefined ? '-' : compact(s.values[hover.index]!)}</span>
                </p>
              ))}
            </>
          )}
        </div>
      )}
      {data.truncated && <p className="absolute right-2 bottom-1 text-[10px] text-ink-2">Menampilkan 500 data pertama</p>}
    </div>
  );
}

// ---------- layout ----------

interface Layout {
  px: number;
  py: number;
  pw: number;
  ph: number;
  /** Pixel position of the value axis' zero (or minimum) line. */
  base: number;
  cx: number;
  cy: number;
  r: number;
  /** Value axis ticks: `pos` is a y pixel (vertical charts) or an x pixel (horizontal bars). */
  valTicks: { value: number; pos: number; label: string }[];
  /** Category labels along the other axis; `pos` is an x pixel, or a y pixel for horizontal bars. */
  catLabels: { i: number; pos: number; label: string }[];
  horizontal: boolean;
  legend: { i: number; x: number; y: number; label: string; max: number }[];
  marks: ((hover: number | null) => React.ReactNode)[];
  guide: ((i: number) => { x1: number; x2: number; y1: number; y2: number }) | null;
  indexAt: (x: number, y: number) => number;
}

function layout(spec: ChartSpec, data: ChartData, w: number, h: number): Layout {
  const pie = spec.type === 'pie';
  const horizontal = spec.type === 'bar';
  const n = data.categories.length;
  const legendItems = pie ? data.categories.map((c, i) => ({ i, label: c || `Data ${i + 1}` })) : data.series.length > 1 || spec.legend !== 'none' ? data.series.map((s, i) => ({ i, label: s.name })) : [];
  const showLegend = spec.legend !== 'none' && legendItems.length > 0 && (pie || data.series.length > 1);
  const top = spec.title ? 32 : 10;
  const legendH = showLegend && (spec.legend === 'bottom' || spec.legend === 'top') ? 22 : 0;
  const legendW = showLegend && spec.legend === 'right' ? Math.min(150, Math.max(70, 12 * Math.max(...legendItems.map((l) => Math.min(l.label.length, 16))) * 0.6 + 30)) : 0;
  const legend: Layout['legend'] = [];
  if (showLegend) {
    if (legendW) {
      legendItems.slice(0, Math.floor((h - top - 10) / 18)).forEach((it, k) => legend.push({ ...it, x: w - legendW + 4, y: top + 14 + k * 18, max: Math.floor((legendW - 20) / 6) }));
    } else {
      let x = 12;
      const y = spec.legend === 'top' ? top + 12 : h - 8;
      for (const it of legendItems) {
        const label = trunc(it.label, 18);
        const width = 22 + label.length * 6.2;
        if (x + width > w - 8) break;
        legend.push({ ...it, x, y, label: it.label, max: 18 });
        x += width + 6;
      }
    }
  }
  const areaTop = top + (spec.legend === 'top' ? legendH : 0);
  const areaBottom = h - (spec.legend === 'bottom' ? legendH : 0) - 6;
  const areaRight = w - legendW - 8;

  if (pie) {
    const size = Math.max(40, Math.min(areaRight - 8, areaBottom - areaTop - 4));
    return { px: 0, py: 0, pw: 0, ph: 0, base: 0, cx: (areaRight + 8) / 2, cy: (areaTop + areaBottom) / 2, r: size / 2, valTicks: [], catLabels: [], horizontal: false, legend, marks: [], guide: null, indexAt: () => 0 };
  }

  // Value domain.
  let lo = Infinity;
  let hi = -Infinity;
  const stacked = spec.stacked && (spec.type === 'column' || spec.type === 'bar' || spec.type === 'area');
  if (stacked) {
    for (let p = 0; p < n; p++) {
      let pos = 0;
      let neg = 0;
      for (const s of data.series) {
        const v = s.values[p] ?? 0;
        if (v >= 0) pos += v;
        else neg += v;
      }
      hi = Math.max(hi, pos);
      lo = Math.min(lo, neg);
    }
  } else {
    for (const s of data.series) for (const v of s.values) if (v !== null) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
  }
  if (spec.type !== 'line' && spec.type !== 'scatter') (lo = Math.min(lo, 0)), (hi = Math.max(hi, 0));
  if (!Number.isFinite(lo)) (lo = 0), (hi = 1);
  const ticks = niceTicks(lo, hi, horizontal ? Math.max(3, Math.floor((areaRight - 60) / 70)) : Math.max(3, Math.floor((areaBottom - areaTop - 30) / 40)));
  const labelW = Math.max(...ticks.ticks.map((t) => compact(t).length)) * 6.4 + 12;
  const catLabelW = horizontal ? Math.min(110, Math.max(30, Math.max(0, ...data.categories.map((c) => Math.min(c.length, 16))) * 6.2 + 10)) : 0;
  const px = 8 + (horizontal ? catLabelW : labelW);
  const py = areaTop + 6;
  const pw = Math.max(20, areaRight - px - (horizontal ? 14 : 0));
  const ph = Math.max(20, areaBottom - py - (horizontal ? 22 : 24));

  const val = (v: number) => (horizontal ? px + ((v - ticks.min) / (ticks.max - ticks.min)) * pw : py + ph - ((v - ticks.min) / (ticks.max - ticks.min)) * ph);
  const zero = val(Math.max(ticks.min, Math.min(0, ticks.max)));
  const valTicks = ticks.ticks.map((t) => ({ value: t, pos: val(t), label: compact(t) }));
  const band = (horizontal ? ph : pw) / Math.max(1, n);
  const catPos = (i: number) => (horizontal ? py + band * (i + 0.5) : px + band * (i + 0.5));

  // Scatter uses a numeric x axis.
  let xs: { min: number; max: number; ticks: number[] } | null = null;
  if (spec.type === 'scatter') {
    const nums = data.xs.filter((x): x is number => x !== null);
    xs = niceTicks(nums.length ? Math.min(...nums) : 0, nums.length ? Math.max(...nums) : 1, 5);
  }
  const sx = (v: number) => (xs ? px + ((v - xs.min) / (xs.max - xs.min)) * pw : 0);

  // Category labels, thinned so they do not overlap.
  const catLabels: Layout['catLabels'] = [];
  if (spec.type === 'scatter' && xs) {
    for (const t of xs.ticks) catLabels.push({ i: t, pos: sx(t), label: compact(t) });
  } else if (horizontal) {
    const every = Math.max(1, Math.ceil(16 / band));
    for (let i = 0; i < n; i += every) catLabels.push({ i, pos: catPos(i), label: trunc(data.categories[i], 16) });
  } else {
    const maxLen = Math.max(1, ...data.categories.map((c) => Math.min(c.length, 12)));
    const every = Math.max(1, Math.ceil((maxLen * 6.4 + 8) / band));
    for (let i = 0; i < n; i += every) catLabels.push({ i, pos: catPos(i), label: trunc(data.categories[i], 12) });
  }

  // Stacked series sit on top of each other: work the offsets out once, so drawing stays pure.
  const S = data.series.length;
  const from: number[][] = data.series.map(() => new Array(n).fill(0));
  const to: number[][] = data.series.map((s) => s.values.map((v) => v ?? 0));
  if (stacked) {
    for (let i = 0; i < n; i++) {
      let pos = 0;
      let neg = 0;
      data.series.forEach((s, si) => {
        const v = s.values[i] ?? 0;
        if (v >= 0) (from[si][i] = pos), (to[si][i] = pos + v), (pos += v);
        else (from[si][i] = neg), (to[si][i] = neg + v), (neg += v);
      });
    }
  }

  const marks: Layout['marks'] = [];
  if (spec.type === 'column' || spec.type === 'bar') {
    const inner = band * 0.72;
    const barW = stacked ? inner : inner / S;
    data.series.forEach((s, si) => {
      marks.push((hover) => (
        <>
          {s.values.map((v, i) => {
            if (v === null) return null;
            const c = catPos(i);
            const off = stacked ? -inner / 2 : -inner / 2 + si * barW;
            const v1 = val(from[si][i]);
            const v2 = val(to[si][i]);
            const thick = Math.max(1, barW - (stacked ? 0 : 1));
            const rect = horizontal ? { x: Math.min(v1, v2), y: c + off, width: Math.abs(v2 - v1), height: thick } : { x: c + off, y: Math.min(v1, v2), width: thick, height: Math.abs(v2 - v1) };
            return <rect key={i} {...rect} rx={1.5} fill={chartColor(si)} opacity={hover === null || hover === i ? 1 : 0.55} />;
          })}
        </>
      ));
    });
  } else {
    const at = (i: number) => (spec.type === 'scatter' ? sx(data.xs[i] ?? i + 1) : catPos(i));
    const areaStack = stacked && spec.type === 'area';
    data.series.forEach((s, si) => {
      marks.push((hover) => {
        const pts: { i: number; x: number; y: number; y0: number }[] = [];
        s.values.forEach((v, i) => {
          if (v === null) return;
          pts.push({ i, x: at(i), y: val(areaStack ? to[si][i] : v), y0: val(areaStack ? from[si][i] : Math.max(ticks.min, Math.min(0, ticks.max))) });
        });
        const color = chartColor(si);
        if (spec.type === 'scatter') return <>{pts.map((p) => <circle key={p.i} cx={p.x} cy={p.y} r={hover === p.i ? 5 : 3.5} fill={color} opacity={0.85} />)}</>;
        const line = pts.map((p, k) => `${k ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
        const last = pts[pts.length - 1];
        const area = pts.length ? `${line} L${last.x.toFixed(1)},${last.y0.toFixed(1)} L${pts[0].x.toFixed(1)},${pts[0].y0.toFixed(1)} Z` : '';
        const dots = pts.filter((p) => (pts.length <= 40 ? true : p.i === hover));
        return (
          <>
            {spec.type === 'area' && <path d={area} fill={color} opacity={0.18} />}
            <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
            {dots.map((p) => (
              <circle key={p.i} cx={p.x} cy={p.y} r={hover === p.i ? 4.5 : 3} fill="var(--surface)" stroke={color} strokeWidth={2} />
            ))}
          </>
        );
      });
    });
  }

  const indexAt = (x: number, y: number) => {
    if (spec.type === 'scatter' && xs) {
      let best = 0;
      let bd = Infinity;
      data.xs.forEach((v, i) => {
        const d = Math.abs(sx(v ?? i + 1) - x);
        if (d < bd) (bd = d), (best = i);
      });
      return best;
    }
    const t = horizontal ? (y - py) / band : (x - px) / band;
    return Math.max(0, Math.min(n - 1, Math.floor(t)));
  };
  const guide = spec.type === 'line' || spec.type === 'area' || spec.type === 'scatter' ? (i: number) => ({ x1: spec.type === 'scatter' ? sx(data.xs[i] ?? i + 1) : catPos(i), x2: spec.type === 'scatter' ? sx(data.xs[i] ?? i + 1) : catPos(i), y1: py, y2: py + ph }) : null;
  return { px, py, pw, ph, base: horizontal ? zero : zero, cx: 0, cy: 0, r: 0, valTicks, catLabels, horizontal, legend, marks, guide, indexAt };
}

// ---------- pie ----------

function Pie({ spec, data, L, total, hover, setHover }: { spec: ChartSpec; data: ChartData; L: Layout; total: number; hover: Hover | null; setHover: (h: Hover | null) => void }) {
  const vals = data.series[0].values.map((v) => Math.max(0, v ?? 0));
  if (!total) return null;
  let angle = -Math.PI / 2;
  return (
    <g>
      {vals.map((v, i) => {
        const a0 = angle;
        const a1 = angle + (v / total) * Math.PI * 2;
        angle = a1;
        if (v === 0) return null;
        const big = a1 - a0 > Math.PI ? 1 : 0;
        const hovered = hover?.index === i;
        const r = L.r + (hovered ? 4 : 0);
        const pt = (a: number, rr = r) => `${(L.cx + rr * Math.cos(a)).toFixed(1)},${(L.cy + rr * Math.sin(a)).toFixed(1)}`;
        const full = v === total;
        const d = full ? `M${L.cx - r},${L.cy} a${r},${r} 0 1,0 ${2 * r},0 a${r},${r} 0 1,0 ${-2 * r},0` : `M${L.cx},${L.cy} L${pt(a0)} A${r},${r} 0 ${big} 1 ${pt(a1)} Z`;
        const mid = (a0 + a1) / 2;
        const share = Math.round((v / total) * 100);
        return (
          <g key={i} onPointerMove={(e) => { const box = e.currentTarget.ownerSVGElement!.getBoundingClientRect(); setHover({ index: i, x: e.clientX - box.left, y: e.clientY - box.top }); }} onPointerLeave={() => setHover(null)}>
            <path d={d} fill={chartColor(i)} stroke="var(--surface)" strokeWidth={1.5} />
            {share >= 6 && (
              <text x={L.cx + L.r * 0.62 * Math.cos(mid)} y={L.cy + L.r * 0.62 * Math.sin(mid) + 4} textAnchor="middle" fontSize={11} fontWeight={600} fill="#fff" pointerEvents="none">
                {share}%
              </text>
            )}
          </g>
        );
      })}
      <title>{spec.title}</title>
    </g>
  );
}
