// Slack connector (src/connectors/slack.js): the token gate, the confirm gate on writes, Slack ok:false errors,
// 429 + Retry-After handling, channel name lookup, and the /api/local/connectors/slack/* routes (in process and
// through a real `rigs serve`). fetch is always mocked; nothing reaches slack.com.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-slack-'));
process.env.RIGS_NO_OPENRIG = '1';
process.env.RIGS_NO_AUTOUPDATE = '1';
process.env.RIGS_NO_MIGRATIONS = '1';
const S = await import('../src/connectors/slack.js');
const { publicConfig } = await import('../src/config.js');

const TOKEN = 'xoxb-1111-2222-SECRETsecretSECRET';
const USER_TOKEN = 'xoxp-3333-4444-USERsecretUSER';

/** A fetch look-alike: `routes` maps a Web API method to a handler (params, call) → { status, body, headers }. */
function mockFetch(routes = {}) {
  const calls = [];
  const fn = async (url, init) => {
    const method = String(url).replace(S.SLACK_API, '');
    const params = Object.fromEntries(new URLSearchParams(init.body));
    const call = { url: String(url), method, params, auth: init.headers.authorization, init };
    calls.push(call);
    const h = routes[method];
    const r = h ? await h(params, call, calls) : { body: { ok: false, error: 'unknown_method' } };
    const headers = new Headers(r.headers || {});
    return new Response(r.raw ?? JSON.stringify(r.body ?? {}), { status: r.status || 200, headers });
  };
  fn.calls = calls;
  return fn;
}

const cfgWith = (slack) => () => ({ connectors: { slack } });
const client = (opts = {}) => {
  const sleeps = [];
  const c = S.createSlack({ getConfig: cfgWith({ token: TOKEN }), env: {}, sleep: async (ms) => { sleeps.push(ms); }, ...opts });
  c.sleeps = sleeps;
  return c;
};
const rejectsCode = (p, code, status) => assert.rejects(p, (e) => { assert.equal(e.name, 'SlackError'); assert.equal(e.code, code); if (status) assert.equal(e.status, status); return true; });
const noToken = (v) => { const s = JSON.stringify(v); assert.ok(!s.includes(TOKEN) && !s.includes(USER_TOKEN) && !s.includes('SECRET'), `token leaked: ${s}`); };

// ---------------------------------------------------------------- token

test('resolveToken: config wins over env, env is the fallback, blanks count as unset', () => {
  assert.deepEqual(S.resolveToken({ connectors: { slack: { token: ' a ' } } }, { SLACK_BOT_TOKEN: 'b' }), { token: 'a', source: 'config' });
  assert.deepEqual(S.resolveToken({ connectors: { slack: { token: '  ' } } }, { SLACK_BOT_TOKEN: 'b' }), { token: 'b', source: 'env' });
  assert.deepEqual(S.resolveToken({}, {}), { token: '', source: null });
  assert.deepEqual(S.resolveToken({}, { SLACK_USER_TOKEN: 'u' }, 'user'), { token: 'u', source: 'env' });
});

test('token gate: with no token every call is refused before fetch, and status says not configured', async () => {
  const fetch = mockFetch();
  const c = S.createSlack({ fetch, getConfig: () => ({}), env: {} });
  await rejectsCode(c.listChannels(), 'not_configured', 503);
  await rejectsCode(c.readHistory({ channel: 'C0123456789' }), 'not_configured', 503);
  await rejectsCode(c.searchMessages({ query: 'x' }), 'not_configured', 503);
  await rejectsCode(c.postMessage({ channel: 'C0123456789', text: 'hi', confirm: true }), 'not_configured', 503);
  assert.deepEqual(await c.status(), { configured: false, source: null, token: null, searchToken: null, checkedAt: null });
  assert.equal(fetch.calls.length, 0);
});

