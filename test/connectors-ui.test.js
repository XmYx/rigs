// Connectors panel (ui/src/connectors-panel.js): the pure view model and static wiring checks. No browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const M = await import('../ui/src/connectors-model.js');

test('driveView: disconnected, connected, not set up, loading and error', () => {
  const off = M.driveView({ configured: true, connected: false, account: null });
  assert.deepEqual([off.state, off.canConnect, off.canDisconnect], ['disconnected', true, false]);
  const on = M.driveView({ configured: true, connected: true, account: { email: 'a@b.eu', name: 'A' } });
  assert.deepEqual([on.state, on.canConnect, on.canDisconnect, on.account], ['connected', false, true, 'a@b.eu']);
  assert.match(on.detail, /a@b\.eu/);
  assert.equal(M.driveView({ configured: true, connected: true, account: null }).canDisconnect, true, 'connected without a label');
  const none = M.driveView({ configured: false, connected: false });
  assert.deepEqual([none.state, none.canConnect, none.needsSetup], ['unconfigured', false, true]);
  assert.equal(M.driveView(null).state, 'loading');
  const err = M.driveView({ _err: 'boom' });
  assert.deepEqual([err.state, err.detail, err.canConnect], ['error', 'boom', false]);
});

test('accountLabel accepts an object or a string', () => {
  assert.equal(M.accountLabel('x@y.z'), 'x@y.z');
  assert.equal(M.accountLabel({ name: 'Ann' }), 'Ann');
  assert.equal(M.accountLabel(null), '');
});

test('Connect opens auth/start and Disconnect posts to the disconnect route; the tab is in Mesh control', () => {
  assert.equal(M.DRIVE_CONNECT_URL, '/api/local/connectors/google-drive/auth/start?redirect=1');
  const panel = read('ui/src/connectors-panel.js');
  assert.match(panel, /window\.open\(DRIVE_CONNECT_URL/);
  assert.match(panel, /`\$\{DRIVE_BASE\}\/disconnect`, \{ method: 'POST'/);
  assert.match(read('ui/src/mesh.js'), /\['Connectors', connectorsEl\]/);
  assert.match(read('ui/src/styles.css'), /\.conn-card\b/);
});
