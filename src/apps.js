import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_FILE, config } from './config.js';

/**
 * App registry: web apps hosted on a node and shared with the mesh (the "App Cloud").
 *
 * Declared per node in ~/.rigs/config.json → "apps":
 *   { "id": "szuf", "name": "SZÜF", "icon": "🚗",
 *     "port": 8787,                       // or "url": "http://100.82.152.1:8787" (exactly one of the two)
 *     "host": "100.82.152.1",             // optional, with "port" only; default 127.0.0.1
 *     "healthPath": "/healthz",           // optional, default "/"
 *     "launch": { "systemd": "szuf.service" }  // or { "command": "…" }; used to start the app (see LAUNCH below)
 *     "description": "what it does, for whom",  // optional, ≤ 500 chars; tool_list / GET /api/tools search it
 *     "tags": ["cars", "dashboard"],      // optional short words (a-z, 0-9, . + - _), searched and filterable (tool_list tag)
 *     "rewrite": { "rootRelative": true, "basePath": "/ui", "cookies": true, "websocket": true } }  // proxy hints
 * The node name is never declared; it always comes from config().name.
 *
 * LAUNCH recipe, per OS: { systemd?, command?, cwd?, env?, linux?, darwin?, windows? }.
 *   - systemd: a `systemctl --user` unit, used on Linux only. command: a command line, used on any OS (on Linux
 *     only when there is no systemd unit). cwd (default ~) and env apply to that top-level command.
 *   - linux | darwin | windows: the recipe for that OS, which replaces the top-level one there:
 *     { command, cwd?, env? } (or just the command string); linux may give { systemd } instead.
 *   e.g. { "systemd": "szuf.service", "windows": { "command": "szuf.cmd", "cwd": "~/szuf" } }.
 * launchFor(launch, platform) picks the recipe for a platform; app.launchHere is the one this node runs.
 *
 * Health: every app is probed with GET <target><healthPath> on an interval with a timeout. Any HTTP
 * answer below 500 counts as up (a login wall still means the app runs); a network error, timeout or
 * 5xx is down. Status is "unknown" until the first probe finishes (or for an app that was never probed).
 */

export const APP_STATUS = Object.freeze({ UP: 'up', DOWN: 'down', UNKNOWN: 'unknown' });
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const REWRITE_KEYS = { rootRelative: 'boolean', basePath: 'string', cookies: 'boolean', websocket: 'boolean' };

/**
 * Validate one declared app. Returns { app, errors }; app is null when errors is non-empty.
 * `app.target` is the base URL the daemon forwards to (no trailing slash).
 */
