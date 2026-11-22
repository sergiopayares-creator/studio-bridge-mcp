import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

const TOKEN_PATTERN = /^[a-f0-9]{64}$/i;

// Creates or reads a per-user random bridge token. Never ship a default token.
export function getOrCreateBridgeToken(configDir) {
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }

  const tokenFile = path.join(configDir, '.bridge-secret');
  if (fs.existsSync(tokenFile)) {
    try {
      const saved = fs.readFileSync(tokenFile, 'utf8').trim();
      if (TOKEN_PATTERN.test(saved)) return saved;
    } catch (_) {}
  }

  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  return token;
}

// Compare fixed-length secret tokens without an early exit on the first mismatch.
export function tokensMatch(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

// Strictly validates and normalizes target file path (safe against command injection & Windows quotes)
export function sanitizePath(inputPath, mustExist = false) {
  if (typeof inputPath !== 'string' || !inputPath.trim()) {
    throw new Error('Path must be a non-empty string');
  }

  // Strip wrapping quotes if user copied path with quotes in Windows
  const clean = inputPath.trim().replace(/^["']|["']$/g, '').trim();

  // Check for dangerous characters in arguments
  if (/[\r\n\0]/.test(clean)) {
    throw new Error('Path contains forbidden control characters');
  }

  const normalized = path.normalize(path.resolve(clean));

  if (mustExist && !fs.existsSync(normalized)) {
    throw new Error(`File does not exist: ${normalized}`);
  }

  return normalized;
}

// Validates numeric time format (e.g. 12.5 or "00:01:23.456") with millisecond precision
export function sanitizeTimestamp(timeVal) {
  if (typeof timeVal === 'number' && timeVal >= 0 && Number.isFinite(timeVal)) {
    return Number(timeVal.toFixed(3)).toString();
  }
  if (typeof timeVal === 'string') {
    const trimmed = timeVal.trim().replace(/^["']|["']$/g, '');
    // Allows standard float or HH:MM:SS / HH:MM:SS.mmm
    if (/^(\d+(\.\d+)?|(\d{1,2}:)?[0-5]?\d:[0-5]\d(\.\d+)?)$/.test(trimmed)) {
      return trimmed;
    }
  }
  throw new Error(`Invalid timestamp format: ${timeVal}. Expected seconds (e.g. 10.5) or HH:MM:SS`);
}

/**
 * Coerces and validates a numeric argument, rejecting anything that is not a
 * finite number inside an optional [min, max] range. Prevents ffmpeg filter
 * injection (e.g. a string like "-30dB;movie=..." reaching the -af argument).
 */
export function validateNumber(value, { name = 'value', min = -Infinity, max = Infinity } = {}) {
  let num;
  if (typeof value === 'number') {
    num = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    num = Number(value.trim());
  } else {
    num = NaN;
  }
  if (!Number.isFinite(num)) {
    throw new Error(`${name} must be a finite number (got ${JSON.stringify(value)})`);
  }
  if (num < min || num > max) {
    throw new Error(`${name} must be between ${min} and ${max} (got ${num})`);
  }
  return num;
}

/**
 * Returns the list of allowed output roots from the ANTIGRAVITY_WRITABLE_ROOTS
 * environment variable (semicolon-separated on Windows). Empty list means "no
 * restriction" (backward-compatible default), but operators are encouraged to
 * set it to the media/project folders so a prompt-injected agent cannot write
 * or overwrite arbitrary files on disk.
 */
export function getWritableRoots() {
  const raw = process.env.ANTIGRAVITY_WRITABLE_ROOTS || '';
  return raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => path.resolve(s));
}

/**
 * Asserts that an output path is inside one of the allowed writable roots.
 * No-op when no roots are configured.
 */
export function assertWritablePath(outputPath, roots = getWritableRoots()) {
  if (!roots || roots.length === 0) return;
  const resolved = path.resolve(outputPath);
  const within = roots.some((r) => resolved === r || resolved.startsWith(r + path.sep));
  if (!within) {
    throw new Error(
      `Refusing to write to ${resolved}: it is outside the allowed roots (${roots.join('; ')}). ` +
        `Set ANTIGRAVITY_WRITABLE_ROOTS to permit it.`
    );
  }
}

/**
 * Prevents a destructive tool from using the same file as both input and output,
 * which would truncate/destroy the source.
 */
export function assertNotSamePath(inputPath, outputPath) {
  const a = path.resolve(inputPath);
  const b = path.resolve(outputPath);
  if (a === b) {
    throw new Error('Input and output paths are identical; refusing to overwrite the source file.');
  }
}

/**
 * Extracts a Bearer token from an HTTP request headers object (case-insensitive
 * key match). Returns null when absent or malformed, so callers can reject.
 */
export function extractBearerToken(headers) {
  if (!headers || typeof headers !== 'object') return null;
  const raw = headers['authorization'] || headers['Authorization'];
  if (typeof raw !== 'string') return null;
  const m = raw.match(/^\s*Bearer\s+(.+?)\s*$/i);
  return m ? m[1] : null;
}

/**
 * Asserts that the filesystem path carried by params[key] is inside the
 * configured writable roots. No-op when the key is absent (so read-only verbs
 * never fail); the caller must invoke this for every write-capable verb.
 */
export function assertWritableParam(params, key) {
  if (!params || typeof params !== 'object') return;
  const p = params[key];
  if (typeof p === 'string' && p.trim()) {
    assertWritablePath(p);
  }
}
