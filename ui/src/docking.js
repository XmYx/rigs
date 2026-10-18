import { h } from './api.js';
import { isPhone } from './mobile.js';
import { announce } from './a11y.js';
import {
  dockManager, panelStatus, panelsIn, dropZoneAt, allocate, minSizeOf, setActiveTab, reorder, resizeSplit,
  dock, undock, removePanel,
} from './dock-layout.js';

// The DOM side of the dock layout engine (dock-layout.js holds the model; this module draws it).
//
// Every JARVIS panel (panels.js) and every wm.js window registers here as a "dockable" with its element and
// its title bar. Dragging the bar moves it like a desktop window (buttons, inputs and tabs inside the bar
// keep working). With the optional docking mode on (off by default, persisted in 'rigs.docking'), the drag
// shows animated drop zones over the panel, window or galaxy under the pointer: left/right/top/bottom dock
// it beside that one, the centre adds it as a tab. Docked panels are laid out by the engine's tree over the
// screen: they keep their own element (never reparented) and get a fixed rect, tab groups get a tab strip
// (role=tablist) and splits get draggable separators. The galaxy is the 'stage' leaf of the tree: it is
// never a tab and never closes, so docked panels gather around it. Phones never dock.

export const STAGE = 'stage';
const MODE_KEY = 'rigs.docking';
const TAB_H = 30; // tab strip height
const GAP = 6; // space between docked panels
const PAD = 8; // space between the docked area and the screen edge
const ROOT_EDGE = 26; // pointer this close to a screen edge = dock against the whole layout
const THRESHOLD = 4; // px before a press on a bar becomes a drag
// What a press on a title bar must leave alone: controls, tabs, resize handles.
const NO_DRAG = 'button, a, input, select, textarea, label, summary, [contenteditable=""], [contenteditable="true"], [role="button"], [role="tab"], [role="slider"], [role="separator"], .presize, .no-drag';

const items = new Map(); // id → dockable
const modeListeners = new Set();
let mode = readMode();
let geo = { leaves: {}, groups: [], splits: [], stage: null };
let layer = null; // #dock-layer: tab strips, splitters, the stage outline
let overlay = null; // drop-zone overlay while dragging
const strips = new Map(); // group key → tab strip element
const splitters = new Map(); // split key → separator element
let drag = null; // the drag in progress
let splitDrag = null;
let stageEl = null;

function readMode() { try { return localStorage.getItem(MODE_KEY) === '1'; } catch { return false; } }

/** Docking mode as the user set it (persisted). */
export const isDocking = () => mode;
/** Docking actually in effect: the mode is on and this is not a phone. */
export const dockingActive = () => mode && !isPhone();
export function onDockingChange(fn) { modeListeners.add(fn); return () => modeListeners.delete(fn); }

/**
 * Switch the docking layout on or off (the ☰ menu and the top menu call this). Off floats every docked
 * panel where it is on screen and hands docked windows back to the window manager, so the layout looks the
 * same and behaves as before.
 */
export function setDocking(on) {
  on = !!on;
  if (on === mode) return mode;
  if (!on) {
    let L = dockManager.getLayout();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let cascade = 0;
    for (const id of panelsIn(L.root)) {
      if (id === STAGE) continue;
      const it = items.get(id);
      const r = it?.el.getBoundingClientRect();
      const visible = r && r.width > 0 && r.height > 0;
      const g = geo.leaves[id];
      const rect = visible ? { x: r.left, y: r.top, w: r.width, h: r.height } : g ? { x: g.x + (cascade += 24), y: g.y + cascade, w: g.w, h: g.h } : {};
      L = undock(L, id, { ...rect, vw, vh });
    }
    for (const f of [...L.floating]) if (items.get(f.id)?.kind === 'window' || f.id.startsWith('win-')) L = removePanel(L, f.id);
    dockManager.setLayout(L);
  }
  mode = on;
  try { localStorage.setItem(MODE_KEY, on ? '1' : '0'); } catch { /* private mode */ }
  render();
  announce(on ? 'Docking layout on: drag a panel by its title bar onto another to dock it.' : 'Docking layout off.');
  for (const fn of modeListeners) { try { fn(on); } catch { /* keep going */ } }
  return mode;
}
export const toggleDocking = () => setDocking(!mode);

