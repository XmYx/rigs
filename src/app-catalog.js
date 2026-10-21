// The installed-application catalog behind GET /api/local/appstream/catalog (docs/app-streaming.md §9): which GUI apps
// this machine has, with an icon, how to launch each and whether it can be streamed. Parsers are pure (test/app-catalog.test.js,
// fixtures in test/fixtures/app-catalog); the scanners at the bottom read the OS (Linux .desktop files, macOS .app bundles,
// Windows Start-menu shortcuts) and are cached for a minute.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { RIGS_HOME } from './config.js';
import { run } from './util.js';

const ID_RE = /^[\w.+-]{1,200}$/;
const TTL_MS = 60_000;
const SVG_MAX = 256 * 1024;
const NOTE_PROFILE = 'may refuse to start while it runs on the desktop (profile lock)';
/** Apps that keep a profile lock: a second instance next to the one on the desktop tends to exit at once. */
const PROFILE_APPS = /^(?:firefox|chromium|google-chrome|brave-browser|discord|slack|code|jetbrains-|idea|pycharm|webstorm|goland|clion|rider|phpstorm|datagrip)/i;

// ------------------------------------------------------------------ pure: .desktop files

const unescapeValue = (v) => v.replace(/\\(s|n|t|r|\\|;)/g, (_, c) => ({ s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\', ';': ';' })[c]);
const bool = (v) => String(v || '').trim().toLowerCase() === 'true';
const list = (v) => String(v || '').split(/(?<!\\);/).map((s) => s.trim()).filter(Boolean);

/**
 * A .desktop file → the keys of its [Desktop Entry] group as an object. Localized keys (Name[de]) are ignored: the
 * JARVIS UI is English. Booleans become booleans, Categories/OnlyShowIn/NotShowIn arrays.
 */
export function parseDesktopEntry(text) {
  const out = {};
  let inEntry = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const g = /^\[(.+)\]$/.exec(line);
    if (g) { inEntry = g[1] === 'Desktop Entry'; continue; }
    if (!inEntry) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z0-9-]+$/.test(key) || key in out) continue; // localized keys have [..]; first one wins
    out[key] = line.slice(eq + 1).trim();
  }
  const entry = {};
  for (const k of ['NoDisplay', 'Hidden', 'Terminal', 'DBusActivatable', 'StartupNotify']) entry[k] = false;
  for (const [k, v] of Object.entries(out)) entry[k] = ['NoDisplay', 'Hidden', 'Terminal', 'DBusActivatable', 'StartupNotify'].includes(k) ? bool(v) : unescapeValue(v);
  for (const k of ['Categories', 'OnlyShowIn', 'NotShowIn']) entry[k] = list(out[k]);
  return entry;
}

/**
 * Exec= → argv, per the Desktop Entry spec: double-quoted arguments (with \" \` \$ \\ escapes), field codes %f %F %u %U
 * take `files` (nothing when there are none), %i → --icon <Icon>, %c → Name, %k → the file's path, %% → %, deprecated and
 * unknown codes vanish.
 */
export function desktopExecArgv(exec, files = [], { name = '', icon = '', path: file = '' } = {}) {
  const words = [];
  let cur = '', started = false, quoted = false;
  const s = String(exec || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '\\' && i + 1 < s.length && '"`$\\'.includes(s[i + 1])) cur += s[++i];
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') { quoted = true; started = true; } else if (/\s/.test(c)) {
      if (started || cur) words.push(cur);
      cur = ''; started = false;
    } else { cur += c; started = true; }
  }
  if (started || cur) words.push(cur);
  const argv = [];
  for (const word of words) {
    if (/^%[fFuU]$/.test(word)) { argv.push(...(word === '%f' || word === '%u' ? files.slice(0, 1) : files)); continue; }
    if (word === '%i') { if (icon) argv.push('--icon', icon); continue; }
    const v = word.replace(/%(.)/g, (_, k) => (k === '%' ? '%' : k === 'c' ? name : k === 'k' ? file : ''));
    if (v !== '' || word === '') argv.push(v); // a word that was only an unknown or deprecated code vanishes
  }
  return argv;
}

