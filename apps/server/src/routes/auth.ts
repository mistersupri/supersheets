import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { invalidate } from '../lib/bus';
import { badRequest, forbidden, h, HttpError, parse, unauthorized } from '../lib/http';
import { sendMail } from '../lib/mail';
import { getSettings } from '../lib/settings';
import { ipKey, limiter } from '../lib/limits';
import {
  checkLock,
  createSession,
  destroySession,
  hashPassword,
  needsRehash,
  publicUser,
  recordFailure,
  recordSuccess,
  requireAuth,
  sha256,
  verifyPassword,
} from '../services/auth';

export const authRouter = Router();

// Used to spend comparable time on logins for unknown emails.
const dummyHash = hashPassword(crypto.randomBytes(16).toString('hex'));

// Two layers: a generous per-IP cap (many users can share one office or school
// IP) and a tight per IP + email cap against password guessing. Accounts are
// also locked after repeated failures (services/auth.ts).
const ipLimiter = limiter({
  prefix: 'login-ip',
  windowMs: 15 * 60_000,
  limit: config.loginIpLimit,
  message: 'Terlalu banyak percobaan dari jaringan ini. Coba lagi dalam 15 menit.',
});
const accountLimiter = limiter({
  prefix: 'login-acct',
  windowMs: 15 * 60_000,
  limit: config.isProd ? config.loginAccountLimit : 1000,
  message: 'Terlalu banyak percobaan untuk akun ini. Coba lagi dalam 15 menit.',
  key: (req) => `${ipKey(req)}|${String(req.body?.email ?? '').trim().toLowerCase().slice(0, 254)}`,
});
const loginLimiter = [ipLimiter, accountLimiter];

const email = z.string().trim().toLowerCase().email('Email tidak valid').max(254);
const password = z.string().min(8, 'Kata sandi minimal 8 karakter').max(200);

authRouter.post(
  '/register',
  loginLimiter,
  h(async (req, res) => {
    const body = parse(z.object({ name: z.string().trim().min(1, 'Nama wajib diisi').max(120), email, password }), req.body);
    const settings = await getSettings();
    const count = await prisma.user.count();
    // The very first account administers the instance.
    if (count > 0 && !settings.registrationEnabled) throw forbidden('Registrasi sedang dinonaktifkan oleh admin');
    const exists = await prisma.user.findUnique({ where: { email: body.email } });
    if (exists) throw new HttpError(409, 'Email sudah terdaftar');
    const user = await prisma.user.create({
      data: { name: body.name, email: body.email, passwordHash: await hashPassword(body.password), role: count === 0 ? 'super_admin' : 'user' },
    });
    // Accept pending invitations sent to this address.
    const invites = await prisma.workbookInvitation.findMany({ where: { email: body.email, acceptedAt: null } });
    for (const inv of invites) {
      await prisma.workbookPermission.upsert({
        where: { workbookId_userId: { workbookId: inv.workbookId, userId: user.id } },
        create: { workbookId: inv.workbookId, userId: user.id, permission: inv.permission },
        update: {},
      });
      await prisma.workbookInvitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } });
      invalidate('workbook', inv.workbookId);
    }
    await createSession(res, req, user.id, false);
    await audit(req, 'auth.register', { type: 'user', id: user.id }, undefined, user.id);
    res.status(201).json({ user: publicUser(user) });
  }),
);

authRouter.post(
  '/login',
  loginLimiter,
  h(async (req, res) => {
    const body = parse(z.object({ email, password: z.string().min(1).max(200), remember: z.boolean().optional() }), req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    const fail = () => new HttpError(401, 'Email atau kata sandi salah');
    if (!user) {
      // Spend comparable time so response timing does not reveal which emails exist.
      await verifyPassword(await dummyHash, body.password);
      throw fail();
    }
    if (!user.isActive) throw forbidden('Akun dinonaktifkan. Hubungi admin.');
    if (await checkLock(user)) throw new HttpError(429, 'Akun dikunci sementara karena terlalu banyak percobaan gagal. Coba lagi nanti.');
    if (!(await verifyPassword(user.passwordHash, body.password))) {
      await recordFailure(user);
      await audit(req, 'auth.login_failed', { type: 'user', id: user.id }, undefined, user.id);
      throw fail();
    }
    await recordSuccess(user.id);
    if (needsRehash(user.passwordHash)) await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.password) } });
    await createSession(res, req, user.id, !!body.remember);
    await audit(req, 'auth.login', { type: 'user', id: user.id }, undefined, user.id);
    res.json({ user: publicUser(user) });
  }),
);

