// Google Drive connector (/api/local/connectors/google-drive/*): read-only access to Sir's Drive for JARVIS.
//
// OAuth 2.0 authorization code flow for a desktop app: the consent URL carries a random `state` and a PKCE S256
// challenge, Google sends the browser back to this daemon's own loopback callback, and the code is exchanged
// (with the verifier and the client secret) for an access token plus a refresh token (access_type=offline).
// Client id and secret live in config.connectors.googleDrive { clientId, clientSecret, redirectUri?, maxBytes? }
// — set through POST …/config, never hard-coded and never sent back out. Tokens are kept in
// RIGS_HOME/connectors/google-drive.json (mode 0600) and refreshed shortly before they expire.
//
// The Drive v3 client is plain fetch: search by name and/or full text, file metadata, and content —
// Google Docs and Slides exported as text/plain, Sheets as text/csv (first sheet), text files downloaded —
// always read up to a byte cap and flagged `truncated` past it. Binary files return metadata only.
//
// Nothing here returns or logs a token or the client secret: responses are built from explicit fields and every
// error message passes `redact` with the live secrets first.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, RIGS_HOME, saveConfig } from '../config.js';
import { log } from '../util.js';

export const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const CALLBACK_PATH = '/api/local/connectors/google-drive/auth/callback';
export const TOKEN_FILE = path.join(RIGS_HOME, 'connectors', 'google-drive.json');

export const DEFAULT_MAX_BYTES = 1024 * 1024;
export const MAX_MAX_BYTES = 10 * 1024 * 1024; // Drive's own limit for exported content
const STATE_TTL_MS = 10 * 60 * 1000;
const EXPIRY_SKEW_MS = 60 * 1000;
const HTTP_TIMEOUT_MS = 20000;

/** Google Workspace types we can read as text, and the format each is exported to. */
export const EXPORTS = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,createdTime,webViewLink,iconLink,parents,description,owners(displayName,emailAddress)';
const LIST_FIELDS = `nextPageToken,files(${FILE_FIELDS})`;

const STATUS = { bad_request: 400, bad_state: 400, not_configured: 409, not_connected: 409, not_found: 404, unsupported: 415, too_large: 413, rate: 429, google: 502 };

export class DriveError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'DriveError';
    this.code = code;
    this.status = STATUS[code] || 500;
    Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------- pure helpers

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** PKCE pair (RFC 7636): a 43-char verifier and its S256 challenge. */
export function pkcePair(random = crypto.randomBytes) {
  const verifier = b64url(random(32));
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier) {
  return b64url(crypto.createHash('sha256').update(verifier).digest());
}

export function newState(random = crypto.randomBytes) {
  return b64url(random(32));
}

/** The loopback redirect this daemon answers on (Google desktop clients accept any port on 127.0.0.1). */
export function defaultRedirectUri(port) {
  return `http://127.0.0.1:${port}${CALLBACK_PATH}`;
}

/** Google's consent URL: drive.readonly, offline access (refresh token), state and PKCE S256. */
export function buildAuthUrl({ clientId, redirectUri, state, codeChallenge, scope = SCOPE }) {
  if (!clientId) throw new DriveError('not_configured', 'Google Drive client id is not set');
  if (!state || !codeChallenge) throw new DriveError('bad_request', 'state and PKCE challenge are required');
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    // consent every time, so Google issues a refresh token again after a disconnect
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  return `${AUTH_URL}?${p}`;
}

/**
 * Pending authorizations, keyed by state: single use, expire after `ttlMs`, at most `max` at once (oldest
 * dropped). `take` returns the stored data only for a known, unexpired state, and forgets it either way.
 */
export function createStateStore({ ttlMs = STATE_TTL_MS, max = 20, now = Date.now } = {}) {
  const pending = new Map();
  const sweep = () => { for (const [k, v] of pending) if (now() - v.at > ttlMs) pending.delete(k); };
  return {
    put(state, data) {
      sweep();
      while (pending.size >= max) pending.delete(pending.keys().next().value);
      pending.set(state, { at: now(), data });
    },
    take(state) {
      if (typeof state !== 'string' || !state) return null;
      const hit = pending.get(state);
      pending.delete(state);
      if (!hit || now() - hit.at > ttlMs) return null;
      return hit.data;
    },
    get size() { sweep(); return pending.size; },
  };
}

