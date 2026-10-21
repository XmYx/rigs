// Drag and drop on the server (src/file-transfer.js): move/copy on one machine, pull from another, clash handling,
// path checks — plus the HTTP routes on a throwaway node.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-transfer-')));
process.env.RIGS_HOME = path.join(TMP, 'home'); // trash lands here, not in the real ~/.rigs
const { transfer, pull, checkPath, checkName, localSource, progressOf } = await import('../src/file-transfer.js');
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let n = 0;
const fresh = () => { const d = path.join(TMP, `case${++n}`); fs.mkdirSync(path.join(d, 'src'), { recursive: true }); fs.mkdirSync(path.join(d, 'dst'), { recursive: true }); return { src: path.join(d, 'src'), dst: path.join(d, 'dst'), d }; };
const put = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); return p; };
const read = (p) => fs.readFileSync(p, 'utf8');
const trashed = () => { try { return fs.readdirSync(path.join(process.env.RIGS_HOME, 'trash')); } catch { return []; } };

test('checkPath: refuses .., NUL, relative and empty paths; accepts absolute, ~ and @shared', () => {
  for (const bad of ['', '   ', '../etc', '/a/../../etc/passwd', '~/x/../../y', 'rel/path', 'a\0b', '@shared/../x', 'C:\\a\\..\\b']) assert.throws(() => checkPath(bad), (e) => e.status === 400, JSON.stringify(bad));
  assert.equal(checkPath('/tmp/x'), path.resolve('/tmp/x'));
  assert.ok(checkPath('~/Documents').startsWith(os.homedir()));
  assert.ok(checkPath('@shared/reports').includes('reports'));
  assert.throws(() => checkPath(42), (e) => e.status === 400);
});

test('checkName: a bare name only', () => {
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', '../x', 'x\0']) assert.throws(() => checkName(bad), (e) => e.status === 400, JSON.stringify(bad));
  assert.equal(checkName('Résumé (2).pdf'), 'Résumé (2).pdf');
});

test('move: a file lands in the folder, the source is gone, several items at once', async () => {
  const { src, dst } = fresh();
  put(path.join(src, 'a.txt'), 'A'); put(path.join(src, 'b.txt'), 'B'); put(path.join(src, 'dir/inner.txt'), 'I');
  const r = await transfer('move', [path.join(src, 'a.txt'), path.join(src, 'b.txt'), path.join(src, 'dir')], dst);
  assert.equal(r.ok, true);
  assert.equal(r.done.length, 3);
  assert.equal(read(path.join(dst, 'a.txt')), 'A');
  assert.equal(read(path.join(dst, 'dir/inner.txt')), 'I');
  assert.ok(!fs.existsSync(path.join(src, 'a.txt')) && !fs.existsSync(path.join(src, 'dir')));
});

test('copy: the source stays, folders copy recursively', async () => {
  const { src, dst } = fresh();
  put(path.join(src, 'a.txt'), 'A'); put(path.join(src, 'dir/x/y.txt'), 'Y');
  const r = await transfer('copy', [path.join(src, 'a.txt'), path.join(src, 'dir')], dst);
  assert.equal(r.ok, true);
  assert.equal(read(path.join(dst, 'a.txt')), 'A');
  assert.equal(read(path.join(dst, 'dir/x/y.txt')), 'Y');
  assert.equal(read(path.join(src, 'a.txt')), 'A');
});

test('path traversal: ".." and relative/escaping paths are refused in copy and move, nothing is touched', async () => {
  const { src, dst, d } = fresh();
  put(path.join(src, 'a.txt'), 'A'); put(path.join(d, 'secret.txt'), 'S');
  for (const op of ['copy', 'move']) {
    await assert.rejects(transfer(op, [src + '/../secret.txt'], dst), (e) => e.status === 400);
    await assert.rejects(transfer(op, [path.join(src, 'a.txt')], dst + '/../src'), (e) => e.status === 400);
    await assert.rejects(transfer(op, ['src/a.txt'], dst), (e) => e.status === 400);
    await assert.rejects(transfer(op, [path.join(src, 'a.txt')], 'dst'), (e) => e.status === 400);
    await assert.rejects(transfer(op, [{ from: path.join(src, 'a.txt'), name: '../evil.txt' }], dst), (e) => e.status === 400);
    await assert.rejects(transfer(op, [{ from: path.join(src, 'a.txt'), name: '/abs/evil.txt' }], dst), (e) => e.status === 400);
  }
  assert.equal(read(path.join(src, 'a.txt')), 'A');
  assert.deepEqual(fs.readdirSync(dst), []);
  assert.ok(!fs.existsSync(path.join(d, 'evil.txt')));
});

