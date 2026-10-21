// HTTP Range on files/raw (src/files.js sendFile, parseRange, mimeOf): what <video>/<audio> seeking and Safari/iOS need.
// Pure parsing first, then two real daemons — "front" relays /api/nodes/media-node/files/raw to "media-node" (src/proxy.js
// forwardHttp) — for full, partial, open-ended, suffix, invalid and unsatisfiable ranges and HEAD, locally and via the peer.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-media-unit-'));
const { mimeOf, parseRange } = await import('../src/files.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- pure

test('parseRange: single byte ranges, open end, suffix; null = whole file; past the end = unsatisfiable', () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.equal(parseRange('', 100), null);
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=10-', 100), { start: 10, end: 99 });
  assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 }, 'an end past the file is clamped');
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-500', 100), { start: 0, end: 99 }, 'a suffix longer than the file is the whole file');
  assert.deepEqual(parseRange('BYTES = 5 - 6', 100), { start: 5, end: 6 }, 'case and spaces');
  assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=500-600', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=0-', 0), 'unsatisfiable', 'an empty file has no bytes to give');
  assert.equal(parseRange('bytes=9-2', 100), null, 'malformed (end before start): ignored');
  assert.equal(parseRange('bytes=0-1,5-6', 100), null, 'multi-range: ignored, whole file');
  assert.equal(parseRange('items=0-1', 100), null, 'another unit: ignored');
  assert.equal(parseRange('bytes=-', 100), null);
  assert.equal(parseRange('bytes=a-b', 100), null);
});

test('mimeOf: audio and video types the media player streams', () => {
  const want = {
    'a.mp3': 'audio/mpeg', 'a.m4a': 'audio/mp4', 'a.aac': 'audio/aac', 'a.wav': 'audio/wav', 'a.flac': 'audio/flac', 'a.ogg': 'audio/ogg',
    'a.opus': 'audio/ogg', 'v.mp4': 'video/mp4', 'v.M4V': 'video/mp4', 'v.webm': 'video/webm', 'v.mov': 'video/quicktime',
    'v.mkv': 'video/x-matroska', 'x.bin': 'application/octet-stream',
  };
  for (const [name, type] of Object.entries(want)) assert.equal(mimeOf(name), type, name);
});

// ---------------------------------------------------------------- end to end: local and front → media-node

const TOKEN = 'media-test-token';
const homes = [];
const procs = [];
const B_PORT = 20000 + Math.floor(Math.random() * 20000);
const A_PORT = B_PORT + 1;
const A = `http://127.0.0.1:${A_PORT}`;
const B = `http://127.0.0.1:${B_PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-media-data-'));
const SIZE = 300 * 1024 + 17;
const BYTES = Buffer.from(Array.from({ length: SIZE }, (_, i) => (i * 7 + (i >> 8)) % 256));
const FILE = path.join(DATA, 'clip.mp4');
const SONG = path.join(DATA, 'song.mp3');

function daemon(name, port, extraEnv) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `rigs-media-${name}-`));
  homes.push(home);
  const env = { ...process.env, RIGS_NO_MIGRATIONS: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_OPENRIG: '1', RIGS_HOME: home, RIGS_SSH_DIR: path.join(home, 'ssh'), RIGS_PORT: String(port), RIGS_NAME: name, RIGS_PEERS: '', RIGS_MESH_TOKEN: TOKEN, RIGS_BIND: '127.0.0.1', ...extraEnv };
  const p = spawn(process.execPath, [path.join(ROOT, 'bin/rigs.js'), 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = '';
  p.stdout.on('data', (d) => { p.log += d; });
  p.stderr.on('data', (d) => { p.log += d; });
  procs.push(p);
  return p;
}

async function waitFor(fn, what, proc) {
  for (let i = 0; i < 150; i++) {
    try { if (await fn()) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${what} never became ready\n${proc?.log || ''}`);
}

before(async () => {
  fs.writeFileSync(FILE, BYTES);
  fs.writeFileSync(SONG, BYTES.subarray(0, 4096));
  const b = daemon('media-node', B_PORT);
  await waitFor(async () => (await fetch(B + '/api/self')).ok, 'media-node', b);
  const a = daemon('front', A_PORT, { RIGS_PEERS: `http://127.0.0.1:${B_PORT}` });
  await waitFor(async () => (await fetch(A + '/api/self')).ok, 'front', a);
  await waitFor(async () => {
    const nodes = await (await fetch(A + '/api/mesh/refresh', { method: 'POST' })).json();
    return nodes.some((n) => n.name === 'media-node' && n.online && n.rigs);
  }, 'front discovering media-node', a);
});

