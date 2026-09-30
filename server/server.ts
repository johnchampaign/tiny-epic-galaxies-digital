import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GameServer } from 'digital-boardgame-framework/server';
import { FsStore } from 'digital-boardgame-framework/server/node';
import { jsonCodec } from 'digital-boardgame-framework';
import { tegAdapter, createInitialState } from '../src/engine/index.js';
import type { Action, GameState } from '../src/engine/index.js';
import { tegAiControllers } from '../src/engine/aiControllers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_URL = process.env.PUBLIC_URL ?? 'http://localhost:5173';

const store = new FsStore(join(__dirname, '..', '.data'));

const server = new GameServer<GameState, Action, string>({
  adapter: tegAdapter,
  codec: jsonCodec<GameState>(),
  store,
  aiControllers: tegAiControllers,
  // Split long AI runs: follow offers hand the decision to other seats after
  // almost every die, so AI seats interleave (perSeat would split per action);
  // cap by work instead - ~10 actions is ~15-100 ms of AI CPU (2-5 seats).
  aiSlice: { maxSteps: 10 },
  gameUrl: (gameId, token) => `${PUBLIC_URL}/?game=${gameId}&token=${token}`,
  // Best-effort play counter: createGame fires an 'online' beacon to the hub.
  playBeacon: { appId: 'tiny-epic-galaxies' },
});

function json(res: import('node:http').ServerResponse, code: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(data);
}

async function readBody(req: import('node:http').IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

const http = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const token = url.searchParams.get('token') ?? '';

    if (req.method === 'OPTIONS') return json(res, 204, {});

    // POST /api/report -> standalone bug/feedback report (local & solo games)
    if (req.method === 'POST' && parts[0] === 'report' && parts.length === 1) {
      const b = await readBody(req);
      const reportId = `r${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      await store.putReport({
        reportId,
        gameId: b.gameId ?? 'standalone',
        reporterSide: b.reporterSide ?? 'local',
        turnNumber: b.turn ?? 0,
        serverSnapshot: typeof b.state === 'string' ? b.state : JSON.stringify(b.state ?? null),
        reporterView: '',
        clientLog: Array.isArray(b.log) ? b.log : [],
        message: String(b.message ?? '').slice(0, 4000),
        severity: b.severity ?? 'bug',
        category: b.category ?? 'game',
        clientBuild: b.build,
        userAgent: b.userAgent,
        createdAt: new Date().toISOString(),
        screenshot: typeof b.screenshot === 'string' ? b.screenshot.slice(0, 4_000_000) : undefined,
      } as any);
      return json(res, 200, { reportId });
    }

    // ---- Report triage (public-read, fingerprint stripped; public-write resolve) ----
    if (parts[0] === 'reports') {
      if (req.method === 'GET' && !parts[1]) {
        const unresolved = url.searchParams.get('unresolved') === '1';
        let rows = await server.listReports(unresolved ? { unresolved: true } : undefined);
        // Keep post-victory game-log uploads out of the problem-report queue.
        const cat = url.searchParams.get('category');
        if (cat) rows = rows.filter((r: any) => (r.category ?? 'game') === cat);
        else rows = rows.filter((r: any) => (r.category ?? 'game') !== 'game-log');
        rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        return json(res, 200, rows.map((r) => { const { serverSnapshot, reporterView, clientLog, userAgent, ...rest } = r as any; return rest; }));
      }
      if (req.method === 'GET' && parts[1]) {
        const rows = await server.listReports();
        const r = rows.find((x) => x.reportId === parts[1]) as any;
        if (r) { const { userAgent, ...rest } = r; return json(res, 200, rest); }
        return json(res, 404, { error: 'not found' });
      }
      if (req.method === 'POST' && parts[1] && parts[2] === 'resolve') {
        const b = await readBody(req);
        await server.resolveReport(parts[1], String(b.note ?? 'resolved').slice(0, 1000));
        return json(res, 200, { ok: true });
      }
    }

    // POST /api/games  -> create a game
    if (req.method === 'POST' && parts[0] === 'games' && parts.length === 1) {
      const body = await readBody(req);
      const names: string[] = body.names ?? ['Player 1', 'Player 2'];
      const players = names.map((_, i) => `p${i + 1}`);
      const rawAi = (body.ai && typeof body.ai === 'object') ? body.ai as Record<string, string> : undefined;
      let ai: Record<string, string> | undefined;
      if (rawAi) {
        ai = {};
        for (const [k, v] of Object.entries(rawAi)) {
          if (typeof v !== 'string' || !tegAiControllers[v]) continue;
          const seat = players.includes(k) ? k : players[Number(k)];
          if (seat) ai[seat] = v;
        }
        if (Object.keys(ai).length === 0) ai = undefined;
      }
      const initialState = createInitialState({
        seats: names.map((name: string) => ({ name })),
        seed: Math.floor(Math.random() * 1e9),
        followEnabled: true, // engine only offers follow to players who can afford it
      });
      const result = await server.createGame({ initialState, players, ...(ai ? { ai } : {}) });
      return json(res, 200, result);
    }

    // /api/games/:id ...
    if (parts[0] === 'games' && parts[1]) {
      const gameId = parts[1];
      const sub = parts[2];

      if (req.method === 'GET' && !sub) {
        return json(res, 200, await server.fetch(gameId, token));
      }
      if (req.method === 'GET' && sub === 'legal') {
        return json(res, 200, await server.legalActions(gameId, token));
      }
      if (req.method === 'POST' && sub === 'actions') {
        const b = await readBody(req);
        // Ranked attribution rides along as identityToken; strip it so the action
        // exact-matches legalActions (mirrors the Pages Function). Claim the seat
        // best-effort first.
        if (typeof b?.identityToken === 'string') {
          try { await server.claimSeat(gameId, token, b.identityToken); } catch { /* casual */ }
        }
        const { identityToken: _it, ...action } = b ?? {};
        return json(res, 200, await server.submit(gameId, token, action));
      }
      if (req.method === 'POST' && sub === 'report') {
        const body = await readBody(req);
        return json(res, 200, await server.report(gameId, token, body));
      }
    }

    return json(res, 404, { error: 'not found' });
  } catch (e: any) {
    return json(res, 400, { error: String(e?.message ?? e) });
  }
});

http.listen(PORT, () => {
  console.log(`TEG multiplayer server on http://localhost:${PORT}`);
  console.log(`Frontend expected at ${PUBLIC_URL}`);
});
