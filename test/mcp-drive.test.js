// drive_search / drive_read MCP tools (src/mcp.js) with the connector's HTTP routes mocked. No daemon, no Google.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-mcp-drive-'));
Object.assign(process.env, { RIGS_HOME: path.join(TMP, 'rigs'), RIGS_NO_OPENRIG: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_MIGRATIONS: '1', RIGS_NAME: 'test-node' });
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const { TOOLS, driveSearch, driveRead } = await import('../src/mcp.js');

const notConnected = () => Promise.reject(Object.assign(new Error('Google Drive is not connected'), { code: undefined }));

test('drive_search and drive_read are listed with JSON schemas, next to the mesh tools', () => {
  const names = TOOLS.map((t) => t.name);
  console.log('mcp tools:', names.join(', '));
  for (const name of ['drive_search', 'drive_read']) {
    const t = TOOLS.find((x) => x.name === name);
    assert.ok(t, name);
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.description.length > 20);
  }
  assert.deepEqual(TOOLS.find((t) => t.name === 'drive_search').inputSchema.required, ['query']);
  assert.deepEqual(TOOLS.find((t) => t.name === 'drive_read').inputSchema.required, ['fileId']);
  assert.ok(names.includes('mesh_notify') && names.includes('project_get'));
  assert.equal(new Set(names).size, names.length);
});

test('drive_search calls the connector search route with the query and options escaped', async () => {
  const calls = [];
  const r = await driveSearch({ query: 'budget & plan 2026', mode: 'fulltext', pageSize: 5 }, async (url) => { calls.push(url); return { files: [{ id: 'f1', name: 'Budget' }] }; });
  assert.deepEqual(r, { files: [{ id: 'f1', name: 'Budget' }] });
  const u = new URL(calls[0], 'http://x');
  assert.equal(u.pathname, '/api/local/connectors/google-drive/search');
  assert.equal(u.searchParams.get('q'), 'budget & plan 2026');
  assert.equal(u.searchParams.get('mode'), 'fulltext');
  assert.equal(u.searchParams.get('pageSize'), '5');
  await assert.rejects(driveSearch({ query: '  ' }, async () => ({})), /needs a query/);
});

test('drive_read calls the file route with an encoded id and optional cap', async () => {
  const calls = [];
  const doc = { id: 'a/b', name: 'Notes', content: 'hello', truncated: false };
  assert.deepEqual(await driveRead({ fileId: 'a/b', maxBytes: 2048 }, async (url) => { calls.push(url); return doc; }), doc);
  assert.equal(calls[0], '/api/local/connectors/google-drive/file/a%2Fb?maxBytes=2048');
  await driveRead({ fileId: 'x' }, async (url) => { calls.push(url); return {}; });
  assert.equal(calls[1], '/api/local/connectors/google-drive/file/x');
  await assert.rejects(driveRead({}, async () => ({})), /needs a fileId/);
});

test('both tools answer plainly (no error) when Drive is not connected, and rethrow other failures', async () => {
  for (const r of [await driveSearch({ query: 'x' }, notConnected), await driveRead({ fileId: 'x' }, notConnected)]) {
    assert.equal(r.connected, false);
    assert.match(r.message, /Google Drive is not connected/);
    assert.ok(!/\bat \w+.*:\d+/.test(r.message), 'no stack');
  }
  const unconfigured = await driveSearch({ query: 'x' }, () => Promise.reject(new Error('Google Drive is not configured')));
  assert.equal(unconfigured.connected, false);
  await assert.rejects(driveSearch({ query: 'x' }, () => Promise.reject(new Error('HTTP 500'))), /HTTP 500/);
});
