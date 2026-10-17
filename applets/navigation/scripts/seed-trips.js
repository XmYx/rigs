#!/usr/bin/env node
// Seed sample trips for screenshots and trying the Trips panel: a handful of drives round Budapest
// (the demo area), spread over the last ~6 weeks, written through the real trip store in 15-fix
// chunks like the browser recorder sends them.
//
//   NAV_DATA_DIR=/tmp/nav-trips node applets/navigation/scripts/seed-trips.js [--count=8] [--offline]
//
// Without NAV_DATA_DIR it makes a fresh temp dir and prints it; it never writes into the real trips
// folder unless you point it there. Routes come from OSRM (the applet's routing service, with its
// per-segment speed estimates) when reachable; --offline or no network uses built-in lines instead.
// The drive is simulated at 1 Hz: the driver eases toward the road's speed (2 m/s² up, 3 m/s² down),
// stops at some lights, and the fixes carry ~2 m of GPS error that drifts slowly, as a phone's does.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bearing, cumulativeDistances, pointAlong } from '../public/geo.js';
import { newTripId } from '../public/trips.js';
import { DEFAULTS, USER_AGENT } from '../server.js';
import { createTripStore } from '../tripstore.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const offline = args.includes('--offline');
const count = Math.max(1, Math.min(20, Number(opt('count', 8)) || 8));
const dir = process.env.NAV_DATA_DIR ? path.resolve(process.env.NAV_DATA_DIR) : fs.mkdtempSync(path.join(os.tmpdir(), 'nav-trips-'));
const routingUrl = (process.env.NAV_ROUTING_URL || DEFAULTS.routingUrl).replace(/\/+$/, '');

// [name, from, to, days ago, hour] — from/to as [lon, lat]. Days ago spread so the 7 d / 30 d filters differ.
const DRIVES = [
  ['Deák tér → Városliget', [19.0548, 47.4979], [19.0838, 47.5155], 0.2, 8.5],
  ['Keleti → Széll Kálmán tér', [19.0837, 47.5003], [19.0237, 47.5075], 2, 18],
  ['Árpád híd → Gellért tér', [19.0505, 47.5333], [19.0530, 47.4840], 5, 12.25],
  ['Gellért tér → Érd (M6)', [19.0530, 47.4840], [18.9135, 47.3780], 9, 16.5],
  ['Örs vezér tere → Nyugati', [19.1360, 47.5030], [19.0565, 47.5103], 13, 7.75],
  ['Flórián tér → Népliget', [19.0410, 47.5410], [19.0960, 47.4760], 21, 19],
  ['Újpest → Deák tér', [19.0870, 47.5600], [19.0548, 47.4979], 34, 10],
  ['Zugló → Kőbánya', [19.1100, 47.5150], [19.1450, 47.4880], 41, 15],
];

let seed = 20261017;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());

/** OSRM route with per-vertex road speed (m/s), or null. */
async function osrmRoute(from, to) {
  if (offline) return null;
  try {
    const url = `${routingUrl}/route/v1/driving/${from.join(',')};${to.join(',')}?overview=full&geometries=geojson&annotations=speed`;
    const r = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const d = await r.json();
    const route = d.routes?.[0];
    const coords = route?.geometry?.coordinates;
    const speeds = route?.legs?.flatMap((l) => l.annotation?.speed || []);
    if (!coords?.length || speeds?.length !== coords.length - 1) return null;
    return { coords, speeds: [...speeds, speeds[speeds.length - 1]], source: 'osrm' };
  } catch {
    return null;
  }
}

/** Fallback: a gently bent line between the two ends at town speed (motorway speed past ~10 km). */
function lineRoute(from, to) {
  const coords = [];
  for (let i = 0; i <= 20; i++) {
    const f = i / 20;
    const bend = Math.sin(f * Math.PI) * 0.004;
    coords.push([from[0] + (to[0] - from[0]) * f + bend, from[1] + (to[1] - from[1]) * f - bend]);
  }
  const far = Math.hypot(to[0] - from[0], to[1] - from[1]) > 0.1;
  return { coords, speeds: coords.map(() => (far ? 30 : 13)), source: 'line' };
}

