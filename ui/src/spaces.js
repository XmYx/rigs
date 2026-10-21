import { onRemoteKey, syncedStorage } from './synced-storage.js';
import { isPhone } from './mobile.js';
import * as M from './spaces-model.js';

// Spaces — virtual desktops for the wm.js windows (macOS style). The model is pure (spaces-model.js); this module holds
// the page's live state, saves it and tells listeners. wm.js listens and shows only the active desktop's windows, so
// the public API (listDesktops, switchDesktop, moveWindowToDesktop…) is re-exported from wm.js, which knows the
// windows. Panels, the galaxy, the menu bar and the app dock are on every desktop, as the Mac's Dock and menu bar are.
//
// Saved in two places: the desktops and which desktop each keyed window is on go through synced-storage.js
// ('rigs.spaces', every machine on the mesh: a desktop added or a window moved on one shows on the others); the active
// desktop belongs to this browser ('rigs.spaces.active' in localStorage). A window opening only because it is assigned
// to the active desktop is a derived write (synced-storage auto): it stays in this browser's cache.
// Phones have one desktop: nothing is hidden and switching does nothing.

const KEY = 'rigs.spaces';
const ACTIVE_KEY = 'rigs.spaces.active';
const listeners = new Set();
let openKeys = () => []; // wm.js: the keys of the windows open on this page (kept on their desktop when another machine saves)

const readActive = () => { try { return localStorage.getItem(ACTIVE_KEY); } catch { return null; } };
const saveActive = (id) => { try { localStorage.setItem(ACTIVE_KEY, id); } catch { /* private mode */ } };

let state = M.normalizeSpaces(syncedStorage.getItem(KEY), { active: readActive() });
let saved = JSON.stringify(M.serializeSpaces(state));

/** Spaces in effect here (not on a phone). */
export const spacesOn = () => !isPhone();
/** The live state (read only): { desktops, active, windows, seq }. */
export const spacesState = () => state;

/**
 * Make `next` the state: save what changed and tell the listeners. `auto` = derived, not chosen by a person (cache only);
 * `remote` = another machine's value (never sent back). Returns true when anything changed.
 */
function commit(next, { reason, auto = false, remote = false } = {}) {
  if (next === state) return false;
  const prev = state;
  state = next;
  const json = JSON.stringify(M.serializeSpaces(state));
  if (json !== saved) {
    saved = json;
    const write = () => syncedStorage.setItem(KEY, json);
    if (remote) syncedStorage.quiet(write);
    else if (auto) syncedStorage.auto(write);
    else write();
  }
  if (prev.active !== state.active) saveActive(state.active);
  for (const fn of [...listeners]) { try { fn({ state, prev, reason }); } catch (e) { console.error(e); } }
  return true;
}

/** fn({ state, prev, reason }) after every change (reason: switch, add, remove, rename, move, assign, forget, remote). Returns an unsubscribe. */
export function onSpacesChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** The desktops in order: { id, name, index, active, named, windows }. A phone has one. */
export function listDesktops() {
  const all = M.listDesktops(state);
  return spacesOn() ? all : all.filter((d) => d.active);
}
/** The active desktop: { id, name, index }. */
export function activeDesktop() {
  const d = M.listDesktops(state).find((x) => x.active);
  return { id: d.id, name: d.name, index: d.index };
}
export const desktopName = (id) => M.desktopName(state, id);

/** Switch desktops: a desktop id, { index } (0-based), 'next' or 'prev'. False when nothing changed (or on a phone). */
export function switchDesktop(target) {
  if (!spacesOn()) return false;
  return commit(M.switchDesktop(state, target), { reason: 'switch' });
}
/** Add a desktop at the end; `switchTo` makes it active. Returns its id, or null when there are MAX_DESKTOPS already. */
export function addDesktop({ name = '', switchTo = false } = {}) {
  if (!spacesOn()) return null;
  const next = M.addDesktop(state, { name });
  if (next === state) return null;
  const id = next.desktops[next.desktops.length - 1].id;
  commit(switchTo ? M.switchDesktop(next, id) : next, { reason: 'add' });
  return id;
}
/** Remove a desktop (default: the active one); its windows move to its neighbour. The last one can't be removed. */
export function removeDesktop(id = state.active) {
  if (!spacesOn()) return false;
  return commit(M.removeDesktop(state, id), { reason: 'remove' });
}
export function renameDesktop(id, name) { return commit(M.renameDesktop(state, id, name), { reason: 'rename' }); }
export const canAddDesktop = () => spacesOn() && M.canAdd(state);
export const canRemoveDesktop = (id = state.active) => spacesOn() && M.canRemove(state, id);

// ---------------------------------------------------------------- for wm.js (window keys, not window ids)

/** A window opened: on its remembered desktop, else the active one. Returns that desktop's id. */
export function assignKey(key) { commit(M.assignWindow(state, key), { reason: 'assign', auto: true }); return M.desktopOf(state, key); }
/** A window closed: it is on no desktop any more. */
export function forgetKey(key) { commit(M.forgetWindow(state, key), { reason: 'forget', auto: true }); }
/** Move a window (by key) to a desktop. */
export function moveKey(key, id) { return commit(M.moveWindow(state, key, id), { reason: 'move' }); }
/** The desktop a window key is on (the active one when it has none, or on a phone). */
export const desktopOfKey = (key) => (spacesOn() && M.desktopOf(state, key)) || state.active;
/** wm.js tells which window keys are open here (they keep their desktop when another machine saves). */
export function setOpenKeys(fn) { openKeys = fn; }

onRemoteKey(KEY, (raw) => {
  const next = M.mergeRemote(state, raw, { open: openKeys() });
  saved = JSON.stringify(M.serializeSpaces(next));
  commit(next, { reason: 'remote', remote: true });
});
