// Integration tests for transcript backfill — the write side of "the tool
// session file is the single source of truth". backfillSession() reads a host
// transcript (via the scanner) and appends its turns into SQLite, and MUST be
// idempotent so repeated reconciliations never duplicate history.
//
// IMPORTANT: backfill.ts imports the session scanner, which resolves
// CLAUDE_DIR / CODEX_DIR from homedir() *at import time*. So HOME must be set
// BEFORE the dynamic imports below. Each test file runs in its own process
// under `node --test`, so this env mutation stays isolated.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'pocket-backfill-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const { Store } = await import('../src/store/sqlite.js');
const { backfillSession, reconcileSession } = await import('../src/hosts/backfill.js');
type StoreT = InstanceType<typeof Store>;

const EXTERNAL_ID = 'backfill-sess-1';
const CWD = '/proj/backfill';

let dir: string;
let store: StoreT;

function seedTranscript(): void {
  const projDir = join(HOME, '.claude', 'projects', '-backfill');
  mkdirSync(projDir, { recursive: true });
  const jsonl = [
    JSON.stringify({ type: 'user', sessionId: EXTERNAL_ID, cwd: CWD, uuid: 'u1', message: { role: 'user', content: '第一条' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: '回复一' }] } }),
  ].join('\n');
  writeFileSync(join(projDir, `${EXTERNAL_ID}.jsonl`), jsonl, 'utf8');
}

function createBoundSession(externalId: string | null): void {
  store.createSession({
    id: 'local-1',
    project_id: 'proj',
    tool_id: 'claude-code',
    model: null,
    state: 'idle',
    tmux_name: 'pocket-local-1',
    last_seq: 0,
    baseline_ref: null,
    created_at: Date.now(),
    cwd: CWD,
    external_session_id: externalId,
    has_run_once: 0,
    permission_mode: 'default',
  });
}

before(() => {
  seedTranscript();
});

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test('backfillSession imports all transcript turns on first run', () => {
  dir = mkdtempSync(join(tmpdir(), 'pocket-backfill-db-'));
  store = new Store(join(dir, 'pocket.db'));
  createBoundSession(EXTERNAL_ID);

  const res = backfillSession(store, {
    sessionId: 'local-1',
    toolId: 'claude-code',
    externalSessionId: EXTERNAL_ID,
  });
  assert.ok(res);
  assert.equal(res!.imported, 2);
  assert.equal(res!.total, 2);
  assert.equal(res!.lastSeq, 2);
  assert.equal(store.countMessages('local-1'), 2);

  const rows = store.listMessages('local-1');
  assert.equal(rows[0].source, 'external');
  assert.equal(rows[0].external_turn_ref, 'u1', 'dedupe ref comes from the transcript uuid');

  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('second backfill is idempotent (0 new turns, count unchanged)', () => {
  dir = mkdtempSync(join(tmpdir(), 'pocket-backfill-db-'));
  store = new Store(join(dir, 'pocket.db'));
  createBoundSession(EXTERNAL_ID);

  const first = backfillSession(store, {
    sessionId: 'local-1',
    toolId: 'claude-code',
    externalSessionId: EXTERNAL_ID,
  });
  assert.equal(first!.imported, 2);

  const second = backfillSession(store, {
    sessionId: 'local-1',
    toolId: 'claude-code',
    externalSessionId: EXTERNAL_ID,
  });
  assert.equal(second!.imported, 0, 'already-recorded refs are skipped');
  assert.equal(second!.total, 2);
  assert.equal(store.countMessages('local-1'), 2, 'history must not double');

  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('reconcileSession delegates to backfill and stays idempotent', () => {
  dir = mkdtempSync(join(tmpdir(), 'pocket-backfill-db-'));
  store = new Store(join(dir, 'pocket.db'));
  createBoundSession(EXTERNAL_ID);
  const row = store.getSession('local-1')!;

  const r1 = reconcileSession(store, row);
  assert.equal(r1!.imported, 2, 'first reconcile catches up all turns');

  const r2 = reconcileSession(store, row);
  assert.equal(r2!.imported, 0, 'repeat reconcile is a no-op');
  assert.equal(store.countMessages('local-1'), 2);

  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('reconcileSession returns null when session has no external binding', () => {
  dir = mkdtempSync(join(tmpdir(), 'pocket-backfill-db-'));
  store = new Store(join(dir, 'pocket.db'));
  createBoundSession(null);
  const row = store.getSession('local-1')!;

  assert.equal(reconcileSession(store, row), null);

  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('backfillSession returns null when the transcript file is missing', () => {
  dir = mkdtempSync(join(tmpdir(), 'pocket-backfill-db-'));
  store = new Store(join(dir, 'pocket.db'));
  createBoundSession('no-such-external-id');

  const res = backfillSession(store, {
    sessionId: 'local-1',
    toolId: 'claude-code',
    externalSessionId: 'no-such-external-id',
  });
  assert.equal(res, null);

  store.close();
  rmSync(dir, { recursive: true, force: true });
});