export function validateApp(raw, node = config().name) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { app: null, errors: ['app must be an object'] };
  const id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase() : '';
  if (!ID_RE.test(id)) errors.push('id must be 1-40 chars of a-z, 0-9, - or _');
  const hasPort = raw.port !== undefined && raw.port !== null && raw.port !== '';
  const hasUrl = raw.url !== undefined && raw.url !== null && raw.url !== '';
  let target = '';
  if (hasPort === hasUrl) errors.push('declare exactly one of port or url');
  else if (hasPort) {
    const port = Number(raw.port);
    const host = raw.host === undefined ? '127.0.0.1' : String(raw.host);
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('port must be an integer 1-65535');
    else if (!/^[\w.:-]+$/.test(host)) errors.push('host is not a valid hostname or IP');
    else target = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  } else {
    try {
      const u = new URL(String(raw.url));
      if (!/^https?:$/.test(u.protocol)) errors.push('url must be http(s)');
      else target = u.origin + u.pathname.replace(/\/+$/, '');
    } catch { errors.push('url is not a valid URL'); }
  }
  let healthPath = raw.healthPath === undefined || raw.healthPath === '' ? '/' : String(raw.healthPath);
  if (!healthPath.startsWith('/')) errors.push('healthPath must start with /');

  let launch = null;
  if (raw.launch !== undefined && raw.launch !== null) launch = validateLaunch(raw.launch, errors);

  let description = '';
  if (raw.description !== undefined && raw.description !== null) {
    if (typeof raw.description !== 'string') errors.push('description must be text');
    else if (raw.description.trim().length > 500) errors.push('description must be at most 500 characters');
    else description = raw.description.trim();
  }
  let tags = [];
  if (raw.tags !== undefined && raw.tags !== null) {
    if (!Array.isArray(raw.tags) || !raw.tags.every((t) => typeof t === 'string' && /^[\w.+-]{1,32}$/.test(t.trim()))) errors.push('tags must be an array of short words (a-z, 0-9, . + - _)');
    else tags = [...new Set(raw.tags.map((t) => t.trim().toLowerCase()))].slice(0, 20);
  }

  let rewrite = {};
  if (raw.rewrite !== undefined && raw.rewrite !== null) {
    if (typeof raw.rewrite !== 'object' || Array.isArray(raw.rewrite)) errors.push('rewrite must be an object');
    else {
      for (const [k, v] of Object.entries(raw.rewrite)) {
        if (!(k in REWRITE_KEYS)) errors.push(`rewrite.${k} is not a known hint (${Object.keys(REWRITE_KEYS).join(', ')})`);
        else if (typeof v !== REWRITE_KEYS[k]) errors.push(`rewrite.${k} must be a ${REWRITE_KEYS[k]}`);
        else rewrite[k] = v;
      }
      if (rewrite.basePath !== undefined && !rewrite.basePath.startsWith('/')) errors.push('rewrite.basePath must start with /');
    }
  }
  if (errors.length) return { app: null, errors: errors.map((e) => `${id || '?'}: ${e}`) };
  return {
    app: { id, name: String(raw.name || id), icon: String(raw.icon || ''), node, target, healthPath, launch, launchHere: launchFor(launch), rewrite, ...(description ? { description } : {}), ...(tags.length ? { tags } : {}) },
    errors: [],
  };
}

export const LAUNCH_OS = Object.freeze(['linux', 'darwin', 'windows']);
const LAUNCH_OS_ALIAS = { win32: 'windows', mac: 'darwin', macos: 'darwin' };
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The launch-recipe key for a Node platform name ('win32' → 'windows', 'darwin', anything else → 'linux'). */
export function launchOs(platform = process.platform) {
  return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux';
}

/** One { command, cwd?, env? } (or { systemd } where allowed) recipe; pushes errors and returns null when invalid. */
function validateRecipe(r, field, { systemd, requireOne }, errors) {
  if (typeof r === 'string') r = { command: r };
  if (!r || typeof r !== 'object' || Array.isArray(r)) { errors.push(`${field} must be an object`); return null; }
  const unit = typeof r.systemd === 'string' ? r.systemd.trim() : '';
  const cmd = typeof r.command === 'string' ? r.command.trim() : '';
  const before = errors.length;
  if (r.systemd !== undefined && !systemd) errors.push(`${field}.systemd is Linux only (give a command here)`);
  else if (r.systemd !== undefined && !unit) errors.push(`${field}.systemd must be a unit name`);
  else if (unit && !/^[\w@.:-]+$/.test(unit)) errors.push(`${field}.systemd is not a valid unit name`);
  if (r.command !== undefined && !cmd) errors.push(`${field}.command must be a command line`);
  if (requireOne && !!unit === !!cmd && errors.length === before) errors.push(`${field} needs exactly one of systemd (unit name) or command`);
  else if (!requireOne && !unit && !cmd && errors.length === before) errors.push(`${field} needs a command`);
  if (r.cwd !== undefined && typeof r.cwd !== 'string') errors.push(`${field}.cwd must be a path`);
  const env = {};
  if (r.env !== undefined) {
    if (!r.env || typeof r.env !== 'object' || Array.isArray(r.env)) errors.push(`${field}.env must be an object of NAME: "value"`);
    else for (const [k, v] of Object.entries(r.env)) {
      if (!ENV_RE.test(k)) errors.push(`${field}.env.${k} is not a valid variable name`);
      else if (!['string', 'number', 'boolean'].includes(typeof v)) errors.push(`${field}.env.${k} must be a string`);
      else env[k] = String(v);
    }
  }
  if (errors.length > before) return null;
  return { ...(unit ? { systemd: unit } : {}), ...(cmd ? { command: cmd } : {}), ...(cmd && r.cwd ? { cwd: r.cwd } : {}), ...(cmd && Object.keys(env).length ? { env } : {}) };
}

