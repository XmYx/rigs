// The shared folder (src/shared.js): two in-process nodes on temp dirs, each behind a real HTTP server running the
// /api/local/shared/* routes, pull from each other. Covers create / edit / rename / delete (to trash) / conflict /
// ignore propagation and path traversal refusal.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { conflictName, createShared, decide, isIgnored, safeRel, sharedRoute, SUBFOLDERS } from '../src/shared.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-shared-'));
const MAX = 64 * 1024;

function makeNode(name) {
  const dir = path.join(TMP, name);
  const n = { name, dir, root: path.join(dir, 'RIGS-Shared'), trash: path.join(dir, 'rigs', 'trash'), peers: [] };
  n.engine = createShared({
    root: n.root, stateDir: path.join(dir, 'rigs', 'shared'), trashDir: n.trash, node: name, maxFileBytes: MAX, ignore: ['*.secret'],
    peers: () => n.peers,
    fetchPeer: (peer, p, { method = 'GET' } = {}) => fetch(`${peer.url}/api/local/${p}`, { method }),
  });
  n.server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const sub = url.pathname.replace(/^\/api\/local\//, '');
    try {
      const out = await sharedRoute(n.engine, { method: req.method, sub, q: url.searchParams, req, res });
      if (out !== undefined) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); }
    } catch (e) {
      if (!res.headersSent) { res.writeHead(e.status || 500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); } else res.end();
    }
  });
  return n;
}

const A = makeNode('alpha');
const B = makeNode('beta');
const listen = (n) => new Promise((r) => n.server.listen(0, '127.0.0.1', () => { n.url = `http://127.0.0.1:${n.server.address().port}`; r(); }));

before(async () => {
  await listen(A); await listen(B);
  A.peers = [{ id: 'b', name: 'beta', url: B.url }];
  B.peers = [{ id: 'a', name: 'alpha', url: A.url }];
  A.engine.ensure(); B.engine.ensure();
});
after(() => { A.server.close(); B.server.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

const fa = (rel) => path.join(A.root, ...rel.split('/'));
const fb = (rel) => path.join(B.root, ...rel.split('/'));
const write = (file, text, mtimeMs) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtimeMs) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
};
const read = (file) => fs.readFileSync(file, 'utf8');
const exists = (file) => fs.existsSync(file);
async function syncBoth() { await A.engine.sync(); await B.engine.sync(); await A.engine.sync(); }
/** Every synced file on a node (relative path → content). */
function tree(root) {
  const out = {};
  const walk = (d, pre) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const rel = pre ? `${pre}/${e.name}` : e.name; if (isIgnored(rel, ['*.secret'])) continue; if (e.isDirectory()) walk(path.join(d, e.name), rel); else if (e.isFile()) out[rel] = fs.readFileSync(path.join(d, e.name), 'utf8'); } };
  walk(root, '');
  return out;
}
const trashed = (n) => (exists(n.trash) ? fs.readdirSync(n.trash) : []);

test('startup creates the folder with apps/, files/ and reports/', () => {
  for (const n of [A, B]) for (const s of SUBFOLDERS) assert.ok(fs.statSync(path.join(n.root, s)).isDirectory(), `${n.name}/${s}`);
});

test('create and edit on one node reach the other, with the same mtime', async () => {
  write(fa('reports/weekly.md'), '# week 1', Date.now() - 60000);
  write(fa('apps/demo/index.html'), '<h1>demo</h1>');
  await syncBoth();
  assert.equal(read(fb('reports/weekly.md')), '# week 1');
  assert.equal(read(fb('apps/demo/index.html')), '<h1>demo</h1>');
  assert.equal(Math.floor(fs.statSync(fb('reports/weekly.md')).mtimeMs / 1000), Math.floor(fs.statSync(fa('reports/weekly.md')).mtimeMs / 1000));

  write(fa('reports/weekly.md'), '# week 1\n\nupdated', Date.now() - 30000);
  await syncBoth();
  assert.equal(read(fb('reports/weekly.md')), '# week 1\n\nupdated');
  // B edits the version it has: pulled back to A as a plain edit, not a conflict.
  write(fb('reports/weekly.md'), '# week 1\n\nupdated twice', Date.now() - 20000);
  await syncBoth();
  assert.equal(read(fa('reports/weekly.md')), '# week 1\n\nupdated twice');
  assert.ok(!fs.readdirSync(path.dirname(fa('reports/weekly.md'))).some((f) => f.includes('conflict')), 'no conflict copy for a sequential edit');
  assert.deepEqual(tree(A.root), tree(B.root));
});

