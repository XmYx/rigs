#!/usr/bin/env node
// Navigation applet server: serves the UI (public/) with relative URLs only, because the App Cloud
// reaches it under /api/nodes/<node>/apps/navigation/, plus
//   GET healthz      {ok:true}
//   GET config.json  the free map stack the browser should use (tiles, glyphs, demo route)
//   GET api/search   place search: Photon (komoot), falling back to Nominatim
//   GET api/route    driving route with turn-by-turn steps from OSRM
//   GET api/traffic  per-road congestion around a bbox: TomTom flow tiles or assumed traffic (traffic.js)
//   api/trips…       recorded trips: upload chunks, list, detail, totals, delete-to-trash (tripstore.js)
// Search and routing go through here so the public OSM services see one polite, cached, rate-limited
// client with a real User-Agent instead of every browser hitting them directly.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { HOME, expandHome, log, readJsonSync } from '../../src/util.js';
import { createTraffic, hash01, routeInfo } from './traffic.js';
import { createTripStore, tripsRoute } from './tripstore.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.join(HERE, 'public');
export const USER_AGENT = 'rigs-navigation-applet/0.1 (RIGS mesh; personal navigation, low volume)';

export const DEFAULTS = {
  port: 8731,
  host: '127.0.0.1',
  tilesUrl: 'https://tiles.openfreemap.org/planet',
  glyphsUrl: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  routingUrl: 'https://router.project-osrm.org',
  searchUrl: 'https://photon.komoot.io',
  nominatimUrl: 'https://nominatim.openstreetmap.org',
  tomtomUrl: 'https://api.tomtom.com',
  // Traffic: 'auto' = TomTom when a key is set, else the synthetic model. tomtomKey is a secret: it
  // never reaches the browser or a log line.
  trafficSource: 'auto',
  tomtomKey: null,
  trafficDailyTiles: 5000,
  // Demo drive: Budapest, Andrássy út from Deák tér out to Hősök tere and round the park.
  demo: { from: [19.0548, 47.4979], to: [19.0838, 47.5155] },
};

const URL_KEYS = ['tilesUrl', 'glyphsUrl', 'routingUrl', 'searchUrl', 'nominatimUrl', 'tomtomUrl'];
const ENV_KEYS = { tilesUrl: 'NAV_TILES_URL', glyphsUrl: 'NAV_GLYPHS_URL', routingUrl: 'NAV_ROUTING_URL', searchUrl: 'NAV_SEARCH_URL', nominatimUrl: 'NAV_NOMINATIM_URL', tomtomUrl: 'NAV_TOMTOM_URL' };
const TRAFFIC_SOURCES = ['auto', 'tomtom', 'synthetic', 'off'];

const isHttpUrl = (s) => typeof s === 'string' && /^https?:\/\/[^\s]+$/i.test(s);
const isLonLat = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;

/**
 * Settings from env (NAV_*), then ~/.rigs/config.json → navigation, then defaults. Bad values are
 * dropped with a warning that names the setting but never echoes its value (URLs can carry tokens).
 */
