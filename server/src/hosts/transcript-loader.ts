// Transcript loader — parses the AI tools' own on-disk session files into a
// tool-agnostic shape so Pocket can (a) discover host sessions and (b)
// backfill turns that happened in the desktop terminal.
//
// This is the read side of the "single source of truth = tool session file"
// principle: SQLite is an index/cache, these files are the truth.
//
// File layouts (verified from real captures):
//   claude : ~/.claude/projects/<enc-cwd>/<sessionId>.jsonl
//            one JSON object per line; user/assistant/system/permission-mode/
//            file-history-snapshot; `cwd` + `sessionId` on content lines;
//            per-line `uuid` gives a stable dedupe ref.
//   codex  : ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
//            first line type=session_meta {payload:{id,cwd,timestamp}};
//            then response_item {payload:{type:message|reasoning|function_call}}.

import { readFileSync } from 'node:fs';
import type { AgentEvent, ToolId } from '../protocol.js';

export interface TranscriptEntry {
  // Stable reference to this turn/line in the source file (dedupe key).
  ref: string;
  role: 'user' | 'assistant' | 'system';
  // For user turns: 'text' with { text }. Otherwise a full AgentEvent.
  event: AgentEvent | { type: 'text'; text: string };
  createdAt: number;
}

export interface Transcript {
  toolId: ToolId;
  externalSessionId: string | null;
  cwd: string | null;
  updatedAt: number;
  entries: TranscriptEntry[];
}

export interface TranscriptMeta {
  toolId: ToolId;
  externalSessionId: string | null;
  cwd: string | null;
  updatedAt: number;
  messageCount: number;
  summary: string;
}

function truncate(s: string, n = 120): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n) + '…' : clean;
}

function ts(iso: unknown): number {
  if (typeof iso === 'string') {
    const t = Date.parse(iso);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

// Codex injects synthetic user turns (environment context / permission
// instructions) that aren't real conversation — skip them in summaries and
// backfill so the app shows what the human actually typed.
function isSyntheticUserText(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith('<environment_context>') ||
    t.startsWith('<permissions') ||
    t.startsWith('<user_instructions>')
  );
}

// ---------- Claude ----------

export function parseClaudeTranscript(filePath: string, mtime: number): Transcript {
  const entries: TranscriptEntry[] = [];
  let cwd: string | null = null;
  let sessionId: string | null = null;
  let lineNo = 0;

  for (const rawLine of readLines(filePath)) {
    lineNo += 1;
    const line = rawLine.trim();
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof obj.sessionId === 'string' && !sessionId) sessionId = obj.sessionId;
    if (typeof obj.cwd === 'string') cwd = obj.cwd as string;
    const type = obj.type as string;
    const uuid = (obj.uuid as string) || `claude:${lineNo}`;
    const createdAt = ts(obj.timestamp);

    if (type === 'user') {
      const msg = obj.message as { role?: string; content?: unknown } | undefined;
      const content = msg?.content;
      if (typeof content === 'string') {
        entries.push({ ref: uuid, role: 'user', event: { type: 'text', text: content }, createdAt });
      } else if (Array.isArray(content)) {
        for (const c of content as Array<Record<string, unknown>>) {
          if (c.type === 'text' && typeof c.text === 'string') {
            entries.push({ ref: uuid, role: 'user', event: { type: 'text', text: c.text }, createdAt });
          } else if (c.type === 'tool_result') {
            const id = (c.tool_use_id as string) || 't';
            const out = extractToolResultText(c.content);
            entries.push({ ref: `${uuid}:tr`, role: 'system', event: { type: 'tool_result', id, output: out }, createdAt });
          }
        }
      }
    } else if (type === 'assistant') {
      const msg = obj.message as { content?: Array<Record<string, unknown>> } | undefined;
      const content = msg?.content;
      if (Array.isArray(content)) {
        let i = 0;
        for (const c of content) {
          i += 1;
          if (c.type === 'text' && typeof c.text === 'string') {
            entries.push({ ref: `${uuid}:${i}`, role: 'assistant', event: { type: 'message', role: 'assistant', text: c.text as string }, createdAt });
          } else if (c.type === 'thinking' && typeof c.thinking === 'string') {
            entries.push({ ref: `${uuid}:${i}`, role: 'assistant', event: { type: 'thinking', text: c.thinking as string }, createdAt });
          } else if (c.type === 'tool_use') {
            const id = (c.id as string) || `t${i}`;
            entries.push({ ref: `${uuid}:${i}`, role: 'assistant', event: { type: 'tool_call', id, name: (c.name as string) || 'tool', input: c.input }, createdAt });
          }
        }
      }
    }
    // system / permission-mode / file-history-snapshot / summary: skipped.
  }

  return { toolId: 'claude-code', externalSessionId: sessionId, cwd, updatedAt: mtime, entries };
}

