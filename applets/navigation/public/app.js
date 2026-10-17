// Navigation applet UI: MapLibre GL over free OpenStreetMap vector tiles, a JARVIS-style HUD (speed,
// heading, next turn, ETA), a follow-me 3D camera, destination search + routing through the applet
// server, traffic (streets shaded by congestion, little cars moving around you) and ?demo=1 which
// drives a simulated vehicle so it all works without GPS. Speed limits and speed cameras (speedwarn.js)
// put a round limit sign by the speedometer and a red/blue light when speeding towards a camera. Every
// drive is recorded as a trip (trips.js; ?record=0 turns that off, and the demo records only with
// ?record=1); the Trips panel (tripsui.js) lists, charts, replays and maps them.
import {
  bearing, cardinal, createMotionEstimator, formatDistance, formatDuration, kmhToMs, lerpHeading,
  maneuverArrow, maneuverText, msToKmh, pointAlong, projectOnLine, cumulativeDistances, routeProgress, speedIn, zoomForSpeed,
} from './geo.js';
import { buildStyle, routeLayers, trafficLayers } from './mapstyle.js';
import { cameraOnRoute, currentLimit, demoCamera, nearestCameraAhead, speedHud } from './speedwarn.js';
import { createTrafficSim, shadeFeatures } from './traffic.js';
import { installTripRecorder } from './trips.js';
import { createTripsUi } from './tripsui.js';

const MAPLIBRE_FALLBACK = 'https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.js';
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DEMO = params.has('demo') && params.get('demo') !== '0';
const RECORD = DEMO ? params.get('record') === '1' : params.get('record') !== '0';
const DEMO_TICK_MS = 200;
const DEMO_LIMIT_KMH = 50; // the demo's road limit where the real one isn't known (yet)
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
  traffic: { on: store.get('traffic', '1') !== '0', source: null, segments: 0, cars: 0, updated: null },
  trip: null, // trip recorder status: {recording, id, points, outbox, …} (trips.js)
  replay: null, // while a trip replays: {hud: {speed, heading, source, warn}} shown instead of the live values
  warn: null, // speed warning: speedHud() + {roadLimit, camera, cameraM} (the nearest camera ahead, counted or not)
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
  $('traffic').hidden = cfg.traffic?.source === 'off';
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');

  let lastMapError = 0;
  map.on('error', (e) => {
    console.warn('map error', e.error || e);
    if (Date.now() - lastMapError > 10000) { lastMapError = Date.now(); status('Map data hiccup: ' + (e.error?.message || 'tile request failed')); }
  });
  map.on('rotate', renderCompass);
  // Rotation and fullscreen can change the size without a resize MapLibre sees in time (iframes,
  // mobile toolbars collapsing), so resize again once the viewport settles.
  const settle = () => { map.resize(); setTimeout(() => { map.resize(); if (state.follow && state.pos) followCam(state.pos, 0); }, 350); };
  for (const ev of ['orientationchange', 'resize']) window.addEventListener(ev, settle);
  document.addEventListener('fullscreenchange', settle);
  window.visualViewport?.addEventListener('resize', settle);
  for (const ev of ['dragstart', 'rotatestart', 'pitchstart', 'zoomstart']) {
    map.on(ev, (e) => { if (e.originalEvent) setFollow(false); });
  }

  map.on('load', () => {
    const tl = trafficLayers('traffic', 'traffic-cars');
    map.addSource('traffic', { type: 'geojson', data: emptyLine(), attribution: cfg.traffic?.source === 'tomtom' ? 'Traffic © TomTom' : undefined });
    map.addSource('traffic-cars', { type: 'geojson', data: emptyLine() });
    map.addImage('nav-car', carIcon('#6dffb4', 'rgba(0, 255, 136, 0.9)'), { pixelRatio: 2 });
    map.addImage('nav-car-slow', carIcon('#e2d36a', 'rgba(230, 170, 40, 0.8)'), { pixelRatio: 2 });
    map.addLayer(tl.shade, 'building-3d');
    map.addSource('route', { type: 'geojson', data: emptyLine() });
    for (const l of routeLayers('route')) map.addLayer(l);
    map.addImage('nav-cam', cameraIcon('#00ff88', 'rgba(0, 255, 136, 0.7)'), { pixelRatio: 2 });
    map.addImage('nav-cam-hot', cameraIcon('#ff3b5c', 'rgba(255, 59, 92, 0.9)'), { pixelRatio: 2 });
    map.addSource('speedcams', { type: 'geojson', data: emptyLine() });
    map.addLayer(cameraLayer('speedcams'));
    map.addLayer(tl.cars);
    for (const id of ['traffic-shade', 'traffic-cars']) map.setLayoutProperty(id, 'visibility', state.traffic.on ? 'visible' : 'none');
    map.on('moveend', () => {
      // The follow camera eases every tick, so this is a trailing timer rather than a resetting one.
      if (!trafficTimer) trafficTimer = setTimeout(() => { trafficTimer = null; refreshTraffic(); refreshAreaCameras(); }, 500);
    });
    vehicle = new maplibregl.Marker({ element: vehicleEl(), rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat(center);
    state.mapLoaded = true;
    tripsUi = createTripsUi({ state, map, renderHud, setFollow, status, pitch: PITCH, escapeHtml });
    tripsUi.onTrip(state.trip);
    renderHud();
    if (DEMO) startDemo(); else startGps();
    refreshTraffic();
    refreshAreaCameras();
  });
}

// ---- Position pipeline -------------------------------------------------------------------------

const motion = createMotionEstimator();
let tripsUi = null;
const recorder = RECORD ? installTripRecorder({ source: DEMO ? 'sim' : 'gps', onChange: (s) => { state.trip = s; tripsUi?.onTrip(s); } }) : null;
if (recorder) state.trip = recorder.status();
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
  updateWarning();
  // The trip keeps what the warning saw, so its replay shows the same sign, chip and light.
  const w = state.warn;
  recorder?.addFix({ ...fix, lim: w.roadLimit, camD: w.cameraM, camLim: w.camera?.maxspeed });
  if (state.replay) return; // the replay owns the camera and the HUD; recording and the live marker carry on
  if (state.follow) followCam(fix, DEMO ? DEMO_TICK_MS * 1.1 : 1000);
  renderHud();
}

