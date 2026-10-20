import { bannerVisible, closedTexts, prefs } from './toasts.js';
import { CAPS, capMap, createSweeper } from './cleanup.js';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { ago, api, fmtBytes, h, node, stream, toast, wsUrl } from './api.js';
import { appPath, closeApp, findApp, isAppOpen, onAppsEvent, openApp, openApps, refreshApps, reloadApp, rerenderApps } from './apps.js';
import { appKey, canDock, dockPanel, floatPanel, initLayout, isAppRemoved, isCollapsed, isDocked, listRemoved, openPanel, resetPanel, toggleCollapse } from './layout-actions.js';
import { createAppDock, registerAppDockProviders } from './app-dock.js';
import { sourcesFromSnapshot } from './app-dock-model.js';
import { TOOLS } from './app-dock-state.js';
import { menuModel, registerJarvisCommands } from './jarvis-commands.js';
import { closeMenus, initMenubar } from './menubar.js';
import { askMode, dockAskToTopbar, floatAsk, focusAsk, hideAsk, initAskPanel, rememberAsk } from './ask-panel.js';
import { copyText, installContextMenu } from './contextmenu.js';
import { createProviders, galaxyTarget, registerJarvisProviders } from './ctx-providers.js';
import { tagCtx } from './ctx-tag.js';
import { initAppStore, onAppStoreEvent, openAppStore } from './appstore.js';
import { openBrainPanel } from './brain.js';
import { registerJarvisTray } from './tray-jarvis.js';
import { listPanels, makeFloating, panelState, showPanel, togglePanel, setClosed, inheritPanel } from './panels.js';
import { initMobile, openDrawer, revealInspector, isPhone } from './mobile.js';
import { renderReply } from './visual.js';
import { activity, freshIds } from './os.js';
import { createWork, createQuestions } from './work.js';
import { createUsage } from './usage-panel.js';
import { createDesktops, openLargeView } from './desktops.js';
import { routeChip } from './preroute-format.js';
import { replyLabel } from './local-responder-model.js';
import { createTraces, onTraceSpan, openTrace } from './trace-panel.js';
import { exhibitAnim, exhibitsEnabled, initExhibits, onExhibitEvent, onExhibitSpan, openExhibits, setExhibitAnim, setExhibitsEnabled } from './exhibits.js';
import { initStarnet, onStarnetConfig, setStarnetEnabled, starnetEnabled, starnetFit, starnetFocus, starnetUpdate } from './starnet/index.js';
import { openFiles } from './files.js';
import { addClaim, filesTarget, isBrowseAsk, uiOpenAction } from './ui-open-model.js';
import { TYPES, buildGraph, createGraph } from './graph.js';
import { cloudCommand, createCloud } from './cloud.js';
import { createGraphify } from './graphify.js';
import { openMesh } from './mesh.js';
import { controlEvent, openControl } from './control.js';
import { openProjects } from './projects.js';
import { createAgents } from './agents.js';
import { createFace } from './face.js';
import { createOrb } from './orb.js';
import { lowPower } from './perf.js';
import { announce, initA11y, initPopovers, prefersReducedMotion } from './a11y.js';
import { openSessions } from './sessions.js';
import { createPopups } from './popups.js';
import { focusTerminal, openTerminal } from './terminal-lazy.js';
import { bindDock, openBus, reconcileOnLoad, trackPanels } from './open-events.js';
import { dockManager } from './dock-layout.js';
import { createVoice } from './voice.js';
import { closeAll as closeAllWindows, closeOthers, isMaximized, openWindow, toggleMaximize, windowCount } from './wm.js';
import { THEMES, applyTheme, themeId } from './themes.js';

applyTheme();

