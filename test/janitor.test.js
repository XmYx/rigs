// Process janitor (src/janitor.js): only services RIGS launched, stopped after idleMinutes without use; holds and keepAlive protect.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-janitor-'));
const J = await import('../src/janitor.js');
const A = await import('../src/apps.js');
const { saveConfig, loadConfig } = await import('../src/config.js');
const MIN = 60000;

test('idleVictims: idle past the limit, not held, not kept', () => {
  const now = 100 * MIN;
  const es = [
    { id: 'old', lastUsed: now - 31 * MIN },
    { id: 'fresh', lastUsed: now - 5 * MIN },
    { id: 'held', lastUsed: now - 90 * MIN, holds: 1 },
    { id: 'keep', lastUsed: now - 90 * MIN },
  ];
  assert.deepEqual(J.idleVictims(es, { now, idleMinutes: 30, keep: (id) => id === 'keep' }).map((e) => e.id), ['old']);
});

test('track, touch and hold keep an app alive; sweep stops it the way it was started', async () => {
  J.resetJanitor();
  const t0 = Date.now() - 60 * MIN;
  J.track({ id: 'Comfy', name: 'ComfyUI', pid: 4242 }, t0);
  J.track({ id: 'svc', unit: 'rigs-svc.service' }, t0);
  J.track({ id: 'busy', pid: 7 }, t0);
  const release = J.hold('busy');
  J.touch('nothing-tracked');
  const killed = [];
  const ran = [];
  const deps = { kill: (pid, sig) => killed.push([pid, sig]), alive: () => killed.length === 0, sleep: async () => {}, run: async (cmd, args) => { ran.push([cmd, ...args]); return { code: 0 }; } };
  const stopped = await J.sweep({ deps });
  assert.deepEqual(stopped.sort(), ['comfy', 'svc']);
  assert.ok(killed.some(([pid, sig]) => Math.abs(pid) === 4242 && sig === 'SIGTERM'));
  assert.deepEqual(ran, [['systemctl', '--user', 'stop', 'rigs-svc.service']]);
  assert.deepEqual(J.list().map((e) => e.id), ['busy']);
  release();
  assert.equal(J.list()[0].holds, 0);
  // the used-just-now app survives the next sweep
  assert.deepEqual(await J.sweep({ deps }), []);
  // state is saved for a daemon restart
  assert.ok(JSON.parse(fs.readFileSync(path.join(process.env.RIGS_HOME, 'janitor.json'), 'utf8')).some((e) => e.id === 'busy'));
});

test('settings default on, 30 min, clamp silly values', () => {
  assert.deepEqual(J.settings({}), { enabled: true, idleMinutes: 30, intervalSec: 60 });
  assert.equal(J.settings({ janitor: { enabled: false } }).enabled, false);
  assert.equal(J.settings({ janitor: { idleMinutes: 0, intervalSec: 1 } }).intervalSec, 10);
});

test('jarvis-voice is resident: the janitor never selects it, however long it was idle — registered keepAlive or not', async () => {
  const cfg = loadConfig();
  cfg.persona = { ...cfg.persona, neural: true, voiceApp: undefined, hearingApp: undefined };
  const longIdle = { id: 'jarvis-voice', unit: 'jarvis-voice.service', lastUsed: 0, holds: 0 };
  const other = { id: 'comfy', pid: 4242, lastUsed: 0, holds: 0 };
  for (const apps of [
    [{ id: 'jarvis-voice', port: 8197, keepAlive: true, launch: { systemd: 'jarvis-voice.service' } }, { id: 'comfy', port: 8188 }],
    [{ id: 'jarvis-voice', port: 8197, launch: { systemd: 'jarvis-voice.service' } }, { id: 'comfy', port: 8188 }], // flag lost by a re-registration
    [{ id: 'comfy', port: 8188 }], // not even registered
  ]) {
    cfg.apps = apps;
    saveConfig(cfg);
    A.resetAppsState();
    assert.deepEqual(J.idleVictims([longIdle, other], { now: 1e12, idleMinutes: 30, keep: (id) => A.isKeepAlive(id) }).map((e) => e.id), ['comfy']);
  }
  // and a real sweep keeps its unit running (no systemctl stop) while the idle neighbour is stopped
  J.resetJanitor();
  J.track({ id: 'jarvis-voice', unit: 'jarvis-voice.service' }, 1);
  J.track({ id: 'comfy', pid: 4242 }, 1);
  const ran = [];
  const deps = { kill: () => {}, alive: () => false, sleep: async () => {}, run: async (...a) => { ran.push(a.flat().join(' ')); return { code: 0 }; } };
  assert.deepEqual(await J.sweep({ now: 1e12, keep: (id) => A.isKeepAlive(id), deps }), ['comfy']);
  assert.deepEqual(ran, []);
  assert.deepEqual(J.list().map((e) => e.id), ['jarvis-voice']);
});
