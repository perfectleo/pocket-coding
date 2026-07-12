// Smoke test: simulate the Flutter PreviewPage's API calls.
// Verifies: start → poll status → fetch via proxy → logs → restart → stop.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:8080';
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
  log('=== Preview page smoke (Flutter PreviewPage API sequence) ===\n');

  // pair
  const pc = await json('/api/pair/code', { method: 'POST', body: '{}' });
  const p = await json('/api/pair', { method: 'POST', body: JSON.stringify({ code: pc.body.code, name: 'preview-app' }) });
  const token = p.body.token;
  const auth = { authorization: `Bearer ${token}` };

  // scaffold a dev server project
  const projDir = mkdtempSync(join(tmpdir(), 'pocket-preview-app-'));
  writeFileSync(join(projDir, 'package.json'), JSON.stringify({
    name: 'preview-app',
    scripts: { dev: 'node server.js' },
  }));
  writeFileSync(join(projDir, 'server.js'), `
const http = require('http');
const s = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<html><body><h1 id="title">Preview OK</h1><button id="go">Go</button></body></html>');
});
s.listen(0, '127.0.0.1', () => console.log('Local: http://localhost:' + s.address().port));
`);

  // create session
  const s = await json('/api/sessions', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'preview-app', toolId: 'claude-code', cwd: projDir }),
  });
  const sid = s.body.id;
  log('sessionId:', sid);

  // 1. PreviewPage.initState calls previewStatus — should be stopped initially
  log('[1] initial status (PreviewPage.initState)');
  const st0 = await json(`/api/sessions/${sid}/preview/status`, { headers: auth });
  check(st0.status === 200, 'status endpoint ok');
  check(st0.body.state === 'stopped', `initial state stopped (got ${st0.body.state})`);

  // 2. PreviewPage._start — POST /preview/start
  log('[2] start preview');
  const start = await json(`/api/sessions/${sid}/preview/start`, { method: 'POST', headers: auth });
  check(start.status === 200, 'start returns 200');
  check(!!start.body.token, 'token issued');

  // 3. Poll status until ready (PreviewPage._poll)
  log('[3] poll status until ready');
  let ready = false, statusBody = null;
  for (let i = 0; i < 20; i++) {
    const st = await json(`/api/sessions/${sid}/preview/status`, { headers: auth });
    statusBody = st.body;
    if (st.body?.state === 'ready') { ready = true; break; }
    if (st.body?.state === 'error') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  check(ready, `preview reaches ready (port ${statusBody?.port})`);
  check(typeof statusBody?.port === 'number' && statusBody.port > 0, 'port assigned');
  check(!!statusBody?.url, 'url returned');

  // 4. WebView loadRequest — fetch via proxy
  log('[4] fetch via proxy');
  const proxyRes = await fetch(`${BASE}/preview/${start.body.token}/`);
  const proxyText = await proxyRes.text();
  check(proxyRes.status === 200, 'proxy returns 200');
  check(proxyText.includes('Preview OK'), 'proxy serves dev server HTML');
  check(proxyText.includes('id="title"'), 'HTML structure preserved');

  // 5. Sub-path fetch (for navigation inside WebView)
  log('[5] sub-path fetch');
  const sub = await fetch(`${BASE}/preview/${start.body.token}/some/route`);
  check(sub.status === 200, 'sub-path proxied');

  // 6. Logs endpoint (PreviewPage._refreshLogs)
  log('[6] logs endpoint');
  const logs = await json(`/api/sessions/${sid}/preview/logs?tail=200`, { headers: auth });
  check(typeof logs.body?.logs === 'string', 'logs returned as string');
  check(logs.body.logs.includes('Local: http://localhost:'), 'logs contain port-detection line');

  // 7. Restart flow: stop then start (PreviewPage._restart)
  log('[7] restart (stop → start)');
  const stop1 = await json(`/api/sessions/${sid}/preview/stop`, { method: 'POST', headers: auth });
  check(stop1.body.ok === true, 'stop ok');
  await new Promise((r) => setTimeout(r, 400));
  const start2 = await json(`/api/sessions/${sid}/preview/start`, { method: 'POST', headers: auth });
  check(start2.status === 200 && !!start2.body.token, 'restart issues new token');

  let ready2 = false;
  for (let i = 0; i < 20; i++) {
    const st = await json(`/api/sessions/${sid}/preview/status`, { headers: auth });
    if (st.body?.state === 'ready') { ready2 = true; break; }
    if (st.body?.state === 'error') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  check(ready2, 'preview ready again after restart');

  // 8. Final stop
  log('[8] final stop');
  const stop2 = await json(`/api/sessions/${sid}/preview/stop`, { method: 'POST', headers: auth });
  check(stop2.body.ok === true, 'stop ok');
  await new Promise((r) => setTimeout(r, 400));
  const stFinal = await json(`/api/sessions/${sid}/preview/status`, { headers: auth });
  check(stFinal.body?.state === 'stopped' || stFinal.body?.state === 'error',
    `final state stopped/error (got ${stFinal.body?.state})`);

  // 9. Proxy after stop → 404 (WebView would show error page)
  log('[9] proxy after stop');
  const after = await fetch(`${BASE}/preview/${start2.body.token}/`);
  check(after.status === 404, 'proxy 404 after stop');

  log(`\n=== Preview page smoke: ${pass} passed, ${fail} failed ===`);
  rmSync(projDir, { recursive: true, force: true });
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