/**
 * Validate a launch recipe (shapes in LAUNCH above). Old shapes normalize to themselves ({ systemd } / { command }).
 * Pushes readable errors and returns the normalized recipe or null.
 */
export function validateLaunch(l, errors = []) {
  if (!l || typeof l !== 'object' || Array.isArray(l)) { errors.push('launch must be an object'); return null; }
  const before = errors.length;
  const out = {};
  const perOs = {};
  for (const [k, v] of Object.entries(l)) {
    const key = LAUNCH_OS_ALIAS[k] || k;
    if (!LAUNCH_OS.includes(key) || v === undefined || v === null) continue;
    if (perOs[key]) { errors.push(`launch.${k} repeats launch.${key}`); continue; }
    perOs[key] = validateRecipe(v, `launch.${k}`, { systemd: key === 'linux', requireOne: key === 'linux' }, errors);
  }
  const hasTop = ['systemd', 'command'].some((k) => l[k] !== undefined && l[k] !== null && l[k] !== '');
  if (hasTop) {
    const top = validateRecipe({ systemd: l.systemd || undefined, command: l.command || undefined, cwd: l.cwd, env: l.env }, 'launch', { systemd: true, requireOne: false }, errors);
    if (top) Object.assign(out, top);
  } else if (!Object.keys(perOs).length) errors.push('launch needs systemd (unit name), command, or a per-OS recipe (linux, darwin, windows)');
  if (errors.length > before) return null;
  for (const k of LAUNCH_OS) if (perOs[k]) out[k] = perOs[k];
  return out;
}

/**
 * The recipe a node on `platform` runs: { systemd } | { command, cwd, env } | null (nothing for that OS).
 * A per-OS entry wins; else the top-level systemd unit (Linux only), else the top-level command. Pure.
 */
export function launchFor(launch, platform = process.platform) {
  if (!launch) return null;
  const osKey = launchOs(platform);
  const r = launch[osKey] || launch;
  if (r.systemd && osKey === 'linux') return { systemd: r.systemd };
  if (r.command) return { command: r.command, cwd: r.cwd || '', env: r.env || {} };
  return null;
}

/** Split a Windows command line into argv the way CommandLineToArgvW does for the common cases ("…" quoting). Pure. */
export function splitWinCommand(line) {
  const args = [];
  let cur = '';
  let quoted = false;
  let any = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') {
      let n = 0;
      while (line[i] === '\\') { n++; i++; }
      if (line[i] === '"') { cur += '\\'.repeat(Math.floor(n / 2)); if (n % 2) cur += '"'; else { quoted = !quoted; any = true; } } else { cur += '\\'.repeat(n); i--; }
    } else if (c === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else { quoted = !quoted; any = true; }
    } else if (/\s/.test(c) && !quoted) {
      if (cur || any) args.push(cur);
      cur = ''; any = false;
    } else cur += c;
  }
  if (cur || any) args.push(cur);
  return args;
}

/**
 * How to spawn a { command, cwd, env } recipe on `platform`, without running it: { cmd, args, shell, cwd, env }. Pure
 * apart from `which`. POSIX: the command line through $SHELL (or /bin/sh), as before. Windows: never a POSIX shell —
 * a plain command line is split into argv and its program resolved on PATH (with .exe/.cmd/.bat/.ps1 shims) for
 * util.spawnCmd; only a line using cmd.exe syntax (& | < > ^ %VAR%) runs through cmd.exe.
 */
export function commandPlan(recipe, { platform = process.platform, which = () => null, home = os.homedir(), shellEnv = process.env.SHELL } = {}) {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const expand = (s) => (s === '~' ? home : /^~[\\/]/.test(s) ? p.join(home, s.slice(2)) : s);
  const cwd = recipe.cwd ? p.resolve(home, expand(recipe.cwd)) : home;
  const env = { ...(recipe.env || {}) };
  if (!win) return { cmd: recipe.command, args: [], shell: shellEnv || '/bin/sh', cwd, env };
  if (/[&|<>^%]/.test(recipe.command)) return { cmd: recipe.command, args: [], shell: true, cwd, env };
  const [prog = '', ...args] = splitWinCommand(recipe.command);
  const exe = expand(prog);
  const resolved = p.isAbsolute(exe) || /[\\/]/.test(exe) ? p.resolve(cwd, exe) : which(exe) || exe;
  return { cmd: resolved, args: args.map(expand), shell: false, cwd, env };
}

