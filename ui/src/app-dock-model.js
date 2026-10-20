// The app dock's render-side logic, pure (no DOM): which sources go in, where icons sit, what a drop does and what the
// menus offer. app-dock.js draws the dock from app-dock-state.js through these; tests in test/app-dock-ui.test.js.
import {
  createGroup, dockView, moveItem, reorder, renameGroup, setHidden, setPinned, setSettings, ungroup, POSITIONS,
} from './app-dock-state.js';

export const STORAGE_KEY = 'rigs.appdock';
export const ICON = 46; // px, an icon at rest on a desktop
export const MIN_ICON = 30; // icons shrink to this before the dock stops fitting
export const PHONE_ICON = 44; // a phone bar never magnifies; 44px = a finger-sized target
export const GAP = 6; // px between icons
export const PAD = 6; // px between the icons and the shelf's edge
export const EDGE = 6; // px between the shelf and the screen edge
export const RADIUS = 120; // magnification radius (px) at ICON size; scales with the icon size

/** The live sources mergeSources() takes, from the mesh snapshot: every app on the mesh (minus removed ones) and every machine. */
export function sourcesFromSnapshot(snap, { isRemoved = () => false } = {}) {
  const applets = [];
  const rigs = [];
  for (const e of Array.isArray(snap) ? snap : []) {
    const n = e?.node;
    if (!n?.id) continue;
    rigs.push({ id: n.id, name: n.name || n.id, online: !!n.online, rigs: !!n.rigs });
    for (const a of e.apps || []) {
      if (!a?.id || isRemoved({ ...a, node: n.name, nodeId: n.id })) continue;
      applets.push({ node: n.id, id: a.id, name: a.name || a.id, icon: a.icon || '' });
    }
  }
  return { applets, rigs };
}

/** 'x' for a bottom dock (icons left→right), 'y' for a side dock (top→bottom). */
export const axisOf = (position) => (position === 'bottom' ? 'x' : 'y');

/** Icon size that fits `count` tiles into `available` px along the axis, between `min` and `max`. */
export function fitIcon(count, available, { max = ICON, min = MIN_ICON } = {}) {
  if (!(count > 0) || !(available > 0)) return max;
  const per = (available - 2 * PAD - (count - 1) * GAP) / count;
  return Math.max(min, Math.min(max, Math.floor(per)));
}

/** Length of the shelf along its axis at rest. */
export const restLength = (count, size) => (count > 0 ? 2 * PAD + count * size + (count - 1) * GAP : 2 * PAD + size);

/**
 * Centres of the icons at rest along the axis, for a shelf centred on `centre`. The magnification reads these, never
 * the live (already magnified) positions, so growing icons do not feed back into their own scale.
 */
export function restCentres(count, size, centre) {
  const start = centre - restLength(count, size) / 2 + PAD;
  return Array.from({ length: count }, (_, i) => start + i * (size + GAP) + size / 2);
}

/** Ease displayed scales toward the targets; `dt` in ms. Returns [next, settled]. */
export function easeScales(current, target, dt, tau = 70) {
  const k = 1 - Math.exp(-Math.max(0, dt) / tau);
  let settled = true;
  const next = target.map((t, i) => {
    const c = Number.isFinite(current[i]) ? current[i] : 1;
    const v = c + (t - c) * k;
    if (Math.abs(t - v) > 0.002) { settled = false; return v; }
    return t;
  });
  return [next, settled];
}

/**
 * Where a drag would land. `slots` = the dock's top-level tiles in order, [{ type, id, start, end }] along the axis
 * (current rects). An item over the middle half of another tile → { kind: 'onto', index }; otherwise
 * { kind: 'before', index } (index = the slot it goes before; slots.length = the end). The dragged tile is never a target.
 */
export function dropAt(slots, pos, dragged = null) {
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    const len = s.end - s.start;
    const self = dragged && s.type === dragged.type && s.id === dragged.id;
    if (!self && dragged?.type === 'item' && pos >= s.start + len * 0.25 && pos <= s.end - len * 0.25) return { kind: 'onto', index: i };
    if (pos < s.start + len / 2) return { kind: 'before', index: i };
  }
  return { kind: 'before', index: slots.length };
}

/** A name for a group made by dropping one item onto another: same kind → 'Applets' / 'Rigs'; else 'Group'. */
export function groupNameFor(a, b) {
  const names = { applet: 'Applets', rig: 'Rigs', panel: 'Panels', window: 'Windows', terminal: 'Terminals' };
  return a && b && a.kind === b.kind ? names[a.kind] || 'Group' : 'Group';
}

