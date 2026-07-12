import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export class Store {
    db;
    constructor(path) {
        mkdirSync(dirname(path), { recursive: true });
        this.db = new Database(path);
        this.db.pragma('journal_mode = WAL');
        this.migrate();
    }
    migrate() {
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
    `);
    }
    // ---------- pair codes ----------
    createPairCode(code, ttlMs, ip) {
        const now = Date.now();
        this.db.prepare(`INSERT INTO pair_codes (code, created_at, expires_at, used, ip) VALUES (?,?,?,?,?)`).run(code, now, now + ttlMs, 0, ip);
    }
    getPairCode(code) {
        return this.db.prepare(`SELECT * FROM pair_codes WHERE code = ?`).get(code);
    }
    markPairCodeUsed(code) {
        this.db.prepare(`UPDATE pair_codes SET used = 1 WHERE code = ?`).run(code);
    }
    countRecentPairFailures(ip, sinceMs) {
        const row = this.db
            .prepare(`SELECT COUNT(*) as n FROM audit WHERE action = 'pair_fail' AND target = ? AND at > ?`)
            .get(ip, sinceMs);
        return row.n;
    }
    // ---------- devices ----------
    createDevice(d) {
        this.db
            .prepare(`INSERT INTO devices (id, name, public_key, paired_at, last_seen_at) VALUES (?,?,?,?,?)`)
            .run(d.id, d.name, d.public_key, d.paired_at, d.last_seen_at);
    }
    getDevice(id) {
        return this.db.prepare(`SELECT * FROM devices WHERE id = ?`).get(id);
    }
    touchDevice(id) {
        this.db.prepare(`UPDATE devices SET last_seen_at = ? WHERE id = ?`).run(Date.now(), id);
    }
    // ---------- sessions ----------
    createSession(s) {
        this.db
            .prepare(`INSERT INTO sessions (id, project_id, tool_id, model, state, tmux_name, last_seq, baseline_ref, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`)
            .run(s.id, s.project_id, s.tool_id, s.model, s.state, s.tmux_name, s.last_seq, s.baseline_ref, s.created_at);
    }
    getSession(id) {
        return this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id);
    }
    listSessions() {
        return this.db
            .prepare(`SELECT * FROM sessions ORDER BY created_at DESC`)
            .all();
    }
    updateSessionState(id, state) {
        this.db.prepare(`UPDATE sessions SET state = ? WHERE id = ?`).run(state, id);
    }
    updateSessionLastSeq(id, seq) {
        this.db.prepare(`UPDATE sessions SET last_seq = ? WHERE id = ?`).run(seq, id);
    }
    updateSessionBaseline(id, ref) {
        this.db.prepare(`UPDATE sessions SET baseline_ref = ? WHERE id = ?`).run(ref, id);
    }
    // ---------- messages ----------
    appendMessage(m) {
        this.db
            .prepare(`INSERT INTO messages (id, session_id, seq, role, type, payload, turn_id, created_at)
         VALUES (?,?,?,?,?,?,?,?)`)
            .run(m.id, m.session_id, m.seq, m.role, m.type, m.payload, m.turn_id, m.created_at);
    }
    listMessages(sessionId, afterSeq = -1) {
        return this.db
            .prepare(`SELECT * FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq ASC`)
            .all(sessionId, afterSeq);
    }
    // ---------- approvals ----------
    createApproval(a) {
        this.db
            .prepare(`INSERT INTO approvals (id, session_id, call_id, command, decision, decided_at, created_at)
         VALUES (?,?,?,?,?,?,?)`)
            .run(a.id, a.session_id, a.call_id, a.command, a.decision, a.decided_at, a.created_at);
    }
    pendingApproval(sessionId, callId) {
        return this.db
            .prepare(`SELECT * FROM approvals WHERE session_id = ? AND call_id = ? AND decision IS NULL`)
            .get(sessionId, callId);
    }
    decideApproval(id, decision) {
        this.db
            .prepare(`UPDATE approvals SET decision = ?, decided_at = ? WHERE id = ?`)
            .run(decision, Date.now(), id);
    }
    // ---------- checkpoints ----------
    createCheckpoint(c) {
        this.db
            .prepare(`INSERT INTO checkpoints (id, session_id, turn_id, shadow_commit, status, files, created_at)
         VALUES (?,?,?,?,?,?,?)`)
            .run(c.id, c.session_id, c.turn_id, c.shadow_commit, c.status, c.files, c.created_at);
    }
    listCheckpoints(sessionId) {
        return this.db
            .prepare(`SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at ASC`)
            .all(sessionId);
    }
    getCheckpoint(id) {
        return this.db.prepare(`SELECT * FROM checkpoints WHERE id = ?`).get(id);
    }
    updateCheckpointStatus(id, status) {
        this.db.prepare(`UPDATE checkpoints SET status = ? WHERE id = ?`).run(status, id);
    }
    getApproval(id) {
        return this.db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id);
    }
    listApprovals(sessionId) {
        return this.db
            .prepare(`SELECT * FROM approvals WHERE session_id = ? ORDER BY created_at ASC`)
            .all(sessionId);
    }
    // ---------- audit ----------
    audit(sessionId, action, target, meta = '{}') {
        this.db
            .prepare(`INSERT INTO audit (session_id, action, target, meta, at) VALUES (?,?,?,?,?)`)
            .run(sessionId, action, target, meta, Date.now());
    }
    // ---------- preview tokens ----------
    createPreviewToken(token, sessionId) {
        this.db
            .prepare(`INSERT INTO preview_tokens (token, session_id, state, created_at) VALUES (?,?,?,?)`)
            .run(token, sessionId, 'starting', Date.now());
    }
    getPreviewToken(token) {
        return this.db
            .prepare(`SELECT * FROM preview_tokens WHERE token = ? AND revoked_at IS NULL`)
            .get(token);
    }
    setPreviewDevPort(token, port) {
        this.db
            .prepare(`UPDATE preview_tokens SET dev_port = ?, state = 'ready' WHERE token = ?`)
            .run(port, token);
    }
    revokePreviewToken(token) {
        this.db.prepare(`UPDATE preview_tokens SET revoked_at = ? WHERE token = ?`).run(Date.now(), token);
    }
    close() {
        this.db.close();
    }
}
//# sourceMappingURL=sqlite.js.map