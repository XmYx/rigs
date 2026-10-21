// System Preferences window (ui/src/prefs-model.js, ui/src/prefs-bridge.js): what the window shows on a desktop and a
// phone, search across categories, grouped rows, select options from static and dynamic sources, typed values from
// controls, action requests, the saved / error text, every UI pref routed to the live UI, and the JARVIS menu entries.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { CATEGORIES, ITEMS, itemById, prefItems } from '../ui/src/settings-model.js';
import {
  actionRequest, choiceOptions, coerceInput, displayValue, errorFor, groupRows, hasMachineItems, hasServerItems, offered, savedText, scopeChip,
  searchGroups, visibleCategories,
} from '../ui/src/prefs-model.js';
import { BRIDGED, createPrefBridge } from '../ui/src/prefs-bridge.js';

const it = (id) => itemById(id);
function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

test('every category and item is offered on a desktop; phones lose only the phone: false items', () => {
  const desk = visibleCategories();
  assert.deepEqual(desk.map((c) => c.id), CATEGORIES.map((c) => c.id));
  assert.equal(desk.flatMap((c) => c.items).length, ITEMS.length);
  const phone = visibleCategories({ phone: true }).flatMap((c) => c.items).map((x) => x.id);
  const gone = ITEMS.filter((x) => !phone.includes(x.id));
  assert.ok(gone.length > 0 && gone.every((x) => x.phone === false), gone.map((x) => x.id).join(', '));
  for (const id of ['ui.docking', 'ui.scaling', 'ui.menubarHidden']) assert.equal(offered(it(id), { phone: true }), false, id);
  assert.ok(phone.includes('quick.enabled') && phone.includes('ui.theme'));
});

