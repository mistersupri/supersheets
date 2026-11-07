import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing environment variable ${name}`);
  return v;
}

const isProd = process.env.NODE_ENV === 'production';

export const config = {
  isProd,
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required('DATABASE_URL'),
  /** Public origin of the web app, used for links in emails and the Origin check. */
  appUrl: required('APP_URL', isProd ? undefined : 'http://localhost:5173'),
  smtpUrl: process.env.SMTP_URL ?? '',
  mailFrom: process.env.MAIL_FROM ?? 'OpenSheet <no-reply@localhost>',
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 10) * 1024 * 1024,
  sessionDays: 1,
  rememberDays: 30,
  snapshotEvery: Number(process.env.SNAPSHOT_EVERY ?? 100),
  webDist: process.env.WEB_DIST ?? '',
  /** Set behind a reverse proxy so req.ip and secure cookies work. */
  trustProxy: process.env.TRUST_PROXY === '1',
};
