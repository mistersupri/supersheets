import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodType } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (m: string, d?: unknown) => new HttpError(400, m, d);
export const unauthorized = (m = 'Silakan masuk terlebih dahulu') => new HttpError(401, m);
export const forbidden = (m = 'Anda tidak memiliki akses') => new HttpError(403, m);
export const notFound = (m = 'Tidak ditemukan') => new HttpError(404, m);
export const conflict = (m: string, d?: unknown) => new HttpError(409, m, d);

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

export function h(fn: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest('Data tidak valid', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Data tidak valid', details: err.issues });
    return;
  }
  const anyErr = err as { type?: string; code?: string; status?: number };
  if (anyErr?.type === 'entity.too.large' || anyErr?.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: 'Ukuran data terlalu besar' });
    return;
  }
  if (anyErr?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'JSON tidak valid' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Terjadi kesalahan di server' });
}

/** JSON.stringify replacer for BigInt columns. */
export function jsonSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x)));
}
