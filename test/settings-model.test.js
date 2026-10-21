// The settings schema (ui/src/settings-model.js, docs/settings.md): the coverage guard — every config key, every config
// path read in src/ and every UI pref is in the preferences window or in HIDDEN with a reason, so a new setting cannot go
// missing silently — then the schema's consistency with the code (scopes, writers, defaults, choices) and its helpers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
Object.assign(process.env, { RIGS_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-settings-')), RIGS_NO_OPENRIG: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_MIGRATIONS: '1' });

const S = await import('../ui/src/settings-model.js');
const { defaults, PATCH_BLOCKED } = await import('../src/config.js');
const { GLOBAL_PATHS, globalSettings } = await import('../src/globalbrain.js');
const { KEYS: LAYOUT_KEYS } = await import('../src/uilayout.js');
const Q = await import('../src/quick.js');
const { ENGINES } = await import('../src/router.js');
const { YOLO_PROVIDERS } = await import('../src/yolo.js');
const { IMAGE_MODES } = await import('../src/exhibits.js');
const comfy = await import('../src/comfyui.js');
const linear = await import('../src/linear.js');
const drive = await import('../src/connectors/google-drive.js');
const { ZIP_LIMITS } = await import('../src/zip-model.js');
const { DEFAULT_SETTINGS: DOCK, POSITIONS } = await import('../ui/src/app-dock-state.js');
const { ASK_MODES, DEFAULT_ASK } = await import('../ui/src/ask-panel-model.js');
const { ANIM_MODES } = await import('../ui/src/exhibits-model.js');
const { renderInventory, withInventory, DOC } = await import('../scripts/settings-doc.js');

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const walkFiles = (dir, ext) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
  const rel = path.join(dir, e.name);
  return e.isDirectory() ? walkFiles(rel, ext) : e.name.endsWith(ext) ? [rel] : [];
});
/** Leaf paths of a plain-object tree: arrays, scalars and empty objects are leaves. */
function leaves(o, p = '') {
  if (o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length) return Object.entries(o).flatMap(([k, v]) => leaves(v, p ? `${p}.${k}` : k));
  return [p];
}
const values = (it) => (it.values || []).map((v) => (v && typeof v === 'object' ? v.value : v));
const hint = 'map it to an item in ui/src/settings-model.js (or add it to HIDDEN with a reason), then run node scripts/settings-doc.js';

// Config keys that live outside defaults(), with their defaults where their modules keep them.
const EXTRA_DEFAULTS = {
  ...Object.fromEntries(Object.entries(Q.localSettings({})).map(([k, v]) => [`quick.local.${k}`, v])),
  ...Object.fromEntries(Object.entries(comfy.DEFAULTS).map(([k, v]) => [`comfyui.${k}`, v])),
  ...Object.fromEntries(Object.entries(linear.DEFAULTS).map(([k, v]) => [`linear.${k}`, v])),
  ...Object.fromEntries(Object.entries(drive.loadSettings({})).map(([k, v]) => [`connectors.googleDrive.${k}`, v])),
  ...Object.fromEntries(Object.entries(ZIP_LIMITS).map(([k, v]) => [`files.zip.${k}`, v])),
  'connectors.slack.token': undefined, 'connectors.slack.userToken': undefined,
};

test('the module is import-free and bundles for the browser', async () => {
  const src = read('ui/src/settings-model.js');
  assert.doesNotMatch(src, /^\s*import\s/m, 'settings-model.js must stay import-free (browser + node)');
  const esbuild = await import('esbuild');
  const r = await esbuild.build({ entryPoints: [path.join(ROOT, 'ui/src/settings-model.js')], bundle: true, platform: 'browser', format: 'esm', write: false, logLevel: 'silent' });
  assert.equal(r.errors.length, 0);
  assert.match(r.outputFiles[0].text, /CATEGORIES/);
});

