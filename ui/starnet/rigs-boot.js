/* RIGS · StarNet station frame boot — EXPERIMENTAL space-station view (src/starnet.js, ui/src/starnet/).
   A classic script that src/starnet.js injects into StarNet's own index.html ahead of the first app script, so it runs
   before any StarNet store read. StarNet (MIT © Andrew Sims, github.com/androoAGI/starnet) runs unmodified; this file
   only sets the stage around it, the way StarNet's own website/app/demo-boot.js boots the real frontend with no sidecar:
     1. Sandbox. localStorage / sessionStorage are in-memory for this frame, so StarNet never reads or writes the
        RIGS UI's keys on the shared origin and leaves nothing behind. The network is fenced to /starnet/ on this
        origin: fetch / XHR / EventSource / WebSocket / sendBeacon to anything else (StarNet's sidecar API, the RIGS
        API) answer "offline" locally without a request.
     2. Seeded save. The station document, JARVIS as the station's hero and the settings come from the host page
        (parent.__rigsStarnet.initial(), same origin, built by ui/src/starnet/model.js from the galaxy's data).
     3. Bridge (postMessage, same origin only). host → frame: {type:'station', state} (rooms, workers, work state),
        {type:'focus', id}; frame → host: {type:'ready'}, {type:'select', id} (a JARVIS node id), {type:'error', message}.
   The frame never changes JARVIS state: a click only asks the host to select a node in its inspector. */