/** Drive a route at 1 Hz from t0: fixes {t, lat, lon, speed, heading, accuracy, alt}. */
function simulate({ coords, speeds }, t0) {
  const cum = cumulativeDistances(coords);
  const total = cum[cum.length - 1];
  const speedAt = (d) => { let i = 1; while (i < cum.length - 1 && cum[i] < d) i++; return speeds[i - 1]; };
  const fixes = [];
  let along = 0, v = 0, t = t0;
  let nextLight = 300 + rnd() * 600;
  let waitUntil = 0;
  let eN = 0, eE = 0; // position error in m: AR(1), σ ≈ 2 m, correlated over ~20 s
  const fix = (time, speed) => {
    const p = pointAlong(coords, cum, along);
    const ahead = pointAlong(coords, cum, Math.min(total, along + 12));
    eN = 0.95 * eN + 0.62 * gauss();
    eE = 0.95 * eE + 0.62 * gauss();
    return {
      t: time, lat: p.lat + eN / 111195, lon: p.lon + eE / (111195 * Math.cos((p.lat * Math.PI) / 180)),
      speed: speed > 0 ? Math.max(0, speed + gauss() * 0.25) : 0, heading: along + 1 < total ? bearing(p, ahead) : p.bearing,
      accuracy: 4 + rnd() * 4, alt: 105 + gauss(),
    };
  };
  // ~8 s parked at the start, like the recorder's pre-roll.
  for (let k = 0; k < 8; k++, t += 1000) fixes.push(fix(t, 0));
  while (along < total - 1) {
    const road = Math.min(36, speedAt(along) * (0.92 + 0.16 * rnd()));
    let target = t < waitUntil ? 0 : road;
    // Some lights are red: stop there for a while. And brake for the destination.
    if (along > nextLight) {
      nextLight = along + 350 + rnd() * 900;
      if (road < 20 && rnd() < 0.45) waitUntil = t + (8 + rnd() * 30) * 1000;
    }
    // (Crawling at ≥ 1.5 m/s for the last metres, so the drive always reaches the end.)
    target = Math.max(Math.min(target, Math.sqrt(2 * 2.6 * Math.max(0, total - along))), Math.min(target, 1.5));
    v = Math.max(0, v + Math.max(-3, Math.min(2, target - v)));
    along = Math.min(total, along + v);
    t += 1000;
    fixes.push(fix(t, v));
  }
  for (let k = 0; k < 6; k++) { t += 1000; fixes.push(fix(t, 0)); }
  return fixes;
}

const store = createTripStore({ dir });
const now = Date.now();
const made = [];
for (const [name, from, to, daysAgo, hour] of DRIVES.slice(0, count)) {
  const day = new Date(now - daysAgo * 86400000);
  day.setHours(Math.floor(hour), Math.round((hour % 1) * 60), Math.floor(rnd() * 60), 0);
  const t0 = Math.min(day.getTime(), now - 30 * 60000);
  const route = (await osrmRoute(from, to)) || lineRoute(from, to);
  const fixes = simulate(route, t0);
  const id = newTripId(t0, rnd);
  for (let seq = 0, i = 0; i < fixes.length; seq++, i += 15) {
    const last = i + 15 >= fixes.length;
    await store.append(id, { seq, points: fixes.slice(i, i + 15), final: last, reason: last ? 'stopped' : undefined, source: 'seed' });
  }
  made.push({ id, name, fixes: fixes.length, route: route.source });
}
const totals = await store.totals();
console.log(JSON.stringify({ dir, trips: made, totals: { trips: totals.trips, km: Math.round(totals.distance / 100) / 10, topKmh: Math.round(totals.maxSpeed * 3.6) } }, null, 2));
