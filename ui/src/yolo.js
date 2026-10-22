import { api, h, toast } from './api.js';
import { appsCatalog, openApp, refreshApps } from './apps.js';
import { openWindow } from './wm.js';
import { isPhone } from './mobile.js';
import { CONVO_KEY, HISTORY_URL, SCREENSHOT_MAX, STATUS_LABEL, applyEvent, buildRows, filterRows, historySummary, machinesOf, rowAction, stateFromRow, canSendBody, composerState, convoHidden, convoToggle, elapsed, errorCount, errorsUrl, eventKey, iconView, isYoloEvent, keepBody, keepButton, keepIconField, keepUrl, keptApp, messageBody, messageUrl, metaUrl, readHiddenMap, startRun, stopUrl, turnStarted, windowTitle, withConvoHidden, withKept, withMeta } from './yolo-model.js';

// YOLO windows: "yolo a bouncing ball in p5" opens a floating window the moment the daemon pushes yolo-start (before the
// agent writes anything), shows the run's sandbox page in an iframe through /api/nodes/<node>/yolo/<runId>/ (so a run
// on another machine looks the same), reloads it on every yolo-update and settles a slim status strip on yolo-done.
// Events (src/yolo.js has the contract) arrive on /ws and in the jarvis/send stream: onYoloEvent takes both and dedupes.
// A finished window stays until closed; several runs make several windows. Window chrome (tiling, docking, the phone
// full-screen sheet) is wm.js's. ★ Keep as app asks for a name (prefilled from the run title) and an icon, stops a live
// run first, POSTs …/keep through the run's node (src/yolo-keep.js) and opens the new app with the Apps list's opener;
// a kept run (yolo-kept, or keptAs in the run's meta when the window opens) reads ★ Kept and opens its app.
// YOLOv2 runs (config.yolo.v2) add a conversation pane in the same window: the run's messages, the agent's current step,
// a composer (POST …/message; disabled while a turn runs, the server does not queue) and ✉ Send feedback, which bundles
// the note with the page errors since the last turn (and an optional screenshot). The pane is hidden or shown with a
// toggle: remembered per window, hidden by default on a phone. The page keeps reloading on yolo-update, so the user can
// test while the agent works. The agent's suggested icon (yolo-icon / meta.icon) replaces ⚡ in the title bar and the dock.

const runs = new Map(); // runId → { state, win, frame, ... }
const seen = new Set();

/** Feed a yolo-* event from either path. Anything else is ignored. */
export function onYoloEvent(m) {
  if (!isYoloEvent(m)) return;
  const k = eventKey(m);
  if (seen.has(k)) return;
  seen.add(k);
  if (seen.size > 2000) seen.delete(seen.values().next().value);
  let r = runs.get(m.runId);
  if (!r) {
    if (m.type !== 'yolo-start') return; // an update for a run whose window was closed
    r = openRun(startRun(m));
    runs.set(m.runId, r);
    return;
  }
  const prev = r.state;
  r.state = applyEvent(prev, m);
  if (r.state === prev) return;
  render(r);
  if (m.type === 'yolo-update') postReload(r);
  if (m.type === 'yolo-done') finish(r);
  if (m.type === 'yolo-message' && m.role === 'assistant' && r.state.status === 'live' && r.state.v2) postReload(r);
}

/** For tests and the context menu: the runs with an open window. */
export const openYoloRuns = () => [...runs.keys()];

function postReload(r) {
  try { r.frame.contentWindow?.postMessage({ type: 'yolo-reload' }, '*'); } catch { /* the page's own SSE reloads it too */ }
}

function reload(r) { r.frame.src = r.state.url; } // a fresh load; the in-page client reloads on updates itself

async function pollErrors(r) {
  try { const n = errorCount(await api(errorsUrl(r.state))); if (n !== r.state.errors) { r.state = { ...r.state, errors: n }; render(r); } } catch { /* run gone or peer unreachable */ }
}

async function stop(r) {
  r.stopBtn.disabled = true;
  try { await api(stopUrl(r.state), { method: 'POST', body: {} }); } catch (e) { r.step.textContent = `Could not stop: ${e.message}`; r.stopBtn.disabled = false; }
}

