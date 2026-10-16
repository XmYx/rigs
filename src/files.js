import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { RIGS_HOME } from './config.js';
import { HOME, expandHome, isWin } from './util.js';

const MIME = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.ts': 'text/plain', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.mp4': 'video/mp4',
  '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.zip': 'application/zip',
};

export function resolvePath(p) {
  const raw = expandHome(p || '~');
  return path.resolve(raw || HOME);
}

export async function roots() {
  if (!isWin) return [{ name: 'Home', path: HOME }, { name: '/', path: '/' }];
  const drives = [];
  for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (fs.existsSync(l + ':\\')) drives.push({ name: l + ':', path: l + ':\\' });
  return [{ name: 'Home', path: HOME }, ...drives];
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

export function mimeOf(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

export async function sendFile(p, res, { download = false } = {}) {
  const file = resolvePath(p);
  const st = await fsp.stat(file);
  if (st.isDirectory()) throw Object.assign(new Error('is a directory'), { status: 400 });
  const headers = { 'content-type': mimeOf(file), 'content-length': st.size };
  if (download) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`;
  res.writeHead(200, headers);
  await pipeline(fs.createReadStream(file), res);
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
