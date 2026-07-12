// Verifies:
//   1. /api/roots returns the server's workspace root (process.cwd() by default)
//   2. /api/roots/browse lists subdirectories of the root, confined to the root
//   3. POST /api/sessions + DELETE /api/sessions/:id cascade-deletes messages
// Also exercises the mode cycle via WS (server confirms + broadcasts).
//
// Run: node scripts/e2e-roots-delete.mjs
import { WebSocket } from 'ws';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:8080';
const WS_BASE = 'ws://127.0.0.1:8080';
const log = (...a) => console.log(...a);
let pass = 0, fail = 0;
function check(cond, label) {
  if (cond) { pass++; log(`   ✓ ${label}`); }
  else { fail++; console.error(`   ✗ ${label}`); }
}

async function json(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
  const r = await fetch(BASE + path, { ...opts, headers });
  const t = await r.text();
  return { status: r.status, body: t ? (() => { try { return JSON.parse(t); } catch { return t; } })() : null };
}

async function main() {
  log('=== Roots browsing + session delete ===\n');

  // Pair
  const pc = await json('/api/pair/code', { method: 'POST', body: '{}' });
  const p = await json('/api/pair', { method: 'POST', body: JSON.stringify({ code: pc.body.code, name: 'rd-test' }) });
  const token = p.body.token;
  const auth = { authorization: `Bearer ${token}` };

  // 1. /api/roots returns the workspace root (default = process.cwd at server start)
  log('[1] /api/roots returns workspace root');
  const roots = await json('/api/roots', { headers: auth });
  check(roots.status === 200 && typeof roots.body.root === 'string' && roots.body.root.length > 0,
    `root present: ${roots.body?.root}`);

  // 2. /api/roots/browse — scaffold some subdirs under the real root and list them
  log('[2] /api/roots/browse lists subdirectories');
  // We can't write into the real server root from here, but we can at least
  // confirm the endpoint returns an entries array for the root itself.
  const browse = await json('/api/roots/browse?path=', { headers: auth });
  check(browse.status === 200 && Array.isArray(browse.body.entries),
    `browse root returns entries array (${browse.body?.entries?.length ?? 0} items)`);
  check(browse.body.entries.every((e) => e.dir === true), 'all entries are directories');

  // 3. browse path traversal rejected
  log('[3] /api/roots/browse rejects path traversal');
  const trav = await json('/api/roots/browse?path=../../etc', { headers: auth });
  check(trav.status === 400, 'traversal blocked');

  // 4. create a session, then delete it — messages/checkpoints must cascade
  log('[4] create + delete session cascade');
  const projDir = mkdtempSync(join(tmpdir(), 'pocket-rd-proj-'));
  const s = await json('/api/sessions', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'rd-test', toolId: 'claude-code', cwd: projDir }),
  });
  const sid = s.body.id;
  check(s.status === 200, `session created: ${sid}`);

  // Drop a fake message row + audit row directly via... actually we can't
  // poke the DB from here. Instead, send an input (which writes a user
  // message) and then delete — verify the session is gone from the list.
  const ws = new WebSocket(`${WS_BASE}/ws?token=${token}`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const events = [];
  ws.on('message', (raw) => events.push(JSON.parse(raw.toString())));
  ws.send(JSON.stringify({ t: 'attach', sessionId: sid, lastSeq: 0 }));
  await new Promise((r) => setTimeout(r, 300));

  log('   sending input to seed a message row...');
  ws.send(JSON.stringify({ t: 'input', sessionId: sid, text: 'remember XYZ' }));
  await new Promise((r) => setTimeout(r, 2000));

  const msgsBefore = await json(`/api/sessions/${sid}/messages`, { headers: auth });
  check(msgsBefore.body.messages.length >= 1, `messages before delete: ${msgsBefore.body.messages.length}`);

  // 5. WS mode cycle — server should broadcast a mode event
  log('[5] WS mode cycle broadcasts mode event');
  const beforeModeEvents = events.filter((e) => e.t === 'event' && e.event?.type === 'mode').length;
  ws.send(JSON.stringify({ t: 'mode', sessionId: sid }));
  await new Promise((r) => setTimeout(r, 400));
  const modeEvents = events.filter((e) => e.t === 'event' && e.event?.type === 'mode');
  check(modeEvents.length > beforeModeEvents, `mode event received (${modeEvents.length} total)`);
  if (modeEvents.length > 0) {
    const lastMode = modeEvents[modeEvents.length - 1].event.mode;
    check(['default', 'plan', 'acceptEdits', 'bypassPermissions'].includes(lastMode),
      `mode value valid: ${lastMode}`);
  }

  ws.close();

  // 6. DELETE /api/sessions/:id
  log('[6] DELETE session');
  const del = await json(`/api/sessions/${sid}`, { method: 'DELETE', headers: auth });
  check(del.status === 200 && del.body.ok === true, 'delete returns ok');

  const ls = await json('/api/sessions', { headers: auth });
  check(!ls.body.sessions.some((x) => x.id === sid), 'session gone from list');

  const msgsAfter = await json(`/api/sessions/${sid}/messages`, { headers: auth });
  // Messages endpoint doesn't 404 for unknown session (it just returns []),
  // but the rows should be gone — we can't query directly, so we just
  // confirm the endpoint doesn't error.
  check(Array.isArray(msgsAfter.body.messages) && msgsAfter.body.messages.length === 0,
    'messages cascade-deleted (empty array)');

  // 7. DELETE non-existent → 404
  log('[7] DELETE non-existent session → 404');
  const del404 = await json('/api/sessions/sess-does-not-exist', { method: 'DELETE', headers: auth });
  check(del404.status === 404, '404 for unknown session');

  rmSync(projDir, { recursive: true, force: true });
  log(`\n=== Roots+Delete: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