// ---------------------------------------------------------------- registration

/**
 * Make an element dockable.
 *   kind       'panel' (persists, can be hidden) | 'window' (wm.js; lives until closed)
 *   handles    the elements that grab it (its title bar); presses on controls inside are left alone
 *   canDrag    () => false to refuse a drag (phones, maximised windows)
 *   clamp      (left, top, w, h) => [left, top] for free moves
 *   onClosed / onCollapsed  panels: show the state change (called with (value, initial))
 *   raise      windows: bring to the front of the window stack again after undocking
 */
export function registerDockable(id, opts) {
  const it = {
    id, title: opts.title || id, kind: opts.kind || 'panel', el: opts.el, handles: (opts.handles || []).filter(Boolean),
    canDrag: opts.canDrag || (() => !isPhone()), clamp: opts.clamp || clampPanel,
    onClosed: opts.onClosed, onCollapsed: opts.onCollapsed, raise: opts.raise,
    closed: false, collapsed: false, styled: false, init: true, rect: null,
  };
  it.el.dataset.dockId = id;
  if (!it.el.id) it.el.id = `dock-${id}`;
  items.set(id, it);
  for (const hd of it.handles) bindHandle(it, hd);
  render();
  return it;
}

export function unregisterDockable(id) {
  const it = items.get(id);
  if (!it) return;
  if (drag?.it === it) endDrag(true);
  items.delete(id);
  if (panelStatus(dockManager.getLayout(), id)) dockManager.apply(removePanel, id);
  else render();
}

export function setDockTitle(id, title) {
  const it = items.get(id);
  if (!it || it.title === title) return;
  it.title = title;
  if (dockingActive()) render();
}

// ---------------------------------------------------------------- geometry

function dockArea() {
  return { x: PAD, y: PAD, w: Math.max(1, window.innerWidth - 2 * PAD), h: Math.max(1, window.innerHeight - 2 * PAD) };
}
const inset = (r) => ({ x: r.x + GAP / 2, y: r.y + GAP / 2, w: Math.max(0, r.w - GAP), h: Math.max(0, r.h - GAP) });

/** Screen rects of the docked tree: leaves (panel content), tab groups, splitters and the stage. */
function computeGeo(L) {
  const out = { leaves: {}, groups: [], splits: [], stage: null };
  if (!L.root) return out;
  const walk = (n, r, path) => {
    if (n.type === 'panel') {
      if (n.id === STAGE) out.stage = inset(r);
      else out.leaves[n.id] = inset(r);
      return;
    }
    if (n.type === 'tabs') {
      const g = inset(r);
      out.groups.push({ key: path.join('.') || 'root', path, panels: n.panels, active: n.active, rect: g });
      const body = { x: g.x, y: g.y + TAB_H, w: g.w, h: Math.max(0, g.h - TAB_H) };
      for (const id of n.panels) out.leaves[id] = body;
      return;
    }
    const row = n.dir === 'row';
    const along = row ? 'w' : 'h';
    const sizes = allocate(r[along], n.ratios, n.children.map((c) => minSizeOf(c)[along]));
    let at = row ? r.x : r.y;
    n.children.forEach((c, i) => {
      walk(c, row ? { x: at, y: r.y, w: sizes[i], h: r.h } : { x: r.x, y: at, w: r.w, h: sizes[i] }, [...path, i]);
      at += sizes[i];
      if (i < n.children.length - 1) out.splits.push({ key: `${path.join('.')}:${i}`, path, index: i, dir: n.dir, at, rect: r, sizes, ratios: n.ratios, a: panelsIn(c), b: panelsIn(n.children[i + 1]) });
    });
  };
  walk(L.root, dockArea(), []);
  return out;
}

/** Panels: keep at least 80px and the top 28px on screen (as before). */
export function clampPanel(left, top, w) {
  return [Math.min(Math.max(0, left), Math.max(0, window.innerWidth - Math.min(w, 80))), Math.min(Math.max(0, top), Math.max(0, window.innerHeight - 28))];
}

