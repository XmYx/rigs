// Dock layout engine (pure, no DOM): the model behind dockable, tabbed and floating JARVIS panels.
//
// A layout is plain JSON:
//   { version: 2,
//     root: Node | null,                  // the docked tree
//     floating: [{ id, x, y, w, h, z, vw, vh }],  // free panels; vw/vh = viewport they were placed in
//     hidden: { [id]: Place },            // closed panels and where they were, so restore puts them back
//     collapsed: [id],                    // panels folded to their header (kept from rigs.panels)
//     windows: { [key]: WindowRecord } }  // wm.js windows by stable key: state + rect (window-state.js), version 2
// Version 1 (no `windows`) and the older 'rigs.panels' state are migrated on load.
// Node = { type: 'split', dir: 'row' | 'column', ratios: [n], children: [Node] }
//      | { type: 'tabs', panels: [id], active: id }
//      | { type: 'panel', id }
// Invariants (normalize): no empty or single-panel tab groups (one tab = a plain panel), no split with
// fewer than two children, ratios positive and summing to 1, every panel id in exactly one place.
//
// Every operation returns a new layout and never mutates its input. The command API at the bottom
// (dockPanel, floatPanel, hidePanel, restorePanel, resetLayout, listPanels) wraps them in a store
// with optional localStorage-style persistence for the UI, the top menu and context menus.

import { normalizeWindows, normalizeRecord, putWindow } from './window-state.js';

export const VERSION = 2;
export const STORAGE_KEY = 'rigs.dock';
export const LEGACY_KEY = 'rigs.panels';
export const ZONES = ['left', 'right', 'top', 'bottom', 'center'];
export const DEFAULT_MIN = { w: 160, h: 48 }; // same as panels.js MIN_W / MIN_H

const MIN_RATIO = 0.02;
const clone = (v) => JSON.parse(JSON.stringify(v));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isId = (v) => typeof v === 'string' && v.length > 0;

export function emptyLayout() {
  return { version: VERSION, root: null, floating: [], hidden: {}, collapsed: [], windows: {} };
}

// ---------------------------------------------------------------- tree helpers

/** Panel ids under a node, in visual order. */
export function panelsIn(node) {
  if (!node) return [];
  if (node.type === 'panel') return [node.id];
  if (node.type === 'tabs') return [...node.panels];
  return node.children.flatMap(panelsIn);
}

/** Node at a path of child indices (root = []). */
export function nodeAt(layout, path) {
  let n = layout.root;
  for (const i of path) n = n?.type === 'split' ? n.children[i] : undefined;
  return n ?? null;
}

/** Path to the leaf or tab group that holds a panel, or null when it is not docked. */
export function pathOf(layout, id) {
  const walk = (n, path) => {
    if (!n) return null;
    if (n.type === 'panel') return n.id === id ? path : null;
    if (n.type === 'tabs') return n.panels.includes(id) ? path : null;
    for (let i = 0; i < n.children.length; i++) {
      const p = walk(n.children[i], [...path, i]);
      if (p) return p;
    }
    return null;
  };
  return walk(layout.root, []);
}

function setAt(layout, path, node) {
  if (!path.length) { layout.root = node; return; }
  nodeAt(layout, path.slice(0, -1)).children[path[path.length - 1]] = node;
}

/** Path of the smallest node that holds every one of these panels (those still docked). */
function lcaPath(layout, ids) {
  const paths = ids.map((id) => pathOf(layout, id)).filter(Boolean);
  if (!paths.length) return null;
  const out = [];
  for (let d = 0; ; d++) {
    const v = paths[0][d];
    if (v === undefined || paths.some((p) => p[d] !== v)) return out;
    out.push(v);
  }
}

function normRatios(ratios, n) {
  const r = Array.from({ length: n }, (_, i) => {
    const v = num(ratios?.[i]);
    return v && v > 0 ? v : 0;
  });
  const sum = r.reduce((a, b) => a + b, 0);
  if (!(sum > 0) || r.some((v) => v <= 0)) return Array(n).fill(1 / n);
  return r.map((v) => v / sum);
}

