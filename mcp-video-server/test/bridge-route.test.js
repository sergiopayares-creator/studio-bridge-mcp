import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeCode = fs.readFileSync(path.join(here, '../index.js'), 'utf8');

test('MCP tool description and dispatch expose the implemented project snapshot action', () => {
  assert.match(bridgeCode, /name:\s*'adobe_get_project_snapshot'/);
  assert.match(bridgeCode, /case\s+'adobe_get_project_snapshot'/);
});
