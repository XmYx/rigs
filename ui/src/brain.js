import { api, h, toast } from './api.js';

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

  host.append(
    h('div', { class: 'bm-title' }, 'Brain'),
    h('label', { class: 'bm-row' }, h('span', {}, 'Machine'), machineSel),
    h('label', { class: 'bm-row' }, h('span', {}, 'Provider'), providerSel),
    h('label', { class: 'bm-row' }, h('span', {}, 'Model'), modelIn, modelList),
    h('label', { class: 'bm-row' }, h('span', {}, 'Effort'), effortSel),
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
