// Home Security retention (t3, docs/home-security.md §6).
// selectVictims is pure. Deletion goes through safeRemove, which only ever removes inside <data>/segments or
// <data>/events — lexically and after resolving symlinks.
import fs from 'node:fs';
import path from 'node:path';

const DAY = 86_400_000;
const GB = 1024 ** 3;

/** Merge windows [{from, to|null}] → sorted, non-overlapping [[from, to]] (to = Infinity when open). */
function mergeWindows(wins) {
  const list = wins.map((w) => [w.from, w.to ?? Infinity]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const w of list) {
    const last = out[out.length - 1];
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]); else out.push([...w]);
  }
  return out;
}
/** Does [from, to) overlap any merged window? Binary search. */
function hits(merged, from, to) {
  let lo = 0; let hi = merged.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (merged[mid][1] <= from) lo = mid + 1; else hi = mid - 1;
  }
  return lo < merged.length && merged[lo][0] < to && merged[lo][1] > from;
}
const evWindow = (e) => ({ from: e.clipFromMs, to: e.clipToMs ?? null });

/** Map camera → merged windows of the given events. */
function windowsByCamera(events) {
  const by = new Map();
  for (const e of events) { if (!by.has(e.camera)) by.set(e.camera, []); by.get(e.camera).push(evWindow(e)); }
  const out = new Map();
  for (const [cam, w] of by) out.set(cam, mergeWindows(w));
  return out;
}
const covered = (wins, s) => { const w = wins.get(s.camera); return !!w && hits(w, s.startMs, s.startMs + s.durMs); };

/**
 * Pure victim selection.
 * @param segments [{ id, camera, startMs, durMs, bytes }]
 * @param events   [{ id, camera, startMs, endMs|null, clipFromMs, clipToMs|null, locked, bytes? (thumb+clip on disk), cacheBytes? (clip.mp4) }]
 * @param now      epoch ms
 * @param settings full settings (uses settings.retention)
 * @param usage    { totalBytes, freeBytes } — totalBytes = segments + events dirs
 * @returns { segments: [id], events: [id], caches: [eventId], bytes, reasons: { ageSegments, ageEvents, sizeSegments, sizeEvents, sizeCaches }, overLimit }
 */