test('every key of config defaults() is in the window or hidden with a reason', () => {
  const d = defaults();
  const missingTop = Object.keys(d).filter((k) => !['item', 'hidden', 'parent'].includes(S.configCoverage(k)));
  assert.deepEqual(missingTop, [], `top-level config keys missing from the settings schema: ${missingTop.join(', ')} — ${hint}`);
  const missing = leaves(d).filter((p) => !['item', 'hidden'].includes(S.configCoverage(p)));
  assert.deepEqual(missing, [], `config settings missing from the settings schema: ${missing.join(', ')} — ${hint}`);
});

test('config keys outside defaults() are covered too (responder, connectors, zip limits)', () => {
  const missing = Object.keys(EXTRA_DEFAULTS).filter((p) => !['item', 'hidden'].includes(S.configCoverage(p)));
  assert.deepEqual(missing, [], `settings missing from the schema: ${missing.join(', ')} — ${hint}`);
});

test('every config path read in src/ and bin/ is in the window or hidden', () => {
  const files = [...walkFiles('src', '.js'), 'bin/rigs.js'];
  const missing = new Set();
  for (const f of files) {
    for (const m of read(f).matchAll(/config\(\)((?:\??\.[A-Za-z_$][\w$]*)+)/g)) {
      const p = m[1].replace(/\?/g, '').slice(1);
      if (!S.configCoverage(p)) missing.add(`${p} (${f})`);
    }
  }
  assert.deepEqual([...missing], [], `config reads with no setting in the schema: ${[...missing].join(', ')} — ${hint}`);
});

