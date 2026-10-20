import { h, toast } from './api.js';
import { commands, formatShortcut, inTextField, isMac } from './commands.js';
import { isPhone, PHONE_QUERY } from './mobile.js';
import { closeTrayPopover, mountTray, openTrayItem, trayPopoverOpen } from './tray.js';

// The top menu bar: File, Edit, Window, Tools, Help — slim, animated, themed by the CSS variables of themes.js.
// Every item runs a command from commands.js (the model comes from jarvis-commands.js menuModel()).
// Hide/show: Window › Hide menu bar, Ctrl/⌘+Shift+M, or hover the top edge to peek; the setting persists
// (rigs.menubar). Keyboard: F10 focuses it; ←/→ between menus, ↑/↓ inside, → opens a submenu, Esc closes.
// ARIA: menubar / menu / menuitem(checkbox) / separator. On a phone it collapses into one ⋮ button in the header
// whose menu drills into File, Edit… in place.
// openMenuAt() renders the same menus at a point, for context menus.
// The right end holds the status tray (tray.js: session limit, calendar, clock); on a phone a compact copy sits in the header.
// The right side holds one self-contained slot, #menubar-ask-slot: mountAskSlot() puts the inline Ask JARVIS field
// there (ask-panel.js decides when), askSlot() is the element (its drop target), peekMenubar() shows a hidden bar.

const KEY = 'rigs.menubar';
const mac = isMac();
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

let model = () => [];
let extraCtx = () => ({});
let bar = null;
let tops = []; // top-level buttons
let phoneBtn = null;
let zone = null;
const open = []; // stack of { el, level, parentItem }
let openTop = -1; // index of the open top menu; -2 phone menu, -3 context menu
let prevFocus = null; // where focus was before the menu took it
let lastField = null; // the last text field used (Edit › Copy/Paste act on it)
let hidden = readHidden();
let peekTimer = null;
let hoverTimer = null;
let askSlotEl = null; // #menubar-ask-slot
let askPending = null; // mountAskSlot() before initMenubar()

function readHidden() { try { return localStorage.getItem(KEY) === 'hidden'; } catch { return false; } }
function saveHidden() { try { localStorage.setItem(KEY, hidden ? 'hidden' : 'shown'); } catch { /* private mode */ } }

/** The context every command sees when it is shown or run from here. */
export function menuCtx() {
  return { mac, phone: isPhone(), inText: false, field: lastField, menubarHidden: hidden, ...extraCtx() };
}

// ------------------------------------------------------------------ rendering one menu

/** Turn model entries into visible rows: commands that don't apply are dropped, separators tidied. */
function visibleRows(entries, ctx) {
  const rows = [];
  for (const e of entries) {
    if (e.sep) { if (rows.length && !rows.at(-1).sep) rows.push(e); continue; }
    if (e.cmd && !commands.isVisible(e.cmd, ctx, e.args)) continue;
    rows.push(e);
  }
  while (rows.length && rows.at(-1).sep) rows.pop();
  return rows.filter((r, i) => !r.header || (rows[i + 1] && !rows[i + 1].sep && !rows[i + 1].header)); // a header with nothing under it goes
}

