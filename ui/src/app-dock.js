// The macOS-style app dock: applets from the App Cloud and the mesh's online rigs, grouped into stacks the user can
// open, drag, reorder, pin, hide and rename. Everything drawn here comes from the pure state in app-dock-state.js
// (persisted with its serializer in localStorage `rigs.appdock`); app-dock-model.js holds the render-side logic.
// The dock never changes a panel, window or the top bar: it only calls the open/focus/launch functions main.js hands in.
//
//   const dock = createAppDock({ sources, open, isOpen, appFor, nodeFor });   dock.sync() after each snapshot
//   registerAppDockProviders(providers, dock)                                   its right-click / long-press menus
import { h } from './api.js';
import { tagCtx } from './ctx-tag.js';
import { isPhone, PHONE_QUERY } from './mobile.js';
import { prefersReducedMotion } from './a11y.js';
import { contextMenuOpen } from './menubar.js';
import { deserialize, dockView, magnifyScales, mergeSources, serialize } from './app-dock-state.js';
import {
  applyDrop, axisOf, canOpen, dropAt, easeScales, fitIcon, groupEntries, ICON, itemEntries, PAD, PHONE_ICON, RADIUS,
  rename, reserve, restCentres, settingsEntries, STORAGE_KEY,
} from './app-dock-model.js';

const DRAG_START = 5; // px before a press becomes a drag
const HIDE_DELAY = 450; // ms an auto-hidden dock stays after the pointer left
const BAND = 70; // px beyond the shelf a drag still counts as "over the dock"

const hue = (s) => { let x = 0; for (const c of String(s)) x = (x * 31 + c.codePointAt(0)) >>> 0; return x % 360; };
/** Two letters for a machine tile: "magix-system" → "MS", "macbookpro" → "MA". */
const monogram = (name) => {
  const parts = String(name || '?').split(/[-_.\s]+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : String(parts[0] || '?').slice(0, 2)).toUpperCase();
};
const mbHeight = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mb-h')) || 0;
const inside = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

function iconFor(it) {
  return it.kind === 'rig'
    ? h('span', { class: 'adock-icon mono', 'data-mono': monogram(it.title), style: { '--h': hue(it.id) } }) // letters drawn by CSS, so the tile's name stays the machine's name
    : h('span', { class: 'adock-icon', style: { '--h': hue(it.id) } }, it.icon || '▦');
}

