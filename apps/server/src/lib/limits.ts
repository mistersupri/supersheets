import type { Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redis } from './bus';

/**
 * Rate limiters. With Redis the counters are shared by every server process,
 * otherwise they live in this process.
 */
export function limiter(opts: { prefix: string; windowMs: number; limit: number; message: string; key?: (req: Request) => string }) {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: opts.message },
    keyGenerator: opts.key ?? ((req) => ipKeyGenerator(req.ip ?? '')),
    store: redis
      ? new RedisStore({ prefix: `rl:${opts.prefix}:`, sendCommand: (...args: string[]) => redis!.sendCommand(args) as never })
      : undefined,
  });
}

export const ipKey = (req: Request) => ipKeyGenerator(req.ip ?? '');
