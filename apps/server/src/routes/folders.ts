import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { badRequest, h, notFound, parse } from '../lib/http';

export const foldersRouter = Router();

foldersRouter.get(
  '/',
  h(async (req, res) => {
    const folders = await prisma.folder.findMany({ where: { ownerId: req.user!.id }, orderBy: { name: 'asc' }, include: { _count: { select: { workbooks: { where: { isTrashed: false } } } } } });
    res.json({ folders: folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId, count: f._count.workbooks })) });
  }),
);

async function ownFolder(userId: string, id: string) {
  const f = await prisma.folder.findFirst({ where: { id, ownerId: userId } });
  if (!f) throw notFound('Folder tidak ditemukan');
  return f;
}

foldersRouter.post(
  '/',
  h(async (req, res) => {
    const body = parse(z.object({ name: z.string().trim().min(1).max(120), parentId: z.string().uuid().nullish() }), req.body);
    if (body.parentId) await ownFolder(req.user!.id, body.parentId);
    const f = await prisma.folder.create({ data: { name: body.name, parentId: body.parentId ?? null, ownerId: req.user!.id } });
    res.status(201).json({ folder: { id: f.id, name: f.name, parentId: f.parentId, count: 0 } });
  }),
);

foldersRouter.patch(
  '/:id',
  h(async (req, res) => {
    const body = parse(z.object({ name: z.string().trim().min(1).max(120).optional(), parentId: z.string().uuid().nullable().optional() }), req.body);
    const id = req.params.id as string;
    await ownFolder(req.user!.id, id);
    if (body.parentId) {
      // Refuse to move a folder inside itself.
      let cur: string | null = body.parentId;
      while (cur) {
        if (cur === id) throw badRequest('Folder tidak dapat dipindahkan ke dalam dirinya sendiri');
        cur = (await ownFolder(req.user!.id, cur)).parentId;
      }
    }
    const f = await prisma.folder.update({ where: { id }, data: { name: body.name, parentId: body.parentId } });
    res.json({ folder: f });
  }),
);

foldersRouter.delete(
  '/:id',
  h(async (req, res) => {
    const id = req.params.id as string;
    await ownFolder(req.user!.id, id);
    // Workbooks inside fall back to the root (folder_id is set null).
    await prisma.folder.delete({ where: { id } });
    res.json({ ok: true });
  }),
);