test('a rename converges and a delete lands in the trash instead of being unlinked', async () => {
  write(fa('files/notes.txt'), 'remember the milk');
  write(fa('files/old-name.txt'), 'renamed content');
  await syncBoth();
  assert.equal(read(fb('files/old-name.txt')), 'renamed content');

  fs.renameSync(fa('files/old-name.txt'), fa('files/new-name.txt'));
  fs.unlinkSync(fa('files/notes.txt'));
  const before = trashed(B).length;
  await syncBoth();
  assert.equal(read(fb('files/new-name.txt')), 'renamed content');
  assert.ok(!exists(fb('files/old-name.txt')), 'old name is gone on B');
  assert.ok(!exists(fb('files/notes.txt')), 'deleted file is gone on B');
  const inTrash = trashed(B).slice(before);
  assert.equal(inTrash.length, 2, `trash holds both: ${inTrash}`);
  const notes = inTrash.find((f) => f.endsWith('notes.txt'));
  assert.equal(fs.readFileSync(path.join(B.trash, notes), 'utf8'), 'remember the milk', 'the deleted file is kept in the trash');
  assert.deepEqual(tree(A.root), tree(B.root));
  // The tombstone travels in the manifest, and one more sync changes nothing.
  assert.equal(A.engine.manifest().files['files/notes.txt'].deleted, true);
  const r = await B.engine.sync();
  assert.deepEqual(r.peers.alpha, { pulled: 0, trashed: 0, conflicts: 0, errors: [] });
});

test('a concurrent edit on both nodes keeps both versions, the older one as a named conflict copy', async () => {
  write(fa('files/plan.md'), 'base');
  await syncBoth();
  const t = Date.now();
  write(fa('files/plan.md'), 'alpha edit', t - 10000);
  write(fb('files/plan.md'), 'beta edit (newer)', t - 5000);
  await syncBoth();
  await syncBoth();
  const copy = conflictName('files/plan.md', 'alpha', t - 10000);
  assert.match(copy, /^files\/plan \(conflict alpha \d{4}-\d\d-\d\d \d{6}\)\.md$/);
  assert.equal(read(fa('files/plan.md')), 'beta edit (newer)', 'newest mtime keeps the name');
  assert.equal(read(fb('files/plan.md')), 'beta edit (newer)');
  assert.equal(read(fa(copy)), 'alpha edit', 'the older version survives as a conflict copy');
  assert.equal(read(fb(copy)), 'alpha edit', 'and reaches the other node');
  assert.deepEqual(tree(A.root), tree(B.root));
});

test('ignored names, temp files and oversized files do not propagate', async () => {
  write(fa('apps/web/node_modules/dep/index.js'), 'module');
  write(fa('apps/web/.git/config'), '[core]');
  write(fa('files/draft.tmp'), 'temp');
  write(fa('files/.~lock.sheet.ods#'), 'lock');
  write(fa('files/token.secret'), 'from config.shared.ignore');
  write(fa('files/huge.bin'), 'x'.repeat(MAX + 1));
  write(fa('apps/web/server.js'), 'ok');
  await syncBoth();
  assert.equal(read(fb('apps/web/server.js')), 'ok');
  for (const rel of ['apps/web/node_modules/dep/index.js', 'apps/web/.git/config', 'files/draft.tmp', 'files/.~lock.sheet.ods#', 'files/token.secret', 'files/huge.bin']) {
    assert.ok(!exists(fb(rel)), `${rel} must not sync`);
    assert.equal(A.engine.manifest().files[rel], undefined, `${rel} is not in the manifest`);
  }
});

test('GET shared returns the path, subfolders and per-peer sync state', async () => {
  const s = await (await fetch(`${B.url}/api/local/shared`)).json();
  assert.equal(s.path, B.root);
  assert.deepEqual(s.subfolders.map((x) => x.name), ['apps', 'files', 'reports']);
  assert.ok(s.lastSync > 0);
  assert.equal(s.peers.length, 1);
  assert.equal(s.peers[0].node, 'alpha');
  assert.equal(s.peers[0].state, 'synced');
  assert.ok(s.peers[0].lastSync > 0);
  const forced = await (await fetch(`${B.url}/api/local/shared/sync`, { method: 'POST' })).json();
  assert.ok(forced.run && forced.run.peers.alpha, 'POST shared/sync runs a reconcile');
});

