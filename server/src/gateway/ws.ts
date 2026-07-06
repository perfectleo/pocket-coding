import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'node:http';
import { verifyToken } from './auth.js';
import type { Store } from '../store/sqlite.js';
import { sessionManager } from '../session/manager.js';
import type { ClientMessage, ServerMessage } from '../protocol.js';

export function attachWsServer(server: Server, store: Store): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    // Auth via query token or Sec-WebSocket-Protocol hack. We use query.
    const token = url.searchParams.get('token');
    if (!token) {
      socket.destroy();
      return;
    }
    verifyToken(token).then((payload) => {
      if (!payload) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        (ws as unknown as { deviceId: string }).deviceId = payload.deviceId;
        wss.emit('connection', ws, req);
      });
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    const deviceId = (ws as unknown as { deviceId: string }).deviceId;
    store.audit(null, 'ws_connect', deviceId);

    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      handleClient(ws, msg, store).catch((err) => {
        send(ws, { seq: 0, t: 'error', message: err.message });
      });
    });

    ws.on('close', () => {
      store.audit(null, 'ws_disconnect', deviceId);
    });
  });

  return wss;
}

async function handleClient(ws: WebSocket, msg: ClientMessage, store: Store): Promise<void> {
  switch (msg.t) {
    case 'ping': {
      send(ws, { seq: 0, t: 'pong' });
      return;
    }
    case 'attach': {
      const session = sessionManager.get(msg.sessionId);
      if (!session) {
        // session not in memory — replay from DB
        const msgs = sessionManager.replayFromDb(msg.sessionId, msg.lastSeq, store);
        for (const m of msgs) send(ws, m);
        return;
      }
      const replay = sessionManager.attach(session, msg.lastSeq, (m) => send(ws, m));
      for (const m of replay) send(ws, m);
      return;
    }
    case 'input': {
      const session = sessionManager.get(msg.sessionId);
      if (!session) return send(ws, { seq: 0, t: 'error', sessionId: msg.sessionId, message: 'session_not_found' });
      sessionManager.input(session, msg.text, store);
      return;
    }
    case 'interrupt': {
      const session = sessionManager.get(msg.sessionId);
      if (!session) return;
      sessionManager.interrupt(session);
      return;
    }
    case 'approve': {
      const session = sessionManager.get(msg.sessionId);
      if (!session) return;
      const resolver = session.pendingApprovals.get(msg.callId);
      if (resolver) {
        resolver(msg.approve);
        session.pendingApprovals.delete(msg.callId);
      }
      return;
    }
    case 'resize': {
      // tmux resize — best effort
      return;
    }
  }
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
