import Papa from 'papaparse';
import { parseRangeA1 } from '@opensheet/engine';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { forbidden, h, notFound, parse } from '../lib/http';
import { ipKey, limiter } from '../lib/limits';
import { requireCapability } from '../services/access';
import { checkFeedToken, createFeedToken, feedKeyOf, listFeedTokens, revokeFeedToken } from '../services/feed';
import { valueGrid } from '../services/importexport';

/** Owner and managers create and revoke keys. */
export const feedManageRouter = Router();

feedManageRouter.get(
  '/:id/feed-tokens',
  h(async (req, res) => {
    await requireCapability(req.user!.id, req.params.id as string, 'manage');
    res.json({ items: await listFeedTokens(req.params.id as string) });
  }),
);

feedManageRouter.post(
  '/:id/feed-tokens',
  h(async (req, res) => {
    const id = req.params.id as string;
    await requireCapability(req.user!.id, id, 'manage');
    const body = parse(z.object({ label: z.string().trim().min(1).max(80) }), req.body);
    if ((await listFeedTokens(id)).length >= 20) throw forbidden('Maksimal 20 kunci per workbook. Hapus yang tidak dipakai.');
    const out = await createFeedToken(id, req.user!.id, body.label);
    await audit(req, 'feed.create', { type: 'workbook', id }, { label: body.label });
    res.status(201).json(out);
  }),
);

feedManageRouter.delete(
  '/:id/feed-tokens/:tokenId',
  h(async (req, res) => {
    const id = req.params.id as string;
    await requireCapability(req.user!.id, id, 'manage');
    await revokeFeedToken(id, req.params.tokenId as string);
    await audit(req, 'feed.revoke', { type: 'workbook', id }, { tokenId: req.params.tokenId });
    res.json({ ok: true });
  }),
);

/**
 * Read-only data feed for Google Sheets and scripts. It is outside the session login: the key in
 * `Authorization: Bearer` (or `?token=` for IMPORTDATA, which cannot send headers) is the credential.
 */
export const feedPublicRouter = Router();

const byToken = limiter({ prefix: 'feed', windowMs: 60_000, limit: 120, message: 'Terlalu banyak permintaan untuk kunci ini. Coba lagi sebentar.', key: (req) => feedKeyOf(tokenOf(req) ?? 'none') });
const byIp = limiter({ prefix: 'feedip', windowMs: 60_000, limit: 600, message: 'Terlalu banyak permintaan.', key: ipKey });

function tokenOf(req: { get(n: string): string | undefined; query: Record<string, unknown> }): string | undefined {
  const auth = req.get('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return typeof req.query.token === 'string' ? req.query.token : undefined;
}

feedPublicRouter.get(
  '/:id',
  byIp,
  byToken,
  h(async (req, res) => {
    const id = req.params.id as string;
    if (!/^[0-9a-f-]{36}$/i.test(id) || !(await checkFeedToken(id, tokenOf(req)))) {
      // The same answer for a wrong key and a missing workbook, so ids cannot be probed.
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.status(401).json({ error: 'Kunci tidak valid' });
      return;
    }
    const q = parse(
      z.object({
        sheet: z.string().max(100).optional(),
        range: z.string().max(40).optional(),
        format: z.enum(['csv', 'json']).default('csv'),
        token: z.string().optional(),
      }),
      req.query,
    );
    const wb = await prisma.workbook.findFirst({ where: { id, isTrashed: false }, select: { title: true, revision: true, updatedAt: true } });
    if (!wb) throw notFound('Workbook tidak ditemukan');
    const range = q.range ? parseRangeA1(q.range.toUpperCase()) : null;
    if (q.range && !range) {
      res.status(400).json({ error: 'Rentang tidak valid. Contoh: A1:D20' });
      return;
    }
    // Cheap polling: nothing changed since the caller's copy.
    const etag = `W/"${wb.revision}-${q.sheet ?? ''}-${q.range ?? ''}-${q.format}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-OpenSheet-Revision', String(wb.revision));
    if (req.get('if-none-match') === etag) {
      res.status(304).end();
      return;
    }
    const grid = await valueGrid(id, q.sheet, range);
    if (!grid) throw notFound('Sheet tidak ditemukan');
    if (q.format === 'json') {
      res.json({ workbook: wb.title, sheet: grid.title, revision: Number(wb.revision), updatedAt: wb.updatedAt, range: q.range ?? null, values: grid.rows });
      return;
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send(Papa.unparse(grid.rows, { newline: '\n' }));
  }),
);
