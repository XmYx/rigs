import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, RIGS_HOME, saveConfig } from './config.js';
import { APP_DIR, run } from './util.js';

/**
 * StarNet space-station view (experimental, opt-in through config.experimental.starnet; spec docs/starnet-integration.md).
 *
 * With the flag on, JARVIS shows StarNet's pixel-art station (https://github.com/androoAGI/starnet, MIT © Andrew Sims)
 * with the mesh's machines as rooms and its agent sessions as workers, in place of the 3D galaxy. This module is the
 * daemon side: the flag, the pinned install and the read-only /starnet/ static route the station iframe loads from.
 *
 * - Install (`rigs starnet install`, POST /api/local/starnet/install): StarNet is never vendored into this repo (its
 *   renderer pulls ~250 MB of art). The browser renderer subset (SUBSET: frontend code, sprites, fonts, the industrial
 *   materials it loads at boot, shared/, LICENSE + NOTICE.md) is fetched at the pinned commit PINNED_REF with a sparse,
 *   shallow git fetch — or copied from a local checkout at that commit (--from) — into RIGS_HOME/starnet/<ref>/.
 *   StarNet's UI sounds (frontend/assets/sfx) are licensed only as sounds of StarNet itself: never installed or served.
 * - Serve (`serve`): /starnet/ is StarNet's own index.html with ui/starnet/rigs-boot.js + rigs.css injected ahead of
 *   the first app script; /starnet/_rigs/* = ui/starnet/; /starnet/shared/* = the install's shared/; everything else
 *   = the install's frontend/. With the flag off (the default) every /starnet/ path is a 404, so nothing changes.
 * - StarNet's sidecar is never run and the station never reaches the RIGS API: rigs-boot.js blocks every request
 *   outside /starnet/ in the frame, and `blockedApiCall` refuses /api/* calls whose Referer is the station.
 *
 * Removing the experiment: switch the flag off (or delete config.experimental.starnet) and `rigs starnet remove`;
 * nothing else in RIGS_HOME is touched.
 */

export const REPO = 'https://github.com/androoAGI/starnet';
export const PINNED_REF = 'd540d503d9c8d5140685881880d46985b27e2f9c'; // v0.13.5, the commit docs/starnet-integration.md studied
export const SUBSET = [
  'shared', 'frontend/app', 'frontend/js', 'frontend/css', 'frontend/agent-demo',
  'frontend/assets/fonts', 'frontend/assets/sprites', 'frontend/assets/brand', 'frontend/assets/furniture',
  'frontend/assets/agent-demo', 'frontend/assets/agent-animation-0914', 'frontend/assets/skin-study-0914',
  'frontend/assets/industrial/remaster', 'frontend/assets/industrial/projection-correction', 'frontend/assets/industrial/calibration',
];
const EXCLUDED = ['frontend/assets/sfx']; // Bleeoop UI sounds: "ship only as embedded UI sounds of this application"
const MARKER = '.rigs-starnet.json';
const BOOT_DIR = path.join(APP_DIR, 'ui', 'starnet');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};
const isRef = (s) => /^[0-9a-f]{40}$/.test(String(s || ''));
export const events = new EventEmitter();

/** config.experimental.starnet with defaults applied (ref '' = the pinned commit). Pure. */
export function settings(cfg = config()) {
  const s = cfg?.experimental?.starnet || {};
  const ref = isRef(s.ref) ? s.ref : PINNED_REF;
  const dir = typeof s.dir === 'string' && s.dir.trim() ? path.resolve(s.dir.trim()) : path.join(RIGS_HOME, 'starnet', ref);
  return { enabled: s.enabled === true, ref, dir, custom: !!(typeof s.dir === 'string' && s.dir.trim()) };
}

