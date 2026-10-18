// Google Drive connector (src/connectors/google-drive.js): the pure helpers (consent URL, PKCE, state check,
// token expiry, query escaping, export mapping, size cap, settings validation) and the HTTP routes against a
// mocked Google (token, revoke and Drive v3 endpoints): connect, status, search, read with export and cap,
// refresh, revoked refresh token, disconnect — and no token or secret in any response or log line.
// No network, no real Google account.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-gdrive-'));
process.env.RIGS_NO_OPENRIG = '1';
process.env.RIGS_NO_AUTOUPDATE = '1';
process.env.RIGS_NO_MIGRATIONS = '1';
const G = await import('../src/connectors/google-drive.js');
const { config, patchConfig, publicConfig } = await import('../src/config.js');

const CLIENT_ID = '1234-abc.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-super-secret-value';
const ACCESS_1 = 'ya29.access-token-one';
const ACCESS_2 = 'ya29.access-token-two';
const REFRESH = '1//refresh-token-secret';
const CODE = '4/0auth-code-from-google';
const SECRETS = [CLIENT_SECRET, ACCESS_1, ACCESS_2, REFRESH, CODE];

// ---------------------------------------------------------------- pure helpers

test('consent URL: drive.readonly, offline access, state and PKCE S256 challenge', () => {
  const url = new URL(G.buildAuthUrl({ clientId: CLIENT_ID, redirectUri: G.defaultRedirectUri(4719), state: 'st-1', codeChallenge: 'ch-1' }));
  assert.equal(url.origin + url.pathname, G.AUTH_URL);
  const p = url.searchParams;
  assert.equal(p.get('scope'), 'https://www.googleapis.com/auth/drive.readonly');
  assert.equal(p.get('client_id'), CLIENT_ID);
  assert.equal(p.get('redirect_uri'), 'http://127.0.0.1:4719/api/local/connectors/google-drive/auth/callback');
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('state'), 'st-1');
  assert.equal(p.get('code_challenge'), 'ch-1');
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.equal(p.get('access_type'), 'offline');
  assert.equal(p.get('prompt'), 'consent');
  assert.throws(() => G.buildAuthUrl({ clientId: '', redirectUri: 'x', state: 's', codeChallenge: 'c' }), /client id/);
  assert.throws(() => G.buildAuthUrl({ clientId: CLIENT_ID, redirectUri: 'x', state: '', codeChallenge: 'c' }), /state/);
});

test('PKCE: RFC 7636 test vector, fresh random verifier and state', () => {
  assert.equal(G.pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const a = G.pkcePair();
  const b = G.pkcePair();
  assert.match(a.verifier, /^[\w-]{43}$/);
  assert.notEqual(a.verifier, b.verifier);
  assert.equal(a.challenge, G.pkceChallenge(a.verifier));
  assert.match(G.newState(), /^[\w-]{43}$/);
});

test('state check: missing, unknown, reused and expired states are refused', () => {
  let t = 1000;
  const store = G.createStateStore({ ttlMs: 500, now: () => t });
  store.put('good', { verifier: 'v' });
  assert.throws(() => G.checkState(store, ''), (e) => e.code === 'bad_state' && /missing state/.test(e.message));
  assert.throws(() => G.checkState(store, undefined), (e) => e.code === 'bad_state');
  assert.throws(() => G.checkState(store, 'forged'), (e) => e.code === 'bad_state' && /does not match/.test(e.message));
  assert.deepEqual(G.checkState(store, 'good'), { verifier: 'v' });
  assert.throws(() => G.checkState(store, 'good'), /does not match/, 'single use');
  store.put('old', { verifier: 'w' });
  t += 501;
  assert.throws(() => G.checkState(store, 'old'), /does not match/, 'expired');
  const small = G.createStateStore({ max: 2, now: () => t });
  small.put('a', 1); small.put('b', 2); small.put('c', 3);
  assert.equal(small.take('a'), null, 'oldest dropped past max');
  assert.equal(small.take('c'), 3);
});

test('token expiry and refresh records', () => {
  const now = 1_000_000;
  const t = G.tokensFromResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3599, scope: G.SCOPE }, now);
  assert.equal(t.expires_at, now + 3599_000);
  assert.equal(G.isExpired(t, now), false);
  assert.equal(G.isExpired(t, t.expires_at - 61_000), false);
  assert.equal(G.isExpired(t, t.expires_at - 59_000), true, 'refreshed a minute early');
  assert.equal(G.isExpired(t, t.expires_at + 1), true);
  assert.equal(G.isExpired(null, now), true);
  assert.equal(G.isExpired({ access_token: 'a' }, now), true, 'no expiry = expired');
  const next = G.tokensFromResponse({ access_token: 'b', expires_in: 10 }, now, t);
  assert.equal(next.refresh_token, 'r', 'a refresh keeps the refresh token');
  assert.equal(next.scope, G.SCOPE);
  assert.throws(() => G.tokensFromResponse({}, now), /no access token/);
  assert.equal(G.hasScope(`openid ${G.SCOPE}`), true);
  assert.equal(G.hasScope('https://www.googleapis.com/auth/drive.file'), false);
});

