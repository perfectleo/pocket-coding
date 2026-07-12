import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
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
    handles = new Map();
    tokenBySession = new Map();
    start(opts) {
        const { sessionId, cwd, store } = opts;
        // Reuse existing handle for session if alive.
        const existingToken = this.tokenBySession.get(sessionId);
        if (existingToken && this.handles.has(existingToken)) {
            const h = this.handles.get(existingToken);
            if (h.state === 'ready' || h.state === 'starting') {
                return { token: existingToken, state: h.state };
            }
        }
        if (!existsSync(join(cwd, 'package.json'))) {
            throw new Error('no package.json in cwd');
        }
        const token = randomBytes(12).toString('hex');
        store.createPreviewToken(token, sessionId);
        const handle = {
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
    spawn(handle, store) {
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
        const onChunk = (chunk, stream) => {
            const text = chunk.toString('utf8');
            handle.logs.push(text);
            if (handle.logs.length > 4000)
                handle.logs = handle.logs.slice(-4000);
            if (handle.port !== null)
                return;
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
        proc.stdout?.on('data', (c) => onChunk(c, 'stdout'));
        proc.stderr?.on('data', (c) => onChunk(c, 'stderr'));
        proc.on('error', (err) => {
            handle.logs.push(`[spawn error] ${err.message}\n`);
            this.markError(handle, store);
        });
        proc.on('close', (code) => {
            handle.logs.push(`[exit] code=${code}\n`);
            if (handle.state !== 'ready') {
                this.markError(handle, store);
            }
            else {
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
    detectRunner(cwd) {
        if (existsSync(join(cwd, 'pnpm-lock.yaml')))
            return 'pnpm';
        if (existsSync(join(cwd, 'yarn.lock')))
            return 'yarn';
        return 'npm';
    }
    markReady(handle, port, store) {
        handle.port = port;
        handle.state = 'ready';
        store.setPreviewDevPort(handle.token, port);
    }
    markError(handle, store) {
        handle.state = 'error';
        store.setPreviewDevPort(handle.token, -1);
    }
    stop(token, store) {
        const h = this.handles.get(token);
        if (!h)
            return false;
        if (h.proc) {
            try {
                h.proc.kill('SIGTERM');
                setTimeout(() => {
                    try {
                        h.proc?.kill('SIGKILL');
                    }
                    catch { /* ignore */ }
                }, 2000);
            }
            catch { /* ignore */ }
        }
        h.state = 'stopped';
        store.revokePreviewToken(token);
        return true;
    }
    get(token) {
        return this.handles.get(token);
    }
    getBySession(sessionId) {
        const token = this.tokenBySession.get(sessionId);
        if (!token)
            return undefined;
        return this.handles.get(token);
    }
    logs(token, tail = 200) {
        const h = this.handles.get(token);
        if (!h)
            return '';
        return h.logs.slice(-tail).join('');
    }
}
export const previewManager = new PreviewManager();
//# sourceMappingURL=manager.js.map