function followCam(fix, duration) {
  const map = state.map;
  const target = state.heading ?? map.getBearing();
  camHeading = camHeading == null ? target : lerpHeading(camHeading, target, 0.35);
  const h = map.getContainer().clientHeight;
  const sheet = sheetInset();
  map.easeTo({
    center: [fix.lon, fix.lat], bearing: camHeading, pitch: state.pitched ? PITCH : 0,
    zoom: zoomForSpeed(state.speed), duration, easing: (t) => t,
    padding: { top: Math.round(h * (sheet ? 0.12 : 0.38)), bottom: sheet, left: 0, right: 0 },
    essential: true,
  });
}

/** On phones the trips sheet covers the lower half: how much, so the followed car stays above it. */
function sheetInset() {
  const el = $('trips');
  if (el.hidden || !window.matchMedia('(max-width: 640px)').matches) return 0;
  return Math.max(0, Math.round(window.innerHeight - el.getBoundingClientRect().top));
}

function setFollow(on) {
  state.follow = on;
  $('follow').classList.toggle('on', on);
  $('follow').title = on ? 'Following you' : 'Recenter';
  if (on && state.pos) followCam(state.pos, 600);
}

// Mobile Chrome may skip the location prompt unless a tap asked for it (and always does once it was
// dismissed), so unless permission is already granted, GPS starts from an "Enable GPS" button.
async function startGps() {
  if (!('geolocation' in navigator)) {
    return status('This browser has no geolocation. <a href="?demo=1">Try the demo drive</a>.', { sticky: true, html: true });
  }
  if (!window.isSecureContext) {
    return status('GPS needs a secure page (HTTPS or localhost). <a href="?demo=1">Try the demo drive</a> or see the README.', { sticky: true, html: true });
  }
  const perm = await navigator.permissions?.query({ name: 'geolocation' }).then((p) => p.state, () => null);
  if (perm === 'granted') return watchGps();
  if (perm === 'denied') return gpsDenied();
  status('<button id="gps-go" type="button" class="btn primary">Enable GPS</button> or <a href="?demo=1">try the demo drive</a>', { sticky: true, html: true });
  $('gps-go').addEventListener('click', watchGps, { once: true });
}

