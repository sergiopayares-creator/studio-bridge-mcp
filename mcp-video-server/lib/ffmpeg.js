import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {
  sanitizePath,
  sanitizeTimestamp,
  validateNumber,
  assertWritablePath,
  assertNotSamePath,
} from './security.js';

// Helper for exact 3-decimal (millisecond) numeric precision
const toMillis = (val) => {
  if (val === null || val === undefined) return null;
  const num = typeof val === 'number' ? val : parseFloat(val);
  return isNaN(num) ? null : Number(num.toFixed(3));
};

// Resolve binary path reliably in Windows
function getBinaryPath(name) {
  // Check known winget Gyan path first
  const wingetBase = path.join(
    process.env.LOCALAPPDATA || '',
    'Microsoft',
    'WinGet',
    'Packages'
  );
  if (fs.existsSync(wingetBase)) {
    try {
      const items = fs.readdirSync(wingetBase);
      const ffmpegDir = items.find(d => d.toLowerCase().includes('gyan.ffmpeg'));
      if (ffmpegDir) {
        const fullBuild = path.join(wingetBase, ffmpegDir, 'ffmpeg-9.0.2-full_build', 'bin', `${name}.exe`);
        if (fs.existsSync(fullBuild)) return fullBuild;
      }
    } catch (_) {}
  }
  // Default to system PATH
  return name;
}

export const FFMPEG_BIN = getBinaryPath('ffmpeg');
export const FFPROBE_BIN = getBinaryPath('ffprobe');