const $ = (s) => document.querySelector(s);
const store = {
  get: (k, d) => { try { const v = localStorage.getItem('rigs.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('rigs.' + k, JSON.stringify(v)); } catch {} },
};

let snap = [];
// Agent sessions started in the background pop up here as terminals (deduped per node:kind:id). At most
// CAPS.popupWindows of them stay open: past that the oldest one the user is not typing in closes (a busy mesh would
// otherwise stack up a terminal, with its scrollback and socket, for every agent it ever started).
const popupWins = [];
const popups = createPopups({
  enabled: () => store.get('autoOpenSessions', true),
  open: async (s) => {
    try {
      const r = await api(`${node(s.nodeId)}/sessions/attach`, { method: 'POST', body: { kind: s.kind, id: s.id } });
      // auto/tab: an automatically surfaced session; with the dock's autoTabTerminals on it joins the shared Terminals window (off by default: its own window as before)
      const t = await openTerminal({ nodeId: s.nodeId, nodeName: s.nodeName, ptyId: r.ptyId, title: s.title?.slice(0, 50), auto: true, tab: !!appDock?.state.settings.autoTabTerminals });
      if (!t?.window) return;
      popupWins.push(t.window);
      t.window.onCleanup(() => { const i = popupWins.indexOf(t.window); if (i >= 0) popupWins.splice(i, 1); });
      while (popupWins.length > CAPS.popupWindows) {
        const old = popupWins.find((w) => !w.el.contains(document.activeElement));
        if (!old) break;
        old.close();
      }
    } catch (e) { toast(e.message, 'error'); }
  },
});
let selfId = null;
let persona = { name: 'J.A.R.V.I.S.', address: 'sir' };
if (store.get('brainv', 0) < 2) { store.set('brain', null); store.set('brainv', 2); } // JARVIS chat now defaults to Haiku
let brainSel = store.get('brain', null); // { nodeId, nodeName, brain, model }
let chatRef = store.get('chat', null); // { nodeId, chatId }
// The chat dock can be attached to any session on the mesh instead of JARVIS's own conversation:
// { nodeId, nodeName, kind, id, title, live } — typed/spoken input goes straight into that session.
let chatTarget = store.get('chatTarget', null);
let busy = null;

// ------------------------------------------------------------------ boot
// The cloud (the galaxy on #graph) can be hidden for good — graph destroyed, GPU memory released (cloud.js). Hidden by
// default on low-power devices; Display › cloud, ☁ in the top bar, Window › Show cloud or "hide the cloud" switch it.
const graph = createCloud($('#graph'), {
  createGraph, visible: store.get('cloud', !lowPower()),
  onSelect: (n) => { select(n.id); revealInspector(); }, onBackground: () => {},
  onChange: (on) => { store.set('cloud', on); syncCloud(); },
});
function syncCloud() {
  const on = graph.visible;
  document.body.classList.toggle('cloud-off', !on);
  const box = document.getElementById('d-cloud');
  if (box) box.checked = on;
  const pill = document.getElementById('cloud-toggle');
  if (pill) { pill.setAttribute('aria-pressed', String(on)); pill.title = on ? 'Hide the cloud — the 3D mesh galaxy (saves GPU and memory)' : 'Show the cloud — the 3D mesh galaxy'; pill.classList.toggle('off', !on); }
}
/** Show or hide the cloud (a fresh galaxy frames the whole mesh by itself once its layout settles). */
function setCloud(on) { graph.setVisible(on); }
const orb = createOrb($('#orb'), 'J.A.R.V.I.S.');
/** The launch recipe an app's host runs on its own OS (launchHere); older peers send only launch. */
const launchOf = (a) => (a.launchHere !== undefined ? a.launchHere : a.launch);

// The face lip-syncs to every spoken sentence (viseme timeline from the neural voice, else the audio itself)
let face = null;
// The face is the heaviest WebGL scene after the galaxy, so it is created lazily: on low-power devices only once
// the user asks for it ("show your face"), elsewhere unless they hid it.
function makeFace() {
  try { face = createFace($('#face')); window.jarvisFace = face; } catch { $('#face').classList.add('off'); } // no WebGL: the orb alone (window.jarvisFace: for the devtools console)
}
{ const pref = localStorage.getItem('rigs.face'); if (pref === '1' || (pref == null && !lowPower())) makeFace(); else $('#face').classList.add('off'); }
$('#face').onclick = () => $('#face').classList.toggle('big');
// Hidden, the face is disposed (no render loop, WebGL context released); showing it builds a new one.
function showFace(on) {
  if (on && !face) makeFace();
  if (!on && face) { face.dispose(); face = null; window.jarvisFace = null; }
  $('#face').classList.toggle('off', !on);
  localStorage.setItem('rigs.face', on ? '1' : '0');
}
// The face's emotion for each line JARVIS says (LocalJev on the mesh decides; see src/senses.js)
let feelSeq = 0;
function feel(text) {
  if (!face || !text?.trim()) return;
  const seq = ++feelSeq;
  api('/api/local/emotion', { method: 'POST', body: { text: text.slice(0, 600) } }).then((r) => {
    if (seq !== feelSeq) return; // a newer line already decided
    const words = text.split(/\s+/).length;
    face?.setEmotion(r.emotion, { hold: Math.max(4500, words * 420 + 2500) });
  }).catch(() => {});
}

const voice = createVoice({
  onSpeech: (s) => { if (!face) return; if (s) face.speak(s); else face.stop(); },
  onTranscript: (t) => { $('#ask').value = ''; ask(t, { spoken: true }); },
  onInterim: (t) => { if (t) showSubtitle(t, 'user interim'); },
  onState: (s) => setOrb(s),
  onLevel: (v) => { orb.setLevel(v); face?.setLevel(v); },
});
{ const say = voice.say; voice.say = (t) => { feel(t); say(t); }; } // every spoken line gets an expression

function setOrb(s) {
  orb.setState(s);
  face?.setState(s);
  const label = { online: 'ONLINE', listening: 'LISTENING', thinking: 'THINKING', speaking: 'SPEAKING', error: 'ERROR', offline: 'OFFLINE' }[s] || s.toUpperCase();
  $('#orb-state').innerHTML = `<i class="dot s-${s}" aria-hidden="true"></i>${label}`;
}

const machines = () => snap.filter((e) => e.node.online && e.node.rigs).map((e) => e.node);
/** Apps on the mesh (with node name/id), removed ones included; `open` = it has a window here. */
const meshApps = () => snap.flatMap((e) => (e.apps || []).map((a) => ({ ...a, node: e.node.name, nodeId: e.node.id }))).map((a) => ({ ...a, open: isAppOpen(a) }));
/** The snapshot without removed apps (Window › Removed items): what the galaxy shows. */
const visibleSnap = () => snap.map((e) => (e.apps?.length ? { ...e, apps: e.apps.filter((a) => !isAppRemoved({ ...a, nodeId: e.node.id })) } : e));
const machineById = (id) => snap.find((e) => e.node.id === id)?.node;

// ------------------------------------------------------------------ "an agent needs you"
// Every machine reports agents waiting on the user (permission prompts, questions, blocked tasks).
// They blink in the galaxy, sit in a banner until answered, and announce themselves once.
let work = null; // the Active projects panel (wire())
let appDock = null; // the app dock (app-dock.js, wire())
let attention = []; // [{ node, nodeId, items: [...] }]
const baseTitle = document.title;

const attnItems = () => attention.flatMap((g) => (g.items || []).map((it) => ({ ...it, nodeId: g.nodeId, nodeName: g.node })));

function sessionFor(it) {
  const e = snap.find((x) => x.node.id === it.nodeId);
  if (!e || !it.session) return null;
  return (e.sessions || []).find((s) => s.id === it.session.id && s.kind === it.session.kind) || (e.sessions || []).find((s) => s.id === it.session.id) || null;
}

function attentionGraphIds() {
  const ids = new Set();
  for (const it of attnItems()) {
    ids.add('m:' + it.nodeId);
    const s = sessionFor(it);
    if (s) ids.add(`s:${it.nodeId}:${s.kind}:${s.id}`);
    if (it.project) ids.add(`tk:${it.project.id}:${it.project.task}`);
  }
  return ids;
}

async function refreshAttention() {
  try { attention = await api('/api/mesh/attention'); } catch { return; }
  graph.setAttention(attentionGraphIds());
  starnetUpdate(); // experimental station view (no-op while off)
  renderAttention();
  work?.rerender();
}

// The Questions button's count follows the attention poll, so it is right while the panel is closed.
function updateQuestionCount(n) {
  const c = $('#ask-count');
  if (!c) return;
  c.hidden = !n;
  c.textContent = String(n);
  const label = n ? `Questions — ${n} agent${n > 1 ? 's' : ''} waiting for your answer` : 'Questions — agents waiting for your answer';
  $('#btn-ask').title = label;
  $('#btn-ask').setAttribute('aria-label', label);
  askCount = n;
  syncToolBadges();
}

// The dock's tools show the toolbar's live state: the questions count, the agents badge and the voice toggle.
const TOOL_PANEL = { ask: 'questions', agents: 'agents', work: 'work', usage: 'usage', desktops: 'desktops', traces: 'traces', graphify: 'graphify' };
let askCount = 0;
let agentCount = 0;
function syncToolBadges() {
  if (!appDock) return;
  appDock.setTool('tool:ask', { badge: askCount });
  appDock.setTool('tool:agents', { badge: agentCount });
  appDock.setTool('tool:mute', { pressed: !!voice.muted });
}

// Bring the Questions panel up (on a phone the two panels are sheets in the same place, so Active projects steps aside).
function showQuestions() {
  if (isPhone()) setClosed('work', true);
  showPanel('questions');
  $('#questions')?.scrollIntoView?.({ block: 'nearest' });
}

function syncNotifyChecks() {
  const p = prefs();
  if ($('#d-notify')) $('#d-notify').checked = p.notifications;
  if ($('#d-attnbanner')) { $('#d-attnbanner').checked = p.attnBanner; $('#d-attnbanner').disabled = !p.notifications; }
}

function renderAttention() {
  const items = attnItems();
  updateQuestionCount(items.length);
  // The banner heads the toast column, so toasts stack under it instead of on top of it.
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
  let bar = $('#attn');
  if (!bar) bar = h('div', { id: 'attn', role: 'alert' });
  if (box.firstChild !== bar) box.prepend(bar);
  document.title = items.length ? `(${items.length}) ⚠ ${baseTitle}` : baseTitle;
  $('#orb-wrap').classList.toggle('alert', items.length > 0);
  if (!bannerVisible(items, prefs())) { bar.replaceChildren(); bar.classList.remove('on'); return; }
  bar.classList.add('on');
  const who = (a) => ({ claude: 'Claude', codex: 'Codex', ollama: 'Ollama' }[a] || a || 'agent');
  bar.replaceChildren(
    h('div', { class: 'attn-head' }, h('b', {}, `⚠ ${items.length} agent${items.length > 1 ? 's' : ''} need${items.length > 1 ? '' : 's'} you`),
      h('button', { class: 'toast-x', title: 'Close for good (questions stay in the Questions panel; turn it back on under Display)', 'aria-label': 'Close attention banner', onclick: () => { prefs().attnBanner = false; syncNotifyChecks(); renderAttention(); } }, '×')),
    ...items.slice(0, 3).map((it) => h('div', { class: 'attn-row' },
      h('div', { class: 'attn-what' }, h('b', {}, `${who(it.agent)} · ${it.nodeName}`), ' ', h('span', {}, it.title || ''), h('div', { class: 'muted small' }, `${it.reason || ''}${it.since ? ' · ' + ago(it.since) : ''}${it.where && it.where !== 'tmux' ? ' · in ' + it.where : ''}`)),
      h('div', { class: 'attn-btns' }, act('⌨ Answer', () => openAttention(it), 'primary'), act('◎', () => showAttention(it), 'icon')))),
    // (replaceChildren would print a literal "null", unlike h())
    ...(items.length > 3 ? [h('div', { class: 'muted small' }, `+${items.length - 3} more — see the blinking planets`)] : []));
}

function showAttention(it) {
  const s = sessionFor(it);
  if (s) select(`s:${it.nodeId}:${s.kind}:${s.id}`);
  else if (it.project) select(`tk:${it.project.id}:${it.project.task}`);
  else select('m:' + it.nodeId);
}

async function openAttention(it) {
  const m = machineById(it.nodeId);
  if (!m) return;
  if (it.project && !it.session) { showAttention(it); projectsWindow({ owner: it.nodeId, id: it.project.id }); return; }
  if (it.where === 'Claude app') { showAttention(it); toast(`It's waiting in the Claude app on ${m.name} — answer it there.`, 'ok', 12000); return; }
  const s = sessionFor(it) || (it.session && { ...it.session, title: it.title, live: true });
  if (!s) { showAttention(it); return; }
  // A Claude Code / Codex session outside tmux can't be joined (resuming would fork it): show where it is instead.
  if (s.kind === 'claude' || s.kind === 'codex') { showAttention(it); sessionsWindow('', { node: m, s }); toast(`Answer it in the terminal where it runs on ${m.name}.`, 'ok', 12000); return; }
  // A Claude Code / Codex seat in tmux: answer from the chat dock, its options are shown there.
  if ((s.kind === 'tmux' || s.kind === 'rig') && (it.agent === 'claude' || it.agent === 'codex')) { showAttention(it); attachChat(m, s); return; }
  attachSession(m, s);
}

async function attentionNotify(m) {
  const it = m.action?.item ? { ...m.action.item, nodeName: m.action.node, nodeId: snap.find((e) => e.node.name === m.action.node)?.node.id } : null;
  await refreshAttention();
  if (!it) return;
  // No toast: it shows once, in the banner. With the banner closed or notifications off Sir asked for quiet; the
  // Questions panel, the orb and the tab title still show who is waiting.
  try {
    if (prefs().notifications && 'Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
      const n = new Notification(`${m.from}: an agent needs you`, { body: m.text, tag: it.key, requireInteraction: true });
      n.onclick = () => { window.focus(); openAttention(it); n.close(); };
    }
  } catch {}
}

// Browsers only allow asking for notification permission from a user gesture.
window.addEventListener('pointerdown', () => { try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch {} }, { once: true });

async function refresh() {
  try {
    snap = await api('/api/mesh/snapshot');
    const self = snap.find((e) => e.node.self);
    if (self) selfId = self.node.id;
    graph.setData(buildGraph(visibleSnap()));
    graph.setAttention(attentionGraphIds());
    starnetUpdate();
    graphifyPanel?.update();
    renderCounts();
    agentsPanel?.update();
    renderHubs();
    renderAppList();
    appDock?.sync();
    syncToolBadges();
    renderFilters();
    renderBrainBadge();
    if (graph.focused) renderInspector(graph.focused);
    else renderInspector(null);
  } catch (e) {
    setOrb('offline');
    toast('Gateway unreachable: ' + e.message, 'error');
  }
}

// Requests this UI sent (their trace ids), told to the gateway so ui-open pushes for them come here first.
let eventsWs = null;
let tracesClaimed = [];
function claimTrace(traceId) {
  tracesClaimed = addClaim(tracesClaimed, traceId);
  if (eventsWs?.readyState === 1 && tracesClaimed.includes(traceId)) eventsWs.send(JSON.stringify({ type: 'claim-trace', traceId }));
}

function connectEvents() {
  const ws = new WebSocket(wsUrl('/ws'));
  eventsWs = ws;
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'ui-open') onUiOpen(m);
    if (m.type === 'mesh') refresh();
    if (m.type === 'global') { globalBrain = { ...m, home: m.settings?.['brain.home'] || m.settings?.['brain.core']?.node || '' }; renderBrainBadge(); }
    onAppsEvent(m);
    if (m.type === 'appstore') onAppStoreEvent(m);
    if (m.type === 'apps') refresh();
    if (m.type === 'notify' && m.session) popups.handle(m);
    if (m.type === 'control') controlEvent(m);
    if (m.type === 'trace-span') { onTraceSpan(m.span); onExhibitSpan(m.span); } // the Exhibit window's activity follows the same stream
    if (m.type?.startsWith('exhibit')) onExhibitEvent(m); // experimental Exhibit window (exhibits.js)
    if (m.type === 'starnet-config') onStarnetConfig(m); // experimental space-station view switched (starnet/index.js)
    // Notifications switched off: no toast, banner, subtitle or speech — only the passive signals stay current.
    if (m.type === 'notify' && !prefs().notifications) { if (m.level === 'attention') refreshAttention(); }
    else if (m.type === 'notify' && m.level === 'attention') {
      attentionNotify(m);
      showSubtitle(m.text, 'jarvis');
      if (m.speak) voice.say(spokenText(m.text, true));
    } else if (m.type === 'notify') {
      const act = m.action?.type === 'run' ? { label: m.action.label || 'Run', run: () => runOn(m.action.node, m.action.command, m.action.title) } : null;
      // A message Sir already closed stays gone: no toast, and no subtitle or speech either.
      if (!toast(`${m.from}: ${m.text}`, m.level === 'error' ? 'error' : 'ok', undefined, act)) return;
      showSubtitle(m.text, 'jarvis');
      if (m.speak) voice.say(spokenText(m.text, true));
    }
  };
  ws.onopen = () => {
    if (orb.state === 'offline') setOrb('online');
    for (const traceId of tracesClaimed) ws.send(JSON.stringify({ type: 'claim-trace', traceId }));
  };
  ws.onclose = () => { setOrb('offline'); setTimeout(connectEvents, 3000); };
}

// ------------------------------------------------------------------ left panel
function renderCounts() {
  const up = machines().length;
  const total = snap.length;
  const sessions = snap.reduce((a, e) => a + (e.sessions?.length || 0), 0);
  const live = snap.reduce((a, e) => a + (e.sessions || []).filter((s) => s.live).length, 0);
  $('#counts').textContent = `${up}/${total} machines · ${sessions} sessions · ${live} live`;
}

/** Left panel: every app on the mesh, one click to open (and spin up) it. */
function renderAppList() {
  const apps = meshApps().filter((a) => !isAppRemoved(a));
  const fresh = freshIds('apps', apps.map((a) => a.id));
  $('#app-list').replaceChildren(...(apps.length ? apps.map((a) => {
    const st = a.health?.status || 'unknown';
    return tagCtx(h('div', { class: `hub app-row ${st}${fresh.has(a.id) ? ' materialise' : ''}`, title: `${a.name} on ${a.node} — ${st}${launchOf(a) ? '' : ' (no launch recipe)'}`, onclick: () => openApp(a) },
      h('i', { style: { background: st === 'up' ? '#4ade80' : st === 'down' ? '#f87171' : TYPES.offline.color } }), h('span', {}, `${a.icon || '▦'} ${a.name}`), h('em', {}, a.node)), 'app', appKey(a), { app: a });
  }) : [h('div', { class: 'muted small' }, 'No apps yet.')]), h('div', { class: 'hub app-row store-row', title: 'App Store — install new apps', onclick: () => openAppStore() }, h('i', { style: { background: 'var(--accent)' } }), h('span', {}, '🛍 App Store'), h('em', {}, 'install')));
}

initAppStore({ machines: () => snap });

const inside = (cwd, root) => !!cwd && !!root && (cwd === root || cwd.startsWith(root.replace(/[\\/]+$/, '') + (root.includes('\\') ? '\\' : '/')));
const pinSessions = (e, p) => (e.sessions || []).filter((s) => s.live !== false && inside(s.cwd, p.path));
const allPins = () => snap.flatMap((e) => (e.node.pinnedProjects || []).map((p) => ({ ...p, node: e.node, entry: e })));

const pinRig = (e, p) => (e?.hubs?.pins || []).find((x) => x.path === p.path) || null;
const rigHealth = (e) => e?.hubs?.openrig || null;

/** "3 seats · 1 running · 2 queued" — or why there is no rig. */
function rigLine(r, health) {
  if (health && !health.healthy) return 'OpenRig unusable';
  if (!r || !r.exists) return 'no rig yet';
  if (!r.up) return 'rig down';
  const live = r.seats.filter((x) => x.live).length;
  return `${live} seat${live === 1 ? '' : 's'} · ${r.running ? `${r.running} running` : 'idle'}${r.queue ? ` · ${r.queue} queued` : ''}`;
}

function projectWindow(pin) {
  const m = pin.node;
  const list = h('div', { class: 'proj-sessions' });
  const seatsEl = h('div', { class: 'proj-sessions proj-seats' });
  const rigHead = h('div', { class: 'proj-rig-head' });
  const msg = h('input', { class: 'path-input', placeholder: 'Message the lead seat…', onkeydown: (e) => { if (e.key === 'Enter') sendLead(); } });
  const upDown = h('button', { class: 'btn' }, '…');
  const w = openWindow({ title: `📌 ${pin.name} · ${m.name}`, width: 560, height: 520 });
  const call = (sub, body) => api(`${node(m.id)}/hubs/${sub}`, { method: 'POST', body: { path: pin.path, ...body } });
  async function sendLead() {
    const text = msg.value.trim();
    if (!text) return;
    msg.disabled = true;
    try { const r = await call('send', { text }); msg.value = ''; toast(`Sent to ${r.seat}.`, 'ok'); refresh(); } catch (e) { toast(e.message, 'error'); }
    msg.disabled = false;
  }
  const render = () => {
    const cur = allPins().find((x) => x.node.id === m.id && x.path === pin.path) || pin;
    const ss = pinSessions(cur.entry, cur).filter((s) => s.kind !== 'rig');
    list.replaceChildren(...(ss.length ? ss.map((s) => h('div', { class: 'hub', onclick: () => attachSession(m, s) },
      h('i', { style: { background: TYPES.machine.color } }), h('span', {}, s.title || s.id), h('em', {}, s.kind))) : [h('div', { class: 'muted small' }, 'No other live sessions in this project.')]));
    const r = pinRig(cur.entry, cur);
    const health = rigHealth(cur.entry);
    rigHead.replaceChildren(h('b', {}, '⛭ OpenRig team'), h('span', { class: 'muted small' }, ` ${r?.rig || ''} · ${rigLine(r, health)}`));
    if (health && !health.healthy) seatsEl.replaceChildren(h('div', { class: 'chip st-bad wrap' }, health.health || 'OpenRig is not usable on this machine.'));
    else seatsEl.replaceChildren(...(r?.seats?.length ? r.seats.map((x) => h('div', { class: 'hub' + (x.live ? '' : ' off'), title: `${x.session} — ${x.live ? x.activity : x.status}`, onclick: () => (x.live ? attachSession(m, { kind: 'rig', id: x.session, title: x.session }) : toast('That seat is stopped — it comes back when work arrives.', 'info')) },
      h('i', { style: { background: !x.live ? TYPES.offline.color : /idle/i.test(x.activity || '') && !x.work ? '#60a5fa' : '#4ade80' } }),
      h('span', {}, `${x.lead ? '★ ' : ''}${x.id}`), h('em', {}, `${x.live ? (/idle/i.test(x.activity || '') && !x.work ? 'idle' : 'running') : 'stopped'}${x.queue ? ` · q${x.queue}` : ''} · ⌨`))) : [h('div', { class: 'muted small' }, 'No seats yet — the lead starts with the first task, a message, or “Bring rig up”.')]));
    upDown.textContent = r?.up ? '⏹ Bring rig down' : '⏵ Bring rig up';
    upDown.onclick = async () => {
      upDown.disabled = true;
      try {
        if (r?.up) { if (!confirm(`Stop every seat of ${r.rig}? Conversations are kept and resume when it comes back up.`)) return; await call('down'); toast('Rig is down.', 'ok'); }
        else { toast('Bringing the rig up…'); await call('up'); toast('Rig is up.', 'ok'); }
        refresh();
      } catch (e) { toast(e.message, 'error'); } finally { upDown.disabled = false; }
    };
  };
  render();
  const t = setInterval(() => { if (!w.el.isConnected) clearInterval(t); else render(); }, 3000);
  w.body.append(h('div', { class: 'muted small' }, `${m.name}:${pin.path}`), rigHead, seatsEl,
    h('div', { class: 'actions proj-send' }, msg, h('button', { class: 'btn primary', onclick: sendLead }, '➤ Send to lead'), upDown),
    h('div', { class: 'pv-title small' }, 'Other sessions here'), list,
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => startAgent(m, 'claude', pin.path) }, '▶ New Claude here'),
      h('button', { class: 'btn', onclick: () => openTerminal({ nodeId: m.id, nodeName: m.name, cwd: pin.path, title: pin.name }) }, '⌨ Terminal here'),
      h('button', { class: 'btn', onclick: async () => { await pinProject(m, pin.path, pin.name, true); w.close(); } }, 'Unpin')));
}

async function pinProject(m, path, name, remove = false) {
  try { await api(`${node(m.id)}/pins`, { method: 'POST', body: { path, name, remove } }); refresh(); toast(remove ? 'Unpinned.' : `Pinned ${name || path}.`, 'ok'); } catch (e) { toast(e.message, 'error'); }
}

function renderHubs() {
  const pinRows = allPins().map((p) => {
    const r = pinRig(p.entry, p);
    const health = rigHealth(p.entry);
    const rl = rigLine(r, health);
    const el = h('div', { class: 'hub pin-hub' + (p.node.online ? '' : ' off'), title: `${p.node.name}:${p.path}\nOpenRig: ${r?.rig || '—'} — ${rl}` },
      h('i', { style: { background: '#fbbf24' } }), h('span', {}, `📌 ${p.name}`), h('em', {}, `${p.node.name} · ${pinSessions(p.entry, p).length}`),
      h('small', { class: 'rig-line' + (r?.up ? ' up' : '') + (health && !health.healthy ? ' bad' : '') }, `⛭ ${rl}`));
    el.onclick = () => projectWindow(p);
    return el;
  });
  const rows = snap.map((e) => ({ n: e.node, c: e.sessions?.length || 0 })).sort((a, b) => (b.n.online - a.n.online) || b.c - a.c);
  $('#hubs').replaceChildren(...pinRows, ...rows.map(({ n, c }) => {
    const el = h('div', { class: 'hub' + (n.online && n.rigs ? '' : ' off') }, h('i', { style: { background: n.online && n.rigs ? TYPES.machine.color : TYPES.offline.color } }), h('span', {}, n.name), h('em', {}, c || ''));
    el.onclick = () => select('m:' + n.id);
    return el;
  }));
}

