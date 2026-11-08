import ExcelJS from 'exceljs';
import { simpleParser } from 'mailparser';
import { SMTPServer } from 'smtp-server';
import http from 'node:http';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';

const app = createApp();

type Agent = ReturnType<typeof request.agent>;

function agent(): Agent {
  return request.agent(app);
}

const H = { 'x-opensheet-csrf': '1' };

async function register(a: Agent, name: string, email: string) {
  const r = await a.post('/api/auth/register').set(H).send({ name, email, password: 'rahasia-123' });
  expect(r.status).toBe(201);
  return r.body.user as { id: string; role: string };
}

let owner: Agent;
let editor: Agent;
let viewer: Agent;
let stranger: Agent;
let ownerUser: { id: string; role: string };
let workbookId: string;
let sheetId: string;

// A local SMTP server receives every email the API sends during the tests.
const mails: { to: string; subject: string; text: string }[] = [];
const smtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  onData(stream, session, cb) {
    simpleParser(stream).then((m) => {
      mails.push({ to: session.envelope.rcptTo.map((r) => r.address).join(','), subject: m.subject ?? '', text: m.text ?? '' });
      cb();
    }, cb);
  },
});

beforeAll(async () => {
  await new Promise<void>((r) => smtp.listen(2526, '127.0.0.1', r));
  owner = agent();
  editor = agent();
  viewer = agent();
  stranger = agent();
  ownerUser = await register(owner, 'Ani', 'ani@example.test');
  await register(editor, 'Budi', 'budi@example.test');
  await register(viewer, 'Citra', 'citra@example.test');
  await register(stranger, 'Dodi', 'dodi@example.test');
});

describe('auth', () => {
  it('first account is super admin, later ones are users', async () => {
    expect(ownerUser.role).toBe('super_admin');
    const me = await editor.get('/api/auth/me');
    expect(me.body.user.role).toBe('user');
  });
  it('rejects state-changing requests without the CSRF header', async () => {
    const r = await owner.post('/api/workbooks').send({});
    expect(r.status).toBe(403);
  });
  it('rejects wrong passwords and locks after repeated failures', async () => {
    const a = agent();
    for (let i = 0; i < 5; i++) {
      const r = await a.post('/api/auth/login').set(H).send({ email: 'dodi@example.test', password: 'salah-salah' });
      expect(r.status).toBe(401);
    }
    const locked = await a.post('/api/auth/login').set(H).send({ email: 'dodi@example.test', password: 'rahasia-123' });
    expect(locked.status).toBe(429);
  });
  it('logs in and out', async () => {
    const a = agent();
    expect((await a.post('/api/auth/login').set(H).send({ email: 'budi@example.test', password: 'rahasia-123', remember: true })).status).toBe(200);
    expect((await a.get('/api/auth/me')).status).toBe(200);
    expect((await a.post('/api/auth/logout').set(H)).status).toBe(200);
    expect((await a.get('/api/auth/me')).body.user).toBeNull();
  });
  it('resets a password with a one-time token', async () => {
    // Token is delivered by mail; here we create one directly through the API flow and read it from the DB.
    const { prisma } = await import('../src/db');
    const crypto = await import('node:crypto');
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'citra@example.test' } });
    const token = crypto.randomBytes(32).toString('base64url');
    await prisma.passwordReset.create({ data: { userId: user.id, tokenHash: crypto.createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 60_000) } });
    const r = await agent().post('/api/auth/reset-password').set(H).send({ token, password: 'sandi-baru-123' });
    expect(r.status).toBe(200);
    const again = await agent().post('/api/auth/reset-password').set(H).send({ token, password: 'sandi-baru-456' });
    expect(again.status).toBe(400);
    viewer = agent();
    expect((await viewer.post('/api/auth/login').set(H).send({ email: 'citra@example.test', password: 'sandi-baru-123' })).status).toBe(200);
  });
});

