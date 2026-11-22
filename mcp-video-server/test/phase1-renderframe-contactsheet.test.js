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
import { createMcpServer, assertExpectedProject, normalizeToolkitParams } from '../index.js';
import { buildContactSheetJpeg, normalizeRenderFrameParams } from '../lib/aftereffects.js';
import { assertWritablePath } from '../lib/security.js';
import { FFMPEG_BIN } from '../lib/ffmpeg.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeSource = fs.readFileSync(path.join(here, '../../extension/host/bridge.jsx'), 'utf8');
const toolkitSource = fs.readFileSync(path.join(here, '../../extension/host/toolkit_ae.jsx'), 'utf8');
const mainSource = fs.readFileSync(path.join(here, '../../extension/client/js/main.js'), 'utf8');

// 1x1 transparent PNG used as the mock renderFrame payload.
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function makePng(file, color) {
  execFileSync(
    FFMPEG_BIN,
    ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=160x90:d=1`, '-frames:v', '1', file],
    { stdio: 'ignore' }
  );
}

function startMcpServer(t, sendCommand) {
  const server = createMcpServer({ sendCommand });
  const client = new Client({ name: 'phase1-renderframe-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  return Promise.all([client.connect(clientTransport), server.connect(serverTransport)]).then(() => {
    t.after(async () => {
      await client.close();
      await server.close();
    });
    return { client, server };
  });
}

async function withWritableRoots(root, fn) {
  const previous = process.env.ANTIGRAVITY_WRITABLE_ROOTS;
  process.env.ANTIGRAVITY_WRITABLE_ROOTS = root;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.ANTIGRAVITY_WRITABLE_ROOTS;
    else process.env.ANTIGRAVITY_WRITABLE_ROOTS = previous;
  }
}

function hasSystemDrawtextFont() {
  const windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    path.join(windir, 'Fonts', 'arial.ttf'),
    path.join(windir, 'Fonts', 'segoeui.ttf'),
    path.join(windir, 'Fonts', 'consola.ttf'),
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
  ];
  return candidates.some((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch (_) {
      return false;
    }
  });
}

function runBridgeHost(app) {
  const context = vm.createContext({
    app,
    BridgeTalk: { appName: 'aftereffects' },
    JSON,
    Math,
    Date,
    String,
    Number,
    Object,
    Array,
    isFinite,
  });
  vm.runInContext(bridgeSource, context, { filename: 'bridge.jsx' });
  return context.AntigravityBridge;
}

// --- 1) renderFrame path / outputPath --------------------------------------
test('normalizeRenderFrameParams accepts path and outputPath and rejects paths outside the writable roots', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-phase1-paths-'));
  try {
    await withWritableRoots(tmp, async () => {
      const aliasTarget = path.join(tmp, 'frame alias.png');
      const viaAlias = normalizeToolkitParams('renderFrame', { outputPath: aliasTarget, time: 2 });
      assert.equal(viaAlias.path, path.resolve(aliasTarget));
      assert.equal(viaAlias.outputPath, undefined);
      assert.equal(viaAlias.time, 2);

      const directTarget = path.join(tmp, 'frame direct.png');
      const viaPath = normalizeRenderFrameParams({ path: directTarget, time: 1 });
      assert.equal(viaPath.path, path.resolve(directTarget));

      const sheetTarget = path.join(tmp, 'sheet output.jpg');
      const viaSheetAlias = normalizeToolkitParams('contactSheet', { outputPath: sheetTarget });
      assert.equal(viaSheetAlias.path, path.resolve(sheetTarget));

      // `path` wins when both aliases are supplied.
      const both = normalizeToolkitParams('renderFrame', {
        path: path.join(tmp, 'a.png'),
        outputPath: path.join(tmp, 'b.png'),
      });
      assert.equal(both.path, path.resolve(path.join(tmp, 'a.png')));

      // security.js is the gate: no silent write outside ANTIGRAVITY_WRITABLE_ROOTS.
      const outside = path.join(os.tmpdir(), 'phase1-outside-frame.png');
      assert.throws(
        () => assertWritablePath(outside),
        /outside the allowed roots/
      );
      assert.throws(
        () => normalizeToolkitParams('renderFrame', { outputPath: outside }),
        /outside the allowed roots/
      );
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('MCP aftereffects_toolkit renderFrame honors path/outputPath exactly and never deletes the file', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-phase1-render-'));
  try {
    await withWritableRoots(tmp, async () => {
      const targets = [path.join(tmp, 'explicit-path.png'), path.join(tmp, 'explicit-output-path.png')];
      const sent = [];
      const { client } = await startMcpServer(t, async (appTarget, action, params) => {
        sent.push({ appTarget, action, params });
        if (action === 'toolkit_ae' && params && params.verb === 'renderFrame') {
          // Emulate the host writing the PNG exactly at the requested path.
          fs.writeFileSync(params.params.path, Buffer.from(TINY_PNG, 'base64'));
          return { ok: true, comp: 'MockComp', time: 1.25, path: params.params.path, temp: false, base64: TINY_PNG };
        }
        return { ok: false, error: 'unexpected command' };
      });

      for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        const params = i === 0 ? { time: 1.25, path: target } : { time: 1.25, outputPath: target };
        const result = await client.callTool({
          name: 'aftereffects_toolkit',
          arguments: { verb: 'renderFrame', params },
        });

        assert.equal(result.isError, undefined);
        assert.equal(result.content.length, 2);
        assert.equal(result.content[1].type, 'image');
        assert.equal(result.content[1].mimeType, 'image/png');

        const meta = JSON.parse(result.content[0].text);
        assert.equal(meta.ok, true);
        assert.equal(meta.comp, 'MockComp');
        assert.equal(meta.path, path.resolve(target));
        assert.equal(meta.mimeType, 'image/png');

        // The requested PNG must still be on disk after the tool answers.
        assert.ok(fs.existsSync(target), `explicit renderFrame output must not be deleted: ${target}`);
        assert.ok(fs.statSync(target).size > 0);

        const call = sent[sent.length - 1];
        assert.equal(call.params.params.path, path.resolve(target));
        assert.equal(call.params.params.outputPath, undefined);
      }
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('MCP renderFrame rejects an outputPath outside ANTIGRAVITY_WRITABLE_ROOTS before touching the bridge', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-phase1-outside-'));
  try {
    await withWritableRoots(tmp, async () => {
      let calls = 0;
      const { client } = await startMcpServer(t, async () => {
        calls++;
        return { ok: false, error: 'must not be called' };
      });
      const outside = path.join(os.tmpdir(), 'phase1-forbidden-frame.png');
      const result = await client.callTool({
        name: 'aftereffects_toolkit',
        arguments: { verb: 'renderFrame', params: { time: 0, outputPath: outside } },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /outside the allowed roots/);
      assert.equal(calls, 0, 'the bridge must not receive an unvalidated output path');
      assert.equal(fs.existsSync(outside), false);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('toolkit_ae.jsx waits for saveFrameToPng on explicit paths and aligns contactSheet times', () => {
  assert.doesNotThrow(() => new vm.Script(toolkitSource, { filename: 'toolkit_ae.jsx' }));
  const renderBody = toolkitSource.slice(
    toolkitSource.indexOf('function renderFrame(p)'),
    toolkitSource.indexOf('// Contexto de la GUI')
  );
  assert.match(renderBody, /p\.outputPath/);
  assert.match(renderBody, /waitForFileWritten\(file, 10000\)/);
  assert.match(renderBody, /written: true/);
  assert.match(renderBody, /path: file\.fsName/);
  assert.doesNotMatch(renderBody, /unlink/);

  const sheetBody = toolkitSource.slice(
    toolkitSource.indexOf('function contactSheet(p)'),
    toolkitSource.indexOf('// Mapa único de verbos')
  );
  assert.match(sheetBody, /pathTimes/);
  assert.match(sheetBody, /times: readyTimes/);

  // The panel only removes frames the host marked as temporary; an explicit
  // renderFrame path (temp:false) must survive.
  assert.match(mainSource, /if \(write\.temp\) scheduleFrameCleanup\(write\.path\)/);
});

// --- 2) contactSheet -> ONE JPEG with timestamps ----------------------------
test('buildContactSheetJpeg returns one JPEG with per-tile timestamps and removes temp PNGs', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-phase1-sheet-'));
  try {
    await withWritableRoots(tmp, async () => {
      const frames = ['red', 'green', 'blue', 'yellow'].map((color, i) => {
        const file = path.join(tmp, `frame_${i}.png`);
        makePng(file, color);
        return file;
      });
      const out = path.join(tmp, 'mosaic.jpg');
      const sheet = await buildContactSheetJpeg(
        { ok: true, comp: 'MockComp', times: [0, 1, 2.5, 3], paths: frames.slice() },
        { path: out, cols: 2, tileWidth: 160 }
      );

      assert.equal(sheet.count, 4);
      assert.equal(sheet.cols, 2);
      assert.equal(sheet.rows, 2);
      assert.deepEqual(sheet.times, [0, 1, 2.5, 3]);
      assert.equal(sheet.path, path.resolve(out));
      assert.equal(sheet.timestampsBurned, hasSystemDrawtextFont());
      assert.ok(fs.existsSync(out));
      const bytes = fs.readFileSync(out);
      assert.equal(bytes[0], 0xff, 'JPEG SOI marker');
      assert.equal(bytes[1], 0xd8, 'JPEG SOI marker');
      assert.ok(bytes.length > 100);

      // Intermediate host PNGs are temporary and removed.
      for (const frame of frames) {
        assert.equal(fs.existsSync(frame), false, `intermediate PNG must be removed: ${frame}`);
      }
      // The composed JPEG is the deliverable and survives.
      assert.ok(fs.existsSync(out));
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('MCP aftereffects_toolkit contactSheet returns exactly one JPEG image block', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-phase1-mcp-sheet-'));
  try {
    await withWritableRoots(tmp, async () => {
      const frames = ['red', 'green'].map((color, i) => {
        const file = path.join(tmp, `frame_${i}.png`);
        makePng(file, color);
        return file;
      });
      const out = path.join(tmp, 'mcp-sheet.jpg');
      const { client } = await startMcpServer(t, async (appTarget, action, params) => {
        if (action === 'toolkit_ae' && params && params.verb === 'contactSheet') {
          return { ok: true, comp: 'MockComp', times: [0, 2], paths: frames.slice() };
        }
        return { ok: false, error: 'unexpected command' };
      });

      const result = await client.callTool({
        name: 'aftereffects_toolkit',
        arguments: { verb: 'contactSheet', params: { path: out, cols: 2, tileWidth: 160 } },
      });

      assert.equal(result.isError, undefined);
      assert.equal(result.content.length, 2, 'exactly one text block + one image block');
      assert.equal(result.content[1].type, 'image');
      assert.equal(result.content[1].mimeType, 'image/jpeg');
      assert.ok(!result.content[0].text.includes(result.content[1].data.slice(0, 96)));

      const meta = JSON.parse(result.content[0].text);
      assert.equal(meta.ok, true);
      assert.equal(meta.action, 'contactSheet');
      assert.equal(meta.comp, 'MockComp');
      assert.equal(meta.mimeType, 'image/jpeg');
      assert.equal(meta.count, 2);
      assert.deepEqual(meta.times, [0, 2]);
      assert.equal(meta.path, path.resolve(out));
      assert.equal(meta.outputPath, path.resolve(out));
      assert.ok(fs.existsSync(out));
      for (const frame of frames) {
        assert.equal(fs.existsSync(frame), false);
      }
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- 3) expected_project single retry -------------------------------------
test('assertExpectedProject retries exactly once on a transient timeout', async () => {
  let calls = 0;
  const guard = await assertExpectedProject(
    'aftereffects',
    'Demo.aep',
    async () => {
      calls++;
      if (calls === 1) return { success: false, error: 'CEP bridge request timed out after 20000ms.' };
      return { success: true, projectName: 'Demo.aep' };
    },
    { retryDelayMs: 0, sleep: async () => {} }
  );
  assert.equal(calls, 2);
  assert.equal(guard.retried, true);
  assert.equal(guard.attempts, 2);
  assert.equal(guard.verified, true);
});

test('assertExpectedProject aborts after one retry when the timeout persists', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      assertExpectedProject(
        'aftereffects',
        'Demo.aep',
        async () => {
          calls++;
          return { success: false, error: 'timed out after 20000ms' };
        },
        { retryDelayMs: 0, sleep: async () => {} }
      ),
    /could not verify the active project.*after 2 attempts.*fail-closed/s
  );
  assert.equal(calls, 2);
});

test('assertExpectedProject does not retry a mismatch or a non-timeout error', async () => {
  let mismatchCalls = 0;
  await assert.rejects(
    () =>
      assertExpectedProject(
        'aftereffects',
        'Demo.aep',
        async () => {
          mismatchCalls++;
          return { success: true, projectName: 'Otro.aep' };
        },
        { retryDelayMs: 0, sleep: async () => {} }
      ),
    /expected_project mismatch/
  );
  assert.equal(mismatchCalls, 1);

  let errorCalls = 0;
  await assert.rejects(
    () =>
      assertExpectedProject(
        'aftereffects',
        'Demo.aep',
        async () => {
          errorCalls++;
          return { success: false, error: 'No active Adobe CEP extension' };
        },
        { retryDelayMs: 0, sleep: async () => {} }
      ),
    /could not verify the active project/
  );
  assert.equal(errorCalls, 1);
});

// --- 4) ExtendScript eval: last expression + err.line ---------------------
test('evalCustom preserves the last expression / IIFE value and reports err.line', () => {
  const app = {
    name: 'Adobe After Effects',
    project: {},
    beginUndoGroup() {},
    endUndoGroup() {},
  };
  const bridge = runBridgeHost(app);

  const number = JSON.parse(bridge.evalCustom('1 + 2'));
  assert.deepEqual(number, { success: true, result: 3 });

  // Completion value of the last statement, not undefined.
  const statements = JSON.parse(bridge.evalCustom('var a = 2; a * 3'));
  assert.equal(statements.success, true);
  assert.equal(statements.result, 6);

  // Top-level `return` is not a valid eval program: the new Function fallback
  // must keep working.
  const topLevelReturn = JSON.parse(bridge.evalCustom('return 7;'));
  assert.equal(topLevelReturn.success, true);
  assert.equal(topLevelReturn.result, 7);

  // Strings are not lost either.
  const text = JSON.parse(bridge.evalCustom('"hola"'));
  assert.equal(text.result, 'hola');

  // IIFE returning an object: serialized as an object, not "[object Object]".
  const iife = JSON.parse(bridge.evalCustom('(function(){ return { ok: true, n: 5 }; })()'));
  assert.equal(iife.success, true);
  assert.deepEqual(iife.result, { ok: true, n: 5 });

  const failure = JSON.parse(
    bridge.evalCustom('(function(){ var e = new Error("boom"); e.line = 42; throw e; })()')
  );
  assert.equal(failure.success, false);
  assert.match(failure.error, /boom/);
  assert.equal(failure.line, 42);
});

test('aftereffects_execute_extendscript returns error and line from the host', async (t) => {
  const previous = process.env.STUDIO_BRIDGE_ALLOW_ARBITRARY_JS;
  process.env.STUDIO_BRIDGE_ALLOW_ARBITRARY_JS = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.STUDIO_BRIDGE_ALLOW_ARBITRARY_JS;
    else process.env.STUDIO_BRIDGE_ALLOW_ARBITRARY_JS = previous;
  });

  const { client } = await startMcpServer(t, async (appTarget, action, params) => {
    assert.equal(appTarget, 'aftereffects');
    assert.equal(action, 'evalCustom');
    assert.match(params.code, /throw/);
    return { success: false, error: 'boom (line 7)', line: 7 };
  });

  const result = await client.callTool({
    name: 'aftereffects_execute_extendscript',
    arguments: { script: 'throw new Error("boom");' },
  });
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.success, false);
  assert.equal(payload.error, 'boom (line 7)');
  assert.equal(payload.line, 7);
});