const GEOM = ['left', 'top', 'right', 'bottom', 'transform', 'width', 'height'];
function setGeom(el, r) {
  Object.assign(el.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px', right: 'auto', bottom: 'auto', transform: 'none' });
}
function clearGeom(el) { for (const k of GEOM) el.style[k] = ''; }

// ---------------------------------------------------------------- render

let renderQueued = false;
/** Draw the current layout. Cheap enough to run on every change; a drag skips the element being dragged. */
export function render() {
  renderQueued = false;
  const L = dockManager.getLayout();
  const active = dockingActive();
  geo = active ? computeGeo(L) : { leaves: {}, groups: [], splits: [], stage: null };
  const tabbed = new Map();
  for (const g of geo.groups) for (const id of g.panels) tabbed.set(id, g);
  for (const it of items.values()) applyItem(it, L, active, tabbed.get(it.id));
  drawLayer(active);
}
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(render);
}

function applyItem(it, L, active, group) {
  const { el, id } = it;
  const status = panelStatus(L, id);
  const initial = it.init;
  it.init = false;
  if (it.kind === 'panel') {
    const closed = status === 'hidden';
    if (closed !== it.closed || initial) { it.closed = closed; it.onClosed?.(closed, initial); }
    const collapsed = L.collapsed.includes(id);
    if (collapsed !== it.collapsed || initial) { it.collapsed = collapsed; it.onCollapsed?.(collapsed, initial); }
    if (closed) return;
  }
  if (drag?.it === it) return;
  const r = status === 'docked' && active ? geo.leaves[id] : null;
  if (r) {
    if (!el.classList.contains('docked') && it.kind === 'window') el.style.zIndex = '';
    el.classList.add('docked');
    el.classList.toggle('dock-tab-hidden', !!group && group.active !== id);
    if (group) {
      if (it.kind !== 'window') el.setAttribute('role', 'tabpanel');
      el.setAttribute('aria-labelledby', `dtab-${id}`);
    } else unTab(el, id);
    const changed = !it.rect || ['x', 'y', 'w', 'h'].some((k) => Math.abs(it.rect[k] - r[k]) > 0.5);
    setGeom(el, r);
    it.rect = { ...r };
    it.styled = true;
    if (changed) el.dispatchEvent(new CustomEvent(it.kind === 'window' ? 'winresize' : 'panelresize'));
    return;
  }
  it.rect = null;
  if (el.classList.contains('docked') || el.classList.contains('dock-tab-hidden')) {
    el.classList.remove('docked', 'dock-tab-hidden');
    unTab(el, id);
    if (it.kind === 'window') it.raise?.();
  }
  if (status === 'floating') {
    const f = L.floating.find((x) => x.id === id);
    if (f && f.x !== null && f.y !== null) {
      if (f.w !== null) el.style.width = f.w + 'px';
      if (f.h !== null) el.style.height = f.h + 'px';
      const b = el.getBoundingClientRect();
      const [left, top] = it.clamp(f.x, f.y, b.width || f.w || 0, b.height || f.h || 0);
      Object.assign(el.style, { left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto', transform: 'none' });
      it.styled = true;
      return;
    }
  }
  // No saved rect (the CSS default place), or docked while docking is not in effect (phones): CSS places it.
  if (it.kind === 'panel' && it.styled && status !== null) { clearGeom(el); it.styled = false; }
}

function unTab(el, id) {
  if (el.getAttribute('aria-labelledby') !== `dtab-${id}`) return;
  el.removeAttribute('aria-labelledby');
  if (el.getAttribute('role') === 'tabpanel') el.removeAttribute('role');
}

// ---------------------------------------------------------------- tab strips, splitters, stage

function drawLayer(active) {
  if (!active && !layer) return;
  if (!layer) {
    stageEl = h('div', { class: 'dock-stage', 'aria-hidden': 'true' });
    layer = h('div', { id: 'dock-layer' }, stageEl);
    document.body.append(layer);
  }
  layer.hidden = !active;
  if (geo.stage) Object.assign(stageEl.style, { left: geo.stage.x + 'px', top: geo.stage.y + 'px', width: geo.stage.w + 'px', height: geo.stage.h + 'px', display: '' });
  else stageEl.style.display = 'none';

  // Tab strips, keyed by tree position so keyboard focus survives a re-render.
  const focusedTab = document.activeElement?.closest?.('.dock-tab')?.dataset.id;
  const seen = new Set();
  for (const g of geo.groups) {
    seen.add(g.key);
    let strip = strips.get(g.key);
    if (!strip) {
      strip = h('div', { class: 'dock-tabs', role: 'tablist' });
      strip.addEventListener('keydown', onTabKey);
      strips.set(g.key, strip);
      layer.append(strip);
    }
    strip.setAttribute('aria-label', `Docked tabs: ${g.panels.map((id) => items.get(id)?.title || id).join(', ')}`);
    Object.assign(strip.style, { left: g.rect.x + 'px', top: g.rect.y + 'px', width: g.rect.w + 'px', height: TAB_H + 'px' });
    strip.replaceChildren(...g.panels.map((id) => {
      const it = items.get(id);
      const sel = id === g.active;
      const b = h('button', { class: 'dock-tab', role: 'tab', id: `dtab-${id}`, type: 'button', 'aria-selected': String(sel), 'aria-controls': it?.el.id || '', tabindex: sel ? '0' : '-1', title: `${it?.title || id} · drag to reorder, drag out to float · Shift+←/→ moves it` }, it?.title || id);
      b.dataset.id = id;
      b.addEventListener('pointerdown', (e) => onTabDown(e, id, strip));
      b.addEventListener('click', () => { if (!b._dragged) dockManager.apply(setActiveTab, id); });
      return b;
    }));
  }
  for (const [k, s] of strips) if (!seen.has(k)) { s.remove(); strips.delete(k); }
  if (focusedTab && !document.activeElement?.closest?.('.dock-tab')) document.getElementById(`dtab-${focusedTab}`)?.focus({ preventScroll: true });

  // Separators between the children of each split.
  const seenS = new Set();
  for (const s of geo.splits) {
    seenS.add(s.key);
    let el = splitters.get(s.key);
    if (!el) {
      el = h('div', { class: 'dock-split', role: 'separator', tabindex: '0' });
      el.addEventListener('pointerdown', (e) => onSplitDown(e, el));
      el.addEventListener('keydown', (e) => onSplitKey(e, el));
      splitters.set(s.key, el);
      layer.append(el);
    }
    el._split = s;
    const row = s.dir === 'row';
    el.className = `dock-split ${s.dir}${splitDrag?.el === el ? ' active' : ''}`;
    el.setAttribute('aria-orientation', row ? 'vertical' : 'horizontal');
    const pair = s.ratios[s.index] + s.ratios[s.index + 1];
    el.setAttribute('aria-valuenow', String(Math.round((s.ratios[s.index] / pair) * 100)));
    el.setAttribute('aria-valuemin', '0');
    el.setAttribute('aria-valuemax', '100');
    const name = (ids) => ids.filter((x) => x !== STAGE).map((x) => items.get(x)?.title || x).join(' + ') || 'galaxy';
    el.setAttribute('aria-label', `Resize ${name(s.a)} and ${name(s.b)}`);
    const t = 8;
    Object.assign(el.style, row
      ? { left: s.at - t / 2 + 'px', top: s.rect.y + 'px', width: t + 'px', height: s.rect.h + 'px' }
      : { left: s.rect.x + 'px', top: s.at - t / 2 + 'px', width: s.rect.w + 'px', height: t + 'px' });
  }
  for (const [k, el] of splitters) if (!seenS.has(k)) { el.remove(); splitters.delete(k); }
}

function onTabKey(e) {
  const tabs = [...e.currentTarget.querySelectorAll('.dock-tab')];
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  let j = null;
  if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
  else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
  else if (e.key === 'Home') j = 0;
  else if (e.key === 'End') j = tabs.length - 1;
  if (j === null) return;
  e.preventDefault();
  const cur = tabs[i].dataset.id;
  if (e.shiftKey) { dockManager.apply(reorder, cur, j); document.getElementById(`dtab-${cur}`)?.focus(); return; } // Shift+arrow moves the tab
  const id = tabs[j].dataset.id;
  dockManager.apply(setActiveTab, id);
  document.getElementById(`dtab-${id}`)?.focus();
}

/** Ratios after moving a splitter to `pos` (screen px along the split's axis); each side keeps 40px. */
function ratiosAt(s, pos) {
  const row = s.dir === 'row';
  const start = (row ? s.rect.x : s.rect.y) + s.sizes.slice(0, s.index).reduce((a, b) => a + b, 0);
  const pair = s.sizes[s.index] + s.sizes[s.index + 1];
  const first = Math.min(Math.max(pos - start, 40), pair - 40);
  const pr = s.ratios[s.index] + s.ratios[s.index + 1];
  const ratios = [...s.ratios];
  ratios[s.index] = pr * (first / pair);
  ratios[s.index + 1] = pr - ratios[s.index];
  return ratios;
}

function onSplitDown(e, el) {
  if (e.button !== 0) return;
  e.preventDefault();
  splitDrag = { el };
  el.setPointerCapture(e.pointerId);
  el.classList.add('active');
  document.body.classList.add('dock-resizing');
  const move = (ev) => {
    const s = el._split;
    if (s) dockManager.apply(resizeSplit, s.path, ratiosAt(s, s.dir === 'row' ? ev.clientX : ev.clientY));
  };
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    el.classList.remove('active');
    document.body.classList.remove('dock-resizing');
    splitDrag = null;
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

function onSplitKey(e, el) {
  const s = el._split;
  if (!s) return;
  const step = (e.shiftKey ? 0.1 : 0.03) * (s.sizes[s.index] + s.sizes[s.index + 1]);
  const d = (s.dir === 'row' ? { ArrowLeft: -1, ArrowRight: 1 } : { ArrowUp: -1, ArrowDown: 1 })[e.key];
  if (!d) return;
  e.preventDefault();
  dockManager.apply(resizeSplit, s.path, ratiosAt(s, s.at + d * step));
}

// ---------------------------------------------------------------- dragging

function bindHandle(it, hd) {
  hd.classList.add('pdrag');
  hd.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag || !it.canDrag()) return;
    if (e.target.closest(NO_DRAG) && !e.target.closest('.pgrip')) return;
    pendingPress(it, hd, e);
  });
}

