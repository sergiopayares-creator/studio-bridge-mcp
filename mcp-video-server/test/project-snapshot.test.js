import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const hostScript = fs.readFileSync(path.join(here, '../../extension/host/bridge.jsx'), 'utf8');

function runHost(app, bridgeTalkName) {
  const context = vm.createContext({
    app,
    BridgeTalk: { appName: bridgeTalkName },
    JSON,
    Math,
    Date,
    String,
    Number,
    Object,
    Array,
    isFinite,
  });
  vm.runInContext(hostScript, context, { filename: 'bridge.jsx' });
  return context.AntigravityBridge;
}

function collection(items) {
  const value = items.slice();
  value.numItems = items.length;
  return value;
}

function time(seconds) {
  return { seconds };
}

test('Premiere snapshot includes clips, timing, and effect parameters from active sequence', () => {
  const scale = {
    displayName: 'Scale',
    getValue: () => 125,
    isTimeVarying: () => false,
  };
  const motion = {
    displayName: 'Motion',
    matchName: 'AE.ADBE Motion',
    properties: collection([scale]),
  };
  const clip = {
    name: 'Intro.mov',
    start: time(0),
    end: time(2.5),
    inPoint: time(0.25),
    outPoint: time(2.75),
    components: collection([motion]),
    projectItem: { name: 'Intro.mov' },
  };
  const sequence = {
    name: 'Main Cut',
    getPlayerPosition: () => time(1.25),
    end: time(10),
    videoTracks: collection([{ name: 'V1', clips: collection([clip]) }]),
    audioTracks: collection([{ name: 'A1', clips: collection([]) }]),
  };
  const app = { name: 'Adobe Premiere Pro', project: { name: 'Demo.prproj', activeSequence: sequence } };
  const bridge = runHost(app, 'premierepro');

  assert.equal(typeof bridge.getProjectSnapshot, 'function');
  const snapshot = JSON.parse(bridge.getProjectSnapshot());
  assert.equal(snapshot.success, true);
  assert.equal(snapshot.app, 'Premiere Pro');
  assert.equal(snapshot.projectName, 'Demo.prproj');
  assert.equal(snapshot.activeItem.name, 'Main Cut');
  assert.equal(snapshot.activeItem.playheadSeconds, 1.25);
  assert.equal(snapshot.tracks[0].clips[0].name, 'Intro.mov');
  assert.equal(snapshot.tracks[0].clips[0].durationSeconds, 2.5);
  assert.equal(snapshot.tracks[0].clips[0].effects[0].parameters[0].name, 'Scale');
  assert.equal(snapshot.tracks[0].clips[0].effects[0].parameters[0].value, 125);
});
