import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeHttpServer } from '../lib/cep-bridge.js';

test('HTTP bridge does not expose command, prompt, or status routes to browser origins', async (t) => {
  const server = createBridgeHttpServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(() => resolve())));

  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  for (const [method, route] of [['GET', '/health'], ['GET', '/prompts'], ['POST', '/command']]) {
    const response = await fetch(base + route, {
      method,
      headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify({ action: 'evalScript', params: { script: '1+1' } }) } : {}),
    });
    assert.equal(response.status, 404, `${method} ${route} must be unavailable over HTTP`);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
});
