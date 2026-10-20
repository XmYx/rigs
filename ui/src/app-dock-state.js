// State model for the macOS-style application dock — pure functions, no DOM, no globals, no I/O. Unit-tested in
// test/app-dock-state.test.js. Every operation returns a new state and never mutates its input (an operation that
// has nothing to do returns the input state itself). app-dock.js draws the dock from this state (via app-dock-model.js).
//
// State: {
//   v, nextGroup,
//   settings: { position: 'left'|'right'|'bottom', autoHide, magnification, magnifyStrength (0..1), autoDock, autoTabTerminals },
//   items:    { [id]: { id, kind, title, icon, ref, pinned, hidden, live } }    id = `${kind}:${key}`
//   groups:   { [gid]: { id, name, collapsed, items: [itemId] } }
//   order:    [{ type: 'item'|'group', id }]   top level, left→right / top→bottom; grouped items live only in their group
// }
// Item kinds mirror the real sources: applet (App Cloud entry from /api/apps: { node, id, name, icon }), rig (a mesh
// node from the nodes snapshot: { id, name, online, rigs }), panel ({ id, title }), window (wm.js: { id, title, icon })
// and terminal (a PTY: { id, nodeId, title }).

export const VERSION = 1;
export const KINDS = ['applet', 'rig', 'panel', 'window', 'terminal'];
export const POSITIONS = ['left', 'right', 'bottom'];
export const TERMINAL_GROUP = 'g-terminals';

export const DEFAULT_SETTINGS = Object.freeze({
  position: 'bottom',
  autoHide: false,
  magnification: true,
  magnifyStrength: 0.6,
  autoDock: false,
  autoTabTerminals: false,
});

/** An empty dock with default settings (autoDock and autoTabTerminals off). */
export const emptyState = () => ({ v: VERSION, nextGroup: 1, settings: { ...DEFAULT_SETTINGS }, items: {}, groups: {}, order: [] });

// ---------------------------------------------------------------------------------------------------------------
// helpers

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const str = (x, fallback = '') => (typeof x === 'string' ? x : fallback);
const bool = (x, fallback) => (typeof x === 'boolean' ? x : fallback);
const clamp01 = (n, fallback) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback);
const ITEM_ID = /^(applet|rig|panel|window|terminal):.+$/;
const GROUP_ID = /^g[\w-]*$/;
const isItemId = (id) => typeof id === 'string' && ITEM_ID.test(id);
const isGroupId = (id) => typeof id === 'string' && GROUP_ID.test(id);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const jsonSafe = (ref) => {
  if (!isObj(ref)) return {};
  const out = {};
  for (const [k, v] of Object.entries(ref)) if (k !== '__proto__' && (v === null || ['string', 'number', 'boolean'].includes(typeof v))) out[k] = v;
  return out;
};

/** Item id for a kind and a source key: itemId('applet', 'mac/krea') → 'applet:mac/krea'. */
export const itemId = (kind, key) => `${kind}:${key}`;

/** Copy of a state whose parts can be edited freely (items, groups and arrays are copied, the input is untouched). */
function draft(s) {
  const items = {};
  for (const [id, it] of Object.entries(s.items)) items[id] = { ...it, ref: { ...it.ref } };
  const groups = {};
  for (const [id, g] of Object.entries(s.groups)) groups[id] = { ...g, items: [...g.items] };
  return { ...s, settings: { ...s.settings }, items, groups, order: s.order.map((e) => ({ ...e })) };
}

const topIndex = (s, type, id) => s.order.findIndex((e) => e.type === type && e.id === id);

/** Detach an item from wherever it sits (top level or a group) inside a draft. */
function detach(d, id) {
  d.order = d.order.filter((e) => !(e.type === 'item' && e.id === id));
  for (const g of Object.values(d.groups)) g.items = g.items.filter((x) => x !== id);
}

const insertAt = (arr, index, value) => {
  const i = Number.isInteger(index) ? Math.max(0, Math.min(arr.length, index)) : arr.length;
  arr.splice(i, 0, value);
};

