import { ago, api, h, node, toast } from './api.js';
import { openWindow } from './wm.js';

// Access & Control panel for one machine: what RIGS may see and do on its screen, the grants it is
// missing, the access and full-control switches (on by default; kill switch and per-machine off), a live
// "in control" indicator and a stop button.

const PERMS = [
  ['screenCapture', 'Screen capture', 'See the screen'],
  ['input', 'Input', 'Move the pointer and type'],
  ['accessibility', 'Accessibility', 'List and focus windows'],
  ['automation', 'Automation', 'Drive other apps (macOS)'],
  ['fullDiskAccess', 'Full Disk Access', 'Read protected folders (macOS, optional)'],
];

const panels = new Set();

/** Called from the WebSocket handler: refresh any open panel for this machine. */
export function controlEvent(m) {
  for (const p of panels) if (!m.node || m.node === p.name) p.refresh();
}

export function openControl({ machine }) {
  const id = machine.id;
  let timer = null;
  let shotUrl = null;
  const w = openWindow({ title: `Access & control · ${machine.name}`, icon: '🛡', width: 560, height: 640, className: 'ctl-win', onClose: () => { clearInterval(timer); panels.delete(entry); if (shotUrl) URL.revokeObjectURL(shotUrl); } });
  const body = h('div', { class: 'pad ctl' }, h('div', { class: 'muted' }, 'Loading…'));
  w.body.append(body);
  const entry = { name: machine.name, refresh: () => render() };
  panels.add(entry);

  const run = async (label, fn) => {
    try { const r = await fn(); if (r?.message) toast(r.message, 'ok', 12000); await render(); }
    catch (e) { toast(`${label}: ${e.message}`, 'error', 9000); await render(); }
  };

  function setMode({ enabled, input }) {
    const turningOn = enabled === true || input === true;
    let confirm;
    if (turningOn) {
      const what = input ? 'let JARVIS and its agents move the pointer and type on' : 'let JARVIS and its agents see the screen of';
      confirm = prompt(`This will ${what} ${machine.name}. Every action is logged and announced, and you can stop it at any time.\n\nType the machine name to confirm:`);
      if (confirm == null) return render();
      if (confirm.trim() !== machine.name) { toast('Name did not match — nothing changed', 'error'); return render(); }
      confirm = confirm.trim();
    }
    return run('Save', () => api(`${node(id)}/control/enable`, { method: 'POST', body: { ...(enabled != null ? { enabled } : {}), ...(input != null ? { input } : {}), ...(confirm ? { confirm } : {}) } }));
  }

  const stop = () => run('Stop', () => api(`${node(id)}/control/kill`, { method: 'POST', body: { reason: 'Stopped from the JARVIS panel' } }).then(() => ({ message: `Control on ${machine.name} stopped.` })));
  const stopAll = () => run('Stop all', () => api('/api/mesh/control/kill', { method: 'POST', body: { reason: 'Stopped from the JARVIS panel' } }).then((r) => ({ message: `Stopped: ${r.map((x) => x.node + (x.error ? ' (' + x.error + ')' : '')).join(', ')}` })));

  async function preview(img, btn) {
    btn.disabled = true;
    try {
      const r = await api(`${node(id)}/control/screenshot?maxWidth=640`, { raw: true });
      if (!r.ok) { let m = `HTTP ${r.status}`; try { const j = await r.json(); m = j.error + (j.fix ? ' — ' + j.fix : ''); } catch {} throw new Error(m); }
      if (shotUrl) URL.revokeObjectURL(shotUrl);
      shotUrl = URL.createObjectURL(await r.blob());
      img.src = shotUrl; img.style.display = '';
    } catch (e) { toast(`Preview: ${e.message}`, 'error', 9000); }
    btn.disabled = false;
  }

  const dot = (ok) => h('i', { class: `ctl-dot ${ok === true ? 'ok' : ok === false ? 'bad' : 'warn'}`, title: ok === true ? 'granted' : ok === false ? 'missing' : 'unknown' });

  async function render() {
    const [st, ac, audit] = await Promise.all([
      api(`${node(id)}/control?force=1`).catch((e) => ({ _err: e.message })),
      api(`${node(id)}/access?force=1`).catch(() => null),
      api(`${node(id)}/control/audit?limit=8`).catch(() => []),
    ]);
    if (!document.body.contains(w.el)) return;
    if (st._err) {
      body.replaceChildren(h('div', { class: 'warnbox' }, machine.online === false ? `${machine.name} is offline.` : `Cannot reach ${machine.name}: ${st._err}`), h('div', { class: 'muted small' }, 'Access and control can only be changed on a machine that is online and running RIGS.'));
      return;
    }
    const lease = st.lease;
    const rows = PERMS.filter(([k]) => ac?.[k] != null || ['screenCapture', 'input', 'accessibility'].includes(k)).map(([k, label, what]) => {
      const p = ac?.[k] ?? {};
      const ok = typeof p === 'object' ? p.ok : p;
      const fixable = ok !== true && (st.platform === 'mac' || (st.platform === 'linux' && k === 'input'));
      return h('div', { class: 'ctl-perm' }, dot(ok ?? null),
        h('div', { class: 'ctl-perm-t' }, h('b', {}, label), h('span', { class: 'muted small' }, ' ' + what),
          p.via || p.detail ? h('div', { class: 'muted small' }, [p.via ? `via ${p.via}` : '', p.partial ? 'partial' : '', p.detail].filter(Boolean).join(' · ')) : null,
          ok !== true && p.fix ? h('div', { class: 'small ctl-fix' }, typeof p.fix === 'string' ? p.fix : p.fix.text || '') : null),
        fixable ? h('button', { class: 'btn', onclick: () => run('Grant', () => api(`${node(id)}/control/grant`, { method: 'POST', body: { permission: k } })) }, 'Grant') : null);
    });

    // macOS: the two grants a person must give once in System Settings (TCC ignores synthetic clicks).
    const macMissing = st.platform === 'mac' ? [['screenCapture', 'Screen Recording'], ['accessibility', 'Accessibility']].filter(([k]) => ac?.[k]?.ok !== true) : [];
    const macGuide = macMissing.length ? h('div', { class: 'ctl-guide' },
      h('b', {}, `Finish setup on ${machine.name}`),
      h('div', { class: 'small' }, 'Control is on, but macOS needs you to allow it once. Click each button: System Settings opens on the right page and the RIGS program is shown in Finder. Switch it on in the list (drag it in if it is missing), then restart RIGS.'),
      h('div', { class: 'ctl-stopbar' }, ...macMissing.map(([k, label]) => h('button', { class: 'btn', onclick: () => run('Grant', () => api(`${node(id)}/control/grant`, { method: 'POST', body: { permission: k } })) }, `Open ${label}`)))) : null;

    const img = h('img', { class: 'ctl-shot', alt: 'screen preview', style: shotUrl ? {} : { display: 'none' }, src: shotUrl || '' });
    const prevBtn = h('button', { class: 'btn', disabled: !st.ready?.see, title: st.ready?.see ? 'Takes one screenshot (logged and announced)' : 'Needs screen access on, an unlocked screen and a capture backend', onclick: (e) => preview(img, e.currentTarget) }, '📷 Preview');
    const logRows = (Array.isArray(audit) ? audit : []).slice().reverse().map((a) => h('div', { class: 'ctl-log' + (a.ok ? '' : ' fail') }, h('span', { class: 'muted' }, ago(Date.parse(a.ts))), h('b', {}, a.op), h('span', { class: 'muted small' }, a.caller?.agent || a.caller?.who || (a.caller?.human ? 'person' : '')), a.ok ? null : h('span', { class: 'chip st-bad' }, a.error?.code || 'failed')));

    body.replaceChildren(...[
      lease ? h('div', { class: 'ctl-live' }, h('i', { class: 'ctl-pulse' }), h('div', {}, h('b', {}, 'JARVIS is in control'), h('div', { class: 'small' }, `${lease.holder?.agent || lease.holder?.who || 'an agent'}${lease.holder?.from ? ' on ' + lease.holder.from : ''} · ${lease.actions || 0} actions · since ${ago(lease.since)}`)), h('button', { class: 'btn danger', onclick: stop }, '■ Stop'))
        : st.killed ? h('div', { class: 'warnbox small' }, `Control was stopped ${ago(Date.parse(st.killed.at))}${st.killed.reason ? ': ' + st.killed.reason : ''}. It stays off, across restarts and updates, until you switch it on again.`) : null,
      macGuide,
      h('div', { class: 'muted small' }, 'On by default on every machine. Stop it at once with the kill switch, or switch it off for this machine below.'),
      h('div', { class: 'ctl-modes' },
        modeRow('Screen access', 'Agents can take screenshots and list windows.', st.enabled, (v) => setMode({ enabled: v })),
        modeRow('Full control', 'Agents can also move the pointer, click and type.', st.input, (v) => setMode({ input: v }), !st.enabled)),
      h('div', { class: 'ctl-stopbar' },
        h('button', { class: 'btn danger', disabled: !st.enabled && !lease, onclick: stop }, '■ Stop control now'),
        h('button', { class: 'btn', onclick: stopAll, title: 'Switch screen control off on every online machine' }, 'Stop on every machine')),
      h('div', { class: 'pv-title ctl-h' }, 'Permissions'),
      h('div', { class: 'muted small' }, `${st.platform || ''} · ${st.session || 'no session'}${st.desktop ? ' · ' + st.desktop : ''}${st.locked ? ' · screen locked' : ''}`),
      ...rows,
      st.backend?.missing?.length ? h('div', { class: 'warnbox small' }, `No backend yet for: ${st.backend.missing.join(', ')}.`) : null,
      h('div', { class: 'ctl-prev' }, prevBtn, img),
      h('div', { class: 'pv-title ctl-h' }, 'Recent actions'),
      ...(logRows.length ? logRows : [h('div', { class: 'muted small' }, 'Nothing yet.')]),
    ].filter(Boolean)); // replaceChildren would print a literal "null"
  }

  function modeRow(title, desc, on, set, disabled = false) {
    const box = h('input', { type: 'checkbox', checked: !!on, disabled, onchange: () => set(box.checked) });
    return h('label', { class: 'ctl-mode' + (disabled ? ' off' : '') }, h('div', {}, h('b', {}, title), h('div', { class: 'muted small' }, desc)), h('span', { class: 'ctl-switch' }, box, h('span', { class: 'ctl-knob' })));
  }

  render();
  timer = setInterval(render, 4000);
  return w;
}
