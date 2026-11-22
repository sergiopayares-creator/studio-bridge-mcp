import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { getOrCreateBridgeToken, tokensMatch } from './security.js';

let wss = null;
let httpServer = null;
let listening = false;
const activeConnections = new Map(); // id -> { ws, app, tokenValidated }
let messageCounter = 0;
const pendingRequests = new Map(); // id -> { resolve, timer }
const recentPrompts = [];

// Hosts considered local for the loopback WebSocket upgrade. Any other Host
// header (DNS rebinding) is rejected before the token check even happens.
// The port is validated against the actual listening port.
function isTrustedUpgrade(request, port) {
  const host = (request.headers.host || '').toLowerCase();
  if (host) {
    const m = host.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
    if (!m) return false;
    const hostname = m[1];
    const hostPort = m[2] ? Number(m[2]) : null;
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) return false;
    if (hostPort !== null && port && hostPort !== port) return false;
  }

  const origin = (request.headers.origin || '').toLowerCase();
  if (!origin) return true; // native clients (CEP panel) send no Origin
  if (origin === 'null') return true;
  // CEP panels load from local file:// pages; allow them. A remote web page
  // cannot forge file:// (the browser sets Origin itself), so this stays safe.
  if (origin.startsWith('file://')) return true;
  // Allow local/dev origins only; block arbitrary browser origins (CSRF / rebinding)
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin);
}

// Sequential Command Queue (Anti-Collision Mutex for ExtendScript)
let commandExecutionQueue = Promise.resolve();

/**
 * True when a bridge payload failed because the request timed out (transient:
 * AE/Premiere may still be busy rendering or answering the previous command).
 * The expected_project guard retries exactly once on this condition.
 */
export function isTransientTimeout(payload) {
  if (!payload) return false;
  const text =
    typeof payload === 'string'
      ? payload
      : String((payload && (payload.error || payload.message)) || '');
  return /timed?\s*out|timeout|tiempo de espera agotado/i.test(text);
}

export function getRecentPrompts() {
  return recentPrompts;
}

// Normalizes an app identifier: case-insensitive, ignoring spaces, "_" and "-".
function normalizeAppName(app) {
  return String(app || '').toLowerCase().replace(/[\s_-]/g, '');
}

/**
 * Strictly matches a connection's app name against a requested target.
 *
 * Targets are different transports, not aliases:
 *  - 'premiere_uxp' ONLY matches the UXP plugin (auth app 'premiere_uxp').
 *  - 'premiere' ONLY matches the CEP panel ('Premiere Pro', 'premierepro', ...).
 *    It must never select 'premiere_uxp': ExtendScript commands cannot be
 *    executed by the UXP panel.
 *  - 'aftereffects' matches the AE CEP panel.
 *  - 'any'/empty matches the first authenticated connection.
 *  - Any other target is compared by exact normalized identity (no substrings).
 */
export function matchesAppTarget(connApp, appTarget) {
  const conn = normalizeAppName(connApp);
  const target = normalizeAppName(appTarget);
  if (!target || target === 'any') return true;
  if (!conn) return false;
  if (target === 'premiereuxp') return conn === 'premiereuxp';
  if (target === 'premiere') {
    return conn === 'premiere' || conn === 'premierepro' || conn === 'ppro';
  }
  if (target === 'aftereffects') {
    return conn === 'aftereffects' || conn === 'aftereffect' || conn === 'ae' || conn === 'aeft';
  }
  return conn === target;
}

export function createBridgeHttpServer() {
  return http.createServer((req, res) => {
    res.writeHead(404, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify({ success: false, error: 'Not found' }));
  });
}