function renderMenu(entries, { level = 0, labelledBy, label, back } = {}) {
  const ctx = menuCtx();
  const el = h('div', { class: `mb-menu${level ? ' mb-sub' : ''}`, role: 'menu', tabindex: '-1', ...(labelledBy ? { 'aria-labelledby': labelledBy } : { 'aria-label': label || 'Menu' }) });
  if (back) el.append(h('div', { class: 'mb-item mb-back', role: 'menuitem', tabindex: '-1', onclick: (e) => { e.stopPropagation(); back(); } }, h('span', { class: 'mb-ico', 'aria-hidden': 'true' }, '‹'), h('span', { class: 'mb-label' }, 'Back')));
  for (const e of visibleRows(entries, ctx)) {
    if (e.sep) { el.append(h('div', { class: 'mb-sep', role: 'separator' })); continue; }
    if (e.header) { el.append(h('div', { class: 'mb-header', role: 'presentation' }, e.header)); continue; }
    const cmd = e.cmd ? commands.get(e.cmd) : null;
    const enabled = !e.disabled && (!cmd || commands.isEnabled(e.cmd, ctx, e.args));
    const checkable = cmd ? !!cmd.checked : e.checked !== undefined; // inline entries (context menus) may carry their own checked state
    const checked = checkable && (cmd ? commands.isChecked(e.cmd, ctx, e.args) : !!e.checked);
    const text = e.label || (cmd ? commands.label(e.cmd, ctx, e.args) : '');
    const scDef = cmd ? (cmd.shortcut ? [].concat(cmd.shortcut)[0] : cmd.hint) : (e.shortcut || e.hint || '');
    const sc = scDef ? formatShortcut(scDef, mac) : '';
    const item = h('div', {
      class: `mb-item${enabled ? '' : ' disabled'}${e.submenu ? ' has-sub' : ''}${e.danger ? ' danger' : ''}`,
      role: checkable ? 'menuitemcheckbox' : 'menuitem', tabindex: '-1',
      ...(checkable ? { 'aria-checked': String(checked) } : {}),
      ...(enabled ? {} : { 'aria-disabled': 'true' }),
      ...(e.submenu ? { 'aria-haspopup': 'menu', 'aria-expanded': 'false' } : {}),
      ...(sc ? { 'aria-keyshortcuts': scDef.replace('Mod', mac ? 'Meta' : 'Control') } : {}),
    },
    h('span', { class: 'mb-ico', 'aria-hidden': 'true' }, checkable ? (checked ? '✓' : '') : (cmd?.icon || e.icon || '')),
    h('span', { class: 'mb-label' }, text),
    sc ? h('span', { class: 'mb-sc', 'aria-hidden': 'true' }, sc) : null,
    e.submenu ? h('span', { class: 'mb-arrow', 'aria-hidden': 'true' }, '▸') : null);
    item._entry = e;
    item._enabled = enabled;
    el.append(item);
  }
  if (!el.querySelector('.mb-item:not(.mb-back)')) el.append(h('div', { class: 'mb-item disabled', role: 'menuitem', tabindex: '-1', 'aria-disabled': 'true' }, h('span', { class: 'mb-ico' }), h('span', { class: 'mb-label' }, 'Nothing here')));
  el.addEventListener('keydown', onMenuKey);
  el.addEventListener('click', onMenuClick);
  el.addEventListener('pointerover', onMenuHover);
  return el;
}

const items = (menuEl) => [...menuEl.querySelectorAll(':scope > .mb-item')];
const levelOf = (menuEl) => open.findIndex((m) => m.el === menuEl);

function place(el, x, y, { flipFrom } = {}) {
  el.style.left = '0px'; el.style.top = '0px';
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = x;
  if (left + r.width > vw - 8) left = flipFrom != null ? flipFrom - r.width : vw - 8 - r.width;
  let top = y;
  if (top + r.height > vh - 8) top = Math.max(8, vh - 8 - r.height);
  Object.assign(el.style, { left: Math.max(8, left) + 'px', top: top + 'px', maxHeight: (vh - top - 8) + 'px' });
}

function show(el) {
  document.body.append(el);
  if (!reduced()) { el.classList.add('mb-enter'); requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('mb-enter'))); }
}

function focusItem(menuEl, which) {
  const list = items(menuEl);
  if (!list.length) { menuEl.focus({ preventScroll: true }); return; }
  const it = which === 'last' ? list.at(-1) : typeof which === 'number' ? list[Math.max(0, Math.min(list.length - 1, which))] : list.find((x) => x._enabled && !x.classList.contains('mb-back')) || list[0];
  it.focus({ preventScroll: true });
}

// ------------------------------------------------------------------ open / close

function closeFrom(level) {
  while (open.length > level) {
    const m = open.pop();
    m.parentItem?.setAttribute('aria-expanded', 'false');
    m.parentItem?.classList.remove('sub-open');
    m.el.remove();
  }
  if (level === 0) {
    tops.forEach((b) => { b.setAttribute('aria-expanded', 'false'); b.classList.remove('active'); });
    phoneBtn?.setAttribute('aria-expanded', 'false');
    openTop = -1;
    bar?.classList.remove('menu-open');
    schedulePeekEnd();
  }
}

/** Close every menu; focus goes back where it was (or to the bar button when asked). */
export function closeMenus({ restore = true, focusTop = false } = {}) {
  const top = openTop;
  const had = open.length > 0;
  closeFrom(0);
  if (focusTop && tops[top]) tops[top].focus({ preventScroll: true });
  else if (had && restore && prevFocus?.isConnected) prevFocus.focus?.({ preventScroll: true });
}

/** Part of the bar's own chrome (menus, buttons) — the Ask slot's field is an ordinary text field. */
const inChrome = (el) => !!el?.closest?.('.mb-menu, #menubar, #mb-phone') && !el.closest('#menubar-ask-slot');

