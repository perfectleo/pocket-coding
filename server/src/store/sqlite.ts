import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DeviceRow {
  id: string;
  name: string;
  public_key: string;
  paired_at: number;
  last_seen_at: number;
}

export interface PairCodeRow {
  code: string;
  created_at: number;
  expires_at: number;
  used: number;
  ip: string | null;
}

export interface SessionRow {
  id: string;
  project_id: string;
  tool_id: string;
  model: string | null;
  state: string;
  tmux_name: string;
  last_seq: number;
  baseline_ref: string | null;
  created_at: number;
  // Added by migration — nullable for rows created before the column existed.
  cwd: string | null;
  external_session_id: string | null;
  has_run_once: number;
  permission_mode: string | null;
}

export interface MessageRow {
  id: string;
  session_id: string;
  seq: number;
  role: string;
  type: string;
  payload: string;
  turn_id: string | null;
  created_at: number;
}

export interface ApprovalRow {
  id: string;
  session_id: string;
  call_id: string;
  command: string;
  decision: string | null;
  decided_at: number | null;
  created_at: number;
}

export interface CheckpointRow {
  id: string;
  session_id: string;
  turn_id: string;
  shadow_commit: string;
  status: string;
  files: string;
  created_at: number;
}

export interface AuditRow {
  id: number;
  session_id: string | null;
  action: string;
  target: string;
  meta: string;
  at: number;
}

