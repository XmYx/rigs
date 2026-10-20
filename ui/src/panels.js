import { h } from './api.js';
import { isPhone } from './mobile.js';
import { dockManager, panelWindowState, setActiveTab, emptyLayout } from './dock-layout.js';
import { initDocking, registerDockable, render, clampPanel, STAGE } from './docking.js';
import { tagCtx } from './ctx-tag.js';
import { buildChrome } from './window-state.js';
import { pushBack, dropBack } from './wm.js';

// Every fixed panel of the JARVIS screen (side panel, filters, top bar, face, chat dock, work dashboard, questions,
// tokens & time, desktops, traces, agents, graphify, footer, Ask JARVIS) is a window: its whole header is the grab area
// (the ⠿ grip still works; double-click it to put the panel back at its default place) and it has the wm.js title bar
// buttons, the same elements in the same order (window-state.js buildChrome): – minimize, □/❐ maximize/restore, ✕ close.
//   minimize  a floating panel folds to its title strip where it is (elements marked .keep or the `keep` option stay
//             visible: the face keeps its orb, the chat its header); the strip's first button is then ❐ Restore. The
//             app dock shows it minimized (its tool tile, `dockRef`, else a panel tile of its own; open-events.js
//             trackPanels) and a click there restores it.
//   maximize  the panel fills the stage (below the top menu bar, clear of the app dock) over everything else; double-
//             clicking its header does the same. Its place is untouched, so restore puts it back exactly.
//   close     the panel goes, remembering exactly where it was; the Panels menu lists it (unchecked) and reopens it
//             there. The old ▾ collapse is minimize, the old ✕ hide is close (saved layouts are migrated: dock-layout.js).
// Docked / tabbed mode (docking.js): minimize and close act on the tab — the panel leaves the tree (its place kept) and
// comes back to the same slot or tab; maximize zooms the panel over the whole stage without un-docking it, and restore
// drops it back into its slot. The galaxy (STAGE) and the ☰ corner button are not panels and cannot be closed.
// Phones: the CSS phone layout places the panels (sheets under the header, the chat above the toolbar, the side panel a
// drawer); they keep only ✕ (no minimize or maximize), and a sheet opened by hand closes with the back gesture too.
// The layout lives in the dock layout engine (dock-layout.js, storage 'rigs.dock'); docking.js draws it.

const panels = new Map(); // id → { el, title, chrome, onToggle, listed, dockRef, off, backOn, closeBack, phoneBack }
const startHidden = new Set(); // panels closed by default (also after Reset layout)
const inherited = new Set(); // inheritPanel: start closed because the panel it was split from is closed
const removedIds = new Set(); // panels in the Removed list (layout-actions.js): kept closed, left out of the Panels menu
let topZ = 12; // focusPanel raises a floating panel above the others, still under windows (z 100+)

const NO_RECT = { x: null, y: null, w: null, h: null, vw: null, vh: null };
// A double-click on these inside a header is theirs, not the header's maximize.
const NO_DBL = 'button, a, input, select, textarea, label, summary, [contenteditable=""], [contenteditable="true"], [role="button"], [role="tab"], .presize, .no-drag';

/** The layout Reset goes back to: the galaxy alone in the tree, every panel at its CSS place, default-closed ones hidden. */
function defaults() {
  const L = emptyLayout();
  L.root = { type: 'panel', id: STAGE };
  let z = 0;
  for (const id of panels.keys()) {
    if (startHidden.has(id)) L.hidden[id] = { kind: 'float', rect: { ...NO_RECT } };
    else L.floating.push({ id, ...NO_RECT, z: ++z });
  }
  return L;
}
initDocking({ defaults });

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const MIN_W = 160;
const MIN_H = 48;

/** Eight resize handles (edges and corners) on a floating panel; the size and position persist with it. */
function addResizeHandles(el, id) {
  for (const dir of EDGES) {
    const hd = document.createElement('span');
    hd.className = `presize presize-${dir}`;
    hd.dataset.dir = dir;
    hd.title = 'Drag to resize';
    hd.setAttribute('aria-hidden', 'true');
    el.append(hd);
    hd.addEventListener('pointerdown', (e) => {
      if (el.classList.contains('docked') || el.classList.contains('panel-max')) return; // docked panels resize with the splitters
      e.preventDefault();
      e.stopPropagation();
      const r = el.getBoundingClientRect();
      const sx = e.clientX;
      const sy = e.clientY;
      hd.setPointerCapture(e.pointerId);
      el.classList.add('resizing');
      const move = (ev) => {
        const dx = ev.clientX - sx;
        const dy = ev.clientY - sy;
        let left = r.left;
        let top = r.top;
        let width = r.width;
        let height = r.height;
        if (dir.includes('e')) width = Math.max(MIN_W, r.width + dx);
        if (dir.includes('w')) { width = Math.max(MIN_W, r.width - dx); left = r.right - width; }
        if (dir.includes('s')) height = Math.max(MIN_H, r.height + dy);
        if (dir.includes('n')) { height = Math.max(MIN_H, r.height - dy); top = r.bottom - height; }
        width = Math.min(width, window.innerWidth - 8);
        height = Math.min(height, window.innerHeight - 8);
        const [l, t] = clampPanel(left, top, width);
        Object.assign(el.style, { width: width + 'px', height: height + 'px', left: l + 'px', top: t + 'px', right: 'auto', bottom: 'auto', transform: 'none' });
      };
      const up = () => {
        hd.removeEventListener('pointermove', move);
        hd.removeEventListener('pointerup', up);
        el.classList.remove('resizing');
        const b = el.getBoundingClientRect();
        dockManager.floatPanel(id, { x: b.left, y: b.top, w: b.width, h: b.height, vw: window.innerWidth, vh: window.innerHeight });
        el.dispatchEvent(new CustomEvent('panelresize'));
      };
      hd.addEventListener('pointermove', move);
      hd.addEventListener('pointerup', up);
    });
  }
}

