import { h } from './api.js';
import { isPhone } from './mobile.js';
import { dialogify } from './a11y.js';
import { registerDockable, unregisterDockable, setDockTitle, stowDockable, unstowDockable } from './docking.js';
import { dockManager } from './dock-layout.js';
import { tagCtx } from './ctx-tag.js';
import { createDisposer } from './cleanup.js';
import { dockableWindow, emitClosed, emitMinimized, emitOpened, emitRestored, emitTitle } from './open-events.js';
import { buildChrome, cleanRect, isVisible, transition } from './window-state.js';
import './tiling.js'; // drag a window to a screen edge or corner to tile it (macOS style); tileWindow / untile live there

// Floating window manager: drag by the whole title bar (docking.js; buttons in it still click), resize from the
// corner, click to raise; dragged to a screen edge or corner it tiles into that half or quarter (tiling.js). Every window has the same three title bar buttons, in this order: minimize (–),
// maximize / restore (□ / ❐; double-clicking the bar does the same) and close (✕). The state model is
// window-state.js; each window's state and rect are kept in the dock layout store (rigs.dock `windows`, by a stable
// key), so it reopens where and how it was. A minimized window is reached from the app dock (its applet or
// terminal item, else a window item of its own) and comes back in place. With the docking layout on, a window docks
// beside a panel or another window, or as a tab. Terminals, file browsers and session viewers live here.

let z = 100;
let cascade = 0;
const windows = new Set();
const keysInUse = new Set();
let nextId = 1;
// Phones: windows open full-screen (styles.css, MOBILE LAYOUT) and each owns a history entry, so the
// browser/OS back gesture closes the top one instead of leaving JARVIS. A minimized window gives its entry back.
const backStack = []; // close() of phone windows that pushed a history entry, oldest first
let skipPop = 0;
window.addEventListener('popstate', () => { if (skipPop) { skipPop--; return; } backStack.pop()?.({ fromBack: true }); });
/** Phones: `fn({ fromBack: true })` runs on the next back gesture (panels.js uses it for its sheets, like windows). */
export function pushBack(fn) { history.pushState({ rigsWin: true }, ''); backStack.push(fn); }
/** Give a pushBack entry back (the sheet closed some other way), so back does not close something nobody sees. */
export function dropBack(fn) { const i = backStack.indexOf(fn); if (i >= 0) { backStack.splice(i, 1); skipPop++; history.back(); } }

const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

/**
 * Open a window. `key` names it across reloads (default: its title) so its state and rect are remembered; a second
 * window whose key is already open is not remembered. `dockRef`: the app dock item that stands for this window while
 * it is minimized (an applet or terminal item id); without one it gets a window item.
 */
