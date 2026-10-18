// Pure part of the Connectors panel (ui/src/connectors-panel.js): what the Google Drive row says and which
// buttons are available for a /api/local/connectors/google-drive/status answer. No DOM.

export const DRIVE_BASE = '/api/local/connectors/google-drive';
export const DRIVE_CONNECT_URL = `${DRIVE_BASE}/auth/start?redirect=1`;

/** Account label from the status route: `account` is `{ email, name }`, a string or absent. */
export function accountLabel(account) {
  if (!account) return '';
  if (typeof account === 'string') return account;
  return String(account.email || account.name || account.displayName || '').trim();
}

/** `st` = status answer, or null while loading, or `{ _err }` when the route failed. */
export function driveView(st) {
  if (!st) return { state: 'loading', chip: 'checking…', tone: '', detail: '', canConnect: false, canDisconnect: false, needsSetup: false };
  if (st._err) return { state: 'error', chip: 'unavailable', tone: 'st-bad', detail: st._err, canConnect: false, canDisconnect: false, needsSetup: false };
  if (st.connected) {
    const who = accountLabel(st.account);
    return { state: 'connected', chip: 'connected', tone: 'st-ok', detail: who ? `Signed in as ${who}. Read-only access to Drive.` : 'Read-only access to Drive.', account: who, canConnect: false, canDisconnect: true, needsSetup: false };
  }
  if (!st.configured) return { state: 'unconfigured', chip: 'not set up', tone: 'st-warn', detail: 'Save a Google OAuth client id and secret (Desktop app) to enable Connect.', canConnect: false, canDisconnect: false, needsSetup: true };
  return { state: 'disconnected', chip: 'not connected', tone: '', detail: 'Connect to let JARVIS search and read your Drive files (read-only).', canConnect: true, canDisconnect: false, needsSetup: false };
}
