import { parseA1 } from '@opensheet/engine';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { badRequest, forbidden, h, notFound, parse } from '../lib/http';
import { broadcast } from '../realtime';
import { can, requireCapability } from '../services/access';

export const commentsRouter = Router();

const include = {
  user: { select: { id: true, name: true } },
  replies: { include: { user: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' as const } },
};

commentsRouter.get(
  '/workbooks/:id/comments',
  h(async (req, res) => {
    const id = req.params.id as string;
    await requireCapability(req.user!.id, id, 'view');
    const comments = await prisma.workbookComment.findMany({ where: { workbookId: id }, include, orderBy: { createdAt: 'asc' } });
    res.json({ comments });
  }),
);

commentsRouter.post(
  '/workbooks/:id/comments',
  h(async (req, res) => {
    const id = req.params.id as string;
    const body = parse(z.object({ worksheetId: z.string().uuid(), cellReference: z.string().max(20), content: z.string().trim().min(1).max(5000) }), req.body);
    await requireCapability(req.user!.id, id, 'comment');
    if (!parseA1(body.cellReference)) throw badRequest('Alamat sel tidak valid');
    const ws = await prisma.worksheet.findFirst({ where: { id: body.worksheetId, workbookId: id } });
    if (!ws) throw notFound('Worksheet tidak ditemukan');
    const c = await prisma.workbookComment.create({
      data: { workbookId: id, worksheetId: ws.id, cellReference: body.cellReference.toUpperCase(), userId: req.user!.id, content: body.content },
      include,
    });
    broadcast(id, 'comment:update', { comment: c });
    res.status(201).json({ comment: c });
  }),
);

async function loadComment(id: string) {
  const c = await prisma.workbookComment.findUnique({ where: { id } });
  if (!c) throw notFound('Komentar tidak ditemukan');
  return c;
}

commentsRouter.post(
  '/comments/:id/replies',
  h(async (req, res) => {
    const body = parse(z.object({ content: z.string().trim().min(1).max(5000) }), req.body);
    const c = await loadComment(req.params.id as string);
    await requireCapability(req.user!.id, c.workbookId, 'comment');
    await prisma.workbookCommentReply.create({ data: { commentId: c.id, userId: req.user!.id, content: body.content } });
    const full = await prisma.workbookComment.findUniqueOrThrow({ where: { id: c.id }, include });
    broadcast(c.workbookId, 'comment:update', { comment: full });
    res.status(201).json({ comment: full });
  }),
);

commentsRouter.patch(
  '/comments/:id',
  h(async (req, res) => {
    const body = parse(z.object({ resolved: z.boolean() }), req.body);
    const c = await loadComment(req.params.id as string);
    await requireCapability(req.user!.id, c.workbookId, 'comment');
    const full = await prisma.workbookComment.update({ where: { id: c.id }, data: { resolved: body.resolved }, include });
    broadcast(c.workbookId, 'comment:update', { comment: full });
    res.json({ comment: full });
  }),
);

commentsRouter.delete(
  '/comments/:id',
  h(async (req, res) => {
    const c = await loadComment(req.params.id as string);
    const { role } = await requireCapability(req.user!.id, c.workbookId, 'comment');
    if (c.userId !== req.user!.id && !can(role, 'manage')) throw forbidden('Hanya penulis komentar yang dapat menghapusnya');
    await prisma.workbookComment.delete({ where: { id: c.id } });
    broadcast(c.workbookId, 'comment:update', { deletedId: c.id });
    res.json({ ok: true });
  }),
);