/** A settings patch from the API → the new config.experimental.starnet (throws on bad values). Pure. */
export function applyConfigPatch(cur = {}, patch = {}) {
  const next = { enabled: cur?.enabled === true, ref: isRef(cur?.ref) ? cur.ref : '', dir: typeof cur?.dir === 'string' ? cur.dir : '' };
  if (patch.enabled !== undefined) next.enabled = patch.enabled === true || patch.enabled === 'true';
  if (patch.ref !== undefined) {
    if (patch.ref !== '' && !isRef(patch.ref)) throw new Error('ref must be a full 40-character commit sha (or "" for the pinned one)');
    next.ref = patch.ref === PINNED_REF ? '' : patch.ref;
  }
  if (patch.dir !== undefined) {
    if (typeof patch.dir !== 'string') throw new Error('dir must be a path string ("" = RIGS_HOME/starnet/<ref>)');
    next.dir = patch.dir.trim();
  }
  return next;
}

/** What is installed in `dir`: the marker written by install, or null. */
export function installed(dir = settings().dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'));
    if (!fs.existsSync(path.join(dir, 'frontend', 'index.html')) || !fs.existsSync(path.join(dir, 'frontend', 'app', 'world.js'))) return null;
    return m;
  } catch { return null; }
}

/** GET /api/local/starnet/config: the flag plus whether this machine has the station files. */
export function status(cfg = config()) {
  const s = settings(cfg);
  const m = installed(s.dir);
  return {
    enabled: s.enabled, ref: s.ref, pinned: s.ref === PINNED_REF, dir: s.dir,
    installed: !!m && m.ref === s.ref, installedRef: m?.ref || null, installedAt: m?.installedAt || null, bytes: m?.bytes || null,
    installing: !!installing, url: '/starnet/', credit: 'Station view by StarNet (MIT) — github.com/androoAGI/starnet',
  };
}

/** POST /api/local/starnet/config. Applied at once (the next /starnet/ request and every open UI via 'config'). */
export function saveSettings(patch) {
  const cfg = config();
  cfg.experimental = { ...(cfg.experimental || {}), starnet: applyConfigPatch(cfg.experimental?.starnet, patch || {}) };
  saveConfig(cfg);
  const st = status(cfg);
  events.emit('config', st);
  return st;
}

// ------------------------------------------------------------------ install

async function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  const walk = async (d) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) { files++; bytes += (await fsp.stat(p)).size; }
    }
  };
  await walk(dir);
  return { files, bytes };
}

/** Is repo-relative `rel` (posix) part of the installed subset? Git's cone semantics: the SUBSET dirs recursively, plus
 *  the files directly inside each of their ancestors (the repo root's LICENSE/NOTICE.md, frontend/index.html, …). Pure. */