/** Collapse single-child splits and empty / one-panel tab groups; fix ratios. Returns a node or null. */
export function normalize(node) {
  if (!node) return null;
  if (node.type === 'panel') return isId(node.id) ? { type: 'panel', id: node.id } : null;
  if (node.type === 'tabs') {
    const panels = [...new Set((node.panels || []).filter(isId))];
    if (!panels.length) return null;
    if (panels.length === 1) return { type: 'panel', id: panels[0] };
    return { type: 'tabs', panels, active: panels.includes(node.active) ? node.active : panels[0] };
  }
  if (node.type === 'split') {
    const kids = [];
    const ratios = [];
    (node.children || []).forEach((c, i) => {
      const k = normalize(c);
      if (k) { kids.push(k); ratios.push(node.ratios?.[i]); }
    });
    if (!kids.length) return null;
    if (kids.length === 1) return kids[0];
    return { type: 'split', dir: node.dir === 'column' ? 'column' : 'row', ratios: normRatios(ratios, kids.length), children: kids };
  }
  return null;
}

function topZ(layout) { return layout.floating.reduce((m, f) => Math.max(m, num(f.z) ?? 0), 0); }

function rectOf(r = {}) {
  return { x: num(r.x), y: num(r.y), w: num(r.w), h: num(r.h), vw: num(r.vw), vh: num(r.vh) };
}

/** Where a panel is now: 'docked' | 'floating' | 'hidden' | null. */
export function panelStatus(layout, id) {
  if (pathOf(layout, id)) return 'docked';
  if (layout.floating.some((f) => f.id === id)) return 'floating';
  if (layout.hidden[id]) return 'hidden';
  return null;
}

// ---------------------------------------------------------------- detach / attach

/**
 * Take a panel out of wherever it is. Returns { layout, place } — `place` records enough to put it back
 * exactly (see restore). Works on a copy.
 */
function detach(input, id) {
  const layout = clone(input);
  layout.collapsed = layout.collapsed || [];
  const fi = layout.floating.findIndex((f) => f.id === id);
  if (fi >= 0) {
    const [f] = layout.floating.splice(fi, 1);
    return { layout, place: { kind: 'float', rect: rectOf(f) } };
  }
  if (layout.hidden[id]) {
    const place = layout.hidden[id];
    delete layout.hidden[id];
    return { layout, place };
  }
  const path = pathOf(layout, id);
  if (!path) return { layout, place: null };
  const node = nodeAt(layout, path);
  let place;
  if (node.type === 'tabs') {
    const index = node.panels.indexOf(id);
    place = { kind: 'tab', anchors: node.panels.filter((p) => p !== id), index, active: node.active === id };
    node.panels.splice(index, 1);
    if (node.active === id) node.active = node.panels[Math.min(index, node.panels.length - 1)];
  } else if (!path.length) {
    place = { kind: 'root' };
    layout.root = null;
  } else {
    const parent = nodeAt(layout, path.slice(0, -1));
    const i = path[path.length - 1];
    const after = i > 0;
    const sibling = parent.children[after ? i - 1 : i + 1];
    place = { kind: 'split', dir: parent.dir, side: after ? 'after' : 'before', share: parent.ratios[i], anchors: panelsIn(sibling), wrap: parent.children.length === 2 };
    parent.children.splice(i, 1);
    parent.ratios.splice(i, 1);
  }
  layout.root = normalize(layout.root);
  return { layout, place };
}

const clampShare = (share, def = 0.5) => Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, num(share) ?? def));

/**
 * Put `leaf` next to the node at `path`. Same-direction parent: it becomes a sibling. `own` = it takes
 * `share` of the target's slot (docking); otherwise it takes `share` of the whole parent and every
 * sibling shrinks evenly (restoring a hidden panel's exact ratio). `wrap` forces a new split.
 */
function insertBeside(layout, path, leaf, dir, after, share, { wrap = false, own = true } = {}) {
  const target = nodeAt(layout, path);
  const parent = path.length ? nodeAt(layout, path.slice(0, -1)) : null;
  // A restore puts back the exact share it recorded; a new dock keeps both sides at least 2%.
  const s = own ? clampShare(share) : Math.min(1 - 1e-9, Math.max(1e-9, num(share) ?? 0.5));
  if (!wrap && parent && parent.dir === dir) {
    const i = path[path.length - 1];
    let mine;
    if (own) { mine = parent.ratios[i] * s; parent.ratios[i] -= mine; } else { mine = s; parent.ratios = parent.ratios.map((r) => r * (1 - s)); }
    parent.children.splice(after ? i + 1 : i, 0, leaf);
    parent.ratios.splice(after ? i + 1 : i, 0, mine);
    return;
  }
  const children = after ? [target, leaf] : [leaf, target];
  const ratios = after ? [1 - s, s] : [s, 1 - s];
  setAt(layout, path, { type: 'split', dir, ratios, children });
}

