import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config, RIGS_HOME } from './config.js';
import { HOME, expandHome, isWin } from './util.js';
import { nearestExisting } from './ui-open.js';

const MIME = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.ts': 'text/plain', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.zip': 'application/zip',
  // audio and video (the media player, ui/src/media-player.js): the type decides what <audio>/<video> attempts
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.weba': 'audio/webm', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.ogv': 'video/ogg',
};

/**
 * This machine's shared folder (src/shared.js): config.shared.path, else RIGS_SHARED, else ~/RIGS-Shared — or
 * <RIGS_HOME>/RIGS-Shared on a throwaway node (tests, a second instance), so it never syncs the real folder.
 */
export function sharedRoot() {
  const p = config().shared?.path || process.env.RIGS_SHARED || (process.env.RIGS_HOME ? path.join(RIGS_HOME, 'RIGS-Shared') : '~/RIGS-Shared');
  return path.resolve(expandHome(p));
}

/** '@shared' (and '@shared/reports/x.md') names the shared folder on whichever machine resolves it. */
export function resolvePath(p) {
  const m = /^@shared(?:[\\/](.*))?$/i.exec(String(p || ''));
  if (m) return path.resolve(sharedRoot(), m[1] || '.');
  const raw = expandHome(p || '~');
  return path.resolve(raw || HOME);
}

export async function roots() {
  const shared = config().shared?.enabled === false ? [] : [{ name: 'Shared', path: sharedRoot() }];
  if (!isWin) return [{ name: 'Home', path: HOME }, ...shared, { name: '/', path: '/' }];
  const drives = [];
  for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (fs.existsSync(l + ':\\')) drives.push({ name: l + ':', path: l + ':\\' });
  return [{ name: 'Home', path: HOME }, ...shared, ...drives];
}

export async function list(p, { showHidden = false } = {}) {
  const dir = resolvePath(p);
  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  const entries = [];
  await Promise.all(dirents.map(async (d) => {
    const hidden = d.name.startsWith('.');
    if (hidden && !showHidden) return;
    const full = path.join(dir, d.name);
    let st = null;
    try { st = await fsp.stat(full); } catch {}
    entries.push({
      name: d.name, path: full, hidden,
      type: st?.isDirectory() ? 'dir' : d.isSymbolicLink() && !st ? 'link' : 'file',
      size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0,
    });
  }));
  entries.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent !== dir ? parent : null, sep: path.sep, entries, roots: await roots() };
}

/**
 * What the file browser should open for `p` on this machine (ui_open, src/ui-open.js): the folder itself, a file's
 * folder with the file selected, or the nearest existing parent when `p` is missing → { requested, path, folder,
 * select, missing, sep }.
 */
export function locate(p) {
  const full = resolvePath(p);
  const kind = (x) => { try { const st = fs.statSync(x); return st.isDirectory() ? 'dir' : 'file'; } catch { return null; } };
  const r = nearestExisting(full, kind, path.dirname);
  return { requested: p || '~', path: full, folder: r.folder || HOME, select: r.select, missing: r.missing || !r.folder, sep: path.sep };
}

export function mimeOf(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

/**
 * A `Range` request header against a file of `size` bytes (RFC 9110 §14): one `bytes=` range → { start, end } (inclusive),
 * `bytes=-N` = the last N bytes, an open end runs to the last byte. null = serve the whole file (no header, another unit,
 * a malformed or a multi-range header, which a server may ignore); 'unsatisfiable' = 416 (starts at or past the end).
 */
export function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (!n || !size) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  if (m[2] !== '' && Number(m[2]) < start) return null;
  if (start >= size) return 'unsatisfiable';
  const end = m[2] === '' ? size - 1 : Number(m[2]);
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Stream a file: 200 with the whole file, or 206 Partial Content for a `range` header (seeking in <video>/<audio>, and
 * Safari/iOS, which will not play media without it); 416 + `Content-Range: bytes *\/size` when the range starts past
 * the end. `head` sends the headers only. A client that hangs up mid-file (a media element seeking) is not an error.
 * `no-cache`: Last-Modified alone would let a browser reuse a stale copy heuristically (an edited image or text file);
 * an `ifRange` that is not the current Last-Modified (the file changed since the client cached part of it) = the whole file.
 */
export async function sendFile(p, res, { download = false, range, ifRange, head = false } = {}) {
  const file = resolvePath(p);
  const st = await fsp.stat(file);
  if (st.isDirectory()) throw Object.assign(new Error('is a directory'), { status: 400 });
  const headers = { 'content-type': mimeOf(file), 'accept-ranges': 'bytes', 'last-modified': st.mtime.toUTCString(), 'cache-control': 'no-cache' };
  if (download) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`;
  const r = ifRange && ifRange !== headers['last-modified'] ? null : parseRange(range, st.size);
  if (r === 'unsatisfiable') {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${st.size}`, 'content-length': 0 });
    res.end();
    return;
  }
  if (r) res.writeHead(206, { ...headers, 'content-range': `bytes ${r.start}-${r.end}/${st.size}`, 'content-length': r.end - r.start + 1 });
  else res.writeHead(200, { ...headers, 'content-length': st.size });
  if (head) { res.end(); return; }
  try {
    await pipeline(fs.createReadStream(file, r ? { start: r.start, end: r.end } : {}), res);
  } catch (e) {
    if (e.code !== 'ERR_STREAM_PREMATURE_CLOSE' && !res.destroyed) throw e;
  }
}

