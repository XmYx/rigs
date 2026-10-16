import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { ago, api, fmtBytes, h, node, stream, toast, wsUrl } from './api.js';
import { openBrainPanel } from './brain.js';
import { openFiles } from './files.js';
import { TYPES, buildGraph, createGraph } from './graph.js';
import { openMesh } from './mesh.js';
import { openProjects } from './projects.js';
import { createOrb } from './orb.js';
import { openSessions } from './sessions.js';
import { openTerminal } from './terminal.js';
import { createVoice } from './voice.js';
import { openWindow } from './wm.js';

const $ = (s) => document.querySelector(s);
const store = {
  get: (k, d) => { try { const v = localStorage.getItem('rigs.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('rigs.' + k, JSON.stringify(v)); } catch {} },
};

let snap = [];
let selfId = null;
let persona = { name: 'J.A.R.V.I.S.', address: 'sir' };
let brainSel = store.get('brain', null); // { nodeId, nodeName, brain, model }
let chatRef = store.get('chat', null); // { nodeId, chatId }
let busy = null;

// ------------------------------------------------------------------ boot
const graph = createGraph($('#graph'), { onSelect: (n) => select(n.id), onBackground: () => {} });
const orb = createOrb($('#orb'), 'J.A.R.V.I.S.');
const voice = createVoice({
  onTranscript: (t) => { $('#ask').value = ''; ask(t, { spoken: true }); },
  onInterim: (t) => { if (t) showSubtitle(t, 'user interim'); },
  onState: (s) => setOrb(s),
  onLevel: (v) => orb.setLevel(v),
});

function setOrb(s) {
  orb.setState(s);
  const label = { online: 'ONLINE', listening: 'LISTENING', thinking: 'THINKING', speaking: 'SPEAKING', error: 'ERROR', offline: 'OFFLINE' }[s] || s.toUpperCase();
  $('#orb-state').innerHTML = `<i class="dot s-${s}"></i>${label}`;
}

const machines = () => snap.filter((e) => e.node.online && e.node.rigs).map((e) => e.node);
const machineById = (id) => snap.find((e) => e.node.id === id)?.node;

async function refresh() {
  try {
    snap = await api('/api/mesh/snapshot');
    const self = snap.find((e) => e.node.self);
    if (self) selfId = self.node.id;
    graph.setData(buildGraph(snap));
    renderCounts();
    renderHubs();
    renderFilters();
    renderBrainBadge();
    if (graph.focused) renderInspector(graph.focused);
    else renderInspector(null);
  } catch (e) {
    setOrb('offline');
    toast('Gateway unreachable: ' + e.message, 'error');
  }
}

function connectEvents() {
  const ws = new WebSocket(wsUrl('/ws'));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'mesh') refresh();
    if (m.type === 'notify') {
      const act = m.action?.type === 'run' ? { label: m.action.label || 'Run', run: () => runOn(m.action.node, m.action.command, m.action.title) } : null;
      toast(`${m.from}: ${m.text}`, m.level === 'error' ? 'error' : 'ok', act ? 60000 : 9000, act);
      showSubtitle(m.text, 'jarvis');
      if (m.speak) voice.say(m.text);
    }
  };
  ws.onopen = () => { if (orb.state === 'offline') setOrb('online'); };
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

function renderHubs() {
  const rows = snap.map((e) => ({ n: e.node, c: e.sessions?.length || 0 })).sort((a, b) => (b.n.online - a.n.online) || b.c - a.c);
  $('#hubs').replaceChildren(...rows.map(({ n, c }) => {
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
      renderFilters();
    };
    return el;
  }));
  graph.setHidden([...hiddenTypes]);
}

// ------------------------------------------------------------------ inspector
function select(id) {
  const n = graph.get(id);
  if (!n) return;
  graph.focus(id, graph.depth || 1);
  renderInspector(id);
  $('#back').style.visibility = 'visible';
}

function clearSelection() {
  graph.clearFocus();
  graph.fit();
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
    }
    out.push(h('div', { class: 'ins-actions' },
      up ? act('⌨ Terminal', () => openTerminal({ nodeId: d.id, nodeName: d.name })) : null,
      up ? act('📁 Files', () => filesOn(d)) : null,
      act('🖥 Desktop', () => desktopTo(d)),
      up ? act('💬 Sessions', () => sessionsWindow(d.name)) : null,
      up ? act('◆ Use as brain', () => pickBrainOn(d)) : null,
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
      s.kind === 'chat' ? act('◆ Continue', () => continueChat(m, s)) : act(s.kind === 'pty' ? '⌨ Open' : s.live ? '⌨ Attach' : '⌨ Resume', () => attachSession(m, s))));
  } else if (n.type === 'project') {
    const sess = graph.neighbors(id, 1).filter((x) => x.session);
    const where = [...new Set(sess.map((x) => machineById(x.machine)?.name))].filter(Boolean);
    out.push(h('div', { class: 'ins-meta' }, `On ${where.join(', ')} · ${sess.length} sessions`));
    const first = sess[0];
    if (first) {
      const mm = machineById(first.machine);
      out.push(h('div', { class: 'ins-actions' }, act('⌨ Terminal in project', () => openTerminal({ nodeId: mm.id, nodeName: mm.name, cwd: first.session.cwd, title: n.name })), act('📁 Files', () => filesOn(mm, first.session.cwd)), act('✳ Claude here', () => startAgent(mm, 'claude', first.session.cwd))));
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

function filesOn(m, path = '~') {
  openFiles({ nodeId: m.id, nodeName: m.name, path, machines, onTerminalHere: (p) => openTerminal({ nodeId: m.id, nodeName: m.name, cwd: p }) });
}

let sessWin = null;
function sessionsWindow(filter = '', show = null) {
  sessWin = openSessions({ snapshot: () => snap, focus: (n, s) => select(`s:${n.id}:${s.kind}:${s.id}`), onContinueChat: continueChat });
  if (filter) { const i = sessWin.window.body.querySelector('input'); i.value = filter; i.dispatchEvent(new Event('input')); }
  if (show) sessWin.showSession(show.node, show.s);
}

async function attachSession(m, s) {
  try {
    const r = await api(`${node(m.id)}/sessions/attach`, { method: 'POST', body: { kind: s.kind, id: s.id, cwd: s.cwd } });
    openTerminal({ nodeId: m.id, nodeName: m.name, ptyId: r.ptyId, title: s.title?.slice(0, 50) });
  } catch (e) { toast(e.message, 'error'); }
}

async function startAgent(m, agent, cwd, prompt = '', model = '') {
  try {
    const r = await api(`${node(m.id)}/agents/start`, { method: 'POST', body: { agent, cwd, prompt, model } });
    const a = await api(`${node(m.id)}/sessions/attach`, { method: 'POST', body: { kind: r.kind, id: r.id } });
    openTerminal({ nodeId: m.id, nodeName: m.name, ptyId: a.ptyId, title: `${agent} · ${r.id}` });
    setTimeout(refresh, 1500);
    return r;
  } catch (e) { toast(e.message, 'error'); return null; }
}

function newAgent(m, preset) {
  const tools = m.tools || {};
  const agents = ['claude', 'codex', 'ollama', 'rig'].filter((a) => tools[a]);
  const w = openWindow({ title: `New agent on ${m.name}`, icon: '✳', width: 520, height: 330 });
  const agentSel = h('select', { class: 'mini' }, ...agents.map((a) => h('option', { value: a, selected: a === preset }, a)));
  const cwd = h('input', { class: 'path-input', value: '~', placeholder: 'working directory on ' + m.name });
  const prompt = h('textarea', { class: 'path-input', rows: 4, placeholder: 'Optional first task, e.g. “fix the failing tests”' });
  const model = h('input', { class: 'path-input', placeholder: 'model (optional)' });
  w.body.append(h('div', { class: 'pad settings' }, h('label', {}, 'Agent', agentSel), h('label', {}, 'Directory', cwd), h('label', {}, 'Task', prompt), h('label', {}, 'Model', model),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: async () => { const r = await startAgent(m, agentSel.value, cwd.value, prompt.value, model.value); if (r) { w.close(); voice.say(`${agentSel.value} is up on ${m.name}, ${persona.address}.`); } } }, 'Start (in tmux)'))));
}

