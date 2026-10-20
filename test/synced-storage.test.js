// Daemon-backed storage for the dock layout and app dock (ui/src/synced-storage-model.js): boot reconcile, one-time
// migration, debounced PUTs, live remote values without echo, deferral during a drag, read-only keys (phones),
// keys the daemon refuses, and the app dock's page-local tiles (open-events.js withoutTransient / keepTransient).
// No browser: fake localStorage, fake transport, manual timers.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const M = await import('../ui/src/synced-storage-model.js');
const E = await import('../ui/src/open-events.js');
const S = await import('../ui/src/app-dock-state.js');

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}

/** A daemon like src/uilayout.js: per-key { value, rev, by }, PUT stamps with `name`. */
function fakeDaemon({ keys = {}, name = 'B', whitelist = null, getStatus = 0 } = {}) {
  const d = { keys: structuredClone(keys), puts: [], gets: 0, rev: 1000, down: false };
  d.transport = {
    async get() {
      d.gets++;
      if (d.down) throw new Error('offline');
      if (getStatus) throw Object.assign(new Error(`HTTP ${getStatus}`), { status: getStatus });
      return { keys: structuredClone(d.keys) };
    },
    async put(key, value) {
      if (d.down) throw new Error('offline');
      if (whitelist && !whitelist.includes(key)) throw Object.assign(new Error('unknown key'), { status: 400 });
      d.puts.push({ key, value: structuredClone(value) });
      d.rev = Math.max(d.rev + 1, (d.keys[key]?.rev || 0) + 1);
      d.keys[key] = { value: structuredClone(value), rev: d.rev, by: name };
      return { key, rev: d.rev, by: name };
    },
  };
  return d;
}

function timers() {
  let t = 0;
  let seq = 0;
  const q = new Map();
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; q.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => q.delete(id),
    /** Advance the clock, running due timers (and letting their promises settle). */
    async tick(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...q.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        q.delete(due[0]);
        t = Math.max(t, due[1].at);
        due[1].fn();
        await settle();
      }
      t = end;
      await settle();
    },
  };
}

function make({ local = memStorage(), daemon = fakeDaemon(), clock = timers(), ...o } = {}) {
  const s = M.createSyncedStorage({ local, transport: daemon.transport, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...o });
  return { s, local, daemon, clock };
}

const layoutA = { root: { type: 'panel', id: 'stage' }, floating: [{ id: 'work', x: 10, y: 20, w: 300, h: 200, vw: 1280, vh: 800 }], v: 1 };
const layoutB = { root: { type: 'panel', id: 'stage' }, floating: [{ id: 'work', x: 600, y: 40, w: 300, h: 200, vw: 1280, vh: 800 }], v: 1 };

test('encode / decode keep JSON values and plain strings', () => {
  assert.deepEqual(M.encode('{"a":1}'), { a: 1 });
  assert.equal(M.encode('1'), 1);
  assert.equal(M.decode(1), '1');
  assert.equal(M.encode('not json'), 'not json');
  assert.equal(M.decode('not json'), 'not json');
  assert.equal(M.encode(null), null);
  assert.equal(M.decode(M.encode(JSON.stringify(layoutA))), JSON.stringify(layoutA));
  assert.ok(M.isNewer({ rev: 2, by: 'a' }, { rev: 1, by: 'z' }));
  assert.ok(M.isNewer({ rev: 2, by: 'b' }, { rev: 2, by: 'a' }), 'a tie goes to the machine name, like the daemon');
  assert.ok(!M.isNewer({ rev: 2, by: 'a' }, { rev: 2, by: 'a' }));
});