/** The catalog id of a .desktop file: its path under an applications/ directory, '/' → '-', without ".desktop". */
export function desktopId(file, root) {
  const rel = path.relative(root, file).split(path.sep).join('-').replace(/\.desktop$/, '');
  return sanitizeId(rel);
}

export function sanitizeId(id) {
  const s = String(id || '').replace(/[^\w.+-]/g, '_').slice(0, 200);
  return ID_RE.test(s) ? s : '';
}

/** The source of a .desktop file by the directory it was found in. */
export function desktopSource(file) {
  if (/\/flatpak\/exports\//.test(file)) return 'flatpak';
  if (/\/snapd\/desktop\//.test(file)) return 'snap';
  return 'desktop';
}

/** Why a .desktop entry is not listed at all (null = list it). `hasExe(name)` answers TryExec. */
export function desktopSkip(entry, { hasExe = () => true, desktop = 'GNOME' } = {}) {
  if (entry.Type !== 'Application') return 'not an application';
  if (entry.NoDisplay || entry.Hidden) return 'hidden';
  if (!entry.Name || !(entry.Exec || entry.DBusActivatable)) return 'incomplete';
  const cur = String(desktop).split(':').filter(Boolean);
  if (entry.OnlyShowIn?.length && !entry.OnlyShowIn.some((d) => cur.includes(d))) return 'not for this desktop';
  if (entry.NotShowIn?.some((d) => cur.includes(d))) return 'not for this desktop';
  if (entry.TryExec && !hasExe(entry.TryExec)) return 'TryExec missing';
  return null;
}

/** One catalog item from a parsed .desktop entry. `streamable`/`why` are about the entry only; the host adds its own limits. */
export function desktopItem(entry, file, id, source = desktopSource(file)) {
  const argv = desktopExecArgv(entry.Exec, [], { name: entry.Name, icon: entry.Icon, path: file });
  const item = {
    id, name: entry.Name, ...(entry.GenericName ? { generic: entry.GenericName } : {}), ...(entry.Comment ? { comment: entry.Comment } : {}),
    icon: null, source, path: file, categories: entry.Categories || [], terminal: !!entry.Terminal,
    streamable: !entry.Terminal, ...(entry.Terminal ? { why: 'a terminal program, not a window app' } : {}),
    launch: { kind: 'desktop', file, argv, dbus: !!entry.DBusActivatable, acceptsFiles: /%[fFuU]/.test(entry.Exec || '') },
    running: [],
  };
  if (PROFILE_APPS.test(id) || PROFILE_APPS.test(path.basename(argv[0] || ''))) item.note = NOTE_PROFILE;
  return item;
}

/**
 * Icon file candidates for `Icon=` (absolute path as it is, or a theme name over the standard directories), best first.
 * `dataDirs` are the XDG data dirs (their icons/ is searched), `home` the user's home.
 */
export function iconCandidates(icon, { dataDirs = [], home = os.homedir() } = {}) {
  if (!icon) return [];
  if (path.isAbsolute(icon)) return [icon];
  const bare = icon.replace(/\.(png|svg|xpm)$/i, '');
  const roots = [path.join(home, '.local/share/icons'), path.join(home, '.icons'), ...dataDirs.map((d) => path.join(d, 'icons'))];
  const out = [];
  for (const r of roots) {
    for (const theme of ['hicolor', 'Yaru', 'Adwaita']) {
      for (const size of ['256x256', '128x128', 'scalable', '64x64', '48x48']) {
        for (const ext of size === 'scalable' ? ['svg'] : ['png', 'svg']) out.push(path.join(r, theme, size, 'apps', `${bare}.${ext}`));
      }
    }
    for (const ext of ['png', 'svg']) out.push(path.join(r, `${bare}.${ext}`));
  }
  for (const d of dataDirs) for (const ext of ['png', 'svg']) out.push(path.join(path.dirname(d), 'pixmaps', `${bare}.${ext}`));
  out.push(`/usr/share/pixmaps/${bare}.png`, `/usr/share/pixmaps/${bare}.svg`);
  return [...new Set(out)];
}

// ------------------------------------------------------------------ pure: macOS bundles

/**
 * An Info.plist (as the JSON `plutil -convert json` makes of it) → a catalog item, or null for apps that have no window
 * (LSUIElement / LSBackgroundOnly) or no usable id.
 */
export function parseInfoPlist(info, bundlePath, source = 'bundle') {
  if (!info || typeof info !== 'object') return null;
  if (info.LSUIElement === true || info.LSUIElement === '1' || info.LSBackgroundOnly === true || info.LSBackgroundOnly === '1') return null;
  if (info.CFBundlePackageType && info.CFBundlePackageType !== 'APPL') return null;
  const base = path.basename(bundlePath).replace(/\.app$/i, '');
  const id = sanitizeId(info.CFBundleIdentifier || base);
  if (!id) return null;
  const iconFile = info.CFBundleIconFile ? String(info.CFBundleIconFile) : '';
  return {
    id, name: String(info.CFBundleDisplayName || info.CFBundleName || base), icon: null, source, path: bundlePath,
    categories: info.LSApplicationCategoryType ? [String(info.LSApplicationCategoryType).replace(/^public\.app-category\./, '')] : [],
    terminal: false, streamable: true,
    launch: { kind: 'bundle', path: bundlePath },
    iconFile: iconFile ? (/\.icns$/i.test(iconFile) ? iconFile : `${iconFile}.icns`) : '',
    running: [],
  };
}

// ------------------------------------------------------------------ pure: Windows

/** The rows of the PowerShell scan (Name, Target, Args, AppId, Path) → catalog items; all `streamable:false` until a Windows host exists. */
export function windowsItems(rows = []) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const name = String(r?.Name || '').trim();
    if (!name || /^(uninstall|readme|help|documentation|release notes)\b/i.test(name)) continue;
    const appx = !!r.AppId && !r.Path;
    const id = sanitizeId(r.AppId ? `appx-${String(r.AppId).replace(/[^\w.+-]/g, '_')}` : `lnk-${crypto.createHash('sha1').update(String(r.Path || name)).digest('hex').slice(0, 12)}`);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id, name, icon: null, source: appx ? 'appx' : 'startmenu', path: String(r.Path || r.AppId || ''), categories: [], terminal: false,
      streamable: false, why: 'Windows app hosting is not available yet',
      launch: appx ? { kind: 'appx', appId: String(r.AppId) } : { kind: 'lnk', path: String(r.Path || ''), target: String(r.Target || ''), args: String(r.Args || '') },
      running: [],
    });
  }
  return out;
}

