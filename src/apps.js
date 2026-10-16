import fs from 'node:fs';
import { CONFIG_FILE, config } from './config.js';

/**
 * App registry: web apps hosted on a node and shared with the mesh (the "App Cloud").
 *
 * Declared per node in ~/.rigs/config.json → "apps":
 *   { "id": "szuf", "name": "SZÜF", "icon": "🚗",
 *     "port": 8787,                       // or "url": "http://100.82.152.1:8787" (exactly one of the two)
 *     "host": "100.82.152.1",             // optional, with "port" only; default 127.0.0.1
 *     "healthPath": "/healthz",           // optional, default "/"
 *     "launch": { "systemd": "szuf.service" }  // or { "command": "…" }; informational, used to start the app
 *     "rewrite": { "rootRelative": true, "basePath": "/ui", "cookies": true, "websocket": true } }  // proxy hints
 * The node name is never declared; it always comes from config().name.
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
  if (raw.launch !== undefined && raw.launch !== null) {
    const l = raw.launch;
    const unit = l && typeof l.systemd === 'string' ? l.systemd.trim() : '';
    const cmd = l && typeof l.command === 'string' ? l.command.trim() : '';
    if (!l || typeof l !== 'object' || (!!unit === !!cmd)) errors.push('launch needs exactly one of systemd (unit name) or command');
    else if (unit && !/^[\w@.:-]+$/.test(unit)) errors.push('launch.systemd is not a valid unit name');
    else launch = unit ? { systemd: unit } : { command: cmd };
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
    app: { id, name: String(raw.name || id), icon: String(raw.icon || ''), node, target, healthPath, launch, rewrite },
    errors: [],
  };
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
  const isSelf = !key || key === 'self' || key === 'local' || key === cfg.name.toLowerCase() || key === String(cfg.nodeId).toLowerCase();
  if (isSelf) {
    const a = localApps().apps.find((x) => x.id === appId);
    return a ? { local: true, node: cfg.name, nodeId: cfg.nodeId, app: a } : null;
  }
  const a = meshCatalog.find((x) => x.id === appId && (x.node.toLowerCase() === key || String(x.nodeId).toLowerCase() === key));
  return a ? { local: a.node === cfg.name, node: a.node, nodeId: a.nodeId, app: a } : null;
}
