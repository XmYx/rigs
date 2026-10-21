// Spaces (ui/src/spaces-model.js): the virtual desktops of the JARVIS window manager. Pure module, no DOM; the wiring
// (wm.js hides other desktops' windows, the menu bar indicator, Ctrl+←/→ / Ctrl+1…9) is checked in the browser
// (scripts/spaces-check.js).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  DESKTOP_KEYS, MAX_DESKTOPS, addDesktop, assignWindow, canRemove, desktopName, desktopOf, desktopShortcuts, forgetWindow, initialSpaces,
  keyToDesktop, listDesktops, mergeRemote, moveDesktop, moveWindow, normalizeSpaces, removeDesktop, renameDesktop, serializeSpaces,
  switchDesktop, targetOf, windowsOn,
} from '../ui/src/spaces-model.js';

/** Three desktops d1 d2 d3, d2 active, with windows a b on d1, c on d2, e f on d3. */
function three() {
  let s = addDesktop(addDesktop(initialSpaces()));
  s = switchDesktop(s, 'd1');
  s = assignWindow(assignWindow(s, 'a'), 'b');
  s = switchDesktop(s, 'd2');
  s = assignWindow(s, 'c');
  s = moveWindow(assignWindow(s, 'e'), 'e', 'd3');
  s = moveWindow(assignWindow(s, 'f'), 'f', 'd3');
  return s;
}
const key = (k, mods = {}) => {
  const code = /^\d$/.test(k) ? `Digit${k}` : '';
  return { key: k, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods };
};

