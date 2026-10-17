// Pure helpers behind the trips panel (tripsui.js): speed and per-trip colours, the speed-coloured
// track as GeoJSON, replay interpolation by real timestamps, the speed chart's geometry and the
// labels. No DOM and no map here, so Node tests run them directly.
import { bearing, formatDistance, formatDuration, haversine, lerpHeading, speedIn } from './geo.js';

// Speed colour ramp (km/h → colour): dim green when crawling, neon green in town, then yellow, amber
// and a hot pink only well above motorway speed. Shared by the map layers, the legend and the chart.
export const SPEED_STOPS = [[0, '#0a6b40'], [30, '#00ff88'], [60, '#b6ff3b'], [90, '#ffd23f'], [120, '#ff7a2f'], [150, '#ff2d6f']];

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const toHex = (rgb) => '#' + rgb.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');

/** Colour for a speed in m/s, interpolated along SPEED_STOPS. */
export function speedColor(ms) {
  const kmh = Math.max(0, (Number.isFinite(ms) ? ms : 0) * 3.6);
  for (let i = 1; i < SPEED_STOPS.length; i++) {
    const [k1, c1] = SPEED_STOPS[i];
    if (kmh <= k1) {
      const [k0, c0] = SPEED_STOPS[i - 1];
      const f = (kmh - k0) / (k1 - k0);
      const a = hex(c0), b = hex(c1);
      return toHex(a.map((x, j) => x + (b[j] - x) * f));
    }
  }
  return SPEED_STOPS[SPEED_STOPS.length - 1][1];
}

/** MapLibre expression: line colour from a feature's speed property (m/s). */
export function speedColorExpr(prop = 'v') {
  return ['interpolate', ['linear'], ['*', ['to-number', ['get', prop], 0], 3.6], ...SPEED_STOPS.flat()];
}

// Trip colours: bright, and away from the base map's neon green so every trip stands out from the
// roads. Past these, hues step by the golden angle, skipping the green band.
export const TRIP_COLORS = ['#ff2d6f', '#2de2ff', '#ffb52d', '#a66bff', '#f5ff3b', '#ff7a2f', '#ff4dff', '#4d9dff', '#ff6b6b', '#ffd6f0', '#c9a0ff', '#ffe08a'];

/** The i-th trip's colour. */
export function tripColor(i) {
  if (i < TRIP_COLORS.length) return TRIP_COLORS[i];
  let h = (i * 137.508) % 360;
  if (h > 85 && h < 175) h = (h + 90) % 360;
  const l = 0.62;
  const a = Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1))); };
  return toHex([f(0) * 255, f(8) * 255, f(4) * 255]);
}

/**
 * A track coloured by speed as a GeoJSON FeatureCollection: consecutive vertices whose speed falls in
 * the same `binKmh` band share one LineString (props: v = mean m/s, id when given), so a long trip
 * stays a handful of features instead of one per fix. `pts` is [{lat, lon, v}] or [[lon, lat, v]].
 */
export function speedSegments(pts, { binKmh = 8, id = null } = {}) {
  const P = (pts || []).map((p) => (Array.isArray(p) ? { lon: p[0], lat: p[1], v: p[2] || 0 } : p));
  const features = [];
  let cur = null;
  for (let i = 0; i < P.length; i++) {
    const p = P[i];
    const bin = Math.floor((p.v * 3.6) / binKmh);
    if (cur && bin === cur.bin) {
      cur.coords.push([p.lon, p.lat]);
      cur.sum += p.v; cur.n++;
      continue;
    }
    if (cur) features.push(done(cur));
    // A new band starts at the previous vertex, so the line has no holes.
    const prev = P[i - 1];
    cur = { bin, coords: prev ? [[prev.lon, prev.lat], [p.lon, p.lat]] : [[p.lon, p.lat]], sum: p.v, n: 1 };
  }
  if (cur) features.push(done(cur));
  function done(c) {
    const coords = c.coords.length === 1 ? [c.coords[0], c.coords[0]] : c.coords;
    return { type: 'Feature', properties: { v: Math.round((c.sum / c.n) * 100) / 100, ...(id != null ? { id } : {}) }, geometry: { type: 'LineString', coordinates: coords } };
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Replay track from a speed profile [{t, lat, lon, v}] (tripstats speedProfile): adds a heading per
 * fix, taken toward the first fix at least `lookM` ahead (so GPS wobble while stopped doesn't spin the
 * marker) and held while standing.
 */
export function replayTrack(profile, { lookM = 8, lookMs = 30000 } = {}) {
  const pts = (profile || []).map((p) => ({ ...p }));
  let last = null;
  for (let i = 0; i < pts.length; i++) {
    let h = null;
    for (let j = i + 1; j < pts.length && pts[j].t - pts[i].t <= lookMs; j++) {
      if (haversine(pts[i], pts[j]) >= lookM) { h = bearing(pts[i], pts[j]); break; }
    }
    pts[i].h = h ?? last;
    if (h != null) last = h;
  }
  // Fixes before the first movement face where the car is about to go.
  const first = pts.find((p) => p.h != null)?.h ?? 0;
  for (const p of pts) { if (p.h == null) p.h = first; else break; }
  return { pts, t0: pts[0]?.t ?? 0, t1: pts[pts.length - 1]?.t ?? 0 };
}

/** Where the replay is at time `t` (ms): {lat, lon, v, heading, i}, interpolated between the fixes around it. */
export function replayAt(track, t) {
  const { pts } = track;
  if (!pts.length) return null;
  if (t <= pts[0].t) return { lat: pts[0].lat, lon: pts[0].lon, v: pts[0].v, heading: pts[0].h, i: 0 };
  const n = pts.length - 1;
  if (t >= pts[n].t) return { lat: pts[n].lat, lon: pts[n].lon, v: pts[n].v, heading: pts[n].h, i: n };
  let lo = 0, hi = n;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid].t <= t) lo = mid; else hi = mid; }
  const a = pts[lo], b = pts[hi];
  const f = (t - a.t) / (b.t - a.t || 1);
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, v: a.v + (b.v - a.v) * f, heading: lerpHeading(a.h, b.h, f), i: lo };
}