function addTab(layout, path, id, index, makeActive) {
  const node = nodeAt(layout, path);
  const tabs = node.type === 'tabs' ? node : { type: 'tabs', panels: [node.id], active: node.id };
  const at = Math.max(0, Math.min(num(index) ?? tabs.panels.length, tabs.panels.length));
  tabs.panels.splice(at, 0, id);
  if (makeActive) tabs.active = id;
  setAt(layout, path, tabs);
}

function dockAtRoot(layout, id, zone = 'right', share = 0.3) {
  const leaf = { type: 'panel', id };
  if (!layout.root) { layout.root = leaf; return; }
  if (zone === 'center') {
    if (layout.root.type === 'split') { dockAtRoot(layout, id, 'right', share); return; }
    addTab(layout, [], id, null, true);
    return;
  }
  const { dir, after } = zoneDir(zone);
  insertBeside(layout, [], leaf, dir, after, share, { wrap: true });
}

function zoneDir(zone) {
  return { dir: zone === 'left' || zone === 'right' ? 'row' : 'column', after: zone === 'right' || zone === 'bottom' };
}

function canonZone(zone) {
  if (zone === 'tab') return 'center';
  return ZONES.includes(zone) ? zone : null;
}

function finish(layout) {
  layout.root = normalize(layout.root);
  return layout;
}

// ---------------------------------------------------------------- operations

/**
 * Dock `id` against `targetId` (a docked panel; 'root' or null = the whole layout) in a zone:
 * left | right | top | bottom split the target's area, center (alias 'tab') adds it as a tab.
 * `share` = the new panel's part of the split (default 0.5, or 0.3 against the root).
 */
export function dock(layout, id, targetId, zone, { share } = {}) {
  const z = canonZone(zone);
  if (!isId(id) || !z || id === targetId) return layout;
  const { layout: out } = detach(layout, id);
  const tpath = isId(targetId) && targetId !== 'root' ? pathOf(out, targetId) : null;
  if (!tpath) { dockAtRoot(out, id, z, share ?? 0.3); return finish(out); }
  if (z === 'center') { addTab(out, tpath, id, null, true); return finish(out); }
  const { dir, after } = zoneDir(z);
  insertBeside(out, tpath, { type: 'panel', id }, dir, after, share ?? 0.5);
  return finish(out);
}

/** Take a panel out of the tree (or hidden) and float it at `rect` ({x, y, w, h, vw, vh}), on top. */
export function undock(layout, id, rect = {}) {
  if (!isId(id)) return layout;
  const { layout: out, place } = detach(layout, id);
  const prev = place?.kind === 'float' ? place.rect : {};
  out.floating.push({ id, ...rectOf({ ...prev, ...rect }), z: topZ(out) + 1 });
  return out;
}

/** Move a panel into the tab group of `targetId` at `index` (end when omitted) and make it active. */
export function moveTab(layout, id, targetId, index) {
  if (!isId(id) || id === targetId || !pathOf(layout, targetId)) return layout;
  const { layout: out } = detach(layout, id);
  addTab(out, pathOf(out, targetId), id, index, true);
  return finish(out);
}

/** Change a panel's position among its tabs, or (as a plain panel in a split) among the split's children. */
export function reorder(layout, id, index) {
  const path = pathOf(layout, id);
  if (!path) return layout;
  const out = clone(layout);
  const node = nodeAt(out, path);
  if (node.type === 'tabs') {
    const i = node.panels.indexOf(id);
    node.panels.splice(i, 1);
    node.panels.splice(Math.max(0, Math.min(index, node.panels.length)), 0, id);
    return out;
  }
  if (!path.length) return layout;
  const parent = nodeAt(out, path.slice(0, -1));
  const i = path[path.length - 1];
  const j = Math.max(0, Math.min(index, parent.children.length - 1));
  const [c] = parent.children.splice(i, 1);
  const [r] = parent.ratios.splice(i, 1);
  parent.children.splice(j, 0, c);
  parent.ratios.splice(j, 0, r);
  return out;
}

export function setActiveTab(layout, id) {
  const path = pathOf(layout, id);
  const node = path && nodeAt(layout, path);
  if (node?.type !== 'tabs' || node.active === id) return layout;
  const out = clone(layout);
  nodeAt(out, path).active = id;
  return out;
}