function rememberFocus() {
  const a = document.activeElement;
  if (a && !inChrome(a)) prevFocus = a;
}

function openTopMenu(i, { focus = 'none' } = {}) {
  const def = model()[i];
  if (!def) return;
  if (!open.length) rememberFocus();
  closeFrom(0);
  openTop = i;
  const btn = tops[i];
  btn.setAttribute('aria-expanded', 'true');
  btn.classList.add('active');
  bar.classList.add('menu-open');
  const el = renderMenu(def.items(), { level: 0, labelledBy: btn.id });
  show(el);
  const r = btn.getBoundingClientRect();
  place(el, r.left, r.bottom + 4);
  open.push({ el, level: 0 });
  if (focus !== 'none') focusItem(el, focus);
}

function openSubmenu(item, { focus = 'none' } = {}) {
  const menuEl = item.parentElement;
  const level = levelOf(menuEl);
  if (level < 0) return;
  if (open[level + 1]?.parentItem === item) { if (focus !== 'none') focusItem(open[level + 1].el, focus); return; }
  closeFrom(level + 1);
  const entries = item._entry.submenu();
  const label = item.querySelector('.mb-label')?.textContent;
  if (menuEl._stack) { drill(menuEl, entries, label); return; }
  const el = renderMenu(entries, { level: level + 1, label });
  show(el);
  const r = item.getBoundingClientRect();
  place(el, r.right - 4, r.top - 5, { flipFrom: r.left + 4 });
  item.setAttribute('aria-expanded', 'true');
  item.classList.add('sub-open');
  open.push({ el, level: level + 1, parentItem: item });
  if (focus !== 'none') focusItem(el, focus);
}

// Phone: a submenu replaces the menu's content, with a Back row; the stack lives on the element.
function drill(menuEl, entries, label) {
  menuEl._stack.push({ entries: menuEl._entries, label: menuEl.getAttribute('aria-label') });
  fillPhone(menuEl, entries, label);
}
function fillPhone(menuEl, entries, label) {
  const back = menuEl._stack.length ? () => { const prev = menuEl._stack.pop(); fillPhone(menuEl, prev.entries, prev.label); } : null;
  const fresh = renderMenu(entries, { label, back });
  menuEl._entries = entries;
  menuEl.replaceChildren(...fresh.childNodes);
  menuEl.setAttribute('aria-label', label || 'JARVIS menu');
  if (menuEl._at) place(menuEl, menuEl._at.x, menuEl._at.y); // a context menu changes height as it drills: keep it on screen
  focusItem(menuEl, 'first');
}

function openPhoneMenu() {
  rememberFocus();
  closeFrom(0);
  const top = [...model().map((d) => ({ label: d.label, submenu: d.items })), { sep: true },
    { label: 'Calendar', icon: '📅', run: () => setTimeout(() => openTrayItem('clock'), 0) },
    { label: 'Session limit', icon: '◔', run: () => setTimeout(() => openTrayItem('session-limit'), 0) }];
  const el = renderMenu(top, { label: 'JARVIS menu' });
  el.classList.add('mb-phone-menu');
  el._entries = top;
  el._stack = [];
  show(el);
  phoneBtn.setAttribute('aria-expanded', 'true');
  openTop = -2;
  open.push({ el, level: 0 });
  focusItem(el, 'first');
}

/**
 * A context menu at a point (same rendering, keyboard and commands as the bar's menus). Entries are the menu model's:
 * { cmd, args } or inline { label, run, icon?, hint?, disabled?, danger?, checked?, submenu? }. Stays inside the viewport;
 * on a phone submenus drill in place (with a Back row) instead of flying out sideways.
 */
export function openMenuAt(x, y, entries, { label = 'Context menu' } = {}) {
  rememberFocus();
  closeFrom(0);
  const el = renderMenu(entries, { label });
  el.classList.add('mb-ctx');
  if (isPhone()) { el.classList.add('mb-drill'); el._entries = entries; el._stack = []; el._at = { x, y }; }
  show(el);
  place(el, x, y);
  openTop = -3;
  open.push({ el, level: 0 });
  focusItem(el, 'first');
  return el;
}

/** Is a context menu (not a bar menu) open right now? */
export const contextMenuOpen = () => openTop === -3 && open.length > 0;

// ------------------------------------------------------------------ activation

