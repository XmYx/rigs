// Home Security storage (t3, docs/home-security.md §5, §7): settings.json / cameras.json / secrets.json with atomic
// writes, and the node:sqlite segment + event index. No dependencies; node:sqlite ships with Node ≥ 22.13.
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = 1;

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  recording: { defaultMode: 'continuous', segmentSeconds: 2, preRollSeconds: 10, postRollSeconds: 10, ringSeconds: 60 },
  motion: { enabled: true, sensitivity: 50, minDurationMs: 500, maxEventSeconds: 600, fps: 5, width: 160 },
  retention: { maxGB: 50, maxDays: 14, eventMaxDays: 30, minFreeGB: 2, intervalMinutes: 5 },
  discovery: { onvif: true, intervalMinutes: 60, portProbe: false, ports: [554, 8554, 80, 8080], excludeCidrs: [], extraCidrs: [] },
  live: { hlsWindowSegments: 6, snapshotFps: 1 },
  ffmpeg: { path: '', hwaccel: 'auto' },
});

const clone = (v) => JSON.parse(JSON.stringify(v));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deep merge: objects merge key by key, everything else (arrays included) replaces. Pure. */
export function deepMerge(base, patch) {
  if (!isObj(base) || !isObj(patch)) return clone(patch);
  const out = clone(base);
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : clone(v);
  }
  return out;
}

const RFC1918 = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]];
const ipNum = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
function parseCidr(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(s));
  if (!m || m.slice(1, 5).some((o) => Number(o) > 255) || Number(m[5]) > 32) return null;
  return { ip: m.slice(1, 5).join('.'), bits: Number(m[5]) };
}
const inCidr = (ip, net, bits) => bits === 0 || Math.floor(ipNum(ip) / 2 ** (32 - bits)) === Math.floor(ipNum(net) / 2 ** (32 - bits));

/** Validate a full settings object → list of human-readable errors (empty = valid). Pure. */
export function validateSettings(s) {
  const errors = [];
  const num = (p, v, min, max, int = false) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || (int && !Number.isInteger(v))) errors.push(`${p} must be a${int ? 'n integer' : ' number'}${max === undefined ? ` ≥ ${min}` : ` between ${min} and ${max}`}`);
    else if (v < min || (max !== undefined && v > max)) errors.push(`${p} must be ${max === undefined ? `≥ ${min}` : `between ${min} and ${max}`}`);
  };
  const bool = (p, v) => { if (typeof v !== 'boolean') errors.push(`${p} must be true or false`); };
  const oneOf = (p, v, list) => { if (!list.includes(v)) errors.push(`${p} must be one of ${list.join(', ')}`); };
  for (const sec of ['recording', 'motion', 'retention', 'discovery', 'live', 'ffmpeg']) if (!isObj(s?.[sec])) errors.push(`${sec} must be an object`);
  if (errors.length) return errors;
  const { recording: r, motion: m, retention: t, discovery: d, live: l, ffmpeg: f } = s;
  oneOf('recording.defaultMode', r.defaultMode, ['continuous', 'motion', 'off']);
  num('recording.segmentSeconds', r.segmentSeconds, 1, 10);
  num('recording.preRollSeconds', r.preRollSeconds, 0, 60);
  num('recording.postRollSeconds', r.postRollSeconds, 0, 120);
  num('recording.ringSeconds', r.ringSeconds, 1, 3600);
  bool('motion.enabled', m.enabled);
  num('motion.sensitivity', m.sensitivity, 1, 100);
  num('motion.minDurationMs', m.minDurationMs, 0, 10000);
  num('motion.maxEventSeconds', m.maxEventSeconds, 30, 3600);
  num('motion.fps', m.fps, 1, 15);
  num('motion.width', m.width, 64, 640, true);
  num('retention.maxGB', t.maxGB, 1);
  num('retention.maxDays', t.maxDays, 1);
  num('retention.eventMaxDays', t.eventMaxDays, 1);
  if (typeof t.eventMaxDays === 'number' && typeof t.maxDays === 'number' && t.eventMaxDays < t.maxDays) errors.push('retention.eventMaxDays must be ≥ retention.maxDays');
  num('retention.minFreeGB', t.minFreeGB, 0);
  num('retention.intervalMinutes', t.intervalMinutes, 1, 60);
  bool('discovery.onvif', d.onvif);
  num('discovery.intervalMinutes', d.intervalMinutes, 0, 10080);
  bool('discovery.portProbe', d.portProbe);
  if (!Array.isArray(d.ports) || !d.ports.every((p) => Number.isInteger(p) && p >= 1 && p <= 65535)) errors.push('discovery.ports must be a list of ports 1–65535');
  for (const key of ['excludeCidrs', 'extraCidrs']) {
    if (!Array.isArray(d[key])) { errors.push(`discovery.${key} must be a list`); continue; }
    for (const c of d[key]) {
      const p = parseCidr(c);
      if (!p) { errors.push(`discovery.${key}: "${c}" is not an IPv4 CIDR`); continue; }
      if (key === 'extraCidrs') {
        if (!RFC1918.some(([net, bits]) => p.bits >= bits && inCidr(p.ip, net, bits))) errors.push(`discovery.extraCidrs: ${c} must be an RFC1918 range`);
        else if (p.bits < 22) errors.push(`discovery.extraCidrs: ${c} must be /22 or narrower`);
      }
    }
  }
  num('live.hlsWindowSegments', l.hlsWindowSegments, 2, 30, true);
  num('live.snapshotFps', l.snapshotFps, 0.1, 10);
  if (typeof f.path !== 'string') errors.push('ffmpeg.path must be a string');
  oneOf('ffmpeg.hwaccel', f.hwaccel, ['auto', 'none']);
  return errors;
}

