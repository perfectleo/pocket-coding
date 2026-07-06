import { spawn } from 'node:child_process';
import type { AgentEvent, LaunchOptions, ToolAdapter } from '../protocol.js';

const DETECT_TIMEOUT_MS = 3000;

async function detectClaude(): Promise<{ installed: boolean; version?: string }> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ installed: false }), DETECT_TIMEOUT_MS);
    const p = spawn('claude', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
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

// Parse one line of Claude Code stream-json into AgentEvent(s).
function parseJsonLine(line: string): AgentEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return [];
  }
  return mapClaudeEvent(obj);
}

function mapClaudeEvent(obj: unknown): AgentEvent[] {
  if (!obj || typeof obj !== 'object') return [];
  const e = obj as Record<string, unknown>;
  const type = e.type as string;
  const out: AgentEvent[] = [];

  switch (type) {
    case 'assistant': {
      const message = e.message as { content?: Array<{ type: string; text?: string }> } | undefined;
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === 'text' && typeof c.text === 'string') {
            out.push({ type: 'message', role: 'assistant', text: c.text });
          }
        }
      }
      break;
    }
    case 'tool_use': {
      const name = (e.name as string) || 'tool';
      const id = (e.id as string) || 't' + Math.random().toString(36).slice(2, 8);
      out.push({ type: 'tool_call', id, name, input: e.input });
      break;
    }
    case 'tool_result': {
      const id = (e.tool_use_id as string) || 't';
      const content = e.content;
      let output = '';
      if (typeof content === 'string') output = content;
      else if (Array.isArray(content)) {
        output = content
          .map((c) => (typeof c === 'string' ? c : (c?.text as string) || ''))
          .join('');
      }
      out.push({ type: 'tool_result', id, output });
      break;
    }
    case 'thinking': {
      const text = (e.thinking as string) || '';
      if (text) out.push({ type: 'thinking', text });
      break;
    }
    case 'result': {
      const subtype = e.subtype as string;
      if (subtype === 'error') {
        out.push({ type: 'status', state: 'error' });
      } else {
        out.push({ type: 'status', state: 'done' });
      }
      break;
    }
    default:
      // Unknown event types: pass as raw for debugging.
      out.push({ type: 'raw', data: trimmedLine(e) });
      break;
  }
  return out;
}

function trimmedLine(e: Record<string, unknown>): string {
  try {
    return JSON.stringify(e);
  } catch {
    return '';
  }
}

export const claudeCodeAdapter: ToolAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  mode: 'structured',

  async detect() {
    return detectClaude();
  },

  buildCommand(opts: LaunchOptions) {
    const args = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
    ];
    if (opts.model) args.push('--model', opts.model);
    return { cmd: 'claude', args, env: {} };
  },

  parseChunk(chunk: Buffer): AgentEvent[] {
    // Claude stream-json is line-delimited. Buffer across calls.
    const text = chunk.toString('utf8');
    const lines = text.split('\n');
    const events: AgentEvent[] = [];
    for (const line of lines) {
      if (!line) continue;
      events.push(...parseJsonLine(line));
    }
    return events;
  },

  encodeInput(text: string): Buffer {
    // stream-json input: a JSON object per user turn.
    const obj = JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
    return Buffer.from(obj + '\n', 'utf8');
  },

  encodeApproval(_callId: string, approve: boolean): Buffer {
    // Claude Code permission prompts: respond via stdin with the choice.
    // Format depends on CLI version; send a simple yes/no line.
    return Buffer.from((approve ? 'yes' : 'no') + '\n', 'utf8');
  },

  interrupt(session: { tmuxName: string }): void {
    // Send Ctrl+C to the tmux pane.
    if (session.tmuxName) {
      spawn('tmux', ['send-keys', '-t', session.tmuxName, 'C-c'], { stdio: 'ignore' });
    }
  },
};
