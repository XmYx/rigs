// State model for the macOS-style application dock — pure functions, no DOM, no globals, no I/O. Unit-tested in
// test/app-dock-state.test.js. Every operation returns a new state and never mutates its input (an operation that
// has nothing to do returns the input state itself). app-dock.js draws the dock from this state (via app-dock-model.js).
//
// State: {
//   v, nextGroup,
//   settings:  { position: 'left'|'right'|'bottom', autoHide, magnification, magnifyStrength (0..1), autoDock, autoTabTerminals, autoGroup },
//   items:     { [id]: { id, kind, title, icon, ref, pinned, hidden, live, badge?, pressed? } }    id = `${kind}:${key}`
//   groups:    { [gid]: { id, name, collapsed, items: [itemId] } }
//   order:     [{ type: 'item'|'group', id }]   top level, left→right / top→bottom; grouped items live only in their group
//   placed:    { [itemId]: true | 'hidden' | { g?, i?, after?, hidden? } }   applets, rigs and tools that have had their
//                                            place once (see "default groups"); the object is the spot one left: group g
//                                            (or the top level), right after `after` (index i), so it comes back there
//   dismissed: [gid]                            default groups the user dissolved: never re-created by themselves
// }
// Item kinds mirror the real sources: applet (App Cloud entry from /api/apps: { node, id, name, icon, category?, nodeName? }),
// rig (a mesh node from the nodes snapshot: { id, name, online, rigs }), panel ({ id, title }), window (wm.js: { id, title,
// icon }), terminal (a PTY: { id, nodeId, title }) and tool (a JARVIS function from TOOL_GROUPS: { id, title, icon, action,
// button, hint, toggle? }). `badge` and `pressed` are live, tool-only display state (setToolState) and are never stored.

export const VERSION = 2;
export const KINDS = ['applet', 'rig', 'panel', 'window', 'terminal', 'tool'];
export const POSITIONS = ['left', 'right', 'bottom'];
export const TERMINAL_GROUP = 'g-terminals';

export const DEFAULT_SETTINGS = Object.freeze({
  position: 'bottom',
  autoHide: false,
  magnification: true,
  magnifyStrength: 0.6,
  autoDock: false,
  autoTabTerminals: false,
  autoGroup: true,
});

/** An empty dock with default settings (autoDock and autoTabTerminals off, autoGroup on). */
export const emptyState = () => ({ v: VERSION, nextGroup: 1, settings: { ...DEFAULT_SETTINGS }, items: {}, groups: {}, order: [], placed: {}, dismissed: [] });

// ---------------------------------------------------------------------------------------------------------------
// helpers

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const str = (x, fallback = '') => (typeof x === 'string' ? x : fallback);
const bool = (x, fallback) => (typeof x === 'boolean' ? x : fallback);
const clamp01 = (n, fallback) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback);
const ITEM_ID = /^(applet|rig|panel|window|terminal|tool):.+$/;
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

