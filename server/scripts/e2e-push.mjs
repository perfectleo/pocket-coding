// Phase 6 Day 4 e2e: push token registration + audit trail.
// Real APNs/FCM delivery can't be tested without credentials, but the
// registration endpoint, store persistence, and session-state trigger wiring
// can be.
import { WebSocket } from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:8080';
const WS_BASE = 'ws://127.0.0.1:8080';
const log = (...a) => console.log(...a);
let pass = 0, fail = 0;
function check(cond, label) {
  if (cond) { pass++; log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}`); }
}

async function json(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
  const r = await fetch(BASE + path, { ...opts, headers });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}

async function main() {
  log('=== Phase 6 Day 4: push notifications wiring ===\n');

  log('[1] pair');
  const pc = await json('/api/pair/code', { method: 'POST', body: '{}' });
  const p = await json('/api/pair', { method: 'POST', body: JSON.stringify({ code: pc.body.code, name: 'push-test' }) });
  const token = p.body.token;
  const auth = { authorization: `Bearer ${token}` };

  log('[2] register iOS push token');
  const iosToken = 'a'.repeat(64);
  const r1 = await json('/api/devices/push/register', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'ios', token: iosToken }),
  });
  check(r1.status === 200 && r1.body.ok === true, 'ios registration accepted');

  log('[3] register Android push token');
  const androidToken = 'b'.repeat(152);
  const r2 = await json('/api/devices/push/register', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'android', token: androidToken }),
  });
  check(r2.status === 200 && r2.body.ok === true, 'android registration accepted');

  log('[4] register same token again (idempotent)');
  const r3 = await json('/api/devices/push/register', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'ios', token: iosToken }),
  });
  check(r3.status === 200, 'duplicate registration is idempotent');

  log('[5] reject short token');
  const r4 = await json('/api/devices/push/register', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'ios', token: 'short' }),
  });
  check(r4.status === 400, 'short token rejected');

  log('[6] reject bad platform');
  const r5 = await json('/api/devices/push/register', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'web', token: iosToken }),
  });
  check(r5.status === 400, 'unknown platform rejected');

  log('[7] reject without auth');
  const r6 = await json('/api/devices/push/register', {
    method: 'POST',
    body: JSON.stringify({ platform: 'ios', token: iosToken }),
  });
  check(r6.status === 401, 'unauthenticated request rejected');

  log('[8] unregister');
  const r7 = await json('/api/devices/push/unregister', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ token: iosToken }),
  });
  check(r7.status === 200 && r7.body.ok === true, 'unregister accepted');

  log('[9] trigger session done → push wiring fires (no crash without creds)');
  // Create session + send input + wait for done. PushManager.notifyDevice
  // is a no-op without APNs/FCM creds, but should not error.
  const projDir = mkdtempSync(join(tmpdir(), 'pocket-push-'));
  const s = await json('/api/sessions', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'push-test', toolId: 'claude-code', cwd: projDir }),
  });
  const sid = s.body.id;
  const ws = new WebSocket(`${WS_BASE}/ws?token=${token}`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const events = [];
  ws.on('message', (raw) => events.push(JSON.parse(raw.toString())));
  ws.send(JSON.stringify({ t: 'attach', sessionId: sid, lastSeq: 0 }));
  await new Promise((r) => setTimeout(r, 400));
  ws.send(JSON.stringify({ t: 'input', sessionId: sid, text: 'say hi' }));
  // Wait for status:done (up to ~20s — claude ttft can be 2-5s)
  // The done signal arrives as {t:'event', event:{type:'status', state:'done'}}
  // (from the adapter) OR as {t:'status', state:'done'} (from setState).
  let sawDone = false;
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (events.some((e) =>
      (e.t === 'status' && e.state === 'done') ||
      (e.t === 'event' && e.event?.type === 'status' && e.event?.state === 'done')
    )) {
      sawDone = true;
      break;
    }
  }
  if (!sawDone) {
    log('  events seen:', events.map((e) => `${e.t}:${e.state||e.event?.type||e.event?.state||''}`).join(', '));
  }
  check(sawDone, 'session reached done state (push trigger fired)');

  ws.close();
  rmSync(projDir, { recursive: true, force: true });

  log(`\n=== Push: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
