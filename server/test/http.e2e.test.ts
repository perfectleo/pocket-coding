// End-to-end tests for the HTTP gateway, driven through Fastify's in-process
// `app.inject()` — no network port, no device, no real AI CLI required. This
// guards the M1 "import desktop session → backfill history" closed loop, which
// is the highest-value flow to protect against regression.
//
// IMPORTANT: config.ts and the host session scanner resolve their on-disk
// paths from env vars / homedir() *at import time*. So we must set HOME,
// POCKET_DATA_DIR and POCKET_JWT_SECRET BEFORE importing the app modules —
// hence the dynamic import() after the env setup below. This gives each test
// run a fully isolated home (fake ~/.claude transcript + fresh SQLite db).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- isolate all on-disk state before importing anything from src/ ---
const HOME = mkdtempSync(join(tmpdir(), 'pocket-e2e-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME; // windows parity for os.homedir()
process.env.POCKET_DATA_DIR = join(HOME, '.pocket');
process.env.POCKET_JWT_SECRET = 'e2e-test-secret-not-for-prod';
process.env.POCKET_WORKSPACES_DIR = join(HOME, 'workspaces');

const { buildHttpServer } = await import('../src/gateway/http.js');
type App = Awaited<ReturnType<typeof buildHttpServer>>;

const EXTERNAL_ID = 'e2e-claude-sess-001';
const FIXTURE_CWD = join(HOME, 'workspaces', 'e2e-proj');
const USER_TEXT = '帮我写一个快速排序函数';

let app: App;
let token: string;
let importedId: string;

/** Seed a fake claude-code host transcript so scanHostSessions/backfill have
 *  something real to read, without depending on the developer's own history. */
function seedClaudeTranscript(): void {
  const projDir = join(HOME, '.claude', 'projects', '-e2e-proj');
  mkdirSync(projDir, { recursive: true });
  const jsonl = [
    JSON.stringify({
      type: 'user',
      sessionId: EXTERNAL_ID,
      cwd: FIXTURE_CWD,
      uuid: 'u1',
      timestamp: '2024-01-01T00:00:00Z',
      message: { role: 'user', content: USER_TEXT },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2024-01-01T00:00:01Z',
      message: { content: [{ type: 'text', text: '好的，这是快速排序实现。' }] },
    }),
  ].join('\n');
  writeFileSync(join(projDir, `${EXTERNAL_ID}.jsonl`), jsonl, 'utf8');
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

before(async () => {
  seedClaudeTranscript();
  app = await buildHttpServer();
  await app.ready();

  // Pair a virtual device to obtain a JWT for the protected routes.
  const codeRes = await app.inject({ method: 'POST', url: '/api/pair/code' });
  assert.equal(codeRes.statusCode, 200);
  const code = codeRes.json().code as string;

  const pairRes = await app.inject({
    method: 'POST',
    url: '/api/pair',
    payload: { code, name: 'e2e-device' },
  });
  assert.equal(pairRes.statusCode, 200);
  token = pairRes.json().token as string;
  assert.ok(token && token.length > 20, 'pairing should return a JWT');
});

after(async () => {
  await app?.close();
  rmSync(HOME, { recursive: true, force: true });
});

test('health is open; protected route rejects missing token', async () => {
  const health = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().ok, true);

  const noAuth = await app.inject({ method: 'GET', url: '/api/sessions' });
  assert.equal(noAuth.statusCode, 401);
});

test('GET /api/hosts/sessions discovers the seeded transcript (not yet imported)', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/hosts/sessions',
    headers: authHeaders(),
  });
  assert.equal(res.statusCode, 200);
  const sessions = res.json().sessions as Array<{
    toolId: string;
    externalSessionId: string;
    cwd: string;
    messageCount: number;
    summary: string;
    imported: boolean;
  }>;
  const found = sessions.find((s) => s.externalSessionId === EXTERNAL_ID);
  assert.ok(found, 'seeded session should be discovered');
  assert.equal(found!.toolId, 'claude-code');
  assert.equal(found!.cwd, FIXTURE_CWD);
  assert.equal(found!.summary, USER_TEXT);
  assert.equal(found!.imported, false);
});

test('POST /api/hosts/sessions/import backfills history', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/hosts/sessions/import',
    headers: authHeaders(),
    payload: { toolId: 'claude-code', externalSessionId: EXTERNAL_ID, cwd: FIXTURE_CWD },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { id: string; alreadyImported: boolean; backfilled: number };
  assert.ok(body.id, 'import should return a local session id');
  assert.equal(body.alreadyImported, false);
  assert.equal(body.backfilled, 2, 'both transcript turns should be backfilled');
  importedId = body.id;
});

test('GET /api/sessions lists the imported session with external binding', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/sessions',
    headers: authHeaders(),
  });
  assert.equal(res.statusCode, 200);
  const sessions = res.json().sessions as Array<{
    id: string;
    toolId: string;
    externalSessionId?: string;
    cwd?: string;
  }>;
  const s = sessions.find((x) => x.id === importedId);
  assert.ok(s, 'imported session should appear in the list');
  assert.equal(s!.externalSessionId, EXTERNAL_ID);
  assert.equal(s!.cwd, FIXTURE_CWD);
  assert.equal(s!.toolId, 'claude-code');
});

test('GET /api/sessions/:id exposes the desktop resume command', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/sessions/${importedId}`,
    headers: authHeaders(),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { externalSessionId?: string; resumeCommand?: string };
  assert.equal(body.externalSessionId, EXTERNAL_ID);
  assert.equal(body.resumeCommand, `claude --resume ${EXTERNAL_ID}`);
});

test('GET /api/sessions/:id/messages returns backfilled external turns', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/sessions/${importedId}/messages`,
    headers: authHeaders(),
  });
  assert.equal(res.statusCode, 200);
  const messages = res.json().messages as Array<{
    role: string;
    type: string;
    source: string;
    payload: { text?: string };
  }>;
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].source, 'external');
  assert.equal(messages[0].payload.text, USER_TEXT);
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].source, 'external');
});

test('re-importing the same session is idempotent (0 new turns)', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/hosts/sessions/import',
    headers: authHeaders(),
    payload: { toolId: 'claude-code', externalSessionId: EXTERNAL_ID, cwd: FIXTURE_CWD },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { id: string; alreadyImported: boolean; backfilled: number };
  assert.equal(body.id, importedId, 'should reuse the existing local session');
  assert.equal(body.alreadyImported, true);
  assert.equal(body.backfilled, 0);

  // Message count must not have doubled.
  const msgs = await app.inject({
    method: 'GET',
    url: `/api/sessions/${importedId}/messages`,
    headers: authHeaders(),
  });
  assert.equal((msgs.json().messages as unknown[]).length, 2);
});

test('GET /api/hosts/sessions now flags the session as imported', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/hosts/sessions',
    headers: authHeaders(),
  });
  const sessions = res.json().sessions as Array<{ externalSessionId: string; imported: boolean }>;
  const found = sessions.find((s) => s.externalSessionId === EXTERNAL_ID);
  assert.ok(found);
  assert.equal(found!.imported, true);
});
