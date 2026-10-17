import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, RIGS_HOME } from './config.js';
import { CODEX_AUTO_PROFILE, codexAutoProfileReady, wrapperTarget } from './agentmodes.js';
import * as openrig from './openrig.js';
import { bin } from './tools.js';
import { HOME, expandHome, isWin, sleep } from './util.js';

/**
 * Persistent OpenRig rigs: one per pinned project (on the project's own machine, cwd = the project folder) and one
 * "jarvis" rig on the core-brain machine.
 *
 * A hub rig has a LEAD seat that keeps the project's context for as long as the project is pinned, plus WORKER
 * seats added on demand with the routed runtime/model/effort. Tasks reach a worker as owned queue items
 * (`rig queue create`); follow-ups go to the seat that already holds the context (`rig send`). Workers idle for
 * longer than `openrig.hubs.idleMinutes` are stopped (`rig seat stop`) and relaunched fresh when needed again;
 * the lead is never torn down by RIGS. The jarvis rig's OVERSEER seat receives Sir's instructions from the intake
 * and is the recorded source of the work fanned out to the project rigs.
 */

export const POD = 'team';
export const LEAD = 'lead';
export const JARVIS_RIG = 'jarvis';
export const OVERSEER = 'overseer';
export const GONE = /detached|stopped|exited|dead|failed/i;

export const AGENT_REF = {
  code: 'development/implementer', test: 'development/qa', review: 'review/independent-reviewer',
  research: 'research/analyst', docs: 'research/analyst', 'reverse-engineer': 'research/analyst',
  architecture: 'orchestration/orchestrator', plan: 'orchestration/orchestrator', lead: 'orchestration/orchestrator',
};

export function slug(s, n = 24) {
  return String(s || 'x').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, n) || 'x';
}

/** A short, stable tag for a seat id: claude-opus-5-5 → opus, gpt-6.1-sol → codex. */
export function modelTag(a) {
  const m = String(a.model || '').toLowerCase();
  const fam = (m.match(/opus|sonnet|haiku|fable/) || [])[0];
  if (fam) return fam;
  if (a.provider === 'codex' || a.provider === 'stub') return a.provider;
  return slug(m || a.provider || 'agent', 10);
}

export function hubSettings() {
  const h = config().openrig?.hubs || {};
  return {
    enabled: h.enabled !== false, jarvis: h.jarvis !== false,
    idleMs: Math.max(1, Number(h.idleMinutes) || 20) * 60000,
    lead: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', ...(h.lead || {}) },
    overseer: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', ...(h.overseer || {}) },
  };
}

const norm = (p) => path.resolve(expandHome(String(p || ''))).replace(/[\\/]+$/, '');
const within = (dir, root) => { const d = norm(dir); const r = norm(root); return d === r || d.startsWith(r + path.sep); };

/** The hub rig's name for a pinned folder: readable, and unique per path. */
export function hubRigName(pin) {
  const h = crypto.createHash('sha1').update(norm(pin.path)).digest('hex').slice(0, 4);
  return slug(`hub-${slug(pin.name || path.basename(norm(pin.path)), 24)}-${h}`, 40);
}

/** The pinned project a folder belongs to (the deepest pin containing it), or null. */
export function pinFor(dir, pins = config().pinnedProjects || []) {
  if (!dir) return null;
  return pins.filter((p) => p?.path && within(dir, p.path)).sort((a, b) => norm(b.path).length - norm(a.path).length)[0] || null;
}

const sessionOf = (id, rig) => `${POD}-${id}@${rig}`;

export function agentsDir() {
  const r = bin('rig');
  if (!r) return null;
  try {
    const real = wrapperTarget(r) || fs.realpathSync(r); // …/@openrig/cli/dist/bin-wrapper.js
    const dir = path.join(path.dirname(path.dirname(real)), 'daemon', 'specs', 'agents');
    return fs.existsSync(dir) ? dir : null;
  } catch { return null; }
}

const agentRef = (kind) => {
  const ref = AGENT_REF[kind] || AGENT_REF.code;
  const dir = agentsDir();
  return dir ? path.join(dir, ref) : ref;
};

export function runtimeFor(provider) {
  return provider === 'codex' ? 'codex' : provider === 'stub' ? 'stub' : 'claude-code';
}