let diskMtime = 0;
/**
 * The declared apps, re-read from config.json whenever the file changes on disk, so an app added by
 * hand or by another process shows up without restarting the daemon. The in-memory config is updated
 * too, so a later saveConfig() does not write the stale list back.
 */
export function declaredApps() {
  const cfg = config();
  try {
    const mtime = fs.statSync(CONFIG_FILE).mtimeMs;
    if (mtime !== diskMtime) {
      diskMtime = mtime;
      const disk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).apps;
      if (disk !== undefined) cfg.apps = disk;
    }
  } catch { /* missing or mid-write: keep what we have */ }
  return cfg.apps;
}

/**
 * Register / update / remove one app in this node's config (POST /api/local/apps, mesh_app_register, a kept YOLO run):
 * `{ ...app }` or `{ id, remove: true }`. Throws { status: 400 } on an invalid app. → localApps().
 */
export async function upsertApp(b = {}) {
  const { saveConfig } = await import('./config.js');
  const cfg = config();
  const id = String(b.id || '').trim().toLowerCase();
  const rest = (declaredApps() || []).filter((a) => String(a.id || '').toLowerCase() !== id);
  if (!b.remove) {
    const { app, errors } = validateApp(b);
    if (!app) throw Object.assign(new Error(errors.join('; ')), { status: 400 });
    const { remove, ...raw } = b;
    rest.push({ ...raw, id });
  }
  cfg.apps = rest;
  saveConfig(cfg);
  checkAll().catch(() => {});
  return localApps();
}

/** Validate the whole "apps" array. Invalid and duplicate entries are dropped and reported. */
export function loadApps(list = declaredApps(), node = config().name) {
  const apps = [];
  const errors = [];
  const seen = new Set();
  for (const [i, raw] of (Array.isArray(list) ? list : []).entries()) {
    const { app, errors: errs } = validateApp(raw, node);
    if (!app) { errors.push(...errs.map((e) => (e.startsWith('?') ? `apps[${i}]${e.slice(1)}` : e))); continue; }
    if (seen.has(app.id)) { errors.push(`${app.id}: duplicate id`); continue; }
    seen.add(app.id);
    apps.push(app);
  }
  return { apps, errors };
}

/** Next health record after one probe result ({ ok, latencyMs, error }). Pure. */
export function nextHealth(prev, result, now = Date.now()) {
  const status = result.ok ? APP_STATUS.UP : APP_STATUS.DOWN;
  const changed = !prev || prev.status !== status;
  return {
    status,
    latencyMs: result.ok ? result.latencyMs : null,
    lastChecked: now,
    since: changed ? now : prev.since,
    failures: result.ok ? 0 : (prev?.failures || 0) + 1,
    error: result.ok ? '' : String(result.error || 'unreachable'),
  };
}

export const UNKNOWN_HEALTH = Object.freeze({ status: APP_STATUS.UNKNOWN, latencyMs: null, lastChecked: null, since: null, failures: 0, error: '' });

/** Probe one app once. `fetchImpl` is injectable for tests. Never throws. */
export async function probeApp(app, { timeoutMs = 4000, fetchImpl = fetch } = {}) {
  const t0 = Date.now();
  try {
    const r = await fetchImpl(app.target + app.healthPath, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    r.body?.cancel?.().catch?.(() => {});
    if (r.status >= 500) return { ok: false, error: `HTTP ${r.status}` };
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'timeout' : e.cause?.code || e.name || 'unreachable' };
  }
}

