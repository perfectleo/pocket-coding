import * as pty from 'node-pty';

interface Handle {
  proc: pty.IPty;
  onData: (data: string) => void;
  onExit: (code: number) => void;
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
      env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string>,
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