export function openWindow({ title, icon = '', width = 760, height = 480, className = '', onClose, tools = [], focus = true, key, dockRef = null }) {
  const body = h('div', { class: 'win-body' });
  const bin = createDisposer(); // what the window's owner hooked up (timers, sockets, listeners): undone on every close path
  const titleEl = h('span', { class: 'win-title-text' }, title);
  const storeKey = (() => { const k = String(key ?? `t:${title}`).slice(0, 200); return keysInUse.has(k) ? null : k; })();
  if (storeKey) keysInUse.add(storeKey);
  const saved = storeKey ? dockManager.getWindow(storeKey) : null;
  let rec = transition(saved, 'open', { at: Date.now() }); // closed / minimized last time → normal or maximized again
  const chrome = buildChrome(h, (action) => act(action));
  const win = h('div', { class: `win ${className}`, 'data-win-id': String(nextId++) },
    h('div', { class: 'win-bar' },
      h('span', { class: 'win-icon' }, icon),
      titleEl,
      h('span', { class: 'win-tools' }, ...tools),
      ...chrome.els),
    body);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const place = savedPlace(saved?.rect, vw, vh);
  const w = place?.w ?? Math.min(width, vw - 32);
  const hh = place?.h ?? Math.min(height, vh - 140);
  const off = place ? 0 : (cascade++ % 6) * 28;
  Object.assign(win.style, { width: w + 'px', height: hh + 'px', left: (place?.x ?? Math.max(16, (vw - w) / 2 - 80 + off)) + 'px', top: (place?.y ?? Math.max(16, (vh - hh) / 2 - 60 + off)) + 'px', zIndex: ++z });
  win.classList.toggle('max', rec.state === 'maximized');
  chrome.sync(rec);
  win.classList.add('win-enter');
  document.body.append(win);
  requestAnimationFrame(() => requestAnimationFrame(() => win.classList.remove('win-enter'))); // fade/scale in
  windows.add(win);
  const dlg = dialogify(win, { label: title, onClose: () => close(), focus }); // role=dialog, focus in (focus:false for a window that opens by itself, so it never takes the cursor from a text field), Tab trap, Esc closes, focus returns on close

  tagCtx(win, 'window', win.dataset.winId, { get title() { return titleEl.textContent; } }); // right-click on the title bar: front, minimize, maximize, close…
  const dockSource = () => ({ id: win.dataset.winId, title: titleEl.textContent, icon });
  const front = () => { win.style.zIndex = ++z; };
  /** Bring the window to the front; a minimized one comes back first (the app dock, Window menu and openApp all land here). */
  const raise = () => { if (rec.state === 'minimized') act('restore'); else front(); };
  win._wm = { title: () => titleEl.textContent, icon, raise, close: () => close(), act: (a) => act(a), state: () => rec.state };
  win.addEventListener('pointerdown', front);

  const bar = win.querySelector('.win-bar');
  const id = `win-${win.dataset.winId}`; // dock id; the same number tagCtx / listWindows use
  registerDockable(id, {
    el: win, title, kind: 'window', handles: [bar], raise: front,
    canDrag: () => !win.classList.contains('max') && !isPhone(),
    // Keep at least 120px of the window and its bar on screen.
    clamp: (left, top, ww) => [Math.min(window.innerWidth - 80, Math.max(-ww + 120, left)), Math.min(window.innerHeight - 40, Math.max(0, top))],
  });
  bar.addEventListener('dblclick', (e) => {
    if (e.target.closest('button,select,input') || win.classList.contains('docked') || isPhone()) return;
    act('toggleMaximize');
  });
  // A drag, a tile or a corner resize ends with the pointer let go: remember where the window is now.
  win.addEventListener('pointerup', () => setTimeout(remember, 0));

  const ro = new ResizeObserver(() => { if (rec.state !== 'minimized') win.dispatchEvent(new CustomEvent('winresize')); }); // a minimized window has no size: its content must not fit itself to 0×0
  ro.observe(body);
  const dockable = dockableWindow(className); // open / close / title are announced for the app dock's auto-docking (open-events.js)
  if (dockable) emitOpened('window', { id: win.dataset.winId, title, icon });

  let closing = false;

  /** The rect the window has on its own (not docked, maximized, minimized or on a phone), from its inline place. */
  function ownRect() {
    if (rec.state !== 'normal' || win.classList.contains('docked') || isPhone()) return null;
    const b = win.getBoundingClientRect();
    return cleanRect({ x: px(win.style.left) ?? b.left, y: px(win.style.top) ?? b.top, w: px(win.style.width) ?? b.width, h: px(win.style.height) ?? b.height });
  }
  function save() { if (storeKey) dockManager.setWindow(storeKey, rec); }
  function remember() {
    if (closing) return;
    const r = ownRect();
    const next = r ? transition(rec, 'move', { rect: r, at: Date.now() }) : rec;
    if (next !== rec) { rec = next; save(); }
  }

  /** Every state change goes through here: the buttons, double-click, the context menu, restore from the dock. */
  function act(action) {
    if (closing) return;
    if (action === 'close') { close(); return; }
    if (action === 'toggleMaximize' && isPhone()) return; // phones: windows are always full-screen
    const r = ownRect();
    if (r) rec = transition(rec, 'move', { rect: r }); // the exact rect to come back to
    const prev = rec.state;
    const next = transition(rec, action, { at: Date.now() });
    if (next === rec) return;
    rec = next;
    apply(prev);
    save();
  }

  function apply(prev) {
    const now = rec.state;
    win.classList.toggle('max', now === 'maximized');
    chrome.sync(rec);
    if (prev === now) return;
    if (now === 'minimized') minimizeOut();
    else if (prev === 'minimized') restoreIn();
    if (now !== 'minimized') { front(); win.dispatchEvent(new CustomEvent('winresize')); }
  }

  function minimizeOut() {
    const hadFocus = win.contains(document.activeElement);
    stowDockable(id); // a docked window leaves the layout like a hidden panel (its place is kept)
    emitMinimized(dockSource(), dockRef);
    const i = backStack.indexOf(close);
    if (i >= 0) { backStack.splice(i, 1); skipPop++; history.back(); } // phone: back no longer closes a window nobody sees
    const done = () => { win.classList.remove('win-minimizing'); if (rec.state === 'minimized') win.classList.add('min'); };
    if (reducedMotion()) done();
    else { win.classList.add('win-minimizing'); setTimeout(done, 180); }
    if (hadFocus) focusTop(win);
  }

  function restoreIn() {
    win.classList.remove('min', 'win-minimizing');
    unstowDockable(id);
    emitRestored(dockSource(), dockRef);
    if (isPhone() && !backStack.includes(close)) { history.pushState({ rigsWin: true }, ''); backStack.push(close); }
    if (!reducedMotion()) { win.classList.add('win-enter'); requestAnimationFrame(() => requestAnimationFrame(() => win.classList.remove('win-enter'))); }
    requestAnimationFrame(() => { if (!win.contains(document.activeElement)) win.focus({ preventScroll: true }); });
  }

  function close({ fromBack = false } = {}) {
    if (closing) return;
    const r = ownRect();
    if (r) rec = transition(rec, 'move', { rect: r });
    const wasMin = rec.state === 'minimized';
    rec = transition(rec, 'close', { at: Date.now() });
    save();
    closing = true;
    if (storeKey) keysInUse.delete(storeKey);
    const i = backStack.indexOf(close);
    if (i >= 0) { backStack.splice(i, 1); if (!fromBack) { skipPop++; history.back(); } }
    ro.disconnect();
    windows.delete(win);
    if (wasMin) emitRestored(dockSource(), dockRef); // its dock item stops showing it minimized (a window item added for that goes)
    if (dockable) emitClosed('window', { id: win.dataset.winId });
    unregisterDockable(id);
    try { onClose?.(); } catch (e) { console.error(e); }
    bin.dispose();
    dlg.release();
    if (wasMin || reducedMotion()) { win.remove(); return; }
    win.classList.add('win-leave'); // fade/scale out, then gone
    setTimeout(() => win.remove(), 180);
  }
  if (isPhone()) { history.pushState({ rigsWin: true }, ''); backStack.push(close); }
  if (storeKey) { const r = ownRect(); if (r) rec = transition(rec, 'move', { rect: r }); if (rec !== saved) save(); }
  return {
    el: win, body, close,
    /** Run fn when the window closes (✕, Esc, phone back, close others, hide). interval/listen: the same, pre-wired. */
    onCleanup: (fn) => bin.add(fn), interval: (fn, ms) => bin.interval(fn, ms), listen: (t, ev, fn, o) => bin.listen(t, ev, fn, o),
    setTitle: (t) => { titleEl.textContent = t; win.setAttribute('aria-label', t); setDockTitle(id, t); if (dockable) emitTitle('window', { id: win.dataset.winId, title: t, icon }); }, onResize: (fn) => win.addEventListener('winresize', fn), raise,
    minimize: () => act('minimize'), maximize: () => act('maximize'), restore: () => act('restore'), state: () => rec.state,
    /** true when the window opened at the rect it had last time (its opener should not move it). */
    remembered: !!place };
}

