import { api, h, node, toast } from './api.js';

/**
 * Brain settings popover: which machine thinks, which provider, the exact model and the reasoning
 * effort. "Core brain" also becomes the default planner for projects on this gateway.
 */
export function openBrainPanel({ host, entries, current, gatewayName, onSave }) {
  host.replaceChildren();
  const machines = entries.filter((e) => e.node.online && e.node.rigs && (e.brains || []).length);
  if (!machines.length) { host.append(h('div', { class: 'muted pad' }, 'No brains found. Install Claude Code, Codex or Ollama.')); host.classList.add('open'); return; }
  const sel = { ...current };
  const machineSel = h('select', { class: 'mini' }, ...machines.map((e) => h('option', { value: e.node.id }, `${e.node.name}${e.node.self ? ' (this machine)' : ''}`)));
  const providerSel = h('select', { class: 'mini' });
  const modelIn = h('input', { class: 'path-input', list: 'brain-models', placeholder: 'model (empty = provider default)', spellcheck: 'false' });
  const modelList = h('datalist', { id: 'brain-models' });
  const effortSel = h('select', { class: 'mini' });
  const core = h('input', { type: 'checkbox', checked: true });

  function entry() { return machines.find((e) => e.node.id === machineSel.value) || machines[0]; }
  function provider() { return (entry().brains || []).find((b) => b.id === providerSel.value) || entry().brains[0]; }
  function fillProviders() {
    providerSel.replaceChildren(...entry().brains.map((b) => h('option', { value: b.id }, b.label)));
    if (entry().brains.some((b) => b.id === sel.brain)) providerSel.value = sel.brain;
    fillModels();
  }
  function fillModels() {
    const b = provider();
    modelList.replaceChildren(...b.models.map((m) => h('option', { value: m })));
    if (b.id !== sel.brain) { modelIn.value = b.default || (b.id === 'ollama' ? b.models[0] || '' : ''); }
    effortSel.replaceChildren(h('option', { value: '' }, 'default'), ...(b.efforts || []).map((x) => h('option', { value: x }, x)));
    effortSel.value = b.id === sel.brain ? sel.effort || '' : b.defaultEffort || '';
  }
  machineSel.value = machines.some((e) => e.node.id === sel.nodeId) ? sel.nodeId : machines[0].node.id;
  modelIn.value = sel.model || '';
  fillProviders();
  machineSel.onchange = () => { sel.brain = ''; fillProviders(); };
  providerSel.onchange = () => { sel.brain = ''; fillModels(); };

  // Pre-routing (config.router.preroute on the machine that takes the requests): on = RIGS classifies a request and files
  // work itself before the brain sees it; off = the brain gets it as it is and files work itself. Saved as soon as it flips.
  const preBox = h('input', { type: 'checkbox', 'aria-label': 'Pre-routing', disabled: true });
  const preNote = h('div', { class: 'muted small bm-pre-note' }, 'Loading…');
  let preFor = '';
  const preText = (r) => (r.preroute === false
    ? 'Off — the brain gets every request as it is and files work itself.'
    : `On — each request is classified first (${{ jev: r.jevUrl ? 'LocalJev' : 'Jev, not reachable: falls back', claude: 'Haiku', rules: 'keyword rules' }[r.engine] || r.engine}) and work is filed for you.`);
  async function loadPre() {
    const id = (preFor = machineSel.value);
    preBox.disabled = true;
    preNote.textContent = 'Loading…';
    try {
      const r = await api(`${node(id)}/router`);
      if (preFor !== id) return;
      preBox.checked = r.preroute !== false;
      preNote.textContent = preText(r);
      preBox.disabled = false;
    } catch (err) { if (preFor === id) preNote.textContent = `Could not read pre-routing: ${err.message}`; }
  }
  preBox.onchange = async () => {
    const id = machineSel.value;
    const want = preBox.checked;
    preBox.disabled = true;
    try {
      const r = await api(`${node(id)}/router`, { method: 'POST', body: { preroute: want } });
      preBox.checked = r.preroute !== false;
      preNote.textContent = preText(r);
      toast(`Pre-routing ${preBox.checked ? 'on' : 'off'} · ${entry().node.name}`);
      window.dispatchEvent(new CustomEvent('rigs:router', { detail: r }));
    } catch (err) {
      preBox.checked = !want;
      toast('Could not change pre-routing: ' + err.message, 'error');
    }
    preBox.disabled = false;
  };
  const machineChanged = machineSel.onchange;
  machineSel.onchange = () => { machineChanged(); loadPre(); };
  loadPre();

  host.append(
    h('div', { class: 'bm-title' }, 'Brain'),
    h('label', { class: 'bm-row' }, h('span', {}, 'Machine'), machineSel),
    h('label', { class: 'bm-row' }, h('span', {}, 'Provider'), providerSel),
    h('label', { class: 'bm-row' }, h('span', {}, 'Model'), modelIn, modelList),
    h('label', { class: 'bm-row' }, h('span', {}, 'Effort'), effortSel),
    h('label', { class: 'bm-pre' }, h('div', {}, h('b', {}, 'Pre-routing'), preNote), h('span', { class: 'ctl-switch' }, preBox, h('span', { class: 'ctl-knob' }))),
    h('label', { class: 'check bm-core' }, core, ` Core brain — default for JARVIS and project planning on ${gatewayName}`),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: async () => {
      const e = entry();
      const b = provider();
      const out = { nodeId: e.node.id, nodeName: e.node.name, brain: b.id, model: modelIn.value.trim(), effort: effortSel.value };
      if (core.checked) {
        try { await api('/api/local/brain/core', { method: 'POST', body: { provider: out.brain, model: out.model, effort: out.effort, node: e.node.self ? '' : e.node.name } }); }
        catch (err) { toast('Could not save core brain: ' + err.message, 'error'); }
      }
      onSave(out);
      host.classList.remove('open');
    } }, 'Use this brain'), h('button', { class: 'btn', onclick: () => host.classList.remove('open') }, 'Cancel')));
  host.classList.add('open');
}
