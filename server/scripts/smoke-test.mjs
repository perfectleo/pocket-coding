// Smoke test for pocket-agent: pair → create session → attach WS → input → see events.
// Run: node scripts/smoke-test.mjs
import { WebSocket } from 'ws';

const BASE = process.env.BASE || 'http://127.0.0.1:8080';
const WS_BASE = process.env.WS_BASE || 'ws://127.0.0.1:8080';

async function json(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
  const r = await fetch(BASE + path, { ...opts, headers });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}

async function main() {
  console.log('1. health');
  const h = await json('/api/health');
  console.log('  ', h);

  console.log('2. pair code');
  const pc = await json('/api/pair/code', { method: 'POST', body: '{}' });
  console.log('  ', pc);
  if (!pc.body?.code) throw new Error('no code');

  console.log('3. pair');
  const p = await json('/api/pair', {
    method: 'POST',
    body: JSON.stringify({ code: pc.body.code, name: 'smoke-test' }),
  });
  console.log('  ', p);
  if (!p.body?.token) throw new Error('pair failed');
  const token = p.body.token;

  console.log('4. tools');
  const tools = await json('/api/hosts/tools', { headers: { authorization: `Bearer ${token}` } });
  console.log('  ', tools);

  console.log('5. create session (claude-code)');
  const s = await json('/api/sessions', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'smoke', toolId: 'claude-code', cwd: '/tmp' }),
  });
  console.log('  ', s);
  if (!s.body?.id) throw new Error('session create failed');
  const sid = s.body.id;

  console.log('6. ws attach');
  const ws = new WebSocket(`${WS_BASE}/ws?token=${token}`);
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });
  ws.send(JSON.stringify({ t: 'attach', sessionId: sid, lastSeq: 0 }));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    console.log('  evt', JSON.stringify(m).slice(0, 200));
  });

  console.log('7. input (will fail if claude not installed — that is OK for smoke)');
  ws.send(JSON.stringify({ t: 'input', sessionId: sid, text: 'say hi' }));

  console.log('8. list sessions');
  const ls = await json('/api/sessions', { headers: { authorization: `Bearer ${token}` } });
  console.log('  ', ls.body?.sessions?.length, 'sessions');

  console.log('9. messages');
  const ms = await json(`/api/sessions/${sid}/messages`, {
    headers: { authorization: `Bearer ${token}` },
  });
  console.log('  ', ms.body?.messages?.length, 'messages');

  await new Promise((r) => setTimeout(r, 2000));
  ws.close();
  console.log('done');
  process.exit(0);
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
