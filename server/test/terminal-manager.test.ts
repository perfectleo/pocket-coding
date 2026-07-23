import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalManager } from '../src/session/terminal.js';

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
