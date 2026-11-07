import { createClient, type RedisClientType } from 'redis';
import { config } from '../config';

/**
 * Invalidation bus. Handlers run in this process right away; when REDIS_URL is
 * set the message is also published so other server processes drop their
 * cached copies too.
 */
type Topic = 'user' | 'workbook' | 'settings';
type Handler = (key: string) => void;

const handlers = new Map<Topic, Handler[]>();
const CHANNEL = 'opensheet:invalidate';
const origin = `${process.pid}-${Math.random().toString(36).slice(2)}`;
let pub: RedisClientType | null = null;

/** The shared Redis client, created at import time so stores can queue commands before connect. */
export const redis: RedisClientType | null = config.redisUrl ? createClient({ url: config.redisUrl }) : null;
if (redis) {
  redis.on('error', (e) => console.error('redis', e.message));
  // Connect before anything (rate-limit stores, the Socket.IO adapter) sends commands.
  await redis.connect();
}

export function onInvalidate(topic: Topic, h: Handler) {
  handlers.set(topic, [...(handlers.get(topic) ?? []), h]);
}

function runLocal(topic: Topic, key: string) {
  for (const h of handlers.get(topic) ?? []) h(key);
}

export function invalidate(topic: Topic, key = '*') {
  runLocal(topic, key);
  if (pub) void pub.publish(CHANNEL, JSON.stringify({ origin, topic, key })).catch(() => undefined);
}

export async function connectBus(): Promise<void> {
  if (!config.redisUrl) return;
  pub = redis!;
  const sub = pub.duplicate();
  sub.on('error', (e) => console.error('redis sub', e.message));
  await sub.connect();
  await sub.subscribe(CHANNEL, (raw) => {
    try {
      const m = JSON.parse(raw) as { origin: string; topic: Topic; key: string };
      if (m.origin !== origin) runLocal(m.topic, m.key);
    } catch {
      /* ignore malformed messages */
    }
  });
}
