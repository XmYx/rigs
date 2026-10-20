import { api, h, node, toast } from './api.js';
import { registerTrayItem, closeTrayPopover } from './tray.js';
import { brainSummary, effortChoices, modelChoices, pickBrain, providerChoices } from './tray-brain-model.js';

// The main JARVIS item of the tray (left-most): its brain settings as a popover — provider, model, effort, pre-routing and the
// quick path. A pick goes through main.js's setBrain (the same hot-swap as the Brain panel) and the existing /router and /quick APIs.

/**
 * deps: { current(): selection, entries(): mesh snapshot, setBrain(sel), openAsk(), openBrainPanel() }.
 * Returns { refresh() } — call it when the brain or the snapshot changes so the icon's tooltip and badge follow.
 */
export function registerJarvisTray(deps) {
  let router = null;
  let quick = null;
  let btn = null;
  let rerender = null;

  const entry = () => { const c = deps.current(); return c && deps.entries().find((e) => e.node.id === c.nodeId); };
  const paint = (el = btn) => {
    if (!el) return;
    const s = brainSummary(deps.current());
    el.title = s.title;
    el.setAttribute('aria-label', s.title);
    el.querySelector('.tray-jv-badge').textContent = s.badge;
  };

  async function load() {
    const c = deps.current();
    const base = c ? node(c.nodeId) : '/api/local';
    const [r, q] = await Promise.allSettled([api(`${base}/router`), api('/api/local/quick')]);
    router = r.status === 'fulfilled' ? r.value : null;
    quick = q.status === 'fulfilled' ? q.value : null;
    rerender?.();
  }
  async function patch(path, body, label) {
    try { return await api(path, { method: 'POST', body }); } catch (err) { toast(`Could not change ${label}: ${err.message}`, 'error'); return null; }
  }

  const item = (label, { checked, disabled, reason, role = 'menuitemradio', onclick }) => h('button', {
    class: 'mb-item tray-jv-item', role, 'aria-checked': String(!!checked), disabled: disabled || undefined, title: reason || undefined,
    onclick: () => { if (!disabled) onclick(); },
  }, h('span', { class: 'tray-jv-ck', 'aria-hidden': 'true' }, checked ? '✓' : ''), h('span', { class: 'tray-jv-lb' }, label), reason ? h('small', { class: 'muted' }, reason) : null);
  const group = (title, ...rows) => h('div', { class: 'tray-jv-grp', role: 'group', 'aria-label': title }, h('div', { class: 'tray-pop-title' }, title), ...rows);

  function popover({ rerender: rr }) {
    rerender = rr;
    const cur = deps.current();
    const e = entry();
    if (!cur || !e) return [h('div', { class: 'tray-pop-title' }, 'JARVIS'), h('div', { class: 'muted small' }, 'No brain available. Install Claude Code or Ollama.')];
    const brains = e.brains || [];
    const provider = brains.find((b) => b.id === cur.brain);
    const select = (b, p) => { deps.setBrain(pickBrain(e, b, p, cur)); rr(); };
    const out = [
      group('Provider', ...providerChoices(brains, cur).map((p) => item(p.label, { ...p, onclick: () => select(brains.find((b) => b.id === p.id), {}) }))),
    ];
    const models = modelChoices(provider, cur);
    if (models.length) out.push(group('Model', h('div', { class: 'tray-jv-scroll' }, ...models.map((m) => item(m.label, { ...m, onclick: () => select(provider, { model: m.id }) })))));
    const efforts = effortChoices(provider, cur);
    if (efforts.length) out.push(group('Effort', ...efforts.map((x) => item(x.label, { ...x, onclick: () => select(provider, { effort: x.id }) }))));
    const rows = [];
    if (router) {
      const on = router.preroute !== false;
      rows.push(item(`Pre-routing ${on ? 'on' : 'off'}`, { role: 'menuitemcheckbox', checked: on, onclick: async () => {
        const r = await patch(`${node(cur.nodeId)}/router`, { preroute: !on }, 'pre-routing');
        if (r) { router = r; window.dispatchEvent(new CustomEvent('rigs:router', { detail: r })); rr(); }
      } }));
      if (on) for (const [id, label] of [['jev', 'LocalJev'], ['claude', 'Haiku'], ['rules', 'Keyword rules']]) {
        rows.push(item(`Engine: ${label}`, { checked: router.engine === id, onclick: async () => { const r = await patch(`${node(cur.nodeId)}/router`, { engine: id }, 'the engine'); if (r) { router = r; rr(); } } }));
      }
    }
    if (quick) {
      rows.push(item(`Quick fast path ${quick.enabled ? 'on' : 'off'}`, { role: 'menuitemcheckbox', checked: quick.enabled, onclick: async () => { const q = await patch('/api/local/quick', { enabled: !quick.enabled }, 'the quick path'); if (q) { quick = q; rr(); } } }));
    }
    if (rows.length) out.push(group('Routing', ...rows));
    out.push(h('div', { class: 'tray-jv-links' },
      h('button', { class: 'tray-link', onclick: () => { closeTrayPopover({ restore: false }); deps.openAsk(); } }, 'Ask JARVIS'),
      h('button', { class: 'tray-link', onclick: () => { closeTrayPopover({ restore: false }); deps.openBrainPanel(); } }, 'Brain settings…')));
    return out;
  }

  registerTrayItem({
    id: 'jarvis', order: 0, phone: true, label: 'JARVIS brain', popover,
    render() {
      btn = h('button', { class: 'tray-item tray-jarvis', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: () => load() },
        h('img', { src: '/icon.svg', alt: '', width: 16, height: 16 }), h('span', { class: 'tray-jv-badge' }));
      paint();
      return btn;
    },
    update: paint,
  });
  return { refresh: () => paint() };
}
