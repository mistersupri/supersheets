import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { badRequest, forbidden, h, jsonSafe, notFound, parse } from '../lib/http';
import { broadcast } from '../realtime';
import { capabilities, requireCapability, roleFor, type Role } from '../services/access';
import { loadSheetCells } from '../services/cells';
import { baseSnapshot, createWorkbook, nextSheetTitle, recordOpen, sheetPayload } from '../services/workbooks';

export const workbooksRouter = Router();

const COLORS = ['green', 'teal', 'blue', 'plum', 'rust', 'amber', 'slate'] as const;

const listQuery = z.object({
  view: z.enum(['recent', 'mine', 'shared', 'starred', 'trash', 'all']).default('all'),
  q: z.string().max(200).optional(),
  owner: z.enum(['any', 'me', 'others']).default('any'),
  modified: z.enum(['any', '7', '30', '365']).default('any'),
  folderId: z.string().uuid().optional(),
});

workbooksRouter.get(
  '/',
  h(async (req, res) => {
    const q = parse(listQuery, req.query);
    const me = req.user!.id;
    const since = q.modified === 'any' ? undefined : new Date(Date.now() - Number(q.modified) * 86_400_000);
    const accessible = {
      OR: [{ ownerId: me }, { permissions: { some: { userId: me } } }],
    };
    const where: Record<string, unknown> = { isTrashed: q.view === 'trash' };
    const and: Record<string, unknown>[] = [];
    if (q.view === 'trash') where.ownerId = me;
    else if (q.view === 'mine') {
      where.ownerId = me;
      if (q.folderId) where.folderId = q.folderId;
    } else if (q.view === 'shared') and.push({ permissions: { some: { userId: me } } }, { ownerId: { not: me } });
    else if (q.view === 'starred') and.push({ stars: { some: { userId: me } } }, accessible);
    else if (q.view === 'recent') and.push({ opens: { some: { userId: me } } }, { OR: [accessible, { opens: { some: { userId: me } }, linkAccess: { not: 'restricted' } }] });
    else and.push(accessible);
    if (q.owner === 'me') and.push({ ownerId: me });
    if (q.owner === 'others') and.push({ ownerId: { not: me } });
    if (since) and.push({ updatedAt: { gte: since } });
    if (q.q) and.push({ title: { contains: q.q, mode: 'insensitive' } });
    if (and.length) where.AND = and;

    const rows = await prisma.workbook.findMany({
      where: where as never,
      include: {
        owner: { select: { id: true, name: true } },
        stars: { where: { userId: me }, select: { userId: true } },
        permissions: { where: { userId: me }, select: { permission: true } },
        opens: { where: { userId: me }, select: { openedAt: true } },
      },
      take: 200,
      orderBy: { updatedAt: 'desc' },
    });
    let items = rows.map((w) => ({
      id: w.id,
      title: w.title,
      color: w.color,
      folderId: w.ownerId === me ? w.folderId : null,
      owner: w.owner,
      role: (w.ownerId === me ? 'owner' : (w.permissions[0]?.permission ?? (w.linkAccess === 'restricted' ? 'none' : 'link'))) as string,
      starred: w.stars.length > 0,
      updatedAt: w.updatedAt,
      openedAt: w.opens[0]?.openedAt ?? null,
      trashedAt: w.trashedAt,
    }));
    if (q.view === 'recent') items = items.sort((a, b) => +new Date(b.openedAt ?? 0) - +new Date(a.openedAt ?? 0)).slice(0, 40);
    res.json({ items });
  }),
);

workbooksRouter.post(
  '/',
  h(async (req, res) => {
    const body = parse(z.object({ title: z.string().trim().min(1).max(200).optional(), folderId: z.string().uuid().nullish() }), req.body ?? {});
    if (body.folderId) {
      const f = await prisma.folder.findFirst({ where: { id: body.folderId, ownerId: req.user!.id } });
      if (!f) throw badRequest('Folder tidak ditemukan');
    }
    const { workbook } = await createWorkbook(req.user!.id, body.title ?? 'Spreadsheet tanpa judul', body.folderId);
    await baseSnapshot(workbook.id);
    await audit(req, 'workbook.create', { type: 'workbook', id: workbook.id });
    res.status(201).json({ id: workbook.id });
  }),
);

