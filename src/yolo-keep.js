// Keep as app: a finished YOLO run (src/yolo.js) becomes an App Cloud app. POST /api/local/yolo/<runId>/keep
// { id?, name?, icon?, description?, tags? } copies the run's sandbox into the shared folder (<shared>/apps/<id>/),
// writes a zero-dependency static server beside it, publishes it like every applet (an enabled `systemctl --user` unit
// on Linux, else a launch command; the App Cloud registration through apps.upsertApp, the same code as
// POST /api/local/apps and mesh_app_register) and stores `keptAs` in the run's meta, so a second keep returns the same
// app. A YOLO page (Origin: null) can never call it: server.js refuses opaque-origin writes first (opaqueOriginRefused).
// The pure parts (id, skip rules, client stripping, the server source, the launch recipe, the unit) are tested in
// test/yolo.test.js; keepRun is the thin I/O step, with injectable deps so tests never touch systemd or the real config.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import * as appsReg from './apps.js';
import { config, RIGS_HOME } from './config.js';
import { sharedRoot } from './files.js';
import { run as runCmd, which } from './util.js';
import { confinePath, getRun, isLive, isPlaceholder, markKept, MIME_TYPES, yoloRoot } from './yolo.js';

/** The App Cloud id rule (src/apps.js ID_RE). */
export const APP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** Ports a kept app is given (the first free one, not used by another app on this machine). */
export const KEEP_PORTS = Object.freeze({ from: 8900, to: 8999 });
/** The kept app's server file; `rigs-server.mjs` when the run wrote a server.mjs of its own. */
export const SERVER_FILE = 'server.mjs';
const MAX_FILES = 5000;
const MAX_BYTES = 512 * 1024 * 1024;
const UNIT_MARK = '# Managed by RIGS: a kept YOLO run';

const fail = (status, msg) => Object.assign(new Error(msg), { status });

