import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../index.js';
import { matchesAppTarget } from '../lib/cep-bridge.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(here, '../../uxp-premiere/manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const mainSource = fs.readFileSync(path.join(here, '../../uxp-premiere/main.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(here, '../index.js'), 'utf8');

const UXP_VERBS = ['status', 'effectsList', 'effectsAdd', 'effectsRemove', 'clipParams', 'clipParamSet'];

async function connect(server) {
  const client = new Client({ name: 'phase4-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

// --- a) manifest UXP -------------------------------------------------------
test('uxp-premiere manifest is a valid v5 UXP panel without code generation', () => {
  assert.equal(manifest.manifestVersion, 5);
  assert.equal(manifest.id, 'com.antigravity.studio.uxp.premiere');
  assert.equal(manifest.name, 'Studio Bridge UXP (Premiere)');
  assert.equal(manifest.version, '1.0.2');
  assert.equal(manifest.host.app, 'premierepro');
  assert.equal(manifest.host.minVersion, '25.6.0');
  assert.equal(manifest.requiredPermissions.localFileSystem, 'fullAccess');
  assert.deepEqual(manifest.requiredPermissions.network.domains, [
    'localhost',
    '127.0.0.1',
    'ws://localhost:8765',
    'ws://127.0.0.1:8765',
    'http://localhost:8765',
    'http://127.0.0.1:8765',
  ]);
  assert.equal(Object.prototype.hasOwnProperty.call(manifest, 'allowCodeGenerationFromStrings'), false);
  assert.equal(JSON.stringify(manifest).includes('allowCodeGenerationFromStrings'), false);

  const panel = manifest.entrypoints.find((entry) => entry.type === 'panel');
  assert.ok(panel, 'must define one panel entrypoint');
  assert.equal(panel.id, 'studioBridgeUxpPanel');
  assert.equal(panel.main, 'index.html');

  // El panel implementa token, auth y reconexión de 4s.
  assert.match(mainSource, /\.bridge-secret/);
  assert.match(mainSource, /type: 'auth'/);
  assert.match(mainSource, /app: 'premiere_uxp'/);
  assert.match(mainSource, /RECONNECT_MS = 4000/);
  assert.match(mainSource, /VideoFilterFactory\.getMatchNames/);
  assert.match(mainSource, /lockedAccess/);
  assert.match(mainSource, /executeTransaction/);
});

// --- b) aislamiento CEP vs UXP --------------------------------------------
test('matchesAppTarget isolates the CEP panel from the UXP bridge', () => {
  // UXP target only matches the UXP connection.
  assert.equal(matchesAppTarget('premiere_uxp', 'premiere_uxp'), true);
  assert.equal(matchesAppTarget('premiere_uxp', 'premiereuxp'), true);
  assert.equal(matchesAppTarget('premiere_uxp', 'premiere'), false);
  assert.equal(matchesAppTarget('premiere_uxp', 'aftereffects'), false);

  // CEP target only matches the CEP panel names, never the UXP connection.
  assert.equal(matchesAppTarget('Premiere Pro', 'premiere'), true);
  assert.equal(matchesAppTarget('premierepro', 'premiere'), true);
  assert.equal(matchesAppTarget('Premiere Pro', 'premiere_uxp'), false);
  assert.equal(matchesAppTarget('After Effects', 'premiere'), false);
  assert.equal(matchesAppTarget('After Effects', 'aftereffects'), true);

  // any/empty keeps the legacy "first connected" semantics.
  assert.equal(matchesAppTarget('premiere_uxp', 'any'), true);
  assert.equal(matchesAppTarget('premiere_uxp', ''), true);

  // Unknown targets compare by exact normalized identity (no substrings).
  assert.equal(matchesAppTarget('premierepro', 'premierepro'), true);
  assert.equal(matchesAppTarget('premierepro_extra', 'premierepro'), false);

  assert.match(indexSource, /matchesAppTarget\(app, 'premiere_uxp'\)/);
});

// --- c) ListTools ----------------------------------------------------------
test('ListTools exposes premiere_uxp_toolkit with all verbs and expected_project', async (t) => {
  const server = createMcpServer();
  const client = await connect(server);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const { tools } = await client.listTools();
  const tool = tools.find((entry) => entry.name === 'premiere_uxp_toolkit');
  assert.ok(tool, 'premiere_uxp_toolkit must be exposed');
  assert.deepEqual(tool.inputSchema.required, ['verb']);
  assert.deepEqual(tool.inputSchema.properties.verb.enum, UXP_VERBS);
  assert.equal(tool.inputSchema.properties.params.type, 'object');
  assert.equal(tool.inputSchema.properties.expected_project.type, 'string');

  // La guía documenta la herramienta y sus verbos.
  const guideResult = await client.callTool({ name: 'adobe_guide', arguments: { topic: 'premiere' } });
  const guide = JSON.parse(guideResult.content[0].text);
  assert.ok(guide.premiere.uxpToolkit, 'adobe_guide must document the UXP toolkit');
  assert.equal(guide.premiere.uxpToolkit.tool, 'premiere_uxp_toolkit');
  assert.deepEqual(guide.premiere.uxpToolkit.verbs, UXP_VERBS);
});

// --- d) despacho MCP ------------------------------------------------------
test('premiere_uxp_toolkit dispatches effectsAdd/effectsRemove/clipParamSet to the UXP connection', async (t) => {
  const calls = [];
  const server = createMcpServer({
    sendCommand: async (appTarget, action, params) => {
      calls.push({ appTarget, action, verb: params && params.verb });
      if (action === 'toolkit_uxp') {
        return { ok: true, host: 'premiere_uxp', sequence: 'Seq UXP', verb: params.verb, applied: 1, removed: 1 };
      }
      return { success: false, error: 'unexpected action' };
    },
  });
  const client = await connect(server);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const cases = [
    { verb: 'effectsAdd', params: { matchName: 'AE.ADBE Gaussian Blur 2', track: 0 } },
    { verb: 'effectsRemove', params: { match: 'Gaussian Blur', track: 0 } },
    { verb: 'clipParamSet', params: { component: 'Graphics', param: 'Text', value: 'Hola', at: 1.5 } },
  ];
  for (const item of cases) {
    const result = await client.callTool({
      name: 'premiere_uxp_toolkit',
      arguments: { verb: item.verb, params: item.params },
    });
    assert.equal(result.isError, undefined, `${item.verb} must not be an MCP error`);
    const meta = JSON.parse(result.content[0].text);
    assert.equal(meta.ok, true);
    assert.equal(meta.host, 'premiere_uxp');
    assert.equal(meta.verb, item.verb);
    const call = calls[calls.length - 1];
    assert.equal(call.appTarget, 'premiere_uxp');
    assert.equal(call.action, 'toolkit_uxp');
    assert.equal(call.verb, item.verb);
  }
  assert.equal(calls.length, 3);
});

test('premiere_uxp_toolkit expected_project is fail-closed', async (t) => {
  const sendCommand = async (appTarget, action) => {
    if (action === 'getProjectSnapshot') return { success: false, error: 'UXP disconnected' };
    return { ok: true, host: 'premiere_uxp' };
  };
  const server = createMcpServer({ sendCommand });
  const client = await connect(server);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: 'premiere_uxp_toolkit',
    arguments: { verb: 'status', expected_project: 'Target.prproj' },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /could not verify/i);
});

test('premiere_uxp_toolkit aborts on project mismatch and proceeds on a match', async (t) => {
  let projectName = 'Other.prproj';
  const calls = [];
  const server = createMcpServer({
    sendCommand: async (appTarget, action, params) => {
      calls.push({ appTarget, action, verb: params && params.verb });
      if (action === 'getProjectSnapshot') return { success: true, projectName };
      if (action === 'toolkit_uxp') return { ok: true, host: 'premiere_uxp', verb: params.verb };
      return { ok: false, error: 'unexpected' };
    },
  });
  const client = await connect(server);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const mismatch = await client.callTool({
    name: 'premiere_uxp_toolkit',
    arguments: { verb: 'status', expected_project: 'Target.prproj' },
  });
  assert.equal(mismatch.isError, true);
  assert.match(mismatch.content[0].text, /expected_project mismatch/);
  assert.equal(calls.some((call) => call.action === 'toolkit_uxp'), false, 'must not dispatch on mismatch');

  projectName = 'Target Project.prproj';
  const match = await client.callTool({
    name: 'premiere_uxp_toolkit',
    arguments: { verb: 'effectsList', params: { filter: 'blur' }, expected_project: 'TARGET PROJECT.PRPROJ' },
  });
  assert.equal(match.isError, undefined);
  const meta = JSON.parse(match.content[0].text);
  assert.equal(meta.ok, true);
  assert.equal(meta.projectGuard.verified, true);
  assert.equal(meta.projectGuard.match, 'exact');
});
