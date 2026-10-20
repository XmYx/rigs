// Window tiling, the pure part (macOS Sequoia style): which snap zone a dragged pointer is in, the rect of each
// zone, the key chords that tile, and the geometry of untiling. No DOM: tiling.js draws it, docking.js drags it,
// test/tiling.test.js checks it in Node.
//
// Every rect here is { x, y, w, h } in screen px. `area` is the usable area: the screen below the top menu bar and
// clear of the app dock, already inset by the docking margin (docking.js dockArea(), built by usableArea() below).

import { matchShortcut } from './commands.js';

/** The zones a window can tile into. 'fill' = the whole usable area (macOS "Fill"). */
export const ZONES = ['left', 'right', 'top', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'fill'];
export const QUARTERS = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right']);

export const EDGE = 18; // pointer this close to (or beyond) an edge of the usable area = that half
export const CORNER = 56; // corner hit-zone: a square this big at each corner (bigger than the edge band, so corners are easy to hit)
export const GAP = 8; // space between two tiles (the outer margin is the usable area's own padding)

const ZONE_LABELS = {
  left: 'Left half', right: 'Right half', top: 'Top half', bottom: 'Bottom half',
  'top-left': 'Top-left quarter', 'top-right': 'Top-right quarter', 'bottom-left': 'Bottom-left quarter', 'bottom-right': 'Bottom-right quarter',
  fill: 'Fill', restore: 'Return to previous size',
};
export const zoneLabel = (zone) => ZONE_LABELS[zone] || zone;

/**
 * The usable area: the viewport minus `pad` on every side, below the top menu bar (`top` = its height) and clear of
 * the app dock's edges (`insets` = { l, r, b } it keeps on screen). docking.js dockArea() is this with live values.
 */
export function usableArea({ vw, vh, top = 0, insets = {}, pad = 8 }) {
  const l = insets.l || 0;
  const r = insets.r || 0;
  const b = insets.b || 0;
  return { x: pad + l, y: pad + top, w: Math.max(1, vw - 2 * pad - l - r), h: Math.max(1, vh - 2 * pad - top - b) };
}

/**
 * The snap zone under the pointer, or null (anywhere away from the edges, including dead centre).
 * Corners first (a CORNER square at each corner, reached from either edge band), then the edge bands. The top
 * edge's middle third is 'fill' (the macOS "drag to the top" maximise); the rest of the top edge is the top half.
 * The pointer may be beyond the area (over the menu bar or the app dock): that still counts as that edge.
 *   opts.only  a Set of zones to consider (docking.js passes QUARTERS while the docking layout owns the edges)
 */
export function zoneAt(pt, area, { edge = EDGE, corner = CORNER, only = null } = {}) {
  if (!pt || !area) return null;
  const { x, y } = pt;
  const left = x < area.x + edge;
  const right = x > area.x + area.w - edge;
  const top = y < area.y + edge;
  const bottom = y > area.y + area.h - edge;
  const nearL = x < area.x + corner;
  const nearR = x > area.x + area.w - corner;
  const nearT = y < area.y + corner;
  const nearB = y > area.y + area.h - corner;
  let zone = null;
  if (nearT && nearL && (top || left)) zone = 'top-left';
  else if (nearT && nearR && (top || right)) zone = 'top-right';
  else if (nearB && nearL && (bottom || left)) zone = 'bottom-left';
  else if (nearB && nearR && (bottom || right)) zone = 'bottom-right';
  else if (left) zone = 'left';
  else if (right) zone = 'right';
  else if (top) zone = Math.abs(x - (area.x + area.w / 2)) <= area.w / 6 ? 'fill' : 'top';
  else if (bottom) zone = 'bottom';
  if (zone && only && !only.has(zone)) return null;
  return zone;
}

/** The rect a window takes in a zone: halves and quarters split the area with `gap` between them. */
export function zoneRect(zone, area, gap = GAP) {
  const a = area;
  const lw = Math.floor((a.w - gap) / 2);
  const th = Math.floor((a.h - gap) / 2);
  const L = { x: a.x, w: lw };
  const R = { x: a.x + lw + gap, w: a.w - gap - lw };
  const T = { y: a.y, h: th };
  const B = { y: a.y + th + gap, h: a.h - gap - th };
  const FW = { x: a.x, w: a.w };
  const FH = { y: a.y, h: a.h };
  const pick = {
    left: [L, FH], right: [R, FH], top: [FW, T], bottom: [FW, B],
    'top-left': [L, T], 'top-right': [R, T], 'bottom-left': [L, B], 'bottom-right': [R, B],
    fill: [FW, FH],
  }[zone];
  if (!pick) return null;
  const [hz, vt] = pick;
  return { x: hz.x, y: vt.y, w: hz.w, h: vt.h };
}

