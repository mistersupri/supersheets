import { Engine, FormulaError, parseRangeA1, Scalar, toStored, type StoredValue } from '@opensheet/engine';
import { prisma } from '../db';
import { TtlCache } from '../lib/cache';
import { badRequest, forbidden, HttpError } from '../lib/http';
import { roleFor } from './access';

/**
 * IMPORTRANGE support: reading a range of another workbook. The reader must be
 * able to view the source workbook; results are cached per source revision.
 */
export const MAX_IMPORT_RANGE_CELLS = 50_000;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const resultCache = new TtlCache<StoredValue[][]>(30_000, 2_000);

export function parseSource(source: string): string | null {
  return UUID.exec(source)?.[0].toLowerCase() ?? null;
}

function splitRange(range: string): { sheet: string | null; a1: string } {
  const m = /^(?:'((?:[^']|'')+)'|([^!]+))!(.+)$/.exec(range.trim());
  if (!m) return { sheet: null, a1: range.trim() };
  return { sheet: (m[1] ?? m[2]).replace(/''/g, "'"), a1: m[3] };
}

/** Builds an engine with every sheet of a workbook loaded and calculated. */
export async function loadEngine(workbookId: string, opts: { userId?: string; resolveImports?: boolean } = {}): Promise<Engine> {
  const sheets = await prisma.worksheet.findMany({ where: { workbookId }, select: { id: true, title: true } });
  const cells = await prisma.cell.findMany({
    where: { worksheet: { workbookId } },
    select: { worksheetId: true, rowIndex: true, columnIndex: true, rawValue: true },
  });
  const engine = new Engine();
  if (opts.resolveImports !== false && opts.userId) {
    // The engine asks synchronously, so literal IMPORTRANGE arguments are fetched first.
    const wanted = new Map<string, Scalar[][] | HttpError>();
    for (const c of cells) {
      const raw = c.rawValue ?? '';
      if (!/IMPORTRANGE/i.test(raw)) continue;
      for (const m of raw.matchAll(/IMPORTRANGE\(\s*"([^"]*)"\s*[,;]\s*"([^"]*)"\s*\)/gi)) wanted.set(`${m[1]}\u0000${m[2]}`, []);
    }
    for (const key of wanted.keys()) {
      const [src, range] = key.split('\u0000');
      try {
        wanted.set(key, (await importRange(opts.userId, src, range, workbookId)).map((r) => r.map((v) => (v && typeof v === 'object' ? null : v))) as Scalar[][]);
      } catch (e) {
        wanted.set(key, e as HttpError);
      }
    }
    engine.setImportProvider((src, range) => {
      const hit = wanted.get(`${src}\u0000${range}`);
      if (!hit) return toError('#REF!');
      if (hit instanceof Error) return toError('#REF!');
      return hit;
    });
  }
  for (const s of sheets) engine.addSheet(s.id, s.title);
  for (const c of cells) engine.load(c.worksheetId, [{ row: c.rowIndex, col: c.columnIndex, raw: c.rawValue ?? '' }]);
  engine.recalcAll();
  return engine;
}

function toError(code: '#REF!') {
  return new FormulaError(code, 'Tidak dapat mengambil data dari workbook lain');
}

/** Values of `range` in workbook `source`, as `userId` is allowed to see them. */
export async function importRange(userId: string, source: string, range: string, fromWorkbookId?: string): Promise<StoredValue[][]> {
  const sourceId = parseSource(source);
  if (!sourceId) throw badRequest('Alamat workbook sumber tidak valid');
  if (sourceId === fromWorkbookId) throw badRequest('IMPORTRANGE tidak dapat mengambil dari workbook yang sama');
  const { role, workbook } = await roleFor(userId, sourceId).catch(() => ({ role: 'none' as const, workbook: null }));
  if (role === 'none' || !workbook) throw forbidden('Anda tidak memiliki akses ke workbook sumber');
  const { sheet, a1 } = splitRange(range);
  const r = parseRangeA1(a1.toUpperCase());
  if (!r) throw badRequest('Rentang tidak valid. Contoh: "Sheet1!A1:C10"');
  if ((r.r2 - r.r1 + 1) * (r.c2 - r.c1 + 1) > MAX_IMPORT_RANGE_CELLS) throw badRequest('Rentang terlalu besar');
  const key = `${sourceId}|${Number(workbook.revision)}|${range}`;
  const cached = resultCache.get(key);
  if (cached) return cached;
  // Nested IMPORTRANGE inside the source is not followed (avoids loops).
  const engine = await loadEngine(sourceId, { resolveImports: false });
  const sheets = await prisma.worksheet.findMany({ where: { workbookId: sourceId }, orderBy: { position: 'asc' }, select: { id: true, title: true } });
  const target = sheet ? sheets.find((s) => s.title.toLowerCase() === sheet.toLowerCase()) : sheets[0];
  if (!target) throw badRequest(`Sheet "${sheet}" tidak ada di workbook sumber`);
  const out: StoredValue[][] = [];
  for (let row = r.r1; row <= r.r2; row++) {
    const line: StoredValue[] = [];
    for (let col = r.c1; col <= r.c2; col++) line.push(toStored(engine.getValue(target.id, row, col)));
    out.push(line);
  }
  // Trim trailing empty rows so open-ended ranges stay small.
  while (out.length > 1 && out[out.length - 1].every((v) => v === null)) out.pop();
  resultCache.set(key, out);
  return out;
}
