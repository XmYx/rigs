// Home Security UI (t4). Contract: docs/home-security.md §1, §8.
// RELATIVE URLS ONLY. Every request resolves against the app root (this page's folder), and every media URL / write
// against the owning node's `base` ("./" here, "../../../<node>/apps/home-security/" for a peer, null = unreachable).

const ROOT = new URL('./', document.baseURI);
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
};
const url = (base, p) => new URL((base ?? './') + p, ROOT);
async function api(p, { base = './', method = 'GET', body, signal } = {}) {
  const r = await fetch(url(base, p), { method, signal, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (r.status === 204) return null;
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw Object.assign(new Error((data && data.error) || `HTTP ${r.status}`), { status: r.status, data });
  return data;
}
const enc = encodeURIComponent;
const pad = (n) => String(n).padStart(2, '0');
const fmtTime = (ms, sec = true) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}${sec ? ':' + pad(d.getSeconds()) : ''}`; };
const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtDateTime = (ms) => `${fmtDate(ms)} ${fmtTime(ms)}`;
const fmtBytes = (b) => { if (b === null || b === undefined) return '—'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; } return `${b.toFixed(b >= 10 || i === 0 ? 0 : 1)} ${u[i]}`; };
const fmtDur = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${pad(s % 60)}s`; };
const camKey = (c) => `${c.node}|${c.id ?? c.camera}`;
let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast'); t.textContent = msg; t.className = `toast show${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = 'toast'; }, 3500);
}
const hasNativeHls = () => !!document.createElement('video').canPlayType('application/vnd.apple.mpegurl');
const hlsReady = () => new Promise((res) => { if (window.Hls || hasNativeHls()) return res(); window.addEventListener('load', () => res(), { once: true }); });

/** Attach an HLS source to a <video>. Returns a detach function. */
function attachHls(video, src, { live = false, onError } = {}) {
  if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls(live ? { liveSyncDurationCount: 2, maxBufferLength: 10, backBufferLength: 10 } : { maxBufferLength: 30, backBufferLength: 30 });
    hls.on(window.Hls.Events.ERROR, (_, d) => { if (d.fatal) { onError?.(d); try { hls.destroy(); } catch { /* gone */ } } });
    hls.loadSource(String(src)); hls.attachMedia(video);
    return () => { try { hls.destroy(); } catch { /* gone */ } video.removeAttribute('src'); };
  }
  if (hasNativeHls()) {
    video.src = String(src);
    const err = () => onError?.({});
    video.addEventListener('error', err, { once: true });
    return () => { video.removeEventListener('error', err); video.removeAttribute('src'); video.load(); };
  }
  onError?.({ unsupported: true });
  return () => {};
}

// ---------------------------------------------------------------- state
const state = {
  view: 'live', nodes: [], cameras: [], streams: new Map(), focus: null,
  selfNode: null,
};

// ---------------------------------------------------------------- mesh, cameras, SSE
async function loadCameras() {
  const r = await api('api/cameras');
  state.nodes = r.nodes || [];
  state.cameras = (r.cameras || []).map((c) => ({ ...c, base: c.base ?? (c.node === state.nodes[0]?.node ? './' : null) }));
  state.selfNode = state.nodes[0]?.node || null;
  renderNodeChips();
  openStreams();
  return state.cameras;
}

function renderNodeChips() {
  const el = $('#nodeChips'); el.replaceChildren();
  for (const n of state.nodes) {
    el.append(h('span', { class: 'chip', title: n.error ? `${n.node}: ${n.error}` : `${n.node}${n.version ? ' · v' + n.version : ''}` },
      h('span', { class: `dot ${n.online ? 'ok' : 'bad'}` }), n.node, n.base === null && n.online ? h('small', { class: 'muted' }, ' (no proxy)') : null));
  }
}

function openStreams() {
  const want = new Set(state.nodes.filter((n) => n.online && n.base !== null).map((n) => n.base));
  for (const [base, es] of state.streams) if (!want.has(base)) { es.close(); state.streams.delete(base); }
  for (const base of want) {
    if (state.streams.has(base)) continue;
    let es;
    try { es = new EventSource(url(base, 'api/stream')); } catch { continue; }
    const node = state.nodes.find((n) => n.base === base)?.node;
    es.addEventListener('camera', (e) => onCameraStatus(node, JSON.parse(e.data)));
    es.addEventListener('motion', (e) => onMotion(node, JSON.parse(e.data)));
    es.addEventListener('event', () => { if (state.view === 'events') loadEvents(true); if (state.view === 'timeline') loadTimeline(); });
    es.addEventListener('discovery', (e) => { if (state.view === 'settings' && settingsBase() === base) renderScanStatus(JSON.parse(e.data)); });
    state.streams.set(base, es);
  }
}

function onCameraStatus(node, s) {
  const c = state.cameras.find((x) => x.node === node && x.id === (s.camera || s.id));
  if (!c) return;
  const was = c.status;
  Object.assign(c, { status: s.status, error: s.error ?? null, retryAt: s.retryAt ?? null });
  if (state.view === 'live') updateTileState(c, was !== 'recording' && c.status === 'recording');
  if (state.view === 'settings') renderCamList();
}