function runExecFile(bin, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 50 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          error.stdout = stdout;
          return reject(error);
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

/**
 * Inspects a media file and returns a concise, token-optimized JSON summary.
 * All duration numbers are normalized to 3 decimal places (milliseconds).
 */
export async function getMediaInfo(filePath) {
  const safePath = sanitizePath(filePath, true);
  const args = [
    '-v', 'error',
    '-show_entries', 'format=duration,size,bit_rate,format_name:stream=index,codec_name,codec_type,width,height,r_frame_rate,sample_rate,channels',
    '-of', 'json',
    safePath
  ];

  const { stdout } = await runExecFile(FFPROBE_BIN, args, 15000);
  const parsed = JSON.parse(stdout);

  const format = parsed.format || {};
  const streams = (parsed.streams || []).map(s => {
    const base = {
      index: s.index,
      type: s.codec_type,
      codec: s.codec_name,
    };
    if (s.codec_type === 'video') {
      base.width = s.width;
      base.height = s.height;
      if (s.r_frame_rate) {
        const [num, den] = s.r_frame_rate.split('/').map(Number);
        base.fps = den ? Math.round((num / den) * 100) / 100 : s.r_frame_rate;
      }
    } else if (s.codec_type === 'audio') {
      base.sampleRate = s.sample_rate ? parseInt(s.sample_rate, 10) : undefined;
      base.channels = s.channels;
    }
    return base;
  });

  return {
    file: path.basename(safePath),
    fullPath: safePath,
    durationSeconds: toMillis(format.duration),
    sizeMB: format.size ? Math.round((parseInt(format.size, 10) / (1024 * 1024)) * 100) / 100 : null,
    format: format.format_name,
    streams
  };
}

/**
 * Cuts a video losslessly without re-rendering (-c copy). Instant execution.
 */
export async function losslessCut(inputPath, outputPath, startTime, endTime) {
  const safeIn = sanitizePath(inputPath, true);
  const safeOut = sanitizePath(outputPath, false);
  assertNotSamePath(safeIn, safeOut);
  assertWritablePath(safeOut);
  const safeStart = sanitizeTimestamp(startTime);

  const args = ['-y', '-ss', safeStart];
  if (endTime !== undefined && endTime !== null && endTime !== '') {
    const safeEnd = sanitizeTimestamp(endTime);
    args.push('-to', safeEnd);
  }

  args.push('-i', safeIn, '-c', 'copy', '-avoid_negative_ts', 'make_zero', safeOut);

  await runExecFile(FFMPEG_BIN, args, 60000);

  return {
    success: true,
    action: 'losslessCut',
    outputPath: safeOut,
    startTime: safeStart,
    endTime: endTime || 'end_of_file'
  };
}

/**
 * Extracts audio track from video file (WAV, MP3, etc.)
 */
export async function extractAudio(inputPath, outputPath, format = 'wav', sampleRate = 16000) {
  const safeIn = sanitizePath(inputPath, true);
  const safeOut = sanitizePath(outputPath, false);
  assertNotSamePath(safeIn, safeOut);
  assertWritablePath(safeOut);
  const safeRate = validateNumber(sampleRate, { name: 'sample_rate', min: 8000, max: 384000 });

  const args = ['-y', '-i', safeIn, '-vn'];

  if (format === 'wav') {
    args.push('-acodec', 'pcm_s16le', '-ar', String(safeRate), '-ac', '1', safeOut);
  } else if (format === 'mp3') {
    args.push('-acodec', 'libmp3lame', '-b:a', '192k', safeOut);
  } else {
    args.push('-c:a', 'copy', safeOut);
  }

  await runExecFile(FFMPEG_BIN, args, 120000);

  return {
    success: true,
    action: 'extractAudio',
    outputPath: safeOut,
    format,
    sampleRate: format === 'wav' ? sampleRate : 'default'
  };
}

/**
 * Detects silences in an audio/video file and returns exact timestamps with millisecond precision (3 decimals).
 * Runs 100% locally with 0 token cost, producing ready-to-cut segments.
 */
export async function detectSilences(inputPath, noiseThresholdDb = -30, minDurationSec = 0.5) {
  const safeIn = sanitizePath(inputPath, true);
  const safeNoise = validateNumber(noiseThresholdDb, { name: 'noise_threshold_db', min: -90, max: 0 });
  const safeMin = validateNumber(minDurationSec, { name: 'min_duration_sec', min: 0.05, max: 60 });
  const filter = `silencedetect=noise=${safeNoise}dB:d=${safeMin}`;

  const args = [
    '-i', safeIn,
    '-af', filter,
    '-f', 'null',
    '-'
  ];

  const { stderr } = await runExecFile(FFMPEG_BIN, args, 180000);

  const silences = [];
  let currentStart = null;

  const lines = stderr.split('\n');
  for (const line of lines) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
    if (startMatch) {
      currentStart = parseFloat(startMatch[1]);
    }
    const endMatch = line.match(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/);
    if (endMatch && currentStart !== null) {
      const end = parseFloat(endMatch[1]);
      const duration = parseFloat(endMatch[2]);
      silences.push({
        start: toMillis(currentStart),
        end: toMillis(end),
        duration: toMillis(duration)
      });
      currentStart = null;
    }
  }

  return {
    inputFile: path.basename(safeIn),
    totalSilencesFound: silences.length,
    silences,
    noiseThresholdDb: safeNoise,
    minDurationSec: safeMin
  };
}

/**
 * Generates an editing proxy (e.g. 720p or 540p lightweight H.264)
 */
export async function generateProxy(inputPath, outputPath, height = 720, crf = 26) {
  const safeIn = sanitizePath(inputPath, true);
  const safeOut = sanitizePath(outputPath, false);
  assertNotSamePath(safeIn, safeOut);
  assertWritablePath(safeOut);
  const safeHeight = validateNumber(height, { name: 'height', min: 120, max: 4320 });
  const safeCrf = validateNumber(crf, { name: 'crf', min: 0, max: 51 });

  const scaleFilter = `scale=-2:${safeHeight}`;
  const args = [
    '-y',
    '-i', safeIn,
    '-vf', scaleFilter,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', String(safeCrf),
    '-c:a', 'aac',
    '-b:a', '128k',
    safeOut
  ];

  await runExecFile(FFMPEG_BIN, args, 300000);

  return {
    success: true,
    action: 'generateProxy',
    outputPath: safeOut,
    targetHeight: safeHeight
  };
}

/**
 * Extracts a single still frame (JPEG) from a video at a given time.
 * This gives an agent "eyes": it can ask for a preview frame of a clip and
 * then read the resulting image.
 */