/** Build an item from a source record of the given kind; null when the record has no usable key. */
export function toItem(kind, src) {
  if (!KINDS.includes(kind) || !isObj(src)) return null;
  const has = (v) => v !== undefined && v !== null && v !== '';
  if (!has(src.id)) return null;
  const key = String(src.id);
  let title; let icon = str(src.icon); let ref;
  if (kind === 'applet') { title = str(src.name, key); ref = { node: str(src.node), id: key }; return mk(kind, src.node ? `${src.node}/${key}` : key, title, icon, ref); }
  if (kind === 'rig') { title = str(src.name, key); ref = { nodeId: key }; icon = icon || '◈'; }
  else if (kind === 'terminal') { title = str(src.title, 'shell'); icon = icon || '⌨'; ref = { ptyId: key, nodeId: str(src.nodeId) }; }
  else { title = str(src.title, key); ref = { id: key }; }
  return mk(kind, key, title, icon, ref);
}
const mk = (kind, key, title, icon, ref) => ({ id: itemId(kind, key), kind, title, icon, ref, pinned: false, hidden: false, live: true });

// ---------------------------------------------------------------------------------------------------------------
// items: add / remove / pin / hide

/** Add an item (from toItem) at the end of the top level — or into `group` — unless it is already there; refreshes its label when it is. */
export function addItem(state, item, { group = null, index } = {}) {
  if (!item || !isItemId(item.id) || !KINDS.includes(item.kind)) return state;
  const d = draft(state);
  const known = d.items[item.id];
  if (known) { d.items[item.id] = { ...known, title: item.title ?? known.title, icon: item.icon || known.icon, ref: { ...known.ref, ...jsonSafe(item.ref) }, live: true }; return d; }
  d.items[item.id] = { pinned: false, hidden: false, live: true, icon: '', title: item.id, ...item, ref: jsonSafe(item.ref) };
  if (group && d.groups[group]) insertAt(d.groups[group].items, index, item.id);
  else insertAt(d.order, index, { type: 'item', id: item.id });
  return d;
}

/** Remove an item everywhere. */
export function removeItem(state, id) {
  if (!own(state.items, id)) return state;
  const d = draft(state);
  detach(d, id);
  delete d.items[id];
  return d;
}

/** Pin or unpin an item. A pinned item stays in the dock when its source goes away. */
export function setPinned(state, id, pinned = true) {
  if (!own(state.items, id) || state.items[id].pinned === !!pinned) return state;
  const d = draft(state);
  d.items[id].pinned = !!pinned;
  return d;
}

/** Hide or show an item (customisation: hidden items are kept but not rendered). */
export function setHidden(state, id, hidden = true) {
  if (!own(state.items, id) || state.items[id].hidden === !!hidden) return state;
  const d = draft(state);
  d.items[id].hidden = !!hidden;
  return d;
}

// ---------------------------------------------------------------------------------------------------------------
// groups

/**
 * Create a group holding `items` (in the given order; unknown ids are skipped). The group takes the top-level slot of its
 * first member, or the end when it starts empty. `id` is optional — ids come from a counter in the state, never a clock.
 */
export function createGroup(state, { id, name = 'Group', items = [] } = {}) {
  const d = draft(state);
  let gid = id;
  if (!isGroupId(gid) || d.groups[gid]) {
    gid = `g${d.nextGroup}`;
    while (d.groups[gid]) { d.nextGroup += 1; gid = `g${d.nextGroup}`; }
  }
  const members = [...new Set(items)].filter((x) => own(d.items, x));
  const slots = members.map((m) => topIndex(d, 'item', m)).filter((i) => i >= 0);
  const at = slots.length ? Math.min(...slots) : d.order.length;
  for (const m of members) detach(d, m);
  d.groups[gid] = { id: gid, name: str(name).trim() || 'Group', collapsed: false, items: members };
  insertAt(d.order, at, { type: 'group', id: gid });
  const n = Number(gid.slice(1));
  if (Number.isInteger(n)) d.nextGroup = Math.max(d.nextGroup, n + 1);
  return d;
}

export function renameGroup(state, gid, name) {
  if (!own(state.groups, gid) || typeof name !== 'string' || !name.trim() || state.groups[gid].name === name.trim()) return state;
  const d = draft(state);
  d.groups[gid].name = name.trim();
  return d;
}

