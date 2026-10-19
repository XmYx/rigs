// EXPERIMENTAL — StarNet space-station view, the pure half (tested in test/starnet.test.js; no DOM, no network).
// Turns the galaxy's own data (graph.js buildGraph(visibleSnap())) into a StarNet station document plus the
// per-worker state rigs-boot.js applies inside the station iframe (ui/starnet/rigs-boot.js):
//   TAILNET → the BRIDGE room where JARVIS (the station's hero) sits, with a workbench per active plan
//   machine → a room off the central corridor (kind by platform; offline = an unlit STORAGE room with nobody in it)
//   agent session (Claude Code, Codex, OpenRig seat, Ollama) → a worker body with its own desk in its machine's room;
//     live = sits down and works, needs-you (attention) = walks to its wait anchor, otherwise it idles in its room
// The layout is a pure function of the sorted machine / worker ids, so the station only re-bakes when that set
// changes (`key`); everything else is a cheap state update. Every StarNet id maps back to the JARVIS node id
// (`ids`), so a click on a worker selects the same inspector entry as the galaxy.

const W = 14; // machine / bridge room floor, in tiles
const H = 9;
const GAP = 2; // void between neighbouring rooms, so rooms only join through the corridor
const CORRIDOR_H = 3;
export const MAX_WORKERS = 8; // desks per room (two rows of four)
const MAX_PLANS = 4;
const DESK_X = [2, 5, 8, 11];
const DESK_Y = [1, 5];
const RECENT_MS = 12 * 3600000; // an idle session older than this has gone home
const WORKER_KINDS = new Set(['claude', 'codex', 'rig', 'ollama']);
const KIND_BY_PLATFORM = { darwin: 'lab', linux: 'factory', win32: 'quarters' };
const FLOOR = { hab: 'hull', bridge: 'cobalt', lab: 'sterile', factory: 'rust', quarters: 'verdant', storage: 'rust', corridor: 'corridor' };
const COLOR = { claude: '#f5a65b', codex: '#60a5fa', rig: '#f87171', ollama: '#a3e635' };
export const HERO_ID = 'jarvis';

/** Small stable hash → base36, for StarNet-side ids that never carry JARVIS paths or session ids into the station. */
export function shortHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

function room(id, kind, name, x, y, w, h) {
  return { id, kind, name: clip(name, 22).toUpperCase(), rects: [{ x1: x, y1: y, x2: x + w - 1, y2: y + h - 1 }], floorStyle: FLOOR[kind] || 'hull', floorMat: null, wallStyle: null, wallMat: null, hullStyle: null, hullMat: null, tier: 0, floorPaint: {} };
}

/** The sessions a machine room shows as workers: agent sessions that are live, need you, or ran in the last 12 h. Pure. */
export function workersFor(nodes, machineId, attention = new Set(), now = Date.now()) {
  const out = [];
  for (const n of nodes) {
    if (n.machine !== machineId || !n.session || (n.type !== 'live' && n.type !== 'session')) continue;
    const s = n.session;
    if (!WORKER_KINDS.has(s.kind)) continue;
    const attn = attention.has(n.id);
    const working = !!s.live;
    if (!working && !attn && !(now - (s.updatedAt || 0) < RECENT_MS)) continue;
    out.push({ node: n.id, kind: s.kind, name: clip(s.project || s.title || s.kind, 18), working, attention: attn, updatedAt: s.updatedAt || 0 });
  }
  // needs-you first, then working, then most recent; ties on the node id so the order never flickers
  out.sort((a, b) => (b.attention - a.attention) || (b.working - a.working) || (b.updatedAt - a.updatedAt) || (a.node < b.node ? -1 : 1));
  return out;
}

/**
 * buildGraph() output → { key, doc, hero, workers, rooms, ids }. Pure and deterministic.
 * opts.attention: Set of JARVIS node ids that need you · opts.hidden: node types switched off in Filters · opts.now
 */