test('search query: name, full text or either, quotes escaped, trash excluded', () => {
  assert.equal(G.searchQuery('budget', 'name'), "name contains 'budget' and trashed = false");
  assert.equal(G.searchQuery('budget', 'fulltext'), "fullText contains 'budget' and trashed = false");
  assert.equal(G.searchQuery('budget'), "(name contains 'budget' or fullText contains 'budget') and trashed = false");
  assert.equal(G.searchQuery("Sir's \\plan", 'name'), "name contains 'Sir\\'s \\\\plan' and trashed = false");
  assert.throws(() => G.searchQuery('  '), /required/);
  assert.throws(() => G.searchQuery('x', 'regex'), /mode/);
  assert.throws(() => G.searchQuery('x'.repeat(501)), /too long/);
});

test('export mapping: Docs and Slides as text, Sheets as CSV, text files downloaded, binaries not read', () => {
  assert.deepEqual(G.readPlan('application/vnd.google-apps.document'), { how: 'export', mimeType: 'text/plain' });
  assert.deepEqual(G.readPlan('application/vnd.google-apps.spreadsheet'), { how: 'export', mimeType: 'text/csv' });
  assert.deepEqual(G.readPlan('application/vnd.google-apps.presentation'), { how: 'export', mimeType: 'text/plain' });
  assert.equal(G.readPlan('application/vnd.google-apps.folder').how, 'none');
  assert.equal(G.readPlan('application/vnd.google-apps.form').how, 'none');
  for (const m of ['text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/xml', 'image/svg+xml', 'application/ld+json']) assert.equal(G.readPlan(m).how, 'download', m);
  for (const m of ['application/pdf', 'image/png', 'application/zip', 'application/octet-stream', '']) assert.equal(G.readPlan(m).how, 'none', m);
});

test('size cap: clamped to 10 MiB, text cut without splitting a character', () => {
  assert.equal(G.clampMaxBytes(undefined), G.DEFAULT_MAX_BYTES);
  assert.equal(G.clampMaxBytes(undefined, 2048), 2048);
  assert.equal(G.clampMaxBytes('100', 2048), 100);
  assert.equal(G.clampMaxBytes(50 * 1024 * 1024), G.MAX_MAX_BYTES);
  assert.throws(() => G.clampMaxBytes('0'), /positive/);
  assert.throws(() => G.clampMaxBytes('abc'), /positive/);
  const buf = Buffer.from('héllo wörld', 'utf8'); // é and ö are 2 bytes each
  assert.deepEqual(G.decodeCapped(buf, 100), { text: 'héllo wörld', truncated: false, bytes: 13 });
  const cut = G.decodeCapped(buf, 2); // 'h' + first byte of 'é'
  assert.equal(cut.text, 'h');
  assert.equal(cut.truncated, true);
  assert.equal(G.decodeCapped(buf, 3).text, 'hé');
  assert.equal(G.decodeCapped(Buffer.from('﻿abc'), 100).text, 'abc', 'BOM dropped');
});