test('boot takes the daemon value when its stamp is newer than the cached one, also with cleared storage', async () => {
  const daemon = fakeDaemon({ keys: { 'rigs.dock': { value: layoutB, rev: 5000, by: 'A' } } });
  const local = memStorage({ 'rigs.dock': JSON.stringify(layoutA), 'rigs.sync': JSON.stringify({ 'rigs.dock': { rev: 4000, by: 'B' } }) });
  const { s } = make({ local, daemon });
  const heard = [];
  s.onRemote((k, raw) => heard.push([k, JSON.parse(raw)]));
  assert.equal(await s.refresh(), true);
  assert.deepEqual(JSON.parse(local.getItem('rigs.dock')), layoutB);
  assert.deepEqual(heard, [['rigs.dock', layoutB]]);
  assert.deepEqual(JSON.parse(local.getItem('rigs.sync'))['rigs.dock'], { rev: 5000, by: 'A' });
  assert.equal(daemon.puts.length, 0, 'taking the daemon value sends nothing back');

  const fresh = memStorage(); // cleared storage: the daemon's value is the layout
  const r = make({ local: fresh, daemon });
  await r.s.refresh();
  assert.deepEqual(JSON.parse(fresh.getItem('rigs.dock')), layoutB);
  assert.equal(r.s.status().state, 'synced');
  assert.equal(r.s.status().last.by, 'A');
});

test('a localStorage-only layout is uploaded once when the daemon has none (no layout lost)', async () => {
  const local = memStorage({ 'rigs.dock': JSON.stringify(layoutA), 'rigs.appdock': '{"v":2,"items":{}}' });
  const { s, daemon, clock } = make({ local });
  await s.refresh();
  // Keys read after boot (the engines read them on attach) are compared then; a never-synced cache value goes up.
  s.getItem('rigs.dock');
  s.getItem('rigs.appdock');
  s.getItem('rigs.docking'); // nothing stored: nothing to send
  await clock.tick(600);
  assert.deepEqual(daemon.puts.map((p) => p.key).sort(), ['rigs.appdock', 'rigs.dock']);
  assert.deepEqual(daemon.keys['rigs.dock'].value, layoutA);
  s.getItem('rigs.dock');
  await s.refresh(); // a second boot finds the same value: nothing more to send
  await clock.tick(600);
  assert.equal(daemon.puts.length, 2);
});

test('keys read before the daemon answered are still migrated', async () => {
  const local = memStorage({ 'rigs.scaling': '1' });
  const { s, daemon, clock } = make({ local });
  assert.equal(s.getItem('rigs.scaling'), '1'); // scaling.js reads at module load
  await s.refresh();
  await clock.tick(600);
  assert.deepEqual(daemon.puts, [{ key: 'rigs.scaling', value: 1 }]);
});

test('writes are debounced: a drag sends one PUT with the last value, an unchanged value none', async () => {
  const { s, daemon, clock, local } = make();
  await s.refresh();
  for (let x = 0; x < 30; x++) { s.setItem('rigs.dock', JSON.stringify({ ...layoutA, x })); await clock.tick(16); }
  assert.equal(daemon.puts.length, 0, 'nothing sent while the changes keep coming');
  assert.equal(JSON.parse(local.getItem('rigs.dock')).x, 29, 'the cache has every change at once');
  await clock.tick(500);
  assert.equal(daemon.puts.length, 1);
  assert.equal(daemon.puts[0].value.x, 29);
  s.setItem('rigs.dock', JSON.stringify({ ...layoutA, x: 29 })); // the same value again (an engine re-persisting)
  await clock.tick(600);
  assert.equal(daemon.puts.length, 1);
  assert.equal(s.status().state, 'synced');
});

test('a value from another machine is applied once; our own change coming back never echoes', async () => {
  const { s, daemon, clock, local } = make();
  await s.refresh();
  const heard = [];
  s.onRemote((k, raw) => { heard.push(k); s.setItem(k, raw); }); // an engine reloading re-persists the same value
  s.setItem('rigs.dock', JSON.stringify(layoutA));
  await clock.tick(600);
  const mine = daemon.keys['rigs.dock'];
  assert.equal(s.receive({ type: 'ui-layout', key: 'rigs.dock', ...mine }), false, 'our own PUT broadcast back');
  assert.deepEqual(heard, []);

  assert.equal(s.receive({ key: 'rigs.dock', value: layoutB, rev: mine.rev + 10, by: 'A' }), true);
  assert.deepEqual(JSON.parse(local.getItem('rigs.dock')), layoutB);
  assert.deepEqual(heard, ['rigs.dock']);
  await clock.tick(600);
  assert.equal(daemon.puts.length, 1, 'applying it sent nothing back');
  assert.equal(s.receive({ key: 'rigs.dock', value: layoutA, rev: mine.rev + 5, by: 'C' }), false, 'an older stamp is ignored');
  assert.deepEqual(JSON.parse(local.getItem('rigs.dock')), layoutB);
});

