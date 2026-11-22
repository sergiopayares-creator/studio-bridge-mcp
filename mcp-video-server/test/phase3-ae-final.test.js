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
import {
  createMcpServer,
  buildAdobeGuide,
  runAeCompare,
  normalizeCompareTimes,
} from '../index.js';
import { FFMPEG_BIN } from '../lib/ffmpeg.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const toolkitSource = fs.readFileSync(path.join(here, '../../extension/host/toolkit_ae.jsx'), 'utf8');

// --- Mock AE DOM -----------------------------------------------------------
function makeHarness(specs = []) {
  const undo = [];

  function CompItem() {}
  function TextLayer() {}
  function ShapeLayer() {}
  function CameraLayer() {}
  function LightLayer() {}
  function AVLayer() {}

  function propNode(value) {
    return {
      value,
      numKeys: 0,
      expression: '',
      valueAtTimeCalls: [],
      valueAtTime(t, preExpression) {
        this.valueAtTimeCalls.push([t, preExpression]);
        return value;
      },
      setValue(v) {
        this.value = v;
      },
    };
  }

  function makeKeyProp(name, matchName, initialValue, initialKeys) {
    const keys = (initialKeys || []).map((pair) => ({ t: pair[0], v: pair[1] }));
    const prop = {
      name,
      matchName,
      value: initialValue !== undefined ? initialValue : keys.length ? keys[keys.length - 1].v : 0,
      expression: '',
      dimensionsSeparated: false,
      numProperties: 0,
      removeCalls: [],
      setValueCalls: 0,
      setValueAtTimeCalls: [],
      get numKeys() {
        return keys.length;
      },
      keyTime(index) {
        return keys[index - 1].t;
      },
      keyValue(index) {
        return keys[index - 1].v;
      },
      removeKey(index) {
        prop.removeCalls.push(keys[index - 1].t);
        keys.splice(index - 1, 1);
      },
      setValueAtTime(t, v) {
        prop.setValueAtTimeCalls.push([t, v]);
        const existing = keys.find((key) => Math.abs(key.t - t) < 1e-6);
        if (existing) existing.v = v;
        else {
          keys.push({ t, v });
          keys.sort((a, b) => a.t - b.t);
        }
        prop.value = v;
      },
      setValue(v) {
        prop.setValueCalls++;
        prop.value = v;
      },
      keyInInterpolationType() {
        return 1;
      },
      keyOutInterpolationType() {
        return 1;
      },
      get keys() {
        return keys;
      },
    };
    return prop;
  }

  function makeSeparatedPosition(axisSpecs) {
    const children = axisSpecs.map((spec, index) =>
      makeKeyProp(`Position_${index}`, `ADBE Position_${index}`, spec.value, spec.keys)
    );
    const base = {
      name: 'Position',
      matchName: 'ADBE Position',
      value: axisSpecs.map((spec) => spec.value),
      dimensionsSeparated: false,
      numProperties: children.length,
      expression: '',
      property(ref) {
        if (typeof ref === 'number') return children[ref - 1] || null;
        const name = String(ref);
        for (let i = 0; i < children.length; i++) {
          if (children[i].name === name || children[i].matchName === name) return children[i];
        }
        return null;
      },
    };
    return { prop: base, children };
  }

  function group(props) {
    return {
      numProperties: 0,
      property(name) {
        return props[name] || null;
      },
    };
  }

  function makeLayerFromSpec(spec, comp) {
    let Constructor = AVLayer;
    if (spec.kind === 'text') Constructor = TextLayer;
    else if (spec.kind === 'shape') Constructor = ShapeLayer;
    else if (spec.kind === 'camera') Constructor = CameraLayer;
    else if (spec.kind === 'light') Constructor = LightLayer;

    const ly = new Constructor();
    ly.name = spec.name;
    ly.enabled = spec.enabled === undefined ? true : spec.enabled;
    ly.inPoint = spec.inPoint === undefined ? 0 : spec.inPoint;
    ly.outPoint = spec.outPoint === undefined ? comp.duration : spec.outPoint;
    ly.threeDLayer = false;
    ly.blendingMode = 1;
    ly.trackMatteType = 0;
    ly.hasTrackMatte = false;
    ly.adjustmentLayer = spec.adjustmentLayer === true;
    ly.nullLayer = spec.nullLayer === true;
    ly.guideLayer = spec.guideLayer === true;
    ly.hasVideo = spec.hasVideo === undefined ? true : spec.hasVideo;
    ly.hasAudio = spec.hasAudio === undefined ? false : spec.hasAudio;
    ly.parent = null;
    ly.source = null;
    ly.width = spec.width === undefined ? comp.width : spec.width;
    ly.height = spec.height === undefined ? comp.height : spec.height;
    ly.sourceRect = spec.sourceRect || {
      left: 0,
      top: 0,
      width: ly.width,
      height: ly.height,
    };
    ly.sourceRectAtTime = function () {
      return {
        left: ly.sourceRect.left,
        top: ly.sourceRect.top,
        width: ly.sourceRect.width,
        height: ly.sourceRect.height,
      };
    };

    const position = spec.position || [0, 0];
    const scale = spec.scale || [100, 100];
    const rotation = spec.rotation === undefined ? 0 : spec.rotation;
    const opacitySpec = spec.opacity;
    let opacity;
    if (opacitySpec && typeof opacitySpec === 'object') {
      opacity = makeKeyProp('Opacity', 'ADBE Opacity', opacitySpec.value, opacitySpec.keys);
    } else {
      opacity = propNode(opacitySpec === undefined ? 100 : opacitySpec);
    }
    ly.props = {
      position: propNode(position),
      scale: propNode(scale),
      rotation: propNode(rotation),
      opacity,
      anchor: propNode([0, 0]),
    };
    ly.transform = group({
      'ADBE Position': ly.props.position,
      'ADBE Scale': ly.props.scale,
      'ADBE Rotate Z': ly.props.rotation,
      'ADBE Opacity': ly.props.opacity,
      'ADBE Anchor Point': ly.props.anchor,
    });
    ly.textGroup = spec.kind === 'text' ? group({}) : null;
    ly.property = function (name) {
      if (name === 'ADBE Transform Group') return ly.transform;
      if (name === 'ADBE Text Properties') return ly.textGroup;
      if (name === 'Opacity') return ly.props.opacity;
      if (name === 'Position') return ly.props.position;
      if (name === 'Scale') return ly.props.scale;
      if (name === 'Rotation') return ly.props.rotation;
      return null;
    };
    return ly;
  }

  function attachToComp(comp, ly) {
    ly._comp = comp;
    Object.defineProperty(ly, 'index', {
      configurable: true,
      get() {
        return comp._layers.indexOf(ly) + 1;
      },
    });
  }

  const comp = new CompItem();
  comp.name = 'C';
  comp.id = 1;
  comp.width = 1920;
  comp.height = 1080;
  comp.pixelAspect = 1;
  comp.duration = 10;
  comp.frameRate = 30;
  comp.time = 0;
  comp.motionBlur = false;
  comp.selectedLayers = [];
  comp._layers = [];
  Object.defineProperty(comp, 'numLayers', {
    get() {
      return comp._layers.length;
    },
  });
  comp.layer = function (index) {
    return comp._layers[index - 1];
  };

  for (const spec of specs) {
    const ly = makeLayerFromSpec(spec, comp);
    comp._layers.push(ly);
    attachToComp(comp, ly);
  }
  for (const spec of specs) {
    if (!spec.parent) continue;
    const ly = comp._layers.find((item) => item.name === spec.name);
    const parent = comp._layers.find((item) => item.name === spec.parent);
    if (ly && parent) ly.parent = parent;
  }

  const app = {
    project: {
      activeItem: comp,
      numItems: 1,
      item(index) {
        return index === 1 ? comp : null;
      },
    },
    beginUndoGroup(label) {
      undo.push(String(label));
    },
    endUndoGroup() {
      undo.push('end');
    },
  };

  const context = vm.createContext({
    $: { global: {}, sleep() {} },
    app,
    CompItem,
    TextLayer,
    ShapeLayer,
    CameraLayer,
    LightLayer,
    AVLayer,
    Folder: { temp: { fsName: os.tmpdir() } },
    File: function (filePath) {
      this.fsName = filePath;
      this.exists = false;
      this.length = 0;
    },
    BlendingMode: { OVERLAY: 1, NORMAL: 2 },
    TrackMatteType: { NO_TRACK_MATTE: 0, ALPHA: 1, ALPHA_INVERTED: 2, LUMA: 3, LUMA_INVERTED: 4 },
    LayerSamplingQuality: { BICUBIC: 1, BILINEAR: 2 },
    ParagraphJustification: { LEFT_JUSTIFY: 0, CENTER_JUSTIFY: 1, RIGHT_JUSTIFY: 2 },
    KeyframeInterpolationType: { HOLD: 1, BEZIER: 2, LINEAR: 3 },
  });
  vm.runInContext(toolkitSource, context, { filename: 'toolkit_ae.jsx' });
  const toolkit = context.$.global.AntigravityToolkitAE;
  return { toolkit, comp, app, undo, layer: (name) => comp._layers.find((ly) => ly.name === name) };
}

