import { h } from './api.js';
import { announce } from './a11y.js';
import { dockManager, panelStatus } from './dock-layout.js';
import { addDropTarget } from './docking.js';
import { askSlot, menubarHidden, mountAskSlot, peekMenubar } from './menubar.js';
import { isPhone, PHONE_QUERY } from './mobile.js';
import { focusPanel, makeFloating } from './panels.js';
import {
  ASK_KEY, HISTORY_KEY, askHost, askPlacement, panelWanted, pushHistory, recallHistory, restoreAskPlacement, serializeAsk,
} from './ask-panel-model.js';

// Ask JARVIS as its own panel (#ask-panel: the field, 🎙 push-to-talk, 👂 hands-free and ➤ send), dockable like
// every other panel (panels.js / docking.js, id 'ask': float, drag by its title bar, resize its width, dock beside or
// tab with panels, ✕ hides it) — and dockable into the top menu bar's slot (#menubar-ask-slot), with or without the
// docking mode. Dragging its title bar over the menu bar shows the drop target; ⤒ in its title bar, Window › Dock Ask
// JARVIS to top bar and the drop put it there; ⏏ in the slot (or Window › Float Ask JARVIS) pops it back out at its
// last floating rect. ⌘/Ctrl+K focuses it wherever it is and reopens it when hidden. ↑/↓ in the field recall what
// was sent before (rigs.askHistory).
//
// The elements (#ask, #btn-mic, #btn-hands) are moved, never cloned, so main.js's wiring (submit, history, voice)
// and everything else that looks up #ask keeps working in every placement. The placement model is
// ask-panel-model.js (persisted in rigs.askPanel; desktop default: the top bar). In the top bar the panel itself is
// hidden in the dock layout and left out of ☰ / Show all.
//
// Menu bar hidden (Ctrl/⌘+Shift+M): an Ask docked in the top bar stays there and peeks with the bar — hover the top
// edge, press ⌘/Ctrl+K (peeks the bar and focuses the field) or F10; the bar stays out while the field has focus.
//
// Phones keep today's layout: the field and 🎙 sit in the bottom toolbar (#bar), 👂 in the ⋯ sheet (mobile.js); no
// panel, no top bar, no floating.

const ID = 'ask';
const $ = (s) => document.querySelector(s);

let state = null;
let panel = null;
let row = null; // #ask-row: the field and its buttons, moved between the panel and the menu bar slot
let undockBtn = null;
let queued = false;
let history = [];
let hIndex = null; // browsing the history: the entry shown, null = the draft
let draft = '';

function read() { try { return localStorage.getItem(ASK_KEY); } catch { return null; } }
function save() { try { localStorage.setItem(ASK_KEY, serializeAsk(state)); } catch { /* private mode */ } }

function floatingRect(L) {
  const f = L.floating.find((x) => x.id === ID);
  return f && f.x !== null && f.y !== null ? { x: f.x, y: f.y, w: f.w, h: f.h } : null;
}

/** Apply an event to the placement; the layout and the DOM follow. */
function sync(ev) {
  const next = askPlacement(state, ev, { phone: isPhone() });
  if (next === state) return;
  state = next;
  save();
  place();
  if (!queued) { queued = true; queueMicrotask(() => { queued = false; enforce(); }); } // not from inside a layout listener
}

/** Make the panel's status in the dock layout match the mode. */
function enforce() {
  if (isPhone()) return;
  const st = panelStatus(dockManager.getLayout(), ID);
  const want = panelWanted(state);
  if (want === 'hidden') { if (st && st !== 'hidden') dockManager.hidePanel(ID); return; }
  if (want === 'floating' && st !== 'floating') dockManager.floatPanel(ID, state.rect || {});
  else if (want === 'docked' && st === 'hidden') dockManager.restorePanel(ID);
}

/** Move the field and its buttons to where the mode says. */
function place() {
  const ask = $('#ask');
  const mic = $('#btn-mic');
  const hands = $('#btn-hands');
  const host = askHost(state, { phone: isPhone() });
  const focused = document.activeElement === ask;
  if (host === 'bar') {
    const bar = $('#bar');
    if (ask.parentElement !== bar) bar.prepend(ask, mic); // 👂 goes to the ⋯ sheet with the other buttons (mobile.js)
    mountAskSlot();
  } else {
    if (ask.parentElement !== row) row.prepend(ask, mic, hands);
    else if (hands.parentElement !== row) mic.after(hands);
    if (host === 'topbar') { if (row.parentElement !== askSlot()) mountAskSlot(row, undockBtn); }
    else if (row.parentElement !== panel) { panel.append(row); mountAskSlot(); }
  }
  if (focused && document.activeElement !== ask) ask.focus({ preventScroll: true });
}

// ------------------------------------------------------------------ actions (commands, ⤒, ⏏, the drop)

export const askMode = () => state?.mode ?? 'topbar';

