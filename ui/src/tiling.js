import { isPhone } from './mobile.js';
import { reducedMotion } from './scaling.js';
import { dockArea, setFloatingRect, setWindowSnap } from './docking.js';
import { QUARTERS, ZONES, fitRect, restoreRect, zoneAt, zoneLabel, zoneRect } from './tiling-model.js';

// Window tiling (macOS Sequoia style) for wm.js floating windows: drag a window to a screen edge or corner and a
// preview shows where it goes; let go and it glides into that half or quarter (the top edge's centre fills the
// screen). Dragging a tiled window away gives it its old size back. Keyboard and the Window › Tile menu run the
// same tileWindow / untile (jarvis-commands.js). The geometry is pure (tiling-model.js); this module keeps each
// window's tile state and draws it. Self-contained on purpose: a desktop mode only needs tileWindow(win, zone) and
// untile(win). Phones keep full-screen windows and never tile.
//
// State per window element: { zone, rect (where the zone put it), prev (its rect before tiling) }. Windows never
// outlive the page, so nothing is persisted; a tiled window re-fits to its zone when the viewport, the top menu bar
// or the app dock change (docking.js render() calls refit()).

const ANIM_MS = 220; // matches .win.tile-anim in styles.css
const state = new WeakMap(); // window element → { zone, rect, prev }
const tiled = new Set(); // the same elements, to walk on refit

const winEl = (w) => {
  if (!w) return null;
  if (w.nodeType === 1) return w.closest?.('.win') || null;
  if (w.el?.nodeType === 1) return w.el;
  return document.querySelector(`.win[data-win-id="${CSS.escape(String(w))}"]`);
};
const rectOf = (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };
const same = (a, b) => !!a && !!b && ['x', 'y', 'w', 'h'].every((k) => Math.abs(a[k] - b[k]) < 0.5);

/** Can this window tile right now? Not on phones, not while docked into the docking layout, not once closing. */
export function canTile(win) {
  const el = winEl(win);
  return !!el && el.isConnected && !isPhone() && !el.classList.contains('docked') && !el.classList.contains('win-leave') && !el.classList.contains('min'); // a minimized window is off the stage
}

/** The window keyboard tiling acts on: the one holding focus, else the frontmost floating window. */
export function activeWindow() {
  const focused = document.activeElement?.closest?.('.win');
  if (focused && canTile(focused)) return focused;
  return [...document.querySelectorAll('.win[data-win-id]')]
    .filter((el) => canTile(el))
    .sort((a, b) => Number(b.style.zIndex || 0) - Number(a.style.zIndex || 0))[0] || null;
}

/** { zone, rect, prev } of a tiled window, else null. */
export function tileState(win) {
  const el = winEl(win);
  return (el && state.get(el)) || null;
}

