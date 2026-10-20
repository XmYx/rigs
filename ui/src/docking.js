import { h } from './api.js';
import { isPhone } from './mobile.js';
import { announce } from './a11y.js';
import {
  dockManager, panelStatus, panelsIn, dropZoneAt, allocate, minSizeOf, setActiveTab, reorder, resizeSplit,
  dock, undock, removePanel, solveFit, fitHome, DEFAULT_MIN, deserialize, serialize, STORAGE_KEY, VERSION as LAYOUT_VERSION,
} from './dock-layout.js';
import { scalingActive, onScalingChange, recordFit, scaleCommands, reducedMotion } from './scaling.js';
import { syncedStorage, readOnlyWhen, prepareKey, onRemoteKey } from './synced-storage.js';
import { usableArea } from './tiling-model.js';

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
//
// Other modules can add drop targets outside the layout (addDropTarget: the top menu bar's Ask JARVIS slot). They
// are checked first on every drag move, with or without the docking mode, and drawn with the same preview.
//
// Window tiling (tiling.js) plugs into window drags with setWindowSnap(): near a screen edge or corner the drag
// shows the tile preview instead, and letting go there tiles the window. Precedence with the docking layout on:
// the docking layout keeps the screen edges (ROOT_EDGE, dock against the whole layout, exactly as before), the
// corners still tile into quarters. With docking off every edge, corner and the top-centre (fill) tile.
//
// Smart scaling (scaling.js, off by default) adds the fit pass at the top of render(): the solver in
// dock-layout.js (solveFit) places every visible floating panel, window and the docked tree so all of them stay
// fully on screen. Panels shrink toward their minimum before anything scales, and only when the minimums
// themselves overflow does the one shared scale factor kick in (content drawn with the `scale` property). Fitted
// rects are never stored: the layout keeps each panel's home, so a growing window brings it back. Motion is
// CSS transitions (styles.css, SMART SCALING): eased and spring-like for a discrete resize, switched off
// (.fit-live) while the window edge is being dragged and under prefers-reduced-motion.
//
// Mesh sync: the layout ('rigs.dock') and the docking switch ('rigs.docking') go through synced-storage.js, so they
// are saved on the daemon and follow every machine. What is synced leaves out this page's wm.js windows (win-<n>);
// a layout from another machine is re-read live (reloadLayout) once no pointer is held, keeping this page's windows
// where they are on screen. Phones read it but never write a panel layout back (they never dock).

export const STAGE = 'stage';
const MODE_KEY = 'rigs.docking';
const TAB_H = 30; // tab strip height
const GAP = 6; // space between docked panels
const PAD = 8; // space between the docked area and the screen edge
const ROOT_EDGE = 26; // pointer this close to a screen edge = dock against the whole layout
const THRESHOLD = 4; // px before a press on a bar becomes a drag
const FIT_MARGIN = 8; // breathing room kept between a fitted panel and the screen edge
const LIVE_MS = 340; // another resize before the last glide ended (= MOVE_MS) = the window edge is being dragged, or the OS animates a maximise
const MOVE_MS = 340; // how long .fit-moving (the eased transitions) stays on after a fit that moved something
// What a press on a title bar must leave alone: controls, tabs, resize handles.
const NO_DRAG = 'button, a, input, select, textarea, label, summary, [contenteditable=""], [contenteditable="true"], [role="button"], [role="tab"], [role="slider"], [role="separator"], .presize, .no-drag';

const items = new Map(); // id → dockable
const dropTargets = new Set(); // addDropTarget: drop places outside the layout
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
let windowSnap = null; // tiling.js: { zone(it, x, y, docking), lift(it, grab, rect), drop(it, zone, start), moved(it), refit() }
const SNAP_DWELL = 150; // ms the pointer rests in a tile zone before its preview shows (and letting go tiles)

/** Tiling hooks into window drags (tiling.js calls this once). */
export function setWindowSnap(handler) { windowSnap = handler; }

