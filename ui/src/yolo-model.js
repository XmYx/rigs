// YOLO window model (ui/src/yolo.js): the pure part — a run's events (src/yolo.js contract: yolo-start, yolo-update,
// yolo-done, which can arrive twice, on /ws and in the jarvis/send stream; yolo-kept on /ws; YOLOv2: yolo-message and
// yolo-icon, and a yolo-done per turn with idle: true) folded into the state the window shows, the conversation pane's
// logic (message merge, composer, feedback bundle, hidden state), the suggested icon and the Keep as app button. No DOM.
// Unit-tested in test/yolo-ui.test.js.

export const YOLO_TYPES = ['yolo-start', 'yolo-update', 'yolo-done', 'yolo-kept', 'yolo-message', 'yolo-icon'];
export const DEFAULT_ICON = '⚡';
export const isYoloEvent = (m) => !!m && YOLO_TYPES.includes(m.type) && typeof m.runId === 'string' && m.runId !== '';

/**
 * The key an event is deduped by: (type, runId, step). Starts carry no step. A YOLOv2 run is idle after each turn, and a
 * turn that wrote nothing ends at the same step as the last one, so a done also keys on its turn; a message on its role,
 * turn and time; an icon on when it was suggested.
 */
export const eventKey = (m) => {
  const extra = m.type === 'yolo-message' ? `${m.role}|${m.turn ?? ''}|${m.at ?? ''}` : m.type === 'yolo-icon' ? `${m.icon?.at ?? m.at ?? ''}` : m.type === 'yolo-done' ? `${m.turn ?? ''}` : '';
  return `${m.type}|${m.runId}|${m.step ?? ''}|${extra}`;
};

/** A run's initial state from its yolo-start. `url` already goes through the node proxy (works from any machine's UI). */
export function startRun(m) {
  return {
    runId: m.runId, title: m.title || m.task || 'YOLO', task: m.task || '', node: m.node || '',
    url: m.url || (m.node ? `/api/nodes/${encodeURIComponent(m.node)}/yolo/${encodeURIComponent(m.runId)}/` : ''),
    status: 'live', step: 0, activity: 'Starting…', files: [], reloads: 0, errors: 0, ok: null, summary: '',
    startedAt: Number(m.at) || 0, endedAt: 0, timeToFirstFrameMs: null, keptAs: m.keptAs || null,
    v2: !!m.v2, turn: 1, messages: [], icon: null,
  };
}

/**
 * Fold one event into the state. Returns the same object when the event changes nothing (a duplicate, a stale step,
 * another run's event), so callers can skip a render. `reloads` counts the updates that should reload the frame.
 */
