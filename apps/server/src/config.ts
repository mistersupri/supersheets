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
  /** Where original uploads are kept: "local" (STORAGE_DIR) or "s3". "none" keeps nothing. */
  storage: (process.env.STORAGE ?? 'local') as 'local' | 's3' | 'none',
  storageDir: process.env.STORAGE_DIR ?? './data/uploads',
  s3: {
    endpoint: process.env.S3_ENDPOINT || undefined,
    region: process.env.S3_REGION ?? 'us-east-1',
    bucket: process.env.S3_BUCKET ?? '',
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== '0',
  },
  /** Optional Redis: shares realtime rooms, cache invalidation and rate limits across processes. */
  redisUrl: process.env.REDIS_URL ?? '',
  /** Number of worker processes (cluster mode). More than 1 requires REDIS_URL. */
  workers: Number(process.env.WORKERS ?? 1),
  /** PostgreSQL connections per process. */
  dbPoolMax: Number(process.env.DB_POOL_MAX ?? 20),
  /** Login attempts per IP per 15 minutes. Offices and schools often share one public IP. */
  loginIpLimit: Number(process.env.LOGIN_IP_LIMIT ?? 3000),
  /** Login attempts per IP + email per 15 minutes. */
  loginAccountLimit: Number(process.env.LOGIN_ACCOUNT_LIMIT ?? 10),
  /** API requests per signed-in user (or per IP when signed out) per minute. */
  apiLimit: Number(process.env.API_RATE_LIMIT ?? 600),
};
