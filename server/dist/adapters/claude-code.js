import { spawn } from 'node:child_process';
const DETECT_TIMEOUT_MS = 3000;
async function detectClaude() {
    return new Promise((resolve) => {
        const t = setTimeout(() => resolve({ installed: false }), DETECT_TIMEOUT_MS);
        const p = spawn('claude', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
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
// Parse one line of Claude Code stream-json into AgentEvent(s).
function parseJsonLine(line) {
    const trimmed = line.trim();
    if (!trimmed)
        return [];
    let obj;
    try {
        obj = JSON.parse(trimmed);
    }
    catch {
        return [];
    }
    return mapClaudeEvent(obj);
}
function mapClaudeEvent(obj) {
    if (!obj || typeof obj !== 'object')
        return [];
    const e = obj;
    const type = e.type;
    const out = [];
    switch (type) {
        case 'system': {
            // init/sessionConfig events carry no conversational content — suppress.
            // (subtype 'init' dumps all tools/skills; we don't want it flooding chat.)
            break;
        }
        case 'assistant': {
            const message = e.message;
            const content = message?.content;
            if (Array.isArray(content)) {
                for (const c of content) {
                    if (c.type === 'text' && typeof c.text === 'string') {
                        out.push({ type: 'message', role: 'assistant', text: c.text });
                    }
                    else if (c.type === 'thinking' && typeof c.thinking === 'string') {
                        out.push({ type: 'thinking', text: c.thinking });
                    }
                    else if (c.type === 'tool_use') {
                        const name = c.name || 'tool';
                        const id = c.id || 't' + Math.random().toString(36).slice(2, 8);
                        out.push({ type: 'tool_call', id, name, input: c.input });
                    }
                }
            }
            break;
        }
        case 'user': {
            // Claude stream-json returns tool results as user messages with content[]
            // blocks of type 'tool_result' — not as top-level events.
            const message = e.message;
            const content = message?.content;
            if (Array.isArray(content)) {
                for (const c of content) {
                    if (c.type !== 'tool_result')
                        continue;
                    const id = c.tool_use_id || 't';
                    const raw = c.content;
                    let output = '';
                    if (typeof raw === 'string')
                        output = raw;
                    else if (Array.isArray(raw)) {
                        output = raw
                            .map((x) => (typeof x === 'string' ? x : x?.text || ''))
                            .join('');
                    }
                    out.push({ type: 'tool_result', id, output });
                }
            }
            break;
        }
        case 'thinking': {
            const text = e.thinking || '';
            if (text)
                out.push({ type: 'thinking', text });
            break;
        }
        case 'result': {
            const subtype = e.subtype;
            if (subtype === 'error') {
                out.push({ type: 'status', state: 'error' });
            }
            else {
                out.push({ type: 'status', state: 'done' });
            }
            break;
        }
        default:
            // Unknown event types: pass as raw for debugging (non-fatal).
            out.push({ type: 'raw', data: JSON.stringify(e) });
            break;
    }
    return out;
}
export const claudeCodeAdapter = {
    id: 'claude-code',
    displayName: 'Claude Code',
    mode: 'structured',
    async detect() {
        return detectClaude();
    },
    buildCommand(opts) {
        const args = [
            '--output-format', 'stream-json',
            '--input-format', 'stream-json',
            '--verbose',
        ];
        if (opts.model)
            args.push('--model', opts.model);
        return { cmd: 'claude', args, env: {} };
    },
    parseChunk(chunk) {
        // Claude stream-json is line-delimited. Buffer across calls.
        const text = chunk.toString('utf8');
        const lines = text.split('\n');
        const events = [];
        for (const line of lines) {
            if (!line)
                continue;
            events.push(...parseJsonLine(line));
        }
        return events;
    },
    encodeInput(text) {
        // stream-json input: a JSON object per user turn.
        const obj = JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
        return Buffer.from(obj + '\n', 'utf8');
    },
    encodeApproval(_callId, approve) {
        // Claude Code permission prompts: respond via stdin with the choice.
        // Format depends on CLI version; send a simple yes/no line.
        return Buffer.from((approve ? 'yes' : 'no') + '\n', 'utf8');
    },
    interrupt(session) {
        // Send Ctrl+C to the tmux pane (best effort — tmux may be absent in dev).
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
//# sourceMappingURL=claude-code.js.map