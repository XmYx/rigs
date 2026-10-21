import { h } from './api.js';
import { isPhone, PHONE_QUERY } from './mobile.js';
import { prefersReducedMotion } from './a11y.js';
import {
  activeDesktop, addDesktop, canAddDesktop, canRemoveDesktop, dropBack, focusWindow, listDesktops, listWindows, moveWindowToDesktop,
  onSpacesChange, pushBack, removeDesktop, switchDesktop,
} from './wm.js';
import { gridLayout, miniRects, neighbor } from './mission-control-model.js';

// Mission Control (macOS style): every window of the active desktop at a glance, and the desktops (Spaces, wm.js) across
// the top. Opening it dims the stage and moves each wm.js window into a grid of scaled previews; nothing is re-created
// or reloaded: the real window element only gets a CSS transform (class .mc-win), so terminals, iframes and apps keep
// running. A layer of buttons on top (one per preview, with its icon and title) takes the clicks and drags; the windows
// themselves take no pointer events while it is open. Closing takes the transforms off, so every window goes back to
// exactly the rect it had (its left / top / width / height were never touched).
//   click a preview → close and focus that window      click a desktop → switch to it (the grid follows, still open)
//   drag a preview onto a desktop → move it there      onto + → a new desktop with that window on it
//   Esc, a click on empty space, or the trigger again → close        ←/→/↑/↓ move between previews, Enter focuses
// Minimized windows sit in a smaller row at the bottom (a click restores one). The layout math is pure
// (mission-control-model.js). Phones: a full-screen list of window cards and a desktop row, no previews, no drag.
// Nothing runs while it is closed: its listeners (spaces, resize, a body MutationObserver) exist only while it is open.

const MC_Z = 12000; // above the menu bar, app dock and toasts (it covers the whole screen, as on a Mac)
const ANIM_MS = 320;
const DRAG_START = 5; // px before a press on a preview becomes a drag
const DRAG_W = 200; // a dragged preview shrinks to at most this wide, so the desktops stay visible
let mc = null; // the open overlay

export const isMissionControlOpen = () => !!mc;
export function toggleMissionControl() { if (mc) closeMissionControl(); else openMissionControl(); }