test('redaction, public file shape and settings validation', () => {
  assert.equal(G.redact(`bad ${ACCESS_1} and ${CLIENT_SECRET}`, [ACCESS_1, CLIENT_SECRET, '', null, 'abc']), 'bad [redacted] and [redacted]');
  const f = G.publicFile({ id: 'x', name: 'n', mimeType: 'application/pdf', size: '42', owners: [{ displayName: 'Sir', emailAddress: 's@x' }], secretField: 'no' });
  assert.equal(f.size, 42);
  assert.equal(f.readable, false);
  assert.deepEqual(f.owners, [{ name: 'Sir', email: 's@x' }]);
  assert.equal('secretField' in f, false);
  const ok = G.validateSettings({ clientId: ` ${CLIENT_ID} `, clientSecret: CLIENT_SECRET, maxBytes: 2048 }, {});
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.clientId, CLIENT_ID);
  assert.equal(ok.value.clientSecret, CLIENT_SECRET);
  assert.equal(G.validateSettings({ clientSecret: '' }, ok.value).value.clientSecret, CLIENT_SECRET, 'an empty secret field keeps the stored one');
  assert.equal(G.validateSettings({ clearSecret: true }, ok.value).value.clientSecret, '');
  assert.equal(G.validateSettings({ clientId: 'has space' }).errors.length, 1);
  assert.equal(G.validateSettings({ redirectUri: 'ftp://x' }).errors.length, 1);
  assert.equal(G.validateSettings({ redirectUri: 'http://127.0.0.1:9/cb#x' }).errors.length, 1);
  assert.equal(G.validateSettings({ maxBytes: 0 }).errors.length, 1);
});