// ---------------------------------------------------------------------------------------------------------------
// default groups
//
// The JARVIS functions that used to sit on the floating toolbar (<nav id="bar"> in ui/index.html), as dock tools, in the
// default groups they are seeded into. This table is the one place that defines them: id (tool:<id>, also the action
// key the UI dispatches on), the #bar button whose handler runs it, short title, icon, the button's tooltip as `hint`,
// `badge` for the two buttons that carry a live count, `toggle` for the one on/off switch.
//
// Why these groups (read from what each button does, not from where it sat on the bar):
//   This machine  terminal, files and remote desktop all act on the *focused* machine. Named "This machine" rather than
//                 "Machine" so it cannot be confused with the "Machines" stack of rigs right next to it.
//   Work          everything about agents doing work for you. Questions and Active agents lead the stack because they
//                 carry the live badges and a stack's tile previews its first four items; then projects (plan and
//                 delegate), active projects (running ones) and all sessions.
//   Insight       read-only views onto the mesh: tokens & time, request traces, the Graphify mesh graph, and the
//                 desktops wall (live screens of every machine — watching, not driving one, so not "This machine").
//   System        running the mesh itself: hosted apps, mesh control/updates/settings, and voice output on/off.
export const TOOL_GROUPS = Object.freeze([
  { id: 'g-tools-machine', name: 'This machine', tools: [
    { id: 'term', button: 'btn-term', title: 'Terminal', icon: '⌨', hint: 'Terminal on the focused machine' },
    { id: 'files', button: 'btn-files', title: 'Files', icon: '📁', hint: 'Files on the focused machine' },
    { id: 'desk', button: 'btn-desk', title: 'Remote desktop', icon: '🖥', hint: 'Remote desktop to the focused machine' },
    { id: 'player', button: 'btn-player', title: 'Media player', icon: '▶', hint: 'Media player — audio and video from any machine' },
  ] },
  { id: 'g-tools-work', name: 'Work', tools: [
    { id: 'ask', button: 'btn-ask', title: 'Questions', icon: '❓', hint: 'Questions — agents waiting for your answer', badge: true },
    { id: 'agents', button: 'btn-agents', title: 'Active agents', icon: '🤖', hint: 'Active agents — every live agent session, one click to attach', badge: true },
    { id: 'proj', button: 'btn-proj', title: 'Projects', icon: '📋', hint: 'Projects — plan and delegate work across machines and models' },
    { id: 'work', button: 'btn-work', title: 'Active projects', icon: '📊', hint: 'Active projects — running projects and their progress' },
    { id: 'sess', button: 'btn-sess', title: 'Sessions', icon: '💬', hint: 'All sessions on all machines' },
  ] },
  { id: 'g-tools-insight', name: 'Insight', tools: [
    { id: 'usage', button: 'btn-usage', title: 'Tokens & time', icon: '⏱', hint: 'Tokens & time — what each model spent on which tasks' },
    { id: 'traces', button: 'btn-traces', title: 'Request traces', icon: '🧭', hint: 'Request traces — every request in 3D: stages, inputs and outputs, tool calls' },
    { id: 'graphify', button: 'btn-graphify', title: 'Graphify', icon: '🕸', hint: 'Graphify — the mesh graph in a window you can move, dock and close' },
    { id: 'desktops', button: 'btn-desktops', title: 'Desktops', icon: '🖼', hint: 'Desktops — live screens of your machines' },
  ] },
  { id: 'g-tools-system', name: 'System', tools: [
    { id: 'apps', button: 'btn-apps', title: 'Apps', icon: '▦', hint: 'Apps — web apps hosted on your machines, opened right here' },
    { id: 'mesh', button: 'btn-mesh', title: 'Mesh & settings', icon: '⚙', hint: 'Mesh control, updates, settings' },
    { id: 'mute', button: 'btn-mute', title: 'Voice', icon: '🔊', hint: 'Voice output on/off', toggle: true },
  ] },
].map((g) => Object.freeze({ ...g, tools: Object.freeze(g.tools.map((t) => Object.freeze({ ...t, action: t.id }))) }))); // action key = tool id

/** Every tool, in table order: the `tools` source mergeSources() takes. */
export const TOOLS = Object.freeze(TOOL_GROUPS.flatMap((g) => g.tools));

/** Mesh machines (rig items) go into this stack. */
export const MACHINES_GROUP = Object.freeze({ id: 'g-machines', name: 'Machines' });

const TOOL_HOME = new Map(TOOL_GROUPS.flatMap((g) => g.tools.map((t, i) => [itemId('tool', t.id), { id: g.id, name: g.name, rank: i }])));
const slug = (x) => String(x).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/**
 * The default group an item belongs in, or null (panels, windows, terminals): { id, name, rank? }. Applets go by their
 * App Cloud category when they have one (g-cat-<category>), otherwise by host node (g-node-<node id>, named after the
 * machine); rigs go into "Machines"; tools into their TOOL_GROUPS group (rank = place in that group).
 */
export function defaultGroupOf(item) {
  if (!item) return null;
  if (item.kind === 'tool') return TOOL_HOME.get(item.id) || null;
  if (item.kind === 'rig') return { ...MACHINES_GROUP };
  if (item.kind !== 'applet') return null;
  const cat = str(item.ref?.category).trim();
  if (cat && slug(cat)) return { id: `g-cat-${slug(cat)}`, name: cat };
  const node = str(item.ref?.node);
  if (!node || !slug(node)) return null;
  return { id: `g-node-${slug(node)}`, name: str(item.ref?.nodeName).trim() || node };
}

/** Whether a group id is one of the default groups (a tool group, Machines, an app category or a host node). */
export const isDefaultGroup = (gid) => typeof gid === 'string' && (TOOL_GROUPS.some((g) => g.id === gid) || gid === MACHINES_GROUP.id || /^g-(cat|node)-./.test(gid));

const DEFAULT_KINDS = ['applet', 'rig', 'tool'];

/** Copy of a state whose parts can be edited freely (items, groups and arrays are copied, the input is untouched). */
function draft(s) {
  const items = {};
  for (const [id, it] of Object.entries(s.items)) items[id] = { ...it, ref: { ...it.ref } };
  const groups = {};
  for (const [id, g] of Object.entries(s.groups)) groups[id] = { ...g, items: [...g.items] };
  return { ...s, settings: { ...s.settings }, items, groups, order: s.order.map((e) => ({ ...e })), placed: { ...s.placed }, dismissed: [...(s.dismissed || [])] };
}

