// Diagnostic: simulate the exact Flutter app chat flow with a real session.
// Verifies: pair → create session → WS attach → send input → receive assistant reply.
import { WebSocket } from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:8080';
const WS_BASE = 'ws://127.0.0.1:8080';

async function json(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
  const r = await fetch(BASE + path, { ...opts, headers });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}

async function main() {
  console.log('=== Chat flow diagnostic ===\n');

  // 1. pair
  console.log('[1] pair');
  const pc = await json('/api/pair/code', { method: 'POST', body: '{}' });
  const p = await json('/api/pair', { method: 'POST', body: JSON.stringify({ code: pc.body.code, name: 'diag-chat' }) });
  const token = p.body.token;
  const auth = { authorization: `Bearer ${token}` };
  console.log('   token:', token.slice(0, 30) + '...');

  // 2. create session with a real cwd
  console.log('[2] create session');
  const projDir = mkdtempSync(join(tmpdir(), 'pocket-chat-'));
  const s = await json('/api/sessions', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'diag-chat', toolId: 'claude-code', cwd: projDir }),
  });
  const sid = s.body.id;
  console.log('   sessionId:', sid);

  // 3. WS attach
  console.log('[3] WS connect + attach');
  const ws = new WebSocket(`${WS_BASE}/ws?token=${token}`);
  await new Promise((res, rej) => {
    ws.on('open', () => { console.log('   ws OPEN'); res(); });
    ws.on('error', (e) => { console.error('   ws ERROR:', e.message); rej(e); });
  });
  const events = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    events.push(msg);
    const ev = msg.event;
    let prev = '';
    if (ev) {
      if (ev.type === 'message') prev = `message: ${ev.text.slice(0, 60)}`;
      else if (ev.type === 'tool_call') prev = `tool_call: ${ev.name}`;
      else if (ev.type === 'tool_result') prev = `tool_result: ${(ev.output||'').slice(0,60)}`;
      else if (ev.type === 'status') prev = `status: ${ev.state}`;
      else if (ev.type === 'raw') prev = `raw: ${(ev.data||'').slice(0,60)}`;
      else prev = `${ev.type}`;
    } else {
      prev = `${msg.t}: ${msg.state||''}`;
    }
    console.log(`   <- seq=${msg.seq} ${prev}`);
  });
  ws.send(JSON.stringify({ t: 'attach', sessionId: sid, lastSeq: 0 }));
  await new Promise((r) => setTimeout(r, 500));

  // 4. send input
  console.log('\n[4] send input: "say hi briefly"');
  ws.send(JSON.stringify({ t: 'input', sessionId: sid, text: 'say hi briefly' }));

  // 5. wait for assistant message or done
  console.log('[5] waiting for response (up to 30s)...');
  let gotAssistant = false;
  let gotDone = false;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (events.some((e) => e.event?.type === 'message' && e.event?.role === 'assistant')) {
      gotAssistant = true;
    }
    if (events.some((e) =>
      (e.t === 'status' && e.state === 'done') ||
      (e.t === 'event' && e.event?.type === 'status' && e.event?.state === 'done')
    )) {
      gotDone = true;
      break;
    }
  }

  console.log(`\n=== Result: assistant_msg=${gotAssistant} done=${gotDone} ===`);
  console.log(`total events: ${events.length}`);
  if (!gotAssistant) {
    console.log('FAIL: no assistant message received');
    process.exit(1);
  }
  console.log('PASS: chat flow works end-to-end');
  ws.close();
  rmSync(projDir, { recursive: true, force: true });
  process.exit(0);
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
