import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const allowlistPath = path.join(here, '../../extension/client/js/bridge-actions.js');
const mainPath = path.join(here, '../../extension/client/js/main.js');

function loadAllowlist() {
  const code = fs.readFileSync(allowlistPath, 'utf8');
  const sandbox = { module: { exports: {} }, exports: {} };
  vm.runInNewContext(code, sandbox, { filename: 'bridge-actions.js' });
  return { exported: sandbox.module.exports, globalRef: sandbox.StudioBridgeActions };
}

test('la allowlist acepta las acciones y macros conocidas del panel', () => {
  const { exported, globalRef } = loadAllowlist();
  const { isAllowedAction, isAllowedMacro } = exported;
  assert.ok(globalRef, 'StudioBridgeActions debe quedar expuesto en root aunque exista module.exports');
  assert.equal(typeof globalRef.isAllowedAction, 'function');
  assert.equal(typeof globalRef.isAllowedMacro, 'function');
  for (const action of [
    'evalScript',
    'evalCustom',
    'toolkit',
    'toolkit_ae',
    'getProjectSnapshot',
    'getTimelineInfo',
    'getSummary',
  ]) {
    assert.equal(isAllowedAction(action), true, `${action} debe estar permitida`);
  }
  for (const macro of [
    'cutAtPlayhead',
    'addMarker',
    'applySmartZoom',
    'create3DCameraWithZoom',
    'applyFlashTransitions',
  ]) {
    assert.equal(isAllowedMacro(macro), true, `${macro} debe estar permitida`);
  }
});

test('la allowlist rechaza acciones arbitrarias y nombres heredados de Object', () => {
  const { exported } = loadAllowlist();
  const { isAllowedAction, isAllowedMacro } = exported;
  for (const value of [
    '',
    'system.callSystem',
    'AntigravityBridge.cutAtPlayhead',
    'cutAtPlayhead()',
    'eval',
    'constructor',
    '__proto__',
    'toString',
    'hasOwnProperty',
    'alert',
    null,
    undefined,
    42,
    {},
    [],
  ]) {
    assert.equal(isAllowedAction(value), false, `action ${String(value)} debe rechazarse`);
    assert.equal(isAllowedMacro(value), false, `macro ${String(value)} debe rechazarse`);
  }
});

test('main.js consulta la allowlist antes del primer evalScript de handleAgentAction', () => {
  const source = fs.readFileSync(mainPath, 'utf8');
  const handler = source.indexOf('function handleAgentAction');
  assert.ok(handler > -1, 'handleAgentAction debe existir');

  const allowCheck = source.indexOf('isAllowedAction(action)', handler);
  const firstEval = source.indexOf('cs.evalScript', handler);
  assert.ok(allowCheck > handler, 'handleAgentAction debe consultar isAllowedAction');
  assert.ok(firstEval > allowCheck, 'la allowlist debe ejecutarse antes de cs.evalScript');
});

test('renderSteps escapa el HTML de los pasos y no quedan rutas legadas', () => {
  const source = fs.readFileSync(mainPath, 'utf8');
  const render = source.indexOf('function renderSteps');
  const next = source.indexOf('function handleRemoteTaskProgress');
  const block = source.slice(render, next);

  assert.match(block, /escapeHtml\(s\)/);
  assert.doesNotMatch(block, /<span>' \+ String\(s\) \+ '<\/span>/);
  assert.doesNotMatch(source, /Antigravity_Workspace/);
});
