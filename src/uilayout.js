// The JARVIS dock layout and app dock, saved on the daemon and synced across the mesh. The UI keeps these in each
// browser's localStorage; this store holds the same opaque JSON values under RIGS_HOME/ui-layout.json so every browser
// on every machine ends up with the newest one. Every key carries its own { rev, by } stamp (same ordering as the global
// brain settings in globalbrain.js), so changing the app dock never overwrites a newer panel layout from another machine.
// Machine-bound or transient state (wm.js `win-<n>` windows, fitted rects) is never stored: only the whitelisted keys are.
// Pure functions plus a small file-backed store, so node --test can check them.
import fs from 'node:fs';
import path from 'node:path';
import { isNewer } from './globalbrain.js';

export { isNewer };

/** The localStorage keys that are synced; each holds one opaque JSON value. */
export const KEYS = ['rigs.dock', 'rigs.appdock', 'rigs.docking', 'rigs.scaling', 'rigs.spaces'];
export const MAX_VALUE_BYTES = 256 * 1024;

export class LayoutError extends Error { constructor(status, msg, extra = {}) { super(msg); this.status = status; Object.assign(this, extra); } }

/** A fresh stamp for a key, always newer than the current one even if the clock is behind. */
export function nextStamp(current, by, now = Date.now()) {
  return { rev: Math.max(now, (Number(current?.rev) || 0) + 1), by: String(by || '') };
}

/** Throws a 400 LayoutError unless `key` is whitelisted and `value` is JSON of a sane size. */
export function validate(key, value) {
  if (!KEYS.includes(key)) throw new LayoutError(400, `unknown key ${JSON.stringify(key)}: expected one of ${KEYS.join(', ')}`);
  if (value === undefined) throw new LayoutError(400, 'value is required');
  let s;
  try { s = JSON.stringify(value); } catch { throw new LayoutError(400, 'value is not JSON'); }
  if (s === undefined) throw new LayoutError(400, 'value is not JSON');
  if (Buffer.byteLength(s) > MAX_VALUE_BYTES) throw new LayoutError(400, `value is larger than ${MAX_VALUE_BYTES / 1024} kB`);
}

const entryOf = (e) => ({ value: e.value, rev: Number(e.rev) || 0, by: String(e.by || '') });

/**
 * Store over `file`. snapshot() = { keys: { key: { value, rev, by } } }. Listeners get (key, entry, 'local' | 'peer').
 * `name` (this machine's name, or a function returning it) and `now` are injectable for tests.
 */
export function createStore({ file, name = '', now = Date.now } = {}) {
  let data = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const k of KEYS) if (raw?.keys?.[k] && raw.keys[k].value !== undefined) data[k] = entryOf(raw.keys[k]);
  } catch { /* first run or an unreadable file: start empty */ }
  const listeners = new Set();
  const emit = (k, source) => { for (const fn of listeners) { try { fn(k, entryOf(data[k]), source); } catch { /* a listener never breaks a save */ } } };
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ keys: data }));
    fs.renameSync(tmp, file);
  }
  return {
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    snapshot() { return { keys: Object.fromEntries(Object.entries(data).map(([k, e]) => [k, entryOf(e)])) }; },
    get(key) { return data[key] ? entryOf(data[key]) : null; },
    /** Save a value from this machine. With baseRev, refuses (409) when the stored revision moved on since the caller read it. */
    set(key, value, { baseRev } = {}) {
      validate(key, value);
      const cur = data[key];
      if (baseRev !== undefined && baseRev !== null && (Number(cur?.rev) || 0) !== Number(baseRev)) {
        throw new LayoutError(409, `${key} changed since revision ${baseRev}`, { current: cur ? entryOf(cur) : null });
      }
      data[key] = { value: JSON.parse(JSON.stringify(value)), ...nextStamp(cur, typeof name === 'function' ? name() : name, now()) };
      save();
      emit(key, 'local');
      return { key, rev: data[key].rev, by: data[key].by };
    },
    /** Adopt a peer's { keys } where its stamp is newer than ours; invalid or unknown keys are skipped. Returns the adopted keys. Never re-broadcasts. */
    adopt(snap) {
      const adopted = [];
      for (const [k, e] of Object.entries(snap?.keys || {})) {
        try { validate(k, e?.value); } catch { continue; }
        if (data[k] && !isNewer(e, data[k])) continue;
        if (!data[k] && !(Number(e.rev) > 0)) continue;
        data[k] = { value: JSON.parse(JSON.stringify(e.value)), rev: Number(e.rev) || 0, by: String(e.by || '') };
        adopted.push(k);
      }
      if (adopted.length) { save(); for (const k of adopted) emit(k, 'peer'); }
      return adopted;
    },
  };
}