/** Dissolve a group: its items return to the top level at the group's position, in order. */
export function ungroup(state, gid) {
  if (!own(state.groups, gid)) return state;
  const d = draft(state);
  const at = topIndex(d, 'group', gid);
  d.order.splice(at, 1, ...d.groups[gid].items.map((id) => ({ type: 'item', id })));
  delete d.groups[gid];
  return d;
}

export function setCollapsed(state, gid, collapsed = true) {
  if (!own(state.groups, gid) || state.groups[gid].collapsed === !!collapsed) return state;
  const d = draft(state);
  d.groups[gid].collapsed = !!collapsed;
  return d;
}

/**
 * Move an item into a group (`group` = id, at `index` or the end) or out to the top level (`group` = null, at `index`
 * or the end). A group left with no items is kept: ungroup it or leave it for the user to fill.
 */
export function moveItem(state, id, { group = null, index } = {}) {
  if (!own(state.items, id) || (group !== null && !own(state.groups, group))) return state;
  const d = draft(state);
  detach(d, id);
  if (group) insertAt(d.groups[group].items, index, id);
  else insertAt(d.order, index, { type: 'item', id });
  return d;
}

/** Reorder a top-level entry (an ungrouped item or a whole group) to `index` among the top-level entries. */
export function reorder(state, type, id, index) {
  const from = topIndex(state, type, id);
  if (from < 0 || !Number.isInteger(index)) return state;
  const to = Math.max(0, Math.min(state.order.length - 1, index));
  if (to === from) return state;
  const d = draft(state);
  const [entry] = d.order.splice(from, 1);
  d.order.splice(to, 0, entry);
  return d;
}

// ---------------------------------------------------------------------------------------------------------------
// settings

function sanitizeSettings(raw, fallback = DEFAULT_SETTINGS) {
  const r = isObj(raw) ? raw : {};
  return {
    position: POSITIONS.includes(r.position) ? r.position : fallback.position,
    autoHide: bool(r.autoHide, fallback.autoHide),
    magnification: bool(r.magnification, fallback.magnification),
    magnifyStrength: clamp01(r.magnifyStrength, fallback.magnifyStrength),
    autoDock: bool(r.autoDock, fallback.autoDock),
    autoTabTerminals: bool(r.autoTabTerminals, fallback.autoTabTerminals),
  };
}

/** Merge a partial settings patch; invalid values are ignored field by field. */
export function setSettings(state, patch = {}) {
  if (!isObj(patch)) return state;
  const next = sanitizeSettings({ ...state.settings, ...patch }, state.settings);
  if (Object.keys(next).every((k) => next[k] === state.settings[k])) return state;
  return { ...draft(state), settings: next };
}

export const setPosition = (state, position) => (POSITIONS.includes(position) ? setSettings(state, { position }) : state);
export const setAutoHide = (state, autoHide) => setSettings(state, { autoHide: !!autoHide });

// ---------------------------------------------------------------------------------------------------------------
// merging live sources

const SOURCE_KEYS = { applets: 'applet', rigs: 'rig', panels: 'panel', windows: 'window', terminals: 'terminal' };

/**
 * Fold the live sources into the state without disturbing the user's layout. `sources` may carry any of
 * { applets, rigs, panels, windows, terminals } (arrays of the records described at the top); a key that is absent
 * means "that source was not polled" and leaves its items alone.
 *   applets, rigs      new ones are appended to the top level; known ones keep their place, group, pin and hide and only
 *                      refresh title/icon/ref. Rigs count only while { online && rigs }.
 *   panels/windows/    never added by a merge (that is the user's choice, or auto-docking); items already in the dock
 *   terminals          get their title refreshed.
 * Items whose source is gone are removed — unless pinned, which keep their slot and turn `live: false`.
 */
