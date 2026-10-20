// Web UI automatic cleanups (ui/src/cleanup.js): caps, ring buffer, prune policy, disposer, idle sweeper. Pure, no DOM.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAPS, capArray, capChildren, capMap, createDisposer, createSweeper, pruneByAge, ringPush } from '../ui/src/cleanup.js';
import { createPopups } from '../ui/src/popups.js';

test('capArray keeps the newest items in place and reports what it dropped', () => {
  const a = [1, 2, 3, 4, 5];
  assert.equal(capArray(a, 3), 2);
  assert.deepEqual(a, [3, 4, 5]);
  assert.equal(capArray(a, 10), 0);
  assert.deepEqual(a, [3, 4, 5]);
  assert.equal(capArray(a, 0), 3);
  assert.deepEqual(a, []);
});

test('ringPush is a ring buffer over a plain array', () => {
  const r = [];
  for (let i = 0; i < 10; i++) ringPush(r, i, 4);
  assert.deepEqual(r, [6, 7, 8, 9]);
});

test('capMap drops the oldest entries of a Map or Set (insertion order); re-inserting refreshes', () => {
  const m = new Map([['a', 1], ['b', 2], ['c', 3]]);
  m.delete('a'); m.set('a', 1); // a is now the newest
  assert.equal(capMap(m, 2), 1);
  assert.deepEqual([...m.keys()], ['c', 'a']);
  const s = new Set(['x', 'y', 'z']);
  capMap(s, 1);
  assert.deepEqual([...s], ['z']);
  assert.equal(capMap(s, 5), 0);
});

test('pruneByAge deletes stale entries unless keep() says otherwise', () => {
  const m = new Map([['old', { at: 0 }], ['open', { at: 0, open: true }], ['new', { at: 9000 }], ['untimed', {}]]);
  assert.equal(pruneByAge(m, { now: 10000, maxAgeMs: 5000, keep: (v) => v.open }), 1);
  assert.deepEqual([...m.keys()], ['open', 'new', 'untimed']);
  const t = new Map([['k', 5]]);
  assert.equal(pruneByAge(t, { now: 100, maxAgeMs: 10, at: (v) => v }), 1);
});

test('capChildren removes the oldest children of an element-like list', () => {
  const kids = [];
  const el = { children: kids };
  for (let i = 0; i < 5; i++) { const c = { i, remove() { kids.splice(kids.indexOf(c), 1); } }; kids.push(c); }
  assert.equal(capChildren(el, 2), 3);
  assert.deepEqual(kids.map((c) => c.i), [3, 4]);
});

test('createDisposer undoes listeners, timers and cleanups once, newest first, past a throwing one', () => {
  const log = [];
  const timers = new Map();
  let next = 1;
  const d = createDisposer({
    setInterval: (fn, ms) => { const id = next++; timers.set(id, ms); return id; }, clearInterval: (id) => { log.push(`ci${id}`); timers.delete(id); },
    setTimeout: (fn, ms) => { const id = next++; timers.set(id, ms); return id; }, clearTimeout: (id) => { log.push(`ct${id}`); timers.delete(id); },
  });
  const target = { on: new Set(), addEventListener(t, fn) { this.on.add(fn); }, removeEventListener(t, fn) { this.on.delete(fn); log.push('off'); } };
  const fn = () => {};
  d.listen(target, 'resize', fn);
  d.interval(() => {}, 1000);
  d.timeout(() => {}, 500);
  d.add(() => { throw new Error('boom'); });
  d.add(() => log.push('ws.close'));
  assert.equal(target.on.size, 1);
  assert.equal(timers.size, 2);
  d.dispose();
  d.dispose(); // idempotent
  assert.deepEqual(log, ['ws.close', 'ct2', 'ci1', 'off']);
  assert.equal(target.on.size, 0);
  assert.equal(timers.size, 0);
  assert.ok(d.disposed);
  d.add(() => log.push('late')); // added after dispose: runs at once
  assert.equal(log.at(-1), 'late');
  assert.doesNotThrow(() => d.listen(null, 'x', fn));
});

