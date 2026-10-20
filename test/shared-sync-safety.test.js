// Shared folder data-safety edge cases (src/shared.js), each on its own pair of in-process nodes:
//  - files deleted in one run that share a name all survive in the trash
//  - a synced file that grows past maxFileMb, or starts matching an ignore glob, is not deleted on the peers
//  - a file created locally between the scan and the pull is not overwritten by the peer's copy
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createShared, sharedRoute } from '../src/shared.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-shared-safety-'));
const MAX = 64 * 1024;
const servers = [];
after(() => { for (const s of servers) s.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

function engineFor(n, { ignore = [], beforeManifest } = {}) {
  return createShared({
    root: n.root, stateDir: path.join(n.dir, 'rigs', 'shared'), trashDir: n.trash, node: n.name, maxFileBytes: MAX, ignore,
    peers: () => n.peers,
    fetchPeer: async (peer, p, { method = 'GET' } = {}) => {
      if (p === 'shared/manifest' && beforeManifest) await beforeManifest();
      return fetch(`${peer.url}/api/local/${p}`, { method });
    },
  });
}

async function makeNode(name, opts) {
  const dir = path.join(TMP, name);
  const n = { name, dir, root: path.join(dir, 'RIGS-Shared'), trash: path.join(dir, 'rigs', 'trash'), peers: [] };
  n.engine = engineFor(n, opts);
  n.server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      const out = await sharedRoute(n.engine, { method: req.method, sub: url.pathname.replace(/^\/api\/local\//, ''), q: url.searchParams, req, res });
      if (out !== undefined) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); }
    } catch (e) {
      if (!res.headersSent) { res.writeHead(e.status || 500); res.end(JSON.stringify({ error: e.message })); } else res.end();
    }
  });
  servers.push(n.server);
  await new Promise((r) => n.server.listen(0, '127.0.0.1', r));
  n.url = `http://127.0.0.1:${n.server.address().port}`;
  n.engine.ensure();
  n.file = (rel) => path.join(n.root, ...rel.split('/'));
  return n;
}

async function pair(tag, optsA, optsB) {
  const A = await makeNode(`${tag}-a`, optsA);
  const B = await makeNode(`${tag}-b`, optsB);
  A.peers = [{ id: 'b', name: B.name, url: B.url }];
  B.peers = [{ id: 'a', name: A.name, url: A.url }];
  return [A, B];
}

const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = (file) => fs.readFileSync(file, 'utf8');
const trashContents = (n) => (fs.existsSync(n.trash) ? fs.readdirSync(n.trash).map((f) => read(path.join(n.trash, f))).sort() : []);

test('files with the same name deleted in one run all survive in the trash', async () => {
  const [A, B] = await pair('trash');
  const names = ['apps/site/index.html', 'apps/site/a/index.html', 'apps/site/b/index.html', 'apps/site/c/index.html'];
  names.forEach((rel, i) => write(A.file(rel), `version ${i}`));
  await A.engine.sync(); await B.engine.sync();
  for (const rel of names) assert.ok(fs.existsSync(B.file(rel)), `${rel} reached B`);
  fs.rmSync(A.file('apps/site'), { recursive: true });
  await A.engine.sync(); await B.engine.sync();
  for (const rel of names) assert.ok(!fs.existsSync(B.file(rel)), `${rel} left B's folder`);
  assert.deepEqual(trashContents(B), names.map((_, i) => `version ${i}`).sort(), 'every deleted copy is kept in the trash');
});

test('a synced file that grows past maxFileMb stays on the peers', async () => {
  const [A, B] = await pair('grow');
  write(A.file('files/log.txt'), 'small');
  await A.engine.sync(); await B.engine.sync();
  assert.equal(read(B.file('files/log.txt')), 'small');
  write(A.file('files/log.txt'), 'x'.repeat(MAX + 1));
  await A.engine.sync(); await B.engine.sync();
  assert.equal(read(B.file('files/log.txt')), 'small', 'B keeps its copy: too big to sync is not a delete');
  assert.deepEqual(trashContents(B), []);
  assert.notEqual(A.engine.manifest().files['files/log.txt']?.deleted, true, 'A does not record a tombstone');
});

test('a synced file that starts matching an ignore glob stays on the peers', async () => {
  const [A, B] = await pair('ignore');
  write(A.file('files/run.log'), 'log line');
  await A.engine.sync(); await B.engine.sync();
  assert.equal(read(B.file('files/run.log')), 'log line');
  // Sir adds '*.log' to config.shared.ignore on A and restarts it: same folder and manifest, new rules.
  A.engine = engineFor(A, { ignore: ['*.log'] });
  await A.engine.sync(); await B.engine.sync();
  assert.equal(read(B.file('files/run.log')), 'log line', 'B keeps its copy');
  assert.equal(read(A.file('files/run.log')), 'log line', 'A keeps its copy');
  assert.deepEqual(trashContents(B), []);
});

test('a file created locally after the scan is not overwritten by the peer\'s copy', async () => {
  let createLocal = null;
  const [A, B] = await pair('race', {}, { beforeManifest: async () => { if (createLocal) await createLocal(); } });
  write(A.file('files/notes.md'), 'from A');
  await A.engine.sync();
  // B's scan has run (no notes.md yet); Sir saves his own notes.md on B before B pulls A's.
  createLocal = async () => { write(B.file('files/notes.md'), 'typed on B'); createLocal = null; };
  await B.engine.sync();
  assert.equal(read(B.file('files/notes.md')), 'typed on B', 'the local file is left alone');
  // The next runs see both versions and keep both.
  await B.engine.sync(); await A.engine.sync(); await B.engine.sync();
  const all = (n) => fs.readdirSync(path.join(n.root, 'files')).filter((f) => f.startsWith('notes')).map((f) => read(path.join(n.root, 'files', f))).sort();
  assert.deepEqual(all(B), ['from A', 'typed on B'], 'both versions survive on B');
  assert.deepEqual(all(A), ['from A', 'typed on B'], 'and on A');
});
