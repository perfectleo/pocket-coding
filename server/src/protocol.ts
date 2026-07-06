// Pocket Coding protocol — shared between server and app.
// Versioned: bump PROTOCOL_VERSION on breaking changes.

export const PROTOCOL_VERSION = 1;

// ---------- Agent events (server → app, via WS) ----------

export type AgentEvent =
  | { type: 'message'; role: 'assistant'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown; danger?: boolean }
  | { type: 'tool_result'; id: string; output: string }
  | { type: 'diff'; file: string; patch: string }
  | { type: 'plan'; steps: string[] }
  | { type: 'status'; state: SessionState }
  | { type: 'raw'; data: string };

export type SessionState =
  | 'created'
  | 'running'
  | 'waiting_approval'
  | 'done'
  | 'error';

// ---------- WS envelope ----------

export type ClientMessage =
  | { t: 'attach'; sessionId: string; lastSeq: number }
  | { t: 'input'; sessionId: string; text: string }
  | { t: 'approve'; sessionId: string; callId: string; approve: boolean }
  | { t: 'interrupt'; sessionId: string }
  | { t: 'resize'; sessionId: string; cols: number; rows: number }
  | { t: 'ping' };

export type ServerMessage =
  | { seq: number; t: 'event'; sessionId: string; event: AgentEvent }
  | { seq: number; t: 'status'; sessionId: string; state: SessionState }
  | { seq: number; t: 'checkpoint'; sessionId: string; cpId: string; kind: 'created' }
  | { seq: number; t: 'preview'; sessionId: string; state: PreviewState; url?: string }
  | { seq: number; t: 'error'; sessionId?: string; message: string }
  | { seq: number; t: 'pong' };

export type PreviewState = 'starting' | 'ready' | 'stopped' | 'error';

// ---------- Tool adapter interface ----------

export type ToolId = 'claude-code' | 'codex';

export interface LaunchOptions {
  cwd: string;
  model?: string;
  mode?: 'agent' | 'chat';
}

export interface ToolAdapter {
  id: ToolId;
  displayName: string;
  mode: 'structured' | 'pty';
  detect(): Promise<{ installed: boolean; version?: string }>;
  buildCommand(opts: LaunchOptions): { cmd: string; args: string[]; env: Record<string, string> };
  parseChunk?(chunk: Buffer): AgentEvent[];
  encodeInput(text: string): Buffer;
  encodeApproval?(callId: string, approve: boolean): Buffer;
  interrupt(session: { tmuxName: string }): void;
}

// ---------- REST types ----------

export interface PairCodeResponse {
  code: string;
  expiresAt: number;
}

export interface PairResponse {
  token: string;
  expiresAt: number;
  deviceId: string;
}

export interface ToolInfo {
  id: ToolId;
  displayName: string;
  installed: boolean;
  version?: string;
}

export interface SessionSummary {
  id: string;
  projectId: string;
  toolId: ToolId;
  model?: string;
  state: SessionState;
  lastSeq: number;
  createdAt: number;
  lastMessage?: string;
}

export interface SessionDetail extends SessionSummary {
  tmuxName: string;
  baselineRef?: string;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  seq: number;
  role: 'user' | 'assistant' | 'system';
  type: AgentEvent['type'] | 'text';
  payload: unknown;
  turnId?: string;
  createdAt: number;
}

export interface DiffHunk {
  file: string;
  hunks: Array<{
    header: string;
    lines: Array<{ type: 'add' | 'del' | 'ctx'; oldNo?: number; newNo?: number; text: string }>;
  }>;
  added: number;
  removed: number;
}

export interface CheckpointRecord {
  id: string;
  sessionId: string;
  turnId: string;
  status: 'pending' | 'accepted' | 'rolledback';
  files: Array<{ path: string; added: number; removed: number }>;
  createdAt: number;
}

// ---------- Danger detection ----------

export const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+-rf?\s+[\/~]/i,
  /\bgit\s+push\s+(-f|--force)/i,
  /\bcurl\s+[^|]*\|\s*(sh|bash|zsh)/i,
  /\bwget\s+[^|]*\|\s*(sh|bash|zsh)/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  />\s*\/dev\/sd[a-z]/i,
  /\bchmod\s+-R\s+777\b/i,
  /\bsudo\b/i,
  /\:\(\)\s*\{/i,
];

export function isDangerousCommand(cmd: string): boolean {
  return DANGEROUS_PATTERNS.some((re) => re.test(cmd));
}