test('token from SLACK_BOT_TOKEN is sent as a Bearer header and never returned: status shows len=N only', async () => {
  const fetch = mockFetch({ 'auth.test': () => ({ body: { ok: true, team: 'Acme', team_id: 'T1', user: 'jarvis', bot_id: 'B1', url: 'https://acme.slack.com/' } }) });
  const c = S.createSlack({ fetch, getConfig: () => ({}), env: { SLACK_BOT_TOKEN: TOKEN } });
  const s = await c.status();
  assert.equal(fetch.calls[0].auth, `Bearer ${TOKEN}`);
  assert.equal(fetch.calls[0].init.method, 'POST');
  assert.equal(s.configured, true);
  assert.equal(s.source, 'env');
  assert.equal(s.token, `len=${TOKEN.length}`);
  assert.equal(s.ok, true);
  assert.equal(s.team, 'Acme');
  assert.equal(s.searchToken, 'bot');
  noToken(s);
  // check=0 skips auth.test
  const quick = await c.status({ check: false });
  assert.equal(fetch.calls.length, 1);
  assert.equal(quick.checkedAt, null);
});

test('status with a revoked token reports ok:false and the Slack code, without the token', async () => {
  const fetch = mockFetch({ 'auth.test': () => ({ body: { ok: false, error: 'invalid_auth' } }) });
  const s = await client({ fetch }).status();
  assert.equal(s.configured, true);
  assert.equal(s.ok, false);
  assert.equal(s.error, 'invalid_auth');
  noToken(s);
});

test('errors never carry the token, even for a network failure', async () => {
  const fetch = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
  const err = await client({ fetch }).listChannels().catch((e) => e);
  assert.equal(err.code, 'network');
  assert.match(err.message, /ENOTFOUND/);
  noToken({ message: err.message, stack: err.stack, ...err });
});

test('publicConfig (sent to peers and the UI) leaves the connector token out', () => {
  noToken(publicConfig());
  assert.equal(publicConfig().connectors, undefined);
});

// ---------------------------------------------------------------- confirm gate

test('confirm gate: postMessage refuses without confirm: true and sends nothing', async () => {
  const fetch = mockFetch({ 'chat.postMessage': () => ({ body: { ok: true, channel: 'C1', ts: '1.2' } }) });
  const c = client({ fetch });
  await rejectsCode(c.postMessage({ channel: 'C0123456789', text: 'hi' }), 'confirm_required', 400);
  for (const confirm of [false, 'true', 1, 'yes', {}]) await rejectsCode(c.postMessage({ channel: 'C0123456789', text: 'hi', confirm }), 'confirm_required', 400);
  assert.equal(fetch.calls.length, 0);
});

test('confirm gate: any non-read Web API method is a write and needs confirm', async () => {
  const fetch = mockFetch({ 'chat.delete': () => ({ body: { ok: true } }) });
  const c = client({ fetch });
  await rejectsCode(c.api('chat.delete', { channel: 'C1', ts: '1' }), 'confirm_required', 400);
  await rejectsCode(c.api('conversations.invite', { channel: 'C1', users: 'U1' }), 'confirm_required', 400);
  assert.equal(fetch.calls.length, 0);
  await c.api('chat.delete', { channel: 'C1', ts: '1' }, { confirm: true });
  assert.equal(fetch.calls.length, 1);
});

test('postMessage with confirm: true posts channel, text and thread_ts', async () => {
  const fetch = mockFetch({ 'chat.postMessage': (p) => ({ body: { ok: true, channel: p.channel, ts: '1700000000.000200' } }) });
  const r = await client({ fetch }).postMessage({ channel: 'C0123456789', text: 'Deploy done', thread_ts: '1700000000.000100', confirm: true });
  assert.deepEqual(fetch.calls[0].params, { channel: 'C0123456789', text: 'Deploy done', thread_ts: '1700000000.000100' });
  assert.deepEqual(r, { ok: true, channel: 'C0123456789', ts: '1700000000.000200', thread_ts: '1700000000.000100' });
  await rejectsCode(client({ fetch }).postMessage({ channel: 'C1', text: '   ', confirm: true }), 'bad_request', 400);
  await rejectsCode(client({ fetch }).postMessage({ text: 'x', confirm: true }), 'bad_request', 400);
  await rejectsCode(client({ fetch }).postMessage({ channel: 'C1', text: 'x'.repeat(40001), confirm: true }), 'bad_request', 400);
  assert.equal(fetch.calls.length, 1);
});