function finish(r) {
  r.time.textContent = elapsed(r.state);
  pollErrors(r);
  if (r.state.status !== 'idle') { clearInterval(r.timer); r.win.el.classList.add('yolo-finished'); } // a YOLOv2 run only waits for feedback
  for (const fn of r.doneWaiters.splice(0)) fn();
}

// ── Conversation (YOLOv2) ───────────────────────────────────────────────────────────────────────────────────────────
const readMap = () => { try { return readHiddenMap(localStorage.getItem(CONVO_KEY)); } catch { return {}; } };
const hiddenNow = (r) => convoHidden(readMap(), r.state.runId, isPhone());

function setConvoHidden(r, hidden) {
  try { localStorage.setItem(CONVO_KEY, JSON.stringify(withConvoHidden(readMap(), r.state.runId, hidden))); } catch { /* private mode: the choice lasts for this window only */ }
  r.convoHidden = hidden;
  render(r);
}

function renderMessages(r) {
  const ms = r.state.messages;
  const sig = `${ms.length}|${ms.at(-1)?.at ?? ''}`;
  if (sig === r.msgSig) return;
  r.msgSig = sig;
  const near = r.log.scrollHeight - r.log.scrollTop - r.log.clientHeight < 40;
  r.log.replaceChildren(...(ms.length ? ms.map((m) => h('div', { class: `yolo-msg ${m.role}` },
    h('div', { class: 'yolo-msg-meta' }, m.role === 'user' ? 'You' : 'Agent', ` · turn ${m.turn ?? 1}`,
      m.feedback ? h('b', { class: 'yolo-msg-tag' }, 'feedback') : '', m.errors ? h('b', { class: 'yolo-msg-tag bad' }, `${m.errors} page error${m.errors === 1 ? '' : 's'}`) : ''),
    h('div', { class: 'yolo-msg-text' }, m.text))) : [h('div', { class: 'yolo-convo-empty' }, 'The agent answers here once its first turn is done. Test the page meanwhile.')]));
  if (near) r.log.scrollTop = r.log.scrollHeight;
}

async function send(r, feedback) {
  if (r.sending || composerState(r.state).disabled) return;
  const note = r.input.value;
  r.sending = true;
  r.convoMsg.textContent = '';
  render(r);
  try {
    let errors = [];
    if (feedback) { try { errors = (await api(`${errorsUrl(r.state)}?after=${r.errAfter || 0}`)).errors || []; } catch { /* the server adds the page errors itself */ } }
    const body = messageBody({ text: note, errors, screenshot: r.shot || '', feedback });
    if (!canSendBody(body)) { r.convoMsg.textContent = 'Write a message first.'; return; }
    const res = await api(messageUrl(r.state), { method: 'POST', body });
    r.errAfter = Math.max(r.errAfter || 0, ...errors.map((e) => e.seq || 0));
    r.input.value = '';
    r.shot = ''; r.shotName.textContent = '';
    r.state = turnStarted(r.state, res.turn);
  } catch (e) {
    r.convoMsg.textContent = `Could not send: ${e.message}`;
  } finally {
    r.sending = false;
    render(r);
  }
}

function attach(r, file) {
  if (!file) return;
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > SCREENSHOT_MAX * 0.7) { r.convoMsg.textContent = 'Attach a PNG, JPEG or WebP image under 2.8 MB.'; return; }
  const fr = new FileReader();
  fr.onload = () => { r.shot = String(fr.result); r.shotName.textContent = `📎 ${file.name}`; };
  fr.readAsDataURL(file);
}

// ── Keep as app ──────────────────────────────────────────────────────────────────────────────────────────────────────
function setKeepMsg(r, text, level = '') {
  r.keepMsg.textContent = text;
  r.keepMsg.className = `yolo-keep-msg${level ? ` ${level}` : ''}`;
  r.keepRow.hidden = !text && !r.keepForm;
}

function closeKeepForm(r) {
  r.keepForm?.remove();
  r.keepForm = null;
  if (r.phase === 'asking') r.phase = '';
  setKeepMsg(r, '');
  render(r);
  r.keepBtn.focus();
}