/** Fill gaps from defaults, then clamp derived values (ringSeconds ≥ preRoll + 2×segment). Pure. */
export function normalizeSettings(s) {
  const out = deepMerge(DEFAULT_SETTINGS, isObj(s) ? s : {});
  out.version = 1;
  const r = out.recording;
  if (typeof r.ringSeconds === 'number' && typeof r.preRollSeconds === 'number' && typeof r.segmentSeconds === 'number') {
    r.ringSeconds = Math.max(r.ringSeconds, r.preRollSeconds + 2 * r.segmentSeconds);
  }
  return out;
}

/** Write JSON atomically (tmp + rename, fsync'd), optionally with a file mode. */
export function writeJsonAtomic(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w', mode ?? 0o644);
  try { fs.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (mode !== undefined) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// Standalone file accessors (usable without opening the index), same formats as §5.
export const loadSettings = (dataDir) => {
  const s = normalizeSettings(readJson(path.join(dataDir, 'settings.json'), {}));
  return validateSettings(s).length ? normalizeSettings({}) : s;
};
export const loadCameras = (dataDir) => { const c = readJson(path.join(dataDir, 'cameras.json'), []); return Array.isArray(c) ? c : []; };
export const saveCameras = (dataDir, list) => writeJsonAtomic(path.join(dataDir, 'cameras.json'), list);
export const loadSecrets = (dataDir) => { const s = readJson(path.join(dataDir, 'secrets.json'), {}); return isObj(s) ? s : {}; };
export const saveSecrets = (dataDir, obj) => writeJsonAtomic(path.join(dataDir, 'secrets.json'), obj, 0o600);

let sqliteMod;
async function sqlite() {
  if (!sqliteMod) {
    // node:sqlite prints one ExperimentalWarning; silence only that one (§5).
    const orig = process.emitWarning;
    process.emitWarning = function (w, ...rest) {
      const msg = typeof w === 'string' ? w : w?.message;
      if (/SQLite/i.test(String(msg))) return;
      return orig.call(process, w, ...rest);
    };
    try { sqliteMod = await import('node:sqlite'); } finally { process.emitWarning = orig; }
  }
  return sqliteMod;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY, camera TEXT NOT NULL, start_ms INTEGER NOT NULL, dur_ms INTEGER NOT NULL,
  path TEXT NOT NULL, bytes INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS segments_cam_start ON segments(camera, start_ms);
CREATE INDEX IF NOT EXISTS segments_start ON segments(start_ms);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, camera TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER,
  clip_from_ms INTEGER NOT NULL, clip_to_ms INTEGER,
  peak_score REAL NOT NULL, frames INTEGER NOT NULL DEFAULT 0, zones TEXT,
  locked INTEGER NOT NULL DEFAULT 0, reviewed INTEGER NOT NULL DEFAULT 0, note TEXT,
  created_ms INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS events_start ON events(start_ms);
CREATE INDEX IF NOT EXISTS events_cam_start ON events(camera, start_ms);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`;

const segRow = (r) => r && ({ id: r.id, camera: r.camera, startMs: r.start_ms, durMs: r.dur_ms, path: r.path, bytes: r.bytes });
const evRow = (r) => r && ({
  id: r.id, camera: r.camera, startMs: r.start_ms, endMs: r.end_ms ?? null, clipFromMs: r.clip_from_ms, clipToMs: r.clip_to_ms ?? null,
  peak: r.peak_score, frames: r.frames, zones: r.zones ? JSON.parse(r.zones) : [], locked: !!r.locked, reviewed: !!r.reviewed,
  note: r.note ?? null, createdMs: r.created_ms,
});

/**
 * Open the store for one data dir. Returns an object with settings/cameras/secrets accessors and index queries.
 * `await openStore(dir)`; call `close()` on shutdown.
 */
export async function openStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  for (const d of ['segments', 'events', 'live', 'run', 'logs']) fs.mkdirSync(path.join(dataDir, d), { recursive: true });
  const { DatabaseSync } = await sqlite();
  const db = new DatabaseSync(path.join(dataDir, 'index.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);
  db.prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)').run('schema', String(SCHEMA_VERSION));

  const q = {
    insSeg: db.prepare('INSERT INTO segments (camera, start_ms, dur_ms, path, bytes) VALUES (?, ?, ?, ?, ?)'),
    segExists: db.prepare('SELECT id FROM segments WHERE camera = ? AND start_ms = ?'),
    delSeg: db.prepare('DELETE FROM segments WHERE id = ?'),
    // Overlap [from, to): a segment overlaps when start < to and start + dur > from. A segment never exceeds 60 s, so
    // the start_ms lower bound keeps the index usable.
    segsCam: db.prepare('SELECT * FROM segments WHERE camera = ? AND start_ms < ? AND start_ms >= ? AND start_ms + dur_ms > ? ORDER BY start_ms'),
    segsAll: db.prepare('SELECT * FROM segments WHERE start_ms < ? AND start_ms >= ? AND start_ms + dur_ms > ? ORDER BY camera, start_ms'),
    lastSegs: db.prepare('SELECT * FROM segments WHERE camera = ? ORDER BY start_ms DESC LIMIT ?'),
    segAt: db.prepare('SELECT * FROM segments WHERE camera = ? AND start_ms <= ? AND start_ms >= ? ORDER BY start_ms DESC LIMIT 1'),
    nextSeg: db.prepare('SELECT * FROM segments WHERE camera = ? AND start_ms > ? ORDER BY start_ms LIMIT 1'),
    segByStart: db.prepare('SELECT * FROM segments WHERE camera = ? AND start_ms = ?'),
    segsBefore: db.prepare('SELECT * FROM segments WHERE camera = ? AND start_ms < ? ORDER BY start_ms'),
    allSegs: db.prepare('SELECT * FROM segments ORDER BY start_ms'),
    cams: db.prepare('SELECT DISTINCT camera FROM segments'),
    usage: db.prepare('SELECT camera, SUM(bytes) AS bytes, COUNT(*) AS n, MIN(start_ms) AS oldest FROM segments GROUP BY camera'),
    insEv: db.prepare(`INSERT INTO events (id, camera, start_ms, end_ms, clip_from_ms, clip_to_ms, peak_score, frames, zones, created_ms)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updEv: db.prepare(`UPDATE events SET end_ms = ?, clip_to_ms = ?, peak_score = ?, frames = ?, zones = ? WHERE id = ?`),
    getEv: db.prepare('SELECT * FROM events WHERE id = ?'),
    delEv: db.prepare('DELETE FROM events WHERE id = ?'),
    allEv: db.prepare('SELECT * FROM events ORDER BY start_ms'),
    openEv: db.prepare('SELECT * FROM events WHERE end_ms IS NULL'),
  };
  const MAX_SEG_MS = 60_000;

  const settingsFile = path.join(dataDir, 'settings.json');
  let settings = loadSettings(dataDir); // corrupt file → defaults, don't crash

  const store = {
    dataDir,
    db,
    // --- settings (§7) ---
    getSettings: () => clone(settings),
    /** Deep-merge a partial object. Returns { ok: true, settings } or { ok: false, errors }. */
    patchSettings(partial) {
      if (!isObj(partial)) return { ok: false, errors: ['body must be a JSON object'] };
      const { version, ...rest } = partial; // version is ours
      const next = deepMerge(settings, rest);
      const errors = validateSettings(next);
      if (errors.length) return { ok: false, errors };
      const prev = settings;
      settings = normalizeSettings(next);
      writeJsonAtomic(settingsFile, settings);
      return { ok: true, settings: clone(settings), previous: prev };
    },
    // --- cameras / secrets (t2 owns their semantics; these are just the atomic files) ---
    loadCameras: () => loadCameras(dataDir),
    saveCameras: (list) => saveCameras(dataDir, list),
    loadSecrets: () => loadSecrets(dataDir),
    saveSecrets: (obj) => saveSecrets(dataDir, obj),

    // --- segments ---
    addSegment({ camera, startMs, durMs, path: rel, bytes }) {
      if (q.segExists.get(camera, startMs)) return null;
      const r = q.insSeg.run(camera, startMs, Math.round(durMs), rel, bytes);
      return Number(r.lastInsertRowid);
    },
    deleteSegment: (id) => { q.delSeg.run(id); },
    segments(camera, fromMs, toMs) {
      const rows = camera ? q.segsCam.all(camera, toMs, fromMs - MAX_SEG_MS, fromMs) : q.segsAll.all(toMs, fromMs - MAX_SEG_MS, fromMs);
      return rows.map(segRow);
    },
    lastSegments: (camera, n) => q.lastSegs.all(camera, n).map(segRow).reverse(),
    segmentAt: (camera, t) => { const s = segRow(q.segAt.get(camera, t, t - MAX_SEG_MS)); return s && s.startMs + s.durMs > t ? s : null; },
    nextSegment: (camera, t) => segRow(q.nextSeg.get(camera, t)) || null,
    segmentByStart: (camera, startMs) => segRow(q.segByStart.get(camera, startMs)) || null,
    segmentsBefore: (camera, t) => q.segsBefore.all(camera, t).map(segRow),
    allSegments: () => q.allSegs.all().map(segRow),
    segmentCameras: () => q.cams.all().map((r) => r.camera),
    segmentUsage() {
      const out = {};
      for (const r of q.usage.all()) out[r.camera] = { bytes: Number(r.bytes) || 0, count: Number(r.n), oldestMs: r.oldest };
      return out;
    },
    transaction(fn) {
      db.exec('BEGIN');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },

    // --- events ---
    insertEvent(e) {
      q.insEv.run(e.id, e.camera, e.startMs, e.endMs ?? null, e.clipFromMs, e.clipToMs ?? null, e.peak ?? 0, e.frames ?? 0,
        JSON.stringify(e.zones || []), e.createdMs ?? Date.now());
      return store.getEvent(e.id);
    },
    updateEventProgress(id, { endMs, clipToMs, peak, frames, zones }) {
      q.updEv.run(endMs ?? null, clipToMs ?? null, peak ?? 0, frames ?? 0, JSON.stringify(zones || []), id);
    },
    getEvent: (id) => evRow(q.getEv.get(id)) || null,
    patchEvent(id, { locked, reviewed, note }) {
      const sets = []; const args = [];
      if (locked !== undefined) { sets.push('locked = ?'); args.push(locked ? 1 : 0); }
      if (reviewed !== undefined) { sets.push('reviewed = ?'); args.push(reviewed ? 1 : 0); }
      if (note !== undefined) { sets.push('note = ?'); args.push(note === null ? null : String(note).slice(0, 2000)); }
      if (sets.length) db.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
      return store.getEvent(id);
    },
    deleteEvent: (id) => { q.delEv.run(id); },
    allEvents: () => q.allEv.all().map(evRow),
    openEvents: () => q.openEv.all().map(evRow),
    /** Filtered list, newest first. `before` is a start_ms cursor (exclusive). */
    listEvents({ camera, from, to, reviewed, locked, before, limit = 50 } = {}) {
      const where = []; const args = [];
      if (camera) { where.push('camera = ?'); args.push(camera); }
      if (Number.isFinite(from)) { where.push('COALESCE(end_ms, 9e15) >= ?'); args.push(from); }
      if (Number.isFinite(to)) { where.push('start_ms <= ?'); args.push(to); }
      if (typeof reviewed === 'boolean') { where.push('reviewed = ?'); args.push(reviewed ? 1 : 0); }
      if (typeof locked === 'boolean') { where.push('locked = ?'); args.push(locked ? 1 : 0); }
      if (Number.isFinite(before)) { where.push('start_ms < ?'); args.push(before); }
      const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY start_ms DESC LIMIT ?`;
      return db.prepare(sql).all(...args, limit).map(evRow);
    },
    eventsBetween(camera, fromMs, toMs) {
      const sql = `SELECT * FROM events WHERE ${camera ? 'camera = ? AND ' : ''}start_ms <= ? AND COALESCE(end_ms, 9e15) >= ? ORDER BY start_ms`;
      return db.prepare(sql).all(...(camera ? [camera] : []), toMs, fromMs).map(evRow);
    },
    close() { try { db.close(); } catch { /* already closed */ } },
  };
  return store;
}