/** Set the ratios of the split at `path` (normalised; each child keeps at least 2%). */
export function resizeSplit(layout, path, ratios) {
  const node = nodeAt(layout, path || []);
  if (node?.type !== 'split' || !Array.isArray(ratios) || ratios.length !== node.children.length) return layout;
  const out = clone(layout);
  const r = normRatios(ratios.map((v) => Math.max(num(v) ?? 0, MIN_RATIO)), ratios.length);
  nodeAt(out, path || []).ratios = normRatios(r.map((v) => Math.max(v, MIN_RATIO)), r.length);
  return out;
}

/** Close a panel, remembering exactly where it was. */
export function hide(layout, id) {
  if (layout.hidden[id] || !panelStatus(layout, id)) return layout;
  const { layout: out, place } = detach(layout, id);
  out.hidden[id] = place;
  return out;
}

/** Bring a hidden panel back to the place it was hidden from (same tree position or floating rect). */
export function restore(layout, id) {
  const place = layout.hidden[id];
  if (!place) return layout;
  const out = clone(layout);
  delete out.hidden[id];
  const leaf = { type: 'panel', id };
  if (place.kind === 'float') {
    out.floating.push({ id, ...rectOf(place.rect), z: topZ(out) + 1 });
    return out;
  }
  if (place.kind === 'root' || !out.root) { dockAtRoot(out, id); return finish(out); }
  const anchors = (place.anchors || []).filter(isId);
  if (place.kind === 'tab') {
    let path = lcaPath(out, anchors);
    if (path && nodeAt(out, path).type === 'split') path = pathOf(out, anchors.find((a) => pathOf(out, a)));
    if (path) { addTab(out, path, id, place.index, place.active); return finish(out); }
  }
  if (place.kind === 'split') {
    const path = lcaPath(out, anchors);
    if (path) {
      insertBeside(out, path, leaf, place.dir === 'column' ? 'column' : 'row', place.side === 'after', place.share, { wrap: !!place.wrap, own: false });
      return finish(out);
    }
  }
  dockAtRoot(out, id);
  return finish(out);
}

/** Forget a panel everywhere (tree, floating, hidden). */
export function removePanel(layout, id) {
  const { layout: out } = detach(layout, id);
  out.collapsed = out.collapsed.filter((c) => c !== id);
  return out;
}

export function setFloatingRect(layout, id, rect) {
  const i = layout.floating.findIndex((f) => f.id === id);
  if (i < 0) return layout;
  const out = clone(layout);
  out.floating[i] = { ...out.floating[i], ...rectOf({ ...out.floating[i], ...rect }) };
  return out;
}

export function raise(layout, id) {
  const i = layout.floating.findIndex((f) => f.id === id);
  const top = topZ(layout);
  if (i < 0 || (layout.floating[i].z === top && layout.floating.filter((f) => f.z === top).length === 1)) return layout;
  const out = clone(layout);
  out.floating[i].z = top + 1;
  return out;
}

export function setCollapsed(layout, id, collapsed) {
  const has = layout.collapsed.includes(id);
  if (has === !!collapsed) return layout;
  const out = clone(layout);
  out.collapsed = collapsed ? [...out.collapsed, id] : out.collapsed.filter((c) => c !== id);
  return out;
}

/** Store a wm.js window's state record under its stable key (window-state.js); null forgets it. */
export function setWindow(layout, key, rec) {
  const windows = putWindow(layout.windows || {}, key, rec);
  return windows === layout.windows ? layout : { ...layout, windows };
}

/** Add panels the layout has never seen as floating with no rect (the UI keeps its CSS default place). */
export function ensurePanels(layout, ids, { hidden = [] } = {}) {
  const missing = ids.filter((id) => isId(id) && !panelStatus(layout, id));
  if (!missing.length) return layout;
  const out = clone(layout);
  for (const id of missing) {
    if (hidden.includes(id)) out.hidden[id] = { kind: 'float', rect: rectOf({}) };
    else out.floating.push({ id, ...rectOf({}), z: topZ(out) + 1 });
  }
  return out;
}

/** Every panel the layout knows, with where it is. */
export function listLayoutPanels(layout) {
  const out = [];
  for (const id of panelsIn(layout.root)) out.push({ id, status: 'docked', path: pathOf(layout, id) });
  for (const f of [...layout.floating].sort((a, b) => (a.z ?? 0) - (b.z ?? 0))) out.push({ id: f.id, status: 'floating' });
  for (const id of Object.keys(layout.hidden)) out.push({ id, status: 'hidden' });
  for (const p of out) p.collapsed = layout.collapsed.includes(p.id);
  return out;
}

// ---------------------------------------------------------------- drop zones