export function loadNavConfig({ env = process.env, configFile } = {}) {
  const rigsHome = env.RIGS_HOME ? path.resolve(env.RIGS_HOME) : path.join(HOME, '.rigs');
  const file = configFile || path.join(rigsHome, 'config.json');
  const fromFile = readJsonSync(file, {})?.navigation || {};
  const warnings = [];
  const cfg = { ...DEFAULTS, demo: { ...DEFAULTS.demo } };
  // Recorded trips (tripstore.js). Personal location history: it stays on this machine.
  const dataDir = env.NAV_DATA_DIR || fromFile.dataDir;
  cfg.dataDir = dataDir ? path.resolve(expandHome(String(dataDir))) : path.join(rigsHome, 'navigation', 'trips');

  const port = Number(env.NAV_PORT || fromFile.port || DEFAULTS.port);
  if (Number.isInteger(port) && port >= 0 && port < 65536) cfg.port = port;
  else warnings.push('port must be an integer 0-65535; using ' + DEFAULTS.port);
  if (env.NAV_HOST || fromFile.host) cfg.host = String(env.NAV_HOST || fromFile.host);

  for (const k of URL_KEYS) {
    const v = env[ENV_KEYS[k]] || fromFile[k];
    if (v == null || v === '') continue;
    if (isHttpUrl(v)) cfg[k] = String(v).replace(/\/+$/, '');
    else warnings.push(`${k} must be an http(s) URL; using the default`);
  }
  const source = env.NAV_TRAFFIC_SOURCE || fromFile.trafficSource;
  if (source != null && source !== '') {
    if (TRAFFIC_SOURCES.includes(source)) cfg.trafficSource = source;
    else warnings.push(`trafficSource must be one of ${TRAFFIC_SOURCES.join(', ')}; using auto`);
  }
  const key = env.NAV_TOMTOM_KEY || fromFile.tomtomKey;
  if (key != null && key !== '') {
    if (typeof key === 'string' && /^[\w.-]{8,128}$/.test(key)) cfg.tomtomKey = key;
    else warnings.push('tomtomKey (NAV_TOMTOM_KEY) does not look like a TomTom key; traffic uses the assumed model');
  }
  if (cfg.trafficSource === 'tomtom' && !cfg.tomtomKey) warnings.push('trafficSource is tomtom but NAV_TOMTOM_KEY is not set; traffic uses the assumed model');
  const daily = env.NAV_TRAFFIC_DAILY_TILES || fromFile.trafficDailyTiles;
  if (daily != null && daily !== '') {
    if (Number.isInteger(Number(daily)) && Number(daily) >= 0) cfg.trafficDailyTiles = Number(daily);
    else warnings.push('trafficDailyTiles must be a whole number; using ' + DEFAULTS.trafficDailyTiles);
  }
  if (fromFile.demo) {
    for (const end of ['from', 'to']) {
      if (fromFile.demo[end] == null) continue;
      if (isLonLat(fromFile.demo[end])) cfg.demo[end] = fromFile.demo[end];
      else warnings.push(`demo.${end} must be [lon, lat]; using the default`);
    }
  }
  return { cfg, warnings };
}

/** Which traffic source the applet is set up for: 'tomtom' | 'synthetic' | 'off' (never the key itself). */
export function trafficMode(cfg) {
  if (cfg.trafficSource === 'off') return 'off';
  return cfg.tomtomKey && cfg.trafficSource !== 'synthetic' ? 'tomtom' : 'synthetic';
}

/** What the browser gets from config.json: only the public endpoints it loads itself. */
export function publicConfig(cfg) {
  return { tiles: cfg.tilesUrl, glyphs: cfg.glyphsUrl, demo: cfg.demo, traffic: { source: trafficMode(cfg) }, provider: 'OpenStreetMap · OpenFreeMap · OSRM · Photon/Nominatim' };
}

/** `bbox=w,s,e,n` → [w, s, e, n], or null unless 4 finite numbers with w<e and s<n. */
export function parseBbox(s) {
  const b = String(s || '').split(',').map(Number);
  if (b.length !== 4 || !b.every(Number.isFinite)) return null;
  const [w, so, e, n] = b;
  return w < e && so < n && Math.abs(w) <= 180 && Math.abs(e) <= 180 && Math.abs(so) <= 90 && Math.abs(n) <= 90 ? b : null;
}

// ---- Upstream responses → the small shapes the UI uses ---------------------------------------------

/** OSRM /route response → {distance, duration, geometry, steps} or null. */
export function normalizeOsrm(data) {
  const r = data && data.code === 'Ok' && data.routes && data.routes[0];
  if (!r || !r.geometry || !Array.isArray(r.geometry.coordinates)) return null;
  const steps = [];
  for (const leg of r.legs || []) {
    for (const s of leg.steps || []) {
      const m = s.maneuver || {};
      steps.push({
        type: m.type, modifier: m.modifier, exit: m.exit,
        name: s.name || s.ref || '', location: m.location,
        distance: s.distance, duration: s.duration,
      });
    }
  }
  return { distance: r.distance, duration: r.duration, geometry: r.geometry.coordinates, steps };
}

