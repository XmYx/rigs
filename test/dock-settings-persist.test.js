// Dock settings survive RIGS updates: the app dock saved on the mesh is never replaced by a page that has not loaded
// it (boot defaults, a fresh browser, a reload before the daemon answered) or by what a page derives while peers are
// restarting (rigs and applets missing from the snapshot). Real pieces end to end: ui/src/synced-storage-model.js as
// the page's storage, ui/src/app-dock-state.js as the dock, src/uilayout.js as each machine's daemon (a restart is a
// new store over the same file; the mesh is store.adopt(peer.snapshot()), as server.js pushes and pulls).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const M = await import('../ui/src/synced-storage-model.js');
const S = await import('../ui/src/app-dock-state.js');
const L = await import('../src/uilayout.js');

const KEY = 'rigs.appdock';
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}

/** One machine's daemon: a uilayout store over a file in `dir`, a clock, and the PUTs its pages sent. */
function daemon(dir, name, clock) {
  const file = path.join(dir, `${name}.json`);
  const d = { name, file, puts: [], hold: false };
  d.boot = () => { d.store = L.createStore({ file, name, now: () => clock.t }); return d; }; // `rigs start` after an update
  d.transport = {
    get: () => (d.hold ? new Promise(() => {}) : Promise.resolve(d.store.snapshot())), // hold: a GET that never answers in time
    put: async (key, value) => { d.puts.push({ key, value: structuredClone(value) }); return d.store.set(key, value); },
  };
  return d.boot();
}

/** A JARVIS page: synced storage over `local`, and the dock persisted the way app-dock.js does it. */
function page(local, d, clock) {
  const store = M.createSyncedStorage({ local, transport: d.transport, now: () => clock.t, setTimer: (fn) => { queueMicrotask(fn); return 1; }, clearTimer: () => {} });
  const p = { store, dock: null };
  const save = ({ auto = false } = {}) => {
    const write = () => store.setItem(KEY, S.serialize(p.dock));
    if (auto && store.auto) store.auto(write); else write(); // app-dock.js save(): same fallback for a storage without auto()
  };
  p.load = () => { p.dock = S.deserialize(store.getItem(KEY)); return p; };
  /** app-dock.js sync(): fold the mesh snapshot in. */
  p.sync = (sources) => { const next = S.mergeSources(p.dock, sources); if (S.serialize(next) !== S.serialize(p.dock)) { p.dock = next; save({ auto: true }); } return p; };
  /** A person's action (app-dock.js act()). */
  p.act = (fn) => { const next = fn(p.dock); if (next !== p.dock) { p.dock = next; save(); } return p; };
  store.onRemote((k) => { if (k === KEY) store.quiet(() => p.load()); }); // main.js onRemoteKey → appDock.reload
  return p;
}

const rig = (id) => ({ id, name: id, online: true, rigs: true });
const BOTH = { tools: S.TOOLS, rigs: [rig('mac'), rig('lin')] };
const MAC_ONLY = { tools: S.TOOLS, rigs: [rig('mac')] }; // right after an update: lin is still restarting

/** What a person set: settings, pins, hidden items, groups with their members, the top-level order. */
const essence = (s) => ({
  settings: s.settings,
  pinned: Object.values(s.items).filter((i) => i.pinned).map((i) => i.id).sort(),
  hidden: Object.values(s.items).filter((i) => i.hidden).map((i) => i.id).sort(),
  groups: Object.fromEntries(Object.entries(s.groups).map(([g, v]) => [g, { name: v.name, items: v.items }])),
  order: s.order.map((e) => `${e.type}:${e.id}`),
});

