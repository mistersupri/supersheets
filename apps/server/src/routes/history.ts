import { CellOp, formatA1 } from '@opensheet/engine';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { h, jsonSafe, notFound, parse } from '../lib/http';
import { broadcast } from '../realtime';
import { requireCapability } from '../services/access';
import { applyBatch, buildState, computeValues, stateAt, type RevisionChanges } from '../services/cells';
import { loadStyles } from '../services/styles';

export const historyRouter = Router();

historyRouter.get(
  '/:id/revisions',
  h(async (req, res) => {
    const id = req.params.id as string;
    const q = parse(z.object({ userId: z.string().uuid().optional(), before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }), req.query);
    await requireCapability(req.user!.id, id, 'view');
    const sheets = await prisma.worksheet.findMany({ where: { workbookId: id }, select: { id: true, title: true } });
    const titles = new Map(sheets.map((s) => [s.id, s.title]));
    const revs = await prisma.workbookRevision.findMany({
      where: { workbookId: id, ...(q.userId ? { userId: q.userId } : {}), ...(q.before ? { revisionNumber: { lt: BigInt(q.before) } } : {}) },
      orderBy: { revisionNumber: 'desc' },
      take: q.limit,
      include: { user: { select: { id: true, name: true } } },
    });
    const editors = await prisma.workbookRevision.findMany({
      where: { workbookId: id },
      distinct: ['userId'],
      select: { user: { select: { id: true, name: true } } },
    });
    res.json(
      jsonSafe({
        revisions: revs.map((r) => {
          const ch = r.changes as unknown as RevisionChanges;
          const cells = ch.cells ?? [];
          const moved = (ch.deleted?.length ?? 0) + cells.length;
          return {
            id: r.id,
            revision: r.revisionNumber,
            kind: r.kind,
            label: ch.label ?? null,
            user: r.user,
            createdAt: r.createdAt,
            count: ch.op ? moved : cells.length,
            sample: cells.slice(0, 6).map((c) => ({
              sheet: titles.get(c.s) ?? '(sheet dihapus)',
              cell: formatA1(c.r, c.c),
              before: c.b ? c.b[0] : '',
              after: c.a ? c.a[0] : '',
            })),
          };
        }),
        editors: editors.map((e) => e.user).filter(Boolean),
      }),
    );
  }),
);

historyRouter.get(
  '/:id/revisions/:revisionId',
  h(async (req, res) => {
    const id = req.params.id as string;
    await requireCapability(req.user!.id, id, 'view');
    const r = await prisma.workbookRevision.findFirst({ where: { id: req.params.revisionId as string, workbookId: id }, include: { user: { select: { id: true, name: true } } } });
    if (!r) throw notFound('Revisi tidak ditemukan');
    const sheets = await prisma.worksheet.findMany({ where: { workbookId: id }, select: { id: true, title: true } });
    const titles = new Map(sheets.map((s) => [s.id, s.title]));
    const ch = r.changes as unknown as RevisionChanges;
    res.json(
      jsonSafe({
        id: r.id,
        revision: r.revisionNumber,
        kind: r.kind,
        label: ch.label ?? null,
        user: r.user,
        createdAt: r.createdAt,
        changes: (ch.cells ?? []).slice(0, 5000).map((c) => ({
          sheetId: c.s,
          sheet: titles.get(c.s) ?? '(sheet dihapus)',
          cell: formatA1(c.r, c.c),
          before: c.b ? c.b[0] : '',
          after: c.a ? c.a[0] : '',
          styleChanged: (c.b?.[1] ?? null) !== (c.a?.[1] ?? null),
        })),
        truncated: (ch.cells ?? []).length > 5000,
      }),
    );
  }),
);

historyRouter.post(
  '/:id/revisions/:revisionId/restore',
  h(async (req, res) => {
    const id = req.params.id as string;
    const { role, workbook } = await requireCapability(req.user!.id, id, 'edit');
    const r = await prisma.workbookRevision.findFirst({ where: { id: req.params.revisionId as string, workbookId: id } });
    if (!r) throw notFound('Revisi tidak ditemukan');
    const target = await stateAt(id, Number(r.revisionNumber));
    const current = await prisma.$transaction((tx) => buildState(tx, id));
    const ops: CellOp[] = [];
    const styleIds = new Set<string>();
    for (const [sheetId, cells] of Object.entries(current)) {
      const want = target[sheetId] ?? {};
      const keys = new Set([...Object.keys(cells), ...Object.keys(want)]);
      for (const k of keys) {
        const a = cells[k] ?? null;
        const b = want[k] ?? null;
        if (JSON.stringify(a) === JSON.stringify(b)) continue;
        const [row, col] = k.split(':').map(Number);
        if (b?.[1]) styleIds.add(b[1]);
        ops.push({ sheetId, row, col, raw: b ? b[0] : '', style: b && b[1] ? ({ __id: b[1] } as never) : null });
      }
    }
    if (!ops.length) {
      res.json({ revision: Number(workbook.revision), changed: 0 });
      return;
    }
    const styles = await loadStyles(styleIds);
    for (const op of ops) if (op.style && (op.style as { __id?: string }).__id) op.style = styles.get((op.style as unknown as { __id: string }).__id) ?? null;
    const withValues = await computeValues(id, ops);
    const result = await applyBatch({
      workbookId: id,
      userId: req.user!.id,
      role,
      clientId: 'restore',
      baseRevision: Number(workbook.revision),
      ops: withValues,
      kind: 'restore',
      label: `Memulihkan versi #${r.revisionNumber}`,
    });
    await audit(req, 'history.restore', { type: 'workbook', id }, { to: Number(r.revisionNumber) });
    broadcast(id, 'revision:created', { revision: result.revision, restored: true, userId: req.user!.id });
    res.json({ revision: result.revision, changed: result.ops.length });
  }),
);