test('every UI pref (localStorage rigs.*) is in the window or hidden with a reason', () => {
  const files = [...walkFiles('ui/src', '.js').filter((f) => !f.endsWith('settings-model.js')), 'ui/index.html'];
  const keys = new Set();
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/['"`](rigs\.[A-Za-z0-9_.-]*)['"`]/g)) keys.add(m[1]);
    // main.js keeps its prefs through `store` ('rigs.' + key, JSON)
    if (f.endsWith('main.js')) for (const m of src.matchAll(/\bstore\.(?:get|set)\('([A-Za-z0-9_-]+)'/g)) if (!m[1].endsWith('-')) keys.add(`rigs.${m[1]}`);
  }
  assert.ok(keys.size > 20, `the scan found only ${keys.size} keys`);
  const missing = [];
  for (const k of keys) {
    if (k === 'rigs.') continue; // the generic helpers themselves (main.js store, toasts.js prefs)
    if (k.endsWith('.')) { if (!S.HIDDEN.some((h) => h.prefPrefix === k) && !S.ITEMS.some((it) => it.pref?.key.startsWith(k))) missing.push(`${k}*`); continue; }
    if (!S.prefCoverage(k)) missing.push(k);
  }
  assert.deepEqual(missing, [], `UI prefs missing from the settings schema: ${missing.join(', ')} — ${hint}`);
});

test('every left-panel Display / Forces control maps to an item, and stays the same pref', () => {
  const ids = [...read('ui/index.html').matchAll(/id="(d-[a-z0-9-]+|repel|linklen)"/g)].map((m) => `#${m[1]}`);
  assert.ok(ids.length >= 11, `found ${ids.length} controls`);
  const missing = ids.filter((id) => !S.ITEMS.some((it) => it.pref?.dom === id));
  assert.deepEqual(missing, [], `left-panel controls without a settings item: ${missing.join(', ')} — ${hint}`);
});

test('every app dock setting is an item of the synced rigs.appdock pref', () => {
  for (const [k, v] of Object.entries(DOCK)) {
    const it = S.ITEMS.find((x) => x.pref?.key === 'rigs.appdock' && x.pref.field === `settings.${k}`);
    assert.ok(it, `app dock setting ${k} has no item — ${hint}`);
    assert.equal(it.default, v, `ui.dock ${k} default`);
    assert.equal(it.scope, 'synced');
  }
});

test('scopes follow GLOBAL_PATHS and the ui-layout keys', () => {
  assert.deepEqual(S.GLOBAL_PATHS, GLOBAL_PATHS, 'settings-model.js GLOBAL_PATHS must mirror src/globalbrain.js');
  assert.deepEqual(S.SYNCED_KEYS, LAYOUT_KEYS, 'settings-model.js SYNCED_KEYS must mirror src/uilayout.js KEYS');
  for (const it of S.serverItems()) {
    const g = globalSettings(S.setPath({}, it.config, '__probe__'));
    const global = JSON.stringify(g).includes('__probe__');
    assert.equal(it.scope, global ? 'global' : 'machine', `${it.id} scope`);
  }
  assert.equal(S.itemById('router.jev.apiKey').scope, 'machine');
  assert.equal(S.itemById('quick.local.enabled').scope, 'global');
  assert.equal(S.itemById('ui.theme').scope, 'browser');
  assert.equal(S.itemById('ui.scaling').scope, 'synced');
});

test('items are well formed', () => {
  const ids = S.ITEMS.map((it) => it.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.deepEqual(S.CATEGORIES.map((c) => c.id).slice(0, 2), ['general', 'appearance']);
  assert.equal(new Set(S.CATEGORIES.map((c) => c.id)).size, S.CATEGORIES.length);
  for (const c of S.CATEGORIES) assert.ok(c.label && c.icon && c.help && c.items.length, `category ${c.id}`);
  for (const it of S.ITEMS) {
    const where = `item ${it.id}`;
    assert.ok(S.CONTROLS.includes(it.control), `${where}: control ${it.control}`);
    assert.ok(it.label && it.help, `${where}: label and help`);
    assert.ok(S.SCOPES[it.scope], `${where}: scope ${it.scope}`);
    if (it.control === 'select') assert.ok(it.values?.length || it.choices, `${where}: values or choices`);
    if (it.choices) assert.ok(Object.keys(S.CHOICES).some((c) => it.choices === c || it.choices.startsWith(c.split('<')[0])), `${where}: choices ${it.choices}`);
    if (['number', 'slider'].includes(it.control)) assert.ok(it.min < it.max, `${where}: min < max`);
    if (it.secret) assert.equal(it.control, 'secret-status', where);
    if (it.control === 'action') assert.ok(it.action?.api || S.UI_SURFACES[it.action?.open], `${where}: action api or a known UI surface`);
    if (it.pref) {
      assert.match(it.pref.key, /^rigs\./, where);
      assert.ok(it.pref.via, `${where}: pref.via names the function that applies it`);
      assert.ok(['raw', 'json', 'flag'].includes(it.pref.format), where);
      assert.ok(it.id.startsWith('ui.'), `${where}: UI prefs are ui.<name>`);
    }
    if (it.config) {
      assert.ok(it.readOnly || it.writer, `${where}: a config item is read-only or has a writer`);
      if (it.writer) assert.ok(S.WRITERS[it.writer], `${where}: writer ${it.writer}`);
      if (it.writer === 'config') assert.ok(!PATCH_BLOCKED.includes(it.config.split('.')[0]), `${where}: patchConfig drops ${it.config.split('.')[0]}`);
    }
  }
  for (const h of S.HIDDEN) assert.ok(h.reason?.length > 20 && (h.config || h.pref || h.prefPrefix), `hidden entry ${JSON.stringify(h)}`);
  // screen control is never written by the settings API
  for (const it of S.ITEMS.filter((x) => x.config?.startsWith('control.'))) assert.equal(S.isWritable(it.id), false, it.id);
});

test('defaults in the schema are the ones the code applies', () => {
  const d = defaults();
  const checked = [];
  for (const it of S.serverItems()) {
    if (it.default === undefined) continue;
    const real = it.config in EXTRA_DEFAULTS ? EXTRA_DEFAULTS[it.config] : S.getPath(d, it.config);
    if (real === undefined) continue;
    assert.ok(isDeepStrictEqual(it.default, real), `${it.id}: schema default ${JSON.stringify(it.default)} ≠ code default ${JSON.stringify(real)}`);
    checked.push(it.id);
  }
  assert.ok(checked.length > 120, `checked ${checked.length} defaults`);
  assert.equal(S.itemById('ui.askPlacement').default, DEFAULT_ASK.mode);
});

test('choices match the code that validates them', () => {
  assert.deepEqual(values(S.itemById('quick.local.tools')), Q.READ_ONLY_TOOLS);
  assert.deepEqual(values(S.itemById('quick.local.tiers')), Q.TIERS);
  assert.deepEqual(values(S.itemById('quick.simple.provider')), Q.QUICK_PROVIDERS);
  assert.deepEqual(values(S.itemById('yolo.provider')), YOLO_PROVIDERS);
  assert.deepEqual(values(S.itemById('router.engine')), ENGINES);
  assert.deepEqual(values(S.itemById('exhibits.images')), IMAGE_MODES);
  assert.deepEqual(values(S.itemById('ui.askPlacement')), ASK_MODES);
  assert.deepEqual(values(S.itemById('ui.exhibitAnim')), ANIM_MODES);
  assert.deepEqual(values(S.itemById('ui.dock.position')).sort(), [...POSITIONS].sort());
});

test('validateValue checks type, choices and range, and never echoes a secret', () => {
  const v = (id, x) => S.validateValue(S.itemById(id), x);
  assert.deepEqual(v('quick.enabled', false), { ok: true, value: false });
  assert.equal(v('quick.enabled', 'yes').ok, false);
  assert.deepEqual(v('router.engine', 'rules'), { ok: true, value: 'rules' });
  assert.match(v('router.engine', 'gpt').error, /one of/);
  assert.deepEqual(v('quick.maxTurns', '12'), { ok: true, value: 12 });
  assert.match(v('quick.maxTurns', 99).error, /between 1 and 50/);
  assert.match(v('quick.maxTurns', 2.5).error, /whole number/);
  assert.deepEqual(v('router.jev.minProb', 0.7), { ok: true, value: 0.7 });
  assert.deepEqual(v('quick.local.tiers', ['sonnet', 'haiku', 'sonnet']), { ok: true, value: ['sonnet', 'haiku'] });
  assert.equal(v('quick.local.tools', ['mesh_exec']).ok, false);
  assert.deepEqual(v('quick.local.keepAlive', '1h'), { ok: true, value: '1h' });
  assert.equal(v('quick.local.keepAlive', 'forever').ok, false);
  assert.equal(v('persona.name', 'a\nb').ok, false);
  assert.equal(v('control.enabled', true).error, 'read-only here');
  assert.equal(v('action.sharedSync', true).ok, false);
  assert.equal(S.validateValue(null, 1).error, 'unknown setting');
  const secret = 'lin_api_SECRETSECRETSECRET';
  assert.deepEqual(v('linear.apiKey', secret), { ok: true, value: secret });
  assert.deepEqual(v('linear.apiKey', null), { ok: true, value: null });
  const bad = v('linear.apiKey', { k: secret });
  assert.equal(bad.ok, false);
  assert.ok(!JSON.stringify(bad).includes(secret));
});

test('planPatch routes each value to the existing setter and rejects what the API must not take', () => {
  const current = (p) => ({ 'brain.chat.provider': 'claude', 'brain.chat.model': 'claude-haiku-5-5', 'brain.chat.effort': 'low', 'brain.core.node': 'ubuntu' })[p];
  const { writes, errors } = S.planPatch({
    'quick.enabled': false, 'quick.local.model': 'llama3.2', 'router.preroute': false, 'router.jev.apiKey': null,
    'brain.chat.effort': 'medium', 'brain.home': 'macbookpro', 'brain.core.model': 'claude-opus-5-5', 'persona.humor': 70, 'shared.ignore': ['*.tmp'],
    'linear.apiKey': null, 'comfyui.authHeader': S.SECRET_MASK, 'connectors.googleDrive.clientSecret': 'shh-it-is-a-secret', 'experimental.starnet.enabled': true,
  }, { current });
  assert.deepEqual(errors, []);
  const by = Object.fromEntries(writes.map((w) => [w.writer, w]));
  assert.deepEqual(by.quick.body, { enabled: false, local: { model: 'llama3.2' } });
  assert.equal(by.quick.endpoint, 'POST /api/local/quick');
  assert.deepEqual(by.router.body, { preroute: false, jev: { apiKey: '' } });
  assert.deepEqual(by.brainChat.body, { effort: 'medium', provider: 'claude', model: 'claude-haiku-5-5' }, 'whole-object writers get the rest from current');
  assert.deepEqual(by.brainHome.body, { node: 'macbookpro' });
  assert.deepEqual(by.brainCore.body, { model: 'claude-opus-5-5', provider: '', effort: '', node: 'ubuntu' });
  assert.deepEqual(by.config.body, { persona: { humor: 70 }, shared: { ignore: ['*.tmp'] } });
  assert.deepEqual(by.linear.body, { clearKey: true });
  assert.equal(by.comfyui, undefined, 'the mask keeps the stored secret: nothing to write');
  assert.deepEqual(by.googleDrive.body, { clientSecret: 'shh-it-is-a-secret' });
  assert.deepEqual(by.starnet.body, { enabled: true });
  assert.deepEqual(writes.map((w) => w.writer), ['router', 'quick', 'brainHome', 'brainChat', 'brainCore', 'starnet', 'linear', 'googleDrive', 'config']);

  const bad = S.planPatch({ nope: 1, 'ui.theme': 'atari', 'control.enabled': true, meshToken: 'x', 'routing.rules': [], 'action.updateAll': true, 'quick.maxTurns': 0 });
  assert.equal(bad.writes.length, 0);
  assert.deepEqual(bad.errors.map((e) => e.id), ['nope', 'ui.theme', 'control.enabled', 'meshToken', 'routing.rules', 'action.updateAll', 'quick.maxTurns']);
  assert.equal(S.planPatch(null).errors.length, 1);
  assert.equal(S.planPatch(['quick.enabled']).errors.length, 1);
});

test('the whitelist is exactly the items with a writer, and every one round-trips through planPatch', () => {
  const writable = S.ITEMS.filter((it) => S.isWritable(it.id));
  assert.ok(writable.length > 100, `${writable.length} writable items`);
  for (const it of writable) {
    const sample = it.control === 'switch' ? !it.default : it.control === 'list' ? (it.values ? [values(it)[0]] : ['x']) : it.control === 'secret-status' ? 'new-secret-value'
      : it.values ? values(it).at(-1) : ['number', 'slider'].includes(it.control) ? it.max : it.pattern ? '1h' : 'value';
    const { writes, errors } = S.planPatch({ [it.id]: sample });
    assert.deepEqual(errors, [], it.id);
    assert.equal(writes.length, 1, it.id);
    assert.equal(writes[0].writer, it.writer);
  }
});

test('secrets only ever come out as set / len', () => {
  assert.deepEqual(S.secretStatus('abcdef'), { set: true, len: 6, source: 'config' });
  assert.deepEqual(S.secretStatus('', 'config'), { set: false, len: 0, source: null });
  assert.deepEqual(S.secretStatus(undefined), { set: false, len: 0, source: null });
  assert.equal(S.formatSecret(S.secretStatus('abcdef', 'env')), 'set · len=6 (environment)');
  assert.equal(S.formatSecret({ set: false }), 'not set');
  for (const id of ['meshToken', 'desktop.sunshinePass', 'router.jev.apiKey', 'linear.apiKey', 'comfyui.authHeader', 'connectors.googleDrive.clientSecret', 'connectors.slack.token', 'connectors.slack.userToken']) {
    assert.equal(S.itemById(id)?.secret, true, `${id} is a secret`);
  }
});

test('search finds settings by label, help, category and CLI', () => {
  const ids = (q) => S.searchItems(q).map((x) => x.item.id);
  assert.equal(ids('pre-routing')[0], 'router.preroute', 'a label match comes first');
  assert.ok(ids('local responder').includes('quick.local.enabled'));
  assert.ok(ids('rigs yolo').includes('yolo.enabled'));
  assert.ok(ids('THEME').includes('ui.theme'));
  assert.ok(ids('magnification size').includes('ui.dock.magnifyStrength'));
  assert.deepEqual(ids('   '), []);
  assert.deepEqual(ids('zzzz-no-such-setting'), []);
  assert.equal(S.searchItems('humor')[0].category.id, 'general');
});

test('UI prefs decode and encode exactly as the existing code stores them', () => {
  const it = (id) => S.itemById(id);
  assert.equal(S.decodePref(it('ui.theme'), null), 'jarvis');
  assert.equal(S.encodePref(it('ui.theme'), 'atari'), 'atari');
  assert.equal(S.decodePref(it('ui.cloud'), 'false'), false); // main.js store: JSON
  assert.equal(S.encodePref(it('ui.repel'), 200), '200');
  assert.equal(S.decodePref(it('ui.exhibitAnim'), '"always"'), 'always');
  assert.equal(S.decodePref(it('ui.speak'), '1'), false, 'rigs.muted = 1 → not speaking');
  assert.equal(S.decodePref(it('ui.speak'), null), true);
  assert.equal(S.encodePref(it('ui.speak'), false), '1');
  assert.equal(S.decodePref(it('ui.menubarHidden'), 'hidden'), true);
  assert.equal(S.encodePref(it('ui.menubarHidden'), false), 'shown');
  assert.equal(S.encodePref(it('ui.clock12'), true), 'h12');
  assert.equal(S.decodePref(it('ui.notifications'), 'false'), false);
  assert.equal(S.decodePref(it('ui.docking'), 'garbage'), false, 'an unknown flag value falls back to the default');
  const dock = JSON.stringify({ v: 2, settings: { position: 'left', autoHide: true }, items: { 'rig:a': {} } });
  assert.equal(S.decodePref(it('ui.dock.position'), dock), 'left');
  const next = JSON.parse(S.encodePref(it('ui.dock.position'), 'right', dock));
  assert.deepEqual(next, { v: 2, settings: { position: 'right', autoHide: true }, items: { 'rig:a': {} } }, 'the rest of the dock state is kept');
  assert.equal(S.decodePref(it('ui.askPlacement'), '{"mode":"floating","rect":null}'), 'floating');
  assert.equal(S.decodePref(it('ui.askPlacement'), '{broken'), 'topbar');
  assert.equal(S.decodePref({}, 'x'), undefined);
});

test('valuesById flattens the GET payload', () => {
  const res = { categories: [{ id: 'routing', items: [{ id: 'quick.enabled', value: true }] }, { id: 'connectors', items: [{ id: 'linear.apiKey', secret: { set: false } }] }] };
  assert.deepEqual(S.valuesById(res), { 'quick.enabled': { id: 'quick.enabled', value: true }, 'linear.apiKey': { id: 'linear.apiKey', secret: { set: false } } });
  assert.deepEqual(S.valuesById(null), {});
});

test('docs/settings.md carries the generated inventory of every item', () => {
  const doc = fs.readFileSync(DOC, 'utf8');
  assert.equal(withInventory(doc), doc, 'docs/settings.md is out of date: run node scripts/settings-doc.js');
  const inv = renderInventory();
  for (const it of S.ITEMS) assert.ok(inv.includes(`\`${it.id}\``), `${it.id} is in the inventory`);
  for (const h of S.HIDDEN) assert.ok(inv.includes(h.reason.replace(/\|/g, '\\|')), 'hidden entries are in the inventory');
  for (const w of Object.values(S.WRITERS)) assert.ok(doc.includes(w.endpoint), `${w.endpoint} is documented`);
  assert.match(doc, /GET \/api\/local\/settings|### GET/);
  assert.match(doc, /PATCH_BLOCKED/);
});
