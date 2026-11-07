import type { Request } from 'express';
import { prisma } from '../db';

export async function audit(
  req: Request | null,
  action: string,
  target?: { type: string; id: string },
  detail?: Record<string, unknown>,
  userId?: string | null,
) {
  try {
    await prisma.auditLog.create({
      data: {
        userId: userId ?? req?.user?.id ?? null,
        action,
        targetType: target?.type,
        targetId: target?.id,
        detail: (detail ?? undefined) as never,
        ip: req?.ip,
      },
    });
  } catch (e) {
    console.error('audit log failed', e);
  }
}