export function stationFromGraph(graph, opts = {}) {
  const hidden = new Set(opts.hidden || []);
  const attention = opts.attention instanceof Set ? opts.attention : new Set(opts.attention || []);
  const now = opts.now ?? Date.now();
  const nodes = (graph?.nodes || []).filter((n) => !hidden.has(n.type));
  const machines = nodes.filter((n) => n.type === 'machine' || n.type === 'offline')
    .sort((a, b) => (a.type === b.type ? 0 : a.type === 'machine' ? -1 : 1) || String(a.name).localeCompare(String(b.name)) || (a.id < b.id ? -1 : 1));
  const plans = nodes.filter((n) => n.type === 'plan' && n.plan?.status !== 'done').sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, MAX_PLANS);

  // Rooms: the bridge sits in the top row with every second machine around it; the rest hang below the corridor.
  const top = [];
  const bottom = [];
  machines.forEach((m, i) => (i % 2 ? top : bottom).push(m));
  const half = Math.floor(top.length / 2);
  const topRow = [...top.slice(0, half), { bridge: true }, ...top.slice(half)];
  const rowW = (n) => n * W + Math.max(0, n - 1) * GAP;
  const width = Math.max(rowW(topRow.length), rowW(bottom.length));
  const corridorY = H;
  const doc = { schema: 'starnet.station', version: 2, _nid: 1, meta: { name: 'RIGS MESH', createdAt: 0, tier: 0, spawnRoomId: 'bridge', trunkRoomId: 'corridor' }, rooms: {}, order: [], props: [], belts: {}, edges: [] };
  const ids = {}; // StarNet id (prop / body / room) → JARVIS node id
  const roomOf = {}; // JARVIS node id (machine / mesh) → StarNet room id
  const prop = (t, x, y, w, h, extra = {}) => { const p = { id: 'p' + doc._nid++, t, x, y, w, h, block: t !== 'plant', ...extra }; doc.props.push(p); return p; };
  const addRoom = (r) => { doc.rooms[r.id] = r; doc.order.push(r.id); };

  addRoom(room('corridor', 'corridor', 'CORRIDOR', 0, corridorY, width, CORRIDOR_H));
  const place = (row, y) => { const x0 = Math.floor((width - rowW(row.length)) / 2); return row.map((m, i) => ({ m, x: x0 + i * (W + GAP), y })); };
  const workers = [];
  const hero = { id: HERO_ID, name: 'JARVIS', working: plans.some((p) => p.plan?.tasks?.some((t) => t.status === 'running')) };
  for (const { m, x, y } of [...place(topRow, 0), ...place(bottom, corridorY + CORRIDOR_H)]) {
    if (m.bridge) {
      addRoom(room('bridge', 'bridge', 'BRIDGE · JARVIS', x, y, W, H));
      roomOf.mesh = 'bridge';
      ids.bridge = 'mesh';
      prop('desk', x + 6, y + 1, 2, 1, { agentId: HERO_ID });
      ids[HERO_ID] = 'mesh';
      ids[prop('comms_dish', x + 11, y, 2, 2).id] = 'mesh';
      plans.forEach((pl, i) => { ids[prop('workbench', x + DESK_X[i], y + 5, 2, 1).id] = pl.id; });
      prop('plant', x, y, 1, 1);
      prop('plant', x + W - 1, y + H - 1, 1, 1);
      continue;
    }
    const online = m.type === 'machine';
    const rid = 'm' + shortHash(m.id);
    const kind = online ? KIND_BY_PLATFORM[m.platform] || 'hab' : 'storage';
    addRoom(room(rid, kind, online ? m.name : `${m.name} · offline`, x, y, W, H));
    roomOf[m.id] = rid;
    ids[rid] = m.id;
    ids[prop('war_intelcab', x, y, 1, 2).id] = m.id;
    if (!online) continue;
    const apps = nodes.filter((n) => n.type === 'app' && n.machine === m.machine).length;
    for (let i = 0; i < Math.min(2, apps); i++) prop('gigs_servercart', x + i, y + H - 1, 1, 1);
    if (nodes.some((n) => n.type === 'tool' && n.machine === m.machine)) prop('studio', x + W - 2, y + H - 2, 2, 2);
    prop('plant', x + W - 1, y, 1, 1);
    for (const [i, w] of workersFor(nodes, m.machine, attention, now).slice(0, MAX_WORKERS).entries()) {
      const id = 'w' + shortHash(w.node);
      prop('desk', x + DESK_X[i % 4], y + DESK_Y[Math.floor(i / 4)], 2, 1, { agentId: id });
      ids[id] = w.node;
      workers.push({ id, node: w.node, name: w.name, color: COLOR[w.kind] || '#5ad0ff', room: rid, working: w.working, attention: w.attention });
    }
  }
  // The layout key: rooms + desks only. Names, colours and work state change without a re-bake.
  const key = shortHash(JSON.stringify([doc.order, doc.props.map((p) => [p.t, p.x, p.y, p.agentId || ''])]));
  return { key, doc, hero, workers, rooms: roomOf, ids };
}

/** What changed between two station states → the calls rigs-boot.js makes. Pure. */
export function diffWorkers(prev = [], next = []) {
  const before = new Map(prev.map((w) => [w.id, w]));
  const after = new Map(next.map((w) => [w.id, w]));
  const out = { spawn: [], despawn: [], rename: [], work: [], idle: [], wait: [], release: [] };
  for (const w of next) {
    const p = before.get(w.id);
    if (!p) out.spawn.push(w);
    else if (p.name !== w.name) out.rename.push(w);
    if (w.working && !p?.working) out.work.push(w.id);
    if (!w.working && p?.working) out.idle.push(w.id);
    if (w.attention && !p?.attention) out.wait.push(w.id);
    if (!w.attention && p?.attention) out.release.push(w.id);
  }
  for (const p of prev) if (!after.has(p.id)) out.despawn.push(p.id);
  return out;
}