function readMode() { return syncedStorage.getItem(MODE_KEY) === '1'; }

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
  syncedStorage.setItem(MODE_KEY, on ? '1' : '0');
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
  if (it.kind === 'window') trackWindowResize(it);
  if (!adoptWindow(it)) render();
  return it;
}

/**
 * Windows live outside the layout until they are moved. With smart scaling on, a window needs a home like a
 * panel's, so it joins the floating layer at the rect the window manager gave it (adopting renders).
 */
function adoptWindow(it) {
  if (it.kind !== 'window' || !scalingActive() || panelStatus(dockManager.getLayout(), it.id)) return false;
  const s = it.el.style;
  const r = it.el.getBoundingClientRect();
  const x = px(s.left) ?? r.left;
  const y = px(s.top) ?? r.top;
  const w = px(s.width) ?? r.width;
  const hh = px(s.height) ?? r.height;
  if (!(w > 0 && hh > 0)) return false;
  dockManager.floatPanel(it.id, { x, y, w, h: hh, vw: window.innerWidth, vh: window.innerHeight });
  return true;
}

/** The corner grip of a window is the browser's own resize handle: when it lets go, the new size is the window's home. */
function trackWindowResize(it) {
  const { el } = it;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || el.classList.contains('docked') || el.classList.contains('max')) return;
    const r = el.getBoundingClientRect();
    if (e.clientX < r.right - 18 || e.clientY < r.bottom - 18) return;
    el.classList.add('resizing'); // no eased transitions while the handle is held
    const up = () => {
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      el.classList.remove('resizing');
      const b = el.getBoundingClientRect();
      if (scalingActive() && (Math.abs(b.width - r.width) > 1 || Math.abs(b.height - r.height) > 1)) {
        dockManager.floatPanel(it.id, { x: b.left, y: b.top, w: b.width, h: b.height, vw: window.innerWidth, vh: window.innerHeight });
      }
    };
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  }, true);
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

const cssPx = (name) => { const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)); return Number.isFinite(v) && v > 0 ? v : 0; };
/** Height of the top menu bar (menubar.js sets --mb-h on <html>; 0 when it is hidden or on a phone). */
const topInset = () => cssPx('--mb-h');
/** The edges the app dock keeps while it stays on screen (app-dock.js sets --ad-l/--ad-r/--ad-b; 0 when auto-hidden or absent). */
const appDockInsets = () => ({ l: cssPx('--ad-l'), r: cssPx('--ad-r'), b: cssPx('--ad-b') });

/** The docked area: the whole window minus a small margin, below the top menu bar and clear of the app dock's edge. Tiling uses it too. */
export function dockArea() {
  return usableArea({ vw: window.innerWidth, vh: window.innerHeight, top: topInset(), insets: appDockInsets(), pad: PAD });
}

/** A window that is in the layout (smart scaling adopted it) keeps `rect` as its home; others only have their inline place. */
export function setFloatingRect(id, rect) {
  if (panelStatus(dockManager.getLayout(), id) !== 'floating') return;
  dockManager.floatPanel(id, { ...rect, vw: window.innerWidth, vh: window.innerHeight });
}
const inset = (r) => ({ x: r.x + GAP / 2, y: r.y + GAP / 2, w: Math.max(0, r.w - GAP), h: Math.max(0, r.h - GAP) });

/**
 * Screen rects of the docked tree: leaves (panel content), tab groups, splitters and the stage. With smart
 * scaling below 1 the tree is laid out in a virtual screen of size / scale (so its minimums fit) and the
 * rects are mapped back to screen pixels; gaps and tab strips keep their real size.
 */
