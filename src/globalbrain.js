// One JARVIS brain for the whole mesh. The settings that decide how JARVIS thinks and delegates — the conversational and
// core brains (provider · model · effort), the main-brain machine, the router / pre-routing, the routing rules, the quick
// path and YOLO mode — are global: changing them on any machine stamps a revision (config.globalRev) and every peer adopts the newest
// revision (pushed at once, pulled again whenever a peer comes back). Machine-bound bits stay local: brain.ollamaUrl,
// workRoot, permission modes, the LocalJev url and API key. Requests that reach any machine are relayed to the main-brain
// machine (homeNode), which answers and delegates work across the mesh; when it is unreachable the machine answers itself.
// Pure functions over a config object so node --test can check them.

// [path, keys to leave out] — whole sub-objects are synced, minus machine-bound keys.
export const GLOBAL_PATHS = [
  ['brain.core', []],
  ['brain.chat', []],
  ['brain.home', []],
  ['router', ['jev.url', 'jev.apiKey']],
  ['routing', []],
  ['quick', []],
  ['yolo', []], // YOLO mode (src/yolo.js): on/off and its model; the sandbox root is fixed per machine, not a setting
];

const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
function set(o, p, v) {
  const ks = p.split('.');
  let a = o;
  for (const k of ks.slice(0, -1)) { if (a[k] == null || typeof a[k] !== 'object') a[k] = {}; a = a[k]; }
  a[ks.at(-1)] = v;
}
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** The global part of a config: { 'brain.core': {...}, 'router': {...minus jev url/key}, ... }. */
export function globalSettings(cfg) {
  const out = {};
  for (const [p, omit] of GLOBAL_PATHS) {
    const v = clone(get(cfg, p));
    if (v === undefined) continue;
    for (const o of omit) if (v && typeof v === 'object') { const parent = o.includes('.') ? get(v, o.split('.').slice(0, -1).join('.')) : v; if (parent) delete parent[o.split('.').at(-1)]; }
    out[p] = v;
  }
  return out;
}

/** Write global settings into a config, keeping its machine-bound keys. Returns the same config object. */
export function applyGlobal(cfg, settings) {
  for (const [p, omit] of GLOBAL_PATHS) {
    if (!(p in (settings || {}))) continue;
    const next = clone(settings[p]);
    if (next && typeof next === 'object' && !Array.isArray(next)) {
      const cur = get(cfg, p);
      for (const o of omit) { const keep = get(cur, o); if (keep !== undefined) set(next, o, keep); }
    }
    set(cfg, p, next);
  }
  return cfg;
}

/** Does a settings patch (as sent to patchConfig) touch any global setting? */
export function touchesGlobal(patch) {
  if (!patch || typeof patch !== 'object') return false;
  return GLOBAL_PATHS.some(([p]) => get(patch, p) !== undefined);
}

/** The revision stamp: newer wins; equal stamps break ties by machine name so every node picks the same one. */
export const revOf = (cfg) => ({ rev: Number(cfg?.globalRev?.rev) || 0, by: String(cfg?.globalRev?.by || '') });
export function isNewer(a, b) {
  const x = { rev: Number(a?.rev) || 0, by: String(a?.by || '') };
  const y = { rev: Number(b?.rev) || 0, by: String(b?.by || '') };
  return x.rev !== y.rev ? x.rev > y.rev : x.by > y.by;
}
/** A fresh stamp, always newer than the current one even if the clock is behind. */
export function nextRev(cfg, by, now = Date.now()) {
  return { rev: Math.max(now, revOf(cfg).rev + 1), by };
}

/** The machine JARVIS's main brain runs on: brain.home, else the core brain's machine. '' = each machine answers itself. */
export function homeNode(cfg) {
  return String(cfg?.brain?.home || cfg?.brain?.core?.node || '');
}

/** Should a request that arrived on `self` be relayed to the main brain? Never twice (via = already relayed by a peer). */
export function relayTarget(cfg, self, { via = '' } = {}) {
  const home = homeNode(cfg);
  if (!home || via) return '';
  return home.toLowerCase() === String(self || '').toLowerCase() ? '' : home;
}