function onKeep(r) {
  if (r.state.keptAs?.id) { openKept(r); return; }
  if (r.phase) return;
  r.phase = 'asking';
  const live = r.state.status === 'live';
  const name = h('input', { class: 'yolo-keep-name', value: r.state.title, maxlength: '80', 'aria-label': 'App name', placeholder: 'App name', required: true });
  const icon = h('input', { class: 'yolo-keep-icon', maxlength: '8', 'aria-label': 'Icon (one emoji)', ...keepIconField(r.state) });
  r.keepForm = h('form', { class: 'yolo-keep-form', onsubmit: (e) => { e.preventDefault(); keep(r, { name: name.value, icon: icon.value }); } },
    h('label', {}, h('span', {}, 'App name'), name), h('label', { class: 'yolo-keep-icon-l' }, h('span', {}, 'Icon'), icon),
    h('button', { class: 'btn primary yolo-btn', type: 'submit' }, live ? '■ Stop & keep' : '★ Keep'),
    h('button', { class: 'btn yolo-btn', type: 'button', onclick: () => closeKeepForm(r) }, 'Cancel'));
  r.keepForm.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeKeepForm(r); } });
  r.keepRow.prepend(r.keepForm);
  setKeepMsg(r, live ? 'The agent is still working: it is stopped first, then this page becomes an app.' : `It becomes an App Cloud app on ${r.state.node || 'this machine'}.`);
  render(r);
  name.focus();
  name.select();
}

/** Resolves once the run's yolo-done arrived (or after `ms`). */
function untilDone(r, ms = 20000) {
  if (r.state.status !== 'live') return Promise.resolve();
  return new Promise((resolve) => { const t = setTimeout(resolve, ms); r.doneWaiters.push(() => { clearTimeout(t); resolve(); }); });
}

async function keep(r, form) {
  if (r.phase === 'stopping' || r.phase === 'keeping') return;
  const body = keepBody(form, r.state);
  r.keepForm?.remove();
  r.keepForm = null;
  try {
    if (r.state.status === 'live') {
      r.phase = 'stopping';
      render(r);
      setKeepMsg(r, 'Stopping the agent…');
      await api(stopUrl(r.state), { method: 'POST', body: {} });
      await untilDone(r);
    }
    r.phase = 'keeping';
    render(r);
    setKeepMsg(r, `Copying the page and publishing ${body.name || 'it'} to the App Cloud…`);
    const res = await api(keepUrl(r.state), { method: 'POST', body });
    r.state = withKept(r.state, res.keptAs);
    r.phase = '';
    render(r);
    setKeepMsg(r, `${res.already ? 'Already kept' : 'Kept'} as ${res.app?.name || res.keptAs.id} — opening it.`, 'ok');
    refreshApps();
    openKept(r, res.app);
  } catch (e) {
    r.phase = '';
    render(r);
    setKeepMsg(r, `Could not keep it as an app: ${e.message}`, 'bad');
  }
}

function openKept(r, fromServer = null) {
  const a = keptApp(r.state.keptAs, appsCatalog(), fromServer);
  if (a) openApp(a);
}

/** The run's meta when its window opens: kept already? ended already (a window reopened for a finished run)? */
async function loadMeta(r) {
  try {
    const next = withMeta(r.state, await api(metaUrl(r.state)));
    if (next === r.state) return;
    const ended = r.state.status === 'live' && next.status !== 'live';
    r.state = next;
    render(r);
    if (ended) finish(r);
  } catch { /* run gone or peer unreachable */ }
}

