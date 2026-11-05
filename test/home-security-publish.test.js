// t5: the App Cloud publication of Home Security: app.json is a valid registration (keepAlive, healthPath, a launch recipe
// for every OS), the Linux unit template fills in, the installer plans the right steps, /healthz carries ffmpeg + storage,
// and the process janitor can never pick the app as a victim.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-hs-publish-'));
process.env.RIGS_HOME = home;
process.env.RIGS_NAME = 'mac';
process.env.HOME_SECURITY_DATA = path.join(home, 'hs-data');
const apps = await import('../src/apps.js');
const janitor = await import('../src/janitor.js');
const { createServer } = await import('../apps/home-security/server.js');

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'home-security');
const manifest = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'app.json'), 'utf8'));
const installer = path.join(APP_DIR, 'launch', 'install.mjs');
const plan = (...extra) => JSON.parse(execFileSync(process.execPath, [installer, '--dry-run', ...extra], { encoding: 'utf8', env: { ...process.env, RIGS_SYSTEMD_USER_DIR: path.join(home, 'units') } }));

test('app.json passes the daemon registration validator: id, /healthz, keepAlive, launch for linux, darwin and windows', () => {
  const { app, errors } = apps.validateApp({ ...manifest, launch: JSON.parse(JSON.stringify(manifest.launch).replaceAll('{{INSTALL_DIR}}', '/opt/rigs')) });
  assert.deepEqual(errors, []);
  assert.equal(app.id, 'home-security');
  assert.equal(app.healthPath, '/healthz');
  assert.equal(app.keepAlive, true);
  assert.equal(app.target, 'http://127.0.0.1:8749');
  // The UI is relative-URL only, and it fetches PEER nodes at /api/nodes/<peer>/apps/home-security/…: the proxy's fetch shim would
  // prefix those with this node's prefix (404), so the app registers with the shim and HTML rewriting off.
  assert.deepEqual(app.rewrite, { rootRelative: false });
  for (const os_ of ['linux', 'darwin', 'windows']) assert.ok(apps.launchFor(app.launch, { linux: 'linux', darwin: 'darwin', windows: 'win32' }[os_]), `launch recipe for ${os_}`);
  assert.equal(apps.launchFor(app.launch, 'linux').systemd, 'rigs-home-security.service');
  assert.match(apps.launchFor(app.launch, 'darwin').command, /apps\/home-security\/server\.js/);
  assert.match(apps.launchFor(app.launch, 'win32').command, /apps\\home-security\\server\.js/);
});

test('the registered app is resident: isKeepAlive is true and idleVictims never selects it, however long it was idle', () => {
  const { app } = apps.validateApp({ ...manifest, launch: { command: 'true' } });
  const keep = (id) => apps.isKeepAlive(id, { apps: [app] });
  assert.equal(keep('home-security'), true);
  const old = [{ id: 'home-security', startedAt: 1, lastUsed: 1, holds: 0 }, { id: 'other', startedAt: 1, lastUsed: 1, holds: 0 }];
  assert.deepEqual(janitor.idleVictims(old, { now: Date.now(), idleMinutes: 30, keep }).map((e) => e.id), ['other']);
});

test('installer dry run: fills the unit template, enables the unit on Linux, registers keepAlive with this machine\'s install dir', () => {
  const p = plan('--install-dir', path.join(APP_DIR, '..', '..'));
  assert.equal(p.ok, true);
  assert.equal(p.registration.keepAlive, true);
  assert.equal(p.registration.healthPath, '/healthz');
  assert.deepEqual(Object.keys(p.registration.launch).sort(), ['darwin', 'linux', 'windows']);
  assert.ok(!JSON.stringify(p.registration).includes('{{'), 'no placeholder is left in the registration');
  if (process.platform === 'linux') assert.ok(p.steps.some((s) => /enable --now rigs-home-security\.service/.test(s)));
  const here = { darwin: 'darwin', win32: 'windows', linux: 'linux' }[process.platform];
  if (here !== 'linux') assert.equal(p.registration.launch[here].cwd, path.resolve(APP_DIR, '..', '..'));
});

test('unit template has every placeholder the installer fills, and Restart=always + KillMode=mixed', () => {
  const t = fs.readFileSync(path.join(APP_DIR, 'rigs-home-security.service.tmpl'), 'utf8');
  const names = [...new Set([...t.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]))].sort();
  assert.deepEqual(names, ['INSTALL_DIR', 'NODE', 'PORT']);
  assert.match(t, /Restart=always/);
  assert.match(t, /KillMode=mixed/);
  assert.match(t, /WantedBy=default\.target/);
});

test('healthz reports ffmpeg and storage (the App Cloud health probe) and answers 200 without any camera', async () => {
  const server = createServer({ env: { ...process.env, FFMPEG: '/definitely/not/ffmpeg' } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(typeof j.ffmpeg.found, 'boolean');
    assert.ok('path' in j.ffmpeg && 'version' in j.ffmpeg);
    assert.equal(typeof j.storage.dataDir, 'string');
    assert.ok('usedBytes' in j.storage && 'freeBytes' in j.storage && 'maxBytes' in j.storage);
    assert.deepEqual(Object.keys(j.cameras).sort(), ['enabled', 'failing', 'recording', 'total']);
  } finally { await new Promise((r) => server.close(r)); }
});