test('our event can arrive before the PUT answers: the same value only records the stamp', async () => {
  const { s, daemon, clock } = make();
  await s.refresh();
  let release;
  const slow = new Promise((r) => { release = r; });
  const put = daemon.transport.put;
  daemon.transport.put = async (k, v) => { const r = await put(k, v); await slow; return r; };
  const heard = [];
  s.onRemote((k) => heard.push(k));
  s.setItem('rigs.appdock', '{"v":2,"n":1}');
  await clock.tick(600);
  assert.equal(s.receive({ key: 'rigs.appdock', ...daemon.keys['rigs.appdock'] }), false);
  release();
  await clock.tick(10);
  assert.deepEqual(heard, []);
  assert.equal(daemon.puts.length, 1);
});

test('a pending change here wins over a remote value that arrives before it is sent', async () => {
  const { s, daemon, clock, local } = make();
  await s.refresh();
  s.setItem('rigs.dock', JSON.stringify(layoutA));
  assert.equal(s.receive({ key: 'rigs.dock', value: layoutB, rev: 99999, by: 'A' }), false);
  assert.deepEqual(JSON.parse(local.getItem('rigs.dock')), layoutA);
  await clock.tick(600);
  assert.deepEqual(daemon.keys['rigs.dock'].value, layoutA, 'the newer local action is what the mesh gets');
});

test('during a drag a remote value waits for the release, and a drop made meanwhile keeps the local layout', async () => {
  let held = true;
  const { s, daemon, clock, local } = make({ busy: () => held });
  await s.refresh();
  const heard = [];
  s.onRemote((k) => heard.push(k));
  local.setItem('rigs.dock', JSON.stringify(layoutA));
  s.receive({ key: 'rigs.dock', value: layoutB, rev: 2000, by: 'A' });
  assert.deepEqual(heard, [], 'nothing applied under the pointer');
  assert.deepEqual(JSON.parse(local.getItem('rigs.dock')), layoutA);
  assert.ok(s.hasPending());
  held = false;
  s.resume();
  assert.deepEqual(heard, ['rigs.dock']);
  assert.deepEqual(JSON.parse(local.getItem('rigs.dock')), layoutB);

  held = true; // a second drag that ends in a drop
  s.receive({ key: 'rigs.dock', value: { ...layoutB, z: 1 }, rev: 3000, by: 'A' });
  s.setItem('rigs.dock', JSON.stringify({ ...layoutA, dropped: true }));
  held = false;
  s.resume();
  assert.equal(heard.length, 1, 'the remote value from during the drag is dropped');
  await clock.tick(600);
  assert.equal(daemon.keys['rigs.dock'].value.dropped, true);
});

test('a read-only key (the panel layout on a phone) is read but never written back', async () => {
  const phone = () => true;
  const daemon = fakeDaemon({ keys: { 'rigs.dock': { value: layoutB, rev: 5000, by: 'A' } } });
  const local = memStorage({ 'rigs.dock': JSON.stringify(layoutA) });
  const { s, clock } = make({ local, daemon, readOnly: (k) => k === 'rigs.dock' && phone() });
  await s.refresh();
  assert.deepEqual(JSON.parse(local.getItem('rigs.dock')), layoutB, 'the phone reads the synced layout');
  s.setItem('rigs.dock', JSON.stringify(layoutA));
  s.setItem('rigs.appdock', '{"v":2}');
  await clock.tick(600);
  assert.deepEqual(daemon.puts.map((p) => p.key), ['rigs.appdock'], 'the app dock still syncs from a phone');
  assert.equal(s.isSynced('rigs.dock'), false);
  assert.equal(s.receive({ key: 'rigs.dock', value: layoutB, rev: 6000, by: 'A' }), true, 'live updates still arrive');

  const fresh = make({ local: memStorage({ 'rigs.dock': JSON.stringify(layoutA) }), readOnly: (k) => k === 'rigs.dock' && phone() });
  await fresh.s.refresh();
  fresh.s.getItem('rigs.dock');
  await fresh.clock.tick(600);
  assert.equal(fresh.daemon.puts.length, 0, 'a phone never migrates a panel layout either');
});

