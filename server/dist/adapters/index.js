import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';
export const adapters = {
    'claude-code': claudeCodeAdapter,
    codex: codexAdapter,
};
export function getAdapter(id) {
    return adapters[id];
}
export async function detectAllTools() {
    const out = [];
    for (const a of Object.values(adapters)) {
        const info = await a.detect();
        out.push({ id: a.id, displayName: a.displayName, ...info });
    }
    return out;
}
//# sourceMappingURL=index.js.map