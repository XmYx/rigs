import { h } from './api.js';
import { isPhone } from './mobile.js';

// Every fixed panel of the JARVIS screen (side panel, filters, top bar, face, chat dock, work dashboard,
// bottom toolbar) can be dragged by its ⠿ grip, collapsed with ▾ to its header (elements marked .keep or
// the `keep` option stay) and closed with ✕ — all animated. Position, collapsed and closed state persist per
// browser. The ☰ corner button (never closable) lists the panels to bring them back or reset the layout.

const KEY = 'rigs.panels';
const panels = new Map(); // id → { el, title }
let topZ = 12; // focusPanel raises a panel above the others, still under windows (z 100+)
const removedIds = new Set(); // panels in the Removed list (layout-actions.js): kept closed, left out of ☰
let state = load();
let menu = null;

function load() { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } }
function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode */ } }

function place(el, pos) {
  const r = el.getBoundingClientRect();
  const left = Math.min(Math.max(0, pos.left), Math.max(0, window.innerWidth - Math.min(r.width, 80)));
  const top = Math.min(Math.max(0, pos.top), Math.max(0, window.innerHeight - 28));
  Object.assign(el.style, { left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto', transform: 'none' });
}

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const MIN_W = 160;
const MIN_H = 48;

/** Eight resize handles (edges and corners) on a floating panel; sizes and position persist with it. */
function addResizeHandles(el, id) {
  for (const dir of EDGES) {
    const hd = document.createElement('span');
    hd.className = `presize presize-${dir}`;
    hd.dataset.dir = dir;
    hd.title = 'Drag to resize';
    hd.setAttribute('aria-hidden', 'true');
    el.append(hd);
    hd.addEventListener('pointerdown', (e) => {
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
        Object.assign(el.style, { width: width + 'px', height: height + 'px' });
        place(el, { left, top });
      };
      const up = () => {
        hd.removeEventListener('pointermove', move);
        hd.removeEventListener('pointerup', up);
        el.classList.remove('resizing');
        const b = el.getBoundingClientRect();
        state[id] = { ...state[id], pos: { left: b.left, top: b.top, width: b.width + 'px', height: b.height + 'px' } };
        save();
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

export function setClosed(id, closed) {
  const p = panels.get(id);
  if (!p) return;
  if (closed && p.el.contains(document.activeElement)) document.getElementById('panels-btn')?.focus({ preventScroll: true }); // don't strand focus on a hidden panel
  animateClosed(p.el, closed);
  state[id] = { ...state[id], closed };
  save();
  renderMenu();
  p.onToggle?.({ closed, collapsed: !!state[id]?.collapsed });
}

function setCollapsed(id, collapsed) {
  const p = panels.get(id);
  if (!p) return;
  p.el.classList.toggle('panel-collapsed', collapsed);
  p.collapseBtn.textContent = collapsed ? '▸' : '▾';
  p.collapseBtn.title = `${collapsed ? 'Expand' : 'Collapse'} ${p.title}`;
  p.collapseBtn.setAttribute('aria-label', p.collapseBtn.title);
  p.collapseBtn.setAttribute('aria-expanded', String(!collapsed));
  state[id] = { ...state[id], collapsed };
  save();
  p.onToggle?.({ closed: !!state[id]?.closed, collapsed });
}

/** Make a fixed element draggable and closable. The grip goes at the start of `into` (default: el). */
export function makeFloating(el, { id, title, into = el, keep = [], onToggle, closedOnPhone = false, closedByDefault = false }) {
  if (!el) return;
  for (const k of keep) k?.classList.add('keep');
  const grip = h('span', { class: 'pgrip', 'aria-hidden': 'true', title: `Drag to move ${title} · double-click to reset` }, '⠿');
  const close = h('button', { class: 'pclose', title: `Close ${title} (bring it back from ☰)`, 'aria-label': `Close ${title}`, onclick: (e) => { e.stopPropagation(); setClosed(id, true); } }, '✕');
  const collapseBtn = h('button', { class: 'pclose pcollapse', title: `Collapse ${title}`, 'aria-label': `Collapse ${title}`, 'aria-expanded': 'true', onclick: (e) => { e.stopPropagation(); setCollapsed(id, !el.classList.contains('panel-collapsed')); } }, '▾');
  panels.set(id, { el, title, collapseBtn, onToggle });
  into.prepend(h('span', { class: 'pctl keep' }, grip, collapseBtn, close));
  el.classList.add('floating');
  addResizeHandles(el, id);

  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    // Freeze the size so panels anchored to two edges (e.g. top + bottom) don't stretch while moving
    if (!state[id]?.pos) Object.assign(el.style, { width: r.width + 'px', height: r.height + 'px' });
    grip.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    const move = (ev) => place(el, { left: ev.clientX - dx, top: ev.clientY - dy });
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      el.classList.remove('dragging');
      const b = el.getBoundingClientRect();
      state[id] = { ...state[id], pos: { left: b.left, top: b.top, width: el.style.width || null, height: el.style.height || null } };
      save();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
  grip.addEventListener('dblclick', () => reset(id));
  grip.addEventListener('click', (e) => e.stopPropagation());

  // On a phone some panels start closed (until shown once), so the galaxy is not buried on first load.
  if ((closedByDefault || (closedOnPhone && isPhone())) && !state[id]) state[id] = { closed: true };
  const s = state[id];
  if (s?.pos) {
    if (s.pos.width) el.style.width = s.pos.width;
    if (s.pos.height) el.style.height = s.pos.height;
    place(el, s.pos);
  }
  if (s?.closed) el.classList.add('panel-closed');
  if (s?.collapsed) setCollapsed(id, true);
}

function reset(id) {
  const p = panels.get(id);
  if (!p) return;
  for (const k of ['left', 'top', 'right', 'bottom', 'transform', 'width', 'height']) p.el.style[k] = '';
  state[id] = { closed: false, collapsed: false };
  p.el.classList.remove('panel-collapsed');
  p.collapseBtn.textContent = '▾';
  animateClosed(p.el, false);
  save();
  renderMenu();
}

/** First run of a panel split off another one: start from the parent's closed state (never overrides saved state). */
export function inheritPanel(id, fromId) {
  if (state[id] || !state[fromId]) return;
  if (state[fromId].closed) { state[id] = { closed: true }; save(); }
}
export function showPanel(id) { setClosed(id, false); if (state[id]?.collapsed) setCollapsed(id, false); }
export function togglePanel(id) { if (state[id]?.closed) showPanel(id); else setClosed(id, true); }
export function panelState(id) { return { closed: !!state[id]?.closed, collapsed: !!state[id]?.collapsed }; }
export function isClosed(id) { return !!state[id]?.closed; }

/** Every registered panel: { id, title, closed, collapsed, removed }. */
export function listPanels() {
  return [...panels].map(([id, p]) => ({ id, el: p.el, title: p.title, closed: !!state[id]?.closed, collapsed: !!state[id]?.collapsed, removed: removedIds.has(id) }));
}
export const hasPanel = (id) => panels.has(id);

/** Show a panel, raise it above the others and move focus into it (with a short highlight). */
export function focusPanel(id) {
  const p = panels.get(id);
  if (!p) return;
  showPanel(id);
  p.el.style.zIndex = String(topZ = Math.min(topZ + 1, 90));
  p.el.classList.remove('panel-flash');
  void p.el.offsetWidth; // restart the animation
  p.el.classList.add('panel-flash');
  setTimeout(() => p.el.classList.remove('panel-flash'), 900);
  const target = p.el.querySelector('input:not([type=hidden]), button:not(.pclose), [tabindex="0"], a[href]') || p.el;
  if (target === p.el && !p.el.hasAttribute('tabindex')) p.el.setAttribute('tabindex', '-1');
  requestAnimationFrame(() => target.focus?.({ preventScroll: true }));
}
/** Removed panels stay closed and leave the ☰ list until restored. */
export function setRemoved(id, removed) {
  if (removed) { removedIds.add(id); if (panels.has(id) && !state[id]?.closed) setClosed(id, true); }
  else removedIds.delete(id);
  renderMenu();
}

/** Every panel back to its default place and open (removed ones stay removed). */
export function resetLayout() { for (const id of panels.keys()) if (!removedIds.has(id)) reset(id); }

function renderMenu() {
  if (!menu) return;
  menu.list.replaceChildren(...[...panels].filter(([id]) => !removedIds.has(id)).map(([id, p]) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: !p.el.classList.contains('panel-closed'), onchange: (e) => setClosed(id, !e.target.checked) }), ' ', p.title)));
}

/** The ☰ corner button: show/hide each panel, reset the layout. Call after the makeFloating()s. */
export function panelMenu() {
  const btn = h('button', { id: 'panels-btn', class: 'round', title: 'Panels — show, hide, reset layout', 'aria-label': 'Panels', 'aria-haspopup': 'dialog' }, '☰');
  const list = h('div', {});
  const box = h('div', { id: 'panels-menu', class: 'panel hidden' }, h('h4', {}, 'Panels'), list,
    h('button', { class: 'ibtn', onclick: () => resetLayout() }, '↺ Reset layout'));
  menu = { box, list };
  btn.onclick = () => { renderMenu(); box.classList.toggle('hidden'); };
  document.addEventListener('pointerdown', (e) => { if (!box.contains(e.target) && e.target !== btn) box.classList.add('hidden'); });
  document.body.append(btn, box);
  window.addEventListener('resize', () => { for (const [id, p] of panels) if (state[id]?.pos) place(p.el, state[id].pos); });
  renderMenu();
}