// ---------------------------------------------------------------- Slack errors

test('Slack ok:false becomes a SlackError with the Slack code', async () => {
  const fetch = mockFetch({
    'conversations.history': () => ({ body: { ok: false, error: 'channel_not_found' } }),
    'conversations.list': () => ({ body: { ok: false, error: 'missing_scope', needed: 'channels:read' } }),
    'chat.postMessage': () => ({ body: { ok: false, error: 'not_in_channel' } }),
  });
  const c = client({ fetch });
  await rejectsCode(c.readHistory({ channel: 'C0123456789' }), 'channel_not_found', 404);
  const e = await c.listChannels().catch((x) => x);
  assert.equal(e.code, 'missing_scope');
  assert.match(e.message, /channels:read/);
  await rejectsCode(c.postMessage({ channel: 'C0123456789', text: 'x', confirm: true }), 'not_in_channel', 502);
});

test('search with only a bot token explains that a user token is needed; a user token is preferred for search', async () => {
  const fetch = mockFetch({ 'search.messages': (p, call) => (call.auth === `Bearer ${USER_TOKEN}` ? { body: { ok: true, messages: { total: 1, matches: [{ ts: '1.1', user: 'U1', text: 'release at 5', channel: { id: 'C1', name: 'general' }, permalink: 'https://x/p1' }] } } } : { body: { ok: false, error: 'not_allowed_token_type' } }) });
  const e = await client({ fetch }).searchMessages({ query: 'release' }).catch((x) => x);
  assert.equal(e.code, 'not_allowed_token_type');
  assert.match(e.message, /user token/);
  const withUser = client({ fetch, getConfig: cfgWith({ token: TOKEN, userToken: USER_TOKEN }) });
  const r = await withUser.searchMessages({ query: 'release', count: 500 });
  assert.equal(fetch.calls.at(-1).params.count, '100');
  assert.deepEqual(r, { query: 'release', total: 1, matches: [{ ts: '1.1', user: 'U1', bot: null, username: null, text: 'release at 5', channel: { id: 'C1', name: 'general' }, permalink: 'https://x/p1' }] });
  assert.equal((await withUser.status({ check: false })).searchToken, 'user');
  await rejectsCode(withUser.searchMessages({ query: '  ' }), 'bad_request', 400);
});

test('HTTP errors and non-JSON answers are reported, not parsed', async () => {
  await rejectsCode(client({ fetch: mockFetch({ 'conversations.list': () => ({ status: 500, raw: 'oops' }) }) }).listChannels(), 'http_500', 502);
  await rejectsCode(client({ fetch: mockFetch({ 'conversations.list': () => ({ raw: '<html>' }) }) }).listChannels(), 'bad_response', 502);
});

// ---------------------------------------------------------------- rate limits

test('429 with Retry-After waits that long and retries', async () => {
  let n = 0;
  const fetch = mockFetch({ 'conversations.list': () => (++n < 3 ? { status: 429, headers: { 'retry-after': '2' } } : { body: { ok: true, channels: [{ id: 'C1', name: 'general', num_members: 4 }] } }) });
  const c = client({ fetch });
  const r = await c.listChannels();
  assert.equal(fetch.calls.length, 3);
  assert.deepEqual(c.sleeps, [2000, 2000]);
  assert.equal(r.channels[0].name, 'general');
});

