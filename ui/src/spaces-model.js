// Spaces model (pure, no DOM; tested in test/spaces-model.test.js): the virtual desktops of the JARVIS window manager,
// like macOS Spaces. spaces.js holds the live state and persists it; wm.js shows only the active desktop's windows.
//
// State (plain JSON, never mutated: every operation returns a new object, or the same one when nothing changed):
//   { desktops: [{ id, name }], active: id, windows: { key: desktopId }, seq }
//   desktops  in order, at least one; `name` is '' for an unnamed desktop, shown as "Desktop <position>" (so removing
//             Desktop 2 makes Desktop 3 the new Desktop 2, as on a Mac)
//   windows   which desktop each window is on, by window key: wm.js passes a window's stable key (`term:<node>`,
//             `app:<node>/<id>`…) so a reload puts it back on its desktop, or a TRANSIENT key ('~<n>') for a window
//             with no key of its own, which lives only as long as the page and is never persisted
//   seq       the last desktop number handed out, so a removed desktop's id is never reused

import { matchShortcut } from './commands.js';

export const MAX_DESKTOPS = 16;
export const MAX_WINDOWS = 200; // window keys saved; the oldest go first
export const TRANSIENT = '~'; // prefix of window keys that are never persisted
export const VERSION = 1;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const cleanName = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
const has = (s, id) => s.desktops.some((d) => d.id === id);

/** A fresh state: one desktop, active. */
export function initialSpaces() {
  return { desktops: [{ id: 'd1', name: '' }], active: 'd1', windows: {}, seq: 1 };
}

/** Validate and repair any value (a persisted one, another machine's) into a state; `active` overrides the saved one. */
export function normalizeSpaces(raw, { active } = {}) {
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = null; } }
  if (!isObj(raw)) raw = {};
  const seen = new Set();
  const desktops = [];
  for (const d of Array.isArray(raw.desktops) ? raw.desktops : []) {
    const id = isObj(d) && typeof d.id === 'string' && /^d\d+$/.test(d.id) ? d.id : null;
    if (!id || seen.has(id) || desktops.length >= MAX_DESKTOPS) continue;
    seen.add(id);
    desktops.push({ id, name: cleanName(d.name) });
  }
  if (!desktops.length) return initialSpaces();
  const top = Math.max(...desktops.map((d) => Number(d.id.slice(1))));
  const seq = Math.max(top, Number.isInteger(raw.seq) && raw.seq > 0 ? raw.seq : 0);
  const windows = {};
  if (isObj(raw.windows)) for (const [k, id] of Object.entries(raw.windows)) if (k && seen.has(id)) windows[k] = id;
  const want = active ?? raw.active;
  return { desktops, active: seen.has(want) ? want : desktops[0].id, windows, seq };
}

/** The JSON to save: no transient windows, the newest MAX_WINDOWS keys; `active` only with { active: true } (it belongs to one page, not the mesh). */
export function serializeSpaces(s, { active = false } = {}) {
  const windows = {};
  const keep = Object.keys(s.windows).filter((k) => !k.startsWith(TRANSIENT)).slice(-MAX_WINDOWS);
  for (const k of keep) windows[k] = s.windows[k];
  return { v: VERSION, desktops: s.desktops.map((d) => ({ ...d })), windows, seq: s.seq, ...(active ? { active: s.active } : {}) };
}

// ---------------------------------------------------------------- reading

export const indexOf = (s, id) => s.desktops.findIndex((d) => d.id === id);
/** What a desktop is called: its own name, else "Desktop <position>". */
export function desktopName(s, id) {
  const i = indexOf(s, id);
  if (i < 0) return '';
  return s.desktops[i].name || `Desktop ${i + 1}`;
}
/** The desktops in order: { id, name, index, active, named, windows } (windows = how many keys are on it). */
export function listDesktops(s) {
  const counts = {};
  for (const id of Object.values(s.windows)) counts[id] = (counts[id] || 0) + 1;
  return s.desktops.map((d, index) => ({ id: d.id, name: desktopName(s, d.id), index, active: d.id === s.active, named: !!d.name, windows: counts[d.id] || 0 }));
}
/** The desktop a window key is on (null when it has none yet). */
export const desktopOf = (s, key) => (has(s, s.windows[key]) ? s.windows[key] : null);
/** The window keys on a desktop. */
export const windowsOn = (s, id) => Object.keys(s.windows).filter((k) => s.windows[k] === id);
export const canAdd = (s) => s.desktops.length < MAX_DESKTOPS;
export const canRemove = (s, id = s.active) => s.desktops.length > 1 && has(s, id);

// ---------------------------------------------------------------- desktops

/** Add a desktop at the end (it does not become active, as on a Mac): the new one is the last of `desktops`. */
export function addDesktop(s, { name = '' } = {}) {
  if (!canAdd(s)) return s;
  const seq = s.seq + 1;
  const id = `d${seq}`;
  return { ...s, desktops: [...s.desktops, { id, name: cleanName(name) }], seq };
}

/**
 * Remove a desktop. Its windows move to its neighbour (the desktop before it, else the one after), which also becomes
 * active when the removed one was. The last desktop can't be removed.
 */
export function removeDesktop(s, id = s.active) {
  if (!canRemove(s, id)) return s;
  const i = indexOf(s, id);
  const to = s.desktops[i > 0 ? i - 1 : 1].id;
  const windows = {};
  for (const [k, d] of Object.entries(s.windows)) windows[k] = d === id ? to : d;
  return { ...s, desktops: s.desktops.filter((d) => d.id !== id), windows, active: s.active === id ? to : s.active };
}