test('search groups hits by category in window order and respects the phone filter', () => {
  const g = searchGroups('token');
  assert.ok(g.length >= 2, 'tokens show up in more than one category');
  const order = CATEGORIES.map((c) => c.id);
  assert.deepEqual(g.map((x) => x.category.id), [...g.map((x) => x.category.id)].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
  assert.deepEqual(searchGroups(''), []);
  assert.deepEqual(searchGroups('zzzz-no-such-setting'), []);
  assert.ok(searchGroups('docking').some((x) => x.items.some((i) => i.id === 'ui.docking')));
  assert.ok(!searchGroups('docking', { phone: true }).some((x) => x.items.some((i) => i.id === 'ui.docking')));
});

test('rows keep their group boxes in first-seen order', () => {
  const rows = groupRows([{ id: 'a', group: 'X' }, { id: 'b', group: 'Y' }, { id: 'c', group: 'X' }, { id: 'd' }]);
  assert.deepEqual(rows.map((r) => [r.group, r.items.map((x) => x.id)]), [['X', ['a', 'c']], ['Y', ['b']], ['', ['d']]]);
  const general = CATEGORIES.find((c) => c.id === 'general');
  assert.deepEqual(groupRows(general.items).map((r) => r.group), ['JARVIS', 'This machine']);
});

test('the machine picker shows for server items; scope chips name where a value lives', () => {
  assert.equal(hasServerItems([it('ui.theme')]), false);
  assert.equal(hasServerItems([it('quick.enabled')]), true);
  assert.equal(hasMachineItems([it('quick.enabled')]), false, 'quick is mesh-wide');
  assert.equal(hasMachineItems([it('persona.humor')]), true);
  assert.equal(scopeChip(it('quick.enabled')).text, 'Mesh-wide');
  assert.equal(scopeChip(it('persona.humor')), null);
  assert.equal(scopeChip(it('ui.docking')).text, 'All screens');
  assert.equal(scopeChip(it('ui.theme')), null, 'a browser pref needs no chip');
  assert.equal(scopeChip(it('action.updateAll')).text, 'Every machine');
});

test('select options: static values keep their type, dynamic sources fill in, the current value is never dropped', () => {
  assert.deepEqual(choiceOptions(it('ui.dock.magnifyStrength')).map((o) => o.value), [0.3, 0.6, 1]);
  const catalog = [{ id: 'claude', label: 'Claude', models: ['claude-haiku-5-5', 'claude-opus-5-5'], efforts: ['low', 'high'] }, { id: 'ollama', label: 'Ollama', models: ['qwen3:8b'], efforts: ['off', 'on'] }];
  const ctx = { catalog, value: (id) => (id === 'brain.chat.provider' ? 'ollama' : undefined), machines: [{ name: 'mac', self: true }, { name: 'linux' }], themes: { jarvis: { name: 'JARVIS' }, atari: { name: 'Atari' } }, voices: [{ id: 'browser:Samantha', label: 'Samantha' }] };
  assert.deepEqual(choiceOptions(it('brain.chat.provider'), ctx, 'claude').map((o) => o.value), ['claude', 'ollama']);
  assert.deepEqual(choiceOptions(it('brain.chat.effort'), ctx, 'off').map((o) => o.value).filter(Boolean), ['off', 'on'], 'efforts follow the provider chosen in the named item');
  assert.deepEqual(choiceOptions(it('quick.simple.effort'), ctx, 'low').map((o) => o.value).filter(Boolean), ['low', 'high'], 'efforts:claude is a literal provider');
  const m = choiceOptions(it('brain.home'), ctx, 'mac');
  assert.ok(m.some((o) => o.value === 'mac' && /this machine/.test(o.label)) && m.some((o) => o.value === 'linux'));
  assert.ok(choiceOptions(it('brain.home'), ctx, 'gone-box').some((o) => o.value === 'gone-box' && /current/.test(o.label)), 'an offline machine stays selectable');
  assert.deepEqual(choiceOptions(it('ui.theme'), ctx, 'jarvis').map((o) => o.value), ['jarvis', 'atari']);
  assert.equal(choiceOptions(it('ui.voice'), ctx, '')[0].value, '', 'voices: Automatic first');
  assert.ok(choiceOptions(it('brain.core.node'), ctx, '').some((o) => o.value === ''), "'' = this machine is offered where the default is empty");
});

test('control values become schema values (typed, validated) before anything is saved', () => {
  assert.deepEqual(coerceInput(it('ui.dock.magnifyStrength'), '0.6'), { ok: true, value: 0.6 });
  assert.deepEqual(coerceInput(it('persona.humor'), '45'), { ok: true, value: 45 });
  assert.equal(coerceInput(it('traces.days'), '0').ok, false);
  assert.match(coerceInput(it('traces.days'), '0').error, /between 1 and 3650/);
  assert.equal(coerceInput(it('traces.days'), '2.5').ok, false);
  assert.deepEqual(coerceInput(it('peers'), 'http://a:4719\n\nhttp://b:4719, http://a:4719'), { ok: true, value: ['http://a:4719', 'http://b:4719'] });
  assert.deepEqual(coerceInput(it('quick.local.tiers'), ['haiku']), { ok: true, value: ['haiku'] });
  assert.equal(coerceInput(it('quick.local.tiers'), ['gpt']).ok, false);
  assert.deepEqual(coerceInput(it('quick.enabled'), false), { ok: true, value: false });
  assert.deepEqual(coerceInput(it('linear.apiKey'), null), { ok: true, value: null }, 'a secret can be cleared');
  assert.equal(coerceInput(it('name'), 'x').ok, false, 'read-only');
});

test('read-only values, secrets and lists read well; actions make the request their item names', () => {
  assert.equal(displayValue(it('linear.apiKey'), { set: true, len: 32, source: 'config' }), 'set · len=32');
  assert.equal(displayValue(it('linear.apiKey'), { set: false }), 'not set');
  assert.equal(displayValue(it('peers'), []), 'none');
  assert.equal(displayValue(it('traces.days'), 14), '14 days');
  assert.equal(displayValue(it('nodeId'), ''), '—');
  assert.deepEqual(actionRequest(it('action.sharedSync'), '/api/nodes/abc'), { method: 'POST', url: '/api/nodes/abc/shared/sync' });
  assert.deepEqual(actionRequest(it('action.updateAll'), '/api/nodes/abc'), { method: 'POST', url: '/api/mesh/update' });
  assert.equal(actionRequest(it('action.openControl'), '/api/nodes/abc'), null, 'an open action makes no request');
  for (const x of ITEMS.filter((i) => i.control === 'action')) assert.ok(x.action.open || actionRequest(x, '/b'), `${x.id} does something`);
});

test('the indicator says where it was saved and when it applies; refusals show the real message', () => {
  assert.equal(savedText(it('quick.enabled'), { machine: 'mac' }), 'Saved for the whole mesh');
  assert.equal(savedText(it('persona.humor'), { machine: 'linux' }), 'Saved on linux');
  assert.equal(savedText(it('keepAwake'), { machine: 'mac' }), 'Saved on mac · applies after a restart');
  assert.equal(errorFor('traces.days', { error: 'first', errors: [{ id: 'x', error: 'first' }, { id: 'traces.days', error: 'must be between 1 and 3650' }] }), 'must be between 1 and 3650');
  assert.equal(errorFor('a', { error: 'Engine must be rules or llm' }), 'Engine must be rules or llm');
  assert.equal(errorFor('a', null), 'The change was not saved');
});

test('every UI pref is bridged to the live UI, except the ones read only at start', () => {
  const unbridged = prefItems().filter((p) => !BRIDGED[p.id]).map((p) => p.id);
  assert.deepEqual(unbridged, ['ui.stt'], 'rigs.stt is read when hearing starts: storage is the live state');
  for (const id of Object.keys(BRIDGED)) assert.ok(it(id)?.pref, `${id} is a UI pref`);
});

test('the bridge calls the live setters, mirrors their state, and falls back to storage in the item\'s format', async () => {
  const calls = [];
  const live = { theme: 'jarvis', dock: { position: 'bottom' }, muted: false, labels: true };
  const storage = memStorage({ 'rigs.stt': 'server' });
  const b = createPrefBridge({
    storage,
    theme: { get: () => live.theme, set: (v) => { calls.push(['theme', v]); live.theme = v; } },
    dock: { get: (f) => live.dock[f], set: (f, v) => { calls.push(['dock', f, v]); live.dock[f] = v; } },
    display: { get: (k) => live[k], set: (k, v) => { calls.push(['display', k, v]); live[k] = v; } },
    voice: { get muted() { return live.muted; }, setMuted: (v) => { calls.push(['muted', v]); live.muted = v; }, voiceId: 'browser:x', setVoice: () => {} },
  });
  b.set('ui.theme', 'atari');
  assert.equal(b.get('ui.theme'), 'atari');
  b.set('ui.dock.position', 'left');
  assert.equal(b.get('ui.dock.position'), 'left');
  b.set('ui.labels', false);
  assert.equal(b.get('ui.labels'), false);
  b.set('ui.speak', false);
  assert.equal(live.muted, true, 'Speak replies off = muted (rigs.muted is inverted)');
  assert.equal(b.get('ui.speak'), false);
  assert.deepEqual(calls, [['theme', 'atari'], ['dock', 'position', 'left'], ['display', 'labels', false], ['muted', true]]);
  // No live dep → storage, exactly as the existing code stores it.
  assert.equal(b.get('ui.stt'), 'server');
  b.set('ui.stt', 'browser');
  assert.equal(storage.m.get('rigs.stt'), 'browser');
  b.set('ui.clock12', true);
  assert.equal(storage.m.get('rigs.clock12'), 'h12');
  b.set('ui.attnBanner', false);
  assert.equal(storage.m.get('rigs.attnBanner'), 'false');
  b.set('ui.dock.autoHide', true); // with a live dock, through it
  assert.equal(live.dock.autoHide, true);
  assert.throws(() => b.get('quick.enabled'), /not a UI preference/);
});

test('a live getter that throws or has nothing yet reads the stored value instead', () => {
  const b = createPrefBridge({ storage: memStorage({ 'rigs.repel': '200' }), forces: { get: () => { throw new Error('graph not ready'); }, set() {} } });
  assert.equal(b.get('ui.repel'), 200);
  const c = createPrefBridge({ storage: memStorage({ 'rigs.appdock': JSON.stringify({ settings: { position: 'right' } }) }), dock: { get: () => undefined, set() {} } });
  assert.equal(c.get('ui.dock.position'), 'right');
});

test('the JARVIS menu is first, at the far left, with About, System Preferences… (⌘,) and global actions', () => {
  const src = fs.readFileSync(new URL('../ui/src/jarvis-commands.js', import.meta.url), 'utf8');
  const jarvis = src.slice(src.indexOf("{ id: 'jarvis', label: '◆ JARVIS'"), src.indexOf("{ id: 'file', label: 'File'"));
  for (const c of ['help.about', 'jarvis.prefs', 'jarvis.rescan', 'jarvis.mute']) assert.ok(jarvis.includes(`cmd: '${c}'`), c);
  assert.match(jarvis, /brand: true/);
  assert.match(src, /id: 'jarvis\.prefs'[^\n]*shortcut: 'Mod\+,'/);
  assert.match(src, /label: 'About RIGS OS'/);
  const menubar = fs.readFileSync(new URL('../ui/src/menubar.js', import.meta.url), 'utf8');
  assert.match(menubar, /d\.brand \? ' mb-brand' : ''/, 'the brand entry is drawn as the JARVIS mark');
  const main = fs.readFileSync(new URL('../ui/src/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /from '\.\/(docking|scaling)\.js'/, 'main.js must not import these directly: it reorders the bundle\'s module cycle (docking before scaling → boot error)');
});
