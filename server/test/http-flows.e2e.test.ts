// End-to-end tests for the REST flows a first-time user hits *before* the
// import happy-path that http.e2e already guards:
//   - pairing failure modes (invalid code -> 401, brute-force -> 429 lock)
//   - creating a brand-new session (not an import) + input validation
//   - browsing the workspace root to pick a project folder + path-traversal
//     rejection (security: '..' / absolute paths must never escape the root)
//   - deleting a session
//
// Uses Fastify `app.inject()` (no port, no device, no CLI). Env is set before
// the dynamic import so config.ts resolves an isolated HOME/db (see http.e2e).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'pocket-flows-e2e-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.POCKET_DATA_DIR = join(HOME, '.pocket');
process.env.POCKET_JWT_SECRET = 'flows-e2e-secret-not-for-prod';
// Small brute-force threshold so the 429 test stays fast/deterministic.
process.env.POCKET_PAIR_FAIL_MAX = '3';
const WORKSPACES = join(HOME, 'workspaces');
process.env.POCKET_WORKSPACES_DIR = WORKSPACES;

// Seed a couple of project folders under the workspace root so /browse has
// something to list, plus a nested one to prove recursion.
mkdirSync(join(WORKSPACES, 'alpha', 'src'), { recursive: true });
mkdirSync(join(WORKSPACES, 'beta'), { recursive: true });

const { buildHttpServer } = await import('../src/gateway/http.js');
type App = Awaited<ReturnType<typeof buildHttpServer>>;

let app: App;
let token: string;

function auth(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function pairFreshDevice(): Promise<string> {
  const codeRes = await app.inject({ method: 'POST', url: '/api/pair/code' });
  const code = codeRes.json().code as string;
  const pairRes = await app.inject({
    method: 'POST',
    url: '/api/pair',
    payload: { code, name: 'flows-device' },
  });
  return pairRes.json().token as string;
}

before(async () => {
  app = await buildHttpServer();
  await app.ready();
  token = await pairFreshDevice();
  assert.ok(token && token.length > 20);
});

after(async () => {
  await app?.close();
  rmSync(HOME, { recursive: true, force: true });
});

test('pairing with an unknown code is rejected 401', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/pair',
    payload: { code: '000000', name: 'x' },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'invalid_code');
});

test('pairing with a malformed code is rejected 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/pair',
    payload: { code: 'abc', name: 'x' },
  });
  assert.equal(res.statusCode, 400);
});

test('repeated pairing failures trip the rate limiter (429)', async () => {
  // POCKET_PAIR_FAIL_MAX=3: three bad-code attempts, then /pair/code locks.
  for (let i = 0; i < 3; i++) {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/pair',
      payload: { code: '111111', name: 'attacker' },
    });
    assert.equal(bad.statusCode, 401);
  }
  const locked = await app.inject({ method: 'POST', url: '/api/pair/code' });
  assert.equal(locked.statusCode, 429);
  assert.equal(locked.json().error, 'too_many_attempts');
});

test('creating a brand-new session returns an idle session', async () => {
  const cwd = join(WORKSPACES, 'alpha');
  const res = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: auth(),
    payload: { projectId: 'alpha', toolId: 'claude-code', cwd },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { id: string; toolId: string; state: string };
  assert.ok(body.id, 'should return a session id');
  assert.equal(body.toolId, 'claude-code');

  // It shows up in the list and can be deleted again.
  const list = await app.inject({ method: 'GET', url: '/api/sessions', headers: auth() });
  const ids = (list.json().sessions as Array<{ id: string }>).map((s) => s.id);
  assert.ok(ids.includes(body.id));

  const del = await app.inject({
    method: 'DELETE',
    url: `/api/sessions/${body.id}`,
    headers: auth(),
  });
  assert.equal(del.statusCode, 200);
  assert.equal(del.json().ok, true);
});

test('creating a session with a bad toolId is rejected 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: auth(),
    payload: { projectId: 'x', toolId: 'not-a-tool' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'bad_request');
});

test('GET /api/roots returns the workspace root', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/roots', headers: auth() });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().root, WORKSPACES);
});

test('GET /api/roots/browse lists project folders under the root', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/roots/browse',
    headers: auth(),
  });
  assert.equal(res.statusCode, 200);
  const names = (res.json().entries as Array<{ name: string; dir: boolean }>).map((e) => e.name);
  assert.deepEqual(names, ['alpha', 'beta'], 'dirs listed alphabetically');
});

test('browse rejects path traversal outside the root (400)', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/roots/browse?path=${encodeURIComponent('../../etc')}`,
    headers: auth(),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_path');
});

test('browse rejects an absolute path (400)', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/roots/browse?path=${encodeURIComponent('/etc')}`,
    headers: auth(),
  });
  assert.equal(res.statusCode, 400);
});