const motionTimers = new Map();
function onMotion(node, m) {
  const key = `${node}|${m.camera}`;
  for (const t of $$(`#liveGrid .tile[data-key="${CSS.escape(key)}"]`)) {
    t.classList.add('motion');
    clearTimeout(motionTimers.get(key));
    motionTimers.set(key, setTimeout(() => $$(`#liveGrid .tile[data-key="${CSS.escape(key)}"]`).forEach((x) => x.classList.remove('motion')), 1500));
  }
}

// ---------------------------------------------------------------- views
function show(view) {
  if (!['live', 'timeline', 'events', 'settings'].includes(view)) view = 'live';
  state.view = view;
  for (const b of $$('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.view === view));
  for (const s of $$('.view')) s.hidden = s.dataset.view !== view;
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  if (view !== 'live') stopLive();
  if (view !== 'timeline') stopPlayback();
  ({ live: renderLive, timeline: enterTimeline, events: enterEvents, settings: enterSettings })[view]();
}

// ================================================================= LIVE
const liveDetach = new Map(); // key → detach()
function stopLive() { for (const d of liveDetach.values()) d(); liveDetach.clear(); $('#liveGrid').replaceChildren(); }

const statusText = (c) => ({ recording: 'Live', starting: 'Starting…', idle: 'Off', error: 'Error', 'needs-credentials': 'Needs login', 'needs-setup': 'Needs setup', unavailable: 'Not found' })[c.status] || c.status;
const statusDot = (c) => (c.status === 'recording' ? 'ok' : c.status === 'starting' ? 'warn' : c.status === 'error' || c.status === 'unavailable' ? 'bad' : '');

async function renderLive() {
  try { await loadCameras(); } catch (e) { toast(`Could not load cameras: ${e.message}`, true); }
  if (state.view !== 'live') return;
  await hlsReady();
  stopLive();
  const grid = $('#liveGrid');
  const offlineNodes = state.nodes.filter((n) => !n.online);
  let cams = state.cameras.filter((c) => c.enabled);
  if (state.focus) cams = cams.filter((c) => camKey(c) === state.focus);
  if (state.focus && !cams.length) state.focus = null;
  grid.classList.toggle('focus', !!state.focus);
  $('#liveBack').hidden = !state.focus;
  const all = state.cameras.filter((c) => c.enabled);
  $('#liveSummary').textContent = `${all.filter((c) => c.status === 'recording').length} of ${all.length} recording · ${state.nodes.filter((n) => n.online).length}/${state.nodes.length} machines online`;
  $('#liveEmpty').hidden = all.length > 0 || offlineNodes.length > 0;
  for (const c of cams) grid.append(liveTile(c));
  if (!state.focus) for (const n of offlineNodes) {
    grid.append(h('div', { class: 'tile offline' },
      h('div', { class: 'label' }, h('span', { class: 'name' }, n.node)),
      h('div', { class: 'over' }, h('strong', {}, `${n.node} is offline`), h('span', {}, n.error || 'not reachable'))));
  }
}

function liveTile(c) {
  const key = camKey(c);
  const tile = h('div', { class: 'tile', 'data-key': key, tabindex: 0, role: 'button', 'aria-label': `${c.name} on ${c.node}` });
  const img = h('img', { alt: '' });
  const video = h('video', { muted: true, autoplay: true, playsinline: true });
  video.muted = true;
  tile.append(img, video,
    h('div', { class: 'label' }, h('span', { class: 'name' }, c.name), h('span', { class: 'node' }, c.node)),
    h('div', { class: 'state' }, h('span', { class: `dot ${statusDot(c)}` }), h('span', { class: 'st' }, statusText(c))));
  const open = () => { state.focus = state.focus === key ? null : key; renderLive(); };
  tile.addEventListener('click', open);
  tile.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  if (c.base === null) {
    tile.classList.add('offline');
    tile.append(h('div', { class: 'over' }, h('strong', {}, 'Open through JARVIS to watch'), h('span', {}, `${c.node} is only reachable via the RIGS proxy`)));
    return tile;
  }
  startTileMedia(c, tile, img, video);
  return tile;
}

function startTileMedia(c, tile, img, video) {
  const key = camKey(c);
  liveDetach.get(key)?.();
  let snapTimer = null; let detachHls = () => {};
  const snapshot = () => { img.src = `${url(c.base, `api/cameras/${enc(c.id)}/snapshot.jpg`)}?t=${Date.now()}`; };
  img.onerror = () => { img.removeAttribute('src'); };
  $('.over', tile)?.remove();
  if (c.status !== 'recording' && c.status !== 'starting') {
    tile.append(h('div', { class: 'over' }, h('strong', {}, statusText(c)), c.error ? h('span', {}, c.error) : null));
    snapshot();
    liveDetach.set(key, () => {});
    return;
  }
  snapshot();
  snapTimer = setInterval(snapshot, 5000);
  const startHls = () => {
    detachHls = attachHls(video, url(c.base, `api/cameras/${enc(c.id)}/live.m3u8`), {
      live: true,
      onError: () => { video.hidden = true; setTimeout(() => { if (liveDetach.has(key)) { video.hidden = false; startHls(); } }, 4000); },
    });
    video.play?.().catch(() => {});
  };
  video.addEventListener('playing', () => { img.hidden = true; });
  startHls();
  liveDetach.set(key, () => { clearInterval(snapTimer); detachHls(); });
}

function updateTileState(c, restart) {
  const tile = $(`#liveGrid .tile[data-key="${CSS.escape(camKey(c))}"]`);
  if (!tile) return;
  $('.st', tile).textContent = statusText(c);
  $('.state .dot', tile).className = `dot ${statusDot(c)}`;
  if (restart) startTileMedia(c, tile, $('img', tile), $('video', tile));
}

$('#liveBack').addEventListener('click', () => { state.focus = null; renderLive(); });

// ================================================================= TIMELINE
const tl = {
  range: 86_400_000, to: Date.now(), t: Date.now() - 60_000, data: null, players: new Map(),
  playing: false, speed: 1, lastTick: 0, raf: null, loading: false,
};
const tlFrom = () => tl.to - tl.range;

async function enterTimeline() {
  await hlsReady();
  if (!tl.data) { tl.to = Date.now(); tl.t = Math.min(tl.t, Date.now() - 5000); }
  await loadTimeline();
  seekAll(tl.t);
}

async function loadTimeline() {
  try {
    const r = await api(`api/timeline?from=${Math.round(tlFrom())}&to=${Math.round(tl.to)}`);
    tl.data = r;
    renderTimeline();
    syncPlayers();
  } catch (e) { toast(`Timeline: ${e.message}`, true); }
}

function renderTimeline() {
  const from = tlFrom(); const span = tl.range;
  const pct = (t) => `${((t - from) / span) * 100}%`;
  const axis = $('#tlAxis'); axis.replaceChildren();
  const steps = [60e3, 300e3, 900e3, 1800e3, 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 86400e3];
  const width = $('#tlRows').clientWidth || 600;
  const step = steps.find((s) => (span / s) * 70 <= width) || 86400e3;
  const tzOff = new Date().getTimezoneOffset() * 60e3;
  for (let t = Math.ceil((from - tzOff) / step) * step + tzOff; t <= tl.to; t += step) {
    axis.append(h('span', { style: { left: pct(t) } }, step >= 86400e3 || new Date(t).getHours() === 0 && new Date(t).getMinutes() === 0 ? fmtDate(t) : fmtTime(t, false)));
  }
  const rows = $('#tlRows'); rows.replaceChildren();
  const cams = tl.data?.cameras || [];
  $('#tlEmpty').hidden = cams.some((c) => c.spans.length);
  for (const c of cams) {
    const track = h('div', { class: 'track' });
    for (const s of c.spans) track.append(h('div', { class: 'span', style: { left: pct(s.from), width: `${Math.max(0.05, ((s.to - s.from) / span) * 100)}%` }, title: `${fmtDateTime(s.from)} – ${fmtTime(s.to)}` }));
    for (const e of c.events) {
      track.append(h('div', {
        class: 'ev', style: { left: pct(e.start), width: `${(((e.end ?? Date.now()) - e.start) / span) * 100}%` }, title: `Motion ${fmtDateTime(e.start)}`,
        onpointerdown: (ev) => { ev.stopPropagation(); }, onclick: (ev) => { ev.stopPropagation(); setT(e.start - 3000, true); },
      }));
    }
    rows.append(h('div', { class: 'tl-row' }, h('div', { class: 'who', title: `${c.name || c.camera} · ${c.node}` }, c.name || c.camera, h('small', {}, c.node)), track));
  }
  for (const n of (tl.data?.nodes || []).filter((x) => !x.online)) {
    rows.append(h('div', { class: 'tl-row' }, h('div', { class: 'who' }, n.node, h('small', {}, 'offline')), h('div', { class: 'track' })));
  }
  placeCursor();
}

function placeCursor() {
  const rows = $('#tlRows'); const cur = $('#tlCursor');
  const rect = rows.getBoundingClientRect(); const box = $('#tl').getBoundingClientRect();
  const firstTrack = $('.track', rows);
  const left = firstTrack ? firstTrack.getBoundingClientRect().left : rect.left + 120;
  const width = firstTrack ? firstTrack.getBoundingClientRect().width : rect.width - 120;
  const f = (tl.t - tlFrom()) / tl.range;
  cur.hidden = f < 0 || f > 1;
  const x = left - box.left + f * width;
  cur.style.left = `${x}px`;
  cur.classList.toggle('flip', x > box.width - 150);
  $('#tlCursorLabel').textContent = fmtDateTime(tl.t);
  $('#pbClock').textContent = `${new Date(tl.t).toLocaleDateString()} ${fmtTime(tl.t)}`;
}

function tFromPointer(ev) {
  const track = $('#tlRows .track');
  const r = (track || $('#tlRows')).getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
  return tlFrom() + f * tl.range;
}

function setT(t, seek) {
  tl.t = Math.min(Date.now(), Math.max(0, t));
  if (tl.t < tlFrom() || tl.t > tl.to) { tl.to = Math.min(Date.now(), tl.t + tl.range / 2); loadTimeline(); }
  placeCursor();
  if (seek) seekAll(tl.t);
}

{ // scrubbing: pointer drag on the timeline
  const box = $('#tl'); let drag = false;
  box.addEventListener('pointerdown', (e) => { drag = true; box.setPointerCapture(e.pointerId); setT(tFromPointer(e), false); });
  box.addEventListener('pointermove', (e) => { if (drag) setT(tFromPointer(e), false); });
  const end = (e) => { if (!drag) return; drag = false; setT(tFromPointer(e), true); };
  box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
  window.addEventListener('resize', () => { if (state.view === 'timeline') renderTimeline(); });
}
for (const b of $$('#tlRange button')) b.addEventListener('click', () => {
  $$('#tlRange button').forEach((x) => x.classList.toggle('on', x === b));
  tl.range = Number(b.dataset.range); tl.to = Math.min(Date.now(), tl.t + tl.range / 2); loadTimeline();
});
$('#tlPrev').addEventListener('click', () => { tl.to -= tl.range / 2; loadTimeline(); });
$('#tlNext').addEventListener('click', () => { tl.to = Math.min(Date.now(), tl.to + tl.range / 2); loadTimeline(); });
$('#tlNow').addEventListener('click', () => { tl.to = Date.now(); setT(Date.now() - 10_000, true); loadTimeline(); });
$('#pbBack').addEventListener('click', () => setT(tl.t - 10_000, true));
$('#pbFwd').addEventListener('click', () => setT(tl.t + 10_000, true));
$('#pbGoto').addEventListener('change', (e) => { const t = new Date(e.target.value).getTime(); if (Number.isFinite(t)) { tl.to = Math.min(Date.now(), t + tl.range / 2); setT(t, true); loadTimeline(); } });
for (const b of $$('#pbSpeed button')) b.addEventListener('click', () => {
  $$('#pbSpeed button').forEach((x) => x.classList.toggle('on', x === b));
  tl.speed = Number(b.dataset.speed);
  for (const p of tl.players.values()) p.video.playbackRate = tl.speed;
});
$('#pbPlay').addEventListener('click', () => (tl.playing ? pause() : play()));

/* ---- synced playback ----
 * One master clock (tl.t, wall-clock ms). Each camera gets a VOD playlist for a window around tl.t; the playlist is
 * parsed here to map wall time ↔ media time (EXTINF sums; segments carry PROGRAM-DATE-TIME). Every tick each video is
 * steered to the master: seek if it drifts > 0.6 s, show "gap" while the master is in a hole of that camera. */
const VOD_BEFORE = 60_000; const VOD_AFTER = 20 * 60_000;

function parsePlaylist(text) {
  const segs = []; let pdt = null; let dur = null; let media = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pdt = Date.parse(line.slice(25));
    else if (line.startsWith('#EXTINF:')) dur = parseFloat(line.slice(8)) * 1000;
    else if (line && !line.startsWith('#') && dur !== null) {
      segs.push({ start: pdt, dur, media }); media += dur; pdt = pdt !== null ? pdt + dur : null; dur = null;
    }
  }
  return segs;
}
/** wall time → media ms, or { gap, next } */
function mediaAt(segs, t) {
  for (const s of segs) {
    if (t < s.start) return { gap: true, next: s.start };
    if (t < s.start + s.dur) return { media: s.media + (t - s.start) };
  }
  return { gap: true, next: null, after: true };
}

function syncPlayers() {
  const grid = $('#pbGrid');
  const cams = (tl.data?.cameras || []).filter((c) => c.base !== null && c.spans.length);
  const want = new Set(cams.map((c) => camKey(c)));
  for (const [k, p] of tl.players) if (!want.has(k)) { p.detach?.(); p.tile.remove(); tl.players.delete(k); }
  for (const c of cams) {
    const k = camKey(c);
    if (tl.players.has(k)) continue;
    const video = h('video', { muted: true, playsinline: true }); video.muted = true;
    const over = h('div', { class: 'over', hidden: true });
    const ts = h('span', { class: 'ts' });
    const tile = h('div', { class: 'tile', 'data-key': k },
      video, h('div', { class: 'label' }, h('span', { class: 'name' }, c.name || c.camera), h('span', { class: 'node' }, c.node)), over, ts);
    grid.append(tile);
    tl.players.set(k, { cam: c, video, over, ts, tile, segs: [], win: null, detach: null, loading: false });
  }
}

async function loadWindow(p, t) {
  if (p.loading) return;
  p.loading = true;
  p.detach?.(); p.detach = null; p.segs = []; p.ready = false;
  const from = Math.round(t - VOD_BEFORE); const to = Math.round(Math.min(Date.now(), t + VOD_AFTER));
  p.win = { from, to };
  const src = url(p.cam.base, `api/cameras/${enc(p.cam.camera)}/vod.m3u8?from=${from}&to=${to}`);
  try {
    const text = await (await fetch(src)).text();
    p.segs = text.startsWith('#EXTM3U') ? parsePlaylist(text) : [];
  } catch { p.segs = []; }
  if (p.segs.length) {
    p.detach = attachHls(p.video, src, { onError: () => { p.ready = false; } });
    await new Promise((res) => {
      const done = () => { p.video.removeEventListener('loadedmetadata', done); res(); };
      p.video.addEventListener('loadedmetadata', done); setTimeout(done, 5000);
    });
    p.ready = true;
    p.video.playbackRate = tl.speed;
  }
  p.loading = false;
}

function steer(p, force) {
  const t = tl.t;
  if (!p.win || t < p.win.from || (t > p.win.to - 5000 && p.win.to < Date.now() - 10_000) || (force && !p.segs.length)) {
    loadWindow(p, t).then(() => steer(p, true));
    return;
  }
  const m = mediaAt(p.segs, t);
  p.ts.textContent = fmtTime(t);
  if (m.gap) {
    p.over.hidden = false;
    p.over.replaceChildren(h('strong', {}, 'No recording'), h('span', {}, m.next ? `next at ${fmtDateTime(m.next)}` : 'nothing later in this window'));
    if (!p.video.paused) p.video.pause();
    if (m.after && p.win.to < Date.now() - 10_000 && !p.loading) loadWindow(p, t);
    return;
  }
  p.over.hidden = true;
  if (!p.ready) return;
  const want = m.media / 1000;
  if (force || Math.abs(p.video.currentTime - want) > 0.6 * Math.max(1, tl.speed)) { try { p.video.currentTime = want; } catch { /* not seekable yet */ } }
  if (tl.playing && p.video.paused) p.video.play().catch(() => {});
  if (!tl.playing && !p.video.paused) p.video.pause();
}

function seekAll(t) { tl.t = t; placeCursor(); for (const p of tl.players.values()) steer(p, true); }
function tick(now) {
  if (!tl.playing) return;
  const dt = now - (tl.lastTick || now); tl.lastTick = now;
  tl.t = Math.min(Date.now() - 2000, tl.t + dt * tl.speed);
  placeCursor();
  if (tl.t > tl.to) { tl.to = Math.min(Date.now(), tl.t + tl.range / 2); loadTimeline(); }
  if (!tick.n || now - tick.n > 400) { tick.n = now; for (const p of tl.players.values()) steer(p, false); }
  tl.raf = requestAnimationFrame(tick);
}
function play() { tl.playing = true; tl.lastTick = 0; $('#pbPlay').textContent = '❚❚'; $('#pbPlay').setAttribute('aria-label', 'Pause'); for (const p of tl.players.values()) steer(p, true); tl.raf = requestAnimationFrame(tick); }
function pause() { tl.playing = false; cancelAnimationFrame(tl.raf); $('#pbPlay').textContent = '▶'; $('#pbPlay').setAttribute('aria-label', 'Play'); for (const p of tl.players.values()) p.video.pause(); }
function stopPlayback() { pause(); for (const p of tl.players.values()) { p.detach?.(); p.tile.remove(); } tl.players.clear(); }

// ================================================================= EVENTS
const ev = { list: [], next: null, current: null, detach: null };
async function enterEvents() {
  try { if (!state.cameras.length) await loadCameras(); } catch { /* shown elsewhere */ }
  const camSel = $('#evCamera'); const keep = camSel.value;
  camSel.replaceChildren(h('option', { value: '' }, 'All cameras'), ...state.cameras.map((c) => h('option', { value: `${c.node}|${c.id}` }, `${c.name} (${c.node})`)));
  camSel.value = keep;
  const nodeSel = $('#evNode'); const keepN = nodeSel.value;
  nodeSel.replaceChildren(h('option', { value: '' }, 'All machines'), ...state.nodes.map((n) => h('option', { value: n.node }, n.node)));
  nodeSel.value = keepN;
  loadEvents(true);
}
async function loadEvents(reset) {
  const q = new URLSearchParams({ limit: '48' });
  const cam = $('#evCamera').value; const node = $('#evNode').value; const day = $('#evDate').value; const st = $('#evState').value;
  if (cam) { const [n, id] = cam.split('|'); q.set('camera', id); q.set('node', n); } else if (node) q.set('node', node);
  if (day) { const d = new Date(`${day}T00:00:00`); q.set('from', String(d.getTime())); q.set('to', String(d.getTime() + 86_400_000 - 1)); }
  if (st === 'unreviewed') q.set('reviewed', 'false');
  if (st === 'locked') q.set('locked', 'true');
  if (!reset && ev.next) q.set('before', String(ev.next));
  try {
    const r = await api(`api/events?${q}`);
    ev.list = reset ? r.events : ev.list.concat(r.events);
    ev.next = r.next;
    renderEvents();
  } catch (e) { toast(`Events: ${e.message}`, true); }
}
function renderEvents() {
  const list = $('#evList'); list.replaceChildren();
  $('#evEmpty').hidden = ev.list.length > 0;
  $('#evMore').hidden = !ev.next;
  for (const e of ev.list) {
    const thumb = h('div', { class: 'thumb' }, h('span', { class: 'badge' }, e.end ? fmtDur(e.end - e.start) : 'live'));
    if (e.base !== null) thumb.style.backgroundImage = `url("${url(e.base, e.thumb)}")`;
    list.append(h('div', { class: `card${e.reviewed ? '' : ' unreviewed'}`, tabindex: 0, role: 'button', onclick: () => openEvent(e), onkeydown: (k) => { if (k.key === 'Enter') openEvent(e); } },
      thumb,
      h('div', { class: 'body' },
        h('span', { class: 't' }, e.cameraName || e.camera),
        h('span', { class: 'muted small' }, `${fmtDateTime(e.start)} · ${e.node}`),
        h('span', { class: 'muted small' }, `motion ${Math.round(e.peak * 100)}%${e.locked ? ' · 🔒 locked' : ''}${e.zones?.length ? ' · ' + e.zones.join(', ') : ''}`))));
  }
}
for (const id of ['#evCamera', '#evNode', '#evDate', '#evState']) $(id).addEventListener('change', () => loadEvents(true));
$('#evMore').addEventListener('click', () => loadEvents(false));

async function openEvent(e) {
  ev.current = e;
  const dlg = $('#evDialog');
  $('#evTitle').textContent = `${e.cameraName || e.camera} · ${fmtDateTime(e.start)}`;
  $('#evMeta').textContent = `${e.node} · motion ${fmtTime(e.start)}–${e.end ? fmtTime(e.end) : 'now'} · clip ${fmtTime(e.clipFrom)}–${e.clipTo ? fmtTime(e.clipTo) : 'now'} · peak ${Math.round(e.peak * 100)}%`;
  const reachable = e.base !== null;
  $('#evDownload').href = reachable ? url(e.base, e.download).href : '#';
  $('#evDownload').toggleAttribute('hidden', !reachable);
  $('#evLock').textContent = e.locked ? 'Unlock' : 'Lock (keep forever)';
  $('#evDelete').disabled = !reachable || e.locked;
  $('#evDelete').title = e.locked ? 'Unlock it first' : '';
  dlg.showModal();
  await hlsReady();
  ev.detach?.();
  const video = $('#evVideo');
  if (reachable) {
    ev.detach = attachHls(video, url(e.base, e.clip), { onError: () => toast('This clip could not be played', true) });
    video.play().catch(() => {});
    if (!e.reviewed) api(`api/events/${enc(e.id)}`, { base: e.base, method: 'PATCH', body: { reviewed: true } }).then((u) => { Object.assign(e, { reviewed: u.reviewed }); renderEvents(); }).catch(() => {});
  }
}
$('#evDialog').addEventListener('close', () => { ev.detach?.(); ev.detach = null; });
$('#evClose').addEventListener('click', () => $('#evDialog').close());
$('#evLock').addEventListener('click', async () => {
  const e = ev.current;
  try {
    const u = await api(`api/events/${enc(e.id)}`, { base: e.base, method: 'PATCH', body: { locked: !e.locked } });
    e.locked = u.locked; $('#evLock').textContent = e.locked ? 'Unlock' : 'Lock (keep forever)'; $('#evDelete').disabled = e.locked; renderEvents();
    toast(e.locked ? 'Locked: retention will keep this event' : 'Unlocked');
  } catch (x) { toast(x.message, true); }
});
$('#evDelete').addEventListener('click', async () => {
  const e = ev.current;
  if (!confirm(`Delete the event from ${e.cameraName || e.camera} at ${fmtDateTime(e.start)}?`)) return;
  try {
    await api(`api/events/${enc(e.id)}`, { base: e.base, method: 'DELETE' });
    ev.list = ev.list.filter((x) => x !== e); renderEvents(); $('#evDialog').close(); toast('Event deleted');
  } catch (x) { toast(x.message, true); }
});
$('#evTimeline').addEventListener('click', () => {
  const e = ev.current; $('#evDialog').close();
  tl.t = e.clipFrom; tl.to = Math.min(Date.now(), e.start + tl.range / 2);
  location.hash = '#timeline';
});

// ================================================================= SETTINGS
const settingsBase = () => { const n = state.nodes.find((x) => x.node === $('#stNode').value); return n ? n.base : './'; };
async function enterSettings() {
  try { await loadCameras(); } catch (e) { toast(`Cameras: ${e.message}`, true); }
  const sel = $('#stNode'); const keep = sel.value || state.selfNode;
  sel.replaceChildren(...state.nodes.map((n) => h('option', { value: n.node, disabled: !n.online || n.base === null }, `${n.node}${n.online ? '' : ' (offline)'}${n.base === null && n.online ? ' (open via JARVIS)' : ''}`)));
  sel.value = keep;
  renderCamList();
  loadNodeSettings();
}
$('#stNode').addEventListener('change', () => { renderCamList(); loadNodeSettings(); });

function renderCamList() {
  const node = $('#stNode').value || state.selfNode;
  const list = $('#camList'); list.replaceChildren();
  const cams = state.cameras.filter((c) => c.node === node).sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
  if (!cams.length) list.append(h('p', { class: 'muted' }, 'No cameras found on this machine yet. Rescan, or add an IP camera by URL.'));
  for (const c of cams) list.append(camRow(c));
}

function camRow(c) {
  const base = c.base;
  const patch = async (body, what = 'Saved') => {
    try { const u = await api(`api/cameras/${enc(c.id)}`, { base, method: 'PATCH', body }); Object.assign(c, u, { node: c.node, base: c.base }); toast(what); renderCamList(); } catch (e) { toast(e.message, true); renderCamList(); }
  };
  const pv = h('div', { class: 'pv' });
  if (base !== null && c.enabled) pv.style.backgroundImage = `url("${url(base, `api/cameras/${enc(c.id)}/snapshot.jpg`)}?t=${Date.now()}")`;
  const sw = h('input', { type: 'checkbox', 'aria-label': `Record ${c.name}` }); sw.checked = !!c.enabled;
  sw.addEventListener('change', () => patch({ enabled: sw.checked }, sw.checked ? `${c.name}: recording on` : `${c.name}: off`));
  const src = c.source?.device || c.source?.url || c.source?.onvif?.xaddr || '';
  const row = h('div', { class: 'cam' },
    pv,
    h('div', { class: 'info' },
      h('div', { class: 'n' }, c.name),
      h('div', { class: 's' }, `${c.kind}${src ? ' · ' + src : ''}`),
      h('div', { class: 's' }, h('span', { class: `dot ${statusDot(c)}`, style: { display: 'inline-block', marginRight: '5px' } }), statusText(c), c.warning ? ` · ⚠ ${c.warning}` : '', c.seenBy?.length > 1 ? ` · seen by ${c.seenBy.join(', ')}` : ''),
      c.error ? h('div', { class: 'err' }, c.error) : null),
    h('div', { class: 'act' },
      h('button', { class: 'btn ghost', type: 'button', onclick: () => row.classList.toggle('open'), 'aria-label': `Options for ${c.name}` }, 'Options'),
      h('label', { class: 'switch', title: 'Record this camera' }, sw, h('span'))));
  // options
  const mode = h('select', {}, h('option', { value: '' }, 'Node default'), h('option', { value: 'continuous' }, 'Continuous'), h('option', { value: 'motion' }, 'Motion only'), h('option', { value: 'off' }, 'Off'));
  mode.value = c.mode || '';
  mode.addEventListener('change', () => patch({ mode: mode.value || null }));
  const sens = h('input', { type: 'number', min: 1, max: 100, step: 1, placeholder: 'default' });
  sens.value = c.motion?.sensitivity ?? '';
  sens.addEventListener('change', () => patch({ motion: { sensitivity: sens.value === '' ? null : Math.round(Number(sens.value)) } }));
  const motionOn = h('input', { type: 'checkbox' }); motionOn.checked = c.motion?.enabled !== false;
  motionOn.addEventListener('change', () => patch({ motion: { enabled: motionOn.checked } }));
  const name = h('input', { value: c.name, maxlength: 120 });
  name.addEventListener('change', () => name.value.trim() && patch({ name: name.value.trim() }, 'Renamed'));
  const more = h('div', { class: 'more' },
    h('label', {}, 'Name', name),
    h('label', {}, 'Recording', mode),
    h('label', {}, 'Sensitivity (1–100)', sens),
    h('label', { class: 'check' }, motionOn, 'Motion detection'));
  if (c.kind !== 'webcam' && c.kind !== 'test') {
    const u = h('input', { placeholder: 'rtsp://host:554/path', value: c.source?.url || '', inputmode: 'url' });
    const user = h('input', { placeholder: c.hasCredentials ? 'saved' : 'username', autocomplete: 'off' });
    const pass = h('input', { type: 'password', placeholder: c.hasCredentials ? '•••••• (saved)' : 'password', autocomplete: 'new-password' });
    more.append(
      c.kind !== 'onvif' ? h('label', {}, 'Stream URL', u) : null,
      h('label', {}, 'Username', user), h('label', {}, 'Password', pass),
      h('button', { class: 'btn', type: 'button', onclick: () => {
        const body = {};
        if (c.kind !== 'onvif' && u.value && u.value !== c.source?.url) body.url = u.value;
        if (user.value) body.username = user.value;
        if (pass.value) body.password = pass.value;
        if (Object.keys(body).length) patch(body, 'Camera login saved');
      } }, 'Save login'));
  }
  more.append(
    h('button', { class: 'btn ghost', type: 'button', onclick: async (e) => {
      e.target.disabled = true;
      try { const r = await api(`api/cameras/${enc(c.id)}/test`, { base, method: 'POST', body: {} }); toast(r.ok ? `OK${r.codec ? ` · ${r.codec} ${r.width}×${r.height}` : ''}` : `Failed: ${r.error}`, !r.ok); } catch (x) { toast(x.message, true); }
      e.target.disabled = false;
    } }, 'Test'),
    h('button', { class: 'btn danger', type: 'button', onclick: async () => {
      const purge = confirm(`Remove ${c.name}?\n\nOK = also delete its recordings and events.\nCancel = keep the camera.`);
      if (!purge) return;
      try { await api(`api/cameras/${enc(c.id)}?purge=1`, { base, method: 'DELETE' }); state.cameras = state.cameras.filter((x) => x !== c); renderCamList(); toast('Camera removed'); } catch (x) { toast(x.message, true); }
    } }, 'Remove'));
  row.append(more);
  return row;
}

function renderScanStatus(d) {
  const el = $('#scanStatus');
  if (!d) { el.textContent = ''; return; }
  $('#scanBtn').disabled = !!d.running;
  const found = d.found || {};
  el.textContent = d.running ? 'Scanning…'
    : `${d.finishedAt ? `Last scan ${fmtDateTime(d.finishedAt)}` : 'Not scanned yet'} · webcams ${found.webcam ?? 0} · ONVIF ${found.onvif ?? 0} · RTSP ${found.rtsp ?? 0}${d.subnets?.length ? ` · LAN ${d.subnets.join(', ')}` : ''}${d.errors?.length ? ` · ${d.errors.join('; ')}` : ''}`;
  if (!d.running && state.view === 'settings' && el.dataset.wasRunning === '1') { loadCameras().then(renderCamList); }
  el.dataset.wasRunning = d.running ? '1' : '0';
}

$('#scanBtn').addEventListener('click', async () => {
  const base = settingsBase();
  try {
    const d = await api('api/discovery/scan', { base, method: 'POST', body: { portProbe: $('#scanProbe').checked } });
    renderScanStatus(d);
    const poll = setInterval(async () => {
      try { const s = await api('api/discovery', { base }); renderScanStatus(s); if (!s.running) clearInterval(poll); } catch { clearInterval(poll); }
    }, 1500);
  } catch (e) { toast(e.status === 409 ? 'A scan is already running' : e.message, true); }
});

$('#addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target); const body = Object.fromEntries([...f].filter(([, v]) => v !== ''));
  const msg = $('#addMsg');
  try {
    const c = await api('api/cameras', { base: settingsBase(), method: 'POST', body });
    msg.className = 'msg ok'; msg.textContent = `Added ${c.name}. Switch it on to record.`;
    e.target.reset(); await loadCameras(); renderCamList();
  } catch (x) { msg.className = 'msg bad'; msg.textContent = x.message; }
});

