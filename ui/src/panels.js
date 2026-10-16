import { h } from './api.js';

// Every fixed panel of the JARVIS screen (side panel, filters, top bar, face, chat dock, bottom
// toolbar) can be dragged by its ⠿ grip and closed with ✕. Positions and closed state persist per
// browser. The ☰ corner button (never closable) lists the panels to bring them back or reset the layout.

const KEY = 'rigs.panels';
const panels = new Map(); // id → { el, title }
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

function setClosed(id, closed) {
  const p = panels.get(id);
  if (!p) return;
  p.el.classList.toggle('panel-closed', closed);
  state[id] = { ...state[id], closed };
  save();
  renderMenu();
}

/** Make a fixed element draggable and closable. The grip goes at the start of `into` (default: el). */
export function makeFloating(el, { id, title, into = el }) {
  if (!el) return;
  panels.set(id, { el, title });
  const grip = h('span', { class: 'pgrip', title: `Drag to move ${title} · double-click to reset` }, '⠿');
  const close = h('button', { class: 'pclose', title: `Close ${title} (bring it back from ☰)`, onclick: (e) => { e.stopPropagation(); setClosed(id, true); } }, '✕');
  into.prepend(h('span', { class: 'pctl' }, grip, close));
  el.classList.add('floating');

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

  const s = state[id];
  if (s?.pos) {
    if (s.pos.width) el.style.width = s.pos.width;
    if (s.pos.height) el.style.height = s.pos.height;
    place(el, s.pos);
  }
  if (s?.closed) el.classList.add('panel-closed');
}

function reset(id) {
  const p = panels.get(id);
  if (!p) return;
  for (const k of ['left', 'top', 'right', 'bottom', 'transform', 'width', 'height']) p.el.style[k] = '';
  state[id] = { closed: false };
  p.el.classList.remove('panel-closed');
  save();
  renderMenu();
}

export function showPanel(id) { setClosed(id, false); }
export function isClosed(id) { return !!state[id]?.closed; }

function renderMenu() {
  if (!menu) return;
  menu.list.replaceChildren(...[...panels].map(([id, p]) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: !p.el.classList.contains('panel-closed'), onchange: (e) => setClosed(id, !e.target.checked) }), ' ', p.title)));
}

/** The ☰ corner button: show/hide each panel, reset the layout. Call after the makeFloating()s. */
export function panelMenu() {
  const btn = h('button', { id: 'panels-btn', class: 'round', title: 'Panels — show, hide, reset layout' }, '☰');
  const list = h('div', {});
  const box = h('div', { id: 'panels-menu', class: 'panel hidden' }, h('h4', {}, 'Panels'), list,
    h('button', { class: 'ibtn', onclick: () => { for (const id of panels.keys()) reset(id); } }, '↺ Reset layout'));
  menu = { box, list };
  btn.onclick = () => { renderMenu(); box.classList.toggle('hidden'); };
  document.addEventListener('pointerdown', (e) => { if (!box.contains(e.target) && e.target !== btn) box.classList.add('hidden'); });
  document.body.append(btn, box);
  window.addEventListener('resize', () => { for (const [id, p] of panels) if (state[id]?.pos) place(p.el, state[id].pos); });
  renderMenu();
}