/**
 * Drop results that repeat an earlier one: same label within ~200 m (a station, its platforms and its
 * metro stop all come back as separate hits).
 */
export function dedupeResults(results) {
  const kept = [];
  for (const r of results) {
    if (!kept.some((k) => k.label === r.label && Math.abs(k.lat - r.lat) < 0.002 && Math.abs(k.lon - r.lon) < 0.003)) kept.push(r);
  }
  return kept;
}

/** Photon GeoJSON → [{label, detail, lon, lat}]. */
export function normalizePhoton(data) {
  return dedupeResults((data?.features || []).filter((f) => f?.geometry?.coordinates).map((f) => {
    const p = f.properties || {};
    const street = [p.street, p.housenumber].filter(Boolean).join(' ');
    const label = p.name || street || p.city || 'Unnamed place';
    const detail = [p.name && street, p.district, p.city !== label && p.city, p.country].filter(Boolean).join(', ');
    return { label, detail, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
  }));
}

/** Nominatim jsonv2 → [{label, detail, lon, lat}]. */
export function normalizeNominatim(data) {
  return dedupeResults((Array.isArray(data) ? data : []).map((d) => {
    const parts = String(d.display_name || '').split(', ');
    const label = d.name || parts[0] || 'Unnamed place';
    return { label, detail: parts.filter((x) => x !== label).slice(0, 3).join(', '), lon: Number(d.lon), lat: Number(d.lat) };
  }).filter((r) => Number.isFinite(r.lon) && Number.isFinite(r.lat)));
}

// ---- Polite upstream client: cache + per-host spacing ------------------------------------------

export function createUpstream({ fetchImpl = globalThis.fetch, minGapMs = { 'nominatim.openstreetmap.org': 1100 }, ttlMs = 10 * 60 * 1000, max = 300 } = {}) {
  const cache = new Map();
  const nextSlot = new Map();
  return async function getJson(url) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < ttlMs) return hit.data;
    const host = new URL(url).host;
    const gap = minGapMs[host] || 0;
    if (gap) {
      const now = Date.now();
      const at = Math.max(now, nextSlot.get(host) || 0);
      nextSlot.set(host, at + gap);
      if (at > now) await new Promise((r) => setTimeout(r, at - now));
    }
    const res = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw Object.assign(new Error(`upstream ${host} HTTP ${res.status}`), { status: res.status });
    const data = await res.json();
    cache.set(url, { at: Date.now(), data });
    if (cache.size > max) cache.delete(cache.keys().next().value);
    return data;
  };
}

// ---- HTTP --------------------------------------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

function send(res, status, body, headers = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  // Traffic answers run to a few hundred KB of coordinates; they shrink ~5x gzipped.
  if (buf.length > 8192 && headers['content-type'] == null && /\bgzip\b/.test(res.req.headers['accept-encoding'] || '')) {
    buf = zlib.gzipSync(buf);
    headers = { ...headers, 'content-encoding': 'gzip', vary: 'accept-encoding' };
  }
  res.writeHead(status, { 'content-length': buf.length, 'content-type': 'application/json', ...headers });
  res.end(res.req.method === 'HEAD' ? undefined : buf);
}

function parseLonLat(s) {
  const p = String(s || '').split(',').map(Number);
  return isLonLat(p) ? p : null;
}