test('a folder cannot go into itself or a descendant; a missing source is 404; a file is not a destination', async () => {
  const { src, dst } = fresh();
  put(path.join(src, 'dir/sub/f.txt'), 'F'); put(path.join(src, 'a.txt'), 'A');
  await assert.rejects(transfer('move', [path.join(src, 'dir')], path.join(src, 'dir')), /into itself/);
  await assert.rejects(transfer('copy', [path.join(src, 'dir')], path.join(src, 'dir/sub')), /into itself/);
  await assert.rejects(transfer('move', [path.join(src, 'nope.txt')], dst), (e) => e.status === 404);
  await assert.rejects(transfer('move', [path.join(src, 'dir')], path.join(src, 'a.txt')), (e) => e.status === 400);
  assert.ok(fs.existsSync(path.join(src, 'dir/sub/f.txt')));
});

test('clash: with no policy nothing is done and the clashes are listed', async () => {
  const { src, dst } = fresh();
  put(path.join(src, 'a.txt'), 'NEW'); put(path.join(src, 'b.txt'), 'B'); put(path.join(dst, 'a.txt'), 'OLD');
  const r = await transfer('move', [path.join(src, 'a.txt'), path.join(src, 'b.txt')], dst);
  assert.equal(r.ok, false);
  assert.deepEqual(r.clashes.map((c) => c.name), ['a.txt']);
  assert.equal(r.clashes[0].existing.size, 3);
  assert.equal(read(path.join(dst, 'a.txt')), 'OLD');
  assert.ok(fs.existsSync(path.join(src, 'a.txt')) && fs.existsSync(path.join(src, 'b.txt')), 'the clash-free item waits too: all or nothing');
  assert.ok(!fs.existsSync(path.join(dst, 'b.txt')));
});

test('clash keep: both stay, the newcomer gets a " (2)" name', async () => {
  const { src, dst } = fresh();
  put(path.join(src, 'a.txt'), 'NEW'); put(path.join(dst, 'a.txt'), 'OLD'); put(path.join(dst, 'a (2).txt'), 'OLD2');
  const r = await transfer('copy', [path.join(src, 'a.txt')], dst, { onClash: 'keep' });
  assert.equal(r.ok, true);
  assert.equal(read(path.join(dst, 'a.txt')), 'OLD');
  assert.equal(read(path.join(dst, 'a (2).txt')), 'OLD2');
  assert.equal(read(path.join(dst, 'a (3).txt')), 'NEW');
});

test('clash replace: the old file goes to ~/.rigs/trash, the new one takes its place', async () => {
  const { src, dst } = fresh();
  put(path.join(src, 'only-here.txt'), 'NEW'); put(path.join(dst, 'only-here.txt'), 'OLD');
  const r = await transfer('move', [path.join(src, 'only-here.txt')], dst, { onClash: 'replace' });
  assert.equal(r.ok, true);
  assert.equal(r.done[0].trashed, true);
  assert.equal(read(path.join(dst, 'only-here.txt')), 'NEW');
  const t = trashed().find((x) => x.endsWith('-only-here.txt'));
  assert.ok(t, 'the replaced file is in the trash');
  assert.equal(read(path.join(process.env.RIGS_HOME, 'trash', t)), 'OLD');
});

test('clash skip: the existing file is untouched and the source stays', async () => {
  const { src, dst } = fresh();
  put(path.join(src, 'a.txt'), 'NEW'); put(path.join(src, 'b.txt'), 'B'); put(path.join(dst, 'a.txt'), 'OLD');
  const r = await transfer('move', [path.join(src, 'a.txt'), path.join(src, 'b.txt')], dst, { onClash: 'skip' });
  assert.equal(r.ok, true);
  assert.equal(read(path.join(dst, 'a.txt')), 'OLD');
  assert.equal(read(path.join(src, 'a.txt')), 'NEW');
  assert.equal(read(path.join(dst, 'b.txt')), 'B');
  assert.deepEqual(r.skipped.map((s) => path.basename(s.from)), ['a.txt']);
  await assert.rejects(transfer('move', [path.join(src, 'a.txt')], dst, { onClash: 'overwrite' }), (e) => e.status === 400);
});

