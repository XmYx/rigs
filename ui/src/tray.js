import { api, h } from './api.js';
import { createTrayRegistry } from './tray-registry.js';
import { formatClock, limitView, monthGrid, msToNextMinute, parseHour12, shiftMonth } from './tray-model.js';

// The status tray at the right of the top menu bar (and, compact, in the phone header): small items like the macOS menu
// bar's icons. Items plug in through registerTrayItem() (see tray-registry.js); built in here: session limit, clock,
// calendar. One popover at a time, closed by Esc, an outside click or opening another; focus returns to its button.
// The clock re-renders once per minute from one timer and the plan limits are read at most once a minute, both only
// while a tray is mounted (teardown clears them).

const registry = createTrayRegistry();
export const registerTrayItem = registry.register;
export const unregisterTrayItem = registry.unregister;

const HOUR_KEY = 'rigs.clock12';
const POLL_MS = 60000;
const mounts = new Set(); // { host, phone, render }
let pop = null; // { el, anchor, off }

const store = {
  get() { try { return localStorage.getItem(HOUR_KEY); } catch { return null; } },
  set(v) { try { localStorage.setItem(HOUR_KEY, v); } catch { /* private mode */ } },
};
let hour12 = parseHour12(store.get());

// ------------------------------------------------------------------ popover

export function closeTrayPopover({ restore = true } = {}) {
  if (!pop) return;
  const { el, anchor, off } = pop;
  pop = null;
  off();
  el.remove();
  anchor?.setAttribute('aria-expanded', 'false');
  if (restore && anchor?.isConnected) anchor.focus({ preventScroll: true });
}

export const trayPopoverOpen = () => !!pop;

/** Show `build({ rerender, fresh })`'s element(s) in a popover under `anchor`; rerender() rebuilds in place (fresh is true only on the first build). */
export function openTrayPopover(anchor, build, { label = 'Details' } = {}) {
  const same = pop?.anchor === anchor;
  closeTrayPopover({ restore: false });
  if (same) return; // clicking the button again toggles it shut
  document.dispatchEvent(new Event('tray-popover-open')); // the menu bar closes its menus
  const el = h('div', { class: 'mb-menu tray-pop', role: 'dialog', 'aria-label': label, tabindex: '-1' });
  let fresh = true;
  const fill = () => { el.replaceChildren(...[].concat(build({ rerender: fill, fresh }))); fresh = false; };
  fill();
  document.body.append(el);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const w = el.getBoundingClientRect().width;
    el.style.top = r.bottom + 4 + 'px';
    el.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
  };
  place();
  anchor.setAttribute('aria-expanded', 'true');
  const onDown = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closeTrayPopover({ restore: false }); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeTrayPopover(); } };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  pop = { el, anchor, fill, off: () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', place); } };
  el.focus({ preventScroll: true });
}

// ------------------------------------------------------------------ mounting

function renderMount(m) {
  m.els = m.els || new Map(); // id → { item, el }
  const ctx = (item) => ({
    phone: m.phone,
    refresh: () => renderMount(m),
    openPopover: (anchor) => item.popover && openTrayPopover(anchor, (c) => item.popover({ phone: m.phone, ...c }), { label: item.label || item.id }),
  });
  const els = registry.items({ phone: m.phone }).map((item) => {
    const kept = m.els.get(item.id);
    // keep the node (keyboard focus, an open popover's anchor) across refreshes; only a re-registered item renders anew
    if (kept?.item === item) { item.update?.(kept.el); return kept.el; }
    const el = item.render(ctx(item));
    if (!el) { m.els.delete(item.id); return null; }
    el.dataset.trayItem = item.id;
    if (item.popover) el.addEventListener('click', (e) => { e.stopPropagation(); ctx(item).openPopover(el); });
    m.els.set(item.id, { item, el });
    return el;
  }).filter(Boolean);
  const cur = m.host.children;
  if (cur.length !== els.length || els.some((el, i) => cur[i] !== el)) m.host.replaceChildren(...els); // moving a focused node blurs it
}

/** Render the tray into `host`; returns an unmount function. */
export function mountTray(host, { phone = false } = {}) {
  const m = { host, phone };
  mounts.add(m);
  const off = registry.onChange(() => renderMount(m));
  renderMount(m);
  start();
  return () => { off(); mounts.delete(m); host.replaceChildren(); if (!mounts.size) stop(); };
}

// ------------------------------------------------------------------ shared timers

let clockTimer = null;
let pollTimer = null;
let plan = null;
let polling = false;

const refreshAll = () => mounts.forEach(renderMount);
const clockEls = () => [...mounts].flatMap((m) => [...m.host.querySelectorAll('[data-clock]')]);

function tickClock() {
  const t = formatClock(new Date(), hour12);
  clockEls().forEach((el) => { if (el.textContent !== t) el.textContent = t; });
  clockTimer = setTimeout(tickClock, msToNextMinute(Date.now()) + 50);
}

async function poll() {
  if (polling || document.hidden) return;
  polling = true;
  try { plan = (await api('/api/local/work?plan=1')).plan || null; } catch (e) { plan = { error: e.message }; }
  polling = false;
  refreshAll();
  if (pop?.anchor?.dataset.trayItem === 'session-limit') pop.fill();
}

