#!/usr/bin/env node

// Redirigir console.log y console.info a stderr para proteger el canal stdout de MCP (JSON-RPC)
console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

import {
  getMediaInfo,
  losslessCut,
  extractAudio,
  detectSilences,
  generateProxy,
  extractFrame,
  createContactSheetFromImages,
  createVideoContactSheet,
  imageFileToJpegBase64,
  base64ImageToJpegBase64,
  cleanBase64,
} from './lib/ffmpeg.js';
import {
  findAfterEffectsExe,
  normalizeOutputPathParams,
  buildContactSheetJpeg,
  buildCompareSheet,
} from './lib/aftereffects.js';
import { transcribeAudio } from './lib/transcribe.js';
import {
  initCepBridge,
  sendCepCommand,
  getBridgeStatus,
  broadcastToPanel,
  getRecentPrompts,
  getConnectedApps,
  matchesAppTarget,
  isTransientTimeout,
} from './lib/cep-bridge.js';
import {
  getWritableRoots,
  assertWritableParam,
  assertWritablePath,
  sanitizePath,
  validateNumber,
} from './lib/security.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Política de escritura / ejecución --------------------------------------
// Ejecución de ExtendScript arbitrario (evalScript/evalCustom) queda
// deshabilitada por defecto: es un vector de ejecución de código arbitrario
// (incluido system.callSystem dentro de AE). Habilítala solo si es imprescindible.
function requireArbitraryJs() {
  if (process.env.STUDIO_BRIDGE_ALLOW_ARBITRARY_JS === '1') return;
  throw new Error(
    'Ejecución de JS/ExtendScript arbitrario deshabilitada. Define ' +
    'STUDIO_BRIDGE_ALLOW_ARBITRARY_JS=1 para habilitarla, o usa los verbos acotados del toolkit.'
  );
}

// Escritura a disco (guardar proyecto, render a una ruta, etc.) exige raíces.
function requireWritableRoots() {
  if (getWritableRoots().length > 0) return;
  throw new Error(
    'Operación de escritura rechazada: ANTIGRAVITY_WRITABLE_ROOTS no está definida. ' +
    'Define las carpetas de salida permitidas (separadas por ;) para habilitar escrituras.'
  );
}

// Returns the explicit output path carried by a verb's params. renderFrame
// accepts `path` and `outputPath` as aliases; `path` wins when both are present.
function explicitOutputPath(params) {
  const p = params && params.params;
  if (!p || typeof p !== 'object') return '';
  if (typeof p.path === 'string' && p.path.trim()) return p.path;
  if (typeof p.outputPath === 'string' && p.outputPath.trim()) return p.outputPath;
  return '';
}

/**
 * Normalizes the params of an image verb before it reaches the CEP bridge.
 * renderFrame/contactSheet accept `outputPath` as an alias of `path`; the alias
 * is resolved and checked against ANTIGRAVITY_WRITABLE_ROOTS here, so the exact
 * path that reaches ExtendScript is the one validated by security.js.
 */
export function normalizeToolkitParams(verb, params) {
  const source = params && typeof params === 'object' ? params : {};
  if (verb === 'renderFrame' || verb === 'contactSheet' || verb === 'compare') {
    return normalizeOutputPathParams(source);
  }
  return { ...source };
}

// Aplica la política de escritura a un comando CEP según su acción/verbo.
export function gateCepWrite(action, params) {
  const verb = params && params.verb;
  if (action === 'evalScript' || action === 'evalCustom') {
    return requireArbitraryJs();
  }
  if (action === 'toolkit_ae') {
    if (verb === 'script') return requireArbitraryJs();
    if (verb === 'save' || verb === 'renderOutput') {
      requireWritableRoots();
      if (verb === 'renderOutput') assertWritableParam(params && params.params, 'path');
    }
    if (verb === 'renderFrame' || verb === 'contactSheet' || verb === 'compare') {
      const outputPath = explicitOutputPath(params);
      if (outputPath) {
        requireWritableRoots();
        assertWritablePath(outputPath);
      }
    }
  } else if (action === 'toolkit') {
    if (verb === 'save' || verb === 'saveSafe') requireWritableRoots();
    if (verb === 'renderFrame' || verb === 'contactSheet' || verb === 'compare') {
      const outputPath = explicitOutputPath(params);
      if (outputPath) {
        requireWritableRoots();
        assertWritablePath(outputPath);
      }
    }
    if (verb === 'export') {
      requireWritableRoots();
      assertWritableParam(params && params.params, 'path');
    }
  }
}


// --- MCP content blocks -----------------------------------------------------
// A vision-capable MCP client expects images as their own `image` block. The
// base64 payload must live ONLY there: embedding it inside the JSON text block
// burns context and does not render as an image.
const MAX_INLINE_IMAGE_BYTES = 1536 * 1024;

export function imageContentBlock(data, mimeType = 'image/jpeg') {
  const clean = cleanBase64(data);
  if (!clean) throw new Error('imageContentBlock: empty image data');
  return { type: 'image', data: clean, mimeType };
}

export function buildImageResult(meta, data, mimeType = 'image/jpeg') {
  const safeMeta = { ...(meta || {}) };
  delete safeMeta.base64;
  delete safeMeta.base64Data;
  const clean = cleanBase64(data);
  return {
    content: [
      { type: 'text', text: JSON.stringify(safeMeta, null, 2) },
      imageContentBlock(clean, mimeType),
    ],
  };
}

// Reads a frame already saved on disk and returns it as an image block,
// re-compressing through ffmpeg only when the file is too heavy to inline.
export async function imageResultFromFile(meta, imagePath, { maxWidth = 1600 } = {}) {
  const buffer = fs.readFileSync(imagePath);
  let data;
  let mimeType;
  if (buffer.length <= MAX_INLINE_IMAGE_BYTES) {
    data = buffer.toString('base64');
    mimeType = /\.jpe?g$/i.test(imagePath) ? 'image/jpeg' : 'image/png';
  } else {
    data = await imageFileToJpegBase64(imagePath, maxWidth);
    mimeType = 'image/jpeg';
  }
  return buildImageResult(
    { ...meta, mimeType, bytes: Buffer.byteLength(data, 'base64') },
    data,
    mimeType
  );
}

