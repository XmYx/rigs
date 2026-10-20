// Dock layout + app dock sync: stamp ordering, per-key independence, whitelist and size limits, adopt, push/pull.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createStore, isNewer, KEYS, LayoutError, MAX_VALUE_BYTES, nextStamp, validate } from '../src/uilayout.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-uilayout-')), 'ui-layout.json');
const status = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof LayoutError); return e.status; } return 0; };

test('stamps: newer rev wins, equal revs break ties by machine name, a stale clock still moves forward', () => {
  assert.equal(isNewer({ rev: 2, by: 'a' }, { rev: 1, by: 'z' }), true);
  assert.equal(isNewer({ rev: 1, by: 'z' }, { rev: 2, by: 'a' }), false);
  assert.equal(isNewer({ rev: 5, by: 'b' }, { rev: 5, by: 'a' }), true);
  assert.equal(isNewer({ rev: 5, by: 'a' }, { rev: 5, by: 'a' }), false);
  assert.deepEqual(nextStamp({ rev: 100 }, 'mac', 10), { rev: 101, by: 'mac' });
  assert.deepEqual(nextStamp(null, 'mac', 10), { rev: 10, by: 'mac' });
});

test('validate: only whitelisted keys, JSON values, at most 256 kB', () => {
  for (const k of KEYS) validate(k, { a: 1 });
  assert.equal(status(() => validate('rigs.win-3', {})), 400, 'wm.js windows are never persisted');
  assert.equal(status(() => validate('rigs.dock.fitted', {})), 400);
  assert.equal(status(() => validate('rigs.dock', undefined)), 400);
  const cyc = {}; cyc.self = cyc;
  assert.equal(status(() => validate('rigs.dock', cyc)), 400);
  assert.equal(status(() => validate('rigs.dock', 'x'.repeat(MAX_VALUE_BYTES))), 400);
  validate('rigs.dock', 'x'.repeat(MAX_VALUE_BYTES - 2));
});

test('set: stamps the key, persists it, and survives a restart', () => {
  const file = tmp();
  const a = createStore({ file, name: 'mac', now: () => 1000 });
  assert.deepEqual(a.set('rigs.appdock', { v: 2, items: [] }), { key: 'rigs.appdock', rev: 1000, by: 'mac' });
  assert.equal(a.set('rigs.appdock', { v: 2, items: [1] }).rev, 1001, 'a same-millisecond save still gets a newer rev');
  const b = createStore({ file, name: 'mac' });
  assert.deepEqual(b.get('rigs.appdock'), { value: { v: 2, items: [1] }, rev: 1001, by: 'mac' });
  assert.equal(b.get('rigs.dock'), null);
});

test('keys are independent: saving the app dock leaves the panel layout and its stamp alone', () => {
  const s = createStore({ file: tmp(), name: 'mac', now: () => 50 });
  s.set('rigs.dock', { v: 1 });
  const before = s.get('rigs.dock');
  s.set('rigs.appdock', { v: 2 });
  assert.deepEqual(s.get('rigs.dock'), before);
  const peer = createStore({ file: tmp(), name: 'linux', now: () => 40 });
  peer.set('rigs.appdock', { v: 2, from: 'linux' });
  assert.deepEqual(peer.adopt(s.snapshot()).sort(), ['rigs.appdock', 'rigs.dock'], 'a peer with an older appdock adopts both');
  const old = createStore({ file: tmp(), name: 'win', now: () => 10 });
  old.set('rigs.appdock', { from: 'win' });
  s.adopt(old.snapshot());
  assert.deepEqual(s.get('rigs.appdock').value, { v: 2 }, 'an older appdock never replaces ours');
  assert.deepEqual(s.get('rigs.dock'), before);
});

test('set with baseRev: refuses (409) when the key moved on', () => {
  const s = createStore({ file: tmp(), name: 'mac', now: () => 7 });
  const { rev } = s.set('rigs.dock', { n: 1 });
  s.set('rigs.dock', { n: 2 }, { baseRev: rev });
  assert.equal(status(() => s.set('rigs.dock', { n: 3 }, { baseRev: rev })), 409);
  assert.deepEqual(s.get('rigs.dock').value, { n: 2 });
});