/** Give a desktop a name ('' gives it back its "Desktop <n>"). */
export function renameDesktop(s, id, name) {
  const i = indexOf(s, id);
  const n = cleanName(name);
  if (i < 0 || s.desktops[i].name === n) return s;
  const desktops = s.desktops.slice();
  desktops[i] = { ...desktops[i], name: n };
  return { ...s, desktops };
}

/** Move a desktop to position `to` (0-based, clamped). */
export function moveDesktop(s, id, to) {
  const i = indexOf(s, id);
  if (i < 0) return s;
  const j = Math.max(0, Math.min(s.desktops.length - 1, Math.trunc(Number(to)) || 0));
  if (i === j) return s;
  const desktops = s.desktops.slice();
  desktops.splice(j, 0, ...desktops.splice(i, 1));
  return { ...s, desktops };
}

// ---------------------------------------------------------------- switching

/**
 * Make another desktop active. `target`: a desktop id, { index } (0-based), 'next' or 'prev' (they stop at the ends,
 * as on a Mac). Unknown targets change nothing.
 */
export function switchDesktop(s, target) {
  let id = null;
  const i = indexOf(s, s.active);
  if (target === 'next') id = s.desktops[i + 1]?.id;
  else if (target === 'prev') id = s.desktops[i - 1]?.id;
  else if (isObj(target) && Number.isInteger(target.index)) id = s.desktops[target.index]?.id;
  else if (typeof target === 'string') id = has(s, target) ? target : null;
  if (!id || id === s.active) return s;
  return { ...s, active: id };
}

// ---------------------------------------------------------------- windows

/**
 * A window opens: it goes on the desktop it was on (a keyed window after a reload), else on the active one.
 * `desktop` puts it on that desktop instead.
 */
export function assignWindow(s, key, { desktop } = {}) {
  if (!key) return s;
  const want = has(s, desktop) ? desktop : desktopOf(s, key) || s.active;
  if (s.windows[key] === want) return s;
  return { ...s, windows: { ...s.windows, [key]: want } };
}

/** Move a window to another desktop (the active desktop stays as it is). It becomes the newest key. */
export function moveWindow(s, key, id) {
  if (!key || !has(s, id) || s.windows[key] === id) return s;
  const { [key]: _, ...windows } = s.windows;
  return { ...s, windows: { ...windows, [key]: id } };
}

/** A window closed: it is on no desktop any more (it opens on the active one next time). */
export function forgetWindow(s, key) {
  if (!(key in s.windows)) return s;
  const windows = { ...s.windows };
  delete windows[key];
  return { ...s, windows };
}

/**
 * Another machine (or tab) saved its spaces: take its desktops and windows, keep this page's active desktop when it
 * still exists (else its neighbour), and keep the desktop of every window `open` here that the other side does not know
 * (its own windows are not ours). `open` = the keys of the windows open on this page.
 */
export function mergeRemote(s, raw, { open = [] } = {}) {
  const r = normalizeSpaces(raw);
  const ids = new Set(r.desktops.map((d) => d.id));
  let active = s.active;
  if (!ids.has(active)) {
    // the active desktop went away: its neighbour in the old order that still exists
    const i = indexOf(s, active);
    const before = s.desktops.slice(0, i).reverse().find((d) => ids.has(d.id));
    const after = s.desktops.slice(i + 1).find((d) => ids.has(d.id));
    active = (before || after || r.desktops[0]).id;
  }
  const windows = { ...r.windows };
  for (const k of open) {
    if (k in windows) continue;
    const d = s.windows[k];
    windows[k] = ids.has(d) ? d : active;
  }
  return { desktops: r.desktops, active, windows, seq: Math.max(s.seq, r.seq) };
}

// ---------------------------------------------------------------- keys

// Ctrl is the Control key on every platform (Mac included), as for tiling (tiling-model.js TILE_KEYS). Ctrl+←/→ move
// one desktop, Ctrl+1…9 jump to one. macOS takes Ctrl+←/→ for its own Spaces while those shortcuts are on (they are by
// default), so Macs also take Ctrl+Shift+←/→. Elsewhere the browser keeps Ctrl+1…9 for its tabs (only an installed
// JARVIS window sees them), so other platforms also take Ctrl+Shift+1…9. None of them fire while typing or in a terminal.
export const DESKTOP_KEYS = [
  { action: 'prev', keys: ['Ctrl+ArrowLeft'], mac: ['Ctrl+Shift+ArrowLeft'] },
  { action: 'next', keys: ['Ctrl+ArrowRight'], mac: ['Ctrl+Shift+ArrowRight'] },
  ...Array.from({ length: 9 }, (_, i) => ({ action: i + 1, keys: [`Ctrl+${i + 1}`], other: [`Ctrl+Shift+${i + 1}`] })),
];

/** The shortcuts for 'prev', 'next' or a desktop number 1…9 on this platform, the one shown in menus first. */
export function desktopShortcuts(action, mac = false) {
  const row = DESKTOP_KEYS.find((r) => r.action === action);
  if (!row) return [];
  return [...row.keys, ...((mac ? row.mac : row.other) || [])];
}

/**
 * A switch target for switchDesktop from a desktop-key action: 'prev' / 'next' as they are, a number n → { index: n-1 }.
 */
export const targetOf = (action) => (typeof action === 'number' ? { index: action - 1 } : action);

/** The desktop-key action ('prev' | 'next' | 1…9) a keydown asks for, else null. The same matching as every other JARVIS shortcut. */
export function keyToDesktop(ev, { mac = false } = {}) {
  if (!ev) return null;
  for (const row of DESKTOP_KEYS) if (desktopShortcuts(row.action, mac).some((sc) => matchShortcut(sc, ev, { mac }))) return row.action;
  return null;
}