const health = new Map(); // app id → health record (local apps)
const listeners = new Set();
let lastSignature = '';
/** Subscribe to changes in this node's app list or any app's up/down status. Returns unsubscribe. */
export function onAppsChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function signature() {
  return loadApps().apps.map((a) => `${a.id}|${a.name}|${a.icon}|${a.target}|${health.get(a.id)?.status || 'unknown'}`).join('\n');
}
function emitIfChanged() {
  const sig = signature();
  if (sig === lastSignature) return;
  lastSignature = sig;
  for (const fn of listeners) { try { fn(localApps()); } catch { /* listener bugs never stop health checks */ } }
}
let meshCatalog = []; // last aggregated catalog, for resolveApp on peers
let timer = null;

/** This node's apps with their health. Served as GET /api/local/apps. */
export function localApps() {
  const { apps, errors } = loadApps();
  return { apps: apps.map((a) => ({ ...a, health: health.get(a.id) || UNKNOWN_HEALTH })), errors };
}

/** Probe every declared app once and record the result. */
export async function checkAll(opts = {}) {
  const { apps } = loadApps();
  const live = new Set(apps.map((a) => a.id));
  for (const id of health.keys()) if (!live.has(id)) health.delete(id);
  await Promise.all(apps.map(async (a) => {
    const res = await probeApp(a, opts);
    health.set(a.id, nextHealth(health.get(a.id), res));
  }));
  emitIfChanged();
}

export function startHealthChecks({ intervalMs = 15000, ...opts } = {}) {
  stopHealthChecks();
  checkAll(opts).catch(() => {});
  timer = setInterval(() => checkAll(opts).catch(() => {}), intervalMs);
  timer.unref?.();
}

export function stopHealthChecks() { clearInterval(timer); timer = null; }

export function resetAppsState() { health.clear(); meshCatalog = []; lastSignature = ''; diskMtime = 0; }

/**
 * Merge per-node results into the mesh catalog. `results` = [{ node: {id,name}, apps?: [...], error? }].
 * Each app is tagged with node (name) and nodeId; failed nodes are reported in `errors`, not dropped silently.
 * Sorted by node then id so output is stable.
 */
export function aggregateApps(results) {
  const apps = [];
  const errors = [];
  for (const r of results) {
    if (r.error) { errors.push({ node: r.node.name, error: r.error }); continue; }
    for (const a of r.apps || []) apps.push({ ...a, node: r.node.name, nodeId: r.node.id });
  }
  apps.sort((a, b) => a.node.localeCompare(b.node) || a.id.localeCompare(b.id));
  return { apps, errors };
}

/** Remember the latest aggregated catalog so resolveApp can find apps on peers. */
export function setMeshCatalog(apps) { meshCatalog = Array.isArray(apps) ? apps : []; }

/** The last aggregated mesh-wide catalog (empty until someone asked for /api/apps). */
export function meshCatalogApps() { return meshCatalog; }

/** True when a node reference (name, id, "self", "local" or empty) means this machine. */
export function isSelfRef(node) {
  const cfg = config();
  const key = String(node || '').toLowerCase();
  return !key || key === 'self' || key === 'local' || key === String(cfg.name).toLowerCase() || key === String(cfg.nodeId).toLowerCase();
}

/**
 * resolveApp(node, id) — lookup contract for the proxy (src/proxy.js).
 *  - node: node name (case-insensitive) or id; "self"/"local"/"" means this machine.
 *  - id:   app id (case-insensitive).
 *  Returns null when the app is unknown (proxy answers 404). Otherwise
 *    { local, node, nodeId, app }
 *  where app = { id, name, icon, node, target, healthPath, launch, rewrite, health }.
 *  local === true: this node hosts the app; forward HTTP/WS to app.target (base URL, no trailing slash)
 *    after applying app.rewrite. local === false: the app lives on a peer; forward to that peer's daemon
 *    at /api/nodes/<node>/apps/<id>/… (the peer then does the local forward); app.target is the PEER's
 *    local address and must not be dialled from here.
 *  health reflects the last probe (status 'unknown' when never probed); resolveApp does not probe.
 *  Local lookups read the live config; peer lookups use the catalog from the last GET /api/apps.
 */
export function resolveApp(node, id) {
  const cfg = config();
  const key = String(node || '').toLowerCase();
  const appId = String(id || '').toLowerCase();
  if (isSelfRef(node)) {
    const a = localApps().apps.find((x) => x.id === appId);
    return a ? { local: true, node: cfg.name, nodeId: cfg.nodeId, app: a } : null;
  }
  const a = meshCatalog.find((x) => x.id === appId && (x.node.toLowerCase() === key || String(x.nodeId).toLowerCase() === key));
  return a ? { local: a.node === cfg.name, node: a.node, nodeId: a.nodeId, app: a } : null;
}

