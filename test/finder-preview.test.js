// Preview pane + Quick Look: viewer selection and the pure helpers (ui/src/preview-model.js), HTTP Range on
// files/raw (src/files.js parseRange/sendFile) locally, and through the peer proxy (/api/nodes/<peer>/files/raw).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  fmtTime, highlight, isMedia, langOf, parseInline, parseMarkdown, progressOf, quickLookSet, quickLookStep, safeHref, seekTime, skipTime, viewerFor,
} from '../ui/src/preview-model.js';
import { mimeOf, parseRange } from '../src/files.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const f = (name, size = 10, type = 'file') => ({ name, path: `/x/${name}`, size, type });

// ------------------------------------------------------------------ viewer selection

test('viewerFor: picks the viewer by kind and extension', () => {
  const k = (name, size) => viewerFor(f(name, size));
  for (const n of ['a.png', 'a.JPG', 'a.jpeg', 'a.gif', 'a.webp', 'a.svg', 'a.avif']) assert.equal(k(n), 'image', n);
  for (const n of ['a.mp4', 'a.mov', 'a.webm', 'a.mkv', 'a.m4v']) assert.equal(k(n), 'video', n);
  for (const n of ['a.mp3', 'a.m4a', 'a.wav', 'a.flac', 'a.ogg', 'a.opus']) assert.equal(k(n), 'audio', n);
  assert.equal(k('a.pdf'), 'pdf');
  assert.equal(k('README.md'), 'markdown');
  for (const n of ['a.js', 'a.py', 'a.json', 'a.yml', 'a.txt', 'a.css', 'a.sh']) assert.equal(k(n), 'text', n);
  assert.equal(k('Makefile'), 'text', 'no extension = text');
  assert.equal(k('a.zip'), 'info');
  assert.equal(k('a.dmg'), 'info');
  assert.equal(viewerFor(f('src', 0, 'dir')), 'folder');
  assert.equal(viewerFor(null), 'none');
});

test('viewerFor: a text file too large to read falls back to the info card, media does not', () => {
  assert.equal(viewerFor(f('big.log', 5 * 1024 * 1024)), 'info');
  assert.equal(viewerFor(f('big.md', 5 * 1024 * 1024)), 'info');
  assert.equal(viewerFor(f('big.mp4', 5 * 1024 * 1024 * 1024)), 'video');
  assert.ok(isMedia(f('a.mp3')) && isMedia(f('a.mp4')) && !isMedia(f('a.png')));
});

test('langOf: groups languages for the highlighter', () => {
  assert.equal(langOf('a.ts'), 'c');
  assert.equal(langOf('a.py'), 'hash');
  assert.equal(langOf('a.json'), 'json');
  assert.equal(langOf('a.html'), 'markup');
  assert.equal(langOf('a.txt'), 'plain');
});

// ------------------------------------------------------------------ transport maths

test('fmtTime, seekTime, progressOf, skipTime', () => {
  assert.equal(fmtTime(0), '0:00');
  assert.equal(fmtTime(83.9), '1:23');
  assert.equal(fmtTime(3723), '1:02:03');
  assert.equal(fmtTime(NaN), '--:--');
  assert.equal(fmtTime(Infinity), '--:--');
  assert.equal(seekTime(0.5, 200), 100);
  assert.equal(seekTime(2, 200), 200, 'clamped to the end');
  assert.equal(seekTime(-1, 200), 0);
  assert.equal(seekTime(0.5, NaN), 0, 'unknown duration: stay at the start');
  assert.equal(progressOf(50, 200), 0.25);
  assert.equal(progressOf(5, 0), 0);
  assert.equal(skipTime(3, -5, 100), 0);
  assert.equal(skipTime(98, 5, 100), 100);
  assert.equal(skipTime(10, 5, NaN), 15);
});

// ------------------------------------------------------------------ Quick Look

test('quickLookSet: several picked → step through them; one picked → through the folder\'s files; a folder → nothing', () => {
  const a = f('a.png'); const b = f('b.mp3'); const c = f('c.txt'); const d = f('dir', 0, 'dir');
  const shown = [d, a, b, c];
  assert.deepEqual(quickLookSet([a, c], shown, a), { list: [a, c], index: 0 });
  const one = quickLookSet([b], shown, b);
  assert.deepEqual(one.list, [a, b, c]);
  assert.equal(one.index, 1);
  assert.equal(quickLookSet([d], shown, d), null);
  assert.equal(quickLookSet([], shown, null), null);
});

