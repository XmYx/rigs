// The shared folder: one folder per machine (config.shared.path, default ~/RIGS-Shared) that every RIGS node keeps in
// sync with its online peers, built into the daemon (no external service). It is the default place for ad-hoc apps
// (apps/<id>), files made for Sir's requests (files/) and reports (reports/). Design notes: docs/shared-folder.md.
//
// Each node keeps a manifest of its folder: relative path → { size, mtime, sha256, hist } plus tombstones for
// deletions. `hist` is the chain of earlier hashes at that path (newest first), so a peer can tell "they edited the
// version I have" (pull) from "we both edited it" (a genuine conflict: keep both, the older one as a named copy).
// A reconcile pulls from each peer: GET /api/local/shared/manifest, then GET /api/local/shared/file?path= for what
// is new. Nothing is ever unlinked: a deletion seen from a peer moves the local copy to ~/.rigs/trash.
//
// The engine is transport-agnostic (`peers()` + `fetchPeer()`), so tests run two nodes in one process.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { writeStream, mimeOf } from './files.js';

export const SUBFOLDERS = ['apps', 'files', 'reports'];
export const DEFAULT_PATH = '~/RIGS-Shared';
const HIST_MAX = 16;
const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;

// Never synced: VCS and dependency folders, OS litter, editor/download temp files and our own transfer temp files.
const IGNORE_NAMES = new Set(['.git', '.hg', '.svn', 'node_modules', '__pycache__', '.venv', '.DS_Store', 'Thumbs.db', 'desktop.ini', '.Trash', '.Trashes', '$RECYCLE.BIN']);
const IGNORE_RE = [/\.rigs-upload-/, /^\.rigs-sync-/, /\.(?:tmp|temp|swp|swo|swx|part|crdownload|partial)$/i, /~$/, /^~\$/, /^\.~lock\./, /^\.#/];

function bad(status, msg) { const e = new Error(msg); e.status = status; return e; }

/** A simple glob for one path segment or a whole relative path: `*` = any run of characters, `?` = one. */
function globRe(g) {
  return new RegExp('^' + String(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
}

/** Is this relative (posix) path excluded from sync? `extra`: globs from config.shared.ignore. */
export function isIgnored(rel, extra = []) {
  const parts = String(rel).split('/');
  const res = extra.map(globRe);
  for (const p of parts) {
    if (IGNORE_NAMES.has(p) || IGNORE_RE.some((r) => r.test(p))) return true;
    if (res.some((r) => r.test(p))) return true;
  }
  return res.some((r) => r.test(rel));
}

/**
 * A peer- or user-supplied relative path, checked and normalized to posix form. Refuses absolute paths, drive letters,
 * '..' segments, NUL bytes and empty names (400).
 */
export function safeRel(rel) {
  const s = String(rel ?? '');
  if (!s || s.length > 4096) throw bad(400, 'path is required');
  if (s.includes('\0')) throw bad(400, 'path has a NUL byte');
  if (/^[\\/]/.test(s) || /^[a-z]:/i.test(s) || path.isAbsolute(s)) throw bad(400, 'path must be relative to the shared folder');
  const parts = s.split(/[\\/]+/).filter((p) => p && p !== '.');
  if (!parts.length) throw bad(400, 'path is required');
  if (parts.some((p) => p === '..')) throw bad(400, 'path escapes the shared folder');
  return parts.join('/');
}

const within = (root, p) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** "Report.pdf" + node "macbook" + mtime → "Report (conflict macbook 2026-10-20 191233).pdf" (the same on every node). */
export function conflictName(rel, node, mtime) {
  const dir = path.posix.dirname(rel);
  const base = path.posix.basename(rel);
  const ext = path.posix.extname(base);
  const stem = ext && ext !== base ? base.slice(0, -ext.length) : base;
  const d = new Date(Math.floor(mtime) || 0).toISOString();
  const when = `${d.slice(0, 10)} ${d.slice(11, 19).replace(/:/g, '')}`;
  const who = String(node || 'peer').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40);
  const name = `${stem} (conflict ${who} ${when})${ext && ext !== base ? ext : ''}`;
  return dir === '.' ? name : `${dir}/${name}`;
}

async function hashFile(file) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

/**
 * Pure decision for one path. local/remote: a manifest entry ({ sha256, hist, mtime, deleted? }) or undefined.
 * → 'none' | 'pull' | 'trash' | 'conflict-keep-local' (local wins the name, the remote copy is saved beside it)
 *   | 'conflict-take-remote' (remote wins the name, the local copy is renamed beside it).
 */
export function decide(local, remote) {
  if (!remote) return 'none';
  const L = local; const R = remote;
  const inHist = (e, sha) => !!sha && (e?.hist || []).includes(sha);
  if (R.deleted) {
    if (!L || L.deleted) return 'none';
    if (L.sha256 === R.sha256 || inHist(R, L.sha256)) return 'trash'; // they deleted the version we have
    if (inHist(L, R.sha256)) return 'none'; // we edited after the version they deleted: ours comes back to them
    return R.mtime > L.mtime ? 'trash' : 'none'; // unrelated: newest wins
  }
  if (!L) return 'pull';
  if (L.deleted) {
    if (R.sha256 === L.sha256 || inHist(L, R.sha256)) return 'none'; // they still have what we deleted: they will trash it
    if (inHist(R, L.sha256)) return 'pull'; // edited after the version we deleted
    return R.mtime > L.mtime ? 'pull' : 'none';
  }
  if (L.sha256 === R.sha256) return 'none';
  if (inHist(R, L.sha256)) return 'pull'; // they edited our version
  if (inHist(L, R.sha256)) return 'none'; // we edited theirs: they pull from us
  // Both changed since a common version (or never shared one): keep both. Newest mtime keeps the name.
  const remoteWins = R.mtime > L.mtime || (R.mtime === L.mtime && R.sha256 > L.sha256);
  return remoteWins ? 'conflict-take-remote' : 'conflict-keep-local';
}

/**
 * createShared({ root, stateDir, trashDir, node, peers, fetchPeer, ... }) → the engine.
 *  - root: the shared folder (absolute). stateDir: where the manifest lives (outside root, never synced).
 *  - node: this machine's name (conflict copies are named after the node whose version lost).
 *  - peers(): online RIGS peers [{ id, name }]. fetchPeer(peer, localPath, { method }) → a fetch Response for the
 *    peer's /api/local/<localPath> (authenticated like any other peer call).
 */
export function createShared({
  root, stateDir, trashDir, node = 'local', peers = () => [], fetchPeer = null,
  intervalSec = 60, debounceMs = 2000, maxFileBytes = 256 * 1024 * 1024, ignore = [], log = () => {},
} = {}) {
  root = path.resolve(root);
  const manifestFile = path.join(stateDir, 'manifest.json');
  let man = { files: {} };
  try { man = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); if (!man.files) man.files = {}; } catch { /* first run */ }
  const peerState = new Map(); // peer name → { node, state, lastSync, error, pulled, trashed, conflicts }
  let lastSync = 0;
  let lastScan = 0;
  let running = null;
  let again = false;
  let timer = null;
  let watcher = null;
  let debounce = null;
  let realRoot = root;
  let onLocalChange = null; // tells the peers something changed here (start({ notify }))
  const ign = (rel) => isIgnored(rel, ignore);

  function ensure() {
    fs.mkdirSync(root, { recursive: true });
    for (const s of SUBFOLDERS) fs.mkdirSync(path.join(root, s), { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    realRoot = fs.realpathSync(root);
  }

  /**
   * The absolute path for a relative one, refusing anything outside the root: '..', absolute paths, and symlinks
   * anywhere on the way (a link inside the folder could point anywhere on the disk). 400/403.
   */
  async function resolve(rel, { mustExist = false } = {}) {
    const r = safeRel(rel);
    const abs = path.join(root, ...r.split('/'));
    if (!within(root, abs)) throw bad(400, 'path escapes the shared folder');
    // Walk from the root down: no component may be a symlink.
    let cur = root;
    for (const part of r.split('/')) {
      cur = path.join(cur, part);
      let st;
      try { st = await fsp.lstat(cur); } catch (e) { if (e.code === 'ENOENT') { if (mustExist) throw bad(404, 'not found'); break; } throw e; }
      if (st.isSymbolicLink()) throw bad(403, 'symlinks in the shared folder are not followed');
    }
    const parentReal = await fsp.realpath(path.dirname(abs)).catch(() => null);
    if (parentReal && !within(realRoot, parentReal)) throw bad(403, 'path escapes the shared folder');
    return { rel: r, abs };
  }

  function save() {
    fs.mkdirSync(stateDir, { recursive: true });
    const tmp = manifestFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(man));
    fs.renameSync(tmp, manifestFile);
  }

  /** Walk the folder (no symlinks, no ignored or oversized files) and bring the manifest up to date. → changed? */
  async function scan() {
    ensure();
    const seen = new Set();
    let changed = false;
    async function walk(dir, prefix) {
      let ents;
      try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const d of ents) {
        const rel = prefix ? `${prefix}/${d.name}` : d.name;
        if (ign(rel) || d.isSymbolicLink()) continue;
        const full = path.join(dir, d.name);
        if (d.isDirectory()) { await walk(full, rel); continue; }
        if (!d.isFile()) continue;
        let st;
        try { st = await fsp.stat(full); } catch { continue; }
        if (st.size > maxFileBytes) continue;
        seen.add(rel);
        const prev = man.files[rel];
        const mtime = Math.floor(st.mtimeMs);
        if (prev && !prev.deleted && prev.size === st.size && prev.mtime === mtime) continue;
        let sha;
        try { sha = await hashFile(full); } catch { continue; }
        if (prev && !prev.deleted && prev.sha256 === sha) { man.files[rel] = { ...prev, size: st.size, mtime }; continue; }
        // A local edit (or a re-creation after a delete): the version it replaced goes into its history.
        const hist = prev ? [prev.sha256, ...(prev.hist || [])].filter(Boolean).slice(0, HIST_MAX) : [];
        man.files[rel] = { size: st.size, mtime, sha256: sha, hist };
        changed = true;
      }
    }
    await walk(root, '');
    const now = Date.now();
    for (const [rel, e] of Object.entries(man.files)) {
      if (e.deleted) { if (now - e.mtime > TOMBSTONE_TTL_MS) delete man.files[rel]; continue; }
      if (!seen.has(rel)) { man.files[rel] = { deleted: true, size: 0, mtime: now, sha256: e.sha256, hist: e.hist || [] }; changed = true; }
    }
    lastScan = now;
    save();
    return changed;
  }

  function manifest() {
    return { node, root, at: lastScan, files: man.files };
  }

  /** Move a local file to the trash (never unlink): <trashDir>/<ts>-<name>. */
  async function toTrash(abs) {
    await fsp.mkdir(trashDir, { recursive: true });
    const dest = path.join(trashDir, `${Date.now()}-${path.basename(abs)}`);
    try { await fsp.rename(abs, dest); } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      await fsp.copyFile(abs, dest);
      await fsp.rm(abs, { force: true });
    }
    return dest;
  }

  /** Download a peer's file to `rel` through the files write path (temp file + rename), with its mtime. */
  async function download(peer, remoteRel, rel, mtime) {
    const r = await fetchPeer(peer, `shared/file?path=${encodeURIComponent(remoteRel)}`, { method: 'GET' });
    if (!r.ok) throw new Error(`${peer.name}: ${remoteRel}: HTTP ${r.status}`);
    const { abs } = await resolve(rel);
    await writeStream(abs, Readable.fromWeb(r.body));
    const t = new Date(mtime);
    await fsp.utimes(abs, t, t).catch(() => {});
    const st = await fsp.stat(abs);
    return { abs, size: st.size, mtime: Math.floor(st.mtimeMs), sha256: await hashFile(abs) };
  }

  /** The local file at rel still is what the last scan saw (nobody wrote it since). */
  async function unchanged(abs, e) {
    try { const st = await fsp.stat(abs); return st.size === e.size && Math.floor(st.mtimeMs) === e.mtime; } catch { return false; }
  }

  async function syncPeer(peer) {
    const ps = peerState.get(peer.name) || { node: peer.name, state: 'never', lastSync: 0 };
    peerState.set(peer.name, { ...ps, state: 'syncing' });
    const stats = { pulled: 0, trashed: 0, conflicts: 0, errors: [] };
    try {
      const r = await fetchPeer(peer, 'shared/manifest', { method: 'GET' });
      if (r.status === 404) { peerState.set(peer.name, { ...ps, state: 'unsupported', error: 'no shared folder on that node (older RIGS)' }); return stats; }
      if (!r.ok) throw new Error(`manifest: HTTP ${r.status}`);
      const remote = await r.json();
      for (const [rawRel, R] of Object.entries(remote.files || {})) {
        let rel;
        try { rel = safeRel(rawRel); } catch { continue; }
        if (rel !== rawRel || ign(rel) || (!R.deleted && R.size > maxFileBytes)) continue;
        const L = man.files[rel];
        const act = decide(L, R);
        if (act === 'none') continue;
        try {
          const { abs } = await resolve(rel);
          if (L && !L.deleted && !(await unchanged(abs, L))) continue; // edited since the scan: the next run decides
          if (act === 'pull') {
            const got = await download(peer, rel, rel, R.mtime);
            man.files[rel] = { size: got.size, mtime: got.mtime, sha256: got.sha256, hist: got.sha256 === R.sha256 ? (R.hist || []) : [R.sha256, ...(R.hist || [])].slice(0, HIST_MAX) };
            stats.pulled++;
          } else if (act === 'trash') {
            const to = await toTrash(abs);
            man.files[rel] = { deleted: true, size: 0, mtime: R.mtime, sha256: R.sha256, hist: R.hist || [] };
            stats.trashed++;
            log(`shared: ${rel} deleted on ${peer.name} → ${to}`);
          } else if (act === 'conflict-take-remote') {
            // Ours lost on mtime: it moves aside under our node's name, theirs takes the path.
            const copy = conflictName(rel, node, L.mtime);
            const dst = await resolve(copy);
            await fsp.rename(abs, dst.abs);
            man.files[copy] = { size: L.size, mtime: L.mtime, sha256: L.sha256, hist: [] };
            const got = await download(peer, rel, rel, R.mtime);
            man.files[rel] = { size: got.size, mtime: got.mtime, sha256: got.sha256, hist: R.hist || [] };
            stats.conflicts++;
            log(`shared: conflict on ${rel} with ${peer.name}: kept ours as ${copy}`);
          } else if (act === 'conflict-keep-local') {
            // Theirs lost: we keep ours at the path and save theirs beside it, named after their node.
            const copy = conflictName(rel, peer.name, R.mtime);
            if (!man.files[copy] || man.files[copy].deleted) {
              const got = await download(peer, rel, copy, R.mtime);
              man.files[copy] = { size: got.size, mtime: got.mtime, sha256: got.sha256, hist: [] };
              stats.conflicts++;
              log(`shared: conflict on ${rel} with ${peer.name}: saved theirs as ${copy}`);
            }
          }
        } catch (e) { stats.errors.push(`${rel}: ${e.message}`); }
      }
      save();
      const now = Date.now();
      peerState.set(peer.name, { node: peer.name, state: stats.errors.length ? 'partial' : 'synced', lastSync: now, error: stats.errors[0] || undefined, ...stats, errors: stats.errors.length });
    } catch (e) {
      peerState.set(peer.name, { ...ps, state: 'error', error: e.message });
    }
    return stats;
  }

  /** One full run: scan, then pull from every online peer. Runs never overlap; a call during a run queues one more. */
  function sync() {
    if (running) { again = true; return running; }
    running = (async () => {
      const t0 = Date.now();
      const changed = await scan();
      if (changed && onLocalChange) Promise.resolve().then(onLocalChange).catch((e) => log('shared notify:', e.message));
      const list = (await peers()) || [];
      const out = {};
      for (const p of list) out[p.name] = await syncPeer(p);
      // What we pulled shows up in the next scan as unchanged (same size + mtime), so nothing loops.
      lastSync = Date.now();
      return { changed, ms: lastSync - t0, peers: out };
    })().finally(() => { running = null; if (again) { again = false; schedule(250); } });
    return running;
  }

  function schedule(ms = debounceMs) {
    clearTimeout(debounce);
    debounce = setTimeout(() => { sync().catch((e) => log('shared sync:', e.message)); }, ms);
    debounce.unref?.();
  }

  /** A local change: sync soon (the scan in that run spots it and tells the peers, so they pull within seconds). */
  function watch() {
    try {
      watcher = fs.watch(root, { recursive: true }, (_ev, name) => {
        const rel = name ? String(name).split(path.sep).join('/') : '';
        if (rel && ign(rel)) return;
        schedule(debounceMs);
      });
      watcher.on('error', (e) => { log('shared watch stopped:', e.message); watcher = null; });
    } catch (e) { log('shared: no file watcher here, syncing every', intervalSec, 's:', e.message); }
  }

  return {
    root, ensure, resolve, scan, sync, manifest, decide,
    /** Start the periodic reconcile and the folder watcher. notify(): tell peers something changed here. */
    start({ notify } = {}) {
      ensure();
      onLocalChange = notify || null;
      timer = setInterval(() => { sync().catch((e) => log('shared sync:', e.message)); }, Math.max(5, intervalSec) * 1000);
      timer.unref?.();
      watch();
      schedule(1500);
    },
    stop() { clearInterval(timer); clearTimeout(debounce); watcher?.close(); watcher = null; },
    /** A peer told us it changed something: pull soon. */
    nudge() { schedule(Math.min(debounceMs, 1000)); },
    /** known: every RIGS peer [{ name, online }] — ones not synced yet show as 'pending', unreachable ones 'offline'. */
    status(known = []) {
      const files = Object.values(man.files).filter((e) => !e.deleted);
      const out = new Map([...peerState.values()].map((p) => [p.node, p]));
      for (const k of known) {
        const p = out.get(k.name);
        if (!p) out.set(k.name, { node: k.name, state: k.online ? 'pending' : 'offline', lastSync: null });
        else if (!k.online) out.set(k.name, { ...p, state: 'offline' });
      }
      return {
        path: root, subfolders: SUBFOLDERS.map((s) => ({ name: s, path: path.join(root, s) })),
        lastSync: lastSync || null, lastScan: lastScan || null, syncing: !!running,
        files: files.length, bytes: files.reduce((s, e) => s + (e.size || 0), 0),
        peers: [...out.values()].sort((a, b) => String(a.node).localeCompare(String(b.node))),
      };
    },
    async sendFile(rel, res) {
      const { abs } = await resolve(rel, { mustExist: true });
      const st = await fsp.stat(abs);
      if (!st.isFile()) throw bad(400, 'not a file');
      res.writeHead(200, { 'content-type': mimeOf(abs), 'content-length': st.size, 'x-rigs-mtime': String(Math.floor(st.mtimeMs)) });
      await pipeline(fs.createReadStream(abs), res);
    },
    async writeFile(rel, readable) {
      const { abs, rel: r } = await resolve(rel);
      if (ign(r)) throw bad(400, 'that name is excluded from the shared folder');
      const out = await writeStream(abs, readable);
      schedule(300);
      return { ...out, rel: r };
    },
  };
}

