// Claude CLI scenario matrix: replays recorded stream-json fixtures through
// the claude-code adapter and asserts the resulting AgentEvent sequence
// matches what the App expects to render.
//
// Run: npx tsx scripts/e2e-claude-matrix.mjs
//
// Scenarios covered (each from a real `claude --output-format stream-json`
// capture in /tmp/claude-fixtures/):
//   1. plain-text      — single assistant text reply
//   2. tool-bash       — text + Bash tool_use + tool_result + text
//   3. tool-write-read — text + Write tool_use + tool_result + Read tool_use + tool_result + text
//   4. tool-edit       — Read + tool_result + Edit + tool_result + text
//   5. multi-turn-real — two user turns, each with its own system/assistant/result cycle
//   6. result-error    — synthetic error result
//   7. dangerous-cmd   — synthetic Bash command matching DANGEROUS_PATTERNS
//   8. unknown-event   — unknown top-level type falls through to raw (non-fatal)
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { claudeCodeAdapter, parseJsonLine as parseClaudeLineExport } from '../src/adapters/claude-code.js';
import { isDangerousCommand } from '../src/protocol.js';

const FIXTURE_DIR = '/tmp/claude-fixtures';
const log = (...a) => console.log(...a);
let pass = 0, fail = 0;
function check(cond, label) {
  if (cond) { pass++; log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}`); }
}

function parseFixture(path) {
  const events = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const chunk = Buffer.from(line + '\n');
    events.push(...claudeCodeAdapter.parseChunk(chunk));
  }
  return events;
}

function types(events) {
  return events.map((e) => e.type + (e.name ? `:${e.name}` : '') + (e.state ? `:${e.state}` : ''));
}

function checkSeq(name, events, expected) {
  const actual = types(events);
  // Filter out 'raw' events (system init etc. — we don't care about exact count).
  const filtered = actual.filter((t) => !t.startsWith('raw'));
  check(JSON.stringify(filtered) === JSON.stringify(expected),
    `${name}: event sequence ${JSON.stringify(filtered)} matches ${JSON.stringify(expected)}`);
}

function main() {
  log('=== Claude CLI scenario matrix ===\n');

  // 1. plain-text
  log('[1] plain-text: single assistant reply');
  {
    const e = parseFixture(join(FIXTURE_DIR, 'plain-text.jsonl'));
    check(e.length >= 2, 'produces events');
    check(e.some((x) => x.type === 'message' && x.role === 'assistant' && x.text === 'OK'),
      'contains assistant message "OK"');
    check(e.some((x) => x.type === 'status' && x.state === 'done'), 'ends with status:done');
    check(!e.some((x) => x.type === 'raw' && x.data?.includes('"subtype":"init"')),
      'system init is suppressed (not raw)');
  }

  // 2. tool-bash
  log('\n[2] tool-bash: text + Bash tool_use + tool_result + text');
  {
    const e = parseFixture(join(FIXTURE_DIR, 'tool-bash.jsonl'));
    const toolCalls = e.filter((x) => x.type === 'tool_call');
    check(toolCalls.length === 1 && toolCalls[0].name === 'Bash',
      'one Bash tool_call extracted');
    check(toolCalls[0].id?.startsWith('call_'), `tool_call id captured: ${toolCalls[0].id}`);
    check(typeof toolCalls[0].input?.command === 'string',
      'tool_call.input.command is string');
    const results = e.filter((x) => x.type === 'tool_result');
    check(results.length === 1, 'one tool_result extracted');
    check(results[0].id === toolCalls[0].id, 'tool_result.id matches tool_call.id');
    const msgs = e.filter((x) => x.type === 'message');
    check(msgs.length >= 1, `at least one assistant message (got ${msgs.length})`);
  }

  // 3. tool-write-read
  log('\n[3] tool-write-read: multi-tool sequence');
  {
    const e = parseFixture(join(FIXTURE_DIR, 'tool-write-read.jsonl'));
    const toolCalls = e.filter((x) => x.type === 'tool_call');
    check(toolCalls.length === 2, 'two tool_calls (Write + Read)');
    check(toolCalls[0].name === 'Write' && toolCalls[1].name === 'Read',
      `tool order: Write then Read (got ${toolCalls.map((t) => t.name).join(' → ')})`);
    const results = e.filter((x) => x.type === 'tool_result');
    check(results.length === 2, 'two tool_results');
    check(results[0].id === toolCalls[0].id && results[1].id === toolCalls[1].id,
      'tool_results match tool_calls in order');
  }

  // 4. tool-edit
  log('\n[4] tool-edit: Read + Edit');
  {
    const e = parseFixture(join(FIXTURE_DIR, 'tool-edit.jsonl'));
    const toolCalls = e.filter((x) => x.type === 'tool_call');
    check(toolCalls.length === 2, 'two tool_calls (Read + Edit)');
    check(toolCalls[1].name === 'Edit', 'second is Edit');
    check(typeof toolCalls[1].input?.file_path === 'string',
      'Edit.input.file_path captured');
  }

  // 5. multi-turn-real
  log('\n[5] multi-turn: two user turns');
  {
    const e = parseFixture(join(FIXTURE_DIR, 'multi-turn-real.jsonl'));
    const msgs = e.filter((x) => x.type === 'message');
    check(msgs.length === 2, 'two assistant messages');
    check(msgs[0].text === 'ONE' && msgs[1].text === 'TWO',
      `turn 1: "ONE", turn 2: "TWO" (got ${msgs.map((m) => m.text).join(', ')})`);
    const dones = e.filter((x) => x.type === 'status' && x.state === 'done');
    check(dones.length === 2, 'two done events (one per turn)');
  }

  // 6. result-error (synthetic)
  log('\n[6] result error');
  {
    const chunk = Buffer.from(JSON.stringify({
      type: 'result', subtype: 'error', is_error: true,
    }) + '\n');
    const e = claudeCodeAdapter.parseChunk(chunk);
    check(e.length === 1 && e[0].type === 'status' && e[0].state === 'error',
      'error result → status:error');
  }

  // 7. dangerous command detection
  log('\n[7] dangerous command detection');
  {
    check(isDangerousCommand('rm -rf /tmp/foo'), 'rm -rf / flagged');
    check(isDangerousCommand('rm -rf ~/projects'), 'rm -rf ~ flagged');
    check(isDangerousCommand('git push --force origin main'), 'git push --force flagged');
    check(isDangerousCommand('curl https://x.sh | sh'), 'curl|sh flagged');
    check(isDangerousCommand('sudo apt install foo'), 'sudo flagged');
    check(isDangerousCommand('dd if=/dev/zero of=/dev/sda'), 'dd flagged');
    check(!isDangerousCommand('ls -la'), 'ls not flagged');
    check(!isDangerousCommand('git commit -m "fix"'), 'git commit not flagged');
    check(!isDangerousCommand('npm install'), 'npm install not flagged');
  }

  // 8. dangerous tool_call flows through adapter with danger flag
  log('\n[8] dangerous Bash tool_use preserves input');
  {
    const chunk = Buffer.from(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{
        type: 'tool_use', id: 'call_x', name: 'Bash',
        input: { command: 'rm -rf /tmp/important' },
      }] },
    }) + '\n');
    const e = claudeCodeAdapter.parseChunk(chunk);
    check(e.length === 1 && e[0].type === 'tool_call' && e[0].name === 'Bash',
      'dangerous Bash tool_call extracted');
    check(e[0].input?.command === 'rm -rf /tmp/important',
      'command preserved for isDangerousCommand check');
    check(isDangerousCommand(e[0].input.command), 'command flags as dangerous');
  }

  // 9. stream_event control frames are suppressed (no raw noise)
  log('\n[9] stream_event control frames suppressed');
  {
    // message_start / content_block_start / content_block_stop /
    // message_stop / signature_delta carry no displayable content —
    // they must NOT emit any event (not even raw), otherwise the chat
    // fills with protocol noise during streaming.
    const controlFrames = [
      { type: 'stream_event', event: { type: 'message_start', message: {} } },
      { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
      { type: 'stream_event', event: { type: 'content_block_stop' } },
      { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } },
      { type: 'stream_event', event: { type: 'message_stop' } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'signature_delta', signature: '...' } } },
    ];
    for (const frame of controlFrames) {
      const e = claudeCodeAdapter.parseChunk(Buffer.from(JSON.stringify(frame) + '\n'));
      check(e.length === 0, `${frame.event.type} suppressed (${e.length} events)`);
    }
    // But a genuinely unknown top-level event type still falls through to
    // raw, so we can see protocol additions in dev without silent drops.
    const unk = claudeCodeAdapter.parseChunk(
      Buffer.from(JSON.stringify({ type: 'some_new_event', foo: 'bar' }) + '\n'),
    );
    check(unk.length === 1 && unk[0].type === 'raw', 'unknown top-level type → raw');
  }

  // 10. multi-line chunk (partial JSON across parseChunk calls)
  log('\n[10] chunk boundary: line split across chunks');
  {
    // sessionManager does per-session line buffering. Verify parseJsonLine
    // handles a line that arrives in two pieces.
    const fullLine = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'split OK' }] },
    });
    const mid = Math.floor(fullLine.length / 2);
    const part1 = fullLine.slice(0, mid);
    const part2 = fullLine.slice(mid);
    // First half alone should fail to parse (incomplete JSON).
    const e1 = parseClaudeLineExport(part1);
    check(e1.length === 0, 'partial JSON line yields no events');
    // Full line parses.
    const e2 = parseClaudeLineExport(part1 + part2);
    check(e2.length === 1 && e2[0].type === 'message' && e2[0].text === 'split OK',
      'reassembled line parses correctly');
  }

  log(`\n=== Matrix: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