let hiddenTypes = new Set(store.get('hidden', []));
function renderFilters() {
  const counts = {};
  for (const n of graph.nodes()) counts[n.type] = (counts[n.type] || 0) + 1;
  $('#filters').replaceChildren(...Object.entries(TYPES).filter(([k]) => counts[k]).map(([k, t]) => {
    const el = h('label', { class: 'flt' + (hiddenTypes.has(k) ? ' off' : '') }, h('i', { style: { background: t.color } }), h('span', {}, t.label), h('em', {}, counts[k]));
    el.onclick = () => {
      if (hiddenTypes.has(k)) hiddenTypes.delete(k); else hiddenTypes.add(k);
      store.set('hidden', [...hiddenTypes]);
      graph.setHidden([...hiddenTypes]);
      graphifyPanel?.update();
      renderFilters();
    };
    return el;
  }));
  graph.setHidden([...hiddenTypes]);
  starnetUpdate();
}

// ------------------------------------------------------------------ inspector
function select(id, { keepView = false } = {}) {
  const n = graph.get(id);
  if (!n) return;
  graph.focus(id, graph.depth || 1);
  if (!keepView) starnetFocus(id); // a click in the station keeps its camera (the menu opens where the pointer is)
  renderInspector(id);
  $('#back').style.visibility = 'visible';
}

function clearSelection() {
  graph.clearFocus();
  if (!starnetFit()) graph.fit(); // the space-station view frames the whole station instead
  renderInspector(null);
  $('#back').style.visibility = 'hidden';
}

function statBar(label, pct, title) {
  return h('div', { class: 'bar', title: title || '' }, h('span', {}, label), h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: `${pct}%`, background: pct > 85 ? '#f87171' : pct > 60 ? '#fbbf24' : '#2dd4bf' } })), h('em', {}, `${pct}%`));
}

function act(label, fn, cls = '') { return h('button', { class: 'ibtn ' + cls, onclick: fn }, label); }

function renderInspector(id) {
  const box = $('#inspector');
  if (!id) {
    box.replaceChildren(h('div', { class: 'muted small' }, 'Click a machine, agent or session to focus it — only it and its connections light up. Use the depth buttons to trace further.'));
    return;
  }
  const n = graph.get(id);
  if (!n) return;
  const out = [h('div', { class: 'ins-title' }, h('i', { style: { background: TYPES[n.type]?.color } }), n.name), h('div', { class: 'ins-type' }, TYPES[n.type]?.label || n.type)];
  const m = n.machine ? machineById(n.machine) : null;

  if (n.type === 'machine' || n.type === 'offline') {
    const d = n.data;
    const up = d.online && d.rigs;
    out.push(h('div', { class: 'ins-meta' }, `${d.distro || d.platform || ''}${d.arch ? ' · ' + d.arch : ''}`, h('br'), d.tailscale?.dnsName || d.tailscale?.ip || d.url || '', up ? [h('br'), `rigs ${d.version} · ${d.display?.session || ''}`] : ''));
    if (up && d.stats) {
      const mem = Math.round((d.stats.memUsed / d.stats.memTotal) * 100);
      out.push(statBar('CPU', d.stats.cpu || 0), statBar('MEM', mem, `${fmtBytes(d.stats.memUsed)} / ${fmtBytes(d.stats.memTotal)}`));
      if (d.gpus?.length) out.push(h('div', { class: 'muted small' }, '⧉ ' + d.gpus.map((g) => g.replace(/^[\d:.]+ VGA compatible controller: /, '')).join(', ')));
      const ds = desktopState(d);
      if (ds) out.push(ds);
      if (d.access) out.push(h('div', { class: 'muted small' }, `💾 ${d.access.home?.write ? 'home read/write' : 'home NOT writable'}${d.access.blocked?.length ? ` · blocked: ${d.access.blocked.map((b) => b.split(/[\\/]/).pop()).join(', ')}` : ''}${d.access.fullDiskAccess === false ? ' · no Full Disk Access (optional)' : d.access.fullDiskAccess ? ' · Full Disk Access ✓' : ''}`));
    }
    out.push(h('div', { class: 'ins-actions' },
      up ? act('⌨ Terminal', () => openTerminal({ nodeId: d.id, nodeName: d.name })) : null,
      up ? act('📁 Files', () => filesOn(d)) : null,
      act('🖥 Desktop', () => desktopTo(d)),
      up ? act('🛡 Access & control', () => openControl({ machine: d })) : null,
      up ? act('💬 Sessions', () => sessionsWindow(d.name)) : null,
      up ? act('◆ Use as brain', () => pickBrainOn(d)) : null,
      up ? act('⚙ Processes', () => processesWindow(d)) : null,
      act('🔐 SSH', () => sshTo(d)),
      act('⧉', () => { navigator.clipboard.writeText(`ssh ${d.sshAlias || d.name}`); toast(`Copied: ssh ${d.sshAlias || d.name}`); }, 'icon'),
      up ? act('✳ New agent', () => newAgent(d)) : null,
      up && d.tools?.rig ? act('⛭ OpenRig TUI', () => openTerminal({ nodeId: d.id, nodeName: d.name, command: 'rig tui', title: 'OpenRig' })) : null));
  } else if (n.type === 'agent') {
    out.push(h('div', { class: 'ins-meta' }, `${m?.name} · ${n.detail || ''}`));
    const a = n.agent;
    out.push(h('div', { class: 'ins-actions' },
      act(`▶ New ${n.name} session`, () => newAgent(m, a)),
      a !== 'rig' ? act('◆ Use as brain', () => setBrain({ nodeId: m.id, nodeName: m.name, brain: a, model: '' })) : act('⛭ OpenRig TUI', () => openTerminal({ nodeId: m.id, nodeName: m.name, command: 'rig tui', title: 'OpenRig' })),
      act('💬 Its sessions', () => sessionsWindow(`${m.name}`))));
    if (a === 'claude' || a === 'codex') out.push(h('div', { class: 'muted small' }, `REA: ${m?.tools?.reaRegistered?.[a] ? 'registered ✓' : 'not registered — run rigs setup'} · mesh MCP: ${m?.tools?.rigsRegistered?.[a] ? '✓' : '✗'}`));
  } else if (n.type === 'model') {
    out.push(h('div', { class: 'ins-meta' }, `Ollama on ${m?.name}`));
    out.push(h('div', { class: 'ins-actions' }, act('◆ Talk to this model', () => setBrain({ nodeId: m.id, nodeName: m.name, brain: 'ollama', model: n.model })), act('⌨ ollama run', () => openTerminal({ nodeId: m.id, nodeName: m.name, command: `ollama run ${n.model}`, title: n.model }))));
  } else if (n.session) {
    const s = n.session;
    out.push(h('div', { class: 'ins-meta' }, `${m?.name} · ${s.kind}${s.project ? ' · ' + s.project : ''}`, h('br'), s.cwd || '', h('br'), `${s.live ? '● live · ' : ''}${ago(s.updatedAt)}`));
    out.push(h('div', { class: 'ins-actions' },
      act('📜 Transcript', () => sessionsWindow('', { node: m, s })),
      s.kind !== 'chat' ? act('💬 Chat here', () => attachChat(m, s)) : null,
      s.kind === 'chat' ? act('◆ Continue', () => continueChat(m, s)) : act(s.kind === 'pty' ? '⌨ Open' : s.live ? '⌨ Attach' : '⌨ Resume', () => attachSession(m, s))));
  } else if (n.type === 'project') {
    const sess = graph.neighbors(id, 1).filter((x) => x.session);
    const where = [...new Set(sess.map((x) => machineById(x.machine)?.name))].filter(Boolean);
    out.push(h('div', { class: 'ins-meta' }, `On ${where.join(', ')} · ${sess.length} sessions`));
    const first = sess[0];
    if (first) {
      const mm = machineById(first.machine);
      out.push(h('div', { class: 'ins-actions' }, act('⌨ Terminal in project', () => openTerminal({ nodeId: mm.id, nodeName: mm.name, cwd: first.session.cwd, title: n.name })), act('📁 Files', () => filesOn(mm, first.session.cwd)), act('✳ Claude here', () => startAgent(mm, 'claude', first.session.cwd)), act('📌 Pin', () => pinProject(mm, first.session.cwd, n.name))));
    }
  } else if (n.type === 'skill') {
    out.push(h('div', { class: 'ins-meta' }, n.detail));
    if (n.id === 'skill:rea') out.push(h('div', { class: 'ins-actions' }, act('⌨ REA setup (this machine)', () => openTerminal({ nodeId: selfId, nodeName: 'here', command: 'npx -y rea-agents@latest setup', title: 'REA setup' })), act('⌨ REA help', () => openTerminal({ nodeId: selfId, nodeName: 'here', command: 'npx -y rea-agents@latest --help', title: 'REA' }))));
  } else if (n.type === 'rig') {
    out.push(h('div', { class: 'ins-meta' }, `OpenRig on ${m?.name} · ${n.data.status} · ${n.data.running}/${n.data.nodes} seats running`));
    out.push(h('div', { class: 'ins-actions' }, act('⛭ OpenRig TUI', () => openTerminal({ nodeId: m.id, nodeName: m.name, command: 'rig tui', title: 'OpenRig' })), act('📜 rig ps', () => openTerminal({ nodeId: m.id, nodeName: m.name, command: `rig ps --nodes --rig ${n.name}; exec $SHELL`, title: 'rig ps' }))));
  } else if (n.type === 'plan') {
    const pj = n.plan;
    const by = pj.tasks.reduce((a, t) => ((a[t.status] = (a[t.status] || 0) + 1), a), {});
    out.push(h('div', { class: 'ins-meta' }, pj.goal, h('br'), `${pj.status} · ${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ')}`));
    out.push(h('div', { class: 'ins-actions' }, act('📋 Open project', () => projectsWindow({ owner: n.owner, id: pj.id }))));
  } else if (n.type === 'task') {
    const t = n.task;
    out.push(h('div', { class: 'ins-meta' }, `${n.plan.name} · ${t.kind} · ${t.status}`, h('br'), t.assign ? `${t.assign.provider} ${t.assign.model || ''} ${t.assign.effort ? '· ' + t.assign.effort : ''} on ${t.assign.node}` : 'unassigned'));
    out.push(h('div', { class: 'ins-actions' }, act('📋 Open project', () => projectsWindow({ owner: snap.find((e) => (e.projects || []).some((p) => p.id === n.plan.id))?.node.id, id: n.plan.id }))));
  } else if (n.type === 'tool') {
    const c = n.tool;
    out.push(h('div', { class: 'ins-meta' }, `${m?.name} · serves ${c.kinds.join(', ') || '—'}`, h('br'), [c.url, c.command].filter(Boolean).join(' · '), c.notes ? [h('br'), c.notes] : ''));
    if (c.url) out.push(h('div', { class: 'ins-actions' }, act('↗ Open', () => window.open(c.url.replace('127.0.0.1', m?.tailscale?.ip || '127.0.0.1'), '_blank'))));
  } else if (n.type === 'app') {
    const a = n.app;
    const st = a.health?.status || 'unknown';
    out.push(h('div', { class: 'ins-meta' }, `${a.node} · ${st}${a.health?.latencyMs != null ? ` · ${a.health.latencyMs} ms` : ''}`, h('br'), launchOf(a) ? `starts with ${launchOf(a).systemd || launchOf(a).command}` : `no launch recipe${a.launch ? ' for its OS' : ''} — start it by hand`));
    out.push(h('div', { class: 'ins-actions' }, act(st === 'up' ? '▦ Open' : '▶ Start & open', () => openApp(a)), act('↗ Tab', () => window.open(`/api/nodes/${encodeURIComponent(a.node)}/apps/${encodeURIComponent(a.id)}/`, '_blank', 'noopener'))));
  } else if (n.type === 'mesh') {
    out.push(h('div', { class: 'ins-meta' }, `${machines().length} RIGS nodes online on your tailnet.`));
    out.push(h('div', { class: 'ins-actions' }, act('⚙ Mesh control', () => meshWindow()), act('↻ Rescan', async () => { await api('/api/mesh/refresh', { method: 'POST' }); refresh(); })));
  }

  // Connections with depth, like the reference UI.
  const depthBtns = h('div', { class: 'depth' }, 'Depth', ...[1, 2, 3].map((d) => h('button', { class: graph.depth === d ? 'on' : '', onclick: () => { graph.setDepth(d); renderInspector(id); } }, d)));
  const nb = graph.neighbors(id, graph.depth || 1).filter((x) => x.id !== id).sort((a, b) => b.val - a.val).slice(0, 40);
  out.push(depthBtns, h('div', { class: 'conns' }, ...nb.map((x) => { const el = h('div', { class: 'conn' }, h('i', { style: { background: TYPES[x.type]?.color } }), h('span', {}, x.name)); el.onclick = () => select(x.id); return el; })));
  box.replaceChildren(...out);
}

// ------------------------------------------------------------------ actions
/** Open a terminal on a machine (by name or id) running a command — e.g. a sudo step you finish by typing your password. */
function runOn(nodeRef, command, title) {
  const m = snap.find((e) => e.node.name === nodeRef || e.node.id === nodeRef)?.node;
  if (!m) { toast(`${nodeRef} is offline`, 'error'); return; }
  openTerminal({ nodeId: m.id, nodeName: m.name, command, title: title || command.slice(0, 40) });
}

/** SSH into a machine from the gateway; the login lands in a tmux session that also shows up in JARVIS. */
function sshTo(m) {
  const self = snap.find((e) => e.node.self)?.node;
  if (!self || m.self) { openTerminal({ nodeId: m.id, nodeName: m.name }); return; }
  openTerminal({ nodeId: self.id, nodeName: self.name, command: `ssh ${m.sshAlias || m.name}`, title: `ssh ${m.name}` });
  setTimeout(refresh, 4000);
}