test('paths escaping the shared root are refused: .., absolute, symlink', async () => {
  const outside = path.join(TMP, 'outside.txt');
  fs.writeFileSync(outside, 'private');
  for (const p of ['../outside.txt', '../../outside.txt', 'files/../../outside.txt', outside, '/etc/passwd', 'C:\\Windows\\win.ini', '']) {
    const r = await fetch(`${A.url}/api/local/shared/file?path=${encodeURIComponent(p)}`);
    assert.equal(r.status, 400, `GET ${p} → ${r.status}`);
    const w = await fetch(`${A.url}/api/local/shared/file?path=${encodeURIComponent(p)}`, { method: 'PUT', body: 'x' });
    assert.equal(w.status, 400, `PUT ${p} → ${w.status}`);
  }
  assert.equal(read(outside), 'private');
  // A symlink inside the folder pointing out of it is neither served, written through nor synced.
  let linked = true;
  try { fs.symlinkSync(TMP, fa('files/escape'), 'dir'); fs.symlinkSync(outside, fa('files/link.txt')); } catch { linked = false; }
  if (linked) {
    assert.equal((await fetch(`${A.url}/api/local/shared/file?path=${encodeURIComponent('files/link.txt')}`)).status, 403);
    assert.equal((await fetch(`${A.url}/api/local/shared/file?path=${encodeURIComponent('files/escape/outside.txt')}`)).status, 403);
    assert.equal((await fetch(`${A.url}/api/local/shared/file?path=${encodeURIComponent('files/escape/new.txt')}`, { method: 'PUT', body: 'x' })).status, 403);
    assert.ok(!exists(path.join(TMP, 'new.txt')));
    await syncBoth();
    assert.ok(!exists(fb('files/link.txt')) && !exists(fb('files/escape')), 'symlinks do not sync');
  }
  // A write inside the folder works.
  const ok = await fetch(`${A.url}/api/local/shared/file?path=${encodeURIComponent('files/dropped.txt')}`, { method: 'PUT', body: 'dropped' });
  assert.equal(ok.status, 200);
  assert.equal(read(fa('files/dropped.txt')), 'dropped');
});

test('a hostile peer manifest cannot make a node write outside its folder', async () => {
  const evil = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.endsWith('/shared/manifest')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      const e = { size: 4, mtime: Date.now(), sha256: 'f'.repeat(64), hist: [] };
      res.end(JSON.stringify({ files: { '../pwned.txt': e, '/tmp/pwned.txt': e, 'files/../../pwned.txt': e, 'files\\..\\..\\pwned.txt': e } }));
    } else { res.writeHead(200); res.end('evil'); }
  });
  await new Promise((r) => evil.listen(0, '127.0.0.1', r));
  const C = makeNode('gamma');
  C.peers = [{ id: 'e', name: 'evil', url: `http://127.0.0.1:${evil.address().port}` }];
  await C.engine.sync();
  evil.close();
  assert.ok(!exists(path.join(C.dir, 'pwned.txt')) && !exists(path.join(TMP, 'pwned.txt')));
  assert.deepEqual(fs.readdirSync(C.root).sort(), [...SUBFOLDERS].sort());
});

test('safeRel and decide (pure)', () => {
  assert.equal(safeRel('files//a/./b.txt'), 'files/a/b.txt');
  assert.equal(safeRel('files\\a.txt'), 'files/a.txt');
  for (const p of ['..', 'a/../../b', '/abs', 'C:/x', 'a\0b', '']) assert.throws(() => safeRel(p), (e) => e.status === 400, p);
  const v1 = { sha256: '1', hist: [], mtime: 1 };
  const v2 = { sha256: '2', hist: ['1'], mtime: 2 };
  const v3 = { sha256: '3', hist: ['1'], mtime: 3 };
  assert.equal(decide(undefined, v1), 'pull');
  assert.equal(decide(v1, v2), 'pull');
  assert.equal(decide(v2, v1), 'none');
  assert.equal(decide(v2, v3), 'conflict-take-remote');
  assert.equal(decide(v3, v2), 'conflict-keep-local');
  assert.equal(decide(v1, { deleted: true, sha256: '1', hist: [], mtime: 5 }), 'trash');
  assert.equal(decide(v2, { deleted: true, sha256: '1', hist: [], mtime: 5 }), 'none', 'edited after the deleted version: it comes back');
  assert.equal(decide({ deleted: true, sha256: '1', hist: [], mtime: 5 }, v2), 'pull');
  assert.equal(decide({ deleted: true, sha256: '1', hist: [], mtime: 5 }, v1), 'none');
  assert.ok(isIgnored('a/node_modules/b.js') && isIgnored('x/.git/HEAD') && isIgnored('f.swp') && isIgnored('f.rigs-upload-123') && !isIgnored('reports/a.md'));
});