export function selectVictims({ segments, events, now, settings, usage = {} }) {
  const r = settings?.retention || settings || {};
  const maxDays = r.maxDays ?? 14; const eventMaxDays = Math.max(r.eventMaxDays ?? 30, maxDays);
  const maxBytes = (r.maxGB ?? 50) * GB; const minFree = (r.minFreeGB ?? 2) * GB;
  const segs = [...segments].sort((a, b) => a.startMs - b.startMs || String(a.camera).localeCompare(String(b.camera)));
  const deadSeg = new Set(); const deadEv = new Set(); const caches = [];
  const reasons = { ageSegments: 0, ageEvents: 0, sizeSegments: 0, sizeEvents: 0, sizeCaches: 0 };
  let freed = 0;

  // 2 (decided first so step 1 knows which windows are kept). Age, events: closed, unlocked, ended before cutoff.
  const evCut = now - eventMaxDays * DAY;
  const evAged = events.filter((e) => !e.locked && e.endMs !== null && e.endMs !== undefined && e.endMs < evCut);
  for (const e of evAged) deadEv.add(e.id);
  let kept = events.filter((e) => !deadEv.has(e.id));
  let keptWins = windowsByCamera(kept);
  const agedWins = windowsByCamera(evAged);

  // 1. Age, footage: ended before now − maxDays and not covered by a kept event window.
  // 2b. Segments only the aged events covered go with them (any age).
  const segCut = now - maxDays * DAY;
  for (const s of segs) {
    if (covered(keptWins, s)) continue;
    if (s.startMs + s.durMs < segCut) { deadSeg.add(s.id); freed += s.bytes || 0; reasons.ageSegments++; } else if (covered(agedWins, s)) { deadSeg.add(s.id); freed += s.bytes || 0; reasons.ageEvents++; }
  }
  for (const e of evAged) freed += e.bytes || 0;

  // 3. Size / free space.
  const total0 = usage.totalBytes ?? segs.reduce((n, s) => n + (s.bytes || 0), 0) + events.reduce((n, e) => n + (e.bytes || 0), 0);
  const free0 = usage.freeBytes ?? Infinity;
  const over = () => total0 - freed > maxBytes || free0 + freed < minFree;

  if (over()) { // unprotected (continuous) footage, oldest first across cameras
    for (const s of segs) {
      if (!over()) break;
      if (deadSeg.has(s.id) || covered(keptWins, s)) continue;
      deadSeg.add(s.id); freed += s.bytes || 0; reasons.sizeSegments++;
    }
  }
  if (over()) { // then unlocked events, oldest first, with the segments only they covered
    const byCam = new Map();
    for (const s of segs) if (!deadSeg.has(s.id)) { if (!byCam.has(s.camera)) byCam.set(s.camera, []); byCam.get(s.camera).push(s); }
    const candidates = kept.filter((e) => !e.locked && e.endMs !== null && e.endMs !== undefined).sort((a, b) => a.startMs - b.startMs);
    for (const e of candidates) {
      if (!over()) break;
      deadEv.add(e.id); freed += e.bytes || 0; reasons.sizeEvents++;
      kept = kept.filter((k) => k.id !== e.id);
      keptWins.set(e.camera, mergeWindows(kept.filter((k) => k.camera === e.camera).map(evWindow)));
      const win = [[e.clipFromMs, e.clipToMs ?? Infinity]];
      for (const s of byCam.get(e.camera) || []) {
        if (deadSeg.has(s.id) || !hits(win, s.startMs, s.startMs + s.durMs) || covered(keptWins, s)) continue;
        deadSeg.add(s.id); freed += s.bytes || 0;
      }
    }
  }
  if (over()) { // then clip caches of what is left (locked events included: the clip is rebuilt on demand)
    for (const e of [...kept].sort((a, b) => a.startMs - b.startMs)) {
      if (!over()) break;
      if (e.cacheBytes > 0) { caches.push(e.id); freed += e.cacheBytes; reasons.sizeCaches++; }
    }
  }
  return {
    segments: segs.filter((s) => deadSeg.has(s.id)).map((s) => s.id),
    events: events.filter((e) => deadEv.has(e.id)).sort((a, b) => a.startMs - b.startMs).map((e) => e.id),
    caches, bytes: freed, reasons, overLimit: over(),
  };
}

/**
 * Remove <data>/<rel> only if it lies inside <data>/segments/ or <data>/events/ — both as written and after resolving
 * symlinks. A symlink is unlinked itself, never followed. Returns true when something was removed.
 */
export function safeRemove(dataDir, rel, log = () => {}) {
  const refuse = (why) => { log(`retention: refused to delete ${JSON.stringify(rel)}: ${why}`); return false; };
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return refuse('not a relative path');
  let realData;
  try { realData = fs.realpathSync(dataDir); } catch { return refuse('data dir missing'); }
  const roots = ['segments', 'events'].map((d) => path.join(realData, d) + path.sep);
  const lexical = path.resolve(realData, rel);
  if (!roots.some((r) => lexical.startsWith(r))) return refuse('outside data/segments and data/events');
  let st;
  try { st = fs.lstatSync(lexical); } catch { return false; } // already gone
  // Resolve the parent through symlinks: a symlinked folder (segments/cam → /elsewhere) must not let us in.
  let realParent;
  try { realParent = fs.realpathSync(path.dirname(lexical)); } catch { return refuse('parent unresolvable'); }
  const real = path.join(realParent, path.basename(lexical));
  if (!roots.some((r) => real.startsWith(r))) return refuse('resolves outside data/segments and data/events');
  try {
    if (st.isDirectory()) fs.rmSync(real, { recursive: true, force: true }); // rmSync never follows inner symlinks
    else fs.unlinkSync(real);
    return true;
  } catch (e) { log(`retention: delete ${rel} failed: ${e.message}`); return false; }
}