test('the model is pure: no DOM at import time', () => {
  const src = fs.readFileSync(new URL('../ui/src/spaces-model.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\b(document|window|localStorage|getComputedStyle)\b\./);
  assert.match(src, /from '\.\/commands\.js'/, 'key chords use the one shortcut matcher');
});

test('a fresh state is one active desktop called Desktop 1', () => {
  const s = initialSpaces();
  assert.deepEqual(listDesktops(s), [{ id: 'd1', name: 'Desktop 1', index: 0, active: true, named: false, windows: 0 }]);
  assert.equal(canRemove(s), false);
});

test('add: appended at the end, not switched to; ids are never reused; at most MAX_DESKTOPS', () => {
  let s = addDesktop(initialSpaces());
  assert.deepEqual(s.desktops.map((d) => d.id), ['d1', 'd2']);
  assert.equal(s.active, 'd1');
  assert.equal(desktopName(s, 'd2'), 'Desktop 2');
  s = removeDesktop(s, 'd2');
  s = addDesktop(s);
  assert.deepEqual(s.desktops.map((d) => d.id), ['d1', 'd3'], 'a removed id is not handed out again');
  assert.equal(desktopName(s, 'd3'), 'Desktop 2', 'unnamed desktops are numbered by position');
  for (let i = 0; i < 40; i++) s = addDesktop(s);
  assert.equal(s.desktops.length, MAX_DESKTOPS);
  assert.equal(addDesktop(s), s, 'a full set is returned unchanged');
});

test('remove: the windows of a removed desktop move to its neighbour, which becomes active if it was', () => {
  const s = three();
  // d2 (active, holds c) goes: c moves to d1, the desktop before it, and d1 becomes active
  const a = removeDesktop(s, 'd2');
  assert.deepEqual(a.desktops.map((d) => d.id), ['d1', 'd3']);
  assert.equal(a.active, 'd1');
  assert.deepEqual(windowsOn(a, 'd1').sort(), ['a', 'b', 'c']);
  assert.deepEqual(windowsOn(a, 'd3').sort(), ['e', 'f']);
  // the first desktop has no desktop before it: its windows go to the one after, the active one stays
  const b = removeDesktop(s, 'd1');
  assert.equal(b.active, 'd2');
  assert.deepEqual(windowsOn(b, 'd2').sort(), ['a', 'b', 'c']);
  // removing an inactive desktop keeps the active one
  const c = removeDesktop(s, 'd3');
  assert.equal(c.active, 'd2');
  assert.deepEqual(windowsOn(c, 'd2').sort(), ['c', 'e', 'f']);
  assert.equal(listDesktops(c).find((d) => d.id === 'd2').windows, 3);
  // default: the active desktop
  assert.equal(removeDesktop(s).desktops.length, 2);
  assert.equal(removeDesktop(s).active, 'd1');
});

test('remove: the last desktop and unknown ids are refused (same object back)', () => {
  let s = three();
  s = removeDesktop(removeDesktop(s, 'd1'), 'd2');
  assert.deepEqual(s.desktops.map((d) => d.id), ['d3']);
  assert.deepEqual(windowsOn(s, 'd3').sort(), ['a', 'b', 'c', 'e', 'f'], 'every window survives');
  assert.equal(removeDesktop(s, 'd3'), s);
  assert.equal(removeDesktop(three(), 'd9').desktops.length, 3);
});

test('rename: trimmed and capped; an empty name gives back "Desktop <n>"; no change → same object', () => {
  let s = three();
  s = renameDesktop(s, 'd2', '  Research   work ');
  assert.equal(desktopName(s, 'd2'), 'Research work');
  assert.equal(listDesktops(s)[1].named, true);
  assert.equal(renameDesktop(s, 'd2', 'Research work'), s);
  assert.equal(desktopName(renameDesktop(s, 'd2', 'x'.repeat(100)), 'd2').length, 40);
  s = renameDesktop(s, 'd2', '   ');
  assert.equal(desktopName(s, 'd2'), 'Desktop 2');
  assert.equal(renameDesktop(s, 'd9', 'x'), s);
  assert.equal(desktopName(s, 'd9'), '');
});

test('moveDesktop reorders; numbering follows the position', () => {
  const s = moveDesktop(three(), 'd3', 0);
  assert.deepEqual(s.desktops.map((d) => d.id), ['d3', 'd1', 'd2']);
  assert.equal(desktopName(s, 'd3'), 'Desktop 1');
  assert.equal(moveDesktop(s, 'd3', 0), s);
  assert.deepEqual(moveDesktop(s, 'd3', 99).desktops.map((d) => d.id), ['d1', 'd2', 'd3']);
});

test('switch: by id, by index, next / prev stopping at the ends; nothing to do → same object', () => {
  const s = three(); // d2 active
  assert.equal(switchDesktop(s, 'd3').active, 'd3');
  assert.equal(switchDesktop(s, { index: 0 }).active, 'd1');
  assert.equal(switchDesktop(s, 'next').active, 'd3');
  assert.equal(switchDesktop(s, 'prev').active, 'd1');
  const last = switchDesktop(s, 'd3');
  assert.equal(switchDesktop(last, 'next'), last, 'no wrap past the last desktop');
  const first = switchDesktop(s, 'd1');
  assert.equal(switchDesktop(first, 'prev'), first, 'no wrap before the first');
  assert.equal(switchDesktop(s, 'd2'), s);
  assert.equal(switchDesktop(s, 'd9'), s);
  assert.equal(switchDesktop(s, { index: 7 }), s);
  assert.equal(switchDesktop(s, { index: 1.5 }), s);
  assert.equal(switchDesktop(s, null), s);
  // switching never moves windows
  assert.deepEqual(switchDesktop(s, 'd3').windows, s.windows);
});

test('new windows go on the active desktop; a known window keeps its desktop', () => {
  let s = three(); // d2 active
  s = assignWindow(s, 'new');
  assert.equal(desktopOf(s, 'new'), 'd2');
  assert.equal(assignWindow(s, 'e'), s, 'e is on d3 already: it stays there');
  assert.equal(desktopOf(assignWindow(s, 'g', { desktop: 'd1' }), 'g'), 'd1');
  assert.equal(desktopOf(assignWindow(s, 'g', { desktop: 'd9' }), 'g'), 'd2', 'an unknown desktop falls back to the active one');
  assert.equal(desktopOf(s, 'nobody'), null);
  assert.equal(assignWindow(s, ''), s);
});

test('moveWindow / forgetWindow', () => {
  let s = three();
  s = moveWindow(s, 'a', 'd3');
  assert.equal(desktopOf(s, 'a'), 'd3');
  assert.equal(s.active, 'd2', 'moving a window does not switch');
  assert.equal(moveWindow(s, 'a', 'd3'), s);
  assert.equal(moveWindow(s, 'a', 'd9'), s);
  s = forgetWindow(s, 'a');
  assert.equal(desktopOf(s, 'a'), null);
  assert.equal(forgetWindow(s, 'a'), s);
  // a forgotten window opens on the active desktop next time
  assert.equal(desktopOf(assignWindow(s, 'a'), 'a'), 'd2');
});

test('persist: serialize → normalize round-trips desktops, names and keyed windows; transient windows and active stay local', () => {
  let s = renameDesktop(three(), 'd3', 'Music');
  s = assignWindow(s, '~7'); // a window without a key of its own
  const json = JSON.stringify(serializeSpaces(s));
  const saved = JSON.parse(json);
  assert.equal(saved.v, 1);
  assert.equal('active' in saved, false);
  assert.equal('~7' in saved.windows, false);
  assert.equal(serializeSpaces(s, { active: true }).active, 'd2');
  const back = normalizeSpaces(json, { active: 'd3' });
  assert.deepEqual(back.desktops, s.desktops);
  assert.equal(back.active, 'd3');
  assert.equal(back.seq, s.seq);
  assert.deepEqual(windowsOn(back, 'd3').sort(), ['e', 'f']);
  assert.equal(desktopName(back, 'd3'), 'Music');
  // a reload: the keyed window comes back on its desktop
  assert.equal(desktopOf(assignWindow(back, 'e'), 'e'), 'd3');
  // an active id that no longer exists: the first desktop
  assert.equal(normalizeSpaces(json, { active: 'd42' }).active, 'd1');
});

test('normalize repairs anything', () => {
  for (const bad of [null, undefined, 42, 'not json', '[]', {}, { desktops: 'x' }, { desktops: [] }, { desktops: [{ id: 5 }, { id: 'zz' }] }]) {
    const s = normalizeSpaces(bad);
    assert.deepEqual(s, initialSpaces(), JSON.stringify(bad));
  }
  const s = normalizeSpaces({
    desktops: [{ id: 'd4', name: 'A' }, { id: 'd4', name: 'dup' }, { id: 'd2' }, null],
    windows: { x: 'd2', y: 'd9', '': 'd2' },
    seq: 1,
    active: 'd2',
  });
  assert.deepEqual(s.desktops, [{ id: 'd4', name: 'A' }, { id: 'd2', name: '' }]);
  assert.deepEqual(s.windows, { x: 'd2' }, 'windows on unknown desktops are dropped');
  assert.equal(s.seq, 4, 'seq never falls below the highest id');
  assert.equal(s.active, 'd2');
  const many = normalizeSpaces({ desktops: Array.from({ length: 30 }, (_, i) => ({ id: `d${i + 1}` })) });
  assert.equal(many.desktops.length, MAX_DESKTOPS);
});

test('mergeRemote: takes the other side\'s desktops, keeps this page\'s active desktop and its own open windows', () => {
  const s = three(); // d2 active; a b on d1, c on d2, e f on d3
  // the other machine added d4, renamed d1 and moved a to d4; it does not know window "local"
  let remote = renameDesktop(addDesktop(s), 'd1', 'Mail');
  remote = moveWindow(remote, 'a', 'd4');
  const here = assignWindow(s, 'local');
  const m = mergeRemote(here, JSON.stringify(serializeSpaces(remote)), { open: ['a', 'local'] });
  assert.deepEqual(m.desktops.map((d) => d.id), ['d1', 'd2', 'd3', 'd4']);
  assert.equal(desktopName(m, 'd1'), 'Mail');
  assert.equal(m.active, 'd2');
  assert.equal(desktopOf(m, 'a'), 'd4', 'the other side moved a');
  assert.equal(desktopOf(m, 'local'), 'd2', 'a window only this page has keeps its desktop');
  assert.equal(m.seq, 4);
  // the other side removed the active desktop: this page goes to its neighbour, open windows of it follow
  const gone = removeDesktop(s, 'd2');
  const m2 = mergeRemote(assignWindow(s, 'mine'), serializeSpaces(gone), { open: ['mine'] });
  assert.equal(m2.active, 'd1');
  assert.equal(desktopOf(m2, 'mine'), 'd1');
  assert.equal(desktopOf(m2, 'c'), 'd1');
});

test('keys: Ctrl+←/→ and Ctrl+1…9, with the Mac / browser fallbacks', () => {
  assert.equal(DESKTOP_KEYS.length, 11);
  assert.deepEqual(desktopShortcuts('prev'), ['Ctrl+ArrowLeft']);
  assert.deepEqual(desktopShortcuts('prev', true), ['Ctrl+ArrowLeft', 'Ctrl+Shift+ArrowLeft']);
  assert.deepEqual(desktopShortcuts(3), ['Ctrl+3', 'Ctrl+Shift+3']);
  assert.deepEqual(desktopShortcuts(3, true), ['Ctrl+3']);
  assert.deepEqual(desktopShortcuts('nope'), []);
  const ctrl = { ctrlKey: true };
  assert.equal(keyToDesktop(key('ArrowLeft', ctrl)), 'prev');
  assert.equal(keyToDesktop(key('ArrowRight', ctrl), { mac: true }), 'next');
  assert.equal(keyToDesktop(key('ArrowRight', { ctrlKey: true, shiftKey: true }), { mac: true }), 'next');
  assert.equal(keyToDesktop(key('ArrowRight', { ctrlKey: true, shiftKey: true })), null, 'Ctrl+Shift+→ selects words elsewhere');
  assert.equal(keyToDesktop(key('4', ctrl)), 4);
  assert.equal(keyToDesktop(key('$', { ctrlKey: true, shiftKey: true, code: 'Digit4' })), 4, 'Shift+4 is "$": the physical key counts');
  assert.equal(keyToDesktop(key('$', { ctrlKey: true, shiftKey: true, code: 'Digit4' }), { mac: true }), null);
  assert.equal(keyToDesktop(key('0', ctrl)), null);
  assert.equal(keyToDesktop(key('ArrowLeft')), null);
  assert.equal(keyToDesktop(key('ArrowLeft', { ctrlKey: true, altKey: true })), null, 'Ctrl+Alt+← is tiling');
  assert.equal(keyToDesktop(key('ArrowLeft', { metaKey: true })), null);
  assert.equal(keyToDesktop(null), null);
  assert.deepEqual(targetOf(4), { index: 3 });
  assert.equal(targetOf('next'), 'next');
  assert.equal(switchDesktop(three(), targetOf(1)).active, 'd1');
});

test('desktop keys never collide with the tiling keys', async () => {
  const { TILE_KEYS } = await import('../ui/src/tiling-model.js');
  const tiles = new Set(TILE_KEYS.flatMap((r) => [...r.keys, ...(r.mac || [])]).map((s) => s.toLowerCase()));
  for (const r of DESKTOP_KEYS) for (const s of [...r.keys, ...(r.mac || []), ...(r.other || [])]) assert.equal(tiles.has(s.toLowerCase()), false, s);
});

test('persist keeps the newest MAX_WINDOWS window keys', async () => {
  const { MAX_WINDOWS } = await import('../ui/src/spaces-model.js');
  let s = initialSpaces();
  for (let i = 0; i < MAX_WINDOWS + 50; i++) s = assignWindow(s, `k${i}`);
  s = moveWindow(addDesktop(s), 'k0', 'd2'); // moved: the newest now
  const out = serializeSpaces(s);
  assert.equal(Object.keys(out.windows).length, MAX_WINDOWS);
  assert.equal(out.windows.k0, 'd2');
  assert.equal('k1' in out.windows, false);
  assert.equal(out.windows[`k${MAX_WINDOWS + 49}`], 'd1');
});