test('settings live in config.connectors, never in publicConfig and never patched by the generic settings API', () => {
  const saved = G.saveSettings({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  assert.equal(saved.clientId, CLIENT_ID);
  assert.equal(config().connectors.googleDrive.clientSecret, CLIENT_SECRET);
  assert.equal(G.loadSettings().clientSecret, CLIENT_SECRET);
  assert.ok(!JSON.stringify(publicConfig()).includes(CLIENT_SECRET));
  patchConfig({ connectors: { googleDrive: { clientSecret: 'overwritten' } } });
  assert.equal(config().connectors.googleDrive.clientSecret, CLIENT_SECRET);
  assert.throws(() => G.saveSettings({ clientId: 'bad id' }), /clientId/);
});

// ---------------------------------------------------------------- a mocked Google

const DOC_TEXT = '﻿Meeting notes: ship the Drive connector.';
const SHEET_CSV = 'name,amount\nrent,1200\nfood,300\n';
const BIG_TEXT = 'x'.repeat(5000);
const FILES = {
  doc1: { id: 'doc1', name: 'Notes', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-01T00:00:00Z', webViewLink: 'https://docs.google.com/document/d/doc1' },
  sheet1: { id: 'sheet1', name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet' },
  big1: { id: 'big1', name: 'big.txt', mimeType: 'text/plain', size: String(BIG_TEXT.length) },
  pdf1: { id: 'pdf1', name: 'scan.pdf', mimeType: 'application/pdf', size: '99999' },
};

/** fetch look-alike for Google's token, revoke and Drive v3 endpoints. */
function mockGoogle() {
  const st = { calls: [], tokenForms: [], revoked: [], access: new Set([ACCESS_1]), nextAccess: ACCESS_2, refreshMode: 'ok', grantScope: G.SCOPE, challenge: null };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const driveErr = (status, reason, message) => json(status, { error: { code: status, message, errors: [{ reason, message }] } });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const auth = init.headers?.authorization || '';
    st.calls.push({ url: u, method: init.method || 'GET', auth });
    if (url === G.TOKEN_URL) {
      const f = Object.fromEntries(new URLSearchParams(String(init.body)));
      st.tokenForms.push(f);
      if (f.client_id !== CLIENT_ID || f.client_secret !== CLIENT_SECRET) return json(401, { error: 'invalid_client', error_description: 'The OAuth client was not found.' });
      if (f.grant_type === 'authorization_code') {
        if (f.code !== CODE) return json(400, { error: 'invalid_grant', error_description: 'Malformed auth code.' });
        if (G.pkceChallenge(f.code_verifier) !== st.challenge) return json(400, { error: 'invalid_grant', error_description: 'Invalid code verifier.' });
        return json(200, { access_token: ACCESS_1, refresh_token: REFRESH, expires_in: 3599, scope: st.grantScope, token_type: 'Bearer' });
      }
      if (f.grant_type === 'refresh_token') {
        if (st.refreshMode === 'revoked' || f.refresh_token !== REFRESH) return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        st.access.add(st.nextAccess);
        return json(200, { access_token: st.nextAccess, expires_in: 3599, scope: G.SCOPE, token_type: 'Bearer' });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (url === G.REVOKE_URL) { st.revoked.push(new URLSearchParams(String(init.body)).get('token')); return new Response('', { status: 200 }); }
    if (!url.startsWith(G.DRIVE_API)) return json(404, {});
    if (!st.access.has(auth.replace(/^Bearer /, ''))) return driveErr(401, 'authError', 'Invalid Credentials');
    const p = u.pathname.slice(new URL(G.DRIVE_API).pathname.length);
    if (p === '/about') return json(200, { user: { displayName: 'Sir', emailAddress: 'sir@example.com' } });
    if (p === '/files') {
      const q = u.searchParams.get('q');
      const hits = Object.values(FILES).filter((f) => q.includes(`'${f.name.toLowerCase()}'`) || q.includes(`'${f.name}'`));
      return json(200, { files: hits, ...(hits.length ? { nextPageToken: 'next-1' } : {}) });
    }
    let mm = p.match(/^\/files\/([\w-]+)\/export$/);
    if (mm) {
      const want = u.searchParams.get('mimeType');
      if (mm[1] === 'doc1' && want === 'text/plain') return new Response(DOC_TEXT, { status: 200, headers: { 'content-type': 'text/plain' } });
      if (mm[1] === 'sheet1' && want === 'text/csv') return new Response(SHEET_CSV, { status: 200, headers: { 'content-type': 'text/csv' } });
      return driveErr(403, 'fileNotExportable', 'Export only supports Docs Editors files.');
    }
    mm = p.match(/^\/files\/([\w-]+)$/);
    if (mm) {
      const f = FILES[mm[1]];
      if (!f) return driveErr(404, 'notFound', `File not found: ${mm[1]}.`);
      if (u.searchParams.get('alt') === 'media') return new Response(BIG_TEXT, { status: 200 });
      return json(200, f);
    }
    return json(404, {});
  };
  return { st, fetchImpl };
}

async function routeServer(svc) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = async () => { const c = []; for await (const x of req) c.push(x); const t = String(Buffer.concat(c)); return t ? JSON.parse(t) : {}; };
    try {
      const out = await G.googleDriveRoute(svc, { method: req.method, sub: url.pathname.slice(1), q: url.searchParams, req, res, body });
      if (out !== undefined) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); }
    } catch (e) { if (!res.headersSent) { res.writeHead(e.status || 500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); } }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const seen = [];
  const call = async (p, opts = {}) => {
    const r = await fetch(base + p, { redirect: 'manual', ...opts });
    const text = await r.text();
    seen.push(text, r.headers.get('location') || '');
    const type = r.headers.get('content-type') || '';
    return { status: r.status, type, location: r.headers.get('location'), text, body: type.includes('json') ? JSON.parse(text) : text };
  };
  const post = (p, json) => call(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json ?? {}) });
  return { call, post, seen, close: () => new Promise((r) => server.close(r)) };
}