workbooksRouter.get(
  '/:id',
  h(async (req, res) => {
    const { role, workbook } = await roleFor(req.user!.id, req.params.id as string);
    if (role === 'none') throw notFound('Workbook tidak ditemukan atau Anda tidak memiliki akses');
    const sheets = await prisma.worksheet.findMany({ where: { workbookId: workbook.id }, orderBy: { position: 'asc' }, select: { id: true } });
    const owner = await prisma.user.findUnique({ where: { id: workbook.ownerId }, select: { id: true, name: true, email: true } });
    const star = await prisma.workbookStar.findUnique({ where: { userId_workbookId: { userId: req.user!.id, workbookId: workbook.id } } });
    if (!workbook.isTrashed) await recordOpen(req.user!.id, workbook.id);
    res.json(
      jsonSafe({
        workbook: {
          id: workbook.id,
          title: workbook.title,
          description: workbook.description,
          color: workbook.color,
          revision: workbook.revision,
          linkAccess: workbook.linkAccess,
          isTrashed: workbook.isTrashed,
          updatedAt: workbook.updatedAt,
          owner,
          starred: !!star,
        },
        role: role as Role,
        can: capabilities(role),
        sheets: await Promise.all(sheets.map((s) => sheetPayload(s.id))),
      }),
    );
  }),
);

/** Every cell of every sheet. The engine needs them all for cross-sheet formulas. */
workbooksRouter.get(
  '/:id/cells',
  h(async (req, res) => {
    const { workbook } = await requireCapability(req.user!.id, req.params.id as string, 'view');
    const sheets = await prisma.worksheet.findMany({ where: { workbookId: workbook.id }, select: { id: true } });
    const out: Record<string, Awaited<ReturnType<typeof loadSheetCells>>> = {};
    for (const s of sheets) out[s.id] = await loadSheetCells(s.id);
    const userIds = new Set<string>();
    Object.values(out).forEach((cells) => cells.forEach((c) => c.updatedBy && userIds.add(c.updatedBy)));
    const users = await prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true } });
    res.json(jsonSafe({ revision: workbook.revision, sheets: out, users }));
  }),
);

workbooksRouter.patch(
  '/:id',
  h(async (req, res) => {
    const body = parse(
      z.object({
        title: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(2000).nullable().optional(),
        color: z.enum(COLORS).optional(),
        folderId: z.string().uuid().nullable().optional(),
        starred: z.boolean().optional(),
      }),
      req.body,
    );
    const id = req.params.id as string;
    const me = req.user!.id;
    if (body.starred !== undefined) {
      await requireCapability(me, id, 'view');
      if (body.starred) await prisma.workbookStar.upsert({ where: { userId_workbookId: { userId: me, workbookId: id } }, create: { userId: me, workbookId: id }, update: {} });
      else await prisma.workbookStar.deleteMany({ where: { userId: me, workbookId: id } });
    }
    if (body.folderId !== undefined) {
      await requireCapability(me, id, 'own');
      if (body.folderId) {
        const f = await prisma.folder.findFirst({ where: { id: body.folderId, ownerId: me } });
        if (!f) throw badRequest('Folder tidak ditemukan');
      }
      await prisma.workbook.update({ where: { id }, data: { folderId: body.folderId } });
    }
    if (body.title !== undefined || body.color !== undefined || body.description !== undefined) {
      await requireCapability(me, id, 'edit');
      const wb = await prisma.workbook.update({ where: { id }, data: { title: body.title, color: body.color, description: body.description } });
      broadcast(id, 'workbook:update', { title: wb.title, color: wb.color, description: wb.description });
    }
    res.json({ ok: true });
  }),
);

workbooksRouter.delete(
  '/:id',
  h(async (req, res) => {
    const id = req.params.id as string;
    const { workbook } = await requireCapability(req.user!.id, id, 'own');
    if (req.query.permanent === '1') {
      if (!workbook.isTrashed) throw badRequest('Pindahkan ke sampah terlebih dahulu');
      await prisma.workbook.delete({ where: { id } });
      await audit(req, 'workbook.delete_permanent', { type: 'workbook', id }, { title: workbook.title });
      res.json({ ok: true });
      return;
    }
    await prisma.workbook.update({ where: { id }, data: { isTrashed: true, trashedAt: new Date() } });
    broadcast(id, 'access:revoked', { workbookId: id });
    await audit(req, 'workbook.trash', { type: 'workbook', id }, { title: workbook.title });
    res.json({ ok: true });
  }),
);

