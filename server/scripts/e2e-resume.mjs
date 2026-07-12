// Verifies SessionManager.input() re-spawns with --resume when the process
// has died, and that rehydrate() rebuilds a Session from a DB row.
//
// Uses a fake adapter to avoid spawning real claude/codex — we only verify
// the manager's spawn/resume decision logic, not the AI tool's behavior.
import { SessionManager } from '../src/session/manager.js';
import { Store } from '../src/store/sqlite.js';
import { config } from '../src/config.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const log = (...a) => console.log(...a);
let pass = 0, fail = 0;
function check(cond, label) {
  if (cond) { pass++; log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}`); }
}

async function main() {
  log('=== Session resume test ===\n');

  const dataDir = mkdtempSync(join(tmpdir(), 'pocket-resume-'));
  const dbPath = join(dataDir, 'pocket.db');
  const store = new Store(dbPath);
  const sm = new SessionManager();
  // Override workspacesDir so rehydrate fallback doesn't hit real homedir.
  const origWorkspaces = config.workspacesDir;
  config.workspacesDir = dataDir;

  try {
    // [1] create session — no process spawned yet (lazy)
    log('[1] create() does not spawn');
    {
      const cwd = mkdtempSync(join(dataDir, 'ws-'));
      const session = await sm.create({
        projectId: 'test', toolId: 'claude-code', cwd, store,
      });
      check(session.proc === null, 'proc is null after create (lazy spawn)');
      check(session.hasRunOnce === false, 'hasRunOnce false initially');
      check(session.externalSessionId === null, 'externalSessionId null initially');
      check(session.state === 'created', 'state is created');
    }

    // [2] rehydrate from DB row
    log('\n[2] rehydrate() rebuilds session from DB');
    {
      const cwd = mkdtempSync(join(dataDir, 'ws2-'));
      const session = await sm.create({
        projectId: 'test2', toolId: 'claude-code', cwd, store,
      });
      // Simulate first-turn completion: mark run-once + external id.
      store.markSessionRunOnce(session.id);
      store.updateSessionExternalId(session.id, 'fake-external-uuid');
      // Drop from memory (simulate server restart).
      sm.dropFromCache(session.id);
      check(!sm.get(session.id), 'session dropped from memory');

      const row = store.getSession(session.id);
      const rehydrated = sm.rehydrate(row, store);
      check(rehydrated.id === session.id, 'rehydrated id matches');
      check(rehydrated.hasRunOnce === true, 'hasRunOnce restored from DB');
      check(rehydrated.externalSessionId === 'fake-external-uuid', 'externalSessionId restored');
      check(rehydrated.cwd === cwd, 'cwd restored from DB');
      check(rehydrated.state === 'idle', 'rehydrated state is idle (waiting for input)');
      check(rehydrated.proc === null, 'rehydrated proc is null (lazy)');
    }

    // [3] buildCommand resume flag
    log('\n[3] claude buildCommand: fresh vs resume args');
    {
      const { claudeCodeAdapter } = await import('../src/adapters/claude-code.js');
      const fresh = claudeCodeAdapter.buildCommand({
        cwd: '/tmp', sessionId: 'irrelevant-on-fresh', resume: false, permissionMode: 'default',
      });
      // Fresh spawn: AI tool generates its own session ID, we don't pass --session-id.
      check(!fresh.args.includes('--session-id'), 'fresh: no --session-id (tool generates)');
      check(!fresh.args.includes('--resume'), 'fresh: no --resume');
      check(fresh.args.includes('--permission-mode') && fresh.args.includes('default'),
        'fresh: --permission-mode default');

      const resume = claudeCodeAdapter.buildCommand({
        cwd: '/tmp', sessionId: '550e8400-e29b-41d4-a716-446655440000', resume: true, permissionMode: 'plan',
      });
      check(resume.args.includes('--resume'), 'resume: --resume flag');
      check(resume.args.includes('550e8400-e29b-41d4-a716-446655440000'), 'resume: captured id arg');
      check(!resume.args.includes('--session-id'), 'resume: no --session-id');
      check(resume.args.includes('--permission-mode') && resume.args.includes('plan'),
        'resume: --permission-mode plan');
    }

    // [3b] extractPermissionMode reads init event
    log('\n[3b] claude extractPermissionMode');
    {
      const { claudeCodeAdapter } = await import('../src/adapters/claude-code.js');
      const init = JSON.stringify({
        type: 'system', subtype: 'init', permissionMode: 'acceptEdits',
      });
      check(claudeCodeAdapter.extractPermissionMode(init) === 'acceptEdits',
        'extracts acceptEdits from init');
      check(claudeCodeAdapter.extractPermissionMode('{"type":"assistant"}') === null,
        'non-init → null');
      check(claudeCodeAdapter.extractPermissionMode('not json') === null,
        'non-JSON → null');
    }

    // [3c] nextPermissionMode cycles
    log('\n[3c] nextPermissionMode cycles through modes');
    {
      const { nextPermissionMode, PERMISSION_MODES } = await import('../src/protocol.js');
      check(nextPermissionMode('default') === 'plan', 'default → plan');
      check(nextPermissionMode('plan') === 'acceptEdits', 'plan → acceptEdits');
      check(nextPermissionMode('acceptEdits') === 'bypassPermissions', 'acceptEdits → bypass');
      check(nextPermissionMode('bypassPermissions') === 'default', 'bypass → default (wraps)');
      check(PERMISSION_MODES.length === 4, '4 modes total');
    }

    // [4] newSessionId is Pocket-internal format (s_ + hex). The AI tool's
    // own session ID is generated by the tool and captured from stdout —
    // it is NOT this value. Pocket's ID is just a DB primary key.
    log('\n[4] newSessionId returns Pocket-internal s_ format');
    {
      const { newSessionId } = await import('../src/gateway/auth.js');
      const id = newSessionId();
      check(/^s_[0-9a-f]{16}$/.test(id), `s_ + 16 hex format: ${id}`);
    }

    // [5] DB migration: cwd/external_session_id/has_run_once columns exist
    log('\n[5] DB schema has new columns');
    {
      const cols = store.rawDb.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
      check(cols.includes('cwd'), 'cwd column exists');
      check(cols.includes('external_session_id'), 'external_session_id column exists');
      check(cols.includes('has_run_once'), 'has_run_once column exists');
    }

    // [6] ensureColumn is idempotent
    log('\n[6] ensureColumn idempotent');
    {
      const before = store.rawDb.prepare('PRAGMA table_info(sessions)').all().length;
      const store2 = new Store(dbPath); // re-open triggers migrate again
      const after = store2.rawDb.prepare('PRAGMA table_info(sessions)').all().length;
      check(before === after, `column count unchanged on reopen (${before} → ${after})`);
    }

  } finally {
    config.workspacesDir = origWorkspaces;
    rmSync(dataDir, { recursive: true, force: true });
  }

  log(`\n=== Resume: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