export function applyEvent(state, m) {
  if (!state || !isYoloEvent(m) || m.runId !== state.runId) return state;
  if (m.type === 'yolo-update') {
    if (state.status !== 'live' && !(state.status === 'idle')) return state;
    if (Number.isFinite(m.step) && m.step <= state.step) return state; // the /ws and stream copies of one update
    // A YOLOv2 follow-up turn is writing (its yolo-message may not have reached this socket): the run is live again.
    return { ...state, ...(state.status === 'idle' ? { status: 'live', endedAt: 0 } : {}), step: Number.isFinite(m.step) ? m.step : state.step + 1, activity: prettyActivity(m.activity) || state.activity, files: Array.isArray(m.files) ? m.files : state.files, reloads: state.reloads + 1 };
  }
  if (m.type === 'yolo-done') {
    const turn = Number(m.turn) || 0;
    if (m.idle) { // YOLOv2: the turn ended, the run waits for feedback
      if (state.status !== 'live' && !(turn > state.turn)) return state;
      return {
        ...state, status: 'idle', ok: !!m.ok, summary: m.summary || '', endedAt: Number(m.at) || Date.now(), turn: Math.max(state.turn, turn),
        timeToFirstFrameMs: state.timeToFirstFrameMs ?? m.timeToFirstFrameMs ?? null, errors: Math.max(state.errors, Number(m.errors) || 0),
        activity: m.ok ? 'Ready for your feedback' : (m.summary || 'Stopped — ready for your feedback'),
      };
    }
    if (state.status !== 'live') return state;
    return {
      ...state, status: m.ok ? 'done' : 'failed', ok: !!m.ok, summary: m.summary || '', endedAt: Number(m.at) || Date.now(),
      timeToFirstFrameMs: m.timeToFirstFrameMs ?? null, errors: Math.max(state.errors, Number(m.errors) || 0),
      activity: m.ok ? 'Done' : (m.summary || 'Stopped'),
    };
  }
  if (m.type === 'yolo-kept') return withKept(state, m.keptAs);
  if (m.type === 'yolo-icon') return withIcon(state, m.icon);
  if (m.type === 'yolo-message') {
    const messages = mergeMessages(state.messages, [m]);
    const turn = Number(m.turn) || state.turn;
    // A user message past the current turn starts a follow-up turn: the run is live again, its clock restarts.
    if (m.role === 'user' && turn > state.turn && state.status === 'idle') {
      return { ...state, v2: true, messages, turn, status: 'live', ok: null, summary: '', startedAt: Number(m.at) || Date.now(), endedAt: 0, activity: 'Working on your feedback…' };
    }
    return messages === state.messages ? state : { ...state, v2: true, messages, turn: Math.max(state.turn, turn) };
  }
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

export const STATUS_LABEL = { live: 'live', idle: 'ready', done: 'done', failed: 'failed' };
export const windowTitle = (s) => `YOLO — ${s.title}${s.node ? ` · ${s.node}` : ''}`;
const base = (s) => (s.url.endsWith('/') ? s.url : `${s.url}/`);
export const stopUrl = (s) => `${base(s)}stop`;
export const errorsUrl = (s) => `${base(s)}errors`;
/**
 * A window opened for a run (its yolo-start) folded with the run's meta (GET …/meta): keptAs, and — when the run has
 * already ended (a window reopened later) — its end, as its yolo-done would have said. Same object when nothing changes.
 */
export function withMeta(state, meta) {
  if (!state || !meta || meta.runId !== state.runId) return state;
  let s = withIcon(withKept(state, meta.keptAs), meta.icon);
  if (meta.v2 || Array.isArray(meta.messages)) {
    const v2 = !!meta.v2 || s.v2;
    const turn = Math.max(s.turn, Number(meta.turn) || 1);
    if (v2 !== s.v2 || turn !== s.turn) s = { ...s, v2, turn };
    const messages = mergeMessages(s.messages, meta.messages);
    if (messages !== s.messages) s = { ...s, messages };
  }
  if (meta.v2 && meta.status === 'idle' && s.status === 'live') {
    s = applyEvent(s, { type: 'yolo-done', runId: s.runId, ok: meta.ok !== false, summary: meta.summary, errors: meta.errors, at: meta.endedAt, idle: true, turn: meta.turn || 1,
      timeToFirstFrameMs: meta.firstFrameAt && meta.startedAt ? Math.max(0, meta.firstFrameAt - meta.startedAt) : null });
    s = { ...s, step: Math.max(s.step, Number(meta.updates) || 0) };
  } else if (s.status === 'live' && ['done', 'failed', 'stopped'].includes(meta.status)) {
    s = applyEvent(s, { type: 'yolo-done', runId: s.runId, ok: !!meta.ok, summary: meta.summary || (meta.status === 'stopped' ? 'Stopped' : ''), errors: meta.errors, at: meta.endedAt,
      timeToFirstFrameMs: meta.firstFrameAt && meta.startedAt ? Math.max(0, meta.firstFrameAt - meta.startedAt) : null });
    s = { ...s, step: Math.max(s.step, Number(meta.updates) || 0) };
  }
  return s;
}

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

/**
 * The Keep form's icon field: the agent's suggested emoji as its value (left empty otherwise, so an empty field lets the
 * server use the suggested SVG or ⚡), and a placeholder that says which. Pure.
 */
export function keepIconField(state) {
  const emoji = state?.icon?.emoji ? String(state.icon.emoji).trim() : '';
  return { value: emoji, placeholder: emoji || (state?.icon?.svg ? 'agent’s icon' : DEFAULT_ICON) };
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

// ── YOLOv2: the conversation, the composer, the suggested icon ───────────────────────────────────────────────────────

const messageKey = (m) => `${m.role}|${m.turn ?? ''}|${m.at ?? ''}|${String(m.text ?? '').slice(0, 40)}`;

/**
 * The run's messages merged with `incoming` (yolo-message events, or meta.messages): deduped by role, turn, time and text
 * start, oldest first, capped at 200 like the server's. Same array when nothing is new.
 */
export function mergeMessages(current = [], incoming = []) {
  const have = new Set(current.map(messageKey));
  const fresh = [];
  for (const m of Array.isArray(incoming) ? incoming : []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.text !== 'string') continue;
    const k = messageKey(m);
    if (have.has(k)) continue;
    have.add(k);
    const { runId, type, ...rest } = m; // eslint-disable-line no-unused-vars
    fresh.push(rest);
  }
  if (!fresh.length) return current;
  return [...current, ...fresh].sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0) || (a.turn ?? 0) - (b.turn ?? 0)).slice(-200);
}

