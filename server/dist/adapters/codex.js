import { spawn } from 'node:child_process';
const DETECT_TIMEOUT_MS = 3000;
async function detectCodex() {
    return new Promise((resolve) => {
        const t = setTimeout(() => resolve({ installed: false }), DETECT_TIMEOUT_MS);
        const p = spawn('codex', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
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
            }
            else {
                resolve({ installed: false });
            }
        });
    });
}
export const codexAdapter = {
    id: 'codex',
    displayName: 'Codex',
    mode: 'pty',
    async detect() {
        return detectCodex();
    },
    buildCommand(opts) {
        const args = [];
        if (opts.model)
            args.push('--model', opts.model);
        return { cmd: 'codex', args, env: {} };
    },
    // pty mode: no chunk parsing, raw bytes flow through.
    encodeInput(text) {
        return Buffer.from(text + '\n', 'utf8');
    },
    interrupt(session) {
        if (session.tmuxName) {
            try {
                const p = spawn('tmux', ['send-keys', '-t', session.tmuxName, 'C-c'], { stdio: 'ignore' });
                p.on('error', () => { });
            }
            catch {
                // ignore
            }
        }
    },
};
//# sourceMappingURL=codex.js.map