async function desktopTo(m) {
  toast(`Connecting to ${m.name}'s desktop…`);
  try {
    const r = await api('/api/desktop/connect', { method: 'POST', body: { target: m.id } });
    toast(r.message, r.ok ? 'ok' : 'error', 9000);
    if (!r.ok) desktopHelp(m, r);
  } catch (e) { toast(e.message, 'error'); desktopHelp(m, { message: e.message }); }
}

function desktopHelp(m, r) {
  const w = openWindow({ title: `Remote desktop — ${m.name}`, icon: '🖥', width: 620, height: 380 });
  const addr = m.tailscale?.dnsName || m.tailscale?.ip || m.name;
  w.body.append(h('div', { class: 'pad' },
    h('p', {}, r.message || ''),
    h('p', { class: 'muted' }, 'Hardware-accelerated path: Sunshine on the target (NVENC / VAAPI / VideoToolbox, KMS capture on Wayland) and Moonlight here. Pairing is automatic once both are installed — rerun the installer with the desktop option.'),
    h('pre', { class: 'pv-text' }, `Target ${m.name} (${m.platform}):\n  ${m.platform === 'windows' ? 'winget install LizardByte.Sunshine' : m.platform === 'mac' ? 'brew install --cask moonlight && brew tap LizardByte/homebrew && brew install sunshine' : 'sudo apt install ./sunshine-ubuntu-24.04-amd64.deb   (from github.com/LizardByte/Sunshine/releases)'}\nThis machine:\n  Moonlight from moonlight-stream.org (or: winget install MoonlightGameStreamingProject.Moonlight / brew install --cask moonlight / flatpak install flathub com.moonlight_stream.Moonlight)\n\nManual: moonlight stream ${addr} Desktop\nMac↔Mac: open vnc://${addr}  (Screen Sharing → High Performance)`)));
}