/** A remembered rect, kept on screen: the size fits the viewport and the title bar stays reachable. */
function savedPlace(r, vw, vh) {
  if (!r || isPhone()) return null;
  const w = Math.min(r.w, vw - 32);
  const h = Math.min(r.h, vh - 40);
  return { w, h, x: Math.min(Math.max(0, r.x), Math.max(0, vw - Math.min(w, 120))), y: Math.min(Math.max(0, r.y), Math.max(0, vh - 60)) };
}

/** Focus the topmost window still on the stage (not `except`), else let focus fall back to the page. */
function focusTop(except) {
  const next = listWindows().find((w) => w.el !== except && isVisible({ state: w.state }));
  if (next) next.el.focus({ preventScroll: true });
  else document.activeElement?.blur?.();
}

/** Open windows, topmost first: { id, title, icon, state, raise(), close(), el }. */
export function listWindows() {
  return [...windows].filter((w) => w._wm).sort((a, b) => Number(b.style.zIndex) - Number(a.style.zIndex))
    .map((w) => ({ id: w.dataset.winId, title: w._wm.title(), icon: w._wm.icon, state: w._wm.state(), raise: w._wm.raise, close: w._wm.close, el: w }));
}

const byId = (id) => [...windows].find((w) => w._wm && w.dataset.winId === String(id)) || null;

/** Raise a window (restoring it when minimized) and put focus in it. */
export function focusWindow(id) {
  const w = listWindows().find((x) => x.id === String(id));
  if (!w) return false;
  w.raise();
  (w.el.querySelector('.win-body input, .win-body textarea, .win-body button, .win-body [tabindex="0"]') || w.el.querySelector('.win-btn'))?.focus({ preventScroll: true });
  return true;
}

export const windowCount = () => windows.size;
export const windowState = (id) => byId(id)?._wm.state() ?? null;
export const isMaximized = (id) => windowState(id) === 'maximized';
export const isMinimized = (id) => windowState(id) === 'minimized';
/** Run one window state action ('minimize' | 'maximize' | 'restore' | 'toggleMaximize' | 'close') on window `id`. */
export function windowAction(id, action) {
  const w = byId(id);
  if (!w) return false;
  w._wm.act(action);
  if (action !== 'minimize' && action !== 'close') w._wm.raise();
  return true;
}
export const minimizeWindow = (id) => windowAction(id, 'minimize');
export const restoreWindow = (id) => windowAction(id, 'restore');
export const toggleMaximize = (id) => windowAction(id, 'toggleMaximize');
/** Close every window except `id`. */
export function closeOthers(id) { for (const w of listWindows()) if (w.id !== String(id)) w.close(); }

export function closeAll() { for (const w of [...windows]) w.querySelector('.win-btn.close')?.click(); }
