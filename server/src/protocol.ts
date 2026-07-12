// Pocket Coding protocol — shared between server and app.
// Versioned: bump PROTOCOL_VERSION on breaking changes.

export const PROTOCOL_VERSION = 1;

// ---------- Agent events (server → app, via WS) ----------

export type AgentEvent =
  | { type: 'message'; role: 'assistant'; text: string }
  | { type: 'message_delta'; role: 'assistant'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown; danger?: boolean }
  | { type: 'tool_result'; id: string; output: string }
  | { type: 'diff'; file: string; patch: string }
  | { type: 'plan'; steps: string[] }
  | { type: 'status'; state: SessionState }
  | { type: 'mode'; mode: PermissionMode }
  | { type: 'raw'; data: string };

export type SessionState =
  | 'created'
  | 'running'
  | 'waiting_approval'
  | 'idle'   // process exited (done or interrupted), waiting for next input which will --resume
  | 'done'
  | 'error';

// AI tool permission modes. claude/codebuddy accept these verbatim via
// --permission-mode; codex maps them onto its --sandbox + --ask-for-approval
// pair (plan has no codex equivalent and falls back to default).
export type PermissionMode =
  | 'default'
  | 'plan'
  | 'acceptEdits'
  | 'bypassPermissions';

export const PERMISSION_MODES: PermissionMode[] = ['default', 'plan', 'acceptEdits', 'bypassPermissions'];

export function nextPermissionMode(m: PermissionMode): PermissionMode {
  const i = PERMISSION_MODES.indexOf(m);
  return PERMISSION_MODES[(i + 1) % PERMISSION_MODES.length];
}

// ---------- WS envelope ----------

export type ClientMessage =
  | { t: 'attach'; sessionId: string; lastSeq: number }
  | { t: 'input'; sessionId: string; text: string }
  | { t: 'approve'; sessionId: string; callId: string; approve: boolean }
  | { t: 'interrupt'; sessionId: string }
  | { t: 'resize'; sessionId: string; cols: number; rows: number }
  | { t: 'mode'; sessionId: string; mode?: PermissionMode }   // mode omitted => cycle; present => set directly
  | { t: 'ping' };

export type ServerMessage =
  | { seq: number; t: 'event'; sessionId: string; event: AgentEvent }
  | { seq: number; t: 'status'; sessionId: string; state: SessionState }
  | { seq: number; t: 'checkpoint'; sessionId: string; cpId: string; kind: 'created' }
  | { seq: number; t: 'preview'; sessionId: string; state: PreviewState; url?: string }
  | { seq: number; t: 'mode'; sessionId: string; mode: PermissionMode }
  | { seq: number; t: 'error'; sessionId?: string; message: string }
  | { seq: number; t: 'pong' };

export type PreviewState = 'starting' | 'ready' | 'stopped' | 'error';

// ---------- Tool adapter interface ----------

export type ToolId = 'claude-code' | 'codex' | 'codebuddy';

export interface LaunchOptions {
  cwd: string;
  model?: string;
  mode?: 'agent' | 'chat';
  // AI tool's own session ID (captured from stdout on first turn, persisted
  // to DB). Used as --resume <id> when re-spawning after process exit or
  // server restart. On the first turn (resume=false) this is null/ignored —
  // the AI tool generates its own ID.
  sessionId: string;
  // true => spawn with --resume <sessionId> to continue a prior session.
  resume: boolean;
  // Permission mode to launch the AI tool with. claude/codebuddy pass this
  // verbatim via --permission-mode; codex maps it to --sandbox +
  // --ask-for-approval. Default = 'default'.
  permissionMode: PermissionMode;
}

export interface ToolAdapter {
  id: ToolId;
  displayName: string;
  mode: 'structured' | 'pty';
  detect(): Promise<{ installed: boolean; version?: string }>;
  buildCommand(opts: LaunchOptions): { cmd: string; args: string[]; env: Record<string, string> };
  parseJsonLine?(line: string): AgentEvent[];
  parseChunk?(chunk: Buffer): AgentEvent[];
  encodeInput(text: string): Buffer;
  encodeApproval?(callId: string, approve: boolean): Buffer;
  // Extract the AI tool's session ID from a stdout line. Called for each
  // complete line until it returns a non-null ID. Each adapter handles its
  // tool's envelope: codex emits thread_id in thread.started; claude and
  // codebuddy emit session_id in every stream-json message.
  extractSessionId?(line: string): string | null;
  // Extract the AI tool's current permission mode from a stdout line, if
  // the line carries one (e.g. claude's system init event has permissionMode).
  // The captured mode is broadcast to the app so its mode chip reflects the
  // tool's actual state rather than what we last requested.
  extractPermissionMode?(line: string): PermissionMode | null;
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
  permissionMode: PermissionMode;
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