function gpsDenied() {
  status('Location is blocked for this site. Tap the lock icon in the address bar → Permissions → Location → Allow, then reload. Or <a href="?demo=1">try the demo drive</a>.', { sticky: true, html: true });
}

function watchGps() {
  status('Waiting for GPS…', { sticky: true });
  navigator.geolocation.watchPosition((p) => {
    if (state.fixes === 0) status('');
    onFix({ lat: p.coords.latitude, lon: p.coords.longitude, t: p.timestamp || Date.now(), speed: p.coords.speed, heading: p.coords.heading, accuracy: p.coords.accuracy, alt: p.coords.altitude });
  }, (err) => {
    if (err.code === 1) gpsDenied();
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
  loadRouteSpeed(route);
  renderHud();
  refreshTraffic(); // the route changes the assumed traffic along it
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
  clearRouteSpeed();
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
  let route = null, cum = null, along = 0, v = 0, timer = null, last = 0, restart = null, hold = null;
  function tick() {
    const now = performance.now();
    const dt = Math.min(0.5, (now - last) / 1000);
    last = now;
    const total = cum[cum.length - 1];
    const here = pointAlong(route.geometry, cum, along);
    const pr = routeProgress(route, here);
    const ahead = along + 1 < total ? bearing(here, pointAlong(route.geometry, cum, along + 12)) : here.bearing;
    const vt = hold && now < hold.until ? kmhToMs(hold.kmh) : demoTarget(pr, here, ahead);
    if (hold && now < hold.until) v = vt; // a held speed (screenshots) applies at once
    else v = Math.max(0, v + Math.max(-3.2 * dt, Math.min(2.4 * dt, vt - v)));
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
  // The demo driver (m/s): wanders from ~15 km/h under the limit to ~15 over it; with a camera ahead
  // keeps going too fast until ~130 m before it (the light comes on), then brakes under its limit
  // (the light goes out); brakes for the next maneuver like a driver would.
  function demoTarget(pr, here, heading) {
    const limit = roadLimit(pr) ?? DEMO_LIMIT_KMH;
    let kmh = limit - 2 + 13 * Math.sin(along / 300) + 4 * Math.sin(along / 97);
    const cam = nearestCameraAhead(here, heading, activeCameras());
    if (cam) {
      const camLimit = cam.camera.maxspeed ?? limit;
      kmh = cam.distanceM > 130 ? camLimit + 14 : camLimit - 6;
    }
    const turnV = kmhToMs(pr.nextStep?.type === 'arrive' ? 0 : 20);
    const brake = Math.sqrt(turnV * turnV + 2 * 1.6 * Math.max(0, pr.toNext - 10));
    return Math.min(kmhToMs(Math.max(15, kmh)), brake);
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
  /** Jump to `m` metres along the route (the follow camera catches up). */
  function seek(m) {
    if (!route) return;
    along = Math.max(0, Math.min(cum[cum.length - 1] - 1, m));
    if (!timer) drive(route);
  }
  /** Drive at exactly `kmh` for `ms`, then let the demo driver take over again. */
  function setHold(kmh, ms = 8000) { hold = { kmh, until: performance.now() + ms }; }
  return { drive, stop, seek, hold: setHold, at: () => ({ route, cum, along }) };
}

const sim = createSimulator(onFix);

// For screenshots and trying the HUD: put the demo car where it shows one warning state.
// __nav.demo.scenario('none' | 'speeding' | 'camera-near' | 'camera-speeding') → true when it could.
if (DEMO) state.demo = { seek: sim.seek, hold: sim.hold, scenario: demoScenario };

function demoScenario(name) {
  const { route, cum } = sim.at();
  if (!route) return false;
  const total = cum[cum.length - 1];
  const cams = activeCameras().map((c) => ({ c, along: projectOnLine(route.geometry, cum, c).along }));
  const limitAt = (m) => roadLimit({ index: pointAlong(route.geometry, cum, m).index }) ?? DEMO_LIMIT_KMH;
  if (name === 'camera-near' || name === 'camera-speeding') {
    const cam = cams.find((x) => x.along > 450 && cameraOnRoute(route, x.c)) || cams.find((x) => x.along > 450);
    if (!cam) return false;
    const camLimit = cam.c.maxspeed ?? limitAt(cam.along);
    sim.seek(cam.along - (name === 'camera-speeding' ? 380 : 260));
    sim.hold(name === 'camera-speeding' ? camLimit + 15 : camLimit - 8);
    return true;
  }
  // Somewhere with no camera within 900 m ahead, clear of the route's ends.
  const spot = [150, 400, 800, 1200, 1600, 2000].map((m) => Math.min(m, total - 200))
    .find((m) => m > 0 && !cams.some((x) => x.along > m - 20 && x.along - m < 900));
  if (spot == null) return false;
  sim.seek(spot);
  sim.hold(name === 'speeding' ? limitAt(spot) + 15 : limitAt(spot) - 8);
  return true;
}

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

// ---- Traffic -----------------------------------------------------------------------------------

// Streets shaded by congestion and car silhouettes around the vehicle, from api/traffic (TomTom flow
// or the server's assumed-traffic model). One GeoJSON source for all cars, updated from one
// requestAnimationFrame loop at up to 30 Hz; nothing runs while the tab is hidden or traffic is off.
const TRAFFIC_RADIUS_M = 900;   // cars and shading this far round the vehicle
const TRAFFIC_GRID = 0.005;     // bbox snapped outward to this grid (°), so small moves reuse the last answer
const TRAFFIC_POLL_MS = 60000;
const TRAFFIC_FRAME_MS = 33;
const carSim = createTrafficSim({ maxCars: window.matchMedia('(max-width: 640px)').matches ? 160 : 260 });
let trafficTimer = null;
let trafficKey = '';
let trafficAt = 0;
let trafficAbort = null;
let carRaf = 0;
let carLast = 0;

const trafficEnabled = () => state.traffic.on && state.mapLoaded && state.cfg.traffic?.source !== 'off';

function trafficArea() {
  const c = state.pos ? [state.pos.lon, state.pos.lat] : state.map.getCenter().toArray();
  const dLat = TRAFFIC_RADIUS_M / 110540;
  const dLon = TRAFFIC_RADIUS_M / (111320 * Math.cos((c[1] * Math.PI) / 180));
  const snap = (v, round) => (round(v / TRAFFIC_GRID) * TRAFFIC_GRID).toFixed(3);
  const zoom = state.map.getZoom();
  return {
    center: c,
    bbox: [snap(c[0] - dLon, Math.floor), snap(c[1] - dLat, Math.floor), snap(c[0] + dLon, Math.ceil), snap(c[1] + dLat, Math.ceil)].join(','),
    z: zoom < 13 ? 12 : zoom < 15 ? 14 : 16, // only the class filter changes between these
  };
}

/** Fetch traffic for the area round the vehicle when it changed or the last answer is a minute old. */
async function refreshTraffic() {
  if (!trafficEnabled() || document.hidden) return;
  const a = trafficArea();
  const routeId = state.route?.routeId || '';
  const key = `${a.bbox}|${a.z}|${routeId}`;
  if (key === trafficKey && Date.now() - trafficAt < TRAFFIC_POLL_MS) return;
  trafficKey = key;
  trafficAt = Date.now();
  trafficAbort?.abort();
  trafficAbort = new AbortController();
  const q = new URLSearchParams({ bbox: a.bbox, z: String(a.z) });
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz) q.set('tz', tz);
  if (routeId) q.set('route', routeId);
  if (DEMO) q.set('at', demoRushHour());
  try {
    const r = await fetch('api/traffic?' + q, { signal: trafficAbort.signal });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
    if (!state.traffic.on) return;
    state.map.getSource('traffic').setData(shadeFeatures(data.segments));
    carSim.setData(data.segments, a.center);
    Object.assign(state.traffic, { source: data.source, segments: data.segments.length, cars: carSim.cars.length, updated: data.updated });
    $('traffic').title = data.source === 'tomtom' ? 'Traffic: live (TomTom)' : data.source === 'synthetic' ? 'Traffic: assumed from road type and time of day' : 'Traffic: no data here';
    startCars();
  } catch (e) {
    // No error screen for traffic: keep what is drawn and try again in 10 s.
    if (e.name !== 'AbortError') { trafficAt = Date.now() - TRAFFIC_POLL_MS + 10000; console.warn('traffic:', e.message); }
  }
}

/** The demo shows weekday evening rush hour (17:30 local, the latest weekday) so the effect is always visible. */
function demoRushHour() {
  const d = new Date();
  d.setHours(17, 30, 0, 0);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d.toISOString();
}

function carFrame(t) {
  carRaf = 0;
  if (!trafficEnabled() || document.hidden) return;
  if (!carLast || t - carLast >= TRAFFIC_FRAME_MS) {
    carSim.step(carLast ? Math.min(0.25, (t - carLast) / 1000) : 0);
    carLast = t;
    // Below the car layer's minzoom the cars still move, but nothing is drawn, so skip the upload.
    if (state.map.getZoom() >= 13) state.map.getSource('traffic-cars').setData(carSim.features());
  }
  carRaf = requestAnimationFrame(carFrame);
}

function startCars() {
  if (carRaf || !trafficEnabled() || document.hidden) return;
  carLast = 0;
  carRaf = requestAnimationFrame(carFrame);
}

function setTraffic(on) {
  state.traffic.on = on;
  store.set('traffic', on ? '1' : '0');
  $('traffic').classList.toggle('on', on);
  $('traffic').setAttribute('aria-pressed', String(on));
  if (!state.mapLoaded) return;
  for (const id of ['traffic-shade', 'traffic-cars']) state.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  if (on) { trafficKey = ''; refreshTraffic(); startCars(); }
  else { cancelAnimationFrame(carRaf); carRaf = 0; trafficAbort?.abort(); }
}

/** A top-down car silhouette (pointing north) with a soft glow, for map.addImage at pixelRatio 2. */
function carIcon(body, glow) {
  const r = 2, w = 22, h = 40;
  const c = document.createElement('canvas');
  c.width = w * r; c.height = h * r;
  const g = c.getContext('2d');
  g.scale(r, r);
  const rr = (x, y, rw, rh, rad) => { g.beginPath(); g.roundRect(x, y, rw, rh, rad); g.fill(); };
  g.shadowColor = glow; g.shadowBlur = 6;
  g.fillStyle = body;
  rr(5, 4, 12, 32, 4);
  g.shadowBlur = 0;
  g.fillStyle = 'rgba(1, 4, 3, 0.85)';
  rr(7, 11, 8, 5, 1.5);  // windscreen
  rr(7.5, 27, 7, 3.5, 1.2); // rear window
  return { width: c.width, height: c.height, data: g.getImageData(0, 0, c.width, c.height).data };
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { cancelAnimationFrame(carRaf); carRaf = 0; return; }
  refreshTraffic();
  startCars();
});
setInterval(refreshTraffic, 15000); // cheap: it only fetches when the answer is a minute old

// ---- Speed limits and cameras ------------------------------------------------------------------

// With a route: its road limits (api/route, else api/route/limits) and the cameras along it
// (api/speedcams?route=), fetched once per route. Without one: the cameras round the vehicle or the
// map centre (api/speedcams?bbox=), throttled. The demo adds a made-up camera on its route when no
// real one enforces it. Every fix then gets a warning state (speedwarn.js) the HUD shows.
const CAM_AREA_DEG = 0.06;      // bbox lookups reach this far from the vehicle/map centre (°), within the view
const CAM_GRID = 0.02;          // …snapped outward to this grid, so small moves reuse the last answer
const CAM_MIN_ZOOM = 11;        // zoomed further out, no lookups
const CAM_AREA_POLL_MS = 120000;
const CAM_AREA_MIN_MS = 10000;  // at most one bbox lookup this often
const CAM_RETRY_MS = 60000;     // Overpass busy or down: try a route's data again after this, twice
const cams = { routeId: null, limits: null, route: [], area: [], demo: null, areaKey: '', areaAt: 0, retry: null, shown: '' };

async function getJson(url) {
  try {
    const r = await fetch(url);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

const roadLimit = (pr) => currentLimit(pr, cams.limits);

function activeCameras() {
  if (!state.route) return cams.area;
  return cams.demo ? [...cams.route, cams.demo] : cams.route;
}

function loadRouteSpeed(route) {
  clearTimeout(cams.retry);
  cams.routeId = route.routeId || null;
  cams.limits = Array.isArray(route.limits) ? route.limits : null;
  cams.route = [];
  seedDemoCamera();
  if (cams.routeId) fetchRouteSpeed(route, 0); // the built-in fallback line has no server-side route
}

async function fetchRouteSpeed(route, attempt) {
  const id = route.routeId;
  const [lim, cam] = await Promise.all([
    cams.limits ? null : getJson(`api/route/limits?route=${encodeURIComponent(id)}`),
    getJson(`api/speedcams?route=${encodeURIComponent(id)}`),
  ]);
  if (cams.routeId !== id) return; // re-routed meanwhile
  if (Array.isArray(lim?.limits)) cams.limits = lim.limits;
  if (Array.isArray(cam?.cameras)) cams.route = cam.cameras;
  seedDemoCamera();
  if (attempt < 2 && (!cams.limits || cam?.status !== 'ok')) cams.retry = setTimeout(() => fetchRouteSpeed(route, attempt + 1), CAM_RETRY_MS);
}

function clearRouteSpeed() {
  clearTimeout(cams.retry);
  Object.assign(cams, { routeId: null, limits: null, route: [], demo: null, areaKey: '' });
  updateWarning();
  renderHud();
  refreshAreaCameras();
}

/** The demo's own camera, unless a real one on the route enforces its direction. */
function seedDemoCamera() {
  cams.shown = ''; // the list (or the demo camera's limit) may have changed
  cams.demo = DEMO && state.route && !cams.route.some((c) => cameraOnRoute(state.route, c)) ? demoCamera(state.route, cams.limits, { fallbackKmh: DEMO_LIMIT_KMH }) : null;
  updateWarning();
  renderCameras();
}

/** Cameras round the vehicle (or the map centre) while there is no route. */
async function refreshAreaCameras() {
  if (!state.mapLoaded || state.route || document.hidden || state.map.getZoom() < CAM_MIN_ZOOM) return;
  const c = state.pos ? [state.pos.lon, state.pos.lat] : state.map.getCenter().toArray();
  const b = state.map.getBounds();
  const snap = (v, round) => Number((round(v / CAM_GRID) * CAM_GRID).toFixed(3));
  const bbox = [
    snap(Math.max(b.getWest(), c[0] - CAM_AREA_DEG), Math.floor), snap(Math.max(b.getSouth(), c[1] - CAM_AREA_DEG), Math.floor),
    snap(Math.min(b.getEast(), c[0] + CAM_AREA_DEG), Math.ceil), snap(Math.min(b.getNorth(), c[1] + CAM_AREA_DEG), Math.ceil),
  ].join(',');
  const since = Date.now() - cams.areaAt;
  if ((bbox === cams.areaKey && since < CAM_AREA_POLL_MS) || since < CAM_AREA_MIN_MS) return;
  cams.areaKey = bbox;
  cams.areaAt = Date.now();
  const data = await getJson('api/speedcams?bbox=' + bbox);
  if (state.route || cams.areaKey !== bbox) return;
  if (Array.isArray(data?.cameras)) { cams.area = data.cameras; cams.shown = ''; }
  if (data?.status !== 'ok') cams.areaAt = Date.now() - CAM_AREA_POLL_MS + CAM_RETRY_MS; // ask again in a minute
  updateWarning();
  renderCameras();
}
setInterval(refreshAreaCameras, 15000); // cheap: it only fetches when the view moved on or the answer is old

/** The warning for the current position, speed and heading: state.warn (see its comment). */
function updateWarning() {
  const pos = state.pos;
  const road = state.route ? roadLimit(state.progress) ?? (DEMO ? DEMO_LIMIT_KMH : null) : null;
  const hit = pos ? nearestCameraAhead(pos, state.heading, activeCameras()) : null;
  const speedKmh = state.speed == null ? null : msToKmh(state.speed);
  state.warn = { ...speedHud({ speedKmh, limitKmh: road, camera: hit?.camera, distanceM: hit?.distanceM }), roadLimit: road, camera: hit?.camera ?? null, cameraM: hit?.distanceM ?? null };
  renderCameras();
}

/** Camera markers; the one that counts right now turns red. Only re-uploaded when that changes. */
function renderCameras() {
  if (!state.mapLoaded) return;
  const list = activeCameras();
  const hot = state.warn?.distanceM != null ? state.warn.camera : null;
  const key = `${list.length}:${list[0]?.id}:${list[list.length - 1]?.id}:${hot?.id ?? ''}`;
  if (key === cams.shown) return;
  cams.shown = key;
  state.map.getSource('speedcams').setData({
    type: 'FeatureCollection',
    features: list.map((c) => ({
      type: 'Feature',
      properties: { id: c.id, hot: c === hot, ...(Number.isFinite(c.maxspeed) ? { limit: c.maxspeed } : {}) },
      geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
    })),
  });
}

function cameraLayer(source) {
  return {
    id: source, type: 'symbol', source, minzoom: 11,
    layout: {
      'icon-image': ['case', ['get', 'hot'], 'nav-cam-hot', 'nav-cam'],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.55, 16, 1],
      'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-pitch-alignment': 'viewport',
      'text-field': ['to-string', ['coalesce', ['get', 'limit'], '']],
      'text-font': ['Noto Sans Bold'], 'text-size': 10, 'text-offset': [0, 1.6], 'text-optional': true, 'text-allow-overlap': true,
    },
    paint: { 'text-color': '#eafff4', 'text-halo-color': '#010403', 'text-halo-width': 1.5 },
  };
}

/** A small speed-camera badge (dark box, glowing outline, camera glyph) for map.addImage at pixelRatio 2. */
function cameraIcon(color, glow) {
  const r = 2, w = 30, h = 30;
  const c = document.createElement('canvas');
  c.width = w * r; c.height = h * r;
  const g = c.getContext('2d');
  g.scale(r, r);
  g.shadowColor = glow; g.shadowBlur = 6;
  g.fillStyle = 'rgba(2, 14, 9, 0.92)';
  g.strokeStyle = color; g.lineWidth = 1.6;
  g.beginPath(); g.roundRect(4, 4, 22, 22, 5); g.fill(); g.stroke();
  g.shadowBlur = 0;
  g.fillStyle = color;
  g.beginPath(); g.roundRect(8, 11, 14, 10, 2); g.fill();  // body
  g.fillRect(11, 9, 5, 2.5);                               // top
  g.fillStyle = 'rgba(2, 14, 9, 1)';
  g.beginPath(); g.arc(15, 16, 3.2, 0, Math.PI * 2); g.fill(); // lens
  g.fillStyle = color;
  g.beginPath(); g.arc(15, 16, 1.6, 0, Math.PI * 2); g.fill();
  return { width: c.width, height: c.height, data: g.getImageData(0, 0, c.width, c.height).data };
}

// ---- HUD ---------------------------------------------------------------------------------------

const GAUGE_MAX_KMH = 160;

function renderHud() {
  const unit = state.unit;
  const live = state.replay?.hud || state;
  const val = live.speed == null ? null : Math.min(999, Math.round(speedIn(live.speed, unit)));
  const digits = val == null ? '---' : String(val).padStart(3, '0');
  const lead = val == null ? 0 : 3 - String(val).length;
  $('speed').innerHTML = `<span class="dim">${digits.slice(0, lead)}</span>${digits.slice(lead)}`;
  $('unit').textContent = unit === 'mph' ? 'MPH' : 'KM/H';
  $('speed-src').textContent = { gps: 'GPS', derived: 'CALC', sim: 'SIM', replay: 'REPLAY' }[live.source] || 'NO FIX';
  const frac = live.speed == null ? 0 : Math.min(1, speedIn(live.speed, 'kmh') / GAUGE_MAX_KMH);
  $('gauge-arc').style.strokeDashoffset = String(75 * (1 - frac));

  renderWarn(live.warn, unit);

  const h = live.heading;
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

const WARN_SAY = {
  'speeding': 'Over the speed limit',
  'camera-near': 'Speed camera ahead',
  'camera-speeding': 'Speed camera ahead. Slow down',
};
let warnSaid = 'none';

/** The limit sign, the camera chip and the red/blue light for a speedHud() result (live or replayed). */
function renderWarn(w, unit) {
  const st = w?.state || 'none';
  const lim = w?.limit ?? null;
  const limText = lim == null ? '' : String(Math.round(unit === 'mph' ? lim / 1.609344 : lim));
  const unitText = unit === 'mph' ? 'mph' : 'km/h';
  $('limit').hidden = lim == null;
  $('limit-val').textContent = limText;
  $('limit').classList.toggle('wide', limText.length > 2);
  $('limit').setAttribute('aria-label', lim == null ? 'No speed limit known' : `Speed limit ${limText} ${unitText}`);
  document.body.dataset.warn = st;
  const atCamera = st === 'camera-near' || st === 'camera-speeding';
  $('cam').hidden = !atCamera;
  if (atCamera) {
    $('cam-dist').textContent = formatDistance(w.distanceM, unit);
    $('cam-text').textContent = st === 'camera-near' ? 'Speed camera' : lim == null ? 'Slow down' : `Slow down · ${limText}`;
  }
  $('police').hidden = st !== 'camera-speeding';
  if (st !== warnSaid) { // screen readers hear the state change, not every distance tick
    warnSaid = st;
    $('warn-say').textContent = WARN_SAY[st] ? WARN_SAY[st] + (lim == null ? '' : `, limit ${limText} ${unitText}`) : '';
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
  $('unit').onclick = () => { state.unit = state.unit === 'kmh' ? 'mph' : 'kmh'; store.set('unit', state.unit); renderHud(); tripsUi?.rerender(); };
  $('follow').onclick = () => setFollow(true);
  $('pitch').onclick = () => {
    state.pitched = !state.pitched;
    $('pitch').textContent = state.pitched ? '3D' : '2D';
    state.map?.easeTo({ pitch: state.pitched ? PITCH : 0, duration: 500 });
  };
  $('compass').onclick = () => { if (!state.follow) state.map?.easeTo({ bearing: 0, duration: 500 }); };
  $('traffic').onclick = () => setTraffic(!state.traffic.on);
  $('traffic').classList.toggle('on', state.traffic.on);
  $('traffic').setAttribute('aria-pressed', String(state.traffic.on));
  if (DEMO) document.body.classList.add('demo');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

wireUi();
renderHud();
boot();