export async function extractFrame(inputPath, outputPath, timeSeconds = 0) {
  const safeIn = sanitizePath(inputPath, true);
  const safeOut = sanitizePath(outputPath, false);
  assertNotSamePath(safeIn, safeOut);
  assertWritablePath(safeOut);
  const safeTime = validateNumber(timeSeconds, { name: 'time_seconds', min: 0, max: 86400 });

  const args = [
    '-y',
    '-ss', String(safeTime),
    '-i', safeIn,
    '-frames:v', '1',
    '-q:v', '2',
    safeOut
  ];

  await runExecFile(FFMPEG_BIN, args, 30000);

  let width = null;
  let height = null;
  let base64 = null;
  try {
    const probe = await getMediaInfo(safeOut);
    const videoStream = (probe.streams || []).find((s) => s.type === 'video');
    if (videoStream) {
      width = videoStream.width || null;
      height = videoStream.height || null;
    }
    if (fs.existsSync(safeOut)) {
      const buf = fs.readFileSync(safeOut);
      if (buf.length <= 8 * 1024 * 1024) {
        base64 = buf.toString('base64');
      }
    }
  } catch (_) {}

  return {
    success: true,
    action: 'extractFrame',
    outputPath: safeOut,
    timeSeconds: safeTime,
    width,
    height,
    base64Data: base64 ? `data:image/jpeg;base64,${base64}` : null
  };
}

// --- MCP image helpers ------------------------------------------------------
// Images travel to the agent as their own MCP content block ({type:'image'}).
// Everything below returns clean base64 (no data: prefix), never a giant
// string embedded in JSON.

/** Removes whitespace and an optional `data:<mime>;base64,` prefix. */
export function cleanBase64(value) {
  return String(value || '')
    .replace(/^data:[^;]+;base64,/i, '')
    .replace(/\s+/g, '');
}

function randomSuffix() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function evenNumber(n) {
  const v = Math.max(2, Math.round(n));
  return v % 2 === 0 ? v : v + 1;
}