/** A press becomes a drag once the pointer moved a few px; until then clicks, focus and selection are untouched. */
function pendingPress(it, hd, e) {
  const sx = e.clientX;
  const sy = e.clientY;
  const pid = e.pointerId;
  const move = (ev) => {
    if (ev.pointerId !== pid || Math.hypot(ev.clientX - sx, ev.clientY - sy) < THRESHOLD) return;
    cleanup();
    startDrag(it, hd, ev, { sx, sy });
  };
  const cleanup = () => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', cleanup, true);
    window.removeEventListener('pointercancel', cleanup, true);
  };
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', cleanup, true);
  window.addEventListener('pointercancel', cleanup, true);
}

function startDrag(it, hd, ev, { sx, sy, fromTab = false }) {
  const { el } = it;
  const status = panelStatus(dockManager.getLayout(), it.id);
  const docking = dockingActive();
  const r = el.getBoundingClientRect();
  const snapshot = { css: el.style.cssText, cls: el.className };
  let w = r.width;
  let hh = r.height;
  let offX = sx - r.left;
  let offY = sy - r.top;
  if (status === 'docked' && docking) {
    // Lift it out of the tree at a comfortable floating size, the grab point kept under the pointer.
    w = Math.min(r.width || 420, 520);
    hh = Math.min(r.height || 360, 440);
    offX = Math.min(Math.max(16, offX * (w / (r.width || w))), w - 16);
    offY = fromTab ? 14 : Math.min(Math.max(8, offY), 40);
    el.classList.remove('docked', 'dock-tab-hidden');
  }
  // Freeze the size so panels anchored to two edges (e.g. top + bottom) don't stretch while moving.
  Object.assign(el.style, { width: w + 'px', height: hh + 'px', right: 'auto', bottom: 'auto', transform: 'none' });
  drag = { it, hd, el, docking, snapshot, offX, offY, w, h: hh, target: null, pointerId: ev.pointerId, moved: false };
  try { hd.setPointerCapture(ev.pointerId); } catch { /* the press target is gone (a re-rendered tab) */ }
  el.classList.add('dragging');
  if (docking) { el.classList.add('dock-lifted'); el.style.zIndex = '1000'; }
  document.body.classList.add('dock-dragging');
  window.addEventListener('pointermove', onDragMove, true);
  window.addEventListener('pointerup', onDragUp, true);
  window.addEventListener('pointercancel', onDragCancel, true);
  window.addEventListener('keydown', onDragKey, true);
  onDragMove(ev);
}

