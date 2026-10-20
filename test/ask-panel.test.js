// Ask JARVIS as its own panel: the placement model (ask-panel-model.js) — mode transitions, the persisted shape,
// migration from no stored value, the phone override, invalid stored values — and the ↑/↓ input history.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ASK_KEY, ASK_MODES, DEFAULT_ASK, askHost, askPlacement, cleanRect, panelWanted, pushHistory, recallHistory, restoreAskPlacement, serializeAsk,
} from '../ui/src/ask-panel-model.js';

const R = { x: 120, y: 340, w: 640, h: 80 };

// ------------------------------------------------------------------ restore / persist

test('no stored value (first run, or an install from before the panel): docked in the top bar', () => {
  assert.equal(ASK_KEY, 'rigs.askPanel');
  for (const raw of [null, undefined, '']) assert.deepEqual(restoreAskPlacement(raw), { mode: 'topbar', rect: null, last: 'topbar' });
  assert.equal(DEFAULT_ASK.mode, 'topbar');
  assert.throws(() => { DEFAULT_ASK.mode = 'floating'; }, 'the default is frozen');
});

test('invalid stored values fall back field by field instead of breaking the page', () => {
  assert.deepEqual(restoreAskPlacement('{not json'), DEFAULT_ASK);
  assert.deepEqual(restoreAskPlacement('[1,2]'), DEFAULT_ASK);
  assert.deepEqual(restoreAskPlacement('"topbar"'), DEFAULT_ASK);
  assert.deepEqual(restoreAskPlacement(42), DEFAULT_ASK);
  assert.deepEqual(restoreAskPlacement({ mode: 'sideways' }), DEFAULT_ASK, 'unknown mode');
  assert.deepEqual(restoreAskPlacement({ mode: 'floating', rect: { x: 'a', y: 2 } }), { mode: 'floating', rect: null, last: 'floating' }, 'bad rect dropped, mode kept');
  assert.deepEqual(restoreAskPlacement({ mode: 'hidden', last: 'hidden' }), { mode: 'hidden', rect: null, last: 'topbar' }, 'last is always a visible mode');
  assert.deepEqual(restoreAskPlacement({ mode: 'floating', rect: { x: 1, y: 2, w: -5, h: Infinity } }), { mode: 'floating', rect: { x: 1, y: 2, w: null, h: null }, last: 'floating' }, 'sizes must be positive and finite');
  assert.equal(cleanRect({ x: NaN, y: 0 }), null);
  assert.equal(cleanRect(null), null);
});

test('the persisted shape round-trips through localStorage', () => {
  for (const s of [
    { mode: 'topbar', rect: null, last: 'topbar' },
    { mode: 'floating', rect: R, last: 'floating' },
    { mode: 'docked', rect: R, last: 'docked' },
    { mode: 'hidden', rect: R, last: 'docked' },
  ]) {
    const raw = serializeAsk(s);
    assert.deepEqual(Object.keys(JSON.parse(raw)), ['mode', 'rect', 'last']);
    assert.deepEqual(restoreAskPlacement(raw), s);
  }
  assert.deepEqual(ASK_MODES, ['topbar', 'floating', 'docked', 'hidden']);
});

// ------------------------------------------------------------------ transitions

test('top bar ⇄ floating: docking remembers the floating rect, ⏏ goes back to it', () => {
  let s = { mode: 'floating', rect: null, last: 'floating' };
  s = askPlacement(s, { type: 'topbar', rect: R });
  assert.deepEqual(s, { mode: 'topbar', rect: R, last: 'topbar' });
  s = askPlacement(s, { type: 'float' });
  assert.deepEqual(s, { mode: 'floating', rect: R, last: 'floating' }, 'last floating rect');
  // From docked into the top bar there is no new rect: the old one stays.
  s = askPlacement({ mode: 'docked', rect: R, last: 'docked' }, { type: 'topbar', rect: null });
  assert.deepEqual(s.rect, R);
  const same = { mode: 'topbar', rect: R, last: 'topbar' };
  assert.equal(askPlacement(same, { type: 'topbar' }), same, 'no change → same object (nothing to save)');
});

test('hide and show return to the visible mode it was hidden from', () => {
  for (const mode of ['topbar', 'floating', 'docked']) {
    const hidden = askPlacement({ mode, rect: R, last: mode }, { type: 'hide' });
    assert.deepEqual(hidden, { mode: 'hidden', rect: R, last: mode });
    assert.equal(askPlacement(hidden, { type: 'hide' }), hidden);
    assert.equal(askPlacement(hidden, { type: 'show' }).mode, mode);
  }
  const shown = { mode: 'floating', rect: R, last: 'floating' };
  assert.equal(askPlacement(shown, { type: 'show' }), shown, 'show on a visible one changes nothing');
});