/** The callback's state check: a missing, unknown, reused or expired state is refused. */
export function checkState(store, state) {
  if (!state) throw new DriveError('bad_state', 'missing state — start the Google Drive connection again');
  const data = store.take(String(state));
  if (!data) throw new DriveError('bad_state', 'state does not match a pending sign-in (expired or already used) — start again');
  return data;
}

/** Stored token record from a token endpoint response; a refresh that brings no new refresh token keeps the old one. */
export function tokensFromResponse(r, now = Date.now(), prev = null) {
  if (!r || typeof r.access_token !== 'string' || !r.access_token) throw new DriveError('google', 'Google sent no access token');
  const expiresIn = Number(r.expires_in);
  return {
    access_token: r.access_token,
    refresh_token: r.refresh_token || prev?.refresh_token || null,
    token_type: r.token_type || 'Bearer',
    scope: r.scope || prev?.scope || '',
    expires_at: now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
  };
}

/** True when the access token is missing or expires within `skewMs`. */
export function isExpired(tokens, now = Date.now(), skewMs = EXPIRY_SKEW_MS) {
  if (!tokens?.access_token) return true;
  const at = Number(tokens.expires_at);
  return !Number.isFinite(at) || now >= at - skewMs;
}

export function hasScope(scopeString, scope = SCOPE) {
  return String(scopeString || '').split(/\s+/).includes(scope);
}

/** Drive query string literal: backslashes and single quotes escaped. */
export function quoteQuery(s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** `q` for files.list: mode name | fulltext | any (either), never trashed files. */
export function searchQuery(text, mode = 'any') {
  const t = String(text ?? '').trim();
  if (!t) throw new DriveError('bad_request', 'search text is required');
  if (t.length > 500) throw new DriveError('bad_request', 'search text is too long (500 characters at most)');
  const lit = quoteQuery(t);
  const terms = { name: `name contains ${lit}`, fulltext: `fullText contains ${lit}`, any: `(name contains ${lit} or fullText contains ${lit})` };
  if (!terms[mode]) throw new DriveError('bad_request', 'mode must be name, fulltext or any');
  return `${terms[mode]} and trashed = false`;
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-javascript|ecmascript|x-yaml|yaml|x-sh|x-shellscript|sql|csv|x-ndjson|ld\+json|x-tex|rtf)\b)|\+(json|xml)$/i;

/** How a file's content is read: export (Workspace doc → text), download (text file) or none (binary/folder). */
export function readPlan(mimeType) {
  const m = String(mimeType || '');
  if (EXPORTS[m]) return { how: 'export', mimeType: EXPORTS[m] };
  if (m.startsWith('application/vnd.google-apps.')) return { how: 'none', reason: `${m.slice('application/vnd.google-apps.'.length)} files have no text export` };
  if (TEXT_TYPES.test(m)) return { how: 'download', mimeType: m };
  return { how: 'none', reason: `binary content (${m || 'unknown type'}) is not read as text` };
}

/** The byte cap for one read: the request's maxBytes, else the configured one, clamped to 1 byte … 10 MiB. */
export function clampMaxBytes(requested, configured = DEFAULT_MAX_BYTES) {
  const base = Number(configured) > 0 ? Number(configured) : DEFAULT_MAX_BYTES;
  const n = requested === undefined || requested === null || requested === '' ? base : Number(requested);
  if (!Number.isFinite(n) || n < 1) throw new DriveError('bad_request', 'maxBytes must be a positive number');
  return Math.min(Math.floor(n), MAX_MAX_BYTES);
}

/** UTF-8 text from at most `maxBytes` of `buf`, never splitting a character; BOM dropped. */
export function decodeCapped(buf, maxBytes) {
  const truncated = buf.length > maxBytes;
  const slice = truncated ? buf.subarray(0, maxBytes) : buf;
  // stream: true holds back an incomplete trailing sequence instead of emitting U+FFFD
  const text = new TextDecoder('utf-8').decode(slice, { stream: truncated });
  return { text, truncated, bytes: Buffer.byteLength(text) };
}

/** Replaces every given secret in `text` (tokens, client secret, auth code) with [redacted]. */
export function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) if (typeof s === 'string' && s.length >= 6) out = out.split(s).join('[redacted]');
  return out;
}

