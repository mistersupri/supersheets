import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { badRequest, forbidden, h, notFound, parse } from '../lib/http';
import { sendMail } from '../lib/mail';
import { getSettings } from '../lib/settings';
import { broadcast, notifyRoleChange, revokeAccess } from '../realtime';
import { can, rank, requireCapability, roleFor } from '../services/access';

export const sharingRouter = Router();

const grantable = z.enum(['viewer', 'commenter', 'editor', 'manager']);

const ROLE_LABEL: Record<string, string> = { viewer: 'Viewer', commenter: 'Commenter', editor: 'Editor', manager: 'Editor + kelola akses' };

sharingRouter.get(
  '/:id/permissions',
  h(async (req, res) => {
    const id = req.params.id as string;
    const { role, workbook } = await requireCapability(req.user!.id, id, 'view');
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: workbook.ownerId }, select: { id: true, name: true, email: true } });
    const settings = await getSettings();
    // Members other than the owner are visible to those who can share.
    const canShare = can(role, 'share');
    const permissions = canShare
      ? await prisma.workbookPermission.findMany({ where: { workbookId: id }, include: { user: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: 'asc' } })
      : [];
    const invitations = canShare ? await prisma.workbookInvitation.findMany({ where: { workbookId: id, acceptedAt: null }, orderBy: { createdAt: 'asc' } }) : [];
    res.json({
      owner,
      linkAccess: workbook.linkAccess,
      linkSharingEnabled: settings.linkSharingEnabled,
      permissions: permissions.map((p) => ({ id: p.id, permission: p.permission, user: p.user })),
      invitations: invitations.map((i) => ({ id: i.id, email: i.email, permission: i.permission, createdAt: i.createdAt })),
    });
  }),
);

sharingRouter.post(
  '/:id/share',
  h(async (req, res) => {
    const id = req.params.id as string;
    const body = parse(z.object({ email: z.string().trim().toLowerCase().email('Email tidak valid'), permission: grantable, message: z.string().max(1000).optional() }), req.body);
    const { role, workbook } = await requireCapability(req.user!.id, id, 'share');
    if (body.permission === 'manager' && role !== 'owner') throw forbidden('Hanya pemilik yang dapat memberi hak kelola');
    const link = `${config.appUrl}/w/${id}`;
    const target = await prisma.user.findUnique({ where: { email: body.email } });
    const note = body.message ? `\n\nPesan dari ${req.user!.name}:\n${body.message}` : '';
    if (target) {
      if (target.id === workbook.ownerId) throw badRequest('Orang ini adalah pemilik workbook');
      const p = await prisma.workbookPermission.upsert({
        where: { workbookId_userId: { workbookId: id, userId: target.id } },
        create: { workbookId: id, userId: target.id, permission: body.permission },
        update: { permission: body.permission },
      });
      await sendMail(target.email, `${req.user!.name} membagikan "${workbook.title}"`, `${req.user!.name} memberi Anda akses ${ROLE_LABEL[body.permission]} ke "${workbook.title}".\n\nBuka: ${link}${note}`);
      await notifyRoleChange(id, target.id);
      await audit(req, 'share.grant', { type: 'workbook', id }, { userId: target.id, permission: body.permission });
      res.status(201).json({ kind: 'permission', id: p.id });
      return;
    }
    const inv = await prisma.workbookInvitation.upsert({
      where: { workbookId_email: { workbookId: id, email: body.email } },
      create: { workbookId: id, email: body.email, permission: body.permission, invitedBy: req.user!.id },
      update: { permission: body.permission },
    });
    await sendMail(
      body.email,
      `${req.user!.name} mengundang Anda ke "${workbook.title}"`,
      `${req.user!.name} mengundang Anda untuk membuka "${workbook.title}" di OpenSheet sebagai ${ROLE_LABEL[body.permission]}.\n\nDaftar dengan email ini untuk menerima undangan: ${config.appUrl}/register\nSetelah itu buka: ${link}${note}`,
    );
    await audit(req, 'share.invite', { type: 'workbook', id }, { email: body.email, permission: body.permission });
    res.status(201).json({ kind: 'invitation', id: inv.id });
  }),
);

sharingRouter.patch(
  '/:id/permissions/:permissionId',
  h(async (req, res) => {
    const id = req.params.id as string;
    const body = parse(z.object({ permission: grantable }), req.body);
    const { role } = await requireCapability(req.user!.id, id, 'share');
    const p = await prisma.workbookPermission.findFirst({ where: { id: req.params.permissionId as string, workbookId: id } });
    if (!p) throw notFound();
    if (role !== 'owner' && (body.permission === 'manager' || p.permission === 'manager')) throw forbidden('Hanya pemilik yang dapat mengubah hak kelola');
    await prisma.workbookPermission.update({ where: { id: p.id }, data: { permission: body.permission } });
    await notifyRoleChange(id, p.userId);
    await audit(req, 'share.update', { type: 'workbook', id }, { userId: p.userId, permission: body.permission });
    res.json({ ok: true });
  }),
);

sharingRouter.delete(
  '/:id/permissions/:permissionId',
  h(async (req, res) => {
    const id = req.params.id as string;
    const p = await prisma.workbookPermission.findFirst({ where: { id: req.params.permissionId as string, workbookId: id } });
    if (!p) throw notFound();
    // Anyone may remove themselves; otherwise sharing rights are needed.
    if (p.userId !== req.user!.id) {
      const { role } = await requireCapability(req.user!.id, id, 'share');
      if (role !== 'owner' && p.permission === 'manager') throw forbidden('Hanya pemilik yang dapat mencabut hak kelola');
    }
    await prisma.workbookPermission.delete({ where: { id: p.id } });
    await revokeAccess(id, p.userId);
    await audit(req, 'share.revoke', { type: 'workbook', id }, { userId: p.userId });
    res.json({ ok: true });
  }),
);

sharingRouter.delete(
  '/:id/invitations/:invitationId',
  h(async (req, res) => {
    const id = req.params.id as string;
    await requireCapability(req.user!.id, id, 'share');
    await prisma.workbookInvitation.deleteMany({ where: { id: req.params.invitationId as string, workbookId: id } });
    res.json({ ok: true });
  }),
);

sharingRouter.patch(
  '/:id/link',
  h(async (req, res) => {
    const id = req.params.id as string;
    const body = parse(z.object({ linkAccess: z.enum(['restricted', 'view', 'comment', 'edit']) }), req.body);
    await requireCapability(req.user!.id, id, 'share');
    const settings = await getSettings();
    if (body.linkAccess !== 'restricted' && !settings.linkSharingEnabled) throw forbidden('Berbagi lewat tautan dinonaktifkan oleh admin');
    await prisma.workbook.update({ where: { id }, data: { linkAccess: body.linkAccess } });
    await audit(req, 'share.link', { type: 'workbook', id }, { linkAccess: body.linkAccess });
    broadcast(id, 'workbook:update', { linkAccess: body.linkAccess });
    // Re-evaluate everyone connected; link access may have been their only grant.
    const viewers = await prisma.workbookOpen.findMany({ where: { workbookId: id }, select: { userId: true } });
    for (const v of viewers) {
      const r = await roleFor(v.userId, id);
      if (rank(r.role) === 0) await revokeAccess(id, v.userId);
      else await notifyRoleChange(id, v.userId);
    }
    res.json({ ok: true });
  }),
);
