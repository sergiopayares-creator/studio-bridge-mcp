import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { sanitizePath } from './security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR = path.join(__dirname, '..', 'bin');
const MODEL_DIR = path.join(__dirname, '..', 'models');

/**
 * Locates the whisper.cpp binary. Resolution order:
 *   1. WHISPER_BIN environment variable (absolute path)
 *   2. bin/whisper-cli.exe (current whisper.cpp)
 *   3. bin/main.exe (older whisper.cpp)
 *   4. bin/whisper.exe
 */
export function findWhisperBin() {
  if (process.env.WHISPER_BIN && fs.existsSync(process.env.WHISPER_BIN)) {
    return process.env.WHISPER_BIN;
  }
  const candidates = ['whisper-cli.exe', 'main.exe', 'whisper.exe'];
  for (const name of candidates) {
    const p = path.join(BIN_DIR, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Locates a ggml whisper model. Resolution order:
 *   1. WHISPER_MODEL environment variable (absolute path)
 *   2. models/ggml-small.bin, models/ggml-base.bin, models/ggml-tiny.bin
 */
export function findWhisperModel() {
  if (process.env.WHISPER_MODEL && fs.existsSync(process.env.WHISPER_MODEL)) {
    return process.env.WHISPER_MODEL;
  }
  const candidates = ['ggml-small.bin', 'ggml-base.bin', 'ggml-tiny.bin'];
  for (const name of candidates) {
    const p = path.join(MODEL_DIR, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function runExecFile(bin, args, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
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
 * Transcribes an audio file (WAV 16 kHz mono recommended) to text using a local
 * whisper.cpp model. Returns the full text plus per-segment timing, entirely
 * offline (no tokens, no cloud).
 *
 * @param {string} inputPath - Absolute path to an audio file (wav/mp3/mp4/m4a…).
 * @param {object} opts - { language?: 'auto'|'es'|'en'|… }
 */
export async function transcribeAudio(inputPath, opts = {}) {
  const safeIn = sanitizePath(inputPath, true);

  const bin = findWhisperBin();
  if (!bin) {
    throw new Error(
      'whisper.cpp binary not found. Run setup-whisper.ps1 inside mcp-video-server, or set WHISPER_BIN to the whisper-cli.exe path.'
    );
  }
  const model = findWhisperModel();
  if (!model) {
    throw new Error(
      'whisper model not found. Run setup-whisper.ps1 inside mcp-video-server, or set WHISPER_MODEL to a ggml-*.bin path.'
    );
  }

  const language = opts.language && opts.language !== 'auto' ? String(opts.language) : null;

  const tmpDir = path.join(os.tmpdir(), 'antigravity-whisper');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const base = path.join(tmpDir, `transcript_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const jsonOut = `${base}.json`;

  const args = ['-m', model, '-f', safeIn, '-oj', '-of', base, '--no-prints'];
  if (language) args.push('-l', language);

  try {
    await runExecFile(bin, args, 600000);
  } catch (err) {
    throw new Error(`whisper transcription failed: ${err.message}`);
  }

  if (!fs.existsSync(jsonOut)) {
    throw new Error('whisper produced no JSON output.');
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
  } catch (_) {
    throw new Error('whisper JSON output could not be parsed.');
  }

  let segments = [];
  let fullText = '';

  if (Array.isArray(parsed.transcription)) {
    segments = parsed.transcription.map((s) => ({
      start: (s.timestamps && s.timestamps.from) || (s.offsets && s.offsets.from) || null,
      end: (s.timestamps && s.timestamps.to) || (s.offsets && s.offsets.to) || null,
      text: (s.text || '').trim(),
    }));
    fullText = segments.map((s) => s.text).join(' ').trim();
  }
  if (!fullText && typeof parsed.text === 'string') {
    fullText = parsed.text.trim();
  }

  try { fs.unlinkSync(jsonOut); } catch (_) {}

  return {
    success: true,
    text: fullText,
    segments,
    language: language || 'auto',
    model: path.basename(model),
  };
}
