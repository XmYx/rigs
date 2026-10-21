// Drag and drop in the file browser: move / copy inside one machine and pull from another machine, Finder-style.
//   POST files/copy {paths, dest, onClash?}   POST files/move {paths, dest, onClash?}   (same machine)
//   POST files/pull {node, paths, dest, onClash?, id?}  — this machine fetches from `node` and streams to disk
//   GET  files/progress?id=                    — bytes done / total of a running pull
// Rules (tests: test/file-transfer.test.js):
//  - every path goes through checkPath: no '..' segment, no NUL, only absolute, ~ or @shared (400) — then
//    files.resolvePath, the same resolution as every other files/* call;
//  - nothing is silently overwritten: a clash answers { ok:false, clashes:[…] } with NOTHING done, and the caller
//    repeats with onClash 'keep' (a " (2)" name), 'replace' (the old one goes to ~/.rigs/trash) or 'skip';
//  - a folder never goes into itself; a move to where the item already is does nothing;
//  - a pulled name is a bare name (never a path): a peer cannot write outside the destination folder.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolvePath, trash } from './files.js';
import { uniqueName } from './zip-model.js';

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
export const CLASH_POLICIES = ['keep', 'replace', 'skip'];

/** A path the caller may name: absolute (either style), ~, ~/x or @shared/x — never a '..' segment or NUL. */
export function checkPath(p, what = 'path') {
  if (typeof p !== 'string' || !p.trim()) throw bad(`${what}: a path is required`);
  if (p.includes('\0')) throw bad(`${what}: invalid characters`);
  if (p.split(/[\\/]+/).includes('..')) throw bad(`${what}: ".." is not allowed (${p})`);
  if (!/^(~([\\/]|$)|@shared([\\/]|$)|\/|[a-zA-Z]:[\\/]|\\\\)/i.test(p)) throw bad(`${what}: must be absolute, ~ or @shared (${p})`);
  return resolvePath(p);
}

/** A single file or folder name: never a path. */
export function checkName(n) {
  if (typeof n !== 'string' || !n || n === '.' || n === '..' || /[\\/\0]/.test(n)) throw bad(`invalid name: ${JSON.stringify(n)}`);
  return n;
}

const lstat = (p) => fsp.lstat(p).catch(() => null);
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

function policyOf(onClash) {
  if (onClash == null || onClash === '' || onClash === 'ask') return 'ask';
  if (!CLASH_POLICIES.includes(onClash)) throw bad(`onClash: one of ${CLASH_POLICIES.join(', ')}`);
  return onClash;
}

const brief = (name, st) => ({ name, type: st.isDirectory() ? 'dir' : 'file', size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs });

/**
 * Decide each item's fate in `destDir`: { name, target, existing } with action 'write' | 'skip' | 'replace' | 'clash'.
 * `incoming(name)` → what is arriving (for the clash row), `same(name)` → the item already is the thing at that name.
 */
async function plan(destDir, wants, policy) {
  const out = [];
  const taken = new Set(); // names claimed by earlier items of the same drop
  for (const w of wants) {
    const target = path.join(destDir, w.name);
    if (!inside(target, destDir) || path.dirname(target) !== destDir) throw bad(`invalid name: ${JSON.stringify(w.name)}`);
    const existing = await lstat(target);
    const busy = existing || taken.has(w.name);
    let action = 'write';
    let finalName = w.name;
    if (w.same) {
      action = w.op === 'move' ? 'same' : 'write';
      if (w.op === 'copy') finalName = uniqueName(w.name, (n) => taken.has(n) || fs.existsSync(path.join(destDir, n)), { dir: w.dir }); // a copy beside itself: Finder's duplicate
    } else if (busy) {
      if (policy === 'ask') action = 'clash';
      else if (policy === 'skip') action = 'skip';
      else if (policy === 'keep') finalName = uniqueName(w.name, (n) => taken.has(n) || fs.existsSync(path.join(destDir, n)), { dir: w.dir });
      else action = 'replace';
    }
    taken.add(finalName);
    out.push({ ...w, action, existing, target: path.join(destDir, finalName), finalName });
  }
  return out;
}