const topIndex = (s, type, id) => s.order.findIndex((e) => e.type === type && e.id === id);

const entryKey = (e) => `${e.type}:${e.id}`;

/**
 * Where an item sits: { g, i, after } in group g, { i, after } on the top level ({} when it is nowhere). `after` is what
 * came right before it — an item id in a group, an entry key ('item:<id>' / 'group:<gid>') on the top level — or null
 * when it was first.
 */
function spotOf(s, id) {
  for (const g of Object.values(s.groups)) { const i = g.items.indexOf(id); if (i >= 0) return { g: g.id, i, after: i ? g.items[i - 1] : null }; }
  const i = topIndex(s, 'item', id);
  return i >= 0 ? { i, after: i ? entryKey(s.order[i - 1]) : null } : {};
}

/**
 * Where an item returning to `spot` goes in `list` (a group's items or the top-level order): right after its `after`,
 * or after that one's own `after` while it is still away too (a machine's items leave together and come back one by
 * one), at the start when the chain began there. -1 when the chain is broken (then spot.i is used).
 */
function returnIndex(d, list, keyOf, spot) {
  let after = spot.after;
  const seen = new Set();
  while (typeof after === 'string' && !seen.has(after)) {
    seen.add(after);
    const at = list.findIndex((x) => keyOf(x) === after);
    if (at >= 0) return at + 1;
    const id = spot.g ? after : after.startsWith('item:') ? after.slice(5) : '';
    const prev = isObj(d.placed[id]) ? d.placed[id] : null;
    if (!prev || (prev.g || null) !== (spot.g || null) || !('after' in prev)) return -1;
    after = prev.after;
  }
  return after === null ? 0 : -1;
}

/** Detach an item from wherever it sits (top level or a group) inside a draft. */
function detach(d, id) {
  d.order = d.order.filter((e) => !(e.type === 'item' && e.id === id));
  for (const g of Object.values(d.groups)) g.items = g.items.filter((x) => x !== id);
}

const insertAt = (arr, index, value) => {
  const i = Number.isInteger(index) ? Math.max(0, Math.min(arr.length, index)) : arr.length;
  arr.splice(i, 0, value);
};

/** Put a default group in a draft unless it is there: an empty stack at the end of the top level. */
function ensureGroup(d, { id, name }) {
  if (!d.groups[id]) { d.groups[id] = { id, name, collapsed: false, items: [] }; d.order.push({ type: 'group', id }); }
  return d.groups[id];
}

/** Into its default group, in a draft — a tool at its table rank among the tools already there, anything else at the end. */
function intoDefault(d, item, home) {
  const g = ensureGroup(d, home);
  const rank = (id) => TOOL_HOME.get(id)?.rank ?? Infinity;
  const at = home.rank === undefined ? g.items.length : g.items.findIndex((x) => rank(x) > home.rank);
  insertAt(g.items, at < 0 ? g.items.length : at, item.id);
}

/**
 * Give a brand-new item (already in d.items, not yet placed) its slot, in a draft. An applet, rig or tool seen for the
 * first time joins its default group (with settings.autoGroup on, unless the user dissolved that group); one that was
 * placed before — the user may have moved, ungrouped or hidden it, then it vanished (its machine restarting for an
 * update, asleep, the app stopped) and came back — returns to the spot it left (that group, or that place on the top
 * level; the end of the top level when the group is gone or the spot is unknown) and keeps being hidden if it was.
 * Default groups are never forced on a placed item.
 */
function place(d, item) {
  const before = d.placed[item.id];
  const spot = isObj(before) ? before : null;
  const home = before || !d.settings.autoGroup ? null : defaultGroupOf(item);
  if (before === 'hidden' || spot?.hidden) item.hidden = true;
  if (spot?.g && d.groups[spot.g]) {
    const g = d.groups[spot.g];
    const at = returnIndex(d, g.items, (x) => x, spot);
    insertAt(g.items, at >= 0 ? at : spot.i, item.id);
  } else if (spot && !spot.g && (Number.isInteger(spot.i) || 'after' in spot)) {
    const at = returnIndex(d, d.order, entryKey, spot);
    insertAt(d.order, at >= 0 ? at : spot.i, { type: 'item', id: item.id });
  }
  else if (home && !d.dismissed.includes(home.id)) intoDefault(d, item, home);
  else d.order.push({ type: 'item', id: item.id });
  if (DEFAULT_KINDS.includes(item.kind)) d.placed[item.id] = true;
}