/**
 * The /api/local/shared/* routes on an engine. Returns the JSON body, or undefined when it streamed a response.
 *   GET  shared            → status { path, subfolders, lastSync, peers }
 *   GET  shared/manifest   → { node, files: { rel: { size, mtime, sha256, hist, deleted? } } }
 *   GET  shared/file?path= → the raw file           PUT shared/file?path= → write it (temp file + rename)
 *   POST shared/sync       → run a reconcile now    POST shared/nudge     → a peer changed something: pull soon
 */
export async function sharedRoute(engine, { method, sub, q, req, res, known = () => [] }) {
  if (!engine) throw bad(503, 'the shared folder is off on this machine (config.shared.enabled)');
  if (sub === 'shared' && method === 'GET') return engine.status(known());
  if (sub === 'shared/manifest' && method === 'GET') { await engine.scan(); return engine.manifest(); }
  if (sub === 'shared/file' && method === 'GET') {
    if (!res) throw bad(400, 'stream only');
    await engine.sendFile(q.get('path'), res);
    return undefined;
  }
  if (sub === 'shared/file' && method === 'PUT') return engine.writeFile(q.get('path'), req);
  if (sub === 'shared/sync' && method === 'POST') { const r = await engine.sync(); return { ...engine.status(known()), run: r }; }
  if (sub === 'shared/nudge' && method === 'POST') { engine.nudge(); return { ok: true }; }
  if (sub === 'shared/path' && method === 'GET') return { path: engine.root };
  throw bad(404, 'unknown shared route');
}
