import { Popover } from '@base-ui/react/popover';
import clsx from 'clsx';
import { useState, type ReactElement } from 'react';
import { Button, Input } from '../components/ui';

/** Cell colours are user data, so the picker offers a broad, ordered set. */
const SWATCHES = [
  '#000000', '#434343', '#666666', '#999999', '#B7B7B7', '#CCCCCC', '#D9D9D9', '#EFEFEF', '#F3F3F3', '#FFFFFF',
  '#980000', '#FF0000', '#FF9900', '#FFFF00', '#00FF00', '#00FFFF', '#4A86E8', '#0000FF', '#9900FF', '#FF00FF',
  '#E6B8AF', '#F4CCCC', '#FCE5CD', '#FFF2CC', '#D9EAD3', '#D0E0E3', '#C9DAF8', '#CFE2F3', '#D9D2E9', '#EAD1DC',
  '#DD7E6B', '#EA9999', '#F9CB9C', '#FFE599', '#B6D7A8', '#A2C4C9', '#A4C2F4', '#9FC5E8', '#B4A7D6', '#D5A6BD',
  '#A61C00', '#CC0000', '#E69138', '#F1C232', '#6AA84F', '#45818E', '#3C78D8', '#3D85C6', '#674EA7', '#A64D79',
  '#5B0F00', '#660000', '#783F04', '#7F6000', '#274E13', '#0C343D', '#1C4587', '#073763', '#20124D', '#4C1130',
];

export function ColorPicker({ trigger, value, onChange, label, resetLabel }: { trigger: ReactElement; value?: string; onChange: (c: string | undefined) => void; label: string; resetLabel: string }) {
  const [open, setOpen] = useState(false);
  const [hex, setHex] = useState(value ?? '');
  const valid = /^#[0-9a-fA-F]{6}$/.test(hex);
  const choose = (c: string | undefined) => {
    onChange(c);
    setOpen(false);
  };
  return (
    <Popover.Root open={open} onOpenChange={(o) => (setOpen(o), setHex(value ?? ''))}>
      <Popover.Trigger render={trigger} />
      <Popover.Portal>
        <Popover.Positioner sideOffset={4} align="start" className="z-50 outline-none">
          <Popover.Popup aria-label={label} className="pop w-[248px] rounded-md border border-line bg-surface p-3 shadow-pop outline-none">
            <button type="button" className="mb-2 min-h-8 w-full rounded border border-line px-2 text-left text-[13px] hover:bg-surface-2 max-md:min-h-11" onClick={() => choose(undefined)}>
              {resetLabel}
            </button>
            <div className="grid grid-cols-10 gap-[3px]" role="listbox" aria-label={label}>
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="option"
                  aria-selected={value?.toUpperCase() === c}
                  aria-label={c}
                  title={c}
                  className={clsx('aspect-square rounded-sm border', value?.toUpperCase() === c ? 'border-brand ring-2 ring-brand' : 'border-black/10')}
                  style={{ background: c }}
                  onClick={() => choose(c)}
                />
              ))}
            </div>
            <form
              className="mt-3 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (valid) choose(hex.toUpperCase());
              }}
            >
              <Input aria-label="Kode warna" className="addr" placeholder="#1A73E8" value={hex} onChange={(e) => setHex(e.target.value.trim())} maxLength={7} />
              <Button size="sm" type="submit" disabled={!valid}>
                Pakai
              </Button>
            </form>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
