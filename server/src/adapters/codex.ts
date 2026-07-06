import { spawn } from 'node:child_process';
import type { AgentEvent, LaunchOptions, ToolAdapter } from '../protocol.js';

const DETECT_TIMEOUT_MS = 3000;

async function detectCodex(): Promise<{ installed: boolean; version?: string }> {
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
      } else {
        resolve({ installed: false });
      }
    });
  });
}

export const codexAdapter: ToolAdapter = {
  id: 'codex',
  displayName: 'Codex',
  mode: 'pty',

  async detect() {
    return detectCodex();
  },

  buildCommand(opts: LaunchOptions) {
    const args = [];
    if (opts.model) args.push('--model', opts.model);
    return { cmd: 'codex', args, env: {} };
  },

  // pty mode: no chunk parsing, raw bytes flow through.
  encodeInput(text: string): Buffer {
    return Buffer.from(text + '\n', 'utf8');
  },

  interrupt(session: { tmuxName: string }): void {
    if (session.tmuxName) {
      spawn('tmux', ['send-keys', '-t', session.tmuxName, 'C-c'], { stdio: 'ignore' });
    }
  },
};