/** The agent's suggested icon (yolo-icon / meta.icon: { emoji?, svg?, at }). Same object when it adds nothing. */
export function withIcon(state, icon) {
  if (!state || !icon || (typeof icon !== 'object') || (!icon.emoji && !icon.svg)) return state;
  const cur = state.icon;
  if (cur && cur.emoji === icon.emoji && cur.svg === icon.svg) return state;
  return { ...state, icon: { ...(icon.emoji ? { emoji: String(icon.emoji) } : {}), ...(icon.svg ? { svg: String(icon.svg) } : {}), at: icon.at || 0 } };
}

/**
 * What to show for the run's icon, for the title bar and the dock entry: { text, img } — `text` is always set (the
 * emoji, else ⚡: the dock only draws text), `img` is the sandbox SVG's URL for the title bar when there is one and no emoji.
 */
export function iconView(state) {
  const ic = state?.icon;
  const emoji = ic?.emoji ? String(ic.emoji).trim() : '';
  if (emoji) return { text: emoji, img: '' };
  if (ic?.svg && state.url && !/^[a-z]+:|^\/\/|\.\.\//i.test(ic.svg)) return { text: DEFAULT_ICON, img: `${base(state)}${String(ic.svg).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}` };
  return { text: DEFAULT_ICON, img: '' };
}

export const messageUrl = (s) => `${base(s)}message`;
export const FEEDBACK_MAX_CONSOLE = 20;
export const SCREENSHOT_MAX = 4 * 1024 * 1024;

/**
 * Can the user send now, and what does the composer say? A turn runs → disabled (the server does not queue: 409), a run
 * that is not YOLOv2 → no composer at all. { shown, disabled, placeholder, hint }.
 */
export function composerState(state, sending = false) {
  if (!state?.v2) return { shown: false, disabled: true, placeholder: '', hint: '' };
  if (sending) return { shown: true, disabled: true, placeholder: 'Sending…', hint: 'Sending…' };
  if (state.status === 'live') return { shown: true, disabled: true, placeholder: 'The agent is working — you can test the page meanwhile', hint: 'Messages are not queued: send when this turn ends.' };
  if (state.status === 'idle') return { shown: true, disabled: false, placeholder: 'Tell the agent what to change…', hint: 'Enter sends, Shift+Enter adds a line.' };
  return { shown: true, disabled: true, placeholder: 'This run is over', hint: 'This run ended and takes no more messages.' };
}

/** A page error report as one console line for the feedback bundle. */
export const errorLine = (e) => `${e.type ? `${e.type}: ` : ''}${String(e.message || '').slice(0, 300)}${e.source ? ` (${String(e.source).split('/').pop()}${e.line ? `:${e.line}` : ''})` : ''}`;

/**
 * The POST …/message body for a message or a 'Send feedback': the note plus the page errors since the last turn
 * (`errors`: GET …/errors entries, newest last) and an optional screenshot data URL. A feedback with no note says so.
 */
export function messageBody({ text = '', errors = [], screenshot = '', feedback = false } = {}) {
  const note = String(text).trim();
  const lines = (Array.isArray(errors) ? errors : []).slice(-FEEDBACK_MAX_CONSOLE).map(errorLine).filter(Boolean);
  if (!feedback && !screenshot) return { text: note };
  const fb = { ...(note ? { text: note } : {}), ...(lines.length ? { console: lines } : {}), ...(screenshot ? { screenshot } : {}) };
  return { text: note || (lines.length ? 'The page shows errors — please fix them.' : 'Feedback on the page.'), feedback: fb };
}

/** Can this be sent? A message needs text; a feedback needs a note, errors or a screenshot. */
export const canSendBody = (b) => !!b && (!!b.text || !!b.feedback);

// The conversation pane's shown / hidden choice: remembered per window (run), collapsed by default on a narrow screen.
export const CONVO_KEY = 'rigs.yolo.convoHidden';
export const CONVO_CAP = 60;

/** Parse the stored map {runId: hidden}; anything else → {}. */
export function readHiddenMap(raw) {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, b]) => typeof b === 'boolean'));
  } catch { return {}; }
}
/** Is the conversation hidden for this run? A saved choice wins; none → hidden on a narrow screen, shown otherwise. */
export const convoHidden = (map, runId, narrow = false) => (typeof map?.[runId] === 'boolean' ? map[runId] : !!narrow);
/** The map with this run's choice set (the oldest entries drop past CONVO_CAP). */
export function withConvoHidden(map, runId, hidden) {
  const next = { ...readHiddenMap(map) };
  delete next[runId]; // re-insert last: insertion order = recency
  next[runId] = !!hidden;
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - CONVO_CAP))) delete next[k];
  return next;
}
/** The toggle button for the pane: { label, title, pressed }. */
export function convoToggle(hidden, count = 0) {
  const n = count ? ` (${count})` : '';
  return { label: hidden ? `💬 Show chat${n}` : '💬 Hide chat', title: hidden ? 'Show the conversation' : 'Hide the conversation', pressed: !hidden };
}

