// Automatic cleanups for a JARVIS tab that stays open for days: caps for every client-side store that grows with
// time, a disposer that undoes what a window or panel hooked up, and an idle-time sweep that prunes stale caches.
// Pure (no DOM globals; timers and the idle callback are injectable), unit-tested in test/cleanup.test.js.

/** How much each store keeps. Oldest first out. */
export const CAPS = {
  traceSpans: 1500, // spans in one trace explorer (all-activity keeps the latest requests on top of this)
  traceRequests: 40, // requests in the all-activity explorer
  toasts: 6, // toasts on screen at once
  dismissed: 300, // "closed for good" message keys (toasts.js)
  chatMessages: 300, // messages kept in a conversation window's list
  transcriptLines: 2000, // lines rendered in a transcript / session view
  terminalScrollback: 5000, // xterm scrollback rows per terminal
  popups: 500, // session keys the auto-open popups remember (a forgotten one could pop up again)
  popupWindows: 4, // auto-opened agent terminals on screen at once: the oldest one nobody is typing in closes
  freshIds: 500, // ids remembered by "materialise" highlighting per list
};

/** Keep only the last `max` items of `arr` (in place). Returns how many were dropped. */
export function capArray(arr, max) {
  const over = arr.length - Math.max(0, max);
  if (over > 0) arr.splice(0, over);
  return Math.max(0, over);
}

/** Append `item`, dropping the oldest past `max` (a ring buffer over a plain array). Returns arr. */
export function ringPush(arr, item, max) {
  arr.push(item);
  capArray(arr, max);
  return arr;
}

/** Keep only the `max` newest entries of a Map or Set (insertion order = age; re-insert to refresh). Returns dropped count. */
export function capMap(map, max) {
  let over = map.size - Math.max(0, max);
  if (over <= 0) return 0;
  const dropped = over;
  for (const k of map.keys()) { if (over-- <= 0) break; map.delete(k); }
  return dropped;
}

/**
 * Delete entries older than `maxAgeMs` from a Map (value → time via `at`, default v.at ?? v.updatedAt ?? v.t) unless
 * `keep(value, key)` says otherwise (e.g. still on screen). Returns the number deleted.
 */
export function pruneByAge(map, { now = Date.now(), maxAgeMs, at = (v) => v?.at ?? v?.updatedAt ?? v?.t, keep = () => false }) {
  let n = 0;
  for (const [k, v] of map) {
    const t = at(v, k);
    if (typeof t === 'number' && now - t > maxAgeMs && !keep(v, k)) { map.delete(k); n++; }
  }
  return n;
}

/** Remove the oldest children of a DOM-like element past `max` (anything with .children and child.remove()). */
export function capChildren(el, max) {
  let n = 0;
  while (el && el.children.length > Math.max(0, max)) { el.children[0].remove(); n++; }
  return n;
}

/**
 * Everything a window or panel hooks up, undone in one call. `listen(target, type, fn, opts)`, `interval(fn, ms)`,
 * `timeout(fn, ms)`, `add(fn)` (any cleanup: ws.close, term.dispose, observer.disconnect…), then `dispose()` — runs
 * every cleanup once, newest first, and keeps going when one throws. Later adds after dispose run at once.
 */
export function createDisposer({ setInterval: si = globalThis.setInterval, clearInterval: ci = globalThis.clearInterval, setTimeout: st = globalThis.setTimeout, clearTimeout: ct = globalThis.clearTimeout } = {}) {
  let fns = [];
  let done = false;
  const d = {
    get disposed() { return done; },
    get size() { return fns.length; },
    add(fn) {
      if (typeof fn !== 'function') return fn;
      if (done) { try { fn(); } catch {} return fn; }
      fns.push(fn);
      return fn;
    },
    listen(target, type, fn, opts) {
      if (!target?.addEventListener) return () => {};
      target.addEventListener(type, fn, opts);
      return d.add(() => target.removeEventListener(type, fn, opts));
    },
    interval(fn, ms) { const id = si(fn, ms); d.add(() => ci(id)); return id; },
    timeout(fn, ms) { const id = st(fn, ms); d.add(() => ct(id)); return id; },
    dispose() {
      if (done) return;
      done = true;
      const list = fns;
      fns = [];
      for (let i = list.length - 1; i >= 0; i--) { try { list[i](); } catch {} }
    },
  };
  return d;
}

/**
 * A periodic sweep that runs when the browser is idle: every `everyMs` (default 3 min) it waits for an idle moment
 * (requestIdleCallback, at most `idleTimeoutMs` later; setTimeout where there is none) and runs every registered task.
 * `add(name, fn)` → unregister. A task returns a number (what it pruned) or nothing; `stats` keeps the last run.
 */
export function createSweeper({
  everyMs = 180000, idleTimeoutMs = 10000, now = () => Date.now(),
  setTimeout: st = globalThis.setTimeout, clearTimeout: ct = globalThis.clearTimeout,
  requestIdleCallback: ric = globalThis.requestIdleCallback, cancelIdleCallback: cic = globalThis.cancelIdleCallback,
} = {}) {
  const tasks = new Map();
  let timer = null;
  let idle = null;
  let running = false;
  const stats = { runs: 0, last: null, lastAt: 0, totals: {} };
  function run() {
    idle = null;
    const pruned = {};
    for (const [name, fn] of tasks) {
      try {
        const r = fn();
        pruned[name] = typeof r === 'number' ? r : 0;
        stats.totals[name] = (stats.totals[name] || 0) + pruned[name];
      } catch (e) { pruned[name] = `error: ${e?.message || e}`; }
    }
    stats.runs++;
    stats.last = pruned;
    stats.lastAt = now();
    return pruned;
  }
  function schedule() {
    if (!running) return;
    timer = st(() => {
      timer = null;
      if (ric) idle = ric(() => { run(); schedule(); }, { timeout: idleTimeoutMs });
      else { run(); schedule(); }
    }, everyMs);
  }
  return {
    stats,
    add(name, fn) { tasks.set(name, fn); return () => tasks.delete(name); },
    has: (name) => tasks.has(name),
    run,
    start() { if (running) return; running = true; schedule(); },
    stop() { running = false; if (timer != null) ct(timer); timer = null; if (idle != null && cic) cic(idle); idle = null; },
    get running() { return running; },
  };
}
