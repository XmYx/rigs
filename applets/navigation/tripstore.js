// Recorded trips on disk: one JSON file per trip in the data dir (NAV_DATA_DIR, default
// ~/.rigs/navigation/trips), written atomically (temp file + rename) and one write at a time per trip.
// Deleting moves the file into trash/ beside it; nothing is ever hard-deleted here.
//
//   <dir>/<id>.json        {v, id, status: 'recording'|'done', source, createdAt, updatedAt, endReason,
//                           seqs: [chunk numbers seen], points: [{t, lat, lon, speed, heading, accuracy, alt}],
//                           summary (tripStats without the timeline, cached once the trip is done),
//                           title?, places?}
//   <dir>/trash/<id>.json  the same, after DELETE
//
// Uploads are idempotent: a chunk whose seq was already stored is ignored and points are merged by
// timestamp, so the browser can resend its outbox (after a lost reply, a beacon, a reload) safely.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { aggregateTrips, tripStats } from './public/tripstats.js';

export const TRIP_ID = /^[A-Za-z0-9_-]{6,64}$/;
const MAX_CHUNK_POINTS = 5000;
const MAX_BODY = 2 * 1024 * 1024;
// A trip still "recording" with no upload for this long lost its final chunk (tab killed, phone
// died): it is finalised the next time trips are listed.
const STALE_MS = 10 * 60 * 1000;

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const httpError = (status, message) => Object.assign(new Error(message), { status });

