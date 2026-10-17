// Trip recorder: turns the position stream app.js already gets (watchPosition, or the demo vehicle
// with ?demo=1&record=1) into trips on the applet server (api/trips, see tripstore.js).
//
// - Fixes worse than 50 m accuracy are dropped, at most one fix per ~second is kept, and while
//   standing still (moved < 3 m, under 1 km/h) nothing is kept, so a parked phone doesn't fill a trip.
// - A trip starts once moving faster than 5 km/h (with the last few seconds before it as pre-roll) and
//   ends after 5 minutes without moving, or when the page closes.
// - Every ~15 s the new fixes become a numbered chunk in an outbox kept in localStorage, and the
//   outbox is posted in order. If the server is unreachable the chunks wait there, across reloads,
//   until it answers. On pagehide / tab hidden the outbox goes out with navigator.sendBeacon. The
//   fixes not yet in a chunk are saved with the open trip, so a crashed or killed page loses nothing
//   either: the next visit closes that trip with them.
//   The server ignores chunks it already has, so resending is always safe.
// The logic takes its clock, fetch, storage and beacon as arguments, so it runs in Node tests.
import { haversine } from './geo.js';

export const RECORDER_DEFAULTS = {
  maxAccuracy: 50,        // m: worse fixes are dropped
  jitterM: 3,             // m: closer than this to the last kept fix…
  jitterSpeed: 1 / 3.6,   // …and slower than 1 km/h is GPS wobble, not movement
  startSpeed: 5 / 3.6,    // m/s: a trip starts above 5 km/h
  movingSpeed: 3 / 3.6,   // m/s: above this the stop timer resets
  stopAfterMs: 5 * 60 * 1000,
  chunkEveryMs: 15000,
  minIntervalMs: 900,     // the 5 Hz demo vehicle is kept at ~1 Hz
  preRollMs: 10000,
  speedWindowMs: 5000,    // speed from displacement over ≥ 5 s when the device gives none
  beaconBytes: 60000,     // sendBeacon payloads are capped at 64 KB in flight
};

export const OUTBOX_KEY = 'nav.trips.outbox';
export const CURRENT_KEY = 'nav.trips.current';

const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const round = (x, dp) => (finite(x) ? Math.round(x * 10 ** dp) / 10 ** dp : null);

/** A sortable, readable trip id: 20261017-143706-k3f9 (UTC). */
export function newTripId(t = Date.now(), rnd = Math.random) {
  const d = new Date(t).toISOString();
  return `${d.slice(0, 10).replace(/-/g, '')}-${d.slice(11, 19).replace(/:/g, '')}-${Math.floor(rnd() * 36 ** 4).toString(36).padStart(4, '0')}`;
}

/** The stored shape of a fix, rounded to what GPS can actually resolve to keep chunks small. */
function compact(f) {
  return { t: Math.round(f.t), lat: round(f.lat, 6), lon: round(f.lon, 6), speed: round(f.speed, 2), heading: round(f.heading, 1), accuracy: round(f.accuracy, 1), alt: round(f.alt, 1) };
}

