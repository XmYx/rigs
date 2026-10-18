import { h } from './api.js';
import { isPhone } from './mobile.js';
import { dockManager, panelStatus, setCollapsed as setCollapsedOp, emptyLayout } from './dock-layout.js';
import { initDocking, registerDockable, render, isDocking, toggleDocking, onDockingChange, clampPanel, STAGE } from './docking.js';

// Every fixed panel of the JARVIS screen (side panel, filters, top bar, face, chat dock, work dashboard,
// bottom toolbar) moves like a desktop window: its whole header is the grab area (the ⠿ grip still works),
// ▾ collapses it to its header (elements marked .keep or the `keep` option stay) and ✕ hides it — all
// animated. The layout lives in the dock layout engine (dock-layout.js, storage 'rigs.dock', migrated from
// the old 'rigs.panels') and is drawn by docking.js: floating rects, the optional docked tree with tabs,
// hidden panels with the exact place they were hidden from, collapsed panels. The ☰ corner button (never
// closable) switches the docking layout, lists hidden panels to bring them back, and resets the layout.

const panels = new Map(); // id → { el, title, collapseBtn, onToggle }
const startHidden = new Set(); // panels closed by default (also after Reset layout)
const inherited = new Set(); // inheritPanel: start closed because the panel it was split from is closed
let menu = null;

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
  if (closed && p.el.contains(document.activeElement)) document.getElementById('panels-btn')?.focus({ preventScroll: true }); // don't strand focus on a hidden panel
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
 */
export function makeFloating(el, { id, title, into = el, handle, keep = [], onToggle, closedOnPhone = false, closedByDefault = false }) {
  if (!el) return;
  for (const k of keep) k?.classList.add('keep');
  const grip = h('span', { class: 'pgrip', 'aria-hidden': 'true', title: `Drag to move ${title} (or drag its title bar) · double-click to reset` }, '⠿');
  const close = h('button', { class: 'pclose', title: `Close ${title} (bring it back from ☰)`, 'aria-label': `Close ${title}`, onclick: (e) => { e.stopPropagation(); setClosed(id, true); } }, '✕');
  const collapseBtn = h('button', { class: 'pclose pcollapse', title: `Collapse ${title}`, 'aria-label': `Collapse ${title}`, 'aria-expanded': 'true', onclick: (e) => { e.stopPropagation(); setCollapsed(id, !el.classList.contains('panel-collapsed')); } }, '▾');
  const p = { el, title, collapseBtn, onToggle };
  panels.set(id, p);
  into.prepend(h('span', { class: 'pctl keep' }, grip, collapseBtn, close));
  el.classList.add('floating');
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
      renderMenu();
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

function renderMenu() {
  if (!menu) return;
  const list = dockManager.listPanels().filter((x) => panels.has(x.id));
  const hidden = list.filter((x) => x.status === 'hidden');
  menu.dockToggle.checked = isDocking();
  menu.dockRow.hidden = isPhone(); // phones never dock
  menu.list.replaceChildren(...list.filter((x) => x.status !== 'hidden').map((x) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: true, onchange: (e) => setClosed(x.id, !e.target.checked) }), ' ', x.title,
    x.status === 'docked' && isDocking() ? h('span', { class: 'pm-where' }, 'docked') : '')));
  menu.hiddenHead.hidden = !hidden.length;
  menu.hidden.replaceChildren(...hidden.map((x) => h('button', { class: 'ibtn pm-restore', title: `Bring ${x.title} back where it was`, onclick: () => showPanel(x.id) }, `↩ ${x.title}`)));
}

/** The ☰ corner button: the docking layout switch, show/hide and restore each panel, reset the layout. Call after the makeFloating()s. */
export function panelMenu() {
  const btn = h('button', { id: 'panels-btn', class: 'round', title: 'Panels — docking, show, hide, reset layout', 'aria-label': 'Panels', 'aria-haspopup': 'dialog' }, '☰');
  const list = h('div', {});
  const hiddenList = h('div', { class: 'pm-hidden' });
  const hiddenHead = h('h5', { class: 'pm-sub' }, 'Hidden — restore to their last place');
  const dockToggle = h('input', { type: 'checkbox', role: 'switch', onchange: (e) => { toggleDocking(); e.target.checked = isDocking(); } });
  const dockRow = h('label', { class: 'check pm-dock', title: 'Drag a panel or window by its title bar onto another to dock it beside it or as a tab' }, dockToggle, ' Docking layout');
  const box = h('div', { id: 'panels-menu', class: 'panel hidden' }, h('h4', {}, 'Panels'), dockRow, list, hiddenHead, hiddenList,
    h('button', { class: 'ibtn', onclick: () => { dockManager.resetLayout(); render(); } }, '↺ Reset layout'));
  menu = { box, list, hidden: hiddenList, hiddenHead, dockToggle, dockRow };
  btn.onclick = () => { renderMenu(); box.classList.toggle('hidden'); };
  document.addEventListener('pointerdown', (e) => { if (!box.contains(e.target) && e.target !== btn) box.classList.add('hidden'); });
  document.body.append(btn, box);
  dockManager.subscribe(() => renderMenu());
  onDockingChange(() => renderMenu());
  renderMenu();
}