test('the dock layout is the authority for floating vs docked', () => {
  let s = { mode: 'floating', rect: R, last: 'floating' };
  s = askPlacement(s, { type: 'layout', status: 'docked' });
  assert.deepEqual(s, { mode: 'docked', rect: R, last: 'docked' }, 'dropped beside a panel or as a tab');
  const moved = { x: 10, y: 60, w: 500, h: 80 };
  s = askPlacement(s, { type: 'layout', status: 'floating', rect: moved });
  assert.deepEqual(s, { mode: 'floating', rect: moved, last: 'floating' }, 'dragged out: the new rect is the floating rect');
  assert.equal(askPlacement(s, { type: 'layout', status: 'floating', rect: { ...moved } }), s, 'same rect → no change');
  s = askPlacement(s, { type: 'layout', status: 'hidden' });
  assert.deepEqual(s, { mode: 'hidden', rect: moved, last: 'floating' }, '✕ in its title bar, or Hide others');
  s = askPlacement(s, { type: 'layout', status: 'floating', rect: moved });
  assert.equal(s.mode, 'floating', 'restored from ☰ / Show all');
});

test('in the top bar the panel is hidden in the layout — that is not a close', () => {
  const s = { mode: 'topbar', rect: R, last: 'topbar' };
  assert.equal(askPlacement(s, { type: 'layout', status: 'hidden' }), s);
  assert.equal(askPlacement(s, { type: 'layout', status: null }), s, 'unknown status: nothing');
  assert.equal(askPlacement(s, { type: 'layout', status: 'floating', rect: R }).mode, 'floating', 'shown some other way: it follows');
});

test('Reset layout puts it back in the top bar and keeps the floating rect', () => {
  const s = askPlacement({ mode: 'docked', rect: R, last: 'docked' }, { type: 'layout', status: 'floating', cause: 'reset' });
  assert.deepEqual(s, { mode: 'topbar', rect: R, last: 'topbar' });
  const top = { mode: 'topbar', rect: R, last: 'topbar' };
  assert.equal(askPlacement(top, { type: 'layout', status: 'hidden', cause: 'reset' }), top);
});

test('unknown or missing events change nothing; a missing state starts from the default', () => {
  const s = { mode: 'docked', rect: R, last: 'docked' };
  assert.equal(askPlacement(s, { type: 'spin' }), s);
  assert.equal(askPlacement(s, null), s);
  assert.deepEqual(askPlacement(null, { type: 'float', rect: R }), { mode: 'floating', rect: R, last: 'floating' });
});

// ------------------------------------------------------------------ phone override, hosts

test('phones keep the field in the bottom toolbar: no event moves it', () => {
  const s = { mode: 'floating', rect: R, last: 'floating' };
  for (const ev of [{ type: 'topbar' }, { type: 'float' }, { type: 'hide' }, { type: 'layout', status: 'docked' }, { type: 'layout', status: 'hidden', cause: 'reset' }]) {
    assert.equal(askPlacement(s, ev, { phone: true }), s, ev.type);
  }
  for (const mode of ASK_MODES) assert.equal(askHost({ mode }, { phone: true }), 'bar', mode);
});

test('host and layout status per mode on a desktop', () => {
  assert.equal(askHost({ mode: 'topbar' }), 'topbar');
  for (const mode of ['floating', 'docked', 'hidden']) assert.equal(askHost({ mode }), 'panel');
  assert.deepEqual(ASK_MODES.map((mode) => panelWanted({ mode })), ['hidden', 'floating', 'docked', 'hidden']);
});

// ------------------------------------------------------------------ input history

test('history keeps the newest last, without repeats or blanks, capped', () => {
  let h = [];
  for (const t of ['status', '  ', 'terminal on mac', 'status']) h = pushHistory(h, t);
  assert.deepEqual(h, ['terminal on mac', 'status']);
  h = pushHistory(Array.from({ length: 60 }, (_, i) => `q${i}`), 'last', 50);
  assert.equal(h.length, 50);
  assert.equal(h.at(-1), 'last');
  assert.deepEqual(pushHistory(['a', 7, null, ''], ''), ['a'], 'stored junk is dropped');
  assert.deepEqual(pushHistory('nope', 'x'), ['x']);
});

test('↑ walks back to the oldest, ↓ returns to what was being typed', () => {
  const h = ['one', 'two', 'three'];
  let r = recallHistory(h, null, -1, 'draft');
  assert.deepEqual(r, { index: 2, value: 'three' });
  r = recallHistory(h, r.index, -1, 'draft');
  r = recallHistory(h, r.index, -1, 'draft');
  assert.deepEqual(r, { index: 0, value: 'one' });
  assert.deepEqual(recallHistory(h, 0, -1, 'draft'), { index: 0, value: 'one' }, 'stops at the oldest');
  r = recallHistory(h, 0, 1, 'draft');
  assert.deepEqual(r, { index: 1, value: 'two' });
  assert.deepEqual(recallHistory(h, 2, 1, 'draft'), { index: null, value: 'draft' });
  assert.deepEqual(recallHistory(h, null, 1, 'draft'), { index: null, value: 'draft' }, '↓ while not browsing: nothing');
  assert.deepEqual(recallHistory([], null, -1, 'x'), { index: null, value: 'x' });
});
