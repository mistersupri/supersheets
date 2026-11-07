import './boot';
import cluster from 'node:cluster';
import http from 'node:http';
import { setupMaster } from '@socket.io/sticky';
import { createApp } from './app';
import { config } from './config';
import { prisma } from './db';
import { connectBus } from './lib/bus';
import { initRealtime } from './realtime';

/**
 * WORKERS=1 (default): one process.
 * WORKERS>1: the primary accepts connections and hands each one to a worker,
 * keeping a client's Socket.IO session on the same worker (sticky). Workers
 * share rooms, cache invalidation and rate limits through Redis (REDIS_URL).
 */
if (config.workers > 1 && !config.redisUrl) {
  console.error('WORKERS > 1 membutuhkan REDIS_URL.');
  process.exit(1);
}

if (config.workers > 1 && cluster.isPrimary) {
  const server = http.createServer();
  setupMaster(server, { loadBalancingMethod: 'least-connection' });
  // Connection data is passed to workers as Buffers, which needs structured-clone IPC.
  cluster.setupPrimary({ serialization: 'advanced' });
  server.listen(config.port, () => console.info(`OpenSheet primary on :${config.port}, ${config.workers} workers`));
  for (let i = 0; i < config.workers; i++) cluster.fork();
  cluster.on('exit', (w, code) => {
    console.error(`worker ${w.process.pid} exited (${code}); restarting`);
    cluster.fork();
  });
} else {
  void start();
}

async function start() {
  await connectBus();
  const app = createApp();
  const server = http.createServer(app);
  initRealtime(server, new URL(config.appUrl).origin);
  // In cluster mode the primary owns the port and passes connections in.
  if (config.workers <= 1) server.listen(config.port, () => console.info(`OpenSheet API listening on :${config.port}`));
  else console.info(`worker ${process.pid} ready`);
  server.keepAliveTimeout = 65_000;

  const shutdown = async () => {
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
