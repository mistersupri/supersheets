import { CellStyle, normalizeStyle, styleKey } from '@opensheet/engine';
import { sha256 } from './auth';
import type { Tx } from '../db';
import { prisma } from '../db';

type StyleRow = Awaited<ReturnType<typeof prisma.cellStyle.findFirst>>;

/** Rebuilds the shared CellStyle shape from a cell_styles row. */
export function styleFromRow(row: NonNullable<StyleRow>): CellStyle | null {
  const extra = (row.extra ?? {}) as Partial<CellStyle>;
  return normalizeStyle({
    fontFamily: row.fontFamily ?? undefined,
    fontSize: row.fontSize ?? undefined,
    bold: row.bold,
    italic: row.italic,
    underline: row.underline,
    textColor: row.textColor ?? undefined,
    backgroundColor: row.backgroundColor ?? undefined,
    hAlign: (row.horizontalAlign as CellStyle['hAlign']) ?? undefined,
    vAlign: (row.verticalAlign as CellStyle['vAlign']) ?? undefined,
    numberFormat: row.numberFormat ?? undefined,
    borders: (row.borderConfig as CellStyle['borders']) ?? undefined,
    wrap: row.wrapText,
    strike: extra.strike,
    rotation: extra.rotation,
    indent: extra.indent,
    link: extra.link,
  });
}

/** Styles are immutable and de-duplicated by content hash. */
export async function styleIdFor(tx: Tx, style: CellStyle | null | undefined, cache: Map<string, string | null>): Promise<string | null> {
  const s = normalizeStyle(style);
  if (!s) return null;
  if (s.link && !/^(https?:\/\/|mailto:)/i.test(s.link)) delete s.link;
  const key = styleKey(s);
  if (cache.has(key)) return cache.get(key)!;
  const hash = sha256(key);
  const extra: Record<string, unknown> = {};
  if (s.strike) extra.strike = true;
  if (s.rotation) extra.rotation = s.rotation;
  if (s.indent) extra.indent = s.indent;
  if (s.link) extra.link = s.link;
  const row = await tx.cellStyle.upsert({
    where: { hash },
    update: {},
    create: {
      hash,
      fontFamily: s.fontFamily,
      fontSize: s.fontSize,
      bold: !!s.bold,
      italic: !!s.italic,
      underline: !!s.underline,
      textColor: s.textColor,
      backgroundColor: s.backgroundColor,
      horizontalAlign: s.hAlign,
      verticalAlign: s.vAlign,
      numberFormat: s.numberFormat,
      borderConfig: (s.borders ?? undefined) as never,
      wrapText: !!s.wrap,
      extra: Object.keys(extra).length ? (extra as never) : undefined,
    },
  });
  cache.set(key, row.id);
  return row.id;
}

export async function loadStyles(ids: Iterable<string>): Promise<Map<string, CellStyle | null>> {
  const list = [...new Set(ids)];
  const rows = list.length ? await prisma.cellStyle.findMany({ where: { id: { in: list } } }) : [];
  return new Map(rows.map((r) => [r.id, styleFromRow(r)]));
}
