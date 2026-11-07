import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { badRequest, h, HttpError, parse } from '../lib/http';
import { getSettings, updateSettings } from '../lib/settings';
import { hashPassword, publicUser, requireSuperAdmin } from '../services/auth';

export const adminRouter = Router();
adminRouter.use(requireSuperAdmin);

adminRouter.get(
  '/users',
  h(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
    const users = await prisma.user.findMany({
      where: q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }] } : {},
      orderBy: { createdAt: 'asc' },
      take: 500,
      include: { _count: { select: { workbooks: true } } },
    });
    res.json({
      users: users.map((u) => ({ ...publicUser(u), isActive: u.isActive, createdAt: u.createdAt, lockedUntil: u.lockedUntil, workbookCount: u._count.workbooks })),
    });
  }),
);

adminRouter.post(
  '/users',
  h(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(120),
        email: z.string().trim().toLowerCase().email(),
        password: z.string().min(8).max(200),
        role: z.enum(['user', 'super_admin']).default('user'),
      }),
      req.body,
    );
    if (await prisma.user.findUnique({ where: { email: body.email } })) throw new HttpError(409, 'Email sudah terdaftar');
    const u = await prisma.user.create({ data: { name: body.name, email: body.email, role: body.role, passwordHash: await hashPassword(body.password) } });
    await audit(req, 'admin.user_create', { type: 'user', id: u.id }, { role: body.role });
    res.status(201).json({ user: publicUser(u) });
  }),
);

adminRouter.patch(
  '/users/:id',
  h(async (req, res) => {
    const id = req.params.id as string;
    const body = parse(z.object({ role: z.enum(['user', 'super_admin']).optional(), isActive: z.boolean().optional(), unlock: z.boolean().optional() }), req.body);
    if (id === req.user!.id && (body.role === 'user' || body.isActive === false)) throw badRequest('Anda tidak dapat menurunkan atau menonaktifkan akun sendiri');
    const u = await prisma.user.update({
      where: { id },
      data: { role: body.role, isActive: body.isActive, ...(body.unlock ? { lockedUntil: null, failedLoginCount: 0 } : {}) },
    });
    if (body.isActive === false) await prisma.session.deleteMany({ where: { userId: id } });
    await audit(req, 'admin.user_update', { type: 'user', id }, body);
    res.json({ user: { ...publicUser(u), isActive: u.isActive } });
  }),
);

adminRouter.get(
  '/settings',
  h(async (_req, res) => {
    res.json({ settings: await getSettings() });
  }),
);

adminRouter.patch(
  '/settings',
  h(async (req, res) => {
    const body = parse(z.object({ registrationEnabled: z.boolean().optional(), linkSharingEnabled: z.boolean().optional() }), req.body);
    const settings = await updateSettings(body);
    await audit(req, 'admin.settings', undefined, body);
    res.json({ settings });
  }),
);

adminRouter.get(
  '/audit-logs',
  h(async (req, res) => {
    const q = parse(z.object({ before: z.string().datetime().optional(), action: z.string().max(60).optional() }), req.query);
    const logs = await prisma.auditLog.findMany({
      where: { ...(q.before ? { createdAt: { lt: new Date(q.before) } } : {}), ...(q.action ? { action: { startsWith: q.action } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    res.json({ logs });
  }),
);