export const orderIndex = (state, type, id) => state.order.findIndex((e) => e.type === type && e.id === id);

/** The group an item sits in, or null when it is at the top level. */
export const groupOf = (state, id) => Object.values(state.groups).find((g) => g.items.includes(id)) || null;

const viewId = (v) => (v.type === 'group' ? v.group.id : v.item.id);

/**
 * Apply a finished drag. `dragged` = { type: 'item'|'group', id, group (the group it came out of, or null) };
 * `drop` from dropAt over the dock's visible top level, `view` = dockView(state) (the slots the drop indexes), or
 * { kind: 'group', group, index } for a drop inside an open group's popover.
 */
export function applyDrop(state, dragged, drop, view = dockView(state)) {
  if (!dragged || !drop) return state;
  const isItem = dragged.type === 'item';
  if (drop.kind === 'group') return isItem ? moveItem(state, dragged.id, { group: drop.group, index: drop.index }) : state;
  const target = view[drop.index];
  if (drop.kind === 'onto' && isItem && target) {
    if (target.type === 'group') return target.group.id === dragged.group ? state : moveItem(state, dragged.id, { group: target.group.id });
    const over = target.item;
    if (over.id === dragged.id) return state;
    // Put the dragged item right after the one it was dropped on, so the new group takes the target's place.
    const s = moveItem(state, dragged.id, { group: null, index: orderIndex(state, 'item', over.id) + 1 });
    return createGroup(s, { name: groupNameFor(over, state.items[dragged.id]), items: [over.id, dragged.id] });
  }
  // A view index → an index in the full top-level order (hidden items sit in `order` but not in the view).
  const before = view[drop.index];
  const at = before ? orderIndex(state, before.type, viewId(before)) : state.order.length;
  const from = orderIndex(state, dragged.type, dragged.id);
  if (isItem && (dragged.group || from < 0)) return moveItem(state, dragged.id, { group: null, index: at });
  if (from < 0) return state;
  return reorder(state, dragged.type, dragged.id, at > from ? at - 1 : at);
}

/** Move a top-level entry one step back (-1) or forward (+1) among the visible entries. */
export function nudge(state, type, id, step) {
  const view = dockView(state);
  const i = view.findIndex((v) => v.type === type && viewId(v) === id);
  const other = view[i + step];
  if (i < 0 || !other) return state;
  return reorder(state, type, id, orderIndex(state, other.type, viewId(other)));
}

/** Move an item one step inside its group. */
export function nudgeInGroup(state, id, step) {
  const g = groupOf(state, id);
  if (!g) return state;
  const j = g.items.indexOf(id) + step;
  if (j < 0 || j >= g.items.length) return state;
  return moveItem(state, id, { group: g.id, index: j });
}

/** Rename used by the popover's title field (blank names are ignored by the state module). */
export const rename = (state, gid, name) => renameGroup(state, gid, name);

/** Space (px) panels keep clear on each edge for a dock that stays on screen; none while auto-hidden or on a phone. */
export function reserve(settings, { phone = false, size = ICON } = {}) {
  const r = { left: 0, right: 0, bottom: 0 };
  if (phone || settings.autoHide) return r;
  r[settings.position] = size + 2 * PAD + EDGE;
  return r;
}

// ---------------------------------------------------------------------------------------------------------------
// menus — entries in the shape menubar.js openMenuAt takes ({ label, run, icon?, checked?, disabled?, hint?, submenu? }
// | { sep: true }). `act(fn)` applies `fn(state) → state` to the dock; `ui` carries the DOM-side actions.

const SEP = { sep: true };
export const STRENGTHS = [['Small', 0.3], ['Medium', 0.6], ['Large', 1]];
const LABEL = { left: 'Left', bottom: 'Bottom', right: 'Right' };
const steps = (state, phone) => (state.settings.position === 'bottom' || phone ? ['left', 'right'] : ['up', 'down']);

