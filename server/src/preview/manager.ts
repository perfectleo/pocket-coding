import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Store } from '../store/sqlite.js';

interface PreviewHandle {
  token: string;
  sessionId: string;
  cwd: string;
  port: number | null;
  proc: ChildProcess | null;
  tmuxName: string | null;
  logs: string[];
  state: 'starting' | 'ready' | 'stopped' | 'error';
  startedAt: number;
}

const PORT_DETECT_TIMEOUT_MS = 20_000;
const PORT_REGEXES = [
  /https?:\/\/localhost:(\d+)/,
  /https?:\/\/127\.0\.0\.1:(\d+)/,
  /https?:\/\/0\.0\.0\.0:(\d+)/,
  /Local:\s+https?:\/\/[^\s:]+:(\d+)/,
  /ready in \d+ ms.*?port\s+(\d+)/i,
  /on port\s+(\d+)/i,
  /listening on.*:(\d+)/i,
];

class PreviewManager {
  private handles = new Map<string, PreviewHandle>();
  private tokenBySession = new Map<string, string>();

  start(opts: { sessionId: string; cwd: string; store: Store }): { token: string; state: string } {
    const { sessionId, cwd, store } = opts;
    // Reuse existing handle for session if alive.
    const existingToken = this.tokenBySession.get(sessionId);
    if (existingToken && this.handles.has(existingToken)) {
      const h = this.handles.get(existingToken)!;
      if (h.state === 'ready' || h.state === 'starting') {
        return { token: existingToken, state: h.state };
      }
    }

    if (!existsSync(join(cwd, 'package.json'))) {
      throw new Error('no package.json in cwd');
    }

    const token = randomBytes(12).toString('hex');
    store.createPreviewToken(token, sessionId);
    const handle: PreviewHandle = {
      token,
      sessionId,
      cwd,
      port: null,
      proc: null,
      tmuxName: null,
      logs: [],
      state: 'starting',
      startedAt: Date.now(),
    };
    this.handles.set(token, handle);
    this.tokenBySession.set(sessionId, token);

    this.spawn(handle, store);
    return { token, state: 'starting' };
  }

  private spawn(handle: PreviewHandle, store: Store): void {
    const { cwd } = handle;
    // Prefer pnpm/yarn/npm based on lockfile.
    const cmd = this.detectRunner(cwd);
    const args = ['run', 'dev'];
    handle.logs.push(`$ ${cmd} ${args.join(' ')} (cwd=${cwd})\n`);
    const proc = spawn(cmd, args, {
      cwd,
      env: { ...process.env, PORT: '0', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    handle.proc = proc;

    const detectDeadline = Date.now() + PORT_DETECT_TIMEOUT_MS;

    const onChunk = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      const text = chunk.toString('utf8');
      handle.logs.push(text);
      if (handle.logs.length > 4000) handle.logs = handle.logs.slice(-4000);
      if (handle.port !== null) return;
      for (const re of PORT_REGEXES) {
        const m = text.match(re);
        if (m) {
          const port = Number(m[1]);
          if (port > 0 && port < 65536) {
            this.markReady(handle, port, store);
            break;
          }
        }
      }
      void stream;
    };
    proc.stdout?.on('data', (c: Buffer) => onChunk(c, 'stdout'));
    proc.stderr?.on('data', (c: Buffer) => onChunk(c, 'stderr'));

    proc.on('error', (err) => {
      handle.logs.push(`[spawn error] ${err.message}\n`);
      this.markError(handle, store);
    });
    proc.on('close', (code) => {
      handle.logs.push(`[exit] code=${code}\n`);
      if (handle.state !== 'ready') {
        this.markError(handle, store);
      } else {
        handle.state = 'stopped';
        store.setPreviewDevPort(handle.token, -1);
      }
      handle.proc = null;
    });

    // Timeout: if no port detected, mark error.
    void delay(PORT_DETECT_TIMEOUT_MS).then(() => {
      if (handle.port === null && handle.state === 'starting' && Date.now() >= detectDeadline) {
        handle.logs.push('[timeout] no port detected within 20s\n');
        this.markError(handle, store);
      }
    });
  }

  private detectRunner(cwd: string): string {
    if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
    if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn';
    return 'npm';
  }

  private markReady(handle: PreviewHandle, port: number, store: Store): void {
    handle.port = port;
    handle.state = 'ready';
    store.setPreviewDevPort(handle.token, port);
  }

  private markError(handle: PreviewHandle, store: Store): void {
    handle.state = 'error';
    store.setPreviewDevPort(handle.token, -1);
  }

  stop(token: string, store: Store): boolean {
    const h = this.handles.get(token);
    if (!h) return false;
    if (h.proc) {
      try {
        h.proc.kill('SIGTERM');
        setTimeout(() => {
          try { h.proc?.kill('SIGKILL'); } catch { /* ignore */ }
        }, 2000);
      } catch { /* ignore */ }
    }
    h.state = 'stopped';
    store.revokePreviewToken(token);
    return true;
  }

  get(token: string): PreviewHandle | undefined {
    return this.handles.get(token);
  }

  getBySession(sessionId: string): PreviewHandle | undefined {
    const token = this.tokenBySession.get(sessionId);
    if (!token) return undefined;
    return this.handles.get(token);
  }

  logs(token: string, tail = 200): string {
    const h = this.handles.get(token);
    if (!h) return '';
    return h.logs.slice(-tail).join('');
  }
}

export const previewManager = new PreviewManager();