/** localStorage-like wrapper that never throws (private mode, quota full, no storage at all). */
function safeStorage(s) {
  return {
    get(k) { try { return JSON.parse(s?.getItem(k) ?? 'null'); } catch { return null; } },
    set(k, v) { try { s.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { s?.removeItem(k); } catch {} },
  };
}

const body = (c) => JSON.stringify({ seq: c.seq, final: c.final, reason: c.reason, source: c.source, points: c.points });

export function createTripRecorder({
  fetchImpl = (...a) => globalThis.fetch(...a), storage = null, beacon = null, now = Date.now,
  base = 'api/trips', source = 'gps', onChange = () => {}, ...opts
} = {}) {
  const o = { ...RECORDER_DEFAULTS, ...opts };
  const store = safeStorage(storage);
  const saved = store.get(OUTBOX_KEY);
  const outbox = Array.isArray(saved) ? saved : [];
  let trip = null;        // {id, seq, startedAt, lastMovingAt, count}
  let pending = [];       // kept fixes not yet in a chunk
  let lastCut = 0;
  let lastKept = null;
  let recent = [];        // the last few seconds of usable fixes: speed estimate and pre-roll
  let flushing = null;
  let lastError = null;
  let stored = true;

  // A trip left open by a page that died without pagehide (crash, killed tab): close it on the server
  // with the fixes it had not chunked yet.
  const left = store.get(CURRENT_KEY);
  if (left?.id) outbox.push({ id: left.id, seq: Number.isInteger(left.seq) ? left.seq : null, final: true, reason: 'closed', source, points: Array.isArray(left.pending) ? left.pending : [] });
  save();

  function save() {
    stored = store.set(OUTBOX_KEY, outbox) || !storage;
    saveCurrent();
  }

  /** The open trip and its not-yet-chunked fixes (≤ 15 s worth), rewritten on every kept fix. */
  function saveCurrent() {
    if (trip) store.set(CURRENT_KEY, { id: trip.id, seq: trip.seq, startedAt: trip.startedAt, lastT: lastKept?.t ?? trip.startedAt, pending: pending.map(compact) });
    else store.del(CURRENT_KEY);
  }

  function status() {
    return {
      recording: !!trip, id: trip?.id ?? null, startedAt: trip?.startedAt ?? null, points: trip?.count ?? 0,
      pending: pending.length, outbox: outbox.length, queuedPoints: outbox.reduce((n, c) => n + c.points.length, 0),
      stored, lastError,
    };
  }
  const changed = () => { try { onChange(status()); } catch {} };

  /** Speed in m/s: the device's own, else the displacement across the recent window (≥ speedWindowMs). */
  function speedOf(fix) {
    if (finite(fix.speed) && fix.speed >= 0) return fix.speed;
    let ref = null;
    for (const r of recent) if (fix.t - r.t >= o.speedWindowMs) ref = r;
    return ref ? haversine(ref, fix) / ((fix.t - ref.t) / 1000) : null;
  }

  function cut({ final = false, reason = null } = {}) {
    if (!trip) return;
    if (pending.length || final) {
      outbox.push({ id: trip.id, seq: trip.seq++, final, reason, source, points: pending.map(compact) });
      pending = [];
    }
    lastCut = now();
    if (final) { trip = null; lastKept = null; }
    save();
    changed();
  }

  /** End the current trip (a final chunk) and try to upload it. */
  function end(reason = 'stopped') {
    if (!trip) return Promise.resolve();
    cut({ final: true, reason });
    return flush();
  }

  /** Feed one fix {t, lat, lon, speed, heading, accuracy, alt}. Returns 'dropped' | 'idle' | 'kept'. */
  function addFix(fix) {
    if (!fix || !finite(fix.t) || !finite(fix.lat) || !finite(fix.lon)) return 'dropped';
    if (finite(fix.accuracy) && fix.accuracy > o.maxAccuracy) return 'dropped';
    if (trip && fix.t - trip.lastMovingAt > o.stopAfterMs) end('stopped'); // back after a long gap
    const prev = recent[recent.length - 1];
    if (prev && fix.t - prev.t < o.minIntervalMs) return 'dropped';
    const v = speedOf(fix);
    recent.push(fix);
    const keepMs = Math.max(o.preRollMs, o.speedWindowMs) + 2000;
    while (recent.length > 2 && fix.t - recent[0].t > keepMs) recent.shift();

    const starting = !trip;
    if (starting) {
      if (v == null || v <= o.startSpeed) return 'idle';
      // Pre-roll: the fixes just before crossing 5 km/h, so the trip starts where the car stood.
      pending = recent.filter((r) => r !== fix && fix.t - r.t <= o.preRollMs);
      trip = { id: newTripId(fix.t), seq: 0, startedAt: pending[0]?.t ?? fix.t, lastMovingAt: fix.t, count: pending.length };
      lastKept = pending[pending.length - 1] || null;
      lastCut = now();
    }
    if (v != null && v > o.movingSpeed) trip.lastMovingAt = fix.t;
    if (lastKept && haversine(lastKept, fix) < o.jitterM && (v == null || v < o.jitterSpeed)) return 'dropped';
    pending.push(fix);
    lastKept = fix;
    trip.count++;
    saveCurrent();
    if (starting) changed();
    return 'kept';
  }

  /** Every few seconds: end a trip stood still for 5 min, close a chunk every chunkEveryMs, upload. */
  function tick() {
    if (trip && now() - trip.lastMovingAt > o.stopAfterMs) return end('stopped');
    if (trip && pending.length && now() - lastCut >= o.chunkEveryMs) cut();
    return flush();
  }

  /** Post the outbox in order. Stops at the first network error or 5xx and keeps the rest for later. */
  function flush() {
    if (flushing) return flushing;
    if (!outbox.length) return Promise.resolve();
    flushing = (async () => {
      while (outbox.length) {
        const c = outbox[0];
        let res;
        try {
          res = await fetchImpl(`${base}/${encodeURIComponent(c.id)}/points`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(c) });
        } catch (e) {
          lastError = 'offline: ' + (e?.message || e);
          break;
        }
        if (res.status >= 500 || res.status === 408 || res.status === 429) { lastError = 'server HTTP ' + res.status; break; }
        // 2xx is stored; any other 4xx (bad chunk, trip deleted) would never succeed, so drop it.
        lastError = res.ok ? null : 'chunk rejected: HTTP ' + res.status;
        outbox.shift();
        save();
      }
      changed();
    })().finally(() => { flushing = null; });
    return flushing;
  }

  /**
   * The page is closing (final) or going to the background: close the current chunk and hand the
   * outbox to sendBeacon. The chunks stay queued; the next load resends them and the server drops repeats.
   * Returns how many chunks the browser accepted.
   */
  function pageHide({ final = false } = {}) {
    if (trip) cut(final ? { final: true, reason: 'closed' } : {});
    if (!beacon) return 0;
    let bytes = 0;
    let sent = 0;
    for (const c of outbox) {
      const b = body(c);
      if (bytes + b.length > o.beaconBytes) break;
      let ok = false;
      try { ok = beacon(`${base}/${encodeURIComponent(c.id)}/points`, b); } catch {}
      if (!ok) break;
      bytes += b.length;
      sent++;
    }
    return sent;
  }

  return { addFix, tick, flush, end, pageHide, status };
}

/** Browser glue: a recorder on localStorage + sendBeacon, ticking every 5 s, flushed on hide and close. */
export function installTripRecorder({ source = 'gps', onChange } = {}) {
  const rec = createTripRecorder({
    source, onChange,
    storage: (() => { try { return window.localStorage; } catch { return null; } })(),
    // text/plain keeps the beacon a "simple" request; the server parses the JSON regardless.
    beacon: navigator.sendBeacon ? (url, b) => navigator.sendBeacon(url, new Blob([b], { type: 'text/plain' })) : null,
  });
  setInterval(() => { if (!document.hidden) rec.tick(); }, 5000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) rec.pageHide(); else rec.flush(); });
  window.addEventListener('pagehide', () => rec.pageHide({ final: true }));
  window.addEventListener('online', () => rec.flush());
  rec.flush(); // whatever an earlier visit left in the outbox
  return rec;
}