test('429 past the retry budget fails with rate_limited and retryAfter', async () => {
  const fetch = mockFetch({ 'conversations.list': () => ({ status: 429, headers: { 'retry-after': '1' } }) });
  const c = client({ fetch, maxRetries: 2 });
  const e = await c.listChannels().catch((x) => x);
  assert.equal(e.code, 'rate_limited');
  assert.equal(e.status, 429);
  assert.equal(e.retryAfter, 1);
  assert.equal(fetch.calls.length, 3);
  assert.deepEqual(c.sleeps, [1000, 1000]);
});

test('429 with a Retry-After longer than maxWaitMs fails at once instead of hanging the request', async () => {
  const fetch = mockFetch({ 'chat.postMessage': () => ({ status: 429, headers: { 'retry-after': '120' } }) });
  const c = client({ fetch, maxWaitMs: 20000 });
  const e = await c.postMessage({ channel: 'C0123456789', text: 'x', confirm: true }).catch((x) => x);
  assert.equal(e.code, 'rate_limited');
  assert.equal(e.retryAfter, 120);
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(c.sleeps, []);
});

// ---------------------------------------------------------------- reads

test('readHistory: channel by #name, limit clamped, oldest as an ISO date, messages trimmed to the useful fields', async () => {
  const fetch = mockFetch({
    'conversations.list': (p) => (p.cursor ? { body: { ok: true, channels: [{ id: 'C0GENERAL01', name: 'general' }] } } : { body: { ok: true, channels: [{ id: 'C0RANDOM001', name: 'random' }], response_metadata: { next_cursor: 'p2' } } }),
    'conversations.history': () => ({ body: { ok: true, has_more: true, messages: [{ ts: '1760000000.0001', user: 'U1', text: 'hello', thread_ts: '1760000000.0001', reply_count: 2, blocks: [{}], team: 'T1' }], response_metadata: { next_cursor: 'h2' } } }),
  });
  const r = await client({ fetch }).readHistory({ channel: '#General', limit: 5000, oldest: '2026-10-18T00:00:00Z' });
  const h = fetch.calls.find((x) => x.method === 'conversations.history').params;
  assert.equal(h.channel, 'C0GENERAL01');
  assert.equal(h.limit, '1000');
  assert.equal(h.oldest, (Date.parse('2026-10-18T00:00:00Z') / 1000).toFixed(6));
  assert.deepEqual(r, { channel: 'C0GENERAL01', has_more: true, next_cursor: 'h2', messages: [{ ts: '1760000000.0001', user: 'U1', bot: null, username: null, text: 'hello', thread_ts: '1760000000.0001', replies: 2 }] });
  await rejectsCode(client({ fetch }).readHistory({ channel: '#nope' }), 'channel_not_found', 404);
  await rejectsCode(client({ fetch }).readHistory({}), 'bad_request', 400);
  await rejectsCode(client({ fetch }).readHistory({ channel: 'C0GENERAL01', oldest: 'yesterday-ish' }), 'bad_request', 400);
});

test('listChannels passes paging and filters through', async () => {
  const fetch = mockFetch({ 'conversations.list': () => ({ body: { ok: true, channels: [{ id: 'G1', name: 'ops', is_private: true, is_member: true, topic: { value: 'pager' } }], response_metadata: { next_cursor: '' } } }) });
  const r = await client({ fetch }).listChannels({ limit: 0, cursor: 'abc' });
  assert.deepEqual(fetch.calls[0].params, { limit: '1', cursor: 'abc', types: 'public_channel,private_channel', exclude_archived: 'true' });
  assert.deepEqual(r, { channels: [{ id: 'G1', name: 'ops', private: true, member: true, archived: false, members: null, topic: 'pager', purpose: '' }], next_cursor: null });
});

// ---------------------------------------------------------------- routes

const q = (s = '') => new URLSearchParams(s);
const route = (slack, method, sub, query = '', b = {}) => S.slackRoute(slack, { method, sub, q: q(query), body: async () => b });