function desktopState(d) {
  const di = d.desktopInstall;
  const rs = d.rootSteps;
  if (rs?.steps?.length) return h('div', { class: 'muted small' }, `🔑 needs your password once: ${rs.steps.map((x) => x.title.split(' (')[0].split(':')[0]).join(' · ')} · `, h('a', { class: 'link', onclick: () => runOn(d.id, rs.command, `Finish setup · ${d.name}`) }, 'finish setup'));
  if (!di) return null;
  const label = di.sunshine && di.moonlight ? 'Sunshine + Moonlight ready' : di.state === 'needs-sudo' ? 'Sunshine needs your password to finish' : di.state === 'installing' ? 'installing Sunshine + Moonlight…' : di.state === 'failed' ? 'remote desktop install failed' : di.moonlight && !di.sunshine ? 'Moonlight ready · no Sunshine host' : 'remote desktop not installed';
  return h('div', { class: 'muted small' }, '🖥 ' + label,
    di.state === 'needs-sudo' && di.command ? [' · ', h('a', { class: 'link', onclick: () => runOn(d.id, di.command, 'Finish Sunshine install') }, 'finish now')] : null,
    (di.state === 'failed' || di.state === 'idle' || !di.state) && !(di.sunshine && di.moonlight) ? [' · ', h('a', { class: 'link', onclick: () => installDesktop(d) }, 'install')] : null);
}

async function installDesktop(d) {
  toast(`Installing Sunshine + Moonlight on ${d.name}…`);
  try {
    const r = await api(`${node(d.id)}/desktop/install`, { method: 'POST', body: { force: true } });
    toast(`${d.name}: ${r.state}${r.steps?.length ? ' — ' + r.steps.slice(-1)[0] : ''}`, r.state === 'failed' ? 'error' : 'ok', 9000, r.state === 'needs-sudo' ? { label: 'Finish install', run: () => runOn(d.id, r.command, 'Finish Sunshine install') } : null);
    refresh();
  } catch (e) { toast(e.message, 'error'); }
}

// The latest file-browser window per machine: a ui_open push for that machine navigates it instead of opening another.
const filesWins = new Map();
function filesOn(m, path = '~', { select = '', showHidden = false } = {}) {
  const w = openFiles({ nodeId: m.id, nodeName: m.name, path, select, showHidden, machines, onTerminalHere: (p) => openTerminal({ nodeId: m.id, nodeName: m.name, cwd: p }) });
  filesWins.set(m.id, w);
  w.onCleanup(() => { if (filesWins.get(m.id) === w) filesWins.delete(m.id); });
  return w;
}

/** A ui-open push (MCP ui_open, src/ui-open.js): open the view it names — today the file browser at a folder. */
const uiOpenSeen = new Set();
function onUiOpen(m) {
  const a = uiOpenAction(m, { machines: snap.map((e) => e.node) });
  if (!a || (a.id && uiOpenSeen.has(a.id))) return;
  if (a.id) { uiOpenSeen.add(a.id); if (uiOpenSeen.size > 50) uiOpenSeen.delete(uiOpenSeen.values().next().value); }
  if (a.view === 'files') {
    const w = filesTarget(filesWins, a.nodeId);
    if (w) { w.navigate(a.path, { select: a.select, showHidden: a.showHidden }); w.raise(); }
    else filesOn({ id: a.nodeId, name: a.nodeName }, a.path, { select: a.select, showHidden: a.showHidden });
  }
  if (a.toast) toast(a.toast, 'info', 7000);
}

// Active agents panel (agents.js): live agent sessions, one click to attach
let agentsPanel = null;
let graphifyPanel = null;

let sessWin = null;
let ctxMenu = null; // installContextMenu()'s handle (wireContextMenus); the station frame opens menus through it
function sessionsWindow(filter = '', show = null) {
  sessWin = openSessions({ snapshot: () => snap, focus: (n, s) => select(`s:${n.id}:${s.kind}:${s.id}`), onContinueChat: continueChat, onAttachChat: attachChat, onAttached: popups.mark });
  const mine = sessWin;
  sessWin.window.onCleanup(() => { if (sessWin === mine) sessWin = null; }); // a closed Sessions window is not kept alive until the next one
  if (filter) { const i = sessWin.window.body.querySelector('input'); i.value = filter; i.dispatchEvent(new Event('input')); }
  if (show) sessWin.showSession(show.node, show.s);
}

const attached = new Map(); // `${node}:${kind}:${id}` → terminal window already open for that session
async function attachSession(m, s) {
  const key = `${m.id}:${s.kind}:${s.id}`;
  const open = attached.get(key)?.el;
  if (open?.isConnected && !open.classList.contains('win-leave')) { open.classList.remove('panel-closed'); attached.get(key).raise(); open.querySelector('.xterm-helper-textarea')?.focus(); return; } // one window per session
  try {
    const r = await api(`${node(m.id)}/sessions/attach`, { method: 'POST', body: { kind: s.kind, id: s.id, cwd: s.cwd } });
    popups.mark(m.id, s.kind, s.id);
    const t = await openTerminal({ nodeId: m.id, nodeName: m.name, ptyId: r.ptyId, title: s.title?.slice(0, 50) });
    if (t?.window) { attached.set(key, t.window); t.window.onCleanup(() => { if (attached.get(key) === t.window) attached.delete(key); }); } // a closed terminal is not kept alive by this map
  } catch (e) { toast(e.message, 'error'); }
}

async function startAgent(m, agent, cwd, prompt = '', model = '') {
  try {
    const r = await api(`${node(m.id)}/agents/start`, { method: 'POST', body: { agent, cwd, prompt, model, surface: false } });
    popups.mark(m.id, r.kind, r.id);
    const a = await api(`${node(m.id)}/sessions/attach`, { method: 'POST', body: { kind: r.kind, id: r.id } });
    openTerminal({ nodeId: m.id, nodeName: m.name, ptyId: a.ptyId, title: `${agent} · ${r.id}` });
    setTimeout(refresh, 1500);
    return r;
  } catch (e) { toast(e.message, 'error'); return null; }
}

function newAgent(m, preset, dir = '~') {
  const tools = m.tools || {};
  const agents = ['claude', 'codex', 'ollama', 'rig'].filter((a) => tools[a]);
  const w = openWindow({ title: `New agent on ${m.name}`, icon: '✳', width: 520, height: 330 });
  const agentSel = h('select', { class: 'mini' }, ...agents.map((a) => h('option', { value: a, selected: a === preset }, a)));
  const cwd = h('input', { class: 'path-input', value: dir || '~', placeholder: 'working directory on ' + m.name });
  const prompt = h('textarea', { class: 'path-input', rows: 4, placeholder: 'Optional first task, e.g. “fix the failing tests”' });
  const model = h('input', { class: 'path-input', placeholder: 'model (optional)' });
  w.body.append(h('div', { class: 'pad settings' }, h('label', {}, 'Agent', agentSel), h('label', {}, 'Directory', cwd), h('label', {}, 'Task', prompt), h('label', {}, 'Model', model),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: async () => { const r = await startAgent(m, agentSel.value, cwd.value, prompt.value, model.value); if (r) { w.close(); voice.say(`${agentSel.value} is up on ${m.name}, ${persona.address}.`); } } }, 'Start (in tmux)'))));
}

/**
 * Remote desktop window for a target machine: connect (viewer = this machine, or any other machine),
 * live steps, the target's pending Moonlight pairings with PIN entry, and install/finish hints.
 */
function desktopTo(m, { viewer } = {}) {
  const self = snap.find((e) => e.node.self)?.node;
  const viewers = machines().filter((x) => x.id !== m.id && x.tools?.moonlight);
  const w = openWindow({ title: `Remote desktop — ${m.name}`, icon: '🖥', width: 680, height: 470 });
  const status = h('div', { class: 'pad desk-status' });
  const pairList = h('div', { class: 'pad' });
  const viewerSel = h('select', { class: 'mini' }, ...viewers.map((x) => h('option', { value: x.id, selected: x.id === (viewer || self?.id) }, `${x.name}${x.self ? ' (this machine)' : ''}`)));
  const tgt = snap.find((e) => e.node.id === m.id)?.node || m;
  const di = tgt.desktopInstall;
  const hostReady = di?.sunshine || tgt.tools?.sunshine;
  w.body.append(
    h('div', { class: 'toolbar' },
      h('span', { class: 'muted small' }, 'Show on'), viewerSel,
      h('button', { class: 'btn primary', onclick: () => go() }, '▶ Connect'),
      h('button', { class: 'btn', title: 'End the stream on the viewing machine', onclick: async () => { try { await api(`${node(viewerSel.value)}/desktop/quit`, { method: 'POST', body: { target: m.id } }); toast('Stream ended'); } catch (e) { toast(e.message, 'error'); } } }, '■ Quit stream')),
    status,
    h('div', { class: 'pad' }, h('div', { class: 'pv-title' }, `Pending pairing requests on ${m.name}`),
      h('div', { class: 'muted small' }, 'Started pairing from Moonlight yourself? It shows a 4-digit PIN — enter it here and RIGS hands it to Sunshine on the target.')),
    pairList);
  if (!hostReady) {
    const rs = tgt.rootSteps;
    status.append(h('div', { class: 'warnbox' }, `${m.name} has no Sunshine host yet. `,
      rs?.steps?.length ? h('a', { class: 'link', onclick: () => runOn(m.id, rs.command, `Finish setup · ${m.name}`) }, 'Finish setup (password)') : h('a', { class: 'link', onclick: () => installDesktop(m) }, 'Install Sunshine + Moonlight')));
  }
  if (!viewers.length) status.append(h('div', { class: 'warnbox' }, 'No machine with Moonlight is online to view from.'));
  // macOS hosts: Sunshine needs the Screen Recording permission or viewers get a black stream.
  api(`${node(m.id)}/desktop`).then((d) => {
    if (d.host?.sunshine?.capturePermission !== false) return;
    status.prepend(h('div', { class: 'warnbox' }, `Sunshine on ${m.name} isn't allowed to record the screen yet (viewers see black). On ${m.name}: `,
      h('a', { class: 'link', onclick: () => api(`${node(m.id)}/desktop/permission`, { method: 'POST' }).then(() => toast(`Opened Screen Recording settings on ${m.name} — switch Sunshine on`)) }, 'open Screen Recording settings'),
      ' → enable Sunshine (and Accessibility for input) → ',
      h('a', { class: 'link', onclick: () => api(`${node(m.id)}/desktop/restart`, { method: 'POST' }).then(() => toast('Sunshine restarted')) }, 'restart Sunshine')));
  }).catch(() => {});

  async function loadPairings() {
    try {
      const r = await api(`${node(m.id)}/desktop/pairings`);
      if (!r.ok) { pairList.replaceChildren(h('div', { class: 'muted small' }, r.error || 'Sunshine not reachable on the target')); return; }
      if (!r.pairings.length) { pairList.replaceChildren(h('div', { class: 'muted small' }, 'None waiting.')); return; }
      pairList.replaceChildren(...r.pairings.map((p) => {
        const pin = h('input', { class: 'path-input pin-in', maxlength: 4, placeholder: 'PIN', inputmode: 'numeric' });
        const name = h('input', { class: 'path-input', placeholder: 'device name', value: p.name || '' });
        const ok = async () => {
          try { const r2 = await api(`${node(m.id)}/desktop/pairings`, { method: 'POST', body: { pairingId: p.id, pin: pin.value.trim(), name: name.value.trim() || 'moonlight' } }); toast(r2.ok ? `Paired ${p.address} with ${m.name}` : `Pairing failed: ${r2.error || 'wrong PIN?'}`, r2.ok ? 'ok' : 'error'); loadPairings(); }
          catch (e) { toast(e.message, 'error'); }
        };
        pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
        return h('div', { class: 'upd-row' }, h('b', {}, p.address), name, pin, h('button', { class: 'btn primary', onclick: ok }, 'Pair'));
      }));
    } catch (e) { pairList.replaceChildren(h('div', { class: 'muted small' }, e.message)); }
  }

  async function go() {
    const v = machines().find((x) => x.id === viewerSel.value) || self;
    status.replaceChildren(h('div', {}, `⏳ ${v.name}: checking pairing with ${m.name}…`));
    try {
      const path = v.self ? '/api/desktop/connect' : `${node(v.id)}/desktop/connect`;
      const r = await api(path, { method: 'POST', body: { target: m.id } });
      status.replaceChildren(
        h('div', { class: r.ok ? 'okbox' : 'warnbox' }, `${r.ok ? '✓' : '✗'} ${r.message}`),
        ...(r.steps || []).map((x) => h('div', { class: 'muted small' }, '· ' + x)),
        r.detail ? h('pre', { class: 'pv-text' }, r.detail) : null,
        r.ok && m.platform === 'mac' ? h('div', { class: 'muted small' }, 'Black screen? Allow Sunshine in System Settings → Privacy & Security → Screen Recording (and Accessibility for input) on the Mac.') : null);
      toast(`${m.name} → ${v.name}: ${r.ok ? 'streaming' : 'failed'}`, r.ok ? 'ok' : 'error');
    } catch (e) { status.replaceChildren(h('div', { class: 'warnbox' }, '✗ ' + e.message)); }
    loadPairings();
  }

  loadPairings();
  w.interval(loadPairings, 3000); // cleared on every close path (Esc, phone back, close others), not only ✕
  if (hostReady && viewers.some((x) => x.id === (viewer || self?.id))) go();
}

function projectsWindow(openId) {
  const pw = openProjects({ snapshot: () => snap, voice, coreBrain: currentBrain, onAttached: popups.mark, onFocus: (p) => select(`pj:${p.id}`) });
  if (openId) pw.open(openId.owner, openId.id);
  return pw;
}

function meshWindow() {
  openMesh({ snapshot: () => snap, voice, onTerminal: (n) => openTerminal({ nodeId: n.id, nodeName: n.name }), onDesktop: desktopTo, onSsh: sshTo, onRun: runOn, onInstallDesktop: installDesktop });
}

// ------------------------------------------------------------------ brain
/** Flat list of (machine, provider, model) choices — used by voice commands like "switch to sonnet on ubuntu". */
function allBrains() {
  const out = [];
  for (const e of snap) {
    if (!e.node.online || !e.node.rigs) continue;
    for (const b of e.brains || []) {
      out.push({ nodeId: e.node.id, nodeName: e.node.name, brain: b.id, model: b.default || '', effort: b.defaultEffort || '', label: b.label });
      for (const mdl of b.models) out.push({ nodeId: e.node.id, nodeName: e.node.name, brain: b.id, model: mdl, effort: b.defaultEffort || '', label: `${b.label} · ${mdl}` });
    }
  }
  return out;
}

let coreDefault = null; // this gateway's core brain from the server
let chatDefault = null; // this gateway's conversational brain (Haiku by default): casual chat and replies
let globalBrain = null; // mesh-wide JARVIS settings (src/globalbrain.js): { home, settings: { 'brain.chat', 'brain.core', … } }

