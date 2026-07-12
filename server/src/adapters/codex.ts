import { spawn } from 'node:child_process';
import type { AgentEvent, LaunchOptions, PermissionMode, ToolAdapter } from '../protocol.js';

const DETECT_TIMEOUT_MS = 3000;

// Map Pocket's unified permission mode onto codex's --sandbox flag values.
// Returns null for bypassPermissions — that mode uses
// --dangerously-bypass-approvals-and-sandbox instead of -s.
function mapCodexSandbox(m: PermissionMode): 'read-only' | 'workspace-write' | 'danger-full-access' | null {
  switch (m) {
    case 'default':
    case 'plan':
      return 'read-only';
    case 'acceptEdits':
      return 'workspace-write';
    case 'bypassPermissions':
      return null;
  }
}

async function detectCodex(): Promise<{ installed: boolean; version?: string }> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ installed: false }), DETECT_TIMEOUT_MS);
    const p = spawn('codex', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('error', () => {
      clearTimeout(t);
      resolve({ installed: false });
    });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) {
        resolve({ installed: true, version: out.trim() || undefined });
      } else {
        resolve({ installed: false });
      }
    });
  });
}

// Parse one line of `codex exec --json` JSONL into AgentEvent(s).
//
// Codex JSONL envelope (verified from real captures):
//   {"type":"thread.started","thread_id":"<uuid>"}        → session id
//   {"type":"turn.started"}                               → (turn begin, no event)
//   {"type":"turn.completed","usage":{...}}               → status:done
//   {"type":"item.started","item":{"id":...,"type":"command_execution","command":"...","status":"in_progress"}}
//   {"type":"item.completed","item":{"id":...,"type":"agent_message","text":"..."}}
//   {"type":"item.completed","item":{"id":...,"type":"reasoning","text":"..."}}
//   {"type":"item.completed","item":{"id":...,"type":"command_execution","command":"...","aggregated_output":"...","exit_code":0,"status":"completed"}}
//   {"type":"item.completed","item":{"id":...,"type":"error","message":"..."}}
//
// command_execution emits BOTH a tool_call and a tool_result (codex reports
// them in one item, unlike claude which splits across tool_use/tool_result).
export function parseJsonLine(line: string): AgentEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!obj || typeof obj !== 'object') return [];
  const e = obj as Record<string, unknown>;
  const type = e.type as string;
  const out: AgentEvent[] = [];

  switch (type) {
    case 'thread.started': {
      // session id — extracted by extractSessionId, not emitted as an event.
      break;
    }
    case 'turn.started': {
      break;
    }
    case 'turn.completed': {
      out.push({ type: 'status', state: 'done' });
      break;
    }
    case 'item.started':
    case 'item.completed': {
      const item = e.item as
        | {
            id?: string;
            type?: string;
            text?: string;
            message?: string;
            command?: string;
            aggregated_output?: string;
            exit_code?: number | null;
            status?: string;
          }
        | undefined;
      if (!item) break;
      const itemId = item.id || 'c' + Math.random().toString(36).slice(2, 8);
      switch (item.type) {
        case 'agent_message':
          if (typeof item.text === 'string') {
            out.push({ type: 'message', role: 'assistant', text: item.text });
          }
          break;
        case 'reasoning':
          if (typeof item.text === 'string') {
            out.push({ type: 'thinking', text: item.text });
          }
          break;
        case 'command_execution': {
          // item.started = in_progress notification (skip — we only emit on
          // completion to avoid duplicate tool_calls). item.completed carries
          // the final command + output + exit code.
          if (type !== 'item.completed') break;
          const cmd = item.command ?? '';
          out.push({
            type: 'tool_call',
            id: itemId,
            name: 'Bash',
            input: { command: cmd },
          });
          out.push({
            type: 'tool_result',
            id: itemId,
            output: `exit ${item.exit_code ?? 0}\n${item.aggregated_output ?? ''}`,
          });
          break;
        }
        case 'error':
          out.push({ type: 'raw', data: item.message ?? 'codex error' });
          break;
        default:
          out.push({ type: 'raw', data: JSON.stringify(item) });
          break;
      }
      break;
    }
    default:
      out.push({ type: 'raw', data: JSON.stringify(e) });
      break;
  }
  return out;
}

export const codexAdapter: ToolAdapter = {
  id: 'codex',
  displayName: 'Codex',
  mode: 'structured',

  async detect() {
    return detectCodex();
  },

  buildCommand(opts: LaunchOptions) {
    // codex exec runs one turn per invocation (no long-running interactive
    // mode via stdin). For resume, use `exec resume <sessionId>`.
    // Prompt is fed via stdin to keep the manager's input() uniform.
    const args = ['exec', '--json', '--skip-git-repo-check'];
    if (opts.resume) {
      args.push('resume', opts.sessionId);
    }
    // Map Pocket's unified permission mode onto codex's --sandbox flag.
    // codex exec has no ask-for-approval flag (it's a config.toml value);
    // --sandbox is the only per-invocation mode knob. codex has no plan
    // mode — plan falls back to read-only (model can't make changes).
    const sandbox = mapCodexSandbox(opts.permissionMode);
    if (sandbox) {
      args.push('-s', sandbox);
    } else {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }
    if (opts.model) args.push('--model', opts.model);
    return { cmd: 'codex', args, env: {} };
  },

  parseJsonLine,

  parseChunk(chunk: Buffer): AgentEvent[] {
    const text = chunk.toString('utf8');
    const lines = text.split('\n');
    lines.pop();
    const events: AgentEvent[] = [];
    for (const line of lines) {
      if (line) events.push(...parseJsonLine(line));
    }
    return events;
  },

  encodeInput(text: string): Buffer {
    // codex exec reads the prompt from stdin when no prompt arg is given.
    return Buffer.from(text, 'utf8');
  },

  // codex doesn't use stdin approval — it has --dangerously-bypass-approvals-and-sandbox.
  // We pass that flag in buildCommand for now; approval flow is a future task.
  encodeApproval(_callId: string, _approve: boolean): Buffer {
    return Buffer.from('', 'utf8');
  },

  extractSessionId(firstLine: string): string | null {
    try {
      const obj = JSON.parse(firstLine.trim()) as { type?: string; thread_id?: string };
      if (obj.type === 'thread.started' && typeof obj.thread_id === 'string') {
        return obj.thread_id;
      }
    } catch {
      // not JSON yet — caller should retry with more lines
    }
    return null;
  },

  // codex's JSONL envelope doesn't echo the sandbox mode back, so we can't
  // capture the "real" mode from stdout. The manager falls back to echoing
  // whatever the user requested — that's correct because we set the flag
  // ourselves and codex has no way to change it mid-turn.


  interrupt(session: { tmuxName: string }): void {
    if (session.tmuxName) {
      try {
        const p = spawn('tmux', ['send-keys', '-t', session.tmuxName, 'C-c'], { stdio: 'ignore' });
        p.on('error', () => {/* tmux not installed; caller falls back to SIGINT */});
      } catch {
        // ignore
      }
    }
  },
};
