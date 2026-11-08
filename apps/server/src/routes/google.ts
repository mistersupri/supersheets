import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { config } from '../config';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { invalidate } from '../lib/bus';
import { h } from '../lib/http';
import { ipKey, limiter } from '../lib/limits';
import { getSettings } from '../lib/settings';
import { acceptInvitations, createSession, hashPassword } from '../services/auth';

/**
 * Sign in with Google: OpenID Connect authorization code flow with PKCE.
 *   1. GET /api/auth/google          sends the browser to Google
 *   2. GET /api/auth/google/callback receives the code, exchanges it on the server
 *                                    and signs the person in.
 * The client secret never reaches the browser, and an email is only trusted
 * when Google reports it as verified.
 */
export const googleRouter = Router();

const COOKIE = 'osgoogle';
const redirectUri = () => `${new URL(config.appUrl).origin}/api/auth/google/callback`;
const enabled = () => !!config.google.clientId && !!config.google.clientSecret;

const guard = limiter({
  prefix: 'google',
  windowMs: 10 * 60_000,
  limit: config.isProd ? 120 : 10_000,
  message: 'Terlalu banyak percobaan masuk dengan Google. Coba lagi nanti.',
  key: ipKey,
});

/** Only same-site paths, never absolute or protocol-relative URLs. */
function safeNext(next: unknown): string {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next.slice(0, 500) : '/';
}

const b64url = (b: Buffer) => b.toString('base64url');

function fail(res: Response, code: string) {
  res.clearCookie(COOKIE, { path: '/api/auth/google' });
  res.redirect(`${new URL(config.appUrl).origin}/login?error=${code}`);
}

googleRouter.get(
  '/google',
  guard,
  h(async (req, res) => {
    if (!enabled()) return void res.status(404).json({ error: 'Masuk dengan Google tidak diaktifkan' });
    const state = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    // The state, PKCE verifier and return path wait in a short-lived cookie that only this server reads.
    res.cookie(COOKIE, JSON.stringify({ state, verifier, next: safeNext(req.query.next) }), {
      httpOnly: true,
      secure: config.isProd,
      sameSite: 'lax',
      path: '/api/auth/google',
      maxAge: 10 * 60_000,
    });
    const url = new URL(config.google.authUrl);
    url.search = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    res.redirect(url.toString());
  }),
);

interface GoogleProfile {
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
}

async function fetchProfile(code: string, verifier: string): Promise<GoogleProfile | null> {
  const tokenRes = await fetch(config.google.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenRes.ok) return null;
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) return null;
  const infoRes = await fetch(config.google.userinfoUrl, { headers: { authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(10_000) });
  return infoRes.ok ? ((await infoRes.json()) as GoogleProfile) : null;
}

googleRouter.get(
  '/google/callback',
  guard,
  h(async (req: Request, res: Response) => {
    if (!enabled()) return void res.status(404).json({ error: 'Masuk dengan Google tidak diaktifkan' });
    let saved: { state: string; verifier: string; next: string } | null = null;
    try {
      saved = JSON.parse(req.cookies?.[COOKIE] ?? 'null');
    } catch {
      saved = null;
    }
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const stateOk = !!saved && state.length === saved.state.length && crypto.timingSafeEqual(Buffer.from(state), Buffer.from(saved.state));
    if (!saved || !stateOk) return fail(res, 'google_state');
    if (req.query.error) return fail(res, 'google_denied');
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) return fail(res, 'google_failed');

    let profile: GoogleProfile | null;
    try {
      profile = await fetchProfile(code, saved.verifier);
    } catch (e) {
      console.error('google sign-in failed', e);
      return fail(res, 'google_failed');
    }
    if (!profile) return fail(res, 'google_failed');
    const email = profile.email?.trim().toLowerCase();
    const verified = profile.email_verified === true || profile.email_verified === 'true';
    if (!profile.sub || !email || !verified) return fail(res, 'google_unverified');

    let user = await prisma.user.findUnique({ where: { googleId: profile.sub } });
    if (!user) {
      const byEmail = await prisma.user.findUnique({ where: { email } });
      if (byEmail) {
        // An account with this email already exists. Google has proven the email is theirs, but
        // someone else could have registered it earlier with a password they know. So the old
        // password is retired and old sessions end: from now on only Google (or a reset by email) works.
        user = await prisma.user.update({
          where: { id: byEmail.id },
          data: { googleId: profile.sub, passwordHash: await hashPassword(crypto.randomBytes(32).toString('hex')), failedLoginCount: 0, lockedUntil: null },
        });
        await prisma.session.deleteMany({ where: { userId: user.id } });
        invalidate('user', user.id);
        await audit(req, 'auth.google_link', { type: 'user', id: user.id }, undefined, user.id);
      } else {
        const count = await prisma.user.count();
        const settings = await getSettings();
        if (count > 0 && !settings.registrationEnabled) return fail(res, 'registration_closed');
        user = await prisma.user.create({
          data: {
            name: (profile.name?.trim() || email.split('@')[0]).slice(0, 120),
            email,
            googleId: profile.sub,
            // Nobody knows this password, so the account can only be entered through Google or an email reset.
            passwordHash: await hashPassword(crypto.randomBytes(32).toString('hex')),
            role: count === 0 ? 'super_admin' : 'user',
          },
        });
        await acceptInvitations(user);
        await audit(req, 'auth.register_google', { type: 'user', id: user.id }, undefined, user.id);
      }
    }
    if (!user.isActive) return fail(res, 'account_disabled');
    await createSession(res, req, user.id, true);
    await audit(req, 'auth.login_google', { type: 'user', id: user.id }, undefined, user.id);
    res.clearCookie(COOKIE, { path: '/api/auth/google' });
    res.redirect(`${new URL(config.appUrl).origin}${saved.next}`);
  }),
);