export function inSubset(rel, isDir = false) {
  const p = rel.split('/').filter(Boolean).join('/');
  if (!p) return true;
  if (EXCLUDED.some((x) => p === x || p.startsWith(x + '/'))) return false;
  if (SUBSET.some((s) => p === s || p.startsWith(s + '/'))) return true;
  const ancestor = (d) => d === '' || SUBSET.some((s) => s.startsWith(d + '/'));
  if (isDir) return ancestor(p);
  return ancestor(p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
}

let installing = null;

/**
 * Fetch (or copy `from` a local checkout) StarNet at the configured ref into its install dir. Idempotent: an existing
 * install of that ref is kept unless `force`. Writes to a temp dir first and renames, so a failed install leaves nothing.
 */
export async function install({ from = '', force = false, onProgress = () => {} } = {}) {
  if (installing) throw new Error('a StarNet install is already running');
  const s = settings();
  const have = installed(s.dir);
  if (have && have.ref === s.ref && !force) return { ok: true, already: true, ...status() };
  installing = (async () => {
    await fsp.mkdir(path.dirname(s.dir), { recursive: true });
    const tmp = `${s.dir}.tmp-${process.pid}`;
    await fsp.rm(tmp, { recursive: true, force: true });
    let source;
    try {
      if (from) {
        const src = path.resolve(from);
        if (!fs.existsSync(path.join(src, 'frontend', 'app', 'world.js'))) throw new Error(`${src} is not a StarNet checkout (no frontend/app/world.js)`);
        const head = await run('git', ['-C', src, 'rev-parse', 'HEAD']);
        if (head.code === 0 && head.stdout.trim() !== s.ref) throw new Error(`${src} is at ${head.stdout.trim().slice(0, 12)}, not the pinned ${s.ref.slice(0, 12)} (check it out, or set experimental.starnet.ref)`);
        onProgress(`copying the renderer subset from ${src}`);
        await fsp.cp(src, tmp, { recursive: true, filter: async (p) => inSubset(path.relative(src, p).split(path.sep).join('/'), (await fsp.lstat(p)).isDirectory()) });
        source = head.code === 0 ? `copy of ${src} @ ${s.ref}` : `copy of ${src} (not a git checkout; ref unverified)`;
      } else {
        const git = async (args, timeout = 60000) => {
          const r = await run('git', ['-C', tmp, ...args], { timeout });
          if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
          return r;
        };
        await fsp.mkdir(tmp, { recursive: true });
        await git(['init', '-q']);
        await git(['remote', 'add', 'origin', REPO]);
        await git(['sparse-checkout', 'init', '--cone']); // `set --cone` needs git ≥ 2.35; init + set works on older ones too
        await git(['sparse-checkout', 'set', ...SUBSET]);
        onProgress(`fetching ${REPO} @ ${s.ref.slice(0, 12)} (renderer subset only, a few hundred MB)`);
        await git(['fetch', '--depth', '1', '--filter=blob:none', 'origin', s.ref], 30 * 60000);
        onProgress('checking out the subset');
        await git(['-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD'], 30 * 60000);
        const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
        if (head !== s.ref) throw new Error(`fetched ${head}, expected ${s.ref}`);
        await fsp.rm(path.join(tmp, '.git'), { recursive: true, force: true });
        source = `${REPO} @ ${s.ref}`;
      }
      for (const x of EXCLUDED) await fsp.rm(path.join(tmp, x), { recursive: true, force: true });
      if (!fs.existsSync(path.join(tmp, 'LICENSE'))) throw new Error('the StarNet LICENSE is missing from the install');
      await fsp.writeFile(path.join(tmp, 'RIGS-NOTICE.txt'), [
        'StarNet (https://github.com/androoAGI/starnet) — MIT, Copyright (c) 2026 Andrew Sims. See LICENSE and NOTICE.md beside this file.',
        `Installed by RIGS for its experimental space-station view: the browser renderer subset at ${s.ref}.`,
        'Not redistributed: this copy lives only in this machine\'s RIGS_HOME. StarNet\'s UI sounds (assets/sfx) are left out.',
        '',
      ].join('\n'));
      const st = await dirStats(tmp);
      await fsp.writeFile(path.join(tmp, MARKER), JSON.stringify({ ref: s.ref, source, installedAt: Date.now(), ...st }, null, 2));
      await fsp.rm(s.dir, { recursive: true, force: true });
      await fsp.rename(tmp, s.dir);
      onProgress(`installed ${st.files} files (${(st.bytes / 1e6).toFixed(0)} MB) in ${s.dir}`);
    } catch (e) {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
  })();
  try { await installing; } finally { installing = null; }
  const st = status();
  events.emit('config', st);
  return { ok: true, ...st };
}

/** `rigs starnet remove`: delete RIGS_HOME/starnet (every installed ref). A custom `dir` is never deleted. */
export async function remove() {
  const s = settings();
  const root = path.join(RIGS_HOME, 'starnet');
  await fsp.rm(root, { recursive: true, force: true });
  const st = status();
  events.emit('config', st);
  return { ok: true, removed: root, kept: s.custom ? s.dir : null, ...st };
}

// ------------------------------------------------------------------ serve

/** StarNet's index.html → the station frame: rigs.css + rigs-boot.js ahead of the first app script, /shared/ made
 *  relative (StarNet's sidecar serves it at the root). Throws if the markup moved, never serves a half-wired frame. Pure. */
export function transformIndex(html, ref = PINNED_REF) {
  const first = html.indexOf('<script src="app/');
  if (first < 0) throw new Error('StarNet index.html: no <script src="app/…"> to inject the RIGS boot ahead of');
  if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(html)) throw new Error('StarNet index.html asks for remote fonts');
  const tags = `<link rel="stylesheet" href="_rigs/rigs.css?v=${ref.slice(0, 8)}"><!-- RIGS: station-only view -->\n`
    + `<script src="_rigs/rigs-boot.js?v=${ref.slice(0, 8)}"></script><!-- RIGS: sandbox + seeded save + JARVIS bridge, before any store read -->\n`;
  return (html.slice(0, first) + tags + html.slice(first)).replaceAll('src="/shared/', 'src="shared/');
}

/** Map a /starnet/… URL path to a file, or null (outside the install, excluded). Pure. */
export function resolvePath(pathname, dir, bootDir = BOOT_DIR) {
  let rel;
  try { rel = decodeURIComponent(pathname.replace(/^\/starnet\/?/, '')); } catch { return null; }
  if (rel.includes('\0')) return null;
  rel = path.posix.normalize('/' + rel).slice(1);
  if (rel === '' || rel === 'index.html') return { index: true, file: path.join(dir, 'frontend', 'index.html') };
  if (rel.startsWith('_rigs/')) return { file: path.join(bootDir, rel.slice(6)), base: bootDir };
  if (EXCLUDED.some((x) => ('frontend/' + rel).startsWith(x + '/'))) return null;
  const base = rel.startsWith('shared/') ? dir : path.join(dir, 'frontend');
  return { file: path.join(base, rel), base };
}

function send(res, status, type, body, cache = 'no-store') {
  res.writeHead(status, { 'content-type': type, 'cache-control': cache, 'x-content-type-options': 'nosniff' });
  res.end(body);
}

const fromStation = (req) => { try { return new URL(req.headers.referer || '', 'http://x').pathname.startsWith('/starnet/'); } catch { return false; } };

/** GET /starnet/*. 404 while the flag is off — except a file the station frame itself asks for: switching off from
 *  the CLI or another window reaches the server before the push removes an open frame, and that frame's in-flight
 *  asset loads should end quietly instead of as a burst of 404s. No new frame can start: the page is a 404. */
export async function serve(req, res, pathname, cfg = config()) {
  const s = settings(cfg);
  if (!s.enabled && !fromStation(req)) return send(res, 404, 'text/plain; charset=utf-8', 'not found');
  if (pathname === '/starnet') { res.writeHead(308, { location: '/starnet/', 'cache-control': 'no-store' }); res.end(); return; }
  const r = resolvePath(pathname, s.dir);
  if (!r || (!s.enabled && r.index)) return send(res, 404, 'text/plain; charset=utf-8', 'not found');
  const inBoot = r.base === BOOT_DIR;
  if (!inBoot && !installed(s.dir)) return send(res, 503, 'text/plain; charset=utf-8', 'StarNet is not installed on this machine: run `rigs starnet install`');
  if (r.index) {
    try { return send(res, 200, TYPES['.html'], transformIndex(await fsp.readFile(r.file, 'utf8'), s.ref)); } catch (e) { return send(res, 500, 'text/plain; charset=utf-8', e.message); }
  }
  if (!path.resolve(r.file).startsWith(path.resolve(r.base) + path.sep)) return send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
  let st;
  try { st = await fsp.stat(r.file); } catch { st = null; }
  if (!st?.isFile()) return send(res, 404, 'text/plain; charset=utf-8', 'not found');
  // Installed files are pinned to a commit: safe to cache. The RIGS boot files follow this checkout.
  res.writeHead(200, { 'content-type': TYPES[path.extname(r.file).toLowerCase()] || 'application/octet-stream', 'content-length': st.size, 'cache-control': inBoot ? 'no-cache' : 'public, max-age=86400', 'x-content-type-options': 'nosniff' });
  fs.createReadStream(r.file).pipe(res);
}

/** Defence in depth beside rigs-boot.js's network fence: the station frame never calls the RIGS API. */
export function blockedApiCall(req) {
  return fromStation(req);
}
