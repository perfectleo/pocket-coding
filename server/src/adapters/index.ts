import type { ToolAdapter, ToolId } from '../protocol.js';
import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';
import { codebuddyAdapter } from './codebuddy.js';

export const adapters: Record<ToolId, ToolAdapter> = {
  'claude-code': claudeCodeAdapter,
  codex: codexAdapter,
  codebuddy: codebuddyAdapter,
};

export function getAdapter(id: string): ToolAdapter | undefined {
  return (adapters as Record<string, ToolAdapter>)[id];
}

export async function detectAllTools() {
  const out = [];
  for (const a of Object.values(adapters)) {
    const info = await a.detect();
    out.push({ id: a.id, displayName: a.displayName, ...info });
  }
  return out;
}