export class Store {
  private db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  /** Expose the raw DB handle for tests / migrations. Production code should
   *  use the typed methods above rather than touching this directly. */
  get rawDb(): Database.Database {
    return this.db;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        public_key TEXT NOT NULL,
        paired_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pair_codes (
        code TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        ip TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        tool_id TEXT NOT NULL,
        model TEXT,
        state TEXT NOT NULL,
        tmux_name TEXT NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0,
        baseline_ref TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        turn_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        command TEXT NOT NULL,
        decision TEXT,
        decided_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        shadow_commit TEXT NOT NULL,
        status TEXT NOT NULL,
        files TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id, created_at);
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        meta TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS preview_tokens (
        token TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        dev_port INTEGER,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS push_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        token TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(device_id, platform, token)
      );
      CREATE INDEX IF NOT EXISTS idx_push_tokens_device ON push_tokens(device_id);
    `);
    // Idempotent column adds — CREATE TABLE IF NOT EXISTS won't add columns
    // to an existing table, so old databases need ALTER for new fields.
    this.ensureColumn('sessions', 'cwd', 'TEXT');
    this.ensureColumn('sessions', 'external_session_id', 'TEXT');
    this.ensureColumn('sessions', 'has_run_once', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('sessions', 'permission_mode', "TEXT NOT NULL DEFAULT 'default'");
  }

  private ensureColumn(table: string, col: string, def: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === col)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    }
  }

  // ---------- pair codes ----------
  createPairCode(code: string, ttlMs: number, ip: string | null): void {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO pair_codes (code, created_at, expires_at, used, ip) VALUES (?,?,?,?,?)`,
    ).run(code, now, now + ttlMs, 0, ip);
  }
  getPairCode(code: string): PairCodeRow | undefined {
    return this.db.prepare(`SELECT * FROM pair_codes WHERE code = ?`).get(code) as
      | PairCodeRow
      | undefined;
  }
  markPairCodeUsed(code: string): void {
    this.db.prepare(`UPDATE pair_codes SET used = 1 WHERE code = ?`).run(code);
  }
  countRecentPairFailures(ip: string, sinceMs: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as n FROM audit WHERE action = 'pair_fail' AND target = ? AND at > ?`,
      )
      .get(ip, sinceMs) as { n: number };
    return row.n;
  }

  // ---------- devices ----------
  createDevice(d: DeviceRow): void {
    this.db
      .prepare(
        `INSERT INTO devices (id, name, public_key, paired_at, last_seen_at) VALUES (?,?,?,?,?)`,
      )
      .run(d.id, d.name, d.public_key, d.paired_at, d.last_seen_at);
  }
  getDevice(id: string): DeviceRow | undefined {
    return this.db.prepare(`SELECT * FROM devices WHERE id = ?`).get(id) as
      | DeviceRow
      | undefined;
  }
  listDevices(): DeviceRow[] {
    return this.db.prepare(`SELECT * FROM devices ORDER BY paired_at DESC`).all() as DeviceRow[];
  }
  touchDevice(id: string): void {
    this.db.prepare(`UPDATE devices SET last_seen_at = ? WHERE id = ?`).run(Date.now(), id);
  }

  // ---------- sessions ----------
  createSession(s: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, project_id, tool_id, model, state, tmux_name, last_seq, baseline_ref, created_at, cwd, external_session_id, has_run_once, permission_mode)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        s.id,
        s.project_id,
        s.tool_id,
        s.model,
        s.state,
        s.tmux_name,
        s.last_seq,
        s.baseline_ref,
        s.created_at,
        s.cwd,
        s.external_session_id,
        s.has_run_once,
        s.permission_mode ?? 'default',
      );
  }
  getSession(id: string): SessionRow | undefined {
    return this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as
      | SessionRow
      | undefined;
  }
  listSessions(): SessionRow[] {
    return this.db
      .prepare(`SELECT * FROM sessions ORDER BY created_at DESC`)
      .all() as SessionRow[];
  }
  updateSessionState(id: string, state: string): void {
    this.db.prepare(`UPDATE sessions SET state = ? WHERE id = ?`).run(state, id);
  }
  updateSessionLastSeq(id: string, seq: number): void {
    this.db.prepare(`UPDATE sessions SET last_seq = ? WHERE id = ?`).run(seq, id);
  }
  updateSessionBaseline(id: string, ref: string): void {
    this.db.prepare(`UPDATE sessions SET baseline_ref = ? WHERE id = ?`).run(ref, id);
  }
  updateSessionExternalId(id: string, externalId: string): void {
    this.db.prepare(`UPDATE sessions SET external_session_id = ? WHERE id = ?`).run(externalId, id);
  }
  markSessionRunOnce(id: string): void {
    this.db.prepare(`UPDATE sessions SET has_run_once = 1 WHERE id = ?`).run(id);
  }
  updateSessionMode(id: string, mode: string): void {
    this.db.prepare(`UPDATE sessions SET permission_mode = ? WHERE id = ?`).run(mode, id);
  }
  deleteSessionCascade(sessionId: string): void {
    // Order: child rows first, then the session row itself. Use a transaction
    // so a partial delete doesn't leave the DB in a half-state.
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId);
      this.db.prepare(`DELETE FROM approvals WHERE session_id = ?`).run(sessionId);
      this.db.prepare(`DELETE FROM checkpoints WHERE session_id = ?`).run(sessionId);
      this.db.prepare(`DELETE FROM audit WHERE session_id = ?`).run(sessionId);
      this.db.prepare(`DELETE FROM preview_tokens WHERE session_id = ?`).run(sessionId);
      this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
    })();
  }

  // ---------- messages ----------
  appendMessage(m: MessageRow): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, seq, role, type, payload, turn_id, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(m.id, m.session_id, m.seq, m.role, m.type, m.payload, m.turn_id, m.created_at);
  }
  listMessages(sessionId: string, afterSeq = -1): MessageRow[] {
    return this.db
      .prepare(
        `SELECT * FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq ASC`,
      )
      .all(sessionId, afterSeq) as MessageRow[];
  }

  // ---------- approvals ----------
  createApproval(a: ApprovalRow): void {
    this.db
      .prepare(
        `INSERT INTO approvals (id, session_id, call_id, command, decision, decided_at, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(a.id, a.session_id, a.call_id, a.command, a.decision, a.decided_at, a.created_at);
  }
  pendingApproval(sessionId: string, callId: string): ApprovalRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM approvals WHERE session_id = ? AND call_id = ? AND decision IS NULL`,
      )
      .get(sessionId, callId) as ApprovalRow | undefined;
  }
  decideApproval(id: string, decision: string): void {
    this.db
      .prepare(`UPDATE approvals SET decision = ?, decided_at = ? WHERE id = ?`)
      .run(decision, Date.now(), id);
  }

  // ---------- checkpoints ----------
  createCheckpoint(c: CheckpointRow): void {
    this.db
      .prepare(
        `INSERT INTO checkpoints (id, session_id, turn_id, shadow_commit, status, files, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(c.id, c.session_id, c.turn_id, c.shadow_commit, c.status, c.files, c.created_at);
  }
  listCheckpoints(sessionId: string): CheckpointRow[] {
    return this.db
      .prepare(
        `SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at ASC`,
      )
      .all(sessionId) as CheckpointRow[];
  }
  getCheckpoint(id: string): CheckpointRow | undefined {
    return this.db.prepare(`SELECT * FROM checkpoints WHERE id = ?`).get(id) as
      | CheckpointRow
      | undefined;
  }
  updateCheckpointStatus(id: string, status: string): void {
    this.db.prepare(`UPDATE checkpoints SET status = ? WHERE id = ?`).run(status, id);
  }
  getApproval(id: string): ApprovalRow | undefined {
    return this.db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id) as
      | ApprovalRow
      | undefined;
  }
  listApprovals(sessionId: string): ApprovalRow[] {
    return this.db
      .prepare(`SELECT * FROM approvals WHERE session_id = ? ORDER BY created_at ASC`)
      .all(sessionId) as ApprovalRow[];
  }

  // ---------- audit ----------
  audit(sessionId: string | null, action: string, target: string, meta = '{}'): void {
    this.db
      .prepare(`INSERT INTO audit (session_id, action, target, meta, at) VALUES (?,?,?,?,?)`)
      .run(sessionId, action, target, meta, Date.now());
  }

  // ---------- preview tokens ----------
  createPreviewToken(token: string, sessionId: string): void {
    this.db
      .prepare(
        `INSERT INTO preview_tokens (token, session_id, state, created_at) VALUES (?,?,?,?)`,
      )
      .run(token, sessionId, 'starting', Date.now());
  }
  getPreviewToken(token: string) {
    return this.db
      .prepare(`SELECT * FROM preview_tokens WHERE token = ? AND revoked_at IS NULL`)
      .get(token) as
      | { token: string; session_id: string; dev_port: number | null; state: string; created_at: number }
      | undefined;
  }
  setPreviewDevPort(token: string, port: number): void {
    this.db
      .prepare(`UPDATE preview_tokens SET dev_port = ?, state = 'ready' WHERE token = ?`)
      .run(port, token);
  }
  revokePreviewToken(token: string): void {
    this.db.prepare(`UPDATE preview_tokens SET revoked_at = ? WHERE token = ?`).run(Date.now(), token);
  }

  // ---------- push tokens ----------
  registerPushToken(deviceId: string, platform: 'ios' | 'android', token: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO push_tokens (device_id, platform, token, created_at) VALUES (?,?,?,?)`,
      )
      .run(deviceId, platform, token, Date.now());
  }
  unregisterPushToken(deviceId: string, token: string): void {
    this.db
      .prepare(`DELETE FROM push_tokens WHERE device_id = ? AND token = ?`)
      .run(deviceId, token);
  }
  listPushTokens(deviceId: string): Array<{ platform: string; token: string }> {
    return this.db
      .prepare(`SELECT platform, token FROM push_tokens WHERE device_id = ?`)
      .all(deviceId) as Array<{ platform: string; token: string }>;
  }

  close(): void {
    this.db.close();
  }
}
