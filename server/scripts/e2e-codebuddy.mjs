// Verifies codebuddyAdapter reuses claude's stream-json parser and that
// buildCommand produces codebuddy-specific args (--resume=<id> = equals syntax).
import { readFileSync } from 'node:fs';
import { codebuddyAdapter } from '../src/adapters/codebuddy.js';
import { claudeCodeAdapter } from '../src/adapters/claude-code.js';

const log = (...a) => console.log(...a);
let pass = 0, fail = 0;
function check(cond, label) {
  if (cond) { pass++; log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}`); }
}

function main() {
  log('=== CodeBuddy adapter test ===\n');

  // 1. Reuses claude parser
  log('[1] parser shared with claude');
  {
    check(codebuddyAdapter.parseJsonLine === claudeCodeAdapter.parseJsonLine,
      'parseJsonLine is the same function reference');
    check(codebuddyAdapter.parseChunk === claudeCodeAdapter.parseChunk,
      'parseChunk is the same function reference');
    check(codebuddyAdapter.encodeInput === claudeCodeAdapter.encodeInput,
      'encodeInput is the same function reference');
  }

  // 2. Parses claude-format fixtures (codebuddy is protocol-compatible)
  log('\n[2] parses claude plain-text fixture');
  {
    const events = [];
    for (const line of readFileSync('/tmp/claude-fixtures/plain-text.jsonl', 'utf8').split('\n')) {
      if (!line.trim()) continue;
      events.push(...codebuddyAdapter.parseJsonLine(line));
    }
    const msgs = events.filter((e) => e.type === 'message' && e.role === 'assistant');
    check(msgs.length === 1 && msgs[0].text === 'OK', 'assistant message "OK" extracted');
    check(events.some((e) => e.type === 'status' && e.state === 'done'), 'ends with status:done');
  }

  // 3. Parses claude tool-bash fixture
  log('\n[3] parses claude tool-bash fixture');
  {
    const events = [];
    for (const line of readFileSync('/tmp/claude-fixtures/tool-bash.jsonl', 'utf8').split('\n')) {
      if (!line.trim()) continue;
      events.push(...codebuddyAdapter.parseJsonLine(line));
    }
    const toolCalls = events.filter((e) => e.type === 'tool_call');
    check(toolCalls.length === 1 && toolCalls[0].name === 'Bash', 'one Bash tool_call');
    const results = events.filter((e) => e.type === 'tool_result');
    check(results.length === 1 && results[0].id === toolCalls[0].id, 'one matching tool_result');
  }

  // 4. buildCommand — fresh
  log('\n[4] buildCommand fresh (resume=false)');
  {
    const { cmd, args } = codebuddyAdapter.buildCommand({
      cwd: '/tmp', sessionId: 'irrelevant-on-fresh', resume: false, permissionMode: 'plan',
    });
    check(cmd === 'codebuddy', 'cmd is codebuddy');
    check(args.includes('--output-format') && args.includes('stream-json'), 'stream-json output');
    check(args.includes('--input-format') && args.includes('stream-json'), 'stream-json input');
    check(args.includes('--verbose'), 'verbose flag');
    check(args.includes('--permission-mode') && args.includes('plan'), 'passes --permission-mode plan');
    // Fresh: codebuddy generates its own session ID, we don't pass --session-id.
    check(!args.some((a) => typeof a === 'string' && a.startsWith('--session-id')),
      'fresh: no --session-id (tool generates its own)');
    check(!args.some((a) => typeof a === 'string' && a.startsWith('--resume')), 'fresh has no --resume');
  }

  // 5. buildCommand — resume
  log('\n[5] buildCommand resume (resume=true)');
  {
    const { args } = codebuddyAdapter.buildCommand({
      cwd: '/tmp', sessionId: '550e8400-e29b-41d4-a716-446655440000', resume: true, permissionMode: 'default',
    });
    check(args.includes('--resume=550e8400-e29b-41d4-a716-446655440000'),
      'resume uses --resume=<uuid> equals syntax');
    check(!args.some((a) => typeof a === 'string' && a.startsWith('--session-id')), 'resume has no --session-id');
  }

  // 6. buildCommand — model
  log('\n[6] buildCommand with model');
  {
    const { args } = codebuddyAdapter.buildCommand({
      cwd: '/tmp', sessionId: 'x', resume: false, model: 'claude-sonnet-4.6', permissionMode: 'default',
    });
    check(args.includes('--model') && args.includes('claude-sonnet-4.6'), 'model flag set');
  }

  // 7. extractSessionId shared with claude
  log('\n[7] extractSessionId reuses claude implementation');
  {
    check(codebuddyAdapter.extractSessionId === claudeCodeAdapter.extractSessionId,
      'extractSessionId is the same function reference');
    const sample = JSON.stringify({
      type: 'system', subtype: 'init',
      session_id: 'cb-abc-123',
    });
    check(codebuddyAdapter.extractSessionId(sample) === 'cb-abc-123',
      'extracts session_id from a codebuddy message');
    check(codebuddyAdapter.extractSessionId('not json') === null, 'non-JSON → null');
  }

  // 8. extractPermissionMode shared with claude
  log('\n[8] extractPermissionMode reuses claude implementation');
  {
    check(codebuddyAdapter.extractPermissionMode === claudeCodeAdapter.extractPermissionMode,
      'extractPermissionMode is the same function reference');
    const init = JSON.stringify({
      type: 'system', subtype: 'init', permissionMode: 'plan',
    });
    check(codebuddyAdapter.extractPermissionMode(init) === 'plan', 'extracts plan from init');
    check(codebuddyAdapter.extractPermissionMode('{"type":"assistant"}') === null, 'non-init → null');
    check(codebuddyAdapter.extractPermissionMode('not json') === null, 'non-JSON → null');
  }

  log(`\n=== CodeBuddy: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
