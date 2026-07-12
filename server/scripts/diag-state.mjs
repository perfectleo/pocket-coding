import { WebSocket } from 'ws';
const codeResp = await (await fetch('http://127.0.0.1:8080/api/pair/code', { method: 'POST', headers: {'content-type':'application/json'}, body: '{}' })).json();
const pair = await (await fetch('http://127.0.0.1:8080/api/pair', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({code: codeResp.code, name:'diag'}) })).json();
const session = await (await fetch('http://127.0.0.1:8080/api/sessions', { method: 'POST', headers: { Authorization: 'Bearer ' + pair.token, 'content-type':'application/json'}, body: JSON.stringify({projectId: 'diag-state', toolId: 'claude-code'}) })).json();
console.log('session:', session.id, 'initial state:', session.state);

const ws = new WebSocket(`ws://127.0.0.1:8080/ws?token=${pair.token}`);
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
ws.on('message', (data) => {
  const m = JSON.parse(data.toString());
  if (m.t === 'status') console.log('[status]', m.state);
  else if (m.t === 'event' && m.event?.type === 'status') console.log('[event:status]', m.event.state);
  else if (m.t === 'event' && m.event?.type === 'message') console.log('[event:message]', m.event.text?.slice(0,40));
});

ws.send(JSON.stringify({ t: 'attach', sessionId: session.id, lastSeq: 0 }));
ws.send(JSON.stringify({ t: 'input', sessionId: session.id, text: 'say hi' }));

// Wait for turn to finish.
await new Promise((r) => setTimeout(r, 15000));
console.log('\n[final session state from REST]');
const s2 = await (await fetch(`http://127.0.0.1:8080/api/sessions`, { headers: { Authorization: 'Bearer ' + pair.token } })).json();
const me = s2.sessions.find((x) => x.id === session.id);
console.log('  state:', me?.state);
ws.close();
process.exit(0);
