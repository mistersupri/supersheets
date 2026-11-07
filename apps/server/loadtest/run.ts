/**
 * Simulates N concurrent users against a running OpenSheet server.
 *   BASE=http://localhost:3000 npx tsx loadtest/run.ts 500 60
 * Each virtual user logs in, loads the dashboard, opens its workbook (meta and
 * all cells), joins the realtime room, then for DURATION seconds sends a
 * selection update every second and a cell edit every 3 to 6 seconds.
 * Reports latency percentiles, error counts and realtime delivery delay.
 */
import { io, type Socket } from 'socket.io-client';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const N = Number(process.argv[2] ?? 500);
const DURATION = Number(process.argv[3] ?? 60) * 1000;
const RAMP = Number(process.env.RAMP_MS ?? 10_000);
const EDIT_MIN = Number(process.env.EDIT_MIN_MS ?? 3000);
const EDIT_JITTER = Number(process.env.EDIT_JITTER_MS ?? 3000);

const lat: Record<string, number[]> = {};
const errors: Record<string, number> = {};
const deliveries: number[] = [];
let conflicts = 0;
let edits = 0;
let connected = 0;
let peak = 0;

function rec(name: string, ms: number) {
  (lat[name] ??= []).push(ms);
}
function fail(name: string, detail: string) {
  const k = `${name}: ${detail}`;
  errors[k] = (errors[k] ?? 0) + 1;
}
function pct(a: number[], p: number) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function call(name: string, cookie: string, method: string, path: string, body?: unknown) {
  const t = performance.now();
  const res = await fetch(BASE + path, {
    method,
    headers: { cookie, 'x-opensheet-csrf': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  rec(name, performance.now() - t);
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { res, data };
}

async function user(i: number) {
  await new Promise((r) => setTimeout(r, (i / N) * RAMP));
  const email = `lt${String(i + 1).padStart(4, '0')}@loadtest.local`;
  const t0 = performance.now();
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-opensheet-csrf': '1' },
    body: JSON.stringify({ email, password: 'loadtest-123' }),
  });
  rec('login', performance.now() - t0);
  if (!login.ok) return fail('login', String(login.status));
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

  const list = await call('dashboard', cookie, 'GET', '/api/workbooks?view=all');
  if (!list.res.ok) return fail('dashboard', String(list.res.status));
  const wb = list.data.items.find((w: { title: string }) => w.title.startsWith('LT '));
  if (!wb) return fail('dashboard', 'no workbook');
  const meta = await call('open_meta', cookie, 'GET', `/api/workbooks/${wb.id}`);
  const cells = await call('open_cells', cookie, 'GET', `/api/workbooks/${wb.id}/cells`);
  if (!meta.res.ok || !cells.res.ok) return fail('open', `${meta.res.status}/${cells.res.status}`);
  const sheetId = meta.data.sheets[0].id;
  let revision = Number(cells.data.revision);

  const socket: Socket = io(BASE, { transports: ['websocket'], extraHeaders: { cookie }, reconnection: true });
  const clientId = `lt-${i}-${Math.random().toString(36).slice(2, 8)}`;
  await new Promise<void>((resolve) => {
    const tj = performance.now();
    socket.once('connect', () =>
      socket.emit('workbook:join', { workbookId: wb.id }, (r: { ok: boolean }) => {
        rec('ws_join', performance.now() - tj);
        if (!r?.ok) fail('ws_join', 'rejected');
        resolve();
      }),
    );
    socket.on('connect_error', (e) => {
      fail('ws_connect', e.message);
      resolve();
    });
  });
  connected++;
  peak = Math.max(peak, connected);
  socket.on('cell:batch-update', (p: { revision: number; ops: { raw?: string }[] }) => {
    revision = Math.max(revision, p.revision);
    for (const op of p.ops) {
      const m = /^ts:(\d+)$/.exec(op.raw ?? '');
      if (m) deliveries.push(Date.now() - Number(m[1]));
    }
  });

  const end = Date.now() + DURATION;
  const row = 200 + (i % 50);
  const selTimer = setInterval(() => {
    socket.emit('cell:selection', { workbookId: wb.id, sheetId, selection: { r1: row, c1: 0, r2: row, c2: 1 } });
  }, 1000);
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, EDIT_MIN + Math.random() * EDIT_JITTER));
    if (Date.now() >= end) break;
    const col = 3 + (i % 5);
    const r = await call('edit_batch', cookie, 'POST', `/api/worksheets/${sheetId}/cells/batch`, {
      baseRevision: revision,
      clientId,
      ops: [{ sheetId, row: Math.floor(Math.random() * 200), col, raw: `ts:${Date.now()}` }],
    });
    edits++;
    if (r.res.status === 409) {
      conflicts++;
      revision = r.data?.details?.revision ?? revision;
    } else if (!r.res.ok) fail('edit_batch', String(r.res.status));
    else revision = Math.max(revision, r.data.revision);
  }
  clearInterval(selTimer);
  socket.disconnect();
  connected--;
}

async function main() {
  const started = Date.now();
  await Promise.all(Array.from({ length: N }, (_, i) => user(i).catch((e) => fail('exception', String(e?.message ?? e)))));
  const secs = (Date.now() - started) / 1000;
  console.log(`\n${N} users, peak ${peak} connected at once, ${secs.toFixed(0)} s, ${edits} edits (${(edits / secs).toFixed(1)}/s), ${conflicts} conflicts (409)`);
  console.log('step            count    p50     p95     p99     max (ms)');
  const rows: [string, number[]][] = [...Object.entries(lat), ['realtime_deliv', deliveries]];
  for (const [k, a] of rows) {
    if (!a.length) continue;
    console.log(
      `${k.padEnd(15)} ${String(a.length).padStart(5)} ${pct(a, 50).toFixed(0).padStart(6)} ${pct(a, 95).toFixed(0).padStart(7)} ${pct(a, 99).toFixed(0).padStart(7)} ${a.reduce((m, x) => (x > m ? x : m), 0).toFixed(0).padStart(7)}`,
    );
  }
  console.log('errors:', Object.keys(errors).length ? errors : 'none');
}
main();