function computeGeo(L, scale = 1) {
  const out = { leaves: {}, groups: [], splits: [], stage: null };
  if (!L.root) return out;
  const S = (r) => (scale === 1 ? r : { x: r.x * scale, y: r.y * scale, w: r.w * scale, h: r.h * scale });
  const walk = (n, r, path) => {
    if (n.type === 'panel') {
      if (n.id === STAGE) out.stage = inset(S(r));
      else out.leaves[n.id] = inset(S(r));
      return;
    }
    if (n.type === 'tabs') {
      const g = inset(S(r));
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
      if (i < n.children.length - 1) out.splits.push({ key: `${path.join('.')}:${i}`, path, index: i, dir: n.dir, at: at * scale, rect: S(r), sizes: sizes.map((v) => v * scale), ratios: n.ratios, a: panelsIn(c), b: panelsIn(n.children[i + 1]) });
    });
  };
  const a = dockArea();
  walk(L.root, scale === 1 ? a : { x: a.x / scale, y: a.y / scale, w: a.w / scale, h: a.h / scale }, []);
  return out;
}

/** Panels: keep at least 80px and the top 28px on screen (as before). */
export function clampPanel(left, top, w) {
  const t = topInset(); // never under the top menu bar, where the title bar could not be grabbed
  return [Math.min(Math.max(0, left), Math.max(0, window.innerWidth - Math.min(w, 80))), Math.min(Math.max(t, top), Math.max(t, window.innerHeight - 28))];
}

const GEOM = ['left', 'top', 'right', 'bottom', 'transform', 'scale', 'transformOrigin', 'width', 'height'];
/**
 * Put an element at a screen rect. Below scale 1 its box is rect / scale, drawn scaled down from the top-left
 * corner with the individual `scale` property (windows hold `transform` in their entrance animation).
 */
function setGeom(el, r, scale = 1) {
  Object.assign(el.style, {
    left: r.x + 'px', top: r.y + 'px', width: r.w / scale + 'px', height: r.h / scale + 'px', right: 'auto', bottom: 'auto',
    transform: 'none', scale: scale < 1 ? String(scale) : '', transformOrigin: scale < 1 ? '0 0' : '',
  });
}
function clearGeom(el) { for (const k of GEOM) el.style[k] = ''; }

// ---------------------------------------------------------------- render

let renderQueued = false;
/** Draw the current layout. Cheap enough to run on every change; a drag skips the element being dragged. */
export function render() {
  renderQueued = false;
  const t0 = performance.now();
  const L = dockManager.getLayout();
  const active = dockingActive();
  const scaling = scalingActive();
  root.classList.toggle('smart-scaling', scaling);
  fitMoved = false;
  const fit = scaling ? computeFit(L, active) : null;
  const t1 = performance.now();
  geo = active ? computeGeo(L, fit?.scale ?? 1) : { leaves: {}, groups: [], splits: [], stage: null };
  const tabbed = new Map();
  for (const g of geo.groups) for (const id of g.panels) tabbed.set(id, g);
  for (const it of items.values()) applyItem(it, L, active, tabbed.get(it.id), fit);
  drawLayer(active);
  windowSnap?.refit();
  if (fitMoved) eased();
  if (scaling) recordFit(performance.now() - t0, t1 - t0);
}
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(render);
}

// ---------------------------------------------------------------- smart scaling: the fit pass

const root = document.documentElement;
let fitMoved = false; // something was placed somewhere new by the fit pass in this render
let movingTimer = 0;
let liveTimer = 0;
let lastResize = 0;
let lastVp = '';

/** Turn the eased transitions on for a moment (html.fit-moving); they are off the rest of the time. */
function eased() {
  if (reducedMotion() || root.classList.contains('fit-live')) return;
  root.classList.add('fit-moving');
  clearTimeout(movingTimer);
  movingTimer = setTimeout(() => root.classList.remove('fit-moving'), MOVE_MS);
}

const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
/** The element's own minimum size (CSS min-width/min-height in px), else the panel default. */
function minOf(el) {
  const cs = getComputedStyle(el);
  return { w: Math.max(px(cs.minWidth) ?? 0, DEFAULT_MIN.w), h: Math.max(px(cs.minHeight) ?? 0, DEFAULT_MIN.h) };
}
const overflows = (b, vw, vh) => b.x < -0.5 || b.y < -0.5 || b.x + b.w > vw + 0.5 || b.y + b.h > vh + 0.5;