/** Animated show/hide: fade + scale out, then display:none; the reverse on the way back. */
function animateClosed(el, closed) {
  clearTimeout(el._panelTimer);
  if (reduced()) { el.classList.toggle('panel-closed', closed); el.classList.remove('panel-out'); return; }
  if (closed) {
    el.classList.add('panel-out');
    el._panelTimer = setTimeout(() => el.classList.add('panel-closed'), 190);
  } else {
    el.classList.add('panel-out');
    el.classList.remove('panel-closed');
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('panel-out')));
  }
}

const stateOf = (id) => panelWindowState(dockManager.getLayout(), id);

/**
 * Every state change of a panel goes through here: its title bar buttons, double-click on its header, the context
 * menu, the Panels menu, the app dock. `action`: minimize | maximize | restore | toggleMaximize | close | open.
 */
export function panelAction(id, action) {
  const p = panels.get(id);
  if (!p) return;
  if (isPhone() && (action === 'minimize' || action === 'maximize' || action === 'toggleMaximize')) return; // phones: the CSS phone layout places panels; ✕ only
  const docked = p.el.classList.contains('docked');
  // Don't strand focus on a panel that leaves the stage (a docked one minimizes out of the tree; a strip keeps its buttons).
  if ((action === 'close' || (action === 'minimize' && docked)) && p.el.contains(document.activeElement)) document.activeElement.blur();
  if (action === 'maximize' || action === 'toggleMaximize') dockManager.apply(setActiveTab, id); // a tab: maximize the one you see
  dockManager.panelAction(id, action);
}

/** Close (remembering exactly where it was) or bring back a panel. */
export function setClosed(id, closed) { panelAction(id, closed ? 'close' : 'open'); }

/** Show a window state change on the panel (docking.js calls it from render). */
function showState(id, state, { initial, stowed }) {
  const p = panels.get(id);
  const { el } = p;
  if (initial) el.classList.toggle('panel-closed', stowed);
  else if (stowed !== p.off) animateClosed(el, stowed);
  p.off = stowed;
  const strip = state === 'minimized' && !stowed;
  // A strip's height is auto and its bottom free: a panel at its CSS place anchored to the bottom (the chat, the face)
  // would jump to the top of the screen. Pin its top where it is while it is a strip (measured before it folds).
  if (strip && !p.pinTop && !el.style.top && !isPhone()) { el.style.top = `${Math.round(el.getBoundingClientRect().top)}px`; p.pinTop = el.style.top; }
  else if (!strip && p.pinTop) { if (el.style.top === p.pinTop) el.style.top = ''; p.pinTop = null; }
  el.classList.toggle('panel-min', strip);
  el.classList.toggle('panel-max', state === 'maximized' && !isPhone());
  p.chrome.sync({ state: state === 'closed' ? 'normal' : state });
  phoneBack(p, id, { initial, stowed });
  if (!initial) p.onToggle?.({ closed: state === 'closed', minimized: state === 'minimized', maximized: state === 'maximized', state });
}

/** Phones: a sheet opened by hand owns a back entry (as a window does), given back when it closes some other way. */
function phoneBack(p, id, { initial, stowed }) {
  if (stowed && p.backOn) { p.backOn = false; dropBack(p.closeBack); return; }
  if (initial || stowed || p.backOn || !p.phoneBack || !isPhone() || removedIds.has(id)) return;
  p.backOn = true;
  pushBack(p.closeBack);
}

/**
 * Make a fixed element a movable, dockable panel with the window title bar buttons. The grip and the buttons go at the
 * start of `into` (default: el). `handle` is the title bar that drags it (default: `into` when that is a header, else the
 * element itself). `listed() === false` leaves it out of the Panels menu, the Window menu and Show all / Hide others for
 * now (Ask JARVIS in the top bar). `dockRef`: the app dock item that stands for it while it is minimized (its tool tile).
 */
