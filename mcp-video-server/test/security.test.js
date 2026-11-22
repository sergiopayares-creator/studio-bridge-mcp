import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getOrCreateBridgeToken } from '../lib/security.js';

test('bridge token is random per install and persists across restarts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-bridge-token-'));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  try {
    const a = getOrCreateBridgeToken(first);
    const aAgain = getOrCreateBridgeToken(first);
    const b = getOrCreateBridgeToken(second);

    assert.match(a, /^[a-f0-9]{64}$/);
    assert.equal(aAgain, a);
    assert.notEqual(b, a);
    assert.equal(fs.readFileSync(path.join(first, '.bridge-secret'), 'utf8'), a);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(first, '.bridge-secret')).mode & 0o077, 0);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