/**
 * The fit pass: gather the home of every visible floating panel and window (the rect stored in the layout;
 * a panel still at its CSS place is measured, and only moved when it would overflow), run solveFit with the
 * docked tree and return where each goes. Reads first, then the caller writes: one forced layout at most.
 */
function computeFit(L, docked) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const vp = { w: vw, h: vh };
  const t = topInset(); // the fit frame starts below the top menu bar: y here = screen y - t
  const below = (f) => ({ ...f, y: f.y - t, vh: Math.max(1, f.vh - t) });
  const vpKey = `${vw}x${vh}x${t}`;
  const floating = [];
  const mins = {};
  const bare = [];
  for (const f of L.floating) {
    const it = items.get(f.id);
    if (!it || it.closed || drag?.it === it || it.el.classList.contains('max') || it.el.classList.contains('panel-closed')) continue;
    const m = minOf(it.el);
    mins[f.id] = m;
    if ([f.x, f.y, f.w, f.h].every((v) => v !== null)) {
      // A collapsed panel is only its header tall; a rect smaller than the element's own minimum is that minimum.
      const hh = it.collapsed ? Math.min(f.h, it.el.offsetHeight || f.h) : Math.max(f.h, m.h);
      if (it.collapsed) m.h = Math.min(m.h, hh);
      floating.push(below(fitHome({ ...f, w: Math.max(f.w, m.w), h: hh }, vp)));
    } else if (it.kind === 'panel') bare.push(it);
  }
  for (const it of bare) {
    if (it.bareKey !== vpKey || it.bareL !== L) {
      if (it.fitted) { clearGeom(it.el); it.fitted = false; it.styled = false; } // back to its CSS place, to measure it
      const b = it.el.getBoundingClientRect();
      const home = { x: b.left, y: b.top, w: b.width, h: b.height };
      it.bareKey = vpKey;
      it.bareL = L;
      it.bareHome = b.width > 0 && b.height > 0 && overflows(home, vw, vh) ? home : null;
    }
    if (it.bareHome) floating.push(below({ id: it.id, ...it.bareHome, z: 0, vw, vh }));
  }
  const res = solveFit({ viewport: { w: vw, h: Math.max(1, vh - t) }, floating, root: docked ? L.root : null, dockRect: dockArea(), mins, mode: 'fit', margin: FIT_MARGIN });
  return { scale: res.scale, byId: new Map(res.floating.map((f) => [f.id, { ...f, y: f.y + t }])) };
}

/** Place a floating panel or window at its fitted rect (drawn scaled when the scale is below 1). */
function placeFit(it, r, scale) {
  const key = [r.x, r.y, r.w, r.h, scale].map((v) => Math.round(v * 10) / 10).join();
  if (it.fitKey !== key) { if (it.fitKey || it.styled) fitMoved = true; it.fitKey = key; } // the first placement (page load) does not glide
  it.fitted = true;
  it.styled = true;
  setGeom(it.el, r, scale);
}

/** Leave smart scaling for an element: its stored place takes over again (the caller writes it). */
function unfit(it) {
  it.fitted = false;
  it.fitKey = null;
  it.el.style.scale = '';
  it.el.style.transformOrigin = '';
  fitMoved = true;
}

