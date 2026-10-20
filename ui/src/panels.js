import { h } from './api.js';
import { isPhone } from './mobile.js';
import { dockManager, panelStatus, setCollapsed as setCollapsedOp, setActiveTab, emptyLayout } from './dock-layout.js';
import { initDocking, registerDockable, render, clampPanel, STAGE } from './docking.js';
import { tagCtx } from './ctx-tag.js';

// Every fixed panel of the JARVIS screen (side panel, filters, top bar, face, chat dock, work dashboard,
// bottom toolbar) moves like a desktop window: its whole header is the grab area (the ⠿ grip still works),
// ▾ collapses it to its header (elements marked .keep or the `keep` option stay) and ✕ hides it — all
// animated. The layout lives in the dock layout engine (dock-layout.js, storage 'rigs.dock', migrated from
// the old 'rigs.panels') and is drawn by docking.js: floating rects, the optional docked tree with tabs,
// hidden panels with the exact place they were hidden from, collapsed panels. The Panels item in the top menu bar
// (jarvis-commands.js) switches the docking layout and Smart scaling (scaling.js: keeps every panel on screen as the
// window resizes), shows or hides each panel, and resets the layout.

const panels = new Map(); // id → { el, title, collapseBtn, onToggle, listed }
const startHidden = new Set(); // panels closed by default (also after Reset layout)
const inherited = new Set(); // inheritPanel: start closed because the panel it was split from is closed
const removedIds = new Set(); // panels in the Removed list (layout-actions.js): kept closed, left out of the Panels menu
let topZ = 12; // focusPanel raises a floating panel above the others, still under windows (z 100+)

const NO_RECT = { x: null, y: null, w: null, h: null, vw: null, vh: null };

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
      if (el.classList.contains('docked')) return; // docked panels resize with the splitters
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

/** Hide (remembering exactly where it was) or bring back a panel. */
export function setClosed(id, closed) {
  const p = panels.get(id);
  if (!p) return;
  if (closed && p.el.contains(document.activeElement)) document.activeElement.blur(); // don't strand focus on a hidden panel
  if (closed) dockManager.hidePanel(id);
  else dockManager.restorePanel(id);
}

function setCollapsed(id, collapsed) {
  if (panels.has(id)) dockManager.apply(setCollapsedOp, id, collapsed);
}

const isCollapsed = (id) => dockManager.getLayout().collapsed.includes(id);

/**
 * Make a fixed element a movable, closable, dockable panel. The grip goes at the start of `into` (default: el).
 * `handle` is the title bar that drags it (default: `into` when that is a header, else the element itself).
 * `listed() === false` leaves it out of the Panels menu, the Window menu and Show all / Hide others for now (Ask JARVIS in the top bar).
 */
export function makeFloating(el, { id, title, into = el, handle, keep = [], onToggle, closedOnPhone = false, closedByDefault = false, listed = () => true }) {
  if (!el) return;
  for (const k of keep) k?.classList.add('keep');
  const grip = h('span', { class: 'pgrip', 'aria-hidden': 'true', title: `Drag to move ${title} (or drag its title bar) · double-click to reset` }, '⠿');
  const close = h('button', { class: 'pclose', title: `Close ${title} (bring it back from the Panels menu)`, 'aria-label': `Close ${title}`, onclick: (e) => { e.stopPropagation(); setClosed(id, true); } }, '✕');
  const collapseBtn = h('button', { class: 'pclose pcollapse', title: `Collapse ${title}`, 'aria-label': `Collapse ${title}`, 'aria-expanded': 'true', onclick: (e) => { e.stopPropagation(); setCollapsed(id, !el.classList.contains('panel-collapsed')); } }, '▾');
  const p = { el, title, collapseBtn, onToggle, listed };
  panels.set(id, p);
  into.prepend(h('span', { class: 'pctl keep' }, grip, collapseBtn, close));
  el.classList.add('floating');
  tagCtx(el, 'panel', id, { id, title }); // right-click / long-press: Collapse, Reset, Hide, Remove (contextmenu.js)
  addResizeHandles(el, id);
  grip.addEventListener('dblclick', () => reset(id));
  grip.addEventListener('click', (e) => e.stopPropagation());

  // Some panels start closed the first time (and on a phone), so the galaxy is not buried on first load.
  if (closedByDefault) startHidden.add(id);
  dockManager.registerPanel(id, { title, hidden: closedByDefault || (closedOnPhone && isPhone()) || inherited.has(id) });
  registerDockable(id, {
    el, title, kind: 'panel',
    handles: [handle || (into !== el ? into : el), grip],
    onClosed: (closed, initial) => {
      if (initial) el.classList.toggle('panel-closed', closed);
      else { animateClosed(el, closed); p.onToggle?.({ closed, collapsed: isCollapsed(id) }); }
    },
    onCollapsed: (collapsed, initial) => {
      el.classList.toggle('panel-collapsed', collapsed);
      collapseBtn.textContent = collapsed ? '▸' : '▾';
      collapseBtn.title = `${collapsed ? 'Expand' : 'Collapse'} ${title}`;
      collapseBtn.setAttribute('aria-label', collapseBtn.title);
      collapseBtn.setAttribute('aria-expanded', String(!collapsed));
      if (!initial || collapsed) p.onToggle?.({ closed: isClosed(id), collapsed });
    },
  });
}

/** Put one panel back at its CSS place, open and expanded (double-click on its grip). */
function reset(id) {
  if (!panels.has(id)) return;
  dockManager.floatPanel(id, NO_RECT);
  setCollapsed(id, false);
}

/** First run of a panel split off another one: start from the parent's closed state (never overrides saved state). */
export function inheritPanel(id, fromId) {
  const L = dockManager.getLayout();
  if (!panelStatus(L, id) && L.hidden[fromId]) inherited.add(id);
}
export function showPanel(id) { setClosed(id, false); if (isCollapsed(id)) setCollapsed(id, false); }
export function togglePanel(id) { if (isClosed(id)) showPanel(id); else setClosed(id, true); }
export function panelState(id) { return { closed: isClosed(id), collapsed: isCollapsed(id) }; }
export function isClosed(id) { return panelStatus(dockManager.getLayout(), id) === 'hidden'; }
export function toggleCollapsed(id) { setCollapsed(id, !isCollapsed(id)); }
export function resetPanel(id) { reset(id); }

/** Every registered panel: { id, el, title, closed, collapsed, removed }. */
export function listPanels() {
  return [...panels].filter(([, p]) => p.listed()).map(([id, p]) => ({ id, el: p.el, title: p.title, closed: isClosed(id), collapsed: isCollapsed(id), removed: removedIds.has(id) }));
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
  const target = p.el.querySelector('input:not([type=hidden]), button:not(.pclose), [tabindex="0"], a[href]') || p.el;
  if (target === p.el && !p.el.hasAttribute('tabindex')) p.el.setAttribute('tabindex', '-1');
  requestAnimationFrame(() => target.focus?.({ preventScroll: true }));
}

/** Removed panels stay closed and leave the Panels menu until restored. */
export function setRemoved(id, removed) {
  if (removed) { removedIds.add(id); if (panels.has(id) && !isClosed(id)) setClosed(id, true); }
  else removedIds.delete(id);
}

/** Every panel back to its default place (Reset layout); removed ones stay removed. */
export function resetLayout() {
  dockManager.resetLayout();
  for (const id of removedIds) if (panels.has(id) && !isClosed(id)) dockManager.hidePanel(id);
  render();
}
