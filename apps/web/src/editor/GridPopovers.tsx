import { Popover } from '@base-ui/react/popover';
import type { ConditionOp, FilterCriterion } from '@opensheet/engine';
import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { Icon } from '../components/icons';
import { Button, Checkbox, Input, Select } from '../components/ui';
import { useCtrl, useEditor } from './context';

type AnchorFn = () => DOMRect;

function Shell({ anchor, onClose, children, label, width = 260 }: { anchor: AnchorFn; onClose: () => void; children: React.ReactNode; label: string; width?: number }) {
  const virtual = useMemo(() => ({ getBoundingClientRect: anchor }), [anchor]);
  return (
    <Popover.Root open onOpenChange={(o) => !o && onClose()}>
      <Popover.Portal>
        <Popover.Positioner anchor={virtual} side="bottom" align="start" sideOffset={2} className="z-50 outline-none" collisionPadding={8}>
          <Popover.Popup aria-label={label} className="pop rounded-md border border-line bg-surface text-sm text-ink shadow-pop outline-none" style={{ width }}>
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Dropdown for cells with a list validation rule. */
export function ListPopover({ anchor, cell, onClose }: { anchor: AnchorFn; cell: { row: number; col: number }; onClose: () => void }) {
  const ctrl = useCtrl();
  const sid = useEditor((s) => s.activeSheetId);
  const rule = ctrl.validationAt(sid, cell.row, cell.col);
  const current = ctrl.model.raw(sid, cell.row, cell.col);
  if (!rule || rule.kind !== 'list') return null;
  return (
    <Shell anchor={anchor} onClose={onClose} label="Pilih nilai" width={220}>
      <ul role="listbox" className="scroll-thin max-h-64 overflow-y-auto py-1">
        {rule.items.map((item) => (
          <li key={item}>
            <button
              type="button"
              role="option"
              aria-selected={item === current}
              className={clsx('flex min-h-8 w-full items-center gap-2 px-3 text-left hover:bg-brand-soft focus-visible:bg-brand-soft max-md:min-h-11', item === current && 'font-medium')}
              onClick={() => {
                ctrl.setCellValue(cell.row, cell.col, item);
                onClose();
              }}
            >
              <span className="w-4">{item === current && <Icon.Check size={14} />}</span>
              {item}
            </button>
          </li>
        ))}
        {current && (
          <li className="border-t border-line">
            <button
              type="button"
              className="flex min-h-8 w-full items-center px-3 pl-9 text-left text-ink-2 hover:bg-brand-soft max-md:min-h-11"
              onClick={() => {
                ctrl.setCellValue(cell.row, cell.col, '');
                onClose();
              }}
            >
              Kosongkan
            </button>
          </li>
        )}
      </ul>
    </Shell>
  );
}

const CONDITIONS: { op: ConditionOp; label: string; arity: 0 | 1 | 2 }[] = [
  { op: 'notEmpty', label: 'Tidak kosong', arity: 0 },
  { op: 'empty', label: 'Kosong', arity: 0 },
  { op: 'contains', label: 'Teks berisi', arity: 1 },
  { op: 'notContains', label: 'Teks tidak berisi', arity: 1 },
  { op: 'startsWith', label: 'Teks diawali', arity: 1 },
  { op: 'endsWith', label: 'Teks diakhiri', arity: 1 },
  { op: 'eq', label: 'Sama dengan', arity: 1 },
  { op: 'neq', label: 'Tidak sama dengan', arity: 1 },
  { op: 'gt', label: 'Lebih besar dari', arity: 1 },
  { op: 'gte', label: 'Lebih besar atau sama dengan', arity: 1 },
  { op: 'lt', label: 'Lebih kecil dari', arity: 1 },
  { op: 'lte', label: 'Lebih kecil atau sama dengan', arity: 1 },
  { op: 'between', label: 'Di antara', arity: 2 },
];

/** Sort and filter options for one column of the filter range. */
export function FilterPopover({ anchor, col, onClose }: { anchor: AnchorFn; col: number; onClose: () => void }) {
  const ctrl = useCtrl();
  useEditor((s) => s.version);
  const f = ctrl.activeFilter();
  const existing = f?.criteria?.[col];
  const [tab, setTab] = useState<'values' | 'condition' | 'color'>(existing?.kind ?? 'values');
  const values = useMemo(() => ctrl.columnValues(col), [ctrl, col]);
  const colors = useMemo(() => ctrl.columnColors(col), [ctrl, col]);
  const [hidden, setHidden] = useState<Set<string>>(new Set(existing?.kind === 'values' ? existing.hidden : []));
  const [search, setSearch] = useState('');
  const [op, setOp] = useState<ConditionOp>(existing?.kind === 'condition' ? existing.op : 'notEmpty');
  const [v1, setV1] = useState(existing?.kind === 'condition' ? existing.value ?? '' : '');
  const [v2, setV2] = useState(existing?.kind === 'condition' ? existing.value2 ?? '' : '');
  const [color, setColor] = useState(existing?.kind === 'color' ? existing.color : colors[0] ?? '');
  if (!f) return null;
  const shown = values.filter((v) => v.text.toLowerCase().includes(search.toLowerCase()));
  const arity = CONDITIONS.find((c) => c.op === op)?.arity ?? 0;

  const apply = () => {
    let crit: FilterCriterion | null = null;
    if (tab === 'values') crit = hidden.size ? { kind: 'values', hidden: [...hidden] } : null;
    else if (tab === 'condition') crit = { kind: 'condition', op, value: v1, value2: v2 };
    else if (color) crit = { kind: 'color', color };
    ctrl.setFilterCriterion(col, crit);
    onClose();
  };

  return (
    <Shell anchor={anchor} onClose={onClose} label="Filter kolom" width={290}>
      <div className="flex flex-col gap-1 border-b border-line p-2">
        <button type="button" className="flex min-h-8 items-center gap-2 rounded px-2 text-left hover:bg-surface-2 max-md:min-h-11" onClick={() => (ctrl.sortRange(f, col, true, true), onClose())}>
          <Icon.SortAsc /> Urutkan A ke Z
        </button>
        <button type="button" className="flex min-h-8 items-center gap-2 rounded px-2 text-left hover:bg-surface-2 max-md:min-h-11" onClick={() => (ctrl.sortRange(f, col, false, true), onClose())}>
          <Icon.SortDesc /> Urutkan Z ke A
        </button>
      </div>
      <div role="tablist" aria-label="Jenis filter" className="flex gap-1 border-b border-line px-2 pt-2">
        {(
          [
            ['values', 'Nilai'],
            ['condition', 'Kondisi'],
            ['color', 'Warna'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={tab === id}
            className={clsx('min-h-8 rounded-t px-3 text-[13px] max-md:min-h-11', tab === id ? 'border-b-2 border-brand font-medium text-ink' : 'text-ink-2 hover:text-ink')}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="p-3">
        {tab === 'values' && (
          <>
            <Input aria-label="Cari nilai" placeholder="Cari nilai" value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="mt-2 flex gap-3 text-xs">
              <button type="button" className="text-brand underline underline-offset-2" onClick={() => setHidden(new Set())}>
                Pilih semua
              </button>
              <button type="button" className="text-brand underline underline-offset-2" onClick={() => setHidden(new Set(values.map((v) => v.text)))}>
                Kosongkan
              </button>
            </div>
            <div className="scroll-thin mt-2 max-h-52 overflow-y-auto">
              {shown.length === 0 && <p className="py-2 text-xs text-ink-2">Tidak ada nilai.</p>}
              {shown.map((v) => (
                <div key={v.text} className="flex items-center justify-between gap-2">
                  <Checkbox
                    label={v.text === '' ? <em className="text-ink-2">(Kosong)</em> : v.text}
                    checked={!hidden.has(v.text)}
                    onChange={(on) => {
                      const n = new Set(hidden);
                      if (on) n.delete(v.text);
                      else n.add(v.text);
                      setHidden(n);
                    }}
                  />
                  <span className="tnum text-xs text-ink-2">{v.count}</span>
                </div>
              ))}
            </div>
          </>
        )}
        {tab === 'condition' && (
          <div className="flex flex-col gap-2">
            <Select aria-label="Kondisi" value={op} onChange={(e) => setOp(e.target.value as ConditionOp)}>
              {CONDITIONS.map((c) => (
                <option key={c.op} value={c.op}>
                  {c.label}
                </option>
              ))}
            </Select>
            {arity >= 1 && <Input aria-label="Nilai" placeholder="Nilai" value={v1} onChange={(e) => setV1(e.target.value)} />}
            {arity === 2 && <Input aria-label="Nilai kedua" placeholder="dan" value={v2} onChange={(e) => setV2(e.target.value)} />}
          </div>
        )}
        {tab === 'color' &&
          (colors.length === 0 ? (
            <p className="text-xs text-ink-2">Tidak ada sel berwarna di kolom ini.</p>
          ) : (
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Warna isian">
              {colors.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={color === c}
                  aria-label={c}
                  className={clsx('size-8 rounded border-2', color === c ? 'border-brand' : 'border-line')}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
          ))}
      </div>
      <div className="flex justify-between gap-2 border-t border-line p-2">
        <Button size="sm" variant="ghost" onClick={() => (ctrl.setFilterCriterion(col, null), onClose())} disabled={!existing}>
          Hapus filter kolom
        </Button>
        <Button size="sm" variant="primary" onClick={apply}>
          Terapkan
        </Button>
      </div>
    </Shell>
  );
}