function onDragMove(ev) {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  drag.moved = true;
  const { el, it } = drag;
  const [left, top] = it.clamp(ev.clientX - drag.offX, ev.clientY - drag.offY, drag.w, drag.h);
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  if (!drag.docking) return;
  drag.target = hitTest(ev.clientX, ev.clientY);
  showOverlay(drag.target);
}

const containsPt = (r, x, y) => r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
const rectOfEl = (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };

/** What the pointer is over: a screen edge (dock against the whole layout), a tab strip, a dockable, or the galaxy. */
function hitTest(x, y) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const edge = x < ROOT_EDGE ? 'left' : x > vw - ROOT_EDGE ? 'right' : y < ROOT_EDGE ? 'top' : y > vh - ROOT_EDGE ? 'bottom' : null;
  if (edge) return { id: 'root', zone: edge, rect: dockArea() };
  for (const e of document.elementsFromPoint(x, y)) {
    if (drag.el.contains(e) || e.closest('.dock-overlay')) continue;
    const strip = e.closest('.dock-tabs');
    if (strip) {
      const g = geo.groups.find((gr) => strips.get(gr.key) === strip);
      if (g && !g.panels.includes(drag.it.id)) return { id: g.active, zone: 'center', rect: g.rect };
      continue;
    }
    const host = e.closest('[data-dock-id]');
    const id = host?.dataset.dockId;
    if (!id || id === drag.it.id || !items.has(id)) continue;
    const g = geo.groups.find((gr) => gr.panels.includes(id));
    const rect = g ? g.rect : rectOfEl(host);
    return { id, rect, zone: dropZoneAt(rect, { x, y }, { edge: 0.28 }) };
  }
  if (containsPt(geo.stage, x, y)) {
    const zone = dropZoneAt(geo.stage, { x, y }, { edge: 0.28 });
    return { id: STAGE, rect: geo.stage, zone: zone === 'center' ? null : zone }; // the galaxy is never a tab: its middle = float here
  }
  return null;
}