export function memberFor({ id, kind, assign, cwd, policy }) {
  const runtime = runtimeFor(assign.provider);
  return {
    id, agentRef: agentRef(kind), runtime, cwd, model: assign.model, effort: assign.effort, role: slug(kind || 'builder', 20),
    codexProfile: runtime === 'codex' && policy !== 'builtin:yolo' && codexAutoProfileReady() ? CODEX_AUTO_PROFILE : '',
  };
}

export function memberYaml(mb, indent = '') {
  return [
    `${indent}id: ${mb.id}`,
    `${indent}agent_ref: ${JSON.stringify('path:' + mb.agentRef)}`,
    `${indent}runtime: ${mb.runtime}`,
    `${indent}profile: default`,
    `${indent}cwd: ${JSON.stringify(mb.cwd)}`,
    ...(mb.model ? [`${indent}model: ${JSON.stringify(mb.model)}`] : []),
    ...(mb.effort ? [`${indent}effort: ${JSON.stringify(mb.effort)}`] : []),
    // Codex has no auto mode of its own; under builtin:auto OpenRig launches it "at the floor", which with a named
    // profile means `-p rigs-auto`: workspace-write + network, asking only to escalate (see agentmodes.js).
    ...(mb.codexProfile ? [`${indent}codex_config_profile: ${mb.codexProfile}`] : []),
    `${indent}role: ${mb.role}`,
  ];
}

export function specYaml(rigName, summary, policy, members) {
  return [
    'version: "0.2"',
    `name: ${rigName}`,
    `summary: ${JSON.stringify(summary)}`,
    ...(policy && policy !== 'floor' ? [`permission_policy: ${policy}`] : []),
    'pods:',
    `  - id: ${POD}`,
    `    label: ${JSON.stringify(POD)}`,
    '    members:',
    ...members.flatMap((mb) => memberYaml(mb, '        ').map((l, i) => (i === 0 ? '      - ' + l.trimStart() : l))),
    '    edges: []',
    'edges: []',
    '',
  ].join('\n');
}