function activate(item) {
  const e = item._entry;
  if (!e || !item._enabled) return;
  if (e.submenu && (!e.cmd || isPhone())) { openSubmenu(item, { focus: 'first' }); return; }
  if (!e.cmd && typeof e.run !== 'function') return;
  const ctx = menuCtx();
  closeMenus({ restore: true });
  try {
    const r = e.cmd ? commands.run(e.cmd, ctx, e.args) : e.run(ctx);
    if (r && typeof r.catch === 'function') r.catch((err) => toast(err.message, 'error'));
  } catch (err) { toast(err.message, 'error'); }
}

function onMenuClick(ev) {
  const item = ev.target.closest('.mb-item');
  if (!item || item.classList.contains('mb-back')) return;
  ev.stopPropagation();
  activate(item);
}

function onMenuHover(ev) {
  if (ev.pointerType === 'touch' || ev.currentTarget._stack) return;
  const item = ev.target.closest('.mb-item');
  if (!item) return;
  const menuEl = item.parentElement;
  if (document.activeElement !== item) item.focus({ preventScroll: true });
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    const level = levelOf(menuEl);
    if (level < 0) return;
    if (item._entry?.submenu && item._enabled) openSubmenu(item);
    else closeFrom(level + 1);
  }, 140);
}

function typeahead(menuEl, ch) {
  const list = items(menuEl);
  const start = list.indexOf(document.activeElement);
  for (let k = 1; k <= list.length; k++) {
    const it = list[(start + k) % list.length];
    if (it.querySelector('.mb-label')?.textContent.trim().toLowerCase().startsWith(ch)) { it.focus({ preventScroll: true }); return; }
  }
}

function backOrClose(menuEl, level) {
  if (menuEl._stack?.length) { menuEl.querySelector('.mb-back')?.click(); return true; }
  if (level > 0) { const parent = open[level].parentItem; closeFrom(level); parent?.focus({ preventScroll: true }); return true; }
  return false;
}

function onMenuKey(ev) {
  const menuEl = ev.currentTarget;
  const list = items(menuEl);
  const i = list.indexOf(document.activeElement);
  const level = levelOf(menuEl);
  const item = list[i];
  const stop = () => { ev.preventDefault(); ev.stopPropagation(); };
  switch (ev.key) {
    case 'ArrowDown': stop(); focusItem(menuEl, i < 0 || i === list.length - 1 ? 0 : i + 1); break;
    case 'ArrowUp': stop(); focusItem(menuEl, i <= 0 ? list.length - 1 : i - 1); break;
    case 'Home': stop(); focusItem(menuEl, 0); break;
    case 'End': stop(); focusItem(menuEl, 'last'); break;
    case 'Enter': case ' ': stop(); if (item?.classList.contains('mb-back')) item.click(); else if (item) activate(item); break;
    case 'ArrowRight':
      stop();
      if (item?._entry?.submenu && item._enabled) openSubmenu(item, { focus: 'first' });
      else if (openTop >= 0) { const k = (openTop + 1) % tops.length; setRoving(k); openTopMenu(k, { focus: 'first' }); }
      break;
    case 'ArrowLeft':
      stop();
      if (!backOrClose(menuEl, level) && openTop >= 0) { const k = (openTop - 1 + tops.length) % tops.length; setRoving(k); openTopMenu(k, { focus: 'first' }); }
      break;
    case 'Escape':
      stop();
      if (backOrClose(menuEl, level)) break;
      if (open.length > level + 1) { closeFrom(level + 1); break; } // a flyout opened by hover: close it first
      if (openTop === -2) { closeMenus({ restore: false }); phoneBtn?.focus(); } else closeMenus({ focusTop: openTop >= 0 });
      break;
    case 'Tab': closeMenus({ restore: false }); break;
    default:
      if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey && /\S/.test(ev.key)) { stop(); typeahead(menuEl, ev.key.toLowerCase()); }
  }
}

function onBarKey(ev) {
  const i = tops.indexOf(document.activeElement);
  if (i < 0) return;
  const stop = () => { ev.preventDefault(); ev.stopPropagation(); };
  const move = (j) => { const k = (j + tops.length) % tops.length; setRoving(k); tops[k].focus(); if (open.length) openTopMenu(k); };
  switch (ev.key) {
    case 'ArrowRight': stop(); move(i + 1); break;
    case 'ArrowLeft': stop(); move(i - 1); break;
    case 'Home': stop(); move(0); break;
    case 'End': stop(); move(tops.length - 1); break;
    case 'ArrowDown': case 'Enter': case ' ': stop(); openTopMenu(i, { focus: 'first' }); break;
    case 'ArrowUp': stop(); openTopMenu(i, { focus: 'last' }); break;
    case 'Escape': stop(); if (open.length) closeMenus({ focusTop: true }); else { endPeek(); prevFocus?.focus?.({ preventScroll: true }); } break;
    default: break;
  }
}

