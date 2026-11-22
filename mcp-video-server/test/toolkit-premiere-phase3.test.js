import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../index.js';
import { FFMPEG_BIN } from '../lib/ffmpeg.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const toolkitPath = path.join(here, '../../extension/host/toolkit.jsx');
const toolkitSource = fs.readFileSync(toolkitPath, 'utf8');
const mainSource = fs.readFileSync(path.join(here, '../../extension/client/js/main.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(here, '../index.js'), 'utf8');

const PREMIERE_NEW_VERBS = ['renderFrame', 'contactSheet', 'clipMotion', 'clipVolume', 'assemble', 'saveSafe'];
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// Mini lexer (same contract as the AE test): first nested ternary line or null.
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

async function connect(server) {
  const client = new Client({ name: 'phase3-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

// --- a) toolkit.jsx: sintaxis + ES3 ---------------------------------------
test('toolkit.jsx compiles and respects the strict ES3 constraints', () => {
  assert.doesNotThrow(() => new vm.Script(toolkitSource, { filename: 'toolkit.jsx' }));
  assert.doesNotMatch(toolkitSource, /\blet\s/);
  assert.doesNotMatch(toolkitSource, /\bconst\s/);
  assert.ok(!toolkitSource.includes('=>'), 'arrow functions are not ES3');
  assert.ok(!toolkitSource.includes('`'), 'template literals are not ES3');
  assert.equal(findNestedTernary(toolkitSource), null, 'nested ternary without parentheses');
  assert.doesNotMatch(toolkitSource, /\.(delete|default|class|import|export)\b/);
});

// --- b) enrutado y schemas ------------------------------------------------
test('toolkit.jsx implements the Phase 3 helpers and routes every new verb', () => {
  assert.match(toolkitSource, /var TPS = 254016000000;/);
  assert.match(toolkitSource, /function secToTimecode\(seq, seconds\)/);
  assert.match(toolkitSource, /function nativePath\(p\)/);
  for (const verb of PREMIERE_NEW_VERBS) {
    assert.match(
      toolkitSource,
      new RegExp(`verb === '${verb}'`),
      `dispatch must route premiere verb ${verb}`
    );
  }
  assert.match(toolkitSource, /verb === 'save' \|\| verb === 'saveSafe'/);
  assert.match(toolkitSource, /qs\.exportFramePNG\(/);
  assert.match(toolkitSource, /getAudioTransitionByName\('Constant Power'\)/);
});

test('MCP tool schemas expose set in aftereffects_toolkit and the new premiere verbs', async (t) => {
  const server = createMcpServer();
  const client = await connect(server);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const { tools } = await client.listTools();
  const ae = tools.find((tool) => tool.name === 'aftereffects_toolkit');
  const pr = tools.find((tool) => tool.name === 'premiere_toolkit');
  assert.ok(ae, 'aftereffects_toolkit must exist');
  assert.ok(pr, 'premiere_toolkit must exist');
  assert.ok(ae.inputSchema.properties.verb.enum.includes('set'), "aftereffects_toolkit enum must include 'set'");

  for (const verb of PREMIERE_NEW_VERBS) {
    assert.ok(pr.inputSchema.properties.verb.enum.includes(verb), `premiere_toolkit enum must include ${verb}`);
  }

  // The guide is built from the same verb tables.
  const guideResult = await client.callTool({ name: 'adobe_guide', arguments: { topic: 'premiere' } });
  const guide = JSON.parse(guideResult.content[0].text);
  for (const verb of PREMIERE_NEW_VERBS) {
    assert.ok(guide.premiere.verbs.includes(verb), `adobe_guide must list ${verb}`);
  }
  assert.match(indexSource, /export const packContactSheet = packAeContactSheet;/);
});

// --- c) clipVolume dB <-> amplitud ----------------------------------------
test('clipVolume dB <-> amplitude conversion matches the Premiere Level formula', () => {
  const gainMatch = toolkitSource.match(/function gainDbToAmp\(db\) \{[^\n]*\}/);
  const ampMatch = toolkitSource.match(/function ampToGainDb\(amp\) \{[^\n]*\}/);
  assert.ok(gainMatch, 'gainDbToAmp must be a single-line helper');
  assert.ok(ampMatch, 'ampToGainDb must be a single-line helper');
  const preamble = `${gainMatch[0]}\n${ampMatch[0]}\n`;

  const gainAt = (db) => vm.runInNewContext(`${preamble}gainDbToAmp(${db});`, { Math });
  const dbAt = (amp) => vm.runInNewContext(`${preamble}ampToGainDb(${amp});`, { Math });

  assert.equal(gainAt(15), 1);
  assert.ok(Math.abs(gainAt(0) - Math.pow(10, -15 / 20)) < 1e-12);
  assert.ok(Math.abs(gainAt(-6) - Math.pow(10, -21 / 20)) < 1e-12);
  assert.ok(Math.abs(dbAt(1) - 15) < 1e-9);
  assert.ok(Math.abs(dbAt(0.5) - (20 * Math.log(0.5) / Math.LN10 + 15)) < 1e-9);
  // Ida y vuelta para varios valores.
  for (const db of [-24, -6, 0, 6, 15, 24]) {
    assert.ok(Math.abs(dbAt(gainAt(db)) - db) < 1e-9, `roundtrip failed for ${db} dB`);
  }
  assert.match(toolkitSource, /gainDbToAmp\(num\(spec\.gainDb, 0\)\)/);
});

// --- d) MCP premiere_toolkit -> bloques de imagen -------------------------
test('MCP premiere_toolkit renderFrame returns a native PNG image block', async (t) => {
  const calls = [];
  const server = createMcpServer({
    sendCommand: async (appTarget, action, params) => {
      calls.push({ appTarget, action, verb: params && params.verb });
      if (action === 'toolkit' && params && params.verb === 'renderFrame') {
        return {
          ok: true,
          sequence: 'Seq Mock',
          time: 1.5,
          timecode: '00:00:01:15',
          path: 'C:/Temp/mock_frame.png',
          base64: TINY_PNG,
        };
      }
      return { ok: false, error: 'unexpected command' };
    },
  });
  const client = await connect(server);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: 'premiere_toolkit',
    arguments: { verb: 'renderFrame', params: { time: 1.5 } },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.content.length, 2);
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.content[1].type, 'image');
  assert.equal(result.content[1].mimeType, 'image/png');
  assert.equal(result.content[1].data, TINY_PNG);

  const meta = JSON.parse(result.content[0].text);
  assert.equal(meta.ok, true);
  assert.equal(meta.sequence, 'Seq Mock');
  assert.equal(meta.timecode, '00:00:01:15');
  assert.ok(!result.content[0].text.includes(TINY_PNG));
  assert.ok(calls.some((call) => call.action === 'toolkit' && call.verb === 'renderFrame'));
});

test('MCP premiere_toolkit contactSheet returns a native JPEG image block and cleans temp PNGs', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pr-sheet-test-'));
  const frames = [];
  try {
    for (const color of ['red', 'green']) {
      const frame = path.join(tmp, `frame_${color}.png`);
      makePng(frame, color);
      frames.push(frame);
    }

    const server = createMcpServer({
      sendCommand: async (appTarget, action, params) => {
        if (action === 'toolkit' && params && params.verb === 'contactSheet') {
          return { ok: true, sequence: 'Seq Mock', times: [0, 1], paths: frames.slice() };
        }
        return { ok: false, error: 'unexpected command' };
      },
    });
    const client = await connect(server);
    t.after(async () => {
      await client.close();
      await server.close();
    });

    const result = await client.callTool({
      name: 'premiere_toolkit',
      arguments: { verb: 'contactSheet', params: { cols: 2, tileWidth: 160 } },
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, 'text');
    assert.equal(result.content[1].type, 'image');
    assert.equal(result.content[1].mimeType, 'image/jpeg');

    const meta = JSON.parse(result.content[0].text);
    assert.equal(meta.ok, true);
    assert.equal(meta.sequence, 'Seq Mock');
    assert.equal(meta.count, 2);
    for (const frame of frames) {
      assert.equal(fs.existsSync(frame), false, `temporary frame should be removed: ${frame}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('client panel reads the Premiere renderFrame PNG as base64', () => {
  assert.match(mainSource, /action === 'toolkit' && params\.verb/);
  assert.match(mainSource, /params\.verb === 'renderFrame'/);
  const toolkitBranch = mainSource.slice(
    mainSource.indexOf("action === 'toolkit' && params.verb"),
    mainSource.indexOf("action === 'getProjectSnapshot'")
  );
  assert.match(toolkitBranch, /readFrameBase64\(write, 0, callback\)/);
  assert.match(mainSource, /sequence: write\.sequence, timecode: write\.timecode/);
});