function extractToolResultText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((x) => (typeof x === 'string' ? x : ((x as { text?: string })?.text ?? '')))
      .join('');
  }
  return '';
}

// ---------- Codex ----------

export function parseCodexTranscript(filePath: string, mtime: number): Transcript {
  const entries: TranscriptEntry[] = [];
  let cwd: string | null = null;
  let sessionId: string | null = null;
  let lineNo = 0;

  for (const rawLine of readLines(filePath)) {
    lineNo += 1;
    const line = rawLine.trim();
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = obj.type as string;
    const createdAt = ts(obj.timestamp);

    if (type === 'session_meta') {
      const p = obj.payload as { id?: string; cwd?: string } | undefined;
      if (p?.id) sessionId = p.id;
      if (p?.cwd) cwd = p.cwd;
      continue;
    }
    if (type !== 'response_item') continue;
    const p = obj.payload as Record<string, unknown> | undefined;
    if (!p) continue;
    const ref = `codex:${lineNo}`;

    if (p.type === 'message') {
      const role = p.role as string;
      const text = extractCodexText(p.content);
      if (!text) continue;
      if (role === 'user') {
        if (isSyntheticUserText(text)) continue;
        entries.push({ ref, role: 'user', event: { type: 'text', text }, createdAt });
      } else if (role === 'assistant') {
        entries.push({ ref, role: 'assistant', event: { type: 'message', role: 'assistant', text }, createdAt });
      }
      // 'developer' messages are system scaffolding — skipped.
    } else if (p.type === 'reasoning') {
      const text = extractCodexSummary(p.summary);
      if (text) entries.push({ ref, role: 'assistant', event: { type: 'thinking', text }, createdAt });
    } else if (p.type === 'function_call' || p.type === 'local_shell_call') {
      const id = (p.call_id as string) || ref;
      const name = (p.name as string) || 'exec';
      let input: unknown = p.arguments;
      if (typeof input === 'string') {
        try {
          input = JSON.parse(input);
        } catch {
          input = { command: input };
        }
      }
      entries.push({ ref, role: 'assistant', event: { type: 'tool_call', id, name, input }, createdAt });
    }
  }

  return { toolId: 'codex', externalSessionId: sessionId, cwd, updatedAt: mtime, entries };
}

function extractCodexText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const x = c as { type?: string; text?: string };
        if (x.type === 'input_text' || x.type === 'output_text' || x.type === 'text') return x.text ?? '';
        return '';
      })
      .join('');
  }
  return '';
}

function extractCodexSummary(summary: unknown): string {
  if (Array.isArray(summary)) {
    return summary
      .map((s) => (s as { text?: string })?.text ?? '')
      .join('\n');
  }
  return '';
}

// ---------- shared ----------

function readLines(filePath: string): string[] {
  const buf = readFileSync(filePath, 'utf8');
  return buf.split('\n');
}

export function parseTranscript(toolId: ToolId, filePath: string, mtime: number): Transcript {
  if (toolId === 'codex') return parseCodexTranscript(filePath, mtime);
  // claude + codebuddy share the claude jsonl layout.
  return parseClaudeTranscript(filePath, mtime);
}

/** Lightweight metadata for the discovery list — parses the file but only
 *  keeps counts + a summary from the first real user turn. */
export function transcriptMeta(t: Transcript): TranscriptMeta {
  const convo = t.entries.filter(
    (e) => e.event.type === 'text' || e.event.type === 'message',
  );
  const firstUser = t.entries.find((e) => e.role === 'user' && e.event.type === 'text');
  const summary =
    firstUser && firstUser.event.type === 'text' ? truncate(firstUser.event.text) : '';
  return {
    toolId: t.toolId,
    externalSessionId: t.externalSessionId,
    cwd: t.cwd,
    updatedAt: t.updatedAt,
    messageCount: convo.length,
    summary,
  };
}
