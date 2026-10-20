// YOLO window model (ui/src/yolo.js): the pure part — a run's events (src/yolo.js contract: yolo-start, yolo-update,
// yolo-done, which can arrive twice, on /ws and in the jarvis/send stream; yolo-kept on /ws) folded into the state the
// window shows, and the Keep as app button. No DOM. Unit-tested in test/yolo-ui.test.js.

export const YOLO_TYPES = ['yolo-start', 'yolo-update', 'yolo-done', 'yolo-kept'];
export const isYoloEvent = (m) => !!m && YOLO_TYPES.includes(m.type) && typeof m.runId === 'string' && m.runId !== '';

/** The key an event is deduped by: (type, runId, step). Starts carry no step. */
export const eventKey = (m) => `${m.type}|${m.runId}|${m.step ?? ''}`;

/** A run's initial state from its yolo-start. `url` already goes through the node proxy (works from any machine's UI). */
export function startRun(m) {
  return {
    runId: m.runId, title: m.title || m.task || 'YOLO', task: m.task || '', node: m.node || '',
    url: m.url || (m.node ? `/api/nodes/${encodeURIComponent(m.node)}/yolo/${encodeURIComponent(m.runId)}/` : ''),
    status: 'live', step: 0, activity: 'Starting…', files: [], reloads: 0, errors: 0, ok: null, summary: '',
    startedAt: Number(m.at) || 0, endedAt: 0, timeToFirstFrameMs: null, keptAs: m.keptAs || null,
  };
}

/**
 * Fold one event into the state. Returns the same object when the event changes nothing (a duplicate, a stale step,
 * another run's event), so callers can skip a render. `reloads` counts the updates that should reload the frame.
 */
export function applyEvent(state, m) {
  if (!state || !isYoloEvent(m) || m.runId !== state.runId) return state;
  if (m.type === 'yolo-update') {
    if (state.status !== 'live') return state;
    if (Number.isFinite(m.step) && m.step <= state.step) return state; // the /ws and stream copies of one update
    return { ...state, step: Number.isFinite(m.step) ? m.step : state.step + 1, activity: prettyActivity(m.activity) || state.activity, files: Array.isArray(m.files) ? m.files : state.files, reloads: state.reloads + 1 };
  }
  if (m.type === 'yolo-done') {
    if (state.status !== 'live') return state;
    return {
      ...state, status: m.ok ? 'done' : 'failed', ok: !!m.ok, summary: m.summary || '', endedAt: Number(m.at) || Date.now(),
      timeToFirstFrameMs: m.timeToFirstFrameMs ?? null, errors: Math.max(state.errors, Number(m.errors) || 0),
      activity: m.ok ? 'Done' : (m.summary || 'Stopped'),
    };
  }
  if (m.type === 'yolo-kept') return withKept(state, m.keptAs);
  return state; // a repeated yolo-start
}

/** The run was kept as an app (yolo-kept, the …/keep answer or the run's meta on open). Same object when nothing changes. */
export function withKept(state, keptAs) {
  if (!state || !keptAs?.id || (state.keptAs?.id === keptAs.id && state.keptAs?.node === keptAs.node)) return state;
  return { ...state, keptAs };
}

/** The agent's tool step for a strip: `Write {"file_path":"/x/index.html"}` → `Write index.html`. Plain text passes through. */
export function prettyActivity(text) {
  const t = String(text || '').trim();
  const m = t.match(/^(\S+)\s+(\{[\s\S]*\})$/);
  if (!m) return t;
  try {
    const i = JSON.parse(m[2]);
    const arg = i.file_path || i.path || i.command || i.pattern || i.url || '';
    return arg ? `${m[1]} ${String(arg).split('/').pop().replace(/\s+/g, ' ').slice(0, 80)}` : m[1];
  } catch { return t; }
}

/** Runtime errors the page reported: GET …/errors → the count (the server's `total` includes dropped ones). */
export const errorCount = (r) => Math.max(0, Number(r?.total) || (Array.isArray(r?.errors) ? r.errors.length : 0) || 0);

/** "0:07", "1:23". Ends at endedAt for a finished run. */
export function elapsed(state, now = Date.now()) {
  const from = state.startedAt || now;
  const s = Math.max(0, Math.floor(((state.endedAt || now) - from) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const STATUS_LABEL = { live: 'live', done: 'done', failed: 'failed' };
export const windowTitle = (s) => `YOLO — ${s.title}${s.node ? ` · ${s.node}` : ''}`;
const base = (s) => (s.url.endsWith('/') ? s.url : `${s.url}/`);
export const stopUrl = (s) => `${base(s)}stop`;
export const errorsUrl = (s) => `${base(s)}errors`;
export const keepUrl = (s) => `${base(s)}keep`;
export const metaUrl = (s) => `${base(s)}meta`;

/**
 * The Keep as app button for a run and the step it is at ('' · 'asking' · 'stopping' · 'keeping'):
 * { label, title, disabled, kept }. A kept run reads '★ Kept' and opens the app; a live run is stopped first.
 */
export function keepButton(state, phase = '') {
  if (state?.keptAs?.id) return { label: '★ Kept', title: `Kept as ${state.keptAs.name || state.keptAs.id} — open it`, disabled: false, kept: true };
  if (phase === 'stopping') return { label: '★ Stopping…', title: 'Stopping the agent first', disabled: true, kept: false };
  if (phase === 'keeping') return { label: '★ Keeping…', title: 'Publishing it to the App Cloud', disabled: true, kept: false };
  const live = state?.status === 'live';
  return { label: '★ Keep as app', title: live ? 'Stop the agent and keep this page as an App Cloud app' : 'Keep this page as an App Cloud app', disabled: phase === 'asking', kept: false };
}

/** The POST …/keep body from the form: the name (else the run title) and an optional icon. Pure. */
export function keepBody({ name = '', icon = '' } = {}, state = {}) {
  const n = String(name).replace(/\s+/g, ' ').trim() || state.title || '';
  const i = String(icon).trim();
  return { ...(n ? { name: n.slice(0, 80) } : {}), ...(i ? { icon: i.slice(0, 16) } : {}) };
}

/**
 * The app to open for a kept run (the Apps list's opener takes it): the catalog entry when the catalog has it, else one
 * built from keptAs (with a launch marker, so the opener starts it on its machine first when it is down). Pure.
 */
export function keptApp(keptAs, catalog = [], fromServer = null) {
  if (!keptAs?.id) return null;
  const hit = catalog.find((a) => a.id === keptAs.id && (a.node === keptAs.node || a.nodeId === keptAs.node));
  if (hit) return hit;
  if (fromServer?.id === keptAs.id) return { ...fromServer, node: keptAs.node };
  return { id: keptAs.id, node: keptAs.node, name: keptAs.name || keptAs.id, icon: keptAs.icon || '⚡', health: { status: 'unknown' }, launchHere: { kept: true } };
}