// renderFrame ships a base64 PNG from the panel. Move it out of the JSON text
// and (only when it is heavy) convert it to JPEG for a cheaper vision payload.
export async function frameResultToImageResult(result, guard = null) {
  const source = cleanBase64(result.base64);
  if (!source) throw new Error('renderFrame did not return image data');
  const meta = {
    ok: true,
    ...(result.comp ? { comp: result.comp } : {}),
    ...(result.sequence ? { sequence: result.sequence } : {}),
    time: result.time,
    ...(result.timecode ? { timecode: result.timecode } : {}),
    path: result.path,
    ...(guard ? { projectGuard: guard } : {}),
  };
  const approxBytes = Math.floor(source.length * 0.75);
  if (approxBytes > MAX_INLINE_IMAGE_BYTES) {
    try {
      const jpeg = await base64ImageToJpegBase64(source, 1600);
      return buildImageResult(
        { ...meta, mimeType: 'image/jpeg', bytes: Buffer.byteLength(jpeg, 'base64'), recompressed: true },
        jpeg,
        'image/jpeg'
      );
    } catch (err) {
      meta.recompressError = err.message || String(err);
    }
  }
  return buildImageResult(
    { ...meta, mimeType: 'image/png', bytes: Buffer.byteLength(source, 'base64') },
    source,
    'image/png'
  );
}

// Case-insensitive exact match or substring match of the project name. The
// projectName reported by Premiere/AE is a file name like "Spot 30s.aep".
export function projectNameMatches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = actual.trim().toLowerCase();
  const e = expected.trim().toLowerCase();
  if (!a || !e) return false;
  return a === e || a.includes(e);
}

// --- AE contactSheet packaging ---------------------------------------------
// toolkit_ae.jsx verb "contactSheet" saves PNG frames to Folder.temp and returns
// their paths. lib/aftereffects.js waits for them, burns each timestamp into its
// tile, encodes ONE lightweight JPEG and removes the intermediate PNGs; here we
// only expose that single file as a native MCP image block.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function packAeContactSheet(result, params = {}, guard = null) {
  const sheet = await buildContactSheetJpeg(result, params);
  const meta = {
    ok: true,
    action: 'contactSheet',
    ...(result.comp ? { comp: result.comp } : {}),
    ...(result.sequence ? { sequence: result.sequence } : {}),
    outputPath: sheet.jpegPath,
    path: sheet.jpegPath,
    count: sheet.count,
    cols: sheet.cols,
    rows: sheet.rows,
    width: sheet.width,
    height: sheet.height,
    times: sheet.times,
    missing: sheet.missing.length
      ? sheet.missing
      : Array.isArray(result.missing)
        ? result.missing
        : [],
    timestampsBurned: sheet.timestampsBurned,
    mimeType: 'image/jpeg',
    ...(guard ? { projectGuard: guard } : {}),
  };
  return await imageResultFromFile(meta, sheet.jpegPath, { maxWidth: 1920 });
}

// Shared by AE and Premiere: both host verbs return temporary PNG paths.
export const packContactSheet = packAeContactSheet;

// --- AE compare (REF | AE) -------------------------------------------------
export function normalizeCompareTimes(times) {
  if (!Array.isArray(times) || times.length === 0) {
    throw new Error('compare requiere times[] con al menos un tiempo');
  }
  if (times.length > 16) {
    throw new Error('compare admite como máximo 16 tiempos');
  }
  return times.map((t) => validateNumber(t, { name: 'times', min: 0, max: 86400 }));
}

/**
 * Read-only comparison: asks the AE panel for contactSheet frames at `times`,
 * extracts the same instants from the reference video and returns ONE JPEG with
 * side-by-side REF | AE pairs and burned timestamps.
 */
export async function runAeCompare(params = {}, sendCommand = sendCepCommand, guard = null) {
  const referencePath = sanitizePath(params.referencePath, true);
  const times = normalizeCompareTimes(params.times);
  const tileWidth =
    params.tileWidth === undefined || params.tileWidth === null
      ? 320
      : validateNumber(params.tileWidth, { name: 'tileWidth', min: 64, max: 1920 });

  const host = await sendCommand(
    'aftereffects',
    'toolkit_ae',
    { verb: 'contactSheet', params: { comp: params.comp, times, tileWidth } },
    120000
  );
  if (!host || host.ok !== true || !Array.isArray(host.paths) || host.paths.length === 0) {
    const reason = host && host.error ? `: ${host.error}` : '';
    throw new Error(`compare: el host no generó frames de AE${reason}`);
  }

  const sheet = await buildCompareSheet(host, {
    referencePath,
    times,
    path: params.path,
    outputPath: params.outputPath,
    tileWidth,
  });

  const meta = {
    ok: true,
    action: 'compare',
    ...(host.comp || params.comp ? { comp: host.comp || params.comp } : {}),
    referencePath,
    path: sheet.path,
    times: sheet.times,
    count: sheet.count,
    cols: sheet.cols,
    rows: sheet.rows,
    timestampsBurned: sheet.timestampsBurned,
    mimeType: 'image/jpeg',
    ...(sheet.missing.length ? { missing: sheet.missing } : {}),
    ...(guard ? { projectGuard: guard } : {}),
  };
  return await imageResultFromFile(meta, sheet.path, { maxWidth: 1920 });
}

