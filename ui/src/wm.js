import { h } from './api.js';
import { isPhone, PHONE_QUERY } from './mobile.js';
import { dialogify } from './a11y.js';
import { registerDockable, unregisterDockable, setDockTitle, stowDockable, unstowDockable } from './docking.js';
import { dockManager } from './dock-layout.js';
import { tagCtx } from './ctx-tag.js';
import { createDisposer } from './cleanup.js';
import { dockableWindow, emitClosed, emitMinimized, emitOpened, emitRestored, emitTitle } from './open-events.js';
import { buildChrome, cleanRect, isVisible, transition } from './window-state.js';
import { refitTiles } from './tiling.js'; // drag a window to a screen edge or corner to tile it (macOS style); tileWindow / untile live there
import { activeDesktop, assignKey, switchDesktop, desktopOfKey, forgetKey, moveKey, onSpacesChange, setOpenKeys, spacesOn, spacesState } from './spaces.js';
import { TRANSIENT } from './spaces-model.js';

// Floating window manager: drag by the whole title bar (docking.js; buttons in it still click), resize from the
// corner, click to raise; dragged to a screen edge or corner it tiles into that half or quarter (tiling.js). Every window has the same three title bar buttons, in this order: minimize (–),
// maximize / restore (□ / ❐; double-clicking the bar does the same) and close (✕). The state model is
// window-state.js; each window's state and rect are kept in the dock layout store (rigs.dock `windows`, by a stable
// key), so it reopens where and how it was. A minimized window is reached from the app dock (its applet or
// terminal item, else a window item of its own) and comes back in place. With the docking layout on, a window docks
// beside a panel or another window, or as a tab. Terminals, file browsers and session viewers live here.
// Spaces (spaces.js): every window is on one virtual desktop, the active one when it opens (a keyed window goes back to
// the desktop it was on). Only the active desktop's windows are on the stage: the others are hidden (`.win.off-space`,
// out of the docking layout like a minimized window) with their state, rect and tile kept, and come back as they were.
// Raising or focusing a window on another desktop switches to that desktop first, as on a Mac. Phones: one desktop.

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
  const winNo = nextId++;
  const spaceKey = storeKey || `${TRANSIENT}${winNo}`; // which desktop it is on (spaces.js); a second window with a key in use is on it for this page only
  assignKey(spaceKey);
  // Back on a desktop other than the active one (it was there before a reload): a window opened by hand takes you there,
  // one that opens by itself (focus: false) waits there.
  if (focus && spacesOn() && desktopOfKey(spaceKey) !== spacesState().active) switchToKey(spaceKey);
  const away = spacesOn() && desktopOfKey(spaceKey) !== spacesState().active;
  const saved = storeKey ? dockManager.getWindow(storeKey) : null;
  let rec = transition(saved, 'open', { at: Date.now() }); // closed / minimized last time → normal or maximized again
  const chrome = buildChrome(h, (action) => act(action));
  const win = h('div', { class: `win ${className}${away ? ' off-space' : ''}`, 'data-win-id': String(winNo), 'data-desktop': desktopOfKey(spaceKey) },
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
  const dlg = dialogify(win, { label: title, onClose: () => close(), focus: focus && !away }); // role=dialog, focus in (focus:false for a window that opens by itself, so it never takes the cursor from a text field), Tab trap, Esc closes, focus returns on close

  tagCtx(win, 'window', win.dataset.winId, { get title() { return titleEl.textContent; } }); // right-click on the title bar: front, minimize, maximize, close…
  const dockSource = () => ({ id: win.dataset.winId, title: titleEl.textContent, icon });
  const front = () => { win.style.zIndex = ++z; };
  /** Bring the window to the front; on another desktop, switch there first; a minimized one comes back (the app dock, Window menu and openApp all land here). */
  const raise = () => { reveal(); if (rec.state === 'minimized') act('restore'); else front(); };
  const reveal = () => { if (spacesOn() && desktopOfKey(spaceKey) !== spacesState().active) switchToKey(spaceKey); };
  win._wm = {
    title: () => titleEl.textContent, icon, raise, reveal, close: () => close(), act: (a) => act(a), state: () => rec.state,
    spaceKey, desktop: () => desktopOfKey(spaceKey), syncSpace: (dir) => syncSpace(dir),
  };
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

  const ro = new ResizeObserver(() => { if (rec.state !== 'minimized' && !win.classList.contains('off-space')) win.dispatchEvent(new CustomEvent('winresize')); }); // a minimized window (or one on another desktop) has no size: its content must not fit itself to 0×0
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

  /**
   * Show or hide the window for the active desktop. Hidden, it keeps its state, rect and tile; a docked one leaves the
   * docking layout as a minimized one does (its place is kept) and goes back into it. `dir` (1 / -1): the way the
   * desktops moved, for the slide in.
   */
  function syncSpace(dir = 0) {
    win.dataset.desktop = desktopOfKey(spaceKey);
    const off = spacesOn() && win.dataset.desktop !== spacesState().active;
    if (off === win.classList.contains('off-space') || closing) return;
    win.classList.toggle('off-space', off);
    win.classList.add('space-back'); // its opening animation never replays (styles.css)
    win.classList.remove('space-in-next', 'space-in-prev');
    if (off) { if (rec.state !== 'minimized') stowDockable(id); return; }
    if (rec.state === 'minimized') return;
    unstowDockable(id);
    if (dir && !reducedMotion()) {
      const cls = dir > 0 ? 'space-in-next' : 'space-in-prev';
      win.classList.add(cls);
      setTimeout(() => win.classList.remove(cls), 260);
    }
    win.dispatchEvent(new CustomEvent('winresize'));
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
    forgetKey(spaceKey); // it opens on the active desktop next time
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

/** Focus the topmost window still on the stage (not `except`, on the active desktop), else let focus fall back to the page. */
function focusTop(except) {
  const next = listWindows({ desktop: activeDesktop().id }).find((w) => w.el !== except && isVisible({ state: w.state }));
  if (next) next.el.focus({ preventScroll: true });
  else document.activeElement?.blur?.();
}

/**
 * Open windows, topmost first: { id, title, icon, state, desktop, raise(), close(), el }. `desktop`: only the windows on
 * that desktop (an id from listDesktops(); on a phone every window is on the one desktop).
 */
export function listWindows({ desktop } = {}) {
  return [...windows].filter((w) => w._wm && (desktop == null || w._wm.desktop() === desktop)).sort((a, b) => Number(b.style.zIndex) - Number(a.style.zIndex))
    .map((w) => ({ id: w.dataset.winId, title: w._wm.title(), icon: w._wm.icon, state: w._wm.state(), desktop: w._wm.desktop(), raise: w._wm.raise, close: w._wm.close, el: w }));
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
  if (action !== 'minimize' && action !== 'close') w._wm.reveal(); // on another desktop: go there first
  w._wm.act(action);
  if (action !== 'minimize' && action !== 'close') w._wm.raise();
  return true;
}
export const minimizeWindow = (id) => windowAction(id, 'minimize');
export const restoreWindow = (id) => windowAction(id, 'restore');
export const toggleMaximize = (id) => windowAction(id, 'toggleMaximize');
/** Close every window on the desktop of window `id` except that one. */
export function closeOthers(id) {
  const desktop = byId(id)?._wm.desktop();
  for (const w of listWindows({ desktop })) if (w.id !== String(id)) w.close();
}

export function closeAll() { for (const w of [...windows]) w.querySelector('.win-btn.close')?.click(); }

// ---------------------------------------------------------------- Spaces (spaces.js): the API other modules use

export { listDesktops, activeDesktop, switchDesktop, addDesktop, removeDesktop, renameDesktop, onSpacesChange, canAddDesktop, canRemoveDesktop } from './spaces.js';

/** Move window `id` to desktop `desktopId` (it hides when that is not the active desktop). */
export function moveWindowToDesktop(id, desktopId) {
  const w = byId(id);
  return !!w && moveKey(w._wm.spaceKey, desktopId);
}
/** The desktop window `id` is on, or null. */
export const windowDesktop = (id) => byId(id)?._wm.desktop() ?? null;

function switchToKey(key) { switchDesktop(desktopOfKey(key)); }

setOpenKeys(() => [...windows].filter((w) => w._wm).map((w) => w._wm.spaceKey));

// The active desktop changed (or a window moved, a desktop went): put each window on or off the stage. Focus that was in
// a window now hidden goes to the top window of the new desktop.
function syncSpaces({ state, prev } = {}) {
  const order = (s, id) => s?.desktops.findIndex((d) => d.id === id) ?? -1;
  const dir = state && prev && prev.active !== state.active ? Math.sign(order(state, state.active) - order(state, prev.active)) || 1 : 0;
  const lost = document.activeElement?.closest?.('.win');
  for (const w of [...windows]) w._wm?.syncSpace(dir);
  if (lost?.classList.contains('off-space') || (dir && (!document.activeElement || document.activeElement === document.body))) focusTop(null);
  refitTiles(); // a tiled window follows its zone if the screen changed while it was away
}
onSpacesChange(syncSpaces);
window.matchMedia?.(PHONE_QUERY)?.addEventListener?.('change', () => syncSpaces()); // a phone shows every window