/** A Drive file as returned to callers: explicit fields only. */
export function publicFile(f) {
  if (!f) return null;
  return {
    id: f.id, name: f.name, mimeType: f.mimeType,
    size: f.size !== undefined ? Number(f.size) : null,
    modifiedTime: f.modifiedTime || null, createdTime: f.createdTime || null,
    webViewLink: f.webViewLink || null, iconLink: f.iconLink || null,
    parents: f.parents || [], description: f.description || '',
    owners: (f.owners || []).map((o) => ({ name: o.displayName || '', email: o.emailAddress || '' })),
    readable: readPlan(f.mimeType).how !== 'none',
  };
}

export function validateSettings(input, prev = {}) {
  const out = { ...prev };
  const errors = [];
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  if (input.clientId !== undefined) {
    const v = str(input.clientId);
    if (v && (v.length > 300 || /\s/.test(v))) errors.push('clientId: not a Google OAuth client id');
    else out.clientId = v;
  }
  if (input.clearSecret === true) out.clientSecret = '';
  else if (input.clientSecret !== undefined && input.clientSecret !== '') {
    const v = str(input.clientSecret);
    if (!v || v.length > 300 || /\s/.test(v)) errors.push('clientSecret: not a Google OAuth client secret');
    else out.clientSecret = v;
  }
  if (input.redirectUri !== undefined) {
    const v = str(input.redirectUri);
    if (v) {
      let u = null;
      try { u = new URL(v); } catch { /* reported below */ }
      if (!u || !/^https?:$/.test(u.protocol) || u.hash) errors.push('redirectUri: must be an http(s) URL without a fragment');
      else out.redirectUri = v;
    } else out.redirectUri = '';
  }
  if (input.maxBytes !== undefined) {
    const n = Number(input.maxBytes);
    if (!Number.isFinite(n) || n < 1 || n > MAX_MAX_BYTES) errors.push(`maxBytes: 1 … ${MAX_MAX_BYTES}`);
    else out.maxBytes = Math.floor(n);
  }
  return { value: out, errors };
}

// ---------------------------------------------------------------- token file

export function readTokens(file = TOKEN_FILE) {
  try {
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    return t && typeof t === 'object' && t.access_token ? t : null;
  } catch { return null; }
}

/** Writes the token record owner-only: a fresh 0600 temp file renamed over the old one, in a 0700 folder. */
export function writeTokens(tokens, file = TOKEN_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* Windows: ACLs, not modes */ }
  fs.renameSync(tmp, file);
}

