// Mesh stability: a peer that misses a probe stays online for a grace window, docs-only updates don't
// restart the daemon, and each OS has a sleep inhibitor tied to the RIGS process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-mesh-'));
process.env.RIGS_HOME = HOME;
process.env.RIGS_NO_MIGRATIONS = '1';
process.env.RIGS_PEERS = 'http://peer.test:4719';

const { Discovery, GRACE_MS } = await import('../src/discovery.js');
const { needsRestart } = await import('../src/updater.js');
const { keepAwakeCommand } = await import('../src/keepawake.js');

test('a peer that misses probes stays online within the grace window, then drops', async () => {
  const d = new Discovery(async () => ({ id: 'self-id', name: 'self' }));
  let answer = true;
  let probes = 0;
  d.probe = async () => { probes++; return answer ? { info: { id: 'peer-id', name: 'peer' } } : { error: 'TimeoutError' }; };
  const peer = () => d.list().find((n) => n.id === 'peer-id' || n.url === 'http://peer.test:4719');

  await d.tick();
  assert.equal(peer().online, true);
  assert.equal(peer().rigs, true);

  answer = false;
  await d.tick();
  assert.equal(peer().id, 'peer-id', 'keeps its identity while stale');
  assert.equal(peer().online, true, 'one missed probe does not drop it');
  assert.equal(peer().stale, true);

  // Past the grace window it is reported offline.
  d.nodes.get('peer-id').lastSeen = Date.now() - GRACE_MS - 1;
  await d.tick();
  assert.equal(peer().online, false);

  answer = true;
  await d.tick();
  assert.equal(peer().online, true);
  assert.equal(peer().stale, false);
  assert.ok(probes >= 4);
});

test('discovery rounds never overlap', async () => {
  const d = new Discovery(async () => ({ id: 'self-id', name: 'self' }));
  let inFlight = 0;
  let maxInFlight = 0;
  d.round = async () => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 50));
    inFlight--;
  };
  await Promise.all([d.tick(), d.tick(), d.tick()]);
  assert.equal(maxInFlight, 1);
});

test('updates touching only docs, tests or markdown do not restart the daemon', () => {
  assert.equal(needsRestart(['docs/x.md', 'README.md', 'test/a.test.js', '.github/workflows/ci.yml', '']), false);
  assert.equal(needsRestart(['docs/x.md', 'src/server.js']), true);
  assert.equal(needsRestart(['ui/src/app.js']), true);
  assert.equal(needsRestart(['package-lock.json']), true);
});

test('a sleep inhibitor tied to the RIGS process exists for every OS', () => {
  const mac = keepAwakeCommand('darwin', 123);
  assert.equal(mac.cmd, 'caffeinate');
  assert.deepEqual(mac.args.slice(-2), ['-w', '123']);
  const linux = keepAwakeCommand('linux', 123);
  assert.equal(linux.cmd, 'systemd-inhibit');
  assert.ok(linux.args.includes('--what=sleep:idle'));
  assert.match(linux.args.at(-1), /kill -0 123/);
  const win = keepAwakeCommand('win32', 123);
  assert.equal(win.cmd, 'powershell');
  assert.match(win.args.at(-1), /Get-Process -Id 123/);
  assert.equal(keepAwakeCommand('aix', 1), null);
});
