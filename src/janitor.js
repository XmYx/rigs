// Process janitor: services RIGS started on this machine and nobody uses any more are shut down. Runs in every RIGS
// daemon, so on every machine of the mesh.
//
// Only what RIGS launched itself is tracked (`track`, called by apps.js when it issues an App Cloud app's launch
// recipe): a service Sir started by hand, or one that was already up, is never touched. Use is the App Cloud proxy:
// every proxied request `touch`es the app and an open WebSocket holds it (`hold` → release). A tracked service idle
// for `config.janitor.idleMinutes` (default 30) is stopped the way it was started: `systemctl --user stop <unit>`, or
// TERM (then KILL after 5 s) to the process group of the detached command. An app whose declaration says
// `"keepAlive": true` is never stopped. State survives a daemon restart in ~/.rigs/janitor.json.
// The decision is pure (`idleVictims`); tests in test/janitor.test.js.
import fs from 'node:fs';
import path from 'node:path';
import { config, RIGS_HOME } from './config.js';
import { log } from './util.js';

const FILE = () => path.join(RIGS_HOME, 'janitor.json');
export const DEFAULTS = Object.freeze({ enabled: true, idleMinutes: 30, intervalSec: 60 });

const tracked = new Map(); // id → { id, name, pid?, unit?, startedAt, lastUsed, holds }
let loaded = false;

export function settings(c = config()) {
  const j = { ...DEFAULTS, ...(c.janitor || {}) };
  return { enabled: j.enabled !== false, idleMinutes: Math.max(1, Number(j.idleMinutes) || DEFAULTS.idleMinutes), intervalSec: Math.max(10, Number(j.intervalSec) || DEFAULTS.intervalSec) };
}

function load() {
  if (loaded) return;
  loaded = true;
  try { for (const e of JSON.parse(fs.readFileSync(FILE(), 'utf8'))) if (e?.id) tracked.set(e.id, { ...e, holds: 0 }); } catch { /* none yet */ }
}
function save() {
  try { fs.mkdirSync(path.dirname(FILE()), { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify([...tracked.values()].map(({ holds, ...e }) => e), null, 1)); } catch (e) { log('janitor: save failed:', e.message); }
}

/** apps.js: RIGS just launched this app (pid of the detached command, or the systemd user unit). */
export function track({ id, name = '', pid = 0, unit = '' }, now = Date.now()) {
  load();
  const key = String(id || '').toLowerCase();
  if (!key) return;
  tracked.set(key, { id: key, name: name || key, ...(pid ? { pid } : {}), ...(unit ? { unit } : {}), startedAt: now, lastUsed: now, holds: 0 });
  save();
}

/** The proxy served a request for this app. */
export function touch(id, now = Date.now()) {
  load();
  const e = tracked.get(String(id || '').toLowerCase());
  if (e) e.lastUsed = now;
}

/** An open WebSocket keeps the app in use until the returned release() runs. */
export function hold(id) {
  load();
  const e = tracked.get(String(id || '').toLowerCase());
  if (!e) return () => {};
  e.holds = (e.holds || 0) + 1;
  let done = false;
  return () => { if (done) return; done = true; e.holds = Math.max(0, e.holds - 1); e.lastUsed = Date.now(); };
}

export function list() { load(); return [...tracked.values()].map((e) => ({ ...e })); }
export function forget(id) { load(); if (tracked.delete(String(id || '').toLowerCase())) save(); }

/** Which tracked services to stop now. Pure. `keep(id)` → true for apps declared keepAlive (or gone from the list). */
export function idleVictims(entries, { now = Date.now(), idleMinutes = DEFAULTS.idleMinutes, keep = () => false } = {}) {
  const limit = idleMinutes * 60000;
  return (entries || []).filter((e) => !(e.holds > 0) && now - (e.lastUsed || e.startedAt || 0) >= limit && !keep(e.id));
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** Stop one tracked service the way it was started. deps = { run, kill, sleep } for tests. */
export async function stopService(e, deps = {}) {
  const kill = deps.kill || process.kill.bind(process);
  const sleep = deps.sleep || ((ms) => new Promise((ok) => setTimeout(ok, ms)));
  if (e.unit) {
    const run = deps.run || (await import('./util.js')).run;
    const r = await run('systemctl', ['--user', 'stop', e.unit], { timeout: 30000 });
    return r.code === 0;
  }
  if (!e.pid) return false;
  const isAlive = deps.alive || alive;
  const sig = (s) => { try { kill(process.platform === 'win32' ? e.pid : -e.pid, s); } catch { try { kill(e.pid, s); } catch { /* gone */ } } };
  if (!isAlive(e.pid)) return true;
  sig('SIGTERM');
  for (let i = 0; i < 10 && isAlive(e.pid); i++) await sleep(500);
  if (isAlive(e.pid)) sig('SIGKILL');
  return true;
}

/** One sweep: stop every idle tracked service. Returns the ids stopped. */
export async function sweep({ now = Date.now(), keep, deps } = {}) {
  load();
  const s = settings();
  if (!s.enabled) return [];
  const out = [];
  for (const e of idleVictims(list(), { now, idleMinutes: s.idleMinutes, keep })) {
    try {
      if (await stopService(e, deps)) {
        tracked.delete(e.id);
        out.push(e.id);
        log(`janitor: stopped ${e.name} (${e.unit ? 'unit ' + e.unit : 'pid ' + e.pid}) — unused for ${Math.round((now - e.lastUsed) / 60000)} min`);
      }
    } catch (err) { log(`janitor: could not stop ${e.name}: ${err.message}`); }
  }
  if (out.length) save();
  return out;
}

let timer = null;
export function startJanitor({ keep, onStopped } = {}) {
  load();
  clearInterval(timer);
  timer = setInterval(() => sweep({ keep }).then((ids) => { if (ids.length) onStopped?.(ids); }).catch((e) => log('janitor:', e.message)), settings().intervalSec * 1000);
  timer.unref?.();
}
export function stopJanitor() { clearInterval(timer); timer = null; }
export function resetJanitor() { tracked.clear(); loaded = true; }
