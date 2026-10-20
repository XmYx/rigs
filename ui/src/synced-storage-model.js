// Daemon-backed storage for the dock layout and the app dock (pure part, no DOM; tested in test/synced-storage.test.js).
// It has the getItem/setItem shape dockManager.attach({ storage }) and createAppDock({ storage }) already take, so the
// engines do not change: localStorage stays the instant cache, and every key that goes through here is also kept on
// the daemon (GET/PUT /api/local/ui-layout, src/uilayout.js), which syncs it across the mesh.
//
//   boot        refresh() reads the daemon's { keys }: a key whose stamp is newer than the one cached here is taken
//               (written to the cache, listeners told); a key the daemon does not have yet is uploaded from the cache
//               once (the migration that keeps a localStorage-only layout).
//   writes      setItem writes the cache at once and sends a PUT `debounceMs` after the last change (a drag is not
//               sent every frame). An unchanged value (same JSON as the daemon's) is not sent.
//   events      receive({ key, value, rev, by }) from the `ui-layout` WebSocket event: a newer value from elsewhere
//               is applied; our own change coming back (same value) only records its stamp, so nothing echoes.
//               While `busy()` (a pointer is held: a drag) it waits for resume(); a key changed here in the meantime
//               keeps the local change (it is the newest action, and its PUT wins on the daemon).
//   read-only   readOnly(key) keeps a key local (phones never write the docked panel layout back).
//   prepare     prepare(key, value) turns a cached value into what is synced (docking.js drops this page's windows).
//
// Key-agnostic: a key the daemon refuses (400: not whitelisted) simply stays local for this session, so a new
// persisted key only needs adding to the daemon's whitelist (uilayout.js KEYS) to start syncing.

/** Same ordering as the daemon (globalbrain.js isNewer): higher rev wins, then the machine name breaks a tie. */
export function isNewer(a, b) {
  const x = { rev: Number(a?.rev) || 0, by: String(a?.by || '') };
  const y = { rev: Number(b?.rev) || 0, by: String(b?.by || '') };
  return x.rev !== y.rev ? x.rev > y.rev : x.by > y.by;
}

/** Cached string → the JSON value the daemon keeps (a string that is not JSON stays a string). */
export function encode(raw) {
  if (raw === null || raw === undefined) return null;
  try { return JSON.parse(raw); } catch { return String(raw); }
}
/** The daemon's value → the string the cache keeps. */
export const decode = (value) => (typeof value === 'string' ? value : JSON.stringify(value));

export const META_KEY = 'rigs.sync';

/**
 * transport: { get() → { keys: { key: { value, rev, by } } }, put(key, value) → { rev, by } }. Errors carry `status`
 * (400 = this key is not synced, 404 = a daemon without the endpoint); anything else is retried after `retryMs`.
 */
