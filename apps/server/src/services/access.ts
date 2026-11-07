import { prisma } from '../db';
import { forbidden, notFound } from '../lib/http';
import { getSettings } from '../lib/settings';
import { onInvalidate } from '../lib/bus';
import { TtlCache } from '../lib/cache';

/** Workbook roles, lowest to highest. "manager" is an editor who may also share and manage. */
export const ROLES = ['none', 'viewer', 'commenter', 'editor', 'manager', 'owner'] as const;
export type Role = (typeof ROLES)[number];

export type Capability = 'view' | 'comment' | 'edit' | 'share' | 'manage' | 'own';

const NEED: Record<Capability, Role> = {
  view: 'viewer',
  comment: 'commenter',
  edit: 'editor',
  share: 'manager',
  manage: 'manager',
  own: 'owner',
};

export function rank(r: Role): number {
  return ROLES.indexOf(r);
}

export function can(role: Role, cap: Capability): boolean {
  return rank(role) >= rank(NEED[cap]);
}

export function capabilities(role: Role) {
  return {
    view: can(role, 'view'),
    comment: can(role, 'comment'),
    edit: can(role, 'edit'),
    share: can(role, 'share'),
    manage: can(role, 'manage'),
    own: can(role, 'own'),
  };
}

const LINK_ROLE: Record<string, Role> = { restricted: 'none', view: 'viewer', comment: 'commenter', edit: 'editor' };

/**
 * Resolves a user's role on a workbook. App-level roles (super admin) are kept
 * separate: they do not grant access to workbook content.
 */
// Per-user grants change rarely and are read on every request; sharing routes invalidate on change.
const permCache = new TtlCache<string | null>(15_000);
onInvalidate('workbook', (id) => permCache.deleteWhere((k) => id === '*' || k.startsWith(`${id}|`)));

export async function roleFor(userId: string, workbookId: string): Promise<{ role: Role; workbook: NonNullable<Awaited<ReturnType<typeof prisma.workbook.findUnique>>> }> {
  const wb = await prisma.workbook.findUnique({ where: { id: workbookId } });
  if (!wb) throw notFound('Workbook tidak ditemukan');
  if (wb.ownerId === userId) return { role: 'owner', workbook: wb };
  if (wb.isTrashed) return { role: 'none', workbook: wb };
  let role: Role = 'none';
  const key = `${workbookId}|${userId}`;
  let permission = permCache.get(key);
  if (permission === undefined) {
    const perm = await prisma.workbookPermission.findUnique({ where: { workbookId_userId: { workbookId, userId } }, select: { permission: true } });
    permission = perm?.permission ?? null;
    permCache.set(key, permission);
  }
  if (permission && (ROLES as readonly string[]).includes(permission)) role = permission as Role;
  if (wb.linkAccess !== 'restricted') {
    const settings = await getSettings();
    const linkRole = settings.linkSharingEnabled ? LINK_ROLE[wb.linkAccess] ?? 'none' : 'none';
    if (rank(linkRole) > rank(role)) role = linkRole;
  }
  return { role, workbook: wb };
}

export async function requireCapability(userId: string, workbookId: string, cap: Capability) {
  const r = await roleFor(userId, workbookId);
  if (r.role === 'none') throw notFound('Workbook tidak ditemukan atau Anda tidak memiliki akses');
  if (!can(r.role, cap)) throw forbidden('Izin Anda pada workbook ini tidak mencukupi');
  return r;
}

export async function worksheetWorkbook(worksheetId: string): Promise<string> {
  const ws = await prisma.worksheet.findUnique({ where: { id: worksheetId }, select: { workbookId: true } });
  if (!ws) throw notFound('Worksheet tidak ditemukan');
  return ws.workbookId;
}
