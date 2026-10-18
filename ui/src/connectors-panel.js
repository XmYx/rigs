import { api, h, toast } from './api.js';
import { DRIVE_BASE, DRIVE_CONNECT_URL, driveView } from './connectors-model.js';

// "Connectors" tab of the Mesh control window: external accounts JARVIS can reach. Today: Google Drive
// (status, Connect → Google's consent screen in a new window, Disconnect, and the OAuth client setup).

export function createConnectors(root) {
  let timer = null;
  let cfg = null;
  let lastState = null;
  const el = h('div', { class: 'conn-list' });
  root.append(el);

  async function load() {
    const st = await api(`${DRIVE_BASE}/status`).catch((e) => ({ _err: e.message }));
    cfg = st._err ? null : await api(`${DRIVE_BASE}/config`).catch(() => cfg);
    lastState = st;
    render(st);
    return st;
  }

  function connect() {
    const win = window.open(DRIVE_CONNECT_URL, '_blank', 'width=520,height=720');
    if (!win) { toast('The browser blocked the sign-in window — allow pop-ups for JARVIS and try again', 'error', 9000); return; }
    toast('Finish signing in to Google in the new window…');
    // The callback runs in that window; poll until the status flips (or give up after 3 minutes).
    clearInterval(timer);
    const until = Date.now() + 180000;
    timer = setInterval(async () => {
      const st = await load();
      if (st.connected) { clearInterval(timer); toast('Google Drive connected', 'ok'); }
      else if (Date.now() > until || !document.body.contains(el)) clearInterval(timer);
    }, 2000);
  }

  async function disconnect() {
    if (!confirm('Disconnect Google Drive? JARVIS loses access until you connect again.')) return;
    try { await api(`${DRIVE_BASE}/disconnect`, { method: 'POST', body: {} }); toast('Google Drive disconnected', 'ok'); }
    catch (e) { toast(`Disconnect: ${e.message}`, 'error', 9000); }
    await load();
  }

  async function saveConfig(idEl, secretEl) {
    const body = { clientId: idEl.value.trim() };
    if (secretEl.value) body.clientSecret = secretEl.value;
    try { await api(`${DRIVE_BASE}/config`, { method: 'POST', body }); toast('Saved', 'ok'); }
    catch (e) { toast(`Save: ${e.message}`, 'error', 9000); }
    await load();
  }

  function setup(v) {
    const idEl = h('input', { class: 'path-input', value: cfg?.clientId || '', placeholder: 'xxxx.apps.googleusercontent.com', autocomplete: 'off', spellcheck: false, 'aria-label': 'Google OAuth client id' });
    const secretEl = h('input', { class: 'path-input', type: 'password', placeholder: cfg?.clientSecretSet ? '•••••••• (saved)' : 'client secret', autocomplete: 'off', 'aria-label': 'Google OAuth client secret' });
    return h('details', { class: 'conn-setup', open: v.needsSetup },
      h('summary', {}, 'OAuth client'),
      h('label', {}, 'Client id', idEl), h('label', {}, 'Client secret', secretEl),
      cfg?.redirectUri ? h('div', { class: 'muted small conn-redirect' }, 'Redirect URI: ', h('span', { class: 'mono' }, cfg.redirectUri)) : null,
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => saveConfig(idEl, secretEl) }, 'Save')));
  }

  function render(st) {
    const v = driveView(st);
    const open = el.querySelector('.conn-setup')?.open;
    el.replaceChildren(h('section', { class: `conn-card conn-${v.state}`, 'data-connector': 'google-drive', 'aria-label': 'Google Drive' },
      h('div', { class: 'conn-head' },
        h('span', { class: 'conn-icon', 'aria-hidden': 'true' }, '📁'),
        h('b', { class: 'conn-name' }, 'Google Drive'),
        h('span', { class: `chip ${v.tone}`, role: 'status' }, v.chip)),
      h('div', { class: 'conn-detail muted' }, v.detail),
      h('div', { class: 'conn-actions' },
        h('button', { class: 'btn primary', disabled: !v.canConnect, onclick: connect }, 'Connect'),
        h('button', { class: 'btn danger', disabled: !v.canDisconnect, onclick: disconnect }, 'Disconnect'),
        h('button', { class: 'btn', onclick: load, title: 'Check the status again' }, '↻')),
      v.state === 'error' ? null : setup(v)));
    if (open != null && !v.needsSetup) el.querySelector('.conn-setup').open = open;
  }

  load();
  return { refresh: load, state: () => lastState };
}
