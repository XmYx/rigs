// Mission Control (ui/src/mission-control-model.js): the previews' grid, the desktops' miniatures, arrow keys, shortcuts
// and the JARVIS requests that open it. Pure module, no DOM; the overlay itself is checked in the browser
// (scripts/mission-control-check.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gridLayout, isMissionControlAsk, miniRects, missionShortcuts, neighbor } from '../ui/src/mission-control-model.js';

const AREA = { x: 24, y: 140, w: 1392, h: 700 };
const EPS = 1e-6;

const overlaps = (a, b) => a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;
const inside = (r, A) => r.x >= A.x - EPS && r.y >= A.y - EPS && r.x + r.w <= A.x + A.w + EPS && r.y + r.h <= A.y + A.h + EPS;

/** The invariants every layout keeps: one rect per window, inside the area (titles too), no overlaps, aspect kept, scale ≤ 1. */
function sound(wins, out, A = AREA, { label = 24 } = {}) {
  assert.equal(out.length, wins.length);
  out.forEach((r, i) => {
    assert.equal(r.id, wins[i].id, 'results keep the order of the input');
    assert.ok(inside(r, A), `${r.id} is inside the area: ${JSON.stringify(r)}`);
    assert.ok(r.y + r.h + label <= A.y + A.h + EPS, `${r.id}'s title fits under it`);
    assert.ok(r.scale > 0 && r.scale <= 1, `${r.id} is never enlarged`);
    assert.ok(Math.abs(r.w / r.h - wins[i].w / wins[i].h) < 1e-6, `${r.id} keeps its aspect`);
    assert.ok(Math.abs(r.w - wins[i].w * r.scale) < 1e-6 && Math.abs(r.h - wins[i].h * r.scale) < 1e-6, `${r.id} is its window times scale`);
  });
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
    assert.ok(!overlaps(out[i], out[j]), `${out[i].id} and ${out[j].id} do not overlap`);
    // a title band under each preview: the next row starts below it
    if (out[j].row !== out[i].row) assert.ok(!overlaps({ ...out[i], h: out[i].h + label }, out[j]) && !overlaps({ ...out[j], h: out[j].h + label }, out[i]), 'titles do not run into the next row');
  }
  assert.deepEqual([...out.map((r) => r.order)].sort((a, b) => a - b), out.map((_, i) => i), 'order numbers every preview once');
}

test('no windows: nothing to place', () => {
  assert.deepEqual(gridLayout([], AREA), []);
  assert.deepEqual(gridLayout(null, AREA), []);
});

test('one small window: its own size (never enlarged), centred in the area', () => {
  const wins = [{ id: 'a', x: 50, y: 60, w: 400, h: 300 }];
  const [r] = gridLayout(wins, AREA, { label: 24 });
  sound(wins, [r]);
  assert.equal(r.scale, 1);
  assert.ok(Math.abs(r.x + r.w / 2 - (AREA.x + AREA.w / 2)) < 1e-6, 'centred across');
  assert.ok(Math.abs(r.y + (r.h + 24) / 2 - (AREA.y + AREA.h / 2)) < 1e-6, 'centred down, with its title');
});

test('one maximized window is scaled down to fit, aspect kept', () => {
  const wins = [{ id: 'max', x: 8, y: 8, w: 1424, h: 884 }];
  const out = gridLayout(wins, AREA);
  sound(wins, out);
  assert.ok(out[0].scale < 1);
});

test('two side-by-side windows stay side by side, left one left', () => {
  const wins = [{ id: 'right', x: 720, y: 30, w: 700, h: 840 }, { id: 'left', x: 0, y: 30, w: 700, h: 840 }];
  const out = gridLayout(wins, AREA);
  sound(wins, out);
  const [r, l] = out;
  assert.equal(r.row, l.row, 'one row');
  assert.ok(l.x + l.w <= r.x, 'the left window stays left');
  assert.equal(l.order, 0);
});

test('stacked windows that overlap on screen are pulled apart', () => {
  const wins = Array.from({ length: 4 }, (_, i) => ({ id: `w${i}`, x: 300 + i * 28, y: 200 + i * 28, w: 760, h: 480 }));
  sound(wins, gridLayout(wins, AREA));
});

test('relative order: a window high on screen gets an earlier row than one low on screen', () => {
  const wins = [
    { id: 'low', x: 100, y: 700, w: 900, h: 300 }, { id: 'top', x: 100, y: 10, w: 900, h: 300 }, { id: 'mid', x: 100, y: 360, w: 900, h: 300 },
  ];
  const out = gridLayout(wins, { x: 0, y: 0, w: 1000, h: 1100 });
  sound(wins, out, { x: 0, y: 0, w: 1000, h: 1100 });
  const by = Object.fromEntries(out.map((r) => [r.id, r]));
  assert.ok(by.top.row < by.mid.row && by.mid.row < by.low.row, JSON.stringify(out.map((r) => [r.id, r.row])));
  assert.ok(by.top.order < by.mid.order && by.mid.order < by.low.order);
});

