// Built-in file tools: the pure models (ui/src/file-tools-model.js, src/zip-model.js), zip/unzip in src/files.js on a
// temp folder, and the HTTP routes POST /api/local/files/zip | unzip on a throwaway node.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import {
  TOOLS, actionTargets, checkJSON, clickSelect, compareCells, editorTitle, fitScale, imageSiblings, isSaveKey, isZip,
  jsonChildren, jsonSummary, lineCol, locateJsonError, nextSort, parseCSV, sniffDelimiter, sortRows, stepIndex, toolFor,
  toolsFor, zoomStep,
} from '../ui/src/file-tools-model.js';
import { archiveName, extractFolderName, planExtract, safeEntryPath, splitExt, uniqueName, zipLimits } from '../src/zip-model.js';
import * as files from '../src/files.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-file-tools-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const dir = (name) => { const d = path.join(TMP, name); fs.mkdirSync(d, { recursive: true }); return d; };
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

// ------------------------------------------------------------------ which tool opens what

test('toolFor: double-click opens txt/md in the editor, png/jpg in the image viewer, pdf, csv and json in theirs', () => {
  assert.equal(toolFor('notes.txt'), 'text');
  assert.equal(toolFor('README.md'), 'text');
  assert.equal(toolFor('photo.PNG'), 'image');
  assert.equal(toolFor('photo.jpg'), 'image');
  assert.equal(toolFor('/a/b/scan.jpeg'), 'image');
  assert.equal(toolFor('report.pdf'), 'pdf');
  assert.equal(toolFor('data.csv'), 'csv');
  assert.equal(toolFor('data.tsv'), 'csv');
  assert.equal(toolFor('package.json'), 'json');
  assert.equal(toolFor('Makefile'), 'text', 'no extension = text');
  assert.equal(toolFor('.bashrc'), 'text');
  assert.equal(toolFor('server.js'), 'text');
  assert.equal(toolFor('movie.mp4'), 'media', 'audio and video: the media player');
  assert.equal(toolFor('archive.zip'), null);
  assert.ok(isZip('x/Archive.ZIP'));
  assert.ok(!isZip('zip.txt'));
});

test('toolsFor: "Open with" lists the default tool first, plus the text editor for text formats', () => {
  assert.deepEqual(toolsFor('a.csv'), ['csv', 'text']);
  assert.deepEqual(toolsFor('a.json'), ['json', 'text']);
  assert.deepEqual(toolsFor('a.svg'), ['image', 'text']);
  assert.deepEqual(toolsFor('a.png'), ['image']);
  assert.deepEqual(toolsFor('a.pdf'), ['pdf']);
  assert.deepEqual(toolsFor('a.md'), ['text']);
  assert.deepEqual(toolsFor('a.bin'), []);
  for (const id of ['text', 'image', 'pdf', 'csv', 'json']) assert.ok(TOOLS[id].label && TOOLS[id].icon);
});

// ------------------------------------------------------------------ CSV

