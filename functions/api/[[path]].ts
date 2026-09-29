// Cloudflare Pages Function: serves the multiplayer GameServer at /api/* using a
// KV-backed store. Same-origin as the frontend, so no CORS / proxy needed.
import { GameServer, verifyIdentityToken, type Jwks } from 'digital-boardgame-framework/server';
import { jsonCodec } from 'digital-boardgame-framework';
import { tegAdapter, createInitialState } from '../../src/engine/index.js';
import type { Action, GameState } from '../../src/engine/index.js';
import { tegAiControllers } from '../../src/engine/aiControllers.js';
import { TegStore } from './_store.js';

interface Env {
  GAMES: any;     // KV: bug reports (see _store.ts)
  GAMES_DB: any;  // D1: games, snapshots, chat
  /** Shared secret matching the hub's RATINGS_INGEST_KEY. When set, finished
   *  games auto-report to the hub's /ratings/record (ranked play). */
  RATINGS_INGEST_KEY?: string;
}

const HUB = 'https://games-hub-5vo.pages.dev';

// Module-scoped caches — persist across requests within a warm isolate.
let _jwks: Jwks | undefined;
let _jwksAt = 0;

/** Hub public verification keys, fetched once and cached for an hour. */
async function getJwks(): Promise<Jwks> {
  if (!_jwks || Date.now() - _jwksAt > 3_600_000) {
    _jwks = (await (await fetch(`${HUB}/id/jwks`)).json()) as Jwks;
    _jwksAt = Date.now();
  }
  return _jwks;
}