/**
 * Which of the five zones a pointer is over: center when it is at least `edge` (fraction of the size)
 * from every side, else the nearest side. null outside the rect. rect: {x,y,w,h} or {left,top,width,height}.
 */
export function dropZoneAt(rect, point, { edge = 0.25 } = {}) {
  const x = num(rect?.x) ?? num(rect?.left);
  const y = num(rect?.y) ?? num(rect?.top);
  const w = num(rect?.w) ?? num(rect?.width);
  const h = num(rect?.h) ?? num(rect?.height);
  const px = num(point?.x);
  const py = num(point?.y);
  if ([x, y, w, h, px, py].includes(null) || w <= 0 || h <= 0) return null;
  const fx = (px - x) / w;
  const fy = (py - y) / h;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  const d = [['left', fx], ['right', 1 - fx], ['top', fy], ['bottom', 1 - fy]];
  const [side, dist] = d.reduce((a, b) => (b[1] < a[1] ? b : a));
  return dist >= edge ? 'center' : side;
}

// ---------------------------------------------------------------- sizes and the fit solver

/** Minimum size of a docked node: splits add along their axis, tabs take the largest child. */
export function minSizeOf(node, mins = {}, def = DEFAULT_MIN) {
  if (!node) return { w: 0, h: 0 };
  const own = (id) => ({ w: num(mins[id]?.w) ?? def.w, h: num(mins[id]?.h) ?? def.h });
  if (node.type === 'panel') return own(node.id);
  if (node.type === 'tabs') {
    const s = node.panels.map(own);
    return { w: Math.max(...s.map((v) => v.w)), h: Math.max(...s.map((v) => v.h)) };
  }
  const s = node.children.map((c) => minSizeOf(c, mins, def));
  const along = node.dir === 'row' ? 'w' : 'h';
  const across = along === 'w' ? 'h' : 'w';
  return { [along]: s.reduce((a, v) => a + v[along], 0), [across]: Math.max(...s.map((v) => v[across])) };
}

/** Split `total` by ratios, never giving a child less than its minimum (the rest shared by ratio). */
export function allocate(total, ratios, mins) {
  const n = ratios.length;
  const minSum = mins.reduce((a, b) => a + b, 0);
  if (minSum >= total) return minSum > 0 ? mins.map((m) => (m / minSum) * total) : ratios.map((r) => r * total);
  const fixed = Array(n).fill(false);
  let sizes = ratios.map((r) => r * total);
  for (let pass = 0; pass < n; pass++) {
    let changed = false;
    sizes.forEach((s, i) => { if (!fixed[i] && s < mins[i]) { fixed[i] = true; changed = true; } });
    if (!changed) break;
    const left = total - mins.reduce((a, m, i) => a + (fixed[i] ? m : 0), 0);
    const freeRatio = ratios.reduce((a, r, i) => a + (fixed[i] ? 0 : r), 0);
    sizes = ratios.map((r, i) => (fixed[i] ? mins[i] : (r / freeRatio) * left));
  }
  return sizes;
}

/** Rect of every docked panel inside `rect` ({x, y, w, h}); tab-group members share their group's rect. */
export function layoutTree(node, rect, mins = {}, def = DEFAULT_MIN) {
  const out = {};
  const walk = (n, r) => {
    if (!n) return;
    if (n.type === 'panel') { out[n.id] = { ...r }; return; }
    if (n.type === 'tabs') { for (const id of n.panels) out[id] = { ...r }; return; }
    const along = n.dir === 'row' ? 'w' : 'h';
    const sizes = allocate(r[along], n.ratios, n.children.map((c) => minSizeOf(c, mins, def)[along]));
    let at = n.dir === 'row' ? r.x : r.y;
    n.children.forEach((c, i) => {
      const cr = n.dir === 'row' ? { x: at, y: r.y, w: sizes[i], h: r.h } : { x: r.x, y: at, w: r.w, h: sizes[i] };
      at += sizes[i];
      walk(c, cr);
    });
  };
  walk(node, rect);
  return out;
}

/**
 * A floating rect as the fit solver should see it on this viewport: a panel placed on a screen at least as
 * big as this one keeps its viewport (it shrinks proportionally), a panel placed on a smaller screen is
 * treated as placed on this one — homes never stretch, so a window that grows past where a panel was put
 * leaves it exactly there instead of pushing it right and down. Rects without a size pass through.
 */