function currentBrain() {
  const has = (nodeId, brain) => snap.find((e) => e.node.id === nodeId && e.node.online)?.brains?.some((b) => b.id === brain);
  // One JARVIS for the mesh: every screen talks to the main-brain machine with the global conversational brain. Only when
  // that machine is offline (or none is set) does this screen fall back to the per-machine choices below.
  if (globalBrain?.home) {
    const node = snap.find((e) => e.node.name === globalBrain.home && e.node.online)?.node;
    const pick = [globalBrain.settings?.['brain.chat'], globalBrain.settings?.['brain.core']].find((x) => x?.provider && x.provider !== 'auto' && node && has(node.id, x.provider));
    if (node && pick) return { nodeId: node.id, nodeName: node.name, brain: pick.provider, model: pick.model || '', effort: pick.effort || '', global: true };
    if (node) { const b = snap.find((e) => e.node.id === node.id)?.brains?.[0]; if (b) return { nodeId: node.id, nodeName: node.name, brain: b.id, model: b.default || '', effort: b.defaultEffort || '', global: true }; }
  }
  if (brainSel && has(brainSel.nodeId, brainSel.brain)) return brainSel;
  if (chatDefault?.model) {
    const node = snap.find((e) => e.node.self)?.node;
    if (node && has(node.id, chatDefault.provider)) return { nodeId: node.id, nodeName: node.name, brain: chatDefault.provider, model: chatDefault.model, effort: chatDefault.effort };
  }
  if (coreDefault && coreDefault.provider !== 'auto') {
    const node = coreDefault.node ? snap.find((e) => e.node.name === coreDefault.node)?.node : snap.find((e) => e.node.self)?.node;
    if (node && has(node.id, coreDefault.provider)) return { nodeId: node.id, nodeName: node.name, brain: coreDefault.provider, model: coreDefault.model, effort: coreDefault.effort };
  }
  const self = snap.find((e) => e.node.self);
  const b = self?.brains?.[0];
  return b ? { nodeId: self.node.id, nodeName: self.node.name, brain: b.id, model: b.default || '', effort: b.defaultEffort || '' } : null;
}

function shortModel(b) {
  const m = b.model || b.brain;
  return m.replace(/^claude-/, '').replace(/:latest$/, '');
}

let jarvisTray = null; // set below, once setBrain and friends exist
function renderBrainBadge() {
  const b = currentBrain();
  $('#brain-badge').innerHTML = b ? `◆ ${shortModel(b).toUpperCase()}${b.effort ? ` <small>· ${b.effort}</small>` : ''} <small>· ${b.nodeName}</small> ▾` : '◆ NO BRAIN ▾';
  $('#brain-badge').removeAttribute('aria-label'); // the visible text is its name (the title only described it before it filled in)
  jarvisTray?.refresh();
}

// The JARVIS icon at the left of the menu-bar tray: the same brain choices, hot-swapped through setBrain.
jarvisTray = registerJarvisTray({
  current: currentBrain, entries: () => snap,
  setBrain: (b) => { setBrain(b); api('/api/local/brain/core').then((c) => { coreDefault = c; }).catch(() => {}); },
  openAsk: () => focusAsk(), openBrainPanel: () => toggleBrainMenu(),
});

function setBrain(b, { quiet = false } = {}) {
  const prevNode = currentBrain()?.nodeId;
  brainSel = { nodeId: b.nodeId, nodeName: b.nodeName, brain: b.brain, model: b.model || '', effort: b.effort || '' };
  store.set('brain', brainSel);
  // The pick is JARVIS's main brain on every machine and screen of the mesh, not just this one.
  globalBrain = { ...(globalBrain || {}), home: b.nodeName, settings: { ...(globalBrain?.settings || {}), 'brain.chat': { provider: b.brain, model: b.model || '', effort: b.effort || '' } } };
  api('/api/local/brain/home', { method: 'POST', body: { node: b.nodeName, provider: b.brain, model: b.model || '', effort: b.effort || '' } })
    .then((g) => { globalBrain = g; renderBrainBadge(); }).catch((e) => toast('Could not make it the main brain for the mesh: ' + e.message, 'error'));
  if (prevNode !== b.nodeId) { chatRef = null; store.set('chat', null); }
  renderBrainBadge();
  $('#brain-menu').classList.remove('open');
  if (!quiet) toast(`Main brain for the whole mesh → ${b.brain}${b.model ? ' ' + b.model : ''}${b.effort ? ' · ' + b.effort : ''} on ${b.nodeName}`);
}

function pickBrainOn(m) { toggleBrainMenu(m.id); }

function toggleBrainMenu(onlyNode) {
  const menu = $('#brain-menu');
  if (menu.classList.contains('open') && !onlyNode) { menu.classList.remove('open'); return; }
  const cur = currentBrain() || {};
  openBrainPanel({
    host: menu, entries: snap, current: onlyNode ? { ...cur, nodeId: onlyNode, brain: '' } : cur,
    gatewayName: snap.find((e) => e.node.self)?.node.name || 'this machine',
    onSave: (b) => { setBrain(b); api('/api/local/brain/core').then((c) => { coreDefault = c; }).catch(() => {}); },
  });
}

// ------------------------------------------------------------------ JARVIS conversation
// A reply is a short spoken line, optionally followed by a "---" line and a written description that
// is shown but never read out. spokenText() is what the voice says; the subtitle shows everything.
const SEPARATOR = /(^|\n)[ \t]*-{3,}[ \t]*(\n|$)/;
const SPOKEN_MAX = 420; // safety cap when a brain ignores the format: say the opening, show the rest
function spokenText(text, final = false) {
  const m = text.match(SEPARATOR);
  let s = m ? text.slice(0, m.index) : final ? text : text.replace(/\n[ \t]*-{1,2}[ \t]*$/, ''); // hold back a half-typed "---"
  if (s.length > SPOKEN_MAX) {
    const cut = s.slice(0, SPOKEN_MAX).search(/[.!?](?=[^.!?]*$)/);
    s = s.slice(0, cut > 80 ? cut + 1 : SPOKEN_MAX);
  }
  return s;
}

function showSubtitle(text, cls = 'jarvis') {
  const el = $('#subtitle');
  if (/\b(jarvis|error)\b/.test(cls)) announce(text.replace(SEPARATOR, '. '), { assertive: cls.includes('error'), delay: 1200 }); // screen readers: once, when the reply settles
  el.className = 'show ' + cls;
  el.removeAttribute('aria-label'); // the empty subtitle is named in index.html; once it has text, the text is its name
  const m = text.match(SEPARATOR);
  el.replaceChildren();
  if (m) {
    const written = h('div', { class: 'written' });
    renderReply(written, text.slice(m.index + m[0].length).trim());
    el.append(h('div', { class: 'spoken' }, text.slice(0, m.index).trim()), written);
    el.classList.add('has-details');
  } else el.textContent = text;
  el.scrollTop = el.scrollHeight;
}

function findMachine(q) {
  q = String(q || '').toLowerCase().replace(/[?.!]$/, '').replace(/^(the|my) /, '').trim();
  const list = snap.map((e) => e.node);
  if (['here', 'this machine', 'local', 'this', 'me'].includes(q)) return list.find((n) => n.self);
  return list.find((n) => n.name.toLowerCase() === q)
    || list.find((n) => n.name.toLowerCase().startsWith(q))
    || list.find((n) => q.includes(n.name.toLowerCase()))
    || (() => {
      const plat = /mac|macbook|imac|apple/.test(q) ? 'mac' : /ubuntu|linux|wayland/.test(q) ? 'linux' : /windows|pc|win/.test(q) ? 'windows' : null;
      const c = plat ? list.filter((n) => n.platform === plat && n.online) : [];
      return c.length ? c.sort((a, b) => b.rigs - a.rigs)[0] : null;
    })();
}

function meshStatusLine() {
  const up = machines();
  const busyM = up.map((m) => ({ m, live: (snap.find((e) => e.node.id === m.id)?.sessions || []).filter((s) => s.live).length })).filter((x) => x.live);
  const hot = up.filter((m) => (m.stats?.cpu || 0) > 70).map((m) => m.name);
  return `${up.length} of ${snap.length} machines online: ${up.map((m) => m.name).join(', ')}. ${busyM.length ? `Live work on ${busyM.map((x) => `${x.m.name} (${x.live})`).join(', ')}.` : 'No live agent sessions.'}${hot.length ? ` Running hot: ${hot.join(', ')}.` : ' All systems nominal.'}`;
}

/** Things JARVIS does instantly without asking an LLM. Returns true when handled. */
async function intent(text) {
  const t = text.trim().replace(/^(jarvis[, ]+|please |can you |could you )+/i, '');
  let m;
  const say = (s) => { showSubtitle(s); voice.say(s); };
  const cloudCmd = cloudCommand(t);
  if (cloudCmd != null) {
    const on = cloudCmd === 'toggle' ? !graph.visible : cloudCmd;
    setCloud(on);
    say(on ? `The cloud is back, ${persona.address}.` : 'Cloud hidden. Nothing of it renders until you ask for it again.');
    return true;
  }
  if ((m = t.match(/^(?:open |start |launch |give me )?(?:a |new )*(?:terminal|shell|console|command line)(?: on| for| at| to)?\s+(.+)$/i))) {
    const n = findMachine(m[1]);
    if (n?.rigs) { openTerminal({ nodeId: n.id, nodeName: n.name }); say(`Terminal on ${n.name}, ${persona.address}.`); return true; }
  }
  if ((m = t.match(/^ssh(?: to| into)?\s+(.+)$/i))) {
    const n = findMachine(m[1]);
    if (n) { sshTo(n); say(`Secure shell to ${n.name}. The session shows up in JARVIS on every machine.`); return true; }
  }
  if ((m = t.match(/^(?:open |show |browse )?(?:the )?files?(?: on| for| at| of)?\s+(.+)$/i))) {
    const n = findMachine(m[1]);
    if (n?.rigs) { filesOn(n); say(`${n.name}'s files.`); return true; }
  }
  if ((m = t.match(/^(?:open |start |connect |show )?(?:to )?(?:the )?(?:remote )?(?:desktop|screen)(?: on| to| for| of)?\s+(.+)$/i))) {
    const n = findMachine(m[1]);
    if (n) { desktopTo(n); say(`Connecting to ${n.name}'s desktop.`); return true; }
  }
  const browse = isBrowseAsk(t); // a folder or file: JARVIS opens it in the file browser (ui_open), not a pin or graph node
  if (!browse && (m = t.match(/^(?:open|show|go to)\s+(?:the\s+)?(.+?)(?:\s+project)?$/i))) {
    const q = m[1].toLowerCase().replace(/[?.!]$/, '').trim();
    const pin = allPins().find((p) => p.name.toLowerCase() === q) || allPins().find((p) => q.length > 2 && p.name.toLowerCase().includes(q));
    if (pin) { projectWindow(pin); say(`${pin.name}, on ${pin.node.name}.`); return true; }
  }
  if (/^(?:show|list|open)(?: me)?(?: the| all| my)?(?: live| running)? (?:active )?agents(?: panel)?$|^(?:active|live|running) agents$/i.test(t)) { showPanel('agents'); agentsPanel?.update(); say('The active agents, on every machine.'); return true; }
  if (/^(?:show |list |open )?(?:all |my )?(?:sessions|chats|conversations|coding sessions)\b/i.test(t)) { sessionsWindow(); say('Every session on every machine.'); return true; }
  if (/^(?:mesh |system )?status( report)?$|^how are (?:the |my )?(?:rigs|machines|systems)/i.test(t)) { say(meshStatusLine()); return true; }
  if (/^(?:update|upgrade|deploy|roll ?out)(?: the)?(?: mesh| all| everything| every machine)?$/i.test(t)) { meshWindow(); say(`Opening mesh control. Confirm the rollout there, ${persona.address}.`); return true; }
  if ((m = t.match(/^(?:start|launch|spawn|new)\s+(claude|codex|ollama|openrig|rig)(?: code)?(?: agent| session)?(?: on (\S+))?(?: in (\S+))?(?: to (.+))?$/i))) {
    const n = m[2] ? findMachine(m[2]) : machineById(selfId);
    if (n?.rigs) { const a = m[1].toLowerCase().replace('openrig', 'rig'); await startAgent(n, a, m[3] || '~', m[4] || ''); say(`${a} is starting on ${n.name}.`); return true; }
  }
  if ((m = t.match(/^(?:use|switch(?: brain)?(?: to)?|change (?:the )?brain to)\s+(.+)$/i))) {
    const [what, where] = m[1].toLowerCase().split(/\s+on\s+/);
    const target = where ? findMachine(where) : null;
    const pool = allBrains().filter((x) => !target || x.nodeId === target.id);
    const pref = (list) => list.find((x) => x.nodeId === selfId) || list[0];
    const words = what.replace(/claude /, '');
    const b = pref(pool.filter((x) => x.model && (words.includes(x.model.toLowerCase().split(':')[0]) || x.model.toLowerCase().includes(words.trim())))) || pref(pool.filter((x) => what.includes(x.brain)));
    if (b) { setBrain(b); say(`Switching my brain to ${b.label} on ${b.nodeName}.`); return true; }
  }
  if (!browse && (m = t.match(/^(?:focus|zoom(?: in)?(?: on)?|go to|show me)\s+(.+)$/i))) {
    const q = m[1].toLowerCase();
    const hit = graph.nodes().find((x) => x.name?.toLowerCase() === q) || graph.nodes().find((x) => x.name?.toLowerCase().includes(q));
    if (hit) { select(hit.id); say(`${hit.name}.`); return true; }
  }
  if ((m = t.match(/^(?:plan|start|create|new)(?: a| the)?(?: new)? project(?: to| for|:)?\s+(.+)$/i))) {
    const self = snap.find((e) => e.node.self)?.node;
    const b = currentBrain();
    say(`Planning it with ${b ? shortModel(b) : 'the core brain'}, ${persona.address}. I'll show you the routing before anything runs.`);
    try {
      const p = await api(`${node(self.id)}/projects`, { method: 'POST', body: { goal: m[1], planner: b ? { provider: b.brain, model: b.model, effort: b.effort, node: b.nodeName } : undefined } });
      const pw = projectsWindow({ owner: self.id, id: p.id });
      api(`${node(self.id)}/projects/${p.id}/plan`, { method: 'POST', body: {} }).then(() => { pw.open(self.id, p.id); refresh(); say(`The plan for ${p.name} is ready for your review.`); }).catch((e) => toast('Planning failed: ' + e.message, 'error', 12000));
    } catch (e) { toast(e.message, 'error'); }
    return true;
  }
  if (/^(?:show |open )?(?:my )?projects$/i.test(t)) { projectsWindow(); say('Your projects.'); return true; }
  if (/^(?:show |open |launch |start )?(?:the |my )?(?:app ?store|apps? catalog|app shop)$/i.test(t)) { openAppStore(); say('The App Store.'); return true; }
  if (/^(?:show |open |list )?(?:my |the )?(?:apps|applets|app cloud)$/i.test(t)) { openApps(); say('Your apps.'); return true; }
  if ((m = t.match(/^(?:open|launch|show|start|run)\s+(?:the |my )?(.+?)(?: app| applet)?$/i))) {
    await refreshApps();
    const a = findApp(m[1]);
    if (a) { openApp(a); say(`${a.name}, ${persona.address}.`); return true; }
  }
  if (/^(?:show|open)(?: me)? your face$/i.test(t)) { showFace(true); say(`At your service, ${persona.address}.`); return true; }
  if (/^(?:hide|close) your face$/i.test(t)) { showFace(false); say('As you wish.'); return true; }
  if (/^(stop|quiet|silence|shut up|enough)$/i.test(t)) { voice.stop(); busy?.abort(); setOrb('online'); return true; }
  return false;
}