test('a key the daemon refuses stays local: no retries, others keep syncing (key-agnostic)', async () => {
  const daemon = fakeDaemon({ whitelist: ['rigs.dock'] });
  const { s, clock } = make({ daemon });
  await s.refresh();
  s.setItem('rigs.windows', '{"w":1}');
  s.setItem('rigs.dock', JSON.stringify(layoutA));
  await clock.tick(600);
  assert.deepEqual(daemon.puts.map((p) => p.key), ['rigs.dock']);
  assert.equal(s.isSynced('rigs.windows'), false);
  s.setItem('rigs.windows', '{"w":2}');
  await clock.tick(6000);
  assert.deepEqual(daemon.puts.map((p) => p.key), ['rigs.dock']);
  // Once the daemon whitelists it, a new page syncs it with no change here.
  const d2 = fakeDaemon();
  const r = make({ daemon: d2, local: memStorage({ 'rigs.windows': '{"w":2}' }) });
  await r.s.refresh();
  r.s.getItem('rigs.windows');
  await r.clock.tick(600);
  assert.deepEqual(d2.puts, [{ key: 'rigs.windows', value: { w: 2 } }]);
});

test('an old daemon without the endpoint leaves plain localStorage', async () => {
  const { s, daemon, clock, local } = make({ daemon: fakeDaemon({ getStatus: 404 }) });
  assert.equal(await s.refresh(), false);
  s.setItem('rigs.dock', JSON.stringify(layoutA));
  await clock.tick(10000);
  assert.equal(daemon.puts.length, 0);
  assert.deepEqual(JSON.parse(local.getItem('rigs.dock')), layoutA);
  assert.equal(s.status().state, 'local');
  assert.equal(s.receive({ key: 'rigs.dock', value: layoutB, rev: 1, by: 'A' }), false);
});

test('defaults written before the daemon answered never overwrite the mesh layout', async () => {
  const daemon = fakeDaemon({ keys: { 'rigs.dock': { value: layoutB, rev: 5000, by: 'A' } } });
  const clock = timers();
  await clock.tick(100000); // the page's clock is well past the daemon's stamp
  const { s, local } = make({ daemon, clock, local: memStorage() });
  s.setItem('rigs.dock', JSON.stringify(layoutA)); // dockManager.attach persisting its defaults (boot timed out)
  await clock.tick(600);
  assert.equal(daemon.puts.length, 0, 'nothing is sent before the first refresh');
  await s.refresh();
  await clock.tick(600);
  assert.deepEqual(JSON.parse(local.getItem('rigs.dock')), layoutB);
  assert.equal(daemon.puts.length, 0);
});

test('an edit left unsent by an earlier session goes up when it is newer than the daemon value; offline retries', async () => {
  const daemon = fakeDaemon({ keys: { 'rigs.appdock': { value: { v: 2, old: true }, rev: 5000, by: 'A' } } });
  const clock = timers();
  await clock.tick(9000);
  const local = memStorage({ 'rigs.appdock': '{"v":2,"mine":true}', 'rigs.sync': JSON.stringify({ 'rigs.appdock': { rev: 5000, by: 'A', dirty: 8000 } }) });
  const { s } = make({ daemon, clock, local });
  await s.refresh();
  await clock.tick(600);
  assert.deepEqual(daemon.keys['rigs.appdock'].value, { v: 2, mine: true });

  daemon.down = true;
  s.setItem('rigs.appdock', '{"v":2,"later":true}');
  await clock.tick(600);
  assert.equal(s.status().state, 'offline');
  daemon.down = false;
  await clock.tick(5000);
  assert.deepEqual(daemon.keys['rigs.appdock'].value, { v: 2, later: true });
  assert.equal(s.status().state, 'synced');
});