export function fitHome(f, viewport) {
  const vw = num(viewport?.w) ?? 1;
  const vh = num(viewport?.h) ?? 1;
  if (!f || [f.x, f.y, f.w, f.h].some((v) => num(v) === null)) return f;
  return { ...f, vw: Math.max(num(f.vw) ?? vw, vw), vh: Math.max(num(f.vh) ?? vh, vh) };
}

/**
 * Keep every visible panel fully on screen.
 *   viewport  {w, h}             the window now
 *   floating  [{id,x,y,w,h,z,vw,vh}]  home rects (vw/vh: viewport they were placed in; default = now).
 *                                 Entries without a rect (CSS default place) pass through untouched.
 *   root      the docked tree (optional), laid out in dockRect (default: the whole viewport)
 *   mins      {id: {w, h}} per-panel minimum sizes (default DEFAULT_MIN)
 *   mode      'off' (rects as given) | 'fit'
 * Returns { scale, floating: [{id,x,y,w,h,z}], docked: {id: rect} }, all in screen pixels. With scale < 1
 * the UI draws each panel's content scaled by `scale` inside its rect.
 *
 * Fit first moves each panel proportionally (its centre keeps its fraction of the viewport) and shrinks it
 * toward its minimum only when it does not fit; only if minimums still overflow does everything scale down
 * by one shared factor. The result is a pure, continuous function of the inputs — no state, no packing —
 * so a small resize moves panels a few pixels at most, and the left-to-right / top-to-bottom order of panel
 * centres stays as it was at home.
 */
