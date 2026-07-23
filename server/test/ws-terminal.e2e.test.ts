// End-to-end test for the M3 pty terminal channel over a REAL WebSocket.
//
// Like http.e2e.test.ts we isolate all on-disk state via env vars set BEFORE
// importing anything from src/ (config resolves paths at import time). We then
// listen on an ephemeral port, attach the WS server, pair for a JWT, create a
// claude-code session, and — because spawning the real `claude` TUI in CI is
// impossible — monkey-patch the claude adapter's buildTerminalCommand to return
// `cat`, which echoes deterministically inside the pty.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';

const HOME = mkdtempSync(join(tmpdir(), 'pocket-ws-term-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.POCKET_DATA_DIR = join(HOME, '.pocket');
process.env.POCKET_JWT_SECRET = 'ws-term-e2e-secret';
process.env.POCKET_WORKSPACES_DIR = join(HOME, 'workspaces');

const { buildHttpServer } = await import('../src/gateway/http.js');
const { attachWsServer } = await import('../src/gateway/ws.js');
const { Store } = await import('../src/store/sqlite.js');
const { dbPath } = await import('../src/config.js');
const { claudeCodeAdapter } = await import('../src/adapters/claude-code.js');

type App = Awaited<ReturnType<typeof buildHttpServer>>;

let app: App;
let store: InstanceType<typeof Store>;
let token: string;
let port: number;
let sessionId: string;
const origBuildTerminal = claudeCodeAdapter.buildTerminalCommand;

before(async () => {
  // Force the terminal channel to launch `cat` (deterministic echo) instead
  // of the real claude TUI, which cannot run in CI.
  claudeCodeAdapter.buildTerminalCommand = () => ({ cmd: 'cat', args: [], env: {} });

  app = await buildHttpServer();
  await app.ready();
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;

  store = new Store(dbPath);
  attachWsServer(app.server, store);

  const code = (await app.inject({ method: 'POST', url: '/api/pair/code' })).json().code as string;
  const pair = await app.inject({ method: 'POST', url: '/api/pair', payload: { code, name: 'ws-term' } });
  token = pair.json().token as string;

  const cwd = join(HOME, 'workspaces', 'term-proj');
  mkdirSync(cwd, { recursive: true });
  const created = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: { authorization: `Bearer ${token}` },
    payload: { projectId: 'term-proj', toolId: 'claude-code', cwd },
  });
  sessionId = created.json().id as string;
});

after(async () => {
  claudeCodeAdapter.buildTerminalCommand = origBuildTerminal;
  await app?.close();
  rmSync(HOME, { recursive: true, force: true });
});

function connect(): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Wait until a server message satisfying `pred` arrives, else reject on timeout. */
function waitFor(ws: WebSocket, pred: (m: any) => boolean, ms = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error('timeout waiting for message'));
    }, ms);
    function onMsg(raw: Buffer) {
      let m: any;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (pred(m)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(m);
      }
    }
    ws.on('message', onMsg);
  });
}

test('term_open → term data echoes → term_close emits term_exit', async () => {
  const ws = await connect();
  // Attach first so this socket is registered as a subscriber — term bytes
  // are broadcast to session.subscribers (same as the real app flow).
  ws.send(JSON.stringify({ t: 'attach', sessionId, lastSeq: 0 }));
  ws.send(JSON.stringify({ t: 'term_open', sessionId }));

  // Give the pty a moment to spawn, then send keystrokes.
  await new Promise((r) => setTimeout(r, 150));
  ws.send(JSON.stringify({ t: 'term', sessionId, data: 'ping\n' }));

  const echoed = await waitFor(ws, (m) => m.t === 'term' && typeof m.data === 'string' && m.data.includes('ping'));
  assert.equal(echoed.sessionId, sessionId);

  ws.send(JSON.stringify({ t: 'term_close', sessionId }));
  const exit = await waitFor(ws, (m) => m.t === 'term_exit' && m.sessionId === sessionId);
  assert.equal(typeof exit.code, 'number');

  ws.close();
});

test('term_open on an unknown session returns an error', async () => {
  const ws = await connect();
  ws.send(JSON.stringify({ t: 'term_open', sessionId: 'does-not-exist' }));
  const err = await waitFor(ws, (m) => m.t === 'error' && m.sessionId === 'does-not-exist');
  assert.equal(err.message, 'session_not_found');
  ws.close();
});