// ------------------------------------------------------------------ catalog shaping

/** The host's limit for this OS (until the stream host reports its own): why apps here cannot be opened, or null. */
export function hostSupport(platform = process.platform) {
  if (platform === 'linux') return { supported: true };
  // macOS streams the app's windows on the shared desktop (docs/app-streaming.md §3.6): starting one needs screen
  // control, and the start says so precisely when it is off.
  if (platform === 'darwin') return { supported: true, shared: true };
  return { supported: false, why: 'Windows app hosting is not available yet' };
}

/** Sort by name (natural, case-insensitive), apply the host's limit to every item and give each its icon URL. */
export function shapeItems(items, { host = { supported: true }, hasIcon = () => true } = {}) {
  return [...items].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })).map((it) => {
    const { iconFile: _f, iconPath: _p, ...rest } = it;
    const blocked = !host.supported;
    return {
      ...rest, icon: hasIcon(it) ? `appstream/catalog/${encodeURIComponent(it.id)}/icon` : null,
      streamable: !blocked && it.streamable, ...(blocked ? { why: host.why } : it.streamable ? {} : { why: it.why }),
    };
  });
}

// ------------------------------------------------------------------ scanners

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const readdir = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };

/** System-wide flatpak and snap export roots: not under $HOME or XDG_DATA_DIRS, so tests pass their own (or none). */
const SYSTEM_DIRS = ['/var/lib/flatpak/exports/share', '/var/lib/snapd/desktop'];