// ---------------------------------------------------------------- keys

// Ctrl+Option on a Mac, Ctrl+Alt elsewhere ("Ctrl" is the Control key on both). U I / J K are the four quarters as
// they sit on the keyboard. The macOS Globe+Ctrl+arrows reach a browser as Ctrl+Home/End/PageUp/PageDown (Globe
// turns the arrows into those keys) and only when macOS itself does not take them (System Settings › Desktop &
// Dock › tiling shortcuts off), so they are an extra on Macs only: elsewhere Ctrl+Home/End/PageUp/PageDown belong
// to the browser (page ends, tab switching).
export const TILE_KEYS = [
  { zone: 'left', keys: ['Ctrl+Alt+ArrowLeft'], mac: ['Ctrl+Home'] },
  { zone: 'right', keys: ['Ctrl+Alt+ArrowRight'], mac: ['Ctrl+End'] },
  { zone: 'top', keys: ['Ctrl+Alt+ArrowUp'], mac: ['Ctrl+PageUp'] },
  { zone: 'bottom', keys: ['Ctrl+Alt+ArrowDown'], mac: ['Ctrl+PageDown'] },
  { zone: 'top-left', keys: ['Ctrl+Alt+U'] },
  { zone: 'top-right', keys: ['Ctrl+Alt+I'] },
  { zone: 'bottom-left', keys: ['Ctrl+Alt+J'] },
  { zone: 'bottom-right', keys: ['Ctrl+Alt+K'] },
  { zone: 'fill', keys: ['Ctrl+Alt+Enter', 'Ctrl+Alt+F'] },
  { zone: 'restore', keys: ['Ctrl+Alt+Backspace', 'Ctrl+Alt+R'] },
];

/** The shortcuts for a zone (or 'restore') on this platform, the one shown in menus first. */
export function tileShortcuts(zone, mac = false) {
  const row = TILE_KEYS.find((r) => r.zone === zone);
  if (!row) return [];
  return [...row.keys, ...(mac && row.mac ? row.mac : [])];
}

/** The zone (or 'restore') a keydown asks for, else null. The same matching as every other JARVIS shortcut. */
export function keyToZone(ev, { mac = false } = {}) {
  if (!ev) return null;
  for (const row of TILE_KEYS) if (tileShortcuts(row.zone, mac).some((s) => matchShortcut(s, ev, { mac }))) return row.zone;
  return null;
}

// ---------------------------------------------------------------- untiling

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Dragging a tiled window away: it gets its pre-tile size back and the point it was grabbed by stays under the
 * pointer (horizontally at the same fraction of the width, vertically at the same depth in the title bar).
 *   prev = { w, h } before tiling; tile = its tiled rect; grab = { x, y } where the press was
 * Returns { x, y, w, h, offX, offY } (offX/offY = the grab point inside the restored window).
 */
export function restoreRect(prev, tile, grab) {
  const { w, h } = prev;
  const m = Math.min(16, w / 2);
  const offX = clamp(Math.round(((grab.x - tile.x) / (tile.w || 1)) * w), m, w - m);
  const offY = clamp(Math.round(grab.y - tile.y), 0, Math.min(40, h));
  return { x: grab.x - offX, y: grab.y - offY, w, h, offX, offY };
}

export const BAR_KEEP = 120; // px of the title bar that must stay on screen (as wm.js clamps a free move)

/**
 * Untiling from the keyboard or menu: back to exactly the pre-tile rect (as macOS does), no bigger than the area.
 * Only when its title bar could no longer be grabbed there (the screen shrank, the menu bar or app dock moved in)
 * is it pulled wholly inside the area.
 */
export function fitRect(r, area) {
  const w = Math.min(r.w, area.w);
  const h = Math.min(r.h, area.h);
  const barOk = r.y >= area.y && r.y <= area.y + area.h - 40 && r.x + w >= area.x + BAR_KEEP && r.x <= area.x + area.w - BAR_KEEP;
  if (barOk) return { x: r.x, y: r.y, w, h };
  return { x: clamp(r.x, area.x, area.x + area.w - w), y: clamp(r.y, area.y, area.y + area.h - h), w, h };
}