export function createSyncedStorage({
  local, transport, readOnly = () => false, prepare = (k, v) => v, busy = () => false,
  debounceMs = 500, retryMs = 5000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, metaKey = META_KEY,
} = {}) {
  const lget = (k) => { try { return local?.getItem(k) ?? null; } catch { return null; } };
  const lset = (k, v) => { try { local?.setItem(k, v); } catch { /* private mode / quota */ } };
  let meta = {};
  try { const m = JSON.parse(lget(metaKey) || '{}'); if (m && typeof m === 'object' && !Array.isArray(m)) meta = m; } catch { /* corrupt: start over */ }
  const saveMeta = () => lset(metaKey, JSON.stringify(meta));

  const synced = new Map(); // key → JSON of the value the daemon has (as far as we know)
  const unsynced = new Set(); // keys the daemon refused: local only
  const early = new Set(); // keys written before the first refresh answered: the daemon's value wins over them
  const checked = new Set(); // keys already compared with the daemon (migration done or not needed)
  const seen = new Set(); // keys read before the first refresh answered: compared then
  const inflight = new Map(); // key → JSON being sent
  const pending = new Map(); // key → entry waiting for resume() (a drag was in progress)
  const listeners = new Set();
  const statusListeners = new Set();
  let ready = false; // the first refresh answered (or failed)
  let disabled = false; // the daemon has no ui-layout endpoint: plain localStorage
  let offline = false;
  let last = null; // { key, rev, by } of the newest stamp seen
  let timer = null;
  let quiet = 0;

  const current = (k) => { const raw = lget(k); return raw === null ? null : prepare(k, encode(raw)); };
  const json = (v) => JSON.stringify(v ?? null);
  const at = () => Math.max(1, Number(now()) || 0); // when a change was made here (never 0: it doubles as the dirty flag)
  const blocked = (k) => disabled || unsynced.has(k) || k === metaKey || readOnly(k);
  const stamp = (e) => ({ rev: Number(e?.rev) || 0, by: String(e?.by || '') });
  const note = (k, e) => { if (!last || isNewer(e, last)) last = { key: k, ...stamp(e) }; };
  const dirty = () => Object.values(meta).some((m) => m?.dirty);
  const tellStatus = () => { const s = api.status(); for (const fn of statusListeners) { try { fn(s); } catch { /* keep going */ } } };

  function schedule(ms) {
    if (timer) clearTimer(timer);
    timer = setTimer(() => { timer = null; flush(); }, ms);
  }

  function markDirty(k, { force = false } = {}) {
    if (blocked(k)) return;
    const v = current(k);
    if (v === null) return; // nothing to send (the daemon has no delete)
    if (!force && synced.has(k) && json(v) === synced.get(k)) {
      if (meta[k]?.dirty) { delete meta[k].dirty; saveMeta(); }
      return;
    }
    if (!ready) early.add(k);
    meta[k] = { ...(meta[k] || {}), dirty: at() };
    saveMeta();
    if (ready) schedule(debounceMs);
  }

  /** Send every changed key now (the debounce timer calls this). Resolves when the PUTs answered. */
  async function flush() {
    if (!ready || disabled) return;
    const keys = Object.keys(meta).filter((k) => meta[k]?.dirty && !inflight.has(k));
    let retry = false;
    await Promise.all(keys.map(async (k) => {
      if (blocked(k)) { delete meta[k].dirty; return; }
      const v = current(k);
      if (v === null) { delete meta[k].dirty; return; }
      const s = json(v);
      inflight.set(k, s);
      try {
        const r = await transport.put(k, v);
        offline = false;
        synced.set(k, s);
        const was = meta[k];
        meta[k] = stamp(r);
        note(k, meta[k]);
        if (json(current(k)) !== s) { meta[k].dirty = was?.dirty || at(); retry = true; } // changed again while it was being sent
      } catch (e) {
        if (e?.status === 400 || e?.status === 413) { unsynced.add(k); delete meta[k].dirty; } // not a synced key / too big: stays local
        else if (e?.status === 404) disabled = true;
        else { offline = true; retry = true; }
      } finally { inflight.delete(k); }
    }));
    saveMeta();
    if (retry) schedule(offline ? retryMs : debounceMs);
    tellStatus();
  }

  /** Take the daemon's entry for `k`: into the cache, then tell the listeners (or wait while a drag is on). */
  function apply(k, e) {
    if (busy()) { pending.set(k, e); return false; }
    pending.delete(k);
    synced.set(k, json(e.value));
    meta[k] = stamp(e);
    note(k, e);
    saveMeta();
    const raw = decode(e.value);
    quiet++;
    try {
      lset(k, raw);
      for (const fn of listeners) { try { fn(k, raw, e); } catch { /* one listener must not break the rest */ } }
    } finally { quiet--; }
    tellStatus();
    return true;
  }

  /** Compare one key with the daemon's snapshot entry `d` (undefined = the daemon has none). */
  function reconcile(k, d) {
    checked.add(k);
    if (disabled || unsynced.has(k) || k === metaKey) return;
    const m = meta[k];
    const wasEarly = early.delete(k);
    if (!d) {
      if (lget(k) !== null) markDirty(k, { force: true }); // the daemon has none yet: upload the localStorage-only value once
      return;
    }
    note(k, d);
    const local = current(k);
    synced.set(k, json(d.value));
    if (local !== null && json(local) === json(d.value)) { meta[k] = stamp(d); return; } // already the same: remember the stamp
    // An edit made here after the daemon's value (and not just the defaults written while booting): send it.
    if (m?.dirty && !wasEarly && !readOnly(k) && Number(m.dirty) > stamp(d).rev) { markDirty(k, { force: true }); return; }
    // The cache is stamped newer than the daemon (its file was restored or lost a write): send ours. Otherwise take the daemon's.
    if (m && !m.dirty && !wasEarly && !readOnly(k) && isNewer(m, d)) { markDirty(k, { force: true }); return; }
    apply(k, d);
  }

  const api = {
    getItem(k) {
      const raw = lget(k);
      if (!ready) seen.add(k);
      else if (!checked.has(k)) reconcile(k, undefined); // first read after boot of a key the daemon did not have
      return raw;
    },
    setItem(k, v) {
      lset(k, String(v));
      if (!quiet) markDirty(k); // while applying the daemon's value nothing is sent back
    },
    removeItem(k) { try { local?.removeItem?.(k); } catch { /* ignore */ } },

    /** Read the daemon's keys and reconcile every key we know of. Resolves false when the daemon could not be reached. */
    async refresh() {
      let snap;
      try { snap = await transport.get(); offline = false; } catch (e) {
        if (e?.status === 404) disabled = true; else offline = true;
        tellStatus();
        if (!disabled) setTimer(() => api.refresh(), retryMs);
        return false;
      }
      const keys = snap?.keys && typeof snap.keys === 'object' ? snap.keys : {};
      ready = true;
      const known = new Set([...Object.keys(keys), ...Object.keys(meta), ...checked, ...early, ...seen]);
      known.delete(metaKey);
      for (const k of known) reconcile(k, keys[k]);
      saveMeta();
      tellStatus();
      if (dirty()) schedule(0);
      return true;
    },

    /** A `ui-layout` WebSocket event. Returns true when it changed the cache. */
    receive(ev) {
      const k = ev?.key;
      if (!k || ev.value === undefined || disabled || unsynced.has(k) || k === metaKey) return false;
      checked.add(k);
      note(k, ev);
      const m = meta[k];
      if (m && (m.rev || m.by) && !isNewer(ev, m)) return false; // older, or the stamp we already have (our own PUT came back)
      const s = json(ev.value);
      if (json(current(k)) === s) { // our own change coming back before the PUT answered, or the same value set elsewhere
        synced.set(k, s);
        meta[k] = stamp(ev);
        saveMeta();
        tellStatus();
        return false;
      }
      if (m?.dirty || inflight.has(k)) return false; // a newer change of ours is on its way and will win
      return apply(k, ev);
    },

    /** The pointer was released: apply what arrived during the drag, unless the drag changed that key here. */
    resume() {
      for (const [k, e] of [...pending]) {
        if (busy()) return;
        pending.delete(k);
        if (meta[k]?.dirty || inflight.has(k)) continue; // the drop is newer: its PUT wins
        if (meta[k] && !isNewer(e, meta[k])) continue;
        apply(k, e);
      }
    },

    /** Run fn with writes going to the cache only (re-applying a value that came from the daemon). */
    quiet(fn) { quiet++; try { return fn(); } finally { quiet--; } },
    /** fn(key, raw, entry) after a value from elsewhere was written to the cache. */
    onRemote(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    onStatus(fn) { statusListeners.add(fn); return () => statusListeners.delete(fn); },
    flush,
    /** { state: 'synced' | 'saving' | 'offline' | 'local' | 'starting', last: { key, rev, by } | null } for menus. */
    status() {
      const state = disabled ? 'local' : offline ? 'offline' : !ready ? 'starting' : dirty() || inflight.size ? 'saving' : 'synced';
      return { state, last };
    },
    /** Whether writes to `k` go to the daemon here (false on a phone for the panel layout, or a key it refused). */
    isSynced: (k) => !blocked(k),
    hasPending: () => pending.size > 0,
  };
  return api;
}
