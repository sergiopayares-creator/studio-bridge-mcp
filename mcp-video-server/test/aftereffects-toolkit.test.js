import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMcpServer, buildImageResult, imageContentBlock } from '../index.js';

const EXPECTED_AE_VERBS = [
  'project', 'catalog', 'comp', 'layer', 'settings', 'shape', 'fill', 'text', 'textStyle',
  'textAnimator', 'camera', 'light', 'effect', 'effectParam', 'effectKey', 'transform',
  'keyframe', 'expression', 'mask', 'roto', 'tracker', 'marker', 'import', 'folder', 'items',
  'render', 'renderOutput', 'renderFrame', 'selection', 'save', 'measure', 'alignAnchor',
  'shapeGroup', 'halo', 'batch', 'check', 'contactSheet',
];

async function connectClient(t) {
  const server = createMcpServer();
  const client = new Client({ name: 'phase1-toolkit-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return { client, server };
}

test('ListTools registers aftereffects_toolkit with the full AE verb surface', async (t) => {
  const { client } = await connectClient(t);
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);

  assert.ok(names.includes('aftereffects_toolkit'), 'aftereffects_toolkit must be exposed as a first-class tool');
  assert.ok(names.includes('premiere_toolkit'));
  assert.ok(names.includes('video_contact_sheet'));
  assert.ok(names.includes('adobe_guide'));

  const aeTool = tools.find((tool) => tool.name === 'aftereffects_toolkit');
  assert.deepEqual(aeTool.inputSchema.required, ['verb']);
  assert.ok(Array.isArray(aeTool.inputSchema.properties.verb.enum));
  for (const verb of EXPECTED_AE_VERBS) {
    assert.ok(aeTool.inputSchema.properties.verb.enum.includes(verb), `missing AE verb: ${verb}`);
  }
  assert.equal(aeTool.inputSchema.properties.params.type, 'object');
  assert.equal(aeTool.inputSchema.properties.expected_project.type, 'string');

  const premiereTool = tools.find((tool) => tool.name === 'premiere_toolkit');
  assert.equal(premiereTool.inputSchema.properties.expected_project.type, 'string');
});

test('image packaging returns a separate image block and keeps base64 out of the text', () => {
  const base64 = 'aGVsbG8td29ybGQtaW1hZ2UtYnl0ZXM=';
  const result = buildImageResult(
    { ok: true, comp: 'Main', time: 1.5, path: 'C:/tmp/frame.png', bytes: base64.length },
    base64,
    'image/jpeg'
  );

  assert.equal(result.content.length, 2);
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.content[1].type, 'image');
  assert.equal(result.content[1].mimeType, 'image/jpeg');
  assert.equal(result.content[1].data, base64);
  assert.ok(!result.content[0].text.includes(base64), 'base64 must not be embedded in the JSON text block');

  const textMeta = JSON.parse(result.content[0].text);
  assert.equal(textMeta.comp, 'Main');
  assert.equal(textMeta.base64, undefined);

  const block = imageContentBlock(base64, 'image/png');
  assert.deepEqual(block, { type: 'image', data: base64, mimeType: 'image/png' });
});

test('adobe_guide documents the engine invariants and toolkit verbs (read-only)', async (t) => {
  const { client } = await connectClient(t);
  const result = await client.callTool({ name: 'adobe_guide', arguments: { topic: 'ae' } });

  assert.equal(result.isError, undefined);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');

  const guide = JSON.parse(result.content[0].text);
  const invariantIds = guide.invariants.map((item) => item.id);
  assert.ok(invariantIds.includes('es3'));
  assert.ok(invariantIds.includes('sourceRectAtTime'));
  assert.ok(invariantIds.includes('easing'));
  assert.ok(invariantIds.includes('blurBounds'));
  assert.ok(guide.aftereffects.verbs.includes('renderFrame'));
  assert.equal(guide.premiere, undefined, 'topic "ae" must not include the Premiere section');
});
