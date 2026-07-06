import Fastify, { type FastifyInstance } from 'fastify';
import { config, dbPath } from '../config.js';
import { Store } from '../store/sqlite.js';
import {
  authenticate,
  bearerOf,
  generatePairCode,
  newDeviceId,
  signDeviceToken,
} from './auth.js';
import { detectAllTools } from '../adapters/index.js';
import { sessionManager } from '../session/manager.js';
import { z } from 'zod';
import { newId } from './auth.js';

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

export async function buildHttpServer(): Promise<FastifyInstance> {
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
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });
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
    if (open.includes(req.routerPath || '')) return;
    const auth = await authenticate(bearerOf(req.headers.authorization), store);
    if (!auth) return reply.code(401).send({ error: 'unauthorized' });
    (req as unknown as { deviceId: string }).deviceId = auth.deviceId;
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
        state: inMem?.state ?? (r.state as 'created' | 'running' | 'waiting_approval' | 'done' | 'error'),
        lastSeq: r.last_seq,
        createdAt: r.created_at,
        lastMessage: lastMsg ? (JSON.parse(lastMsg.payload) as { text?: string }).text : undefined,
      };
    });
    return { sessions: out };
  });

  app.post('/api/sessions', async (req, reply) => {
    const parsed = createSessionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', details: parsed.error.flatten() });
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
    const { id } = req.params as { id: string };
    const afterSeq = Number((req.query as { after?: string }).after || 0);
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
    const { id } = req.params as { id: string };
    const s = sessionManager.get(id);
    if (!s) return { error: 'not_found' };
    sessionManager.interrupt(s);
    store.audit(id, 'interrupt', s.toolId);
    return { ok: true };
  });

  return app;
}