/** Build an item from a source record of the given kind; null when the record has no usable key. */
export function toItem(kind, src) {
  if (!KINDS.includes(kind) || !isObj(src)) return null;
  const has = (v) => v !== undefined && v !== null && v !== '';
  if (!has(src.id)) return null;
  const key = String(src.id);
  let title; let icon = str(src.icon); let ref;
  if (kind === 'applet') {
    title = str(src.name, key);
    ref = { node: str(src.node), id: key, ...(str(src.category).trim() ? { category: src.category.trim() } : {}), ...(str(src.nodeName) ? { nodeName: src.nodeName } : {}) };
    return mk(kind, src.node ? `${src.node}/${key}` : key, title, icon, ref);
  }
  if (kind === 'tool') { title = str(src.title, key); ref = { action: str(src.action, key), button: str(src.button), hint: str(src.hint), ...(src.toggle ? { toggle: true } : {}), ...(src.badge ? { badge: true } : {}) }; }
  else if (kind === 'rig') { title = str(src.name, key); ref = { nodeId: key }; icon = icon || '◈'; }
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
  if (DEFAULT_KINDS.includes(item.kind)) d.placed[item.id] = true; // placed explicitly: no default group later
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

/**
 * Live display state of a tool: `badge` (a count or short text; 0, '' or null clears it) and/or `pressed` (a toggle's
 * on/off, e.g. voice muted). Only the keys given change. Never stored: serialize() leaves both out.
 */
export function setToolState(state, id, { badge, pressed } = {}) {
  const it = state.items[id];
  if (!it || it.kind !== 'tool') return state;
  const next = {};
  if (badge !== undefined) next.badge = (typeof badge === 'number' && Number.isFinite(badge) && badge > 0) || (typeof badge === 'string' && badge) ? badge : null;
  if (pressed !== undefined) next.pressed = pressed === null ? null : !!pressed;
  if (Object.keys(next).every((k) => (it[k] ?? null) === next[k])) return state;
  const d = draft(state);
  Object.assign(d.items[id], next);
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
  if (isDefaultGroup(gid) && !d.dismissed.includes(gid)) d.dismissed.push(gid); // the user took it apart: do not bring it back
  return d;
}

/**
 * The user's explicit "sort into default groups": every top-level applet, rig and tool that is not hidden moves into its
 * default group (a new group takes the slot of its first member). Items in any group — the user's or a default one —
 * and hidden items stay where they are. Dissolved default groups may come back (this is the user asking for them).
 */
export function applyDefaultGroups(state) {
  const d = draft(state);
  d.dismissed = [];
  for (const e of [...d.order]) {
    if (e.type !== 'item') continue;
    const item = d.items[e.id];
    const home = item && !item.hidden ? defaultGroupOf(item) : null;
    if (!home) continue;
    const at = topIndex(d, 'item', item.id);
    if (d.groups[home.id]) { d.order.splice(at, 1); intoDefault(d, item, home); continue; }
    d.groups[home.id] = { id: home.id, name: home.name, collapsed: false, items: [item.id] };
    d.order.splice(at, 1, { type: 'group', id: home.id });
  }
  return JSON.stringify(d.order) === JSON.stringify(state.order) && !(state.dismissed || []).length ? state : d;
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
    autoGroup: bool(r.autoGroup, fallback.autoGroup),
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

const SOURCE_KEYS = { tools: 'tool', applets: 'applet', rigs: 'rig', panels: 'panel', windows: 'window', terminals: 'terminal' };

/**
 * Fold the live sources into the state without disturbing the user's layout. `sources` may carry any of
 * { tools, applets, rigs, panels, windows, terminals } (arrays of the records described at the top; tools = TOOLS); a key
 * that is absent means "that source was not polled" and leaves its items alone.
 *   tools, applets,    new ones join their default group (see place(): only the first time an item is ever seen, and
 *   rigs               with autoGroup off they are appended to the top level instead); known ones keep their place,
 *                      group, pin and hide and only refresh title/icon/ref. Rigs count only while { online && rigs }.
 *   panels/windows/    never added by a merge (that is the user's choice, or auto-docking); items already in the dock
 *   terminals          get their title refreshed.
 * Items whose source is gone are removed — unless pinned, which keep their slot and turn `live: false`. An applet/rig/
 * tool that goes is remembered with its spot (and hidden flag) and comes back there (place()).
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
      else if (DEFAULT_KINDS.includes(kind)) { d.items[it.id] = it; place(d, it); }
    }
    for (const it of Object.values(d.items)) {
      if (it.kind !== kind || seen.has(it.id)) continue;
      if (it.pinned) it.live = false;
      else { if (DEFAULT_KINDS.includes(kind)) d.placed[it.id] = { ...spotOf(state, it.id), ...(it.hidden ? { hidden: true } : {}) }; detach(d, it.id); delete d.items[it.id]; }
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
// minimized windows

/**
 * A window was minimized: the dock is where it is reached again. `event` = { source: { id, title, icon } (the wm.js
 * window, or a JARVIS panel with `kind: 'panel'`: its item is a panel item), rep } where `rep` is the id of the item that already stands for that window (an applet tile for an app
 * window, a terminal item for a terminal). That item shows it minimized when it is a tile of its own (top level, not
 * hidden); otherwise — no such item, or it sits inside a group's popover — the window gets a window item of its own
 * (also with autoDock off), so a minimized window is always one click away. That item goes again when the window is
 * restored (unless pinned meanwhile). `minimized` / `transient` are display state: serialize() leaves them out.
 */
export function onMinimized(state, { source, rep, kind = 'window' } = {}) {
  if (typeof rep === 'string' && own(state.items, rep) && !state.items[rep].hidden && topIndex(state, 'item', rep) >= 0) return markMinimized(state, rep, true);
  const item = toItem(kind === 'panel' ? 'panel' : 'window', source);
  if (!item) return state;
  if (own(state.items, item.id)) return markMinimized(addItem(state, item), item.id, true); // already docked (autoDock / pinned): keep it as it is
  const d = draft(addItem(state, item));
  d.items[item.id].transient = true;
  d.items[item.id].minimized = true;
  return d;
}

/** The window is back on the stage (or closed): its item stops showing it minimized; an item added only for that goes. */
export function onRestored(state, { source, rep, kind = 'window' } = {}) {
  let s = state;
  if (typeof rep === 'string' && own(s.items, rep)) s = markMinimized(s, rep, false);
  const item = toItem(kind === 'panel' ? 'panel' : 'window', source);
  if (!item || !own(s.items, item.id)) return s;
  const it = s.items[item.id];
  if (it.transient && !it.pinned) return removeItem(s, item.id);
  if (!it.transient && !it.minimized) return s;
  const d = draft(s);
  delete d.items[item.id].transient;
  delete d.items[item.id].minimized;
  return d;
}

function markMinimized(state, id, on) {
  if (!!state.items[id].minimized === on) return state;
  const d = draft(state);
  if (on) d.items[id].minimized = true; else delete d.items[id].minimized;
  return d;
}

/** Ids of the items showing a minimized window right now. */
export const minimizedItems = (state) => Object.values(state.items).filter((it) => it.minimized).map((it) => it.id);

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
  // v1 → v2: tools and default groups. Everything else (items, groups, order, pins, hidden flags, settings) carries over
  // as it is. Every applet and rig already in the dock counts as placed — it sat where v1 (or the user) put it, and
  // v1 does not tell the two apart — so none of them is pulled into a default group; only items that were never in the
  // dock (all the tools, new applets and rigs) are seeded into theirs. "Sort into default groups" in the dock's settings
  // menu (applyDefaultGroups) groups the existing ones when the user asks.
  1(raw) {
    const placed = {};
    for (const id of isObj(raw.items) ? Object.keys(raw.items) : []) if (isItemId(id) && DEFAULT_KINDS.includes(id.slice(0, id.indexOf(':')))) placed[id] = true;
    return { ...raw, v: 2, placed, dismissed: [] };
  },
};

/** Validate and repair any value into a well-formed current-version state: bad fields fall back to defaults, dangling references are dropped. */
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
  const seen = {};
  for (const [id, v] of isObj(r.placed) ? Object.entries(r.placed) : []) {
    if (!isItemId(id)) continue;
    if (v === true || v === 'hidden') seen[id] = v;
    else if (isObj(v)) {
      seen[id] = {
        ...(isGroupId(v.g) ? { g: v.g } : {}), ...(Number.isInteger(v.i) && v.i >= 0 ? { i: v.i } : {}),
        ...(v.after === null || typeof v.after === 'string' ? { after: v.after } : {}), ...(v.hidden === true ? { hidden: true } : {}),
      };
    }
  }
  for (const it of Object.values(items)) if (DEFAULT_KINDS.includes(it.kind)) seen[it.id] = true; // in the dock = placed
  const dismissed = [...new Set((Array.isArray(r.dismissed) ? r.dismissed : []).filter(isDefaultGroup))];
  return { v: VERSION, nextGroup: Math.max(next, ...used), settings: sanitizeSettings(r.settings), items, groups, order, placed: seen, dismissed };
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