test('routes: connect with state + PKCE, 0600 tokens, status, search, read with export and cap, refresh, disconnect', async (t) => {
  const mock = mockGoogle();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-gdrive-tokens-'));
  const tokenFile = path.join(dir, 'connectors', 'google-drive.json');
  let stored = { clientId: '', clientSecret: '', redirectUri: '', maxBytes: 1024 };
  let clock = 1_800_000_000_000;
  const svc = G.createGoogleDrive({
    getSettings: () => stored,
    setSettings: (input) => { const r = G.validateSettings(input, stored); if (r.errors.length) throw new G.DriveError('bad_request', r.errors.join('; ')); stored = r.value; },
    tokenFile, fetchImpl: mock.fetchImpl, now: () => clock, port: () => 4719,
  });
  const logs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => { logs.push(a.join(' ')); };
  console.error = (...a) => { logs.push(a.join(' ')); };
  const srv = await routeServer(svc);
  try {
    // not set up yet
    let r = await srv.call('status');
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.configured, r.body.connected], [false, false]);
    assert.equal((await srv.call('auth/start')).status, 409, 'start refused without a client id + secret');
    assert.equal((await srv.post('config', { clientId: 'bad id' })).status, 400);
    r = await srv.post('config', { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { clientId: CLIENT_ID, clientSecretSet: true, redirectUri: 'http://127.0.0.1:4719/api/local/connectors/google-drive/auth/callback', maxBytes: 1024, configured: true });
    assert.equal((await srv.call('config')).body.clientSecretSet, true);

    // auth/start: Google consent URL with the scope, a state and a PKCE challenge
    r = await srv.call('auth/start');
    assert.equal(r.status, 200);
    const consent = new URL(r.body.url);
    assert.equal(consent.origin, 'https://accounts.google.com');
    assert.equal(consent.searchParams.get('scope'), G.SCOPE);
    assert.equal(consent.searchParams.get('code_challenge_method'), 'S256');
    const state = consent.searchParams.get('state');
    assert.match(state, /^[\w-]{43}$/);
    assert.match(consent.searchParams.get('code_challenge'), /^[\w-]{43}$/);
    mock.st.challenge = consent.searchParams.get('code_challenge');
    const redirected = await srv.call('auth/start?redirect=1');
    assert.equal(redirected.status, 302);
    assert.match(redirected.location, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);

    // callback: missing and mismatched state refused, nothing stored, no token exchange
    r = await srv.call(`auth/callback?code=${encodeURIComponent(CODE)}`);
    assert.equal(r.status, 400);
    assert.match(r.type, /text\/html/);
    assert.match(r.text, /missing state/);
    r = await srv.call(`auth/callback?state=forged-state&code=${encodeURIComponent(CODE)}`);
    assert.equal(r.status, 400);
    assert.match(r.text, /does not match/);
    assert.equal(mock.st.tokenForms.length, 0, 'no code exchange on a bad state');
    assert.equal(fs.existsSync(tokenFile), false);

    // callback: valid state → code + verifier exchanged, tokens stored owner-only
    r = await srv.call(`auth/callback?state=${state}&code=${encodeURIComponent(CODE)}&scope=${encodeURIComponent(G.SCOPE)}`);
    assert.equal(r.status, 200, r.text);
    assert.match(r.text, /Google Drive connected/);
    assert.match(r.text, /sir@example\.com/);
    const exchange = mock.st.tokenForms[0];
    assert.equal(exchange.grant_type, 'authorization_code');
    assert.equal(exchange.redirect_uri, 'http://127.0.0.1:4719/api/local/connectors/google-drive/auth/callback');
    assert.equal(G.pkceChallenge(exchange.code_verifier), mock.st.challenge, 'the verifier matches the challenge sent to Google');
    const mode = fs.statSync(tokenFile).mode & 0o777;
    t.diagnostic(`google-drive token file mode: ${mode.toString(8)} (${tokenFile})`);
    if (process.platform !== 'win32') {
      assert.equal(mode, 0o600, 'token file is 0600');
      assert.equal(fs.statSync(path.dirname(tokenFile)).mode & 0o777, 0o700, 'connectors folder is 0700');
    }
    const onDisk = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    assert.equal(onDisk.refresh_token, REFRESH);
    assert.equal(onDisk.access_token, ACCESS_1);
    r = await srv.call(`auth/callback?state=${state}&code=${encodeURIComponent(CODE)}`);
    assert.equal(r.status, 400, 'a state is single use');

    // status: connected, account label, no token
    r = await srv.call('status');
    assert.equal(r.body.connected, true);
    assert.deepEqual(r.body.account, { name: 'Sir', email: 'sir@example.com' });
    assert.equal(r.body.canRefresh, true);

    // search
    r = await srv.call('search?q=Notes&mode=name');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.files.map((f) => f.id), ['doc1']);
    assert.equal(r.body.files[0].readable, true);
    assert.equal(r.body.nextPageToken, 'next-1');
    const listCall = mock.st.calls.findLast((c) => c.url.pathname.endsWith('/files'));
    assert.equal(listCall.url.searchParams.get('q'), "name contains 'Notes' and trashed = false");
    assert.equal(listCall.auth, `Bearer ${ACCESS_1}`);
    assert.equal((await srv.call('search?q=')).status, 400);
    r = await srv.call('search?q=Budget');
    assert.equal(mock.st.calls.findLast((c) => c.url.pathname.endsWith('/files')).url.searchParams.get('q'), "(name contains 'Budget' or fullText contains 'Budget') and trashed = false");

    // read: Doc exported as text/plain, Sheet as text/csv
    r = await srv.call('file/doc1');
    assert.equal(r.status, 200);
    assert.equal(r.body.content, 'Meeting notes: ship the Drive connector.');
    assert.equal(r.body.contentType, 'text/plain');
    assert.equal(r.body.exported, true);
    assert.equal(r.body.truncated, false);
    assert.equal(r.body.file.name, 'Notes');
    r = await srv.call('file/sheet1');
    assert.equal(r.body.content, SHEET_CSV);
    assert.equal(r.body.contentType, 'text/csv');
    assert.equal(mock.st.calls.findLast((c) => c.url.pathname.endsWith('/export')).url.searchParams.get('mimeType'), 'text/csv');

    // size cap: configured 1024, per request lower, never above 10 MiB
    r = await srv.call('file/big1');
    assert.equal(r.body.content.length, 1024);
    assert.equal(r.body.truncated, true);
    assert.equal(r.body.maxBytes, 1024);
    r = await srv.call('file/big1?maxBytes=10');
    assert.equal(r.body.content, 'x'.repeat(10));
    assert.equal(r.body.truncated, true);
    r = await srv.call('file/big1?maxBytes=999999');
    assert.equal(r.body.content.length, 5000);
    assert.equal(r.body.truncated, false);
    assert.equal((await srv.call('file/big1?maxBytes=0')).status, 400);

    // binary: metadata, no content; metadata only on request; unknown and invalid ids
    r = await srv.call('file/pdf1');
    assert.equal(r.body.content, null);
    assert.match(r.body.reason, /binary/);
    assert.ok(!mock.st.calls.some((c) => c.url.pathname.endsWith('/pdf1') && c.url.searchParams.get('alt') === 'media'));
    r = await srv.call('file/doc1?content=0');
    assert.deepEqual(Object.keys(r.body), ['file']);
    assert.equal((await srv.call('file/nope')).status, 404);
    assert.equal((await srv.call('file/bad%20id')).status, 400);

    // expiry: refreshed before the call, the refresh token kept and still 0600
    clock += 3600_000;
    r = await srv.call('search?q=Notes&mode=name');
    assert.equal(r.status, 200);
    const refresh = mock.st.tokenForms.at(-1);
    assert.equal(refresh.grant_type, 'refresh_token');
    assert.equal(refresh.refresh_token, REFRESH);
    assert.equal(mock.st.calls.findLast((c) => c.url.pathname.endsWith('/files')).auth, `Bearer ${ACCESS_2}`);
    const after = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    assert.equal(after.access_token, ACCESS_2);
    assert.equal(after.refresh_token, REFRESH);
    if (process.platform !== 'win32') assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);

    // a 401 from Drive forces one refresh and a retry
    mock.st.access.delete(ACCESS_2);
    mock.st.nextAccess = 'ya29.access-token-three';
    SECRETS.push('ya29.access-token-three');
    r = await srv.call('file/doc1?content=0');
    assert.equal(r.status, 200);
    assert.equal(mock.st.calls.findLast((c) => c.url.pathname.endsWith('/doc1')).auth, 'Bearer ya29.access-token-three');

    // disconnect: revoked at Google, file deleted, status not connected
    r = await srv.post('disconnect');
    assert.equal(r.status, 200);
    assert.equal(r.body.removed, true);
    assert.equal(r.body.revoked, true);
    assert.equal(r.body.connected, false);
    assert.deepEqual(mock.st.revoked, [REFRESH]);
    assert.equal(fs.existsSync(tokenFile), false);
    assert.equal((await srv.call('status')).body.connected, false);
    r = await srv.call('search?q=Notes');
    assert.equal(r.status, 409);
    assert.match(r.body.error, /not connected/);
    assert.equal((await srv.call('nope')).status, 404);

    // nothing secret in any response or log line
    const everything = srv.seen.join('\n') + '\n' + logs.join('\n');
    for (const s of SECRETS) assert.ok(!everything.includes(s), `leaked ${s.slice(0, 8)}…`);
    assert.ok(logs.some((l) => /google-drive: connected as sir@example\.com/.test(l)));
  } finally {
    console.log = origLog;
    console.error = origErr;
    await srv.close();
  }
});

