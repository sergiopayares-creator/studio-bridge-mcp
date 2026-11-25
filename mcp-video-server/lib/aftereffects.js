import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { sanitizePath, assertWritablePath, assertNotSamePath, validateNumber } from './security.js';
import {
  createContactSheetFromImages,
  createSideBySidePair,
  extractFrameToPng,
  formatHms,
} from './ffmpeg.js';

const AE_PATHS = [
  'C:\\Program Files\\Adobe\\Adobe After Effects 2026\\Support Files\\AfterFX.exe',
  'C:\\Program Files\\Adobe\\Adobe After Effects 2025\\Support Files\\AfterFX.exe',
  'C:\\Program Files\\Adobe\\Adobe After Effects (Beta)\\Support Files\\AfterFX.exe'
];

export function findAfterEffectsExe() {
  for (const p of AE_PATHS) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

// --- Output paths ------------------------------------------------------------
// renderFrame accepts `params.path` and `params.outputPath` as aliases. The path
// is normalized and checked against ANTIGRAVITY_WRITABLE_ROOTS *before* it is
// sent to ExtendScript, so a prompt-injected agent cannot write anywhere on disk.
export function normalizeOutputPathParams(params) {
  const source = params && typeof params === 'object' ? params : {};
  const candidate =
    typeof source.path === 'string' && source.path.trim()
      ? source.path
      : typeof source.outputPath === 'string' && source.outputPath.trim()
        ? source.outputPath
        : '';
  if (!candidate) return { ...source };

  const resolved = sanitizePath(candidate, false);
  assertWritablePath(resolved);
  const normalized = { ...source, path: resolved };
  delete normalized.outputPath;
  return normalized;
}

// Backwards-friendly explicit name for the renderFrame verb.
export const normalizeRenderFrameParams = normalizeOutputPathParams;

// --- AE contactSheet packaging ----------------------------------------------
// toolkit_ae.jsx "contactSheet" writes one temporary PNG per requested timestamp
// (saveFrameToPng is deferred, so the files may not exist yet). This module waits
// for them, burns each timestamp into its tile, encodes ONE lightweight JPEG and
// removes the intermediate PNGs. The MCP layer only adds the image block.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isInsideTempDir(filePath) {
  try {
    const resolved = path.resolve(filePath);
    const temp = path.resolve(os.tmpdir());
    return resolved === temp || resolved.startsWith(temp + path.sep);
  } catch (_) {
    return false;
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND_CHUNK = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

export function isCompletePngBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 45) return false;
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  if (!buf.subarray(buf.length - 12).equals(PNG_IEND_CHUNK)) return false;
  return true;
}

export function isCompletePngFile(filePath) {
  let fd;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 45) return false;
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(8);
    const tail = Buffer.alloc(12);
    if (fs.readSync(fd, head, 0, 8, 0) !== 8) return false;
    if (fs.readSync(fd, tail, 0, 12, stat.size - 12) !== 12) return false;
    return head.equals(PNG_SIGNATURE) && tail.equals(PNG_IEND_CHUNK);
  } catch (_) {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (_) {}
    }
  }
}

function usableFrame(filePath) {
  return isCompletePngFile(filePath);
}

/**
 * Waits (bounded) until every path exists and is a complete PNG. Returns the
 * indexes of the frames that are ready, so timestamps stay aligned with their
 * image even when the host skipped a frame.
 */
export async function waitForFrameIndexes(paths, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ready = [];
    for (let i = 0; i < paths.length; i++) {
      if (usableFrame(paths[i])) ready.push(i);
    }
    if (ready.length === paths.length || Date.now() >= deadline) return ready;
    await sleep(100);
  }
}

/**
 * Composes the single JPEG contact sheet for the After Effects "contactSheet"
 * verb. Returns the metadata the MCP layer needs; intermediate host PNGs inside
 * the OS temp folder are deleted, the JPEG (explicit or temporary) is kept.
 *
 * @param {{ok?:boolean, comp?:string, times?:number[], paths?:string[]}} result
 * @param {{path?:string, outputPath?:string, cols?:number, tileWidth?:number}} params
 * @returns {Promise<{jpegPath:string, path:string, count:number, cols:number, rows:number,
 *   times:(number|null)[], missing:string[], timestampsBurned:boolean, cleaned:number}>}
 */