export function initCepBridge(configDir, port = 8765) {
  if (wss) return { port, token: getOrCreateBridgeToken(configDir), listening };

  const token = getOrCreateBridgeToken(configDir);
  const resolvedPort = Number(process.env.ANTIGRAVITY_BRIDGE_PORT) || port;

  // Security: Strictly bind HTTP server to 127.0.0.1 (local loopback only)
  httpServer = createBridgeHttpServer();

  wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const remote = socket.remoteAddress;
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      socket.destroy();
      return;
    }
    if (!isTrustedUpgrade(request, resolvedPort)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  httpServer.on('error', (err) => {
    listening = false;
    console.error(`[Bridge] Aviso en servidor HTTP (127.0.0.1:${resolvedPort}):`, err.message);
  });

  wss.on('error', (err) => {
    console.error(`[Bridge] Aviso en WebSocketServer (127.0.0.1:${resolvedPort}):`, err.message);
  });

  wss.on('connection', (ws) => {
    const connId = `conn_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const connState = { ws, app: 'unknown', tokenValidated: false };
    activeConnections.set(connId, connState);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // Handshake authentication
        if (msg.type === 'auth') {
          const isValidToken = tokensMatch(msg.token, token);
          if (isValidToken) {
            connState.tokenValidated = true;
            connState.app = msg.app || 'adobe_cep';
            ws.send(JSON.stringify({
              type: 'auth_ok',
              app: connState.app
            }));
          } else {
            ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid bridge secret token' }));
            ws.close();
          }
          return;
        }

        // Only process messages if authenticated
        if (!connState.tokenValidated) {
          ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized. Send auth token first.' }));
          return;
        }

        // Response to a pending sequential request
        if (msg.requestId && pendingRequests.has(msg.requestId)) {
          const { resolve, timer } = pendingRequests.get(msg.requestId);
          clearTimeout(timer);
          pendingRequests.delete(msg.requestId);
          resolve(msg.payload);
          return;
        }

        // Heartbeat ping
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }

        // Prompts submitted via panel (if any)
        if (msg.type === 'user_prompt') {
          const item = {
            app: msg.app || connState.app,
            text: msg.text,
            projectContext: msg.projectContext || {},
            attachments: msg.attachments || [],
            timestamp: new Date().toISOString()
          };
          recentPrompts.push(item);
          if (recentPrompts.length > 50) recentPrompts.shift();
          return;
        }
      } catch (err) {
        console.error('[Bridge] Error procesando mensaje de socket:', err.message);
      }
    });

    ws.on('close', () => {
      activeConnections.delete(connId);
    });

    ws.on('error', () => {
      activeConnections.delete(connId);
    });
  });

  httpServer.listen(resolvedPort, '127.0.0.1', () => {
    listening = true;
    console.error(`[Bridge] Servidor HTTP y WebSocket escuchando en 127.0.0.1:${resolvedPort}`);
  });

  return { port: resolvedPort, token, listening };
}

export function getBridgeStatus() {
  return {
    listening,
    port: wss ? (httpServer && httpServer.address() ? httpServer.address().port : null) : null,
    connectedApps: getConnectedApps(),
  };
}

/**
 * Sends a command to the connected Adobe CEP extension (Premiere Pro or After Effects).
 * Enforces a sequential queue (mutex) so ExtendScript calls never collide or run concurrently.
 */
export function sendCepCommand(appTarget, action, params = {}, timeoutMs = 30000) {
  const executeOperation = () => new Promise((resolve) => {
    // Find matching connection
    let targetConn = null;
    for (const conn of activeConnections.values()) {
      if (conn.tokenValidated && matchesAppTarget(conn.app, appTarget)) {
        targetConn = conn;
        break;
      }
    }

    if (!targetConn) {
      return resolve({
        success: false,
        error: `No active Adobe CEP extension is currently connected for target: '${appTarget || 'any'}'. Please make sure Premiere Pro or After Effects is open with the Studio Bridge panel active.`
      });
    }

    const requestId = `req_${++messageCounter}_${Date.now()}`;
    const timer = setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId);
        resolve({
          success: false,
          error: `CEP bridge request timed out after ${timeoutMs}ms.`
        });
      }
    }, timeoutMs);

    pendingRequests.set(requestId, { resolve, timer });

    try {
      targetConn.ws.send(JSON.stringify({
        requestId,
        action,
        params
      }));
    } catch (sendErr) {
      clearTimeout(timer);
      pendingRequests.delete(requestId);
      resolve({
        success: false,
        error: `Failed to dispatch command to CEP socket: ${sendErr.message}`
      });
    }
  });

  // Enqueue sequentially: each command awaits the previous one
  const nextInQueue = commandExecutionQueue.then(executeOperation, executeOperation);
  commandExecutionQueue = nextInQueue.then(() => {}, () => {});
  return nextInQueue;
}

export function getConnectedApps() {
  const list = [];
  for (const conn of activeConnections.values()) {
    if (conn.tokenValidated) {
      list.push(conn.app);
    }
  }
  return list;
}

/**
 * Broadcasts an event to all connected CEP panels (Stepper progress or notifications)
 */
export function broadcastToPanel(payload) {
  let count = 0;
  for (const conn of activeConnections.values()) {
    if (conn.tokenValidated && conn.ws && conn.ws.readyState === WebSocket.OPEN) {
      try {
        conn.ws.send(JSON.stringify(payload));
        count++;
      } catch (_) {}
    }
  }
  return count;
}