/** Remove empty parent folders of rel up to (excluding) segments/<cam> or events. */
export function pruneEmptyDirs(dataDir, rel, log) {
  const parts = rel.split('/');
  // segments/<cam>/<day>/<hour>/<file> → try <hour>, then <day>
  for (let n = parts.length - 1; n >= 3; n--) {
    const dirRel = parts.slice(0, n).join('/');
    const abs = path.join(dataDir, dirRel);
    try { if (fs.readdirSync(abs).length) return; } catch { continue; }
    safeRemove(dataDir, dirRel, log);
  }
}

function dirBytes(abs) {
  let n = 0;
  let entries;
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(abs, e.name);
    if (e.isDirectory()) n += dirBytes(p);
    else if (e.isFile()) { try { n += fs.statSync(p).size; } catch { /* raced */ } }
  }
  return n;
}
const fileSize = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

/** api/storage body. */
export function storageReport(store, settings) {
  const dataDir = store.dataDir;
  const usage = store.segmentUsage();
  let segmentsBytes = 0; let oldestMs = null; const cameras = {};
  for (const [cam, u] of Object.entries(usage)) {
    segmentsBytes += u.bytes; cameras[cam] = u.bytes;
    if (u.oldestMs !== null && (oldestMs === null || u.oldestMs < oldestMs)) oldestMs = u.oldestMs;
  }
  const eventsBytes = dirBytes(path.join(dataDir, 'events'));
  let freeBytes = null;
  try { const s = fs.statfsSync(dataDir); freeBytes = Number(s.bavail) * Number(s.bsize); } catch { /* unsupported */ }
  const r = settings.retention;
  const maxBytes = r.maxGB * GB;
  const totalBytes = segmentsBytes + eventsBytes;
  const overLimit = totalBytes > maxBytes || (freeBytes !== null && freeBytes < r.minFreeGB * GB);
  return { dataDir, totalBytes, segmentsBytes, eventsBytes, freeBytes, maxBytes, oldestMs, overLimit, cameras };
}

/**
 * Run retention once: select (pure) then delete exactly those, oldest first, through safeRemove.
 * Returns { before, after, deleted: { segments, events, bytes }, overLimit }.
 */
export function runRetention({ store, settings, now = Date.now(), log = () => {} }) {
  const dataDir = store.dataDir;
  const before = storageReport(store, settings);
  const segments = store.allSegments();
  const events = store.allEvents().map((e) => {
    const dir = path.join(dataDir, 'events', e.id);
    return { ...e, bytes: dirBytes(dir), cacheBytes: fileSize(path.join(dir, 'clip.mp4')) };
  });
  const v = selectVictims({ segments, events, now, settings, usage: { totalBytes: before.totalBytes, freeBytes: before.freeBytes ?? undefined } });
  const segById = new Map(segments.map((s) => [s.id, s]));
  let bytes = 0; let nSeg = 0; let nEv = 0;
  for (const id of v.segments) {
    const s = segById.get(id);
    const removed = safeRemove(dataDir, s.path, log);
    const gone = removed || !fs.existsSync(path.join(dataDir, s.path));
    if (gone) { store.deleteSegment(id); nSeg++; bytes += removed ? s.bytes : 0; pruneEmptyDirs(dataDir, s.path, log); }
  }
  const evById = new Map(events.map((e) => [e.id, e]));
  for (const id of v.events) {
    const e = evById.get(id);
    if (safeRemove(dataDir, `events/${id}`, log)) bytes += e.bytes;
    store.deleteEvent(id); nEv++;
  }
  for (const id of v.caches) {
    const e = evById.get(id);
    if (safeRemove(dataDir, `events/${id}/clip.mp4`, log)) bytes += e.cacheBytes;
  }
  const after = storageReport(store, settings);
  return { before, after, deleted: { segments: nSeg, events: nEv, caches: v.caches.length, bytes }, overLimit: after.overLimit };
}
