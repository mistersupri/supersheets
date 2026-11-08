import cookieParser from 'cookie-parser';
import express from 'express';
import { ipKey, limiter } from './lib/limits';
import helmet from 'helmet';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { errorHandler } from './lib/http';
import { adminRouter } from './routes/admin';
import { authRouter } from './routes/auth';
import { commentsRouter } from './routes/comments';
import { foldersRouter } from './routes/folders';
import { historyRouter } from './routes/history';
import { googleRouter } from './routes/google';
import { exportRouter, importRouter } from './routes/importexport';
import { sharingRouter } from './routes/sharing';
import { workbooksRouter } from './routes/workbooks';
import { worksheetsRouter } from './routes/worksheets';
import { feedManageRouter, feedPublicRouter } from './routes/feed';
import { csrfGuard, loadUser, requireAuth } from './services/auth';
import { listFunctions } from '@opensheet/engine';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'", 'ws:', 'wss:'],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(express.json({ limit: '12mb' }));
  app.use(cookieParser());

  const api = express.Router();
  api.use(loadUser);
  // Counted per signed-in user, so colleagues behind one NAT do not share a budget.
  api.use(
    limiter({
      prefix: 'api',
      windowMs: 60_000,
      limit: config.isProd ? config.apiLimit : 100_000,
      message: 'Terlalu banyak permintaan. Coba lagi sebentar.',
      key: (req) => (req.user ? `u:${req.user.id}` : `ip:${ipKey(req)}`),
    }),
  );
  api.use(csrfGuard);
  api.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  api.use('/feed', feedPublicRouter);
  api.use('/auth', googleRouter);
  api.use('/auth', authRouter);
  // Signed-out visitors may read shared workbooks when the admin allows guests;
  // each handler still checks the workbook's link setting.
  const GUEST_GET = /^\/(workbooks\/[0-9a-f-]{36}(\/(cells|worksheets|comments|export\/(xlsx|ods|csv|tsv|pdf)))?|worksheets\/[0-9a-f-]{36}\/range|functions)$/;
  api.use((req, res, next) => (req.user || (req.method === 'GET' && GUEST_GET.test(req.path)) ? next() : requireAuth(req, res, next)));
  api.get('/functions', (_req, res) => {
    res.json({ functions: listFunctions() });
  });
  api.use('/workbooks', workbooksRouter);
  api.use('/workbooks', sharingRouter);
  api.use('/workbooks', historyRouter);
  api.use('/workbooks', exportRouter);
  api.use('/workbooks', feedManageRouter);
  api.use('/worksheets', worksheetsRouter);
  api.use('/folders', foldersRouter);
  api.use('/import', importRouter);
  api.use('/admin', adminRouter);
  api.use('/', commentsRouter);
  api.use((_req, res) => {
    res.status(404).json({ error: 'Endpoint tidak ditemukan' });
  });
  app.use('/api', api);

  // Production: serve the built web app with an SPA fallback.
  const dist = config.webDist || path.resolve(process.cwd(), '../web/dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/|socket\.io\/).*/, (_req, res) => {
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}