/** The part of the target the dropped panel takes. */
function shareFor(t) {
  if (t.id !== 'root' && t.id !== STAGE) return 0.5;
  const horiz = t.zone === 'left' || t.zone === 'right';
  const own = horiz ? drag?.w ?? 360 : drag?.h ?? 300;
  return Math.min(0.45, Math.max(0.18, own / ((horiz ? t.rect.w : t.rect.h) || 1)));
}

function previewRect(t) {
  const r = t.rect;
  if (t.zone === 'center') return r;
  const s = shareFor(t);
  if (t.zone === 'left') return { x: r.x, y: r.y, w: r.w * s, h: r.h };
  if (t.zone === 'right') return { x: r.x + r.w * (1 - s), y: r.y, w: r.w * s, h: r.h };
  if (t.zone === 'top') return { x: r.x, y: r.y, w: r.w, h: r.h * s };
  return { x: r.x, y: r.y + r.h * (1 - s), w: r.w, h: r.h * s };
}

function ensureOverlay() {
  if (overlay) return overlay;
  const compass = h('div', { class: 'dock-compass' }, ...['top', 'left', 'center', 'right', 'bottom'].map((zone) => h('span', { class: 'dock-pad', 'data-zone': zone }, h('i', {}))));
  const preview = h('div', { class: 'dock-preview' });
  const label = h('div', { class: 'dock-label' });
  overlay = { el: h('div', { class: 'dock-overlay', 'aria-hidden': 'true' }, preview, compass, label), preview, compass, label };
  document.body.append(overlay.el);
  return overlay;
}