(function () {
  'use strict';
  var ORIGIN = location.origin;
  var host = null;
  try { host = window.parent !== window ? window.parent : null; } catch (e) { host = null; }
  var bridge = null;
  try { bridge = host && host.__rigsStarnet; } catch (e) { bridge = null; }
  function post(msg) { try { if (host) host.postMessage(msg, ORIGIN); } catch (e) { /* host gone */ } }

  // ---------------------------------------------------------------- 1. sandbox
  function memoryStorage() {
    var data = new Map();
    var api = {
      getItem: function (k) { k = String(k); return data.has(k) ? data.get(k) : null; },
      setItem: function (k, v) { data.set(String(k), String(v)); },
      removeItem: function (k) { data.delete(String(k)); },
      clear: function () { data.clear(); },
      key: function (i) { var ks = Array.from(data.keys()); return i >= 0 && i < ks.length ? ks[i] : null; },
    };
    return new Proxy(api, {
      get: function (t, k) { if (k === 'length') return data.size; if (typeof k === 'string' && Object.prototype.hasOwnProperty.call(api, k)) return api[k]; return typeof k === 'string' && data.has(k) ? data.get(k) : undefined; },
      set: function (t, k, v) { data.set(String(k), String(v)); return true; },
      deleteProperty: function (t, k) { data.delete(String(k)); return true; },
      has: function (t, k) { return data.has(String(k)) || k in api; },
      ownKeys: function () { return Array.from(data.keys()); },
      getOwnPropertyDescriptor: function (t, k) { return data.has(String(k)) ? { value: data.get(String(k)), enumerable: true, configurable: true, writable: true } : undefined; },
    });
  }
  var ls = memoryStorage();
  try {
    Object.defineProperty(window, 'localStorage', { value: ls, configurable: true });
    Object.defineProperty(window, 'sessionStorage', { value: memoryStorage(), configurable: true });
  } catch (e) { post({ type: 'error', message: 'storage sandbox unavailable' }); return; }

  // StarNet's UI sounds are not installed (their licence covers StarNet itself only): answer those locally too.
  function allowed(url) {
    try { var u = new URL(String(url && url.url ? url.url : url), location.href); return u.origin === ORIGIN && u.pathname.indexOf('/starnet/') === 0 && u.pathname.indexOf('/starnet/assets/sfx/') !== 0; } catch (e) { return false; }
  }
  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    if (allowed(input)) return realFetch(input, init);
    return Promise.resolve(new Response('{"error":"offline: the RIGS station view has no StarNet sidecar"}', { status: 404, headers: { 'content-type': 'application/json' } }));
  };
  var xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    if (!allowed(url)) { args[0] = 'GET'; args[1] = 'data:application/json,%7B%7D'; }
    return xhrOpen.apply(this, args);
  };
  function Closed(url) { this.url = String(url || ''); this.readyState = 2; }
  Closed.prototype.close = function () {};
  Closed.prototype.send = function () {};
  Closed.prototype.addEventListener = function () {};
  Closed.prototype.removeEventListener = function () {};
  Closed.CONNECTING = 0; Closed.OPEN = 1; Closed.CLOSING = 2; Closed.CLOSED = 2;
  window.EventSource = Closed;
  var RealWS = window.WebSocket;
  window.WebSocket = function (url, p) { return allowed(String(url).replace(/^ws/, 'http')) ? new RealWS(url, p) : new Closed(url); };
  window.WebSocket.CONNECTING = 0; window.WebSocket.OPEN = 1; window.WebSocket.CLOSING = 2; window.WebSocket.CLOSED = 3;
  if (navigator.sendBeacon) { var beacon = navigator.sendBeacon.bind(navigator); navigator.sendBeacon = function (url, d) { return allowed(url) ? beacon(url, d) : true; }; }

  // ---------------------------------------------------------------- 2. seeded save
  var initial = null;
  try { initial = bridge && typeof bridge.initial === 'function' ? bridge.initial() : null; } catch (e) { initial = null; }
  if (!initial || !initial.doc) {
    initial = { key: 'empty', hero: { id: 'jarvis', name: 'JARVIS' }, workers: [], ids: {}, rooms: {},
      doc: { schema: 'starnet.station', version: 2, _nid: 2, meta: { name: 'RIGS MESH', createdAt: 0, tier: 0, spawnRoomId: 'bridge', trunkRoomId: 'bridge' },
        rooms: { bridge: { id: 'bridge', kind: 'bridge', name: 'BRIDGE · JARVIS', rects: [{ x1: 0, y1: 0, x2: 13, y2: 8 }], floorStyle: 'cobalt', floorMat: null, wallStyle: null, wallMat: null, hullStyle: null, hullMat: null, tier: 0, floorPaint: {} } },
        order: ['bridge'], props: [{ id: 'p1', t: 'desk', x: 6, y: 1, w: 2, h: 1, block: true, agentId: 'jarvis' }], belts: {}, edges: [] } };
  }
  var hero = initial.hero || { id: 'jarvis', name: 'JARVIS' };
  var t0 = 1700000000000;
  var heroDocs = { identity: 'JARVIS, the RIGS mesh brain, shown on a StarNet station.', purpose: 'Coordinate the work on the mesh.', manual: 'Read-only view of the RIGS mesh.', context: 'Rooms are machines; workers are their agent sessions.' };
  var save = {
    schema: 'starnet.save', version: 5, updatedAt: t0,
    agent: { id: hero.id, name: hero.name, color: '#5ad0ff', model: 'rigs/jarvis', personaId: 'worker-homie', purpose: heroDocs.purpose, specialtyId: null, createdAt: t0, docs: heroDocs,
      stats: { xp: 0, level: 1, lifetimeXp: 0, confidence: 50, samples: 0, counters: {}, milestones: [] }, role: 'orchestrator', systemPrompt: heroDocs.identity, provider: 'rigs', reasoningEffort: 'medium' },
    usage: { tokens: 0, cost: 0, calls: 0 }, prov: 'rigs', reasoningEffort: 'medium',
    station: initial.doc,
    stationStats: { xp: 0, level: 1, lifetimeXp: 0, confidence: 50, samples: 0, counters: {}, milestones: [] },
    profile: { v: 1, tags: {}, seed: null, enabled: false, total: 0 }, worksignal: { v: 1, lanes: {}, total: 0 },
    dossier: { v: 1, dims: { identity: [], stack: [], goals: [], style: [], standing_orders: [], pain: [], ambition: [], people: [], schedule: [] }, seededFrom: { context: true, purpose: true, manual: true }, updatedAt: t0 },
    workstreams: [{ id: 'ws_rigs', title: null, agentId: hero.id, roomId: null, lane: 'active', kind: 'chat', projectRoot: null, history: [], runIds: [], deliverables: [], cost: { tokens: 0, usd: 0, calls: 0 }, pinned: false, archived: false, titleAuto: true, createdAt: t0, lastActiveAt: t0, lastReadAt: t0 }],
    activeId: 'ws_rigs', generalId: 'ws_rigs', sessionUndo: null, deletedIds: [],
  };
  var now = String(Date.now());
  var seed = {
    'starnet.save': JSON.stringify(save),
    'starnet.widgets.v1': '{"v":1,"top":[],"bot":[]}',
    'starnet.byok.prov': 'rigs', 'starnet.byok.model': 'rigs/jarvis', 'starnet.byok.reasoningEffort': 'medium',
    'starnet.station.v1': JSON.stringify({ v: 1, settings: { theme: 'amber', themeHue: 35, themeSat: 100, themeGlow: 100, textScale: 0, flicker: false, sound: false, keepComputerAwake: false, notifyPrefs: { runComplete: false, needsApproval: false, cronDigest: false, sound: false } }, tasks: [], notifs: [], termPos: {}, termSize: {}, consoleSection: {}, tasksImported: true }),
    'starnet.nightreport.v1': now,
    'starnet.pride.v1': '{"v":1,"foundedAt":0,"tasks":0,"deliverables":0,"routines":0,"workMs":0,"sawTask":false,"sawDeliverable":false,"sawRoutine":false,"sawWork":false,"open":{}}',
    'starnet.seedreuse.v1': '{"v":1,"seeds":{}}',
    'starnet.return.v1': JSON.stringify({ v: 1, lastSeenAt: Number(now), pending: [], digested: [] }),
    'starnet.mint.v1': '{"v":1,"shapes":{},"enabled":false}',
    'starnet.refit.seen': '1',
  };
  Object.keys(seed).forEach(function (k) { ls.setItem(k, seed[k]); });
  // StarNet's DEV "server holds the key" seam (as its website embed): boot resumes onto the floor, no key prompt.
  window.__STARNET_DEV__ = { model: 'rigs/jarvis', prov: 'rigs' };

  // ---------------------------------------------------------------- 3. bridge
  var cur = { key: initial.key, ids: initial.ids || {}, rooms: initial.rooms || {}, workers: [], hero: { working: false }, station: null, doc: initial.doc };
  var ready = false;
  var pending = null;
  function toJarvis(id) { return id && Object.prototype.hasOwnProperty.call(cur.ids, id) ? cur.ids[id] : null; }

  // Our own handle on the floor World draws (StarNet's app keeps its copy of the seeded one), so a worker can be
  // spawned in its machine's room: World puts a new body in the station's spawn room, which we point there briefly.
  function load(doc) {
    cur.station = WorldModel.deserialize(doc);
    cur.doc = doc;
    World.loadStation(cur.station);
    labels.layout();
  }
  function spawnIn(w) {
    var meta = cur.station && cur.station.doc && cur.station.doc().meta;
    var keep = meta && meta.spawnRoomId;
    if (meta && w.room) meta.spawnRoomId = w.room;
    try { World.spawnAgent({ id: w.id, name: w.name, color: w.color }); } finally { if (meta) meta.spawnRoomId = keep; }
  }

  function applyState(s) {
    if (!ready) { pending = s; return; }
    if (s.key !== cur.key && s.doc) {
      load(s.doc); // machines or workers changed: re-bake the floor
      cur.key = s.key;
    }
    cur.ids = s.ids || {};
    cur.rooms = s.rooms || {};
    var before = new Map(cur.workers.map(function (w) { return [w.id, w]; }));
    var after = new Map((s.workers || []).map(function (w) { return [w.id, w]; }));
    before.forEach(function (w, id) { if (!after.has(id)) World.despawnAgent(id); });
    (s.workers || []).forEach(function (w) {
      var p = before.get(w.id);
      if (!p) spawnIn(w);
      else if (p.name !== w.name) World.relabel(w.id, w.name);
      if (w.working !== !!(p && p.working) || !p) World.setActivityFor(w.id, w.working ? 'task' : 'idle');
      if (w.attention && !(p && p.attention)) U.bus.emit('permission.prompt', { agentId: w.id, promptId: 'rigs-' + w.id, tool: 'rigs.attention' });
      if (!w.attention && p && p.attention) U.bus.emit('permission.response', { promptId: 'rigs-' + w.id, decision: 'rigs' });
    });
    cur.workers = s.workers || [];
    var heroWorking = !!(s.hero && s.hero.working);
    if (heroWorking !== cur.hero.working) { World.setActivityFor(hero.id, heroWorking ? 'task' : 'idle'); cur.hero.working = heroWorking; }
  }

  function focus(jarvisId) {
    if (!ready || !jarvisId) return;
    var room = cur.rooms[jarvisId];
    if (!room) { for (var i = 0; i < cur.workers.length; i++) if (cur.workers[i].node === jarvisId) { room = cur.workers[i].room; break; } }
    try { World.frameReviewRoom(room || ''); } catch (e) { /* older renderer */ }
  }

  window.addEventListener('message', function (e) {
    if (e.origin !== ORIGIN || e.source !== host || !e.data || typeof e.data !== 'object') return;
    try {
      if (e.data.type === 'station') applyState(e.data.state || {});
      else if (e.data.type === 'focus') focus(e.data.id);
    } catch (err) { post({ type: 'error', message: String(err && err.message || err) }); }
  });

  // Room names: StarNet draws none on its live floor, so a light DOM layer follows the camera and names each
  // machine's room (a click selects that machine). Positions come from the camera (World.cameraState) and the
  // floor's tile origin, calibrated each frame against World._dbgDeskClientPoint(hero) for the CRT curve.
  var labels = (function () {
    var layer = null, items = [], origin = null, tile = 12, raf = 0;
    function el() {
      if (layer) return layer;
      layer = document.createElement('div');
      layer.id = 'rigs-rooms';
      (document.getElementById('stage-wrap') || document.body).appendChild(layer); // inside the game's stacking context
      return layer;
    }
    function layout() {
      el().textContent = '';
      items = [];
      try { var g = cur.station.projectGeometry(typeof StationBake !== 'undefined' ? StationBake.WALL : {}); origin = g.origin; tile = g.TILE || 12; } catch (e) { origin = null; }
      var rooms = (cur.doc && cur.doc.rooms) || {};
      Object.keys(rooms).forEach(function (rid) {
        var rm = rooms[rid];
        if (rm.kind === 'corridor' || !rm.rects || !rm.rects[0]) return;
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'rigs-room' + (rm.kind === 'storage' ? ' off' : '');
        b.textContent = rm.name;
        b.addEventListener('click', function () { var j = toJarvis(rid); if (j) post({ type: 'select', id: j }); });
        layer.appendChild(b);
        var r = rm.rects[0];
        items.push({ b: b, x: (r.x1 + r.x2 + 1) / 2, y: r.y2 + 1 });
      });
      if (!raf) raf = requestAnimationFrame(tick);
    }
    function deskTile() {
      var props = (cur.doc && cur.doc.props) || [];
      for (var i = 0; i < props.length; i++) if (props[i].agentId === hero.id) return props[i];
      return null;
    }
    function tick() {
      raf = requestAnimationFrame(tick);
      var cv = document.getElementById('stage');
      if (!cv || !origin || !items.length || !cv.width) return;
      var cam = World.cameraState();
      var rect = cv.getBoundingClientRect();
      var sx = rect.width / cv.width, sy = rect.height / cv.height;
      var panX = cv.width / 2 - cam.cx * cam.scale, panY = cv.height / 2 - cam.cy * cam.scale;
      var k = (World.crt && +World.crt.curve) || 0;
      var curved = k > 0 && !document.body.classList.contains('no-scan');
      function client(tx, ty) {
        var x = (tx - origin.tx) * tile * cam.scale + panX, y = (ty - origin.ty) * tile * cam.scale + panY;
        if (curved) { var hw = cv.width / 2, hh = cv.height / 2, nx = (x - hw) / hw, ny = (y - hh) / hh, f = 1 - k * (nx * nx + ny * ny); x = hw + nx * f * hw; y = hh + ny * f * hh; }
        return { x: rect.left + x * sx, y: rect.top + y * sy };
      }
      // calibrate on the hero's desk, which the renderer itself can place on screen
      var dx = 0, dy = 0, d = deskTile(), real = null;
      try { real = d && World._dbgDeskClientPoint && World._dbgDeskClientPoint(hero.id); } catch (e) { real = null; }
      if (d && real) { var mine = client(d.x + d.w / 2, d.y + d.h / 2); dx = real.clientX - mine.x; dy = real.clientY - mine.y; }
      // client px → the layer's own px: StarNet's TEXT SIZE is a CSS zoom on <body>
      var box = layer.getBoundingClientRect(), z = parseFloat(getComputedStyle(document.body).zoom) || 1;
      for (var i = 0; i < items.length; i++) { var p = client(items[i].x, items[i].y); items[i].b.style.transform = 'translate(' + Math.round((p.x + dx - box.left) / z) + 'px,' + Math.round((p.y + dy - box.top) / z) + 'px) translate(-50%, 4px)'; }
    }
    return { layout: layout };
  })();

  function onReady() {
    // A static host has no sidecar: pause the bridge so the floor doesn't flag LINK DOWN (StarNet's own API for this),
    // keep the camera on the whole station (no idle follow-cam), and route clicks to the JARVIS inspector.
    try { World.pauseBridge(); } catch (e) {}
    try { World.setCinecamIdle(1e15); } catch (e) {}
    World.setOnClick(function (id) { var j = toJarvis(id); if (j) post({ type: 'select', id: j }); });
    if (World.setOnDesk) World.setOnDesk(function (o) { var j = toJarvis(o && o.agentId); if (j) post({ type: 'select', id: j }); });
    ready = true;
    load(initial.doc);
    try { World.frameReviewRoom(''); } catch (e) {} // the whole station
    applyState(pending || { key: initial.key, ids: initial.ids, rooms: initial.rooms, workers: initial.workers, hero: initial.hero });
    pending = null;
    post({ type: 'ready' });
  }
  var tries = 0;
  var wait = setInterval(function () {
    tries++;
    try {
      var game = document.getElementById('screen-game');
      if (typeof World !== 'undefined' && World.pauseBridge && game && game.classList.contains('active')) { clearInterval(wait); onReady(); return; }
    } catch (e) { /* not up yet */ }
    if (tries > 240) { clearInterval(wait); post({ type: 'error', message: 'the station did not reach its floor in 60 s' }); }
  }, 250);
})();
