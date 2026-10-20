import { api, h } from './api.js';
import { appsCatalog, openApp, refreshApps } from './apps.js';
import { openWindow } from './wm.js';
import { STATUS_LABEL, applyEvent, elapsed, errorCount, errorsUrl, eventKey, isYoloEvent, keepBody, keepButton, keepUrl, keptApp, metaUrl, startRun, stopUrl, windowTitle, withKept, withMeta } from './yolo-model.js';

// YOLO windows: "yolo a bouncing ball in p5" opens a floating window the moment the daemon pushes yolo-start (before the
// agent writes anything), shows the run's sandbox page in an iframe through /api/nodes/<node>/yolo/<runId>/ (so a run
// on another machine looks the same), reloads it on every yolo-update and settles a slim status strip on yolo-done.
// Events (src/yolo.js has the contract) arrive on /ws and in the jarvis/send stream: onYoloEvent takes both and dedupes.
// A finished window stays until closed; several runs make several windows. Window chrome (tiling, docking, the phone
// full-screen sheet) is wm.js's. ★ Keep as app asks for a name (prefilled from the run title) and an icon, stops a live
// run first, POSTs …/keep through the run's node (src/yolo-keep.js) and opens the new app with the Apps list's opener;
// a kept run (yolo-kept, or keptAs in the run's meta when the window opens) reads ★ Kept and opens its app.

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
  clearInterval(r.timer);
  r.time.textContent = elapsed(r.state);
  pollErrors(r);
  r.win.el.classList.add('yolo-finished');
  for (const fn of r.doneWaiters.splice(0)) fn();
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
  const icon = h('input', { class: 'yolo-keep-icon', value: '⚡', maxlength: '8', 'aria-label': 'Icon (one emoji)', placeholder: '⚡' });
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
}

function openRun(state) {
  const r = { state, phase: '', keepForm: null, doneWaiters: [] };
  r.frame = h('iframe', { class: 'app-frame yolo-frame', title: state.title, src: state.url, allow: 'fullscreen; clipboard-write', sandbox: 'allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock' });
  r.dot = h('i', { class: 'yolo-dot live' });
  r.label = h('b', { class: 'yolo-label' }, 'live');
  r.step = h('span', { class: 'yolo-step' }, state.activity);
  r.time = h('span', { class: 'yolo-time' }, '0:00');
  r.errs = h('span', { class: 'yolo-errs' }, 'no errors');
  const btn = (text, title, fn, extra = {}) => h('button', { class: 'btn yolo-btn', title, 'aria-label': title, onclick: fn, ...extra }, text);
  r.stopBtn = btn('■ Stop', 'Stop the agent', () => stop(r));
  r.win = openWindow({
    title: windowTitle(state), icon: '⚡', width: 960, height: 680, className: 'yolo-win', focus: false,
    onClose: () => { clearInterval(r.timer); runs.delete(state.runId); },
  });
  r.keepBtn = btn('★ Keep as app', 'Keep this page as an App Cloud app', () => onKeep(r), { class: 'btn yolo-btn yolo-keep-btn' });
  r.keepMsg = h('span', { class: 'yolo-keep-msg', role: 'status', 'aria-live': 'polite' });
  r.keepRow = h('div', { class: 'yolo-keep', hidden: true }, r.keepMsg);
  const strip = h('div', { class: 'yolo-strip' },
    h('div', { class: 'yolo-status' }, r.dot, r.label, r.step, r.time, r.errs),
    h('div', { class: 'yolo-btns' }, r.stopBtn,
      btn('↻ Reload', 'Reload the page', () => reload(r)),
      btn('↗ Open', 'Open in a new tab', () => window.open(r.state.url, '_blank', 'noopener')),
      btn('⤢ Full size', 'Pop the window to full size', () => r.win.el.querySelector('.win-btn[aria-label="Maximize"]')?.click()),
      r.keepBtn),
    r.keepRow);
  r.win.body.append(strip, h('div', { class: 'app-stage yolo-stage' }, r.frame));
  r.timer = setInterval(() => { r.time.textContent = elapsed(r.state); }, 1000);
  r.win.interval(() => { if (r.state.status === 'live') pollErrors(r); }, 2500);
  render(r);
  loadMeta(r);
  return r;
}
