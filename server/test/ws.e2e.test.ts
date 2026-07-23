// End-to-end tests for the WebSocket gateway (`/ws`) — the *only* channel the
// app uses to send input and receive live turn events. `app.inject()` cannot
// exercise a real WS upgrade, so unlike http.e2e we bind a real port on
// 127.0.0.1 and connect with a real `ws` client.
//
// Covers the user-facing realtime path:
//   - upgrade rejected without a token (app must re-pair, not spin forever)
//   - upgrade rejected with a garbage token
//   - valid token -> connection opens
//   - ping -> pong heartbeat (keeps the socket alive)
//   - input to an unknown session -> structured `error` (never a crash)
//   - attach to an unknown session -> tolerated (empty replay, no crash)
//
// Path resolution note: config.ts reads env at import time, so set HOME /
// POCKET_JWT_SECRET before the dynamic import (same isolation as http.e2e).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const HOME = mkdtempSync(join(tmpdir(), 'pocket-ws-e2e-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.POCKET_DATA_DIR = join(HOME, '.pocket');
process.env.POCKET_JWT_SECRET = 'ws-e2e-secret-not-for-prod';
process.env.POCKET_WORKSPACES_DIR = join(HOME, 'workspaces');

const { buildHttpServer } = await import('../src/gateway/http.js');
const { attachWsServer } = await import('../src/gateway/ws.js');
const { signDeviceToken } = await import('../src/gateway/auth.js');
const { Store } = await import('../src/store/sqlite.js');
const { dbPath } = await import('../src/config.js');

type App = Awaited<ReturnType<typeof buildHttpServer>>;

let app: App;
let baseWsUrl: string;
let token: string;

/** Connect and resolve once we know whether the upgrade succeeded (open) or
 *  was rejected (unexpected-response / error). Avoids hanging the test run. */
function connect(url: string): Promise<
  { ok: true; ws: WebSocket } | { ok: false; statusCode?: number }
> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { handshakeTimeout: 3000 });
    ws.once('open', () => resolve({ ok: true, ws }));
    ws.once('unexpected-response', (_req, res) => {
      ws.terminate();
      resolve({ ok: false, statusCode: res.statusCode });
    });
    ws.once('error', () => resolve({ ok: false }));
  });
}

/** Send a client message and wait for the first server message matching
 *  `predicate`, or reject on timeout. */
function waitFor(
  ws: WebSocket,
  predicate: (m: Record<string, unknown>) => boolean,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error('timeout waiting for server message'));
    }, timeoutMs);
    function onMsg(raw: Buffer): void {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (predicate(m)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(m);
      }
    }
    ws.on('message', onMsg);
  });
}

before(async () => {
  app = await buildHttpServer();
  await app.ready();
  await app.listen({ port: 0, host: '127.0.0.1' });
  // The WS server shares the same on-disk SQLite as the HTTP gateway (same
  // dbPath), mirroring how index.ts wires production.
  attachWsServer(app.server, new Store(dbPath));
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseWsUrl = `ws://127.0.0.1:${port}/ws`;
  token = (await signDeviceToken('ws-e2e-device')).token;
});

after(async () => {
  await app?.close();
  rmSync(HOME, { recursive: true, force: true });
});

test('WS upgrade is rejected without a token (401)', async () => {
  const r = await connect(baseWsUrl);
  assert.equal(r.ok, false);
  if (!r.ok && r.statusCode !== undefined) {
    assert.equal(r.statusCode, 401);
  }
});

test('WS upgrade is rejected with an invalid token', async () => {
  const r = await connect(`${baseWsUrl}?token=not-a-real-jwt`);
  assert.equal(r.ok, false);
});

test('WS upgrade succeeds with a valid token and answers ping with pong', async () => {
  const r = await connect(`${baseWsUrl}?token=${token}`);
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.ws);
  const ws = (r as { ok: true; ws: WebSocket }).ws;
  try {
    const pong = waitFor(ws, (m) => m.t === 'pong');
    ws.send(JSON.stringify({ t: 'ping' }));
    const m = await pong;
    assert.equal(m.t, 'pong');
  } finally {
    ws.terminate();
  }
});

test('input to an unknown session returns a structured error, not a crash', async () => {
  const r = await connect(`${baseWsUrl}?token=${token}`);
  assert.ok(r.ok && r.ws);
  const ws = (r as { ok: true; ws: WebSocket }).ws;
  try {
    const err = waitFor(ws, (m) => m.t === 'error');
    ws.send(JSON.stringify({ t: 'input', sessionId: 'does-not-exist', text: 'hi' }));
    const m = await err;
    assert.equal(m.t, 'error');
    assert.equal(m.message, 'session_not_found');
  } finally {
    ws.terminate();
  }
});

test('attach to an unknown session is tolerated (connection stays alive)', async () => {
  const r = await connect(`${baseWsUrl}?token=${token}`);
  assert.ok(r.ok && r.ws);
  const ws = (r as { ok: true; ws: WebSocket }).ws;
  try {
    // attach with no local/DB session yields an empty replay; the socket must
    // remain usable afterwards, which we prove by a subsequent ping/pong.
    ws.send(JSON.stringify({ t: 'attach', sessionId: 'nope', lastSeq: -1 }));
    const pong = waitFor(ws, (m) => m.t === 'pong');
    ws.send(JSON.stringify({ t: 'ping' }));
    assert.equal((await pong).t, 'pong');
  } finally {
    ws.terminate();
  }
});
