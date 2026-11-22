import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBearerToken, assertWritableParam, tokensMatch } from '../lib/security.js';

test('extractBearerToken parses Bearer header and rejects malformed input', () => {
  assert.equal(extractBearerToken({ authorization: 'Bearer abc123' }), 'abc123');
  assert.equal(extractBearerToken({ Authorization: 'bearer  XYZ  ' }), 'XYZ');
  assert.equal(extractBearerToken({ authorization: 'Basic abc123' }), null);
  assert.equal(extractBearerToken({}), null);
  assert.equal(extractBearerToken(null), null);
});

test('tokensMatch compares tokens and rejects length/type mismatches', () => {
  const a = 'a'.repeat(64);
  const c = 'b'.repeat(64);
  assert.equal(tokensMatch(a, a), true);
  assert.equal(tokensMatch(a, c), false);
  assert.equal(tokensMatch('short', a), false);
  assert.equal(tokensMatch(null, a), false);
});

test('assertWritableParam scopes an output path to ANTIGRAVITY_WRITABLE_ROOTS', () => {
  const prev = process.env.ANTIGRAVITY_WRITABLE_ROOTS;
  process.env.ANTIGRAVITY_WRITABLE_ROOTS = 'C:/media/out';
  try {
    assert.doesNotThrow(() => assertWritableParam({ path: 'C:/media/out/clip.mp4' }, 'path'));
    assert.throws(() => assertWritableParam({ path: 'C:/elsewhere/clip.mp4' }, 'path'));
    // absent key is a no-op (read-only verbs never fail)
    assert.doesNotThrow(() => assertWritableParam({}, 'path'));
  } finally {
    if (prev === undefined) delete process.env.ANTIGRAVITY_WRITABLE_ROOTS;
    else process.env.ANTIGRAVITY_WRITABLE_ROOTS = prev;
  }
});
