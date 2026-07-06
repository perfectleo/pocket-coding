// End-to-end test: simulates app pairing + chat flow.
// Run: node scripts/e2e-test.mjs
import { WebSocket } from 'ws';

const BASE = 'http://127.0.0.1:8080';
const WS_BASE = 'ws://127.0.0.1:8080';

async function json(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
  const r = await fetch(BASE + path, { ...opts, headers });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}

const log = (...a) => console.log(...a);

async function main() {
  log('=== Pocket Coding end-to-end test ===\n');

  // 1. pair code (simulating user request from app)
  log('[1] request pair code');
  const pc = await json('/api/pair/code', { method: 'POST', body: '{}' });
  if (pc.status !== 200) throw new Error(`pair code failed: ${pc.status}`);
  log('   code:', pc.body.code, 'expires:', new Date(pc.body.expiresAt).toISOString());

  // 2. pair (simulating user entering code)
  log('[2] pair');
  const p = await json('/api/pair', {
    method: 'POST',
    body: JSON.stringify({ code: pc.body.code, name: 'e2e-test' }),
  });
  if (p.status !== 200) throw new Error(`pair failed: ${p.status}`);
  log('   deviceId:', p.body.deviceId);
  log('   token:', p.body.token.slice(0, 30) + '...');
  const token = p.body.token;

  // 3. detect tools
  log('[3] detect tools');
  const tools = await json('/api/hosts/tools', { headers: { authorization: `Bearer ${token}` } });
  log('   tools:', tools.body.tools.map((t) => `${t.id}(${t.installed ? 'on' : 'off'})`));

  // 4. reject bad token
  log('[4] reject bad token');
  const bad = await json('/api/sessions', {
    method: 'POST',
    headers: { authorization: 'Bearer invalid.token.here', 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'x', toolId: 'claude-code' }),
  });
  log('   status:', bad.status, bad.body.error);
  if (bad.status !== 401) throw new Error('bad token should be rejected');

  // 5. reject expired/invalid pair code
  log('[5] reject invalid pair code');
  const badPair = await json('/api/pair', {
    method: 'POST',
    body: JSON.stringify({ code: '000000', name: 'x' }),
  });
  log('   status:', badPair.status, badPair.body.error);
  if (badPair.status !== 401) throw new Error('invalid code should be rejected');

  // 6. create session
  log('[6] create session');
  const s = await json('/api/sessions', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'e2e', toolId: 'claude-code', cwd: '/tmp' }),
  });
  if (s.status !== 200) throw new Error(`session create failed: ${s.status}`);
  log('   sessionId:', s.body.id, 'state:', s.body.state);
  const sid = s.body.id;

  // 7. ws attach + collect events
  log('[7] ws attach + collect events for 3s');
  const ws = new WebSocket(`${WS_BASE}/ws?token=${token}`);
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });
  const events = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    events.push(m);
  });
  ws.send(JSON.stringify({ t: 'attach', sessionId: sid, lastSeq: 0 }));

  // 8. send input
  log('[8] send input');
  ws.send(JSON.stringify({ t: 'input', sessionId: sid, text: 'say hi in one word' }));

  await new Promise((r) => setTimeout(r, 3000));
  log(`   collected ${events.length} events:`);
  for (const e of events) {
    const summary = e.t === 'event' ? `${e.event.type}${e.event.text ? ': ' + e.event.text.slice(0, 50) : ''}` : `${e.t}:${e.state || ''}`;
    log(`     seq=${e.seq} ${summary}`);
  }

  // 9. list sessions
  log('[9] list sessions');
  const ls = await json('/api/sessions', { headers: { authorization: `Bearer ${token}` } });
  log('   count:', ls.body.sessions.length);

  // 10. messages
  log('[10] messages');
  const ms = await json(`/api/sessions/${sid}/messages`, {
    headers: { authorization: `Bearer ${token}` },
  });
  log('   count:', ms.body.messages.length);

  // 11. interrupt
  log('[11] interrupt');
  ws.send(JSON.stringify({ t: 'interrupt', sessionId: sid }));
  await new Promise((r) => setTimeout(r, 500));

  ws.close();

  log('\n=== ALL CHECKS PASSED ===');
  process.exit(0);
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