/** Into the menu bar slot (from floating: remember the rect to pop back out there). */
export function dockAskToTopbar({ say = true } = {}) {
  if (isPhone()) return;
  const L = dockManager.getLayout();
  sync({ type: 'topbar', rect: panelStatus(L, ID) === 'floating' ? floatingRect(L) : null });
  if (say) announce('Ask JARVIS docked in the top bar.');
}

/** Out to a floating panel at its last floating rect. */
export function floatAsk() {
  if (isPhone()) return;
  sync({ type: 'float' });
  requestAnimationFrame(() => focusPanel(ID));
}

export function hideAsk() { if (!isPhone()) sync({ type: 'hide' }); }

/** ⌘/Ctrl+K: reopen it if hidden, reveal it (a hidden menu bar peeks) and put the cursor in the field. */
export function focusAsk() {
  const ask = $('#ask');
  if (!isPhone()) {
    sync({ type: 'show' });
    if (state.mode === 'topbar') { if (menubarHidden()) peekMenubar(); } else { requestAnimationFrame(() => focusPanel(ID)); return; }
  }
  requestAnimationFrame(() => ask.focus({ preventScroll: true }));
}

// ------------------------------------------------------------------ input history

/** Remember a sent request for ↑/↓ (main.js calls it on submit). */
export function rememberAsk(text) {
  history = pushHistory(history, text);
  hIndex = null;
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch { /* private mode */ }
}

function wireHistory(ask) {
  try { history = pushHistory(JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'), ''); } catch { history = []; }
  ask.addEventListener('keydown', (e) => {
    if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return;
    if (hIndex === null) draft = ask.value;
    const r = recallHistory(history, hIndex, e.key === 'ArrowUp' ? -1 : 1, draft);
    if (r.index === hIndex) return;
    e.preventDefault();
    hIndex = r.index;
    ask.value = r.value;
    ask.setSelectionRange(r.value.length, r.value.length);
  });
  ask.addEventListener('input', () => { hIndex = null; }); // typing leaves the history
}

/** Esc in the top bar's field leaves it, so a hidden menu bar can slide away again (its focusout ends the peek). */
function wireEscape(ask) {
  ask.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.isComposing && state?.mode === 'topbar' && !isPhone()) ask.blur();
  });
}

// ------------------------------------------------------------------ the drop target over the menu bar

function leaveTarget() {
  setTarget(false);
  if (menubarHidden()) peekMenubar();
}

function setTarget(on) {
  const slot = askSlot();
  if (!slot || slot.classList.contains('mb-ask-target') === on) return slot;
  slot.classList.toggle('mb-ask-target', on);
  slot.hidden = !on && !slot.childElementCount;
  return slot;
}

/** The pointer is over the menu bar (its 32px, or the top edge when the bar is hidden): the slot is the target. */
function hit(x, y) {
  if (isPhone() || y > 40) { if (askSlot()?.classList.contains('mb-ask-target')) leaveTarget(); return null; }
  if (menubarHidden()) peekMenubar({ hold: true }); // stays out while the drag hovers; leave() lets it go
  const r = setTarget(true)?.getBoundingClientRect();
  if (!r || !r.width) return null;
  return { x: r.left - 4, y: r.top - 3, w: r.width + 8, h: r.height + 6 };
}

// ------------------------------------------------------------------ setup

/** Call once, after the menu bar exists (main.js wireMenus). `onSend` submits the field (the same as Enter). */
export function initAskPanel({ onSend } = {}) {
  panel = $('#ask-panel');
  row = $('#ask-row');
  if (!panel || !row) return;
  state = restoreAskPlacement(read());
  const head = panel.querySelector('.ask-head');
  head.append(h('button', { class: 'pclose ask-pin', title: 'Dock into the top bar', 'aria-label': 'Dock Ask JARVIS into the top bar', onclick: (e) => { e.stopPropagation(); dockAskToTopbar(); } }, '⤒'));
  wireHistory($('#ask'));
  wireEscape($('#ask'));
  $('#ask-send')?.addEventListener('click', () => { onSend?.(); $('#ask').focus({ preventScroll: true }); });
  undockBtn = h('button', { class: 'mb-ask-undock', title: 'Float Ask JARVIS — pop it out of the menu bar', 'aria-label': 'Float Ask JARVIS', onclick: () => floatAsk() }, '⏏');

  makeFloating(panel, { id: ID, title: 'Ask JARVIS', into: head, keep: [head], closedByDefault: true, listed: () => state.mode !== 'topbar' });
  dockManager.subscribe((L, cause) => sync({ type: 'layout', status: panelStatus(L, ID), rect: floatingRect(L), cause }));
  addDropTarget({ accepts: (id) => id === ID, hit, leave: leaveTarget, drop: () => dockAskToTopbar(), label: 'Dock Ask JARVIS into the top bar' });
  window.matchMedia?.(PHONE_QUERY)?.addEventListener?.('change', () => { place(); enforce(); });
  place();
  enforce();
}