export const onRequest = async (context: { request: Request; env: Env; params: { path?: string[] } }) => {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const token = url.searchParams.get('token') ?? '';
  const parts = params.path ?? [];

  const server = new GameServer<GameState, Action, string>({
    snapshotHistory: 20,   // cap per-game snapshot history (framework >=0.32)
    adapter: tegAdapter,
    codec: jsonCodec<GameState>(),
    store: new TegStore(env.GAMES_DB, env.GAMES),
    // Server-driven, rated AI opponents (keyed by difficulty). A seat marked AI
    // in createGame is driven here, so the human can't tamper with its play.
    aiControllers: tegAiControllers,
    gameUrl: (gameId, tok) => `${url.origin}/?game=${gameId}&token=${tok}`,
    // Best-effort play counter: createGame fires an 'online' beacon to the hub.
    playBeacon: { appId: 'tiny-epic-galaxies' },
    // Ranked play: verify hub identity tokens (claimSeat) against the hub JWKS,
    // and auto-report each finished game to the hub for Glicko-2 ratings.
    verifyIdentity: async (t) => verifyIdentityToken(t, await getJwks()),
    ...(env.RATINGS_INGEST_KEY
      ? { ratings: { game: 'tiny-epic-galaxies', ingestKey: env.RATINGS_INGEST_KEY } }
      : {}),
  });

  const json = (code: number, body: unknown) =>
    new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });

  try {
    // POST /api/report — standalone bug/feedback report (works for local & solo
    // games that have no server-side game to attach to).
    if (request.method === 'POST' && parts.length === 1 && parts[0] === 'report') {
      const b: any = await request.json().catch(() => ({}));
      const reportId = (globalThis.crypto?.randomUUID?.() ?? `r${Date.now()}`);
      const store = new TegStore(env.GAMES_DB, env.GAMES);
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
        userAgent: b.userAgent ?? request.headers.get('user-agent') ?? undefined,
        createdAt: new Date().toISOString(),
        // Optional base64 PNG screenshot (data URL), stored for visual context.
        screenshot: typeof b.screenshot === 'string' ? b.screenshot.slice(0, 4_000_000) : undefined,
      } as any);
      return json(200, { reportId });
    }

    // ---- Report triage (public-read, fingerprint stripped; public-write resolve) ----
    if (parts[0] === 'reports') {
      const store = new TegStore(env.GAMES_DB, env.GAMES);
      const strip = (r: any) => { if (!r) return r; const { userAgent, ...rest } = r; return rest; };
      // GET /api/reports — list (newest first), without state/log for brevity.
      if (request.method === 'GET' && !parts[1]) {
        const unresolved = url.searchParams.get('unresolved') === '1';
        let rows = await store.listReports(unresolved ? { unresolved: true } : undefined);
        // Keep post-victory game-log uploads out of the problem-report queue.
        // Default: exclude them; ?category=game-log to view only those.
        const cat = url.searchParams.get('category');
        if (cat) rows = rows.filter((r: any) => (r.category ?? 'game') === cat);
        else rows = rows.filter((r: any) => (r.category ?? 'game') !== 'game-log');
        rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        return json(200, rows.map((r) => { const { serverSnapshot, reporterView, clientLog, userAgent, screenshot, ...rest } = r as any; return { ...rest, hasScreenshot: !!screenshot }; }));
      }
      // GET /api/reports/:id — full detail (incl. log + state), fingerprint stripped.
      if (request.method === 'GET' && parts[1]) {
        return json(200, strip(await store.getReport(parts[1])));
      }
      // POST /api/reports/:id/resolve — routine, reversible triage.
      if (request.method === 'POST' && parts[1] && parts[2] === 'resolve') {
        const b: any = await request.json().catch(() => ({}));
        await store.resolveReport(parts[1], String(b.note ?? 'resolved').slice(0, 1000));
        return json(200, { ok: true });
      }
    }

    // POST /api/games — create a game
    if (request.method === 'POST' && parts.length === 1 && parts[0] === 'games') {
      const body: any = await request.json().catch(() => ({}));
      const names: string[] = body.names ?? ['Player 1', 'Player 2'];
      const players = names.map((_, i) => `p${i + 1}`);
      // Optional seat→difficulty map for server-driven AI opponents. Body may use
      // either seat ids (e.g. { p2: 'easy' }) or 0-based seat indices ({ "1": 'easy' });
      // normalize indices to seat ids so the framework can attribute the AI seat.
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
        seats: names.map((name) => ({ name })),
        seed: Math.floor(Math.random() * 1e9),
        // Follow is offered, but only to players who can afford the culture cost
        // (the engine filters the follow queue), so no one gets a forced decline.
        followEnabled: true,
      });
      return json(200, await server.createGame({ initialState, players, ...(ai ? { ai } : {}) }));
    }

    if (parts[0] === 'games' && parts[1]) {
      const gameId = parts[1];
      const sub = parts[2];
      if (request.method === 'GET' && !sub) return json(200, await server.fetch(gameId, token));
      if (request.method === 'GET' && sub === 'legal') return json(200, await server.legalActions(gameId, token));
      // POST /api/games/:id/claim — attach a hub identity to this seat (ranked).
      if (request.method === 'POST' && sub === 'claim') {
        const b: any = await request.json().catch(() => ({}));
        const verified = await server.claimSeat(gameId, token, String(b.identityToken ?? ''));
        return json(200, { ok: true, playerId: verified.playerId });
      }
      if (request.method === 'POST' && sub === 'actions') {
        const b: any = await request.json().catch(() => ({}));
        // Ranked attribution: if a hub identity rode along with the move, claim
        // the seat first (best-effort — never blocks the move).
        if (typeof b.identityToken === 'string') {
          try { await server.claimSeat(gameId, token, b.identityToken); } catch { /* casual play */ }
        }
        // The action is the body itself (legacy shape) sans the identityToken.
        const { identityToken: _it, ...action } = b;
        return json(200, await server.submit(gameId, token, action as Action));
      }
      if (request.method === 'POST' && sub === 'report') return json(200, await server.report(gameId, token, await request.json() as any));
    }

    return json(404, { error: 'not found' });
  } catch (e: any) {
    return json(400, { error: String(e?.message ?? e) });
  }
};
