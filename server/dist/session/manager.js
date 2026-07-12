import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { config } from '../config.js';
import { isDangerousCommand } from '../protocol.js';
import { newId, newSessionId } from '../gateway/auth.js';
import { getAdapter } from '../adapters/index.js';
import { Scrollback } from './scrollback.js';
import * as checkpoint from '../checkpoint/index.js';
class SessionManager {
    sessions = new Map();
    async create(opts) {
        const id = newSessionId();
        const tmuxName = `pocket-${id}`;
        const adapter = getAdapter(opts.toolId);
        if (!adapter)
            throw new Error(`unknown tool: ${opts.toolId}`);
        mkdirSync(opts.cwd, { recursive: true });
        const session = {
            id,
            projectId: opts.projectId,
            toolId: opts.toolId,
            model: opts.model,
            state: 'created',
            tmuxName,
            cwd: opts.cwd,
            lastSeq: 0,
            scrollback: new Scrollback(),
            proc: null,
            pendingApprovals: new Map(),
            subscribers: new Set(),
            currentTurnId: null,
            snapshottedTurns: new Set(),
            approvalMutex: Promise.resolve(),
        };
        opts.store.createSession({
            id,
            project_id: opts.projectId,
            tool_id: opts.toolId,
            model: opts.model ?? null,
            state: 'created',
            tmux_name: tmuxName,
            last_seq: 0,
            baseline_ref: null,
            created_at: Date.now(),
        });
        this.sessions.set(id, session);
        return session;
    }
    async start(session, store) {
        const adapter = getAdapter(session.toolId);
        if (!adapter)
            throw new Error(`unknown tool: ${session.toolId}`);
        const { cmd, args, env } = adapter.buildCommand({
            cwd: session.cwd,
            model: session.model,
        });
        this.setState(session, 'running', store);
        const proc = spawn(cmd, args, {
            cwd: session.cwd,
            env: { ...process.env, ...env },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        session.proc = proc;
        const handleChunk = (chunk) => {
            let events = [];
            if (adapter.parseChunk) {
                events = adapter.parseChunk(chunk);
            }
            else {
                events = [{ type: 'raw', data: chunk.toString('utf8') }];
            }
            // Serialize per-session so approval gates and snapshots stay ordered.
            session.approvalMutex = session.approvalMutex.then(() => this.processEvents(session, events, store, adapter)).catch((err) => {
                this.emitEvent(session, { type: 'raw', data: `[gate error] ${err.message}\n` }, store);
            });
        };
        proc.stdout?.on('data', handleChunk);
        proc.stderr?.on('data', (chunk) => {
            // stderr as raw for pty mode or as raw error context
            this.emitEvent(session, { type: 'raw', data: chunk.toString('utf8') }, store);
        });
        proc.on('error', (err) => {
            this.emitEvent(session, { type: 'raw', data: `[spawn error] ${err.message}\n` }, store);
            this.setState(session, 'error', store);
        });
        proc.on('close', (code) => {
            this.emitEvent(session, { type: 'status', state: code === 0 ? 'done' : 'error' }, store);
            this.setState(session, code === 0 ? 'done' : 'error', store);
            session.proc = null;
        });
    }
    async processEvents(session, events, store, adapter) {
        for (const ev of events) {
            await this.maybeSnapshot(session, ev, store);
            await this.maybeGateApproval(session, ev, store, adapter);
            this.emitEvent(session, ev, store);
        }
    }
    async maybeSnapshot(session, ev, store) {
        const turnId = session.currentTurnId;
        if (!turnId)
            return;
        if (session.snapshottedTurns.has(turnId))
            return;
        // Snapshot on the first sign of assistant activity in this turn.
        const triggersAssistant = ev.type === 'message' || ev.type === 'tool_call' || ev.type === 'thinking';
        if (!triggersAssistant)
            return;
        try {
            await checkpoint.snapshot(session.cwd, store, session.id, turnId);
            session.snapshottedTurns.add(turnId);
            session.lastSeq += 1;
            const cpMsg = {
                seq: session.lastSeq,
                t: 'checkpoint',
                sessionId: session.id,
                cpId: turnId,
                kind: 'created',
            };
            session.scrollback.push(cpMsg);
            store.updateSessionLastSeq(session.id, session.lastSeq);
            for (const sub of session.subscribers)
                sub(cpMsg);
        }
        catch (err) {
            // Snapshot failure shouldn't break the turn — log and continue.
            this.emitEvent(session, { type: 'raw', data: `[snapshot error] ${err.message}\n` }, store);
        }
    }
    async maybeGateApproval(session, ev, store, adapter) {
        if (ev.type !== 'tool_call')
            return;
        const cmd = extractCommand(ev);
        if (!cmd)
            return;
        if (!isDangerousCommand(cmd))
            return;
        ev.danger = true;
        const approvalId = newId('ap');
        store.createApproval({
            id: approvalId,
            session_id: session.id,
            call_id: ev.id,
            command: cmd,
            decision: null,
            decided_at: null,
            created_at: Date.now(),
        });
        store.audit(session.id, 'approval_requested', ev.id, JSON.stringify({ command: cmd }));
        this.setState(session, 'waiting_approval', store);
        const decision = await new Promise((resolve) => {
            session.pendingApprovals.set(ev.id, resolve);
            const timer = setTimeout(() => {
                if (session.pendingApprovals.has(ev.id)) {
                    session.pendingApprovals.delete(ev.id);
                    resolve(false); // auto-deny on timeout
                }
            }, config.approvalTimeoutMs);
            const orig = session.pendingApprovals.get(ev.id);
            session.pendingApprovals.set(ev.id, (ok) => {
                clearTimeout(timer);
                orig(ok);
            });
        });
        store.decideApproval(approvalId, decision ? 'approved' : 'rejected');
        store.audit(session.id, 'approval_decided', ev.id, JSON.stringify({ decision }));
        if (session.proc?.stdin && adapter?.encodeApproval) {
            try {
                session.proc.stdin.write(adapter.encodeApproval(ev.id, decision));
            }
            catch {
                // stdin might be closed — non-fatal
            }
        }
        if (session.state === 'waiting_approval') {
            this.setState(session, 'running', store);
        }
    }
    input(session, text, store) {
        const adapter = getAdapter(session.toolId);
        if (!adapter || !session.proc?.stdin)
            return;
        session.currentTurnId = newId('turn');
        store.audit(session.id, 'input', session.toolId, JSON.stringify({ text, turnId: session.currentTurnId }));
        const buf = adapter.encodeInput(text);
        session.proc.stdin.write(buf);
        store.appendMessage({
            id: newId('m'),
            session_id: session.id,
            seq: 0,
            role: 'user',
            type: 'text',
            payload: JSON.stringify({ text }),
            turn_id: session.currentTurnId,
            created_at: Date.now(),
        });
    }
    interrupt(session) {
        const adapter = getAdapter(session.toolId);
        try {
            adapter?.interrupt({ tmuxName: session.tmuxName });
        }
        catch {
            // ignore — SIGINT below is the real interrupt
        }
        if (session.proc?.pid) {
            try {
                process.kill(session.proc.pid, 'SIGINT');
            }
            catch {
                // ignore
            }
        }
    }
    attach(session, lastSeq, cb) {
        session.subscribers.add(cb);
        return session.scrollback.after(lastSeq);
    }
    detach(session, cb) {
        session.subscribers.delete(cb);
    }
    emitEvent(session, event, store) {
        session.lastSeq += 1;
        const seq = session.lastSeq;
        const msg = { seq, t: 'event', sessionId: session.id, event };
        session.scrollback.push(msg);
        store.updateSessionLastSeq(session.id, seq);
        store.appendMessage({
            id: newId('m'),
            session_id: session.id,
            seq,
            role: event.type === 'message' ? 'assistant' : 'system',
            type: event.type,
            payload: JSON.stringify(event),
            turn_id: null,
            created_at: Date.now(),
        });
        for (const sub of session.subscribers)
            sub(msg);
    }
    setState(session, state, store) {
        session.state = state;
        store.updateSessionState(session.id, state);
        session.lastSeq += 1;
        const msg = {
            seq: session.lastSeq,
            t: 'status',
            sessionId: session.id,
            state,
        };
        session.scrollback.push(msg);
        for (const sub of session.subscribers)
            sub(msg);
    }
    get(id) {
        return this.sessions.get(id);
    }
    list() {
        return Array.from(this.sessions.values());
    }
    // For replay when a session is no longer in memory but exists in DB.
    replayFromDb(sessionId, afterSeq, store) {
        const rows = store.listMessages(sessionId, afterSeq);
        return rows.map((r) => {
            const event = JSON.parse(r.payload);
            return {
                seq: r.seq,
                t: 'event',
                sessionId,
                event,
            };
        });
    }
    // REST mirror of WS `approve`: resolve a pending approval by callId.
    resolveApproval(session, callId, approve) {
        const resolver = session.pendingApprovals.get(callId);
        if (!resolver)
            return false;
        session.pendingApprovals.delete(callId);
        resolver(approve);
        return true;
    }
}
export const sessionManager = new SessionManager();
function extractCommand(ev) {
    if (ev.type !== 'tool_call')
        return null;
    const input = ev.input;
    if (!input)
        return null;
    if (typeof input.command === 'string')
        return input.command;
    if (typeof input.cmd === 'string')
        return input.cmd;
    return null;
}
//# sourceMappingURL=manager.js.map