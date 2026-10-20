// YOLO window model (ui/src/yolo.js): the pure part — a run's events (src/yolo.js contract: yolo-start, yolo-update,
// yolo-done, which can arrive twice, on /ws and in the jarvis/send stream) folded into the state the window shows.
// No DOM. Unit-tested in test/yolo-ui.test.js.

export const YOLO_TYPES = ['yolo-start', 'yolo-update', 'yolo-done'];
export const isYoloEvent = (m) => !!m && YOLO_TYPES.includes(m.type) && typeof m.runId === 'string' && m.runId !== '';

/** The key an event is deduped by: (type, runId, step). Starts carry no step. */
export const eventKey = (m) => `${m.type}|${m.runId}|${m.step ?? ''}`;

/** A run's initial state from its yolo-start. `url` already goes through the node proxy (works from any machine's UI). */
export function startRun(m) {
  return {
    runId: m.runId, title: m.title || m.task || 'YOLO', task: m.task || '', node: m.node || '',
    url: m.url || (m.node ? `/api/nodes/${encodeURIComponent(m.node)}/yolo/${encodeURIComponent(m.runId)}/` : ''),
    status: 'live', step: 0, activity: 'Starting…', files: [], reloads: 0, errors: 0, ok: null, summary: '',
    startedAt: Number(m.at) || 0, endedAt: 0, timeToFirstFrameMs: null,
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
  return state; // a repeated yolo-start
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