test('quickLookStep: arrows move and wrap', () => {
  assert.equal(quickLookStep(0, 3, 'ArrowRight'), 1);
  assert.equal(quickLookStep(2, 3, 'ArrowRight'), 0);
  assert.equal(quickLookStep(0, 3, 'ArrowLeft'), 2);
  assert.equal(quickLookStep(1, 3, 'ArrowDown'), 2);
  assert.equal(quickLookStep(1, 3, 'ArrowUp'), 0);
  assert.equal(quickLookStep(0, 0, 'ArrowRight'), 0);
});

// ------------------------------------------------------------------ highlighter and Markdown

test('highlight: keywords, strings, comments and numbers; joins back to the source; never throws', () => {
  const src = 'const x = 42; // hi\nlet s = "a\\"b"; /* c */ foo(1.5)';
  const runs = highlight(src, 'c');
  assert.equal(runs.map((r) => r.s).join(''), src);
  const at = (t) => runs.filter((r) => r.t === t).map((r) => r.s);
  assert.deepEqual(at('kw'), ['const', 'let']);
  assert.deepEqual(at('num'), ['42', '1.5']);
  assert.deepEqual(at('com'), ['// hi', '/* c */']);
  assert.deepEqual(at('str'), ['"a\\"b"']);
  assert.deepEqual(highlight('# note\nx = 1', 'hash').filter((r) => r.t === 'com').map((r) => r.s), ['# note']);
  assert.deepEqual(highlight('anything "here"', 'plain'), [{ t: '', s: 'anything "here"' }]);
  const odd = '"unterminated\n/* open';
  assert.equal(highlight(odd, 'c').map((r) => r.s).join(''), odd);
  assert.equal(highlight(null, 'c').length, 0);
});

test('parseMarkdown: headings, paragraphs, lists, code fences, quotes, tables, rules', () => {
  const md = ['# Title', '', 'one', 'two', '', '- a', '- b', '', '1. x', '2. y', '', '```js', 'let a;', '```', '', '> quoted', '', '---', '', '| h1 | h2 |', '| -- | -- |', '| 1 | 2 |'].join('\n');
  const b = parseMarkdown(md);
  assert.deepEqual(b.map((x) => x.type), ['h', 'p', 'ul', 'ol', 'code', 'quote', 'hr', 'table']);
  assert.deepEqual(b[0], { type: 'h', level: 1, text: 'Title' });
  assert.equal(b[1].text, 'one\ntwo');
  assert.deepEqual(b[2].items, ['a', 'b']);
  assert.deepEqual(b[4], { type: 'code', lang: 'js', text: 'let a;' });
  assert.deepEqual(b[7], { type: 'table', head: ['h1', 'h2'], rows: [['1', '2']] });
});

test('parseInline: code, bold, italic, links; script links are dropped', () => {
  const r = parseInline('a **b** `c` *d* [e](https://x.y/z) [bad](javascript:alert(1))');
  assert.deepEqual(r.filter((x) => x.t !== 'text').map((x) => [x.t, x.s]), [['strong', 'b'], ['code', 'c'], ['em', 'd'], ['link', 'e'], ['link', 'bad']]);
  assert.equal(r.find((x) => x.s === 'e').href, 'https://x.y/z');
  assert.equal(r.find((x) => x.s === 'bad').href, '', 'javascript: is not a link');
  assert.equal(safeHref('javascript:alert(1)'), '');
  assert.equal(safeHref('data:text/html,x'), '');
  assert.equal(safeHref('./notes.md'), './notes.md');
});

// ------------------------------------------------------------------ Range: parser and content types

test('parseRange: open-ended, bounded, suffix, clamped, unsatisfiable and ignored headers', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 }, 'suffix longer than the file = all of it');
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 }, 'end clamped to the file');
  assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=50-10', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', 1000), 'unsatisfiable');
  assert.equal(parseRange(undefined, 1000), null);
  assert.equal(parseRange('items=0-5', 1000), null);
  assert.equal(parseRange('bytes=0-5,10-20', 1000), null, 'multi-range → the whole file');
  assert.equal(parseRange('bytes=-', 1000), null);
});

test('mimeOf: audio and video types the player needs', () => {
  const m = { 'a.mp3': 'audio/mpeg', 'a.m4a': 'audio/mp4', 'a.wav': 'audio/wav', 'a.flac': 'audio/flac', 'a.ogg': 'audio/ogg', 'a.mp4': 'video/mp4', 'a.mov': 'video/quicktime', 'a.webm': 'video/webm', 'a.mkv': 'video/x-matroska', 'a.pdf': 'application/pdf' };
  for (const [n, t] of Object.entries(m)) assert.equal(mimeOf(n), t, n);
});

