import { spawn } from 'node:child_process';
import type { AgentEvent, LaunchOptions, PermissionMode, ToolAdapter } from '../protocol.js';

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
// Exported so callers that do their own line buffering (e.g.
// sessionManager) can parse complete lines directly.
export function parseJsonLine(line: string): AgentEvent[] {
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

export function mapClaudeEvent(obj: unknown): AgentEvent[] {
  if (!obj || typeof obj !== 'object') return [];
  const e = obj as Record<string, unknown>;
  const type = e.type as string;
  const out: AgentEvent[] = [];

  switch (type) {
    case 'system': {
      // init/sessionConfig events carry no conversational content — suppress
      // from chat. The permissionMode field on init is surfaced separately
      // via extractPermissionMode (called by the manager's line loop) and
      // broadcast as a 'mode' event, so we don't emit it here.
      break;
    }
    case 'assistant': {
      const message = e.message as
        | {
            content?: Array<{
              type: string;
              text?: string;
              thinking?: string;
              id?: string;
              name?: string;
              input?: unknown;
            }>;
          }
        | undefined;
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === 'text' && typeof c.text === 'string') {
            out.push({ type: 'message', role: 'assistant', text: c.text });
          } else if (c.type === 'thinking' && typeof c.thinking === 'string') {
            out.push({ type: 'thinking', text: c.thinking });
          } else if (c.type === 'tool_use') {
            const name = (c.name as string) || 'tool';
            const id = (c.id as string) || 't' + Math.random().toString(36).slice(2, 8);
            out.push({ type: 'tool_call', id, name, input: c.input });
          }
        }
      }
      break;
    }
    case 'user': {
      // Claude stream-json returns tool results as user messages with content[]
      // blocks of type 'tool_result' — not as top-level events.
      const message = e.message as
        | {
            content?: Array<{
              type: string;
              tool_use_id?: string;
              content?: string | Array<{ type: string; text?: string }>;
            }>;
          }
        | undefined;
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type !== 'tool_result') continue;
          const id = (c.tool_use_id as string) || 't';
          const raw = c.content;
          let output = '';
          if (typeof raw === 'string') output = raw;
          else if (Array.isArray(raw)) {
            output = raw
              .map((x) => (typeof x === 'string' ? x : (x?.text as string) || ''))
              .join('');
          }
          out.push({ type: 'tool_result', id, output });
        }
      }
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
    case 'stream_event': {
      // claude --include-partial-messages emits these. The inner event
      // has a type field (message_start / content_block_start /
      // content_block_delta / content_block_stop / message_delta /
      // message_stop). We surface text+thinking deltas so the app can
      // render assistant output as it streams, rather than waiting for
      // the full assistant message to land at turn end.
      //
      // Control frames (message_start, content_block_start/stop,
      // message_delta, message_stop, signature_delta) carry no
      // displayable content — we suppress them entirely rather than
      // emitting raw, which would spam the chat with protocol noise.
      const inner = e.event as
        | {
            type?: string;
            delta?: { type?: string; text?: string };
            content_block?: { type?: string };
          }
        | undefined;
      if (inner && inner.type === 'content_block_delta' && inner.delta) {
        if (inner.delta.type === 'text_delta' && typeof inner.delta.text === 'string') {
          out.push({ type: 'message_delta', role: 'assistant', text: inner.delta.text });
        } else if (inner.delta.type === 'thinking_delta' && typeof inner.delta.text === 'string') {
          out.push({ type: 'thinking_delta', text: inner.delta.text });
        }
        // Other delta types (input_json_delta for tool args streaming,
        // signature_delta for thinking signatures) are not surfaced yet.
      }
      // Unrecognized stream_event shapes are also suppressed — they're
      // either new control frames we don't handle, or protocol noise.
      break;
    }
    default:
      // Unknown event types: pass as raw for debugging (non-fatal).
      out.push({ type: 'raw', data: JSON.stringify(e) });
      break;
  }
  return out;
}

export const claudeCodeAdapter: ToolAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  mode: 'structured',
  // stream-json input reads newline-delimited user messages until EOF, so the
  // process can stay resident across turns (M2).
  supportsResidentStdin: true,

  async detect() {
    return detectClaude();
  },

  buildCommand(opts: LaunchOptions) {
    const args = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', opts.permissionMode,
    ];
    // The AI tool generates its own session ID and emits it in every
    // message (session_id field). We capture it from stdout on first turn
    // and persist it. On resume (process died / server restart), we pass
    // --resume <captured-id> so the tool picks up its own conversation.
    if (opts.resume) {
      args.push('--resume', opts.sessionId);
    }
    if (opts.model) args.push('--model', opts.model);
    return { cmd: 'claude', args, env: {} };
  },

  parseChunk(chunk: Buffer): AgentEvent[] {
    // NOTE: This method is stateless — it parses complete lines in the
    // chunk and ignores any trailing partial line. The sessionManager
    // is responsible for buffering partial lines across stdout 'data'
    // events (adapters are singletons shared across sessions, so
    // per-session state cannot live here). Use parseJsonLine directly
    // for per-line parsing from the caller's buffer.
    const text = chunk.toString('utf8');
    const lines = text.split('\n');
    // Drop the last element: it's either '' (chunk ended with \n) or a
    // partial line the caller must re-buffer.
    lines.pop();
    const events: AgentEvent[] = [];
    for (const line of lines) {
      if (line) events.push(...parseJsonLine(line));
    }
    return events;
  },

  parseJsonLine,

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

  extractSessionId(line: string): string | null {
    // claude emits session_id in every stream-json message (system init,
    // assistant, user, result). Try every line until one parses — the
    // first non-empty line is usually the system init event.
    try {
      const obj = JSON.parse(line.trim()) as { session_id?: unknown };
      if (typeof obj.session_id === 'string') return obj.session_id;
    } catch {
      // partial line or not JSON — caller will retry with the next line
    }
    return null;
  },

  extractPermissionMode(line: string): PermissionMode | null {
    // Only the system init event carries the effective permissionMode.
    // Other lines don't have it, so we return null and let the manager
    // keep feeding lines until init arrives.
    try {
      const obj = JSON.parse(line.trim()) as {
        type?: string;
        subtype?: string;
        permissionMode?: unknown;
      };
      if (obj.type === 'system' && obj.subtype === 'init') {
        const m = obj.permissionMode;
        if (m === 'default' || m === 'plan' || m === 'acceptEdits' || m === 'bypassPermissions') {
          return m;
        }
      }
    } catch {
      // not JSON yet
    }
    return null;
  },

  buildTerminalCommand(opts: { cwd: string; externalSessionId: string | null }) {
    const args: string[] = [];
    if (opts.externalSessionId) args.push('--resume', opts.externalSessionId);
    return { cmd: 'claude', args, env: {} };
  },

  interrupt(session: { tmuxName: string }): void {
    // Send Ctrl+C to the tmux pane (best effort — tmux may be absent in dev).
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