export async function readText(p, maxBytes = 2 * 1024 * 1024) {
  const file = resolvePath(p);
  const st = await fsp.stat(file);
  if (st.size > maxBytes) return { path: file, size: st.size, truncated: true, text: (await readHead(file, maxBytes)) };
  return { path: file, size: st.size, truncated: false, text: await fsp.readFile(file, 'utf8') };
}

async function readHead(file, n) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally { await fh.close(); }
}

/** Stream a request body into a file atomically (temp file + rename). */
export async function writeStream(p, req) {
  const file = resolvePath(p);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.rigs-upload-' + process.pid;
  await pipeline(req, fs.createWriteStream(tmp));
  await fsp.rename(tmp, file);
  const st = await fsp.stat(file);
  return { path: file, size: st.size };
}

export async function writeText(p, text) {
  const file = resolvePath(p);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text);
  return { path: file, size: Buffer.byteLength(text) };
}

export async function mkdir(p) {
  const dir = resolvePath(p);
  await fsp.mkdir(dir, { recursive: true });
  return { path: dir };
}

export async function rename(from, to) {
  const a = resolvePath(from);
  const b = resolvePath(to);
  await fsp.rename(a, b);
  return { from: a, to: b };
}

/** "Delete" moves into ~/.rigs/trash so nothing is lost by a misclick from another machine. */
export async function trash(p) {
  const src = resolvePath(p);
  const dir = path.join(RIGS_HOME, 'trash');
  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, `${Date.now()}-${path.basename(src)}`);
  try {
    await fsp.rename(src, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.cp(src, dest, { recursive: true });
    await fsp.rm(src, { recursive: true, force: true });
  }
  return { path: src, trashedTo: dest };
}

// ------------------------------------------------------------------ zip / unzip
// Built-in file tools (ui/src/file-tools.js): POST files/zip {paths, dest?} and files/unzip {path, dest?}.
// In memory through fflate, under a size cap (config.files.zip); never overwrite (a " (2)" suffix instead);
// unzip refuses any entry that would land outside its folder (zip-slip: '..', absolute paths, symlinked parents).
// Pure rules: src/zip-model.js. Imported lazily so the daemon's start does not pay for them.

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const COMPRESSED = /\.(zip|gz|tgz|bz2|xz|zst|7z|rar|png|jpe?g|gif|webp|avif|heic|mp4|mov|webm|mkv|mp3|m4a|ogg|opus|flac|pdf|docx|xlsx|pptx)$/i;

function commonDir(dirs) {
  let common = dirs[0];
  for (const d of dirs.slice(1)) {
    while (common !== path.dirname(common) && !(d === common || d.startsWith(common.endsWith(path.sep) ? common : common + path.sep))) common = path.dirname(common);
  }
  return common;
}