test('prepare changes what is synced, not the cache, and equality uses it', async () => {
  const strip = (v) => (v && v.floating ? { ...v, floating: v.floating.filter((f) => !f.id.startsWith('win-')) } : v);
  const { s, daemon, clock, local } = make({ prepare: (k, v) => (k === 'rigs.dock' ? strip(v) : v) });
  await s.refresh();
  const withWin = { ...layoutA, floating: [...layoutA.floating, { id: 'win-3', x: 1, y: 1, w: 50, h: 50 }] };
  s.setItem('rigs.dock', JSON.stringify(withWin));
  await clock.tick(600);
  assert.deepEqual(daemon.puts[0].value, layoutA, 'the window stays on this page');
  assert.equal(JSON.parse(local.getItem('rigs.dock')).floating.length, 2);
  s.setItem('rigs.dock', JSON.stringify({ ...withWin, floating: [...layoutA.floating, { id: 'win-4', x: 9, y: 9, w: 50, h: 50 }] }));
  await clock.tick(600);
  assert.equal(daemon.puts.length, 1, 'only a window changed: nothing to sync');
});

test('the app dock shares no window / terminal tiles, and keeps this page\'s own on a remote update', () => {
  let s = S.mergeSources(S.setSettings(S.emptyState(), { autoGroup: false }), { applets: [{ node: 'mac', id: 'krea', name: 'Krea', icon: '▣' }] });
  s = S.addItem(s, S.toItem('terminal', { id: 'pty-1', title: 'zsh' }));
  s = S.addItem(s, S.toItem('window', { id: 'win-2', title: 'Notes' }));
  const shared = E.withoutTransient(s);
  assert.deepEqual(Object.values(shared.items).map((it) => it.kind), ['applet']);
  assert.equal(E.withoutTransient(shared), shared, 'nothing to strip: the same object (no re-serialising)');

  // Another machine added a rig in front; its dock arrives without tiles of ours (and a stray one of theirs is dropped).
  let remote = S.addItem(shared, S.toItem('rig', { id: 'linux', name: 'linux', online: true, rigs: true }), { index: 0 });
  remote = S.addItem(remote, S.toItem('terminal', { id: 'pty-9', title: 'theirs' }));
  const merged = E.keepTransient(remote, s);
  const kinds = Object.values(merged.items).map((it) => `${it.kind}:${it.title}`).sort();
  assert.deepEqual(kinds, ['applet:Krea', 'rig:linux', 'terminal:zsh', 'window:Notes']);
  assert.equal(merged.order[0].id, S.itemId('rig', 'linux'), 'their order is kept');
});

test('Dock settings ends with the mesh sync line and Reset layout for all machines', async () => {
  const D = await import('../ui/src/app-dock-model.js');
  let reset = 0;
  const sync = (state, by = 'dock-A') => ({ status: () => ({ state, last: by ? { key: 'rigs.dock', rev: 1, by } : null }), resetAll: () => { reset++; } });
  const entries = D.settingsEntries(S.emptyState(), (f) => f, { sync: sync('synced') });
  const tail = entries.slice(-2);
  assert.deepEqual(tail.map((e) => [e.label, !!e.disabled, e.hint || '']), [['Synced across the mesh', true, 'last change: dock-A'], ['Reset layout for all machines', false, '']]);
  tail[1].run();
  assert.equal(reset, 1);
  assert.equal(D.syncEntries(sync('offline'))[1].label, 'Mesh sync paused');
  assert.equal(D.syncEntries(sync('local'))[2].disabled, true, 'nothing to reset across the mesh without the daemon endpoint');
  const phone = D.syncEntries(sync('synced'), { phone: true });
  assert.equal(phone[1].hint, 'panel layout read-only on phones');
  assert.equal(phone[2].disabled, true, 'a phone never writes the panel layout');
  assert.deepEqual(D.syncEntries(null), [], 'no sync wiring (tests, older callers): no entries');
  assert.ok(!D.settingsEntries(S.emptyState(), (f) => f).some((e) => /mesh/.test(e.label || '')));
});