function render(r) {
  const s = r.state;
  r.win.el.dataset.yoloStatus = s.status;
  r.dot.className = `yolo-dot ${s.status}`;
  r.label.textContent = STATUS_LABEL[s.status];
  r.step.textContent = s.activity;
  r.step.title = s.summary || s.activity;
  r.time.textContent = elapsed(s);
  r.errs.textContent = s.errors ? `${s.errors} error${s.errors === 1 ? '' : 's'}` : 'no errors';
  r.errs.classList.toggle('bad', s.errors > 0);
  r.stopBtn.disabled = s.status !== 'live' || r.phase === 'stopping';
  const k = keepButton(s, r.phase);
  r.keepBtn.textContent = k.label;
  r.keepBtn.title = k.title;
  r.keepBtn.setAttribute('aria-label', k.title);
  r.keepBtn.disabled = k.disabled;
  r.keepBtn.classList.toggle('kept', k.kept);
  const ic = iconView(s);
  const icKey = `${ic.text}|${ic.img}`;
  if (icKey !== r.iconKey) { r.iconKey = icKey; r.win.setIcon(ic.text, ic.img); }
  const c = composerState(s, r.sending);
  r.convo.hidden = !c.shown || r.convoHidden;
  r.convoBtn.hidden = !c.shown;
  const t = convoToggle(r.convoHidden, s.messages.length);
  r.convoBtn.textContent = t.label;
  r.convoBtn.title = t.title;
  r.convoBtn.setAttribute('aria-label', t.title);
  r.convoBtn.setAttribute('aria-pressed', String(t.pressed));
  r.input.disabled = c.disabled;
  r.input.placeholder = c.placeholder;
  r.sendBtn.disabled = c.disabled;
  r.fbBtn.disabled = c.disabled;
  r.attachBtn.disabled = c.disabled;
  r.hint.textContent = c.hint;
  r.activity.textContent = s.status === 'live' ? s.activity : '';
  r.activity.hidden = s.status !== 'live';
  if (c.shown) renderMessages(r);
}

