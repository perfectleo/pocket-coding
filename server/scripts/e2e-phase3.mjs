// Phase 3 e2e: preview dev server + auth reverse proxy.
// Run: node scripts/e2e-phase3.mjs
import { WebSocket } from 'ws';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:8080';
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
  return { status: r.status, body: t ? (() => { try { return JSON.parse(t); } catch { return t; } })() : null, text: t };
}

async function raw(path, opts = {}) {
  return fetch(BASE + path, opts);
}

async function main() {
  log('=== Phase 3: preview dev server + proxy ===\n');

  // 1. pair + token
  log('[1] pair');
  const pc = await json('/api/pair/code', { method: 'POST', body: '{}' });
  const p = await json('/api/pair', { method: 'POST', body: JSON.stringify({ code: pc.body.code, name: 'p3-test' }) });
  const token = p.body.token;
  const auth = { authorization: `Bearer ${token}` };

  // 2. Create a fake dev-server project as cwd for a session.
  log('[2] scaffold fake dev-server project');
  const projDir = mkdtempSync(join(tmpdir(), 'pocket-p3-proj-'));
  writeFileSync(join(projDir, 'package.json'), JSON.stringify({
    name: 'p3-fake-preview',
    scripts: { dev: 'node server.js' },
  }));
  writeFileSync(join(projDir, 'server.js'), `
const http = require('http');
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/plain');
  res.end('hello from preview dev server at ' + req.url);
});
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  console.log('Local: http://localhost:' + port);
});
`);

  // 3. Create session with that cwd.
  log('[3] create session with fake project cwd');
  const s = await json('/api/sessions', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'p3', toolId: 'claude-code', cwd: projDir }),
  });
  if (s.status !== 200) throw new Error(`session create failed: ${s.status}`);
  const sid = s.body.id;
  log('   sessionId:', sid);

  // 4. Start preview.
  log('[4] preview start');
  const start = await json(`/api/sessions/${sid}/preview/start`, { method: 'POST', headers: auth });
  log('   token:', start.body.token, 'state:', start.body.state);
  check(start.status === 200, 'preview start returns 200');
  check(!!start.body.token, 'preview token issued');

  // 5. Poll status until ready (up to 8s).
  log('[5] poll status until ready');
  let ready = false;
  let statusBody = null;
  for (let i = 0; i < 16; i++) {
    const st = await json(`/api/sessions/${sid}/preview/status`, { headers: auth });
    statusBody = st.body;
    if (st.body?.state === 'ready') { ready = true; break; }
    if (st.body?.state === 'error') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  log('   final state:', statusBody?.state, 'port:', statusBody?.port);
  check(ready, 'preview reaches ready state');
  check(typeof statusBody?.port === 'number' && statusBody.port > 0, 'port detected');

  // 6. Fetch via proxy.
  log('[6] fetch via proxy /preview/{token}/');
  const proxyRes = await raw(`/preview/${start.body.token}/`);
  const proxyText = await proxyRes.text();
  log('   proxy status:', proxyRes.status, 'body:', proxyText.slice(0, 80));
  check(proxyRes.status === 200, 'proxy returns 200');
  check(proxyText.includes('hello from preview dev server'), 'proxy body came from dev server');

  // 7. Fetch a sub-path.
  log('[7] fetch sub-path /preview/{token}/foo/bar');
  const sub = await raw(`/preview/${start.body.token}/foo/bar`);
  const subText = await sub.text();
  check(sub.status === 200 && subText.includes('/foo/bar'), 'sub-path proxied correctly');

  // 8. Logs endpoint.
  log('[8] logs');
  const logs = await json(`/api/sessions/${sid}/preview/logs`, { headers: auth });
  check(typeof logs.body?.logs === 'string' && logs.body.logs.length > 0, 'logs returned');
  check(logs.body.logs.includes('Local: http://localhost:'), 'logs contain port-detection line');

  // 9. Stop preview.
  log('[9] stop preview');
  const stop = await json(`/api/sessions/${sid}/preview/stop`, { method: 'POST', headers: auth });
  check(stop.status === 200 && stop.body.ok === true, 'preview stop ok');
  await new Promise((r) => setTimeout(r, 500));
  const stAfter = await json(`/api/sessions/${sid}/preview/status`, { headers: auth });
  check(stAfter.body?.state === 'stopped' || stAfter.body?.state === 'error',
    `state after stop: ${stAfter.body?.state}`);

  // 10. Proxy after stop → 404.
  log('[10] proxy after stop → 404');
  const after = await raw(`/preview/${start.body.token}/`);
  check(after.status === 404, 'proxy 404 after stop');

  // 11. Reject preview fetch with unknown token.
  log('[11] unknown token rejected');
  const unk = await raw('/preview/deadbeefdeadbeef/');
  check(unk.status === 404, 'unknown token → 404');

  log(`\n=== Phase 3: ${pass} passed, ${fail} failed ===`);
  rmSync(projDir, { recursive: true, force: true });
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
