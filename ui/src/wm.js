import { h } from './api.js';
import { isPhone } from './mobile.js';
import { dialogify } from './a11y.js';

// Minimal floating window manager: drag by the title bar, resize from the corner,
// click to raise, maximize, close. Terminals, file browsers and session viewers live here.

let z = 100;
let cascade = 0;
const windows = new Set();
let nextId = 1;
// Phones: windows open full-screen (styles.css, MOBILE LAYOUT) and each owns a history entry, so the
// browser/OS back gesture closes the top one instead of leaving JARVIS.
const backStack = []; // close() of phone windows that pushed a history entry, oldest first
let skipPop = 0;
window.addEventListener('popstate', () => { if (skipPop) { skipPop--; return; } backStack.pop()?.({ fromBack: true }); });

export function openWindow({ title, icon = '', width = 760, height = 480, className = '', onClose, tools = [] }) {
  const body = h('div', { class: 'win-body' });
  const titleEl = h('span', { class: 'win-title-text' }, title);
  const win = h('div', { class: `win ${className}`, 'data-win-id': String(nextId++) },
    h('div', { class: 'win-bar' },
      h('span', { class: 'win-icon' }, icon),
      titleEl,
      h('span', { class: 'win-tools' }, ...tools),
      h('button', { class: 'win-btn', title: 'Maximize', 'aria-label': 'Maximize', 'aria-pressed': 'false', onclick: (e) => { e.currentTarget.setAttribute('aria-pressed', String(win.classList.toggle('max'))); } }, '▢'),
      h('button', { class: 'win-btn close', title: 'Close', 'aria-label': 'Close', onclick: () => close() }, '✕')),
    body);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(width, vw - 32);
  const hh = Math.min(height, vh - 140);
  const off = (cascade++ % 6) * 28;
  Object.assign(win.style, { width: w + 'px', height: hh + 'px', left: Math.max(16, (vw - w) / 2 - 80 + off) + 'px', top: Math.max(16, (vh - hh) / 2 - 60 + off) + 'px', zIndex: ++z });
  win.classList.add('win-enter');
  document.body.append(win);
  requestAnimationFrame(() => requestAnimationFrame(() => win.classList.remove('win-enter'))); // fade/scale in
  windows.add(win);
  const dlg = dialogify(win, { label: title, onClose: () => close() }); // role=dialog, focus in, Tab trap, Esc closes, focus returns on close

  const raise = () => { win.style.zIndex = ++z; };
  win._wm = { title: () => titleEl.textContent, icon, raise, close: () => close() };
  win.addEventListener('pointerdown', raise);

  const bar = win.querySelector('.win-bar');
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button,select,input') || win.classList.contains('max') || isPhone()) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const ox = win.offsetLeft;
    const oy = win.offsetTop;
    bar.setPointerCapture(e.pointerId);
    const move = (ev) => {
      win.style.left = Math.min(window.innerWidth - 80, Math.max(-w + 120, ox + ev.clientX - sx)) + 'px';
      win.style.top = Math.min(window.innerHeight - 40, Math.max(0, oy + ev.clientY - sy)) + 'px';
    };
    const up = () => { bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
  });
  bar.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) win.classList.toggle('max'); });

  const ro = new ResizeObserver(() => win.dispatchEvent(new CustomEvent('winresize')));
  ro.observe(body);

  let closing = false;
  function close({ fromBack = false } = {}) {
    if (closing) return;
    closing = true;
    const i = backStack.indexOf(close);
    if (i >= 0) { backStack.splice(i, 1); if (!fromBack) { skipPop++; history.back(); } }
    ro.disconnect();
    windows.delete(win);
    onClose?.();
    dlg.release();
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { win.remove(); return; }
    win.classList.add('win-leave'); // fade/scale out, then gone
    setTimeout(() => win.remove(), 180);
  }
  if (isPhone()) { history.pushState({ rigsWin: true }, ''); backStack.push(close); }
  return { el: win, body, close, setTitle: (t) => { titleEl.textContent = t; win.setAttribute('aria-label', t); }, onResize: (fn) => win.addEventListener('winresize', fn), raise };
}

/** Open windows, topmost first: { id, title, icon, raise(), close(), el }. */
export function listWindows() {
  return [...windows].filter((w) => w._wm).sort((a, b) => Number(b.style.zIndex) - Number(a.style.zIndex))
    .map((w) => ({ id: w.dataset.winId, title: w._wm.title(), icon: w._wm.icon, raise: w._wm.raise, close: w._wm.close, el: w }));
}

/** Raise a window and put focus in it. */
export function focusWindow(id) {
  const w = listWindows().find((x) => x.id === String(id));
  if (!w) return false;
  w.raise();
  (w.el.querySelector('.win-body input, .win-body textarea, .win-body button, .win-body [tabindex="0"]') || w.el.querySelector('.win-btn'))?.focus({ preventScroll: true });
  return true;
}

export function closeAll() { for (const w of [...windows]) w.querySelector('.win-btn.close')?.click(); }
