import type { Server, IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';
import http from 'node:http';
import { previewManager } from './manager.js';
import type { Store } from '../store/sqlite.js';

const PREVIEW_PREFIX = '/preview/';

/// Register reverse-proxy routes + WS upgrade handler.
/// Call once from index.ts after attachWsServer.
export function attachPreviewProxy(app: FastifyInstance, server: Server, store: Store): void {
  // HTTP: /preview/:token and /preview/:token/*
  app.all('/preview/:token', async (req, reply) => handle(req, reply));
  app.all('/preview/:token/*', async (req, reply) => handle(req, reply));

  // WebSocket upgrade (HMR). Multiple 'upgrade' listeners are fine; we no-op
  // for non-preview URLs so the /ws gateway keeps working.
  server.on('upgrade', (req, socket, head) => {
    const url = req.url || '/';
    if (!url.startsWith(PREVIEW_PREFIX)) return;
    handleUpgrade(req, socket as unknown as import('net').Socket, head);
  });
  void store;
}

async function handle(
  req: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply,
): Promise<void> {
  const token = (req.params as { token: string }).token;
  const h = previewManager.get(token);
  if (!h || h.state !== 'ready' || !h.port) {
    return reply.code(404).type('text/plain').send('preview_not_ready');
  }
  const url = req.url || '/';
  const subPath = url.slice(PREVIEW_PREFIX.length + token.length) || '/';
  const port = h.port;

  await new Promise<void>((resolve) => {
    const proxyReq = http.request(
      {
        host: '127.0.0.1',
        port,
        path: subPath,
        method: req.method,
        headers: rewriteHeaders(req.headers, port),
      },
      (proxyRes) => {
        reply.code(proxyRes.statusCode ?? 200);
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          if (v != null) reply.header(k, v);
        }
        reply.removeHeader('transfer-encoding');
        reply.send(proxyRes);
        proxyRes.on('end', () => resolve());
        proxyRes.on('error', () => {
          if (!reply.raw.writableEnded) reply.raw.end();
          resolve();
        });
      },
    );
    proxyReq.on('error', (err) => {
      if (!reply.sent) reply.code(502).send(`proxy error: ${err.message}`);
      resolve();
    });
    if (req.body !== undefined && req.body !== null) {
      const body = typeof req.body === 'string' || Buffer.isBuffer(req.body)
          ? (req.body as string | Buffer)
          : Buffer.from(JSON.stringify(req.body));
      proxyReq.end(body);
    } else {
      req.raw.pipe(proxyReq);
    }
  });
}

function rewriteHeaders(
  headers: IncomingMessage['headers'],
  port: number,
): NodeJS.Dict<string | string[]> {
  const out: NodeJS.Dict<string | string[]> = { ...headers };
  out['host'] = `127.0.0.1:${port}`;
  if (out['origin']) out['origin'] = `http://127.0.0.1:${port}`;
  out['connection'] = headers['connection'] || 'keep-alive';
  return out;
}

function handleUpgrade(
  req: IncomingMessage,
  socket: import('net').Socket,
  head: Buffer,
): void {
  const url = req.url || '/';
  const rest = url.slice(PREVIEW_PREFIX.length);
  const slash = rest.indexOf('/');
  const token = slash >= 0 ? rest.slice(0, slash) : rest;
  const subPath = slash >= 0 ? rest.slice(slash) : '/';
  const h = previewManager.get(token);
  if (!h || h.state !== 'ready' || !h.port) {
    socket.destroy();
    return;
  }

  const proxyReq = http.request({
    host: '127.0.0.1',
    port: h.port,
    path: subPath,
    method: 'GET',
    headers: rewriteHeaders(req.headers, h.port),
  });
  proxyReq.on('error', () => socket.destroy());
  proxyReq.on('response', () => socket.destroy());
  proxyReq.on('upgrade', (proxyRes, proxySocket) => {
    let headBuf = `HTTP/1.1 101 Switching Protocols\r\n`;
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (v != null) headBuf += `${k}: ${v}\r\n`;
    }
    headBuf += '\r\n';
    socket.write(headBuf);
    if (head.length > 0) socket.write(head);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
    proxySocket.on('error', () => socket.destroy());
    socket.on('error', () => proxySocket.destroy());
    socket.on('close', () => proxySocket.destroy());
  });
  proxyReq.end();
}