test('slackRoute maps the documented routes and keeps the confirm gate (only a JSON true counts)', async () => {
  const fetch = mockFetch({
    'auth.test': () => ({ body: { ok: true, team: 'Acme' } }),
    'conversations.list': () => ({ body: { ok: true, channels: [] } }),
    'conversations.history': () => ({ body: { ok: true, messages: [] } }),
    'search.messages': () => ({ body: { ok: true, messages: { total: 0, matches: [] } } }),
    'chat.postMessage': () => ({ body: { ok: true, channel: 'C0123456789', ts: '9.9' } }),
  });
  const c = client({ fetch });
  assert.equal((await route(c, 'GET', 'status')).team, 'Acme');
  assert.equal((await route(c, 'GET', 'status', 'check=0')).checkedAt, null);
  assert.deepEqual(await route(c, 'GET', 'channels', 'limit=10'), { channels: [], next_cursor: null });
  assert.equal((await route(c, 'GET', 'history', 'channel=C0123456789&limit=3&oldest=1700000000')).channel, 'C0123456789');
  assert.equal(fetch.calls.at(-1).params.oldest, '1700000000');
  assert.equal((await route(c, 'GET', 'search', 'q=deploy')).query, 'deploy');
  const before = fetch.calls.length;
  await rejectsCode(route(c, 'POST', 'post', '', { channel: 'C0123456789', text: 'hi' }), 'confirm_required', 400);
  await rejectsCode(route(c, 'POST', 'post', '', { channel: 'C0123456789', text: 'hi', confirm: 'true' }), 'confirm_required', 400);
  await rejectsCode(route(c, 'POST', 'post', 'confirm=true', { channel: 'C0123456789', text: 'hi' }), 'confirm_required', 400);
  assert.equal(fetch.calls.length, before);
  assert.deepEqual(await route(c, 'POST', 'post', '', { channel: 'C0123456789', text: 'hi', confirm: true }), { ok: true, channel: 'C0123456789', ts: '9.9' });
  await rejectsCode(route(c, 'GET', 'post'), 'not_found', 404);
  await rejectsCode(route(c, 'POST', 'channels'), 'not_found', 404);
});

test('rigs serve: /api/local/connectors/slack/* answers through the normal /api/local handler', async (t) => {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-slack-srv-'));
  const PORT = 47600 + Math.floor(Math.random() * 300);
  const env = { ...process.env, RIGS_NO_MIGRATIONS: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_OPENRIG: '1', RIGS_HOME: HOME, RIGS_SSH_DIR: path.join(HOME, 'ssh'), RIGS_PORT: String(PORT), RIGS_NAME: 'slack-test', RIGS_PEERS: '', RIGS_MESH_TOKEN: 'test-token' };
  delete env.SLACK_BOT_TOKEN;
  delete env.SLACK_USER_TOKEN;
  const srv = spawn(process.execPath, [path.join(ROOT, 'bin/rigs.js'), 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  srv.stdout.on('data', (d) => { logs += d; });
  srv.stderr.on('data', (d) => { logs += d; });
  t.after(() => srv.kill());
  const base = `http://127.0.0.1:${PORT}/api/local/connectors/slack`;
  let up = false; // a loaded machine can take well over 15 s to boot the server
  for (let i = 0; i < 400 && !up; i++) {
    try { up = (await fetch(`http://127.0.0.1:${PORT}/api/local/info`)).ok; } catch {}
    if (!up) await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(up, `server did not come up on ${PORT}:\n${logs.slice(-1500)}`);
  const status = await fetch(`${base}/status`).then((r) => r.json());
  assert.deepEqual(status, { configured: false, source: null, token: null, searchToken: null, checkedAt: null });
  const ch = await fetch(`${base}/channels`);
  assert.equal(ch.status, 503);
  assert.equal((await ch.json()).code, 'not_configured');
  const post = await fetch(`${base}/post`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'C0123456789', text: 'hi' }) });
  assert.equal(post.status, 400);
  assert.equal((await post.json()).code, 'confirm_required');
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.ok(!logs.includes('xox'), 'no token-looking strings in the server log');
});