/** Text → an id-shaped slug: lowercase ASCII, a-z0-9 and '-', no leading/trailing '-'. Pure. */
export function slugify(text) {
  return String(text ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * A valid App Cloud id for a kept run (a-z0-9_-, ≤ 40 chars), from its name, title or task, unique against `taken`
 * (ids of the apps on this machine and the folders already in <shared>/apps): a clash gets -2, -3, … — it never returns
 * a taken id. A leading article ("a p5 sketch of …") is dropped. Pure.
 */
export function keepAppId(text, taken = []) {
  const used = new Set([...taken].map((t) => String(t).toLowerCase()));
  const base = slugify(String(text ?? '').replace(/^\s*(?:an?|the)\s+/i, '')).slice(0, 40).replace(/-+$/, '') || 'yolo-app';
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const id = `${base.slice(0, 40 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!used.has(id)) return id;
  }
}

/**
 * Why a sandbox entry is left out of the kept copy, or null to copy it. `rel` is posix and relative to the sandbox,
 * `kind` 'file' | 'dir' | 'symlink' | 'other'. Left out: dot-files/folders anywhere, the `__yolo/` client folder,
 * symlinks, sockets/devices, editor temp files, and any path confinePath refuses. Pure.
 */
export function keepSkip(rel, kind, root = '/sandbox') {
  const segs = String(rel || '').split('/');
  if (!rel || segs.some((s) => s === '' || s === '..')) return 'outside';
  if (segs.some((s) => s.startsWith('.'))) return 'dot-file';
  if (segs[0] === '__yolo') return 'yolo-client';
  if (kind === 'symlink') return 'symlink';
  if (kind !== 'file' && kind !== 'dir') return 'special';
  if (kind === 'file' && /(?:~|\.(?:swp|swx|tmp|crdownload|part))$/i.test(segs.at(-1))) return 'temp';
  if (!confinePath(root, rel)) return 'outside';
  return null;
}

/** A stored page without anything YOLO put in it: the __yolo client script tag and the placeholder marker. Pure. */
export function stripYoloClient(html) {
  return String(html ?? '')
    .replace(/<script\b[^>]*\bsrc\s*=\s*["']?[^"'\s>]*__yolo\/client\.js[^>]*>\s*<\/script>\s*/gi, '')
    .replace(/<meta\s+name="rigs-yolo"[^>]*>\s*/gi, '');
}

/** The ports to try for a kept app: KEEP_PORTS minus the ports this machine's apps already use. Pure. */
export function candidatePorts(taken = [], { from = KEEP_PORTS.from, to = KEEP_PORTS.to } = {}) {
  const used = new Set(taken.map(Number));
  const out = [];
  for (let p = from; p <= to; p++) if (!used.has(p)) out.push(p);
  return out;
}

/** The port in an app target ('http://127.0.0.1:8787' → 8787), or null. Pure. */
export const targetPort = (target) => { const m = /:(\d+)(?:\/|$)/.exec(String(target || '')); return m ? Number(m[1]) : null; };

/**
 * The kept app's server (apps/<id>/server.mjs): node:http only, serves its own folder with the right content types,
 * GET /healthz → 200, '' and folders → index.html, refuses '..', dot-files and anything whose real path leaves the
 * folder (symlinks), never serves itself. Binds 127.0.0.1 (HOST to change) on PORT (env) or the first argument, 0 =
 * any free port. Exports `server` and `listening` (a promise of the port) so it can run in process. Pure.
 */
export function staticServerSource({ name = 'app', runId = '', file = SERVER_FILE } = {}) {
  return `// Static server for the RIGS App Cloud app ${JSON.stringify(String(name))}${runId ? ` (kept from YOLO run ${runId})` : ''}.
// Written by RIGS (src/yolo-keep.js). No dependencies: node ${file} [port]   (or PORT=…; HOST defaults to 127.0.0.1)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.dirname(SELF);
const TYPES = ${JSON.stringify(MIME_TYPES)};
const port = Number(process.env.PORT ?? process.argv[2] ?? 0) || 0;
const host = process.env.HOST || '127.0.0.1';

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', ...extra });
  res.end(body);
}

export const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed', undefined, { allow: 'GET, HEAD' });
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://app').pathname); } catch { return send(res, 400, 'bad path'); }
  if (rel === '/healthz') return send(res, 200, '{"ok":true}', 'application/json');
  if (rel.includes('\\0') || rel.includes('\\\\')) return send(res, 400, 'bad path');
  const segs = rel.split('/').filter(Boolean);
  if (segs.some((s) => s === '..' || s.startsWith('.'))) return send(res, 403, 'forbidden');
  if (!segs.length || rel.endsWith('/')) segs.push('index.html');
  const abs = path.resolve(ROOT, ...segs);
  if (!abs.startsWith(ROOT + path.sep) || abs === SELF) return send(res, 404, 'not found');
  fs.realpath(abs, (err, real) => {
    if (err) return send(res, 404, 'not found');
    fs.realpath(ROOT, (err2, realRoot) => {
      if (err2 || !real.startsWith(realRoot + path.sep)) return send(res, 404, 'not found');
      fs.stat(real, (err3, st) => {
        if (err3) return send(res, 404, 'not found');
        if (st.isDirectory()) return send(res, 301, '', undefined, { location: encodeURIComponent(segs.at(-1)) + '/' });
        if (!st.isFile()) return send(res, 404, 'not found');
        res.writeHead(200, { 'content-type': TYPES[path.extname(real).toLowerCase()] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(real).on('error', () => res.destroy()).pipe(res);
      });
    });
  });
});

export const listening = new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, host, () => { const p = server.address().port; console.log(\`serving \${ROOT} on http://\${host}:\${p}/\`); resolve(p); });
});
`;
}

// systemd quoting (as tools/app-publish): inside "…" escape \\ and ", double % and $.
const sdq = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;

/** The systemd unit name for a kept app. Pure. */
export const keepUnitName = (id) => `rigs-${id}.service`;

/** The `systemctl --user` unit that runs a kept app (enabled, so it survives reboots). Pure. */
export function keepUnitText({ id, name, dir, port, runId = '', file = SERVER_FILE, node = process.execPath }) {
  return [
    `${UNIT_MARK} (${runId || 'unknown run'}) for app "${id}"`,
    '[Unit]', `Description=${String(name || id).replace(/[\r\n]+/g, ' ')} (RIGS App Cloud, kept YOLO run)`, 'After=network.target', '',
    '[Service]', 'Type=simple', `WorkingDirectory=${dir}`, `ExecStart=${sdq(node)} ${sdq(path.join(dir, file))} ${port}`,
    `Environment=${sdq(`PORT=${port}`)}`, `Environment=${sdq('HOST=127.0.0.1')}`, 'Restart=on-failure', 'RestartSec=3', '',
    '[Install]', 'WantedBy=default.target', '',
  ].join('\n');
}

/** A path for a launch recipe: under the home folder as ~/…, else absolute. Pure. */
export function homeRel(p, home = os.homedir()) {
  const abs = path.resolve(p);
  return abs === home ? '~' : abs.startsWith(home + path.sep) ? `~/${path.relative(home, abs).split(path.sep).join('/')}` : abs;
}

/**
 * The App Cloud launch recipe of a kept app: the systemd unit on Linux (when there is one), else a top-level command,
 * plus a command + cwd for macOS and Windows (the shared folder is synced to every machine). Pure.
 */
export function keepLaunch({ dir, port, unit = '', file = SERVER_FILE }) {
  const command = `node ${file} ${port}`;
  const cwd = homeRel(dir);
  return { ...(unit ? { systemd: unit } : { command, cwd }), darwin: { command, cwd }, windows: { command, cwd: cwd.replace(/\//g, '\\') } };
}

/**
 * The request body → { id (explicit or ''), name, icon, description, tags }. Throws { status: 400 } on bad values: an
 * explicit id must be a valid App Cloud id; tags are short words, 'yolo' first. Pure.
 */
export function keepRequest(b = {}, meta = {}) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw fail(400, 'expected { id?, name?, icon?, description?, tags? }');
  const id = b.id === undefined || b.id === null || b.id === '' ? '' : String(b.id).trim().toLowerCase();
  if (id && !APP_ID_RE.test(id)) throw fail(400, 'id must be 1-40 chars of a-z, 0-9, - or _ (starting with a letter or digit)');
  const name = String(b.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || meta.title || 'YOLO app';
  const icon = String(b.icon ?? '').trim().slice(0, 16) || '⚡';
  const description = String(b.description ?? '').trim() || `Kept from a YOLO run: ${String(meta.task || meta.title || '').trim()}`;
  if (b.tags !== undefined && !Array.isArray(b.tags)) throw fail(400, 'tags must be an array of short words');
  const tags = [...new Set(['yolo', ...(b.tags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean)])];
  if (!tags.every((t) => /^[\w.+-]{1,32}$/.test(t))) throw fail(400, 'tags must be short words (a-z, 0-9, . + - _)');
  return { id, name, icon, description: description.slice(0, 500), tags: tags.slice(0, 20) };
}

// ── I/O ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Copy a sandbox into `dest` (which must not exist yet), following keepSkip. → { files, bytes, skipped: [{ path, why }] }. */
export async function copySandbox(src, dest) {
  const realSrc = await fsp.realpath(src);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try { await fsp.mkdir(dest); } catch (e) { throw e.code === 'EEXIST' ? fail(409, `${dest} already exists and is never overwritten`) : e; } // never into an existing folder
  const out = { files: 0, bytes: 0, skipped: [] };
  async function walk(rel) {
    const entries = await fsp.readdir(rel ? path.join(src, ...rel.split('/')) : src, { withFileTypes: true });
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const kind = e.isSymbolicLink() ? 'symlink' : e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other';
      const why = keepSkip(r, kind, src);
      if (why) { out.skipped.push({ path: r, why }); continue; }
      const from = path.join(src, ...r.split('/'));
      if (!(await fsp.realpath(from)).startsWith(realSrc + path.sep)) { out.skipped.push({ path: r, why: 'outside' }); continue; }
      const to = path.join(dest, ...r.split('/'));
      if (kind === 'dir') { await fsp.mkdir(to); await walk(r); continue; }
      const st = await fsp.lstat(from);
      if (++out.files > MAX_FILES) throw fail(413, `the sandbox has more than ${MAX_FILES} files`);
      out.bytes += st.size;
      if (out.bytes > MAX_BYTES) throw fail(413, `the sandbox is larger than ${MAX_BYTES / 1024 / 1024} MB`);
      if (/\.html?$/i.test(e.name)) await fsp.writeFile(to, stripYoloClient(await fsp.readFile(from, 'utf8')), { flag: 'wx' });
      else await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    }
  }
  await walk('');
  return out;
}

/** The first port of `candidates` that this machine can bind on 127.0.0.1. */
export async function freePort(candidates) {
  for (const p of candidates) {
    const ok = await new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (ok) return p;
  }
  throw fail(503, `no free port in ${KEEP_PORTS.from}-${KEEP_PORTS.to} for the app`);
}

let systemdCache = null;
/** Is a user systemd usable here? RIGS_NO_SYSTEMD switches it off (the test hook appstore.js and app-publish honour). */
async function systemdUsable() {
  if (process.env.RIGS_NO_SYSTEMD || process.platform !== 'linux' || !which('systemctl')) return false;
  const runtimeDir = `/run/user/${process.getuid?.()}`;
  if (!process.env.XDG_RUNTIME_DIR && fs.existsSync(runtimeDir)) process.env.XDG_RUNTIME_DIR = runtimeDir;
  if (systemdCache === null) systemdCache = (await runCmd('systemctl', ['--user', 'show-environment'], { timeout: 8000 })).code === 0;
  return systemdCache;
}

const realDeps = {
  systemd: systemdUsable,
  unitDir: () => process.env.RIGS_SYSTEMD_USER_DIR || path.join(os.homedir(), '.config', 'systemd', 'user'),
  systemctl: (args) => runCmd('systemctl', ['--user', ...args], { timeout: 60000 }),
  register: (app) => appsReg.upsertApp(app),
  localApps: () => appsReg.localApps().apps,
  startApp: (id, opts) => appsReg.startApp(id, opts),
  probe: (app) => appsReg.probeApp(app),
  sharedRoot: () => sharedRoot(),
  node: () => config().name,
  trashDir: () => path.join(RIGS_HOME, 'trash'),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Move something this keep made into the trash (never unlink). */
async function moveToTrash(p, name, trashDir) {
  await fsp.mkdir(trashDir, { recursive: true });
  const dest = path.join(trashDir, `${Date.now()}-${name}`);
  await fsp.rename(p, dest).catch(async (e) => { if (e.code !== 'EXDEV') throw e; await fsp.cp(p, dest, { recursive: true }); await fsp.rm(p, { recursive: true, force: true }); });
  return dest;
}

const inflight = new Map(); // runId → the keep in progress (a double click keeps once)

/**
 * POST /api/local/yolo/<runId>/keep → { ok, already, keptAs, app, health, files, bytes, skipped, steps }; a second keep
 * of a kept run → { ok, already: true, keptAs, app }. Throws { status } errors: 404 unknown run, 409 live run / no
 * first frame / taken id or folder / a unit RIGS did not write, 400 bad body, 413 too big.
 */
export function keepRun(runId, body = {}, opts = {}) {
  if (inflight.has(runId)) return inflight.get(runId);
  const p = doKeep(runId, body, opts).finally(() => inflight.delete(runId));
  inflight.set(runId, p);
  return p;
}

async function doKeep(runId, body, { root = yoloRoot(), deps: injected = {}, waitMs = 20000 } = {}) {
  const d = { ...realDeps, ...injected };
  const meta = await getRun(runId, root);
  if (!meta) throw fail(404, 'no such YOLO run on this machine');
  if (isLive(runId)) throw fail(409, 'this YOLO run is still live: stop it (or let it finish) before keeping it as an app');
  const apps = await d.localApps();
  const node = await d.node();
  const kept = meta.keptAs && apps.find((a) => a.id === meta.keptAs.id);
  if (kept) return { ok: true, already: true, message: `already kept as ${kept.name}`, keptAs: meta.keptAs, app: { ...kept, node } };
  const req = keepRequest(body, meta);
  const src = path.join(root, runId);
  let index = '';
  try { index = await fsp.readFile(path.join(src, 'index.html'), 'utf8'); } catch { throw fail(409, 'this YOLO run has no index.html to keep'); }
  if (isPlaceholder(index)) throw fail(409, 'this YOLO run never drew its first frame: nothing to keep');

  const appsDir = path.join(await d.sharedRoot(), 'apps');
  let folders = [];
  try { folders = await fsp.readdir(appsDir); } catch {}
  if (req.id && apps.some((a) => a.id === req.id)) throw fail(409, `App Cloud id "${req.id}" is already taken on ${node}: pick another one`);
  if (req.id && folders.some((f) => f.toLowerCase() === req.id)) throw fail(409, `${path.join(appsDir, req.id)} already exists and is never overwritten: pick another id`);
  const id = req.id || keepAppId(req.name || meta.title || meta.task, [...apps.map((a) => a.id), ...folders]);
  const dir = path.join(appsDir, id);
  const file = fs.existsSync(path.join(src, SERVER_FILE)) ? `rigs-${SERVER_FILE}` : SERVER_FILE; // the run's own server.mjs stays
  const port = await freePort(candidatePorts(apps.map((a) => targetPort(a.target)).filter(Boolean)));
  const unit = (await d.systemd()) ? keepUnitName(id) : '';
  const unitPath = unit ? path.join(await d.unitDir(), unit) : '';
  if (unitPath && fs.existsSync(unitPath) && !fs.readFileSync(unitPath, 'utf8').startsWith(UNIT_MARK)) throw fail(409, `${unitPath} exists and was not written by RIGS: pick another id`);

  let copied;
  if (fs.existsSync(dir)) throw fail(409, `${dir} already exists and is never overwritten`);
  try { copied = await copySandbox(src, dir); } catch (e) {
    if (e.status === 409) throw e; // the folder appeared meanwhile: someone else's, left alone
    await moveToTrash(dir, `yolo-keep-${id}`, d.trashDir()).catch(() => {});
    throw e.status ? e : fail(500, `could not copy the sandbox: ${e.message}`);
  }
  const steps = [`copied ${copied.files} files to ${dir}`];
  const app = { id, name: req.name, icon: req.icon, port, healthPath: '/healthz', launch: keepLaunch({ dir, port, unit, file }), description: req.description, tags: req.tags };
  try {
    await fsp.writeFile(path.join(dir, file), staticServerSource({ name: req.name, runId, file }), { flag: 'wx' });
    if (unit) {
      await fsp.mkdir(path.dirname(unitPath), { recursive: true });
      await fsp.writeFile(unitPath, keepUnitText({ id, name: req.name, dir, port, runId, file }));
      for (const a of [['daemon-reload'], ['enable', '--now', unit]]) {
        const r = await d.systemctl(a);
        if (r.code) throw new Error(`systemctl --user ${a.join(' ')} failed: ${String(r.stderr || r.stdout).trim()}`);
      }
      steps.push(`unit ${unit} enabled and started`);
    }
    await d.register(app);
    steps.push(`registered in the App Cloud as ${id}`);
  } catch (e) {
    // undo only what this keep made: the unit off and into the trash, the copied folder into the trash
    if (unit && fs.existsSync(unitPath)) { await d.systemctl(['disable', '--now', unit]).catch(() => {}); await moveToTrash(unitPath, unit, d.trashDir()).catch(() => {}); }
    await moveToTrash(dir, `yolo-keep-${id}`, d.trashDir()).catch(() => {});
    throw fail(e.status || 500, `keeping the run failed: ${e.message}`);
  }

  // Up? systemd started it; otherwise start it the way JARVIS starts any app that is down (its launch recipe).
  let health = 'unknown';
  const reg = (await d.localApps()).find((a) => a.id === id);
  if (!unit) {
    try { await d.startApp(id, { waitMs }); health = 'up'; } catch (e) { steps.push(`not started yet: ${e.message}`); }
  } else if (reg) {
    for (const until = Date.now() + waitMs; Date.now() < until; await d.sleep(300)) if ((await d.probe(reg)).ok) { health = 'up'; break; }
  }
  const keptAs = { id, node, path: `/api/nodes/${encodeURIComponent(node)}/apps/${id}/`, name: req.name, icon: req.icon, port, dir, ...(unit ? { unit } : {}), at: Date.now() };
  await markKept(runId, keptAs, root);
  const final = (await d.localApps()).find((a) => a.id === id) || reg || app;
  return { ok: true, already: false, keptAs, app: { ...final, node }, health, files: copied.files, bytes: copied.bytes, skipped: copied.skipped, steps };
}