function dataDirs(env = process.env, home = os.homedir(), systemDirs = SYSTEM_DIRS) {
  const xdg = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  return [path.join(home, '.local/share'), path.join(home, '.local/share/flatpak/exports/share'), ...systemDirs, ...xdg];
}

function hasExecutable(name, env = process.env) {
  if (path.isAbsolute(name)) return exists(name);
  return (env.PATH || '').split(path.delimiter).some((d) => d && exists(path.join(d, name)));
}

function walkDesktop(dir, out = [], depth = 0) {
  for (const e of readdir(dir)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 3) walkDesktop(p, out, depth + 1);
    else if (e.name.endsWith('.desktop') && (e.isFile() || e.isSymbolicLink())) out.push(p);
  }
  return out;
}

/** Linux: every visible Application in the .desktop directories, earlier directories winning over later ones. */
export function scanLinux({ env = process.env, home = os.homedir(), systemDirs = SYSTEM_DIRS } = {}) {
  const dirs = dataDirs(env, home, systemDirs);
  const desktop = env.XDG_CURRENT_DESKTOP || 'GNOME';
  const seen = new Map();
  for (const base of dirs) {
    const root = path.join(base, 'applications');
    for (const file of walkDesktop(root)) {
      const id = desktopId(file, root);
      if (!id || seen.has(id)) continue;
      let entry;
      try { entry = parseDesktopEntry(fs.readFileSync(file, 'utf8')); } catch { continue; }
      // A hidden entry still claims the id: it masks the same id in later directories.
      if (desktopSkip(entry, { hasExe: (n) => hasExecutable(n, env), desktop })) { seen.set(id, null); continue; }
      const item = desktopItem(entry, file, id);
      item.iconPath = iconCandidates(entry.Icon, { dataDirs: dirs, home }).find((c) => exists(c) && (!c.endsWith('.svg') || fs.statSync(c).size <= SVG_MAX)) || '';
      seen.set(id, item);
    }
  }
  return [...seen.values()].filter(Boolean);
}

const MAC_DIRS = () => ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', path.join(os.homedir(), 'Applications')];

/** macOS: *.app one level deep in the usual folders; Info.plist read through plutil. */
export async function scanMac({ dirs = MAC_DIRS() } = {}) {
  const apps = [];
  for (const d of dirs) for (const e of readdir(d)) if (e.name.endsWith('.app') && (e.isDirectory() || e.isSymbolicLink())) apps.push(path.join(d, e.name));
  const items = new Map();
  const queue = [...apps];
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      const plist = path.join(p, 'Contents/Info.plist');
      if (!exists(plist)) continue;
      const r = await run('plutil', ['-convert', 'json', '-o', '-', plist], { timeout: 8000 }).catch(() => null);
      let info = null;
      try { info = JSON.parse(r?.stdout || ''); } catch { /* binary plist plutil could not read */ }
      const item = parseInfoPlist(info, p);
      if (!item || items.has(item.id)) continue;
      if (item.iconFile) { const f = path.join(p, 'Contents/Resources', item.iconFile); if (exists(f)) item.iconPath = f; }
      items.set(item.id, item);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return [...items.values()];
}

const WIN_SCAN = `$ErrorActionPreference='SilentlyContinue'
$sh = New-Object -ComObject WScript.Shell
$rows = @()
foreach ($d in @("$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs", "$env:AppData\\Microsoft\\Windows\\Start Menu\\Programs")) {
  Get-ChildItem -Path $d -Recurse -Filter *.lnk | ForEach-Object { $l = $sh.CreateShortcut($_.FullName); $rows += [pscustomobject]@{ Name = $_.BaseName; Path = $_.FullName; Target = $l.TargetPath; Args = $l.Arguments } }
}
Get-StartApps | ForEach-Object { $rows += [pscustomobject]@{ Name = $_.Name; AppId = $_.AppID } }
$rows | ConvertTo-Json -Compress`;