const clashRows = (planned) => planned.filter((x) => x.action === 'clash').map((x) => ({ name: x.name, existing: brief(x.name, x.existing), incoming: x.incoming || null }));

async function moveNode(src, target) {
  try { await fsp.rename(src, target); } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.cp(src, target, { recursive: true, errorOnExist: true, force: false });
    await fsp.rm(src, { recursive: true, force: true });
  }
}

/** Move or copy items into a folder on this machine → { ok, done:[{from,to,action}], skipped:[…] } or { ok:false, clashes }. */
export async function transfer(op, paths, dest, { onClash } = {}) {
  if (op !== 'copy' && op !== 'move') throw bad('op: copy or move');
  const policy = policyOf(onClash);
  const list = Array.isArray(paths) ? paths : [];
  if (!list.length) throw bad('paths: a non-empty list of files or folders');
  const destDir = checkPath(dest, 'dest');
  const dst = await lstat(destDir);
  if (!dst?.isDirectory()) throw bad(`not a folder: ${destDir}`, dst ? 400 : 404);
  const realDest = await fsp.realpath(destDir);

  const wants = [];
  for (const item of list) {
    const from = typeof item === 'string' ? item : item?.from;
    const src = checkPath(from, 'paths');
    const st = await lstat(src);
    if (!st) throw bad(`not found: ${src}`, 404);
    const name = checkName((typeof item === 'object' && item.name) || path.basename(src));
    const realSrc = st.isSymbolicLink() ? src : await fsp.realpath(src);
    if (st.isDirectory() && inside(realDest, realSrc)) throw bad(`can't put a folder into itself: ${src}`);
    const same = path.dirname(src) === destDir && name === path.basename(src);
    wants.push({ op, src, name, dir: st.isDirectory(), same, incoming: brief(name, st) });
  }
  const planned = await plan(destDir, wants, policy);
  const clashes = clashRows(planned);
  if (clashes.length) return { ok: false, clashes, done: [], skipped: [] };

  const done = [];
  const skipped = [];
  for (const x of planned) {
    if (x.action === 'skip' || x.action === 'same') { skipped.push({ from: x.src, reason: x.action }); continue; }
    if (x.action === 'replace') await trash(x.target); // the old one is never lost: ~/.rigs/trash
    if (op === 'move') await moveNode(x.src, x.target);
    else await fsp.cp(x.src, x.target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    done.push({ from: x.src, to: x.target, action: x.action, trashed: x.action === 'replace' });
  }
  return { ok: true, done, skipped, clashes: [] };
}

// ------------------------------------------------------------------ pull from another machine

const jobs = new Map(); // id → { bytes, total, files, file, done, error, at }
export function progressOf(id) { return jobs.get(String(id)) || null; }
function track(id) {
  if (!id) return null;
  for (const [k, j] of jobs) if (Date.now() - j.at > 10 * 60 * 1000) jobs.delete(k);
  const job = { bytes: 0, total: 0, files: 0, file: '', done: false, error: '', at: Date.now() };
  jobs.set(String(id), job);
  return job;
}

/** A source on this machine (also what the tests use in place of a peer). */
export function localSource() {
  return {
    async stat(p) { const full = resolvePath(p); const st = await fsp.stat(full); return { path: full, name: path.basename(full), type: st.isDirectory() ? 'dir' : 'file', size: st.size, mtime: st.mtimeMs }; },
    async list(p) {
      const full = resolvePath(p);
      const kids = await fsp.readdir(full, { withFileTypes: true });
      const entries = [];
      for (const d of kids) {
        const f = path.join(full, d.name);
        const st = await fsp.stat(f).catch(() => null);
        if (st) entries.push({ name: d.name, path: f, type: st.isDirectory() ? 'dir' : 'file', size: st.size });
      }
      return entries;
    },
    async read(p) { return fs.createReadStream(resolvePath(p)); },
  };
}

/** A source on a peer, over its /api/local/files API. `fetchPeer(localPath)` → fetch Response (the server wires token + url). */
export function peerSource(fetchPeer) {
  const get = async (rest) => {
    const r = await fetchPeer(rest);
    if (!r.ok) throw bad(`${(await r.text().catch(() => '')).slice(0, 200) || 'HTTP ' + r.status}`, r.status === 404 ? 404 : 502);
    return r;
  };
  const q = (p) => encodeURIComponent(p);
  const sepOf = (p) => (/^[a-zA-Z]:[\\/]|\\/.test(p) && !p.startsWith('/') ? '\\' : '/');
  return {
    async stat(p) {
      const at = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
      const parent = at > 0 ? p.slice(0, at) : p.slice(0, at + 1) || p;
      const name = p.slice(at + 1);
      const r = await (await get(`files?path=${q(parent || sepOf(p))}&hidden=1`)).json();
      const e = (r.entries || []).find((x) => x.name === name);
      if (!e) throw bad(`not found on the source: ${p}`, 404);
      return { path: e.path, name: e.name, type: e.type === 'dir' ? 'dir' : 'file', size: e.size, mtime: e.mtime };
    },
    async list(p) { return ((await (await get(`files?path=${q(p)}&hidden=1`)).json()).entries || []).map((e) => ({ name: e.name, path: e.path, type: e.type === 'dir' ? 'dir' : 'file', size: e.size })); },
    async read(p) { const r = await get(`files/raw?path=${q(p)}`); return Readable.fromWeb(r.body); },
  };
}

/**
 * Copy items from `source` (localSource / peerSource) into a folder here, streaming each file to a temp file and
 * renaming it into place → same result shape as transfer. `id` makes the bytes visible through progressOf.
 */
export async function pull(source, paths, dest, { onClash, id } = {}) {
  const policy = policyOf(onClash);
  const list = Array.isArray(paths) ? paths : [];
  if (!list.length || list.some((p) => typeof p !== 'string' || !p || p.includes('\0'))) throw bad('paths: a non-empty list of files or folders');
  const destDir = checkPath(dest, 'dest');
  const dst = await lstat(destDir);
  if (!dst?.isDirectory()) throw bad(`not a folder: ${destDir}`, dst ? 400 : 404);
  const job = track(id);
  try {
    const wants = [];
    for (const p of list) {
      const st = await source.stat(p);
      wants.push({ op: 'copy', src: st.path || p, name: checkName(st.name), dir: st.type === 'dir', same: false, incoming: { name: st.name, type: st.type, size: st.size, mtime: st.mtime }, st });
    }
    const planned = await plan(destDir, wants, policy);
    const clashes = clashRows(planned);
    if (clashes.length) { if (job) job.done = true; return { ok: false, clashes, done: [], skipped: [] }; }

    const sizeOf = async (st, p) => {
      if (st.type !== 'dir') return st.size || 0;
      let n = 0;
      for (const e of await source.list(p)) n += await sizeOf(e, e.path);
      return n;
    };
    if (job) for (const x of planned) if (x.action !== 'skip') job.total += await sizeOf(x.st, x.src);

    const copyTree = async (st, from, target) => {
      if (st.type === 'dir') {
        await fsp.mkdir(target);
        for (const e of await source.list(from)) await copyTree(e, e.path, path.join(target, checkName(e.name)));
        return;
      }
      if (job) job.file = st.name;
      const tmp = `${target}.rigs-upload-${process.pid}-${Date.now()}`;
      const stream = await source.read(from);
      if (job) stream.on('data', (c) => { job.bytes += c.length; });
      try { await pipeline(stream, fs.createWriteStream(tmp, { flags: 'wx' })); await fsp.rename(tmp, target); } catch (e) { await fsp.rm(tmp, { force: true }); throw e; }
      if (job) job.files++;
    };

    const done = [];
    const skipped = [];
    for (const x of planned) {
      if (x.action === 'skip') { skipped.push({ from: x.src, reason: 'skip' }); continue; }
      if (x.action === 'replace') await trash(x.target);
      await copyTree(x.st, x.src, x.target);
      done.push({ from: x.src, to: x.target, action: x.action, trashed: x.action === 'replace' });
    }
    if (job) job.done = true;
    return { ok: true, done, skipped, clashes: [] };
  } catch (e) {
    if (job) { job.done = true; job.error = e.message; }
    throw e;
  }
}
