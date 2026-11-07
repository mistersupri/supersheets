import cookieParser from 'cookie-parser';
import express from 'express';
import rateLimit from 'express-rate-limit';
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
import { exportRouter, importRouter } from './routes/importexport';
import { sharingRouter } from './routes/sharing';
import { workbooksRouter } from './routes/workbooks';
import { worksheetsRouter } from './routes/worksheets';
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
  api.use(
    rateLimit({
      windowMs: 60_000,
      limit: config.isProd ? 1200 : 100_000,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'Terlalu banyak permintaan. Coba lagi sebentar.' },
    }),
  );
  api.use(loadUser);
  api.use(csrfGuard);
  api.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  api.use('/auth', authRouter);
  api.use(requireAuth);
  api.get('/functions', (_req, res) => {
    res.json({ functions: listFunctions() });
  });
  api.use('/workbooks', workbooksRouter);
  api.use('/workbooks', sharingRouter);
  api.use('/workbooks', historyRouter);
  api.use('/workbooks', exportRouter);
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