const parseJson = (out) => { try { return JSON.parse(out.slice(out.search(/[[{]/))); } catch { return null; } };

async function seatsOf(rig, force = true) {
  return ((await openrig.status(force)).nodes || []).filter((n) => n.rig === rig);
}

/** Is OpenRig usable on this machine right now? */
export async function available() {
  if (isWin) return false;
  const st = await openrig.status(true);
  return !!(st.installed && st.healthy !== false && st.daemon === 'running');
}

async function waitFor(session, tries = 30) {
  for (let i = 0; i < tries; i++) {
    if ((await seatsOf(session.split('@')[1])).some((n) => n.session === session && !GONE.test(n.status || ''))) return true;
    await sleep(2000);
  }
  return false;
}

/** Relaunch one dead seat with a fresh occupant (the seat keeps its id, cwd, runtime and model). A cold start can take minutes. */
async function relaunch(session) {
  await openrig.rigRun(['seat', 'clean', session], { timeout: 60000 });
  await openrig.rigRun(['seat', 'launch', session], { timeout: 300000 });
  return waitFor(session, 90);
}

/**
 * Make sure a persistent rig is up with its lead seat live. Existing → as is; stopped (reboot, `rig down`) →
 * restored with `rig up --existing`, which resumes every conversation; missing → created from a one-seat spec.
 * Returns { rig, lead, created, restored, newSeats }.
 */
export async function ensureRig({ rig, cwd, summary, leadId = LEAD, lead, kind = 'lead', policy = config().agents?.rigPolicy || 'builtin:auto', orientation }) {
  const leadSession = sessionOf(leadId, rig);
  let seats = await seatsOf(rig);
  const out = { rig, lead: leadSession, created: false, restored: false, newSeats: [] };
  if (seats.length && seats.every((n) => GONE.test(n.status || ''))) {
    const r = await openrig.rigRun(['up', rig, '--existing', '--yes', '--json'], { timeout: 300000 });
    if (await waitFor(leadSession, 45)) { out.restored = true; return out; }
    if (r.code !== 0) throw new Error('rig up --existing failed: ' + (r.stdout + r.stderr).trim().slice(-300));
    seats = await seatsOf(rig);
  }
  if (!seats.length) {
    const specDir = path.join(RIGS_HOME, 'rigs', rig);
    await fsp.mkdir(specDir, { recursive: true });
    const spec = path.join(specDir, 'rig.yaml');
    await fsp.writeFile(spec, specYaml(rig, summary || `RIGS ${rig}`, policy, [memberFor({ id: leadId, kind, assign: lead, cwd, policy })]));
    const v = await openrig.rigRun(['spec', 'validate', spec], { timeout: 30000 });
    if (v.code !== 0) throw new Error('rig spec invalid: ' + (v.stdout + v.stderr).trim().slice(-400));
    const up = await openrig.rigRun(['up', spec, '--yes', '--json'], { timeout: 300000 });
    const node = parseJson(up.stdout)?.stages?.flatMap((s) => s.detail?.nodes || [])[0];
    if ((up.code !== 0 || !node?.sessionName) && !(await waitFor(leadSession, 10))) throw new Error('rig up failed: ' + (up.stdout + up.stderr).trim().slice(-400));
    out.created = true;
    out.newSeats.push(leadSession);
    if (orientation) await queue({ seat: leadSession, summary: 'Orientation', body: orientation, source: `rigs@${config().name}`, tier: 'routine' }).catch(() => {});
    return out;
  }
  const l = seats.find((n) => n.session === leadSession);
  if (!l || GONE.test(l.status || '')) {
    if (l) { if (!(await relaunch(leadSession))) throw new Error(`the lead seat ${leadSession} did not come back`); }
    else await addSeat(rig, memberFor({ id: leadId, kind, assign: lead, cwd, policy }));
    out.newSeats.push(leadSession);
  }
  return out;
}

async function addSeat(rig, member) {
  const specDir = path.join(RIGS_HOME, 'rigs', rig);
  await fsp.mkdir(specDir, { recursive: true });
  const frag = path.join(specDir, `${member.id}.member.yaml`);
  await fsp.writeFile(frag, memberYaml(member).join('\n') + '\n');
  const add = await openrig.rigRun(['add', rig, POD, frag, '--json'], { timeout: 300000 });
  const want = sessionOf(member.id, rig);
  // The CLI can give up on the daemon while the seat is still launching ("outcome UNKNOWN"): look for the seat.
  if (parseJson(add.stdout)?.result?.node?.sessionName || (await waitFor(want))) return want;
  throw new Error('rig add failed: ' + (add.stdout + add.stderr).trim().slice(-400));
}

/**
 * A worker seat for this kind of task with this model: an idle live one (it keeps its context), a stopped one
 * relaunched, or a new one (`rig add`). Busy seats of the same kind get a sibling (…-2, …-3, at most 4).
 */
export async function ensureWorker({ rig, cwd, kind, assign, policy }) {
  const seats = await seatsOf(rig);
  const base = slug(`${kind || 'work'}-${modelTag(assign)}`, 22);
  const seat = (id) => seats.find((n) => n.session === sessionOf(id, rig));
  const busy = (n) => n && !GONE.test(n.status || '') && (n.work > 0 || /running|busy|working/i.test(n.activity || ''));
  let id = base;
  for (let k = 2; busy(seat(id)) && k <= 4; k++) id = `${base}-${k}`;
  const n = seat(id);
  const session = sessionOf(id, rig);
  if (n && !GONE.test(n.status || '')) return { seat: session, created: false };
  if (n) {
    if (await relaunch(session)) return { seat: session, created: true };
    // The stopped seat won't come back (the same wait would fail again on a retry): give the task a sibling seat.
    let k = 2;
    while (seat(`${base}-${k}`) && k < 9) k++;
    if (seat(`${base}-${k}`)) throw new Error(`worker ${session} did not come back`);
    id = `${base}-${k}`;
  }
  return { seat: await addSeat(rig, memberFor({ id, kind, assign, cwd, policy })), created: true };
}

/** An owned queue item for a seat (the durable way work enters a rig). Returns the qitem id. */
export async function queue({ seat, body, bodyFile, summary, tags = [], tier = 'routine', source }) {
  let file = bodyFile;
  if (!file) {
    const dir = path.join(RIGS_HOME, 'briefs', 'rig');
    await fsp.mkdir(dir, { recursive: true });
    file = path.join(dir, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.md`);
    await fsp.writeFile(file, body);
  }
  const qc = await openrig.rigRun(['queue', 'create', '--source', source || `rigs-planner@${config().name}`, '--destination', seat, '--body-file', file,
    '--summary', String(summary || 'work').slice(0, 120), ...(tags.length ? ['--tags', tags.join(',')] : []), '--tier', tier], { timeout: 60000 });
  const qitem = (qc.stdout.match(/qitem-[\w-]+/) || [])[0];
  if (!qitem) throw new Error('rig queue create failed: ' + (qc.stdout + qc.stderr).trim().slice(-300));
  touch(seat);
  workCache.at = 0;
  return qitem;
}

/** A follow-up typed into a seat that already holds the context. */
export async function send(seat, text) {
  const r = await openrig.rigRun(['send', seat, text], { timeout: 30000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(-200) || 'rig send failed');
  touch(seat);
  return { ok: true, seat, via: 'rig send' };
}

const leadOrientation = (pin) => `You are the LEAD seat of the persistent OpenRig team for the pinned project "${pin.name || path.basename(pin.path)}" (${pin.path}). You stay for as long as the project is pinned, so build and keep the project's context: read its AGENTS.md / CLAUDE.md / README now and skim the layout. RIGS adds worker seats to this rig on demand (one per task kind + model) and stops idle ones; tasks reach them as queue items. Sir (or JARVIS's overseer) may send you instructions directly: answer questions yourself, and hand real work to a worker with \`rig queue create --destination <seat>\` or ask RIGS for one with the jarvis_task MCP tool (project = the RIGS project for this folder). Close this orientation item when you have read in.`;

/** The hub rig for a pinned project, up with its lead. */
export function ensureHub(pin, { policy } = {}) {
  const s = hubSettings();
  return ensureRig({ rig: hubRigName(pin), cwd: norm(pin.path), summary: `RIGS hub · ${pin.name || pin.path}`, lead: s.lead, policy, orientation: leadOrientation(pin) });
}

/**
 * Run one planned task in the pinned project's hub rig, always as a queue item (so the watchdog can follow it and
 * stopping can cancel it). A retry or follow-up whose seat is still alive and idle goes to that same seat, so its
 * context carries over; everything else goes to a worker seat for the task's kind and model.
 */
export async function dispatchTask({ pin, project, task, dir, brief, pointer, policy, source }) {
  const hub = await ensureHub(pin, { policy });
  const newSeats = [...hub.newSeats];
  const follow = task.followUp || task.lastSeat;
  if (follow && follow.endsWith('@' + hub.rig)) {
    const n = (await seatsOf(hub.rig)).find((x) => x.session === follow);
    if (n && !GONE.test(n.status || '') && !(n.work > 0)) {
      const qitem = await queue({ seat: follow, bodyFile: brief, summary: `${task.title} (follow-up)`, tags: [`project:${project.id}`, `task:${task.id}`], tier: task.size === 'L' ? 'deep' : 'routine', source });
      return { mode: 'openrig', hub: true, rig: hub.rig, seat: follow, lead: hub.lead, via: 'follow-up', qitem, cwd: dir, team: true, newSeats, session: { kind: 'rig', id: follow } };
    }
  }
  const w = await ensureWorker({ rig: hub.rig, cwd: dir, kind: task.kind, assign: task.assign, policy });
  if (w.created) newSeats.push(w.seat);
  const qitem = await queue({ seat: w.seat, bodyFile: brief, summary: task.title, tags: [`project:${project.id}`, `task:${task.id}`], tier: task.size === 'L' ? 'deep' : 'routine', source });
  return { mode: 'openrig', hub: true, rig: hub.rig, seat: w.seat, lead: hub.lead, via: 'queue', qitem, cwd: dir, team: true, newSeats, session: { kind: 'rig', id: w.seat } };
}

// ------------------------------------------------------------------ idle teardown

const lastBusy = new Map(); // seat session → last time it was seen working (or given work)
function touch(seat, now = Date.now()) { lastBusy.set(seat, now); }
export function _resetIdle() { lastBusy.clear(); }

const persistent = (rig) => rig === JARVIS_RIG || /^hub-/.test(rig || '');
const isLead = (n) => n.session.startsWith(`${POD}-${LEAD}@`) || n.session.startsWith(`${POD}-${OVERSEER}@`);

/** Open queue items per destination seat. */
async function openWork() {
  const r = await openrig.rigRun(['queue', 'list', '-A', '--state', 'pending,in-progress,blocked', '--limit', '500', '--json'], { timeout: 20000 });
  const j = parseJson(r.stdout);
  const items = Array.isArray(j) ? j : j?.items || j?.qitems || [];
  const by = new Map();
  for (const q of items) { const d = q.destinationSession || q.destination; if (d) by.set(d, (by.get(d) || 0) + 1); }
  return { ok: r.code === 0 && !!j, by };
}

/**
 * Stop worker seats of persistent rigs that have been idle (no activity, no assigned or queued work) for longer
 * than the timeout. Leads and the overseer are never stopped. Returns the seats it stopped.
 */
export async function reapIdle({ now = Date.now(), idleMs = hubSettings().idleMs } = {}) {
  const st = await openrig.status(true);
  if (st.daemon !== 'running' || !st.nodesOk) return { stopped: [], skipped: 'OpenRig is not answering' };
  const work = await openWork();
  if (!work.ok) return { stopped: [], skipped: 'queue unreadable' };
  const stopped = [];
  for (const n of st.nodes || []) {
    if (!persistent(n.rig) || isLead(n) || GONE.test(n.status || '')) continue;
    const idle = /idle/i.test(n.activity || '') && !(n.work > 0) && !work.by.get(n.session);
    if (!idle) { touch(n.session, now); continue; }
    if (!lastBusy.has(n.session)) { touch(n.session, now); continue; }
    if (now - lastBusy.get(n.session) < idleMs) continue;
    const r = await openrig.rigRun(['seat', 'stop', n.session, '--reason', `RIGS: idle for ${Math.round((now - lastBusy.get(n.session)) / 60000)} min`, '--json'], { timeout: 60000 });
    if (r.code === 0) { stopped.push(n.session); lastBusy.delete(n.session); }
  }
  return { stopped };
}

// ------------------------------------------------------------------ status, up/down, send to lead (the hub UI)

let workCache = { at: 0, value: null };
let workInflight = null;
/** Open queue items per seat, at most one `rig queue list` at a time, reused for 10 s. */
function cachedWork() {
  if (workCache.value && Date.now() - workCache.at < 10000) return Promise.resolve(workCache.value);
  workInflight ||= openWork().catch(() => ({ ok: false, by: new Map() }))
    .then((value) => { workCache = { at: Date.now(), value }; return value; })
    .finally(() => { workInflight = null; });
  return workInflight;
}

function rigView(rig, st, work) {
  const seats = (st.nodes || []).filter((n) => n.rig === rig).map((n) => ({
    session: n.session, id: n.session.split('@')[0].replace(`${POD}-`, ''), role: n.role, runtime: n.runtime,
    lead: isLead(n), live: !GONE.test(n.status || ''), status: n.status, activity: n.activity, work: n.work || 0, queue: work.by.get(n.session) || 0,
  }));
  const live = seats.filter((s) => s.live);
  return {
    rig, up: live.length > 0, exists: seats.length > 0, seats,
    running: live.filter((s) => !/idle/i.test(s.activity || '') || s.work > 0).length,
    idle: live.filter((s) => /idle/i.test(s.activity || '') && !s.work).length,
    queue: seats.reduce((a, s) => a + s.queue, 0),
  };
}

/** Every pinned project's rig on this machine, plus the jarvis rig if it lives here, plus OpenRig health. */
export async function status() {
  const st = await openrig.status();
  const work = st.daemon === 'running' ? await cachedWork() : { by: new Map() };
  const pins = (config().pinnedProjects || []).map((p) => ({ path: p.path, name: p.name, ...rigView(hubRigName(p), st, work) }));
  const j = rigView(JARVIS_RIG, st, work);
  return {
    openrig: { installed: !!st.installed, healthy: st.healthy !== false, daemon: st.daemon || 'unknown', health: st.health || '' },
    pins, jarvis: j.exists ? j : null,
  };
}

export function findPin(p) {
  const pin = (config().pinnedProjects || []).find((x) => norm(x.path) === norm(p));
  if (!pin) throw new Error(`${p} is not a pinned project on ${config().name}`);
  return pin;
}

/** "Bring rig up" from the project window. */
export async function up(p) {
  if (!(await available())) throw new Error((await openrig.status()).health || 'OpenRig is not available on this machine');
  return ensureHub(findPin(p));
}

/** "Bring rig down": every seat stops; the rig record and a snapshot stay, so "up" resumes the conversations. */
export async function down(p) {
  const rig = hubRigName(findPin(p));
  const r = await openrig.rigRun(['down', rig, '--json'], { timeout: 150000 });
  if (r.code !== 0) throw new Error('rig down failed: ' + (r.stdout + r.stderr).trim().slice(-300));
  return { ok: true, rig };
}

/** "Send to lead" (or to any seat of the hub): brings the rig up first if needed. */
export async function sendToHub(p, text, seat) {
  if (!String(text || '').trim()) throw new Error('nothing to send');
  const pin = findPin(p);
  const hub = await up(pin.path);
  const to = seat && seat.endsWith('@' + hub.rig) ? seat : hub.lead;
  return { ...(await send(to, text)), newSeats: hub.newSeats, rig: hub.rig };
}

// ------------------------------------------------------------------ JARVIS's own rig

/** Is this machine the core brain's (the jarvis rig's home)? */
export function isCoreNode() {
  const n = config().brain?.core?.node;
  return !n || n === config().name || n === config().nodeId || n === 'self';
}

const overseerOrientation = () => `You are JARVIS's OVERSEER seat (rig "${JARVIS_RIG}" on ${config().name}). Sir's instructions reach you from the RIGS intake (jarvis_task / POST projects/intake) as queue items: each says which project it was filed under and which seat on which machine RIGS fanned it out to. Own each instruction until it is done: watch the seat (rig capture / mesh_session_transcript), answer its questions, send follow-ups to the SAME seat with \`rig send\` (its context carries over) rather than starting new agents, and close the queue item with a one-line outcome when the task reports done. Pinned projects each have a persistent hub rig ("hub-…") with a lead seat that knows that project — prefer routing project questions to its lead. Report to Sir with mesh_notify. Close this orientation item now.`;

export function ensureJarvis() {
  const s = hubSettings();
  return ensureRig({ rig: JARVIS_RIG, cwd: HOME, summary: 'JARVIS · overseer', leadId: OVERSEER, lead: s.overseer, kind: 'lead', orientation: overseerOrientation() });
}

/** The overseer's session if the jarvis rig is up (cheap: cached status). */
export async function overseer() {
  const st = await openrig.status();
  const n = (st.nodes || []).find((x) => x.rig === JARVIS_RIG && x.session === sessionOf(OVERSEER, JARVIS_RIG));
  return n && !GONE.test(n.status || '') ? n.session : null;
}

/** Hand Sir's instruction to the overseer as an owned queue item, with where RIGS fanned it out. */
export function overseerIntake({ instruction, project, task, run }) {
  const where = run?.seat ? `OpenRig seat ${run.seat} (rig ${run.rig}) on ${task.assign?.node}${run.qitem ? `, queue item ${run.qitem}` : ''}` : run?.session ? `${run.session.kind} session ${run.session.id} on ${task.assign?.node} (no OpenRig there — a direct agent)` : 'not started yet';
  const body = `Sir's instruction (filed by the RIGS intake):\n\n${instruction}\n\nProject: ${project.name} (${project.id}, owner ${project.owner}) · task ${task.id} “${task.title}” · ${task.kind}/${task.size}\nRouted to: ${task.assign ? `${task.assign.provider} ${task.assign.model || ''} ${task.assign.effort || ''} on ${task.assign.node}` : 'no machine yet'}\nRunning in: ${where}\n\nOversee it to done (see your orientation). Close this item when the task is reported done, failed or blocked.`;
  return overseer().then((seat) => (seat ? queue({ seat, body, summary: `Sir: ${task.title}`, tags: [`project:${project.id}`, `task:${task.id}`, 'intake'], source: `rigs-intake@${config().name}` }).then((qitem) => ({ seat, qitem })) : null));
}

/** Background upkeep on every node: the jarvis rig on the core node; idle workers stopped everywhere. */
let keeping = null;
export function keep() {
  // One pass at a time: bringing a rig up can take minutes, longer than the interval.
  if (keeping) return Promise.resolve({ busy: true });
  keeping = (async () => {
    const s = hubSettings();
    if (!s.enabled || !(await available())) return { skipped: true };
    const out = {};
    if (s.jarvis && isCoreNode()) out.jarvis = await ensureJarvis().catch((e) => ({ error: e.message }));
    out.reaped = await reapIdle().catch((e) => ({ error: e.message }));
    return out;
  })().finally(() => { keeping = null; });
  return keeping;
}