function showOverlay(t) {
  const o = ensureOverlay();
  const compass = !!t && t.id !== 'root';
  o.compass.classList.toggle('show', compass);
  o.compass.classList.toggle('no-center', t?.id === STAGE);
  if (compass) Object.assign(o.compass.style, { left: t.rect.x + t.rect.w / 2 + 'px', top: t.rect.y + t.rect.h / 2 + 'px' });
  for (const p of o.compass.children) p.classList.toggle('on', !!t && p.dataset.zone === t.zone);
  if (!t?.zone) { o.preview.classList.remove('show'); o.label.classList.remove('show'); return; }
  const r = previewRect(t);
  Object.assign(o.preview.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
  o.preview.classList.add('show');
  const tgt = t.id === 'root' ? 'the screen' : t.id === STAGE ? 'the galaxy' : items.get(t.id)?.title || t.id;
  o.label.textContent = t.zone === 'center' ? `Tab with ${tgt}` : `Dock ${t.zone} of ${tgt}`;
  Object.assign(o.label.style, { left: r.x + r.w / 2 + 'px', top: r.y + Math.min(r.h / 2, 60) + 'px' });
  o.label.classList.add('show');
}

function hideOverlay() {
  if (!overlay) return;
  for (const el of [overlay.preview, overlay.compass, overlay.label]) el.classList.remove('show');
}

function onDragKey(e) {
  if (e.key !== 'Escape' || !drag) return;
  e.preventDefault();
  e.stopPropagation();
  endDrag(true);
}
function onDragCancel(ev) { if (drag && ev.pointerId === drag.pointerId) endDrag(true); }
function onDragUp(ev) { if (drag && ev.pointerId === drag.pointerId) endDrag(false); }

function endDrag(cancel) {
  const d = drag;
  if (!d) return;
  drag = null;
  window.removeEventListener('pointermove', onDragMove, true);
  window.removeEventListener('pointerup', onDragUp, true);
  window.removeEventListener('pointercancel', onDragCancel, true);
  window.removeEventListener('keydown', onDragKey, true);
  try { d.hd.releasePointerCapture?.(d.pointerId); } catch { /* already released */ }
  document.body.classList.remove('dock-dragging');
  hideOverlay();
  const { el, it } = d;
  // The drag must not also click whatever sits under the pointer in the bar.
  const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
  window.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', swallow, true), 0);
  if (cancel || !d.moved) {
    el.style.cssText = d.snapshot.css;
    el.className = d.snapshot.cls;
    render();
    return;
  }
  const b = el.getBoundingClientRect();
  el.classList.remove('dragging', 'dock-lifted');
  if (d.docking) el.style.zIndex = /z-index:\s*(\d+)/.exec(d.snapshot.css)?.[1] || '';
  const t = d.target;
  if (d.docking && t?.zone) {
    dropOnto(it, t);
    announce(t.zone === 'center' ? `${it.title} added as a tab.` : `${it.title} docked ${t.zone}.`);
    return;
  }
  // A free move: panels (and windows already in the layout) remember the rect; other windows keep their inline place.
  const rect = { x: b.left, y: b.top, w: b.width, h: b.height, vw: window.innerWidth, vh: window.innerHeight };
  if (it.kind === 'panel' || panelStatus(dockManager.getLayout(), it.id)) dockManager.floatPanel(it.id, rect);
  if (it.kind === 'window' && d.docking) it.raise?.();
  render();
}

function dropOnto(it, t) {
  let L = dockManager.getLayout();
  // A floating target first docks beside the galaxy on its nearer side, then the dragged one joins it.
  if (t.id !== 'root' && t.id !== STAGE && panelStatus(L, t.id) !== 'docked') {
    const side = t.rect.x + t.rect.w / 2 < window.innerWidth / 2 ? 'left' : 'right';
    const share = geo.stage ? Math.min(0.45, Math.max(0.18, t.rect.w / geo.stage.w)) : 0.3;
    L = dock(L, t.id, geo.stage ? STAGE : 'root', side, { share });
  }
  L = dock(L, it.id, t.id, t.zone, { share: shareFor(t) });
  dockManager.setLayout(L);
}

// ---------------------------------------------------------------- tabs: click, reorder, drag out

function onTabDown(e, id, strip) {
  if (e.button !== 0) return;
  const tab = e.currentTarget;
  tab._dragged = false;
  const sx = e.clientX;
  const sy = e.clientY;
  const pid = e.pointerId;
  let reordering = false;
  let mark = null;
  let index = null;
  const indexAt = (x) => {
    const others = [...strip.querySelectorAll('.dock-tab')].filter((t) => t !== tab);
    let i = others.findIndex((t) => { const b = t.getBoundingClientRect(); return x < b.left + b.width / 2; });
    if (i < 0) i = others.length;
    const sb = strip.getBoundingClientRect();
    const ref = others[i] ? others[i].getBoundingClientRect().left - 1 : others.length ? others[others.length - 1].getBoundingClientRect().right + 1 : sb.left + 4;
    return { i, mx: ref - sb.left };
  };
  const move = (ev) => {
    if (ev.pointerId !== pid) return;
    if (!reordering && Math.hypot(ev.clientX - sx, ev.clientY - sy) < THRESHOLD) return;
    tab._dragged = true;
    const sb = strip.getBoundingClientRect();
    if (ev.clientY < sb.top - 24 || ev.clientY > sb.bottom + 24) {
      // Out of the strip: now it is a panel drag (dock it elsewhere, or let go to float it).
      cleanup();
      const it = items.get(id);
      if (it?.canDrag()) {
        dockManager.apply(setActiveTab, id);
        startDrag(it, tab, ev, { sx: ev.clientX, sy: ev.clientY, fromTab: true });
      }
      return;
    }
    reordering = true;
    tab.classList.add('dragging');
    const r = indexAt(ev.clientX);
    index = r.i;
    if (!mark) { mark = h('span', { class: 'dock-tab-mark', 'aria-hidden': 'true' }); strip.append(mark); }
    mark.style.left = r.mx + 'px';
  };
  const cleanup = () => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', cleanup, true);
    tab.classList.remove('dragging');
    mark?.remove();
  };
  const up = (ev) => {
    if (ev.pointerId !== pid) return;
    cleanup();
    if (reordering && index !== null) dockManager.apply(reorder, id, index);
  };
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', cleanup, true);
}