test('createSweeper runs its tasks when idle, every period, and keeps stats', () => {
  const timers = [];
  const idles = [];
  const sw = createSweeper({
    everyMs: 1000, now: () => 42,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {},
    requestIdleCallback: (fn, o) => { idles.push({ fn, o }); return idles.length; }, cancelIdleCallback: () => {},
  });
  const cache = new Map([[1, 1], [2, 2], [3, 3]]);
  const off = sw.add('cache', () => capMap(cache, 1));
  sw.add('broken', () => { throw new Error('nope'); });
  sw.add('void', () => {});
  sw.start();
  sw.start(); // once
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1000);
  timers[0].fn(); // the period elapsed → wait for idle
  assert.equal(idles.length, 1);
  assert.equal(idles[0].o.timeout, 10000);
  idles[0].fn();
  assert.deepEqual(sw.stats.last, { cache: 2, broken: 'error: nope', void: 0 });
  assert.equal(sw.stats.runs, 1);
  assert.equal(sw.stats.lastAt, 42);
  assert.equal(cache.size, 1);
  assert.equal(timers.length, 2, 'the next period is scheduled after the run');
  off();
  assert.equal(sw.has('cache'), false);
  sw.stop();
  assert.equal(sw.running, false);
});

test('createSweeper falls back to plain timers without requestIdleCallback', () => {
  const timers = [];
  const sw = createSweeper({ everyMs: 5, setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {}, requestIdleCallback: null });
  let n = 0;
  sw.add('n', () => ++n);
  sw.start();
  timers[0]();
  assert.equal(n, 1);
  assert.equal(sw.stats.totals.n, 1);
});

test('caps are set for every store the UI bounds', () => {
  for (const k of ['traceSpans', 'traceRequests', 'toasts', 'dismissed', 'chatMessages', 'terminalScrollback', 'popups', 'popupWindows']) assert.ok(CAPS[k] > 0, k);
  assert.ok(CAPS.terminalScrollback <= 5000, 'xterm scrollback is the biggest per-window store');
});

test('session popups remember at most CAPS.popups keys (oldest forgotten first)', () => {
  const p = createPopups({ open: () => {}, schedule: () => {} });
  for (let i = 0; i < CAPS.popups + 10; i++) p.mark('n', 'tmux', `s${i}`);
  assert.equal(p.has('n', 'tmux', 's0'), false);
  assert.equal(p.has('n', 'tmux', `s${CAPS.popups + 9}`), true);
  p.mark('n', 'tmux', 's10'); // re-marking refreshes it
  for (let i = 0; i < 5; i++) p.mark('n', 'tmux', `t${i}`);
  assert.equal(p.has('n', 'tmux', 's10'), true);
});

test('UI wiring: windows dispose their hooks on every close path, terminals cap scrollback, stores are capped', async () => {
  const fs = await import('node:fs');
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const wm = read('ui/src/wm.js');
  assert.match(wm, /const bin = createDisposer\(\)/);
  assert.match(wm, /bin\.dispose\(\);/);
  assert.match(wm, /onCleanup: \(fn\) => bin\.add\(fn\)/);
  const term = read('ui/src/terminal.js');
  assert.match(term, /scrollback: CAPS\.terminalScrollback/);
  assert.match(term, /if \(closed\) return; \/\/ closed while a reconnect was pending/);
  const main = read('ui/src/main.js');
  assert.doesNotMatch(main, /querySelector\('\.win-btn\.close'\)\.addEventListener\('click', \(\) => clearInterval/, 'timers are not cleared only by the ✕ click');
  assert.doesNotMatch(read('ui/src/mesh.js'), /\.win-btn\.close'\)\.addEventListener/);
  assert.match(main, /createSweeper\(/);
  assert.match(main, /sweeper\.start\(\)/);
  const tp = read('ui/src/trace-panel.js');
  assert.match(tp, /capArray\(S\.spans, CAPS\.traceSpans\)/);
  assert.match(tp, /forceContextLoss\(\)/);
  assert.match(tp, /if \(ex\.handle\) \{ ex\.handle\.raise\(\); return ex\.handle; \}/, 'one explorer per trace');
  assert.match(read('ui/src/face.js'), /renderer\.forceContextLoss\(\)/);
});
