// Window tiling (ui/src/tiling-model.js): snap-zone detection, zone rects, key chords and untile geometry.
// Pure module, no DOM. The drag / keyboard / menu wiring is checked in the browser (scripts/tiling-check.js).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  CORNER, EDGE, GAP, QUARTERS, TILE_KEYS, ZONES, fitRect, keyToZone, restoreRect, tileShortcuts, usableArea, zoneAt, zoneRect,
} from '../ui/src/tiling-model.js';

const VW = 1440;
const VH = 900;
const MB = 28; // top menu bar height
const plain = usableArea({ vw: VW, vh: VH }); // no menu bar, no app dock
const withBar = usableArea({ vw: VW, vh: VH, top: MB });
const key = (k, mods = {}) => {
  const code = /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : '';
  return { key: k, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods };
};
const ca = { ctrlKey: true, altKey: true };

test('the model is pure: no DOM at import time', () => {
  const src = fs.readFileSync(new URL('../ui/src/tiling-model.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\b(document|window|localStorage|getComputedStyle)\b\./);
  assert.match(src, /from '\.\/commands\.js'/, 'key chords use the one shortcut matcher');
});

test('usableArea: padding, menu bar offset and app-dock insets', () => {
  assert.deepEqual(plain, { x: 8, y: 8, w: VW - 16, h: VH - 16 });
  assert.deepEqual(withBar, { x: 8, y: 8 + MB, w: VW - 16, h: VH - 16 - MB });
  assert.deepEqual(usableArea({ vw: VW, vh: VH, top: MB, insets: { l: 64 } }), { x: 72, y: 36, w: VW - 16 - 64, h: VH - 16 - MB });
  assert.deepEqual(usableArea({ vw: VW, vh: VH, insets: { r: 50, b: 70 } }), { x: 8, y: 8, w: VW - 16 - 50, h: VH - 16 - 70 });
  const tiny = usableArea({ vw: 10, vh: 10, top: 40 });
  assert.ok(tiny.w >= 1 && tiny.h >= 1, 'never a zero or negative area');
});

test('zoneAt: edges are halves, the top-centre fills, dead centre is nothing', () => {
  const a = plain;
  const midY = a.y + a.h / 2;
  const midX = a.x + a.w / 2;
  assert.equal(zoneAt({ x: VW / 2, y: VH / 2 }, a), null, 'dead centre');
  assert.equal(zoneAt({ x: a.x + EDGE + 1, y: midY }, a), null, 'just inside the edge band');
  assert.equal(zoneAt({ x: 2, y: midY }, a), 'left');
  assert.equal(zoneAt({ x: a.x + EDGE - 1, y: midY }, a), 'left');
  assert.equal(zoneAt({ x: VW - 2, y: midY }, a), 'right');
  assert.equal(zoneAt({ x: midX, y: VH - 2 }, a), 'bottom');
  assert.equal(zoneAt({ x: midX, y: 2 }, a), 'fill', 'top edge, centre third = fill (maximise)');
  assert.equal(zoneAt({ x: a.x + a.w / 6, y: 2 }, a), 'top', 'top edge, outer part = top half');
  assert.equal(zoneAt({ x: a.x + a.w - a.w / 6, y: 2 }, a), 'top');
});

test('zoneAt: corners are quarters, and the corner zone is bigger than the edge band', () => {
  const a = plain;
  assert.ok(CORNER > EDGE);
  assert.equal(zoneAt({ x: 2, y: 2 }, a), 'top-left');
  assert.equal(zoneAt({ x: VW - 2, y: 2 }, a), 'top-right');
  assert.equal(zoneAt({ x: 2, y: VH - 2 }, a), 'bottom-left');
  assert.equal(zoneAt({ x: VW - 2, y: VH - 2 }, a), 'bottom-right');
  // On the left edge band but up to CORNER from the top: still the corner, not the left half.
  assert.equal(zoneAt({ x: 4, y: a.y + CORNER - 2 }, a), 'top-left');
  assert.equal(zoneAt({ x: 4, y: a.y + CORNER + 2 }, a), 'left');
  // Along the top edge, within CORNER of the right side: the corner.
  assert.equal(zoneAt({ x: a.x + a.w - CORNER + 2, y: 4 }, a), 'top-right');
  // Inside the corner square but on neither edge band: nothing.
  assert.equal(zoneAt({ x: a.x + EDGE + 4, y: a.y + EDGE + 4 }, a), null);
});

test('zoneAt: the menu bar offset moves the top edge, the app dock moves the side it sits on', () => {
  // Pointer over the menu bar counts as the top edge (it is beyond the usable area).
  assert.equal(zoneAt({ x: VW / 2, y: 10 }, withBar), 'fill');
  assert.equal(zoneAt({ x: VW / 2, y: withBar.y + EDGE - 1 }, withBar), 'fill');
  assert.equal(zoneAt({ x: VW / 2, y: withBar.y + EDGE + 1 }, withBar), null, 'below the band under the bar');
  // Without the bar, the same point is not near the top any more.
  assert.equal(zoneAt({ x: VW / 2, y: 8 + MB + EDGE - 1 }, plain), null);
  // App dock on the left (64px): its strip and the band beside it are the left edge.
  const dockL = usableArea({ vw: VW, vh: VH, top: MB, insets: { l: 64 } });
  assert.equal(zoneAt({ x: 30, y: VH / 2 }, dockL), 'left', 'over the app dock');
  assert.equal(zoneAt({ x: 64 + 8 + EDGE - 1, y: VH / 2 }, dockL), 'left');
  assert.equal(zoneAt({ x: 64 + 8 + EDGE + 1, y: VH / 2 }, dockL), null);
  // App dock along the bottom (70px): the bottom band starts above it.
  const dockB = usableArea({ vw: VW, vh: VH, insets: { b: 70 } });
  assert.equal(zoneAt({ x: VW / 2, y: VH - 70 - 8 - EDGE + 1 }, dockB), 'bottom');
  assert.equal(zoneAt({ x: VW / 2, y: VH - 70 - 8 - EDGE - 1 }, dockB), null);
});

test('zoneAt: `only` limits the zones (docking layout on: corners tile, edges dock)', () => {
  assert.equal(zoneAt({ x: 2, y: VH / 2 }, plain, { only: QUARTERS }), null);
  assert.equal(zoneAt({ x: VW / 2, y: 2 }, plain, { only: QUARTERS }), null);
  assert.equal(zoneAt({ x: 2, y: 2 }, plain, { only: QUARTERS }), 'top-left');
  assert.equal(zoneAt(null, plain), null);
});

test('zoneRect: halves and quarters fill the area with one gap between tiles', () => {
  const a = withBar;
  const L = zoneRect('left', a);
  const R = zoneRect('right', a);
  assert.equal(L.x, a.x);
  assert.equal(L.y, a.y);
  assert.equal(L.h, a.h);
  assert.equal(R.x - (L.x + L.w), GAP, 'gap between left and right');
  assert.equal(R.x + R.w, a.x + a.w, 'right half reaches the right edge');
  const T = zoneRect('top', a);
  const B = zoneRect('bottom', a);
  assert.equal(T.w, a.w);
  assert.equal(B.y - (T.y + T.h), GAP);
  assert.equal(B.y + B.h, a.y + a.h);
  assert.deepEqual(zoneRect('fill', a), a);
  const q = ['top-left', 'top-right', 'bottom-left', 'bottom-right'].map((z) => zoneRect(z, a));
  assert.deepEqual([q[0].x, q[0].y], [L.x, T.y]);
  assert.deepEqual([q[1].x, q[1].y, q[1].w], [R.x, T.y, R.w]);
  assert.deepEqual([q[2].x, q[2].y, q[2].h], [L.x, B.y, B.h]);
  assert.deepEqual([q[3].x + q[3].w, q[3].y + q[3].h], [a.x + a.w, a.y + a.h]);
  // No two quarters overlap; with the gaps they cover the area exactly.
  const area = q.reduce((s, r) => s + r.w * r.h, 0);
  assert.equal(area, (a.w - GAP) * (a.h - GAP));
  for (const z of ZONES) {
    const r = zoneRect(z, a);
    assert.ok([r.x, r.y, r.w, r.h].every(Number.isInteger), `${z}: whole pixels`);
    assert.ok(r.x >= a.x && r.y >= a.y && r.x + r.w <= a.x + a.w && r.y + r.h <= a.y + a.h, `${z}: inside the area`);
  }
  assert.equal(zoneRect('nope', a), null);
});

test('zoneRect: odd sizes still add up exactly', () => {
  const a = { x: 3, y: 5, w: 1001, h: 777 };
  assert.equal(zoneRect('left', a).w + GAP + zoneRect('right', a).w, a.w);
  assert.equal(zoneRect('top', a).h + GAP + zoneRect('bottom', a).h, a.h);
});

test('keyToZone: Ctrl+Alt (Ctrl+Option on a Mac) + arrows, U I J K, Enter/F, Backspace/R', () => {
  for (const mac of [false, true]) {
    assert.equal(keyToZone(key('ArrowLeft', ca), { mac }), 'left');
    assert.equal(keyToZone(key('ArrowRight', ca), { mac }), 'right');
    assert.equal(keyToZone(key('ArrowUp', ca), { mac }), 'top');
    assert.equal(keyToZone(key('ArrowDown', ca), { mac }), 'bottom');
    assert.equal(keyToZone(key('u', ca), { mac }), 'top-left');
    assert.equal(keyToZone(key('i', ca), { mac }), 'top-right');
    assert.equal(keyToZone(key('j', ca), { mac }), 'bottom-left');
    assert.equal(keyToZone(key('k', ca), { mac }), 'bottom-right');
    assert.equal(keyToZone(key('Enter', ca), { mac }), 'fill');
    assert.equal(keyToZone(key('f', ca), { mac }), 'fill');
    assert.equal(keyToZone(key('Backspace', ca), { mac }), 'restore');
    assert.equal(keyToZone(key('r', ca), { mac }), 'restore');
  }
  // Option+U on a Mac types a dead key ("¨"): the physical key still matches.
  assert.equal(keyToZone({ key: '¨', code: 'KeyU', ...ca, metaKey: false, shiftKey: false }, { mac: true }), 'top-left');
});

test('keyToZone: other chords do not tile', () => {
  assert.equal(keyToZone(key('ArrowLeft')), null, 'a bare arrow');
  assert.equal(keyToZone(key('ArrowLeft', { ctrlKey: true })), null, 'Ctrl+← (word jump / Spaces)');
  assert.equal(keyToZone(key('ArrowLeft', { altKey: true })), null);
  assert.equal(keyToZone(key('ArrowLeft', { ...ca, shiftKey: true })), null);
  assert.equal(keyToZone(key('ArrowLeft', { ...ca, metaKey: true }), { mac: true }), null);
  assert.equal(keyToZone(key('u', { ctrlKey: true })), null);
  assert.equal(keyToZone(key('z', ca)), null);
  assert.equal(keyToZone(null), null);
});

test('keyToZone: Globe+Ctrl+arrows (seen as Ctrl+Home/End/PageUp/PageDown) only on a Mac', () => {
  const g = { ctrlKey: true };
  assert.equal(keyToZone(key('Home', g), { mac: true }), 'left');
  assert.equal(keyToZone(key('End', g), { mac: true }), 'right');
  assert.equal(keyToZone(key('PageUp', g), { mac: true }), 'top');
  assert.equal(keyToZone(key('PageDown', g), { mac: true }), 'bottom');
  for (const k of ['Home', 'End', 'PageUp', 'PageDown']) assert.equal(keyToZone(key(k, g), { mac: false }), null, `Ctrl+${k} stays the browser's elsewhere`);
});

test('tile shortcuts: every zone has one, none is bound twice, none clashes with a JARVIS command', () => {
  for (const z of ZONES) assert.ok(tileShortcuts(z).length > 0, z);
  assert.ok(tileShortcuts('restore').length > 0);
  const all = TILE_KEYS.flatMap((r) => [...r.keys, ...(r.mac || [])]).map((s) => s.toLowerCase());
  assert.equal(new Set(all).size, all.length);
  const src = fs.readFileSync(new URL('../ui/src/jarvis-commands.js', import.meta.url), 'utf8');
  const existing = [...src.matchAll(/(?:shortcut|hint): (?:'([^']+)'|\[([^\]]+)\])/g)]
    .flatMap((m) => (m[1] ? [m[1]] : m[2].split(',').map((s) => s.trim().replace(/'/g, '')))).map((s) => s.toLowerCase());
  assert.ok(existing.includes('mod+k'), 'the scan finds the existing shortcuts');
  for (const s of all) assert.ok(!existing.includes(s), `${s} is already a JARVIS shortcut`);
  assert.equal(tileShortcuts('nope').length, 0);
  assert.deepEqual(tileShortcuts('left', true), ['Ctrl+Alt+ArrowLeft', 'Ctrl+Home']);
  assert.deepEqual(tileShortcuts('left', false), ['Ctrl+Alt+ArrowLeft']);
});

test('restoreRect: dragging a tiled window away gives its old size back under the pointer', () => {
  const prev = { w: 600, h: 400 };
  const tile = zoneRect('left', withBar);
  // Grabbed in the middle of the bar: the restored window is centred under the pointer.
  const grab = { x: tile.x + tile.w / 2, y: tile.y + 12 };
  const r = restoreRect(prev, tile, grab);
  assert.equal(r.w, 600);
  assert.equal(r.h, 400);
  assert.equal(r.offX, 300);
  assert.equal(r.offY, 12);
  assert.equal(r.x + r.offX, grab.x);
  assert.equal(r.y + r.offY, grab.y);
  // Grabbed near either end: it stays near that end (never closer than 16px to the edge).
  assert.equal(restoreRect(prev, tile, { x: tile.x + 2, y: tile.y + 10 }).offX, 16);
  assert.equal(restoreRect(prev, tile, { x: tile.x + tile.w - 1, y: tile.y + 10 }).offX, 600 - 16);
  // A press lower in a big tile keeps the pointer in the restored window's top strip.
  assert.ok(restoreRect(prev, tile, { x: tile.x + 50, y: tile.y + 300 }).offY <= 40);
});

test('fitRect: untiling puts the old rect back exactly, pulled on screen only when its title bar is out of reach', () => {
  const prev = { x: 200, y: 120, w: 640, h: 420 };
  assert.deepEqual(fitRect(prev, withBar), prev, 'unchanged when it fits');
  const lowered = { x: 340, y: 436, w: 1100, h: 620 }; // partly below the screen before tiling: it goes back there
  assert.deepEqual(fitRect(lowered, withBar), lowered);
  // Under the menu bar (title bar unreachable): pulled inside.
  assert.deepEqual(fitRect({ x: -50, y: 0, w: 300, h: 200 }, withBar), { x: withBar.x, y: withBar.y, w: 300, h: 200 });
  // The screen shrank so the window's bar is off to the right: pulled wholly inside, no bigger than the area.
  const small = usableArea({ vw: 700, vh: 500, top: MB });
  const r = fitRect({ x: 900, y: 120, w: 800, h: 420 }, small);
  assert.ok(r.x >= small.x && r.y >= small.y && r.x + r.w <= small.x + small.w && r.y + r.h <= small.y + small.h, JSON.stringify(r));
  assert.equal(r.w, small.w);
  // Still grabbable on the smaller screen: left where it was.
  assert.deepEqual(fitRect(prev, small), prev);
});

test('re-fit on resize: a zone keeps its share of the new area', () => {
  const before = zoneRect('right', usableArea({ vw: 1440, vh: 900, top: MB }));
  const after = zoneRect('right', usableArea({ vw: 1000, vh: 700, top: MB }));
  assert.notDeepEqual(before, after);
  assert.equal(after.x + after.w, 1000 - 8);
  assert.equal(after.h, 700 - 16 - MB);
});

test('wiring: docking.js builds dockArea from usableArea and keeps its edge docking; Window › Tile lists every tile command', () => {
  const dock = fs.readFileSync(new URL('../ui/src/docking.js', import.meta.url), 'utf8');
  assert.match(dock, /export function dockArea\(\) \{\s*return usableArea\(/);
  assert.match(dock, /const ROOT_EDGE = 26;/, 'the docking layout edge band is unchanged');
  assert.match(dock, /setWindowSnap/);
  const cmds = fs.readFileSync(new URL('../ui/src/jarvis-commands.js', import.meta.url), 'utf8');
  for (const id of ['tileLeft', 'tileRight', 'tileTop', 'tileBottom', 'tileTopLeft', 'tileTopRight', 'tileBottomLeft', 'tileBottomRight', 'tileFill', 'tileRestore']) {
    assert.match(cmds, new RegExp(`id: 'window\\.${id}'`), `${id} registered`);
    assert.match(cmds, new RegExp(`cmd: 'window\\.${id}'`), `${id} in Window › Tile`);
  }
  assert.match(cmds, /when: \(ctx\) => !ctx\.phone, enabled: \(\) => canTileActive/, 'phones never tile; with no window there is nothing to run');
  const tiling = fs.readFileSync(new URL('../ui/src/tiling.js', import.meta.url), 'utf8');
  assert.match(tiling, /export function tileWindow\(/);
  assert.match(tiling, /export function untile\(/);
});
