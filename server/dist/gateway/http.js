import Fastify from 'fastify';
import { config, dbPath } from '../config.js';
import { Store } from '../store/sqlite.js';
import { authenticate, bearerOf, generatePairCode, newDeviceId, signDeviceToken, } from './auth.js';
import { detectAllTools } from '../adapters/index.js';
import { sessionManager } from '../session/manager.js';
import * as checkpoint from '../checkpoint/index.js';
import { z } from 'zod';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, relative, isAbsolute } from 'node:path';
import { previewManager } from '../preview/manager.js';
const pairSchema = z.object({
    code: z.string().regex(/^\d{6}$/),
    name: z.string().optional(),
});
const createSessionSchema = z.object({
    projectId: z.string().min(1),
    toolId: z.enum(['claude-code', 'codex']),
    model: z.string().optional(),
    cwd: z.string().optional(),
});
export async function buildHttpServer() {
    const store = new Store(dbPath);
    const app = Fastify({ logger: { level: 'info' } });
    await app.register(import('@fastify/cors'), {
        origin: true,
        credentials: true,
    });
    // ---------- pairing ----------
    app.post('/api/pair/code', async (req, reply) => {
        const ip = req.ip;
        const recentFails = store.countRecentPairFailures(ip, Date.now() - config.pairFailWindowMs);
        if (recentFails >= config.pairFailMax) {
            store.audit(null, 'pair_fail', ip, JSON.stringify({ reason: 'rate_limited' }));
            return reply.code(429).send({ error: 'too_many_attempts', retryAfterMs: config.pairFailLockMs });
        }
        const code = generatePairCode();
        store.createPairCode(code, config.pairTtlMs, ip);
        store.audit(null, 'pair_code_issued', ip, JSON.stringify({ code }));
        return { code, expiresAt: Date.now() + config.pairTtlMs };
    });
    app.post('/api/pair', async (req, reply) => {
        const parsed = pairSchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'bad_request' });
        const { code, name } = parsed.data;
        const ip = req.ip;
        const row = store.getPairCode(code);
        if (!row || row.used || row.expires_at < Date.now()) {
            store.audit(null, 'pair_fail', ip, JSON.stringify({ code, reason: 'invalid_or_expired' }));
            return reply.code(401).send({ error: 'invalid_code' });
        }
        store.markPairCodeUsed(code);
        const deviceId = newDeviceId();
        const now = Date.now();
        store.createDevice({
            id: deviceId,
            name: name || `device-${deviceId.slice(0, 6)}`,
            public_key: '-',
            paired_at: now,
            last_seen_at: now,
        });
        store.audit(null, 'pair_success', ip, JSON.stringify({ deviceId }));
        const { token, expiresAt } = await signDeviceToken(deviceId);
        return { token, expiresAt, deviceId };
    });
    // ---------- auth guard ----------
    app.addHook('onRequest', async (req, reply) => {
        const open = ['/api/pair/code', '/api/pair', '/api/health'];
        if (open.includes(req.routerPath || ''))
            return;
        // Preview proxy uses token-in-path, not Bearer JWT.
        if ((req.routerPath || '').startsWith('/preview/'))
            return;
        const auth = await authenticate(bearerOf(req.headers.authorization), store);
        if (!auth)
            return reply.code(401).send({ error: 'unauthorized' });
        req.deviceId = auth.deviceId;
    });
    app.get('/api/health', async () => ({ ok: true, ts: Date.now() }));
    app.get('/api/hosts/tools', async () => {
        return { tools: await detectAllTools() };
    });
    app.get('/api/sessions', async () => {
        const rows = store.listSessions();
        const out = rows.map((r) => {
            const inMem = sessionManager.get(r.id);
            const lastMsg = store.listMessages(r.id, Math.max(0, r.last_seq - 1)).slice(-1)[0];
            return {
                id: r.id,
                projectId: r.project_id,
                toolId: r.tool_id,
                model: r.model ?? undefined,
                state: inMem?.state ?? r.state,
                lastSeq: r.last_seq,
                createdAt: r.created_at,
                lastMessage: lastMsg ? JSON.parse(lastMsg.payload).text : undefined,
            };
        });
        return { sessions: out };
    });
    app.post('/api/sessions', async (req, reply) => {
        const parsed = createSessionSchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'bad_request', details: parsed.error.flatten() });
        const { projectId, toolId, model, cwd } = parsed.data;
        const finalCwd = cwd || config.workspacesDir;
        const session = await sessionManager.create({ projectId, toolId, model, cwd: finalCwd, store });
        await sessionManager.start(session, store);
        return {
            id: session.id,
            projectId: session.projectId,
            toolId: session.toolId,
            model: session.model,
            state: session.state,
            lastSeq: session.lastSeq,
        };
    });
    app.get('/api/sessions/:id/messages', async (req, reply) => {
        const { id } = req.params;
        const afterSeq = Number(req.query.after ?? -1);
        const rows = store.listMessages(id, afterSeq);
        return {
            messages: rows.map((r) => ({
                id: r.id,
                sessionId: r.session_id,
                seq: r.seq,
                role: r.role,
                type: r.type,
                payload: JSON.parse(r.payload),
                turnId: r.turn_id ?? undefined,
                createdAt: r.created_at,
            })),
        };
    });
    app.post('/api/sessions/:id/interrupt', async (req) => {
        const { id } = req.params;
        const s = sessionManager.get(id);
        if (!s)
            return { error: 'not_found' };
        sessionManager.interrupt(s);
        store.audit(id, 'interrupt', s.toolId);
        return { ok: true };
    });
    // ---------- checkpoints / diff / approval ----------
    app.get('/api/sessions/:id/checkpoints', async (req) => {
        const { id } = req.params;
        const rows = store.listCheckpoints(id);
        return {
            checkpoints: rows.map((r) => ({
                id: r.id,
                sessionId: r.session_id,
                turnId: r.turn_id,
                status: r.status,
                shadowCommit: r.shadow_commit,
                files: JSON.parse(r.files || '[]'),
                createdAt: r.created_at,
            })),
        };
    });
    app.get('/api/sessions/:id/diff/:cpId?', async (req, reply) => {
        const { id, cpId } = req.params;
        const files = req.query?.files;
        const fileList = files ? files.split(',').filter(Boolean) : undefined;
        const s = sessionManager.get(id);
        if (!s)
            return reply.code(404).send({ error: 'session_not_in_memory' });
        try {
            const diff = await checkpoint.computeDiff(s.cwd, store, id, cpId, fileList);
            return { diff };
        }
        catch (err) {
            return reply.code(500).send({ error: 'diff_failed', message: err.message });
        }
    });
    app.post('/api/sessions/:id/accept/:cpId', async (req, reply) => {
        const { id, cpId } = req.params;
        const body = req.body ?? {};
        const s = sessionManager.get(id);
        if (!s)
            return reply.code(404).send({ error: 'session_not_in_memory' });
        try {
            await checkpoint.accept(s.cwd, store, id, cpId, body.files);
            store.audit(id, 'accept', cpId, JSON.stringify({ files: body.files }));
            return { ok: true };
        }
        catch (err) {
            return reply.code(400).send({ error: 'accept_failed', message: err.message });
        }
    });
    app.post('/api/sessions/:id/rollback/:cpId', async (req, reply) => {
        const { id, cpId } = req.params;
        const s = sessionManager.get(id);
        if (!s)
            return reply.code(404).send({ error: 'session_not_in_memory' });
        try {
            await checkpoint.rollback(s.cwd, store, id, cpId);
            store.audit(id, 'rollback', cpId);
            return { ok: true };
        }
        catch (err) {
            return reply.code(400).send({ error: 'rollback_failed', message: err.message });
        }
    });
    const approveSchema = z.object({ approve: z.boolean() });
    app.post('/api/sessions/:id/approve/:callId', async (req, reply) => {
        const parsed = approveSchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'bad_request' });
        const { id, callId } = req.params;
        const s = sessionManager.get(id);
        if (!s)
            return reply.code(404).send({ error: 'session_not_in_memory' });
        const ok = sessionManager.resolveApproval(s, callId, parsed.data.approve);
        if (!ok)
            return reply.code(404).send({ error: 'no_pending_approval' });
        store.audit(id, 'approve_rest', callId, JSON.stringify({ approve: parsed.data.approve }));
        return { ok: true };
    });
    app.get('/api/sessions/:id/approvals', async (req) => {
        const { id } = req.params;
        return { approvals: store.listApprovals(id) };
    });
    // ---------- files (read-only, confined to cwd) ----------
    app.get('/api/sessions/:id/files', async (req, reply) => {
        const { id } = req.params;
        const rel = req.query?.path ?? '';
        const s = sessionManager.get(id);
        if (!s)
            return reply.code(404).send({ error: 'session_not_in_memory' });
        const abs = safeJoin(s.cwd, rel);
        if (!abs)
            return reply.code(400).send({ error: 'invalid_path' });
        try {
            const stats = statSync(abs);
            if (!stats.isDirectory())
                return reply.code(400).send({ error: 'not_a_directory' });
            const entries = readdirSync(abs, { withFileTypes: true })
                .filter((e) => e.name !== '.pocket' && !e.name.startsWith('.git'))
                .map((e) => {
                const childPath = join(rel, e.name);
                try {
                    const st = statSync(join(abs, e.name));
                    return { name: e.name, path: childPath, dir: e.isDirectory(), size: st.size };
                }
                catch {
                    return { name: e.name, path: childPath, dir: e.isDirectory(), size: 0 };
                }
            })
                .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
            return { entries, cwd: s.cwd, path: rel };
        }
        catch (err) {
            return reply.code(500).send({ error: 'files_failed', message: err.message });
        }
    });
    app.get('/api/sessions/:id/files/content', async (req, reply) => {
        const { id } = req.params;
        const rel = req.query?.path ?? '';
        const s = sessionManager.get(id);
        if (!s)
            return reply.code(404).send({ error: 'session_not_in_memory' });
        const abs = safeJoin(s.cwd, rel);
        if (!abs)
            return reply.code(400).send({ error: 'invalid_path' });
        try {
            const stats = statSync(abs);
            if (stats.isDirectory())
                return reply.code(400).send({ error: 'is_directory' });
            if (stats.size > 512 * 1024)
                return reply.code(413).send({ error: 'file_too_large' });
            const buf = readFileSync(abs);
            return { content: buf.toString('utf8'), size: stats.size, path: rel };
        }
        catch (err) {
            return reply.code(500).send({ error: 'read_failed', message: err.message });
        }
    });
    // ---------- preview ----------
    app.post('/api/sessions/:id/preview/start', async (req, reply) => {
        const { id } = req.params;
        const s = sessionManager.get(id);
        if (!s)
            return reply.code(404).send({ error: 'session_not_in_memory' });
        try {
            const res = previewManager.start({ sessionId: id, cwd: s.cwd, store });
            store.audit(id, 'preview_start', res.token);
            return res;
        }
        catch (err) {
            return reply.code(400).send({ error: 'preview_start_failed', message: err.message });
        }
    });
    app.post('/api/sessions/:id/preview/stop', async (req) => {
        const { id } = req.params;
        const h = previewManager.getBySession(id);
        if (!h)
            return { ok: false, error: 'no_preview' };
        previewManager.stop(h.token, store);
        store.audit(id, 'preview_stop', h.token);
        return { ok: true };
    });
    app.get('/api/sessions/:id/preview/status', async (req) => {
        const { id } = req.params;
        const h = previewManager.getBySession(id);
        if (!h)
            return { state: 'stopped', token: null, port: null };
        return {
            state: h.state,
            token: h.token,
            port: h.port,
            url: h.port ? `/preview/${h.token}/` : null,
            startedAt: h.startedAt,
        };
    });
    app.get('/api/sessions/:id/preview/logs', async (req) => {
        const { id } = req.params;
        const tail = Number(req.query.tail || 200);
        const h = previewManager.getBySession(id);
        if (!h)
            return { logs: '' };
        return { logs: previewManager.logs(h.token, tail) };
    });
    return app;
}
/// Resolve a user-supplied relative path against the session cwd, refusing
/// anything that escapes the cwd (.. traversal, absolute paths).
function safeJoin(cwd, rel) {
    const trimmed = rel.trim();
    if (isAbsolute(trimmed))
        return null;
    const abs = normalize(join(cwd, trimmed));
    const rel0 = relative(cwd, abs);
    if (rel0.startsWith('..') || isAbsolute(rel0))
        return null;
    return abs;
}
//# sourceMappingURL=http.js.map