workbooksRouter.post(
  '/:id/restore',
  h(async (req, res) => {
    const id = req.params.id as string;
    await requireCapability(req.user!.id, id, 'own');
    await prisma.workbook.update({ where: { id }, data: { isTrashed: false, trashedAt: null } });
    await audit(req, 'workbook.restore', { type: 'workbook', id });
    res.json({ ok: true });
  }),
);

workbooksRouter.post(
  '/:id/duplicate',
  h(async (req, res) => {
    const id = req.params.id as string;
    const { workbook } = await requireCapability(req.user!.id, id, 'view');
    const body = parse(z.object({ title: z.string().trim().min(1).max(200).optional() }), req.body ?? {});
    const sheets = await prisma.worksheet.findMany({
      where: { workbookId: id },
      orderBy: { position: 'asc' },
      include: { metadata: true, dataValidations: true, conditionalFormats: true },
    });
    const copyId = await prisma.$transaction(
      async (tx) => {
        const copy = await tx.workbook.create({
          data: { ownerId: req.user!.id, title: body.title ?? `Salinan ${workbook.title}`.slice(0, 200), color: workbook.color, description: workbook.description },
        });
        for (const s of sheets) {
          const ns = await tx.worksheet.create({
            data: {
              workbookId: copy.id,
              title: s.title,
              position: s.position,
              defaultColumnWidth: s.defaultColumnWidth,
              defaultRowHeight: s.defaultRowHeight,
              frozenRows: s.frozenRows,
              frozenColumns: s.frozenColumns,
              metadata: { create: { data: (s.metadata?.data ?? {}) as never } },
            },
          });
          if (s.dataValidations.length) await tx.dataValidation.createMany({ data: s.dataValidations.map((v) => ({ worksheetId: ns.id, range: v.range, rule: v.rule as never })) });
          if (s.conditionalFormats.length)
            await tx.conditionalFormat.createMany({ data: s.conditionalFormats.map((v) => ({ worksheetId: ns.id, range: v.range, rule: v.rule as never, position: v.position })) });
          await tx.$executeRaw`
            INSERT INTO cells (id, worksheet_id, row_index, column_index, raw_value, formula, calculated_value, data_type, style_id, updated_by, updated_at)
            SELECT gen_random_uuid(), ${ns.id}::uuid, row_index, column_index, raw_value, formula, calculated_value, data_type, style_id, ${req.user!.id}::uuid, now()
            FROM cells WHERE worksheet_id = ${s.id}::uuid`;
        }
        return copy.id;
      },
      { timeout: 60_000 },
    );
    await baseSnapshot(copyId);
    await audit(req, 'workbook.duplicate', { type: 'workbook', id: copyId }, { from: id });
    res.status(201).json({ id: copyId });
  }),
);

workbooksRouter.get(
  '/:id/worksheets',
  h(async (req, res) => {
    const { workbook } = await requireCapability(req.user!.id, req.params.id as string, 'view');
    const sheets = await prisma.worksheet.findMany({ where: { workbookId: workbook.id }, orderBy: { position: 'asc' }, select: { id: true } });
    res.json({ sheets: await Promise.all(sheets.map((s) => sheetPayload(s.id))) });
  }),
);

workbooksRouter.post(
  '/:id/worksheets',
  h(async (req, res) => {
    const id = req.params.id as string;
    await requireCapability(req.user!.id, id, 'edit');
    const body = parse(z.object({ title: z.string().trim().min(1).max(100).optional() }), req.body ?? {});
    const title = body.title ?? (await nextSheetTitle(id));
    const clash = await prisma.worksheet.findFirst({ where: { workbookId: id, title: { equals: title, mode: 'insensitive' } } });
    if (clash) throw badRequest('Nama sheet sudah dipakai');
    const count = await prisma.worksheet.count({ where: { workbookId: id } });
    if (count >= 200) throw forbidden('Batas 200 sheet per workbook');
    const ws = await prisma.worksheet.create({ data: { workbookId: id, title, position: count, metadata: { create: { data: {} } } } });
    const payload = await sheetPayload(ws.id);
    broadcast(id, 'worksheet:update', { action: 'create', sheet: payload });
    res.status(201).json({ sheet: payload });
  }),
);