test('many windows of mixed sizes: all inside, none overlapping, same scale for all', () => {
  const wins = Array.from({ length: 23 }, (_, i) => ({ id: `w${i}`, x: (i * 137) % 1100, y: (i * 89) % 600, w: 320 + ((i * 53) % 700), h: 180 + ((i * 71) % 520) }));
  const out = gridLayout(wins, AREA, { gap: 20, label: 24 });
  sound(wins, out);
  assert.equal(new Set(out.map((r) => r.scale)).size, 1, 'one scale keeps the sizes relative');
  assert.ok(new Set(out.map((r) => r.row)).size > 1, 'more than one row');
});

test('the row count that makes previews biggest wins', () => {
  // Six equal windows in a wide area: one row of six would be tiny, six rows too; 2 rows (3 per row) is best here.
  const wins = Array.from({ length: 6 }, (_, i) => ({ id: `w${i}`, x: i * 10, y: i * 10, w: 800, h: 500 }));
  const A = { x: 0, y: 0, w: 1600, h: 800 };
  const out = gridLayout(wins, A, { gap: 20, label: 20 });
  sound(wins, out, A, { label: 20 });
  assert.equal(new Set(out.map((r) => r.row)).size, 2);
});

test('degenerate input: zero-sized windows and a tiny area never give NaN or negative sizes', () => {
  const out = gridLayout([{ id: 'z', x: 0, y: 0, w: 0, h: 0 }, { id: 'q', x: 'x', y: null, w: 400, h: 300 }], { x: 0, y: 0, w: 10, h: 10 });
  for (const r of out) for (const k of ['x', 'y', 'w', 'h', 'scale']) assert.ok(Number.isFinite(r[k]) && r[k] >= 0, `${k} of ${r.id}`);
});

test('miniRects: scaled to the thumbnail and clipped to the screen; off-screen windows dropped', () => {
  const out = miniRects([
    { id: 'a', title: 'A', x: 0, y: 0, w: 720, h: 450 },
    { id: 'b', title: 'B', x: 1200, y: 800, w: 600, h: 400 },
    { id: 'gone', x: 2000, y: 10, w: 100, h: 100 },
  ], { w: 1440, h: 900 }, { w: 160, h: 100 });
  assert.deepEqual(out.map((r) => r.id), ['a', 'b']);
  assert.deepEqual(out[0], { id: 'a', title: 'A', x: 0, y: 0, w: 80, h: 50 });
  assert.ok(Math.abs(out[1].x + out[1].w - 160) < 1e-9 && Math.abs(out[1].y + out[1].h - 100) < 1e-9, 'clipped at the right and bottom');
});

test('neighbor: arrows move to the nearest preview that way, and stay put at an edge', () => {
  // a b c
  // d e
  const R = [
    { x: 0, y: 0, w: 100, h: 80 }, { x: 120, y: 0, w: 100, h: 80 }, { x: 240, y: 0, w: 100, h: 80 },
    { x: 60, y: 120, w: 100, h: 80 }, { x: 180, y: 120, w: 100, h: 80 },
  ];
  assert.equal(neighbor(R, 0, 'right'), 1);
  assert.equal(neighbor(R, 1, 'right'), 2);
  assert.equal(neighbor(R, 2, 'right'), 2, 'nothing further right');
  assert.equal(neighbor(R, 0, 'left'), 0);
  assert.equal(neighbor(R, 0, 'down'), 3);
  assert.equal(neighbor(R, 2, 'down'), 4);
  assert.equal(neighbor(R, 4, 'up'), 1, 'up from e: the one above it more or less straight');
  assert.equal(neighbor(R, 3, 'right'), 4);
  assert.equal(neighbor(R, -1, 'right'), 0, 'no highlight yet: the first preview');
  assert.equal(neighbor([], 0, 'left'), -1);
});

test('shortcuts: Ctrl+↑ and F3; Macs also Ctrl+Shift+↑', () => {
  assert.deepEqual(missionShortcuts(false), ['Ctrl+ArrowUp', 'F3']);
  assert.deepEqual(missionShortcuts(true), ['Ctrl+ArrowUp', 'Ctrl+Shift+ArrowUp', 'F3']);
});

test('JARVIS requests that open Mission Control', () => {
  for (const s of ['show me all my windows', 'Show me all my windows.', 'show all open windows', 'list my windows', 'mission control', 'open Mission Control', 'show my windows and desktops', 'all my windows', 'show windows', 'what windows'.replace('what ', 'show ')]) {
    assert.ok(isMissionControlAsk(s), s);
  }
  for (const s of ['windows', 'show desktops', 'open the desktops panel', 'show me the files on windows-pc', 'show me agents', 'close all windows', 'mission control center plan']) {
    assert.ok(!isMissionControlAsk(s), s);
  }
});