const getPath = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
function setPath(o, p, v) { const ks = p.split('.'); let a = o; for (const k of ks.slice(0, -1)) a = a[k] ??= {}; a[ks.at(-1)] = v; }

async function loadNodeSettings(keepMsg = false) {
  const base = settingsBase(); const form = $('#setForm');
  if (!keepMsg) $('#setMsg').textContent = '';
  try {
    const [s, st, d] = await Promise.all([api('api/settings', { base }), api('api/storage', { base }), api('api/discovery', { base }).catch(() => null)]);
    for (const el of form.elements) {
      if (!el.name) continue;
      const v = getPath(s, el.name);
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? '';
    }
    $('output[data-for="motion.sensitivity"]').textContent = s.motion.sensitivity;
    renderUsage(st);
    renderScanStatus(d);
  } catch (e) { $('#setMsg').className = 'msg bad'; $('#setMsg').textContent = `Could not load settings: ${e.message}`; }
}
$('#setForm').addEventListener('input', (e) => { if (e.target.name === 'motion.sensitivity') $('output[data-for="motion.sensitivity"]').textContent = e.target.value; });

function renderUsage(st) {
  const el = $('#usage'); el.replaceChildren();
  const pct = st.maxBytes ? Math.min(100, (st.totalBytes / st.maxBytes) * 100) : 0;
  el.append(
    h('div', {}, h('strong', {}, fmtBytes(st.totalBytes)), ` of ${fmtBytes(st.maxBytes)} used`, h('span', { class: 'muted' }, ` · ${fmtBytes(st.freeBytes)} free on disk${st.oldestMs ? ` · oldest ${fmtDateTime(st.oldestMs)}` : ''}`)),
    h('div', { class: `meter${st.overLimit ? ' over' : ''}` }, h('div', { style: { width: `${pct}%` } })),
    h('div', { class: 'muted small' }, `Recordings ${fmtBytes(st.segmentsBytes)} · events ${fmtBytes(st.eventsBytes)}`,
      ...Object.entries(st.cameras || {}).map(([cam, b]) => ` · ${state.cameras.find((c) => c.id === cam)?.name || cam} ${fmtBytes(b)}`)),
    ...(st.overLimit ? [h('div', { class: 'msg bad' }, 'Over the limit: only locked events are left to delete, or the disk is nearly full.')] : []));
}