export function mergeSources(state, sources = {}) {
  if (!isObj(sources)) return state;
  const d = draft(state);
  for (const [field, kind] of Object.entries(SOURCE_KEYS)) {
    if (!Array.isArray(sources[field])) continue;
    const seen = new Set();
    for (const rec of sources[field]) {
      if (kind === 'rig' && !(rec && rec.online && rec.rigs)) continue;
      const it = toItem(kind, rec);
      if (!it) continue;
      seen.add(it.id);
      const known = d.items[it.id];
      if (known) d.items[it.id] = { ...known, title: it.title, icon: it.icon || known.icon, ref: { ...known.ref, ...it.ref }, live: true };
      else if (kind === 'applet' || kind === 'rig') { d.items[it.id] = it; d.order.push({ type: 'item', id: it.id }); }
    }
    for (const it of Object.values(d.items)) {
      if (it.kind !== kind || seen.has(it.id)) continue;
      if (it.pinned) it.live = false;
      else { detach(d, it.id); delete d.items[it.id]; }
    }
  }
  return d;
}

// ---------------------------------------------------------------------------------------------------------------
// auto-dock / auto-tab

/**
 * What to do when something opens. `event` = { kind, source } where source is the record toItem() takes (a panel, a
 * window, a PTY, an applet). With autoDock off (the default) nothing changes. With it on, the item is docked at the end.
 * A terminal is additionally tabbed into the shared Terminals group when autoTabTerminals is on — which also works on
 * its own (autoTabTerminals without autoDock docks terminals only, and only into the group). A terminal event with
 * `auto: false` (opened by hand) is docked by autoDock like any window but never tabbed.
 */
export function onOpened(state, event) {
  const { autoDock, autoTabTerminals } = state.settings;
  const kind = event?.kind;
  const tab = kind === 'terminal' && autoTabTerminals && event.auto !== false; // `auto: false` = the user opened it by hand: never tabbed
  if (!autoDock && !tab) return state;
  const item = toItem(kind, event?.source);
  if (!item) return state;
  let next = state.items[item.id] ? state : addItem(state, item);
  if (tab) {
    if (!next.groups[TERMINAL_GROUP]) next = createGroup(next, { id: TERMINAL_GROUP, name: 'Terminals' });
    if (!next.groups[TERMINAL_GROUP].items.includes(item.id)) next = moveItem(next, item.id, { group: TERMINAL_GROUP });
  }
  return next;
}

/** An opened panel/window/terminal closed again: drop it from the dock unless pinned (then it stays, `live: false`). */
export function onClosed(state, { kind, source } = {}) {
  const it = toItem(kind, source);
  if (!it || !own(state.items, it.id)) return state;
  if (state.items[it.id].pinned) { const d = draft(state); d.items[it.id].live = false; return d; }
  return removeItem(state, it.id);
}

// ---------------------------------------------------------------------------------------------------------------
// view + magnification

/**
 * What to render, in order: [{ type: 'item', item } | { type: 'group', group, items }]. Hidden items are left out; a
 * group whose items are all hidden still shows (so it can be reached) with an empty list.
 */
export function dockView(state) {
  const out = [];
  for (const e of state.order) {
    if (e.type === 'item') { const item = state.items[e.id]; if (item && !item.hidden) out.push({ type: 'item', item }); }
    else { const group = state.groups[e.id]; if (group) out.push({ type: 'group', group, items: group.items.map((id) => state.items[id]).filter((it) => it && !it.hidden) }); }
  }
  return out;
}

/**
 * Scale for one icon whose centre is `distance` px from the cursor along the dock axis. A raised-cosine bump:
 * 1 + strength at distance 0, falling smoothly to 1 at `radius`. Magnification off (or strength 0) → always 1.
 */
export function magnifyScale(distance, { magnification = true, magnifyStrength = DEFAULT_SETTINGS.magnifyStrength } = {}, radius = 120) {
  if (!magnification || !Number.isFinite(distance) || !(radius > 0)) return 1;
  const d = Math.abs(distance);
  if (d >= radius) return 1;
  return 1 + clamp01(magnifyStrength, 0) * 0.5 * (1 + Math.cos((Math.PI * d) / radius));
}

/** Scales for icon centres along the axis given a cursor position; a null/NaN cursor (pointer left the dock) → all 1. */
export function magnifyScales(centres, cursor, settings = DEFAULT_SETTINGS, radius = 120) {
  return centres.map((c) => (Number.isFinite(cursor) ? magnifyScale(c - cursor, settings, radius) : 1));
}