export function formatHms(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = (total % 60).toFixed(2);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${secs.padStart(5, '0')}`;
}

function escapeFilterPath(p) {
  return String(p).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function escapeDrawtextText(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
}

// drawtext needs a font file on Windows (fontconfig is not always available),
// so we look for the usual system fonts and degrade gracefully when missing.
function findDrawtextFont() {
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
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {}
  }
  return null;
}

function drawtextFilter({ fontFile, fontSize, text, expression = false }) {
  const font = fontFile ? `fontfile='${escapeFilterPath(fontFile)}':` : '';
  const value = expression ? text : escapeDrawtextText(text);
  return (
    `drawtext=${font}text='${value}':x=8:y=h-${Math.round(fontSize + 12)}` +
    `:fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=4`
  );
}

// Uses the first image aspect ratio so every grid cell shares one pixel size
// (concat/tile require identical frame geometry).
async function detectTileHeight(imagePath, tileWidth) {
  let aspect = 9 / 16;
  try {
    const info = await getMediaInfo(imagePath);
    const stream = (info.streams || []).find((s) => s.type === 'video' && s.width && s.height);
    if (stream) aspect = stream.height / stream.width;
  } catch (_) {}
  return evenNumber(tileWidth * aspect);
}

/**
 * Builds a lightweight JPEG contact sheet (grid mosaic) from still images that
 * were already captured on disk.
 *
 * @param {string[]} imagePaths PNG/JPG files (in grid order).
 * @param {string} outputPath Destination .jpg.
 * @param {{cols?:number, tileWidth?:number, quality?:number, labels?:string[]}} options
 *   `labels[i]` is burned (drawtext) into tile i, e.g. the frame timestamp. When
 *   no font file is available the mosaic is still produced, only without text.
 * @returns {Promise<{success:boolean, path:string, count:number, cols:number, rows:number,
 *   tileWidth:number, tileHeight:number, width:number, height:number,
 *   timestampsBurned:boolean}>}
 */
export async function createContactSheetFromImages(imagePaths, outputPath, options = {}) {
  const opts = options || {};
  if (!Array.isArray(imagePaths) || imagePaths.length === 0) {
    throw new Error('createContactSheetFromImages requires a non-empty array of image paths');
  }
  if (imagePaths.length > 64) {
    throw new Error('A contact sheet supports at most 64 images');
  }
  const safeOut = sanitizePath(outputPath, false);
  if (!opts.internal) assertWritablePath(safeOut);
  const inputs = imagePaths.map((p) => sanitizePath(p, true));

  const cols = Math.round(validateNumber(opts.cols === undefined ? 4 : opts.cols, { name: 'cols', min: 1, max: 12 }));
  const tileWidth = evenNumber(
    validateNumber(opts.tileWidth === undefined ? 360 : opts.tileWidth, { name: 'tileWidth', min: 64, max: 3840 })
  );
  const quality = Math.round(validateNumber(opts.quality === undefined ? 4 : opts.quality, { name: 'quality', min: 1, max: 31 }));

  // Optional per-tile timestamp labels (contact sheets for agents).
  const labels = Array.isArray(opts.labels) ? opts.labels : null;
  const hasLabels = Boolean(
    labels && labels.some((label) => label !== undefined && label !== null && String(label).trim() !== '')
  );
  const fontFile = hasLabels ? findDrawtextFont() : null;
  const fontSize = Math.max(12, Math.round(tileWidth * 0.055));

  const count = inputs.length;
  const rows = Math.ceil(count / cols);
  const tileHeight = await detectTileHeight(inputs[0], tileWidth);

  const chains = inputs.map((_, i) => {
    const label =
      hasLabels && labels[i] !== undefined && labels[i] !== null ? String(labels[i]) : '';
    const textFilter = fontFile && label ? `,${drawtextFilter({ fontFile, fontSize, text: label })}` : '';
    return (
      `[${i}:v]scale=${tileWidth}:${tileHeight}:force_original_aspect_ratio=decrease,` +
      `pad=${tileWidth}:${tileHeight}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1` +
      `${textFilter},format=yuv420p[v${i}]`
    );
  });
  const concatInputs = inputs.map((_, i) => `[v${i}]`).join('');
  chains.push(`${concatInputs}concat=n=${count}:v=1:a=0[sheetseq]`);
  chains.push(`[sheetseq]tile=${cols}x${rows}[sheet]`);

  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const input of inputs) args.push('-i', input);
  args.push(
    '-filter_complex',
    chains.join(';'),
    '-map',
    '[sheet]',
    '-frames:v',
    '1',
    '-update',
    '1',
    '-q:v',
    String(quality),
    '-pix_fmt',
    'yuvj420p',
    safeOut
  );

  await runExecFile(FFMPEG_BIN, args, 180000);

  return {
    success: true,
    path: safeOut,
    count,
    cols,
    rows,
    tileWidth,
    tileHeight,
    width: tileWidth * cols,
    height: tileHeight * rows,
    timestampsBurned: Boolean(fontFile && hasLabels),
  };
}

async function extractTileFrame(inputPath, outputPath, timeSeconds, filter) {
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(timeSeconds),
    '-i',
    inputPath,
    '-frames:v',
    '1',
    '-update',
    '1',
    '-vf',
    filter,
    '-pix_fmt',
    'rgb24',
    outputPath,
  ];
  await runExecFile(FFMPEG_BIN, args, 60000);
}

/**
 * Builds a contact sheet directly from a video: samples `maxTiles` frames
 * between `from` and `to`, burns each timestamp into its cell and returns a
 * single JPEG.
 *
 * Fast path: when the step between frames is >= 4 s, each tile is captured with
 * a fast input seek (`-ss` before `-i`), which is far cheaper than decoding the
 * whole range. Dense ranges are sampled in one pass with fps+tile.
 *
 * @param {string} videoPath
 * @param {string} outputPath
 * @param {{from?:number, to?:number, every?:number, cols?:number, tileWidth?:number, maxTiles?:number}} options
 * @returns {Promise<{success:boolean, path:string, count:number, cols:number, rows:number,
 *   from:number, to:number, every:number, timestamps:number[], timestampsBurned:boolean,
 *   strategy:'fast-seek'|'single-pass'}>}
 */
export async function createVideoContactSheet(videoPath, outputPath, options = {}) {
  const opts = options || {};
  const safeIn = sanitizePath(videoPath, true);
  const safeOut = sanitizePath(outputPath, false);
  assertNotSamePath(safeIn, safeOut);
  assertWritablePath(safeOut);

  const cols = Math.round(validateNumber(opts.cols === undefined ? 4 : opts.cols, { name: 'cols', min: 1, max: 8 }));
  const tileWidth = evenNumber(
    validateNumber(opts.tileWidth === undefined ? 320 : opts.tileWidth, { name: 'tileWidth', min: 64, max: 1920 })
  );
  const maxTiles = Math.round(
    validateNumber(opts.maxTiles === undefined ? 16 : opts.maxTiles, { name: 'maxTiles', min: 1, max: 64 })
  );
  const from = validateNumber(opts.from === undefined ? 0 : opts.from, { name: 'from', min: 0, max: 86400 });

  let to =
    opts.to === undefined || opts.to === null || opts.to === ''
      ? null
      : validateNumber(opts.to, { name: 'to', min: 0, max: 86400 });
  let every =
    opts.every === undefined || opts.every === null || opts.every === ''
      ? null
      : validateNumber(opts.every, { name: 'every', min: 0.05, max: 3600 });

  let duration = null;
  if (to === null || every === null) {
    try {
      const info = await getMediaInfo(safeIn);
      duration = info.durationSeconds;
    } catch (_) {}
  }
  if (to === null) {
    if (!duration || !Number.isFinite(duration)) {
      throw new Error('Could not determine the video duration; pass `to` explicitly.');
    }
    to = duration;
  }
  if (to - from < 0.05) {
    throw new Error(`Invalid range: to (${to}) must be greater than from (${from})`);
  }
  const span = to - from;
  if (every === null) {
    every = Math.max(0.05, Math.round((span / maxTiles) * 1000) / 1000);
  }

  const timestamps = [];
  for (let i = 0; i < maxTiles; i++) {
    const t = Number((from + i * every).toFixed(3));
    if (t >= to - 0.0001) break;
    timestamps.push(t);
  }
  if (timestamps.length === 0) timestamps.push(Number(from.toFixed(3)));
  const rows = Math.ceil(timestamps.length / cols);

  const fontFile = findDrawtextFont();
  const fontSize = Math.max(12, Math.round(tileWidth * 0.055));

  // Fast path: sparse tiles -> one fast seek per frame, then grid them.
  if (every >= 4) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity_sheet_'));
    let timestampsBurned = Boolean(fontFile);
    try {
      const frames = [];
      for (const t of timestamps) {
        const framePath = path.join(tmpDir, `frame_${String(frames.length).padStart(3, '0')}.png`);
        const hasFrame = () => {
          try {
            return fs.statSync(framePath).size > 0;
          } catch (_) {
            return false;
          }
        };
        let captured = false;
        if (fontFile) {
          const filter = `scale=${tileWidth}:-2,${drawtextFilter({ fontFile, fontSize, text: formatHms(t) })}`;
          try {
            await extractTileFrame(safeIn, framePath, t, filter);
            captured = hasFrame();
          } catch (_) {
            captured = false;
          }
          if (!captured) timestampsBurned = false;
        }
        if (!captured) {
          try {
            await extractTileFrame(safeIn, framePath, t, `scale=${tileWidth}:-2`);
          } catch (_) {}
          captured = hasFrame();
        }
        if (captured) frames.push(framePath);
      }

      if (frames.length === 0) {
        throw new Error('Could not capture any frame from the video for the contact sheet');
      }

      const sheet = await createContactSheetFromImages(frames, safeOut, { cols, tileWidth, quality: 4 });
      return {
        success: true,
        path: safeOut,
        count: sheet.count,
        cols,
        rows: sheet.rows,
        from,
        to,
        every,
        timestamps: timestamps.slice(0, sheet.count),
        timestampsBurned,
        strategy: 'fast-seek',
      };
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (_) {}
    }
  }

  // Dense path: single decode pass with fps + tile.
  const baseFilters = [`fps=${(1 / every).toFixed(6)}`];
  if (from > 0) baseFilters.push(`setpts=PTS+${from}/TB`);
  baseFilters.push(`scale=${tileWidth}:-2`);
  const tailFilters = [`tile=${cols}x${rows}`];

  const baseArgs = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(from),
    '-i',
    safeIn,
    '-t',
    String(span),
  ];
  const outArgs = [
    '-frames:v',
    '1',
    '-update',
    '1',
    '-q:v',
    '4',
    '-pix_fmt',
    'yuvj420p',
    safeOut,
  ];
  const runSinglePass = (filter) => runExecFile(FFMPEG_BIN, [...baseArgs, '-vf', filter, ...outArgs], 300000);

  let timestampsBurned = Boolean(fontFile);
  if (fontFile) {
    const withText = baseFilters
      .concat([drawtextFilter({ fontFile, fontSize, text: '%{pts\\:hms}', expression: true })])
      .concat(tailFilters)
      .join(',');
    try {
      await runSinglePass(withText);
    } catch (_) {
      timestampsBurned = false;
      await runSinglePass(baseFilters.concat(tailFilters).join(','));
    }
  } else {
    await runSinglePass(baseFilters.concat(tailFilters).join(','));
  }

  return {
    success: true,
    path: safeOut,
    count: Math.min(timestamps.length, cols * rows),
    cols,
    rows,
    from,
    to,
    every,
    timestamps: timestamps.slice(0, cols * rows),
    timestampsBurned,
    strategy: 'single-pass',
  };
}

/**
 * Extracts one exact frame from a video and writes it as a PNG (used by the
 * AE-vs-reference compare mosaic). Fails when ffmpeg cannot produce a frame.
 */
export async function extractFrameToPng(inputPath, outputPath, timeSeconds = 0, options = {}) {
  const opts = options || {};
  const safeIn = sanitizePath(inputPath, true);
  const safeOut = sanitizePath(outputPath, false);
  assertNotSamePath(safeIn, safeOut);
  // `internal` lo usan los temporales propios de compare (os.tmpdir), que no
  // deben quedar sujetos a ANTIGRAVITY_WRITABLE_ROOTS (esas raíces son para la
  // salida del usuario). La ruta explícita del JPEG final sí se valida.
  if (!opts.internal) assertWritablePath(safeOut);
  const t = validateNumber(timeSeconds, { name: 'timeSeconds', min: 0, max: 86400 });
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(t),
    '-i',
    safeIn,
    '-frames:v',
    '1',
    '-update',
    '1',
    safeOut,
  ];
  await runExecFile(FFMPEG_BIN, args, 60000);
  let size = 0;
  try {
    size = fs.statSync(safeOut).size;
  } catch (_) {
    size = 0;
  }
  if (!size) {
    throw new Error(`No se pudo extraer el frame de referencia en t=${t}s`);
  }
  return { path: safeOut, timeSeconds: t };
}

/**
 * Builds one side-by-side image (REF | AE) with optional timestamp burned in.
 * Both inputs are scaled/padded to the same tile size so hstack always works.
 *
 * @param {string} referencePath Reference frame (PNG/JPG).
 * @param {string} aePath AE frame (PNG/JPG).
 * @param {string} outputPath Destination PNG (or JPG).
 * @param {{tileWidth?:number, label?:string}} options
 * @returns {Promise<{path:string, width:number, height:number, timestampsBurned:boolean}>}
 */
export async function createSideBySidePair(referencePath, aePath, outputPath, options = {}) {
  const opts = options || {};
  const safeRef = sanitizePath(referencePath, true);
  const safeAe = sanitizePath(aePath, true);
  const safeOut = sanitizePath(outputPath, false);
  if (!opts.internal) assertWritablePath(safeOut);

  const width = evenNumber(
    validateNumber(opts.tileWidth === undefined ? 320 : opts.tileWidth, {
      name: 'tileWidth',
      min: 64,
      max: 1920,
    })
  );
  const height = await detectTileHeight(safeAe, width);
  const label = opts.label === undefined || opts.label === null ? '' : String(opts.label);
  const fontFile = label ? findDrawtextFont() : null;
  const fontSize = Math.max(12, Math.round(width * 0.055));
  const labelFilter =
    fontFile && label ? `,${drawtextFilter({ fontFile, fontSize, text: label })}` : '';

  const scaleChain = (index) =>
    `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
  const buildFilter = (textFilter) =>
    `${scaleChain(0)}[r];${scaleChain(1)}[a];` +
    `[r][a]hstack=inputs=2${textFilter},format=yuv420p[out]`;

  const baseArgs = ['-y', '-hide_banner', '-loglevel', 'error', '-i', safeRef, '-i', safeAe];
  const outArgs = [
    '-map',
    '[out]',
    '-frames:v',
    '1',
    '-update',
    '1',
    '-q:v',
    '3',
    '-pix_fmt',
    'yuvj420p',
    safeOut,
  ];

  let timestampsBurned = Boolean(fontFile && label);
  try {
    await runExecFile(
      FFMPEG_BIN,
      [...baseArgs, '-filter_complex', buildFilter(labelFilter), ...outArgs],
      120000
    );
  } catch (labelErr) {
    if (!timestampsBurned) throw labelErr;
    // drawtext falló (fuente denegada): conservar el par sin timestamp.
    timestampsBurned = false;
    await runExecFile(
      FFMPEG_BIN,
      [...baseArgs, '-filter_complex', buildFilter(''), ...outArgs],
      120000
    );
  }

  let size = 0;
  try {
    size = fs.statSync(safeOut).size;
  } catch (_) {
    size = 0;
  }
  if (!size) throw new Error('No se pudo componer el par REF | AE');

  return { path: safeOut, width: width * 2, height, timestampsBurned };
}