export function makeFloating(el, { id, title, into = el, handle, keep = [], onToggle, closedOnPhone = false, closedByDefault = false, listed = () => true, dockRef = null }) {
  if (!el) return;
  for (const k of keep) k?.classList.add('keep');
  const grip = h('span', { class: 'pgrip', 'aria-hidden': 'true', title: `Drag to move ${title} (or drag its title bar) · double-click to reset` }, '⠿');
  const chrome = buildChrome(h, (action) => panelAction(id, action));
  const p = {
    el, title, chrome, onToggle, listed, dockRef, off: false, backOn: false,
    phoneBack: closedOnPhone || closedByDefault, // the sheets; the always-on panels (chat, header, drawer) have their own ways
    closeBack: ({ fromBack } = {}) => { if (fromBack) { p.backOn = false; setClosed(id, true); } },
  };
  panels.set(id, p);
  into.prepend(h('span', { class: 'pctl keep', role: 'group', 'aria-label': `${title} window` }, grip, ...chrome.els));
  el.classList.add('floating');
  tagCtx(el, 'panel', id, { id, title }); // right-click / long-press: Restore, Minimize, Maximize, Close, Reset, Dock, Remove (ctx-providers.js)
  addResizeHandles(el, id);
  grip.addEventListener('dblclick', (e) => { e.stopPropagation(); reset(id); });
  grip.addEventListener('click', (e) => e.stopPropagation());
  const bar = handle || (into !== el ? into : el);
  // A real header (not the whole element, as for the face or the top bar): double-click maximizes / restores, like a window.
  if (bar !== el) bar.addEventListener('dblclick', (e) => { if (!e.target.closest(NO_DBL)) panelAction(id, 'toggleMaximize'); });

  // Some panels start closed the first time (and on a phone), so the galaxy is not buried on first load.
  if (closedByDefault) startHidden.add(id);
  dockManager.registerPanel(id, { title, hidden: closedByDefault || (closedOnPhone && isPhone()) || inherited.has(id) });
  registerDockable(id, {
    el, title, kind: 'panel',
    handles: [bar, grip],
    canDrag: () => !isPhone() && !el.classList.contains('panel-max'), // a maximized panel stays put, as a maximized window does
    onState: (state, info) => showState(id, state, info),
  });
}

/** Put one panel back at its CSS place, shown normal (double-click on its grip, Reset position and size). */
function reset(id) {
  if (!panels.has(id)) return;
  dockManager.floatPanel(id, NO_RECT);
  if (stateOf(id) === 'minimized') dockManager.panelAction(id, 'restore');
  if (stateOf(id) === 'maximized') dockManager.panelAction(id, 'restore');
}

/** First run of a panel split off another one: start from the parent's closed state (never overrides saved state). */
export function inheritPanel(id, fromId) {
  if (!stateOf(id) && stateOf(fromId) === 'closed') inherited.add(id);
}
/** Show a panel: a closed one reopens at its place, a minimized one is restored. */
export function showPanel(id) { panelAction(id, 'open'); }
export function togglePanel(id) { const s = stateOf(id); if (s === 'closed' || s === 'minimized') showPanel(id); else setClosed(id, true); }
/** { state, closed, minimized, maximized } — state: 'normal' | 'minimized' | 'maximized' | 'closed'. */
export function panelState(id) { const state = stateOf(id); return { state, closed: state === 'closed', minimized: state === 'minimized', maximized: state === 'maximized' }; }
export function isClosed(id) { return stateOf(id) === 'closed'; }
export function resetPanel(id) { reset(id); }

/** Every registered panel: { id, el, title, state, closed, minimized, maximized, removed, dockRef }. */
export function listPanels() {
  return [...panels].filter(([, p]) => p.listed()).map(([id, p]) => ({ id, el: p.el, title: p.title, ...panelState(id), removed: removedIds.has(id), dockRef: p.dockRef }));
}
export const hasPanel = (id) => panels.has(id);

/** Show a panel, bring it to the front (its tab when docked in a group) and move focus into it, with a short highlight. */
export function focusPanel(id) {
  const p = panels.get(id);
  if (!p) return;
  showPanel(id);
  dockManager.apply(setActiveTab, id);
  if (!p.el.classList.contains('docked')) p.el.style.zIndex = String(topZ = Math.min(topZ + 1, 90));
  p.el.classList.remove('panel-flash');
  void p.el.offsetWidth; // restart the animation
  p.el.classList.add('panel-flash');
  setTimeout(() => p.el.classList.remove('panel-flash'), 900);
  const target = p.el.querySelector('input:not([type=hidden]), button:not(.win-btn), [tabindex="0"], a[href]') || p.el;
  if (target === p.el && !p.el.hasAttribute('tabindex')) p.el.setAttribute('tabindex', '-1');
  requestAnimationFrame(() => target.focus?.({ preventScroll: true }));
}

/** Removed panels stay closed and leave the Panels menu until restored. */
export function setRemoved(id, removed) {
  if (removed) { removedIds.add(id); if (panels.has(id) && !isClosed(id)) setClosed(id, true); }
  else removedIds.delete(id);
}

/** Every panel back to its default place (Reset layout): shown normal, default-closed ones closed; removed ones stay removed. */
export function resetLayout() {
  dockManager.resetLayout();
  for (const id of removedIds) if (panels.has(id) && !isClosed(id)) dockManager.hidePanel(id);
  render();
}