function place(el, r, animate) {
  const glide = animate && !reducedMotion();
  clearTimeout(el._tileAnim);
  el.classList.toggle('tile-anim', glide);
  if (el.classList.contains('max')) {
    if (el._wm?.act) el._wm.act('restore'); // wm.js keeps the window's state record (window-state.js) and its buttons in step
    else { el.classList.remove('max'); el.querySelector('.win-btn[aria-pressed]')?.setAttribute('aria-pressed', 'false'); }
  }
  Object.assign(el.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px', right: 'auto', bottom: 'auto', transform: 'none' });
  if (glide) el._tileAnim = setTimeout(() => el.classList.remove('tile-anim'), ANIM_MS + 40);
  setFloatingRect(`win-${el.dataset.winId}`, r); // smart scaling: this is its home now
  el.dispatchEvent(new CustomEvent('winresize'));
}

function forget(el) {
  state.delete(el);
  tiled.delete(el);
  el.classList.remove('tiled');
  delete el.dataset.tile;
}

/**
 * Tile a window into a zone ('left' 'right' 'top' 'bottom' 'top-left' 'top-right' 'bottom-left' 'bottom-right'
 * 'fill'). `win` is the window element, a wm.js handle ({ el }) or its id; `from` = the rect to return to on untile
 * (default: where it is now). Returns false when it cannot tile.
 */
export function tileWindow(win, zone, { animate = true, from = null } = {}) {
  const el = winEl(win);
  if (!canTile(el) || !ZONES.includes(zone)) return false;
  const rect = zoneRect(zone, dockArea());
  const prev = state.get(el)?.prev || from || rectOf(el); // re-tiling keeps the rect from before the first tile
  state.set(el, { zone, rect, prev });
  tiled.add(el);
  el.classList.add('tiled');
  el.dataset.tile = zone;
  place(el, rect, animate);
  el._wm?.raise?.();
  return true;
}

/** Back to the size and place it had before tiling (pulled on screen if the screen shrank). False if not tiled. */
export function untile(win, { animate = true } = {}) {
  const el = winEl(win);
  const s = el && state.get(el);
  if (!s) return false;
  forget(el);
  place(el, fitRect(s.prev, dockArea()), animate);
  return true;
}

/** For menus and shortcuts: tile the active window ('restore' untiles it, or un-maximises it). */
export function tileActive(zone) {
  const el = activeWindow();
  if (!el) return false;
  if (zone !== 'restore') return tileWindow(el, zone);
  if (untile(el)) return true;
  if (el.classList.contains('max')) { el.querySelector('.win-btn[aria-pressed]')?.click(); return true; }
  return false;
}
/** Is there a window keyboard tiling would act on (and, for 'restore', something to restore)? */
export function canTileActive(zone) {
  const el = activeWindow();
  if (!el) return false;
  return zone !== 'restore' || state.has(el) || el.classList.contains('max');
}

// ---------------------------------------------------------------- drag (docking.js)

setWindowSnap({
  /** The tile zone under a dragged window's pointer. With the docking layout on, only the corners tile. */
  zone(it, x, y, docking) {
    if (isPhone() || !it.el.classList.contains('win')) return null;
    const area = dockArea();
    const zone = zoneAt({ x, y }, area, docking ? { only: QUARTERS } : {});
    return zone ? { zone, rect: zoneRect(zone, area), label: zoneLabel(zone) } : null;
  },
  /** A drag starts on a tiled window: its pre-tile size, the grab point kept under the pointer. */
  lift(it, grab, rect) {
    const s = state.get(it.el);
    if (!s) return null;
    clearTimeout(it.el._tileAnim);
    it.el.classList.remove('tile-anim');
    return restoreRect(s.prev, rect, grab);
  },
  /** Let go in a zone: untiling later returns it to where the drag started (a re-tile keeps the first pre-tile rect). */
  drop(it, zone, start) { tileWindow(it.el, zone, { from: start }); },
  /** Moved (or docked) anywhere but a tile zone: a normal window again, where it was let go. */
  moved(it) { if (state.has(it.el)) forget(it.el); },
  /** The usable area changed (resize, menu bar, app dock): tiled windows follow their zone. */
  refit() {
    if (!tiled.size) return;
    const area = dockArea();
    for (const el of [...tiled]) {
      if (!el.isConnected) { forget(el); continue; }
      // Maximised (double-click / ▢) stays maximised; it re-fits on the next change after it is restored.
      if (el.classList.contains('docked') || el.classList.contains('dragging') || el.classList.contains('max')) continue;
      const s = state.get(el);
      const r = zoneRect(s.zone, area);
      if (same(r, s.rect)) continue;
      s.rect = r;
      place(el, r, false);
    }
  },
});

// The window's own corner grip resizes it: after that it is no longer tiled (else it would jump back on a refit).
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest?.('.win.tiled');
  if (!el || e.button !== 0) return;
  const b = el.getBoundingClientRect();
  if (e.clientX < b.right - 18 || e.clientY < b.bottom - 18) return;
  const up = () => {
    window.removeEventListener('pointerup', up, true);
    const a = el.getBoundingClientRect();
    if (Math.abs(a.width - b.width) > 1 || Math.abs(a.height - b.height) > 1) forget(el);
  };
  window.addEventListener('pointerup', up, true);
}, true);
