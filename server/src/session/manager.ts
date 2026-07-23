import { spawn } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { config } from '../config.js';
import type {
  AgentEvent,
  PermissionMode,
  ServerMessage,
  SessionState,
  ToolId,
} from '../protocol.js';
import { isDangerousCommand, nextPermissionMode, PERMISSION_MODES } from '../protocol.js';
import { newId, newSessionId } from '../gateway/auth.js';
import type { Store, SessionRow } from '../store/sqlite.js';
import { getAdapter } from '../adapters/index.js';
import { Scrollback } from './scrollback.js';
import * as checkpoint from '../checkpoint/index.js';
import { PushManager } from '../push/manager.js';
import { terminalManager } from './terminal.js';

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
  currentTurnId: string | null;
  snapshottedTurns: Set<string>;
  approvalMutex: Promise<void>;
  lineBuf: string;
  // true once at least one turn has been spawned. Drives --resume on re-spawn.
  hasRunOnce: boolean;
  // AI tool's own session ID. claude/codebuddy emit session_id in every
  // stream-json message; codex emits thread_id in thread.started. We
  // capture it from stdout via adapter.extractSessionId and persist it
  // to DB so we can --resume <id> on the next turn / after restart.
  externalSessionId: string | null;
  // Current permission mode. The user cycles this via the app (shift+tab
  // equivalent); we pass it to the AI tool via --permission-mode (claude/
  // codebuddy) or --sandbox (codex) on every spawn. claude/codebuddy also
  // echo the effective mode in their system init event — we capture it
  // via adapter.extractPermissionMode and broadcast to the app.
  permissionMode: PermissionMode;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private pushManager: PushManager | null = null;

  setPushManager(pm: PushManager): void {
    this.pushManager = pm;
  }

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
      currentTurnId: null,
      snapshottedTurns: new Set(),
      approvalMutex: Promise.resolve(),
      lineBuf: '',
      hasRunOnce: false,
      externalSessionId: null,
      permissionMode: 'default',
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
      cwd: opts.cwd,
      external_session_id: null,
      has_run_once: 0,
      permission_mode: 'default',
    });

    this.sessions.set(id, session);
    return session;
  }

  /**
   * Spawn (or re-spawn) the AI tool process for this session.
   * First call lets the AI tool generate its own session ID (captured from
   * stdout via adapter.extractSessionId); subsequent calls (process died /
   * server restart) use --resume <captured-id> to pick up the conversation.
   * Returns nothing — the caller writes the user prompt to proc.stdin after.
   */
  private spawnProcess(session: Session, store: Store): void {
    const adapter = getAdapter(session.toolId);
    if (!adapter) throw new Error(`unknown tool: ${session.toolId}`);

    const resume = session.hasRunOnce;
    const sessionIdForTool = session.externalSessionId ?? session.id;
    const { cmd, args, env } = adapter.buildCommand({
      cwd: session.cwd,
      model: session.model,
      sessionId: sessionIdForTool,
      resume,
      permissionMode: session.permissionMode,
    });

    // Verify cwd exists before spawn. Node's spawn reports a missing cwd
    // as "spawn <cmd> ENOENT" — indistinguishable from a missing binary,
    // which makes this a confusing error to debug. Surface a clear message
    // instead. This commonly happens when a session's cwd was a temp dir
    // that got cleaned up (e.g. test scaffolding) or the dir was deleted
    // out from under a long-lived session.
    try {
      const st = statSync(session.cwd);
      if (!st.isDirectory()) {
        this.emitEvent(
          session,
          { type: 'raw', data: `[spawn error] cwd is not a directory: ${session.cwd}\n` },
          store,
        );
        this.setState(session, 'error', store);
        return;
      }
    } catch {
      this.emitEvent(
        session,
        { type: 'raw', data: `[spawn error] working directory no longer exists: ${session.cwd}\nRecreate it, or delete this session and start a new one.\n` },
        store,
      );
      this.setState(session, 'error', store);
      return;
    }

    session.lineBuf = '';
    const proc = spawn(cmd, args, {
      cwd: session.cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    session.proc = proc;
    if (!resume) {
      session.hasRunOnce = true;
      store.markSessionRunOnce(session.id);
    }

    const handleChunk = (chunk: Buffer) => {
      // Buffer partial lines across stdout 'data' events. stdout chunks
      // can split a JSON line at any byte boundary; without buffering,
      // the partial halves fail JSON.parse and get silently dropped.
      session.lineBuf += chunk.toString('utf8');
      const events: AgentEvent[] = [];
      let nl: number;
      while ((nl = session.lineBuf.indexOf('\n')) >= 0) {
        const line = session.lineBuf.slice(0, nl);
        session.lineBuf = session.lineBuf.slice(nl + 1);
        if (!line) continue;
        // Capture the AI tool's session ID from stdout. Each adapter's
        // extractSessionId returns null for non-matching lines, so we
        // keep feeding complete lines until one yields an ID. This works
        // for codex (thread.started), claude (session_id in every msg),
        // and codebuddy (same as claude).
        if (!session.externalSessionId && adapter.extractSessionId) {
          const sid = adapter.extractSessionId(line);
          if (sid) {
            session.externalSessionId = sid;
            store.updateSessionExternalId(session.id, sid);
          }
        }
        // Capture the effective permission mode from the AI tool's init
        // event (claude/codebuddy only). codex has no mode echo, so the
        // session.permissionMode we set from the user's request is the
        // source of truth and gets broadcast by setMode before spawn.
        if (adapter.extractPermissionMode) {
          const m = adapter.extractPermissionMode(line);
          if (m && m !== session.permissionMode) {
            session.permissionMode = m;
            this.broadcastMode(session, store);
          }
        }
        if (adapter.parseJsonLine) {
          events.push(...adapter.parseJsonLine(line));
        } else if (adapter.parseChunk) {
          events.push(...adapter.parseChunk(Buffer.from(line + '\n')));
        } else {
          events.push({ type: 'raw', data: line });
        }
      }
      if (events.length === 0) return;
      // Serialize per-session so approval gates and snapshots stay ordered.
      session.approvalMutex = session.approvalMutex.then(() =>
        this.processEvents(session, events, store, adapter),
      ).catch((err) => {
        this.emitEvent(session, { type: 'raw', data: `[gate error] ${err.message}\n` }, store);
      });
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
      // Process exited. Don't permanently mark the session done — the user
      // can send another message and we'll --resume. idle = "waiting for
      // next input, process not running". Error exit still surfaces.
      this.emitEvent(
        session,
        { type: 'status', state: code === 0 ? 'done' : 'error' },
        store,
      );
      this.setState(session, 'idle', store);
      session.proc = null;
    });
  }

  private async processEvents(
    session: Session,
    events: AgentEvent[],
    store: Store,
    adapter: ReturnType<typeof getAdapter>,
  ): Promise<void> {
    for (const ev of events) {
      // Streaming deltas are transient: broadcast to live subscribers only,
      // no DB row, no seq bump, no scrollback. The final message/thinking
      // event carries the complete text and is persisted normally. This
      // keeps the DB from accumulating one row per text chunk.
      if (ev.type === 'message_delta' || ev.type === 'thinking_delta') {
        const msg: ServerMessage = {
          seq: 0,
          t: 'event',
          sessionId: session.id,
          event: ev,
        };
        for (const sub of session.subscribers) sub(msg);
        continue;
      }
      await this.maybeSnapshot(session, ev, store);
      await this.maybeGateApproval(session, ev, store, adapter);
      this.emitEvent(session, ev, store);

      // Resident model: the process does NOT exit between turns, so proc.close
      // won't fire to reset the state. Drive the turn-completion transition off
      // the tool's own end-of-turn signal (claude `result` / codex
      // `turn.completed` both map to a status event) so the session returns to
      // idle (ready for next input) or surfaces an error.
      if (ev.type === 'status' && this.isResident(adapter) && session.proc) {
        this.setState(session, ev.state === 'error' ? 'error' : 'idle', store);
      }
    }
  }

  private async maybeSnapshot(session: Session, ev: AgentEvent, store: Store): Promise<void> {
    const turnId = session.currentTurnId;
    if (!turnId) return;
    if (session.snapshottedTurns.has(turnId)) return;
    // Snapshot on the first sign of assistant activity in this turn.
    const triggersAssistant =
      ev.type === 'message' || ev.type === 'tool_call' || ev.type === 'thinking';
    if (!triggersAssistant) return;
    try {
      await checkpoint.snapshot(session.cwd, store, session.id, turnId);
      session.snapshottedTurns.add(turnId);
      session.lastSeq += 1;
      const cpMsg: ServerMessage = {
        seq: session.lastSeq,
        t: 'checkpoint',
        sessionId: session.id,
        cpId: turnId,
        kind: 'created',
      };
      session.scrollback.push(cpMsg);
      store.updateSessionLastSeq(session.id, session.lastSeq);
      for (const sub of session.subscribers) sub(cpMsg);
    } catch (err) {
      // Snapshot failure shouldn't break the turn — log and continue.
      this.emitEvent(
        session,
        { type: 'raw', data: `[snapshot error] ${(err as Error).message}\n` },
        store,
      );
    }
  }

  private async maybeGateApproval(
    session: Session,
    ev: AgentEvent,
    store: Store,
    adapter: ReturnType<typeof getAdapter>,
  ): Promise<void> {
    if (ev.type !== 'tool_call') return;
    const cmd = extractCommand(ev);
    if (!cmd) return;
    if (!isDangerousCommand(cmd)) return;
    (ev as { danger?: boolean }).danger = true;

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

    const decision = await new Promise<boolean>((resolve) => {
      session.pendingApprovals.set(ev.id, resolve);
      const timer = setTimeout(() => {
        if (session.pendingApprovals.has(ev.id)) {
          session.pendingApprovals.delete(ev.id);
          resolve(false); // auto-deny on timeout
        }
      }, config.approvalTimeoutMs);
      const orig = session.pendingApprovals.get(ev.id)!;
      session.pendingApprovals.set(ev.id, (ok: boolean) => {
        clearTimeout(timer);
        orig(ok);
      });
    });

    store.decideApproval(approvalId, decision ? 'approved' : 'rejected');
    store.audit(session.id, 'approval_decided', ev.id, JSON.stringify({ decision }));

    // Forward the decision to the AI tool's stdin. In the resident model
    // (M2) stdin stays open across the approval window, so this write now
    // actually reaches the tool and controls its behavior in real time —
    // no longer a silent audit-only record. In one-shot mode the stream may
    // already be closed; the write is a no-op and the DB record stands.
    const stdin = session.proc?.stdin;
    if (stdin && !stdin.destroyed && adapter?.encodeApproval) {
      try {
        stdin.write(adapter.encodeApproval(ev.id, decision));
      } catch {
        // stdin closed — non-fatal
      }
    }
    if (session.state === 'waiting_approval') {
      this.setState(session, 'running', store);
    }
  }

  /** Whether this session should keep its AI-tool process resident across
   *  turns (stdin stays open). Requires the global flag AND an adapter that
   *  speaks a streaming multi-turn stdin protocol (claude/codebuddy). */
  private isResident(adapter: ReturnType<typeof getAdapter>): boolean {
    return config.residentProcess && !!adapter?.supportsResidentStdin;
  }

  input(session: Session, text: string, store: Store): void {
    const adapter = getAdapter(session.toolId);
    if (!adapter) return;
    session.currentTurnId = newId('turn');
    store.audit(session.id, 'input', session.toolId, JSON.stringify({ text, turnId: session.currentTurnId }));
    store.appendMessage({
      id: newId('m'),
      session_id: session.id,
      seq: 0,
      role: 'user',
      type: 'text',
      payload: JSON.stringify({ text }),
      turn_id: session.currentTurnId,
      created_at: Date.now(),
      source: 'app',
      external_turn_ref: null,
    });
    this.setState(session, 'running', store);

    const resident = this.isResident(adapter);
    const alive = !!session.proc && !!session.proc.stdin && !session.proc.stdin.destroyed;

    // Resident model (claude/codebuddy): reuse the live process and just write
    // the next user message to its still-open stdin — no cold start, and the
    // approval gate can write decisions back mid-turn. Spawn only if there is
    // no live process yet (first turn, or after a crash → --resume).
    if (resident && alive) {
      const stdin = session.proc!.stdin!;
      try {
        stdin.write(adapter.encodeInput(text));
        // NOTE: no stdin.end() — the process stays resident for the next turn.
      } catch {
        // Write raced with process exit — respawn and retry once.
        this.spawnProcess(session, store);
        this.writeInitialInput(session, adapter, text, resident);
      }
      return;
    }

    // No live process: spawn (with --resume if this session has run before)
    // then write the first prompt. In one-shot mode (codex, or resident
    // disabled) we close stdin to signal end-of-input for this turn.
    this.spawnProcess(session, store);
    this.writeInitialInput(session, adapter, text, resident);
  }

  private writeInitialInput(
    session: Session,
    adapter: NonNullable<ReturnType<typeof getAdapter>>,
    text: string,
    resident: boolean,
  ): void {
    const stdin = session.proc?.stdin;
    if (!stdin) return;
    try {
      stdin.write(adapter.encodeInput(text));
      // One-shot tools (codex exec) read a single prompt then run to
      // completion on EOF. Resident tools keep stdin open for the next turn.
      if (!resident) stdin.end();
    } catch {
      // stdin closed mid-write — non-fatal, process close will fire.
    }
  }

  interrupt(session: Session): void {
    // SIGINT is the real interrupt. This cancels the current turn; the
    // structured tools exit on SIGINT and the next input() re-spawns with
    // --resume, picking the conversation back up. (The old tmux send-keys
    // path was a no-op in practice — we don't run tools inside tmux.)
    if (session.proc?.pid) {
      try {
        process.kill(session.proc.pid, 'SIGINT');
      } catch {
        // ignore — process may have already exited
      }
    }
  }

  /**
   * Open the interactive pty terminal channel for a session. Kills the
   * structured resident process first so only one process holds the
   * conversation (they share externalSessionId via --resume). Terminal output
   * bytes are broadcast to subscribers as { t:'term' } (transient, not
   * persisted, not seq-tracked). Returns false if the tool has no TUI.
   */
  openTerminal(session: Session, store: Store): boolean {
    const adapter = getAdapter(session.toolId);
    if (!adapter?.buildTerminalCommand) return false;
    const spec = adapter.buildTerminalCommand({
      cwd: session.cwd,
      externalSessionId: session.externalSessionId,
    });
    if (!spec) return false;

    // Single-writer rule: stop the structured process before the TUI resumes
    // the same conversation. It will --resume again on the next input().
    if (session.proc) {
      try { session.proc.kill('SIGINT'); } catch { /* already dead */ }
      session.proc = null;
    }

    terminalManager.open({
      sessionId: session.id,
      cmd: spec.cmd,
      args: spec.args,
      cwd: session.cwd,
      env: spec.env,
      onData: (data) => {
        const msg: ServerMessage = { seq: 0, t: 'term', sessionId: session.id, data };
        for (const sub of session.subscribers) sub(msg);
      },
      onExit: (code) => {
        const msg: ServerMessage = { seq: 0, t: 'term_exit', sessionId: session.id, code };
        for (const sub of session.subscribers) sub(msg);
      },
    });
    store.audit(session.id, 'term_open', session.toolId);
    return true;
  }

  writeTerminal(session: Session, data: string): void {
    terminalManager.write(session.id, data);
  }

  resizeTerminal(session: Session, cols: number, rows: number): void {
    terminalManager.resize(session.id, cols, rows);
  }

  closeTerminal(session: Session, store: Store): void {
    terminalManager.close(session.id);
    store.audit(session.id, 'term_close', session.toolId);
  }

  /** Cycle the permission mode forward (shift+tab equivalent). Takes effect
   *  on the next spawned process — claude/codebuddy re-launch with the new
   *  --permission-mode flag, codex with a new --sandbox value. We broadcast
   *  immediately so the app's mode chip updates; claude/codebuddy's init
   *  event will confirm (or correct) the mode once the next turn starts. */
  cycleMode(session: Session, store: Store): PermissionMode {
    session.permissionMode = nextPermissionMode(session.permissionMode);
    store.updateSessionMode(session.id, session.permissionMode);
    this.broadcastMode(session, store);
    return session.permissionMode;
  }

  /** Set the permission mode directly (vs cycleMode which advances by one).
   * Used when the user picks a specific mode from the menu rather than
   * shift+tab cycling. Validates against the allowed list; invalid values
   * are ignored so a malformed client request can't put the session into
   * an unknown state. */
  setMode(session: Session, mode: PermissionMode, store: Store): PermissionMode {
    if (!PERMISSION_MODES.includes(mode)) return session.permissionMode;
    if (session.permissionMode === mode) return mode;
    session.permissionMode = mode;
    store.updateSessionMode(session.id, mode);
    this.broadcastMode(session, store);
    return mode;
  }

  private broadcastMode(session: Session, store: Store): void {
    const event: AgentEvent = { type: 'mode', mode: session.permissionMode };
    this.emitEvent(session, event, store);
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
    const prev = session.state;
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
    // Fire-and-forget push on transitions that warrant user attention.
    if (prev !== state && this.pushManager) {
      this.maybePush(session, prev, state, store).catch(() => {/* non-fatal */});
    }
  }

  private async maybePush(
    session: Session,
    prev: SessionState,
    state: SessionState,
    store: Store,
  ): Promise<void> {
    if (!this.pushManager) return;
    let title = '';
    let body = '';
    if (state === 'waiting_approval') {
      title = '需要审批';
      body = `${session.projectId}：检测到危险命令`;
    } else if (state === 'done' && prev !== 'done') {
      title = '任务完成';
      body = `${session.projectId}：已完成`;
    } else if (state === 'error' && prev !== 'error') {
      title = '任务出错';
      body = `${session.projectId}：已停止`;
    } else {
      return;
    }
    const devices = store.listDevices();
    for (const d of devices) {
      await this.pushManager.notifyDevice(d.id, {
        title,
        body,
        data: { sessionId: session.id, state },
      });
    }
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** Drop a session from the in-memory cache without touching the DB.
   *  Used to simulate server restart in tests. */
  dropFromCache(id: string): void {
    this.sessions.delete(id);
  }

  /** Permanently delete a session: kill any live process, drop the in-memory
   *  Session, and cascade-delete DB rows for messages/approvals/checkpoints/
   *  audit/preview tokens. The caller (HTTP route) owns the store transaction;
   *  we just tear down live state here. */
  deleteSession(session: Session, store: Store): void {
    if (session.proc) {
      try { session.proc.kill('SIGTERM'); } catch { /* already dead */ }
      session.proc = null;
    }
    // Tear down any live pty terminal channel too, or it leaks.
    terminalManager.close(session.id);
    this.sessions.delete(session.id);
    store.deleteSessionCascade(session.id);
    store.audit(null, 'session_delete', session.id);
  }

  /**
   * Rebuild an in-memory Session from a DB row after server restart.
   * The AI tool process is NOT spawned here — that happens lazily on the
   * next `input()`, which will use --resume <externalSessionId> to pick up
   * the conversation where the tool left off (the tool persists its own
   * session state on disk, e.g. ~/.claude/sessions/).
   */
  rehydrate(row: SessionRow, store: Store): Session {
    const existing = this.sessions.get(row.id);
    if (existing) return existing;
    // Restore the persisted permission mode (default if column is null/empty,
    // e.g. a row created before the migration). This survives server restarts
    // so the user's last mode choice sticks across reboots.
    const persistedMode = (row.permission_mode ?? 'default') as PermissionMode;
    const session: Session = {
      id: row.id,
      projectId: row.project_id,
      toolId: row.tool_id as ToolId,
      model: row.model ?? undefined,
      state: 'idle',
      tmuxName: row.tmux_name,
      cwd: row.cwd ?? config.workspacesDir,
      lastSeq: row.last_seq,
      scrollback: new Scrollback(),
      proc: null,
      pendingApprovals: new Map(),
      subscribers: new Set(),
      currentTurnId: null,
      snapshottedTurns: new Set(),
      approvalMutex: Promise.resolve(),
      lineBuf: '',
      hasRunOnce: row.has_run_once === 1,
      externalSessionId: row.external_session_id,
      permissionMode: persistedMode,
    };
    this.sessions.set(session.id, session);
    void store; // store param kept for future state-persistence hooks
    return session;
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

  // REST mirror of WS `approve`: resolve a pending approval by callId.
  resolveApproval(session: Session, callId: string, approve: boolean): boolean {
    const resolver = session.pendingApprovals.get(callId);
    if (!resolver) return false;
    session.pendingApprovals.delete(callId);
    resolver(approve);
    return true;
  }
}

export const sessionManager = new SessionManager();

function extractCommand(ev: AgentEvent): string | null {
  if (ev.type !== 'tool_call') return null;
  const input = ev.input as { command?: string; cmd?: string } | undefined;
  if (!input) return null;
  if (typeof input.command === 'string') return input.command;
  if (typeof input.cmd === 'string') return input.cmd;
  return null;
}