describe('workbooks and cells', () => {
  it('creates a workbook with one sheet', async () => {
    const r = await owner.post('/api/workbooks').set(H).send({ title: 'Anggaran 2026' });
    expect(r.status).toBe(201);
    workbookId = r.body.id;
    const wb = await owner.get(`/api/workbooks/${workbookId}`);
    expect(wb.body.sheets).toHaveLength(1);
    expect(wb.body.role).toBe('owner');
    sheetId = wb.body.sheets[0].id;
  });
  it('applies a batch and bumps the revision', async () => {
    const r = await owner.post(`/api/worksheets/${sheetId}/cells/batch`).set(H).send({
      baseRevision: 0,
      clientId: 'client-a',
      ops: [
        { sheetId, row: 0, col: 0, raw: '10' },
        { sheetId, row: 1, col: 0, raw: '20' },
        { sheetId, row: 2, col: 0, raw: '=SUM(A1:A2)', value: 30, style: { bold: true } },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.revision).toBe(1);
    const cells = await owner.get(`/api/worksheets/${sheetId}/range?range=A1:A3`);
    expect(cells.body.cells.map((c: { raw: string }) => c.raw)).toEqual(['10', '20', '=SUM(A1:A2)']);
    expect(cells.body.cells[2].style).toEqual({ bold: true });
    expect(cells.body.cells[2].value).toBe(30);
  });
  it('accepts a stale batch that touches other cells', async () => {
    const r = await owner.post(`/api/worksheets/${sheetId}/cells/batch`).set(H).send({ baseRevision: 0, clientId: 'client-b', ops: [{ sheetId, row: 5, col: 5, raw: 'x' }] });
    expect(r.status).toBe(200);
    expect(r.body.revision).toBe(2);
  });
  it('detects a conflict on the same cell', async () => {
    const r = await owner.post(`/api/worksheets/${sheetId}/cells/batch`).set(H).send({ baseRevision: 0, clientId: 'client-b', ops: [{ sheetId, row: 0, col: 0, raw: '99' }] });
    expect(r.status).toBe(409);
    expect(r.body.details.cells).toEqual([{ sheetId, row: 0, col: 0 }]);
  });
  it('stores cells sparsely and deletes cleared ones', async () => {
    const r = await owner.post(`/api/worksheets/${sheetId}/cells/batch`).set(H).send({ baseRevision: 2, clientId: 'client-a', ops: [{ sheetId, row: 5, col: 5, raw: '' }] });
    expect(r.status).toBe(200);
    const { prisma } = await import('../src/db');
    expect(await prisma.cell.count({ where: { worksheetId: sheetId } })).toBe(3);
  });
});

describe('permissions', () => {
  it('hides the workbook from users without access', async () => {
    expect((await stranger.get(`/api/workbooks/${workbookId}`)).status).toBe(404);
  });
  it('shares as viewer and editor', async () => {
    expect((await owner.post(`/api/workbooks/${workbookId}/share`).set(H).send({ email: 'citra@example.test', permission: 'viewer' })).status).toBe(201);
    expect((await owner.post(`/api/workbooks/${workbookId}/share`).set(H).send({ email: 'budi@example.test', permission: 'editor' })).status).toBe(201);
    const v = await viewer.get(`/api/workbooks/${workbookId}`);
    expect(v.body.role).toBe('viewer');
    expect(v.body.can.edit).toBe(false);
  });
  it('viewer cannot edit, editor can', async () => {
    const op = { baseRevision: 3, clientId: 'client-c', ops: [{ sheetId, row: 9, col: 0, raw: 'hai' }] };
    expect((await viewer.post(`/api/worksheets/${sheetId}/cells/batch`).set(H).send(op)).status).toBe(403);
    expect((await editor.post(`/api/worksheets/${sheetId}/cells/batch`).set(H).send(op)).status).toBe(200);
  });
  it('editor cannot share', async () => {
    expect((await editor.post(`/api/workbooks/${workbookId}/share`).set(H).send({ email: 'dodi@example.test', permission: 'viewer' })).status).toBe(403);
  });
  it('protected ranges block editors who are not listed', async () => {
    expect((await owner.put(`/api/worksheets/${sheetId}/protected-ranges`).set(H).send({ items: [{ range: 'A1:A3', editorIds: [] }] })).status).toBe(200);
    const r = await editor.post(`/api/worksheets/${sheetId}/cells/batch`).set(H).send({ baseRevision: 4, clientId: 'client-c', ops: [{ sheetId, row: 0, col: 0, raw: '1' }] });
    expect(r.status).toBe(403);
    await owner.put(`/api/worksheets/${sheetId}/protected-ranges`).set(H).send({ items: [] });
  });
  it('whole-sheet protection can leave some ranges open', async () => {
    const put = await owner.put(`/api/worksheets/${sheetId}/protected-ranges`).set(H).send({ items: [{ range: null, editorIds: [], exceptRanges: ['B1:B3'] }] });
    expect(put.status).toBe(200);
    expect(put.body.sheet.protectedRanges[0].exceptRanges).toEqual(['B1:B3']);
    const blocked = await editor.post(`/api/worksheets/${sheetId}/cells/batch`).set(H).send({ baseRevision: 4, clientId: 'client-c', ops: [{ sheetId, row: 0, col: 0, raw: '1' }] });
    expect(blocked.status).toBe(403);
    const mixed = await editor.post(`/api/worksheets/${sheetId}/cells/batch`).set(H).send({ baseRevision: 4, clientId: 'client-c', ops: [{ sheetId, row: 1, col: 1, raw: 'x' }, { sheetId, row: 5, col: 5, raw: 'y' }] });
    expect(mixed.status).toBe(403);
    // A write that stays inside the exception goes through. Read the current revision first.
    const rev = (await owner.get(`/api/workbooks/${workbookId}`)).body.workbook.revision;
    const allowed = await editor.post(`/api/worksheets/${sheetId}/cells/batch`).set(H).send({ baseRevision: Number(rev), clientId: 'client-c', ops: [{ sheetId, row: 1, col: 1, raw: 'ok' }] });
    expect(allowed.status).toBe(200);
    // The owner is never limited, and an invalid exception range is rejected.
    expect((await owner.put(`/api/worksheets/${sheetId}/protected-ranges`).set(H).send({ items: [{ range: null, editorIds: [], exceptRanges: ['nope'] }] })).status).toBe(400);
    await owner.put(`/api/worksheets/${sheetId}/protected-ranges`).set(H).send({ items: [] });
  });
  it('charts are stored with the sheet and validated', async () => {
    const chart = { id: 'c1', type: 'column', title: 'Uji', range: 'A1:B4', headerRow: true, headerCol: true, seriesIn: 'cols', stacked: false, legend: 'bottom', row: 0, col: 3, dx: 8, dy: 8, w: 480, h: 300 };
    const ok = await owner.patch(`/api/worksheets/${sheetId}`).set(H).send({ metadata: { charts: [chart] } });
    expect(ok.status).toBe(200);
    expect(ok.body.sheet.metadata.charts[0].range).toBe('A1:B4');
    expect((await owner.patch(`/api/worksheets/${sheetId}`).set(H).send({ metadata: { charts: [{ ...chart, type: 'radar' }] } })).status).toBe(400);
    expect((await owner.patch(`/api/worksheets/${sheetId}`).set(H).send({ metadata: { charts: [{ ...chart, w: 10 }] } })).status).toBe(400);
    expect((await viewer.patch(`/api/worksheets/${sheetId}`).set(H).send({ metadata: { charts: [] } })).status).toBe(403);
    await owner.patch(`/api/worksheets/${sheetId}`).set(H).send({ metadata: { charts: [] } });
  });
  it('feed keys give read-only access to values for other tools', async () => {
    expect((await editor.post(`/api/workbooks/${workbookId}/feed-tokens`).set(H).send({ label: 'x' })).status).toBe(403);
    const made = await owner.post(`/api/workbooks/${workbookId}/feed-tokens`).set(H).send({ label: 'Google Sheets' });
    expect(made.status).toBe(201);
    const token: string = made.body.token;
    expect(token.startsWith('osf_')).toBe(true);
    // The list never shows the key itself.
    const list = await owner.get(`/api/workbooks/${workbookId}/feed-tokens`);
    expect(JSON.stringify(list.body)).not.toContain(token);
    // No session needed: a bare client with the key reads CSV, by header or by query.
    const bare = request(app);
    const byHeader = await bare.get(`/api/feed/${workbookId}`).set('Authorization', `Bearer ${token}`);
    expect(byHeader.status).toBe(200);
    expect(byHeader.headers['content-type']).toContain('text/csv');
    expect(byHeader.text.length).toBeGreaterThan(0);
    const byQuery = await bare.get(`/api/feed/${workbookId}?token=${token}&format=json&range=A1:B2`);
    expect(byQuery.status).toBe(200);
    expect(byQuery.body.values.length).toBeLessThanOrEqual(2);
    expect(byQuery.body.values[0].length).toBeLessThanOrEqual(2);
    // Unchanged data answers 304 for a caller that sends the ETag back.
    const etag = byQuery.headers.etag;
    expect((await bare.get(`/api/feed/${workbookId}?token=${token}&format=json&range=A1:B2`).set('If-None-Match', etag)).status).toBe(304);
    // Wrong key, missing key, bad range and a key used on another workbook are all refused.
    expect((await bare.get(`/api/feed/${workbookId}?token=osf_nope`)).status).toBe(401);
    expect((await bare.get(`/api/feed/${workbookId}`)).status).toBe(401);
    expect((await bare.get(`/api/feed/${workbookId}?token=${token}&range=zz`)).status).toBe(400);
    expect((await bare.get(`/api/feed/00000000-0000-4000-8000-000000000000?token=${token}`)).status).toBe(401);
    // Revoking stops it at once.
    expect((await owner.delete(`/api/workbooks/${workbookId}/feed-tokens/${made.body.item.id}`).set(H)).status).toBe(200);
    expect((await bare.get(`/api/feed/${workbookId}`).set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });
  it('revoking access removes it', async () => {
    const list = await owner.get(`/api/workbooks/${workbookId}/permissions`);
    const p = list.body.permissions.find((x: { user: { email: string } }) => x.user.email === 'citra@example.test');
    expect((await owner.delete(`/api/workbooks/${workbookId}/permissions/${p.id}`).set(H)).status).toBe(200);
    expect((await viewer.get(`/api/workbooks/${workbookId}`)).status).toBe(404);
  });
  it('link sharing grants view to any signed-in user', async () => {
    await owner.patch(`/api/workbooks/${workbookId}/link`).set(H).send({ linkAccess: 'view' });
    expect((await stranger.get(`/api/workbooks/${workbookId}`)).body.role).toBe('viewer');
    await owner.patch(`/api/workbooks/${workbookId}/link`).set(H).send({ linkAccess: 'restricted' });
    expect((await stranger.get(`/api/workbooks/${workbookId}`)).status).toBe(404);
  });
  it('a regular user cannot reach admin endpoints', async () => {
    expect((await editor.get('/api/admin/users')).status).toBe(403);
    expect((await owner.get('/api/admin/users')).status).toBe(200);
  });
});

describe('history', () => {
  it('lists revisions and restores an earlier one', async () => {
    const list = await owner.get(`/api/workbooks/${workbookId}/revisions`);
    expect(list.body.revisions.length).toBeGreaterThanOrEqual(4);
    const first = list.body.revisions.find((r: { revision: number }) => r.revision === 1);
    const detail = await owner.get(`/api/workbooks/${workbookId}/revisions/${first.id}`);
    expect(detail.body.changes[0]).toMatchObject({ cell: 'A1', before: '', after: '10' });
    const restore = await owner.post(`/api/workbooks/${workbookId}/revisions/${first.id}/restore`).set(H).send({});
    expect(restore.status).toBe(200);
    const cells = await owner.get(`/api/worksheets/${sheetId}/range`);
    expect(cells.body.cells.map((c: { raw: string }) => c.raw)).toEqual(['10', '20', '=SUM(A1:A2)']);
  });
});

describe('import and export', () => {
  it('imports CSV into a new workbook and exports it back', async () => {
    const csv = 'nama,nilai\nAni,80\nBudi,90\n,=SUM(B2:B3)\n';
    const r = await owner.post('/api/import/csv').set(H).attach('file', Buffer.from(csv), 'nilai.csv');
    expect(r.status).toBe(201);
    const wb = await owner.get(`/api/workbooks/${r.body.id}`);
    expect(wb.body.workbook.title).toBe('nilai');
    const out = await owner.get(`/api/workbooks/${r.body.id}/export/csv`);
    expect(out.text.replace('﻿', '')).toBe('nama,nilai\r\nAni,80\r\nBudi,90\r\n,170');
  });
  it('rejects a binary file posing as CSV', async () => {
    const r = await owner.post('/api/import/csv').set(H).attach('file', Buffer.from([0, 1, 2, 3]), 'x.csv');
    expect(r.status).toBe(400);
  });
  it('round-trips XLSX with formulas, formats and merges', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Data');
    ws.getCell('A1').value = 'Judul';
    ws.getCell('A1').font = { bold: true };
    ws.mergeCells('A1:B1');
    ws.getCell('A2').value = 5;
    ws.getCell('B2').value = { formula: 'A2*2', result: 10 };
    ws.getCell('C2').value = 0.25;
    ws.getCell('C2').numFmt = '0.00%';
    ws.getColumn(1).width = 20;
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await owner.post('/api/import/xlsx').set(H).attach('file', buf, 'laporan.xlsx');
    expect(r.status).toBe(201);
    const meta = await owner.get(`/api/workbooks/${r.body.id}`);
    const sheet = meta.body.sheets[0];
    expect(sheet.title).toBe('Data');
    expect(sheet.metadata.merges).toEqual([{ r1: 0, c1: 0, r2: 0, c2: 1 }]);
    expect(sheet.metadata.colWidths['0']).toBe(145);
    const cells = await owner.get(`/api/worksheets/${sheet.id}/range`);
    const b2 = cells.body.cells.find((c: { row: number; col: number }) => c.row === 1 && c.col === 1);
    expect(b2).toMatchObject({ raw: '=A2*2', value: 10 });
    const out = await owner.get(`/api/workbooks/${r.body.id}/export/xlsx`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(out.status).toBe(200);
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(out.body);
    const bs = back.getWorksheet('Data')!;
    expect(bs.getCell('B2').formula).toBe('A2*2');
    expect(bs.getCell('A1').font?.bold).toBe(true);
    expect(bs.getCell('C2').numFmt).toBe('0.00%');
    expect((bs as unknown as { model: { merges: string[] } }).model.merges).toContain('A1:B1');
  });
  it('exports PDF', async () => {
    const r = await owner.get(`/api/workbooks/${workbookId}/export/pdf`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
  });
});

describe('dashboard', () => {
  it('lists owned, shared, starred and trashed workbooks', async () => {
    await editor.get(`/api/workbooks/${workbookId}`);
    await editor.patch(`/api/workbooks/${workbookId}`).set(H).send({ starred: true });
    expect((await editor.get('/api/workbooks?view=shared')).body.items.map((i: { id: string }) => i.id)).toContain(workbookId);
    expect((await editor.get('/api/workbooks?view=starred')).body.items).toHaveLength(1);
    expect((await editor.get('/api/workbooks?view=recent')).body.items.map((i: { id: string }) => i.id)).toContain(workbookId);
    const dup = await owner.post(`/api/workbooks/${workbookId}/duplicate`).set(H).send({});
    expect(dup.status).toBe(201);
    await owner.delete(`/api/workbooks/${dup.body.id}`).set(H);
    expect((await owner.get('/api/workbooks?view=trash')).body.items.map((i: { id: string }) => i.id)).toEqual([dup.body.id]);
    await owner.post(`/api/workbooks/${dup.body.id}/restore`).set(H);
    expect((await owner.get('/api/workbooks?view=trash')).body.items).toHaveLength(0);
    expect((await owner.get('/api/workbooks?q=salinan')).body.items).toHaveLength(1);
  });
  it('renaming a sheet rewrites formulas that reference it', async () => {
    const add = await owner.post(`/api/workbooks/${workbookId}/worksheets`).set(H).send({ title: 'Ringkasan' });
    const s2 = add.body.sheet.id;
    const wb = await owner.get(`/api/workbooks/${workbookId}`);
    await owner.post(`/api/worksheets/${s2}/cells/batch`).set(H).send({ baseRevision: wb.body.workbook.revision, clientId: 'client-c', ops: [{ sheetId: s2, row: 0, col: 0, raw: '=Sheet1!A3*2' }] });
    const r = await owner.patch(`/api/worksheets/${sheetId}`).set(H).send({ title: 'Data Utama' });
    expect(r.status).toBe(200);
    const cells = await owner.get(`/api/worksheets/${s2}/range`);
    expect(cells.body.cells[0].raw).toBe("='Data Utama'!A3*2");
    expect(cells.body.cells[0].value).toBe(60);
  });
});

describe('array formulas and IMPORTRANGE', () => {
  let src: string;
  let dst: string;
  let dstSheet: string;
  it('reads another workbook only with access to it', async () => {
    src = (await owner.post('/api/workbooks').set(H).send({ title: 'Sumber' })).body.id;
    const srcSheet = (await owner.get(`/api/workbooks/${src}`)).body.sheets[0].id;
    await owner.post(`/api/worksheets/${srcSheet}/cells/batch`).set(H).send({
      baseRevision: 0,
      clientId: 'client-src',
      ops: [
        { sheetId: srcSheet, row: 0, col: 0, raw: '1' },
        { sheetId: srcSheet, row: 1, col: 0, raw: '2' },
        { sheetId: srcSheet, row: 0, col: 1, raw: '=A1*10' },
      ],
    });
    dst = (await owner.post('/api/workbooks').set(H).send({ title: 'Tujuan' })).body.id;
    dstSheet = (await owner.get(`/api/workbooks/${dst}`)).body.sheets[0].id;
    const r = await owner.get(`/api/workbooks/${dst}/import-range`).query({ source: `http://x/w/${src}`, range: 'Sheet1!A1:B2' });
    expect(r.status).toBe(200);
    expect(r.body.values).toEqual([
      [1, 10],
      [2, null],
    ]);
    // Editor of the destination without access to the source is refused.
    await owner.post(`/api/workbooks/${dst}/share`).set(H).send({ email: 'budi@example.test', permission: 'editor' });
    const denied = await editor.get(`/api/workbooks/${dst}/import-range`).query({ source: src, range: 'A1:B2' });
    expect(denied.status).toBe(403);
  });
  it('exports spilled values to CSV and as an array formula to XLSX', async () => {
    await owner.post(`/api/worksheets/${dstSheet}/cells/batch`).set(H).send({
      baseRevision: 0,
      clientId: 'client-dst',
      ops: [
        { sheetId: dstSheet, row: 0, col: 0, raw: `=IMPORTRANGE("${src}","Sheet1!A1:A2")` },
        { sheetId: dstSheet, row: 0, col: 2, raw: '=SEQUENCE(2,1,5)' },
      ],
    });
    const csv = await owner.get(`/api/workbooks/${dst}/export/csv`);
    expect(csv.text.replace('﻿', '')).toBe('1,,5\r\n2,,6');
    const out = await owner.get(`/api/workbooks/${dst}/export/xlsx`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(out.body);
    const ws = back.worksheets[0];
    expect(ws.getCell('C1').formula).toBe('SEQUENCE(2,1,5)');
    expect(ws.getCell('C2').value).toBe(6);
  });
});

describe('row and column structure', () => {
  let wb: string;
  let sh: string;
  let rev = 0;
  it('inserts a row above 60,000 cells and rewrites formulas', async () => {
    wb = (await owner.post('/api/workbooks').set(H).send({ title: 'Besar' })).body.id;
    sh = (await owner.get(`/api/workbooks/${wb}`)).body.sheets[0].id;
    const ops = [];
    for (let r = 0; r < 20_000; r++) ops.push({ sheetId: sh, row: r, col: 0, raw: String(r + 1) }, { sheetId: sh, row: r, col: 1, raw: 'x' }, { sheetId: sh, row: r, col: 2, raw: 'y' });
    rev = (await owner.post(`/api/worksheets/${sh}/cells/batch`).set(H).send({ baseRevision: 0, clientId: 'client-big', ops: ops.slice(0, 50_000) })).body.revision;
    rev = (await owner.post(`/api/worksheets/${sh}/cells/batch`).set(H).send({ baseRevision: rev, clientId: 'client-big', ops: ops.slice(50_000) })).body.revision;
    rev = (await owner.post(`/api/worksheets/${sh}/cells/batch`).set(H).send({ baseRevision: rev, clientId: 'client-big', ops: [{ sheetId: sh, row: 0, col: 3, raw: '=SUM(A1:A20000)' }] })).body.revision;
    const t = Date.now();
    const r = await owner.post(`/api/worksheets/${sh}/structure`).set(H).send({ axis: 'row', index: 0, count: 1, clientId: 'client-big' });
    expect(r.status).toBe(200);
    expect(Date.now() - t).toBeLessThan(5000);
    const top = await owner.get(`/api/worksheets/${sh}/range?range=A1:D2`);
    expect(top.body.cells.map((c: { row: number; col: number; raw: string }) => `${c.row}:${c.col}=${c.raw}`)).toEqual(['1:0=1', '1:1=x', '1:2=y', '1:3==SUM(A2:A20001)']);
  });
  it('rejects a batch made before the rows moved', async () => {
    const stale = await editor.post(`/api/worksheets/${sh}/cells/batch`).set(H).send({ baseRevision: rev, clientId: 'client-other', ops: [{ sheetId: sh, row: 5, col: 5, raw: 'telat' }] });
    // budi has no access here; share first, then retry as an editor of this workbook
    expect([403, 404]).toContain(stale.status);
    await owner.post(`/api/workbooks/${wb}/share`).set(H).send({ email: 'budi@example.test', permission: 'editor' });
    const again = await editor.post(`/api/worksheets/${sh}/cells/batch`).set(H).send({ baseRevision: rev, clientId: 'client-other', ops: [{ sheetId: sh, row: 5, col: 5, raw: 'telat' }] });
    expect(again.status).toBe(409);
  });
  it('deletes columns and history can restore the state before', async () => {
    const del = await owner.post(`/api/worksheets/${sh}/structure`).set(H).send({ axis: 'col', index: 1, count: -2, clientId: 'client-big' });
    expect(del.status).toBe(200);
    const after = await owner.get(`/api/worksheets/${sh}/range?range=A2:D2`);
    expect(after.body.cells.map((c: { col: number; raw: string }) => `${c.col}=${c.raw}`)).toEqual(['0=1', '1==SUM(A2:A20001)']);
    const list = await owner.get(`/api/workbooks/${wb}/revisions`);
    const beforeDelete = list.body.revisions.find((x: { label: string }) => x.label === 'Sisipkan 1 baris');
    const res = await owner.post(`/api/workbooks/${wb}/revisions/${beforeDelete.id}/restore`).set(H).send({});
    expect(res.status).toBe(200);
    const back = await owner.get(`/api/worksheets/${sh}/range?range=A2:D2`);
    expect(back.body.cells.map((c: { col: number; raw: string }) => `${c.col}=${c.raw}`)).toEqual(['0=1', '1=x', '2=y', '3==SUM(A2:A20001)']);
  });
});

describe('ODS', () => {
  it('exports and re-imports formulas, values, styles and merges', async () => {
    const id = (await owner.post('/api/workbooks').set(H).send({ title: 'Ods' })).body.id;
    const sh = (await owner.get(`/api/workbooks/${id}`)).body.sheets[0].id;
    await owner.post(`/api/worksheets/${sh}/cells/batch`).set(H).send({
      baseRevision: 0,
      clientId: 'client-ods',
      ops: [
        { sheetId: sh, row: 0, col: 0, raw: 'Judul', style: { bold: true, backgroundColor: '#D9EAD3' } },
        { sheetId: sh, row: 1, col: 0, raw: '4' },
        { sheetId: sh, row: 2, col: 0, raw: '6' },
        { sheetId: sh, row: 3, col: 0, raw: '=SUM(A2:A3)' },
        { sheetId: sh, row: 3, col: 1, raw: '=IF(A4>5,"besar","kecil")' },
        { sheetId: sh, row: 4, col: 0, raw: '07/11/2026', style: { numberFormat: 'date' } },
      ],
    });
    await owner.patch(`/api/worksheets/${sh}`).set(H).send({ metadata: { merges: [{ r1: 0, c1: 0, r2: 0, c2: 1 }], colWidths: { 0: 150 } } });
    const out = await owner.get(`/api/workbooks/${id}/export/ods`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(out.status).toBe(200);
    expect(out.headers['content-type']).toBe('application/vnd.oasis.opendocument.spreadsheet');
    const imp = await owner.post('/api/import/ods').set(H).attach('file', out.body, 'salinan.ods');
    expect(imp.status).toBe(201);
    const meta = await owner.get(`/api/workbooks/${imp.body.id}`);
    const sheet = meta.body.sheets[0];
    expect(sheet.metadata.merges).toEqual([{ r1: 0, c1: 0, r2: 0, c2: 1 }]);
    expect(sheet.metadata.colWidths['0']).toBe(150);
    const cells = await owner.get(`/api/worksheets/${sheet.id}/range`);
    const at = (r: number, c: number) => cells.body.cells.find((x: { row: number; col: number }) => x.row === r && x.col === c);
    expect(at(0, 0)).toMatchObject({ raw: 'Judul', style: { bold: true, backgroundColor: '#D9EAD3' } });
    expect(at(3, 0)).toMatchObject({ raw: '=SUM(A2:A3)', value: 10 });
    expect(at(3, 1)).toMatchObject({ raw: '=IF(A4>5,"besar","kecil")', value: 'besar' });
    expect(at(4, 0).style.numberFormat).toBe('date');
  });
});

describe('guest access by link', () => {
  it('is off by default, read-only when enabled, and never writes', async () => {
    const id = (await owner.post('/api/workbooks').set(H).send({ title: 'Publik' })).body.id;
    const guest = request.agent(app);
    await owner.patch(`/api/workbooks/${id}/link`).set(H).send({ linkAccess: 'edit' });
    expect((await guest.get(`/api/workbooks/${id}`)).status).toBe(404);
    await owner.patch('/api/admin/settings').set(H).send({ guestLinkEnabled: true });
    const meta = await guest.get(`/api/workbooks/${id}`);
    expect(meta.status).toBe(200);
    expect(meta.body.role).toBe('viewer');
    expect((await guest.get(`/api/workbooks/${id}/cells`)).status).toBe(200);
    expect((await guest.get(`/api/workbooks/${id}/export/csv`)).status).toBe(200);
    const sheet = meta.body.sheets[0].id;
    expect((await guest.post(`/api/worksheets/${sheet}/cells/batch`).set(H).send({ baseRevision: 0, clientId: 'guest-1', ops: [{ sheetId: sheet, row: 0, col: 0, raw: 'x' }] })).status).toBe(401);
    expect((await guest.get('/api/workbooks')).status).toBe(401);
    expect((await guest.get(`/api/workbooks/${id}/revisions`)).status).toBe(401);
    await owner.patch(`/api/workbooks/${id}/link`).set(H).send({ linkAccess: 'restricted' });
    expect((await guest.get(`/api/workbooks/${id}`)).status).toBe(404);
    await owner.patch('/api/admin/settings').set(H).send({ guestLinkEnabled: false });
  });
});

describe('original upload storage', () => {
  it('keeps the imported file and serves it back only as a download', async () => {
    const csv = Buffer.from('a,b\n1,2\n');
    const imp = await owner.post('/api/import/csv').set(H).attach('file', csv, 'asli.csv');
    const files = await owner.get(`/api/workbooks/${imp.body.id}/files`);
    expect(files.body.files).toHaveLength(1);
    expect(files.body.files[0].filename).toBe('asli.csv');
    const dl = await owner.get(`/api/workbooks/${imp.body.id}/files/${files.body.files[0].id}`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(dl.headers['content-type']).toBe('application/octet-stream');
    expect(dl.headers['content-disposition']).toMatch(/^attachment/);
    expect(Buffer.compare(dl.body, csv)).toBe(0);
    expect((await stranger.get(`/api/workbooks/${imp.body.id}/files/${files.body.files[0].id}`)).status).toBe(404);
  });
});

describe('email', () => {
  it('sends a working password-reset link by SMTP', async () => {
    const before = mails.length;
    expect((await agent().post('/api/auth/forgot-password').set(H).send({ email: 'dodi@example.test' })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    const mail = mails.slice(before).find((m) => m.to === 'dodi@example.test');
    expect(mail?.subject).toBe('Atur ulang kata sandi OpenSheet');
    const token = /reset-password\?token=([\w-]+)/.exec(mail!.text)![1];
    expect((await agent().post('/api/auth/reset-password').set(H).send({ token, password: 'dari-email-123' })).status).toBe(200);
    const login = await agent().post('/api/auth/login').set(H).send({ email: 'dodi@example.test', password: 'dari-email-123' });
    expect(login.status).toBe(200);
  });
  it('emails an invitation to someone without an account', async () => {
    const id = (await owner.post('/api/workbooks').set(H).send({ title: 'Undangan' })).body.id;
    const before = mails.length;
    await owner.post(`/api/workbooks/${id}/share`).set(H).send({ email: 'baru@example.test', permission: 'viewer', message: 'Mohon dicek' });
    await new Promise((r) => setTimeout(r, 300));
    const mail = mails.slice(before).find((m) => m.to === 'baru@example.test');
    expect(mail?.text).toContain('Mohon dicek');
    expect(mail?.text).toContain(`/w/${id}`);
  });
});

describe('thumbnail', () => {
  it('draws values, escapes text, answers 304 when unchanged, and needs access', async () => {
    const id = (await owner.post('/api/workbooks').set(H).send({ title: 'Mini' })).body.id;
    const sh = (await owner.get(`/api/workbooks/${id}`)).body.sheets[0].id;
    await owner.post(`/api/worksheets/${sh}/cells/batch`).set(H).send({
      baseRevision: 0,
      clientId: 'client-th',
      ops: [
        { sheetId: sh, row: 0, col: 0, raw: '<script>alert(1)</script>', style: { bold: true, backgroundColor: '#D9EAD3' } },
        { sheetId: sh, row: 1, col: 0, raw: '1500', style: { numberFormat: 'currency' } },
        { sheetId: sh, row: 2, col: 0, raw: '=A2*2', value: 3000 },
      ],
    });
    const r = await owner.get(`/api/workbooks/${id}/thumbnail`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
    });
    const svg = r.body as string;
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/image\/svg\+xml/);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('Rp1,500');
    expect(svg).toContain('3000'); // formula result
    expect(svg).toContain('#D9EAD3');
    const again = await owner.get(`/api/workbooks/${id}/thumbnail`).set('If-None-Match', r.headers.etag);
    expect(again.status).toBe(304);
    const outsider = agent();
    await register(outsider, 'Orang Luar', 'luar@example.test');
    expect((await outsider.get(`/api/workbooks/${id}/thumbnail`)).status).toBe(404);
  });
});

// A stand-in for Google: the token endpoint checks the PKCE verifier and client secret,
// and the profile returned depends on the code that was exchanged.
const googleProfiles: Record<string, Record<string, unknown>> = {
  'code-new': { sub: 'g-111', email: 'Baru.Google@example.test', email_verified: true, name: 'Gita Google' },
  'code-unverified': { sub: 'g-222', email: 'palsu@example.test', email_verified: false, name: 'Palsu' },
  'code-existing': { sub: 'g-333', email: 'citra@example.test', email_verified: true, name: 'Citra Dewi' },
};
let lastChallenge = '';
const googleMock = http.createServer((req, res) => {
  if (req.url?.startsWith('/token')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const p = new URLSearchParams(body);
      const crypto = require('node:crypto') as typeof import('node:crypto');
      const challenge = crypto.createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url');
      if (p.get('client_secret') !== 'test-secret' || challenge !== lastChallenge || !googleProfiles[p.get('code') ?? '']) {
        res.writeHead(400).end('{"error":"invalid_grant"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: `at-${p.get('code')}` }));
    });
    return;
  }
  if (req.url?.startsWith('/userinfo')) {
    const profile = googleProfiles[(req.headers.authorization ?? '').replace('Bearer at-', '')];
    res.writeHead(profile ? 200 : 401, { 'content-type': 'application/json' }).end(JSON.stringify(profile ?? {}));
    return;
  }
  res.writeHead(404).end();
});

describe('sign in with Google', () => {
  beforeAll(async () => {
    await new Promise<void>((r) => googleMock.listen(2527, '127.0.0.1', r));
  });

  async function start(a: Agent, next = '/w/abc') {
    const r = await a.get('/api/auth/google').query({ next });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.location);
    expect(loc.origin + loc.pathname).toBe('http://127.0.0.1:2527/auth');
    expect(loc.searchParams.get('client_id')).toBe('test-client');
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('redirect_uri')).toBe('http://localhost:5173/api/auth/google/callback');
    lastChallenge = loc.searchParams.get('code_challenge')!;
    return loc.searchParams.get('state')!;
  }

  it('advertises Google when configured', async () => {
    expect((await agent().get('/api/auth/config')).body.googleEnabled).toBe(true);
  });
  it('creates an account, signs in and returns to the requested page', async () => {
    const a = agent();
    const state = await start(a);
    const cb = await a.get('/api/auth/google/callback').query({ code: 'code-new', state });
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('http://localhost:5173/w/abc');
    const me = await a.get('/api/auth/me');
    expect(me.body.user).toMatchObject({ name: 'Gita Google', email: 'baru.google@example.test', role: 'user' });
    // The same Google account signs back in to the same user.
    const again = agent();
    const s2 = await start(again);
    await again.get('/api/auth/google/callback').query({ code: 'code-new', state: s2 });
    expect((await again.get('/api/auth/me')).body.user.id).toBe(me.body.user.id);
  });
  it('refuses a wrong state, a missing cookie and an unverified email', async () => {
    const a = agent();
    await start(a);
    const bad = await a.get('/api/auth/google/callback').query({ code: 'code-new', state: 'bukan-state' });
    expect(bad.headers.location).toContain('/login?error=google_state');
    expect((await a.get('/api/auth/me')).body.user).toBeNull();
    const noCookie = await agent().get('/api/auth/google/callback').query({ code: 'code-new', state: 'x' });
    expect(noCookie.headers.location).toContain('error=google_state');
    const b = agent();
    const state = await start(b);
    const unv = await b.get('/api/auth/google/callback').query({ code: 'code-unverified', state });
    expect(unv.headers.location).toContain('error=google_unverified');
    const c = agent();
    const s3 = await start(c);
    const denied = await c.get('/api/auth/google/callback').query({ error: 'access_denied', state: s3 });
    expect(denied.headers.location).toContain('error=google_denied');
  });
  it('rejects a code exchanged without the matching PKCE verifier', async () => {
    const a = agent();
    const state = await start(a);
    lastChallenge = 'tidak-cocok';
    const r = await a.get('/api/auth/google/callback').query({ code: 'code-new', state });
    expect(r.headers.location).toContain('error=google_failed');
  });
  it('links an existing password account and retires its old password and sessions', async () => {
    const pwSession = agent();
    expect((await pwSession.post('/api/auth/login').set(H).send({ email: 'citra@example.test', password: 'sandi-baru-123' })).status).toBe(200);
    const a = agent();
    const state = await start(a, '/');
    const cb = await a.get('/api/auth/google/callback').query({ code: 'code-existing', state });
    expect(cb.headers.location).toBe('http://localhost:5173/');
    expect((await a.get('/api/auth/me')).body.user.email).toBe('citra@example.test');
    expect((await pwSession.get('/api/auth/me')).body.user).toBeNull(); // old session ended
    expect((await agent().post('/api/auth/login').set(H).send({ email: 'citra@example.test', password: 'sandi-baru-123' })).status).toBe(401);
  });
  it('does not allow open redirects through next', async () => {
    const a = agent();
    const state = await start(a, '//evil.example/steal');
    const cb = await a.get('/api/auth/google/callback').query({ code: 'code-new', state });
    expect(cb.headers.location).toBe('http://localhost:5173/');
  });
});