function call(toolkit, verb, params) {
  return JSON.parse(toolkit.dispatch({ verb, params }));
}

function issuesWithCode(result, code) {
  return result.issues.filter((issue) => issue.code === code);
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

function makePng(file, color) {
  execFileSync(
    FFMPEG_BIN,
    ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=160x90:d=1`, '-frames:v', '1', file],
    { stdio: 'ignore' }
  );
}

function makeReferenceVideo(file) {
  execFileSync(
    FFMPEG_BIN,
    [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x180:rate=10:duration=3',
      '-pix_fmt',
      'yuv420p',
      file,
    ],
    { stdio: 'ignore' }
  );
}

async function startMcpServer(t, sendCommand) {
  const server = createMcpServer({ sendCommand });
  const client = new Client({ name: 'phase3-ae-final-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return { client, server };
}

// --- 1) afterTime / ensureKeysAfter ---------------------------------------
test('set with afterTime removes only keys > afterTime and keeps the earlier ones', () => {
  const harness = makeHarness([{ name: 'L' }]);
  const layer = harness.layer('L');
  const prop = {
    name: 'Opacity',
    matchName: 'ADBE Opacity',
    value: 0,
    expression: '',
    numProperties: 0,
    removeCalls: [],
    setValueCalls: 0,
    setValueAtTimeCalls: [],
    keys: [
      { t: 0, v: 100 },
      { t: 1, v: 80 },
      { t: 2, v: 40 },
      { t: 3, v: 0 },
    ],
    get numKeys() {
      return prop.keys.length;
    },
    keyTime(index) {
      return prop.keys[index - 1].t;
    },
    keyValue(index) {
      return prop.keys[index - 1].v;
    },
    removeKey(index) {
      prop.removeCalls.push(prop.keys[index - 1].t);
      prop.keys.splice(index - 1, 1);
    },
    setValueAtTime(t, v) {
      prop.setValueAtTimeCalls.push([t, v]);
      const existing = prop.keys.find((key) => Math.abs(key.t - t) < 1e-6);
      if (existing) existing.v = v;
      else {
        prop.keys.push({ t, v });
        prop.keys.sort((a, b) => a.t - b.t);
      }
      prop.value = v;
    },
    setValue(v) {
      prop.setValueCalls++;
      prop.value = v;
    },
  };
  layer.props.opacity = prop;
  layer.property = function (name) {
    if (name === 'ADBE Transform Group') return layer.transform;
    if (name === 'Opacity') return prop;
    return null;
  };

  const result = call(harness.toolkit, 'set', {
    comp: 'C',
    layer: 'L',
    path: 'Opacity',
    afterTime: 1.5,
    keyframes: [[2.5, 60], [4, 20]],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(prop.keys.map((key) => key.t), [0, 1, 2.5, 4]);
  assert.deepEqual(prop.removeCalls, [3, 2]);
  assert.equal(prop.setValueCalls, 0, 'afterTime must not use setValue');
  assert.match(result.notes.join(','), /keysAfterRemoved=2/);
});

test('ensureKeysAfter wraps set with afterTime and preserves keys <= afterTime', () => {
  const harness = makeHarness([{ name: 'L' }]);
  const layer = harness.layer('L');
  const prop = {
    name: 'Opacity',
    matchName: 'ADBE Opacity',
    value: 0,
    expression: '',
    numProperties: 0,
    removeCalls: [],
    setValueCalls: 0,
    keys: [
      { t: 0, v: 100 },
      { t: 1, v: 80 },
      { t: 1.5004, v: 70 },
      { t: 2, v: 40 },
    ],
    get numKeys() {
      return prop.keys.length;
    },
    keyTime(index) {
      return prop.keys[index - 1].t;
    },
    keyValue(index) {
      return prop.keys[index - 1].v;
    },
    removeKey(index) {
      prop.removeCalls.push(prop.keys[index - 1].t);
      prop.keys.splice(index - 1, 1);
    },
    setValueAtTime(t, v) {
      const existing = prop.keys.find((key) => Math.abs(key.t - t) < 1e-6);
      if (existing) existing.v = v;
      else {
        prop.keys.push({ t, v });
        prop.keys.sort((a, b) => a.t - b.t);
      }
      prop.value = v;
    },
    setValue(v) {
      prop.setValueCalls++;
      prop.value = v;
    },
  };
  layer.property = function (name) {
    if (name === 'Opacity') return prop;
    return null;
  };

  const result = call(harness.toolkit, 'ensureKeysAfter', {
    comp: 'C',
    layer: 'L',
    path: 'Opacity',
    afterTime: 1.5,
    keyframes: [[2.5, 30], [4, 10]],
    value: 999,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(prop.keys.map((key) => key.t), [0, 1, 1.5004, 2.5, 4]);
  assert.deepEqual(prop.removeCalls, [2]);
  assert.equal(prop.setValueCalls, 0, 'the wrapper must ignore value/expression');
  assert.match(result.notes.join(','), /keysAfterRemoved=1/);
});

test('ensureKeysAfter with xKeyframes/yKeyframes cleans each separated dimension', () => {
  const harness = makeHarness([{ name: 'L' }]);
  const layer = harness.layer('L');
  const separated = (() => {
    const children = [
      { name: 'Position_0', matchName: 'ADBE Position_0', value: 0, keys: [{ t: 0, v: 0 }, { t: 1, v: 10 }, { t: 2, v: 20 }, { t: 3, v: 30 }] },
      { name: 'Position_1', matchName: 'ADBE Position_1', value: 0, keys: [{ t: 0, v: 0 }, { t: 1, v: 10 }, { t: 2, v: 20 }, { t: 3, v: 30 }] },
    ];
    const props = children.map((child) => ({
      name: child.name,
      matchName: child.matchName,
      value: child.value,
      expression: '',
      numProperties: 0,
      removeCalls: [],
      setValueCalls: 0,
      keys: child.keys,
      get numKeys() {
        return this.keys.length;
      },
      keyTime(index) {
        return this.keys[index - 1].t;
      },
      keyValue(index) {
        return this.keys[index - 1].v;
      },
      removeKey(index) {
        this.removeCalls.push(this.keys[index - 1].t);
        this.keys.splice(index - 1, 1);
      },
      setValueAtTime(t, v) {
        const existing = this.keys.find((key) => Math.abs(key.t - t) < 1e-6);
        if (existing) existing.v = v;
        else {
          this.keys.push({ t, v });
          this.keys.sort((a, b) => a.t - b.t);
        }
        this.value = v;
      },
      setValue(v) {
        this.setValueCalls++;
        this.value = v;
      },
    }));
    const base = {
      name: 'Position',
      matchName: 'ADBE Position',
      value: [0, 0],
      dimensionsSeparated: false,
      numProperties: 2,
      expression: '',
      property(ref) {
        return typeof ref === 'number' ? props[ref - 1] || null : props.find((p) => p.name === String(ref) || p.matchName === String(ref)) || null;
      },
    };
    return { base, props };
  })();

  layer.transform = {
    numProperties: 0,
    property(name) {
      if (name === 'ADBE Position') return separated.base;
      return null;
    },
  };
  layer.property = function (name) {
    if (name === 'ADBE Transform Group') return layer.transform;
    if (name === 'Position') return separated.base;
    return null;
  };

  const result = call(harness.toolkit, 'ensureKeysAfter', {
    comp: 'C',
    layer: 'L',
    path: 'Position',
    afterTime: 1.5,
    xKeyframes: [[2.5, 25], [4, 40]],
    yKeyframes: [[2.5, 35], [4, 50]],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(separated.props[0].keys.map((key) => key.t), [0, 1, 2.5, 4]);
  assert.deepEqual(separated.props[1].keys.map((key) => key.t), [0, 1, 2.5, 4]);
  assert.deepEqual(separated.props[0].removeCalls, [3, 2]);
  assert.deepEqual(separated.props[1].removeCalls, [3, 2]);
  assert.equal(separated.props[0].setValueCalls, 0);
  assert.equal(separated.props[1].setValueCalls, 0);
});

// --- 2) check: alwaysZeroOpacity / layerCoversText ------------------------
test('check warns alwaysZeroOpacity for active zero-opacity layers, ignoring Nulls and audio-only', () => {
  const harness = makeHarness([
    { name: 'HiddenSolid', opacity: 0, width: 400, height: 300, sourceRect: { left: 100, top: 100, width: 400, height: 300 } },
    {
      name: 'FadeZero',
      opacity: { value: 0, keys: [[0, 0], [1, 0], [2, 0]] },
      width: 300,
      height: 200,
      sourceRect: { left: 200, top: 200, width: 300, height: 200 },
    },
    { name: 'NullHidden', nullLayer: true, opacity: 0 },
    { name: 'AudioOnly', hasVideo: false, hasAudio: true, opacity: 0 },
    { name: 'Visible', opacity: 100 },
  ]);

  const result = call(harness.toolkit, 'check', { comp: 'C', time: 1 });
  assert.equal(result.ok, true);
  const warnings = issuesWithCode(result, 'alwaysZeroOpacity');
  assert.deepEqual(warnings.map((issue) => issue.layer).sort(), ['FadeZero', 'HiddenSolid']);
});

test('check warns layerCoversText only for an active non-background layer above the text', () => {
  const harness = makeHarness([
    {
      name: 'Background',
      width: 1920,
      height: 1080,
      sourceRect: { left: 0, top: 0, width: 1920, height: 1080 },
    },
    {
      name: 'ParentVisual',
      width: 250,
      height: 100,
      sourceRect: { left: 350, top: 650, width: 250, height: 100 },
    },
    {
      name: 'Logo',
      kind: 'shape',
      width: 250,
      height: 100,
      sourceRect: { left: 350, top: 650, width: 250, height: 100 },
    },
    {
      name: 'Lower Third',
      kind: 'text',
      sourceRect: { left: 300, top: 700, width: 400, height: 100 },
    },
    { name: 'NullCover', nullLayer: true },
    { name: 'GuideCover', guideLayer: true },
    { name: 'Child', parent: 'ParentVisual' },
  ]);

  const result = call(harness.toolkit, 'check', { comp: 'C', time: 1 });
  assert.equal(result.ok, true);
  const covers = issuesWithCode(result, 'layerCoversText');
  assert.equal(covers.length, 1, 'only Logo should be reported');
  assert.equal(covers[0].layer, 'Logo');
  assert.match(covers[0].message, /Logo/);
  assert.match(covers[0].message, /Lower Third/);

  // check must evaluate the overlap at the requested time, not at comp.time.
  const logo = harness.layer('Logo');
  assert.ok(
    logo.props.position.valueAtTimeCalls.some((entry) => entry[0] === 1 && entry[1] === false),
    'worldBounds must use valueAtTime(1, false)'
  );
});

// --- 3) compare ------------------------------------------------------------
test('MCP aftereffects_toolkit compare returns one REF|AE JPEG and cleans AE temp frames', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-phase3-compare-'));
  try {
    await withWritableRoots(tmp, async () => {
      const reference = path.join(tmp, 'reference.mp4');
      makeReferenceVideo(reference);
      const frames = [path.join(tmp, 'ae_0.png'), path.join(tmp, 'ae_1.png')];
      makePng(frames[0], 'red');
      makePng(frames[1], 'blue');
      const output = path.join(tmp, 'compare.jpg');

      const calls = [];
      const { client } = await startMcpServer(t, async (appTarget, action, params) => {
        calls.push({ appTarget, action, params });
        if (action === 'toolkit_ae' && params && params.verb === 'contactSheet') {
          return { ok: true, comp: 'MockComp', times: [0.5, 1.5], paths: frames.slice() };
        }
        return { ok: false, error: 'unexpected command' };
      });

      const result = await client.callTool({
        name: 'aftereffects_toolkit',
        arguments: {
          verb: 'compare',
          params: {
            comp: 'MockComp',
            referencePath: reference,
            times: [0.5, 1.5],
            outputPath: output,
            tileWidth: 160,
          },
        },
      });

      assert.equal(result.isError, undefined, result.content[0] && result.content[0].text);
      assert.equal(result.content.length, 2, 'one text block + one image block');
      assert.equal(result.content[1].type, 'image');
      assert.equal(result.content[1].mimeType, 'image/jpeg');
      assert.ok(!result.content[0].text.includes(result.content[1].data.slice(0, 96)));

      const meta = JSON.parse(result.content[0].text);
      assert.equal(meta.ok, true);
      assert.equal(meta.action, 'compare');
      assert.equal(meta.comp, 'MockComp');
      assert.equal(meta.path, path.resolve(output));
      assert.equal(meta.referencePath, path.resolve(reference));
      assert.deepEqual(meta.times, [0.5, 1.5]);
      assert.equal(meta.count, 2);
      assert.equal(meta.mimeType, 'image/jpeg');
      assert.ok(fs.existsSync(output));
      const bytes = fs.readFileSync(output);
      assert.equal(bytes[0], 0xff);
      assert.equal(bytes[1], 0xd8);

      for (const frame of frames) {
        assert.equal(fs.existsSync(frame), false, `AE temp frame must be removed: ${frame}`);
      }
      assert.ok(fs.existsSync(reference), 'reference video must stay untouched');
      assert.ok(calls.some((callItem) => callItem.params.verb === 'contactSheet'));
      assert.deepEqual(calls[0].params.params.times, [0.5, 1.5]);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('compare validates referencePath, times and the writable output path', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-phase3-compare-validation-'));
  try {
    const missing = path.join(tmp, 'missing.mp4');
    const output = path.join(tmp, 'out.jpg');
    await assert.rejects(
      () => runAeCompare({ referencePath: missing, times: [0], path: output }, async () => ({ ok: true, paths: [] })),
      /File does not exist/
    );
    assert.throws(() => normalizeCompareTimes([]), /al menos un tiempo/);
    assert.throws(() => normalizeCompareTimes([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]), /máximo 16/);

    // The MCP gate must reject an output outside ANTIGRAVITY_WRITABLE_ROOTS.
    const { client } = await startMcpServer(t, async () => {
      throw new Error('must not reach the bridge');
    });
    await withWritableRoots(tmp, async () => {
      const outside = path.join(os.tmpdir(), 'phase3-outside-compare.jpg');
      const result = await client.callTool({
        name: 'aftereffects_toolkit',
        arguments: {
          verb: 'compare',
          params: { referencePath: missing, times: [0], path: outside },
        },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /outside the allowed roots/);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- 4) schema / guide / ES3 ----------------------------------------------
test('schema and adobe_guide expose ensureKeysAfter, compare and the new check warnings', async (t) => {
  const { client } = await startMcpServer(t, async () => ({ ok: false, error: 'unused' }));
  const { tools } = await client.listTools();
  const ae = tools.find((tool) => tool.name === 'aftereffects_toolkit');
  assert.ok(ae);
  assert.ok(ae.inputSchema.properties.verb.enum.includes('ensureKeysAfter'));
  assert.ok(ae.inputSchema.properties.verb.enum.includes('compare'));
  assert.match(ae.description, /ensureKeysAfter/);
  assert.match(ae.description, /compare/);
  assert.match(ae.description, /alwaysZeroOpacity/);

  const guide = buildAdobeGuide('ae');
  assert.ok(guide.aftereffects.verbs.includes('ensureKeysAfter'));
  assert.ok(guide.aftereffects.verbs.includes('compare'));
  assert.ok(guide.aftereffects.notes.some((note) => /ensureKeysAfter/.test(note)));
  assert.ok(guide.aftereffects.notes.some((note) => /alwaysZeroOpacity/.test(note)));
  assert.ok(guide.aftereffects.notes.some((note) => /layerCoversText/.test(note)));
  assert.ok(guide.aftereffects.notes.some((note) => /compare is read-only/.test(note)));
});

test('toolkit_ae.jsx routes ensureKeysAfter and check additions while staying ES3', () => {
  assert.doesNotThrow(() => new vm.Script(toolkitSource, { filename: 'toolkit_ae.jsx' }));
  assert.match(toolkitSource, /function removeKeysAfter\(prop, afterTime\)/);
  assert.match(toolkitSource, /function ensureKeysAfter\(p\)/);
  assert.match(toolkitSource, /if \(verb === 'ensureKeysAfter'\) return ensureKeysAfter\(p\);/);
  assert.match(toolkitSource, /alwaysZeroOpacity/);
  assert.match(toolkitSource, /layerCoversText/);
  assert.doesNotMatch(toolkitSource, /\blet\s/);
  assert.doesNotMatch(toolkitSource, /\bconst\s/);
  assert.ok(!toolkitSource.includes('=>'));
  assert.ok(!toolkitSource.includes('`'));
});