function projectsWindow(openId) {
  const pw = openProjects({ snapshot: () => snap, voice, coreBrain: currentBrain, onFocus: (p) => select(`pj:${p.id}`) });
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

function currentBrain() {
  const has = (nodeId, brain) => snap.find((e) => e.node.id === nodeId && e.node.online)?.brains?.some((b) => b.id === brain);
  if (brainSel && has(brainSel.nodeId, brainSel.brain)) return brainSel;
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

function renderBrainBadge() {
  const b = currentBrain();
  $('#brain-badge').innerHTML = b ? `◆ ${shortModel(b).toUpperCase()}${b.effort ? ` <small>· ${b.effort}</small>` : ''} <small>· ${b.nodeName}</small> ▾` : '◆ NO BRAIN ▾';
}

function setBrain(b, { quiet = false } = {}) {
  const prevNode = currentBrain()?.nodeId;
  brainSel = { nodeId: b.nodeId, nodeName: b.nodeName, brain: b.brain, model: b.model || '', effort: b.effort || '' };
  store.set('brain', brainSel);
  if (prevNode !== b.nodeId) { chatRef = null; store.set('chat', null); }
  renderBrainBadge();
  $('#brain-menu').classList.remove('open');
  if (!quiet) toast(`Brain → ${b.brain}${b.model ? ' ' + b.model : ''}${b.effort ? ' · ' + b.effort : ''} on ${b.nodeName}`);
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
function showSubtitle(text, cls = 'jarvis') {
  const el = $('#subtitle');
  el.className = 'show ' + cls;
  el.textContent = text.length > 600 ? '…' + text.slice(-600) : text;
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
  if ((m = t.match(/^(?:focus|zoom(?: in)?(?: on)?|go to|show me)\s+(.+)$/i))) {
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
  if (/^(stop|quiet|silence|shut up|enough)$/i.test(t)) { voice.stop(); setOrb('online'); return true; }
  return false;
}

async function ask(text, { spoken = false } = {}) {
  text = text.trim();
  if (!text) return;
  voice.stop();
  showSubtitle(text, 'user');
  if (await intent(text)) return;
  const b = currentBrain();
  if (!b) { const s = 'I have no brain on any machine yet. Install Claude Code, Codex or Ollama.'; showSubtitle(s); voice.say(s); return; }
  busy?.abort();
  const ac = new AbortController();
  busy = ac;
  setOrb('thinking');
  let reply = '';
  const tools = [];
  try {
    if (!chatRef || chatRef.nodeId !== b.nodeId) {
      const c = await api(`${node(b.nodeId)}/chats`, { method: 'POST', body: { brain: b.brain, model: b.model, effort: b.effort } });
      chatRef = { nodeId: b.nodeId, chatId: c.id };
      store.set('chat', chatRef);
    }
    await stream(`${node(b.nodeId)}/chats/${chatRef.chatId}/send`, { text, brain: b.brain, model: b.model, effort: b.effort }, (e) => {
      if (e.type === 'delta') {
        if (!reply) setOrb('speaking');
        reply += e.text;
        showSubtitle(reply, 'jarvis');
        if (spoken || !voice.muted) voice.feed(e.text);
      } else if (e.type === 'tool') {
        tools.push(e.name);
        showSubtitle(`${reply}\n⚙ ${tools.slice(-3).join(' · ')}`, 'jarvis');
      } else if (e.type === 'status') {
        showSubtitle(`${reply}\n… ${e.text}`, 'jarvis');
      } else if (e.type === 'error') {
        toast(e.message, 'error', 10000);
        if (!reply) showSubtitle(e.message, 'error');
      }
    }, ac.signal);
    voice.feed('', true);
    if (!voice.speaking) setOrb(voice.mode === 'handsfree' ? 'listening' : 'online');
    else setTimeout(function wait() { if (voice.speaking) setTimeout(wait, 300); else setOrb(voice.mode === 'handsfree' ? 'listening' : 'online'); }, 300);
  } catch (e) {
    if (e.name !== 'AbortError') { toast(e.message, 'error'); showSubtitle(e.message, 'error'); setOrb('error'); setTimeout(() => setOrb('online'), 2500); }
  } finally { if (busy === ac) busy = null; }
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

async function conversationWindow() {
  if (!chatRef) { toast('No conversation yet — ask me something.'); return; }
  const w = openWindow({ title: 'Conversation', icon: '◆', width: 640, height: 520 });
  const list = h('div', { class: 'transcript' });
  w.body.append(h('div', { class: 'toolbar' }, h('button', { class: 'tb', onclick: () => { chatRef = null; store.set('chat', null); w.close(); toast('New conversation'); } }, '＋ New conversation')), list);
  try {
    const c = await api(`${node(chatRef.nodeId)}/chats/${chatRef.chatId}`);
    list.replaceChildren(...c.messages.map((x) => h('div', { class: `msg r-${x.role}` }, h('div', { class: 'mr' }, x.role === 'user' ? 'you' : `${x.brain}${x.model ? ' · ' + x.model : ''}`), h('div', { class: 'mt' }, x.text))));
    list.scrollTop = list.scrollHeight;
  } catch (e) { list.replaceChildren(h('div', { class: 'muted pad' }, e.message)); }
}

// ------------------------------------------------------------------ wiring
function wire() {
  $('#ask').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const v = e.target.value; e.target.value = ''; ask(v); } });
  $('#btn-mic').onclick = () => { if (!voice.pushToTalk()) toast(window.isSecureContext ? 'Speech recognition needs Chrome, Edge or Safari.' : 'Microphone needs https or localhost — run `rigs setup --https` or open http://localhost:4719 on this machine.', 'error', 8000); };
  $('#btn-hands').onclick = () => {
    const on = voice.toggleHandsFree();
    $('#btn-hands').classList.toggle('on', on);
    if (on) { toast('Hands-free: just say “Jarvis, …”'); voice.say(`Listening, ${persona.address}.`); }
  };
  $('#btn-term').onclick = () => { const n = graph.focused ? machineById(graph.get(graph.focused)?.machine) : null; const m = n || machineById(selfId); if (m) openTerminal({ nodeId: m.id, nodeName: m.name }); };
  $('#btn-files').onclick = () => { const n = graph.focused ? machineById(graph.get(graph.focused)?.machine) : null; filesOn(n || machineById(selfId)); };
  $('#btn-desk').onclick = () => { const n = graph.focused ? machineById(graph.get(graph.focused)?.machine) : null; if (n && !n.self) desktopTo(n); else toast('Focus another machine first (click it in the galaxy), then press 🖥.'); };
  $('#btn-sess').onclick = () => sessionsWindow();
  $('#btn-mesh').onclick = meshWindow;
  $('#btn-proj').onclick = () => projectsWindow();
  $('#btn-mute').onclick = () => { voice.setMuted(!voice.muted); $('#btn-mute').textContent = voice.muted ? '🔇' : '🔊'; };
  $('#btn-mute').textContent = voice.muted ? '🔇' : '🔊';
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
  for (const k of ['labels', 'particles', 'rotate']) {
    const el = $('#d-' + k);
    el.checked = store.get('d-' + k, true);
    graph.setDisplay({ [k]: el.checked });
    el.onchange = () => { store.set('d-' + k, el.checked); graph.setDisplay({ [k]: el.checked }); };
  }
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
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); $('#ask').focus(); }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#brain-menu,#brain-badge')) $('#brain-menu').classList.remove('open'); });
  if (!voice.supported) { $('#btn-hands').classList.add('dim'); $('#btn-mic').classList.add('dim'); }
}

wire();
setOrb('online');
api('/api/local/brain/core').then((c) => { coreDefault = c; renderBrainBadge(); }).catch(() => {});
api('/api/local/config').then((c) => { persona = c.persona; $('#ask').placeholder = `Ask ${c.persona.name.replace(/\./g, '')} — "status", "terminal on ubuntu", "files on mac", "start claude on windows"…`; }).catch(() => {});
await refresh();
graph.fit();
connectEvents();
setInterval(refresh, 15000);
setTimeout(() => { const s = `${greeting()}, ${persona.address}. ${meshStatusLine()}`; showSubtitle(s); }, 1200);

function greeting() {
  const hr = new Date().getHours();
  return hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
}
