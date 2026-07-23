// Unit tests for the transcript loader — the read side of "tool session file
// is the single source of truth". We write tiny fixture .jsonl files to a
// temp dir and assert the parser extracts session id, cwd, entries and
// summary correctly (including codex synthetic-user filtering).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseClaudeTranscript,
  parseCodexTranscript,
  transcriptMeta,
} from '../src/hosts/transcript-loader.js';

function withFixture(name: string, content: string, fn: (fp: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-transcript-'));
  const fp = join(dir, name);
  writeFileSync(fp, content, 'utf8');
  try {
    fn(fp);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('parseClaudeTranscript extracts session id, cwd and entries', () => {
  const content = [
    JSON.stringify({
      type: 'user',
      sessionId: 'sess-1',
      cwd: '/proj',
      uuid: 'u1',
      timestamp: '2024-01-01T00:00:00Z',
      message: { role: 'user', content: '你好' },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2024-01-01T00:00:01Z',
      message: { content: [{ type: 'text', text: 'hi there' }] },
    }),
  ].join('\n');

  withFixture('sess-1.jsonl', content, (fp) => {
    const t = parseClaudeTranscript(fp, 1234);
    assert.equal(t.toolId, 'claude-code');
    assert.equal(t.externalSessionId, 'sess-1');
    assert.equal(t.cwd, '/proj');
    assert.equal(t.updatedAt, 1234);
    assert.equal(t.entries.length, 2);
    assert.equal(t.entries[0].role, 'user');
    assert.deepEqual(t.entries[0].event, { type: 'text', text: '你好' });
    assert.equal(t.entries[1].role, 'assistant');
    assert.equal(t.entries[1].event.type, 'message');

    const meta = transcriptMeta(t);
    assert.equal(meta.messageCount, 2);
    assert.equal(meta.summary, '你好');
  });
});

test('parseCodexTranscript reads session_meta and skips synthetic user turns', () => {
  const content = [
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2024-01-01T00:00:00Z',
      payload: { id: 'cx-1', cwd: '/proj' },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2024-01-01T00:00:01Z',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'say hi' }] },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2024-01-01T00:00:02Z',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
    }),
    // Synthetic environment-context user turn must be filtered out.
    JSON.stringify({
      type: 'response_item',
      timestamp: '2024-01-01T00:00:03Z',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context> cwd=/proj' }] },
    }),
  ].join('\n');

  withFixture('rollout-cx-1.jsonl', content, (fp) => {
    const t = parseCodexTranscript(fp, 5678);
    assert.equal(t.toolId, 'codex');
    assert.equal(t.externalSessionId, 'cx-1');
    assert.equal(t.cwd, '/proj');
    // Only the real user + assistant messages survive.
    assert.equal(t.entries.length, 2);
    assert.equal(t.entries[0].role, 'user');
    assert.deepEqual(t.entries[0].event, { type: 'text', text: 'say hi' });

    const meta = transcriptMeta(t);
    assert.equal(meta.messageCount, 2);
    assert.equal(meta.summary, 'say hi');
  });
});
