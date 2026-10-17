// The trips panel: history (newest first), one trip in detail (route coloured by speed, stat tiles,
// speed chart, delete), replay along the recorded track by its real timestamps, and every trip on the
// map at once with the totals. A side panel on wide screens, a bottom sheet on phones. Live navigation
// and the trip recorder keep running underneath all of it; leaving a view or the replay hands the
// camera and the HUD back to live navigation.
import { lerpHeading, zoomForSpeed } from './geo.js';
import { speedHud } from './speedwarn.js';
import { speedProfile } from './tripstats.js';
import * as V from './tripsview.js';

const $ = (id) => document.getElementById(id);
const EMPTY = { type: 'FeatureCollection', features: [] };
const RATES = [1, 4, 16, 64];
const GEOCODE_PER_PASS = 30;
const phone = () => window.matchMedia('(max-width: 640px)').matches;
const widthZ = (lo, hi) => ['interpolate', ['exponential', 1.6], ['zoom'], 10, lo, 18, hi];

async function api(path, opts) {
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
  return data;
}

/**
 * @param {{state: object, map: object, renderHud: () => void, setFollow: (on: boolean) => void,
 *   status: (text: string) => void, pitch: number, escapeHtml: (s: string) => string}} app
 */
export function createTripsUi({ state, map, renderHud, setFollow, status, pitch, escapeHtml: esc }) {
  const ui = {
    view: null,       // 'list' | 'detail' | 'all' | null (closed)
    trips: null,      // summaries from api/trips, newest first
    detail: null,     // {id, trip, profile, track}
    all: null,        // {tracks, totals, summaries, colors: Map id → colour}
    range: 'all', mode: 'trips', selected: null, hover: null,
    replay: null, rate: 16,
    geocoding: false, geoOff: false, geoTried: new Set(),
    wasRecording: false,
  };
  let layersReady = false;
  let replayMarker = null;

  // ---- Map layers ------------------------------------------------------------------------------

  function ensureLayers() {
    if (layersReady) return;
    layersReady = true;
    const before = map.getLayer('traffic-cars') ? 'traffic-cars' : undefined;
    const round = { 'line-cap': 'round', 'line-join': 'round' };
    for (const id of ['trip-detail', 'trip-ends', 'trips-all', 'trips-speed', 'trips-heat']) map.addSource(id, { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: 'trips-heat', type: 'heatmap', source: 'trips-heat',
      paint: {
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 9, 5, 16, 22],
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 16, 1.3],
        'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', 0.12, 'rgba(0,90,50,0.5)', 0.4, '#00c46a', 0.7, '#00ff88', 1, '#eafff4'],
        'heatmap-opacity': 0.85,
      },
    }, before);
    // Town speeds are the same neon green as the roads: a dark casing keeps the tracks readable over them.
    map.addLayer({ id: 'trips-speed-case', type: 'line', source: 'trips-speed', layout: round, paint: { 'line-color': '#010403', 'line-width': widthZ(5, 10), 'line-opacity': 0.85 } }, before);
    map.addLayer({ id: 'trips-speed-line', type: 'line', source: 'trips-speed', layout: round, paint: { 'line-color': V.speedColorExpr(), 'line-width': widthZ(2.5, 6), 'line-opacity': 0.95 } }, before);
    map.addLayer({ id: 'trips-all-glow', type: 'line', source: 'trips-all', layout: round, paint: { 'line-color': ['get', 'color'], 'line-width': widthZ(8, 22), 'line-blur': widthZ(5, 12), 'line-opacity': 0 } }, before);
    map.addLayer({ id: 'trips-all-line', type: 'line', source: 'trips-all', layout: round, paint: { 'line-color': ['get', 'color'], 'line-width': widthZ(2.5, 6), 'line-opacity': 0.95 } }, before);
    // Invisible wide stroke: what hover and tap hit, so a 3 px line is easy to pick with a finger.
    map.addLayer({ id: 'trips-all-hit', type: 'line', source: 'trips-all', layout: round, paint: { 'line-color': '#000', 'line-width': 22, 'line-opacity': 0.01 } }, before);
    map.addLayer({ id: 'trip-detail-case', type: 'line', source: 'trip-detail', layout: round, paint: { 'line-color': '#010403', 'line-width': widthZ(6, 12), 'line-opacity': 0.8 } }, before);
    map.addLayer({ id: 'trip-detail-glow', type: 'line', source: 'trip-detail', layout: round, paint: { 'line-color': V.speedColorExpr(), 'line-width': widthZ(8, 22), 'line-blur': widthZ(5, 12), 'line-opacity': 0.4 } }, before);
    map.addLayer({ id: 'trip-detail-line', type: 'line', source: 'trip-detail', layout: round, paint: { 'line-color': V.speedColorExpr(), 'line-width': widthZ(3, 7), 'line-opacity': 0.95 } }, before);
    map.addLayer({
      id: 'trip-ends', type: 'circle', source: 'trip-ends',
      paint: { 'circle-radius': 6, 'circle-color': ['match', ['get', 'end'], 'start', '#010403', '#00ff88'], 'circle-stroke-color': '#00ff88', 'circle-stroke-width': 2.5 },
    }, before);

    map.on('mousemove', 'trips-all-hit', (e) => {
      const id = e.features?.[0]?.properties?.id;
      map.getCanvas().style.cursor = 'pointer';
      if (ui.view === 'all' && id && id !== ui.hover) { ui.hover = id; highlight(); renderPick(); }
    });
    map.on('mouseleave', 'trips-all-hit', () => {
      map.getCanvas().style.cursor = '';
      if (ui.hover) { ui.hover = null; highlight(); renderPick(); }
    });
    map.on('click', 'trips-all-hit', (e) => {
      const id = e.features?.[0]?.properties?.id;
      if (ui.view === 'all' && id) select(id);
    });
  }

  const setData = (id, data) => map.getSource(id)?.setData(data);

  function clearMap() {
    if (!layersReady) return;
    for (const id of ['trip-detail', 'trip-ends', 'trips-all', 'trips-speed', 'trips-heat']) setData(id, EMPTY);
  }

  function showMode() {
    if (!layersReady) return;
    const vis = (id, on) => map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    vis('trips-all-line', ui.mode === 'trips');
    vis('trips-all-glow', ui.mode !== 'heat');
    vis('trips-speed-line', ui.mode === 'speed');
    vis('trips-speed-case', ui.mode === 'speed');
    vis('trips-heat', ui.mode === 'heat');
  }

  /** The picked (or hovered) trip stands out; the others fade back. */
  function highlight() {
    if (!layersReady) return;
    const sel = ui.hover || ui.selected;
    const is = ['==', ['get', 'id'], sel || ''];
    map.setPaintProperty('trips-all-line', 'line-width', sel ? ['interpolate', ['exponential', 1.6], ['zoom'], 10, ['case', is, 4.5, 2.5], 18, ['case', is, 10, 6]] : widthZ(2.5, 6));
    map.setPaintProperty('trips-all-line', 'line-opacity', sel ? ['case', is, 1, 0.4] : 0.95);
    map.setPaintProperty('trips-speed-line', 'line-opacity', sel ? ['case', is, 1, 0.3] : 0.95);
    map.setPaintProperty('trips-all-glow', 'line-opacity', sel ? ['case', is, 0.55, 0] : 0);
  }

  /** Map padding that keeps a fitted area clear of the panel (side panel, or bottom sheet on phones). */
  function padding() {
    const r = $('trips').getBoundingClientRect();
    if (phone()) return { top: 70, left: 28, right: 28, bottom: Math.max(40, innerHeight - r.top + 20) };
    // The speed gauge sits at the bottom left, beside the panel.
    return { top: 80, bottom: 210, left: (r.width ? r.right : 0) + 40, right: 90 };
  }

  function fit(coords) {
    if (!coords.length) return;
    const b = new maplibregl.LngLatBounds();
    for (const c of coords) b.extend(c);
    setFollow(false);
    // fitBounds adds the map's own padding (the follow camera leaves 38% at the top) to ours; drop it.
    // The follow camera and the replay pass their padding again when they take over.
    map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    map.fitBounds(b, { padding: padding(), pitch: 0, bearing: 0, duration: 700, maxZoom: 16 });
  }

  // ---- Panel ------------------------------------------------------------------------------------

  const body = () => $('trips-body');

  function open(view = 'list') {
    ensureLayers();
    $('trips').hidden = false;
    document.body.classList.add('trips-open');
    $('trips-btn').setAttribute('aria-expanded', 'true');
    return show(view);
  }

  /** Close the panel and give the map back to live navigation. */
  function close() {
    if (ui.replay) stopReplay();
    clearMap();
    ui.view = null;
    ui.detail = null;
    ui.selected = ui.hover = null;
    $('trips').hidden = true;
    $('trips').classList.remove('full');
    document.body.classList.remove('trips-open');
    $('trips-btn').setAttribute('aria-expanded', 'false');
    setFollow(true);
    if (!state.pos) map.easeTo({ pitch: state.pitched ? pitch : 0, duration: 500 });
    renderHud();
  }

  function show(view, arg) {
    ui.view = view;
    for (const b of $('trips-tabs').children) {
      const on = b.dataset.view === view || (view === 'detail' && b.dataset.view === 'list');
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    }
    $('trips-back').hidden = view !== 'detail';
    $('trips-title').textContent = view === 'detail' ? 'Trip' : 'Trips';
    clearMap();
    ui.selected = ui.hover = null;
    highlight();
    if (view === 'list') return showList();
    if (view === 'detail') return showDetail(arg);
    if (view === 'all') return showAll();
  }

  function loading(text = 'Loading…') { body().innerHTML = `<div class="empty">${esc(text)}</div>`; }

  function failed(e, retry) {
    body().innerHTML = `<div class="empty">Could not load trips: ${esc(e.message)}<br><button type="button" class="btn">Retry</button></div>`;
    body().querySelector('button').onclick = retry;
  }

  // ---- History ----------------------------------------------------------------------------------

  async function showList() {
    if (!ui.trips) loading();
    else renderList();
    try { ui.trips = (await api('api/trips')).trips || []; }
    catch (e) { if (ui.view === 'list') failed(e, () => show('list')); return; }
    if (ui.view !== 'list') return;
    renderList();
    geocodeMissing();
  }

  function statLine(s) {
    const u = state.unit;
    return `<span>${esc(V.fmtDistance(s.distance, u))}</span><span>${esc(V.fmtDuration(s.duration))}</span>` +
      `<span title="Average speed">⌀ ${esc(V.fmtSpeed(s.avgSpeed, u))}</span><span title="Top speed">▲ ${esc(V.fmtSpeed(s.maxSpeed, u))}</span>`;
  }

  function renderList() {
    const list = ui.trips || [];
    if (!list.length) {
      body().innerHTML = '<div class="empty"><b>No trips yet</b><br>Every drive is recorded while navigation is open (above 5 km/h), and shows up here when it ends.</div>';
      return;
    }
    const live = state.trip?.recording ? state.trip.id : null;
    body().innerHTML = `<ul class="trip-list">${list.map((s) => `
      <li><button type="button" class="trip-row" data-id="${esc(s.id)}">
        <span class="row-when">${esc(V.fmtWhen(s.startedAt))}${s.status !== 'done' ? (s.id === live ? ' <em class="tag rec-tag">● REC</em>' : ' <em class="tag">OPEN</em>') : ''}</span>
        <span class="row-route">${esc(V.tripRoute(s))}</span>
        <span class="row-stats">${statLine(s)}</span>
      </button></li>`).join('')}</ul>`;
    for (const b of body().querySelectorAll('.trip-row')) b.onclick = () => show('detail', b.dataset.id);
  }

  // Trip ends are named once through the applet's own search service and the names are stored with the
  // trip (PATCH), so each trip is looked up at most once. Coordinates stand in until then, or for good
  // when reverse geocoding is turned off.
  async function placeName(p) {
    try { return (await api(`api/reverse?lat=${p.lat}&lon=${p.lon}`)).place || null; }
    catch (e) { if (/turned off/.test(e.message)) ui.geoOff = true; return null; }
  }

  async function geocodeMissing() {
    if (ui.geocoding || ui.geoOff) return;
    ui.geocoding = true;
    let n = 0;
    try {
      for (const s of ui.trips || []) {
        if (ui.geoOff || n >= GEOCODE_PER_PASS) break;
        if (s.status !== 'done' || !s.start || !s.end || (s.places?.start && s.places?.end) || ui.geoTried.has(s.id)) continue;
        ui.geoTried.add(s.id);
        n++;
        const start = s.places?.start || await placeName(s.start);
        const end = s.places?.end || await placeName(s.end);
        if (!start && !end) continue;
        s.places = { start, end };
        api(`api/trips/${encodeURIComponent(s.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ places: s.places }) }).catch(() => {});
        const row = body().querySelector(`.trip-row[data-id="${CSS.escape(s.id)}"] .row-route`);
        if (row) row.textContent = V.tripRoute(s);
        if (ui.detail?.id === s.id) { ui.detail.trip.places = s.places; $('detail-route').textContent = V.tripRoute({ ...ui.detail.trip.stats, places: s.places }); }
      }
    } finally {
      ui.geocoding = false;
    }
  }

  // ---- One trip ---------------------------------------------------------------------------------

  async function showDetail(id) {
    loading();
    let trip;
    try { trip = await api(`api/trips/${encodeURIComponent(id)}`); }
    catch (e) { if (ui.view === 'detail') failed(e, () => show('detail', id)); return; }
    if (ui.view !== 'detail') return;
    const profile = speedProfile(trip.points);
    ui.detail = { id, trip, profile, track: V.replayTrack(profile) };
    const known = ui.trips?.find((s) => s.id === id);
    if (!trip.places && known?.places) trip.places = known.places;
    setData('trip-detail', V.speedSegments(profile));
    const st = trip.stats;
    setData('trip-ends', {
      type: 'FeatureCollection',
      features: st.start ? [
        { type: 'Feature', properties: { end: 'start' }, geometry: { type: 'Point', coordinates: [st.start.lon, st.start.lat] } },
        { type: 'Feature', properties: { end: 'end' }, geometry: { type: 'Point', coordinates: [st.end.lon, st.end.lat] } },
      ] : [],
    });
    renderDetail();
    fit(profile.map((p) => [p.lon, p.lat]));
  }

  function tile(label, value, sub = '') {
    return `<div class="tile"><small>${esc(label)}</small><b>${esc(value)}</b>${sub ? `<em>${esc(sub)}</em>` : ''}</div>`;
  }

  function legend() {
    const u = state.unit;
    const stops = V.SPEED_STOPS.map(([k, c]) => `${c} ${(k / 150) * 100}%`).join(', ');
    const label = (kmh) => Math.round(u === 'mph' ? kmh / 1.609344 : kmh);
    return `<div class="legend"><span>${label(0)}</span><i style="background:linear-gradient(90deg, ${stops})"></i><span>${label(150)}+ ${u === 'mph' ? 'mph' : 'km/h'}</span></div>`;
  }

  function renderDetail() {
    const d = ui.detail;
    if (!d) return;
    const { trip } = d;
    const s = trip.stats;
    const u = state.unit;
    const live = trip.status !== 'done';
    body().innerHTML = `
      <div class="detail-head">
        <div id="detail-route" class="detail-route">${esc(V.tripRoute({ ...s, places: trip.places }))}</div>
        <div class="detail-when">${esc(V.fmtWhen(s.startedAt))}${live ? ' · <em class="tag">STILL RECORDING</em>' : ''}</div>
      </div>
      <div class="tiles">
        ${tile('Distance', V.fmtDistance(s.distance, u))}
        ${tile('Duration', V.fmtDuration(s.duration))}
        ${tile('Moving', V.fmtDuration(s.movingTime))}
        ${tile('Avg speed', V.fmtSpeed(s.avgSpeed, u))}
        ${tile('Max speed', V.fmtSpeed(s.maxSpeed, u))}
        ${tile('Max accel', V.fmtAccel(s.maxAccel), V.fmtG(s.maxAccel))}
        ${tile('Max braking', V.fmtAccel(s.maxBrake), V.fmtG(s.maxBrake))}
        ${tile('Fixes', String(s.pointCount))}
      </div>
      <div class="chart-wrap">
        <div class="chart-head"><small>SPEED · ${state.unit === 'mph' ? 'MPH' : 'KM/H'}</small><span id="chart-read"></span></div>
        ${chartSvg(s.timeline)}
        <small class="chart-hint">Tap the chart to replay from there</small>
      </div>
      ${legend()}
      <div class="detail-actions">
        <button id="detail-replay" type="button" class="btn primary"${d.track.pts.length < 2 ? ' disabled' : ''}>▶ Replay</button>
        <button id="detail-delete" type="button" class="btn danger">Delete</button>
      </div>`;
    $('detail-replay').onclick = () => startReplay(0);
    $('detail-delete').onclick = () => confirmDelete(d.id, s);
    wireChart(s.timeline);
  }

  function chartSvg(timeline) {
    const m = V.chartModel(timeline, { w: 340, h: 132, unit: state.unit });
    const bottom = m.h - m.pad.b;
    const top = m.pad.t;
    const toUnit = (kmh) => (state.unit === 'mph' ? kmh / 1.609344 : kmh);
    const stops = V.SPEED_STOPS.map(([k, c]) => `<stop offset="${Math.min(1, toUnit(k) / m.max).toFixed(3)}" stop-color="${c}"/>`).join('');
    return `<svg id="chart" class="chart" viewBox="0 0 ${m.w} ${m.h}" role="img" aria-label="Speed over time, top ${esc(V.fmtSpeed(m.peak?.v, state.unit))}">
      <defs>
        <linearGradient id="chart-stroke" gradientUnits="userSpaceOnUse" x1="0" y1="${bottom}" x2="0" y2="${top}">${stops}</linearGradient>
        <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#00ff88" stop-opacity="0.28"/><stop offset="1" stop-color="#00ff88" stop-opacity="0"/></linearGradient>
      </defs>
      ${m.grid.map((g) => `<line class="grid" x1="${m.pad.l}" x2="${m.w - m.pad.r}" y1="${g.y}" y2="${g.y}"/><text class="axis" x="${m.pad.l - 4}" y="${g.y + 3}" text-anchor="end">${g.label}</text>`).join('')}
      <text class="axis" x="${m.pad.l}" y="${m.h - 3}">0:00</text>
      <text class="axis" x="${m.w - m.pad.r}" y="${m.h - 3}" text-anchor="end">${V.fmtClock(m.tMax)}</text>
      <path class="area" d="${m.area}" fill="url(#chart-fill)"/>
      <path class="line" d="${m.line}" stroke="url(#chart-stroke)"/>
      ${m.peak ? `<circle class="peak" cx="${m.peak.x}" cy="${m.peak.y}" r="3.5"/>` : ''}
      <line id="chart-cursor" class="cursor" x1="0" x2="0" y1="${top}" y2="${bottom}" visibility="hidden"/>
    </svg>`;
  }

  function wireChart(timeline) {
    const svg = $('chart');
    if (!svg || !timeline?.length) return;
    const m = V.chartModel(timeline, { w: 340, h: 132, unit: state.unit });
    const at = (e) => {
      const r = svg.getBoundingClientRect();
      return m.tOf(((e.clientX - r.left) / r.width) * m.w);
    };
    const read = (s) => {
      const p = V.timelineAt(timeline, s);
      const x = m.xOf(s);
      const c = $('chart-cursor');
      c.setAttribute('x1', x); c.setAttribute('x2', x); c.setAttribute('visibility', 'visible');
      $('chart-read').textContent = `${V.fmtClock(s)} · ${V.fmtSpeed(p?.v, state.unit)}`;
    };
    svg.addEventListener('pointermove', (e) => read(at(e)));
    svg.addEventListener('pointerleave', () => { $('chart-cursor')?.setAttribute('visibility', 'hidden'); $('chart-read').textContent = ''; });
    svg.addEventListener('click', (e) => startReplay(at(e)));
  }

  function confirmDelete(id, s) {
    $('confirm-title').textContent = 'Delete this trip?';
    $('confirm-text').textContent = `${V.fmtWhen(s.startedAt)}, ${V.fmtDistance(s.distance, state.unit)}. It moves to the trash folder on the applet server and can be restored from there by hand.`;
    $('confirm').hidden = false;
    $('confirm-no').focus();
    const done = (yes) => {
      $('confirm').hidden = true;
      $('confirm-yes').onclick = $('confirm-no').onclick = null;
      if (yes) remove(id);
    };
    $('confirm-yes').onclick = () => done(true);
    $('confirm-no').onclick = () => done(false);
  }

  async function remove(id) {
    try {
      await api(`api/trips/${encodeURIComponent(id)}`, { method: 'DELETE' });
      ui.trips = (ui.trips || []).filter((s) => s.id !== id);
      status('Trip deleted');
      show('list');
    } catch (e) {
      status('Could not delete the trip: ' + e.message);
    }
  }

  // ---- All trips --------------------------------------------------------------------------------

  async function showAll() {
    if (!ui.all) loading();
    else renderAll();
    const since = V.rangeSince(ui.range);
    const q = since ? `?since=${since}` : '';
    let totals, tracks, summaries;
    try {
      [totals, { tracks }, { trips: summaries }] = await Promise.all([api('api/trips/summary' + q), api('api/trips/tracks' + q), api('api/trips' + q)]);
    } catch (e) { if (ui.view === 'all') failed(e, () => show('all')); return; }
    if (ui.view !== 'all') return;
    // Colour by age, oldest first, so a trip keeps its colour as new ones arrive.
    const colors = new Map(tracks.slice().sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)).map((t, i) => [t.id, V.tripColor(i)]));
    ui.all = { tracks, totals, summaries, colors };
    setData('trips-all', {
      type: 'FeatureCollection',
      features: tracks.filter((t) => t.coords.length > 1).map((t) => ({ type: 'Feature', properties: { id: t.id, color: colors.get(t.id) }, geometry: { type: 'LineString', coordinates: t.coords.map((c) => [c[0], c[1]]) } })),
    });
    setData('trips-speed', { type: 'FeatureCollection', features: tracks.flatMap((t) => V.speedSegments(t.coords, { id: t.id }).features) });
    setData('trips-heat', { type: 'FeatureCollection', features: tracks.flatMap((t) => t.coords.map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [c[0], c[1]] } }))) });
    showMode();
    highlight();
    renderAll();
    fit(tracks.flatMap((t) => t.coords.map((c) => [c[0], c[1]])));
  }

  function chips(name, items, current) {
    return `<div class="chips" role="group" aria-label="${esc(name)}">${items.map(([v, label]) => `<button type="button" data-${name}="${v}" class="${v === current ? 'on' : ''}" aria-pressed="${v === current}">${esc(label)}</button>`).join('')}</div>`;
  }

  function renderAll() {
    const a = ui.all;
    if (!a) return;
    const u = state.unit;
    const t = a.totals;
    const top = a.summaries.find((s) => s.id === t.maxSpeedTrip);
    const longest = a.summaries.find((s) => s.id === t.longest?.id);
    body().innerHTML = `
      <div class="all-controls">
        ${chips('range', [['all', 'All'], ['7d', '7 d'], ['30d', '30 d']], ui.range)}
        ${chips('mode', [['trips', 'Trips'], ['speed', 'Speed'], ['heat', 'Heat']], ui.mode)}
      </div>
      <div class="tiles totals">
        ${tile('Trips', String(t.trips))}
        ${tile('Distance', V.fmtDistance(t.distance, u))}
        ${tile('Driving time', V.fmtDuration(t.movingTime), t.duration > t.movingTime + 60 ? V.fmtDuration(t.duration) + ' total' : '')}
        ${tile('Avg speed', V.fmtSpeed(t.avgSpeed, u))}
        ${tile('Top speed', V.fmtSpeed(t.maxSpeed, u), top ? V.fmtWhen(top.startedAt) : '')}
        ${tile('Longest', t.longest ? V.fmtDistance(t.longest.distance, u) : '—', longest ? V.fmtWhen(longest.startedAt) : '')}
      </div>
      ${ui.mode === 'speed' ? legend() : ''}
      <div id="pick" class="pick"></div>
      ${a.summaries.length ? `<ul class="trip-list compact">${a.summaries.map((s) => `
        <li><button type="button" class="trip-row" data-id="${esc(s.id)}">
          <i class="swatch" style="background:${a.colors.get(s.id) || '#00ff88'}"></i>
          <span class="row-when">${esc(V.fmtWhen(s.startedAt))}</span>
          <span class="row-stats"><span>${esc(V.fmtDistance(s.distance, u))}</span><span>▲ ${esc(V.fmtSpeed(s.maxSpeed, u))}</span></span>
        </button></li>`).join('')}</ul>` : '<div class="empty">No trips in this range.</div>'}`;
    for (const b of body().querySelectorAll('[data-range]')) b.onclick = () => { ui.range = b.dataset.range; ui.selected = null; showAll(); };
    for (const b of body().querySelectorAll('[data-mode]')) b.onclick = () => { ui.mode = b.dataset.mode; showMode(); highlight(); renderAll(); };
    for (const b of body().querySelectorAll('.trip-row')) b.onclick = () => select(b.dataset.id, { zoom: true });
    renderPick();
  }

  function select(id, { zoom = false } = {}) {
    ui.selected = ui.selected === id && !zoom ? null : id;
    highlight();
    renderPick();
    for (const b of body().querySelectorAll('.trip-row')) b.classList.toggle('on', b.dataset.id === ui.selected);
    const t = zoom && ui.all?.tracks.find((x) => x.id === id);
    if (t) fit(t.coords.map((c) => [c[0], c[1]]));
  }

  /** The card for the hovered or picked trip in the all-trips view. */
  function renderPick() {
    const el = $('pick');
    if (!el || !ui.all) return;
    const id = ui.hover || ui.selected;
    const s = id && ui.all.summaries.find((x) => x.id === id);
    if (!s) { el.innerHTML = '<small class="hint">Hover or tap a trip on the map to see its numbers.</small>'; el.classList.remove('on'); return; }
    const u = state.unit;
    el.classList.add('on');
    el.style.setProperty('--trip', ui.all.colors.get(s.id) || '#00ff88');
    el.innerHTML = `
      <div class="pick-head"><i class="swatch"></i><b>${esc(V.fmtWhen(s.startedAt))}</b></div>
      <div class="pick-route">${esc(V.tripRoute(s))}</div>
      <div class="row-stats">${statLine(s)}</div>
      <div class="pick-actions"><button type="button" class="btn" data-open>Details</button><button type="button" class="btn primary" data-replay>▶ Replay</button></div>`;
    el.querySelector('[data-open]').onclick = () => show('detail', s.id);
    el.querySelector('[data-replay]').onclick = async () => { await show('detail', s.id); startReplay(0); };
  }

  // ---- Replay -----------------------------------------------------------------------------------

  /** Replay the open trip from `atS` seconds: the marker, the camera and the HUD follow the recording. */
  function startReplay(atS = 0) {
    const d = ui.detail;
    if (!d || d.track.pts.length < 2) return status('Nothing to replay in this trip');
    if (ui.replay) stopReplay();
    const { t0, t1 } = d.track;
    ui.replay = { t: Math.min(t1, t0 + atS * 1000), playing: true, last: 0, follow: true, cam: null, zoom: null, hudAt: 0, raf: 0 };
    state.replay = { hud: { speed: 0, heading: 0, source: 'replay' } };
    if (!replayMarker) {
      const el = document.createElement('div');
      el.className = 'vehicle replay-car';
      el.innerHTML = '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M20 3 L34 35 L20 27 L6 35 Z" /></svg>';
      replayMarker = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' });
    }
    replayMarker.setLngLat([d.track.pts[0].lon, d.track.pts[0].lat]).addTo(map);
    $('trips').hidden = true;
    document.body.classList.remove('trips-open');
    document.body.classList.add('replaying');
    $('replay').hidden = false;
    $('replay-follow').classList.add('on');
    $('replay-range').max = String((t1 - t0) / 1000);
    $('replay-total').textContent = '/ ' + V.fmtClock((t1 - t0) / 1000);
    $('replay-spark').querySelector('path').setAttribute('d', sparkPath(d.trip.stats.timeline));
    renderRates();
    renderPlay();
    ui.replay.raf = requestAnimationFrame(frame);
  }

  function sparkPath(tl) {
    return V.chartModel(tl, { w: 600, h: 36, unit: 'kmh', pad: { l: 0, r: 0, t: 2, b: 0 } }).area;
  }

  function frame(now) {
    const r = ui.replay;
    if (!r) return;
    const { t1 } = ui.detail.track;
    // Real time even on a slow device; only a long stall (a background tab) is not caught up.
    const dt = r.last ? Math.min(1000, now - r.last) : 0;
    r.last = now;
    if (r.playing) {
      r.t += dt * ui.rate;
      if (r.t >= t1) { r.t = t1; r.playing = false; renderPlay(); }
    }
    place(now);
    r.raf = requestAnimationFrame(frame);
  }

  function place(now = performance.now(), force = false) {
    const r = ui.replay;
    const { track } = ui.detail;
    const p = V.replayAt(track, r.t);
    replayMarker.setLngLat([p.lon, p.lat]).setRotation(p.heading);
    if (r.follow) {
      r.cam = r.cam == null || force ? p.heading : lerpHeading(r.cam, p.heading, 0.12);
      const z = zoomForSpeed(p.v);
      r.zoom = r.zoom == null || force ? z : r.zoom + (z - r.zoom) * 0.04;
      map.jumpTo({
        center: [p.lon, p.lat], bearing: r.cam, pitch: state.pitched ? pitch : 0, zoom: r.zoom,
        padding: { top: Math.round(map.getContainer().clientHeight * 0.38), bottom: 0, left: 0, right: 0 },
      });
    }
    // The limit sign, camera chip and light as they were: from what the recorder kept with each fix.
    const warn = speedHud({ speedKmh: p.v * 3.6, limitKmh: p.lim, camera: p.camD != null ? { maxspeed: p.camLim } : null, distanceM: p.camD });
    state.replay.hud = { speed: p.v, heading: p.heading, source: 'replay', warn };
    if (force || now - r.hudAt > 100) {
      r.hudAt = now;
      renderHud();
      const s = (r.t - track.t0) / 1000;
      if (document.activeElement !== $('replay-range')) $('replay-range').value = String(s);
      $('replay-now').textContent = V.fmtClock(s);
      const st = ui.detail.trip.stats;
      const tl = V.timelineAt(st.timeline, s);
      $('replay-label').textContent = `${V.fmtDistance(tl?.d ?? 0, state.unit)} of ${V.fmtDistance(st.distance, state.unit)} · ${V.tripRoute({ ...st, places: ui.detail.trip.places })}`;
    }
  }

  function renderPlay() {
    const playing = !!ui.replay?.playing;
    $('replay-play').textContent = playing ? '❚❚' : '▶';
    $('replay-play').title = playing ? 'Pause' : 'Play';
    $('replay-play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  function renderRates() {
    for (const b of $('replay-rates').children) {
      const on = Number(b.dataset.rate) === ui.rate;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }

  function setReplayFollow(on) {
    if (!ui.replay) return;
    ui.replay.follow = on;
    $('replay-follow').classList.toggle('on', on);
    if (on) { ui.replay.cam = null; ui.replay.zoom = null; }
  }

  function togglePlay() {
    const r = ui.replay;
    if (!r) return;
    if (!r.playing && r.t >= ui.detail.track.t1) r.t = ui.detail.track.t0; // at the end: play again from the start
    r.playing = !r.playing;
    r.last = 0;
    renderPlay();
  }

  function stopReplay() {
    const r = ui.replay;
    if (!r) return;
    cancelAnimationFrame(r.raf);
    ui.replay = null;
    state.replay = null;
    replayMarker?.remove();
    document.body.classList.remove('replaying');
    $('replay').hidden = true;
  }

  /** Leave the replay for live navigation: the panel closes, the camera follows you again. */
  function exitReplay() {
    stopReplay();
    close();
  }

  // ---- REC indicator ----------------------------------------------------------------------------

  function onTrip(s) {
    const rec = !!s?.recording;
    $('rec').hidden = !rec;
    $('rec-chip').hidden = !rec;
    const waiting = s?.outbox ? ` · ${s.outbox} chunk${s.outbox === 1 ? '' : 's'} waiting to upload${s.lastError ? ' (' + s.lastError + ')' : ''}` : '';
    $('rec').title = $('rec-chip').title = rec ? `Recording this trip · ${s.points} fixes${waiting}` : '';
    tickRec();
    // A trip started or just ended: refresh the history (the server has the final chunk a moment later).
    if (ui.view === 'list' && rec !== ui.wasRecording) setTimeout(() => ui.view === 'list' && showList(), rec ? 0 : 1500);
    ui.wasRecording = rec;
  }

  function tickRec() {
    const s = state.trip;
    if (!s?.recording || !s.startedAt) return;
    $('rec-time').textContent = V.fmtClock((Date.now() - s.startedAt) / 1000);
  }
  setInterval(tickRec, 1000);

  /** The unit toggle changed: redraw labels in place. */
  function rerender() {
    if (ui.view === 'list') renderList();
    else if (ui.view === 'detail') renderDetail();
    else if (ui.view === 'all') renderAll();
    if (ui.replay) place(performance.now(), false);
  }

  // ---- Wiring -----------------------------------------------------------------------------------

  $('trips-btn').onclick = () => (ui.view ? close() : open('list'));
  $('trips-close').onclick = close;
  $('trips-back').onclick = () => show('list');
  for (const b of $('trips-tabs').children) b.onclick = () => show(b.dataset.view);
  $('sheet-grip').onclick = () => {
    $('trips').classList.toggle('full');
    if (ui.view === 'detail' && ui.detail) fit(ui.detail.profile.map((p) => [p.lon, p.lat]));
  };
  $('replay-play').onclick = togglePlay;
  $('replay-exit').onclick = exitReplay;
  $('replay-follow').onclick = () => setReplayFollow(!ui.replay?.follow);
  for (const b of $('replay-rates').children) b.onclick = () => { ui.rate = Number(b.dataset.rate); renderRates(); };
  $('replay-range').addEventListener('input', (e) => {
    if (!ui.replay) return;
    ui.replay.t = ui.detail.track.t0 + Number(e.target.value) * 1000;
    place(performance.now(), true);
  });
  for (const ev of ['dragstart', 'rotatestart', 'pitchstart']) map.on(ev, (e) => { if (ui.replay && e.originalEvent) setReplayFollow(false); });
  document.addEventListener('keydown', (e) => {
    if (e.target.matches?.('input[type=search], input[type=text]')) return;
    if (!$('confirm').hidden) { if (e.key === 'Escape') $('confirm-no').click(); return; }
    if (ui.replay && e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'Escape' && ui.replay) exitReplay();
    else if (e.key === 'Escape' && ui.view) close();
  });

  const hooks = {
    open, close, show, onTrip, rerender, startReplay, exitReplay, togglePlay, select, ui,
    seek: (s) => { if (ui.replay) { ui.replay.t = ui.detail.track.t0 + s * 1000; place(performance.now(), true); } },
    setRate: (r) => { if (RATES.includes(r)) { ui.rate = r; renderRates(); } },
  };
  window.__navTrips = hooks; // inspection and screenshot hook
  return hooks;
}