// ---------------------------------------------------------------------------------------------------------------
// persistence

const MIGRATIONS = {
  // v0 (before versioning): { position, autoHide, ..., items: [item], groups: [{ id, name, items }] } — settings sat at the
  // top level and groups were a list. Becomes v1's nested settings and keyed groups; order was implicit in the arrays.
  0(raw) {
    const groups = {};
    for (const g of Array.isArray(raw.groups) ? raw.groups : []) if (isObj(g) && isGroupId(g.id)) groups[g.id] = g;
    const items = {};
    for (const it of Array.isArray(raw.items) ? raw.items : []) if (isObj(it) && isItemId(it.id)) items[it.id] = it;
    const grouped = new Set(Object.values(groups).flatMap((g) => (Array.isArray(g.items) ? g.items : [])));
    return {
      v: 1, settings: isObj(raw.settings) ? raw.settings : raw, items, groups,
      order: [...Object.keys(items).filter((id) => !grouped.has(id)).map((id) => ({ type: 'item', id })), ...Object.keys(groups).map((id) => ({ type: 'group', id }))],
    };
  },
};

/** Validate and repair any value into a well-formed v1 state: bad fields fall back to defaults, dangling references are dropped. */
export function normalize(raw) {
  const r = isObj(raw) ? raw : {};
  const items = {};
  for (const [id, it] of isObj(r.items) ? Object.entries(r.items) : []) {
    if (!isItemId(id) || !isObj(it)) continue;
    items[id] = { id, kind: id.slice(0, id.indexOf(':')), title: str(it.title, id), icon: str(it.icon), ref: jsonSafe(it.ref), pinned: bool(it.pinned, false), hidden: bool(it.hidden, false), live: bool(it.live, true) };
  }
  const placed = new Set();
  const groups = {};
  for (const [id, g] of isObj(r.groups) ? Object.entries(r.groups) : []) {
    if (!isGroupId(id) || !isObj(g)) continue;
    const members = (Array.isArray(g.items) ? g.items : []).filter((x) => own(items, x) && !placed.has(x) && placed.add(x));
    groups[id] = { id, name: str(g.name, 'Group').trim() || 'Group', collapsed: bool(g.collapsed, false), items: members };
  }
  const order = [];
  const top = new Set();
  for (const e of Array.isArray(r.order) ? r.order : []) {
    if (!isObj(e)) continue;
    const key = `${e.type}:${e.id}`;
    if (top.has(key)) continue;
    if (e.type === 'item' && own(items, e.id) && !placed.has(e.id)) { top.add(key); placed.add(e.id); order.push({ type: 'item', id: e.id }); }
    else if (e.type === 'group' && own(groups, e.id)) { top.add(key); order.push({ type: 'group', id: e.id }); }
  }
  for (const id of Object.keys(items)) if (!placed.has(id)) order.push({ type: 'item', id });
  for (const id of Object.keys(groups)) if (!top.has(`group:${id}`)) order.push({ type: 'group', id });
  const used = Object.keys(groups).map((g) => Number(g.slice(1))).filter(Number.isInteger).map((n) => n + 1);
  const next = Number.isInteger(r.nextGroup) && r.nextGroup > 0 ? r.nextGroup : 1;
  return { v: VERSION, nextGroup: Math.max(next, ...used), settings: sanitizeSettings(r.settings), items, groups, order };
}

/** JSON text for storage. */
export const serialize = (state) => JSON.stringify(normalize(state));

/**
 * State from stored text (or an already-parsed object). Anything unreadable — null, bad JSON, wrong types — gives the
 * default empty dock; older versions are migrated; a newer version is read as far as it matches and repaired.
 */
export function deserialize(input) {
  let raw = input;
  if (typeof input === 'string') { try { raw = JSON.parse(input); } catch { return emptyState(); } }
  if (!isObj(raw)) return emptyState();
  let v = Number.isInteger(raw.v) ? raw.v : 0;
  while (v < VERSION && MIGRATIONS[v]) { raw = MIGRATIONS[v](raw); v = raw.v; }
  return normalize(raw);
}