/** The dock's own settings: position, auto-hide, magnification (+ size), hidden items. */
export function settingsEntries(state, act, { phone = false, reducedMotion = false } = {}) {
  const st = state.settings;
  const hidden = Object.values(state.items).filter((it) => it.hidden);
  const nearest = STRENGTHS.reduce((a, b) => (Math.abs(b[1] - st.magnifyStrength) < Math.abs(a[1] - st.magnifyStrength) ? b : a))[1];
  return [
    { label: 'Position on screen', icon: '⇲', ...(phone ? { hint: 'bottom on phones' } : {}),
      submenu: () => POSITIONS.map((p) => ({ label: LABEL[p], checked: st.position === p, run: () => act((s) => setSettings(s, { position: p })) })) },
    { label: 'Automatically hide and show', checked: st.autoHide, ...(phone ? { hint: 'stays on phones' } : {}), run: () => act((s) => setSettings(s, { autoHide: !s.settings.autoHide })) },
    { label: 'Magnification', checked: st.magnification, ...(phone ? { hint: 'off on phones' } : reducedMotion ? { hint: 'off: reduced motion' } : {}),
      run: () => act((s) => setSettings(s, { magnification: !s.settings.magnification })) },
    { label: 'Magnification size', disabled: !st.magnification,
      submenu: () => STRENGTHS.map(([label, v]) => ({ label, checked: nearest === v, run: () => act((s) => setSettings(s, { magnifyStrength: v })) })) },
    SEP,
    { label: 'Dock new panels and windows', hint: 'automatic', checked: st.autoDock, run: () => act((s) => setSettings(s, { autoDock: !s.settings.autoDock })) },
    { label: 'Tab auto-opened terminals together', hint: 'automatic', checked: st.autoTabTerminals, run: () => act((s) => setSettings(s, { autoTabTerminals: !s.settings.autoTabTerminals })) },
    SEP,
    { label: `Hidden items${hidden.length ? ` (${hidden.length})` : ''}`, submenu: () => (hidden.length
      ? [...hidden.map((it) => ({ label: `Show ${it.title}`, icon: it.icon || '', run: () => act((s) => setHidden(s, it.id, false)) })), SEP,
        { label: 'Show all', run: () => act((s) => hidden.reduce((x, h) => setHidden(x, h.id, false), s)) }]
      : [{ label: 'Nothing hidden', disabled: true }]) },
  ];
}

/** Whether a tile can be opened: live items, and a pinned panel that was closed (it can be shown again; windows and terminals cannot). */
export const canOpen = (it) => !!it && (it.live || it.kind === 'panel');

/** An item's dock entries: open, pin, hide, grouping, moving. */
export function itemEntries(state, id, act, ui = {}) {
  const it = state.items[id];
  if (!it) return [];
  const g = groupOf(state, id);
  const others = Object.values(state.groups).filter((x) => x.id !== g?.id);
  const [back, fwd] = steps(state, ui.phone);
  return [
    ui.open ? { label: canOpen(it) ? 'Open' : `Open (${it.kind === 'rig' ? 'offline' : 'not available'})`, icon: it.icon || '▦', disabled: !canOpen(it), run: () => ui.open(it) } : null,
    SEP,
    { label: 'Keep in dock (pin)', checked: it.pinned, run: () => act((s) => setPinned(s, id, !s.items[id]?.pinned)) },
    { label: 'Hide from dock', icon: '🙈', run: () => act((s) => setHidden(s, id, true)) },
    SEP,
    { label: 'Move to group', icon: '🗂', submenu: () => [
      ...others.map((x) => ({ label: x.name, run: () => act((s) => moveItem(s, id, { group: x.id })) })),
      ...(others.length ? [SEP] : []),
      { label: 'New group', run: () => act((s) => createGroup(s, { name: 'Group', items: [id] })) },
    ] },
    g ? { label: `Take out of “${g.name}”`, icon: '⇱', run: () => act((s) => moveItem(s, id, { group: null, index: orderIndex(s, 'group', g.id) + 1 })) } : null,
    { label: `Move ${back}`, run: () => act((s) => (g ? nudgeInGroup(s, id, -1) : nudge(s, 'item', id, -1))) },
    { label: `Move ${fwd}`, run: () => act((s) => (g ? nudgeInGroup(s, id, 1) : nudge(s, 'item', id, 1))) },
  ].filter(Boolean);
}

/** A group's entries: open, rename, ungroup, move. */
export function groupEntries(state, gid, act, ui = {}) {
  const g = state.groups[gid];
  if (!g) return [];
  const [back, fwd] = steps(state, ui.phone);
  return [
    ui.openGroup ? { label: `Open “${g.name}”`, icon: '🗂', run: () => ui.openGroup(gid) } : null,
    ui.rename ? { label: 'Rename group…', icon: '✎', run: () => ui.rename(gid) } : null,
    { label: 'Ungroup', icon: '⇱', run: () => act((s) => ungroup(s, gid)) },
    SEP,
    { label: `Move ${back}`, run: () => act((s) => nudge(s, 'group', gid, -1)) },
    { label: `Move ${fwd}`, run: () => act((s) => nudge(s, 'group', gid, 1)) },
  ].filter(Boolean);
}
