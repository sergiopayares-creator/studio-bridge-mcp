import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, buildAdobeGuide } from '../index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const toolkitSource = fs.readFileSync(path.join(here, '../../extension/host/toolkit_ae.jsx'), 'utf8');

// --- Mock AE DOM -----------------------------------------------------------
// The toolkit is an ES3 IIFE that reads AE globals at call time. These mocks
// implement only the DOM surface used by layer/settings/text/textStyle/zStack/
// pose, so the real toolkit source can be executed deterministically.
function makeHarness(layerNames = []) {
  const undo = [];

  function CompItem() {}
  function TextLayer() {}
  function ShapeLayer() {}
  function CameraLayer() {}
  function LightLayer() {}
  function AVLayer() {}

  function propNode(value) {
    const node = {
      value,
      calls: [],
      setCalls: 0,
      dynamic: null,
      valueAtTime(t, preExpression) {
        node.calls.push([t, preExpression]);
        if (typeof node.dynamic === 'function') return node.dynamic(t);
        return node.value;
      },
      setValue(v) {
        node.value = v;
        node.setCalls++;
      },
    };
    return node;
  }

  function group(props) {
    return {
      property(name) {
        return props[name] || null;
      },
    };
  }

  function attachTextDocument(ly) {
    const docEvents = [];
    let fontValue = 'ArialMT';
    const doc = {
      text: '',
      fontSize: 36,
      fillColor: [1, 1, 1],
      tracking: 0,
      leading: 0,
      justification: 0,
      allCaps: false,
    };
    Object.defineProperty(doc, 'font', {
      enumerable: true,
      configurable: true,
      get() {
        return fontValue;
      },
      set(v) {
        fontValue = v;
        docEvents.push('font');
      },
    });
    doc.resetCharStyle = function () {
      docEvents.push('reset');
      doc.allCaps = false;
    };
    const td = {
      value: doc,
      setValue() {
        docEvents.push('setValue');
      },
    };
    ly.textProps = group({ 'ADBE Text Document': td });
    ly.doc = doc;
    ly.docEvents = docEvents;
  }

  function makeLayer(name, kind = 'av') {
    let Constructor = AVLayer;
    if (kind === 'text') Constructor = TextLayer;
    else if (kind === 'shape') Constructor = ShapeLayer;
    else if (kind === 'camera') Constructor = CameraLayer;
    else if (kind === 'light') Constructor = LightLayer;
    const ly = new Constructor();
    ly.name = name;
    ly.enabled = true;
    ly.audioEnabled = true;
    ly.guideLayer = false;
    ly.motionBlur = false;
    ly.samplingQuality = 1;
    ly.threeDLayer = false;
    ly.blendingMode = 1;
    ly.trackMatteType = 0;
    ly.adjustmentLayer = false;
    ly.parent = null;
    ly.inPoint = 0;
    ly.outPoint = 10;
    ly.startTime = 0;
    ly.solo = false;
    ly.locked = false;
    ly.setTrackMatteCalls = [];
    ly.removeTrackMatteCalls = 0;
    ly.props = {
      position: propNode([100, 100]),
      scale: propNode([100, 100]),
      rotation: propNode(0),
      opacity: propNode(100),
      anchor: propNode([0, 0]),
    };
    ly.transform = group({
      'ADBE Position': ly.props.position,
      'ADBE Scale': ly.props.scale,
      'ADBE Rotate Z': ly.props.rotation,
      'ADBE Opacity': ly.props.opacity,
      'ADBE Anchor Point': ly.props.anchor,
    });
    ly.property = function (propertyName) {
      if (propertyName === 'ADBE Transform Group') return ly.transform;
      if (propertyName === 'ADBE Text Properties') return ly.textProps || null;
      return null;
    };
    ly.setTrackMatte = function (matteLayer, mode) {
      ly.setTrackMatteCalls.push([matteLayer.name, mode]);
    };
    ly.removeTrackMatte = function () {
      ly.removeTrackMatteCalls++;
    };
    if (kind === 'text') attachTextDocument(ly);
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
    ly.moveToBeginning = function () {
      const position = comp._layers.indexOf(ly);
      if (position > 0) {
        comp._layers.splice(position, 1);
        comp._layers.unshift(ly);
      }
    };
    ly.moveToEnd = function () {
      const position = comp._layers.indexOf(ly);
      if (position >= 0) {
        comp._layers.splice(position, 1);
        comp._layers.push(ly);
      }
    };
  }

  const comp = new CompItem();
  comp.name = 'C';
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
  comp.layers = {
    addText(text) {
      const ly = makeLayer('Texto', 'text');
      ly.doc.text = String(text || '');
      comp._layers.unshift(ly);
      attachToComp(comp, ly);
      return ly;
    },
    addSolid(color, name) {
      const ly = makeLayer(name || 'Solid');
      comp._layers.unshift(ly);
      attachToComp(comp, ly);
      return ly;
    },
    addNull() {
      const ly = makeLayer('Null');
      comp._layers.unshift(ly);
      attachToComp(comp, ly);
      return ly;
    },
    addShape() {
      const ly = makeLayer('Shape', 'shape');
      comp._layers.unshift(ly);
      attachToComp(comp, ly);
      return ly;
    },
  };

  for (const name of layerNames) {
    const ly = makeLayer(name);
    comp._layers.push(ly);
    attachToComp(comp, ly);
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

// --- layer / settings flags ------------------------------------------------
test('layer and settings apply enabled/audioEnabled/guideLayer/motionBlur/samplingQuality', () => {
  const harness = makeHarness(['Base']);
  const base = harness.layer('Base');

  const settings = call(harness.toolkit, 'settings', {
    comp: 'C',
    layer: 'Base',
    enabled: false,
    audioEnabled: false,
    guideLayer: true,
    motionBlur: true,
    samplingQuality: 'bicubic',
  });
  assert.equal(settings.ok, true);
  assert.equal(base.enabled, false);
  assert.equal(base.audioEnabled, false);
  assert.equal(base.guideLayer, true);
  assert.equal(base.motionBlur, true);
  assert.equal(harness.comp.motionBlur, true);
  assert.equal(base.samplingQuality, 1);
  assert.equal(settings.flags.samplingQuality, 1);
  assert.equal(settings.flags.compMotionBlur, true);

  const created = call(harness.toolkit, 'layer', {
    comp: 'C',
    kind: 'solid',
    name: 'Created',
    enabled: false,
    audioEnabled: false,
    guideLayer: true,
    motionBlur: true,
    samplingQuality: 'bilinear',
  });
  assert.equal(created.ok, true);
  const createdLayer = harness.layer('Created');
  assert.ok(createdLayer, 'layer verb must create the solid');
  assert.equal(createdLayer.enabled, false);
  assert.equal(createdLayer.audioEnabled, false);
  assert.equal(createdLayer.guideLayer, true);
  assert.equal(createdLayer.motionBlur, true);
  assert.equal(createdLayer.samplingQuality, 2);
  assert.equal(created.layer.name, 'Created');
});

test('settings tolerates layers without audio and applies comp motionBlur only when true', () => {
  const harness = makeHarness(['Silent']);
  const layer = harness.layer('Silent');
  Object.defineProperty(layer, 'audioEnabled', {
    configurable: true,
    set() {
      throw new Error('layer has no audio');
    },
    get() {
      return undefined;
    },
  });

  const result = call(harness.toolkit, 'settings', {
    comp: 'C',
    layer: 'Silent',
    audioEnabled: true,
  });
  assert.equal(result.ok, true);
  assert.equal(harness.comp.motionBlur, false);
  assert.match(result.flags.audioEnabledError, /no audio/);
});

// --- track matte -----------------------------------------------------------
test('settings applies setTrackMatte with string and enum modes, including none', () => {
  const harness = makeHarness(['Target', 'Matte']);
  const target = harness.layer('Target');

  const alpha = call(harness.toolkit, 'settings', {
    comp: 'C',
    layer: 'Target',
    trackMatteLayer: 'Matte',
    trackMatte: 'alpha',
  });
  assert.equal(alpha.ok, true);
  assert.equal(alpha.trackMatteApplied, true);
  assert.equal(alpha.trackMatteMode, 1);
  assert.equal(alpha.trackMatteLayer, 'Matte');
  assert.deepEqual(target.setTrackMatteCalls[0], ['Matte', 1]);

  const inverted = call(harness.toolkit, 'settings', {
    comp: 'C',
    layer: 'Target',
    trackMatteLayer: 'Matte',
    trackMatte: 'luma_inverted',
  });
  assert.equal(inverted.trackMatteMode, 4);
  assert.deepEqual(target.setTrackMatteCalls[1], ['Matte', 4]);

  const removed = call(harness.toolkit, 'settings', {
    comp: 'C',
    layer: 'Target',
    trackMatte: 'none',
  });
  assert.equal(removed.trackMatteApplied, true);
  assert.equal(removed.trackMatteMode, 'none');
  assert.equal(target.removeTrackMatteCalls, 1);

  // Without setTrackMatte (older AE) the enum property is the fallback.
  target.setTrackMatte = undefined;
  const legacy = call(harness.toolkit, 'settings', {
    comp: 'C',
    layer: 'Target',
    trackMatteLayer: 'Matte',
    trackMatte: 'luma',
  });
  assert.equal(legacy.trackMatteApplied, true);
  assert.equal(target.trackMatteType, 3);

  const missing = call(harness.toolkit, 'settings', {
    comp: 'C',
    layer: 'Target',
    trackMatteLayer: 'DoesNotExist',
    trackMatte: 'alpha',
  });
  assert.equal(missing.ok, true);
  assert.equal(missing.trackMatteApplied, false);
  assert.match(missing.trackMatteError, /no encontrada/);
});

test('layer accepts trackMatte on creation without failing', () => {
  const harness = makeHarness(['Matte']);
  const result = call(harness.toolkit, 'layer', {
    comp: 'C',
    kind: 'solid',
    name: 'CreatedMatte',
    trackMatteLayer: 'Matte',
    trackMatte: 'alpha_inverted',
  });
  assert.equal(result.ok, true);
  const created = harness.layer('CreatedMatte');
  assert.deepEqual(created.setTrackMatteCalls[0], ['Matte', 2]);
  assert.equal(result.trackMatte.applied, true);
});

// --- text / textStyle ------------------------------------------------------
test('text resets the character style on new layers and applies tracking/leading/allCaps/fillColor', () => {
  const harness = makeHarness([]);
  const result = call(harness.toolkit, 'text', {
    comp: 'C',
    text: 'Hola',
    font: 'Arial-BoldMT',
    fontSize: 48,
    tracking: 12,
    leading: 20,
    allCaps: true,
    fillColor: '#FF0000',
  });
  assert.equal(result.ok, true);
  assert.equal(result.resetCharStyle, true);
  const layer = harness.layer('Texto');
  assert.equal(layer.doc.font, 'Arial-BoldMT');
  assert.equal(layer.doc.fontSize, 48);
  assert.equal(layer.doc.tracking, 12);
  assert.equal(layer.doc.leading, 20);
  assert.equal(layer.doc.allCaps, true);
  assert.deepEqual(Array.from(layer.doc.fillColor), [1, 0, 0]);
  assert.ok(
    layer.docEvents.indexOf('reset') < layer.docEvents.indexOf('font'),
    'resetCharStyle must run before assigning font'
  );
});

test('text resetCharStyle defaults to false on an existing layer and can be forced', () => {
  const harness = makeHarness([]);
  const first = call(harness.toolkit, 'text', { comp: 'C', text: 'Base' });
  assert.equal(first.ok, true);
  const layer = harness.layer('Texto');
  const before = layer.docEvents.filter((event) => event === 'reset').length;

  const edited = call(harness.toolkit, 'text', { comp: 'C', layer: 'Texto', text: 'Editado' });
  assert.equal(edited.resetCharStyle, false);
  assert.equal(layer.docEvents.filter((event) => event === 'reset').length, before);

  const forced = call(harness.toolkit, 'text', {
    comp: 'C',
    layer: 'Texto',
    text: 'Forzado',
    resetCharStyle: true,
  });
  assert.equal(forced.resetCharStyle, true);
  assert.equal(layer.docEvents.filter((event) => event === 'reset').length, before + 1);
});

test('textStyle accepts hex and RGB fillColor, string and numeric justification, and resetCharStyle', () => {
  const harness = makeHarness([]);
  call(harness.toolkit, 'text', { comp: 'C', text: 'Estilo' });
  const layer = harness.layer('Texto');

  const first = call(harness.toolkit, 'textStyle', {
    comp: 'C',
    layer: 'Texto',
    fillColor: '#00FF00',
    justification: 'CENTER_JUSTIFY',
    tracking: 5,
    leading: 15,
    resetCharStyle: true,
  });
  assert.equal(first.ok, true);
  assert.equal(first.resetCharStyle, true);
  assert.deepEqual(Array.from(layer.doc.fillColor), [0, 1, 0]);
  assert.equal(layer.doc.justification, 1);
  assert.equal(layer.doc.tracking, 5);
  assert.equal(layer.doc.leading, 15);

  const second = call(harness.toolkit, 'textStyle', {
    comp: 'C',
    layer: 'Texto',
    fillColor: [0, 0, 1],
    justification: 2,
  });
  assert.equal(second.ok, true);
  assert.deepEqual(layer.doc.fillColor, [0, 0, 1]);
  assert.equal(layer.doc.justification, 2);
  assert.equal(second.resetCharStyle, false);
});

// --- zStack / pose ---------------------------------------------------------
test('zStack orders named layers deterministically and reports optional missing layers', () => {
  const harness = makeHarness(['A', 'B', 'C', 'D', 'Music']);
  const result = call(harness.toolkit, 'zStack', {
    comp: 'C',
    order: ['A', 'C'],
    bottom: ['D', 'Music'],
    // A missing optional layer must not fail the verb.
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ordered, ['A', 'C']);
  assert.deepEqual(result.bottom, ['D', 'Music']);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.stack, ['A', 'C', 'B', 'D', 'Music']);

  const withMissing = call(harness.toolkit, 'zStack', {
    comp: 'C',
    order: ['C', 'Nope'],
    bottom: ['DoesNotExist'],
  });
  assert.equal(withMissing.ok, true);
  assert.deepEqual(withMissing.ordered, ['C']);
  assert.deepEqual(withMissing.missing, ['Nope', 'DoesNotExist']);
  assert.deepEqual(withMissing.stack, ['C', 'A', 'B', 'D', 'Music']);
});

test('zStack resolves index references before moving', () => {
  const harness = makeHarness(['A', 'B', 'C', 'D']);
  const result = call(harness.toolkit, 'zStack', { comp: 'C', order: [2, 3] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ordered, ['B', 'C']);
  assert.deepEqual(result.stack, ['B', 'C', 'A', 'D']);
});

test('pose is read-only, uses valueAtTime(t, false) and reports missing layers', () => {
  const harness = makeHarness(['A', 'B']);
  const a = harness.layer('A');
  const b = harness.layer('B');
  a.parent = b;
  a.props.position.dynamic = (t) => [t * 10, 50];
  a.props.scale.dynamic = (t) => [100 + t, 100];
  b.props.opacity.dynamic = () => 40;

  const result = call(harness.toolkit, 'pose', {
    comp: 'C',
    layers: ['A', 'Nope'],
    time: 2.5,
  });
  assert.equal(result.ok, true);
  assert.equal(result.time, 2.5);
  assert.equal(result.layers.length, 1);
  const poseA = result.layers[0];
  assert.equal(poseA.name, 'A');
  assert.equal(poseA.index, 1);
  assert.equal(poseA.parent, 'B');
  assert.equal(poseA.enabled, true);
  assert.equal(poseA.inPoint, 0);
  assert.equal(poseA.outPoint, 10);
  assert.deepEqual(poseA.position, [25, 50]);
  assert.deepEqual(poseA.scale, [102.5, 100]);
  assert.equal(poseA.rotation, 0);
  assert.equal(poseA.opacity, 100);
  assert.deepEqual(result.missing, ['Nope']);

  // pose must evaluate, never write, and must not open an undo group.
  assert.equal(a.props.position.setCalls, 0);
  assert.equal(a.props.scale.setCalls, 0);
  assert.deepEqual(a.props.position.calls, [[2.5, false]]);
  assert.deepEqual(a.props.scale.calls, [[2.5, false]]);
  assert.deepEqual(harness.undo, []);

  // Without `layers`, pose returns every layer.
  const all = call(harness.toolkit, 'pose', { comp: 'C', time: 1 });
  assert.equal(all.ok, true);
  assert.equal(all.layers.length, 2);
  assert.equal(all.layers[1].name, 'B');
  assert.equal(all.layers[1].opacity, 40);
  assert.deepEqual(harness.undo, []);
});

// --- schema / guide / ES3 --------------------------------------------------
test('aftereffects_toolkit schema and adobe_guide expose zStack and pose', async (t) => {
  const server = createMcpServer();
  const client = new Client({ name: 'phase2-ae-schema-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const { tools } = await client.listTools();
  const ae = tools.find((tool) => tool.name === 'aftereffects_toolkit');
  assert.ok(ae, 'aftereffects_toolkit must exist');
  assert.ok(ae.inputSchema.properties.verb.enum.includes('zStack'));
  assert.ok(ae.inputSchema.properties.verb.enum.includes('pose'));
  assert.match(ae.description, /zStack/);
  assert.match(ae.description, /pose/);

  const guide = buildAdobeGuide('ae');
  assert.ok(guide.aftereffects.verbs.includes('zStack'));
  assert.ok(guide.aftereffects.verbs.includes('pose'));
  assert.ok(guide.aftereffects.notes.some((note) => /pose is read-only/.test(note)));
  assert.ok(guide.aftereffects.notes.some((note) => /zStack/.test(note)));
});

test('toolkit_ae.jsx routes zStack/pose and keeps the ES3 constraints', () => {
  assert.doesNotThrow(() => new vm.Script(toolkitSource, { filename: 'toolkit_ae.jsx' }));
  assert.match(toolkitSource, /function zStack\(p\)/);
  assert.match(toolkitSource, /function pose\(p\)/);
  assert.match(toolkitSource, /if \(verb === 'zStack'\) return zStack\(p\);/);
  assert.match(toolkitSource, /if \(verb === 'pose'\) return pose\(p\);/);
  assert.match(toolkitSource, /if \(verb === 'pose'\) return true;/);
  assert.doesNotMatch(toolkitSource, /\blet\s/);
  assert.doesNotMatch(toolkitSource, /\bconst\s/);
  assert.ok(!toolkitSource.includes('=>'));
  assert.ok(!toolkitSource.includes('`'));
});