export function solveFit({ viewport, floating = [], root = null, dockRect = null, mins = {}, mode = 'fit', margin = 0, defaultMin = DEFAULT_MIN } = {}) {
  const vw = Math.max(1, num(viewport?.w) ?? 1);
  const vh = Math.max(1, num(viewport?.h) ?? 1);
  const area = dockRect ? { x: dockRect.x, y: dockRect.y, w: dockRect.w, h: dockRect.h } : { x: 0, y: 0, w: vw, h: vh };
  const own = (id) => ({ w: num(mins[id]?.w) ?? defaultMin.w, h: num(mins[id]?.h) ?? defaultMin.h });
  const placed = floating.filter((f) => [f.x, f.y, f.w, f.h].every((v) => num(v) !== null));
  const unplaced = floating.filter((f) => !placed.includes(f)).map((f) => ({ ...f }));

  if (mode !== 'fit') {
    return { scale: 1, floating: [...placed.map((f) => ({ ...f })), ...unplaced], docked: layoutTree(root, area, mins, defaultMin) };
  }

  let scale = 1;
  if (root) {
    const dm = minSizeOf(root, mins, defaultMin);
    scale = Math.min(scale, area.w / dm.w, area.h / dm.h);
  }
  for (const f of placed) {
    const m = own(f.id);
    scale = Math.min(scale, Math.max(1, vw - 2 * margin) / Math.min(m.w, f.w), Math.max(1, vh - 2 * margin) / Math.min(m.h, f.h));
  }
  scale = Math.max(0.05, Math.min(1, scale));

  // Solve in a virtual viewport of size viewport / scale, then map back to screen pixels.
  const axis = (pos, size, refKey, view) => {
    const V = view / scale;
    const items = placed.map((f) => {
      const ref = num(f[refKey]) || view;
      const len = Math.max(Math.min(f[size], own(f.id)[size]), Math.min(f[size], V - 2 * margin));
      const frac = (f[pos] + f[size] / 2) / ref;
      const lo = margin + len / 2;
      const hi = Math.max(lo, V - margin - len / 2);
      return { id: f.id, frac, len, lo, hi, c: Math.min(Math.max(frac * V, lo), hi) };
    });
    // Keep the home order of centres: clamping alone can push a wide panel past a narrow one.
    const order = [...items].sort((a, b) => a.frac - b.frac || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (let k = 1; k < order.length; k++) order[k].c = Math.min(Math.max(order[k].c, order[k - 1].c), order[k].hi);
    for (let k = order.length - 2; k >= 0; k--) order[k].c = Math.max(Math.min(order[k].c, order[k + 1].c), order[k].lo);
    return new Map(items.map((it) => [it.id, it]));
  };
  const ax = axis('x', 'w', 'vw', vw);
  const ay = axis('y', 'h', 'vh', vh);
  const out = placed.map((f) => {
    const X = ax.get(f.id);
    const Y = ay.get(f.id);
    return { ...f, x: (X.c - X.len / 2) * scale, y: (Y.c - Y.len / 2) * scale, w: X.len * scale, h: Y.len * scale };
  });

  const virt = { x: area.x / scale, y: area.y / scale, w: area.w / scale, h: area.h / scale };
  const docked = {};
  for (const [id, r] of Object.entries(layoutTree(root, virt, mins, defaultMin))) {
    docked[id] = { x: r.x * scale, y: r.y * scale, w: r.w * scale, h: r.h * scale };
  }
  return { scale, floating: [...out, ...unplaced], docked };
}

// ---------------------------------------------------------------- persistence

export function serialize(layout) {
  return JSON.stringify({ ...layout, version: VERSION });
}

/**
 * The old 'rigs.panels' state ({ id: { closed, collapsed, pos: {left, top, width: '320px'|null, height} } })
 * as a layout: today every panel floats, so each becomes a floating panel (no rect = keep the CSS default
 * place), closed ones hidden with that rect, collapsed ones kept collapsed.
 */
export function migrateLegacy(state, { viewport } = {}) {
  const layout = emptyLayout();
  if (!state || typeof state !== 'object' || Array.isArray(state)) return layout;
  const px = (v) => num(v) ?? (typeof v === 'string' && Number.isFinite(parseFloat(v)) ? parseFloat(v) : null);
  let z = 0;
  for (const [id, s] of Object.entries(state)) {
    if (!isId(id) || !s || typeof s !== 'object') continue;
    const p = s.pos && typeof s.pos === 'object' ? s.pos : {};
    const has = num(p.left) !== null;
    const rect = rectOf({ x: num(p.left), y: num(p.top), w: px(p.width), h: px(p.height), vw: has ? viewport?.w : null, vh: has ? viewport?.h : null });
    if (s.closed) layout.hidden[id] = { kind: 'float', rect };
    else layout.floating.push({ id, ...rect, z: ++z });
    if (s.collapsed) layout.collapsed.push(id);
  }
  return layout;
}

function validPlace(p) {
  if (!p || typeof p !== 'object') return null;
  if (p.kind === 'float') return { kind: 'float', rect: rectOf(p.rect) };
  if (p.kind === 'root') return { kind: 'root' };
  if (p.kind === 'tab') return { kind: 'tab', anchors: (p.anchors || []).filter(isId), index: num(p.index) ?? 0, active: !!p.active };
  if (p.kind === 'split') {
    return { kind: 'split', dir: p.dir === 'column' ? 'column' : 'row', side: p.side === 'before' ? 'before' : 'after', share: num(p.share) ?? 0.5, anchors: (p.anchors || []).filter(isId), wrap: !!p.wrap };
  }
  return null;
}

/** Drop repeated panel ids from a raw tree before normalising (each id lives in exactly one place). */
function withoutRepeats(node, seen) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'panel') {
    if (!isId(node.id) || seen.has(node.id)) return null;
    seen.add(node.id);
    return node;
  }
  if (node.type === 'tabs') {
    const panels = (Array.isArray(node.panels) ? node.panels : []).filter((id) => isId(id) && !seen.has(id) && seen.add(id));
    return { ...node, panels };
  }
  if (node.type === 'split' && Array.isArray(node.children)) return { ...node, children: node.children.map((c) => withoutRepeats(c, seen)) };
  return null;
}

/**
 * A layout from storage: a JSON string or object of this version, or the legacy 'rigs.panels' state
 * (migrated). Anything unreadable gives an empty layout. Ids appear once: tree, then floating, then hidden.
 */
