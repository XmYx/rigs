import { h } from './api.js';

// Minimal floating window manager: drag by the title bar, resize from the corner,
// click to raise, maximize, close. Terminals, file browsers and session viewers live here.

let z = 100;
let cascade = 0;
const windows = new Set();

export function openWindow({ title, icon = '', width = 760, height = 480, className = '', onClose, tools = [] }) {
  const body = h('div', { class: 'win-body' });
  const titleEl = h('span', { class: 'win-title-text' }, title);
  const win = h('div', { class: `win ${className}` },
    h('div', { class: 'win-bar' },
      h('span', { class: 'win-icon' }, icon),
      titleEl,
      h('span', { class: 'win-tools' }, ...tools),
      h('button', { class: 'win-btn', title: 'Maximize', onclick: () => win.classList.toggle('max') }, '▢'),
      h('button', { class: 'win-btn close', title: 'Close', onclick: () => close() }, '✕')),
    body);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(width, vw - 32);
  const hh = Math.min(height, vh - 140);
  const off = (cascade++ % 6) * 28;
  Object.assign(win.style, { width: w + 'px', height: hh + 'px', left: Math.max(16, (vw - w) / 2 - 80 + off) + 'px', top: Math.max(16, (vh - hh) / 2 - 60 + off) + 'px', zIndex: ++z });
  document.body.append(win);
  windows.add(win);

  const raise = () => { win.style.zIndex = ++z; };
  win.addEventListener('pointerdown', raise);

  const bar = win.querySelector('.win-bar');
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button,select,input') || win.classList.contains('max')) return;
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

  function close() {
    ro.disconnect();
    windows.delete(win);
    win.remove();
    onClose?.();
  }
  return { el: win, body, close, setTitle: (t) => { titleEl.textContent = t; }, onResize: (fn) => win.addEventListener('winresize', fn), raise };
}

export function closeAll() { for (const w of [...windows]) w.querySelector('.win-btn.close')?.click(); }
