// Navigation applet UI: MapLibre GL over free OpenStreetMap vector tiles, a JARVIS-style HUD (speed,
// heading, next turn, ETA), a follow-me 3D camera, destination search + routing through the applet
// server, and ?demo=1 which drives a simulated vehicle so it all works without GPS.
import {
  bearing, cardinal, createMotionEstimator, formatDistance, formatDuration, kmhToMs, lerpHeading,
  maneuverArrow, maneuverText, pointAlong, cumulativeDistances, routeProgress, speedIn, zoomForSpeed,
} from './geo.js';
import { buildStyle, routeLayers } from './mapstyle.js';

const MAPLIBRE_FALLBACK = 'https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.js';
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DEMO = params.has('demo') && params.get('demo') !== '0';
const DEMO_TICK_MS = 200;
const PITCH = 60;

const store = {
  get(k, d) { try { return localStorage.getItem('nav.' + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('nav.' + k, v); } catch {} },
};

const state = {
  cfg: null, map: null, unit: store.get('unit', 'kmh') === 'mph' ? 'mph' : 'kmh',
  follow: true, pitched: true, pos: null, speed: null, heading: null, source: null,
  route: null, dest: null, progress: null, offRoute: 0, lastReroute: 0,
  mapLoaded: false, driving: false, fixes: 0,
};
window.__nav = state; // inspection hook for screenshots and debugging

// ---- Screens, status, errors -------------------------------------------------------------------

function screen(title, html, actions = []) {
  $('screen-title').textContent = title;
  $('screen-text').innerHTML = html;
  $('screen-actions').replaceChildren(...actions.map(([label, fn, primary]) => {
    const b = document.createElement(typeof fn === 'string' ? 'a' : 'button');
    b.textContent = label;
    b.className = primary ? 'btn primary' : 'btn';
    if (typeof fn === 'string') b.href = fn; else b.onclick = fn;
    return b;
  }));
  $('screen').hidden = false;
}

let statusTimer = null;
function status(text, { sticky = false, html = false } = {}) {
  const el = $('status');
  clearTimeout(statusTimer);
  if (!text) { el.hidden = true; return; }
  if (html) el.innerHTML = text; else el.textContent = text;
  el.hidden = false;
  if (!sticky) statusTimer = setTimeout(() => { el.hidden = true; }, 5000);
}

window.addEventListener('error', (e) => status('Something went wrong: ' + (e.message || 'unknown error')));
window.addEventListener('unhandledrejection', (e) => status('Something went wrong: ' + (e.reason?.message || e.reason || 'unknown error')));

function loadScript(src) {
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.append(s);
  });
}

function hasWebGL() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; }
}

// ---- Boot --------------------------------------------------------------------------------------