/** Open Mission Control (no-op when it is open already). */
export function openMissionControl() {
  if (mc || typeof document === 'undefined') return;
  if (isPhone()) { openPhone(); return; }
  const root = h('div', { class: 'mc', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Mission Control — the windows on this desktop and every desktop', tabindex: '-1' });
  const dim = h('div', { class: 'mc-dim' });
  const layer = h('div', { class: 'mc-layer' });
  const minRow = h('div', { class: 'mc-minrow', role: 'group', 'aria-label': 'Minimized windows', hidden: true });
  const empty = h('div', { class: 'mc-empty', hidden: true });
  const bar = h('div', { class: 'mc-spaces', role: 'toolbar', 'aria-label': 'Desktops' });
  root.append(dim, layer, minRow, empty, bar);
  const m = { root, layer, minRow, empty, bar, items: new Map(), prevFocus: document.activeElement, raf: 0, drag: null, suppressClick: false, off: [] };
  mc = m;
  if (prefersReducedMotion()) root.classList.add('mc-still');
  document.body.append(root);
  document.body.classList.add('mc-open');
  // Empty space closes: the dim behind the previews and the minimized row's background.
  dim.addEventListener('click', () => closeMissionControl());
  minRow.addEventListener('click', (e) => { if (e.target === minRow) closeMissionControl(); });
  empty.addEventListener('click', () => closeMissionControl());
  document.addEventListener('keydown', onKey, true); // the document's, not the overlay's: focus can drop to the page (a dragged preview goes away)
  m.off.push(() => document.removeEventListener('keydown', onKey, true));
  const relayout = () => schedule(m);
  m.off.push(onSpacesChange(relayout));
  window.addEventListener('resize', relayout);
  m.off.push(() => window.removeEventListener('resize', relayout));
  const phoneQ = window.matchMedia?.(PHONE_QUERY);
  const toPhone = () => { if (phoneQ?.matches) closeMissionControl(); };
  phoneQ?.addEventListener?.('change', toPhone);
  m.off.push(() => phoneQ?.removeEventListener?.('change', toPhone));
  // A window opening or closing while it is open (a terminal that exits, one JARVIS opens): lay out again.
  const mo = new MutationObserver((recs) => {
    if (recs.some((r) => [...r.addedNodes, ...r.removedNodes].some((n) => n.classList?.contains('win')))) relayout();
  });
  mo.observe(document.body, { childList: true });
  m.off.push(() => mo.disconnect());
  layout(m);
  root.classList.add('mc-in');
  requestAnimationFrame(() => { if (mc === m) { (firstPreview(m) || root).focus({ preventScroll: true }); m.focused = true; } });
}

/** Close it: the windows go back where they were; `focus` = a window id to bring to the front and focus. */
export function closeMissionControl({ focus = null } = {}) {
  const m = mc;
  if (!m) return;
  mc = null;
  cancelAnimationFrame(m.raf);
  for (const off of m.off) { try { off(); } catch { /* gone */ } }
  if (m.phone) { closePhone(m, focus); return; }
  const still = prefersReducedMotion();
  const chosen = focus != null ? m.items.get(String(focus)) : null;
  if (chosen) chosen.el.style.setProperty('--mc-z', String(MC_Z + 900)); // it lands on top
  for (const it of m.items.values()) {
    it.el.classList.toggle('mc-anim', !still);
    if (it.el.isConnected && !it.el.classList.contains('win-leave')) it.el.style.transform = '';
  }
  m.root.classList.add('mc-leaving');
  const done = () => {
    for (const it of m.items.values()) if (it.el._mcOwner === m) release(it.el);
    m.root.remove();
    if (!mc) document.body.classList.remove('mc-open');
  };
  if (still) done(); else setTimeout(done, ANIM_MS + 30);
  if (focus != null) focusWindow(focus);
  else if (m.prevFocus?.isConnected && m.prevFocus !== document.body && !m.prevFocus.closest?.('.win.off-space, .win.min')) m.prevFocus.focus({ preventScroll: true });
}

/** Take Mission Control's classes and transform off a window (it is back to how the window manager left it). */
function release(el) {
  el.classList.remove('mc-win', 'mc-anim', 'mc-drag');
  el.style.removeProperty('--mc-z');
  if (!el.classList.contains('win-leave')) el.style.transform = '';
  delete el._mcOwner;
}

function schedule(m) {
  if (mc !== m || m.raf) return;
  m.raf = requestAnimationFrame(() => { m.raf = 0; if (mc !== m) return; if (m.phone) renderPhone(m); else if (!m.drag) layout(m); });
}

// ------------------------------------------------------------------ desktop browsers

/** A window's place on screen, transforms ignored (offset* skip them), so it is the rect it goes back to. */
const ownRect = (el) => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

/** Where a window of another desktop would be (it is display: none): its inline rect, or the screen when maximized. */
function hiddenRect(el) {
  if (el.classList.contains('max')) return { x: 8, y: 8, w: window.innerWidth - 16, h: window.innerHeight - 16 };
  return { x: px(el.style.left) ?? 0, y: px(el.style.top) ?? 0, w: px(el.style.width) ?? 0, h: px(el.style.height) ?? 0 };
}
const onStage = (el) => el.isConnected && getComputedStyle(el).display !== 'none';

function layout(m) {
  const still = prefersReducedMotion();
  renderBar(m);
  const desk = activeDesktop();
  const all = listWindows({ desktop: desk.id }); // topmost first
  const stage = all.filter((w) => w.state !== 'minimized' && onStage(w.el));
  const mins = all.filter((w) => w.state === 'minimized');
  renderMinRow(m, mins);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const top = m.bar.getBoundingClientRect().bottom + 22;
  const bottom = mins.length ? m.minRow.getBoundingClientRect().top - 12 : vh - 28;
  const area = { x: 32, y: top, w: Math.max(80, vw - 64), h: Math.max(60, bottom - top) };
  const rects = stage.map((w) => ({ id: w.id, ...ownRect(w.el) }));
  const targets = gridLayout(rects, area, { gap: 28, label: 30 });
  const keep = new Set();
  stage.forEach((w, i) => {
    const t = targets[i];
    const r = rects[i];
    keep.add(w.id);
    let it = m.items.get(w.id);
    if (!it) { it = makePreview(m, w); m.items.set(w.id, it); m.layer.append(it.hit); }
    Object.assign(it, { rect: r, target: t, order: t.order });
    it.label.lastChild.textContent = w.title;
    it.hit.setAttribute('aria-label', `${w.title} — focus it; drag it onto a desktop to move it there`);
    const el = w.el;
    el._mcOwner = m;
    el.classList.add('mc-win', 'space-back'); // space-back: its opening animation never replays when the class goes (styles.css)
    el.classList.toggle('mc-anim', !still);
    el.style.setProperty('--mc-z', String(MC_Z + 1 + stage.length - i)); // keep the windows' stacking order
    el.style.transform = `translate(${t.x - r.x}px, ${t.y - r.y}px) scale(${t.scale})`;
    placeHit(it, t);
  });
  for (const [id, it] of [...m.items]) {
    if (keep.has(id)) continue;
    it.el.classList.remove('mc-anim');
    if (it.el._mcOwner === m) release(it.el);
    it.hit.remove();
    m.items.delete(id);
  }
  m.empty.hidden = stage.length > 0;
  m.empty.textContent = stage.length ? '' : `No windows on ${desk.name}${mins.length ? ' — only minimized ones, below' : ''}`;
  const f = document.activeElement;
  if (m.focused && (!f || f === document.body)) (firstPreview(m) || m.root).focus({ preventScroll: true }); // its preview went (moved away): keep the keys here
}

function placeHit(it, t) {
  Object.assign(it.hit.style, { left: `${t.x}px`, top: `${t.y}px`, width: `${t.w}px`, height: `${t.h}px` });
}

function makePreview(m, w) {
  const label = h('span', { class: 'mc-label', 'aria-hidden': 'true' }, h('span', { class: 'mc-label-icon' }, w.icon || '▢'), h('span', { class: 'mc-label-text' }, w.title));
  const hit = h('button', { class: 'mc-hit', 'data-win-id': w.id, type: 'button' }, label);
  const it = { id: w.id, el: w.el, hit, label };
  hit.addEventListener('click', () => {
    if (m.suppressClick) { m.suppressClick = false; return; }
    closeMissionControl({ focus: w.id });
  });
  hit.addEventListener('pointerdown', (e) => startPress(m, it, e));
  return it;
}

function firstPreview(m) {
  return [...m.items.values()].sort((a, b) => a.order - b.order)[0]?.hit || null;
}

// ------------------------------------------------------------------ drag a preview onto a desktop

function startPress(m, it, e) {
  if (e.button !== 0 || m.drag) return;
  const start = { x: e.clientX, y: e.clientY };
  let dragging = false;
  it.hit.setPointerCapture?.(e.pointerId);
  const move = (ev) => {
    if (!dragging && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_START) return;
    if (!dragging) { dragging = true; m.drag = it; it.el.classList.add('mc-drag'); it.el.classList.remove('mc-anim'); it.hit.classList.add('dragging'); }
    dragTo(m, it, start, ev.clientX, ev.clientY);
  };
  const end = (ev, cancelled) => {
    it.hit.removeEventListener('pointermove', move);
    it.hit.removeEventListener('pointerup', up);
    it.hit.removeEventListener('pointercancel', cancel);
    if (!dragging) return;
    m.suppressClick = true;
    setTimeout(() => { m.suppressClick = false; }, 0);
    m.drag = null;
    it.el.classList.remove('mc-drag');
    it.hit.classList.remove('dragging');
    const target = cancelled ? null : dropTarget(m, ev.clientX, ev.clientY);
    markDrop(m, null);
    if (mc !== m) return;
    let moved = false;
    if (target?.add) { const id = addDesktop(); moved = !!id && moveWindowToDesktop(it.id, id); }
    else if (target?.desktop && target.desktop !== activeDesktop().id) moved = moveWindowToDesktop(it.id, target.desktop);
    if (moved) return; // the spaces change lays out again: the window leaves this desktop's grid
    // Not dropped on another desktop: back to its place in the grid.
    it.el.classList.toggle('mc-anim', !prefersReducedMotion());
    it.el.style.transform = `translate(${it.target.x - it.rect.x}px, ${it.target.y - it.rect.y}px) scale(${it.target.scale})`;
    placeHit(it, it.target);
    schedule(m);
  };
  const up = (ev) => end(ev, false);
  const cancel = (ev) => end(ev, true);
  it.hit.addEventListener('pointermove', move);
  it.hit.addEventListener('pointerup', up);
  it.hit.addEventListener('pointercancel', cancel);
}

/** Follow the pointer, shrunk so the desktops stay in view; the point that was grabbed stays under the pointer. */
function dragTo(m, it, start, x, y) {
  const t = it.target;
  const k = Math.min(1, DRAG_W / t.w);
  const nx = x - (start.x - t.x) * k;
  const ny = y - (start.y - t.y) * k;
  const s = t.scale * k;
  it.el.style.transform = `translate(${nx - it.rect.x}px, ${ny - it.rect.y}px) scale(${s})`;
  placeHit(it, { x: nx, y: ny, w: t.w * k, h: t.h * k });
  markDrop(m, dropTarget(m, x, y));
}

const inside = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
function dropTarget(m, x, y) {
  for (const el of m.bar.querySelectorAll('.mc-desk, .mc-add')) {
    if (!inside(el.getBoundingClientRect(), x, y)) continue;
    if (el.classList.contains('mc-add')) return el.disabled ? null : { add: true, el };
    return { desktop: el.dataset.desktop, el };
  }
  return null;
}
function markDrop(m, target) {
  for (const el of m.bar.querySelectorAll('.drop')) if (el !== target?.el) el.classList.remove('drop');
  const ok = target && (target.add || target.desktop !== activeDesktop().id);
  target?.el.classList.toggle('drop', !!ok);
}

// ------------------------------------------------------------------ the Spaces bar and the minimized row

function renderBar(m) {
  const ds = listDesktops();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const room = vw - 64 - 64; // the sides and the + button
  const tw = Math.round(Math.max(72, Math.min(176, (room - 16 * (ds.length - 1)) / Math.max(1, ds.length))));
  const th = Math.round((tw * vh) / vw);
  const focusedDesk = document.activeElement?.closest?.('.mc-desk')?.dataset.desktop;
  const cells = ds.map((d) => {
    const wins = listWindows({ desktop: d.id }).filter((w) => w.state !== 'minimized').reverse(); // bottom first
    const rects = wins.map((w) => ({ id: w.id, title: w.title, ...(m.items.get(w.id)?.rect || (onStage(w.el) ? ownRect(w.el) : hiddenRect(w.el))) }));
    const minis = miniRects(rects, { w: vw, h: vh }, { w: tw, h: th });
    const names = wins.slice().reverse().map((w) => w.title);
    const thumb = h('span', { class: 'mc-thumb', style: { width: `${tw}px`, height: `${th}px` } },
      ...minis.map((r) => h('span', { class: 'mc-mini', title: r.title, style: { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` } })));
    const btn = h('button', {
      class: `mc-desk${d.active ? ' on' : ''}`, type: 'button', 'data-desktop': d.id, 'aria-pressed': String(d.active),
      'aria-label': `${d.name}${d.active ? ' (shown)' : ''}: ${names.length ? names.join(', ') : 'no windows'}`,
      title: names.length ? `${d.name}\n${names.join('\n')}` : `${d.name} — no windows`,
    }, thumb, h('span', { class: 'mc-desk-name' }, d.name));
    btn.addEventListener('click', () => switchDesktop(d.id));
    const cell = h('div', { class: 'mc-desk-cell' }, btn);
    if (canRemoveDesktop(d.id)) {
      const x = h('button', { class: 'mc-desk-x', type: 'button', title: `Remove ${d.name} (its windows move next door)`, 'aria-label': `Remove ${d.name}` }, '×');
      x.addEventListener('click', (e) => { e.stopPropagation(); removeDesktop(d.id); });
      cell.append(x);
    }
    return cell;
  });
  const add = h('button', {
    class: 'mc-add', type: 'button', title: canAddDesktop() ? 'Add a desktop — or drop a window here to put it on a new one' : 'No more desktops', 'aria-label': 'Add desktop',
    style: { height: `${th}px` },
  }, '+');
  add.disabled = !canAddDesktop();
  add.addEventListener('click', () => addDesktop());
  m.bar.replaceChildren(...cells, add);
  if (focusedDesk) m.bar.querySelector(`.mc-desk[data-desktop="${focusedDesk}"]`)?.focus({ preventScroll: true });
}

function renderMinRow(m, mins) {
  m.minRow.hidden = !mins.length;
  m.minRow.replaceChildren(...mins.map((w) => {
    const b = h('button', { class: 'mc-minwin', type: 'button', 'data-win-id': w.id, title: `${w.title} — minimized; click to restore it`, 'aria-label': `${w.title} (minimized) — restore it` },
      h('span', { class: 'mc-label-icon' }, w.icon || '▢'), h('span', { class: 'mc-label-text' }, w.title), h('span', { class: 'mc-min-tag' }, 'minimized'));
    b.addEventListener('click', () => closeMissionControl({ focus: w.id }));
    return b;
  }));
}

// ------------------------------------------------------------------ keys

const ARROWS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

function onKey(e) {
  const m = mc;
  if (!m || e.isComposing) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMissionControl(); return; }
  if (m.phone) return;
  const mods = e.ctrlKey || e.metaKey || e.altKey || e.shiftKey;
  if (ARROWS[e.key] && !mods) {
    e.preventDefault();
    e.stopPropagation();
    const items = [...m.items.values()].sort((a, b) => a.order - b.order);
    const inBar = e.target.closest?.('.mc-spaces');
    if (inBar && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const btns = [...m.bar.querySelectorAll('.mc-desk, .mc-add:not(:disabled)')];
      const i = btns.indexOf(e.target);
      btns[Math.max(0, Math.min(btns.length - 1, i + (e.key === 'ArrowLeft' ? -1 : 1)))]?.focus();
      return;
    }
    if (inBar && e.key === 'ArrowDown') { items[0]?.hit.focus(); return; }
    const i = items.findIndex((it) => it.hit === document.activeElement);
    if (i >= 0 && e.key === 'ArrowUp' && neighbor(items.map((it) => it.target), i, 'up') === i) { m.bar.querySelector('.mc-desk.on')?.focus(); return; }
    const j = neighbor(items.map((it) => it.target), i, ARROWS[e.key]);
    items[j]?.hit.focus();
    return;
  }
  if (e.key === 'Tab') { // stay inside: previews in reading order, then the desktops
    const list = [...[...m.items.values()].sort((a, b) => a.order - b.order).map((it) => it.hit), ...m.minRow.querySelectorAll('button'), ...m.bar.querySelectorAll('button:not(:disabled)')];
    if (!list.length) return;
    e.preventDefault();
    e.stopPropagation();
    const i = list.indexOf(document.activeElement);
    list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length].focus();
  }
}

// ------------------------------------------------------------------ phones: a list of window cards

function openPhone() {
  const root = h('div', { class: 'mc mc-phone', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Mission Control — open windows', tabindex: '-1' });
  const m = { phone: true, root, items: new Map(), prevFocus: document.activeElement, raf: 0, off: [] };
  mc = m;
  const back = () => { if (mc === m) { m.fromBack = true; closeMissionControl(); } };
  pushBack(back);
  m.back = back;
  document.addEventListener('keydown', onKey, true);
  m.off.push(() => document.removeEventListener('keydown', onKey, true));
  m.off.push(onSpacesChange(() => schedule(m)));
  const phoneQ = window.matchMedia?.(PHONE_QUERY);
  const toDesk = () => { if (!phoneQ.matches) closeMissionControl(); };
  phoneQ?.addEventListener?.('change', toDesk);
  m.off.push(() => phoneQ?.removeEventListener?.('change', toDesk));
  renderPhone(m);
  document.body.append(root);
  document.body.classList.add('mc-open');
  requestAnimationFrame(() => { if (mc === m) (root.querySelector('.mc-card') || root.querySelector('.mc-phone-close')).focus({ preventScroll: true }); });
}

function renderPhone(m) {
  const wins = listWindows();
  const close = h('button', { class: 'mc-phone-close round', type: 'button', 'aria-label': 'Close Mission Control', title: 'Close' }, '✕');
  close.addEventListener('click', () => closeMissionControl());
  const desks = h('div', { class: 'mc-phone-desks', role: 'toolbar', 'aria-label': 'Desktops' }, ...listDesktops().map((d) => {
    const b = h('button', { class: `mc-phone-desk${d.active ? ' on' : ''}`, type: 'button', 'aria-pressed': String(d.active) }, d.name);
    b.addEventListener('click', () => switchDesktop(d.id));
    return b;
  }));
  const cards = wins.length ? wins.map((w) => {
    const c = h('button', { class: `mc-card${w.state === 'minimized' ? ' min' : ''}`, type: 'button', 'data-win-id': w.id, 'aria-label': `${w.title}${w.state === 'minimized' ? ' (minimized)' : ''} — open it` },
      h('span', { class: 'mc-card-icon', 'aria-hidden': 'true' }, w.icon || '▢'),
      h('span', { class: 'mc-card-text' }, h('span', { class: 'mc-card-title' }, w.title), h('span', { class: 'mc-card-meta' }, w.state === 'minimized' ? 'Minimized' : w.state === 'maximized' ? 'Full screen' : 'Open')));
    c.addEventListener('click', () => closeMissionControl({ focus: w.id }));
    return c;
  }) : [h('p', { class: 'mc-phone-empty' }, 'No open windows.')];
  m.root.replaceChildren(
    h('div', { class: 'mc-phone-head' }, h('b', {}, 'Mission Control'), h('span', { class: 'mc-phone-count' }, `${wins.length} window${wins.length === 1 ? '' : 's'}`), close),
    desks,
    h('div', { class: 'mc-cards', role: 'list' }, ...cards));
}

function closePhone(m, focus) {
  if (!m.fromBack) dropBack(m.back);
  m.root.remove();
  if (!mc) document.body.classList.remove('mc-open');
  if (focus != null) focusWindow(focus);
}
