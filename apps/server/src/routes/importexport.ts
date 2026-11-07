import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { badRequest, h, parse } from '../lib/http';
import { broadcast } from '../realtime';
import { requireCapability } from '../services/access';
import { exportDelimited, exportPdf, exportXlsx, parseDelimited, parseXlsx, writeImported } from '../services/importexport';
import { importRange } from '../services/imports';
import { sheetPayload } from '../services/workbooks';

// Uploads stay in memory and are parsed, never written to disk or executed.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 1 } });

export const importRouter = Router();
export const exportRouter = Router();

function baseName(name: string) {
  return name.replace(/\.[^.]+$/, '').slice(0, 200) || 'Impor';
}

function isZip(buf: Buffer) {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

function looksBinary(buf: Buffer) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

const target = z.object({ workbookId: z.string().uuid().optional(), folderId: z.string().uuid().optional() });

async function finish(req: Parameters<Parameters<typeof h>[0]>[0], sheets: Awaited<ReturnType<typeof parseXlsx>>, title: string, kind: string) {
  const t = parse(target, req.body ?? {});
  const userId = req.user!.id;
  let workbookId = t.workbookId;
  if (workbookId) {
    // Import into an existing workbook as new sheets.
    await requireCapability(userId, workbookId, 'edit');
    const count = await prisma.worksheet.count({ where: { workbookId } });
    const ids = await writeImported(workbookId, userId, sheets, count, false);
    for (const id of ids) broadcast(workbookId, 'worksheet:update', { action: 'create', sheet: await sheetPayload(id), cellsChanged: true });
  } else {
    if (t.folderId && !(await prisma.folder.findFirst({ where: { id: t.folderId, ownerId: userId } }))) throw badRequest('Folder tidak ditemukan');
    const wb = await prisma.workbook.create({ data: { ownerId: userId, title, folderId: t.folderId ?? null } });
    workbookId = wb.id;
    await writeImported(workbookId, userId, sheets, 0, true);
  }
  await prisma.fileAttachment.create({
    data: { userId, workbookId, filename: req.file!.originalname.slice(0, 255), mimeType: (req.file!.mimetype || 'application/octet-stream').slice(0, 120), size: req.file!.size },
  });
  await audit(req, `import.${kind}`, { type: 'workbook', id: workbookId }, { file: req.file!.originalname, sheets: sheets.length });
  return workbookId;
}

importRouter.post(
  '/xlsx',
  upload.single('file'),
  h(async (req, res) => {
    const f = req.file;
    if (!f) throw badRequest('Pilih berkas .xlsx');
    if (!/\.xlsx$/i.test(f.originalname) || !isZip(f.buffer)) throw badRequest('Berkas harus berformat .xlsx');
    const sheets = await parseXlsx(f.buffer);
    const id = await finish(req, sheets, baseName(f.originalname), 'xlsx');
    res.status(201).json({ id });
  }),
);

importRouter.post(
  '/csv',
  upload.single('file'),
  h(async (req, res) => {
    const f = req.file;
    if (!f) throw badRequest('Pilih berkas .csv atau .tsv');
    if (!/\.(csv|tsv|txt)$/i.test(f.originalname) || looksBinary(f.buffer)) throw badRequest('Berkas harus berupa teks CSV atau TSV');
    const tsv = /\.tsv$/i.test(f.originalname);
    const sheet = parseDelimited(f.buffer.toString('utf8'), baseName(f.originalname), tsv ? '\t' : undefined);
    const id = await finish(req, [sheet], baseName(f.originalname), tsv ? 'tsv' : 'csv');
    res.status(201).json({ id });
  }),
);

function filename(title: string, ext: string) {
  const safe = title.replace(/[^\p{L}\p{N} _.-]/gu, '_').slice(0, 120) || 'workbook';
  return `attachment; filename="${safe.replace(/"/g, '')}.${ext}"; filename*=UTF-8''${encodeURIComponent(safe)}.${ext}`;
}

const exportQuery = z.object({ sheetId: z.string().uuid().optional() });

/** IMPORTRANGE data for the editor: the reader needs view access to both workbooks. */
exportRouter.get(
  '/:id/import-range',
  h(async (req, res) => {
    const q = parse(z.object({ source: z.string().min(1).max(500), range: z.string().min(1).max(120) }), req.query);
    await requireCapability(req.user!.id, req.params.id as string, 'view');
    const values = await importRange(req.user!.id, q.source, q.range, req.params.id as string);
    res.json({ values });
  }),
);

exportRouter.get(
  '/:id/export/xlsx',
  h(async (req, res) => {
    const { workbook } = await requireCapability(req.user!.id, req.params.id as string, 'view');
    const buf = await exportXlsx(workbook.id, req.user!.id);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', filename(workbook.title, 'xlsx'));
    res.send(buf);
  }),
);

for (const [ext, delim, mime] of [
  ['csv', ',', 'text/csv'],
  ['tsv', '\t', 'text/tab-separated-values'],
] as const) {
  exportRouter.get(
    `/:id/export/${ext}`,
    h(async (req, res) => {
      const q = parse(exportQuery, req.query);
      const { workbook } = await requireCapability(req.user!.id, req.params.id as string, 'view');
      const out = await exportDelimited(workbook.id, q.sheetId, delim, req.user!.id);
      res.setHeader('Content-Type', `${mime}; charset=utf-8`);
      res.setHeader('Content-Disposition', filename(`${workbook.title} - ${out.title}`, ext));
      res.send(out.text);
    }),
  );
}

exportRouter.get(
  '/:id/export/pdf',
  h(async (req, res) => {
    const q = parse(exportQuery, req.query);
    const { workbook } = await requireCapability(req.user!.id, req.params.id as string, 'view');
    const buf = await exportPdf(workbook.id, workbook.title, q.sheetId, req.user!.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', filename(workbook.title, 'pdf'));
    res.send(buf);
  }),
);