/** Windows: Start-menu shortcuts and Get-StartApps through PowerShell (best effort). */
export async function scanWindows() {
  const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', WIN_SCAN], { timeout: 30000 }).catch(() => null);
  let rows = [];
  try { const j = JSON.parse(r?.stdout || '[]'); rows = Array.isArray(j) ? j : [j]; } catch { /* no PowerShell */ }
  return windowsItems(rows.filter((x) => !x.Path || /\.lnk$/i.test(x.Path)));
}

// ------------------------------------------------------------------ cached catalog + icons

let cache = null;
let inflight = null;

async function scan(platform) {
  if (platform === 'linux') return scanLinux();
  if (platform === 'darwin') return scanMac();
  if (platform === 'win32') return scanWindows();
  return [];
}

/** The catalog: { node, os, generatedAt, host, items }. Cached 60 s (`refresh` rescans); concurrent calls share one scan. */
export async function catalog({ refresh = false, node = os.hostname(), platform = process.platform, host } = {}) {
  if (!refresh && cache && Date.now() - cache.at < TTL_MS && cache.platform === platform) return present(cache, node, host);
  inflight ||= scan(platform).then((items) => { cache = { at: Date.now(), platform, raw: items }; return cache; }).finally(() => { inflight = null; });
  return present(await inflight, node, host);
}

function present(c, node, host) {
  const h = host || hostSupport(c.platform);
  const items = shapeItems(c.raw, { host: h, hasIcon: (it) => !!it.iconPath });
  return { node, os: c.platform === 'darwin' ? 'macos' : c.platform === 'win32' ? 'windows' : c.platform, generatedAt: new Date(c.at).toISOString(), host: h, items };
}

/**
 * The raw catalog item for `id` (what a session start needs): { id, name, path, launch: { kind: 'desktop', file, argv, dbus,
 * acceptsFiles } | { kind: 'bundle', path } | …, streamable, why? } or null. Scans when nothing is cached yet.
 */
export async function findItem(id, opts = {}) {
  if (!cache) await catalog(opts);
  const it = cache?.raw.find((x) => x.id === id);
  if (!it) return null;
  const { iconPath: _p, ...rest } = it;
  return rest;
}

const iconDir = () => path.join(RIGS_HOME, 'appstream', 'icons');

/**
 * The icon of catalog item `id` → { body, type, etag } or null. PNG and small SVG as they are; macOS .icns through sips into
 * RIGS_HOME/appstream/icons (cached by the icns mtime).
 */
export async function icon(id, { size = 64 } = {}) {
  if (!cache) await catalog();
  const it = cache?.raw.find((x) => x.id === id);
  if (!it?.iconPath) return null;
  const src = it.iconPath;
  const px = [64, 128, 256].includes(Number(size)) ? Number(size) : 64;
  const mtime = (() => { try { return fs.statSync(src).mtimeMs; } catch { return 0; } })();
  if (/\.icns$/i.test(src)) {
    const out = path.join(iconDir(), `${id}-${px}-${Math.round(mtime)}.png`);
    if (!exists(out)) {
      fs.mkdirSync(iconDir(), { recursive: true });
      const r = await run('sips', ['-s', 'format', 'png', '-Z', String(px), src, '--out', out], { timeout: 10000 }).catch(() => null);
      if (!r || !exists(out)) return null;
    }
    return fileBody(out, 'image/png');
  }
  if (/\.svg$/i.test(src)) return fileBody(src, 'image/svg+xml');
  if (/\.png$/i.test(src)) return fileBody(src, 'image/png');
  return null; // .xpm and friends
}

function fileBody(file, type) {
  try {
    const body = fs.readFileSync(file);
    return { body, type, etag: `"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 16)}"` };
  } catch { return null; }
}

/** Test hook. */
export function resetCache() { cache = null; inflight = null; }