/** A client fix → the stored shape, or null if it has no usable time and position. */
export function normalizePoint(p) {
  if (!p || typeof p !== 'object') return null;
  const t = num(p.t), lat = num(p.lat), lon = num(p.lon);
  if (t == null || lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { t, lat, lon, speed: num(p.speed), heading: num(p.heading), accuracy: num(p.accuracy), alt: num(p.alt) };
}

function summaryOf(trip) {
  const s = tripStats(trip.points, { timeline: false });
  return { id: trip.id, status: trip.status, source: trip.source || null, endReason: trip.endReason || null, title: trip.title || null, places: trip.places || null, ...s };
}

export function createTripStore({ dir, now = Date.now, staleMs = STALE_MS } = {}) {
  if (!dir) throw new Error('createTripStore: dir is required');
  const trash = path.join(dir, 'trash');
  const file = (id) => path.join(dir, id + '.json');
  const index = new Map(); // id → {mtimeMs, size, summary, open}: GET api/trips re-reads only changed files
  const queues = new Map(); // id → tail of that trip's write chain

  /** Run fn after every earlier write to the same trip has finished. */
  function serial(id, fn) {
    const next = (queues.get(id) || Promise.resolve()).then(fn);
    const tail = next.catch(() => {});
    queues.set(id, tail);
    tail.then(() => { if (queues.get(id) === tail) queues.delete(id); });
    return next;
  }

  async function read(id) {
    try { return JSON.parse(await fs.promises.readFile(file(id), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }

  async function write(trip) {
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${trip.id}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(trip));
      await fs.promises.rename(tmp, file(trip.id));
    } catch (e) {
      await fs.promises.rm(tmp, { force: true });
      throw e;
    }
    index.delete(trip.id);
  }

  const isTrashed = (id) => fs.promises.access(path.join(trash, id + '.json')).then(() => true, () => false);

  function finalise(trip, reason) {
    trip.status = 'done';
    trip.endReason = trip.endReason || reason;
    trip.summary = summaryOf(trip);
  }

  /**
   * Append one chunk {seq, points, final?, source?, reason?}. Resolves to {id, status, pointCount, added}.
   * Rejects with {status: 400|410} for bad input or a deleted trip (so the client drops the chunk).
   */
  function append(id, chunk) {
    if (!TRIP_ID.test(id)) return Promise.reject(httpError(400, 'bad trip id'));
    const pts = Array.isArray(chunk?.points) ? chunk.points : null;
    if (!pts) return Promise.reject(httpError(400, 'points must be an array'));
    if (pts.length > MAX_CHUNK_POINTS) return Promise.reject(httpError(400, `at most ${MAX_CHUNK_POINTS} points per chunk`));
    const seq = Number.isInteger(chunk.seq) && chunk.seq >= 0 ? chunk.seq : null;
    const final = chunk.final === true;
    return serial(id, async () => {
      if (await isTrashed(id)) throw httpError(410, 'trip was deleted');
      const at = now();
      const stored = await read(id);
      const trip = stored || { v: 1, id, status: 'recording', source: null, createdAt: at, updatedAt: at, endReason: null, seqs: [], points: [] };
      let added = 0;
      if (seq == null || !trip.seqs.includes(seq)) {
        const seen = new Set(trip.points.map((p) => p.t));
        let sorted = true;
        for (const raw of pts) {
          const p = normalizePoint(raw);
          if (!p || seen.has(p.t)) continue;
          seen.add(p.t);
          if (trip.points.length && p.t < trip.points[trip.points.length - 1].t) sorted = false;
          trip.points.push(p);
          added++;
        }
        if (!sorted) trip.points.sort((a, b) => a.t - b.t);
        if (seq != null) trip.seqs.push(seq);
      }
      // A resent chunk changes nothing, and an empty one doesn't start a trip: no write either way.
      if (!added && (stored ? !final || trip.status === 'done' : true)) return { id, status: trip.status, pointCount: trip.points.length, added };
      if (chunk.source && !trip.source) trip.source = String(chunk.source).slice(0, 16);
      trip.updatedAt = at;
      // A late chunk (outbox flushed after the trip ended) refreshes the cached summary.
      if (final || trip.status === 'done') finalise(trip, String(chunk.reason || 'ended').slice(0, 32));
      await write(trip);
      return { id, status: trip.status, pointCount: trip.points.length, added };
    });
  }

  async function indexed(id) {
    const st = await fs.promises.stat(file(id)).catch(() => null);
    if (!st) return null;
    const hit = index.get(id);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
    const trip = await read(id).catch(() => null);
    if (!trip) return null;
    const fresh = { mtimeMs: st.mtimeMs, size: st.size, open: trip.status !== 'done', summary: trip.status === 'done' && trip.summary ? trip.summary : summaryOf(trip) };
    index.set(id, fresh);
    return fresh;
  }

  /** Trip summaries, newest first, optionally only those started within [since, until] (ms). */
  async function list({ since = null, until = null } = {}) {
    let names;
    try { names = await fs.promises.readdir(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const out = [];
    for (const name of names) {
      const id = name.endsWith('.json') ? name.slice(0, -5) : '';
      if (!TRIP_ID.test(id)) continue;
      let hit = await indexed(id);
      if (hit?.open && now() - hit.mtimeMs > staleMs) {
        await serial(id, async () => {
          const trip = await read(id);
          if (trip && trip.status !== 'done') { finalise(trip, 'timeout'); await write(trip); }
        });
        hit = await indexed(id);
      }
      const s = hit?.summary;
      if (!s) continue;
      if (since != null && !(s.startedAt >= since)) continue;
      if (until != null && !(s.startedAt <= until)) continue;
      out.push(s);
    }
    return out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }

  /** One trip: its file plus full stats (with the chart timeline), or null. */
  async function get(id) {
    if (!TRIP_ID.test(id)) return null;
    const trip = await read(id);
    if (!trip) return null;
    const { seqs, summary, ...rest } = trip;
    return { ...rest, stats: tripStats(trip.points) };
  }

  /** Totals across the listed trips (same filters as list). */
  async function totals(filter = {}) {
    return { ...aggregateTrips(await list(filter)), since: filter.since ?? null, until: filter.until ?? null };
  }

  /** Move a trip into trash/ (an earlier trashed copy of the same id is kept too). True if it existed. */
  function remove(id) {
    if (!TRIP_ID.test(id)) return Promise.resolve(false);
    return serial(id, async () => {
      if (!fs.existsSync(file(id))) return false;
      await fs.promises.mkdir(trash, { recursive: true });
      let dest = path.join(trash, id + '.json');
      if (fs.existsSync(dest)) dest = path.join(trash, `${id}.${now()}.json`);
      await fs.promises.rename(file(id), dest);
      index.delete(id);
      return true;
    });
  }

  /** Set the display fields the trips panel caches: title, and places {start, end} as labels. */
  function patch(id, body) {
    if (!TRIP_ID.test(id)) return Promise.resolve(null);
    return serial(id, async () => {
      const trip = await read(id);
      if (!trip) return null;
      if (typeof body?.title === 'string') trip.title = body.title.slice(0, 120);
      if (body?.places && typeof body.places === 'object') {
        const label = (x) => (typeof x === 'string' ? x.slice(0, 160) : null);
        trip.places = { start: label(body.places.start), end: label(body.places.end) };
      }
      if (trip.summary) Object.assign(trip.summary, { title: trip.title || null, places: trip.places || null });
      await write(trip);
      return trip.summary || summaryOf(trip);
    });
  }

  return { dir, append, list, get, totals, remove, patch };
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(httpError(413, 'body too large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  // navigator.sendBeacon posts text/plain, so the body is parsed whatever the content type says.
  const text = await readBody(req);
  try { return JSON.parse(text); } catch { throw httpError(400, 'body must be JSON'); }
}

/** since/until query value: epoch ms or an ISO date → ms; '' → null; garbage → undefined. */
const timeParam = (s) => {
  if (s == null || s === '') return null;
  const n = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * The api/trips routes; null when `pathname` isn't one of them, else a promise of {status, body}:
 *   GET    api/trips[?since&until]          {trips: [summary…]} newest first
 *   GET    api/trips/summary[?since&until]  totals (aggregateTrips)
 *   GET    api/trips/:id                    the trip with points and stats (incl. timeline)
 *   POST   api/trips/:id/points             append a chunk {seq, points, final?, source?, reason?}
 *   PATCH  api/trips/:id                    {title?, places?: {start, end}}
 *   DELETE api/trips/:id                    move to trash/
 */
export function tripsRoute(store, req, pathname, query) {
  if (pathname !== '/api/trips' && !pathname.startsWith('/api/trips/')) return null;
  const parts = pathname.split('/').slice(3).filter((x, i, a) => x || i < a.length - 1); // tolerate one trailing slash
  const m = req.method === 'HEAD' ? 'GET' : req.method;
  const bad = (status, error) => ({ status, body: { error } });
  return (async () => {
    try {
      if (parts.length === 0 || (parts.length === 1 && parts[0] === 'summary')) {
        if (m !== 'GET') return bad(405, 'method not allowed');
        const since = timeParam(query.get('since'));
        const until = timeParam(query.get('until'));
        if (since === undefined || until === undefined) return bad(400, 'since and until must be epoch ms or an ISO date');
        if (parts.length) return { status: 200, body: await store.totals({ since, until }) };
        return { status: 200, body: { trips: await store.list({ since, until }) } };
      }
      const id = parts[0];
      if (!TRIP_ID.test(id)) return bad(400, 'bad trip id');
      if (parts.length === 2 && parts[1] === 'points') {
        if (m !== 'POST') return bad(405, 'method not allowed');
        return { status: 200, body: { ok: true, ...(await store.append(id, await readJson(req))) } };
      }
      if (parts.length !== 1) return bad(404, 'not found');
      if (m === 'GET') {
        const trip = await store.get(id);
        return trip ? { status: 200, body: trip } : bad(404, 'no such trip');
      }
      if (m === 'DELETE') return (await store.remove(id)) ? { status: 200, body: { ok: true, trashed: id } } : bad(404, 'no such trip');
      if (m === 'PATCH') {
        const s = await store.patch(id, await readJson(req));
        return s ? { status: 200, body: s } : bad(404, 'no such trip');
      }
      return bad(405, 'method not allowed');
    } catch (e) {
      if (e.status) return bad(e.status, e.message);
      throw e;
    }
  })();
}