function applyItem(it, L, active, group, fit) {
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
    setGeom(el, r, fit?.scale ?? 1);
    if (changed && fit) fitMoved = true;
    it.fitted = !!fit;
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
    const fr = fit?.byId.get(id);
    if (fr) { placeFit(it, fr, fit.scale); return; }
    if (it.fitted) unfit(it);
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

/**
 * A drop place outside the layout, for some dockables, with or without the docking mode:
 *   accepts(id)  does it take this one     hit(x, y)  → screen rect of the target under the pointer, or null
 *   label        what the preview says      leave()    the pointer left it, or the drag ended
 *   drop(id)     the dockable was let go over it (its element is already back where the drag started)
 */
export function addDropTarget(t) { dropTargets.add(t); return () => dropTargets.delete(t); }

function extTargetAt(id, x, y) {
  for (const t of dropTargets) {
    if (!t.accepts(id)) continue;
    const rect = t.hit(x, y);
    if (rect) return { target: t, rect };
  }
  return null;
}

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
  } else if (it.kind === 'window' && windowSnap) {
    // A tiled window gets its pre-tile size back, the grab point kept under the pointer.
    const back = windowSnap.lift(it, { x: sx, y: sy }, { x: r.left, y: r.top, w: r.width, h: r.height });
    if (back) ({ w, h: hh, offX, offY } = back);
  }
  // Freeze the size so panels anchored to two edges (e.g. top + bottom) don't stretch while moving.
  Object.assign(el.style, { width: w + 'px', height: hh + 'px', right: 'auto', bottom: 'auto', transform: 'none' });
  const start = { x: r.left, y: r.top, w: r.width, h: r.height }; // where it was before the drag (tiling returns there)
  drag = { it, hd, el, docking, snapshot, start, offX, offY, w, h: hh, target: null, pointerId: ev.pointerId, moved: false, snap: null };
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
  const ext = extTargetAt(it.id, ev.clientX, ev.clientY);
  const hadExt = drag.ext;
  if (hadExt && hadExt.target !== ext?.target) hadExt.target.leave?.();
  drag.ext = ext;
  if (ext) { clearSnap(); drag.target = null; showExtOverlay(ext); return; }
  const zone = it.kind === 'window' ? windowSnap?.zone(it, ev.clientX, ev.clientY, drag.docking) : null;
  if (zone) { drag.target = null; snapTo(zone); return; }
  if (clearSnap()) hideOverlay();
  if (!drag.docking) { if (hadExt) hideOverlay(); return; }
  drag.target = hitTest(ev.clientX, ev.clientY);
  showOverlay(drag.target);
}

/**
 * The pointer is in a tile zone ({ zone, rect }): after SNAP_DWELL in the same zone its preview shows. A quick pass
 * over an edge shows nothing and does not tile.
 */
function snapTo(z) {
  if (drag.snap?.zone === z.zone) return;
  clearSnap();
  hideOverlay();
  const snap = { ...z, shown: false };
  snap.timer = setTimeout(() => {
    if (drag?.snap !== snap) return;
    snap.shown = true;
    showTileOverlay(snap);
  }, SNAP_DWELL);
  drag.snap = snap;
}
/** Leave the tile zone: returns whether a preview was up (the caller hides the overlay). */
function clearSnap() {
  const s = drag?.snap;
  if (!s) return false;
  clearTimeout(s.timer);
  drag.snap = null;
  return s.shown;
}

const containsPt = (r, x, y) => r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
const rectOfEl = (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };

/** What the pointer is over: a screen edge (dock against the whole layout), a tab strip, a dockable, or the galaxy. */
function hitTest(x, y) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const ad = appDockInsets(); // the screen edges start where the app dock ends (it sits over them, z 3000)
  const edge = x < ad.l + ROOT_EDGE ? 'left' : x > vw - ad.r - ROOT_EDGE ? 'right' : y < ROOT_EDGE ? 'top' : y > vh - ad.b - ROOT_EDGE ? 'bottom' : null;
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

