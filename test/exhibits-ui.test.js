// Exhibit window (ui/src/exhibits.js): the pure model behind it (ui/src/exhibits-model.js) in Node, plus static checks
// that the menu entry, the reduced-motion, phone and print rules and the main.js wiring exist. No browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const M = await import('../ui/src/exhibits-model.js');

const entry = (n, extra = {}) => ({ id: `e${n}`, seq: n, kind: 'step', title: `Step ${n}`, caption: 'c', visual: null, image: { src: 'data:image/svg+xml;base64,AA', alt: 'a', source: 'svg' }, at: 1000 + n, ...extra });
const push = (docId, e, extra = {}) => ({ type: 'exhibit', docId, entry: e, ...extra });

test('pushKind names every WebSocket push and ignores the rest', () => {
  assert.equal(M.pushKind(push('d', entry(1))), 'entry');
  assert.equal(M.pushKind({ type: 'exhibit-entry', docId: 'd', entry: entry(1) }), 'entry');
  assert.equal(M.pushKind({ type: 'exhibit-image', docId: 'd', entry: entry(1) }), 'image');
  assert.equal(M.pushKind({ type: 'exhibit-final', docId: 'd', at: 5 }), 'final');
  assert.equal(M.pushKind({ type: 'exhibit-live', docId: 'd', text: 'Thinking…' }), 'live');
  assert.equal(M.pushKind({ type: 'exhibit-live', docId: 'd' }), null, 'a live push without text');
  assert.equal(M.pushKind({ type: 'exhibit', entry: entry(1) }), null, 'no docId');
  assert.equal(M.pushKind({ type: 'trace-span', docId: 'd' }), null);
  assert.equal(M.pushKind(null), null);
});

test('applyPush places entries by seq, shows one entry once, swaps images and finishes the document', () => {
  const doc = M.emptyDoc('tr-1');
  assert.equal(doc.scope, 'request');
  assert.equal(M.emptyDoc('pr-abc').scope, 'project');
  assert.equal(M.applyPush(doc, push('tr-1', entry(2))).isNew, true);
  assert.equal(M.applyPush(doc, push('tr-1', entry(1))).isNew, true);
  assert.deepEqual(doc.entries.map((e) => e.seq), [1, 2], 'sorted by seq');
  const again = M.applyPush(doc, push('tr-1', entry(2, { title: 'Changed' })));
  assert.equal(again.isNew, false, 'the same id again is an update');
  assert.equal(doc.entries.length, 2);
  assert.equal(doc.entries[1].title, 'Changed');
  const img = M.applyPush(doc, { type: 'exhibit-image', docId: 'tr-1', entry: entry(1, { image: { src: 'x.png', file: 'x.png', source: 'comfyui' } }) });
  assert.equal(doc.entries[0].image.source, 'comfyui');
  assert.equal(img.isNew, false);
  assert.equal(M.applyPush(doc, { type: 'exhibit-image', docId: 'tr-1', entry: entry(9) }).entry, null, 'an image for an unknown entry changes nothing');
  assert.equal(doc.final, false);
  M.applyPush(doc, { type: 'exhibit-final', docId: 'tr-1', at: 42 });
  assert.equal(doc.final, true);
  assert.equal(doc.finalAt, 42);
  const d2 = M.emptyDoc('tr-2');
  M.applyPush(d2, push('tr-2', entry(1), { final: true }));
  assert.equal(d2.final, true, 'an entry that carries final ends the document');
  assert.deepEqual(M.applyPush(M.emptyDoc('tr-3'), { type: 'exhibit-live', docId: 'tr-3', text: 'x' }).entry, null, 'live lines never touch the entries');
});

test('the ticker keeps the last lines, folds repeats and never mutates', () => {
  const live = (text) => ({ type: 'exhibit-live', docId: 'd', kind: 'router', text, at: 1 });
  let t = [];
  t = M.pushLive(t, live('Request received — on it.'));
  const before = t;
  t = M.pushLive(t, live('Request received — on it.'));
  assert.equal(t, before, 'same text again: unchanged');
  for (const s of ['a', 'b', 'c', 'd']) t = M.pushLive(t, live(s));
  assert.deepEqual(t.map((l) => l.text), ['a', 'b', 'c', 'd'], 'four lines at most');
  assert.equal(M.pushLive(t, { type: 'exhibit', docId: 'd', entry: entry(1) }), t, 'not a live push');
});

test('a new document is told by its first push, whichever kind; the window follows unless a document was picked', () => {
  const seen = new Set();
  assert.equal(M.startsDocument(seen, { type: 'exhibit-live', docId: 'a', text: 'x' }), true);
  assert.equal(M.startsDocument(seen, push('a', entry(1))), true);
  seen.add('a');
  assert.equal(M.startsDocument(seen, push('a', entry(2))), false);
  assert.equal(M.startsDocument(seen, { type: 'exhibit-final', docId: 'b' }), false, 'a final alone starts nothing');
  assert.equal(M.shouldFollow({ current: null, currentFinal: false, follow: false }), true, 'nothing shown');
  assert.equal(M.shouldFollow({ current: 'a', currentFinal: true, follow: false }), true, 'shown one is finished');
  assert.equal(M.shouldFollow({ current: 'a', currentFinal: false, follow: true }), true, 'following live work');
  assert.equal(M.shouldFollow({ current: 'a', currentFinal: false, follow: false }), false, 'reading an older one');
});

