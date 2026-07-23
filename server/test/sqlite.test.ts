// Integration tests for the SQLite index/cache layer. SQLite is *not* the
// source of truth (the tool session files are), but it must faithfully record
// message provenance and support the dedupe primitives that make transcript
// backfill idempotent. We use a real better-sqlite3 db in a temp dir so the
// migration path (CREATE TABLE + ensureColumn ALTERs + indexes) runs exactly
// as in production.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type SessionRow, type MessageRow } from '../src/store/sqlite.js';

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pocket-sqlite-'));
  // Nested path also exercises the mkdirSync(dirname) in the constructor.
  store = new Store(join(dir, 'nested', 'pocket.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedSession(overrides: Partial<SessionRow> = {}): SessionRow {
  const row: SessionRow = {
    id: 's1',
    project_id: 'proj',
    tool_id: 'claude-code',
    model: null,
    state: 'idle',
    tmux_name: 'pocket-s1',
    last_seq: 0,
    baseline_ref: null,
    created_at: Date.now(),
    cwd: '/proj',
    external_session_id: null,
    has_run_once: 0,
    permission_mode: 'default',
    ...overrides,
  };
  store.createSession(row);
  return row;
}

function msg(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: 'm' + Math.random().toString(36).slice(2),
    session_id: 's1',
    seq: 1,
    role: 'user',
    type: 'text',
    payload: JSON.stringify({ text: 'hi' }),
    turn_id: null,
    created_at: Date.now(),
    ...overrides,
  };
}

test('appendMessage defaults source to "app" and external_turn_ref to null', () => {
  seedSession();
  store.appendMessage(msg({ seq: 1 }));
  const rows = store.listMessages('s1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'app');
  assert.equal(rows[0].external_turn_ref, null);
});

test('appendMessage persists explicit external source + turn ref', () => {
  seedSession();
  store.appendMessage(
    msg({ seq: 1, source: 'external', external_turn_ref: 'uuid-1' }),
  );
  const rows = store.listMessages('s1');
  assert.equal(rows[0].source, 'external');
  assert.equal(rows[0].external_turn_ref, 'uuid-1');
});

test('hasExternalRef is scoped per session and used for dedupe', () => {
  seedSession({ id: 's1' });
  seedSession({ id: 's2', tmux_name: 'pocket-s2' });
  store.appendMessage(msg({ session_id: 's1', seq: 1, source: 'external', external_turn_ref: 'ref-a' }));

  assert.equal(store.hasExternalRef('s1', 'ref-a'), true);
  // Same ref, different session — must not collide.
  assert.equal(store.hasExternalRef('s2', 'ref-a'), false);
  // Unknown ref.
  assert.equal(store.hasExternalRef('s1', 'ref-b'), false);
});

test('countMessages and maxSeq reflect appended rows', () => {
  seedSession();
  assert.equal(store.countMessages('s1'), 0);
  assert.equal(store.maxSeq('s1'), 0, 'maxSeq on empty session is 0');

  store.appendMessage(msg({ seq: 1 }));
  store.appendMessage(msg({ seq: 2 }));
  store.appendMessage(msg({ seq: 5 }));

  assert.equal(store.countMessages('s1'), 3);
  assert.equal(store.maxSeq('s1'), 5, 'maxSeq returns the highest seq, not the count');
});

test('listMessages honours afterSeq and returns seq-ordered rows', () => {
  seedSession();
  store.appendMessage(msg({ seq: 3, payload: JSON.stringify({ text: 'c' }) }));
  store.appendMessage(msg({ seq: 1, payload: JSON.stringify({ text: 'a' }) }));
  store.appendMessage(msg({ seq: 2, payload: JSON.stringify({ text: 'b' }) }));

  const all = store.listMessages('s1');
  assert.deepEqual(all.map((r) => r.seq), [1, 2, 3], 'ordered ascending by seq');

  const tail = store.listMessages('s1', 1);
  assert.deepEqual(tail.map((r) => r.seq), [2, 3], 'afterSeq is exclusive');
});

test('getSessionByExternalId finds the bound session', () => {
  seedSession({ id: 's1', external_session_id: 'ext-123' });
  const found = store.getSessionByExternalId('ext-123');
  assert.ok(found);
  assert.equal(found!.id, 's1');
  assert.equal(store.getSessionByExternalId('nope'), undefined);
});

test('deleteSessionCascade removes the session and its messages', () => {
  seedSession();
  store.appendMessage(msg({ seq: 1 }));
  store.appendMessage(msg({ seq: 2 }));
  assert.equal(store.countMessages('s1'), 2);

  store.deleteSessionCascade('s1');

  assert.equal(store.getSession('s1'), undefined);
  assert.equal(store.countMessages('s1'), 0, 'child messages are gone too');
});