$('#setForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {};
  for (const el of e.target.elements) {
    if (!el.name) continue;
    const v = el.type === 'checkbox' ? el.checked : el.type === 'number' || el.type === 'range' ? Number(el.value) : el.value;
    setPath(body, el.name, v);
  }
  const msg = $('#setMsg');
  try {
    await api('api/settings', { base: settingsBase(), method: 'PATCH', body });
    msg.className = 'msg ok'; msg.textContent = `Saved for ${$('#stNode').value || 'this machine'}.`;
    loadNodeSettings(true);
  } catch (x) { msg.className = 'msg bad'; msg.textContent = x.data?.errors?.join(' · ') || x.message; }
});
$('#runRetention').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try {
    const r = await api('api/storage/retention/run', { base: settingsBase(), method: 'POST', body: {} });
    renderUsage(r.after);
    toast(`Cleaned up ${fmtBytes(r.deleted.bytes)} (${r.deleted.segments} segments, ${r.deleted.events} events)`);
  } catch (x) { toast(x.message, true); }
  e.target.disabled = false;
});

// ---------------------------------------------------------------- boot
for (const b of $$('.tabs button')) b.addEventListener('click', () => { location.hash = `#${b.dataset.view}`; });
document.addEventListener('click', (e) => { const a = e.target.closest('[data-goto]'); if (a) { e.preventDefault(); location.hash = `#${a.dataset.goto}`; } });
window.addEventListener('hashchange', () => show(location.hash.slice(1)));
document.addEventListener('visibilitychange', () => { if (document.hidden) { stopLive(); pause(); } else if (state.view === 'live') renderLive(); });
show(location.hash.slice(1) || 'live');
setInterval(() => { if (state.view === 'live' && !document.hidden) loadCameras().then(() => { for (const c of state.cameras) updateTileState(c, false); }).catch(() => {}); }, 30_000);