export function deleteTokens(file = TOKEN_FILE) {
  try { fs.unlinkSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

// ---------------------------------------------------------------- settings in config

export function loadSettings(cfg = config()) {
  const s = cfg.connectors?.googleDrive;
  return s && typeof s === 'object' ? { clientId: '', clientSecret: '', redirectUri: '', maxBytes: DEFAULT_MAX_BYTES, ...s } : { clientId: '', clientSecret: '', redirectUri: '', maxBytes: DEFAULT_MAX_BYTES };
}

export function saveSettings(input) {
  const cfg = config();
  const { value, errors } = validateSettings(input || {}, loadSettings(cfg));
  if (errors.length) throw new DriveError('bad_request', errors.join('; '));
  cfg.connectors = { ...(cfg.connectors || {}), googleDrive: value };
  saveConfig(cfg);
  return value;
}

// ---------------------------------------------------------------- service

/**
 * The connector. Everything with side effects is injectable for tests: settings, the token file, fetch, the clock
 * and the port the loopback redirect points at.
 */
export function createGoogleDrive({
  getSettings = loadSettings, setSettings = saveSettings, tokenFile = TOKEN_FILE,
  fetchImpl = globalThis.fetch, now = Date.now, port = () => config().port, random = crypto.randomBytes,
} = {}) {
  const states = createStateStore({ now });
  let refreshing = null;

  const redirectUri = (s = getSettings()) => s.redirectUri || defaultRedirectUri(port());
  const configured = (s = getSettings()) => Boolean(s.clientId && s.clientSecret);
  const secretsOf = (s = getSettings(), t = readTokens(tokenFile), extra = []) => [s.clientSecret, t?.access_token, t?.refresh_token, ...extra];
  const fail = (code, msg, secrets) => new DriveError(code, redact(msg, secrets));

  async function http(url, init = {}) {
    try {
      return await fetchImpl(url, { ...init, signal: init.signal || AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    } catch (e) {
      throw new DriveError('google', `cannot reach Google (${e.name === 'TimeoutError' ? 'timed out' : e.message})`);
    }
  }

  /** POST to the token endpoint; Google's `error`/`error_description` only, never the request. */
  async function tokenCall(form, secrets) {
    const r = await http(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
    let j = null;
    try { j = await r.json(); } catch { /* not JSON */ }
    if (!r.ok) {
      const why = [j?.error, j?.error_description].filter(Boolean).join(': ') || `HTTP ${r.status}`;
      const err = fail('google', `Google token endpoint refused the request (${why})`, secrets);
      err.oauthError = j?.error || null;
      throw err;
    }
    return j;
  }

  function settingsView(s = getSettings()) {
    return { clientId: s.clientId || '', clientSecretSet: Boolean(s.clientSecret), redirectUri: redirectUri(s), maxBytes: s.maxBytes || DEFAULT_MAX_BYTES, configured: configured(s) };
  }

  function status() {
    const s = getSettings();
    const t = readTokens(tokenFile);
    return {
      configured: configured(s),
      connected: Boolean(t && (t.refresh_token || !isExpired(t, now()))),
      account: t?.account || null,
      scope: t ? SCOPE : null,
      connectedAt: t?.connectedAt || null,
      canRefresh: Boolean(t?.refresh_token),
      redirectUri: redirectUri(s),
    };
  }

  function startAuth() {
    const s = getSettings();
    if (!configured(s)) throw new DriveError('not_configured', 'Google Drive is not set up: save an OAuth client id and secret (Desktop app) first');
    const { verifier, challenge } = pkcePair(random);
    const state = newState(random);
    const redirect = redirectUri(s);
    states.put(state, { verifier, redirectUri: redirect });
    return { url: buildAuthUrl({ clientId: s.clientId, redirectUri: redirect, state, codeChallenge: challenge }), redirectUri: redirect, expiresInSec: STATE_TTL_MS / 1000 };
  }

  /** The OAuth callback: state check, code → tokens, scope check, account label, then the 0600 token file. */
  async function finishAuth(params) {
    const get = (k) => (typeof params.get === 'function' ? params.get(k) : params[k]);
    const pending = checkState(states, get('state'));
    if (get('error')) throw new DriveError('bad_request', `Google sign-in was not completed (${String(get('error')).slice(0, 80)})`);
    const code = get('code');
    if (!code) throw new DriveError('bad_request', 'Google sent no authorization code');
    const s = getSettings();
    if (!configured(s)) throw new DriveError('not_configured', 'Google Drive client id and secret are not set');
    const secrets = [s.clientSecret, String(code), pending.verifier];
    const r = await tokenCall({ code, client_id: s.clientId, client_secret: s.clientSecret, code_verifier: pending.verifier, grant_type: 'authorization_code', redirect_uri: pending.redirectUri }, secrets);
    const tokens = tokensFromResponse(r, now());
    if (!hasScope(tokens.scope)) {
      await revoke(tokens.refresh_token || tokens.access_token).catch(() => false);
      throw new DriveError('bad_request', 'Drive access was not granted — tick “See and download all your Google Drive files” on the consent screen');
    }
    const account = await fetchAccount(tokens.access_token).catch(() => null);
    writeTokens({ ...tokens, account, connectedAt: new Date(now()).toISOString() }, tokenFile);
    log(`google-drive: connected${account?.email ? ` as ${account.email}` : ''}`);
    return status();
  }

  async function fetchAccount(accessToken) {
    const r = await http(`${DRIVE_API}/about?fields=${encodeURIComponent('user(displayName,emailAddress)')}`, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!r.ok) return null;
    const u = (await r.json())?.user;
    return u ? { name: u.displayName || '', email: u.emailAddress || '' } : null;
  }

  async function revoke(token) {
    if (!token) return false;
    const r = await http(REVOKE_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) });
    return r.ok;
  }

  async function disconnect() {
    const t = readTokens(tokenFile);
    // Revoking the refresh token also ends the access tokens issued from it; best effort — the local copy goes either way.
    const revoked = t ? await revoke(t.refresh_token || t.access_token).catch(() => false) : false;
    const removed = deleteTokens(tokenFile);
    if (removed) log('google-drive: disconnected');
    return { ok: true, removed, revoked, ...status() };
  }

  /** A valid access token: the stored one, or a refreshed one (one refresh at a time). */
  async function accessToken({ force = false } = {}) {
    const t = readTokens(tokenFile);
    if (!t) throw new DriveError('not_connected', 'Google Drive is not connected');
    if (!force && !isExpired(t, now())) return t.access_token;
    if (!t.refresh_token) {
      deleteTokens(tokenFile);
      throw new DriveError('not_connected', 'the Google Drive session expired — connect again');
    }
    refreshing ||= (async () => {
      const s = getSettings();
      if (!configured(s)) throw new DriveError('not_configured', 'Google Drive client id and secret are not set');
      try {
        const r = await tokenCall({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: s.clientId, client_secret: s.clientSecret }, secretsOf(s, t));
        const next = { ...t, ...tokensFromResponse(r, now(), t) };
        writeTokens(next, tokenFile);
        return next.access_token;
      } catch (e) {
        if (e.oauthError === 'invalid_grant') {
          // revoked by Sir in his Google account, or expired: the stored tokens are useless now
          deleteTokens(tokenFile);
          log('google-drive: refresh token no longer valid — disconnected');
          throw new DriveError('not_connected', 'Google Drive access was revoked or expired — connect again');
        }
        throw e;
      }
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  /** GET on the Drive API with the bearer token; one forced refresh and retry on a 401. */
  async function driveGet(pathAndQuery) {
    let token = await accessToken();
    let r = await http(`${DRIVE_API}${pathAndQuery}`, { headers: { authorization: `Bearer ${token}` } });
    if (r.status === 401) {
      token = await accessToken({ force: true });
      r = await http(`${DRIVE_API}${pathAndQuery}`, { headers: { authorization: `Bearer ${token}` } });
    }
    if (!r.ok) await driveFailure(r);
    return r;
  }

  async function driveFailure(r) {
    let j = null;
    try { j = await r.json(); } catch { /* not JSON */ }
    const reason = j?.error?.errors?.[0]?.reason || j?.error?.status || '';
    const msg = redact(j?.error?.message || `HTTP ${r.status}`, secretsOf());
    if (r.status === 404) throw new DriveError('not_found', `Drive file not found (${msg})`);
    if (r.status === 401) throw new DriveError('not_connected', `Google refused the Drive token (${msg}) — connect again`);
    if (r.status === 429 || /rateLimitExceeded|userRateLimitExceeded/.test(reason)) throw new DriveError('rate', `Google Drive rate limit (${msg})`);
    if (/exportSizeLimitExceeded/.test(reason)) throw new DriveError('too_large', 'the document is too large for Google to export (10 MB limit)');
    if (/fileNotExportable|cannotExportFile/.test(reason)) throw new DriveError('unsupported', `this file cannot be exported as text (${msg})`);
    if (r.status === 403) throw new DriveError('google', `Google Drive refused the request (${msg})`, { status: 403 });
    throw new DriveError('google', `Google Drive error ${r.status} (${msg})`);
  }

  async function search({ q, mode = 'any', pageSize = 20, pageToken } = {}) {
    const size = Math.max(1, Math.min(100, Number(pageSize) || 20));
    const p = new URLSearchParams({ q: searchQuery(q, mode), fields: LIST_FIELDS, pageSize: String(size), supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', spaces: 'drive' });
    if (pageToken) p.set('pageToken', String(pageToken));
    const j = await (await driveGet(`/files?${p}`)).json();
    return { files: (j.files || []).map(publicFile), nextPageToken: j.nextPageToken || null };
  }

  async function metadata(id) {
    checkId(id);
    const p = new URLSearchParams({ fields: FILE_FIELDS, supportsAllDrives: 'true' });
    return (await driveGet(`/files/${encodeURIComponent(id)}?${p}`)).json();
  }

  /** Metadata plus text content (exported or downloaded), at most `maxBytes` of it. */
  async function read(id, { maxBytes, content = true } = {}) {
    const cap = clampMaxBytes(maxBytes, getSettings().maxBytes);
    const meta = await metadata(id);
    const file = publicFile(meta);
    if (!content) return { file };
    const plan = readPlan(meta.mimeType);
    if (plan.how === 'none') return { file, content: null, reason: plan.reason };
    const r = plan.how === 'export'
      ? await driveGet(`/files/${encodeURIComponent(id)}/export?${new URLSearchParams({ mimeType: plan.mimeType })}`)
      : await driveGet(`/files/${encodeURIComponent(id)}?${new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' })}`);
    const buf = await readUpTo(r, cap);
    const { text, truncated, bytes } = decodeCapped(buf, cap);
    return { file, content: text, contentType: plan.mimeType, exported: plan.how === 'export', bytes, truncated, maxBytes: cap };
  }

  return {
    status, settings: () => settingsView(), setSettings: (input) => { setSettings(input); return settingsView(); },
    startAuth, finishAuth, disconnect, search, metadata, read, accessToken,
    pendingStates: () => states.size,
  };
}

function checkId(id) {
  if (!/^[\w-]{1,200}$/.test(String(id || ''))) throw new DriveError('bad_request', 'invalid Drive file id');
}

/** Reads a response body until `max` + 1 bytes (enough to know it is longer), then stops the download. */
async function readUpTo(r, max) {
  if (!r.body?.getReader) {
    const b = Buffer.from(await r.arrayBuffer());
    return b.subarray(0, max + 1);
  }
  const reader = r.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total > max) { await reader.cancel().catch(() => {}); break; }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.length))).subarray(0, max + 1);
}

// ---------------------------------------------------------------- routes

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The page the browser lands on after Google's consent screen. */
export function callbackPage(ok, message) {
  const title = ok ? 'Google Drive connected' : 'Google Drive not connected';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${title}</title><style>body{font:16px system-ui,sans-serif;background:#0b0f14;color:#e6edf3;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}`
    + `main{max-width:28rem}h1{font-size:1.25rem;color:${ok ? '#4ade80' : '#f87171'}}</style></head>`
    + `<body><main><h1>${title}</h1><p>${esc(message)}</p><p>You can close this window and return to JARVIS.</p></main>`
    + `<script>try{window.opener&&window.opener.postMessage({type:'rigs-connector',connector:'google-drive',ok:${ok ? 'true' : 'false'}},'*')}catch(e){}</script></body></html>`;
}

/**
 * /api/local/connectors/google-drive/<sub>:
 *   GET  status                      → { configured, connected, account, … } (no tokens)
 *   GET  config · POST config        → client id, whether a secret is set, redirect URI, maxBytes
 *   GET|POST auth/start [?redirect=1] → { url } of Google's consent screen (302 to it with redirect=1)
 *   GET  auth/callback?state&code    → HTML page for the browser (JSON when there is no response stream)
 *   POST disconnect                  → revokes at Google (best effort) and deletes the token file
 *   GET  search?q=&mode=name|fulltext|any&pageSize=&pageToken=
 *   GET  file/<id>[?maxBytes=&content=0]
 */
export async function googleDriveRoute(svc, { method, sub, q, res, body }) {
  try {
    return await route(svc, { method, sub, q, res, body });
  } catch (e) {
    if (e instanceof DriveError) {
      const err = new Error(e.message);
      err.status = e.status;
      err.code = e.code;
      throw err;
    }
    throw e;
  }
}

async function route(svc, { method, sub, q, res, body }) {
  let mm;
  if ((sub === 'status' || sub === '') && method === 'GET') return svc.status();
  if (sub === 'config' && method === 'GET') return svc.settings();
  if (sub === 'config' && method === 'POST') return svc.setSettings(await body());
  if (sub === 'auth/start' && (method === 'GET' || method === 'POST')) {
    const r = svc.startAuth();
    if (res && q.get('redirect') === '1') {
      res.writeHead(302, { location: r.url, 'cache-control': 'no-store' });
      res.end();
      return undefined;
    }
    return r;
  }
  if (sub === 'auth/callback' && method === 'GET') {
    let out = null;
    let error = null;
    try { out = await svc.finishAuth(q); } catch (e) { if (!(e instanceof DriveError)) log('google-drive: sign-in failed:', e.message); error = e; }
    if (!res) { if (error) throw error; return out; }
    const ok = !error;
    const msg = ok ? `Signed in${out.account?.email ? ` as ${out.account.email}` : ''}. JARVIS can now search and read your Drive (read-only).` : error.message;
    res.writeHead(ok ? 200 : (error.status || 500), { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    res.end(callbackPage(ok, msg));
    return undefined;
  }
  if (sub === 'disconnect' && method === 'POST') return svc.disconnect();
  if (sub === 'search' && method === 'GET') return svc.search({ q: q.get('q'), mode: q.get('mode') || 'any', pageSize: q.get('pageSize'), pageToken: q.get('pageToken') });
  if ((mm = sub.match(/^file\/([^/]+)$/)) && method === 'GET') {
    return svc.read(decodeURIComponent(mm[1]), { maxBytes: q.get('maxBytes') ?? undefined, content: q.get('content') !== '0' });
  }
  throw new DriveError('not_found', `no such Google Drive route: ${method} ${sub}`);
}
