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
    // Auth via query token. We use query because Sec-WebSocket-Protocol
    // would require a subprotocol negotiation echo.
    const token = url.searchParams.get('token');
    if (!token) {
      // Send an HTTP 401 so the client can distinguish "no token" from a
      // transient network failure. Without this the WS just closes and the
      // client retries forever with exponential backoff.
      socket.write('HTTP/1.1 401 Unauthorized\r\nx-pocket-reason: no_token\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    verifyToken(token).then((payload) => {
      if (!payload) {
        // Token failed verification (expired, wrong secret, malformed).
        // Signal this as 401 so the app can clear stored credentials and
        // prompt re-pairing instead of spinning on reconnect.
        socket.write('HTTP/1.1 401 Unauthorized\r\nx-pocket-reason: invalid_token\r\nConnection: close\r\n\r\n');
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
      let session = sessionManager.get(msg.sessionId);
      if (!session) {
        // Server restarted since last visit — rehydrate from DB so the
        // subscriber receives live events when the next input re-spawns.
        const row = store.getSession(msg.sessionId);
        if (!row) {
          const msgs = sessionManager.replayFromDb(msg.sessionId, msg.lastSeq, store);
          for (const m of msgs) send(ws, m);
          return;
        }
        session = sessionManager.rehydrate(row, store);
      }
      const replay = sessionManager.attach(session, msg.lastSeq, (m) => send(ws, m));
      for (const m of replay) send(ws, m);
      return;
    }
    case 'input': {
      let session = sessionManager.get(msg.sessionId);
      if (!session) {
        // Server restarted — rehydrate from DB; input() will --resume.
        const row = store.getSession(msg.sessionId);
        if (!row) return send(ws, { seq: 0, t: 'error', sessionId: msg.sessionId, message: 'session_not_found' });
        session = sessionManager.rehydrate(row, store);
      }
      sessionManager.input(session, msg.text, store);
      return;
    }
    case 'interrupt': {
      const session = sessionManager.get(msg.sessionId);
      if (!session) return;
      sessionManager.interrupt(session);
      return;
    }
    case 'mode': {
      // Set or cycle the permission mode. If msg.mode is present, set it
      // directly (user picked a specific mode from the menu); otherwise
      // cycle to the next one (shift+tab equivalent). Rehydrate from DB
      // if the session isn't in memory (server restart) so the next input
      // spawns with the new mode.
      let session = sessionManager.get(msg.sessionId);
      if (!session) {
        const row = store.getSession(msg.sessionId);
        if (!row) return send(ws, { seq: 0, t: 'error', sessionId: msg.sessionId, message: 'session_not_found' });
        session = sessionManager.rehydrate(row, store);
      }
      if (msg.mode) {
        sessionManager.setMode(session, msg.mode, store);
      } else {
        sessionManager.cycleMode(session, store);
      }
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
    case 'term_open': {
      // Open the interactive pty terminal channel. Rehydrate from DB if the
      // session isn't in memory (server restart) so the terminal can --resume.
      let session = sessionManager.get(msg.sessionId);
      if (!session) {
        const row = store.getSession(msg.sessionId);
        if (!row) return send(ws, { seq: 0, t: 'error', sessionId: msg.sessionId, message: 'session_not_found' });
        session = sessionManager.rehydrate(row, store);
      }
      const ok = sessionManager.openTerminal(session, store);
      if (!ok) send(ws, { seq: 0, t: 'error', sessionId: msg.sessionId, message: 'terminal_unsupported' });
      return;
    }
    case 'term': {
      // Raw keystrokes from the app's terminal view → pty stdin.
      const session = sessionManager.get(msg.sessionId);
      if (session) sessionManager.writeTerminal(session, msg.data);
      return;
    }
    case 'resize': {
      // Terminal geometry change → resize the pty (best effort).
      const session = sessionManager.get(msg.sessionId);
      if (session) sessionManager.resizeTerminal(session, msg.cols, msg.rows);
      return;
    }
    case 'term_close': {
      const session = sessionManager.get(msg.sessionId);
      if (session) sessionManager.closeTerminal(session, store);
      return;
    }
  }
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
