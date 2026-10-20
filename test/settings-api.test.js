// The unified settings API (src/settings-api.js, docs/settings.md): GET reads every server-side item, POST plans first
// and writes through the existing setters; secrets never leave the server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-settings-api-'));
const { config, loadConfig } = await import('../src/config.js');
loadConfig();
const { readSettings, patchSettings, SettingsError } = await import('../src/settings-api.js');
const S = await import('../ui/src/settings-model.js');

const flat = (r) => Object.fromEntries(r.categories.flatMap((c) => c.items).map((e) => [e.id, e]));
const deps = { node: 'testnode', warm() {}, emit() {}, linear: { setConfig() {} }, drive: { setSettings() {} }, comfy: { async setConfig() {} } };

test('GET answers every server-side item once, secrets as status only', () => {
  const r = readSettings();
  const by = flat(r);
  assert.equal(Object.keys(by).length, S.serverItems().length);
  assert.equal(r.schemaVersion, S.SCHEMA_VERSION);
  assert.equal(by['quick.enabled'].scope, 'global');
  assert.equal(typeof by['quick.enabled'].value, 'boolean');
  assert.ok(by['meshToken'].secret.set && !('value' in by['meshToken']));
  assert.equal(JSON.stringify(r).includes(config().meshToken), false, 'the mesh token never appears');
});

test('POST applies through the setters, stamps a global change once and answers applied + the fresh values', async () => {
  const rev0 = config().globalRev?.rev || 0;
  const r = await patchSettings({ values: { 'quick.enabled': false, 'router.engine': 'rules', keepAwake: false } }, deps);
  assert.deepEqual(r.applied.sort(), ['keepAwake', 'quick.enabled', 'router.engine']);
  assert.deepEqual(r.restart, ['keepAwake']);
  const by = flat(r);
  assert.equal(by['quick.enabled'].value, false);
  assert.equal(by['router.engine'].value, 'rules');
  assert.ok(config().globalRev.rev > rev0);
});

test('POST: one bad value → 400 with errors and nothing written', async () => {
  const before = JSON.stringify(config());
  await assert.rejects(
    () => patchSettings({ values: { 'quick.enabled': true, 'router.engine': 'nope', 'ui.theme': 'x', control: 1, meshToken: 'x', bogus: 1 } }, deps),
    (e) => e instanceof SettingsError && e.status === 400 && e.errors.length >= 4 && /router\.engine|ui\.theme|meshToken|bogus/.test(e.message),
  );
  assert.equal(JSON.stringify(config()), before);
});

test('POST: a secret is set, reported as status and cleared; its value is never echoed or logged', async () => {
  const lines = [];
  const orig = console.log; console.log = (...a) => lines.push(a.join(' '));
  try {
    const set = await patchSettings({ values: { 'router.jev.apiKey': 'sekrit-value-123' } }, deps);
    assert.deepEqual(flat(set)['router.jev.apiKey'].secret, { set: true, len: 16, source: 'config' });
    assert.equal(JSON.stringify(set).includes('sekrit-value-123'), false);
    const kept = await patchSettings({ values: { 'router.jev.apiKey': S.SECRET_MASK } }, deps);
    assert.equal(flat(kept)['router.jev.apiKey'].secret.set, true);
    const cleared = await patchSettings({ values: { 'router.jev.apiKey': null } }, deps);
    assert.equal(flat(cleared)['router.jev.apiKey'].secret.set, false);
  } finally { console.log = orig; }
  assert.equal(lines.some((l) => l.includes('sekrit-value-123')), false);
});

test('POST: a setter\'s own refusal is a 400 and lists what was already applied', async () => {
  await assert.rejects(
    () => patchSettings({ values: { 'router.preroute': true, 'brain.home': 'no-such-machine' } }, { ...deps, discovery: { get: () => null } }),
    (e) => e.status === 400 && /unknown machine/.test(e.message) && Array.isArray(e.applied),
  );
});