function setRoving(k) { tops.forEach((b, j) => b.setAttribute('tabindex', j === k ? '0' : '-1')); }

// ------------------------------------------------------------------ hide / show / peek

function applyHidden() {
  const peek = document.body.classList.contains('mb-peek');
  document.body.classList.toggle('mb-hidden', hidden);
  document.documentElement.style.setProperty('--mb-h', hidden || isPhone() ? '0px' : '32px');
  if (bar) bar.inert = hidden && !peek; // a hidden bar is out of the tab order and the accessibility tree
}

export const menubarHidden = () => hidden;

export function setMenubarHidden(on, { notify = true } = {}) {
  hidden = !!on;
  saveHidden();
  closeMenus({ restore: false });
  endPeek();
  if (hidden && notify) toast(`Menu bar hidden — hover the top edge or press ${formatShortcut('Mod+Shift+M', mac)} to bring it back.`, 'info', 6000);
}

export function toggleMenubar() { setMenubarHidden(!hidden); }

function startPeek() {
  clearTimeout(peekTimer);
  if (!hidden || isPhone()) return;
  document.body.classList.add('mb-peek');
  applyHidden();
}
/**
 * Show a hidden bar for a moment (it stays while it has focus or the pointer), e.g. to reach the Ask slot.
 * `hold`: keep it out until the next plain peekMenubar() (a drag over it: pointer capture means it never sees :hover).
 */
export function peekMenubar({ hold = false } = {}) { startPeek(); if (!hold) schedulePeekEnd(); }

// ------------------------------------------------------------------ the Ask JARVIS slot

/** Put nodes into the right-side slot (none = empty and hidden). Works before initMenubar too. */
export function mountAskSlot(...nodes) {
  if (!askSlotEl) { askPending = nodes; return; }
  const keep = nodes.some((n) => n?.contains?.(document.activeElement)) ? document.activeElement : null;
  askSlotEl.replaceChildren(...nodes);
  askSlotEl.hidden = !nodes.length && !askSlotEl.classList.contains('mb-ask-target');
  keep?.focus?.({ preventScroll: true });
}

/** The slot element (null before initMenubar). */
export const askSlot = () => askSlotEl;
function endPeek() {
  clearTimeout(peekTimer);
  document.body.classList.remove('mb-peek');
  applyHidden();
}
function schedulePeekEnd() {
  if (!hidden) return;
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => {
    if (open.length || trayPopoverOpen() || bar?.matches(':hover') || bar?.contains(document.activeElement)) return;
    endPeek();
  }, 650);
}

/** F10: reveal (if hidden) and put focus on the first menu. */
export function focusMenubar() {
  if (isPhone()) { phoneBtn?.focus(); return; }
  rememberFocus();
  if (hidden) startPeek();
  const k = Math.max(0, tops.findIndex((b) => b.getAttribute('tabindex') === '0'));
  tops[k]?.focus({ preventScroll: true });
}

// ------------------------------------------------------------------ setup

