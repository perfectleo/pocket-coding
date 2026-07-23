import * as pty from 'node-pty';

interface Handle {
  proc: pty.IPty;
  onData: (data: string) => void;
  onExit: (code: number) => void;
}

/**
 * Environment markers that a parent AI CLI (claude / codebuddy) exports into
 * every child process it spawns, so nested tools can detect they're "running
 * inside an agent". When our server is itself launched from within such a
 * session (e.g. `npm run dev` started from a claude session — which is how
 * this project is developed), these leak through `process.env` into the pty.
 *
 * A freshly-spawned interactive `claude` that sees them concludes it is nested
 * and DISABLES interactive-only slash commands — `/model`, `/clear`, etc. then
 * report "isn't available in this environment", defeating the whole point of
 * the terminal channel. We strip only these detection markers; auth/config
 * vars (ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, …) are preserved so login and
 * model routing keep working.
 */
const NESTED_AGENT_ENV_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
];

/** Return a copy of `base` with nested-agent detection markers removed so a
 *  spawned CLI launches as a clean top-level interactive session. */
export function sanitizeTerminalEnv(
  base: NodeJS.ProcessEnv,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (NESTED_AGENT_ENV_MARKERS.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Manages interactive pseudo-terminal processes, one per session id. Separate
 * from SessionManager's structured (stream-json) child processes — this is the
 * M3 terminal channel that runs the CLI's real TUI so slash commands work.
 */
export class TerminalManager {
  private handles = new Map<string, Handle>();

  open(opts: {
    sessionId: string;
    cmd: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
    cols?: number;
    rows?: number;
    onData: (data: string) => void;
    onExit: (code: number) => void;
  }): void {
    // One terminal per session — replace any stale handle.
    this.close(opts.sessionId);
    const proc = pty.spawn(opts.cmd, opts.args, {
      name: 'xterm-256color',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd,
      // Clean top-level env (see NESTED_AGENT_ENV_MARKERS) + adapter overrides,
      // so the CLI's interactive slash commands aren't disabled as "nested".
      env: sanitizeTerminalEnv({ ...process.env, ...(opts.env ?? {}) }),
    });
    const handle: Handle = { proc, onData: opts.onData, onExit: opts.onExit };
    proc.onData((d) => handle.onData(d));
    proc.onExit(({ exitCode }) => {
      this.handles.delete(opts.sessionId);
      handle.onExit(exitCode);
    });
    this.handles.set(opts.sessionId, handle);
  }

  write(sessionId: string, data: string): void {
    this.handles.get(sessionId)?.proc.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const h = this.handles.get(sessionId);
    if (!h) return;
    try { h.proc.resize(Math.max(1, cols), Math.max(1, rows)); } catch { /* pty gone */ }
  }

  has(sessionId: string): boolean {
    return this.handles.has(sessionId);
  }

  close(sessionId: string): void {
    const h = this.handles.get(sessionId);
    if (!h) return;
    this.handles.delete(sessionId);
    try { h.proc.kill(); } catch { /* already dead */ }
  }
}

export const terminalManager = new TerminalManager();