function openRun(state, { focus = false } = {}) {
  const r = { state, phase: '', keepForm: null, doneWaiters: [], sending: false, msgSig: '', iconKey: '', shot: '', errAfter: 0 };
  r.convoHidden = hiddenNow(r);
  r.frame = h('iframe', { class: 'app-frame yolo-frame', title: state.title, src: state.url, allow: 'fullscreen; clipboard-write', sandbox: 'allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock' });
  r.dot = h('i', { class: 'yolo-dot live' });
  r.label = h('b', { class: 'yolo-label' }, 'live');
  r.step = h('span', { class: 'yolo-step' }, state.activity);
  r.time = h('span', { class: 'yolo-time' }, '0:00');
  r.errs = h('span', { class: 'yolo-errs' }, 'no errors');
  const btn = (text, title, fn, extra = {}) => h('button', { class: 'btn yolo-btn', title, 'aria-label': title, onclick: fn, ...extra }, text);
  r.stopBtn = btn('■ Stop', 'Stop the agent', () => stop(r));
  r.win = openWindow({
    title: windowTitle(state), icon: iconView(state).text, width: 960, height: 680, className: 'yolo-win', focus,
    onClose: () => { clearInterval(r.timer); runs.delete(state.runId); },
  });
  r.keepBtn = btn('★ Keep as app', 'Keep this page as an App Cloud app', () => onKeep(r), { class: 'btn yolo-btn yolo-keep-btn' });
  r.keepMsg = h('span', { class: 'yolo-keep-msg', role: 'status', 'aria-live': 'polite' });
  r.keepRow = h('div', { class: 'yolo-keep', hidden: true }, r.keepMsg);
  r.convoBtn = btn('💬 Hide chat', 'Hide the conversation', () => setConvoHidden(r, !r.convoHidden), { class: 'btn yolo-btn yolo-convo-btn', hidden: !state.v2 });
  const strip = h('div', { class: 'yolo-strip' },
    h('div', { class: 'yolo-status' }, r.dot, r.label, r.step, r.time, r.errs),
    h('div', { class: 'yolo-btns' }, r.stopBtn,
      btn('↻ Reload', 'Reload the page', () => reload(r)),
      btn('↗ Open', 'Open in a new tab', () => window.open(r.state.url, '_blank', 'noopener')),
      btn('⤢ Full size', 'Pop the window to full size', () => r.win.el.querySelector('.win-btn[aria-label="Maximize"]')?.click()),
      r.convoBtn, r.keepBtn),
    r.keepRow);
  r.log = h('div', { class: 'yolo-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation' });
  r.activity = h('div', { class: 'yolo-convo-activity', hidden: true });
  r.input = h('textarea', { class: 'yolo-input', rows: '2', maxlength: '8000', 'aria-label': 'Message to the agent', onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(r, false); } } });
  r.sendBtn = h('button', { class: 'btn primary yolo-btn', type: 'button', title: 'Send the message', onclick: () => send(r, false) }, 'Send');
  r.fbBtn = h('button', { class: 'btn yolo-btn', type: 'button', title: 'Send the note with the page errors since the last turn', onclick: () => send(r, true) }, '✉ Send feedback');
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true, onchange: () => { attach(r, file.files[0]); file.value = ''; } });
  r.attachBtn = h('button', { class: 'btn yolo-btn', type: 'button', title: 'Attach a screenshot to the feedback', 'aria-label': 'Attach a screenshot', onclick: () => file.click() }, '📎');
  r.shotName = h('span', { class: 'yolo-shot' });
  r.hint = h('span', { class: 'yolo-convo-hint' });
  r.convoMsg = h('span', { class: 'yolo-convo-msg bad', role: 'status' });
  r.convo = h('aside', { class: 'yolo-convo', 'aria-label': 'Conversation', hidden: true },
    h('div', { class: 'yolo-convo-head' }, h('b', {}, 'Conversation'), h('button', { class: 'btn yolo-btn yolo-convo-close', type: 'button', title: 'Hide the conversation', 'aria-label': 'Hide the conversation', onclick: () => setConvoHidden(r, true) }, '✕')),
    r.log, r.activity,
    h('form', { class: 'yolo-composer', onsubmit: (e) => { e.preventDefault(); send(r, false); } }, r.input,
      h('div', { class: 'yolo-composer-row' }, r.sendBtn, r.fbBtn, r.attachBtn, file, r.shotName),
      r.convoMsg, r.hint));
  r.win.body.append(strip, h('div', { class: 'yolo-main' }, h('div', { class: 'app-stage yolo-stage' }, r.frame), r.convo));
  r.timer = setInterval(() => { r.time.textContent = elapsed(r.state); }, 1000);
  // A YOLOv2 follow-up's events go out only on the /ws of the machine that runs it (no jarvis/send stream carries them),
  // so a JARVIS on another machine would never see the turn end: while one runs, its meta is read too.
  r.win.interval(() => { if (r.state.status === 'live') { pollErrors(r); if (r.state.v2 && r.state.turn > 1) loadMeta(r); } }, 2500);
  render(r);
  if (state.status !== 'live') finish(r); // a past run reopened: no clock, no Stop
  loadMeta(r);
  return r;
}

// ── YOLO history ─────────────────────────────────────────────────────────────────────────────────────────────────────
// One window (key yolo-history) with every machine's past runs (GET /api/local/yolo/history, src/yolo.js meshHistory), kept
// or not. A click opens the run in the normal YOLO window: its page in the iframe, the v2 conversation from its meta and the
// feedback box for an idle run; a run whose window is open is focused, not opened twice. Greyed rows are on a machine that
// does not answer (the list came from the cache): not clickable. It opens only on request — the Apps list button, the
// JARVIS box ("show my yolo history") or a ui_open view "yolo" — and never by itself.

let historyWin = null;

/** Open (or focus) the window of a past run. Returns it, or null when the row cannot be opened (its machine does not answer). */
export function openHistoryRun(row) {
  const act = rowAction(row, openYoloRuns());
  if (act === 'none') return null;
  if (act === 'focus') { const r = runs.get(row.runId); r.win.raise(); return r; }
  const r = openRun(stateFromRow(row), { focus: true });
  runs.set(row.runId, r);
  return r;
}

function openKeptOf(row) {
  const a = keptApp(row.kept, appsCatalog());
  if (a) openApp(a);
}