// Guard against editing the wrong project: compare `expected_project` with the
// projectName reported by the host BEFORE dispatching a mutating verb.
// Fail-closed: if the host cannot report a project name, the call aborts.
// A transient timeout (the host was still busy rendering/answering) gets ONE
// short retry before aborting; a real mismatch never retries.
// `getSnapshot` is injectable so tests can prove the fail-closed behaviour and
// the single retry without a live Adobe panel.
export async function assertExpectedProject(
  appTarget,
  expectedProject,
  getSnapshot = sendCepCommand,
  options = {}
) {
  if (expectedProject === undefined || expectedProject === null) return null;
  const expected = String(expectedProject).trim();
  if (!expected) return null;

  const retryDelayMs = Number.isFinite(Number(options && options.retryDelayMs))
    ? Math.max(0, Number(options.retryDelayMs))
    : 400;
  const wait = options && typeof options.sleep === 'function' ? options.sleep : sleep;
  const maxAttempts = options && options.retry === false ? 1 : 2;

  let snapshot = null;
  let attempts = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    attempts++;
    try {
      snapshot = await getSnapshot(appTarget || 'any', 'getProjectSnapshot', {}, 20000);
    } catch (err) {
      snapshot = { success: false, error: (err && err.message) || String(err) };
    }
    if (!isTransientTimeout(snapshot)) break;
    if (attempt + 1 < maxAttempts) await wait(retryDelayMs);
  }

  const actual =
    snapshot && (snapshot.projectName || (snapshot.project && snapshot.project.name) || null);
  if (!actual) {
    const hostError = snapshot && snapshot.error ? `: ${snapshot.error}` : '';
    const retryNote = attempts > 1 ? ` (after ${attempts} attempts)` : '';
    throw new Error(
      `expected_project guard: could not verify the active project because the host did not report projectName${hostError}${retryNote}. Aborting (fail-closed).`
    );
  }
  if (!projectNameMatches(String(actual), expected)) {
    const error = new Error(
      `expected_project mismatch: the active project is "${actual}" but "${expected}" was expected. Aborting without touching the project.`
    );
    error.code = 'EXPECTED_PROJECT_MISMATCH';
    throw error;
  }
  return {
    expected,
    actual,
    verified: true,
    attempts,
    retried: attempts > 1,
    match: String(actual).trim().toLowerCase() === expected.toLowerCase() ? 'exact' : 'substring',
  };
}

// expected_project support for the UXP tool: prefer the CEP panel (it answers
// getProjectSnapshot with full project data); otherwise ask the UXP bridge,
// which reports projectName too.
function premiereGuardTarget() {
  const connected = getConnectedApps();
  if (connected.some((app) => matchesAppTarget(app, 'premiere'))) return 'premiere';
  if (connected.some((app) => matchesAppTarget(app, 'premiere_uxp'))) return 'premiere_uxp';
  return 'premiere';
}

function withProjectGuard(result, guard) {
  if (!guard) return result;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return { ...result, projectGuard: guard };
  }
  return { projectGuard: guard, result };
}

// --- Read-only cheat sheet --------------------------------------------------
const AE_TOOLKIT_VERBS = [
  'project', 'catalog', 'comp', 'layer', 'settings', 'shape', 'fill', 'text', 'textStyle',
  'textAnimator', 'camera', 'light', 'effect', 'effectParam', 'effectKey', 'transform',
  'keyframe', 'expression', 'mask', 'roto', 'tracker', 'marker', 'import', 'folder', 'items',
  'render', 'renderOutput', 'renderFrame', 'selection', 'save', 'set', 'measure', 'alignAnchor',
  'shapeGroup', 'halo', 'batch', 'check', 'contactSheet', 'zStack', 'pose',
  'ensureKeysAfter', 'compare',
];

const PREMIERE_TOOLKIT_VERBS = [
  'catalog', 'project', 'insert', 'overwrite', 'razor', 'removeClip', 'subclip',
  'applyTransition', 'applyEffect', 'marker', 'clearMarkers', 'save', 'saveSafe',
  'renderFrame', 'contactSheet', 'clipMotion', 'clipVolume', 'clipSpeed', 'assemble',
  'import', 'bin', 'export', 'importSrt',
];

const SHARED_INVARIANTS = [
  {
    id: 'es3',
    rule: 'ExtendScript is ES3: only var, function and for/while. No let/const, arrow functions, template literals, classes, Array.map/forEach/filter/reduce, Promise or async. Concatenate strings with +.',
  },
  {
    id: 'sourceRectAtTime',
    rule: 'Text/shape geometry: layer.sourceRectAtTime(time, includeExtents) -> {top,left,width,height} in layer space. It ignores scale/rotation, so multiply by the transform scale to convert to comp space; includeExtents=true adds effect extents (blur/glow).',
  },
  {
    id: 'easing',
    rule: 'Easing depends on prop.propertyValueType and AE requires an exact count of KeyframeEase values: TwoD_SPATIAL, ThreeD_SPATIAL, COLOR and OneD -> 1 element; TwoD -> 2 elements; ThreeD (e.g. a 3D Scale) -> 3 elements. Set prop.setInterpolationTypeAtKey(i, KeyframeInterpolationType.BEZIER) first, then prop.setTemporalEaseAtKey(i, [inEase...], [outEase...]) with exactly that many elements per array; passing extra elements makes the call fail silently on Position.',
  },
  {
    id: 'blurBounds',
    rule: 'Blur Bounds (shape layers): blur/glow only paints inside the layer bounds. Grow the shape path or add padding before blurring, and use sourceRectAtTime(t, true) to measure the blurred extent; layer.width/height return the comp size, not the shape size.',
  },
];

/**
 * Compact, read-only reference of the engine invariants and toolkit verbs.
 */
