// Host session scanner — discovers conversations the user started from the
// desktop terminal by walking the AI tools' own session-file directories.
// Returns a lightweight list for the app's "import desktop session" picker.
//
// Performance matters: users accumulate hundreds of multi-MB session files.
// So we (1) stat every candidate cheaply, (2) sort by mtime and only fully
// read the most-recent `limit` files, and (3) early-terminate per file once
// we have the id + cwd + first-user summary (and cap turn counting).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import type { HostSession, ToolId } from '../protocol.js';

const CLAUDE_DIR = join(homedir(), '.claude', 'projects');
const CODEX_DIR = join(homedir(), '.codex', 'sessions');

// Bound the work so a large ~/.claude history can't stall the request.
const DEFAULT_FILE_LIMIT = 60;
// Stop counting turns after this many lines — the exact count past this point
// isn't useful for a picker and reading giant files line-by-line is costly.
const MAX_COUNT_LINES = 4000;

function truncate(s: string, n = 120): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n) + '…' : clean;
}

interface Candidate {
  filePath: string;
  mtimeMs: number;
}

/** Recursively collect *.jsonl files under a root with their mtime (bounded
 *  depth to avoid runaway walks). statSync per file is cheap vs reading. */
function collectCandidates(root: string, maxDepth = 6): Candidate[] {
  const out: Candidate[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          out.push({ filePath: full, mtimeMs: statSync(full).mtimeMs });
        } catch {
          /* file vanished mid-scan */
        }
      }
    }
  };
  walk(root, 0);
  return out;
}

function scanClaudeFile(filePath: string, mtimeMs: number): HostSession | null {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const lines = content.split('\n');
  let externalSessionId = basename(filePath, '.jsonl');
  let cwd: string | null = null;
  let summary = '';
  let messageCount = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (i < MAX_COUNT_LINES && (line.includes('"type":"user"') || line.includes('"type":"assistant"'))) {
      messageCount += 1;
    }
    // Stop parsing once we have identity + summary (counting continues cheaply
    // via the substring check above, itself capped by MAX_COUNT_LINES).
    if (cwd && summary) {
      if (i >= MAX_COUNT_LINES) break;
      continue;
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof obj.sessionId === 'string') externalSessionId = obj.sessionId;
    if (typeof obj.cwd === 'string') cwd = obj.cwd as string;
    if (!summary && obj.type === 'user') {
      const msg = obj.message as { content?: unknown } | undefined;
      const c = msg?.content;
      if (typeof c === 'string') summary = truncate(c);
      else if (Array.isArray(c)) {
        const t = (c as Array<{ type?: string; text?: string }>).find((x) => x.type === 'text');
        if (t?.text) summary = truncate(t.text);
      }
    }
  }
  if (!cwd) return null;
  return { toolId: 'claude-code', externalSessionId, cwd, updatedAt: mtimeMs, messageCount, summary, filePath };
}

function scanCodexFile(filePath: string, mtimeMs: number): HostSession | null {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const lines = content.split('\n');
  let externalSessionId: string | null = null;
  let cwd: string | null = null;
  let summary = '';
  let messageCount = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (i >= MAX_COUNT_LINES && externalSessionId && cwd && summary) break;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type === 'session_meta') {
      const p = obj.payload as { id?: string; cwd?: string } | undefined;
      if (p?.id) externalSessionId = p.id;
      if (p?.cwd) cwd = p.cwd;
      continue;
    }
    if (obj.type !== 'response_item') continue;
    const p = obj.payload as { type?: string; role?: string; content?: unknown } | undefined;
    if (!p || p.type !== 'message') continue;
    if (p.role !== 'user' && p.role !== 'assistant') continue;
    if (i < MAX_COUNT_LINES) messageCount += 1;
    if (!summary && p.role === 'user') {
      const text = extractCodexText(p.content);
      if (text && !isSynthetic(text)) summary = truncate(text);
    }
  }
  if (!externalSessionId || !cwd) return null;
  return { toolId: 'codex', externalSessionId, cwd, updatedAt: mtimeMs, messageCount, summary, filePath };
}

function extractCodexText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .map((c) => (c.type?.endsWith('_text') || c.type === 'text' ? c.text ?? '' : ''))
      .join('');
  }
  return '';
}

function isSynthetic(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith('<environment_context>') ||
    t.startsWith('<permissions') ||
    t.startsWith('<user_instructions>')
  );
}

/**
 * Scan the host for AI-tool sessions.
 * @param opts.tool  Filter to a single tool (claude-code | codex). codebuddy
 *                   shares claude's directory layout so it is folded in.
 * @param opts.cwd   Filter to sessions rooted at a specific working dir.
 * @param opts.limit Max number of (most-recent) files to fully read.
 */
export function scanHostSessions(
  opts: { tool?: ToolId; cwd?: string; limit?: number } = {},
): HostSession[] {
  const limit = opts.limit ?? DEFAULT_FILE_LIMIT;
  const wantClaude = !opts.tool || opts.tool === 'claude-code' || opts.tool === 'codebuddy';
  const wantCodex = !opts.tool || opts.tool === 'codex';

  const candidates: Array<Candidate & { kind: 'claude' | 'codex' }> = [];
  if (wantClaude && existsSync(CLAUDE_DIR)) {
    for (const c of collectCandidates(CLAUDE_DIR)) candidates.push({ ...c, kind: 'claude' });
  }
  if (wantCodex && existsSync(CODEX_DIR)) {
    for (const c of collectCandidates(CODEX_DIR)) candidates.push({ ...c, kind: 'codex' });
  }

  // Most-recent first, then only fully read the top `limit` files.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out: HostSession[] = [];
  for (const c of candidates.slice(0, limit)) {
    const s =
      c.kind === 'claude'
        ? scanClaudeFile(c.filePath, c.mtimeMs)
        : scanCodexFile(c.filePath, c.mtimeMs);
    if (s) out.push(s);
  }

  const filtered = opts.cwd ? out.filter((s) => s.cwd === opts.cwd) : out;
  filtered.sort((a, b) => b.updatedAt - a.updatedAt);
  return filtered;
}

/** Locate a single host session file by its external session ID. Scans a
 *  wider window since the target may be older than the default list limit. */
export function findHostSession(externalSessionId: string, tool?: ToolId): HostSession | null {
  const all = scanHostSessions(tool ? { tool, limit: 500 } : { limit: 500 });
  return all.find((s) => s.externalSessionId === externalSessionId) ?? null;
}
