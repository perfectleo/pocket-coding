// Integration tests for the host session scanner. It walks the AI tools' own
// on-disk directories (~/.claude/projects, ~/.codex/sessions/YYYY/MM/DD) to
// build the "import desktop session" picker list.
//
// IMPORTANT: session-scanner.ts resolves CLAUDE_DIR / CODEX_DIR from homedir()
// *at import time*. So HOME must be set BEFORE the dynamic import below. Under
// `node --test test/*.test.ts` each file runs in its own process, so this env
// mutation is isolated to this suite.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'pocket-scanner-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const { scanHostSessions, findHostSession } = await import(
  '../src/hosts/session-scanner.js'
);

const CLAUDE_ROOT = join(HOME, '.claude', 'projects');
const CODEX_ROOT = join(HOME, '.codex', 'sessions');

/** Write a claude transcript and stamp its mtime (seconds) so we can assert
 *  the most-recent-first ordering deterministically. */
function seedClaude(id: string, cwd: string, mtimeSec: number, text = 'hello'): void {
  const dir = join(CLAUDE_ROOT, '-' + id);
  mkdirSync(dir, { recursive: true });
  const fp = join(dir, `${id}.jsonl`);
  const jsonl = [
    JSON.stringify({ type: 'user', sessionId: id, cwd, uuid: 'u1', message: { role: 'user', content: text } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'ok' }] } }),
  ].join('\n');
  writeFileSync(fp, jsonl, 'utf8');
  utimesSync(fp, mtimeSec, mtimeSec);
}

function seedCodex(id: string, cwd: string, mtimeSec: number): void {
  const dir = join(CODEX_ROOT, '2024', '01', '01');
  mkdirSync(dir, { recursive: true });
  const fp = join(dir, `rollout-2024-01-01T00-00-00-${id}.jsonl`);
  const jsonl = [
    JSON.stringify({ type: 'session_meta', payload: { id, cwd } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'say hi' }] } }),
  ].join('\n');
  writeFileSync(fp, jsonl, 'utf8');
  utimesSync(fp, mtimeSec, mtimeSec);
}

before(() => {
  // Three claude sessions with ascending mtimes + one codex session.
  seedClaude('claude-old', '/proj/a', 1000);
  seedClaude('claude-mid', '/proj/b', 2000);
  seedClaude('claude-new', '/proj/a', 3000);
  seedCodex('codex-1', '/proj/c', 2500);
});

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test('scanHostSessions returns all sessions sorted most-recent first', () => {
  const all = scanHostSessions();
  const ids = all.map((s) => s.externalSessionId);
  // mtimes: new(3000) > codex(2500) > mid(2000) > old(1000)
  assert.deepEqual(ids, ['claude-new', 'codex-1', 'claude-mid', 'claude-old']);
});

test('scanHostSessions maps tool id, cwd, summary and message count', () => {
  const all = scanHostSessions();
  const claude = all.find((s) => s.externalSessionId === 'claude-new')!;
  assert.equal(claude.toolId, 'claude-code');
  assert.equal(claude.cwd, '/proj/a');
  assert.equal(claude.summary, 'hello');
  assert.equal(claude.messageCount, 2, 'one user + one assistant line');

  const codex = all.find((s) => s.externalSessionId === 'codex-1')!;
  assert.equal(codex.toolId, 'codex');
  assert.equal(codex.cwd, '/proj/c');
  assert.equal(codex.summary, 'say hi');
});

test('tool filter narrows to a single tool', () => {
  const codexOnly = scanHostSessions({ tool: 'codex' });
  assert.equal(codexOnly.length, 1);
  assert.equal(codexOnly[0].externalSessionId, 'codex-1');

  const claudeOnly = scanHostSessions({ tool: 'claude-code' });
  assert.deepEqual(
    claudeOnly.map((s) => s.externalSessionId).sort(),
    ['claude-mid', 'claude-new', 'claude-old'],
  );
});

test('cwd filter keeps only sessions rooted there', () => {
  const inA = scanHostSessions({ cwd: '/proj/a' });
  assert.deepEqual(inA.map((s) => s.externalSessionId), ['claude-new', 'claude-old']);
});

test('limit only fully reads the most-recent N files', () => {
  const top = scanHostSessions({ limit: 1 });
  assert.equal(top.length, 1);
  assert.equal(top[0].externalSessionId, 'claude-new', 'newest by mtime');
});

test('findHostSession locates a session by external id across tools', () => {
  const claude = findHostSession('claude-mid');
  assert.ok(claude);
  assert.equal(claude!.toolId, 'claude-code');
  assert.equal(claude!.cwd, '/proj/b');

  const codex = findHostSession('codex-1');
  assert.ok(codex);
  assert.equal(codex!.toolId, 'codex');

  assert.equal(findHostSession('does-not-exist'), null);
});