// New input while JARVIS is still answering never interrupts that work: it goes to the overseer (a
// long-running agent session, persona.overseer, default tmux "jarvis-overseer" on this machine), which decides
// who should hear it — answer itself, queue it for a running agent, or start one — and replies via a
// notification. Typing into a busy Claude Code session queues the message instead of interrupting it.
// Without a live overseer the message waits and runs after the current reply.
const waiting = [];
function overseerSession() {
  const want = persona.overseer || { kind: 'tmux', id: 'jarvis-overseer' };
  for (const e of snap) {
    if (want.node && e.node.name !== want.node) continue;
    const s = (e.sessions || []).find((x) => x.kind === want.kind && x.id === want.id && x.live);
    if (s) return { node: e.node, s };
  }
  return null;
}

async function toOverseer(text) {
  const o = overseerSession();
  if (!o) {
    waiting.push(text);
    showSubtitle(`Noted — I'll take that up right after the current answer (${waiting.length} waiting).`, 'jarvis');
    return;
  }
  const note = `[New message from the user, typed into JARVIS while it is busy. You are the overseer: decide who should handle it — answer it yourself, queue it for the agent or session already working on that topic, or start a new agent. Never interrupt or stop a running agent or subagent; queue for them instead. Reply to the user with mesh_notify.]\n${text}`;
  try {
    await api(`${node(o.node.id)}/sessions/send`, { method: 'POST', body: { kind: o.s.kind, id: o.s.id, text: note } });
    showSubtitle(`Passed to the overseer on ${o.node.name} — it will route it without interrupting anyone.`, 'jarvis');
  } catch (e) { waiting.push(text); toast(`Overseer unreachable (${e.message}); queued after the current answer.`, 'error', 8000); }
}

async function ask(text, { spoken = false } = {}) {
  text = text.trim();
  if (!text) return;
  if (busy && !chatTarget && !/^(stop|quiet|silence|shut up|enough)$/i.test(text)) { showSubtitle(text, 'user'); await toOverseer(text); return; }
  voice.stop();
  showSubtitle(text, 'user');
  if (chatTarget && /^(?:detach|back to jarvis|talk to (?:jarvis|you)|stop chatting(?: here)?)\.?$/i.test(text.trim())) { detachChat(); return; }
  if (chatTarget) { await sendToSession(text); return; }
  if (await intent(text)) return;
  const b = currentBrain();
  if (!b) { const s = 'I have no brain on any machine yet. Install Claude Code, Codex or Ollama.'; showSubtitle(s); voice.say(s); return; }
  const ac = new AbortController();
  busy = ac;
  setOrb('thinking');
  let reply = '';
  let fed = 0; // characters of the spoken part already handed to the voice
  let felt = false;
  const tools = [];
  const chips = []; // activity chips for this reply's tool calls
  let startNode = ''; // the machine that hosts the local responder, from the turn's start event
  const tierTag = $('#dock-tier'); // "local · qwen3:8b" next to ◆ JARVIS while a locally answered reply is shown
  tierTag.classList.add('hidden');
  try {
    // Every request is routed on the server: a new conversation, or the ongoing thread it belongs to
    await stream(`${node(b.nodeId)}/jarvis/send`, { text, brain: b.brain, model: b.model, effort: b.effort }, (e) => {
      if (e.type === 'trace') claimTrace(e.traceId);
      if (e.type === 'route') {
        chatRef = { nodeId: b.nodeId, chatId: e.chatId };
        store.set('chat', chatRef);
        const rc = routeChip(e); // "route answer · pre-routed …" or "route direct · pre-routing off …"
        activity(rc.name, rc.detail).done(true);
      } else if (e.type === 'start') {
        startNode = e.node || '';
      } else if (e.type === 'done') {
        // a locally answered reply says so, discreetly; `done` carries the tier that answered (not a fallback)
        const lb = replyLabel({ ...e, node: e.node || startNode });
        if (lb) {
          activity(lb.name, lb.detail).done(true);
          tierTag.textContent = `${lb.name} · ${e.model || 'local model'}`;
          tierTag.title = `Answered by the local responder: ${lb.detail}`;
          tierTag.classList.remove('hidden');
        }
      } else if (e.type === 'delta') {
        if (!reply) setOrb('speaking');
        reply += e.text;
        showSubtitle(reply, 'jarvis');
        const say = spokenText(reply);
        if (!felt && /[.!?]\s/.test(say + ' ') && say.length > 12) { felt = true; feel(say); } // first sentence sets the expression early
        if ((spoken || !voice.muted) && say.length > fed) { voice.feed(say.slice(fed)); fed = say.length; }
      } else if (e.type === 'tool') {
        tools.push(e.name);
        chips.push(activity(e.name, e.input));
        showSubtitle(`${reply}\n⚙ ${tools.slice(-3).join(' · ')}`, 'jarvis');
      } else if (e.type === 'status') {
        if (e.reset) { reply = ''; fed = 0; felt = false; } // the fast path handed over: the full brain's reply starts afresh
        showSubtitle(`${reply}\n… ${e.text}`, 'jarvis');
      } else if (e.type === 'error') {
        toast(e.message, 'error', 10000);
        if (!reply) showSubtitle(e.message, 'error');
      }
    }, ac.signal);
    for (const c of chips) c.done(true);
    const say = spokenText(reply, true);
    if (say.trim()) feel(say); // the whole spoken line refines it
    if ((spoken || !voice.muted) && say.length > fed) voice.feed(say.slice(fed));
    voice.feed('', true);
    if (!voice.speaking) setOrb(voice.mode === 'handsfree' ? 'listening' : 'online');
    else setTimeout(function wait() { if (voice.speaking) setTimeout(wait, 300); else setOrb(voice.mode === 'handsfree' ? 'listening' : 'online'); }, 300);
  } catch (e) {
    for (const c of chips) c.done(false);
    if (e.name !== 'AbortError') { toast(e.message, 'error'); showSubtitle(e.message, 'error'); setOrb('error'); setTimeout(() => setOrb('online'), 2500); }
  } finally {
    if (busy === ac) busy = null;
    if (!busy && waiting.length) setTimeout(() => ask(waiting.shift()), 400); // next queued message
  }
}

async function continueChat(m, s) {
  chatRef = { nodeId: m.id, chatId: s.id };
  store.set('chat', chatRef);
  try {
    const c = await api(`${node(m.id)}/chats/${s.id}`);
    setBrain({ nodeId: m.id, nodeName: m.name, brain: c.brain, model: c.model, effort: c.effort }, { quiet: true });
    chatRef = { nodeId: m.id, chatId: s.id };
    store.set('chat', chatRef);
    const last = c.messages.filter((x) => x.role === 'assistant').pop();
    showSubtitle(last ? last.text : 'Conversation resumed.', 'jarvis');
    conversationWindow();
  } catch (e) { toast(e.message, 'error'); }
}

/** Send what is in the Ask field (Enter, or ➤ in the Ask panel). */
function submitAsk() {
  const el = $('#ask');
  const v = el.value;
  el.value = '';
  rememberAsk(v);
  ask(v);
}

// ------------------------------------------------------------------ chat dock ↔ any session
const TARGET_ICON = { claude: '✳', codex: '◎', tmux: '▣', rig: '⛭', pty: '⌨' };
let targetPoll = null;
let targetLast = '';

function renderDock() {
  const label = $('#dock-target');
  if (!label) return;
  if (chatTarget) {
    label.textContent = `${TARGET_ICON[chatTarget.kind] || '💬'} ${chatTarget.title || chatTarget.id} · ${chatTarget.nodeName}`;
    label.title = `Chat attached to this ${chatTarget.kind} session on ${chatTarget.nodeName} — click for its transcript`;
    $('#ask').placeholder = `Message ${chatTarget.kind} session on ${chatTarget.nodeName}…`;
  } else {
    label.textContent = '◆ JARVIS';
    label.title = 'Chatting with JARVIS — click for the conversation; attach to any session with 💬 Chat here';
    $('#ask').placeholder = 'Ask JARVIS…';
  }
  $('#dock-detach').classList.toggle('hidden', !chatTarget);
  $('#chat-dock').classList.toggle('attached', !!chatTarget);
}

function lastReply(t) {
  const out = (Array.isArray(t) ? t : []).filter((x) => x.role !== 'user' && x.text?.trim());
  const m = out[out.length - 1];
  return m ? m.text.trim() : '';
}

async function pollTarget(first = false) {
  const t = chatTarget;
  if (!t) return;
  try {
    const [tr, st, choices] = await Promise.all([
      api(`${node(t.nodeId)}/sessions/transcript?kind=${encodeURIComponent(t.kind)}&id=${encodeURIComponent(t.id)}`),
      t.kind === 'claude' || t.kind === 'codex' ? api(`${node(t.nodeId)}/sessions/state?kind=${t.kind}&id=${encodeURIComponent(t.id)}`).catch(() => null) : null,
      t.kind === 'tmux' || t.kind === 'rig' ? api(`${node(t.nodeId)}/sessions/prompt?kind=${t.kind}&id=${encodeURIComponent(t.id)}`).catch(() => null) : null,
    ]);
    if (chatTarget !== t) return;
    renderChoices(t, choices);
    // tmux/pty transcripts are the whole screen: show its tail
    const text = t.kind === 'tmux' || t.kind === 'rig' || t.kind === 'pty' ? (lastReply(tr).split('\n').filter((l) => l.trim()).slice(-14).join('\n')) : lastReply(tr);
    if (text && (text !== targetLast || first)) {
      const fresh = !first && text !== targetLast && targetLast !== '';
      targetLast = text;
      showSubtitle(text, 'jarvis');
      if (fresh && !voice.muted && (t.kind === 'claude' || t.kind === 'codex')) voice.say(spokenText(text, true));
    }
    setOrb(st?.running ? 'thinking' : voice.mode === 'handsfree' ? 'listening' : 'online');
  } catch (e) { if (first) showSubtitle(e.message, 'error'); }
}

// The numbered question on an attached terminal session, shown as buttons under the reply.
let choicesSig = '';
function renderChoices(t, p) {
  const sig = p?.options?.length ? `${t.id}|${p.question}|${p.options.map((o) => o.label).join('|')}` : '';
  if (sig === choicesSig) return;
  choicesSig = sig;
  let box = $('#dock-choices');
  if (!box) { box = h('div', { id: 'dock-choices' }); $('#chat-dock').append(box); }
  box.replaceChildren(...(sig ? [
    h('div', { class: 'dock-q' }, p.question || 'Waiting for your answer'),
    h('div', { class: 'dock-opts' }, ...p.options.map((o) => h('button', { class: 'btn', onclick: () => answerChoice(t, o) }, `${o.n}. ${o.label}`))),
  ] : []));
}

async function answerChoice(t, o) {
  try {
    await api(`${node(t.nodeId)}/sessions/answer`, { method: 'POST', body: { kind: t.kind, id: t.id, choice: o.n } });
    choicesSig = '';
    $('#dock-choices')?.replaceChildren();
    setOrb('thinking');
    setTimeout(() => pollTarget(), 1200);
  } catch (e) { toast(e.message, 'error', 9000); }
}

/** Attach the chat dock to a session: what you type or say goes into it, its replies show here. */
function attachChat(m, s) {
  if (s.kind === 'chat') { continueChat(m, s); return; }
  chatTarget = { nodeId: m.id, nodeName: m.name, kind: s.kind, id: s.id, title: s.title || s.id, live: !!s.live, cwd: s.cwd };
  store.set('chatTarget', chatTarget);
  targetLast = '';
  showPanel('dock');
  renderDock();
  clearInterval(targetPoll);
  targetPoll = setInterval(() => pollTarget(), 2500);
  pollTarget(true);
  toast(`Chat attached to ${s.kind} session “${chatTarget.title}” on ${m.name}. Say “detach” to talk to JARVIS again.`);
  focusAsk(); // wherever Ask is: reopens it when hidden, peeks a hidden menu bar
}

function detachChat() {
  chatTarget = null;
  choicesSig = '';
  $('#dock-choices')?.replaceChildren();
  store.set('chatTarget', null);
  clearInterval(targetPoll);
  targetPoll = null;
  renderDock();
  showSubtitle(`Back with you, ${persona.address}.`, 'jarvis');
  setOrb(voice.mode === 'handsfree' ? 'listening' : 'online');
}

async function sendToSession(text) {
  const t = chatTarget;
  try {
    const r = await api(`${node(t.nodeId)}/sessions/send`, { method: 'POST', body: { kind: t.kind, id: t.id, text } });
    setOrb('thinking');
    showSubtitle(r.delivered === 'resume' ? `→ ${t.title}: ${text}\n… working` : `→ ${t.title}: ${text}`, 'user');
    setTimeout(() => pollTarget(), 1200);
  } catch (e) { toast(e.message, 'error', 9000); showSubtitle(e.message, 'error'); }
}

let convWin = null; // the one Conversation window: clicking the subtitle again raises and reloads it
async function conversationWindow() {
  if (chatTarget) { const m = machineById(chatTarget.nodeId); if (m) sessionsWindow('', { node: m, s: chatTarget }); return; }
  if (!chatRef) { toast('No conversation yet — ask me something.'); return; }
  let w = convWin;
  if (w?.el.isConnected && !w.el.classList.contains('win-leave')) { w.raise(); w.el.classList.remove('panel-closed'); }
  else {
    w = convWin = openWindow({ title: 'Conversation', icon: '◆', width: 640, height: 520 });
    w.onCleanup(() => { if (convWin === w) convWin = null; });
    w.body.append(h('div', { class: 'toolbar' }, h('button', { class: 'tb', onclick: () => { chatRef = null; store.set('chat', null); w.close(); toast('New conversation'); } }, '＋ New conversation')), h('div', { class: 'transcript' }));
  }
  const list = w.body.querySelector('.transcript');
  try {
    const c = await api(`${node(chatRef.nodeId)}/chats/${chatRef.chatId}`);
    const older = Math.max(0, c.messages.length - CAPS.chatMessages); // a long conversation shows its latest messages, not thousands of nodes
    list.replaceChildren(...(older ? [h('div', { class: 'muted small pad' }, `${older} earlier messages not shown`)] : []), ...c.messages.slice(older).map((x) => h('div', { class: `msg r-${x.role}` }, h('div', { class: 'mr' }, x.role === 'user' ? 'you' : `${x.brain}${x.model ? ' · ' + x.model : ''}${x.tier === 'local' ? ' · local' : ''}`), h('div', { class: 'mt' }, x.text))));
    list.scrollTop = list.scrollHeight;
  } catch (e) { list.replaceChildren(h('div', { class: 'muted pad' }, e.message)); }
}

