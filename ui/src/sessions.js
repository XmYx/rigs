import { ago, api, h, node, toast } from './api.js';
import { openTerminal } from './terminal-lazy.js';
import { openWindow } from './wm.js';
import { nativeCtx, tagCtx } from './ctx-tag.js';

const KIND_ICON = { claude: '✳', codex: '◎', tmux: '▤', rig: '⛭', pty: '⌨', chat: '💬' };
const KIND_LABEL = { claude: 'Claude Code', codex: 'Codex', tmux: 'tmux', rig: 'OpenRig seat', pty: 'RIGS terminal', chat: 'JARVIS chat' };

/** Every coding & chat session on every machine — browse, read, attach, type into, resume. */
export function openSessions({ snapshot, focus, onContinueChat, onAttachChat, onAttached } = {}) {
  let filter = '';
  let kind = '';
  let active = null;
  const listEl = h('div', { class: 'sess-list' });
  const detail = h('div', { class: 'sess-detail' }, h('div', { class: 'muted pad' }, 'Pick a session — from any machine.'));
  const search = h('input', { class: 'path-input', placeholder: 'Filter sessions…', oninput: (e) => { filter = e.target.value.toLowerCase(); render(); } });
  const kinds = h('select', { class: 'mini', onchange: (e) => { kind = e.target.value; render(); } },
    h('option', { value: '' }, 'All kinds'), ...Object.entries(KIND_LABEL).map(([k, v]) => h('option', { value: k }, v)));
  const w = openWindow({ title: 'Sessions — whole mesh', icon: '💬', width: 1100, height: 620, className: 'sess-win' });
  w.body.append(h('div', { class: 'toolbar' }, search, kinds, h('button', { class: 'tb', onclick: refresh }, '↻')), h('div', { class: 'files-split sess-split' }, listEl, detail));

  let data = snapshot();
  function rows() {
    const out = [];
    for (const e of data) {
      if (!e.node.rigs || !e.node.online) continue;
      for (const s of e.sessions || []) {
        if (kind && s.kind !== kind) continue;
        const hay = `${s.title} ${s.project} ${s.cwd} ${e.node.name} ${s.kind} ${s.agent}`.toLowerCase();
        if (filter && !hay.includes(filter)) continue;
        out.push({ node: e.node, s });
      }
    }
    return out.sort((a, b) => (b.s.live - a.s.live) || (b.s.updatedAt || 0) - (a.s.updatedAt || 0));
  }

  function render() {
    const r = rows();
    listEl.replaceChildren(...r.slice(0, 400).map(({ node: n, s }) => {
      const el = h('div', { class: 'sess-row' + (active && active.s.id === s.id && active.node.id === n.id ? ' sel' : '') },
        h('span', { class: `sk k-${s.agent === 'ssh' ? 'ssh' : s.kind}` }, s.agent === 'ssh' ? '🔐' : KIND_ICON[s.kind] || '•'),
        h('div', { class: 'sm' },
          h('div', { class: 'st' }, s.title || s.id),
          h('div', { class: 'ss' }, `${n.name} · ${KIND_LABEL[s.kind] || s.kind}${s.project ? ' · ' + s.project : ''} · ${ago(s.updatedAt)}`)),
        s.live ? h('span', { class: 'live-dot', title: 'live' }) : null);
      el.addEventListener('click', () => show(n, s));
      return tagCtx(el, 'session', s.id, { node: n, s, transcript: () => show(n, s) });
    }));
    if (!r.length) listEl.append(h('div', { class: 'muted pad' }, 'No sessions match.'));
  }

  async function show(n, s) {
    active = { node: n, s };
    render();
    const msgs = nativeCtx(h('div', { class: 'transcript' }, h('div', { class: 'muted pad' }, 'Loading transcript…'))); // selectable text: the browser's menu
    const input = h('input', { class: 'path-input', placeholder: s.live || s.kind === 'claude' || s.kind === 'codex' ? `Type into this ${KIND_LABEL[s.kind]} on ${n.name}…` : 'Not live — attach/resume to continue' });
    const canType = (s.live && ['tmux', 'rig', 'pty'].includes(s.kind)) || s.kind === 'claude' || s.kind === 'codex';
    input.disabled = !canType;
    input.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter' || !input.value.trim()) return;
      try { await api(`${node(n.id)}/sessions/send`, { method: 'POST', body: { kind: s.kind, id: s.id, text: input.value } }); input.value = ''; setTimeout(loadT, 1200); }
      catch (err) { toast(err.message, 'error'); }
    });
    const attachLabel = s.kind === 'pty' ? 'Open terminal' : s.kind === 'chat' ? 'Continue with JARVIS' : s.live ? 'Attach terminal' : 'Resume in terminal';
    const head = h('div', { class: 'pad sess-head' },
      h('div', { class: 'pv-title' }, `${KIND_ICON[s.kind] || ''} ${s.title || s.id}`),
      h('div', { class: 'muted' }, `${n.name} · ${KIND_LABEL[s.kind] || s.kind}${s.cwd ? ' · ' + s.cwd : ''}${s.branch ? ' · ⎇ ' + s.branch : ''}`),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: () => attach(n, s) }, attachLabel),
        s.kind !== 'chat' && onAttachChat ? h('button', { class: 'btn', title: 'Attach the JARVIS chat dock to this session: what you type or say goes straight into it', onclick: () => onAttachChat(n, s) }, '💬 Chat here') : null,
        h('button', { class: 'btn', onclick: loadT }, '↻ Refresh'),
        h('button', { class: 'btn', onclick: () => focus?.(n, s) }, '◎ Show in galaxy'),
        s.kind === 'claude' || s.kind === 'codex' ? h('button', { class: 'btn', onclick: () => { navigator.clipboard.writeText(`ssh ${n.sshAlias || n.name} -t "cd ${s.cwd || '~'} && ${s.kind === 'claude' ? 'claude --resume' : 'codex resume'} ${s.id}"`); toast('Resume command copied'); } }, '⧉ Copy ssh resume') : null));
    detail.replaceChildren(head, msgs, h('div', { class: 'sess-input' }, input));
    async function loadT() {
      try {
        const t = await api(`${node(n.id)}/sessions/transcript?kind=${encodeURIComponent(s.kind)}&id=${encodeURIComponent(s.id)}`);
        msgs.replaceChildren(...t.slice(-250).map((m) => h('div', { class: `msg r-${m.role}` },
          h('div', { class: 'mr' }, m.role === 'tool' ? `⚙ ${m.name || 'tool'}` : m.role === 'terminal' ? '▤ terminal' : m.role === 'user' ? 'you' : m.name || s.agent || 'assistant'),
          h(m.role === 'terminal' ? 'pre' : 'div', { class: 'mt' }, m.text))));
        msgs.scrollTop = msgs.scrollHeight;
      } catch (e) { msgs.replaceChildren(h('div', { class: 'muted pad' }, e.message)); }
    }
    loadT();
  }

  async function attach(n, s) {
    if (s.kind === 'chat') { onContinueChat?.(n, s); return; }
    try {
      const r = await api(`${node(n.id)}/sessions/attach`, { method: 'POST', body: { kind: s.kind, id: s.id, cwd: s.cwd } });
      onAttached?.(n.id, s.kind, s.id);
      openTerminal({ nodeId: n.id, nodeName: n.name, ptyId: r.ptyId, title: `${KIND_LABEL[s.kind]} · ${s.title}`.slice(0, 60) });
    } catch (e) { toast(e.message, 'error'); }
  }

  async function refresh() { data = await api('/api/mesh/snapshot').catch(() => data); render(); }
  render();
  return { window: w, showSession: (n, s) => show(n, s) };
}