/** An addDropTarget target: the same preview, its label just below it. */
function showExtOverlay({ target, rect: r }) {
  const o = ensureOverlay();
  o.compass.classList.remove('show');
  Object.assign(o.preview.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
  o.preview.classList.add('show');
  o.label.textContent = target.label || 'Dock here';
  Object.assign(o.label.style, { left: r.x + r.w / 2 + 'px', top: r.y + r.h + 18 + 'px' });
  o.label.classList.add('show');
}

/** The tile preview: a translucent rect where the window will go, with a small label (no compass). */
function showTileOverlay({ rect: r, label }) {
  const o = ensureOverlay();
  o.compass.classList.remove('show');
  o.el.classList.add('tile');
  Object.assign(o.preview.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
  o.preview.classList.add('show');
  o.label.textContent = label || '';
  o.label.classList.toggle('show', !!label);
  Object.assign(o.label.style, { left: r.x + r.w / 2 + 'px', top: r.y + Math.min(r.h / 2, 60) + 'px' });
}

function hideOverlay() {
  overlay?.el.classList.remove('tile');
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
  if (d.snap) clearTimeout(d.snap.timer);
  drag = null;
  window.removeEventListener('pointermove', onDragMove, true);
  window.removeEventListener('pointerup', onDragUp, true);
  window.removeEventListener('pointercancel', onDragCancel, true);
  window.removeEventListener('keydown', onDragKey, true);
  try { d.hd.releasePointerCapture?.(d.pointerId); } catch { /* already released */ }
  document.body.classList.remove('dock-dragging');
  hideOverlay();
  d.ext?.target.leave?.();
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
  if (d.ext) {
    // Let go over an outside target: the element goes back where it was, the target takes it from there.
    el.style.cssText = d.snapshot.css;
    el.className = d.snapshot.cls;
    d.ext.target.drop(it.id);
    render();
    return;
  }
  const b = el.getBoundingClientRect();
  el.classList.remove('dragging', 'dock-lifted');
  if (d.docking) el.style.zIndex = /z-index:\s*(\d+)/.exec(d.snapshot.css)?.[1] || '';
  if (d.snap?.shown) {
    // Let go in a tile zone (its preview was showing): the window glides into the zone's rect. One lifted out of the
    // docked tree leaves it first (else render() docks it again), and untiling returns it to its lifted size there.
    const wasDocked = panelStatus(dockManager.getLayout(), it.id) === 'docked';
    const lifted = { x: b.left, y: b.top, w: b.width, h: b.height };
    if (wasDocked) dockManager.floatPanel(it.id, { ...d.snap.rect, vw: window.innerWidth, vh: window.innerHeight });
    windowSnap.drop(it, d.snap.zone, wasDocked ? lifted : d.start);
    if (d.docking) it.raise?.();
    announce(`${it.title} tiled: ${d.snap.label || d.snap.zone}.`);
    render();
    return;
  }
  if (it.kind === 'window') windowSnap?.moved(it); // moved or docked anywhere else: no longer tiled
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
  checkFormat(syncedStorage.getItem(STORAGE_KEY));
  readOnlyWhen(STORAGE_KEY, () => isPhone() || newerFormat); // phones never dock; a page too old for the synced format never overwrites it
  prepareKey(STORAGE_KEY, withoutWindows); // windows belong to this page, not to the mesh
  dockManager.attach({ storage: syncedStorage, defaults, viewport: () => ({ w: window.innerWidth, h: window.innerHeight }) });
  // Windows never outlive the page; the galaxy always has its place in the tree.
  dockManager.setLayout(withStage(stripWindows(dockManager.getLayout())));
  dockManager.subscribe(() => render());
  onRemoteKey(STORAGE_KEY, (raw) => { if (!checkFormat(raw)) reloadLayout(); });
  onRemoteKey(MODE_KEY, (raw) => setDocking(raw === '1'));
  window.addEventListener('resize', onResize);
  // The top menu bar (--mb-h) and the app dock (--ad-*) show / hide / move by setting variables on <html>: lay out again inside them.
  const insetKey = () => { const a = appDockInsets(); return `${topInset()},${a.l},${a.r},${a.b}`; };
  let lastInset = insetKey();
  new MutationObserver(() => { const k = insetKey(); if (k !== lastInset) { lastInset = k; queueRender(); } })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  window.matchMedia?.('(max-width: 640px), (max-height: 500px) and (pointer: coarse)')?.addEventListener?.('change', queueRender);
  onScalingChange(() => {
    if (scalingActive()) for (const it of items.values()) adoptWindow(it);
    watchViewport();
    render();
  });
  watchViewport();
}

// A layout saved by a newer JARVIS (a higher `version`, e.g. one that adds fields) cannot be read here: this page keeps
// its own layout and stops writing the synced one until it is reloaded with the new code, so a stale tab never
// replaces the mesh's layout with a default one in the old format.
let newerFormat = false;
function checkFormat(raw) {
  try { newerFormat = Number(JSON.parse(raw)?.version) > LAYOUT_VERSION; } catch { newerFormat = false; }
  return newerFormat;
}

const isWin = (id) => id.startsWith('win-');
function stripWindows(L) {
  for (const p of [...panelsIn(L.root), ...L.floating.map((f) => f.id), ...Object.keys(L.hidden)]) if (isWin(p)) L = removePanel(L, p);
  return L;
}
const withStage = (L) => (panelStatus(L, STAGE) === 'docked' ? L : dock(removePanel(L, STAGE), STAGE, 'root', 'right', { share: 0.7 }));
/** The synced form of a stored layout: the same JSON without this page's windows. */
function withoutWindows(v) {
  if (!JSON.stringify(v).includes('"win-')) return v;
  return JSON.parse(serialize(stripWindows(deserialize(v))));
}

/**
 * Another machine changed the layout (synced-storage.js wrote it to the cache, never while a pointer is held):
 * load it as on boot, then put this page's windows back where they are on screen, floating.
 */
function reloadLayout() {
  if (drag) endDrag(true);
  const wins = [...items.values()].filter((it) => it.kind === 'window' && panelStatus(dockManager.getLayout(), it.id));
  const rects = wins.map((it) => { const r = it.el.getBoundingClientRect(); return { id: it.id, x: r.left, y: r.top, w: r.width, h: r.height }; });
  syncedStorage.quiet(() => {
    dockManager.attach({});
    let L = withStage(stripWindows(dockManager.getLayout()));
    for (const r of rects) if (r.w > 0 && r.h > 0) L = undock(L, r.id, { ...r, vw: window.innerWidth, vh: window.innerHeight });
    dockManager.setLayout(L);
  });
  render();
}

/**
 * Resize handling for smart scaling: coalesced to one render per frame. Events that follow each other within
 * LIVE_MS mean the window edge is being dragged: .fit-live switches the transitions off so panels track the
 * edge exactly (no lag, no jitter); a single jump (maximise, restore, rotate) glides instead.
 */
function onResize() {
  const vp = `${window.innerWidth}x${window.innerHeight}`;
  if (vp === lastVp) return; // the same change seen twice (resize event + probe)
  lastVp = vp;
  const now = performance.now();
  if (scalingActive()) {
    if (now - lastResize < LIVE_MS) { root.classList.add('fit-live'); root.classList.remove('fit-moving'); }
    lastResize = now;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => root.classList.remove('fit-live'), LIVE_MS * 1.2);
  }
  queueRender();
}

// A fixed, invisible full-screen probe: its ResizeObserver catches viewport changes the resize event can miss
// (an embedded frame, devtools docking). The rAF queue and the viewport check make a second signal free.
let probe = null;
let probeObserver = null;
function watchViewport() {
  if (typeof ResizeObserver === 'undefined') return;
  if (!scalingActive()) { probeObserver?.disconnect(); probe?.remove(); probe = probeObserver = null; return; }
  if (probe) return;
  probe = h('div', { id: 'fit-probe', 'aria-hidden': 'true' });
  document.body.append(probe);
  probeObserver = new ResizeObserver(() => { if (`${window.innerWidth}x${window.innerHeight}` !== lastVp) onResize(); });
  probeObserver.observe(probe);
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
  ...scaleCommands, // isScaling, setScaling, toggleScaling, fitStats, resetFitStats (smart scaling)
};