/** A follow-up the server accepted (the …/message answer) before its yolo-message arrives: the run is live again on that turn. */
export const turnStarted = (state, turn, at = Date.now()) => (state.status === 'live' ? state
  : { ...state, status: 'live', turn: Math.max(state.turn, Number(turn) || state.turn + 1), ok: null, summary: '', startedAt: at, endedAt: 0, activity: 'Working on your feedback…' });

// ── The shared history (GET /api/local/yolo/history: one list of every machine's past runs) ──────────────────────────
// Rows come from src/yolo.js historyRow: { node, runId, title, task, status, createdAt, finishedAt, v2, turn, icon, keptAs,
// url, available }. Everything here is pure: row building, sort, filter, and "open it or focus the window it already has".

export const HISTORY_URL = '/api/local/yolo/history?limit=200';

/** The server's run status → what the list shows: { key, label } (key is the row's CSS class). */
export function historyStatus(status) {
  switch (status) {
    case 'running': return { key: 'live', label: 'running' };
    case 'idle': return { key: 'idle', label: 'idle' };
    case 'done': return { key: 'done', label: 'done' };
    case 'stopped': return { key: 'failed', label: 'stopped' };
    case 'interrupted': return { key: 'failed', label: 'interrupted' };
    case 'failed': return { key: 'failed', label: 'failed' };
    default: return { key: 'unknown', label: String(status || 'unknown') };
  }
}

/** "just now", "5m ago", "3h ago", "2d ago", "4mo ago", "2y ago". */
export function ageText(at, now = Date.now()) {
  const t = Number(at) || 0;
  if (!t) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const hr = Math.round(s / 3600);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(s / 86400);
  if (d < 60) return `${d}d ago`;
  if (d < 730) return `${Math.round(d / 30)}mo ago`;
  return `${Math.round(d / 365)}y ago`;
}

/** The identity of a run on the mesh. */
export const historyKey = (r) => `${r.node}/${r.runId}`;

/** The icon to draw in a list row: the agent's emoji, else ⚡ (an SVG icon needs the run's sandbox, so the list stays text). */
export const rowIcon = (icon) => (icon?.emoji ? String(icon.emoji).trim() : '') || DEFAULT_ICON;

/**
 * The history answer → the rows to draw, newest first. `openIds` = the runIds with a window open; `now` is for the age.
 * Row: { key, runId, node, icon, title, age, at, finishedAt, status: {key, label}, kept: {id, name, node}|null, available, open, v2, url,
 * search } — `search` is the lowercase text the filter looks in. Rows without a runId are dropped; a duplicate (node, runId)
 * keeps its first (the newest answer).
 */
