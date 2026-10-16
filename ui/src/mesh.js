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
  const toolsEl = h('div', { class: 'pad settings' });
  const routingEl = h('div', { class: 'pad settings' });
  const tabs = [['Machines', table], ['Tools', toolsEl], ['Routing', routingEl], ['Updates', updates], ['JARVIS', settings]];
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
    const voiceSel = h('select', { class: 'mini' }, ...voices.map((v) => h('option', { value: v.id, selected: v.id === voice.voiceId }, v.label)));
    const perm = h('select', { class: 'mini' }, ...['default', 'acceptEdits', 'bypassPermissions', 'plan'].map((m) => h('option', { value: m, selected: cfg.brain.claudePermissionMode === m }, m)));
    settings.replaceChildren(
      h('label', {}, 'Assistant name', name), h('label', {}, 'Calls you', address),
      h('label', {}, `Humor (${cfg.persona.humor}%)`, humor), h('label', {}, 'Voice', voiceSel),
      h('label', {}, 'Claude chat permission mode (this machine)', perm),
      h('label', { class: 'check' }, auto, ' Auto-update this machine from GitHub every ', String(cfg.update.intervalMin), ' min'),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: async () => {
        voice.setVoice(voiceSel.value);
        await api('/api/local/config', { method: 'POST', body: { persona: { name: name.value, address: address.value, humor: Number(humor.value) }, update: { auto: auto.checked }, brain: { claudePermissionMode: perm.value } } });
        toast('Saved', 'ok');
        voice.say(`Settings saved, ${address.value}.`);
      } }, 'Save'), h('button', { class: 'btn', onclick: () => voice.say(`Good evening, ${address.value}. All systems nominal.`) }, '▶ Test voice')));
  }

  async function renderTools() {
    const ms = snapshot().filter((e) => e.node.online && e.node.rigs);
    const known = await api('/api/local/capabilities').then((r) => r.known).catch(() => []);
    const rows = ms.map((e) => h('div', { class: 'upd-row tool-row' }, h('b', {}, e.node.name),
      ...Object.values(e.node.capabilities || {}).map((c) => h('span', { class: 'chip', title: [c.url, c.command, c.notes].filter(Boolean).join(' · ') }, `${c.label}${c.detected ? ' ✓' : ''}`, c.declared ? h('button', { class: 'chip-x', title: 'remove', onclick: async () => { await api(`${node(e.node.id)}/capabilities`, { method: 'POST', body: { id: c.id, remove: true } }).catch((err) => toast(err.message, 'error')); toast(`Removed ${c.label} from ${e.node.name}`); } }, '×') : null)),
      Object.keys(e.node.capabilities || {}).length ? null : h('span', { class: 'muted small' }, 'no tools yet')));
    const machine = h('select', { class: 'mini' }, ...ms.map((e) => h('option', { value: e.node.id }, e.node.name)));
    const id = h('input', { class: 'path-input', placeholder: 'id, e.g. comfyui', list: 'known-tools' });
    const dl = h('datalist', { id: 'known-tools' }, ...known.map((k) => h('option', { value: k.id }, k.label)));
    const label = h('input', { class: 'path-input', placeholder: 'Label, e.g. ComfyUI' });
    const kinds = h('input', { class: 'path-input', placeholder: 'Task kinds it serves (comma), e.g. media' });
    const url = h('input', { class: 'path-input', placeholder: 'URL (optional), e.g. http://127.0.0.1:8188' });
    const command = h('input', { class: 'path-input', placeholder: 'CLI command (optional), e.g. comfy' });
    const notes = h('textarea', { class: 'path-input', rows: 2, placeholder: 'How agents should use it (shown in their task brief)' });
    id.onchange = () => { const k = known.find((x) => x.id === id.value); if (k) { label.value ||= k.label; kinds.value ||= k.kinds.join(', '); notes.value ||= k.notes; } };
    toolsEl.replaceChildren(
      h('div', { class: 'pv-title' }, 'Tools on each machine'),
      h('p', { class: 'muted small' }, 'Tasks that need a tool (e.g. media → ComfyUI) are routed only to machines that have it. Tools are auto-detected where possible (ComfyUI on :8188 or the comfy CLI); declare anything else here, one tool at a time.'),
      ...rows,
      h('div', { class: 'pv-title', style: { marginTop: '14px' } }, 'Add a tool'),
      h('div', { class: 'grid2' }, h('label', {}, 'Machine', machine), h('label', {}, 'Tool id', id, dl)),
      h('div', { class: 'grid2' }, h('label', {}, 'Label', label), h('label', {}, 'Serves task kinds', kinds)),
      h('div', { class: 'grid2' }, h('label', {}, 'URL', url), h('label', {}, 'Command', command)),
      h('label', {}, 'Notes for agents', notes),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: async () => {
        try { await api(`${node(machine.value)}/capabilities`, { method: 'POST', body: { id: id.value.trim(), label: label.value, kinds: kinds.value, url: url.value, command: command.value, notes: notes.value } }); toast('Tool added — it appears after the next mesh refresh', 'ok'); }
        catch (e) { toast(e.message, 'error'); }
      } }, 'Add tool')));
  }

  async function renderRouting() {
    const r = await api('/api/local/routing').catch(() => null);
    if (!r) return;
    const catalog = await api('/api/local/models').catch(() => []);
    const KINDS = ['*', 'plan', 'architecture', 'code', 'test', 'review', 'research', 'docs', 'text', 'reverse-engineer', 'media', 'private'];
    const PROVS = ['claude', 'codex', 'ollama'];
    let rules = r.rules.map((x) => ({ ...x }));
    const picks = h('select', { class: 'mini' }, ...[['machine', 'planner may suggest machines'], ['all', 'planner may also pick provider + model'], ['none', 'ignore planner suggestions']].map(([v, l]) => h('option', { value: v, selected: r.plannerPicks === v }, l)));
    const dispatch = h('select', { class: 'mini' }, ...[['auto', 'auto (OpenRig when available)'], ['openrig', 'OpenRig'], ['direct', 'direct agent sessions']].map(([v, l]) => h('option', { value: v, selected: r.dispatch === v }, l)));
    const table = h('div', { class: 'rule-table' });
    const sel = (opts, val, on) => { const e = h('select', { class: 'mini' }, ...opts.map((o) => h('option', { value: o, selected: o === (val ?? '') }, o || '—'))); e.onchange = () => on(e.value); return e; };
    function draw() {
      table.replaceChildren(h('div', { class: 'rule-row head' }, ...['kind', 'size', 'needs tool', 'provider', 'model', 'effort', 'cross-check', ''].map((x) => h('span', {}, x))),
        ...rules.map((x, i) => {
          const prov = catalog.find((c) => c.id === x.provider);
          const listId = `rm-${i}`;
          const model = h('input', { class: 'path-input', value: x.model || '', list: listId, placeholder: 'default' });
          model.onchange = () => { x.model = model.value.trim(); };
          const tool = h('input', { class: 'path-input', value: x.tool || '', placeholder: '—' });
          tool.onchange = () => { x.tool = tool.value.trim() || undefined; };
          const cc = h('input', { type: 'checkbox', checked: !!x.crossCheck });
          cc.onchange = () => { x.crossCheck = cc.checked || undefined; };
          return h('div', { class: 'rule-row' },
            sel(KINDS, x.kind, (v) => { x.kind = v; }), sel(['', 'S', 'M', 'L'], x.size || '', (v) => { x.size = v || undefined; }), tool,
            sel(PROVS, x.provider, (v) => { x.provider = v; x.model = ''; x.effort = ''; draw(); }),
            h('span', {}, model, h('datalist', { id: listId }, ...(prov?.models || []).map((m) => h('option', { value: m })))),
            sel(['', ...(prov?.efforts || ['low', 'medium', 'high'])], x.effort || '', (v) => { x.effort = v; }), h('span', {}, cc),
            h('span', { class: 'rule-btns' },
              h('button', { class: 'tb', title: 'up', onclick: () => { if (i) { [rules[i - 1], rules[i]] = [rules[i], rules[i - 1]]; draw(); } } }, '↑'),
              h('button', { class: 'tb', title: 'down', onclick: () => { if (i < rules.length - 1) { [rules[i + 1], rules[i]] = [rules[i], rules[i + 1]]; draw(); } } }, '↓'),
              h('button', { class: 'tb', title: 'remove', onclick: () => { rules.splice(i, 1); draw(); } }, '✕')));
        }));
    }
    draw();
    routingEl.replaceChildren(
      h('div', { class: 'pv-title' }, `Routing policy — this machine ${r.customized ? '(customized)' : '(defaults)'}`),
      h('p', { class: 'muted small' }, 'First matching rule wins (kind, then optional size S/M/L). It fixes the provider, exact model and effort; a "needs tool" rule only lands on machines with that tool; cross-check sends a review to the other agent when one agent wrote all the code. The machine is then chosen by availability, load, GPU/platform needs and spread.'),
      h('div', { class: 'grid2' }, h('label', {}, 'Planner suggestions', picks), h('label', {}, 'Default dispatch', dispatch)),
      table,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => { rules.splice(Math.max(0, rules.length - 1), 0, { kind: 'code', provider: 'claude', model: '', effort: '' }); draw(); } }, '＋ Rule'),
        h('button', { class: 'btn primary', onclick: async () => {
          const clean = rules.map((x) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined && v !== '')));
          await api('/api/local/routing', { method: 'POST', body: { rules: clean, plannerPicks: picks.value, dispatch: dispatch.value } });
          toast('Routing saved — use ⇄ Re-route on a project to apply it', 'ok');
          renderRouting();
        } }, 'Save'),
        h('button', { class: 'btn', onclick: async () => { await api('/api/local/routing', { method: 'POST', body: { reset: true } }); toast('Back to the default rules'); renderRouting(); } }, 'Reset to defaults')));
  }

  renderMachines();
  renderTools();
  renderRouting();
  renderUpdates();
  renderSettings();
  timer = setInterval(renderMachines, 5000);
  return { window: w, refresh: renderMachines };
}