/** Date-range filter → `since` in ms, or null for all time. */
export function rangeSince(range, now = Date.now()) {
  const days = { '7d': 7, '30d': 30 }[range];
  return days ? now - days * 86400000 : null;
}

/** A round axis maximum at or above x, with a step that gives 3-6 grid lines. */
export function niceMax(x) {
  const v = Math.max(10, x);
  for (const step of [10, 20, 25, 50, 100]) if (v / step <= 6) return { max: Math.ceil(v / step) * step, step };
  return { max: Math.ceil(v / 200) * 200, step: 200 };
}

/**
 * The speed chart's geometry in a w×h box (SVG units): the line and filled area of speed over time,
 * the grid in the display unit, and the top-speed point. `timeline` is tripStats' [{t (s), v (m/s)}].
 */
export function chartModel(timeline, { w = 320, h = 120, unit = 'kmh', pad = { l: 30, r: 6, t: 8, b: 16 } } = {}) {
  const tl = (timeline || []).filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));
  const tMax = Math.max(1, tl.length ? tl[tl.length - 1].t : 1);
  const peak = tl.reduce((m, p) => Math.max(m, p.v), 0);
  const { max, step } = niceMax(speedIn(peak, unit) * 1.05);
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const x = (t) => pad.l + (t / tMax) * iw;
  const y = (ms) => pad.t + ih - (Math.min(max, speedIn(ms, unit)) / max) * ih;
  const r1 = (n) => Math.round(n * 10) / 10;
  const pts = tl.map((p) => `${r1(x(p.t))},${r1(y(p.v))}`);
  const line = pts.length ? 'M' + pts.join('L') : '';
  const area = pts.length ? `${line}L${r1(x(tl[tl.length - 1].t))},${pad.t + ih}L${r1(x(tl[0].t))},${pad.t + ih}Z` : '';
  const grid = [];
  for (let v = 0; v <= max; v += step) grid.push({ y: r1(pad.t + ih - (v / max) * ih), label: String(v) });
  const top = tl.find((p) => p.v === peak);
  return {
    w, h, pad, tMax, max, line, area, grid,
    peak: top ? { x: r1(x(top.t)), y: r1(y(top.v)), v: top.v, t: top.t } : null,
    xOf: x, tOf: (px) => Math.max(0, Math.min(tMax, ((px - pad.l) / iw) * tMax)),
  };
}

/** Speed readout from a timeline at s seconds since the start (linear between entries). */
export function timelineAt(timeline, s) {
  const tl = timeline || [];
  if (!tl.length) return null;
  if (s <= tl[0].t) return tl[0];
  for (let i = 1; i < tl.length; i++) {
    if (tl[i].t >= s) {
      const a = tl[i - 1], b = tl[i];
      const f = (s - a.t) / (b.t - a.t || 1);
      return { t: s, v: a.v + (b.v - a.v) * f, d: a.d + (b.d - a.d) * f, a: a.a };
    }
  }
  return tl[tl.length - 1];
}

// ---- Labels ------------------------------------------------------------------------------------

export const fmtSpeed = (ms, unit) => (Number.isFinite(ms) ? `${Math.round(speedIn(ms, unit))} ${unit === 'mph' ? 'mph' : 'km/h'}` : '—');
export const fmtAccel = (a) => (Number.isFinite(a) ? `${a.toFixed(1)} m/s²` : '—');
export const fmtG = (a) => (Number.isFinite(a) ? `${(a / 9.80665).toFixed(2)} g` : '');
export { formatDistance as fmtDistance, formatDuration as fmtDuration };

/** 0:42 · 12:05 · 1:02:07 */
export function fmtClock(s) {
  const t = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

export const fmtCoord = (p) => (p && Number.isFinite(p.lat) && Number.isFinite(p.lon) ? `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}` : '—');

/** "Andrássy út → Városliget", falling back to coordinates for a side not named yet. */
export function tripRoute(s) {
  const a = s?.places?.start || fmtCoord(s?.start);
  const b = s?.places?.end || fmtCoord(s?.end);
  return `${a} → ${b}`;
}

/** "Fri 17 Oct · 14:32" in the browser's locale; the year only when it isn't this year. */
export function fmtWhen(ms, now = Date.now(), locale = undefined) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const day = d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
  return `${day} · ${d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}`;
}