export async function buildContactSheetJpeg(result, params = {}) {
  const requested = Array.isArray(result && result.paths)
    ? result.paths.filter((p) => typeof p === 'string' && p.trim())
    : [];
  if (requested.length === 0) {
    throw new Error('contactSheet: el host no generó ningún PNG temporal');
  }

  const readyIndexes = await waitForFrameIndexes(requested, 10000);
  if (readyIndexes.length === 0) {
    throw new Error('contactSheet: el host no generó ningún PNG temporal');
  }

  const frames = readyIndexes.map((i) => requested[i]);
  const hostTimes = Array.isArray(result.times) ? result.times : [];
  const times = readyIndexes.map((i) => {
    const raw = hostTimes[i];
    if (raw === undefined || raw === null || raw === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  });
  const missing = requested.filter((_, i) => readyIndexes.indexOf(i) === -1);

  const explicitOut =
    typeof params.path === 'string' && params.path.trim()
      ? params.path
      : typeof params.outputPath === 'string' && params.outputPath.trim()
        ? params.outputPath
        : '';
  const outPath = explicitOut
    ? sanitizePath(explicitOut, false)
    : path.join(
        os.tmpdir(),
        `antigravity_ae_contactsheet_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`
      );
  const internalOut = !explicitOut;
  if (!internalOut) assertWritablePath(outPath);

  const labels = times.map((t, i) => (t === null ? `#${readyIndexes[i] + 1}` : formatHms(t)));
  const cols = Number(params.cols || 4);
  const tileWidth = Number(params.tileWidth || 360);

  let sheet;
  let timestampsBurned = false;
  try {
    try {
      sheet = await createContactSheetFromImages(frames, outPath, {
        cols,
        tileWidth,
        quality: 4,
        labels,
        internal: internalOut,
      });
      timestampsBurned = sheet.timestampsBurned === true;
    } catch (labelErr) {
      // A broken drawtext (missing/denied font) must not lose the whole mosaic:
      // retry once without text and report timestampsBurned:false.
      sheet = await createContactSheetFromImages(frames, outPath, {
        cols,
        tileWidth,
        quality: 4,
        internal: internalOut,
      });
      timestampsBurned = false;
    }
  } finally {
    // Never leave the host PNGs behind; never delete the requested JPEG.
    for (const frame of frames) {
      if (path.resolve(frame) !== path.resolve(outPath) && isInsideTempDir(frame)) {
        try {
          fs.unlinkSync(frame);
        } catch (_) {}
      }
    }
  }

  return {
    success: true,
    jpegPath: sheet.path,
    path: sheet.path,
    count: sheet.count,
    cols: sheet.cols,
    rows: sheet.rows,
    width: sheet.width,
    height: sheet.height,
    tileWidth: sheet.tileWidth,
    tileHeight: sheet.tileHeight,
    times: times.slice(0, sheet.count),
    missing,
    timestampsBurned,
    cleaned: frames.length,
  };
}

/**
 * Composes the AE-vs-reference compare mosaic: for every ready AE frame it
 * extracts the exact same time from `referencePath`, builds a REF | AE pair with
 * the timestamp burned in, and tiles all pairs into ONE JPEG.
 *
 * @param {{paths?:string[], times?:number[], comp?:string}} hostResult contactSheet result
 * @param {{referencePath:string, times:number[], path?:string, outputPath?:string, tileWidth?:number}} params
 * @returns {Promise<{path:string, times:number[], count:number, cols:number, rows:number,
 *   timestampsBurned:boolean, missing:string[]}>}
 */
export async function buildCompareSheet(hostResult, params = {}) {
  const referencePath = sanitizePath(params.referencePath, true);
  const requested = Array.isArray(hostResult && hostResult.paths)
    ? hostResult.paths.filter((p) => typeof p === 'string' && p.trim())
    : [];
  if (requested.length === 0) {
    throw new Error('compare: el host no generó frames de AE');
  }
  const hostTimes = Array.isArray(hostResult.times) ? hostResult.times : [];
  const paramTimes = Array.isArray(params.times) ? params.times : [];

  const readyIndexes = await waitForFrameIndexes(requested, 10000);
  if (readyIndexes.length === 0) {
    throw new Error('compare: el host no generó frames de AE');
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity_compare_'));
  const pairPaths = [];
  const usedTimes = [];
  let pairWidth = null;
  let timestampsBurned = true;

  try {
    for (let n = 0; n < readyIndexes.length; n++) {
      const idx = readyIndexes[n];
      let rawTime = hostTimes[idx];
      if (rawTime === undefined || rawTime === null || rawTime === '') rawTime = paramTimes[idx];
      const t = validateNumber(rawTime, { name: 'times', min: 0, max: 86400 });

      const refPng = path.join(tmpDir, `ref_${n}.png`);
      await extractFrameToPng(referencePath, refPng, t, { internal: true });

      const pairPng = path.join(tmpDir, `pair_${n}.png`);
      const pair = await createSideBySidePair(refPng, requested[idx], pairPng, {
        tileWidth: params.tileWidth,
        label: formatHms(t),
        internal: true,
      });
      if (!pair.timestampsBurned) timestampsBurned = false;
      pairPaths.push(pairPng);
      usedTimes.push(t);
      if (pairWidth === null) pairWidth = pair.width;
    }

    const explicitOut =
      typeof params.path === 'string' && params.path.trim()
        ? params.path
        : typeof params.outputPath === 'string' && params.outputPath.trim()
          ? params.outputPath
          : '';
    const outPath = explicitOut
      ? sanitizePath(explicitOut, false)
      : path.join(
          os.tmpdir(),
          `antigravity_compare_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`
        );
    const internalOut = !explicitOut;
    if (!internalOut) assertWritablePath(outPath);
    assertNotSamePath(referencePath, outPath);

    const cols = pairPaths.length > 1 ? 2 : 1;
    const sheet = await createContactSheetFromImages(pairPaths, outPath, {
      cols,
      tileWidth: pairWidth,
      quality: 4,
      internal: internalOut,
    });
    return {
      path: sheet.path,
      times: usedTimes,
      count: pairPaths.length,
      cols: sheet.cols,
      rows: sheet.rows,
      timestampsBurned,
      missing: requested.filter((_, i) => readyIndexes.indexOf(i) === -1),
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
    for (const frame of requested) {
      if (isInsideTempDir(frame)) {
        try {
          fs.unlinkSync(frame);
        } catch (_) {}
      }
    }
  }
}

/**
 * Runs a JSX ExtendScript file in After Effects.
 * If inlineJsxCode is provided, writes it safely to a temporary .jsx file that records the result in a temp JSON.
 */
export async function runExtendScriptAE(scriptContentOrPath, timeoutMs = 60000) {
  const aeExe = findAfterEffectsExe();
  if (!aeExe) {
    throw new Error('Adobe After Effects executable was not found on this system.');
  }

  const tempDir = path.join(os.tmpdir(), 'antigravity-ae');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const nonce = Date.now() + '_' + Math.random().toString(36).substring(2, 8);
  const resultFile = path.join(tempDir, `result_${nonce}.json`).replace(/\\/g, '/');
  let scriptPathToRun;
  let isTempScript = false;

  if (fs.existsSync(scriptContentOrPath)) {
    // If it's an existing file path, sanitize it
    scriptPathToRun = sanitizePath(scriptContentOrPath, true);
  } else {
    // Inline JSX code: wrap in a try/catch block that writes results to resultFile
    isTempScript = true;
    const wrappedJsx = `
(function() {
    var resultObj = { success: false, data: null, error: null };
    try {
        var userFunction = function() {
            ${scriptContentOrPath}
        };
        var ret = userFunction();
        resultObj.success = true;
        resultObj.data = (ret !== undefined) ? ret : "Execution completed successfully";
    } catch(err) {
        resultObj.success = false;
        resultObj.error = err.toString() + (err.line ? " at line " + err.line : "");
    }
    
    try {
        var f = new File("${resultFile}");
        f.encoding = "UTF-8";
        if (f.open("w")) {
            var _safe = function(s) {
                return String(s).replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"').replace(/\\r/g, "\\\\r").replace(/\\n/g, "\\\\n").replace(/\\t/g, "\\\\t");
            };
            var dVal = (typeof resultObj.data === "string") ? ('\\"' + _safe(resultObj.data) + '\\"') : (typeof resultObj.data === "object" ? "true" : ('\\"' + _safe(resultObj.data) + '\\"'));
            var eVal = resultObj.error ? ('\\"' + _safe(resultObj.error) + '\\"') : "null";
            var jsonStr = '{\\"success\\":' + resultObj.success + ',\\"data\\":' + dVal + ',\\"error\\":' + eVal + '}';
            f.write(jsonStr);
            f.close();
        }
    } catch(e) {}
})();
`;
    const tempJsxFile = path.join(tempDir, `script_${nonce}.jsx`);
    fs.writeFileSync(tempJsxFile, wrappedJsx, 'utf8');
    scriptPathToRun = tempJsxFile;
  }

  try {
    await new Promise((resolve, reject) => {
      execFile(
        aeExe,
        ['-r', scriptPathToRun],
        { timeout: timeoutMs, windowsHide: true },
        (error, stdout, stderr) => {
          if (error && error.code !== 0 && !fs.existsSync(resultFile)) {
            return reject(error);
          }
          resolve({ stdout, stderr });
        }
      );
    });

    // Check if result file was generated
    if (fs.existsSync(resultFile)) {
      try {
        const rawResult = fs.readFileSync(resultFile, 'utf8');
        const parsed = JSON.parse(rawResult);
        return parsed;
      } catch (_) {
        return { success: true, message: 'Script executed in After Effects' };
      }
    }

    return { success: true, message: 'Script sent to After Effects via -r' };
  } finally {
    // Cleanup temporary files
    if (isTempScript && fs.existsSync(scriptPathToRun)) {
      try { fs.unlinkSync(scriptPathToRun); } catch (_) {}
    }
    if (fs.existsSync(resultFile)) {
      try { fs.unlinkSync(resultFile); } catch (_) {}
    }
  }
}