/** Build the bar. `menus()` returns the model (jarvis-commands.js menuModel), `ctx()` adds context for commands. */
export function initMenubar({ menus, ctx = () => ({}), status = () => '' } = {}) {
  model = menus;
  extraCtx = ctx;
  tops = model().map((d, i) => h('button', {
    id: `mb-top-${d.id}`, class: 'mb-top', role: 'menuitem', 'aria-haspopup': 'menu', 'aria-expanded': 'false', tabindex: i ? '-1' : '0',
    onclick: (e) => { e.stopPropagation(); if (openTop === i) closeMenus({ restore: false, focusTop: true }); else { setRoving(i); openTopMenu(i, { focus: e.detail === 0 ? 'first' : 'none' }); } },
    onpointerenter: () => { if (open.length && openTop >= 0 && openTop !== i) { setRoving(i); tops[i].focus({ preventScroll: true }); openTopMenu(i); } },
  }, d.label));
  const statusEl = h('span', { class: 'mb-status' });
  askSlotEl = h('div', { id: 'menubar-ask-slot', class: 'mb-ask-slot', role: 'group', 'aria-label': 'Ask JARVIS', hidden: true });
  const trayEl = h('div', { id: 'mb-tray', class: 'tray', role: 'toolbar', 'aria-label': 'Status' });
  const hideBtn = h('button', { class: 'mb-hide', title: `Hide menu bar (${formatShortcut('Mod+Shift+M', mac)})`, 'aria-label': 'Hide menu bar', onclick: () => setMenubarHidden(true) }, '⌃');
  bar = h('nav', { id: 'menubar', 'aria-label': 'JARVIS menu bar' },
    h('span', { class: 'mb-brand', 'aria-hidden': 'true' }, '◆ JARVIS'),
    h('div', { class: 'mb-tops', role: 'menubar', 'aria-label': 'JARVIS' }, ...tops),
    h('span', { class: 'mb-spacer' }), askSlotEl, statusEl, trayEl, hideBtn);
  bar.addEventListener('keydown', onBarKey);
  bar.addEventListener('pointerleave', schedulePeekEnd);
  bar.addEventListener('pointerenter', () => clearTimeout(peekTimer));
  bar.addEventListener('focusout', () => setTimeout(schedulePeekEnd, 0));
  mountTray(trayEl);
  zone = h('div', { id: 'mb-zone', 'aria-hidden': 'true' });
  zone.addEventListener('pointerenter', () => { clearTimeout(peekTimer); peekTimer = setTimeout(startPeek, 120); });
  zone.addEventListener('pointerleave', () => { if (!document.body.classList.contains('mb-peek')) clearTimeout(peekTimer); });
  document.body.append(zone, bar);
  if (askPending) { mountAskSlot(...askPending); askPending = null; }
  const updateStatus = () => { statusEl.textContent = status() || ''; };
  updateStatus();
  setInterval(updateStatus, 5000); // cheap; the node's name/version arrive with the first snapshot

  // Phone: one ⋮ button in the header opens the whole menu.
  phoneBtn = h('button', { id: 'mb-phone', class: 'round', title: 'Menu — File, Edit, Panels, Window, Tools, Help', 'aria-label': 'JARVIS menu', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    onclick: (e) => { e.stopPropagation(); if (openTop === -2) closeMenus({ restore: false }); else openPhoneMenu(); } }, '⋮');
  const placePhone = () => {
    const topbar = document.getElementById('topbar');
    if (isPhone() && topbar) { const d = document.getElementById('drawer-btn'); if (d?.parentElement === topbar) d.after(phoneBtn); else topbar.prepend(phoneBtn); }
    else phoneBtn.remove();
    closeMenus({ restore: false });
    closeTrayPopover({ restore: false });
    applyHidden();
  };
  const phoneTray = h('div', { id: 'mb-tray-phone', class: 'tray', role: 'toolbar', 'aria-label': 'Status' });
  document.body.append(phoneTray);
  mountTray(phoneTray, { phone: true });
  placePhone();
  window.matchMedia?.(PHONE_QUERY)?.addEventListener?.('change', placePhone);

  // Outside click closes; the last text field is remembered for Copy/Paste; shortcuts run commands.
  document.addEventListener('pointerdown', (e) => {
    if (!open.length) return;
    if (e.target.closest?.('.mb-menu, #menubar .mb-top, #mb-phone')) return;
    closeMenus({ restore: false });
  }, true);
  document.addEventListener('tray-popover-open', () => closeMenus({ restore: false }));
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (inChrome(t)) return;
    lastField = inTextField(t) && !t.closest?.('.xterm') ? t : null;
  });
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    if (e.target.closest?.('.mb-menu')) return; // the open menu handles its own keys
    const ctx = { ...menuCtx(), inText: inTextField(e.target) };
    const cmd = commands.forEvent(e, ctx);
    if (!cmd) return;
    e.preventDefault();
    const r = commands.run(cmd.id, ctx);
    if (r && typeof r.catch === 'function') r.catch((err) => toast(err.message, 'error'));
  });
  window.addEventListener('resize', () => { if (openTop !== -2) closeMenus({ restore: false }); });
  // A peeked bar appears under a still pointer, so it may never see pointerleave: moving away from the top ends it.
  document.addEventListener('pointermove', (e) => { if (document.body.classList.contains('mb-peek') && e.clientY > 72 && !open.length) schedulePeekEnd(); }, { passive: true });
  applyHidden();
  return { bar, toggle: toggleMenubar, focus: focusMenubar, setHidden: setMenubarHidden, isHidden: () => hidden };
}