export function deserialize(raw, { viewport } = {}) {
  let v = raw;
  if (typeof raw === 'string') { try { v = JSON.parse(raw); } catch { return emptyLayout(); } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return emptyLayout();
  if (v.version === undefined) return migrateLegacy(v, { viewport });
  if (v.version !== VERSION && v.version !== 1) return emptyLayout(); // a format we cannot read: start clean (1 = before `windows`)
  const seen = new Set();
  const layout = emptyLayout();
  layout.root = normalize(withoutRepeats(v.root, seen));
  for (const id of panelsIn(layout.root)) seen.add(id);
  for (const f of Array.isArray(v.floating) ? v.floating : []) {
    if (!isId(f?.id) || seen.has(f.id)) continue;
    seen.add(f.id);
    layout.floating.push({ id: f.id, ...rectOf(f), z: num(f.z) ?? 0 });
  }
  for (const [id, p] of Object.entries(v.hidden && typeof v.hidden === 'object' ? v.hidden : {})) {
    const place = validPlace(p);
    if (!isId(id) || seen.has(id) || !place) continue;
    seen.add(id);
    layout.hidden[id] = place;
  }
  layout.collapsed = [...new Set((Array.isArray(v.collapsed) ? v.collapsed : []).filter((id) => isId(id) && seen.has(id)))];
  layout.windows = v.version === 1 ? {} : normalizeWindows(v.windows);
  return layout;
}

// ---------------------------------------------------------------- command API

/**
 * A layout store: the one place the UI, the top menu and context menus change the layout through.
 *   storage   localStorage-like {getItem, setItem} (optional; nothing persists without it)
 *   defaults  () => layout used by resetLayout (default: every registered panel floating at its CSS place)
 *   viewport  () => {w, h}, recorded with migrated rects
 */
export function createDockManager({ storage = null, key = STORAGE_KEY, legacyKey = LEGACY_KEY, defaults = null, viewport = null } = {}) {
  const titles = new Map();
  const listeners = new Set();
  let opts = { storage, key, legacyKey, defaults, viewport };
  let layout = emptyLayout();

  const read = (k) => { try { return opts.storage?.getItem(k) ?? null; } catch { return null; } };
  const persist = () => { try { opts.storage?.setItem(opts.key, serialize(layout)); } catch { /* private mode / quota */ } };
  const emit = (cause) => { for (const fn of listeners) { try { fn(layout, cause); } catch { /* one listener must not break the rest */ } } };
  const set = (next, cause) => {
    if (next === layout) return layout;
    layout = next;
    persist();
    emit(cause);
    return layout;
  };
  const defaultLayout = () => (opts.defaults ? deserialize(clone(opts.defaults())) : emptyLayout());

  const api = {
    /** Point the manager at storage (and options) and load: current format first, then 'rigs.panels'. */
    attach(o = {}) {
      opts = { ...opts, ...o };
      const vp = opts.viewport?.();
      const cur = read(opts.key);
      const legacy = cur ? null : read(opts.legacyKey);
      layout = cur ? deserialize(cur, { viewport: vp }) : legacy ? deserialize(legacy, { viewport: vp }) : defaultLayout();
      layout = ensurePanels(layout, [...titles.keys()]);
      persist();
      emit('load');
      return layout;
    },
    /** Tell the manager a panel exists (title for menus); a new one floats at its CSS place, or starts hidden. */
    registerPanel(id, { title = id, hidden = false } = {}) {
      titles.set(id, title);
      return set(ensurePanels(layout, [id], { hidden: hidden ? [id] : [] }), 'register');
    },
    getLayout: () => layout,
    setLayout: (next) => set(deserialize(clone(next)), 'set'),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Apply any pure operation: manager.apply(dock, 'dock', 'work', 'right'). */
    apply: (op, ...args) => set(op(layout, ...args), op.name),

    dockPanel: (id, targetId = 'root', zone = 'right', o) => set(dock(layout, id, targetId, zone, o), 'dock'),
    floatPanel: (id, rect) => set(undock(layout, id, rect), 'float'),
    hidePanel: (id) => set(hide(layout, id), 'hide'),
    restorePanel: (id) => set(restore(layout, id), 'restore'),
    togglePanel: (id) => (layout.hidden[id] ? api.restorePanel(id) : api.hidePanel(id)),
    resetLayout: () => set(ensurePanels(defaultLayout(), [...titles.keys()]), 'reset'),
    /** A wm.js window's saved state record (window-state.js) or null. */
    getWindow: (key) => normalizeRecord(layout.windows?.[key]),
    /** Save a window's state record (null forgets it). Listeners hear cause 'windows'; docking.js does not re-render for it. */
    setWindow: (key, rec) => set(setWindow(layout, key, rec), 'windows'),
    /** [{id, title, status: docked|floating|hidden, collapsed, path?}] for menus. */
    listPanels: () => listLayoutPanels(layout).map((p) => ({ ...p, title: titles.get(p.id) ?? p.id })),
  };
  return api;
}

/** The shared manager the JARVIS UI attaches to storage; menus call the functions below. */
export const dockManager = createDockManager();
export const dockPanel = (...a) => dockManager.dockPanel(...a);
export const floatPanel = (...a) => dockManager.floatPanel(...a);
export const hidePanel = (...a) => dockManager.hidePanel(...a);
export const restorePanel = (...a) => dockManager.restorePanel(...a);
export const resetLayout = (...a) => dockManager.resetLayout(...a);
export const listPanels = (...a) => dockManager.listPanels(...a);