// ------------------------------------------------------------------ Range over HTTP: local daemon and via the peer proxy

const TOKEN = 'range-token';
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-range-'));
const procs = [];
let A; let B; let BIG; let DATA;

function daemon(name, port, extraEnv = {}) {
  const home = path.join(TMP, `home-${name}`);
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env, RIGS_NO_MIGRATIONS: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_OPENRIG: '1', RIGS_HOME: home, RIGS_SSH_DIR: path.join(home, 'ssh'), RIGS_PORT: String(port), RIGS_NAME: name, RIGS_PEERS: '', RIGS_MESH_TOKEN: TOKEN, RIGS_BIND: '127.0.0.1', RIGS_NO_SYSTEMD: '1', ...extraEnv };
  const p = spawn(process.execPath, [path.join(ROOT, 'bin/rigs.js'), 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = '';
  p.stdout.on('data', (d) => { p.log += d; });
  p.stderr.on('data', (d) => { p.log += d; });
  procs.push(p);
  return p;
}
async function waitFor(fn, what, proc) {
  for (let i = 0; i < 150; i++) { try { if (await fn()) return; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  throw new Error(`${what} never became ready\n${proc?.log || ''}`);
}

before(async () => {
  DATA = crypto.randomBytes(3 * 1024 * 1024 + 17);
  BIG = path.join(TMP, 'clip.mp4');
  fs.writeFileSync(BIG, DATA);
  fs.writeFileSync(path.join(TMP, 'song.m4a'), DATA.subarray(0, 4096));
  const [pa, pb] = [await freePort(), await freePort()];
  const b = daemon('range-peer', pb);
  await waitFor(async () => (await fetch(`http://127.0.0.1:${pb}/api/self`)).ok, 'range-peer', b);
  const a = daemon('range-front', pa, { RIGS_PEERS: `http://127.0.0.1:${pb}` });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${pa}/api/self`)).ok, 'range-front', a);
  await waitFor(async () => (await (await fetch(`http://127.0.0.1:${pa}/api/mesh/refresh`, { method: 'POST' })).json()).some((n) => n.name === 'range-peer' && n.online && n.rigs), 'front discovering range-peer', a);
  A = `http://127.0.0.1:${pa}`;
  B = `http://127.0.0.1:${pb}`;
});
after(() => { for (const p of procs) p.kill(); fs.rmSync(TMP, { recursive: true, force: true }); });

const raw = (base, p = BIG, headers = {}) => fetch(`${base}/files/raw?path=${encodeURIComponent(p)}`, { headers });

for (const [label, base] of [['locally', () => `${A}/api/local`], ['through the peer proxy (/api/nodes/range-peer)', () => `${A}/api/nodes/range-peer`], ['on the peer itself', () => `${B}/api/local`]]) {
  test(`files/raw ${label}: Range bytes=1000000- → 206 with Content-Range, the right bytes`, async () => {
    const r = await raw(base(), BIG, { range: 'bytes=1000000-' });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), `bytes 1000000-${DATA.length - 1}/${DATA.length}`);
    assert.equal(r.headers.get('content-length'), String(DATA.length - 1000000));
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
    assert.equal(r.headers.get('content-type'), 'video/mp4');
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(DATA.subarray(1000000)));
  });

  test(`files/raw ${label}: a bounded range and a suffix range return exactly those bytes`, async () => {
    const mid = await raw(base(), BIG, { range: 'bytes=1500000-1500999' });
    assert.equal(mid.status, 206);
    assert.equal(mid.headers.get('content-length'), '1000');
    assert.ok(Buffer.from(await mid.arrayBuffer()).equals(DATA.subarray(1500000, 1501000)));
    const tail = await raw(base(), BIG, { range: 'bytes=-500' });
    assert.equal(tail.status, 206);
    assert.ok(Buffer.from(await tail.arrayBuffer()).equals(DATA.subarray(DATA.length - 500)));
  });

  test(`files/raw ${label}: no Range → 200 with Accept-Ranges and the whole file; past the end → 416`, async () => {
    const whole = await raw(base(), path.join(TMP, 'song.m4a'));
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('accept-ranges'), 'bytes');
    assert.equal(whole.headers.get('content-type'), 'audio/mp4');
    assert.equal((await whole.arrayBuffer()).byteLength, 4096);
    const past = await raw(base(), BIG, { range: `bytes=${DATA.length + 5}-` });
    assert.equal(past.status, 416);
    assert.equal(past.headers.get('content-range'), `bytes */${DATA.length}`);
    await past.arrayBuffer();
  });
}
