// Unit tests for pure protocol helpers. Run: npm test (from server/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResumeCommand } from '../src/protocol.js';

test('buildResumeCommand: claude uses --resume <id>', () => {
  assert.equal(buildResumeCommand('claude-code', 'abc123'), 'claude --resume abc123');
});

test('buildResumeCommand: codex uses exec resume <id>', () => {
  assert.equal(buildResumeCommand('codex', 'abc123'), 'codex exec resume abc123');
});

test('buildResumeCommand: codebuddy uses --resume=<id>', () => {
  assert.equal(buildResumeCommand('codebuddy', 'abc123'), 'codebuddy --resume=abc123');
});