// ------------------------------------------------------------------ processes on any machine
function processesWindow(m) {
  const w = openWindow({ title: `Processes — ${m.name}`, icon: '⚙', width: 760, height: 520 });
  const filter = h('input', { class: 'path-input', placeholder: 'Filter by name or command (e.g. moonlight)' });
  const sort = h('select', { class: 'mini' }, ...['cpu', 'mem', 'age', 'name'].map((v) => h('option', { value: v }, `by ${v}`)));
  const list = h('div', { class: 'proc-list' });
  const status = h('span', { class: 'muted small' });
  async function load() {
    try {
      const r = await api(`${node(m.id)}/processes?${new URLSearchParams({ filter: filter.value.trim(), sort: sort.value, limit: '120' })}`);
      status.textContent = `${r.shown} of ${r.total}`;
      list.replaceChildren(...r.processes.map((p) => h('div', { class: 'proc-row' },
        h('span', { class: 'proc-pid' }, p.pid), h('b', { class: 'proc-name', title: p.args }, p.name),
        h('span', { class: 'proc-num' }, `${p.cpu.toFixed(0)}%`), h('span', { class: 'proc-num' }, `${p.rssMB} MB`),
        h('span', { class: 'proc-args muted small', title: p.args }, p.args),
        p.protected ? h('span', { class: 'muted small' }, 'RIGS/system') : act('Stop', () => stop(p), 'danger'))));
    } catch (e) { list.replaceChildren(h('div', { class: 'muted pad' }, e.message)); }
  }
  async function stop(p) {
    if (!confirm(`Stop ${p.name} (pid ${p.pid}) on ${m.name}? It gets TERM, then KILL after 3 s.`)) return;
    try {
      const r = await api(`${node(m.id)}/processes/kill`, { method: 'POST', body: { pid: p.pid } });
      toast(r.stopped?.length ? `Stopped ${p.name} on ${m.name}${r.stopped[0].forced ? ' (forced)' : ''}` : `${p.name} is still running`, r.stopped?.length ? 'ok' : 'error');
    } catch (e) { toast(e.message, 'error'); }
    load();
  }
  let t;
  filter.oninput = () => { clearTimeout(t); t = setTimeout(load, 300); };
  sort.onchange = load;
  w.body.append(h('div', { class: 'toolbar' }, filter, sort, h('button', { class: 'tb', onclick: load }, '↻'), status), list);
  load();
  const timer = setInterval(() => { if (!document.body.contains(list)) clearInterval(timer); else load(); }, 5000);
}

// ------------------------------------------------------------------ wiring
function wire() {
  // Every panel floats: drag by its title bar (or ⠿), close with ✕, bring back from ☰; ☰ also switches the docking layout (panels.js, docking.js)
  makeFloating($('#left'), { id: 'left', title: 'Side panel', into: $('#left .brand'), keep: [$('#left .brand')] });
  makeFloating($('#legend'), { id: 'legend', title: 'Filters', handle: $('#legend .sec-h'), keep: [$('#legend .sec-h')] });
  makeFloating($('#topbar'), { id: 'topbar', title: 'Top bar' });
  makeFloating($('#orb-wrap'), { id: 'orb', title: 'JARVIS face', keep: [$('#orb'), $('#orb-state')] });
  makeFloating($('#chat-dock'), { id: 'dock', title: 'Chat', into: $('#chat-dock .dock-head'), keep: [$('#chat-dock .dock-head')] });
  // Questions and Active projects were one "work" panel: 'work' keeps its saved layout as Active projects,
  // and the new Questions panel starts closed if the old one was.
  inheritPanel('questions', 'work');
  work = createWork($('#work'), {
    onOpenProject: (n, pj) => projectsWindow({ owner: n.nodeId, id: pj.id }),
    onOpenQuestions: showQuestions,
    getWaiting: attnItems,
  });
  makeFloating($('#work'), { id: 'work', title: 'Active projects', into: $('#work .wk-head'), keep: [$('#work .wk-head')], closedOnPhone: true, onToggle: ({ closed, collapsed }) => work.setActive(!closed && !collapsed) });
  { const st = panelState('work'); work.setActive(!st.closed && !st.collapsed); }
  const questions = createQuestions($('#questions'), { onOpenQuestion: (g, it) => openAttention({ ...it, nodeId: g.nodeId, nodeName: g.node }) });
  makeFloating($('#questions'), { id: 'questions', title: 'Questions', into: $('#questions .wk-head'), keep: [$('#questions .wk-head')], closedOnPhone: true, onToggle: ({ closed, collapsed }) => questions.setActive(!closed && !collapsed) });
  { const st = panelState('questions'); questions.setActive(!st.closed && !st.collapsed); }
  const usagePanel = createUsage($('#usage'), { routerNode: () => currentBrain()?.nodeId });
  makeFloating($('#usage'), { id: 'usage', title: 'Tokens & time', into: $('#usage .wk-head'), keep: [$('#usage .wk-head')], closedByDefault: true, closedOnPhone: true, onToggle: ({ closed, collapsed }) => usagePanel.setActive(!closed && !collapsed) });
  { const st = panelState('usage'); usagePanel.setActive(!st.closed && !st.collapsed); }
  const desktopsPanel = createDesktops($('#desktops'), { machines: () => machines().map((m) => ({ id: m.id, name: m.name })) });
  makeFloating($('#desktops'), { id: 'desktops', title: 'Desktops', into: $('#desktops .wk-head'), keep: [$('#desktops .wk-head')], closedByDefault: true, closedOnPhone: true, onToggle: ({ closed, collapsed }) => desktopsPanel.setActive(!closed && !collapsed) });
  { const st = panelState('desktops'); desktopsPanel.setActive(!st.closed && !st.collapsed); }
  const tracesPanel = createTraces($('#traces'));
  makeFloating($('#traces'), { id: 'traces', title: 'Request traces', into: $('#traces .wk-head'), keep: [$('#traces .wk-head')], closedByDefault: true, closedOnPhone: true, onToggle: ({ closed, collapsed }) => tracesPanel.setActive(!closed && !collapsed) });
  { const st = panelState('traces'); tracesPanel.setActive(!st.closed && !st.collapsed); }
  agentsPanel = createAgents($('#agents'), {
    snapshot: () => snap, onAttach: attachSession, onChat: attachChat,
    onCount: (n, waiting) => { agentCount = n; syncToolBadges(); const b = $('#agents-badge'); b.textContent = String(n); b.hidden = !n; b.classList.toggle('warn', waiting > 0); $('#btn-agents').setAttribute('aria-label', `Active agents — ${n} live${waiting ? `, ${waiting} waiting for you` : ''}`); },
  });
  makeFloating($('#agents'), { id: 'agents', title: 'Active agents', into: $('#agents .ag-head'), keep: [$('#agents .ag-head')], closedByDefault: true, onToggle: () => agentsPanel.update() });
  agentsPanel.update();
  graphifyPanel = createGraphify($('#graphify'), { createGraph, types: TYPES, data: () => buildGraph(visibleSnap()), hidden: () => [...hiddenTypes], attention: attentionGraphIds, onSelect: (n) => { select(n.id); revealInspector(); } });
  makeFloating($('#graphify'), { id: 'graphify', title: 'Graphify', into: $('#graphify .wk-head'), keep: [$('#graphify .wk-head')], closedByDefault: true, closedOnPhone: true, onToggle: ({ closed, collapsed }) => graphifyPanel.setActive(!closed && !collapsed) });
  { const st = panelState('graphify'); graphifyPanel.setActive(!st.closed && !st.collapsed); }
  makeFloating($('#footer'), { id: 'footer', title: 'Footer' });
  initMobile(); // phone layout: drawer, ⋯ sheet, keyboard offset (mobile.js)
  appDock = createAppDock({ // the app dock only calls the existing open / focus / launch paths
    sources: () => ({ ...sourcesFromSnapshot(snap, { isRemoved: isAppRemoved }), tools: TOOLS }),
    toolLabel: (it) => document.getElementById(it.ref.button)?.getAttribute('aria-label') || '',
    appFor: (ref) => meshApps().find((a) => a.nodeId === ref.node && a.id === ref.id) || null,
    nodeFor: (id) => machineById(id) || null,
    isOpen: (it) => {
      if (it.kind === 'panel') return !panelState(it.ref.id).closed;
      if (it.kind === 'tool') { const p = TOOL_PANEL[it.ref.action]; return !!p && !panelState(p).closed; }
      if (it.kind === 'window') return it.live;
      if (it.kind === 'terminal') return it.live;
      if (it.kind !== 'applet') return false;
      const a = meshApps().find((x) => x.nodeId === it.ref.node && x.id === it.ref.id);
      return !!a && isAppOpen(a);
    },
    open: (it) => {
      if (it.kind === 'applet') {
        const a = meshApps().find((x) => x.nodeId === it.ref.node && x.id === it.ref.id);
        if (a) openApp(a); else toast(`${it.title} is not on the mesh right now.`, 'info');
      } else if (it.kind === 'rig') { select(`m:${it.ref.nodeId}`); revealInspector(); }
      else if (it.kind === 'panel' || it.kind === 'window') openPanel({ kind: it.kind, id: it.ref.id });
      else if (it.kind === 'terminal') focusTerminal(it.ref.ptyId);
      else if (it.kind === 'tool') document.getElementById(it.ref.button)?.click(); // exactly what the old toolbar button does
    },
  });
  syncToolBadges();
  // Auto-docking: panels and floating windows (wm.js) and terminals (terminal.js) announce open / close on the bus; the
  // dock turns them into items only when its autoDock / autoTabTerminals settings are on (both off by default).
  appDock.act((s) => reconcileOnLoad(s, listPanels())); // a reload leaves no window or terminal open: drop their stale items
  bindDock(openBus, appDock);
  trackPanels({ list: listPanels, subscribe: (fn) => dockManager.subscribe(fn) });
  wireMenus();
  $('#btn-work').onclick = () => { if (isPhone() && panelState('work').closed) setClosed('questions', true); togglePanel('work'); };
  $('#btn-ask').onclick = () => { if (panelState('questions').closed) showQuestions(); else togglePanel('questions'); };
  $('#btn-agents').onclick = () => togglePanel('agents');
  $('#btn-usage').onclick = () => togglePanel('usage');
  $('#btn-desktops').onclick = () => togglePanel('desktops');
  $('#btn-traces').onclick = () => togglePanel('traces');
  $('#btn-graphify').onclick = () => togglePanel('graphify');
  $('#dock-target').onclick = conversationWindow;
  $('#dock-detach').onclick = detachChat;
  renderDock();
  if (chatTarget) { targetPoll = setInterval(() => pollTarget(), 2500); pollTarget(true); }
  $('#ask').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAsk(); });
  $('#btn-mic').onclick = () => { if (!voice.pushToTalk()) toast(window.isSecureContext ? 'This browser cannot record the microphone.' : 'Microphone needs https or localhost — run `rigs setup --https` or open http://localhost:4719 on this machine.', 'error', 8000); };
  $('#btn-hands').onclick = () => {
    const on = voice.toggleHandsFree();
    $('#btn-hands').classList.toggle('on', on);
    $('#btn-hands').setAttribute('aria-pressed', String(on));
    if (on) { toast('Hands-free: just say “Jarvis, …”'); voice.say(`Listening, ${persona.address}.`); }
  };
  $('#btn-term').onclick = () => { const n = graph.focused ? machineById(graph.get(graph.focused)?.machine) : null; const m = n || machineById(selfId); if (m) openTerminal({ nodeId: m.id, nodeName: m.name }); };
  $('#btn-files').onclick = () => { const n = graph.focused ? machineById(graph.get(graph.focused)?.machine) : null; filesOn(n || machineById(selfId)); };
  $('#btn-desk').onclick = () => { const n = graph.focused ? machineById(graph.get(graph.focused)?.machine) : null; if (n && !n.self) desktopTo(n); else toast('Focus another machine first (click it in the galaxy), then press 🖥.'); };
  $('#btn-sess').onclick = () => sessionsWindow();
  $('#btn-mesh').onclick = meshWindow;
  $('#btn-proj').onclick = () => projectsWindow();
  $('#btn-apps').onclick = () => openApps();
  $('#btn-mute').onclick = () => { voice.setMuted(!voice.muted); $('#btn-mute').textContent = voice.muted ? '🔇' : '🔊'; $('#btn-mute').setAttribute('aria-pressed', String(voice.muted)); syncToolBadges(); };
  $('#btn-mute').textContent = voice.muted ? '🔇' : '🔊';
  $('#btn-mute').setAttribute('aria-pressed', String(voice.muted));
  $('#btn-mute').setAttribute('aria-label', 'Mute voice output');
  $('#subtitle').onclick = conversationWindow;
  $('#brain-badge').onclick = () => toggleBrainMenu();
  $('#back').onclick = clearSelection;
  $('#fit').onclick = clearSelection;
  $('#refresh').onclick = async () => { await api('/api/mesh/refresh', { method: 'POST' }).catch(() => {}); refresh(); };
  $('#orb').onclick = () => voice.pushToTalk() || conversationWindow();
  const repel = $('#repel');
  const len = $('#linklen');
  repel.value = store.get('repel', 120);
  len.value = store.get('linklen', 24);
  graph.setForces({ repel: Number(repel.value), linkLength: Number(len.value) });
  repel.oninput = () => { store.set('repel', Number(repel.value)); graph.setForces({ repel: Number(repel.value) }); };
  len.oninput = () => { store.set('linklen', Number(len.value)); graph.setForces({ linkLength: Number(len.value) }); };
  const cloudBox = $('#d-cloud');
  cloudBox.onchange = () => setCloud(cloudBox.checked);
  $('#cloud-toggle').onclick = () => setCloud(!graph.visible);
  syncCloud();
  for (const k of ['labels', 'particles', 'rotate']) {
    const el = $('#d-' + k);
    el.checked = store.get('d-' + k, k === 'particles' || k === 'rotate' ? !lowPower() : true);
    graph.setDisplay({ [k]: el.checked });
    el.onchange = () => { store.set('d-' + k, el.checked); graph.setDisplay({ [k]: el.checked }); };
  }
  for (const [id, key] of [['#d-notify', 'notifications'], ['#d-attnbanner', 'attnBanner']]) {
    $(id).onchange = (e) => { prefs()[key] = e.target.checked; if (!e.target.checked && key === 'notifications') $('#toasts')?.querySelectorAll('.toast').forEach((t) => t.remove()); syncNotifyChecks(); renderAttention(); };
  }
  syncNotifyChecks();
  const auto = $('#d-autosess');
  auto.checked = store.get('autoOpenSessions', true);
  auto.onchange = () => store.set('autoOpenSessions', auto.checked);
  const exAnim = $('#d-exanim'); // Exhibit animations: off | auto | always (exhibits.js keeps it under rigs.exhibitAnim, like `store`)
  exAnim.value = exhibitAnim();
  exAnim.onchange = () => setExhibitAnim(exAnim.value);
  window.addEventListener('rigs:exhibit-anim', (e) => { exAnim.value = e.detail; });
  const themeSel = $('#d-theme');
  themeSel.replaceChildren(...Object.entries(THEMES).map(([id, t]) => h('option', { value: id }, t.name)));
  themeSel.value = themeId();
  themeSel.onchange = () => applyTheme(themeSel.value);
  const search = $('#search');
  const results = $('#search-results');
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    if (!q) { results.replaceChildren(); return; }
    const hits = graph.nodes().filter((x) => x.name?.toLowerCase().includes(q)).slice(0, 12);
    results.replaceChildren(...hits.map((x) => { const el = h('div', { class: 'conn' }, h('i', { style: { background: TYPES[x.type]?.color } }), h('span', {}, x.name)); el.onclick = () => { select(x.id); results.replaceChildren(); search.value = ''; }; return el; }));
  });
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') results.firstChild?.click(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('#brain-menu').classList.remove('open'); if (graph.focused) clearSelection(); }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#brain-menu,#brain-badge')) $('#brain-menu').classList.remove('open'); });
  if (!voice.supported) { $('#btn-hands').classList.add('dim'); $('#btn-mic').classList.add('dim'); }
}

