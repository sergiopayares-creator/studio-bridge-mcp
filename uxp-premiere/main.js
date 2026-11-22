/* Studio Bridge UXP (Premiere Pro 25.6+ / 27.0)
 * Mini-puente WebSocket hacia ws://127.0.0.1:8765.
 * Solo verbos tipados del toolkit_uxp; no hay generación de código.
 */
'use strict';

var BRIDGE_URL = 'ws://localhost:8765';
var URLS = ['ws://localhost:8765', 'ws://127.0.0.1:8765'];
var urlIndex = 0;
var RECONNECT_MS = 4000;
var TOKEN_RE = /^[a-f0-9]{64}$/i;
var INTRINSIC_COMPONENTS = ['Motion', 'Opacity', 'Time Remapping', 'Volume', 'Channel Volume', 'Panner'];
var INTRINSIC_MATCH_NAMES = [
  'ADBE Motion',
  'ADBE Opacity',
  'ADBE Time Remapping',
  'ADBE Audio Volume',
  'ADBE Channel Volume',
  'ADBE Panner',
  'ADBE Stereo Mixer'
];

var state = {
  token: null,
  ws: null,
  connected: false,
  reconnectTimer: null,
  connecting: false,
  verbCount: 0
};

var els = {
  dot: null,
  status: null,
  log: null,
  reconnect: null,
  verbCount: null
};

function log(message, kind) {
  if (els.log) {
    var line = document.createElement('div');
    line.className = 'line' + (kind ? ' ' + kind : '');
    var now = new Date();
    var hh = ('0' + now.getHours()).slice(-2);
    var mm = ('0' + now.getMinutes()).slice(-2);
    var ss = ('0' + now.getSeconds()).slice(-2);
    line.textContent = '[' + hh + ':' + mm + ':' + ss + '] ' + message;
    els.log.appendChild(line);
    while (els.log.childNodes.length > 80) els.log.removeChild(els.log.firstChild);
    els.log.scrollTop = els.log.scrollHeight;
  }
}

function setStatus(online) {
  state.connected = !!online;
  if (els.dot) els.dot.className = online ? 'dot online' : 'dot';
  if (els.status) {
    els.status.textContent = online ? 'EN LÍNEA' : 'DESCONECTADO';
    els.status.className = online ? 'status online' : 'status';
  }
}

function updateVerbCount() {
  if (els.verbCount) els.verbCount.textContent = state.verbCount + ' verbos';
}

