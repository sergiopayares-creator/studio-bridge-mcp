import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createBridgeHttpServer } from '../lib/cep-bridge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_ACTIONS_PATH = path.resolve(__dirname, '../../extension/client/js/bridge-actions.js');

test('StudioBridgeActions registers on global root even when module.exports exists (CEP Node integration)', () => {
  const source = fs.readFileSync(BRIDGE_ACTIONS_PATH, 'utf8');
  const sandbox = {
    module: { exports: {} },
    self: {},
  };
  vm.runInNewContext(source, sandbox);

  assert.equal(typeof sandbox.self.StudioBridgeActions, 'object');
  assert.equal(sandbox.self.StudioBridgeActions.isAllowedAction('toolkit'), true);
  assert.equal(sandbox.self.StudioBridgeActions.isAllowedAction('getProjectSnapshot'), true);
  assert.equal(sandbox.module.exports.isAllowedAction('toolkit'), true);
});

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