test('routes: a revoked refresh token disconnects; a refused scope or Google error stores nothing and leaks nothing', async () => {
  const mock = mockGoogle();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-gdrive-tokens-'));
  const tokenFile = path.join(dir, 'google-drive.json');
  let clock = 1_800_000_000_000;
  let stored = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: '', maxBytes: 1024 };
  const svc = G.createGoogleDrive({ getSettings: () => stored, setSettings: () => {}, tokenFile, fetchImpl: mock.fetchImpl, now: () => clock, port: () => 4719 });
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  const srv = await routeServer(svc);
  const connect = async () => {
    const u = new URL((await srv.call('auth/start')).body.url);
    mock.st.challenge = u.searchParams.get('code_challenge');
    return srv.call(`auth/callback?state=${u.searchParams.get('state')}&code=${encodeURIComponent(CODE)}`);
  };
  try {
    // Sir unticks Drive on the consent screen: nothing stored, the grant is revoked again
    mock.st.grantScope = 'openid';
    let r = await connect();
    assert.equal(r.status, 400);
    assert.match(r.text, /Drive access was not granted/);
    assert.equal(fs.existsSync(tokenFile), false);
    assert.deepEqual(mock.st.revoked, [REFRESH]);

    // Google refuses the code (wrong secret): clear message, no secret in it
    mock.st.grantScope = G.SCOPE;
    stored = { ...stored, clientSecret: 'GOCSPX-wrong-secret-x' };
    r = await connect();
    assert.equal(r.status, 502);
    assert.match(r.text, /invalid_client/);
    assert.ok(!r.text.includes('GOCSPX-wrong-secret-x'));
    stored = { ...stored, clientSecret: CLIENT_SECRET };

    // user pressed Cancel on Google's screen
    const u = new URL((await srv.call('auth/start')).body.url);
    r = await srv.call(`auth/callback?state=${u.searchParams.get('state')}&error=access_denied`);
    assert.equal(r.status, 400);
    assert.match(r.text, /access_denied/);

    // connected, then the grant is revoked in Sir's Google account
    assert.equal((await connect()).status, 200);
    mock.st.refreshMode = 'revoked';
    clock += 3600_000;
    r = await srv.call('search?q=Notes');
    assert.equal(r.status, 409);
    assert.match(r.body.error, /revoked or expired/);
    assert.equal(fs.existsSync(tokenFile), false, 'useless tokens removed');
    assert.equal((await srv.call('status')).body.connected, false);

    const everything = srv.seen.join('\n') + '\n' + logs.join('\n');
    for (const s of SECRETS) assert.ok(!everything.includes(s), `leaked ${s.slice(0, 8)}…`);
  } finally {
    console.log = origLog;
    await srv.close();
  }
});
