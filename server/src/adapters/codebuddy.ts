import { spawn } from 'node:child_process';
import type { AgentEvent, LaunchOptions, ToolAdapter } from '../protocol.js';
import { parseJsonLine, mapClaudeEvent, claudeCodeAdapter } from './claude-code.js';

const DETECT_TIMEOUT_MS = 3000;

async function detectCodebuddy(): Promise<{ installed: boolean; version?: string }> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ installed: false }), DETECT_TIMEOUT_MS);
    const p = spawn('codebuddy', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
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

// CodeBuddy speaks the same stream-json protocol as Claude Code, so we
// reuse claude's parseJsonLine/mapClaudeEvent verbatim. Only the binary
// name and the --resume=<id> (equals-sign) syntax differ.
export const codebuddyAdapter: ToolAdapter = {
  id: 'codebuddy',
  displayName: 'CodeBuddy',
  mode: 'structured',
  // Same stream-json input protocol as claude — supports a resident process.
  supportsResidentStdin: true,

  async detect() {
    return detectCodebuddy();
  },

  buildCommand(opts: LaunchOptions) {
    const args = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', opts.permissionMode,
    ];
    // codebuddy generates its own session ID (same as claude). We capture
    // it from stdout via extractSessionId and persist it; on resume we
    // pass --resume=<id> so the tool picks up its own conversation.
    if (opts.resume) {
      args.push(`--resume=${opts.sessionId}`);
    }
    if (opts.model) args.push('--model', opts.model);
    return { cmd: 'codebuddy', args, env: {} };
  },

  parseJsonLine,
  parseChunk: claudeCodeAdapter.parseChunk,
  encodeInput: claudeCodeAdapter.encodeInput,
  encodeApproval: claudeCodeAdapter.encodeApproval,
  extractSessionId: claudeCodeAdapter.extractSessionId,
  extractPermissionMode: claudeCodeAdapter.extractPermissionMode,

  buildTerminalCommand(opts: { cwd: string; externalSessionId: string | null }) {
    const args: string[] = [];
    if (opts.externalSessionId) args.push(`--resume=${opts.externalSessionId}`);
    return { cmd: 'codebuddy', args, env: {} };
  },

  interrupt: claudeCodeAdapter.interrupt,
};

// Silence unused-import warnings for re-exports that keep the module
// self-contained for future tool variants.
void mapClaudeEvent;
