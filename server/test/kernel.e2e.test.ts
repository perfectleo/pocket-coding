// Kernel end-to-end: drives the REAL AI CLI (claude / codebuddy / codex)
// through the SessionManager, exactly as a live turn would, and asserts the
// core contract that everything else builds on:
//   1. a fresh turn spawns the tool, captures its own session id from stdout,
//      streams an assistant message, and persists it to SQLite;
//   2. after a simulated server restart (drop from cache → rehydrate), the
//      next turn resumes the SAME tool session (`--resume <id>`) rather than
//      starting a new conversation, and history keeps accumulating.
//
// This is SLOW and needs a real CLI + credentials, so it is DOUBLE-GATED and
// SKIPS (never fails) unless you opt in:
//   POCKET_KERNEL_E2E=1 npm run test:kernel
// Pick a specific tool with POCKET_KERNEL_E2E_TOOL=claude-code|codebuddy|codex
// (otherwise the first installed one is used). Because it is gated, it is safe
// for `npm test` / CI to collect it — it just reports as skipped there.
//
// All on-disk state is isolated in a temp HOME + temp workspace (self-seeded),
// so it never touches the developer's real ~/.claude or ~/.codex history.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'pocket-kernel-e2e-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.POCKET_DATA_DIR = join(HOME, '.pocket');
process.env.POCKET_JWT_SECRET = 'kernel-e2e-secret-not-for-prod';
process.env.POCKET_WORKSPACES_DIR = join(HOME, 'workspaces');

const ENABLED = !!process.env.POCKET_KERNEL_E2E;
const TURN_TIMEOUT_MS = Number(process.env.POCKET_KERNEL_E2E_TIMEOUT_MS || 150_000);

const { sessionManager } = await import('../src/session/manager.js');
const { Store } = await import('../src/store/sqlite.js');
const { dbPath } = await import('../src/config.js');
const { getAdapter } = await import('../src/adapters/index.js');
type ToolId = import('../src/protocol.js').ToolId;
type ServerMessage = import('../src/protocol.js').ServerMessage;

let store: InstanceType<typeof Store>;

async function pickTool(): Promise<ToolId | null> {
  const pref = process.env.POCKET_KERNEL_E2E_TOOL as ToolId | undefined;
  const order: ToolId[] = pref ? [pref] : ['claude-code', 'codebuddy', 'codex'];
  for (const id of order) {
    const a = getAdapter(id);
    if (!a) continue;
    const d = await a.detect();
    if (d.installed) return id;
  }
  return null;
}

/** Poll a predicate until true or timeout. Used to await async turn milestones
 *  (assistant message arrived / turn settled) driven by real CLI stdout. */
function waitFor(pred: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (pred()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error(`timeout waiting for ${label}`));
      }
    }, 200);
  });
}

before(() => {
  store = new Store(dbPath);
});

after(() => {
  try { store?.close(); } catch { /* already closed */ }
  rmSync(HOME, { recursive: true, force: true });
});

test('real CLI turn: spawn → capture session id → stream assistant reply → persist', async (t) => {
  if (!ENABLED) {
    t.skip('set POCKET_KERNEL_E2E=1 to run the real-CLI kernel e2e');
    return;
  }
  const toolId = await pickTool();
  if (!toolId) {
    t.skip('no claude/codebuddy/codex CLI installed on PATH');
    return;
  }

  const cwd = join(HOME, 'workspaces', 'kernel-proj');
  mkdirSync(cwd, { recursive: true });

  const session = await sessionManager.create({
    projectId: 'kernel-e2e',
    toolId,
    cwd,
    store,
  });

  // Collect the live server-message stream just like a WS subscriber would.
  const events: ServerMessage[] = [];
  const gotAssistant = () =>
    events.some(
      (m) => m.t === 'event' && m.event?.type === 'message' && m.event?.role === 'assistant',
    );
  sessionManager.attach(session, -1, (m) => events.push(m));

  // Deterministic, tool-free prompt to keep the assertion stable across models.
  const PROMPT = 'Reply with exactly the single word: DONE. Do not use any tools.';
  sessionManager.input(session, PROMPT, store);

  await waitFor(gotAssistant, TURN_TIMEOUT_MS, 'first assistant message');

  // The tool must have emitted (and we must have captured+persisted) its own
  // session id — this is what makes desktop `--resume` and re-spawn work.
  assert.ok(session.externalSessionId, 'externalSessionId should be captured from stdout');
  const capturedId = session.externalSessionId!;
  assert.equal(
    store.getSession(session.id)?.external_session_id,
    capturedId,
    'captured session id should be persisted to SQLite',
  );

  // The assistant reply must be persisted as an app-sourced message.
  const persisted = store.listMessages(session.id, -1);
  const assistantRows = persisted.filter((r) => r.role === 'assistant');
  assert.ok(assistantRows.length >= 1, 'assistant reply should be persisted');

  // --- simulate a server restart, then a second turn that must RESUME ---
  // On a real restart the whole server process dies, taking its child CLI
  // process with it. In-process we must kill it explicitly, otherwise the
  // (resident) CLI child stays alive and keeps the event loop from settling.
  if (session.proc) {
    try { session.proc.kill('SIGKILL'); } catch { /* already dead */ }
  }
  sessionManager.dropFromCache(session.id);
  const row = store.getSession(session.id);
  assert.ok(row, 'session row should survive the cache drop');
  const revived = sessionManager.rehydrate(row!, store);
  assert.equal(revived.externalSessionId, capturedId, 'rehydrate restores the captured id');
  assert.equal(revived.hasRunOnce, true, 'rehydrated session must re-spawn with --resume');

  const events2: ServerMessage[] = [];
  const gotAssistant2 = () =>
    events2.some(
      (m) => m.t === 'event' && m.event?.type === 'message' && m.event?.role === 'assistant',
    );
  sessionManager.attach(revived, -1, (m) => events2.push(m));
  sessionManager.input(revived, 'Reply with exactly: DONE2. Do not use any tools.', store);
  await waitFor(gotAssistant2, TURN_TIMEOUT_MS, 'second (resumed) assistant message');

  // Resuming must keep the SAME tool session id, and history must grow, never
  // reset — proving the conversation continued rather than starting fresh.
  assert.equal(revived.externalSessionId, capturedId, 'resume keeps the same tool session id');
  const afterResume = store.listMessages(revived.id, -1);
  assert.ok(
    afterResume.length > persisted.length,
    'second turn should append more messages, not restart history',
  );

  sessionManager.deleteSession(revived, store);
});
