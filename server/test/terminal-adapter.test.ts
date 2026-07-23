import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeCodeAdapter } from '../src/adapters/claude-code.js';
import { codebuddyAdapter } from '../src/adapters/codebuddy.js';
import { codexAdapter } from '../src/adapters/codex.js';

test('claude buildTerminalCommand: no resume when externalSessionId absent', () => {
  const c = claudeCodeAdapter.buildTerminalCommand!({ cwd: '/tmp', externalSessionId: null });
  assert.equal(c!.cmd, 'claude');
  assert.ok(!c!.args.includes('--resume'));
  assert.ok(!c!.args.includes('--input-format')); // interactive, NOT stream-json
});

test('claude buildTerminalCommand: resumes when externalSessionId present', () => {
  const c = claudeCodeAdapter.buildTerminalCommand!({ cwd: '/tmp', externalSessionId: 'sess-123' });
  assert.deepEqual(c!.args, ['--resume', 'sess-123']);
});

test('codebuddy buildTerminalCommand: no resume when externalSessionId absent', () => {
  const c = codebuddyAdapter.buildTerminalCommand!({ cwd: '/tmp', externalSessionId: null });
  assert.equal(c!.cmd, 'codebuddy');
  assert.deepEqual(c!.args, []);
  assert.ok(!c!.args.includes('--input-format'));
});

test('codebuddy buildTerminalCommand: resumes with equals-sign syntax', () => {
  const c = codebuddyAdapter.buildTerminalCommand!({ cwd: '/tmp', externalSessionId: 'sess-9' });
  assert.deepEqual(c!.args, ['--resume=sess-9']);
});

test('codex buildTerminalCommand: not supported → null', () => {
  const c = codexAdapter.buildTerminalCommand?.({ cwd: '/tmp', externalSessionId: null });
  assert.equal(c ?? null, null);
});
