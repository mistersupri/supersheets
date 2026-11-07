import argon2 from 'argon2';
import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { prisma } from '../db';
import { forbidden, unauthorized } from '../lib/http';
import { invalidate, onInvalidate } from '../lib/bus';
import { TtlCache } from '../lib/cache';

export const SESSION_COOKIE = 'osid';
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: string;
  avatar: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      sessionId?: string;
    }
  }
}

/**
 * Argon2id with the OWASP minimum profile (19 MiB, 2 passes, 1 lane). It keeps
 * a burst of hundreds of logins affordable on a small server; older hashes
 * are upgraded on the next successful login.
 */
const ARGON = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
export const hashPassword = (pw: string) => argon2.hash(pw, ARGON);
export const needsRehash = (hash: string) => argon2.needsRehash(hash, ARGON);
export const verifyPassword = (hash: string, pw: string) => argon2.verify(hash, pw).catch(() => false);

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function publicUser(u: { id: string; name: string; email: string; role: string; avatar: string | null }): AuthUser {
  return { id: u.id, name: u.name, email: u.email, role: u.role, avatar: u.avatar };
}

export async function createSession(res: Response, req: Request, userId: string, remember: boolean) {
  const token = crypto.randomBytes(32).toString('base64url');
  const days = remember ? config.rememberDays : config.sessionDays;
  const expiresAt = new Date(Date.now() + days * 86_400_000);
  await prisma.session.create({
    data: { id: sha256(token), userId, expiresAt, rememberMe: remember, userAgent: req.get('user-agent')?.slice(0, 300), ip: req.ip },
  });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'lax',
    path: '/',
    // Without "remember me" the cookie ends with the browser session.
    ...(remember ? { expires: expiresAt } : {}),
  });
}

// Session lookups run on every request; cache them briefly. Logout, password
// changes and deactivation invalidate immediately (also across processes).
const sessionCache = new TtlCache<{ user: AuthUser; sessionId: string; expiresAt: number }>(30_000);
onInvalidate('user', (userId) => sessionCache.deleteWhere((_k, v) => userId === '*' || v.user.id === userId));

export async function destroySession(req: Request, res: Response) {
  if (req.sessionId) {
    await prisma.session.deleteMany({ where: { id: req.sessionId } });
    invalidate('user', req.user?.id ?? '*');
  }
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

export async function userFromToken(token: string | undefined): Promise<{ user: AuthUser; sessionId: string } | null> {
  if (!token) return null;
  const id = sha256(token);
  const hit = sessionCache.get(id);
  if (hit && hit.expiresAt > Date.now()) return { user: hit.user, sessionId: hit.sessionId };
  const s = await prisma.session.findUnique({ where: { id }, include: { user: true } });
  if (!s) return null;
  if (s.expiresAt < new Date() || !s.user.isActive) {
    await prisma.session.deleteMany({ where: { id } });
    return null;
  }
  const out = { user: publicUser(s.user), sessionId: id };
  sessionCache.set(id, { ...out, expiresAt: s.expiresAt.getTime() });
  return out;
}

/** Attaches req.user when a valid session cookie is present. */
export async function loadUser(req: Request, _res: Response, next: NextFunction) {
  try {
    const found = await userFromToken(req.cookies?.[SESSION_COOKIE]);
    if (found) {
      req.user = found.user;
      req.sessionId = found.sessionId;
    }
    next();
  } catch (e) {
    next(e);
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  next();
}

export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== 'super_admin') return next(forbidden('Hanya Super Admin'));
  next();
}

/** Account lockout after repeated failures, on top of the per-IP rate limit. */
export async function checkLock(user: { id: string; lockedUntil: Date | null }): Promise<boolean> {
  return !!user.lockedUntil && user.lockedUntil > new Date();
}

export async function recordFailure(user: { id: string; failedLoginCount: number }) {
  const n = user.failedLoginCount + 1;
  await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginCount: n >= MAX_FAILED ? 0 : n,
      lockedUntil: n >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : undefined,
    },
  });
}

export async function recordSuccess(userId: string) {
  await prisma.user.update({ where: { id: userId }, data: { failedLoginCount: 0, lockedUntil: null } });
}

/**
 * CSRF defence for a JSON API: state-changing requests must carry a custom
 * header (which a cross-site form cannot set) and, when the browser sends an
 * Origin, it must match the app.
 */
export function csrfGuard(req: Request, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-opensheet-csrf') !== '1') {
    res.status(403).json({ error: 'Permintaan ditolak (CSRF)' });
    return;
  }
  const origin = req.get('origin');
  if (origin) {
    const allowed = new Set([new URL(config.appUrl).origin, `${req.protocol}://${req.get('host')}`]);
    if (!allowed.has(origin)) {
      res.status(403).json({ error: 'Origin tidak diizinkan' });
      return;
    }
  }
  next();
}