wire();
initA11y();
initPopovers();
setOrb('online');
api('/api/local/brain/core').then((c) => { coreDefault = c; renderBrainBadge(); }).catch(() => {});
api('/api/local/brain/chat').then((c) => { chatDefault = c; renderBrainBadge(); }).catch(() => {});
api('/api/local/global').then((g) => { globalBrain = g; renderBrainBadge(); }).catch(() => {});
api('/api/local/config').then((c) => { persona = c.persona; $('#ask').placeholder = `Ask ${c.persona.name.replace(/\./g, '')} — "status", "terminal on ubuntu", "files on mac", "start claude on windows"…`; }).catch(() => {});
await refresh();
graph.fit();
connectEvents();
initExhibits();
initStarnet({
  graphEl: $('#graph'), data: () => buildGraph(visibleSnap()), attention: attentionGraphIds, hidden: () => [...hiddenTypes],
  onSelect: (id, at) => { select(id, { keepView: !!at }); revealInspector(); if (at) stationMenu(id, at); },
  onContext: (id, at) => stationMenu(id, at),
  onAction: stationAction,
  onPointer: () => closeMenus({ restore: false }),
  pauseGraph: () => graph.pause(), resumeGraph: () => graph.resume(),
});
setInterval(() => { if (!document.hidden) refresh(); }, 15000);
setInterval(() => { if (!document.hidden) refreshAttention(); }, 4000);

// Idle-time sweep (cleanup.js): every few minutes, when the browser has nothing better to do, prune what a tab left
// open for days accumulates. Each task returns how much it dropped; window.__rigsCleanup shows the last run.
const sweeper = createSweeper({ everyMs: 180000 });
sweeper.add('attachedTerminals', () => { let n = 0; for (const [k, w] of attached) if (!w.el.isConnected) { attached.delete(k); n++; } return n; });
sweeper.add('dismissedToasts', () => capMap(closedTexts, CAPS.dismissed));
sweeper.add('resourceTimings', () => { const n = performance.getEntriesByType?.('resource')?.length || 0; performance.clearResourceTimings?.(); return n; }); // one entry per API poll
sweeper.add('cloudLabels', () => { // CSS2D labels left in the galaxy's label layer by nodes that are gone
  const ids = new Set(graph.nodes().map((n) => n.__label).filter(Boolean));
  let n = 0;
  for (const el of document.querySelectorAll('#graph .nlabel')) if (!ids.has(el) && !el.classList.contains('attn-tag')) { el.remove(); n++; }
  return n;
});
sweeper.start();
window.__rigsCleanup = { stats: sweeper.stats, run: () => sweeper.run() };
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); refreshAttention(); } });
refreshAttention();
setTimeout(() => { const s = `${greeting()}, ${persona.address}. ${meshStatusLine()}`; showSubtitle(s); }, 1200);

// ------------------------------------------------------------------ top menu bar, commands, layout adapter
/** The machine the menus act on: the one focused in the galaxy, else this one. */
function focusedMachine() {
  const n = graph.focused ? machineById(graph.get(graph.focused)?.machine) : null;
  return n || machineById(selfId) || null;
}

function wireMenus() {
  initLayout({
    apps: {
      list: meshApps,
      open: (a) => openApp(a),
      close: (a) => closeApp(a),
      changed: () => { graph.setData(buildGraph(visibleSnap())); graphifyPanel?.update(); renderAppList(); renderFilters(); rerenderApps(); },
    },
  });
  let bar = null;
  const reveal = (sel) => {
    if (isPhone()) openDrawer({ focus: false }); else showPanel('left');
    setTimeout(() => { const el = $(sel); el?.scrollIntoView?.({ block: 'center' }); el?.focus({ preventScroll: true }); }, 60);
  };
  registerJarvisCommands({
    projects: () => projectsWindow(),
    openApps: () => openApps(),
    openAppStore: () => openAppStore(),
    files: (m) => filesOn(m),
    sessions: () => sessionsWindow(),
    mesh: () => meshWindow(),
    find: () => reveal('#search'),
    display: () => reveal('#d-theme'),
    brainMenu: () => { showPanel('orb'); setTimeout(() => toggleBrainMenu(), 0); },
    terminal: (m) => openTerminal({ nodeId: m.id, nodeName: m.name }),
    control: (m) => openControl({ machine: m }),
    machine: focusedMachine,
    self: () => machineById(selfId),
    machines,
    menubar: { toggle: () => bar?.toggle(), focus: () => bar?.focus() },
    ask: { mode: askMode, focus: focusAsk, topbar: () => dockAskToTopbar(), float: floatAsk, hide: hideAsk },
    exhibits: { enabled: exhibitsEnabled, toggle: () => setExhibitsEnabled(!exhibitsEnabled()), open: () => openExhibits() },
    starnet: { enabled: starnetEnabled, toggle: () => setStarnetEnabled(!starnetEnabled()) },
    cloud: { visible: () => graph.visible, toggle: () => setCloud(!graph.visible) },
  });
  bar = initMenubar({
    menus: menuModel,
    status: () => { const me = machineById(selfId); return me ? `${me.name} · ${me.version || ''}` : ''; },
  });
  initAskPanel({ onSend: submitAsk }); // after the menu bar: its slot is one of Ask's places
  wireContextMenus();
}

// ------------------------------------------------------------------ context menus
/** Hide every node of a galaxy type (the Filters panel's switch, from a node's menu). */
function hideType(type) {
  hiddenTypes.add(type);
  store.set('hidden', [...hiddenTypes]);
  graph.setHidden([...hiddenTypes]);
  renderFilters();
}

async function projectAct(p, op) {
  const said = { stop: 'Paused — nothing of it runs until you resume', resume: 'Resumed', dispatch: 'Dispatched every ready task' };
  try { await api(`${node(p.ownerId)}/projects/${p.id}/${op}`, { method: 'POST', body: {} }); toast(said[op] || 'Done', 'ok'); refresh(); }
  catch (e) { toast(e.message, 'error', 10000); }
}

async function taskMark(p, t, status) {
  try { await api(`${node(p.ownerId)}/projects/${p.id}/tasks/${t.id}`, { method: 'POST', body: { status, summary: status === 'done' ? 'marked done by hand' : '' } }); refresh(); }
  catch (e) { toast(e.message, 'error', 10000); }
}

async function taskSession(p, t) {
  const m = snap.find((e) => e.node.name === t.assign?.node)?.node;
  const s = t.run?.session;
  if (!m || !s) { toast(`${t.assign?.node || 'The machine'} is offline`, 'error'); return; }
  try {
    const r = s.kind === 'pty' ? { ptyId: s.id } : await api(`${node(m.id)}/sessions/attach`, { method: 'POST', body: { kind: s.kind, id: s.id } });
    popups.mark(m.id, s.kind, s.id);
    openTerminal({ nodeId: m.id, nodeName: m.name, ptyId: r.ptyId, title: `${t.id} · ${t.title}`.slice(0, 60) });
  } catch (e) { toast(e.message, 'error'); }
}

/** One delegated right-click / long-press listener; what each surface offers lives in ctx-providers.js. */
function wireContextMenus() {
  const providers = createProviders();
  registerJarvisProviders(providers, {
    copy: copyText,
    layout: { toggleCollapse, isCollapsed, resetPanel, canDock, isDocked, dock: dockPanel, float: floatPanel, removed: listRemoved },
    window: { toggleMax: toggleMaximize, isMax: isMaximized, closeOthers, closeAll: closeAllWindows, count: windowCount },
    app: {
      key: appKey, isOpen: isAppOpen, status: (a) => a.health?.status, url: (a) => `${location.origin}${appPath(a)}`,
      open: openApp, openTab: (a) => window.open(appPath(a), '_blank', 'noopener'), reload: reloadApp,
    },
    session: {
      transcript: (n, s) => sessionsWindow('', { node: n, s }),
      attach: (n, s) => (s.kind === 'chat' ? continueChat(n, s) : attachSession(n, s)),
      chat: (n, s) => attachChat(n, s),
      galaxy: (n, s) => { select(`s:${n.id}:${s.kind}:${s.id}`); revealInspector(); },
      newHere: (n, s) => newAgent(machineById(n.id) || n, s.agent || s.kind, s.cwd),
    },
    project: { open: (p) => projectsWindow({ owner: p.ownerId, id: p.id }), act: projectAct, galaxy: (p) => { select(`pj:${p.id}`); revealInspector(); } },
    task: { openSession: taskSession, mark: taskMark },
    node: {
      get: (n) => machineById(n.id) || n,
      status: (m) => { select(`m:${m.id}`); revealInspector(); },
      terminal: (m) => openTerminal({ nodeId: m.id, nodeName: m.name }),
      files: (m) => filesOn(m),
      screen: (m) => openLargeView({ id: m.id, name: m.name }),
      sessions: (m) => sessionsWindow(m.name),
      control: (m) => openControl({ machine: m }),
      ssh: sshTo,
      sshCommand: (m) => `ssh ${m.sshAlias || m.name}`,
      newAgent: (m, kind) => newAgent(m, kind),
    },
    trace: { open: (id, summary) => openTrace(id, summary) },
    galaxy: {
      select: (id) => { select(id); revealInspector(); },
      fit: () => { if (!starnetFit()) graph.fit(); },
      hideType,
      typeLabel: (t) => TYPES[t]?.label,
      talkToModel: (n) => { const m = machineById(n.machine); if (m) setBrain({ nodeId: m.id, nodeName: m.name, brain: 'ollama', model: n.model }); },
      useAsBrain: (n) => { const m = machineById(n.machine); if (m) setBrain({ nodeId: m.id, nodeName: m.name, brain: n.agent, model: '' }); },
      newSession: (n) => { const m = machineById(n.machine); if (m) newAgent(m, n.agent); },
      newInProject: (n) => { const s = graph.neighbors(n.id, 1).find((x) => x.session?.cwd); const m = s && machineById(s.machine); if (m) newAgent(m, 'claude', s.session.cwd); else toast('No session of this project is on an online machine.', 'info'); },
    },
    station: { select: (id) => { select(id); revealInspector(); }, fit: () => starnetFit() },
  });
  if (appDock) registerAppDockProviders(providers, appDock);
  // The galaxy is a canvas: ask the graph which node is under the pointer.
  const galaxyEl = $('#graph');
  tagCtx(galaxyEl, 'galaxy', null, null);
  galaxyEl._ctxAt = (x, y) => galaxyTarget(graph.nodeAt(x, y), { machineById });
  ctxMenu = installContextMenu({ providers });
}

// ------------------------------------------------------------------ space-station view (experimental, starnet/)
// The station frame asks; these answer with the same menus and handlers as the galaxy (no route of its own).
const OFF_FLOOR = ['agent', 'live', 'session', 'chat', 'model', 'app', 'tool', 'rig', 'project', 'plan', 'task', 'skill'];

/** What a room or desk holds that the station floor does not draw, grouped by type for its menu. */
function offFloor(n) {
  if (!n) return [];
  const all = graph.nodes();
  const picked = n.type === 'machine' || n.type === 'offline' ? all.filter((x) => x.machine === n.machine && x.id !== n.id)
    : n.type === 'mesh' ? all.filter((x) => x.type === 'plan' || x.type === 'task' || x.type === 'skill')
      : n.session ? graph.neighbors(n.id, 1).filter((x) => x.type === 'project')
        : [];
  return OFF_FLOOR.map((type) => ({
    label: TYPES[type]?.label || type,
    items: picked.filter((x) => x.type === type).sort((a, b) => String(a.name).localeCompare(String(b.name))).slice(0, 40).map((x) => ({ id: x.id, name: x.name })),
  })).filter((g) => g.items.length);
}

/** A click or right-click in the station: the node's menu (as on the galaxy) plus the station's own group. */
function stationMenu(id, at) {
  const n = id ? graph.get(id) : null;
  const targets = [];
  if (n) targets.push(galaxyTarget(n, { machineById }));
  targets.push({ kind: 'station', id: id || null, data: { node: n, more: offFloor(n) } });
  ctxMenu?.openFor(at.x, at.y, targets.filter(Boolean));
}

/** The room tags' buttons (the station view whitelists them): ✳ New agent, +N more sessions. */
function stationAction(action, id) {
  const m = machineById(graph.get(id)?.machine);
  if (!m) { toast('That machine is offline.', 'info'); return; }
  if (action === 'newAgent') newAgent(m);
  else if (action === 'sessions') sessionsWindow(m.name);
}

function greeting() {
  const hr = new Date().getHours();
  return hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
}
