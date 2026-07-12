// Verifies codexAdapter parses real `codex exec --json` fixtures and that
// buildCommand produces correct args for fresh vs resume invocations.
import { readFileSync } from 'node:fs';
import { codexAdapter, parseJsonLine } from '../src/adapters/codex.js';

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
    events.push(...parseJsonLine(line));
  }
  return events;
}

function main() {
  log('=== Codex adapter test ===\n');

  // 1. plain-text fixture
  log('[1] codex-plain: thread.started suppressed, agent_message extracted, turn.completed → done');
  {
    const e = parseFixture('test/fixtures/codex-plain.jsonl');
    const msgs = e.filter((x) => x.type === 'message');
    check(msgs.length === 1 && msgs[0].text === 'Hi', 'one assistant message "Hi"');
    const dones = e.filter((x) => x.type === 'status' && x.state === 'done');
    check(dones.length === 1, 'turn.completed → status:done');
    // thread.started must NOT emit any event (it's captured by extractSessionId instead)
    check(!e.some((x) => x.type === 'raw' && x.data?.includes('thread.started')),
      'thread.started suppressed (no raw leak)');
  }

  // 2. tool fixture
  log('\n[2] codex-tool: reasoning + command_execution + agent_message');
  {
    const e = parseFixture('test/fixtures/codex-tool.jsonl');
    const toolCalls = e.filter((x) => x.type === 'tool_call');
    check(toolCalls.length === 2, 'two command_execution → tool_call');
    check(toolCalls[0].name === 'Bash', 'tool_call name is Bash');
    check(typeof toolCalls[0].input?.command === 'string', 'command captured');
    const results = e.filter((x) => x.type === 'tool_result');
    check(results.length === 2, 'two completed → tool_result');
    check(results[0].id === toolCalls[0].id, 'result.id matches tool_call.id');
    check(results[1].output === 'world' || results[1].output?.includes('world'),
      'second result output is "world"');
    const msgs = e.filter((x) => x.type === 'message');
    check(msgs.length === 2, 'two agent_messages');
    const thinking = e.filter((x) => x.type === 'thinking');
    check(thinking.length === 2, 'two reasoning → thinking');
  }

  // 3. extractSessionId
  log('\n[3] extractSessionId from first stdout line');
  {
    const firstLine = readFileSync('test/fixtures/codex-plain.jsonl', 'utf8').split('\n')[0];
    const sid = codexAdapter.extractSessionId(firstLine);
    check(sid === '019f4b0c-63f6-74b0-b74e-854df9d85162',
      `extracted thread_id: ${sid}`);
    check(codexAdapter.extractSessionId('not json') === null, 'non-JSON → null');
    check(codexAdapter.extractSessionId('{"type":"other"}') === null, 'wrong type → null');
  }

  // 4. buildCommand — fresh
  log('\n[4] buildCommand fresh (resume=false)');
  {
    const { cmd, args } = codexAdapter.buildCommand({
      cwd: '/tmp', sessionId: 'abc-123', resume: false, permissionMode: 'default',
    });
    check(cmd === 'codex', 'cmd is codex');
    check(args.includes('exec'), 'has exec subcommand');
    check(args.includes('--json'), 'has --json');
    check(args.includes('--skip-git-repo-check'), 'has --skip-git-repo-check');
    check(!args.includes('resume'), 'fresh does NOT include resume subcommand');
    check(!args.includes('abc-123'), 'fresh does NOT pass sessionId (codex generates its own)');
    // default mode → read-only sandbox
    check(args.includes('-s') && args.includes('read-only'),
      'default mode maps to -s read-only');
  }

  // 4b. buildCommand — mode mapping
  log('\n[4b] codex maps permission modes to sandbox flags');
  {
    const plan = codexAdapter.buildCommand({
      cwd: '/tmp', sessionId: 'x', resume: false, permissionMode: 'plan',
    });
    check(plan.args.includes('read-only'), 'plan → read-only (codex has no plan mode)');

    const accept = codexAdapter.buildCommand({
      cwd: '/tmp', sessionId: 'x', resume: false, permissionMode: 'acceptEdits',
    });
    check(accept.args.includes('workspace-write'), 'acceptEdits → workspace-write');

    const bypass = codexAdapter.buildCommand({
      cwd: '/tmp', sessionId: 'x', resume: false, permissionMode: 'bypassPermissions',
    });
    check(bypass.args.includes('--dangerously-bypass-approvals-and-sandbox'),
      'bypassPermissions → --dangerously-bypass-approvals-and-sandbox');
    check(!bypass.args.some((a) => a === '-s'), 'bypass: no -s flag');
  }

  // 5. buildCommand — resume
  log('\n[5] buildCommand resume (resume=true)');
  {
    const { cmd, args } = codexAdapter.buildCommand({
      cwd: '/tmp', sessionId: '019f4b0c-63f6-74b0-b74e-854df9d85162', resume: true, permissionMode: 'default',
    });
    check(args.includes('resume'), 'has resume subcommand');
    check(args.includes('019f4b0c-63f6-74b0-b74e-854df9d85162'),
      'sessionId passed as resume arg');
  }

  // 6. buildCommand — model
  log('\n[6] buildCommand with model');
  {
    const { args } = codexAdapter.buildCommand({
      cwd: '/tmp', sessionId: 'x', resume: false, model: 'gpt-5.1-codex', permissionMode: 'default',
    });
    check(args.includes('--model') && args.includes('gpt-5.1-codex'), 'model flag set');
  }

  // 7. encodeInput
  log('\n[7] encodeInput writes raw text (codex reads prompt from stdin)');
  {
    const buf = codexAdapter.encodeInput('hello world');
    check(buf.toString('utf8') === 'hello world', 'encodeInput is raw text');
  }

  log(`\n=== Codex: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
