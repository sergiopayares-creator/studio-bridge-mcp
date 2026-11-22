#!/usr/bin/env node
/**
 * Studio Bridge — Broker compartido (multi-agente)
 * ------------------------------------------------------------------
 * Un solo proceso que:
 *   1. Es dueño del puente WebSocket con Adobe en 127.0.0.1:8765.
 *   2. Expone MCP por Streamable HTTP en 127.0.0.1:8766/mcp.
 *
 * Hermes, DeepSeek, Antigravity (o cualquier agente) se conectan al MISMO
 * broker sin pelear por el puerto. Los comandos se encolan con el mutex
 * existente, así que nunca chocan entre sí.
 */
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { createMcpServer, gateCepWrite } from './index.js';
import { initCepBridge, getBridgeStatus, sendCepCommand } from './lib/cep-bridge.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getOrCreateBridgeToken, tokensMatch, extractBearerToken } from './lib/security.js';

const bridgeConfigDir = path.join(os.homedir(), '.antigravity-studio-bridge');
const defaultHttpPort = Number(process.env.STUDIO_BRIDGE_HTTP_PORT) || 8766;
const MAX_BODY = 4 * 1024 * 1024;

// CORS cerrado: solo páginas servidas desde el propio equipo.
const LOCAL_ORIGIN_HOSTS = new Set(['127.0.0.1', 'localhost']);

// Acciones que el endpoint directo /inject puede despachar al panel CEP.
const INJECT_ACTIONS = new Set([
  'toolkit',
  'toolkit_ae',
  'evalScript',
  'evalCustom',
  'getProjectSnapshot',
  'getTimelineInfo',
  'getSummary',
]);

const INJECT_APP_TARGETS = new Set(['aftereffects', 'premiere', 'any']);

function isAllowedOrigin(origin) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch (_) {
    return false;
  }
  return (
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    LOCAL_ORIGIN_HOSTS.has(parsed.hostname)
  );
}

function isAuthorized(req, token) {
  const candidate = extractBearerToken(req.headers);
  return candidate !== null && tokensMatch(candidate, token);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve(undefined);
      try { resolve(JSON.parse(data)); } catch (_) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function handleMcp(req, res, sessions) {
  const sessionId = req.headers['mcp-session-id'];

  if (sessionId && !sessions.has(sessionId)) {
    return sendJson(res, 404, {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Session not found' },
      id: null,
    });
  }

  let entry = sessionId ? sessions.get(sessionId) : null;

  if (!entry) {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
      try { server.close(); } catch (_) {}
    };
    await server.connect(transport);
    entry = { server, transport };
  }

  const body = await readJsonBody(req);
  await entry.transport.handleRequest(req, res, body);
}

async function handleInject(req, res, sendCommand) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'POST' });
    return res.end('Use POST /inject');
  }

  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return sendJson(res, 400, { error: 'Cuerpo JSON inválido: se espera un objeto.' });
  }

  const appTarget = body.app_target === undefined ? 'aftereffects' : body.app_target;
  if (typeof appTarget !== 'string' || !INJECT_APP_TARGETS.has(appTarget)) {
    return sendJson(res, 400, { error: `app_target no permitido: ${String(appTarget)}` });
  }

  const action = body.action;
  if (typeof action !== 'string' || !INJECT_ACTIONS.has(action)) {
    return sendJson(res, 400, { error: `action no permitida: ${String(action)}` });
  }

  const params = body.params === undefined ? {} : body.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return sendJson(res, 400, { error: 'params debe ser un objeto.' });
  }

  try {
    gateCepWrite(action, params);
  } catch (err) {
    return sendJson(res, 403, { error: err.message || String(err) });
  }

  const result = await sendCommand(appTarget, action, params);
  return sendJson(res, 200, result);
}

/**
 * Crea el servidor HTTP sin arrancar el puente CEP. Pensado para tests y para
 * que el arranque real viva en startBroker().
 */
export function createBrokerHttpServer({
  token,
  sendCommand = sendCepCommand,
  getStatus = getBridgeStatus,
} = {}) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('createBrokerHttpServer requiere el token del puente');
  }
  if (typeof sendCommand !== 'function') {
    throw new Error('createBrokerHttpServer requiere sendCommand');
  }

  const sessions = new Map();

  const server = http.createServer(async (req, res) => {
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');

      const origin = req.headers.origin;
      if (origin !== undefined) {
        if (!isAllowedOrigin(origin)) {
          return sendJson(res, 403, {
            error: 'Origen no permitido: el broker solo acepta 127.0.0.1 y localhost.',
          });
        }
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id, Accept');
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }

      if (!isAuthorized(req, token)) {
        return sendJson(res, 401, { error: 'Unauthorized: Bearer token requerido.' });
      }

      const pathname = (req.url || '').split('?')[0];

      if (pathname === '/health') {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'GET' });
          return res.end('Use GET /health');
        }
        return sendJson(res, 200, {
          ok: true,
          bridge: getStatus(),
          sessions: sessions.size,
        });
      }

      if (pathname === '/inject') {
        return await handleInject(req, res, sendCommand);
      }

      if (pathname !== '/mcp') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not found. Use POST /mcp');
      }

      if (req.method === 'POST' || req.method === 'DELETE') {
        return await handleMcp(req, res, sessions);
      }

      if (req.method === 'GET') {
        // Con enableJsonResponse no hay stream SSE; pedimos POST.
        res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'POST, DELETE' });
        return res.end('Use POST /mcp');
      }

      res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'POST' });
      res.end('Method not allowed');
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 400, {
          jsonrpc: '2.0',
          error: { code: -32700, message: err.message || String(err) },
          id: null,
        });
      } else {
        try { res.end(); } catch (_) {}
      }
    }
  });

  return server;
}

/** Arranca el puente CEP y el servidor HTTP del broker. */
export async function startBroker({ port = defaultHttpPort, token = getOrCreateBridgeToken(bridgeConfigDir) } = {}) {
  const bridgeInfo = initCepBridge(bridgeConfigDir);
  await new Promise((r) => setTimeout(r, 350));

  if (!getBridgeStatus().listening) {
    throw new Error(
      'el puerto 8765 ya está ocupado por otro proceso. ' +
      'Seguramente hay un agente con el servidor stdio (index.js) corriendo. ' +
      'Cierra ese proceso y vuelve a iniciar el broker.'
    );
  }
  console.error(`[Broker] Puente Adobe escuchando en 127.0.0.1:${bridgeInfo.port}`);

  const server = createBrokerHttpServer({ token });
  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  server.on('error', (err) => {
    console.error(`[Broker] Error en servidor MCP HTTP (127.0.0.1:${port}):`, err.message);
  });

  console.error(`[Broker] MCP HTTP listo en http://127.0.0.1:${port}/mcp`);
  console.error('[Broker] Conecta aquí a Hermes / DeepSeek / Antigravity (transporte HTTP).');

  const shutdown = () => {
    server.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return { server, token, port };
}

const invokedDirectly = Boolean(process.argv[1]) &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  startBroker().catch((err) => {
    console.error(`[Broker] ERROR: ${err.message}`);
    process.exit(1);
  });
}