function start() {
  if (!clockTimer) tickClock();
  if (!pollTimer) { poll(); pollTimer = setInterval(poll, POLL_MS); document.addEventListener('visibilitychange', onVisible); }
}
function stop() {
  clearTimeout(clockTimer); clockTimer = null;
  clearInterval(pollTimer); pollTimer = null;
  document.removeEventListener('visibilitychange', onVisible);
  closeTrayPopover({ restore: false });
}
function onVisible() { if (!document.hidden) poll(); }

// ------------------------------------------------------------------ built-in items

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
let calView = null;

function tickNow() { clearTimeout(clockTimer); tickClock(); }

/** The menu bar clock's 12/24-hour setting (also System Preferences › Appearance › 12-hour clock). */
export const clock12 = () => hour12;
export function setClock12(on) { hour12 = !!on; store.set(hour12 ? 'h12' : 'h24'); tickNow(); }

function calendarPopover({ rerender, fresh }) {
  const now = new Date();
  if (fresh || !calView) calView = { year: now.getFullYear(), month: now.getMonth() };
  const nav = (d) => () => { calView = shiftMonth(calView.year, calView.month, d); rerender(); };
  const grid = monthGrid(calView.year, calView.month, now);
  const title = `${MONTHS[calView.month]} ${calView.year}`;
  return [
    h('div', { class: 'tray-cal-head' },
      h('button', { class: 'tray-btn', 'aria-label': 'Previous month', onclick: nav(-1) }, '‹'),
      h('b', { 'aria-live': 'polite' }, title),
      h('button', { class: 'tray-btn', 'aria-label': 'Next month', onclick: nav(1) }, '›')),
    h('table', { class: 'tray-cal', role: 'grid', 'aria-label': title },
      h('thead', {}, h('tr', {}, ...DAYS.map((d) => h('th', { scope: 'col' }, d)))),
      h('tbody', {}, ...grid.map((w) => h('tr', {}, ...w.map((c) => h('td', { class: `${c.inMonth ? '' : 'out'}${c.today ? ' today' : ''}`, ...(c.today ? { 'aria-current': 'date' } : {}) }, c.day)))))),
    h('div', { class: 'tray-cal-foot' },
      h('button', { class: 'tray-link', onclick: () => { calView = null; rerender(); } }, 'Today'),
      h('button', { class: 'tray-link', 'aria-pressed': String(hour12), title: 'Switch the clock between 12 and 24 hours', onclick: () => { hour12 = !hour12; store.set(hour12 ? 'h12' : 'h24'); tickNow(); rerender(); } }, hour12 ? '12-hour clock' : '24-hour clock')),
  ];
}

function limitButton() {
  return h('button', { class: 'tray-item tray-limit', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
    h('span', { class: 'tray-meter', 'aria-hidden': 'true' }, h('i')), h('span', { class: 'tray-pct' }));
}
function paintLimit(el) {
  const v = limitView(plan);
  el.className = `tray-item tray-limit ${v.tone}`;
  el.title = v.title;
  el.setAttribute('aria-label', v.title);
  el.querySelector('i').style.width = (v.pct ?? 0) + '%';
  el.querySelector('.tray-pct').textContent = v.label;
}

registerTrayItem({
  id: 'session-limit', order: 10, phone: true, label: 'Session limit',
  render() { const el = limitButton(); paintLimit(el); return el; },
  update: paintLimit,
  popover() {
    const v = limitView(plan);
    if (!v.rows.length) return [h('div', { class: 'tray-pop-title' }, 'Session limit'), h('div', { class: 'muted small' }, v.title)];
    const at = (r) => (r.resetsAt ? new Date(r.resetsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '');
    return [h('div', { class: 'tray-pop-title' }, 'Plan limits'),
      ...v.rows.map((r) => h('div', { class: 'tray-lim-row' },
        h('div', { class: 'tray-lim-top' }, h('span', {}, r.name), h('b', { class: r.tone }, `${r.pct}% used`)),
        h('div', { class: `tray-meter wide ${r.tone}`, role: 'img', 'aria-label': `${r.name}: ${r.pct}% used` }, h('i', { style: { width: r.pct + '%' } })),
        r.reset ? h('div', { class: 'muted small' }, `Resets ${r.reset} · ${at(r)}`) : null))];
  },
});

registerTrayItem({
  id: 'clock', order: 30, phone: true, label: 'Calendar', popover: calendarPopover,
  render() {
    // named by the time it shows (an aria-label that left it out fails axe's label-content-name-mismatch)
    return h('button', { class: 'tray-item tray-clock', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', title: 'Clock · open the calendar' },
      h('span', { 'data-clock': '1' }, formatClock(new Date(), hour12)));
  },
});

registerTrayItem({
  id: 'calendar', order: 20, label: 'Calendar', popover: calendarPopover,
  render() { return h('button', { class: 'tray-item tray-cal-btn', title: 'Calendar', 'aria-label': 'Calendar', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, '📅'); },
});

/** Open the calendar / limit popover from elsewhere (the phone menu); anchored to the visible tray item. */
export function openTrayItem(id) {
  for (const m of mounts) {
    const el = m.host.querySelector(`[data-tray-item="${id}"]`);
    if (el && el.offsetParent !== null) { el.click(); return true; }
  }
  return false;
}