/** Tools: the YOLO history list. Raises the window when it is already open. */
export function openYoloHistory() {
  if (historyWin && !historyWin.closed) { historyWin.raise(); loadHistory(); return historyWin; }
  const w = openWindow({ title: 'YOLO history', icon: '⚡', width: 620, height: 560, className: 'yolo-hist-win', key: 'yolo-history' });
  historyWin = w;
  w.closed = false;
  w.onCleanup(() => { w.closed = true; if (historyWin === w) historyWin = null; });
  w.data = null;
  w.find = h('input', { class: 'yolo-hist-find', type: 'search', placeholder: 'Filter runs', 'aria-label': 'Filter the history by text', autocomplete: 'off', oninput: () => drawHistory(w) });
  w.machine = h('select', { class: 'yolo-hist-machine', 'aria-label': 'Filter the history by machine', onchange: () => drawHistory(w) }, h('option', { value: '' }, 'All machines'));
  w.list = h('ul', { class: 'yolo-hist-list', role: 'list' });
  w.note = h('div', { class: 'yolo-hist-note muted small', role: 'status', 'aria-live': 'polite' }, 'Loading…');
  w.body.append(
    h('div', { class: 'yolo-hist-bar' }, w.find, w.machine,
      h('button', { class: 'btn yolo-btn', type: 'button', title: 'Reload the list from every machine', 'aria-label': 'Reload the list', onclick: () => loadHistory() }, '↻')),
    w.list, w.note);
  w.interval(() => loadHistory(), 30000);
  loadHistory();
  return w;
}

async function loadHistory() {
  const w = historyWin;
  if (!w || w.closed) return;
  try {
    w.data = await api(HISTORY_URL);
    drawHistory(w);
  } catch (e) {
    if (!w.data) w.note.textContent = `Could not load the history: ${e.message}`;
  }
}

function drawHistory(w) {
  if (!w || w.closed || !w.data) return;
  const all = buildRows(w.data, { openIds: openYoloRuns() });
  const machines = machinesOf(all);
  const picked = w.machine.value;
  w.machine.replaceChildren(h('option', { value: '' }, 'All machines'), ...machines.map((m) => h('option', { value: m.node }, `${m.node} (${m.count})`)));
  w.machine.value = machines.some((m) => m.node === picked) ? picked : '';
  const rows = filterRows(all, { text: w.find.value, node: w.machine.value });
  w.list.replaceChildren(...(rows.length ? rows.map(historyItem) : [h('li', { class: 'yolo-hist-empty muted' }, all.length ? 'No run matches the filter.' : 'No YOLO runs yet. Say “yolo a …” and it shows up here.')]));
  w.note.textContent = historySummary(rows.length, all.length, w.data);
}

function historyItem(row) {
  const go = () => {
    const r = openHistoryRun(row);
    if (!r && !row.available) toast(`${row.node} does not answer right now; this run is shown from its last known state.`, 'info');
    else if (r) { const w = historyWin; if (w && !w.closed) drawHistory(w); }
  };
  const main = h('button', {
    class: 'yolo-hist-main', type: 'button', onclick: go, disabled: !row.available,
    title: row.available ? (row.open ? 'Focus its window' : 'Open this run') : `${row.node} does not answer right now`,
  },
    h('span', { class: 'yolo-hist-icon', 'aria-hidden': 'true' }, row.icon),
    h('span', { class: 'yolo-hist-text' },
      h('span', { class: 'yolo-hist-title' }, row.title),
      h('span', { class: 'yolo-hist-sub' }, `${row.node} · ${row.age}${row.v2 && row.turn > 1 ? ` · ${row.turn} turns` : ''}`)),
    h('span', { class: 'yolo-hist-tags' },
      h('b', { class: `yolo-hist-status ${row.status.key}` }, row.status.label),
      row.kept ? h('b', { class: 'yolo-hist-kept', title: `Kept as ${row.kept.name}` }, '★ kept as app') : ''));
  return h('li', { class: `yolo-hist-row${row.available ? '' : ' offline'}${row.open ? ' is-open' : ''}`, 'data-run': row.runId },
    main, row.kept ? h('button', { class: 'btn yolo-btn yolo-hist-app', type: 'button', disabled: !row.available, title: `Open ${row.kept.name}`, 'aria-label': `Open app ${row.kept.name}`, onclick: () => openKeptOf(row) }, 'Open app') : '');
}