export function buildRows(history, { openIds = [], now = Date.now() } = {}) {
  const open = new Set(openIds);
  const seen = new Set();
  const rows = [];
  for (const r of Array.isArray(history?.runs) ? history.runs : []) {
    if (!r || typeof r.runId !== 'string' || !r.runId || !r.node) continue;
    const key = historyKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    const title = String(r.title || r.task || '').replace(/\s+/g, ' ').trim() || 'YOLO';
    const at = Number(r.createdAt) || 0;
    const kept = r.keptAs?.id ? { id: r.keptAs.id, name: r.keptAs.name || r.keptAs.id, node: r.keptAs.node || r.node } : null;
    rows.push({
      key, runId: r.runId, node: r.node, icon: rowIcon(r.icon), title, age: ageText(at, now), at, finishedAt: Number(r.finishedAt) || 0, status: historyStatus(r.status), kept,
      available: r.available !== false, open: open.has(r.runId), v2: !!r.v2, turn: Number(r.turn) || 1,
      url: r.url || `/api/nodes/${encodeURIComponent(r.node)}/yolo/${encodeURIComponent(r.runId)}/`,
      search: `${title} ${r.task || ''} ${r.node} ${kept?.name || ''}`.toLowerCase(),
    });
  }
  return sortRows(rows);
}

/** Newest first; available before cached on a tie so a live machine's copy is the one in front. */
export const sortRows = (rows) => [...rows].sort((a, b) => b.at - a.at || Number(b.available) - Number(a.available) || a.key.localeCompare(b.key));

/** Rows matching the text (every word, anywhere in title / task / machine / app name) and the machine ('' = all). */
export function filterRows(rows, { text = '', node = '' } = {}) {
  const words = String(text).toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => (!node || r.node === node) && words.every((w) => r.search.includes(w)));
}

/** The machines in the list, for the filter's menu: [{ node, count, available }] by name. */
export function machinesOf(rows) {
  const by = new Map();
  for (const r of rows) {
    const m = by.get(r.node) || { node: r.node, count: 0, available: false };
    m.count += 1;
    m.available = m.available || r.available;
    by.set(r.node, m);
  }
  return [...by.values()].sort((a, b) => a.node.localeCompare(b.node));
}

/** The line under the list: how many are shown, and which machines answered from the cache only. */
export function historySummary(shown, total, history) {
  const cached = Object.entries(history?.nodes || {}).filter(([, n]) => n && n.ok === false).map(([name]) => name).sort();
  const count = shown === total ? `${total} run${total === 1 ? '' : 's'}` : `${shown} of ${total} runs`;
  return cached.length ? `${count} · ${cached.join(', ')} not reachable — shown from the last answer, greyed out` : count;
}

/** What a click on a row does: nothing for a greyed (unreachable) row, focus for a run whose window is open, else open. */
export function rowAction(row, openIds = []) {
  if (!row?.available) return 'none';
  return (openIds instanceof Set ? openIds.has(row.runId) : openIds.includes(row.runId)) ? 'focus' : 'open';
}

/**
 * The window state for a past run, before its meta arrives (GET …/meta then adds the conversation and the end, withMeta):
 * the row's status decides what the strip and the composer show. A run that is still running opens live.
 */
export function stateFromRow(row) {
  const s = startRun({ runId: row.runId, title: row.title, node: row.node, url: row.url, at: row.at, keptAs: row.kept, v2: row.v2 });
  const st = row.status?.key;
  const ended = row.finishedAt || row.at;
  if (st === 'idle') return { ...s, status: 'idle', ok: true, turn: row.turn, endedAt: ended, activity: 'Ready for your feedback' };
  if (st === 'done') return { ...s, status: 'done', ok: true, turn: row.turn, endedAt: ended, activity: 'Done' };
  if (st === 'failed' || st === 'unknown') return { ...s, status: 'failed', ok: false, turn: row.turn, endedAt: ended, activity: row.status.label === 'unknown' ? 'Stopped' : `Run ${row.status.label}` };
  return { ...s, turn: row.turn };
}

/** "show my yolo history", "open yolo history", "my past yolo runs": the JARVIS box opens the list itself, no brain, never work. */
export const isHistoryAsk = (text) => /^(?:(?:please|can you|could you)\s+)*(?:(?:show|open|list|browse|see|view)\s+(?:me\s+)?(?:all\s+)?(?:(?:my|the|our|all)\s+)*(?:(?:past|previous|old|earlier|recent)\s+)?yolo\s*(?:history|runs|sessions)|yolo\s+(?:history|runs|sessions))(?:\s+(?:please|window|panel|list))?\s*[.!?]*$/i.test(String(text || '').trim());
