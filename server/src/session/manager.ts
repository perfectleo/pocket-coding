import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import type {
  AgentEvent,
  ServerMessage,
  SessionState,
  ToolId,
} from '../protocol.js';
import { newId, newSessionId } from '../gateway/auth.js';
import type { Store } from '../store/sqlite.js';
import { getAdapter } from '../adapters/index.js';
import { Scrollback } from './scrollback.js';

export interface Session {
  id: string;
  projectId: string;
  toolId: ToolId;
  model?: string;
  state: SessionState;
  tmuxName: string;
  cwd: string;
  lastSeq: number;
  scrollback: Scrollback;
  proc: import('node:child_process').ChildProcess | null;
  pendingApprovals: Map<string, (approve: boolean) => void>;
  subscribers: Set<(msg: ServerMessage) => void>;
}

class SessionManager {
  private sessions = new Map<string, Session>();

  async create(opts: {
    projectId: string;
    toolId: ToolId;
    model?: string;
    cwd: string;
    store: Store;
  }): Promise<Session> {
    const id = newSessionId();
    const tmuxName = `pocket-${id}`;
    const adapter = getAdapter(opts.toolId);
    if (!adapter) throw new Error(`unknown tool: ${opts.toolId}`);

    mkdirSync(opts.cwd, { recursive: true });

    const session: Session = {
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

  async start(session: Session, store: Store): Promise<void> {
    const adapter = getAdapter(session.toolId);
    if (!adapter) throw new Error(`unknown tool: ${session.toolId}`);

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

    const handleChunk = (chunk: Buffer) => {
      let events: AgentEvent[] = [];
      if (adapter.parseChunk) {
        events = adapter.parseChunk(chunk);
      } else {
        events = [{ type: 'raw', data: chunk.toString('utf8') }];
      }
      for (const ev of events) {
        this.emitEvent(session, ev, store);
      }
    };

    proc.stdout?.on('data', handleChunk);
    proc.stderr?.on('data', (chunk: Buffer) => {
      // stderr as raw for pty mode or as raw error context
      this.emitEvent(session, { type: 'raw', data: chunk.toString('utf8') }, store);
    });

    proc.on('error', (err) => {
      this.emitEvent(
        session,
        { type: 'raw', data: `[spawn error] ${err.message}\n` },
        store,
      );
      this.setState(session, 'error', store);
    });

    proc.on('close', (code) => {
      this.emitEvent(
        session,
        { type: 'status', state: code === 0 ? 'done' : 'error' },
        store,
      );
      this.setState(session, code === 0 ? 'done' : 'error', store);
      session.proc = null;
    });
  }

  input(session: Session, text: string, store: Store): void {
    const adapter = getAdapter(session.toolId);
    if (!adapter || !session.proc?.stdin) return;
    store.audit(session.id, 'input', session.toolId, JSON.stringify({ text }));
    const buf = adapter.encodeInput(text);
    session.proc.stdin.write(buf);
    store.appendMessage({
      id: newId('m'),
      session_id: session.id,
      seq: 0,
      role: 'user',
      type: 'text',
      payload: JSON.stringify({ text }),
      turn_id: null,
      created_at: Date.now(),
    });
  }

  interrupt(session: Session): void {
    const adapter = getAdapter(session.toolId);
    adapter?.interrupt({ tmuxName: session.tmuxName });
    if (session.proc?.pid) {
      try {
        process.kill(session.proc.pid, 'SIGINT');
      } catch {
        // ignore
      }
    }
  }

  attach(session: Session, lastSeq: number, cb: (msg: ServerMessage) => void): ServerMessage[] {
    session.subscribers.add(cb);
    return session.scrollback.after(lastSeq);
  }

  detach(session: Session, cb: (msg: ServerMessage) => void): void {
    session.subscribers.delete(cb);
  }

  private emitEvent(session: Session, event: AgentEvent, store: Store): void {
    session.lastSeq += 1;
    const seq = session.lastSeq;
    const msg: ServerMessage = { seq, t: 'event', sessionId: session.id, event };
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
    for (const sub of session.subscribers) sub(msg);
  }

  setState(session: Session, state: SessionState, store: Store): void {
    session.state = state;
    store.updateSessionState(session.id, state);
    session.lastSeq += 1;
    const msg: ServerMessage = {
      seq: session.lastSeq,
      t: 'status',
      sessionId: session.id,
      state,
    };
    session.scrollback.push(msg);
    for (const sub of session.subscribers) sub(msg);
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return Array.from(this.sessions.values());
  }

  // For replay when a session is no longer in memory but exists in DB.
  replayFromDb(sessionId: string, afterSeq: number, store: Store): ServerMessage[] {
    const rows = store.listMessages(sessionId, afterSeq);
    return rows.map((r) => {
      const event = JSON.parse(r.payload) as AgentEvent;
      return {
        seq: r.seq,
        t: 'event',
        sessionId,
        event,
      } as ServerMessage;
    });
  }
}

export const sessionManager = new SessionManager();