export function buildAdobeGuide(topic = 'all') {
  const requested = String(topic || 'all').toLowerCase();
  const includeAe = ['all', 'ae', 'aftereffects', 'after_effects', 'after-effects'].includes(requested);
  const includePremiere = ['all', 'premiere', 'pr', 'ppro'].includes(requested);

  const guide = {
    engine: 'ExtendScript ES3 inside Adobe 2026 (Premiere Pro / After Effects)',
    invariants: SHARED_INVARIANTS,
    images: {
      note: 'Image-producing tools answer with a native MCP image block ({type:"image", mimeType}) and keep base64 out of the JSON text block. contactSheet returns ONE JPEG mosaic with the timestamps burned into each tile.',
      tools: [
        'video_extract_frame',
        'video_contact_sheet',
        'aftereffects_toolkit (verbs "renderFrame" and "contactSheet")',
        'premiere_toolkit (verbs "renderFrame" and "contactSheet")',
      ],
    },
    projectGuard:
      'aftereffects_toolkit / premiere_toolkit accept expected_project: the active projectName is checked before the verb runs and the call aborts on mismatch. A transient timeout is retried once (400 ms) before aborting.',
  };

  if (includeAe) {
    guide.aftereffects = {
      verbs: AE_TOOLKIT_VERBS,
      flow: 'project -> comp -> layer -> effect -> effectParam -> keyframe -> renderFrame',
      notes: [
        'renderFrame returns {ok, comp, time, path, base64}; the server turns base64 into an image block.',
        'renderFrame accepts params.path or params.outputPath: the PNG is written exactly there (the host waits for saveFrameToPng), that exact path is returned in `path`, and the file is never deleted. Only implicit temp frames are cleaned.',
        'contactSheet returns a single JPEG grid (mimeType image/jpeg) with each timestamp burned into its tile, plus {path, times, count}; intermediate PNGs are temporary and removed.',
        'layer/settings accept enabled, audioEnabled (try/catch), guideLayer, motionBlur (also sets comp.motionBlur when true), samplingQuality ("bicubic"|"bilinear") and trackMatte/trackMatteLayer ("alpha"|"alpha_inverted"|"luma"|"luma_inverted"|"none").',
        'text creates with resetCharStyle:true by default (clears AE Character allCaps), and accepts tracking, leading, allCaps and hex/RGB fillColor. textStyle accepts hex/RGB fillColor, string or numeric justification and resetCharStyle.',
        'zStack orders named layers deterministically: order[] top-to-bottom, bottom[] at the end; absent optional layers are reported in missing[] with ok:true.',
        'pose is read-only: it evaluates position/scale/rotation/opacity with valueAtTime(t, false) without moving the playhead or opening an undo group.',
        'Verbs that mutate the project run inside an undo group ("Antigravity: <verb>").',
        'Write verbs (save, renderOutput, renderFrame with path/outputPath) require ANTIGRAVITY_WRITABLE_ROOTS.',
        'set can animate dimensions separately: dimensions:"separate" plus xKeyframes/yKeyframes (or xValue/yValue) splits Position/Scale into per-axis properties; dimensions:"combined" rejoins them.',
        'set accepts afterTime, and ensureKeysAfter wraps it: before adding new keyframes it removes ONLY existing keys with keyTime > afterTime + 0.0005, preserving all keys <= afterTime and never using setValue.',
        'check reports warnings alwaysZeroOpacity (active layer with constant opacity 0, ignoring Nulls/audio-only) and layerCoversText (active non-background Shape/AV/Precomp above an active text whose worldBounds it overlaps), plus the existing safe-area/textOverlap checks.',
        'compare is read-only: it requests contactSheet frames from AE at times[], extracts the same instants from referencePath with FFmpeg and returns ONE JPEG grid of REF | AE pairs with burned timestamps, plus {path, times, count}.',
        'compare accepts params.path or params.outputPath (validated against ANTIGRAVITY_WRITABLE_ROOTS); referencePath must exist.',
      ],
    };
  }

  if (includePremiere) {
    guide.premiere = {
      verbs: PREMIERE_TOOLKIT_VERBS,
      notes: [
        'applyEffect is NOT supported by the Premiere scripting API and answers {supported:false}; apply effects manually or via QE DOM at your own risk.',
        'Time values are TickTime objects: read .seconds before serializing.',
        'Always check app.project.activeSequence before editing; it can be null.',
        'renderFrame/contactSheet export PNGs via QE in Folder.temp; the server returns them as native image blocks.',
        'clipMotion Position is normalized 0..1; clipVolume uses Level = 10 ^ ((gainDb - 15) / 20).',
        'clipSpeed uses the undocumented QE setSpeed(speed, durationTicksString, reverse, maintainPitch, ripple); without speed it only reads the current value.',
        'import imports media paths into a bin; bin creates nested folder structures (path "A/B/C" or tree[]); export renders direct (exportAsMediaDirect/render queue) or queues in AME (encoder.encodeSequence/queueInAME).',
        'importSrt imports an .srt as a ProjectItem and calls Sequence.createCaptionTrack(item, startAt, format); Premiere exposes no per-caption styling API.',
        'save and saveSafe both use saveAs (non-modal); saveSafe adds mode "version" and "as".',
      ],
      uxpToolkit: {
        tool: 'premiere_uxp_toolkit',
        transport: 'UXP WebSocket panel (ws://127.0.0.1:8765), app "premiere_uxp"',
        verbs: ['status', 'effectsList', 'effectsAdd', 'effectsRemove', 'clipParams', 'clipParamSet'],
        notes: [
          'Requires the Studio Bridge UXP plugin loaded in Premiere (uxp-premiere/manifest.json).',
          'effectsAdd/effectsRemove match by matchName and run inside one atomic Undo transaction.',
          'clipParams reads all components/params, including MOGRT (Essential Graphics) text and controls.',
          'clipParamSet writes one param by component (regex), param (name or index) and value; optional "at" (seconds) adds a keyframe.',
          'UXP and CEP connections are isolated: premiere_toolkit never sends ExtendScript to the UXP panel.',
        ],
      },
    };
  }

  return guide;
}

