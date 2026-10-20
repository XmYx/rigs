// The one synced storage of the JARVIS page (pure logic in synced-storage-model.js): localStorage as the instant cache,
// the daemon's /api/local/ui-layout as the copy every machine on the mesh shares. docking.js (rigs.dock, rigs.docking),
// scaling.js (rigs.scaling) and the app dock (rigs.appdock, from main.js) read and write through it.
//
// This module waits (top-level await, at most BOOT_MS) for the daemon's layout before the modules that import it load,
// so a page with cleared storage starts with the synced layout instead of flashing the default one. main.js feeds it
// the `ui-layout` WebSocket events (receive) and refreshes it when the socket reconnects. A held pointer (any drag:
// panel, splitter, tab, resize handle, dock tile) holds remote changes back until it is released.
import { createSyncedStorage } from './synced-storage-model.js';

const URL = '/api/local/ui-layout';
const BOOT_MS = 1500;

let local = null;
try { local = window.localStorage; } catch { /* blocked storage: nothing persists */ }

async function call(method, body) {
  const r = await fetch(URL, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).error || msg; } catch { /* not JSON */ }
    throw Object.assign(new Error(msg), { status: r.status });
  }
  return r.json();
}

// A drag in progress: from pointerdown to pointerup/cancel (a missed release clears on the next buttonless move or blur).
let held = false;
const release = () => { if (!held) return; held = false; setTimeout(() => store.resume(), 0); }; // after the drop handlers ran
window.addEventListener('pointerdown', () => { held = true; }, true);
window.addEventListener('pointerup', release, true);
window.addEventListener('pointercancel', release, true);
window.addEventListener('pointermove', (e) => { if (held && e.buttons === 0) release(); }, true);
window.addEventListener('blur', release);

const readOnlyRules = new Map(); // key → () => boolean
const prepareRules = new Map(); // key → (value) => value

const store = createSyncedStorage({
  local,
  transport: { get: () => call('GET'), put: (key, value) => call('PUT', { key, value }) },
  busy: () => held,
  readOnly: (k) => !!readOnlyRules.get(k)?.(),
  prepare: (k, v) => { const fn = prepareRules.get(k); if (!fn) return v; try { return fn(v); } catch { return v; } },
});

export const syncedStorage = store;
/** Keep `key` local while `when()` holds (phones never write the docked panel layout back). */
export const readOnlyWhen = (key, when) => { readOnlyRules.set(key, when); };
/** Change what is synced for `key` (the cache keeps the value as written). */
export const prepareKey = (key, fn) => { prepareRules.set(key, fn); };
/** Apply a `ui-layout` WebSocket event. */
export const receiveLayout = (m) => store.receive(m);
/** Run fn(raw, entry) whenever another machine (or tab) changed `key` and it was written to the cache. */
export const onRemoteKey = (key, fn) => store.onRemote((k, raw, e) => { if (k === key) fn(raw, e); });

// Send a pending write before the page goes away (a reload right after a drag keeps it).
window.addEventListener('pagehide', () => { store.flush(); });
globalThis.__rigsSyncedStorage = store; // read by scripts/dock-sync-check.js

await Promise.race([store.refresh(), new Promise((r) => setTimeout(r, BOOT_MS))]);