function scheduleReconnect() {
  if (state.reconnectTimer) return;
  state.reconnectTimer = setTimeout(function () {
    state.reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

// --- token -----------------------------------------------------------------
// UXP no siempre expone require('fs')/require('os'); se intenta Node y luego
// uxp.storage.localFileSystem (fullAccess) con la ruta file:///.
async function readToken() {
  var rel = '.antigravity-studio-bridge/.bridge-secret';
  var home = '';
  try {
    home = require('os').homedir();
  } catch (eOs) {
    home = '';
  }
  if (!home) {
    try {
      if (typeof process !== 'undefined' && process.env) {
        home = process.env.USERPROFILE || process.env.HOME || '';
      }
    } catch (eEnv) {
      home = '';
    }
  }
  if (!home) return null;
  var nativePath = String(home).replace(/\\/g, '/') + '/' + rel;

  try {
    var fs = require('fs');
    var text = fs.readFileSync(nativePath, 'utf8');
    var token = String(text).trim();
    if (TOKEN_RE.test(token)) return token;
  } catch (eFs) {}

  try {
    var uxp = require('uxp');
    var lfs = uxp.storage.localFileSystem;
    if (lfs && lfs.getEntryWithUrl) {
      var url = 'file:///' + nativePath.replace(/^\//, '');
      var entry = await lfs.getEntryWithUrl(url);
      var raw = await entry.read();
      var uxpToken = String(raw).trim();
      if (TOKEN_RE.test(uxpToken)) return uxpToken;
    }
  } catch (eUxp) {}

  return null;
}

// --- websocket -------------------------------------------------------------
function send(payload) {
  if (state.ws && state.ws.readyState === 1) {
    try {
      state.ws.send(JSON.stringify(payload));
      return true;
    } catch (e) {}
  }
  return false;
}

async function connect() {
  if (state.connecting) return;
  if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) return;
  state.connecting = true;
  try {
    if (!state.token) {
      state.token = await readToken();
    }
    if (!state.token) {
      log('No se pudo leer un token válido desde .bridge-secret', 'err');
      scheduleReconnect();
      return;
    }
    var url = URLS[urlIndex % URLS.length];
    urlIndex++;
    log('Conectando a ' + url + '…');
    var ws = new WebSocket(url);
    state.ws = ws;

    ws.onopen = function () {
      log('Socket abierto; autenticando…');
      send({ type: 'auth', token: state.token, app: 'premiere_uxp' });
    };

    ws.onmessage = function (event) {
      handleMessage(event.data);
    };

    ws.onerror = function () {
      log('Error de WebSocket', 'warn');
    };

    ws.onclose = function () {
      setStatus(false);
      log('Socket cerrado; reintento en ' + (RECONNECT_MS / 1000) + 's', 'warn');
      scheduleReconnect();
    };
  } catch (e) {
    log('No se pudo conectar: ' + e, 'err');
    setStatus(false);
    scheduleReconnect();
  } finally {
    state.connecting = false;
  }
}

function handleMessage(raw) {
  var msg = null;
  try {
    msg = JSON.parse(String(raw));
  } catch (e) {
    log('Mensaje no JSON ignorado', 'warn');
    return;
  }
  if (msg.type === 'auth_ok') {
    setStatus(true);
    log('Conectado y autenticado (' + (msg.app || 'premiere_uxp') + ')', 'ok');
    return;
  }
  if (msg.type === 'auth_error') {
    setStatus(false);
    log('Token rechazado por el puente', 'err');
    return;
  }
  if (msg.type === 'pong') return;
  if (msg.requestId) {
    handleRequest(msg);
  }
}

async function handleRequest(msg) {
  var payload;
  try {
    if (msg.action === 'toolkit_uxp') {
      payload = await handleToolkit(msg.params || {});
    } else if (msg.action === 'getProjectSnapshot') {
      payload = await projectSnapshot();
    } else {
      payload = {
        ok: false,
        error: 'Acción no soportada por el puente UXP: ' + String(msg.action)
      };
    }
    state.verbCount++;
    updateVerbCount();
  } catch (error) {
    payload = { ok: false, error: String(error && error.message ? error.message : error) };
  }
  send({ requestId: msg.requestId, payload: payload });
}

// --- helpers Premiere UXP ---------------------------------------------------
async function getPpro() {
  return require('premierepro');
}

async function getActiveProject(ppro) {
  return await ppro.Project.getActiveProject();
}

async function projectSnapshot() {
  var ppro = await getPpro();
  var project = await getActiveProject(ppro);
  return {
    success: true,
    app: 'Premiere Pro',
    host: 'premiere_uxp',
    projectName: project ? String(project.name) : 'Untitled'
  };
}

async function resolveSequence(ppro, project, ref) {
  var active = null;
  try {
    active = await project.getActiveSequence();
  } catch (eActive) {
    active = null;
  }
  if (ref === undefined || ref === null || ref === '') return active;
  if (typeof ref === 'number') {
    var sequences = [];
    try {
      sequences = await project.getSequences();
    } catch (eList) {
      sequences = [];
    }
    if (ref >= 0 && ref < sequences.length) return sequences[ref];
    return null;
  }
  var wanted = String(ref);
  try {
    var all = await project.getSequences();
    for (var i = 0; i < all.length; i++) {
      if (String(all[i].name) === wanted) return all[i];
    }
  } catch (eName) {}
  if (active && String(active.name) === wanted) return active;
  return null;
}

async function getTrackCount(sequence, kind) {
  var fn = kind === 'audio' ? sequence.getAudioTrackCount : sequence.getVideoTrackCount;
  if (fn) return await fn.call(sequence);
  var list = kind === 'audio' ? sequence.audioTracks : sequence.videoTracks;
  return list ? list.length : 0;
}

async function getTrack(sequence, kind, index) {
  var fn = kind === 'audio' ? sequence.getAudioTrack : sequence.getVideoTrack;
  if (fn) return await fn.call(sequence, index);
  var list = kind === 'audio' ? sequence.audioTracks : sequence.videoTracks;
  return list ? list[index] : null;
}

async function getClipsOfTrack(ppro, track) {
  if (!track) return [];
  if (typeof track.getTrackItems === 'function') {
    var clipType = (ppro && ppro.Constants && ppro.Constants.TrackItemType)
      ? ppro.Constants.TrackItemType.CLIP
      : 1;
    return await track.getTrackItems(clipType, false);
  }
  if (track.getClips) return await track.getClips();
  if (track.clips) return track.clips;
  return [];
}

async function readName(obj) {
  if (!obj) return '';
  try {
    if (typeof obj.getName === 'function') return String(await obj.getName());
  } catch (eName) {}
  return String(obj.name || '');
}

async function selectClips(ppro, p) {
  var project = await getActiveProject(ppro);
  if (!project) throw new Error('no hay proyecto activo en Premiere');
  var sequence = await resolveSequence(ppro, project, p.sequence);
  if (!sequence) throw new Error('secuencia no encontrada');
  var kind = p.kind === 'audio' ? 'audio' : 'video';
  var trackIndexes = [];
  var trackCount = await getTrackCount(sequence, kind);
  if (p.track !== undefined && p.track !== null && p.track !== '') {
    var single = Number(p.track);
    if (isNaN(single) || single < 0 || single >= trackCount) {
      throw new Error('pista inexistente: ' + p.track);
    }
    trackIndexes.push(single);
  } else {
    for (var t = 0; t < trackCount; t++) trackIndexes.push(t);
  }
  var nameRe = null;
  if (p.name) nameRe = new RegExp(String(p.name), 'i');
  var wanted = null;
  if (p.clips && typeof p.clips.length === 'number') {
    wanted = [];
    for (var w = 0; w < p.clips.length; w++) wanted.push(Number(p.clips[w]));
  }
  var selected = [];
  for (var ti = 0; ti < trackIndexes.length; ti++) {
    var track = await getTrack(sequence, kind, trackIndexes[ti]);
    var clips = await getClipsOfTrack(ppro, track);
    for (var ci = 0; ci < clips.length; ci++) {
      if (wanted && wanted.indexOf(ci) < 0) continue;
      var clip = clips[ci];
      var name = await readName(clip);
      if (nameRe && !nameRe.test(name)) continue;
      selected.push({ clip: clip, name: name, trackIndex: trackIndexes[ti], clipIndex: ci, kind: kind });
    }
  }
  return { project: project, sequence: sequence, selected: selected };
}

async function getComponentChain(clip) {
  if (clip && typeof clip.getComponentChain === 'function') {
    return await clip.getComponentChain();
  }
  return null;
}

async function getChainComponents(chain) {
  if (!chain) return [];
  var count = 0;
  try {
    if (chain.getComponentCount) count = await chain.getComponentCount();
    else if (typeof chain.componentCount === 'number') count = chain.componentCount;
  } catch (eCount) {
    count = 0;
  }
  var out = [];
  for (var i = 0; i < count; i++) {
    var component = null;
    try {
      if (chain.getComponentAtIndex) component = await chain.getComponentAtIndex(i);
      else if (chain.getComponent) component = await chain.getComponent(i);
    } catch (eComp) {
      component = null;
    }
    if (component) out.push(component);
  }
  return out;
}

async function componentNames(component) {
  var displayName = '';
  var matchName = '';
  try {
    displayName = component.getDisplayName ? String(await component.getDisplayName()) : String(component.displayName || '');
  } catch (eD) {}
  try {
    matchName = component.getMatchName ? String(await component.getMatchName()) : String(component.matchName || '');
  } catch (eM) {}
  return { displayName: displayName, matchName: matchName };
}

function isIntrinsic(displayName, matchName) {
  var d = String(displayName || '');
  var m = String(matchName || '');
  for (var i = 0; i < INTRINSIC_COMPONENTS.length; i++) {
    if (d === INTRINSIC_COMPONENTS[i]) return true;
  }
  for (var k = 0; k < INTRINSIC_MATCH_NAMES.length; k++) {
    if (m === INTRINSIC_MATCH_NAMES[k]) return true;
  }
  return false;
}

function jsonValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    var arr = [];
    for (var i = 0; i < value.length; i++) arr.push(jsonValue(value[i]));
    return arr;
  }
  if (typeof value === 'object') {
    if (value.red !== undefined || value.green !== undefined || value.blue !== undefined) {
      return [
        Number(value.red || 0),
        Number(value.green || 0),
        Number(value.blue || 0),
        value.alpha === undefined ? 1 : Number(value.alpha)
      ];
    }
    if (value.value !== undefined) return jsonValue(value.value);
    if (value.seconds !== undefined) return Number(value.seconds);
  }
  return String(value);
}

async function readComponentParams(component) {
  var out = [];
  var count = 0;
  try {
    if (component.getParamCount) count = await component.getParamCount();
    else if (component.paramCount) count = component.paramCount;
  } catch (eCount) {
    count = 0;
  }
  for (var i = 0; i < count; i++) {
    var param = null;
    try {
      if (component.getParam) param = await component.getParam(i);
      else if (component.params) param = component.params[i];
    } catch (eParam) {
      param = null;
    }
    if (!param) continue;
    var displayName = '';
    try {
      displayName = param.getDisplayName ? String(await param.getDisplayName()) : String(param.displayName || '');
    } catch (eName) {}
    var keyframed = false;
    try {
      keyframed = param.isTimeVarying ? !!(await param.isTimeVarying()) : !!param.keyframed;
    } catch (eKey) {
      keyframed = false;
    }
    var val = null;
    try {
      val = jsonValue(param.getValue ? await param.getValue() : param.value);
    } catch (eVal) {
      val = null;
    }
    out.push({ index: i, displayName: displayName, value: val, keyframed: keyframed });
  }
  return out;
}

async function findParam(component, ref) {
  var text = String(ref);
  if (/^\d+$/.test(text)) {
    var idx = Number(text);
    try {
      if (component.getParam) return await component.getParam(idx);
      if (component.params) return component.params[idx] || null;
    } catch (eIdx) {
      return null;
    }
    return null;
  }
  var re = new RegExp(text, 'i');
  var count = 0;
  try {
    if (component.getParamCount) count = await component.getParamCount();
    else if (component.paramCount) count = component.paramCount;
  } catch (eCount) {
    count = 0;
  }
  for (var i = 0; i < count; i++) {
    var param = null;
    try {
      param = component.getParam ? await component.getParam(i) : component.params[i];
    } catch (eGet) {
      param = null;
    }
    if (!param) continue;
    var name = '';
    try {
      name = param.getDisplayName ? String(await param.getDisplayName()) : String(param.displayName || '');
    } catch (eName) {}
    if (re.test(name)) return param;
  }
  return null;
}

function makeTick(ppro, seconds) {
  if (ppro.TickTime && ppro.TickTime.createWithSeconds) {
    return ppro.TickTime.createWithSeconds(Number(seconds));
  }
  return Number(seconds);
}

async function applyParamValue(param, value, atSeconds, ppro) {
  if (atSeconds === null) {
    if (param.setValue) await param.setValue(value, true);
    return;
  }
  var tick = makeTick(ppro, atSeconds);
  if (param.addKeyframe) {
    try {
      await param.addKeyframe(tick);
    } catch (eAdd) {}
  }
  if (param.setValueAtKeyframe) {
    await param.setValueAtKeyframe(tick, value, true);
  } else if (param.setValue) {
    await param.setValue(value, true);
  }
}

// --- verbos -----------------------------------------------------------------
async function handleToolkit(params) {
  var verb = params.verb;
  var p = params.params || {};
  var ppro = await getPpro();
  if (verb === 'status') return await statusVerb(ppro);
  if (verb === 'effectsList') return await effectsList(ppro, p);
  if (verb === 'effectsAdd') return await effectsAdd(ppro, p);
  if (verb === 'effectsRemove') return await effectsRemove(ppro, p);
  if (verb === 'clipParams') return await clipParams(ppro, p);
  if (verb === 'clipParamSet') return await clipParamSet(ppro, p);
  return { ok: false, error: 'verbo UXP desconocido: ' + String(verb) };
}

async function statusVerb(ppro) {
  var project = await getActiveProject(ppro);
  var sequences = [];
  var activeSequence = null;
  if (project) {
    try {
      var all = await project.getSequences();
      for (var i = 0; i < all.length; i++) sequences.push(String(all[i].name));
    } catch (eList) {}
    try {
      var active = await project.getActiveSequence();
      activeSequence = active ? String(active.name) : null;
    } catch (eActive) {}
  }
  var version = '';
  try {
    version = String(ppro.Application.version || '');
  } catch (eVersion) {}
  return {
    ok: true,
    host: 'premiere_uxp',
    version: version,
    project: project ? String(project.name) : null,
    activeSequence: activeSequence,
    sequences: sequences
  };
}

async function effectsList(ppro, p) {
  var matchNames = await ppro.VideoFilterFactory.getMatchNames();
  var list = [];
  var re = p.filter ? new RegExp(String(p.filter), 'i') : null;
  for (var i = 0; i < matchNames.length; i++) {
    var name = String(matchNames[i]);
    if (re && !re.test(name)) continue;
    list.push(name);
  }
  return { ok: true, host: 'premiere_uxp', count: list.length, effects: list };
}

async function effectsAdd(ppro, p) {
  if (!p.matchName) return { ok: false, error: 'matchName requerido' };
  var selection = await selectClips(ppro, p);
  if (!selection.selected.length) return { ok: false, error: 'no hay clips que coincidan' };
  var matchName = String(p.matchName);
  var components = [];
  for (var i = 0; i < selection.selected.length; i++) {
    var component = await ppro.VideoFilterFactory.createComponent(matchName);
    if (component) components.push({ component: component, item: selection.selected[i] });
  }
  var applied = 0;
  await selection.project.lockedAccess(async function () {
    await selection.project.executeTransaction(async function () {
      for (var k = 0; k < components.length; k++) {
        var entry = components[k];
        var chain = await getComponentChain(entry.item.clip);
        if (!chain) continue;
        if (chain.addComponent) await chain.addComponent(entry.component);
        else if (chain.insertComponent) await chain.insertComponent(entry.component);
        applied++;
      }
    });
  });
  return {
    ok: true,
    host: 'premiere_uxp',
    sequence: String(selection.sequence.name),
    matchName: matchName,
    clips: selection.selected.length,
    applied: applied
  };
}

async function effectsRemove(ppro, p) {
  if (!p.match) return { ok: false, error: 'match requerido (regex de matchName/displayName)' };
  var re = new RegExp(String(p.match), 'i');
  var selection = await selectClips(ppro, p);
  var removed = 0;
  var removedNames = [];
  await selection.project.lockedAccess(async function () {
    await selection.project.executeTransaction(async function () {
      for (var i = 0; i < selection.selected.length; i++) {
        var chain = await getComponentChain(selection.selected[i].clip);
        var components = await getChainComponents(chain);
        for (var k = components.length - 1; k >= 0; k--) {
          var component = components[k];
          var names = await componentNames(component);
          if (isIntrinsic(names.displayName, names.matchName)) continue;
          if (!re.test(names.displayName) && !re.test(names.matchName)) continue;
          if (chain.removeComponent) await chain.removeComponent(component);
          removed++;
          removedNames.push(names.displayName || names.matchName);
        }
      }
    });
  });
  return {
    ok: true,
    host: 'premiere_uxp',
    sequence: String(selection.sequence.name),
    removed: removed,
    components: removedNames
  };
}

async function clipParams(ppro, p) {
  var selection = await selectClips(ppro, p);
  var clips = [];
  for (var i = 0; i < selection.selected.length; i++) {
    var item = selection.selected[i];
    var chain = await getComponentChain(item.clip);
    var components = await getChainComponents(chain);
    var outComponents = [];
    for (var k = 0; k < components.length; k++) {
      var names = await componentNames(components[k]);
      outComponents.push({
        displayName: names.displayName,
        matchName: names.matchName,
        parameters: await readComponentParams(components[k])
      });
    }
    clips.push({
      name: item.name,
      track: item.trackIndex,
      index: item.clipIndex,
      kind: item.kind,
      components: outComponents
    });
  }
  return {
    ok: true,
    host: 'premiere_uxp',
    sequence: String(selection.sequence.name),
    clips: clips
  };
}

async function clipParamSet(ppro, p) {
  if (!p.component) return { ok: false, error: 'component requerido (regex)' };
  if (p.param === undefined || p.param === null || p.param === '') return { ok: false, error: 'param requerido' };
  if (p.value === undefined) return { ok: false, error: 'value requerido' };
  var componentRe = new RegExp(String(p.component), 'i');
  var selection = await selectClips(ppro, p);
  var at = (p.at === undefined || p.at === null || p.at === '') ? null : Number(p.at);
  var applied = 0;
  await selection.project.lockedAccess(async function () {
    await selection.project.executeTransaction(async function () {
      for (var i = 0; i < selection.selected.length; i++) {
        var chain = await getComponentChain(selection.selected[i].clip);
        var components = await getChainComponents(chain);
        for (var k = 0; k < components.length; k++) {
          var names = await componentNames(components[k]);
          if (!componentRe.test(names.displayName) && !componentRe.test(names.matchName)) continue;
          var param = await findParam(components[k], p.param);
          if (!param) continue;
          await applyParamValue(param, p.value, at, ppro);
          applied++;
        }
      }
    });
  });
  return {
    ok: true,
    host: 'premiere_uxp',
    sequence: String(selection.sequence.name),
    applied: applied,
    at: at
  };
}

// --- bootstrap --------------------------------------------------------------
function init() {
  els.dot = document.getElementById('dot');
  els.status = document.getElementById('status');
  els.log = document.getElementById('log');
  els.reconnect = document.getElementById('reconnect');
  els.verbCount = document.getElementById('verbCount');
  if (els.reconnect) {
    els.reconnect.addEventListener('click', function () {
      log('Reconexión manual…');
      if (state.ws) {
        try { state.ws.close(); } catch (e) {}
      }
      state.ws = null;
      setStatus(false);
      connect();
    });
  }
  setStatus(false);
  updateVerbCount();
  connect();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
