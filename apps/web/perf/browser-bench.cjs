/**
 * Browser performance check against PRD section 10:
 *   dashboard < 3 s, opening a spreadsheet < 3 s, grid rendering ~60 FPS.
 *   BASE=http://localhost:3000 EMAIL=... PASSWORD=... node perf/browser-bench.cjs
 * Creates a workbook with 20,000 rows (60,000 cells, 20,000 formulas).
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE ?? 'http://localhost:3000';
const EMAIL = process.env.EMAIL ?? 'rina@example.test';
const PASSWORD = process.env.PASSWORD ?? 'rahasia-123';
const ROWS = Number(process.env.ROWS ?? 20000);

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(BASE + '/login');
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));

  const wbId = await page.evaluate(async (rows) => {
    const H = { 'x-opensheet-csrf': '1', 'content-type': 'application/json' };
    const wb = await fetch('/api/workbooks', { method: 'POST', headers: H, body: JSON.stringify({ title: `Benchmark ${rows} baris` }) }).then((r) => r.json());
    const meta = await fetch(`/api/workbooks/${wb.id}`).then((r) => r.json());
    const sheetId = meta.sheets[0].id;
    let rev = 0;
    const ops = [];
    for (let r = 0; r < rows; r++) {
      ops.push({ sheetId, row: r, col: 0, raw: `Barang ${r + 1}` }, { sheetId, row: r, col: 1, raw: String((r * 37) % 1000) }, { sheetId, row: r, col: 2, raw: `=B${r + 1}*1.1` });
    }
    for (let i = 0; i < ops.length; i += 30000) {
      const res = await fetch(`/api/worksheets/${sheetId}/cells/batch`, { method: 'POST', headers: H, body: JSON.stringify({ baseRevision: rev, clientId: 'bench-seed', ops: ops.slice(i, i + 30000) }) }).then((r) => r.json());
      rev = res.revision;
    }
    return wb.id;
  }, ROWS);

  // Dashboard: navigation until the list is visible.
  let t = Date.now();
  await page.goto(BASE + '/?view=mine');
  await page.waitForSelector('main li');
  const dash = Date.now() - t;

  // Open the spreadsheet: navigation until the grid is drawn with the formula values ready.
  t = Date.now();
  await page.goto(`${BASE}/w/${wbId}`);
  await page.waitForSelector('canvas');
  await page.waitForFunction(() => document.querySelector('[aria-live=polite].sr-only')?.textContent?.includes('A1'));
  const open = Date.now() - t;

  // Scroll: 240 frames of continuous scrolling, measuring frame intervals.
  const fps = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const el = document.querySelector('[role=grid]');
        const times = [];
        let last = performance.now();
        let i = 0;
        const step = () => {
          const now = performance.now();
          times.push(now - last);
          last = now;
          el.scrollTop += 120;
          el.scrollLeft += i % 20 === 0 ? 40 : 0;
          if (++i < 240) requestAnimationFrame(step);
          else {
            times.shift();
            times.sort((a, b) => a - b);
            const avg = times.reduce((a, b) => a + b, 0) / times.length;
            resolve({ avgFps: 1000 / avg, p95FrameMs: times[Math.floor(times.length * 0.95)], slowFrames: times.filter((x) => x > 1000 / 50).length, frames: times.length });
          }
        };
        requestAnimationFrame(step);
      }),
  );

  // Edit response: keypress to value shown in the formula bar after Enter.
  await page.locator('[role=grid]').evaluate((el) => {
    el.scrollTop = 0;
    el.scrollLeft = 0;
  });
  const box = await page.locator('[role=grid]').boundingBox();
  await page.mouse.click(box.x + 46 + 3 * 100 + 50, box.y + 24 + 12);
  t = Date.now();
  await page.keyboard.type('=SUM(C1:C' + ROWS + ')');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => /,\d|\d{4,}/.test(document.querySelector('[aria-live=polite].sr-only')?.textContent ?? ''));
  const edit = Date.now() - t;

  console.log(JSON.stringify({ rows: ROWS, dashboardMs: dash, openSpreadsheetMs: open, scroll: fps, typeFormulaAndRecalcMs: edit }, null, 2));
  await browser.close();
})();