export function createNavServer({ cfg = loadNavConfig().cfg, fetchImpl, publicDir = PUBLIC_DIR, now, trips } = {}) {
  const getJson = createUpstream({ fetchImpl });
  const tripStore = trips || createTripStore({ dir: cfg.dataDir || path.join(HOME, '.rigs', 'navigation', 'trips'), now });
  const traffic = createTraffic({ cfg, fetchImpl, now, log, userAgent: USER_AGENT });
  const root = path.resolve(publicDir);
  // Recent routes by routeId, so api/traffic can bump the roads along the route without the client
  // uploading the polyline: the last 20, for 30 min.
  const routes = new Map();
  const ROUTE_TTL = 30 * 60 * 1000;
  const clock = now || Date.now;

  async function search(q, near) {
    const bias = near ? `&lon=${near[0]}&lat=${near[1]}` : '';
    try {
      const out = normalizePhoton(await getJson(`${cfg.searchUrl}/api/?q=${encodeURIComponent(q)}&limit=6${bias}`));
      if (out.length) return out;
    } catch (e) {
      log('navigation: search falling back to Nominatim:', e.message);
    }
    const viewbox = near ? `&viewbox=${near[0] - 0.5},${near[1] + 0.5},${near[0] + 0.5},${near[1] - 0.5}` : '';
    return normalizeNominatim(await getJson(`${cfg.nominatimUrl}/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}${viewbox}`));
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    // Trips take POST/PATCH/DELETE too; everything else below stays GET/HEAD only.
    const trip = tripsRoute(tripStore, req, p, url.searchParams);
    if (trip) { const r = await trip; return send(res, r.status, r.body, { 'cache-control': 'no-store' }); }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
    if (p === '/healthz') return send(res, 200, { ok: true }, { 'cache-control': 'no-store' });
    if (p === '/config.json') return send(res, 200, publicConfig(cfg), { 'cache-control': 'no-store' });
    if (p === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
      if (q.length < 2) return send(res, 400, { error: 'q must be at least 2 characters' });
      const near = parseLonLat(url.searchParams.get('near'));
      try { return send(res, 200, { results: await search(q, near) }); }
      catch (e) { return send(res, 502, { error: 'search unavailable: ' + e.message }); }
    }
    if (p === '/api/route') {
      const from = parseLonLat(url.searchParams.get('from'));
      const to = parseLonLat(url.searchParams.get('to'));
      if (!from || !to) return send(res, 400, { error: 'from and to must be lon,lat' });
      try {
        const data = await getJson(`${cfg.routingUrl}/route/v1/driving/${from.join(',')};${to.join(',')}?overview=full&geometries=geojson&steps=true&alternatives=false`);
        const route = normalizeOsrm(data);
        if (!route) return send(res, 404, { error: 'no route found' });
        route.routeId = Math.floor(hash01(`${from.join(',')};${to.join(',')}`) * 2 ** 32).toString(36);
        routes.delete(route.routeId);
        routes.set(route.routeId, { at: clock(), info: routeInfo(route.geometry) });
        while (routes.size > 20) routes.delete(routes.keys().next().value);
        return send(res, 200, route);
      } catch (e) { return send(res, 502, { error: 'routing unavailable: ' + e.message }); }
    }
    if (p === '/api/traffic') {
      const bbox = parseBbox(url.searchParams.get('bbox'));
      if (!bbox) return send(res, 400, { error: 'bbox must be west,south,east,north with west<east and south<north' });
      const z = Number(url.searchParams.get('z'));
      if (!url.searchParams.get('z') || !Number.isFinite(z) || z < 0 || z > 22) return send(res, 400, { error: 'z must be the map zoom, 0-22' });
      const hit = routes.get(url.searchParams.get('route') || '');
      const route = hit && clock() - hit.at < ROUTE_TTL ? hit.info : null;
      const tz = (url.searchParams.get('tz') || '').slice(0, 64) || undefined;
      const at = Date.parse(url.searchParams.get('at') || '');
      const out = await traffic.get({ bbox, z, tz, route, source: url.searchParams.get('source') || undefined, at: Number.isFinite(at) ? at : undefined });
      return send(res, 200, out, { 'cache-control': 'private, max-age=30' });
    }
    // Static files. Only public/ is served; anything resolving outside it is a 404.
    let rel;
    try { rel = decodeURIComponent(p); } catch { return send(res, 400, { error: 'bad path' }); }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep)) return send(res, 404, { error: 'not found' });
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, { error: 'not found' });
      const ext = path.extname(file).toLowerCase();
      send(res, 200, buf, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : 'max-age=300' });
    });
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((e) => { try { send(res, 500, { error: String(e.message || e) }); } catch {} });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { cfg, warnings } = loadNavConfig();
  for (const w of warnings) log('navigation config:', w);
  const server = createNavServer({ cfg });
  server.listen(cfg.port, cfg.host, () => log(`navigation applet on http://${cfg.host}:${server.address().port}/`));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
}
