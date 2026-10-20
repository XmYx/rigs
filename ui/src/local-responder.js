import { api, h, node, toast } from './api.js';
import { responderView } from './local-responder-model.js';

// The control itself; wording and states are in local-responder-model.js.

/** The control, to append to the Brain popover. `entries` is the mesh snapshot (to find the host's node id). */
export function localResponderControl({ entries = [] } = {}) {
  const box = h('input', { type: 'checkbox', 'aria-label': 'Local responder', disabled: true });
  const modelDot = h('span', { class: 'lr-dot off', role: 'img', 'aria-label': 'model status' });
  const voiceDot = h('span', { class: 'lr-dot off', role: 'img', 'aria-label': 'voice status' });
  const modelLine = h('div', { class: 'muted small' }, 'Loading…');
  const voiceLine = h('div', { class: 'muted small' });
  const title = h('b', {}, 'Local responder');
  const where = h('div', { class: 'muted small lr-where' });
  let settings = {};

  async function refresh() {
    let status = null;
    let tts = null;
    let hostKnown = true;
    try { settings = (await api('/api/local/quick')).local || {}; } catch (err) { modelLine.textContent = `Could not read the setting: ${err.message}`; return; }
    const hostName = settings.node || '';
    const hostEntry = entries.find((e) => e.node.name === hostName);
    if (settings.enabled) {
      try { status = await api(`${hostEntry ? node(hostEntry.node.id) : '/api/local'}/responder`); } catch { hostKnown = false; }
    }
    try { tts = await api('/api/local/tts'); } catch { tts = null; }
    const v = responderView({ settings, status, tts, hostKnown });
    box.checked = v.on;
    box.disabled = false;
    title.textContent = v.title;
    modelDot.className = `lr-dot ${v.modelDot}`;
    voiceDot.className = `lr-dot ${v.voiceDot}`;
    modelLine.textContent = v.modelText;
    voiceLine.textContent = `Voice: ${v.voiceText}`;
    where.textContent = v.where;
  }

  box.onchange = async () => {
    const want = box.checked;
    box.disabled = true;
    try {
      await api('/api/local/quick', { method: 'POST', body: { local: { enabled: want } } });
      toast(`Local responder ${want ? 'on' : 'off'}`);
      // load the model now, so the first reply doesn't fall back to Haiku while it loads; the dot turns green once it is
      if (want) {
        const hostEntry = entries.find((e) => e.node.name === (settings.node || ''));
        modelLine.textContent = 'Loading the model…';
        api(`${hostEntry ? node(hostEntry.node.id) : '/api/local'}/responder/warm`, { method: 'POST' }).then(refresh, refresh);
      }
    } catch (err) { box.checked = !want; toast('Could not change the local responder: ' + err.message, 'error'); }
    await refresh();
  };

  const root = h('div', { class: 'bm-pre lr' },
    h('div', { class: 'lr-body' }, title,
      h('div', { class: 'lr-line' }, modelDot, modelLine),
      h('div', { class: 'lr-line' }, voiceDot, voiceLine), where),
    h('label', { class: 'ctl-switch' }, box, h('span', { class: 'ctl-knob' })));
  refresh();
  return root;
}