/** Zip files and folders into one archive → { path, files, bytes, size }. */
export async function zip(paths, dest, { limits: lim, config: cfg } = {}) {
  const { zipSync } = await import('fflate');
  const { archiveName, uniqueName, zipLimits } = await import('./zip-model.js');
  const limits = lim || zipLimits(cfg);
  if (!Array.isArray(paths) || !paths.length || paths.some((p) => typeof p !== 'string' || !p)) throw bad('paths: a non-empty list of files or folders');
  const items = [...new Set(paths.map(resolvePath))];
  for (const p of items) if (!exists(p)) throw bad(`not found: ${p}`, 404);
  const base = commonDir(items.map((p) => path.dirname(p)));

  let out = dest ? resolvePath(dest) : path.join(base, archiveName(items));
  try { if (fs.statSync(out).isDirectory()) out = path.join(out, archiveName(items)); } catch {}
  if (!/\.zip$/i.test(out)) out += '.zip';
  out = path.join(path.dirname(out), uniqueName(path.basename(out), (n) => exists(path.join(path.dirname(out), n))));

  const entries = {};
  let bytes = 0;
  let files = 0;
  const add = async (full) => {
    if (full === out) return;
    const st = await fsp.lstat(full);
    if (st.isSymbolicLink()) return; // never follow links out of the selection
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (++files > limits.maxEntries) throw bad(`more than ${limits.maxEntries} files (zip limit)`, 413);
    if (st.isDirectory()) {
      const kids = await fsp.readdir(full);
      if (!kids.length) entries[rel + '/'] = new Uint8Array(0);
      for (const k of kids) await add(path.join(full, k));
      return;
    }
    if (!st.isFile()) return;
    bytes += st.size;
    if (bytes > limits.maxBytes) throw bad(`selection is larger than ${limits.maxBytes} bytes (zip size cap)`, 413);
    const data = new Uint8Array(await fsp.readFile(full));
    entries[rel] = COMPRESSED.test(full) ? [data, { level: 0 }] : data;
  };
  for (const p of items) await add(p);
  const buf = zipSync(entries, { level: 6, mtime: new Date() });
  await fsp.mkdir(path.dirname(out), { recursive: true });
  await fsp.writeFile(out, buf, { flag: 'wx' }); // wx: fail instead of overwriting something that appeared meanwhile
  return { path: out, files: Object.keys(entries).filter((k) => !k.endsWith('/')).length, bytes, size: buf.length };
}

/** Extract an archive → { path (the folder), files, bytes, renamed: [{ from, to }] }. */
export async function unzip(p, dest, { limits: lim, config: cfg } = {}) {
  const { unzipSync } = await import('fflate');
  const { extractFolderName, planExtract, uniqueName, zipLimits } = await import('./zip-model.js');
  const limits = lim || zipLimits(cfg);
  if (typeof p !== 'string' || !p) throw bad('path: the archive to extract');
  const archive = resolvePath(p);
  const st = await fsp.stat(archive);
  if (!st.isFile()) throw bad('not a file');
  if (st.size > limits.maxBytes) throw bad(`archive is larger than ${limits.maxBytes} bytes (zip size cap)`, 413);
  const buf = new Uint8Array(await fsp.readFile(archive));

  // Pass 1 reads the central directory only: refuse the whole archive before writing anything.
  const infos = [];
  try { unzipSync(buf, { filter: (f) => { infos.push(f); return false; } }); } catch (e) { throw bad(`not a readable zip archive: ${e.message}`); }
  const plan = planExtract(infos, limits);
  if (!plan.ok) throw bad(plan.error, /size cap|limit/.test(plan.error) ? 413 : 400);

  let root;
  if (dest) root = resolvePath(dest);
  else {
    const dir = path.dirname(archive);
    root = path.join(dir, uniqueName(extractFolderName(archive), (n) => exists(path.join(dir, n)), { dir: true }));
  }
  await fsp.mkdir(root, { recursive: true });
  const realRoot = await fsp.realpath(root);
  const inside = (x) => x === realRoot || x.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep);

  let data;
  try { data = unzipSync(buf); } catch (e) { throw bad(`could not extract: ${e.message}`); }
  const renamed = [];
  let files = 0;
  let bytes = 0;
  for (const e of plan.entries) {
    const target = path.resolve(realRoot, ...e.path.split('/'));
    if (!inside(target)) throw bad(`unsafe path in archive: ${JSON.stringify(e.name)}`);
    const parent = e.dir ? target : path.dirname(target);
    await fsp.mkdir(parent, { recursive: true });
    if (!inside(await fsp.realpath(parent))) throw bad(`unsafe path in archive (symlinked folder): ${JSON.stringify(e.name)}`);
    if (e.dir) continue;
    const body = data[e.name];
    if (!body) continue;
    bytes += body.length;
    if (bytes > limits.maxBytes) throw bad(`archive unpacks to more than ${limits.maxBytes} bytes (size cap)`, 413);
    const name = uniqueName(path.basename(target), (n) => exists(path.join(parent, n)));
    const file = path.join(parent, name);
    if (name !== path.basename(target)) renamed.push({ from: e.path, to: path.relative(realRoot, file).split(path.sep).join('/') });
    await fsp.writeFile(file, body, { flag: 'wx' });
    files++;
  }
  return { path: root, archive, files, bytes, renamed };
}