after(() => {
  for (const p of procs) p.kill();
  for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(process.env.RIGS_HOME, { recursive: true, force: true });
});

const BASES = {
  local: () => `${B}/api/local/files/raw`,
  self: () => `${B}/api/nodes/self/files/raw`,
  peer: () => `${A}/api/nodes/media-node/files/raw`,
};
const url = (base, p = FILE) => `${BASES[base]()}?path=${encodeURIComponent(p)}`;
const get = (base, range, init = {}) => fetch(url(base, init.path), { method: init.method || 'GET', headers: range ? { range } : {} });

for (const base of Object.keys(BASES)) {
  test(`${base}: no Range → 200 with the whole file, Accept-Ranges and the media type`, async () => {
    const r = await get(base);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
    assert.equal(r.headers.get('content-type'), 'video/mp4');
    assert.equal(Number(r.headers.get('content-length')), SIZE);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(BYTES));
    const song = await get(base, null, { path: SONG });
    assert.equal(song.headers.get('content-type'), 'audio/mpeg');
    await song.arrayBuffer();
  });

  test(`${base}: bytes=0-1023, an open end and a suffix → 206 with Content-Range and exactly those bytes`, async () => {
    const cases = [
      ['bytes=0-1023', 0, 1023],
      ['bytes=100000-', 100000, SIZE - 1],
      ['bytes=-500', SIZE - 500, SIZE - 1],
      ['bytes=200000-99999999', 200000, SIZE - 1],
    ];
    for (const [range, start, end] of cases) {
      const r = await get(base, range);
      assert.equal(r.status, 206, range);
      assert.equal(r.headers.get('content-range'), `bytes ${start}-${end}/${SIZE}`, range);
      assert.equal(Number(r.headers.get('content-length')), end - start + 1, range);
      assert.equal(r.headers.get('content-type'), 'video/mp4', range);
      assert.ok(Buffer.from(await r.arrayBuffer()).equals(BYTES.subarray(start, end + 1)), `${range}: the right slice`);
    }
  });

  test(`${base}: a range past the end → 416 with bytes */size; a malformed one is ignored (200)`, async () => {
    const r = await get(base, `bytes=${SIZE}-`);
    assert.equal(r.status, 416);
    assert.equal(r.headers.get('content-range'), `bytes */${SIZE}`);
    assert.equal((await r.arrayBuffer()).byteLength, 0);
    const bad = await get(base, 'bytes=9-2');
    assert.equal(bad.status, 200);
    assert.equal((await bad.arrayBuffer()).byteLength, SIZE);
  });

  test(`${base}: HEAD → the headers (length, ranges) and no body, also for a range`, async () => {
    const r = await get(base, null, { method: 'HEAD' });
    assert.equal(r.status, 200);
    assert.equal(Number(r.headers.get('content-length')), SIZE);
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
    assert.equal((await r.arrayBuffer()).byteLength, 0);
    const part = await get(base, 'bytes=10-19', { method: 'HEAD' });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 10-19/${SIZE}`);
  });

  test(`${base}: Cache-Control no-cache (no stale heuristic reuse); If-Range other than Last-Modified → the whole file`, async () => {
    const r = await get(base);
    await r.arrayBuffer();
    assert.equal(r.headers.get('cache-control'), 'no-cache', 'Last-Modified alone lets a browser serve an edited file stale');
    const lm = r.headers.get('last-modified');
    const same = await fetch(url(base), { headers: { range: 'bytes=0-9', 'if-range': lm } });
    assert.equal(same.status, 206);
    await same.arrayBuffer();
    const changed = await fetch(url(base), { headers: { range: 'bytes=0-9', 'if-range': 'Thu, 01 Jan 1970 00:00:00 GMT' } });
    assert.equal(changed.status, 200, 'the file changed since the client cached part of it');
    assert.equal((await changed.arrayBuffer()).byteLength, SIZE);
  });
}

test('peer: a client that hangs up mid-file (a media element seeking) leaves both daemons serving', async () => {
  const ac = new AbortController();
  const r = await fetch(url('peer'), { signal: ac.signal });
  const reader = r.body.getReader();
  await reader.read();
  ac.abort();
  await reader.read().catch(() => {});
  const again = await get('peer', 'bytes=0-9');
  assert.equal(again.status, 206);
  assert.ok(Buffer.from(await again.arrayBuffer()).equals(BYTES.subarray(0, 10)));
  assert.doesNotMatch(procs.map((p) => p.log).join('\n'), /PREMATURE_CLOSE/, 'an aborted stream is not logged as an error');
});