/** Sir's dock: every setting off its default, a pin, a hidden tool, his own stack, a rig moved out to the front. */
function customDock() {
  let s = S.mergeSources(S.emptyState(), BOTH);
  s = S.setSettings(s, { position: 'left', autoHide: true, magnification: false, magnifyStrength: 0.25, autoDock: true, autoTabTerminals: true, autoGroup: false });
  s = S.createGroup(s, { name: 'My stack', items: ['tool:term', 'tool:files'] });
  s = S.moveItem(s, 'rig:lin', { group: null, index: 0 });
  s = S.setPinned(s, 'tool:ask', true);
  s = S.setHidden(s, 'tool:desk', true);
  return S.deserialize(S.serialize(s));
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-dock-persist-'));
  const clock = { t: 1_800_000_000_000 };
  return { dir, clock, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Sir arranged his dock on A's page an hour ago: saved on A's daemon, synced to B's, cached in A's browser. */
async function saved({ dir, clock }) {
  const A = daemon(dir, 'mac', clock);
  const B = daemon(dir, 'lin', clock);
  const local = memStorage();
  const p = page(local, A, clock);
  await p.store.refresh();
  p.load().sync(BOTH).act(() => customDock());
  await settle();
  B.store.adopt(A.store.snapshot());
  const want = essence(customDock());
  assert.deepEqual(essence(S.deserialize(A.store.get(KEY).value)), want, 'saved on A');
  clock.t += 3_600_000;
  A.puts.length = 0;
  return { A, B, local, want, stamp: A.store.get(KEY) };
}

test('update: daemon restart + new UI build + reload with a saved dock keeps every setting, pin, hidden item, group and order', async () => {
  const env = setup();
  try {
    const { A, B, local, want, stamp } = await saved(env);
    // Both machines update at once: A's daemon restarts (same RIGS_HOME), B is still installing.
    A.boot();
    const p = page(local, A, env.clock);
    await p.store.refresh();
    p.load().sync(MAC_ONLY); // the first snapshot after the restart misses lin
    await settle();
    assert.equal(A.puts.length, 0, 'a dock derived from a partial snapshot is not sent');
    env.clock.t += 5000;
    p.sync(BOTH); // lin is back
    await settle();
    assert.deepEqual(essence(p.dock), want, 'the page shows the dock exactly as saved: lin back at the front');
    assert.equal(A.puts.length, 0);
    assert.deepEqual(A.store.get(KEY), stamp, 'A\'s saved dock and its stamp are untouched');
    B.boot();
    assert.deepEqual(B.store.adopt(A.store.snapshot()), [], 'nothing newer reaches B');
    // the next reload still starts from the saved dock
    const again = page(local, A.boot(), env.clock);
    await again.store.refresh();
    again.load().sync(BOTH);
    await settle();
    assert.deepEqual(essence(again.dock), want);
    assert.equal(A.puts.length, 0);
  } finally { env.done(); }
});

test('the page that stays open across an update keeps the dock while a peer is gone, and a later change by Sir keeps the rest', async () => {
  const env = setup();
  try {
    const { A, local, want } = await saved(env);
    const p = page(local, A, env.clock);
    await p.store.refresh();
    p.load().sync(BOTH);
    p.sync(MAC_ONLY); // lin restarting: its rig leaves the dock for a moment …
    p.sync(BOTH); // … and comes back to the spot it left
    await settle();
    assert.deepEqual(essence(p.dock), want);
    assert.equal(A.puts.length, 0);
    p.act((s) => S.setSettings(s, { magnifyStrength: 0.5 })); // Sir changes one thing
    await settle();
    const now = S.deserialize(A.store.get(KEY).value);
    assert.equal(now.settings.magnifyStrength, 0.5);
    assert.deepEqual(essence({ ...now, settings: { ...now.settings, magnifyStrength: 0.25 } }), want, 'everything else is as saved');
  } finally { env.done(); }
});

test('a fresh browser (empty localStorage) takes the saved dock from the daemon and never uploads defaults over it', async () => {
  const env = setup();
  try {
    const { A, want, stamp } = await saved(env);
    // The daemon answers within the boot wait.
    const p = page(memStorage(), A, env.clock);
    await p.store.refresh();
    p.load().sync(MAC_ONLY);
    await settle();
    assert.deepEqual(essence(p.load().dock), essence(S.mergeSources(customDock(), MAC_ONLY)));
    p.sync(BOTH);
    assert.deepEqual(essence(p.dock), want);
    // The daemon is slower than the 1.5 s boot wait: the dock starts on defaults, then the saved one arrives.
    A.hold = true;
    const slow = page(memStorage(), A, env.clock);
    slow.store.refresh();
    slow.load().sync(BOTH);
    assert.equal(slow.dock.settings.position, 'bottom', 'defaults while waiting');
    A.hold = false;
    await slow.store.refresh();
    await settle();
    slow.sync(BOTH);
    assert.deepEqual(essence(slow.dock), want, 'the saved dock replaces the defaults');
    assert.equal(A.puts.length, 0, 'no PUT from either fresh page');
    assert.deepEqual(A.store.get(KEY), stamp);
  } finally { env.done(); }
});

test('a dock written before the daemon answered never beats the saved one after a reload, even with a newer clock', async () => {
  const env = setup();
  try {
    const { A, want, stamp } = await saved(env);
    const local = memStorage();
    // Page 1 boots right after the update while A's daemon is too busy to answer, and a default dock is written
    // (by a person even: a click in the first second) — then the page is reloaded before the daemon ever answered.
    A.hold = true;
    const p1 = page(local, A, env.clock);
    p1.store.refresh();
    p1.load().sync(BOTH).act((s) => S.setSettings(s, { autoHide: false }));
    env.clock.t += 60_000; // its stamp is newer than the saved dock's
    A.hold = false;
    const p2 = page(local, A, env.clock);
    await p2.store.refresh();
    await settle();
    p2.load().sync(BOTH);
    await settle();
    assert.deepEqual(essence(p2.dock), want, 'the reloaded page shows the saved dock');
    assert.equal(A.puts.length, 0, 'the boot-time dock is not sent');
    assert.deepEqual(A.store.get(KEY), stamp);
  } finally { env.done(); }
});

test('a peer with a default dock and a newer clock never overwrites the saved one; a change Sir makes there does', async () => {
  const env = setup();
  try {
    const { A, want, stamp } = await saved(env);
    // C is a machine whose daemon has no saved dock yet (new install, lost ui-layout.json) and a fresh browser; its
    // clock is a minute ahead. Its page loads before C's daemon pulled the mesh's dock.
    const clockC = { t: env.clock.t + 60_000 };
    const C = daemon(env.dir, 'win', clockC);
    const pc = page(memStorage(), C, clockC);
    await pc.store.refresh();
    pc.load().sync(BOTH);
    await settle();
    assert.equal(C.puts.length, 0, 'C\'s defaults are not uploaded');
    assert.deepEqual(A.store.adopt(C.store.snapshot()), [], 'A keeps its dock');
    assert.deepEqual(A.store.get(KEY), stamp);
    // C's daemon pulls from A; its open page gets the ui-layout event and shows Sir's dock.
    C.store.onChange((key, entry) => pc.store.receive({ key, ...entry }));
    assert.deepEqual(C.store.adopt(A.store.snapshot()), [KEY]);
    pc.sync(BOTH);
    assert.deepEqual(essence(pc.dock), want, 'C\'s page now shows the saved dock');
    // Sir moves the dock to the right on C, on purpose: that change goes to the mesh.
    clockC.t += 1000;
    pc.act((s) => S.setPosition(s, 'right'));
    await settle();
    assert.equal(C.puts.length, 1);
    assert.deepEqual(A.store.adopt(C.store.snapshot()), [KEY]);
    const onA = S.deserialize(A.store.get(KEY).value);
    assert.equal(onA.settings.position, 'right');
    assert.deepEqual(essence({ ...onA, settings: { ...onA.settings, position: 'left' } }), want, 'only what Sir changed');
  } finally { env.done(); }
});

test('older dock payloads (v0, v1) migrate with their settings, pins, hidden items, groups and order intact', () => {
  const settings = { position: 'right', autoHide: true, magnification: false, magnifyStrength: 0.3, autoDock: true, autoTabTerminals: true };
  const items = {
    'applet:mac/krea': { id: 'applet:mac/krea', kind: 'applet', title: 'Krea', pinned: true },
    'rig:lin': { id: 'rig:lin', kind: 'rig', title: 'lin', hidden: true },
    'rig:mac': { id: 'rig:mac', kind: 'rig', title: 'mac' },
  };
  const v1 = { v: 1, nextGroup: 2, settings, items, groups: { g1: { id: 'g1', name: 'Boxes', items: ['rig:mac', 'rig:lin'] } }, order: [{ type: 'group', id: 'g1' }, { type: 'item', id: 'applet:mac/krea' }] };
  const v0 = { ...settings, items: Object.values(items), groups: [{ id: 'g1', name: 'Boxes', items: ['rig:mac', 'rig:lin'] }] };
  for (const [name, raw] of [['v1', v1], ['v0', v0]]) {
    const s = S.deserialize(JSON.stringify(raw));
    assert.equal(s.v, S.VERSION, name);
    assert.deepEqual(s.settings, { ...settings, autoGroup: true }, `${name}: every stored setting kept, the new one at its default`);
    assert.equal(s.items['applet:mac/krea'].pinned, true, name);
    assert.equal(s.items['rig:lin'].hidden, true, name);
    assert.deepEqual(s.groups.g1.items, ['rig:mac', 'rig:lin'], name);
    // the update's new tools join their default groups; nothing that was there moves
    const merged = S.mergeSources(s, { tools: S.TOOLS, applets: [{ node: 'mac', id: 'krea', name: 'Krea' }], rigs: [rig('mac'), rig('lin')] });
    assert.deepEqual(merged.settings, s.settings, `${name}: settings untouched by the merge`);
    assert.deepEqual(merged.groups.g1.items, ['rig:mac', 'rig:lin'], name);
    if (name === 'v1') assert.deepEqual(merged.order.slice(0, 2), [{ type: 'group', id: 'g1' }, { type: 'item', id: 'applet:mac/krea' }], 'v1 order kept in front');
  }
  // and through a reload: a v1 dock in the cache is taken as it is (it is the user's), not replaced by defaults
  const local = memStorage({ [KEY]: JSON.stringify(v1) });
  assert.deepEqual(S.deserialize(local.getItem(KEY)).settings.position, 'right');
});
