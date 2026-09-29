#!/usr/bin/env node
// One-off: copy Tiny Epic Galaxies games from KV into D1 (see functions/api/_store.ts).
//
//   node scripts/migrate-kv-to-d1.mjs out.sql          # reads KV (read-only), writes SQL
//   npx wrangler d1 execute tiny-epic-galaxies --remote --file out.sql
//
// Copies meta:<id> -> dbf_games, the latest snapshot -> dbf_snapshots, and
// msg:<id> -> dbf_messages. INSERT OR IGNORE, so it's safe to re-run and never
// overwrites a game D1 already has. KV is left untouched as a backup.
// Runs wrangler with its OAuth login (the games API token has no KV scope).
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const NS = 'ac0c631e065f489ba2c563794191e95f';
const out = process.argv[2];
if (!out) { console.error('usage: node scripts/migrate-kv-to-d1.mjs <out.sql>'); process.exit(2); }

const env = { ...process.env };
delete env.CLOUDFLARE_API_TOKEN;
function wrangler(args) {
  const r = spawnSync('npx', ['wrangler', ...args, '--namespace-id', NS, '--remote'], { env, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`wrangler ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}
const get = (key) => { const t = wrangler(['kv', 'key', 'get', key]); return t.trim() ? JSON.parse(t) : null; };
const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

const keys = JSON.parse(wrangler(['kv', 'key', 'list'])).map((k) => k.name);
const metas = keys.filter((k) => k.startsWith('meta:'));
const sql = [];
let snaps = 0, msgs = 0;
for (const mk of metas) {
  const id = mk.slice(5);
  const meta = get(mk);
  if (!meta) continue;
  sql.push(`INSERT OR IGNORE INTO dbf_games (game_id, resolved, created_at, meta) VALUES (${q(id)}, ${meta.resolved ? 1 : 0}, ${q(meta.createdAt ?? '')}, ${q(JSON.stringify(meta))});`);
  // Newest snapshot: the :latest key, else the highest per-turn key (pre-latest store).
  let snap = keys.includes(`snap:${id}:latest`) ? get(`snap:${id}:latest`) : null;
  if (!snap) {
    const turns = keys.filter((k) => k.startsWith(`snap:${id}:`) && !k.endsWith(":latest")).sort(); // snap:<id>:NNNNNN
    if (turns.length) snap = get(turns[turns.length - 1]);
  }
  if (snap) {
    sql.push(`INSERT OR IGNORE INTO dbf_snapshots (game_id, turn, state) VALUES (${q(id)}, ${Number(snap.turn)}, ${q(snap.state)});`);
    snaps += 1;
  }
  if (keys.includes(`msg:${id}`)) {
    for (const m of get(`msg:${id}`) ?? []) {
      sql.push(`INSERT INTO dbf_messages (game_id, msg) VALUES (${q(id)}, ${q(JSON.stringify(m))});`);
      msgs += 1;
    }
  }
}
writeFileSync(out, sql.join('\n') + '\n');
console.log(`${metas.length} games, ${snaps} snapshots, ${msgs} chat messages -> ${out}`);
