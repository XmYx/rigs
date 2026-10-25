// Files agents create are kept, explained or not (src/file-cache.js): cached when unexplained, explained later, listed for reuse.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cacheCopies, filesBrief, mergeFiles, normalizeReported } from '../src/file-cache.js';

test('normalizeReported accepts strings and objects, drops junk', () => {
  assert.deepEqual(normalizeReported(['a.txt', { path: ' b.md ', reason: ' notes ' }, { reason: 'x' }, null, 3]), [{ path: 'a.txt', reason: '' }, { path: 'b.md', reason: 'notes' }]);
  assert.deepEqual(normalizeReported('nope'), []);
});

test('an unexplained file is cached; a later reason explains it instead of a new entry', () => {
  const a = mergeFiles([], [{ path: 'probe.js' }, { path: 'app.js', reason: 'entry point' }], { task: 't1', node: 'mac', now: 1 });
  assert.equal(a.files.length, 2);
  assert.equal(a.files[0].cached, true);
  assert.equal(a.files[1].cached, undefined);
  const b = mergeFiles(a.files, [{ path: 'probe.js', reason: 'parses the logs' }], { task: 't2', node: 'mac', now: 2 });
  assert.equal(b.files.length, 2);
  assert.equal(b.added.length, 0);
  assert.equal(b.explained.length, 1);
  assert.equal(b.files[0].reason, 'parses the logs');
  assert.equal(b.files[0].explainedBy, 't2');
  assert.deepEqual(b.files[0].usedBy, ['t2']);
});

test('filesBrief lists files for reuse, not the task own unexplained ones', () => {
  const { files } = mergeFiles([], [{ path: 'probe.js' }, { path: 'app.js', reason: 'entry' }], { task: 't1', node: 'mac' });
  const own = filesBrief(files, { taskId: 't1' });
  assert.match(own, /app\.js/);
  assert.doesNotMatch(own, /probe\.js/);
  const next = filesBrief(files, { taskId: 't2' });
  assert.match(next, /probe\.js` on mac \(t1\) — kept, no reason given yet/);
  assert.equal(filesBrief([], {}), '');
});

test('cacheCopies stores a copy of cached text files through the node', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-'));
  const entries = [{ path: '/x/probe.js', node: 'mac', cached: true }, { path: '/x/app.js', node: 'mac', reason: 'r' }, { path: '/x/big.bin', node: 'mac', cached: true }];
  const calls = [];
  await cacheCopies('pr-1', entries, async (node, sub) => { calls.push(sub); if (sub.includes('big')) return { truncated: true, text: '' }; return { text: 'hello' }; }, { dir });
  assert.equal(calls.length, 2);
  assert.ok(entries[0].copy && fs.readFileSync(entries[0].copy, 'utf8') === 'hello');
  assert.equal(entries[1].copy, undefined);
  assert.equal(entries[2].copy, undefined);
});
