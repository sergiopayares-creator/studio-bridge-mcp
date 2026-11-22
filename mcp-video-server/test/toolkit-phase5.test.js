import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const premiereSource = fs.readFileSync(path.join(here, '../../extension/host/toolkit.jsx'), 'utf8');
const aeSource = fs.readFileSync(path.join(here, '../../extension/host/toolkit_ae.jsx'), 'utf8');
const indexSource = fs.readFileSync(path.join(here, '../index.js'), 'utf8');

const NEW_PREMIERE_VERBS = ['import', 'bin', 'export', 'clipSpeed', 'importSrt'];

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

function assertEs3(source, label) {
  assert.doesNotThrow(() => new vm.Script(source, { filename: label }));
  assert.doesNotMatch(source, /\blet\s/);
  assert.doesNotMatch(source, /\bconst\s/);
  assert.ok(!source.includes('=>'), `${label}: arrow functions are not ES3`);
  assert.ok(!source.includes('`'), `${label}: template literals are not ES3`);
  assert.equal(findNestedTernary(source), null, `${label}: nested ternary without parentheses`);
}

test('toolkit.jsx and toolkit_ae.jsx stay strict ES3 and compile', () => {
  assertEs3(premiereSource, 'toolkit.jsx');
  assertEs3(aeSource, 'toolkit_ae.jsx');
});

test('Premiere toolkit routes and implements the Phase 5 verbs', () => {
  for (const verb of NEW_PREMIERE_VERBS) {
    assert.match(premiereSource, new RegExp(`verb === '${verb}'`), `dispatch must route ${verb}`);
  }
  assert.match(premiereSource, /function importMedia\(p\)/);
  assert.match(premiereSource, /function createBins\(p\)/);
  assert.match(premiereSource, /function exportSequence\(p\)/);
  assert.match(premiereSource, /function clipSpeed\(p\)/);
  assert.match(premiereSource, /function importSrt\(p\)/);

  // QE setSpeed: firma documentada por reflexión (speed, ticks string, ...).
  assert.match(premiereSource, /qClip\.setSpeed\(speed, targetTicks, reverse, maintainPitch, ripple\)/);
  assert.match(premiereSource, /String\(Math\.round\(baseTicks \/ speed\)\)/);

  // Export: directo (exportAsMediaDirect/render queue) y AME (encodeSequence/queueInAME).
  assert.match(premiereSource, /exportAsMediaDirect\(outputPath, presetPath, workArea\)/);
  assert.match(premiereSource, /app\.encoder\.encodeSequence\(seq, outputPath, presetPath, workArea/);
  assert.match(premiereSource, /rq2\.queueInAME\(removeAfter\)/);
  assert.match(premiereSource, /app\.encoder\.startBatch\(\)/);

  // SRT: createCaptionTrack(item, startAt, format) tras importar.
  assert.match(premiereSource, /seq\.createCaptionTrack\(item, startAt, fmt\)/);
  assert.match(premiereSource, /Sequence\.CAPTION_FORMAT_SUBTITLE/);
});

test('AE set supports separated X/Y dimension animation', () => {
  assert.match(aeSource, /function applyKeyframeList\(prop, list, globalEase\)/);
  assert.match(aeSource, /function separatedDimension\(prop, index\)/);
  assert.match(aeSource, /function enableDimensionsSeparated\(prop\)/);
  assert.match(aeSource, /prop\.dimensionsSeparated = true/);
  assert.match(aeSource, /prop\.dimensionsSeparated = false/);
  assert.match(aeSource, /p\.xKeyframes/);
  assert.match(aeSource, /p\.yKeyframes/);
  assert.match(aeSource, /p\.xValue/);
  assert.match(aeSource, /p\.yValue/);
  assert.match(aeSource, /dimensionsSeparated: true/);
});

test('MCP schemas expose the new verbs and the guide documents them', async (t) => {
  const server = createMcpServer();
  const client = new Client({ name: 'phase5-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const { tools } = await client.listTools();
  const premiere = tools.find((tool) => tool.name === 'premiere_toolkit');
  const ae = tools.find((tool) => tool.name === 'aftereffects_toolkit');
  assert.ok(premiere && ae);
  for (const verb of NEW_PREMIERE_VERBS) {
    assert.ok(premiere.inputSchema.properties.verb.enum.includes(verb), `premiere enum must include ${verb}`);
  }
  assert.ok(ae.inputSchema.properties.verb.enum.includes('set'));

  const guideResult = await client.callTool({ name: 'adobe_guide', arguments: { topic: 'all' } });
  const guide = JSON.parse(guideResult.content[0].text);
  for (const verb of NEW_PREMIERE_VERBS) {
    assert.ok(guide.premiere.verbs.includes(verb), `adobe_guide must list ${verb}`);
  }
  assert.ok(guide.premiere.notes.some((note) => note.includes('clipSpeed')));
  assert.ok(guide.aftereffects.notes.some((note) => note.includes('dimensions')));

  // El gating de escritura cubre export (ruta de salida obligatoria).
  assert.match(indexSource, /verb === 'export'/);
});
