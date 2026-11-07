/**
 * Seeds N load-test users and workbooks directly in the database.
 * Every user shares one password hash, so seeding is fast.
 *   DATABASE_URL=... npx tsx loadtest/seed.ts 500 5
 * creates users lt0001..lt0500@loadtest.local and one workbook per GROUP users,
 * shared with every member of the group as editor. Re-running replaces earlier
 * load-test rows only (emails ending in @loadtest.local, titles starting "LT ").
 */
import 'dotenv/config';
import argon2 from 'argon2';
import pg from 'pg';

const N = Number(process.argv[2] ?? 500);
const GROUP = Number(process.argv[3] ?? 5);
const PASSWORD = 'loadtest-123';

async function main() {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  await db.query(`DELETE FROM workbooks WHERE title LIKE 'LT %' AND owner_id IN (SELECT id FROM users WHERE email LIKE '%@loadtest.local')`);
  await db.query(`DELETE FROM users WHERE email LIKE '%@loadtest.local'`);
  const ids: string[] = [];
  for (let i = 0; i < N; i++) {
    const email = `lt${String(i + 1).padStart(4, '0')}@loadtest.local`;
    const r = await db.query(
      `INSERT INTO users (id, name, email, password_hash, role, updated_at) VALUES (gen_random_uuid(), $1, $2, $3, 'user', now()) RETURNING id`,
      [`Penguji ${i + 1}`, email, hash],
    );
    ids.push(r.rows[0].id);
  }
  for (let g = 0; g * GROUP < N; g++) {
    const members = ids.slice(g * GROUP, g * GROUP + GROUP);
    const wb = await db.query(`INSERT INTO workbooks (id, owner_id, title, updated_at) VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id`, [members[0], `LT ${g + 1}`]);
    const wbId = wb.rows[0].id;
    const ws = await db.query(`INSERT INTO worksheets (id, workbook_id, title, position, updated_at) VALUES (gen_random_uuid(), $1, 'Sheet1', 0, now()) RETURNING id`, [wbId]);
    await db.query(`INSERT INTO worksheet_metadata (worksheet_id, data) VALUES ($1, '{}')`, [ws.rows[0].id]);
    // 200 rows of starting data with a formula column.
    const values: string[] = [];
    const params: unknown[] = [];
    for (let r = 0; r < 200; r++) {
      const row: [number, string][] = [
        [0, `Item ${r + 1}`],
        [1, String((r * 37) % 1000)],
        [2, `=B${r + 1}*2`],
      ];
      for (const [c, raw] of row) {
        params.push(ws.rows[0].id, r, c, raw, raw.startsWith('=') ? raw : null);
        const b = params.length;
        values.push(`(gen_random_uuid(), $${b - 4}::uuid, $${b - 3}, $${b - 2}, $${b - 1}, $${b}, 'null'::jsonb, 'empty', now())`);
      }
    }
    await db.query(
      `INSERT INTO cells (id, worksheet_id, row_index, column_index, raw_value, formula, calculated_value, data_type, updated_at) VALUES ${values.join(',')}`,
      params,
    );
    for (const m of members.slice(1)) await db.query(`INSERT INTO workbook_permissions (id, workbook_id, user_id, permission) VALUES (gen_random_uuid(), $1, $2, 'editor')`, [wbId, m]);
    await db.query(`INSERT INTO workbook_snapshots (id, workbook_id, revision_number, data) VALUES (gen_random_uuid(), $1, 0, '{}')`, [wbId]);
  }
  console.log(`seeded ${N} users, ${Math.ceil(N / GROUP)} workbooks`);
  await db.end();
}
main();
