import test from 'node:test';
import assert from 'node:assert/strict';

import { createBrokerHttpServer } from '../broker.js';

const TOKEN = 'a'.repeat(64);
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const EVIL_ORIGIN = 'https://untrusted.example';
const LOCAL_ORIGIN = 'http://localhost:5173';

function createHarness(t, overrides = {}) {
  const calls = [];
  const sendCommand = async (appTarget, action, params) => {
    calls.push({ appTarget, action, params });
    return { ok: true, action };
  };
  const server = createBrokerHttpServer({
    token: TOKEN,
    sendCommand,
    getStatus: () => ({ listening: true, port: 8765, connectedApps: ['aftereffects'] }),
    ...overrides,
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      t.after(async () => {
        server.closeAllConnections?.();
        await new Promise((done) => server.close(done));
      });
      resolve({ base, calls, server });
    });
  });
}

test('GET /health devuelve 401 sin Bearer', async (t) => {
  const { base } = await createHarness(t);
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /Bearer/);
});

test('POST /inject devuelve 401 sin Bearer y no despacha comandos', async (t) => {
  const { base, calls } = await createHarness(t);
  const response = await fetch(`${base}/inject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_target: 'aftereffects', action: 'toolkit_ae', params: { verb: 'getInfo' } }),
  });
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

test('un Bearer incorrecto tampoco autoriza /health ni /inject', async (t) => {
  const { base, calls } = await createHarness(t);
  const headers = { Authorization: `Bearer ${'b'.repeat(64)}`, 'Content-Type': 'application/json' };

  const health = await fetch(`${base}/health`, { headers });
  assert.equal(health.status, 401);

  const inject = await fetch(`${base}/inject`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: 'toolkit_ae', params: { verb: 'getInfo' } }),
  });
  assert.equal(inject.status, 401);
  assert.equal(calls.length, 0);
});

test('con Bearer válido /health responde 200 y /inject despacha una acción permitida', async (t) => {
  const { base, calls } = await createHarness(t);

  const health = await fetch(`${base}/health`, { headers: AUTH });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    bridge: { listening: true, port: 8765, connectedApps: ['aftereffects'] },
    sessions: 0,
  });

  const inject = await fetch(`${base}/inject`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_target: 'aftereffects', action: 'toolkit_ae', params: { verb: 'getInfo' } }),
  });
  assert.equal(inject.status, 200);
  assert.deepEqual(await inject.json(), { ok: true, action: 'toolkit_ae' });
  assert.deepEqual(calls, [
    { appTarget: 'aftereffects', action: 'toolkit_ae', params: { verb: 'getInfo' } },
  ]);
});

test('/inject rechaza acciones fuera de la allowlist', async (t) => {
  const { base, calls } = await createHarness(t);
  const response = await fetch(`${base}/inject`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'system.callSystem', params: {} }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /action no permitida/);
  assert.equal(calls.length, 0);
});

test('/inject aplica gateCepWrite (evalCustom bloqueado sin STUDIO_BRIDGE_ALLOW_ARBITRARY_JS)', async (t) => {
  const previous = process.env.STUDIO_BRIDGE_ALLOW_ARBITRARY_JS;
  delete process.env.STUDIO_BRIDGE_ALLOW_ARBITRARY_JS;
  t.after(() => {
    if (previous === undefined) delete process.env.STUDIO_BRIDGE_ALLOW_ARBITRARY_JS;
    else process.env.STUDIO_BRIDGE_ALLOW_ARBITRARY_JS = previous;
  });

  const { base, calls } = await createHarness(t);
  const response = await fetch(`${base}/inject`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'evalCustom', params: { code: 'app.project' } }),
  });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /arbitrario/i);
  assert.equal(calls.length, 0);
});

test('CORS acepta solo orígenes locales y bloquea al resto', async (t) => {
  const { base } = await createHarness(t);

  const evil = await fetch(`${base}/health`, {
    headers: { Origin: EVIL_ORIGIN, ...AUTH },
  });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get('access-control-allow-origin'), null);

  const local = await fetch(`${base}/health`, {
    headers: { Origin: LOCAL_ORIGIN, ...AUTH },
  });
  assert.equal(local.status, 200);
  assert.equal(local.headers.get('access-control-allow-origin'), LOCAL_ORIGIN);

  const localWithoutToken = await fetch(`${base}/health`, {
    headers: { Origin: LOCAL_ORIGIN },
  });
  assert.equal(localWithoutToken.status, 401);
  assert.equal(localWithoutToken.headers.get('access-control-allow-origin'), LOCAL_ORIGIN);
});