const starting = new Map(); // app id → in-flight start promise (one start per app at a time)

/**
 * Spin an app up on this machine and wait until it answers its health check.
 *  - already up → { started: false, health }
 *  - the recipe for this OS (launchFor): systemd → `systemctl --user start <unit>` (Linux user units, the default
 *    for RIGS apps); command → run detached (commandPlan: the shell on macOS/Linux, util.spawnCmd with PATH and
 *    .cmd/.bat/.ps1 shims on Windows), output in ~/.rigs/logs/app-<id>.log
 * Throws when the app is unknown, has no launch recipe for this OS, or is not up within waitMs.
 * `deps` ({ run, spawn, spawnCmd, which, probe, sleep, platform }) is injectable for tests.
 */
export function startApp(id, { waitMs = 60000, pollMs = 1000, deps = {} } = {}) {
  const key = String(id || '').toLowerCase();
  if (starting.has(key)) return starting.get(key);
  const p = doStart(key, { waitMs, pollMs, deps }).finally(() => starting.delete(key));
  starting.set(key, p);
  return p;
}

async function doStart(id, { waitMs, pollMs, deps }) {
  const probe = deps.probe || probeApp;
  const sleep = deps.sleep || ((ms) => new Promise((ok) => setTimeout(ok, ms)));
  const platform = deps.platform || process.platform;
  const app = loadApps().apps.find((a) => a.id === id);
  if (!app) throw Object.assign(new Error(`unknown app ${id}`), { status: 404 });
  const record = (res) => { health.set(app.id, nextHealth(health.get(app.id), res)); emitIfChanged(); return health.get(app.id); };
  const first = await probe(app);
  if (first.ok) return { started: false, health: record(first) };
  if (!app.launch) throw Object.assign(new Error(`${app.name} is down and has no launch recipe (add "launch": { "systemd": … } or { "command": … })`), { status: 409 });
  const recipe = launchFor(app.launch, platform);
  const osKey = launchOs(platform);
  if (!recipe) throw Object.assign(new Error(`${app.name} is down and has no launch recipe for ${osKey} (add "launch": { "${osKey}": { "command": … } })`), { status: 409 });

  if (recipe.systemd) {
    const run = deps.run || (await import('./util.js')).run;
    const r = await run('systemctl', ['--user', 'start', recipe.systemd], { timeout: 30000 });
    if (r.code !== 0) throw Object.assign(new Error(`systemctl --user start ${recipe.systemd} failed: ${(r.stderr || r.stdout).trim()}`), { status: 502 });
  } else {
    const util = await import('./util.js');
    const { RIGS_HOME } = await import('./config.js');
    const plan = commandPlan(recipe, { platform, which: deps.which || util.which });
    const logDir = path.join(RIGS_HOME, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const fd = fs.openSync(path.join(logDir, `app-${app.id}.log`), 'a');
    const opts = { cwd: plan.cwd, env: { ...process.env, PATH: util.augmentedPath(), ...plan.env }, detached: true, stdio: ['ignore', fd, fd], windowsHide: true };
    let child;
    try {
      if (plan.shell) child = (deps.spawn || (await import('node:child_process')).spawn)(plan.cmd, { ...opts, shell: plan.shell });
      else child = (deps.spawnCmd || util.spawnCmd)(plan.cmd, plan.args, opts);
    } catch (e) {
      throw Object.assign(new Error(`could not start ${app.name}: ${e.message}`), { status: 502 });
    } finally { fs.closeSync(fd); }
    child.on?.('error', () => {});
    child.unref?.();
  }

  const deadline = Date.now() + waitMs;
  let last = first;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    last = await probe(app);
    if (last.ok) return { started: true, health: record(last) };
  }
  record(last);
  throw Object.assign(new Error(`${app.name} was started but did not answer ${app.healthPath} within ${Math.round(waitMs / 1000)}s`), { status: 504 });
}