test('adopt: newer wins, older and equal are ignored, bad keys and values are skipped, tie goes to the larger machine name', () => {
  const s = createStore({ file: tmp(), name: 'mac', now: () => 100 });
  s.set('rigs.dock', { from: 'mac' });
  assert.deepEqual(s.adopt({ keys: { 'rigs.dock': { value: { from: 'old' }, rev: 99, by: 'zz' } } }), []);
  assert.deepEqual(s.adopt({ keys: { 'rigs.dock': { value: { from: 'same' }, rev: 100, by: 'mac' } } }), []);
  assert.deepEqual(s.adopt({ keys: { 'rigs.dock': { value: { from: 'tie' }, rev: 100, by: 'zeta' } } }), ['rigs.dock']);
  assert.deepEqual(s.get('rigs.dock'), { value: { from: 'tie' }, rev: 100, by: 'zeta' });
  assert.deepEqual(s.adopt({ keys: { 'rigs.win-1': { value: {}, rev: 999, by: 'x' }, 'rigs.scaling': { value: 'x'.repeat(MAX_VALUE_BYTES), rev: 999, by: 'x' }, 'rigs.docking': { rev: 999, by: 'x' } } }), []);
  assert.deepEqual(s.adopt(null), []);
  assert.equal(s.get('rigs.win-1'), null);
});

test('change events: local saves and adopted keys both notify, with their source', () => {
  const s = createStore({ file: tmp(), name: 'mac', now: () => 1 });
  const seen = [];
  const off = s.onChange((k, e, src) => seen.push([k, e.rev, src]));
  s.set('rigs.docking', true);
  s.adopt({ keys: { 'rigs.scaling': { value: 1.5, rev: 9, by: 'linux' } } });
  s.adopt({ keys: { 'rigs.scaling': { value: 1.5, rev: 9, by: 'linux' } } });
  off();
  s.set('rigs.docking', false);
  assert.deepEqual(seen, [['rigs.docking', 1, 'local'], ['rigs.scaling', 9, 'peer']]);
});

test('push/pull round trip between two stores with a stubbed peer link', () => {
  const A = createStore({ file: tmp(), name: 'a', now: () => 1000 });
  const B = createStore({ file: tmp(), name: 'b', now: () => 500 });
  let bOnline = true;
  // push: what the server does on a local change
  A.onChange((key, entry, source) => { if (source === 'local' && bOnline) B.adopt({ keys: { [key]: entry } }); });
  const bSeen = [];
  B.onChange((k, e, src) => bSeen.push([k, src]));
  A.set('rigs.appdock', { v: 2, pins: ['x'] });
  assert.deepEqual(B.get('rigs.appdock'), A.get('rigs.appdock'));
  assert.deepEqual(bSeen, [['rigs.appdock', 'peer']]);
  // B is offline for the next change, then pulls A's whole snapshot when it is back
  bOnline = false;
  A.set('rigs.dock', { v: 1, tree: 'x' });
  assert.equal(B.get('rigs.dock'), null);
  bOnline = true;
  assert.deepEqual(B.adopt(A.snapshot()), ['rigs.dock']);
  assert.deepEqual(B.snapshot(), A.snapshot());
  // B never echoes an adopted key back to A
  assert.deepEqual(A.adopt(B.snapshot()), []);
});

test('a corrupt or foreign store file starts empty and drops unknown keys', () => {
  const file = tmp();
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(createStore({ file }).snapshot(), { keys: {} });
  fs.writeFileSync(file, JSON.stringify({ keys: { 'rigs.dock': { value: 1, rev: 3, by: 'a' }, 'rigs.win-1': { value: 1, rev: 3, by: 'a' } } }));
  assert.deepEqual(Object.keys(createStore({ file }).snapshot().keys), ['rigs.dock']);
});