// Factory: builds a fresh MCP server with all tool handlers. Stateless, so the
// HTTP broker can create one per request and let several agents share the bridge.
// `options.sendCommand` is an injection point for tests (defaults to the CEP bridge).
export function createMcpServer(options = {}) {
  const sendCommand = (options && options.sendCommand) || sendCepCommand;
  // Create the MCP server instance
  const server = new Server(
    {
      name: 'video-production-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register list of tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'video_get_info',
          description: 'Inspects a media file (video/audio) using ffprobe. Returns duration, resolution, fps, bitrate, codecs in a compact JSON format to minimize token usage.',
          inputSchema: {
            type: 'object',
            properties: {
              file_path: {
                type: 'string',
                description: 'Absolute path to the video or audio file.',
              },
            },
            required: ['file_path'],
          },
        },
        {
          name: 'video_lossless_cut',
          description: 'Performs an instant lossless cut (-c copy) on a video between start and end timestamps. Zero re-encoding, zero quality loss, finishes in milliseconds.',
          inputSchema: {
            type: 'object',
            properties: {
              input_path: {
                type: 'string',
                description: 'Absolute path to the source video file.',
              },
              output_path: {
                type: 'string',
                description: 'Absolute path where the cut video will be saved.',
              },
              start_time: {
                type: 'string',
                description: 'Start timestamp in seconds (e.g. "12.5") or HH:MM:SS format (e.g. "00:01:15").',
              },
              end_time: {
                type: 'string',
                description: 'Optional end timestamp. If omitted, cuts until end of file.',
              },
            },
            required: ['input_path', 'output_path', 'start_time'],
          },
        },
        {
          name: 'video_extract_audio',
          description: 'Extracts the audio track from a video file into WAV (for whisper/transcription) or MP3 with custom sample rate and mono/stereo channels.',
          inputSchema: {
            type: 'object',
            properties: {
              input_path: {
                type: 'string',
                description: 'Absolute path to the source video file.',
              },
              output_path: {
                type: 'string',
                description: 'Absolute path for the output audio file (e.g. audio.wav).',
              },
              format: {
                type: 'string',
                enum: ['wav', 'mp3', 'copy'],
                default: 'wav',
                description: 'Audio format. Defaults to wav (16kHz mono, optimal for whisper).',
              },
              sample_rate: {
                type: 'number',
                default: 16000,
                description: 'Sample rate in Hz (default: 16000 for transcription).',
              },
            },
            required: ['input_path', 'output_path'],
          },
        },
        {
          name: 'video_detect_silences',
          description: 'Detects silent pauses and gaps in an audio/video file locally using FFmpeg silencedetect filter. Produces exact cut timestamps without sending any tokens to an LLM.',
          inputSchema: {
            type: 'object',
            properties: {
              input_path: {
                type: 'string',
                description: 'Absolute path to the video or audio file.',
              },
              noise_threshold_db: {
                type: 'number',
                default: -30,
                description: 'Noise threshold in decibels (e.g. -30 for speech pauses, -40 for quieter environments).',
              },
              min_duration_sec: {
                type: 'number',
                default: 0.5,
                description: 'Minimum duration in seconds of silence to detect (default: 0.5s).',
              },
            },
            required: ['input_path'],
          },
        },
        {
          name: 'video_generate_proxy',
          description: 'Converts high-resolution media into an optimized lightweight editing proxy (e.g. 720p or 540p H.264) for smooth timeline playback.',
          inputSchema: {
            type: 'object',
            properties: {
              input_path: {
                type: 'string',
                description: 'Absolute path to the source media file.',
              },
              output_path: {
                type: 'string',
                description: 'Absolute path where the proxy video will be saved.',
              },
              height: {
                type: 'number',
                default: 720,
                description: 'Vertical resolution of the proxy (e.g. 720, 540, 480). Default: 720.',
              },
              crf: {
                type: 'number',
                default: 26,
                description: 'Constant Rate Factor compression (18-30, default: 26 for small file size).',
              },
            },
            required: ['input_path', 'output_path'],
          },
        },
        {
          name: 'video_extract_frame',
          description: 'Extracts a single still JPEG frame from a video at a given time and returns it as a native MCP image block (plus a small JSON text block with path/dimensions). Gives the agent "eyes": request a frame, then inspect it before issuing edits.',
          inputSchema: {
            type: 'object',
            properties: {
              input_path: {
                type: 'string',
                description: 'Absolute path to the source video file.',
              },
              output_path: {
                type: 'string',
                description: 'Absolute path where the JPEG frame will be saved.',
              },
              time_seconds: {
                type: 'number',
                default: 0,
                description: 'Time in seconds at which to capture the frame. Default: 0.',
              },
            },
            required: ['input_path', 'output_path'],
          },
        },
        {
          name: 'video_contact_sheet',
          description: 'Builds a lightweight JPEG contact sheet (mosaic of frames with their timestamps burned in) from a video with FFmpeg and returns it as a native MCP image block. Ideal to "watch" a long clip with very few tokens.',
          inputSchema: {
            type: 'object',
            properties: {
              input_path: {
                type: 'string',
                description: 'Absolute path to the source video file.',
              },
              output_path: {
                type: 'string',
                description: 'Absolute path where the contact sheet JPEG will be saved.',
              },
              from: {
                type: 'number',
                default: 0,
                description: 'Start time in seconds. Default: 0.',
              },
              to: {
                type: 'number',
                description: 'End time in seconds. Defaults to the end of the video.',
              },
              every: {
                type: 'number',
                description: 'Seconds between tiles. Defaults to dividing the range by max_tiles.',
              },
              cols: {
                type: 'number',
                default: 4,
                description: 'Grid columns (1-8). Default: 4.',
              },
              tile_width: {
                type: 'number',
                default: 320,
                description: 'Width in pixels of each tile (64-1920). Default: 320.',
              },
              max_tiles: {
                type: 'number',
                default: 16,
                description: 'Maximum number of tiles (1-64). Default: 16.',
              },
            },
            required: ['input_path', 'output_path'],
          },
        },
        {
          name: 'video_transcribe',
          description: 'Transcribes speech in a video or audio file to text using a local whisper.cpp model (offline, no token cost). Gives the agent "ears". Accepts video (mp4/mov) or audio (wav/mp3/m4a); video audio is auto-extracted to 16 kHz mono first.',
          inputSchema: {
            type: 'object',
            properties: {
              input_path: {
                type: 'string',
                description: 'Absolute path to the video or audio file.',
              },
              language: {
                type: 'string',
                default: 'auto',
                description: 'Language hint: "auto", "es", "en", "fr", etc. Default: auto.',
              },
            },
            required: ['input_path'],
          },
        },
        {
          name: 'aftereffects_execute_extendscript',
          description: 'Executes JSX ExtendScript directly in Adobe After Effects 2026. Can evaluate code or run a script file, returning execution data safely. The value of the last expression (or of an IIFE) is preserved and serialized as a string/object; ExtendScript failures return {success:false, error, line}.',
          inputSchema: {
            type: 'object',
            properties: {
              script: {
                type: 'string',
                description: 'JSX code string OR absolute path to a .jsx script file.',
              },
              timeout_ms: {
                type: 'number',
                default: 60000,
                description: 'Timeout in milliseconds (default: 60000).',
              },
            },
            required: ['script'],
          },
        },
        {
          name: 'adobe_get_project_snapshot',
          description: 'Reads a bounded structured snapshot of the active Premiere Pro sequence or After Effects composition: clip/layer names, timing, effects, parameter values, and keyframe counts. Read-only.',
          inputSchema: {
            type: 'object',
            properties: {
              app_target: {
                type: 'string',
                enum: ['premiere', 'aftereffects', 'any'],
                default: 'any',
                description: 'Target application. Use any to select the first connected Adobe panel.',
              },
            },
          },
        },
        {
          name: 'adobe_cep_bridge_command',
          description: 'Sends an action or ExtendScript command to an active Adobe Premiere Pro or After Effects session via the local CEP bridge.',
          inputSchema: {
            type: 'object',
            properties: {
              app_target: {
                type: 'string',
                enum: ['premiere', 'aftereffects', 'any'],
                default: 'any',
                description: 'Target Adobe host application.',
              },
              action: {
                type: 'string',
                description: 'Action to perform, e.g. "evalScript", "getTimelineInfo", "cutAtPlayhead", "createMarker".',
              },
              params: {
                type: 'object',
                description: 'Parameters for the action.',
              },
            },
            required: ['action'],
          },
        },
        {
          name: 'premiere_toolkit',
          description: 'Premiere toolkit (generic verbs, no style): catalog, project model, timeline (insert/overwrite/razor/removeClip/subclip), applyTransition, markers, clipMotion/clipVolume/clipSpeed, declarative multi-track assemble, media import/bins, export (direct or AME queue), SRT caption tracks, renderFrame/contactSheet (native MCP image blocks) and saveSafe (non-modal save/version/as). Effects apply is NOT supported by the Premiere API (returns supported:false). Pass expected_project to abort before editing the wrong project.',
          inputSchema: {
            type: 'object',
            properties: {
              verb: {
                type: 'string',
                description:
                  'catalog | project | insert | overwrite | razor | removeClip | subclip | applyTransition | applyEffect | marker | clearMarkers | save | saveSafe | renderFrame | contactSheet | clipMotion | clipVolume | clipSpeed | assemble | import | bin | export | importSrt',
                enum: [
                  'catalog', 'project', 'insert', 'overwrite', 'razor', 'removeClip', 'subclip',
                  'applyTransition', 'applyEffect', 'marker', 'clearMarkers', 'save', 'saveSafe',
                  'renderFrame', 'contactSheet', 'clipMotion', 'clipVolume', 'clipSpeed', 'assemble',
                  'import', 'bin', 'export', 'importSrt',
                ],
              },
              params: {
                type: 'object',
                description: 'Parameters for the verb.',
              },
              expected_project: {
                type: 'string',
                description: 'Optional project name guard. If the active projectName differs, the call aborts before touching the project.',
              },
            },
            required: ['verb'],
          },
        },
        {
          name: 'premiere_uxp_toolkit',
          description: 'Premiere Pro UXP toolkit (v25.6+/27.0) for what ExtendScript/QE cannot do: list/add/remove effects by matchName, read MOGRT (Essential Graphics) parameters, set a parameter/keyframe and run atomic undo transactions. Requires the Studio Bridge UXP plugin loaded in Premiere. The UXP connection is isolated from the CEP panel.',
          inputSchema: {
            type: 'object',
            properties: {
              verb: {
                type: 'string',
                description:
                  'status | effectsList | effectsAdd | effectsRemove | clipParams | clipParamSet',
                enum: ['status', 'effectsList', 'effectsAdd', 'effectsRemove', 'clipParams', 'clipParamSet'],
              },
              params: {
                type: 'object',
                description:
                  'Verb parameters: { filter?, matchName?, kind?, track?(0-based), clips?[], name?(regex) } for effects; { clips?, component?, param?, value?, at? } for params.',
              },
              expected_project: {
                type: 'string',
                description: 'Optional project name guard. If the active projectName differs, the call aborts before touching the project.',
              },
            },
            required: ['verb'],
          },
        },
        {
          name: 'aftereffects_toolkit',
          description: 'After Effects toolkit: comps, layers (enabled/audioEnabled/guideLayer/motionBlur/samplingQuality/trackMatte), settings, shapes (shapeGroup), text/textStyle (resetCharStyle, tracking, leading, allCaps, hex/RGB fillColor, string/numeric justification), effects, keyframes (set with path/[i] resolution and separate X/Y dimensions), ensureKeysAfter (continuity: deletes only keys after afterTime), expressions, masks/roto, tracking, markers, import, render, batch transactions, halo, measure/alignAnchor/check (alwaysZeroOpacity + layerCoversText warnings), zStack (deterministic top/bottom layer order), pose (read-only valueAtTime transform snapshot), compare (REF | AE JPEG mosaic) and save. renderFrame accepts params.path or params.outputPath (validated against ANTIGRAVITY_WRITABLE_ROOTS): the PNG is written exactly there, returned in `path` and never deleted. contactSheet returns ONE JPEG grid with timestamps burned into each tile plus {path, times, count}. renderFrame/contactSheet/compare return native MCP image blocks (base64 outside the JSON text); measure/check/pose/compare are read-only. Pass expected_project to abort before editing the wrong project.',
          inputSchema: {
            type: 'object',
            properties: {
              verb: {
                type: 'string',
                description:
                  'project | catalog | comp | layer | settings | shape | fill | text | textStyle | textAnimator | camera | light | effect | effectParam | effectKey | transform | keyframe | expression | mask | roto | tracker | marker | import | folder | items | render | renderOutput | renderFrame | selection | save | set | ensureKeysAfter | measure | alignAnchor | shapeGroup | halo | batch | check | contactSheet | zStack | pose | compare',
                enum: [
                  'project', 'catalog', 'comp', 'layer', 'settings', 'shape', 'fill', 'text',
                  'textStyle', 'textAnimator', 'camera', 'light', 'effect', 'effectParam',
                  'effectKey', 'transform', 'keyframe', 'expression', 'mask', 'roto', 'tracker',
                  'marker', 'import', 'folder', 'items', 'render', 'renderOutput', 'renderFrame',
                  'selection', 'save', 'set', 'ensureKeysAfter', 'measure', 'alignAnchor', 'shapeGroup',
                  'halo', 'batch', 'check', 'contactSheet', 'zStack', 'pose', 'compare',
                ],
              },
              params: {
                type: 'object',
                description: 'Parameters for the verb: { comp, layer, path, time }, layer flags, text style, set/ensureKeysAfter { afterTime, keyframes, xKeyframes, yKeyframes, zKeyframes }, zStack { order, bottom }, pose { layers, time } or compare { referencePath, times, path, tileWidth }.',
              },
              expected_project: {
                type: 'string',
                description: 'Optional project name guard. If the active projectName differs, the call aborts before touching the project.',
              },
            },
            required: ['verb'],
          },
        },
        {
          name: 'adobe_cep_bridge_status',
          description: 'Checks the connection status of the local Adobe CEP bridge, returning active connections and bridge port info.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'adobe_panel_notify',
          description: 'Sends real-time updates directly into the Premiere Pro / After Effects Studio Bridge panel. Can update the step-by-step task progress widget (stepper) or post chat messages from the AI assistant.',
          inputSchema: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['agent_chat', 'task_progress'],
                description: 'Notification type: "agent_chat" for messages or "task_progress" for live stepper updates.',
              },
              text: {
                type: 'string',
                description: 'Markdown message for the chat (when type is "agent_chat").',
              },
              task_action: {
                type: 'string',
                enum: ['start', 'step', 'complete'],
                description: 'Stepper action (when type is "task_progress").',
              },
              title: {
                type: 'string',
                description: 'Task name/title for the stepper.',
              },
              steps: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of step titles when starting a task.',
              },
              step_index: {
                type: 'number',
                description: 'Current active step index (0-based).',
              },
              percent: {
                type: 'number',
                description: 'Progress percentage (0 to 100).',
              },
              subtitle: {
                type: 'string',
                description: 'Short status message under the task title.',
              },
            },
            required: ['type'],
          },
        },
        {
          name: 'adobe_get_panel_prompts',
          description: 'Retrieves the list of prompts and instructions submitted by the user through the Adobe Premiere Pro / After Effects panel chat.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'adobe_guide',
          description: 'Read-only cheat sheet of the Studio Bridge engine invariants (ExtendScript ES3 limits, sourceRectAtTime, easing by propertyValueType, Blur Bounds on shape layers) plus the available AE/Premiere toolkit verbs. Call it before writing After Effects automation.',
          inputSchema: {
            type: 'object',
            properties: {
              topic: {
                type: 'string',
                enum: ['ae', 'premiere', 'all'],
                default: 'all',
                description: 'Which host guide to return. Default: all.',
              },
            },
          },
        },
      ],
    };
  });

  // Handle tool executions
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'video_get_info': {
          const info = await getMediaInfo(args.file_path);
          return {
            content: [{ type: 'text', text: JSON.stringify(info, null, 2) }],
          };
        }

        case 'video_lossless_cut': {
          const result = await losslessCut(
            args.input_path,
            args.output_path,
            args.start_time,
            args.end_time
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        case 'video_extract_audio': {
          const result = await extractAudio(
            args.input_path,
            args.output_path,
            args.format,
            args.sample_rate
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        case 'video_detect_silences': {
          const result = await detectSilences(
            args.input_path,
            args.noise_threshold_db,
            args.min_duration_sec
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        case 'video_generate_proxy': {
          const result = await generateProxy(
            args.input_path,
            args.output_path,
            args.height,
            args.crf
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        case 'video_extract_frame': {
          const result = await extractFrame(args.input_path, args.output_path, args.time_seconds);
          const meta = {
            success: result.success,
            action: result.action,
            outputPath: result.outputPath,
            timeSeconds: result.timeSeconds,
            width: result.width,
            height: result.height,
          };
          return await imageResultFromFile(meta, result.outputPath, { maxWidth: 1600 });
        }

        case 'video_contact_sheet': {
          const result = await createVideoContactSheet(args.input_path, args.output_path, {
            from: args.from,
            to: args.to,
            every: args.every,
            cols: args.cols,
            tileWidth: args.tile_width,
            maxTiles: args.max_tiles,
          });
          const meta = {
            success: true,
            action: 'contactSheet',
            outputPath: result.path,
            count: result.count,
            cols: result.cols,
            rows: result.rows,
            from: result.from,
            to: result.to,
            every: result.every,
            strategy: result.strategy,
            timestampsBurned: result.timestampsBurned,
            timestamps: result.timestamps,
          };
          return await imageResultFromFile(meta, result.path, { maxWidth: 1920 });
        }

        case 'video_transcribe': {
          const tmpWav = path.join(os.tmpdir(), `antigravity_tts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.wav`);
          try {
            await extractAudio(args.input_path, tmpWav, 'wav', 16000);
            const result = await transcribeAudio(tmpWav, { language: args.language });
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            };
          } finally {
            try { fs.unlinkSync(tmpWav); } catch (_) {}
          }
        }

        case 'aftereffects_execute_extendscript': {
          requireArbitraryJs();
          // Route through the CEP bridge so the script runs in the already-open
          // After Effects instance (reliable), with a JSON result from the host.
          const result = await sendCommand(
            'aftereffects',
            'evalCustom',
            { code: args.script },
            args.timeout_ms || 60000
          );
          const payload = result && typeof result === 'object' ? result : { result };
          // ExtendScript errors carry the failing line in `err.line`; never drop
          // it, and never hide the error behind a generic success envelope.
          if (payload.success === false || payload.error) {
            const line =
              payload.line !== undefined && payload.line !== null
                ? payload.line
                : payload.err && payload.err.line !== undefined
                  ? payload.err.line
                  : null;
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      success: false,
                      error: payload.error || 'ExtendScript error',
                      line,
                      result:
                        payload.result === undefined || payload.result === null
                          ? null
                          : payload.result,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          };
        }

        case 'adobe_get_project_snapshot': {
          const result = await sendCepCommand(args.app_target || 'any', 'getProjectSnapshot', {}, 60000);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        case 'adobe_cep_bridge_command': {
          let cepParams = args.params;
          if (
            cepParams &&
            typeof cepParams === 'object' &&
            (cepParams.verb === 'renderFrame' || cepParams.verb === 'contactSheet')
          ) {
            cepParams = { ...cepParams, params: normalizeToolkitParams(cepParams.verb, cepParams.params) };
          }
          gateCepWrite(args.action, cepParams);
          const result = await sendCommand(args.app_target, args.action, cepParams);
          if (
            args.action === 'toolkit_ae' &&
            cepParams &&
            cepParams.verb === 'renderFrame' &&
            result &&
            result.ok &&
            typeof result.base64 === 'string' &&
            result.base64
          ) {
            return await frameResultToImageResult(result);
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        case 'premiere_toolkit': {
          const params = normalizeToolkitParams(args.verb, args.params);
          if (args.expected_project !== undefined && args.expected_project !== null) {
            params.expectedProject = String(args.expected_project);
          }
          gateCepWrite('toolkit', { verb: args.verb, params });
          const guard = await assertExpectedProject('premiere', args.expected_project, sendCommand);
          const result = await sendCommand(
            'premiere',
            'toolkit',
            { verb: args.verb, params },
            120000
          );
          if (
            args.verb === 'renderFrame' &&
            result &&
            result.ok &&
            typeof result.base64 === 'string' &&
            result.base64
          ) {
            return await frameResultToImageResult(result, guard);
          }
          if (
            args.verb === 'contactSheet' &&
            result &&
            result.ok === true &&
            Array.isArray(result.paths) &&
            result.paths.length > 0
          ) {
            return await packContactSheet(result, params, guard);
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(withProjectGuard(result, guard), null, 2) }],
          };
        }

        case 'premiere_uxp_toolkit': {
          const params = { ...(args.params || {}) };
          if (args.expected_project !== undefined && args.expected_project !== null) {
            params.expectedProject = String(args.expected_project);
          }
          const guard = await assertExpectedProject(
            premiereGuardTarget(),
            args.expected_project,
            sendCommand
          );
          const result = await sendCommand(
            'premiere_uxp',
            'toolkit_uxp',
            { verb: args.verb, params },
            120000
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(withProjectGuard(result, guard), null, 2) }],
          };
        }

        case 'aftereffects_toolkit': {
          const params = normalizeToolkitParams(args.verb, args.params);
          if (args.expected_project !== undefined && args.expected_project !== null) {
            params.expectedProject = String(args.expected_project);
          }
          gateCepWrite('toolkit_ae', { verb: args.verb, params });
          const guard = await assertExpectedProject('aftereffects', args.expected_project, sendCommand);
          if (args.verb === 'compare') {
            return await runAeCompare(params, sendCommand, guard);
          }
          const result = await sendCommand(
            'aftereffects',
            'toolkit_ae',
            { verb: args.verb, params },
            120000
          );
          if (
            args.verb === 'contactSheet' &&
            result &&
            result.ok === true &&
            Array.isArray(result.paths) &&
            result.paths.length > 0
          ) {
            return await packAeContactSheet(result, params, guard);
          }
          if (
            args.verb === 'renderFrame' &&
            result &&
            result.ok &&
            typeof result.base64 === 'string' &&
            result.base64
          ) {
            return await frameResultToImageResult(result, guard);
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(withProjectGuard(result, guard), null, 2) }],
          };
        }

        case 'adobe_cep_bridge_status': {
          const aeExe = findAfterEffectsExe();
          const status = getBridgeStatus();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    listening: status.listening,
                    bridgePort: status.port,
                    connectedApps: status.connectedApps,
                    isAfterEffectsInstalled: Boolean(aeExe),
                    afterEffectsPath: aeExe,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'adobe_panel_notify': {
          let payload = {};
          if (args.type === 'agent_chat') {
            payload = {
              type: 'agent_chat',
              text: args.text || '',
              actionCard: args.action_card || null,
            };
          } else if (args.type === 'task_progress') {
            payload = {
              type: 'task_progress',
              action: args.task_action || 'step',
              title: args.title || '',
              steps: args.steps || [],
              stepIndex: args.step_index || 0,
              percent: args.percent || 0,
              subtitle: args.subtitle || '',
              message: args.subtitle || '',
            };
          }
          const sentCount = broadcastToPanel(payload);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ success: true, panelsNotified: sentCount }, null, 2),
              },
            ],
          };
        }

        case 'adobe_get_panel_prompts': {
          const prompts = getRecentPrompts();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ count: prompts.length, prompts }, null, 2),
              },
            ],
          };
        }

        case 'adobe_guide': {
          const guide = buildAdobeGuide(args.topic);
          return {
            content: [{ type: 'text', text: JSON.stringify(guide, null, 2) }],
          };
        }

        default:
          throw new Error(`Unknown tool name: ${name}`);
      }
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error executing ${name}: ${error.message || String(error)}`,
          },
        ],
      };
    }
  });


  return server;
}

// CLI entry: run as a stdio MCP server (single-agent mode) when executed directly.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const bridgeConfigDir = path.join(os.homedir(), '.antigravity-studio-bridge');
  initCepBridge(bridgeConfigDir);
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
