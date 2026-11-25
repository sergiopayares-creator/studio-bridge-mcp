import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  assertExpectedProject,
  projectNameMatches,
  packAeContactSheet,
  buildAdobeGuide,
  createMcpServer,
} from '../index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FFMPEG_BIN } from '../lib/ffmpeg.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const toolkitPath = path.join(here, '../../extension/host/toolkit_ae.jsx');
const toolkitSource = fs.readFileSync(toolkitPath, 'utf8');
const indexSource = fs.readFileSync(path.join(here, '../index.js'), 'utf8');

// --- helpers ---------------------------------------------------------------
// Mini lexer: returns the line of the first ternary nested inside another
// ternary without parentheses, or null. String literals and comments skipped.
function findNestedTernary(source) {
  let inLine = false;
  let inBlock = false;
  let quote = null;
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  const stack = [];
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (inLine) {
      if (ch === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(') {
      paren++;
      continue;
    }
    if (ch === ')') {
      paren--;
      while (stack.length && stack[stack.length - 1].paren > paren) stack.pop();
      continue;
    }
    if (ch === '{') {
      brace++;
      continue;
    }
    if (ch === '}') {
      brace--;
      while (stack.length && stack[stack.length - 1].brace > brace) stack.pop();
      continue;
    }
    if (ch === '[') {
      bracket++;
      continue;
    }
    if (ch === ']') {
      bracket--;
      while (stack.length && stack[stack.length - 1].bracket > bracket) stack.pop();
      continue;
    }
    if (ch === '?') {
      const top = stack[stack.length - 1];
      if (top && top.paren === paren && top.brace === brace && top.bracket === bracket) {
        return source.slice(0, i).split('\n').length;
      }
      stack.push({ paren, brace, bracket });
      continue;
    }
    if (ch === ':') {
      const top = stack[stack.length - 1];
      if (top && top.paren === paren && top.brace === brace && top.bracket === bracket) stack.pop();
    }
  }
  return null;
}

function makePng(file, color) {
  execFileSync(
    FFMPEG_BIN,
    ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=160x90:d=1`, '-frames:v', '1', file],
    { stdio: 'ignore' }
  );
}

// --- a) toolkit_ae.jsx: sintaxis + ES3 -------------------------------------
test('toolkit_ae.jsx compiles and respects the ES3 constraints', () => {
  assert.doesNotThrow(() => new vm.Script(toolkitSource, { filename: 'toolkit_ae.jsx' }));
  assert.doesNotMatch(toolkitSource, /\blet\s/);
  assert.doesNotMatch(toolkitSource, /\bconst\s/);
  assert.ok(!toolkitSource.includes('=>'), 'arrow functions are not ES3');
  assert.ok(!toolkitSource.includes('`'), 'template literals are not ES3');
  assert.equal(findNestedTernary(toolkitSource), null, 'nested ternary without parentheses');
  assert.doesNotMatch(toolkitSource, /\.(delete|default|class|import|export)\b/);
});

test('dispatch routes every Phase 2 verb and keeps the legacy aliases', () => {
  for (const verb of ['measure', 'alignAnchor', 'shapeGroup', 'set', 'halo', 'batch', 'check', 'contactSheet']) {
    assert.match(toolkitSource, new RegExp(`verb === '${verb}'`), `dispatch/runVerb must route ${verb}`);
  }
  for (const alias of ['lowerThird', 'overlay', 'cameraMove']) {
    assert.match(toolkitSource, new RegExp(`verb === '${alias}'`), `legacy alias ${alias} must stay routed`);
  }
  assert.match(toolkitSource, /function getEaseDimensions\(prop\)/);
  assert.match(toolkitSource, /function setValueChecked\(prop, val\)/);
  assert.match(toolkitSource, /function applySet\(p\)/);
  assert.match(toolkitSource, /function applyShapeGroup\(p\)/);
  assert.match(toolkitSource, /function checkComp\(c, options, state\)/);
});

// --- b) expected_project: fail-closed --------------------------------------
test('projectNameMatches is case-insensitive exact or substring', () => {
  assert.equal(projectNameMatches('Demo.aep', 'demo.AEP'), true);
  assert.equal(projectNameMatches('Spot Cliente 30s.aep', 'spot cliente'), true);
  assert.equal(projectNameMatches('Spot%20Cliente%2030s.aep', 'Spot Cliente 30s'), true);
  assert.equal(projectNameMatches('Spot Cliente 30s.aep', 'Otro'), false);
  assert.equal(projectNameMatches(null, 'x'), false);
  assert.equal(projectNameMatches('', ''), false);
});

test('assertExpectedProject fails closed when the host cannot verify the project', async () => {
  const noPanel = async () => ({ success: false, error: 'No active Adobe CEP extension' });
  await assert.rejects(
    () => assertExpectedProject('aftereffects', 'Demo.aep', noPanel),
    /could not verify the active project.*fail-closed/s
  );

  const noProjectName = async () => ({ success: true });
  await assert.rejects(
    () => assertExpectedProject('premiere', 'Demo.prproj', noProjectName),
    /did not report projectName/
  );
});

test('assertExpectedProject aborts on mismatch and accepts a case-insensitive substring', async () => {
  const snapshot = async () => ({ success: true, projectName: 'Spot Cliente 30s.aep' });
  await assert.rejects(
    () => assertExpectedProject('aftereffects', 'Otro Proyecto.aep', snapshot),
    /expected_project mismatch/
  );

  const guard = await assertExpectedProject('aftereffects', 'spot cliente', snapshot);
  assert.equal(guard.verified, true);
  assert.equal(guard.match, 'substring');

  const exact = await assertExpectedProject('aftereffects', 'SPOT CLIENTE 30S.AEP', snapshot);
  assert.equal(exact.match, 'exact');
});

test('assertExpectedProject is a no-op when expected_project is absent', async () => {
  let called = false;
  const guard = await assertExpectedProject('aftereffects', null, async () => {
    called = true;
    return {};
  });
  assert.equal(guard, null);
  assert.equal(called, false);
});

test('adobe_guide carries the corrected propertyValueType easing rule', () => {
  const guide = buildAdobeGuide('ae');
  const easing = guide.invariants.find((item) => item.id === 'easing');
  assert.ok(easing, 'easing invariant must exist');
  assert.match(easing.rule, /TwoD_SPATIAL/);
  assert.match(easing.rule, /ThreeD_SPATIAL/);
  assert.match(easing.rule, /TwoD -> 2 elements/);
  assert.match(easing.rule, /ThreeD .*-> 3 elements/);
});

// --- c) aftereffects_toolkit contactSheet -> image block --------------------
test('aftereffects_toolkit contactSheet packaging returns a native image block and cleans temp PNGs', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ae-sheet-test-'));
  const frames = [];
  try {
    const colors = ['red', 'green', 'blue', 'yellow'];
    for (let i = 0; i < colors.length; i++) {
      const file = path.join(tmp, `frame_${i}.png`);
      makePng(file, colors[i]);
      frames.push(file);
    }

    const result = await packAeContactSheet(
      { ok: true, comp: 'MockComp', times: [0, 1, 2, 3], paths: frames.slice() },
      { cols: 2, tileWidth: 160 }
    );

    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, 'text');
    assert.equal(result.content[1].type, 'image');
    assert.equal(result.content[1].mimeType, 'image/jpeg');
    assert.ok(result.content[1].data.length > 100);

    const meta = JSON.parse(result.content[0].text);
    assert.equal(meta.ok, true);
    assert.equal(meta.action, 'contactSheet');
    assert.equal(meta.comp, 'MockComp');
    assert.equal(meta.count, 4);
    assert.equal(meta.cols, 2);
    assert.equal(meta.rows, 2);
    assert.ok(fs.existsSync(meta.outputPath));
    assert.ok(!result.content[0].text.includes(result.content[1].data.slice(0, 96)));

    // Los PNG temporales del host se limpian tras montar el mosaico.
    for (const frame of frames) {
      assert.equal(fs.existsSync(frame), false, `temporary frame should be removed: ${frame}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('aftereffects_toolkit contactSheet packaging rejects an empty path list', async () => {
  await assert.rejects(
    () => packAeContactSheet({ ok: true, comp: 'MockComp', paths: [] }, {}),
    /host no generó ningún PNG/
  );
});

test('index.js handler wires verb contactSheet to the image packaging helper', () => {
  const libSource = fs.readFileSync(path.join(here, '../lib/aftereffects.js'), 'utf8');
  assert.match(indexSource, /packAeContactSheet\(result, params/);
  assert.match(indexSource, /export async function packAeContactSheet/);
  assert.match(indexSource, /args\.verb === 'contactSheet'/);
  assert.match(indexSource, /buildContactSheetJpeg\(result, params\)/);
  assert.match(libSource, /createContactSheetFromImages\(frames, outPath/);
  assert.match(libSource, /labels/);
});

test('MCP aftereffects_toolkit with verb contactSheet returns a native image block', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ae-mcp-sheet-'));
  const frames = [];
  try {
    for (const color of ['red', 'green']) {
      const frame = path.join(tmp, `frame_${color}.png`);
      makePng(frame, color);
      frames.push(frame);
    }

    const calls = [];
    const server = createMcpServer({
      sendCommand: async (appTarget, action, params) => {
        calls.push({ appTarget, action, verb: params && params.verb });
        if (action === 'toolkit_ae' && params && params.verb === 'contactSheet') {
          return { ok: true, comp: 'MockComp', times: [0, 1], paths: frames.slice() };
        }
        return { ok: false, error: 'unexpected command' };
      },
    });
    const client = new Client({ name: 'phase2-mcp-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    t.after(async () => {
      await client.close();
      await server.close();
    });

    const result = await client.callTool({
      name: 'aftereffects_toolkit',
      arguments: { verb: 'contactSheet', params: { cols: 2, tileWidth: 160 } },
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, 'text');
    assert.equal(result.content[1].type, 'image');
    assert.equal(result.content[1].mimeType, 'image/jpeg');

    const meta = JSON.parse(result.content[0].text);
    assert.equal(meta.ok, true);
    assert.equal(meta.comp, 'MockComp');
    assert.equal(meta.count, 2);
    assert.ok(calls.some((call) => call.action === 'toolkit_ae' && call.verb === 'contactSheet'));

    for (const frame of frames) {
      assert.equal(fs.existsSync(frame), false, `temporary frame should be removed: ${frame}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
