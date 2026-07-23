import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalManager, sanitizeTerminalEnv } from '../src/session/terminal.js';

test('sanitizeTerminalEnv strips nested-agent markers, keeps auth/config', () => {
  const out = sanitizeTerminalEnv({
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SSE_PORT: '54321',
    ANTHROPIC_API_KEY: 'sk-xxx',
    ANTHROPIC_BASE_URL: 'https://api.example.com',
    PATH: '/usr/bin',
    UNDEF: undefined,
  });
  // Nesting markers gone → a fresh claude won't think it's nested.
  assert.equal('CLAUDECODE' in out, false);
  assert.equal('CLAUDE_CODE_ENTRYPOINT' in out, false);
  assert.equal('CLAUDE_CODE_SSE_PORT' in out, false);
  // Auth/config preserved → login & model routing still work.
  assert.equal(out.ANTHROPIC_API_KEY, 'sk-xxx');
  assert.equal(out.ANTHROPIC_BASE_URL, 'https://api.example.com');
  assert.equal(out.PATH, '/usr/bin');
  // undefined values dropped.
  assert.equal('UNDEF' in out, false);
});

test('open → write echoes back via onData → close fires onExit', async () => {
  const tm = new TerminalManager();
  const chunks: string[] = [];
  let exited = false;
  tm.open({
    sessionId: 's1',
    cmd: 'cat', args: [], cwd: process.cwd(),
    onData: (d) => chunks.push(d),
    onExit: () => { exited = true; },
  });
  tm.write('s1', 'hello\n');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(chunks.join('').includes('hello'), 'cat should echo input');
  tm.close('s1');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(exited, true);
  assert.equal(tm.has('s1'), false);
});

test('resize does not throw on a live pty', async () => {
  const tm = new TerminalManager();
  tm.open({ sessionId: 's2', cmd: 'cat', args: [], cwd: process.cwd(), onData: () => {}, onExit: () => {} });
  assert.doesNotThrow(() => tm.resize('s2', 100, 30));
  tm.close('s2');
});
