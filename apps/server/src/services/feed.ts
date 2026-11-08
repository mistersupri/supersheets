import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../db';
import { notFound } from '../lib/http';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export const TOKEN_PREFIX = 'osf_';

export async function listFeedTokens(workbookId: string) {
  const rows = await prisma.feedToken.findMany({ where: { workbookId }, orderBy: { createdAt: 'asc' } });
  return rows.map((t) => ({ id: t.id, label: t.label, prefix: t.prefix, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt }));
}

/** The token is returned once; only its hash is stored. */
export async function createFeedToken(workbookId: string, userId: string, label: string) {
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const row = await prisma.feedToken.create({ data: { workbookId, label, tokenHash: hash(token), prefix: token.slice(0, 10), createdById: userId } });
  return { token, item: { id: row.id, label: row.label, prefix: row.prefix, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt } };
}

export async function revokeFeedToken(workbookId: string, id: string) {
  const r = await prisma.feedToken.deleteMany({ where: { id, workbookId } });
  if (!r.count) throw notFound('Kunci tidak ditemukan');
}

const touched = new Map<string, number>();

/** True when `token` belongs to this workbook. Last-use is written at most once a minute per key. */
export async function checkFeedToken(workbookId: string, token: string | undefined): Promise<boolean> {
  if (!token || !token.startsWith(TOKEN_PREFIX) || token.length > 100) return false;
  const row = await prisma.feedToken.findUnique({ where: { tokenHash: hash(token) }, select: { id: true, workbookId: true } });
  if (!row || row.workbookId !== workbookId) return false;
  const now = Date.now();
  if (now - (touched.get(row.id) ?? 0) > 60_000) {
    touched.set(row.id, now);
    void prisma.feedToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  }
  return true;
}

export const feedKeyOf = (token: string) => hash(token).slice(0, 16);