async function boot() {
  try {
    const r = await fetch('config.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    state.cfg = await r.json();
  } catch (e) {
    return screen('Navigation server unreachable',
      `The applet could not read <code>config.json</code> from its server (${escapeHtml(e.message)}). ` +
      'Start it with <code>node applets/navigation/server.js</code> and reload.', [['Retry', () => location.reload(), true]]);
  }
  if (typeof window.maplibregl === 'undefined') await loadScript(MAPLIBRE_FALLBACK);
  if (typeof window.maplibregl === 'undefined') {
    return screen('Map engine did not load',
      'MapLibre GL is loaded from <code>unpkg.com</code> (fallback <code>cdn.jsdelivr.net</code>) and neither answered. ' +
      'Check this device\'s internet connection, then retry.', [['Retry', () => location.reload(), true]]);
  }
  if (!hasWebGL()) {
    return screen('3D needs WebGL',
      'This browser has WebGL turned off or unavailable, so the vector map cannot render. ' +
      'Enable hardware acceleration in the browser settings and reload.', [['Retry', () => location.reload(), true]]);
  }
  startMap();
}

function startMap() {
  const { cfg } = state;
  const stored = safeJson(store.get('last', 'null'));
  const center = DEMO || !stored ? cfg.demo.from : stored;
  const map = new maplibregl.Map({
    container: 'map',
    style: buildStyle({ tiles: cfg.tiles, glyphs: cfg.glyphs }),
    center, zoom: 16.4, pitch: PITCH, bearing: 0, maxPitch: 80,
    attributionControl: { compact: true },
    canvasContextAttributes: { antialias: true },
  });
  state.map = map;
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');

  let lastMapError = 0;
  map.on('error', (e) => {
    console.warn('map error', e.error || e);
    if (Date.now() - lastMapError > 10000) { lastMapError = Date.now(); status('Map data hiccup: ' + (e.error?.message || 'tile request failed')); }
  });
  map.on('rotate', renderCompass);
  for (const ev of ['dragstart', 'rotatestart', 'pitchstart', 'zoomstart']) {
    map.on(ev, (e) => { if (e.originalEvent) setFollow(false); });
  }

  map.on('load', () => {
    map.addSource('route', { type: 'geojson', data: emptyLine() });
    for (const l of routeLayers('route')) map.addLayer(l);
    vehicle = new maplibregl.Marker({ element: vehicleEl(), rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat(center);
    state.mapLoaded = true;
    renderHud();
    if (DEMO) startDemo(); else startGps();
  });
}

// ---- Position pipeline -------------------------------------------------------------------------

const motion = createMotionEstimator();
let vehicle = null;
let vehicleShown = false;
let destMarker = null;
let camHeading = null;

function onFix(fix) {
  state.fixes++;
  const m = motion.update(fix);
  state.pos = fix;
  state.speed = m.speed;
  if (m.heading != null) state.heading = m.heading;
  state.source = DEMO ? 'sim' : m.source;
  if (!DEMO && state.fixes % 10 === 1) store.set('last', JSON.stringify([fix.lon, fix.lat]));
  if (vehicle) {
    vehicle.setLngLat([fix.lon, fix.lat]).setRotation(state.heading ?? 0);
    if (!vehicleShown) { vehicle.addTo(state.map); vehicleShown = true; }
  }
  if (state.route) updateProgress(fix);
  if (state.follow) followCam(fix, DEMO ? DEMO_TICK_MS * 1.1 : 1000);
  renderHud();
}

function followCam(fix, duration) {
  const map = state.map;
  const target = state.heading ?? map.getBearing();
  camHeading = camHeading == null ? target : lerpHeading(camHeading, target, 0.35);
  map.easeTo({
    center: [fix.lon, fix.lat], bearing: camHeading, pitch: state.pitched ? PITCH : 0,
    zoom: zoomForSpeed(state.speed), duration, easing: (t) => t,
    padding: { top: Math.round(map.getContainer().clientHeight * 0.38), bottom: 0, left: 0, right: 0 },
    essential: true,
  });
}

function setFollow(on) {
  state.follow = on;
  $('follow').classList.toggle('on', on);
  $('follow').title = on ? 'Following you' : 'Recenter';
  if (on && state.pos) followCam(state.pos, 600);
}

function startGps() {
  if (!('geolocation' in navigator)) {
    return status('This browser has no geolocation. <a href="?demo=1">Try the demo drive</a>.', { sticky: true, html: true });
  }
  if (!window.isSecureContext) {
    return status('GPS needs a secure page (HTTPS or localhost). <a href="?demo=1">Try the demo drive</a> or see the README.', { sticky: true, html: true });
  }
  status('Waiting for GPS…', { sticky: true });
  navigator.geolocation.watchPosition((p) => {
    if (state.fixes === 0) status('');
    onFix({ lat: p.coords.latitude, lon: p.coords.longitude, t: p.timestamp || Date.now(), speed: p.coords.speed, heading: p.coords.heading, accuracy: p.coords.accuracy });
  }, (err) => {
    if (err.code === 1) status('Location permission was denied. Allow it in the browser, or <a href="?demo=1">try the demo drive</a>.', { sticky: true, html: true });
    else if (err.code === 2) status('No GPS signal yet — keep the page open.', { sticky: true });
    // code 3 (timeout) just means no new fix yet; watchPosition keeps trying.
  }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
}

// ---- Route -------------------------------------------------------------------------------------

const emptyLine = () => ({ type: 'FeatureCollection', features: [] });

async function fetchRoute(from, to) {
  const r = await fetch(`api/route?from=${from.join(',')}&to=${to.join(',')}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'routing failed (HTTP ' + r.status + ')');
  return data;
}

function setRoute(route) {
  state.route = route;
  state.progress = null;
  state.offRoute = 0;
  state.map.getSource('route').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: route.geometry } });
  const end = route.geometry[route.geometry.length - 1];
  if (!destMarker) destMarker = new maplibregl.Marker({ element: destEl() });
  destMarker.setLngLat(end).addTo(state.map);
  $('turn').hidden = false;
  $('eta').hidden = false;
  if (state.pos) updateProgress(state.pos);
  renderHud();
}

function clearRoute() {
  state.route = null;
  state.dest = null;
  state.progress = null;
  state.map.getSource('route').setData(emptyLine());
  destMarker?.remove();
  $('turn').hidden = true;
  $('eta').hidden = true;
  $('q').value = '';
  if (DEMO) sim.stop();
}

function updateProgress(fix) {
  const pr = routeProgress(state.route, fix);
  state.progress = pr;
  if (DEMO) return;
  if (pr.arrived) {
    status('You have arrived' + (state.dest?.label ? ' at ' + state.dest.label : ''));
    return clearRoute();
  }
  state.offRoute = pr.offset > 50 ? state.offRoute + 1 : 0;
  if (state.offRoute >= 3 && state.dest && Date.now() - state.lastReroute > 20000) {
    state.lastReroute = Date.now();
    status('Off route — recalculating…');
    fetchRoute([fix.lon, fix.lat], [state.dest.lon, state.dest.lat]).then(setRoute).catch((e) => status(e.message));
  }
}

async function setDestination(d) {
  state.dest = d;
  $('q').value = d.label;
  hideSuggestions();
  $('q').blur();
  const from = state.pos ? [state.pos.lon, state.pos.lat] : (DEMO ? state.cfg.demo.from : state.map.getCenter().toArray());
  status('Plotting route to ' + d.label + '…', { sticky: true });
  try {
    const route = await fetchRoute(from, [d.lon, d.lat]);
    status('');
    setRoute(route);
    if (DEMO) sim.drive(route, { fromStart: true });
    else if (!state.pos) fitRoute(route);
  } catch (e) {
    status('No route: ' + e.message);
  }
}

function fitRoute(route) {
  const b = new maplibregl.LngLatBounds();
  for (const c of route.geometry) b.extend(c);
  state.map.fitBounds(b, { padding: 80, pitch: state.pitched ? 45 : 0, duration: 800 });
}

// ---- Demo vehicle ------------------------------------------------------------------------------

// Used only if the routing server can't be reached: a hand-drawn line up Andrássy út, Budapest.
const FALLBACK_ROUTE = {
  geometry: [[19.0548, 47.4979], [19.0566, 47.5005], [19.0581, 47.5022], [19.0629, 47.5052], [19.0663, 47.5072], [19.0703, 47.5098], [19.0742, 47.5124], [19.0777, 47.5149], [19.0838, 47.5155]],
  steps: [
    { type: 'depart', name: 'Bajcsy-Zsilinszky út', location: [19.0548, 47.4979], duration: 40 },
    { type: 'turn', modifier: 'right', name: 'Andrássy út', location: [19.0581, 47.5022], duration: 150 },
    { type: 'turn', modifier: 'right', name: 'Kós Károly sétány', location: [19.0777, 47.5149], duration: 40 },
    { type: 'arrive', name: '', location: [19.0838, 47.5155], duration: 0 },
  ],
};

function createSimulator(emit) {
  let route = null, cum = null, along = 0, v = 0, timer = null, last = 0, restart = null;
  function tick() {
    const now = performance.now();
    const dt = Math.min(0.5, (now - last) / 1000);
    last = now;
    const total = cum[cum.length - 1];
    const here = pointAlong(route.geometry, cum, along);
    const pr = routeProgress(route, here);
    // Cruise speed wanders between ~25 and ~80 km/h; brake for the next maneuver like a driver would.
    const cruise = kmhToMs(52 + 20 * Math.sin(along / 350) + 8 * Math.sin(along / 97));
    const turnV = kmhToMs(pr.nextStep?.type === 'arrive' ? 0 : 20);
    const brake = Math.sqrt(turnV * turnV + 2 * 1.6 * Math.max(0, pr.toNext - 10));
    const vt = Math.min(cruise, brake);
    v = Math.max(0, v + Math.max(-3.2 * dt, Math.min(2.4 * dt, vt - v)));
    along = Math.min(total, along + v * dt);
    const p = pointAlong(route.geometry, cum, along);
    const heading = along + 1 < total ? bearing(p, pointAlong(route.geometry, cum, along + 12)) : p.bearing;
    emit({ lat: p.lat, lon: p.lon, t: Date.now(), speed: v, heading, accuracy: 4 });
    if (along >= total - 0.5) {
      stop();
      status('Demo: arrived — looping the drive in 4 s');
      restart = setTimeout(() => drive(route, { fromStart: true }), 4000);
    }
  }
  function drive(r, { fromStart = false } = {}) {
    stop();
    route = r;
    cum = cumulativeDistances(r.geometry);
    if (fromStart) { along = 0; v = 0; }
    last = performance.now();
    timer = setInterval(tick, DEMO_TICK_MS);
    state.driving = true;
  }
  function stop() {
    clearInterval(timer);
    clearTimeout(restart);
    timer = null;
    state.driving = false;
  }
  return { drive, stop };
}

const sim = createSimulator(onFix);

async function startDemo() {
  const { from, to } = state.cfg.demo;
  status('Demo drive: plotting a route…', { sticky: true });
  let route;
  try {
    route = await fetchRoute(from, to);
    status('Demo drive — simulated vehicle, no GPS needed');
  } catch (e) {
    route = FALLBACK_ROUTE;
    status('Routing service unavailable (' + e.message + ') — using the built-in demo line');
  }
  state.dest = { label: 'Városliget (demo)', lon: to[0], lat: to[1] };
  $('q').value = state.dest.label;
  $('clear').hidden = false;
  setRoute(route);
  sim.drive(route, { fromStart: true });
}

// ---- HUD ---------------------------------------------------------------------------------------

const GAUGE_MAX_KMH = 160;

function renderHud() {
  const unit = state.unit;
  const val = state.speed == null ? null : Math.min(999, Math.round(speedIn(state.speed, unit)));
  const digits = val == null ? '---' : String(val).padStart(3, '0');
  const lead = val == null ? 0 : 3 - String(val).length;
  $('speed').innerHTML = `<span class="dim">${digits.slice(0, lead)}</span>${digits.slice(lead)}`;
  $('unit').textContent = unit === 'mph' ? 'MPH' : 'KM/H';
  $('speed-src').textContent = { gps: 'GPS', derived: 'CALC', sim: 'SIM' }[state.source] || 'NO FIX';
  const frac = state.speed == null ? 0 : Math.min(1, speedIn(state.speed, 'kmh') / GAUGE_MAX_KMH);
  $('gauge-arc').style.strokeDashoffset = String(75 * (1 - frac));

  const h = state.heading;
  $('hdg').textContent = h == null ? '— ---°' : `${cardinal(h)} ${String(Math.round(h) % 360).padStart(3, '0')}°`;
  renderCompass();

  const pr = state.progress;
  if (state.route && pr) {
    $('turn-arrow').textContent = maneuverArrow(pr.nextStep);
    $('turn-dist').textContent = formatDistance(pr.toNext, unit);
    $('turn-text').textContent = maneuverText(pr.nextStep);
    const then = state.route.steps[pr.nextIndex + 1];
    $('turn-then').textContent = then ? 'then ' + maneuverText(then).toLowerCase() : '';
    const arrive = new Date(Date.now() + pr.timeLeft * 1000);
    $('eta-time').textContent = arrive.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('eta-dist').textContent = formatDistance(pr.remaining, unit);
    $('eta-left').textContent = formatDuration(pr.timeLeft);
  }
}

function renderCompass() {
  if (!state.map) return;
  $('ring').style.transform = `rotate(${-state.map.getBearing()}deg)`;
}

function vehicleEl() {
  const el = document.createElement('div');
  el.className = 'vehicle';
  el.innerHTML = '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M20 3 L34 35 L20 27 L6 35 Z" /></svg>';
  return el;
}

function destEl() {
  const el = document.createElement('div');
  el.className = 'dest';
  el.innerHTML = '<span></span>';
  return el;
}

// ---- Search ------------------------------------------------------------------------------------

let searchAbort = null;
let searchTimer = null;
let results = [];
let active = -1;

function hideSuggestions() { $('suggest').hidden = true; }

function renderSuggestions() {
  const ul = $('suggest');
  ul.replaceChildren(...results.map((r, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.className = i === active ? 'active' : '';
    li.innerHTML = `<b>${escapeHtml(r.label)}</b><small>${escapeHtml(r.detail || '')}</small>`;
    li.onmousedown = (e) => { e.preventDefault(); setDestination(r); };
    return li;
  }));
  ul.hidden = results.length === 0;
}

async function runSearch(q) {
  searchAbort?.abort();
  searchAbort = new AbortController();
  const c = state.pos ? [state.pos.lon, state.pos.lat] : state.map?.getCenter().toArray();
  const near = c ? `&near=${c.map((n) => n.toFixed(5)).join(',')}` : '';
  try {
    const r = await fetch(`api/search?q=${encodeURIComponent(q)}${near}`, { signal: searchAbort.signal });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'search failed');
    results = data.results || [];
    active = results.length ? 0 : -1;
    renderSuggestions();
    if (!results.length) status('No places found for “' + q + '”');
  } catch (e) {
    if (e.name !== 'AbortError') status(e.message);
  }
}

function wireUi() {
  const q = $('q');
  q.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const v = q.value.trim();
    $('clear').hidden = !v;
    if (v.length < 3) { results = []; return hideSuggestions(); }
    searchTimer = setTimeout(() => runSearch(v), 400);
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!results.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      renderSuggestions();
    } else if (e.key === 'Escape') hideSuggestions();
  });
  q.addEventListener('blur', () => setTimeout(hideSuggestions, 150));
  $('search').addEventListener('submit', (e) => {
    e.preventDefault();
    if (results[active] && !$('suggest').hidden) setDestination(results[active]);
    else if (q.value.trim().length >= 2) runSearch(q.value.trim());
  });
  $('clear').onclick = () => { clearRoute(); $('clear').hidden = true; q.focus(); };
  $('end-route').onclick = () => { clearRoute(); $('clear').hidden = true; };
  $('unit').onclick = () => { state.unit = state.unit === 'kmh' ? 'mph' : 'kmh'; store.set('unit', state.unit); renderHud(); };
  $('follow').onclick = () => setFollow(true);
  $('pitch').onclick = () => {
    state.pitched = !state.pitched;
    $('pitch').textContent = state.pitched ? '3D' : '2D';
    state.map?.easeTo({ pitch: state.pitched ? PITCH : 0, duration: 500 });
  };
  $('compass').onclick = () => { if (!state.follow) state.map?.easeTo({ bearing: 0, duration: 500 }); };
  if (DEMO) document.body.classList.add('demo');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

wireUi();
renderHud();
boot();