// ---------------------------------------------------------------- setup

let started = false;
/** Load the saved layout and start drawing. panels.js calls this once, before it registers panels. */
export function initDocking({ defaults }) {
  if (started) return;
  started = true;
  let storage = null;
  try { storage = window.localStorage; } catch { /* blocked storage: nothing persists */ }
  dockManager.attach({ storage, defaults, viewport: () => ({ w: window.innerWidth, h: window.innerHeight }) });
  // Windows never outlive the page; the galaxy always has its place in the tree.
  let L = dockManager.getLayout();
  for (const p of [...panelsIn(L.root), ...L.floating.map((f) => f.id), ...Object.keys(L.hidden)]) if (p.startsWith('win-')) L = removePanel(L, p);
  if (panelStatus(L, STAGE) !== 'docked') L = dock(removePanel(L, STAGE), STAGE, 'root', 'right', { share: 0.7 });
  dockManager.setLayout(L);
  dockManager.subscribe(() => render());
  window.addEventListener('resize', queueRender);
  window.matchMedia?.('(max-width: 640px), (max-height: 500px) and (pointer: coarse)')?.addEventListener?.('change', queueRender);
}

/** Commands for menus (☰ today; the top menu and context menus can call the same). */
export const dockCommands = {
  isDocking, setDocking, toggleDocking,
  dockPanel: (...a) => dockManager.dockPanel(...a),
  floatPanel: (...a) => dockManager.floatPanel(...a),
  hidePanel: (...a) => dockManager.hidePanel(...a),
  restorePanel: (...a) => dockManager.restorePanel(...a),
  resetLayout: (...a) => dockManager.resetLayout(...a),
  listPanels: () => dockManager.listPanels().filter((p) => p.id !== STAGE && items.get(p.id)?.kind !== 'window'),
};