test('parseCSV handles quoted commas, doubled quotes, newlines in quotes, CRLF, a BOM and a trailing newline', () => {
  const text = '\uFEFFname,quote,n\r\n"Smith, John","He said ""hi""",1\r\n"multi\nline",plain,2\n,,\n';
  const { rows, truncated } = parseCSV(text);
  assert.equal(truncated, false);
  assert.deepEqual(rows, [
    ['name', 'quote', 'n'],
    ['Smith, John', 'He said "hi"', '1'],
    ['multi\nline', 'plain', '2'],
    ['', '', ''],
  ]);
  assert.deepEqual(parseCSV('a;b\n"x;y";z', { delimiter: ';' }).rows, [['a', 'b'], ['x;y', 'z']]);
  assert.deepEqual(parseCSV('a\tb\n1\t2', { delimiter: '\t' }).rows, [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCSV('"unterminated,still').rows, [['unterminated,still']], 'an open quote runs to the end');
  assert.deepEqual(parseCSV('').rows, []);
});

test('parseCSV shows only the first N rows of a large file', () => {
  const big = Array.from({ length: 5000 }, (_, i) => `${i},row ${i}`).join('\n');
  const r = parseCSV(big, { maxRows: 100 });
  assert.equal(r.rows.length, 100);
  assert.equal(r.truncated, true);
  assert.deepEqual(r.rows[99], ['99', 'row 99']);
  assert.equal(parseCSV('a\nb\n', { maxRows: 2 }).truncated, false, 'exactly N rows is not truncated');
});

test('sniffDelimiter picks the delimiter that splits lines evenly; .tsv is tab', () => {
  assert.equal(sniffDelimiter('a,b,c\n1,2,3\n4,5,6'), ',');
  assert.equal(sniffDelimiter('a;b;c\n1,5;2;3\n4;5;6'), ';');
  assert.equal(sniffDelimiter('a\tb\n1\t2'), '\t');
  assert.equal(sniffDelimiter('a|b|c\n1|2|3'), '|');
  assert.equal(sniffDelimiter('"x, y";b\n"1, 2";3'), ';', 'commas inside quotes do not count');
  assert.equal(sniffDelimiter('anything', 'f.tsv'), '\t');
  assert.equal(sniffDelimiter('single column\nrows'), ',');
});

test('CSV sorting: numbers numerically, text naturally, empty cells last, stable; header click cycles asc → desc → off', () => {
  const rows = [['b', '10'], ['a', '9'], ['c', ''], ['a2', '100'], ['a10', '-1']];
  assert.deepEqual(sortRows(rows, 1, 'asc').map((r) => r[1]), ['-1', '9', '10', '100', '']);
  assert.deepEqual(sortRows(rows, 1, 'desc').map((r) => r[1]), ['100', '10', '9', '-1', '']);
  assert.deepEqual(sortRows(rows, 0, 'asc').map((r) => r[0]), ['a', 'a2', 'a10', 'b', 'c']);
  assert.deepEqual(rows[0], ['b', '10'], 'input untouched');
  assert.ok(compareCells('2', '10') < 0);
  assert.ok(compareCells('1,5', '2') < 0, 'decimal comma');
  assert.deepEqual(nextSort(null, 2), { col: 2, dir: 'asc' });
  assert.deepEqual(nextSort({ col: 2, dir: 'asc' }, 2), { col: 2, dir: 'desc' });
  assert.equal(nextSort({ col: 2, dir: 'desc' }, 2), null);
  assert.deepEqual(nextSort({ col: 2, dir: 'desc' }, 0), { col: 0, dir: 'asc' });
});

// ------------------------------------------------------------------ JSON

test('checkJSON: valid JSON parses; invalid JSON reports message, line and column of the error', () => {
  assert.deepEqual(checkJSON('{"a":[1,2,{"b":null}]}'), { ok: true, value: { a: [1, 2, { b: null }] } });
  assert.equal(checkJSON('\uFEFF[1]').ok, true, 'BOM ignored');

  const missingComma = checkJSON('{\n  "a": 1\n  "b": 2\n}');
  assert.equal(missingComma.ok, false);
  assert.deepEqual([missingComma.line, missingComma.col], [3, 3]);
  assert.match(missingComma.message, /Expected ',' or '}'/);
  assert.equal(missingComma.lineText, '  "b": 2');

  const trailing = checkJSON('[1, 2,]');
  assert.deepEqual([trailing.line, trailing.col], [1, 7]);
  assert.match(trailing.message, /Trailing comma/);

  const single = checkJSON("{'a': 1}");
  assert.deepEqual([single.line, single.col], [1, 2]);
  assert.match(single.message, /property name/);

  const end = checkJSON('{"a": [1, 2');
  assert.match(end.message, /end of input/);
  assert.equal(end.offset, 11);

  assert.match(checkJSON('{"a": tru}').message, /Unexpected character/);
  assert.match(checkJSON('{"a": 1} x').message, /after the JSON value/);
  assert.match(checkJSON('"bad \\q escape"').message, /Bad escape/);
  assert.match(checkJSON('"raw\nnewline"').message, /Control character/);
  assert.match(checkJSON('01').message, /after the JSON value/);
  assert.match(checkJSON('').message, /end of input/);
  for (const ok of ['0', '-1.5e+3', '"\\u00e9"', 'true', 'null', '[]', '{}', ' [ { } ] ']) assert.equal(locateJsonError(ok), null, ok);
  assert.deepEqual(lineCol('ab\ncd', 4), { line: 2, col: 2 });
});

test('JSON tree helpers: summaries and capped children', () => {
  assert.equal(jsonSummary([1, 2, 3]), '[3 items]');
  assert.equal(jsonSummary([1]), '[1 item]');
  assert.equal(jsonSummary({ a: 1, b: 2 }), '{2 keys}');
  assert.equal(jsonSummary('x'), '"x"');
  const c = jsonChildren(Array.from({ length: 1200 }, (_, i) => i), 500);
  assert.equal(c.items.length, 500);
  assert.equal(c.more, 700);
  assert.deepEqual(jsonChildren({ a: 1 }).items, [['a', 1]]);
});

// ------------------------------------------------------------------ images, editor, selection

test('image viewer: siblings in the folder, wrap-around stepping, zoom steps and fit', () => {
  const entries = [{ name: 'd', path: '/p/d', type: 'dir' }, { name: 'a.png', path: '/p/a.png', type: 'file' }, { name: 'n.txt', path: '/p/n.txt', type: 'file' }, { name: 'b.JPG', path: '/p/b.JPG', type: 'file' }];
  const s = imageSiblings(entries, '/p/b.JPG');
  assert.deepEqual(s.list.map((e) => e.name), ['a.png', 'b.JPG']);
  assert.equal(s.index, 1);
  assert.equal(stepIndex(1, 2, 1), 0);
  assert.equal(stepIndex(0, 2, -1), 1);
  assert.equal(stepIndex(0, 0, 1), 0);
  assert.equal(zoomStep(1, 1), 1.5);
  assert.equal(zoomStep(1, -1), 0.75);
  assert.equal(zoomStep(0.33, 1), 0.5);
  assert.equal(zoomStep(8, 1), 8);
  assert.equal(zoomStep(0.1, -1), 0.1);
  assert.equal(fitScale(2000, 1000, 1000, 1000), 0.5);
  assert.equal(fitScale(100, 100, 1000, 1000), 1, 'never enlarges');
});

test('text editor: Ctrl/⌘+S is save, dirty marker in the title', () => {
  assert.ok(isSaveKey({ ctrlKey: true, key: 's' }));
  assert.ok(isSaveKey({ metaKey: true, key: 'S' }));
  assert.ok(!isSaveKey({ key: 's' }));
  assert.ok(!isSaveKey({ ctrlKey: true, altKey: true, key: 's' }));
  assert.equal(editorTitle('a.md', true), '● a.md');
  assert.equal(editorTitle('a.md', false), 'a.md');
});

test('file browser selection: plain click, Ctrl/⌘ toggle, Shift range; menu actions use the selection when the row is in it', () => {
  const paths = ['/a', '/b', '/c', '/d'];
  let s = clickSelect({}, paths, '/b');
  assert.deepEqual(s, { picked: ['/b'], anchor: '/b' });
  s = clickSelect(s, paths, '/d', { ctrl: true });
  assert.deepEqual(s.picked, ['/b', '/d']);
  s = clickSelect(s, paths, '/b', { ctrl: true });
  assert.deepEqual(s.picked, ['/d']);
  s = clickSelect({ picked: ['/b'], anchor: '/b' }, paths, '/d', { shift: true });
  assert.deepEqual(s.picked, ['/b', '/c', '/d']);
  assert.deepEqual(actionTargets(s.picked, '/c'), ['/b', '/c', '/d']);
  assert.deepEqual(actionTargets(s.picked, '/a'), ['/a'], 'a row outside the selection acts alone');
});

// ------------------------------------------------------------------ zip rules

test('safeEntryPath refuses zip-slip: .., absolute, drive letters, UNC, control characters, device names', () => {
  assert.equal(safeEntryPath('a/b.txt'), 'a/b.txt');
  assert.equal(safeEntryPath('./a//b.txt'), 'a/b.txt');
  assert.equal(safeEntryPath('dir/'), 'dir/');
  assert.equal(safeEntryPath('a\\b.txt'), 'a/b.txt', 'backslash = separator');
  for (const bad of ['../evil.txt', 'a/../../evil', 'a/..', '..', '/etc/passwd', '\\evil', 'C:\\x', 'c:x', '//server/share/x', 'a\u0000b', 'a\\..\\..\\x', 'nul', 'a/CON.txt', 'a:b', '', '.', 'trail.', null]) {
    assert.equal(safeEntryPath(bad), null, JSON.stringify(bad));
  }
});

test('uniqueName never overwrites: "name (2).ext", keeps double extensions, folders get a plain suffix', () => {
  const taken = new Set(['a.txt', 'a (2).txt', 'x.tar.gz', 'photos', '.env']);
  const has = (n) => taken.has(n);
  assert.equal(uniqueName('b.txt', has), 'b.txt');
  assert.equal(uniqueName('a.txt', has), 'a (3).txt');
  assert.equal(uniqueName('x.tar.gz', has), 'x (2).tar.gz');
  assert.equal(uniqueName('photos', has), 'photos (2)');
  assert.equal(uniqueName('.env', has), '.env (2)');
  assert.equal(uniqueName('x.tar.gz', has, { dir: true }), 'x.tar.gz (2)', 'a folder keeps its whole name');
  assert.deepEqual(splitExt('report.final.csv'), ['report.final', '.csv']);
  assert.equal(archiveName(['/x/photos/']), 'photos.zip');
  assert.equal(archiveName(['/x/a.txt', '/x/b.txt']), 'Archive.zip');
  assert.equal(extractFolderName('/x/photos.zip'), 'photos');
  assert.equal(extractFolderName('/x/weird'), 'weird contents');
});

test('planExtract checks names, entry count and the declared size before anything is inflated', () => {
  const ok = planExtract([{ name: 'a/', originalSize: 0 }, { name: 'a/b.txt', originalSize: 5 }]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.entries.map((e) => [e.path, e.dir]), [['a', true], ['a/b.txt', false]]);
  assert.match(planExtract([{ name: '../x', originalSize: 1 }]).error, /unsafe path/);
  assert.match(planExtract([{ name: 'big', originalSize: 2048 }], { maxBytes: 1024, maxEntries: 10 }).error, /size cap/);
  assert.match(planExtract([{ name: 'a' }, { name: 'b' }], { maxBytes: 1e9, maxEntries: 1 }).error, /limit is 1/);
  assert.deepEqual(zipLimits({}), { maxBytes: 512 * 1024 * 1024, maxEntries: 20000 });
  assert.deepEqual(zipLimits({ maxBytes: 5000, maxEntries: 'x' }), { maxBytes: 5000, maxEntries: 20000 });
});

// ------------------------------------------------------------------ zip / unzip on disk

test('zip a selection, then unzip: the files round-trip; nothing is overwritten', async () => {
  const d = dir('roundtrip');
  write(path.join(d, 'a.txt'), 'alpha');
  write(path.join(d, 'sub/b.csv'), 'x,y\n1,2\n');
  write(path.join(d, 'sub/deep/c.json'), '{"c":true}');
  fs.mkdirSync(path.join(d, 'sub/empty'));
  write(path.join(d, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));

  const z = await files.zip([path.join(d, 'a.txt'), path.join(d, 'sub'), path.join(d, 'img.png')]);
  assert.equal(z.path, path.join(d, 'Archive.zip'));
  assert.equal(z.files, 4);
  const z2 = await files.zip([path.join(d, 'a.txt'), path.join(d, 'sub'), path.join(d, 'img.png')]);
  assert.equal(z2.path, path.join(d, 'Archive (2).zip'), 'second archive gets a suffix');

  const u = await files.unzip(z.path);
  assert.equal(u.path, path.join(d, 'Archive'));
  assert.equal(u.files, 4);
  assert.equal(fs.readFileSync(path.join(u.path, 'a.txt'), 'utf8'), 'alpha');
  assert.equal(fs.readFileSync(path.join(u.path, 'sub/b.csv'), 'utf8'), 'x,y\n1,2\n');
  assert.equal(fs.readFileSync(path.join(u.path, 'sub/deep/c.json'), 'utf8'), '{"c":true}');
  assert.deepEqual([...fs.readFileSync(path.join(u.path, 'img.png'))], [0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
  assert.ok(fs.statSync(path.join(u.path, 'sub/empty')).isDirectory(), 'empty folders survive');

  write(path.join(d, 'solo.csv'), 'a,b\n');
  const solo = await files.zip([path.join(d, 'solo.csv')]);
  assert.equal(path.basename((await files.unzip(solo.path)).path), 'solo.csv (2)', 'the folder for solo.csv.zip does not clash with solo.csv');
  const again = await files.unzip(z.path);
  assert.equal(again.path, path.join(d, 'Archive (2)'), 'a second extract goes into a new folder');

  // Extracting into an existing folder renames clashing files instead of overwriting them.
  const into = await files.unzip(z.path, u.path);
  assert.equal(into.renamed.length, 4);
  assert.equal(fs.readFileSync(path.join(u.path, 'a (2).txt'), 'utf8'), 'alpha');
  assert.equal(fs.readFileSync(path.join(u.path, 'a.txt'), 'utf8'), 'alpha');

  const one = await files.zip([path.join(d, 'sub')], path.join(d, 'named'));
  assert.equal(one.path, path.join(d, 'named.zip'));
  const intoDir = await files.zip([path.join(d, 'a.txt')], dir('roundtrip/out'));
  assert.equal(intoDir.path, path.join(d, 'out', 'a.txt.zip'));
});

test('unzip rejects an archive with ../ or absolute entries and writes nothing', async () => {
  const d = dir('slip');
  for (const [i, evil] of ['../evil.txt', '/abs-evil.txt', 'ok/../../evil2.txt', 'C:\\evil3.txt'].entries()) {
    const zipPath = path.join(d, `bad${i}.zip`);
    fs.writeFileSync(zipPath, zipSync({ 'fine.txt': strToU8('ok'), [evil]: strToU8('pwned') }));
    await assert.rejects(files.unzip(zipPath), (e) => e.status === 400 && /unsafe path/.test(e.message), evil);
    assert.ok(!fs.existsSync(path.join(d, `bad${i}`)), 'no folder created');
  }
  assert.ok(!fs.existsSync(path.join(TMP, 'evil.txt')));
  assert.ok(!fs.existsSync('/abs-evil.txt'));
});

test('unzip refuses to write through a symlinked folder inside the destination', { skip: process.platform === 'win32' }, async () => {
  const d = dir('symlinked');
  const outside = dir('outside');
  const dest = dir('symlinked/dest');
  fs.symlinkSync(outside, path.join(dest, 'link'));
  const zipPath = path.join(d, 'l.zip');
  fs.writeFileSync(zipPath, zipSync({ 'link/x.txt': strToU8('pwned') }));
  await assert.rejects(files.unzip(zipPath, dest), /symlinked folder/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('zip and unzip enforce the size cap; zip skips symlinks', async () => {
  const d = dir('cap');
  write(path.join(d, 'big.txt'), 'x'.repeat(5000));
  await assert.rejects(files.zip([path.join(d, 'big.txt')], null, { limits: { maxBytes: 1024, maxEntries: 10 } }), (e) => e.status === 413);
  const z = await files.zip([path.join(d, 'big.txt')]);
  await assert.rejects(files.unzip(z.path, null, { limits: { maxBytes: 2048, maxEntries: 10 } }), (e) => e.status === 413 && /size cap/.test(e.message));
  await assert.rejects(files.unzip(path.join(d, 'big.txt')), /not a readable zip/);
  await assert.rejects(files.zip([]), /paths/);
  await assert.rejects(files.zip([path.join(d, 'missing')]), (e) => e.status === 404);
  if (process.platform !== 'win32') {
    const s = dir('cap/withlink');
    write(path.join(s, 'real.txt'), 'r');
    fs.symlinkSync('/etc', path.join(s, 'etc-link'));
    const zl = await files.zip([s]);
    assert.equal(zl.files, 1, 'the symlink is not followed');
  }
});

// ------------------------------------------------------------------ HTTP routes on a throwaway node

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-ft-home-'));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
before(async () => {
  const env = { ...process.env, RIGS_NO_MIGRATIONS: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_OPENRIG: '1', RIGS_HOME: HOME, RIGS_SSH_DIR: path.join(HOME, 'ssh'), RIGS_PORT: String(PORT), RIGS_NAME: 'ft-node', RIGS_PEERS: '', RIGS_MESH_TOKEN: 'ft-token', RIGS_NO_SYSTEMD: '1' };
  server = spawn(process.execPath, [path.join(ROOT, 'bin/rigs.js'), 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout.on('data', (x) => { out += x; });
  server.stderr.on('data', (x) => { out += x; });
  for (let i = 0; i < 100; i++) {
    // Ready once the first discovery pass knows this node, so /api/nodes/self/… resolves.
    try { if ((await fetch(BASE + '/api/nodes/self/files?path=~')).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start:\n' + out);
});
after(() => { server?.kill(); fs.rmSync(HOME, { recursive: true, force: true }); });

const post = (p, body) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('POST /api/local/files/zip and /unzip round-trip over HTTP (and through /api/nodes/self); a slip archive is a 400', async () => {
  const d = dir('http');
  write(path.join(d, 'one.txt'), 'one');
  write(path.join(d, 'two.md'), '# two');
  const z = await post('/api/local/files/zip', { paths: [path.join(d, 'one.txt'), path.join(d, 'two.md')], dest: path.join(d, 'pair.zip') });
  assert.equal(z.status, 200, await z.clone().text());
  const zj = await z.json();
  assert.equal(zj.path, path.join(d, 'pair.zip'));
  const u = await post('/api/nodes/self/files/unzip', { path: zj.path });
  assert.equal(u.status, 200, 'unzip: ' + await u.clone().text());
  const uj = await u.json();
  assert.equal(fs.readFileSync(path.join(uj.path, 'two.md'), 'utf8'), '# two');

  fs.writeFileSync(path.join(d, 'evil.zip'), zipSync({ '../../evil.txt': strToU8('x') }));
  const bad = await post('/api/local/files/unzip', { path: path.join(d, 'evil.zip') });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /unsafe path/);
  assert.equal((await post('/api/local/files/zip', { paths: [] })).status, 400);
});
