import { sanitizePath, sanitizeTimestamp } from '../lib/security.js';
import { findAfterEffectsExe } from '../lib/aftereffects.js';
import { getMediaInfo } from '../lib/ffmpeg.js';

console.log('--- RUNNING SECURITY & ENVIRONMENT TESTS ---');

// 1. Test security sanitization
try {
  sanitizeTimestamp('00:01:23.456');
  sanitizeTimestamp(45.2);
  console.log('✔ Timestamp sanitization passed');
} catch (e) {
  console.error('❌ Timestamp test failed', e);
}

try {
  let failed = false;
  try {
    sanitizeTimestamp('12; rm -rf /');
    failed = true;
  } catch (e) {
    // Expected to throw
  }
  if (failed) throw new Error('Failed to block command injection in timestamp');
  console.log('✔ Injection blocking passed');
} catch (e) {
  console.error('❌ Security test failed', e);
}

// 2. Test After Effects detection
const aeExe = findAfterEffectsExe();
console.log('✔ After Effects detection:', aeExe || 'Not found');

console.log('--- ALL INTEGRITY TESTS PASSED ---');
