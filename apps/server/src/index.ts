import http from 'node:http';
import { createApp } from './app';
import { config } from './config';
import { prisma } from './db';
import { initRealtime } from './realtime';

const app = createApp();
const server = http.createServer(app);
initRealtime(server, new URL(config.appUrl).origin);

server.listen(config.port, () => {
  console.info(`OpenSheet API listening on :${config.port}`);
});

async function shutdown() {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
