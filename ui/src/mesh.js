import { api, fmtBytes, h, node, toast } from './api.js';
import { openWindow } from './wm.js';

const AGENTS = [['claude', 'Claude Code'], ['codex', 'Codex'], ['ollama', 'Ollama'], ['rig', 'OpenRig'], ['rea', 'REA'], ['sunshine', 'Sunshine'], ['moonlight', 'Moonlight'], ['tmux', 'tmux']];

/** Machines, versions, rollout of updates from GitHub, and JARVIS settings. */
export function openMesh({ snapshot, voice, onTerminal, onDesktop }) {
  let timer = null;
  const w = openWindow({ title: 'Mesh control', icon: '⚙', width: 1080, height: 640, className: 'mesh-win', onClose: () => clearInterval(timer) });
  const table = h('div', { class: 'mesh-table' });
  const updates = h('div', { class: 'pad' });
  const settings = h('div', { class: 'pad settings' });
  const tabs = [['Machines', table], ['Updates', updates], ['JARVIS', settings]];
  const tabBar = h('div', { class: 'tabs' }, ...tabs.map(([name, el], i) => h('button', { class: 'tab' + (i ? '' : ' on'), onclick: (e) => { tabBar.querySelectorAll('.tab').forEach((t) => t.classList.remove('on')); e.target.classList.add('on'); tabs.forEach(([, x]) => (x.style.display = 'none')); el.style.display = ''; } }, name)));
  w.body.append(tabBar, ...tabs.map(([, el], i) => { el.style.display = i ? 'none' : ''; return el; }));

  function renderMachines() {
    const data = snapshot();
    table.replaceChildren(...data.map(({ node: n, sessions = [] }) => {
      const up = n.online && n.rigs;
      const mem = n.stats ? Math.round((n.stats.memUsed / n.stats.memTotal) * 100) : 0;
      return h('div', { class: 'mesh-row' + (up ? '' : ' down') },
        h('div', { class: 'mr-name' }, h('b', {}, n.name), n.self ? h('span', { class: 'chip' }, 'this machine') : null,
          h('div', { class: 'muted' }, `${n.distro || n.platform || ''} · ${n.tailscale?.dnsName || n.tailscale?.ip || n.url || ''}`),
          h('div', { class: 'muted' }, up ? `rigs ${n.version || '?'} · ${sessions.length} sessions · ${(n.gpus || []).join(', ')}` : n.rigs ? 'offline' : `no RIGS agent${n.error ? ' (' + n.error + ')' : ''}`)),
        up ? h('div', { class: 'mr-bars' }, bar('CPU', n.stats?.cpu || 0), bar('MEM', mem, `${fmtBytes(n.stats?.memUsed)} / ${fmtBytes(n.stats?.memTotal)}`)) : h('div'),
        h('div', { class: 'mr-agents' }, ...AGENTS.map(([k, label]) => h('span', { class: 'badge' + (n.tools?.[k] ? ' on' : ''), title: n.tools?.[k] || 'not installed' }, label)),
          n.tools?.reaRegistered ? h('span', { class: 'muted small' }, `REA→ claude:${n.tools.reaRegistered.claude ? '✓' : '✗'} codex:${n.tools.reaRegistered.codex ? '✓' : '✗'}`) : null),
        h('div', { class: 'mr-actions' },
          up ? h('button', { class: 'btn', onclick: () => onTerminal(n) }, '⌨') : null,
          h('button', { class: 'btn', onclick: () => onDesktop(n) }, '🖥'),
          h('button', { class: 'btn', title: 'copy ssh command', onclick: () => { navigator.clipboard.writeText(`ssh ${n.sshAlias || n.name}`); toast(`Copied: ssh ${n.sshAlias || n.name}`); } }, 'ssh'),
          up ? h('button', { class: 'btn', onclick: () => updateOne(n) }, '⟳ update') : null));
    }));
  }

  function bar(label, pct, title = '') {
    return h('div', { class: 'bar', title }, h('span', {}, label), h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: pct + '%', background: pct > 85 ? '#f87171' : pct > 60 ? '#fbbf24' : '#2dd4bf' } })), h('em', {}, pct + '%'));
  }

  async function updateOne(n) {
    toast(`Updating ${n.name} from GitHub…`);
    try { const r = await api(`${node(n.id)}/update`, { method: 'POST', body: {} }); toast(`${n.name}: ${r.updated ? `updated ${r.from} → ${r.to}, restarting` : r.message}`, r.updated ? 'ok' : 'info', 8000); }
    catch (e) { toast(`${n.name}: ${e.message}`, 'error'); }
  }

  async function renderUpdates() {
    updates.replaceChildren(h('div', { class: 'muted' }, 'Checking GitHub…'));
    try {
      const st = await api('/api/local/update?check=1');
      const v = st.version;
      const rows = snapshot().filter((e) => e.node.rigs && e.node.online).map((e) => h('div', { class: 'upd-row' }, h('b', {}, e.node.name), h('span', { class: 'mono' }, e.node.version || '?'), e.node.versionInfo?.dirty ? h('span', { class: 'chip warn' }, 'local edits') : null));
      updates.replaceChildren(
        h('div', { class: 'pv-title' }, 'Self-updating mesh'),
        h('p', { class: 'muted' }, 'Every machine is a git checkout of the public repo. Any agent on any machine can change the code, push to main, then roll it out here (or via the mesh_update MCP tool). Machines with uncommitted local edits are skipped.'),
        h('div', { class: 'upd-row' }, h('span', {}, 'This node:'), h('span', { class: 'mono' }, `${v.short} ${v.branch} — ${v.subject || ''}`), h('span', { class: 'muted' }, st.last?.error ? '⚠ ' + st.last.error : `${st.last?.behind || 0} behind · ${st.last?.ahead || 0} ahead of ${st.last?.remote || 'origin'}`)),
        ...rows,
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', onclick: async () => {
            if (!confirm('Pull the latest code from GitHub on every machine and restart them?')) return;
            toast('Rolling out to the whole mesh…');
            try { const r = await api('/api/mesh/update', { method: 'POST', body: {} }); toast(r.map((x) => `${x.node}: ${x.updated ? '→ ' + x.to : x.message}`).join(' · '), 'ok', 12000); }
            catch (e) { toast(e.message, 'error'); }
          } }, '⟳ Update every machine'),
          h('button', { class: 'btn', onclick: renderUpdates }, '↻ Check again')));
    } catch (e) { updates.replaceChildren(h('div', { class: 'muted' }, e.message)); }
  }

  async function renderSettings() {
    const cfg = await api('/api/local/config').catch(() => null);
    if (!cfg) return;
    const name = h('input', { class: 'path-input', value: cfg.persona.name });
    const address = h('input', { class: 'path-input', value: cfg.persona.address });
    const humor = h('input', { type: 'range', min: 0, max: 100, value: cfg.persona.humor });
    const auto = h('input', { type: 'checkbox', checked: cfg.update.auto });
    const voices = voice.voices();
    const voiceSel = h('select', { class: 'mini' }, ...voices.map((v) => h('option', { value: v.name, selected: v.name === voice.voiceName }, `${v.name} (${v.lang})`)));
    const perm = h('select', { class: 'mini' }, ...['default', 'acceptEdits', 'bypassPermissions', 'plan'].map((m) => h('option', { value: m, selected: cfg.brain.claudePermissionMode === m }, m)));
    settings.replaceChildren(
      h('label', {}, 'Assistant name', name), h('label', {}, 'Calls you', address),
      h('label', {}, `Humor (${cfg.persona.humor}%)`, humor), h('label', {}, 'Voice (this browser)', voiceSel),
      h('label', {}, 'Claude chat permission mode (this machine)', perm),
      h('label', { class: 'check' }, auto, ' Auto-update this machine from GitHub every ', String(cfg.update.intervalMin), ' min'),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: async () => {
        voice.setVoice(voiceSel.value);
        await api('/api/local/config', { method: 'POST', body: { persona: { name: name.value, address: address.value, humor: Number(humor.value) }, update: { auto: auto.checked }, brain: { claudePermissionMode: perm.value } } });
        toast('Saved', 'ok');
        voice.say(`Settings saved, ${address.value}.`);
      } }, 'Save'), h('button', { class: 'btn', onclick: () => voice.say(`Good evening, ${address.value}. All systems nominal.`) }, '▶ Test voice')));
  }

  renderMachines();
  renderUpdates();
  renderSettings();
  timer = setInterval(renderMachines, 5000);
  return { window: w, refresh: renderMachines };
}