test('the picker lists live documents over the fetched ones, newest first, labelled', () => {
  const listed = [
    { docId: 'tr-old', scope: 'request', title: 'old request', entries: 3, final: true, updated: 100, node: 'mac' },
    { docId: 'pr-1', scope: 'project', title: 'A project', entries: 2, final: false, updated: 300, node: 'mac' },
  ];
  const live = [{ docId: 'tr-new', scope: 'request', title: '', entries: 0, final: false, updated: null, created: 500, node: '' }, { docId: 'pr-1', scope: 'project', title: 'A project', entries: 4, final: false, updated: 400, node: '' }];
  const rows = M.pickerRows(listed, live);
  assert.deepEqual(rows.map((r) => r.docId), ['tr-new', 'pr-1', 'tr-old']);
  assert.equal(rows[1].entries, 4, 'the live count wins');
  assert.equal(rows[1].node, 'mac', 'the node of the fetched row is kept');
  assert.equal(M.pickerRows(Array.from({ length: 50 }, (_, i) => ({ docId: `tr-${i}`, updated: i })), []).length, 30);
  assert.equal(M.rowLabel(listed[0]), 'Request · old request · 3 · final');
  assert.equal(M.rowLabel(rows[1]), 'Project · A project · 4 · live');
  assert.match(M.rowLabel({ docId: 'tr-x', scope: 'request', entries: 0 }), /tr-x · 0 · live/);
  assert.equal(M.keepSelection(rows, 'pr-1'), 'pr-1');
  assert.equal(M.keepSelection(rows, 'gone'), 'tr-new');
  assert.equal(M.keepSelection([], 'x'), null);
  assert.equal(M.countText(1), '1 exhibit');
  assert.equal(M.countText(5), '5 exhibits');
});

test('URLs go through the node that holds the document; stored pictures by file name, SVGs stay inline', () => {
  assert.equal(M.docUrl('', 'tr-1'), '/api/nodes/self/exhibits/tr-1');
  assert.equal(M.docUrl('mac book', 'pr-1'), '/api/nodes/mac%20book/exhibits/pr-1');
  assert.equal(M.exportUrl('mac', 'tr-1'), '/api/nodes/mac/exhibits/tr-1/export?format=html');
  assert.equal(M.exportUrl('mac', 'tr-1', 'md', true), '/api/nodes/mac/exhibits/tr-1/export?format=md&download=1');
  assert.equal(M.exportUrl('mac', 'tr-1', 'pdf'), '/api/nodes/mac/exhibits/tr-1/export?format=html', 'only html or md');
  const svg = entry(1);
  assert.equal(M.imageSrc(svg, 'mac', 'tr-1'), svg.image.src);
  const png = entry(2, { image: { src: 'api/local/exhibits/tr-1/images/a.png', file: 'a.png', source: 'comfyui' } });
  assert.equal(M.imageSrc(png, 'mac', 'tr-1'), '/api/nodes/mac/exhibits/tr-1/images/a.png');
  assert.equal(M.imageSrc({ image: null }, '', 'tr-1'), '');
});

test('a fetched document merges into the live one without dropping or duplicating', () => {
  const doc = M.emptyDoc('tr-1');
  M.applyPush(doc, push('tr-1', entry(3)));
  const added = M.mergeDoc(doc, { docId: 'tr-1', title: 'add dark mode', entries: [entry(1), entry(2), entry(3)], final: true, finalAt: 9, updated: 2000, created: 900, dropped: 2 });
  assert.deepEqual(added.map((e) => e.seq), [1, 2]);
  assert.deepEqual(doc.entries.map((e) => e.seq), [1, 2, 3]);
  assert.equal(doc.title, 'add dark mode');
  assert.equal(doc.final, true);
  assert.equal(doc.dropped, 2);
  assert.equal(M.titleOf(doc), 'add dark mode');
  const bare = M.emptyDoc('tr-2');
  M.applyPush(bare, push('tr-2', entry(1, { kind: 'intake', title: 'what is the weather?' })));
  assert.equal(M.titleOf(bare), 'what is the weather?', 'the request in its own words');
  assert.equal(M.titleOf(M.emptyDoc('pr-77')), 'Project 77');
  assert.deepEqual(M.mergeDoc(M.emptyDoc('x'), null), []);
});

test('the Experimental menu, the main.js wiring and the stylesheet rules are in place', () => {
  const cmds = read('ui/src/jarvis-commands.js');
  assert.match(cmds, /id: 'experimental\.exhibits'[\s\S]*checked:/, 'a checkable Exhibits command');
  assert.match(cmds, /id: 'experimental', label: 'Experimental'/, 'an Experimental menu');
  const main = read('ui/src/main.js');
  assert.match(main, /startsWith\('exhibit'\)\) onExhibitEvent/, 'WebSocket pushes reach the window');
  assert.match(main, /initExhibits\(\)/);
  assert.match(main, /exhibits: \{ enabled: exhibitsEnabled/);
  const win = read('ui/src/exhibits.js');
  assert.match(win, /\/api\/local\/exhibits\/config/, 'the toggle POSTs the config');
  assert.match(win, /openWindow\(\{[^}]*focus: !auto/, 'an automatic open never takes the cursor');
  const css = read('ui/src/styles.css');
  const block = css.slice(css.indexOf('=== EXHIBITS ==='), css.indexOf('=== END EXHIBITS ==='));
  assert.ok(block.length > 2000, 'EXHIBITS block');
  assert.match(block, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.ex-img[\s\S]*animation: none !important/, 'motion off under reduced motion');
  assert.match(block, /@media \(max-width: 640px\)/, 'phone layout');
  assert.match(block, /@media print/, 'print view');
  assert.doesNotMatch(block.replace(/@media print[\s\S]*$/, ''), /#[0-9a-f]{3,6}\b/i, 'theme variables only outside the print rules');
});