/**
 * Re-encodes any PNG/JPG file as a compact JPEG (capped at `maxWidth`) and
 * returns a clean base64 string (no data: prefix).
 */
export async function imageFileToJpegBase64(imagePath, maxWidth = 1280) {
  const safeIn = sanitizePath(imagePath, true);
  const width = Math.round(validateNumber(maxWidth, { name: 'maxWidth', min: 64, max: 8192 }));
  const tmpOut = path.join(os.tmpdir(), `antigravity_jpeg_${randomSuffix()}.jpg`);
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    safeIn,
    '-vf',
    `scale=w='min(iw,${width})':h=-2:flags=lanczos`,
    '-frames:v',
    '1',
    '-update',
    '1',
    '-q:v',
    '4',
    '-pix_fmt',
    'yuvj420p',
    tmpOut,
  ];
  try {
    await runExecFile(FFMPEG_BIN, args, 60000);
    const buffer = await fs.promises.readFile(tmpOut);
    if (!buffer.length) throw new Error('ffmpeg produced an empty JPEG');
    return buffer.toString('base64');
  } finally {
    try {
      fs.unlinkSync(tmpOut);
    } catch (_) {}
  }
}

/**
 * Converts an in-memory base64 image (e.g. the PNG returned by AE renderFrame)
 * into compact JPEG base64. Used when the original frame is too heavy to send
 * inline.
 */
export async function base64ImageToJpegBase64(base64Image, maxWidth = 1280) {
  const clean = cleanBase64(base64Image);
  if (!clean) throw new Error('Invalid or empty base64 image data');
  const buffer = Buffer.from(clean, 'base64');
  if (!buffer.length) throw new Error('Invalid base64 image data');
  if (buffer.length > 40 * 1024 * 1024) throw new Error('Image too large (max 40 MB)');

  const tmpIn = path.join(os.tmpdir(), `antigravity_img_${randomSuffix()}.png`);
  try {
    await fs.promises.writeFile(tmpIn, buffer);
    return await imageFileToJpegBase64(tmpIn, maxWidth);
  } finally {
    try {
      fs.unlinkSync(tmpIn);
    } catch (_) {}
  }
}