export function createAppDock({ storage = globalThis.localStorage, sources = () => ({}), open = () => {}, isOpen = () => false, appFor = () => null, nodeFor = () => null } = {}) {
  let state = load();
  let phone = isPhone();
  let reduced = prefersReducedMotion();
  let size = ICON;
  let tiles = []; // [{ el, entry }] in view order
  let rest = [];
  let scales = [];
  let cursor = null; // pointer position along the axis while it is over the dock (mouse/pen)
  let raf = 0;
  let last = 0;
  let hover = null; // the tile under the pointer (for the label)
  let drag = null;
  let suppressClick = false;
  let popGroup = null; // id of the group whose popover is open
  let hideTimer = 0;
  let shown = false; // auto-hide: revealed right now

  const nav = h('nav', { id: 'app-dock', class: 'adock', role: 'toolbar', 'aria-label': 'App dock — applets and rigs' });
  const list = h('div', { class: 'adock-list' });
  nav.append(list);
  tagCtx(nav, 'appdock', null, null);
  const edge = h('div', { class: 'adock-edge', 'aria-hidden': 'true' });
  const label = h('div', { class: 'adock-label', 'aria-hidden': 'true' });
  const caret = h('div', { class: 'adock-caret', 'aria-hidden': 'true' });
  const pop = h('div', { class: 'adock-pop', role: 'dialog', hidden: true });
  document.body.append(edge, nav, label, caret, pop);

  function load() {
    try { return deserialize(storage?.getItem(STORAGE_KEY)); } catch { return deserialize(null); }
  }
  function save() {
    try { storage?.setItem(STORAGE_KEY, serialize(state)); } catch { /* private mode / quota: the dock still works this session */ }
  }

  /** Apply `fn(state) → state`; re-render and persist when it changed something. */
  function act(fn) {
    let next;
    try { next = fn(state); } catch { return state; }
    if (!next || next === state) return state;
    state = next;
    save();
    render();
    return state;
  }

  /** Fold the latest snapshot in (new applets/rigs appended, vanished ones dropped unless pinned). */
  function sync() {
    const next = mergeSources(state, sources() || {});
    if (serialize(next) === serialize(state)) { refreshRunning(); return; }
    state = next;
    save();
    if (!drag) render(); // mid-drag the drop re-renders; doing it now would pull the tiles out from under the pointer
  }

  const magnifyOn = () => state.settings.magnification && !phone && !reduced && !drag && !popGroup;
  const position = () => (phone ? 'bottom' : state.settings.position);

  // ------------------------------------------------------------------ render
  /**
   * Right-click, long press or Shift+F10 on a tile: the dock's own entries first (pin, hide, group…), then the app /
   * machine menu the rest of JARVIS shows (Open in a tab, Terminal, Files…). Both come from the tile itself, so the
   * keyboard path (the focused button) gets the same menu as the pointer.
   */
  function tagItem(el, it) {
    const dock = { kind: 'dockitem', id: it.id, data: { id: it.id } };
    if (it.kind === 'applet') tagCtx(el, 'app', `${it.ref.node}/${it.ref.id}`, { get app() { return appFor(it.ref); } });
    else if (it.kind === 'rig') tagCtx(el, 'node', it.ref.nodeId, { get node() { return nodeFor(it.ref.nodeId) || { id: it.ref.nodeId, name: it.title }; } });
    else { tagCtx(el, 'dockitem', it.id, dock.data); return el; }
    el._ctxAt = () => dock; // ctxTargets puts these before the element's own target
    return el;
  }

  function itemTile(it) {
    const hit = h('span', { class: 'adock-hit' }, iconFor(it));
    const el = h('button', {
      class: `adock-tile k-${it.kind}${it.live ? '' : ' off'}${it.pinned ? ' pinned' : ''}`, type: 'button', 'data-id': it.id,
      'aria-label': `${it.title}${it.live ? '' : ' (offline)'}`, tabindex: '-1',
    }, hit, h('i', { class: 'adock-run', 'aria-hidden': 'true' }));
    tagItem(el, it);
    el.addEventListener('click', (e) => { if (!consumeClick(e)) launch(el, it); });
    return el;
  }

  function groupTile({ group, items }) {
    const minis = items.slice(0, 4).map((it) => (it.kind === 'rig' ? h('span', { class: 'adock-mini k-rig', 'data-mono': monogram(it.title), style: { '--h': hue(it.id) } }) : h('span', { class: `adock-mini k-${it.kind}`, style: { '--h': hue(it.id) } }, it.icon || '▦')));
    const hit = h('span', { class: 'adock-hit' }, h('span', { class: 'adock-icon stack' }, ...minis));
    const el = h('button', {
      class: 'adock-tile adock-group', type: 'button', 'data-gid': group.id, tabindex: '-1',
      'aria-label': `${group.name} — group of ${items.length}`, 'aria-haspopup': 'dialog', 'aria-expanded': String(popGroup === group.id),
    }, hit, h('b', { class: 'adock-count', 'aria-hidden': 'true' }, String(items.length)));
    tagCtx(el, 'dockgroup', group.id, { id: group.id });
    el.addEventListener('click', (e) => { if (consumeClick(e)) return; if (popGroup === group.id) closePop(); else openPop(group.id); });
    return el;
  }

  const keyOf = (el) => (el ? el.dataset.id || `group:${el.dataset.gid}` : null);

  function render() {
    phone = isPhone();
    const view = dockView(state);
    const pos = position();
    const axis = axisOf(pos);
    const focusedKey = nav.contains(document.activeElement) ? keyOf(document.activeElement.closest('.adock-tile')) : null;
    const avail = axis === 'x' ? window.innerWidth - 32 : window.innerHeight - mbHeight() - 32;
    size = phone ? PHONE_ICON : fitIcon(view.length, avail);
    const ah = !phone && state.settings.autoHide;
    if (!ah) shown = false;
    nav.className = `adock pos-${pos}${phone ? ' phone' : ''}${ah ? ' ah' : ''}${shown ? ' shown' : ''}`;
    nav.setAttribute('aria-orientation', axis === 'x' ? 'horizontal' : 'vertical');
    nav.style.setProperty('--ad-icon', `${size}px`);
    edge.className = `adock-edge pos-${pos}${ah ? ' on' : ''}`;
    tiles = view.map((entry) => ({ entry, el: entry.type === 'group' ? groupTile(entry) : itemTile(entry.item) }));
    list.replaceChildren(...(tiles.length ? tiles.map((t) => t.el) : [h('span', { class: 'adock-empty' }, 'No applets or rigs yet')]));
    scales = tiles.map(() => 1);
    measureRest();
    // Roving tab stop: one tile is in the Tab order; the arrow keys move between them.
    const keep = tiles.find((t) => keyOf(t.el) === focusedKey) || tiles[0];
    if (keep) keep.el.tabIndex = 0;
    if (focusedKey && keep) keep.el.focus({ preventScroll: true });
    refreshRunning();
    applyReserve();
    if (popGroup) {
      if (!state.groups[popGroup]) closePop();
      else if (document.activeElement?.matches?.('.adock-pop-name') && pop.contains(document.activeElement)) placePop(); // never wipe a name being typed
      else renderPop();
    }
    hideLabel();
  }

  function measureRest() {
    const mb = mbHeight();
    const centre = axisOf(position()) === 'x' ? window.innerWidth / 2 : mb + (window.innerHeight - mb) / 2;
    rest = restCentres(tiles.length, size, centre);
  }

  /** Running dots (an applet with a window open here) — cheap, also polled. */
  function refreshRunning() {
    for (const { el, entry } of tiles) if (entry.type === 'item') el.classList.toggle('open', !!isOpen(entry.item));
  }

  /** Tell the page how much of each edge the dock keeps (styles.css shifts the panels anchored there). */
  let lastReserve = '';
  function applyReserve() {
    const r = reserve(state.settings, { phone, size });
    const key = `${r.left},${r.right},${r.bottom},${phone}`;
    if (key === lastReserve) return; // unchanged: no style write on <html> (others observe it; resizes stay cheap)
    lastReserve = key;
    const root = document.documentElement;
    root.style.setProperty('--ad-l', `${r.left}px`);
    root.style.setProperty('--ad-r', `${r.right}px`);
    root.style.setProperty('--ad-b', `${r.bottom}px`);
    root.style.setProperty('--ad-phone', phone ? `${PHONE_ICON + 2 * PAD + 8}px` : '0px');
    root.classList.toggle('adock-rl', r.left > 0);
    root.classList.toggle('adock-rr', r.right > 0);
    root.classList.toggle('adock-rb', r.bottom > 0);
    root.classList.toggle('adock-phone', phone);
  }

  // ------------------------------------------------------------------ open
  function launch(el, it) {
    if (!canOpen(it)) return; // a pinned panel that was closed can be shown again; windows and terminals cannot
    if (!reduced) { el.classList.remove('launch'); void el.offsetWidth; el.classList.add('launch'); setTimeout(() => el.classList.remove('launch'), 750); }
    open(it);
    setTimeout(refreshRunning, 300);
  }

  function consumeClick(e) {
    if (!suppressClick) return false;
    suppressClick = false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  // ------------------------------------------------------------------ magnification
  function kick() { if (!raf) { last = 0; raf = requestAnimationFrame(frame); } }

  function frame(now) {
    raf = 0;
    const dt = last ? now - last : 16;
    last = now;
    const target = magnifyOn() && cursor != null
      ? magnifyScales(rest, cursor, state.settings, RADIUS * (size / ICON))
      : tiles.map(() => 1);
    const [next, settled] = easeScales(scales, target, dt);
    scales = next;
    tiles.forEach((t, i) => t.el.style.setProperty('--s', scales[i].toFixed(4)));
    if (hover) placeLabel(hover);
    if (!settled) raf = requestAnimationFrame(frame);
  }

  nav.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' || drag) return;
    cursor = axisOf(position()) === 'x' ? e.clientX : e.clientY;
    kick();
  });
  nav.addEventListener('pointerleave', () => { cursor = null; kick(); hideLabel(); scheduleHide(); });
  nav.addEventListener('pointerenter', () => reveal());
  nav.addEventListener('pointerover', (e) => {
    if (drag || e.pointerType === 'touch') return;
    const t = e.target.closest?.('.adock-tile');
    if (t) showLabel(t);
  });

  // ------------------------------------------------------------------ label (tooltip)
  function showLabel(el) {
    if (phone || drag) return;
    const it = el.dataset.id ? state.items[el.dataset.id] : state.groups[el.dataset.gid];
    if (!it) return;
    hover = el;
    label.textContent = (it.title ?? it.name) + (it.live === false ? ' — offline' : '');
    label.classList.add('show');
    placeLabel(el);
  }
  function placeLabel(el) {
    const r = el.getBoundingClientRect();
    const lw = label.offsetWidth;
    const lh = label.offsetHeight;
    const pos = position();
    let x; let y;
    if (pos === 'bottom') { x = r.left + r.width / 2 - lw / 2; y = r.top - lh - 10; }
    else if (pos === 'left') { x = r.right + 12; y = r.top + r.height / 2 - lh / 2; }
    else { x = r.left - lw - 12; y = r.top + r.height / 2 - lh / 2; }
    label.style.transform = `translate(${Math.round(Math.max(4, Math.min(window.innerWidth - lw - 4, x)))}px, ${Math.round(Math.max(4, y))}px)`;
  }
  function hideLabel() { hover = null; label.classList.remove('show'); }

  // ------------------------------------------------------------------ auto-hide
  function reveal() {
    clearTimeout(hideTimer);
    if (shown || !state.settings.autoHide || phone) return;
    shown = true;
    nav.classList.add('shown');
  }
  function scheduleHide() {
    clearTimeout(hideTimer);
    if (!state.settings.autoHide || phone) return;
    hideTimer = setTimeout(() => {
      if (drag || popGroup || nav.contains(document.activeElement) || nav.matches(':hover') || contextMenuOpen()) { scheduleHide(); return; }
      shown = false;
      nav.classList.remove('shown');
    }, HIDE_DELAY);
  }
  edge.addEventListener('pointerenter', reveal);
  edge.addEventListener('pointerleave', scheduleHide); // revealed from the edge but the pointer never reached the shelf
  nav.addEventListener('focusin', reveal);
  nav.addEventListener('focusout', (e) => { if (!nav.contains(e.relatedTarget)) { hideLabel(); setTimeout(scheduleHide, 0); } });

  // ------------------------------------------------------------------ keyboard: roving focus
  nav.addEventListener('keydown', (e) => {
    const cur = e.target.closest?.('.adock-tile');
    if (!cur) return;
    const els = tiles.map((t) => t.el);
    const i = els.indexOf(cur);
    const keys = nav.getAttribute('aria-orientation') === 'horizontal' ? { ArrowLeft: -1, ArrowRight: 1 } : { ArrowUp: -1, ArrowDown: 1 };
    let j = null;
    if (e.key in keys) j = Math.max(0, Math.min(els.length - 1, i + keys[e.key]));
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = els.length - 1;
    else if (e.key === 'Escape' && popGroup) { e.preventDefault(); closePop({ focusTile: true }); return; }
    if (j == null) return;
    e.preventDefault();
    for (const el of els) el.tabIndex = -1;
    els[j].tabIndex = 0;
    els[j].focus();
    showLabel(els[j]);
  });

  // ------------------------------------------------------------------ group popover
  function openPop(gid) {
    popGroup = gid;
    cursor = null;
    kick();
    hideLabel();
    pop.hidden = false;
    renderPop();
    requestAnimationFrame(() => pop.classList.add('show'));
    for (const t of tiles) if (t.entry.type === 'group') t.el.setAttribute('aria-expanded', String(t.entry.group.id === gid));
    setTimeout(() => pop.querySelector('.adock-pop-tile')?.focus({ preventScroll: true }), 0);
  }

  function closePop({ focusTile = false } = {}) {
    if (!popGroup) return;
    const gid = popGroup;
    popGroup = null;
    pop.classList.remove('show');
    pop.hidden = true;
    for (const t of tiles) if (t.entry.type === 'group') t.el.setAttribute('aria-expanded', 'false');
    if (focusTile) list.querySelector(`[data-gid="${CSS.escape(gid)}"]`)?.focus();
    scheduleHide();
  }

  function renderPop({ editName = false } = {}) {
    const g = state.groups[popGroup];
    if (!g) return;
    const items = g.items.map((id) => state.items[id]).filter((it) => it && !it.hidden);
    const name = h('input', { class: 'adock-pop-name', value: g.name, 'aria-label': 'Group name', maxlength: '40', spellcheck: 'false', autocomplete: 'off' });
    const commit = () => { const v = name.value.trim(); if (v && v !== state.groups[g.id]?.name) act((s) => rename(s, g.id, v)); };
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); name.blur(); }
      if (e.key === 'Escape') { e.stopPropagation(); name.value = state.groups[g.id]?.name || ''; name.blur(); }
    });
    name.addEventListener('change', commit);
    const grid = h('div', { class: 'adock-pop-grid', role: 'group', 'aria-label': g.name, style: { '--cols': String(Math.max(1, Math.min(4, items.length))) } });
    for (const it of items) {
      const hit = h('span', { class: 'adock-hit' }, iconFor(it), h('span', { class: 'adock-pop-label' }, it.title));
      const el = tagItem(h('button', { class: `adock-pop-tile k-${it.kind}${it.live ? '' : ' off'}`, type: 'button', 'data-id': it.id, 'aria-label': `${it.title}${it.live ? '' : ' (offline)'}` }, hit), it);
      el.addEventListener('click', (e) => { if (consumeClick(e) || !canOpen(it)) return; closePop(); open(it); setTimeout(refreshRunning, 300); });
      grid.append(el);
    }
    if (!items.length) grid.append(h('span', { class: 'adock-empty' }, 'Empty group — drag items here, or Ungroup it from its menu'));
    pop.setAttribute('aria-label', `${g.name} group`);
    pop.replaceChildren(h('div', { class: 'adock-pop-head' }, name), grid);
    placePop();
    if (editName) setTimeout(() => { name.focus(); name.select(); }, 0);
  }

  function placePop() {
    const anchor = list.querySelector(`[data-gid="${CSS.escape(popGroup)}"]`);
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const pos = position();
    pop.dataset.pos = pos;
    pop.classList.toggle('phone', phone);
    if (phone) { pop.style.transform = ''; return; } // CSS makes it a sheet above the bar
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    let x; let y;
    if (pos === 'bottom') { x = r.left + r.width / 2 - pw / 2; y = r.top - ph - 14; }
    else if (pos === 'left') { x = r.right + 14; y = r.top + r.height / 2 - ph / 2; }
    else { x = r.left - pw - 14; y = r.top + r.height / 2 - ph / 2; }
    x = Math.max(8, Math.min(window.innerWidth - pw - 8, x));
    y = Math.max(mbHeight() + 8, Math.min(window.innerHeight - ph - 8, y));
    pop.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    // The arrow points at the group tile.
    pop.style.setProperty('--arrow', pos === 'bottom' ? `${Math.round(r.left + r.width / 2 - x)}px` : `${Math.round(r.top + r.height / 2 - y)}px`);
  }

  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closePop({ focusTile: true }); return; }
    const t = e.target.closest?.('.adock-pop-tile');
    if (!t || !/^Arrow/.test(e.key)) return;
    const els = [...pop.querySelectorAll('.adock-pop-tile')];
    const cols = Math.max(1, Math.round(pop.querySelector('.adock-pop-grid').offsetWidth / (t.offsetWidth || 1)));
    const j = els.indexOf(t) + { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[e.key];
    if (els[j]) { e.preventDefault(); els[j].focus(); }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!popGroup || drag) return;
    if (pop.contains(e.target) || e.target.closest?.('.adock-group') || e.target.closest?.('.mb-menu')) return;
    closePop();
  }, true);

  // ------------------------------------------------------------------ drag: reorder, group, take out of a group
  function startPress(e) {
    if (e.button !== 0 || phone) return; // phones reorder and group from the long-press menu (a drag would fight the bar's scroll)
    const el = e.target.closest?.('.adock-tile, .adock-pop-tile');
    if (!el || e.target.closest('input')) return;
    const fromPop = el.classList.contains('adock-pop-tile');
    const dragged = el.dataset.gid ? { type: 'group', id: el.dataset.gid, group: null } : { type: 'item', id: el.dataset.id, group: fromPop ? popGroup : null };
    const press = { x: e.clientX, y: e.clientY, el, dragged, id: e.pointerId };
    const move = (ev) => {
      if (ev.pointerId !== press.id) return;
      if (!drag) {
        if (Math.hypot(ev.clientX - press.x, ev.clientY - press.y) < DRAG_START) return;
        beginDrag(press);
      }
      dragMove(ev);
    };
    const up = (ev) => { if (ev.pointerId !== press.id) return; cleanup(); if (drag) endDrag(ev.type === 'pointerup'); };
    const key = (ev) => { if (ev.key === 'Escape' && drag) { ev.preventDefault(); ev.stopPropagation(); cleanup(); endDrag(false); } };
    const cleanup = () => {
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', up, true);
      document.removeEventListener('keydown', key, true);
    };
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
    document.addEventListener('keydown', key, true);
  }
  nav.addEventListener('pointerdown', startPress);
  pop.addEventListener('pointerdown', startPress);

  function beginDrag(press) {
    const r = press.el.getBoundingClientRect();
    const ghost = press.el.cloneNode(true);
    ghost.classList.add('adock-ghost');
    for (const x of [ghost, ...ghost.querySelectorAll('[data-ctx]')]) delete x.dataset.ctx;
    Object.assign(ghost.style, { width: `${r.width}px`, height: `${r.height}px` });
    ghost.setAttribute('aria-hidden', 'true');
    document.body.append(ghost);
    press.el.classList.add('dragging');
    drag = { ...press, ghost, dx: press.x - r.left, dy: press.y - r.top, drop: null };
    cursor = null;
    scales = tiles.map(() => 1);
    tiles.forEach((t) => t.el.style.setProperty('--s', '1'));
    hideLabel();
    document.documentElement.classList.add('adock-dragging');
  }

  function clearMarks() {
    for (const t of tiles) t.el.classList.remove('drop-onto');
    caret.classList.remove('show');
    pop.querySelector('.drop-before')?.classList.remove('drop-before');
  }

  function dragMove(ev) {
    const d = drag;
    d.ghost.style.transform = `translate(${ev.clientX - d.dx}px, ${ev.clientY - d.dy}px)`;
    clearMarks();
    d.drop = null;
    // Over the open popover: move into that group, before the tile under the pointer.
    if (popGroup && !pop.hidden && d.dragged.type === 'item' && inside(pop.getBoundingClientRect(), ev.clientX, ev.clientY)) {
      const els = [...pop.querySelectorAll('.adock-pop-tile')].filter((x) => x !== d.el);
      let index = els.length;
      for (let i = 0; i < els.length; i++) {
        const r = els[i].getBoundingClientRect();
        if (ev.clientY < r.bottom && (ev.clientY < r.top || ev.clientX < r.left + r.width / 2)) { index = i; break; }
      }
      els[index]?.classList.add('drop-before');
      d.drop = { kind: 'group', group: popGroup, index };
      return;
    }
    const pos = position();
    const axis = axisOf(pos);
    const shelf = list.getBoundingClientRect();
    const across = pos === 'bottom' ? shelf.top - ev.clientY : pos === 'left' ? ev.clientX - shelf.right : shelf.left - ev.clientX;
    if (across > BAND) return; // too far from the dock: dropping here does nothing
    const slots = tiles.map((t) => {
      const r = t.el.getBoundingClientRect();
      return { type: t.entry.type, id: t.entry.type === 'group' ? t.entry.group.id : t.entry.item.id, start: axis === 'x' ? r.left : r.top, end: axis === 'x' ? r.right : r.bottom };
    });
    const at = dropAt(slots, axis === 'x' ? ev.clientX : ev.clientY, d.dragged);
    d.drop = at;
    if (at.kind === 'onto') tiles[at.index].el.classList.add('drop-onto');
    else showCaret(slots, at.index, axis, shelf);
  }

  function showCaret(slots, index, axis, shelf) {
    const prev = slots[index - 1];
    const next = slots[index];
    const p = next && prev ? (prev.end + next.start) / 2 : next ? next.start - 3 : prev ? prev.end + 3 : (axis === 'x' ? shelf.left : shelf.top) + PAD;
    caret.dataset.axis = axis;
    caret.style.transform = axis === 'x' ? `translate(${Math.round(p - 1.5)}px, ${Math.round(shelf.top + 6)}px)` : `translate(${Math.round(shelf.left + 6)}px, ${Math.round(p - 1.5)}px)`;
    caret.style.setProperty('--len', `${Math.round((axis === 'x' ? shelf.height : shelf.width) - 12)}px`);
    caret.classList.add('show');
  }

  function endDrag(commit) {
    const d = drag;
    drag = null;
    d.ghost.remove();
    d.el.classList.remove('dragging');
    clearMarks();
    document.documentElement.classList.remove('adock-dragging');
    suppressClick = true; // the click after this pointerup ends the drag; it is not a launch
    setTimeout(() => { suppressClick = false; }, 0);
    const before = state;
    if (commit && d.drop) act((s) => applyDrop(s, d.dragged, d.drop, dockView(s)));
    if (state === before) render(); // nothing changed: still put the tiles back
    scheduleHide();
  }

  // ------------------------------------------------------------------ environment changes
  // A resize only rebuilds the tiles when the icon size or the phone layout changes; otherwise it re-measures.
  function relayout() {
    const axis = axisOf(isPhone() ? 'bottom' : state.settings.position);
    const avail = axis === 'x' ? window.innerWidth - 32 : window.innerHeight - mbHeight() - 32;
    const want = isPhone() ? PHONE_ICON : fitIcon(dockView(state).length, avail);
    if (isPhone() !== phone || want !== size) { render(); return; }
    measureRest();
    if (popGroup) placePop();
  }
  let resizeRaf = 0;
  window.addEventListener('resize', () => { cancelAnimationFrame(resizeRaf); resizeRaf = requestAnimationFrame(relayout); });
  window.matchMedia?.(PHONE_QUERY)?.addEventListener?.('change', render);
  window.matchMedia?.('(prefers-reduced-motion: reduce)')?.addEventListener?.('change', () => { reduced = prefersReducedMotion(); render(); });
  // The menu bar showing/hiding moves a side dock's centre (menubar.js sets --mb-h on <html>).
  new MutationObserver(() => { measureRest(); if (popGroup) placePop(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  setInterval(() => { if (!document.hidden) refreshRunning(); }, 2000);
  window.addEventListener('storage', (e) => { if (e.key === STORAGE_KEY) { state = load(); render(); } }); // another tab changed the dock

  render();

  const dock = {
    get state() { return state; },
    act,
    sync,
    render,
    open: (it) => open(it),
    openGroup: (gid) => { reveal(); openPop(gid); },
    rename: (gid) => { reveal(); if (popGroup !== gid) openPop(gid); renderPop({ editName: true }); },
    phone: () => phone,
    reducedMotion: () => reduced,
    el: nav,
  };
  globalThis.__rigsAppDock = dock; // read by scripts/app-dock-check.js
  return dock;
}

/** The dock's right-click / long-press menus, through the shared context-menu registry (ctx-providers.js). */
export function registerAppDockProviders(reg, dock) {
  const opts = () => ({ phone: dock.phone(), reducedMotion: dock.reducedMotion() });
  const settings = () => ({ label: 'Dock settings', icon: '⚙', submenu: () => settingsEntries(dock.state, dock.act, opts()) });
  reg.register('dockitem', (t) => [...itemEntries(dock.state, t.id, dock.act, { open: dock.open, phone: dock.phone() }), { sep: true }, settings()], { title: 'Dock' });
  reg.register('dockgroup', (t) => [...groupEntries(dock.state, t.id, dock.act, { openGroup: dock.openGroup, rename: dock.rename, phone: dock.phone() }), { sep: true }, settings()], { title: 'Group' });
  reg.register('appdock', () => settingsEntries(dock.state, dock.act, opts()), { title: 'Dock' });
  return reg;
}