authRouter.post(
  '/logout',
  h(async (req, res) => {
    await destroySession(req, res);
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/me',
  h(async (req, res) => {
    // 200 with user: null keeps the signed-out state out of the browser's error console.
    if (!req.user) {
      res.json({ user: null });
      return;
    }
    const settings = await getSettings();
    res.json({ user: req.user, settings: { linkSharingEnabled: settings.linkSharingEnabled } });
  }),
);

authRouter.get(
  '/config',
  h(async (_req, res) => {
    const settings = await getSettings();
    const hasUsers = (await prisma.user.count()) > 0;
    res.json({ registrationEnabled: settings.registrationEnabled || !hasUsers });
  }),
);

authRouter.post(
  '/forgot-password',
  loginLimiter,
  h(async (req, res) => {
    const body = parse(z.object({ email }), req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (user && user.isActive) {
      const token = crypto.randomBytes(32).toString('base64url');
      await prisma.passwordReset.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 60 * 60_000) } });
      const link = `${config.appUrl}/reset-password?token=${token}`;
      await sendMail(user.email, 'Atur ulang kata sandi OpenSheet', `Halo ${user.name},\n\nBuka tautan berikut untuk membuat kata sandi baru (berlaku 1 jam):\n${link}\n\nAbaikan email ini jika Anda tidak memintanya.`);
      await audit(req, 'auth.reset_requested', { type: 'user', id: user.id }, undefined, user.id);
    }
    // Same answer either way, so the endpoint cannot be used to probe accounts.
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/reset-password',
  loginLimiter,
  h(async (req, res) => {
    const body = parse(z.object({ token: z.string().min(10).max(200), password }), req.body);
    const rec = await prisma.passwordReset.findUnique({ where: { tokenHash: sha256(body.token) } });
    if (!rec || rec.usedAt || rec.expiresAt < new Date()) throw badRequest('Tautan sudah tidak berlaku. Minta tautan baru.');
    await prisma.$transaction([
      prisma.user.update({ where: { id: rec.userId }, data: { passwordHash: await hashPassword(body.password), failedLoginCount: 0, lockedUntil: null } }),
      prisma.passwordReset.update({ where: { id: rec.id }, data: { usedAt: new Date() } }),
      // Sign out everywhere after a reset.
      prisma.session.deleteMany({ where: { userId: rec.userId } }),
    ]);
    invalidate('user', rec.userId);
    await audit(req, 'auth.reset_done', { type: 'user', id: rec.userId }, undefined, rec.userId);
    res.json({ ok: true });
  }),
);

authRouter.patch(
  '/me',
  requireAuth,
  h(async (req, res) => {
    const body = parse(
      z.object({ name: z.string().trim().min(1).max(120).optional(), currentPassword: z.string().optional(), newPassword: password.optional() }),
      req.body,
    );
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
    const data: { name?: string; passwordHash?: string } = {};
    if (body.name) data.name = body.name;
    if (body.newPassword) {
      if (!body.currentPassword || !(await verifyPassword(user.passwordHash, body.currentPassword))) throw badRequest('Kata sandi saat ini salah');
      data.passwordHash = await hashPassword(body.newPassword);
    }
    const updated = await prisma.user.update({ where: { id: user.id }, data });
    if (data.name) invalidate('user', user.id);
    if (body.newPassword) {
      await prisma.session.deleteMany({ where: { userId: user.id, NOT: { id: req.sessionId } } });
      invalidate('user', user.id);
      await audit(req, 'auth.password_changed', { type: 'user', id: user.id });
    }
    res.json({ user: publicUser(updated) });
  }),
);

authRouter.get(
  '/sessions',
  requireAuth,
  h(async (req, res) => {
    const sessions = await prisma.session.findMany({ where: { userId: req.user!.id, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
    res.json({
      sessions: sessions.map((s) => ({ id: s.id.slice(0, 12), current: s.id === req.sessionId, createdAt: s.createdAt, expiresAt: s.expiresAt, userAgent: s.userAgent, ip: s.ip })),
    });
  }),
);

authRouter.post(
  '/sessions/revoke-others',
  requireAuth,
  h(async (req, res) => {
    const r = await prisma.session.deleteMany({ where: { userId: req.user!.id, NOT: { id: req.sessionId } } });
    invalidate('user', req.user!.id);
    res.json({ revoked: r.count });
  }),
);