test('a move onto where it already is does nothing; a copy beside itself makes a " (2)" duplicate', async () => {
  const { src } = fresh();
  put(path.join(src, 'a.txt'), 'A');
  const m = await transfer('move', [path.join(src, 'a.txt')], src);
  assert.equal(m.ok, true);
  assert.equal(m.done.length, 0);
  assert.equal(read(path.join(src, 'a.txt')), 'A');
  const c = await transfer('copy', [path.join(src, 'a.txt')], src);
  assert.equal(c.ok, true);
  assert.equal(read(path.join(src, 'a (2).txt')), 'A');
});

test('undo of a move: moving back with an explicit name restores the original', async () => {
  const { src, dst } = fresh();
  put(path.join(src, 'a.txt'), 'A');
  const r = await transfer('move', [path.join(src, 'a.txt')], dst);
  const back = await transfer('move', [{ from: r.done[0].to, name: 'a.txt' }], src);
  assert.equal(back.ok, true);
  assert.equal(read(path.join(src, 'a.txt')), 'A');
  assert.ok(!fs.existsSync(path.join(dst, 'a.txt')));
});

// ------------------------------------------------------------------ pull (the other machine is a fake source)

test('pull: streams files and folders from a source, tracks progress, honours the clash policy', async () => {
  const { src, dst } = fresh();
  put(path.join(src, 'big.bin'), 'x'.repeat(300000)); put(path.join(src, 'dir/a.txt'), 'A'); put(path.join(src, 'dir/deep/b.txt'), 'B');
  const r = await pull(localSource(), [path.join(src, 'big.bin'), path.join(src, 'dir')], dst, { id: 'job-1' });
  assert.equal(r.ok, true);
  assert.equal(fs.statSync(path.join(dst, 'big.bin')).size, 300000);
  assert.equal(read(path.join(dst, 'dir/deep/b.txt')), 'B');
  assert.ok(fs.existsSync(path.join(src, 'big.bin')), 'a pull copies');
  const j = progressOf('job-1');
  assert.equal(j.done, true);
  assert.equal(j.bytes, 300002);
  assert.equal(j.total, 300002);
  assert.deepEqual(fs.readdirSync(dst).filter((f) => f.includes('.rigs-upload-')), [], 'no temp files left');

  const c = await pull(localSource(), [path.join(src, 'big.bin')], dst);
  assert.equal(c.ok, false);
  assert.deepEqual(c.clashes.map((x) => x.name), ['big.bin']);
  const k = await pull(localSource(), [path.join(src, 'big.bin')], dst, { onClash: 'keep' });
  assert.ok(k.ok && fs.existsSync(path.join(dst, 'big (2).bin')));
  put(path.join(dst, 'dir/a.txt'), 'LOCAL-EDIT');
  const rep = await pull(localSource(), [path.join(src, 'dir')], dst, { onClash: 'replace' });
  assert.ok(rep.ok);
  assert.equal(read(path.join(dst, 'dir/a.txt')), 'A');
  assert.ok(trashed().some((x) => x.endsWith('-dir')), 'the replaced folder went to the trash');
});

test('pull: refuses an escaping destination, a bad path list and a source name that is a path', async () => {
  const { src, dst, d } = fresh();
  put(path.join(src, 'a.txt'), 'A');
  await assert.rejects(pull(localSource(), [path.join(src, 'a.txt')], dst + '/../src'), (e) => e.status === 400);
  await assert.rejects(pull(localSource(), [], dst), (e) => e.status === 400);
  await assert.rejects(pull(localSource(), [path.join(src, 'missing')], dst), (e) => /ENOENT|not found/.test(e.message));
  const evil = { ...localSource(), stat: async () => ({ path: '/x', name: '../../evil.txt', type: 'file', size: 1 }), read: async () => { throw new Error('should not read'); } };
  await assert.rejects(pull(evil, ['/x'], dst), (e) => e.status === 400);
  const evilList = { ...localSource(), list: async () => [{ name: '../evil', path: path.join(src, 'a.txt'), type: 'file', size: 1 }] };
  await assert.rejects(pull(evilList, [src], dst), (e) => e.status === 400);
  assert.ok(!fs.existsSync(path.join(d, 'evil.txt')) && !fs.existsSync(path.join(d, 'evil')));
});
