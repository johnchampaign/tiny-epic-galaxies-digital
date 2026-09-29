// Games, snapshots and chat live in D1; bug reports stay in KV.
//
// Why D1: KV's free plan allows 1,000 writes a day per ACCOUNT (shared with
// every game on it), and the old KV store wrote twice per move (a per-turn copy
// + `latest`) and never trimmed history (903 per-turn keys across 40 games by
// 2026-09-29). D1's free plan is 100,000 rows written a day, and the
// framework's D1Store keeps the usual 20-snapshot history. Existing games were
// copied by scripts/migrate-kv-to-d1.mjs; the old KV keys stay as a backup.
//
// Why reports stay in KV: most carry a screenshot (35 of 45 were over 90 KB,
// up to ~850 KB) and D1 caps a row at 2 MB; KV values go to 25 MB. Reports are
// rare writes.
import { D1Store } from 'digital-boardgame-framework/server';
import type { D1DatabaseLike, BugReportRow, ReportFilter } from 'digital-boardgame-framework/server';

// Minimal KV surface (avoids depending on @cloudflare/workers-types here).
interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  list(opts: { prefix: string }): Promise<{ keys: { name: string }[] }>;
}

export class TegStore extends D1Store {
  constructor(db: D1DatabaseLike, private kv: KV) { super(db); }

  private async getJSON<T>(k: string): Promise<T | null> {
    const v = await this.kv.get(k);
    return v ? (JSON.parse(v) as T) : null;
  }

  async putReport(row: BugReportRow) { await this.kv.put(`report:${row.reportId}`, JSON.stringify(row)); }
  getReport(id: string) { return this.getJSON<BugReportRow>(`report:${id}`); }
  async listReports(f?: ReportFilter) {
    const { keys } = await this.kv.list({ prefix: 'report:' });
    let rows: BugReportRow[] = [];
    for (const k of keys) {
      const r = await this.getJSON<BugReportRow>(k.name);
      if (r) rows.push(r);
    }
    if (f?.gameId) rows = rows.filter((r) => r.gameId === f.gameId);
    if (f?.unresolved) rows = rows.filter((r) => !r.resolution);
    if (f?.severity) rows = rows.filter((r) => r.severity === f.severity);
    if (f?.category) rows = rows.filter((r) => r.category === f.category);
    if (f?.since) rows = rows.filter((r) => r.createdAt >= f.since!);
    return rows;
  }
  async resolveReport(id: string, note: string) {
    const k = `report:${id}`;
    const r = await this.getJSON<BugReportRow>(k);
    if (r) { r.resolution = { at: new Date().toISOString(), note }; await this.kv.put(k, JSON.stringify(r)); }
  }
}
