// Slack connector (/api/local/connectors/slack/*): a thin client over the Slack Web API with plain fetch.
//
// Token: config.connectors.slack.token, else SLACK_BOT_TOKEN. search.messages only accepts a user token
// (xoxp-), so config.connectors.slack.userToken / SLACK_USER_TOKEN is used for search when it is set.
// A token is never logged, returned or put in an error: status reports `configured` and `token: 'len=N'`.
//
// Writes are refused unless the caller passes confirm: true — reads are an allowlist (READ_METHODS), so a
// method that is not on it counts as a write. A 429 waits for Retry-After and retries (maxRetries, at most
// maxWaitMs per wait); past that it fails with code `rate_limited` and `retryAfter` in seconds.
import { config } from '../config.js';

export const SLACK_API = 'https://slack.com/api/';
export const READ_METHODS = new Set(['auth.test', 'conversations.list', 'conversations.history', 'conversations.info', 'search.messages']);
const MAX_TEXT = 40000;

export class SlackError extends Error {
  constructor(code, message, status = 502, extra = {}) {
    super(message);
    this.name = 'SlackError';
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

/** Where the token comes from: { token, source: 'config' | 'env' | null }. Never hand `token` to a caller. */
export function resolveToken(cfg = {}, env = process.env, kind = 'bot') {
  const s = cfg?.connectors?.slack || {};
  const fromCfg = kind === 'user' ? s.userToken : s.token;
  const fromEnv = kind === 'user' ? env.SLACK_USER_TOKEN : env.SLACK_BOT_TOKEN;
  if (typeof fromCfg === 'string' && fromCfg.trim()) return { token: fromCfg.trim(), source: 'config' };
  if (typeof fromEnv === 'string' && fromEnv.trim()) return { token: fromEnv.trim(), source: 'env' };
  return { token: '', source: null };
}

const clampInt = (v, lo, hi, dflt) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/** Slack timestamps are "seconds.micros"; an epoch number or an ISO date is accepted too. */
export function toSlackTs(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return s;
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new SlackError('bad_request', `oldest must be a Slack ts, epoch seconds or a date, got "${s.slice(0, 40)}"`, 400);
  return (t / 1000).toFixed(6);
}

const CHANNEL_ID = /^[CGD][A-Z0-9]{6,}$/;

/** Retry-After is seconds (Slack never sends an HTTP date, but tolerate one). */
function retryAfterSeconds(h) {
  if (!h) return 1;
  const n = Number(h);
  if (Number.isFinite(n) && n >= 0) return n;
  const t = Date.parse(h);
  return Number.isNaN(t) ? 1 : Math.max(0, Math.ceil((t - Date.now()) / 1000));
}

const pickChannel = (c) => ({
  id: c.id, name: c.name, private: !!c.is_private, member: !!c.is_member, archived: !!c.is_archived,
  members: c.num_members ?? null, topic: c.topic?.value || '', purpose: c.purpose?.value || '',
});
const pickMessage = (m) => ({
  ts: m.ts, user: m.user || null, bot: m.bot_id || null, username: m.username || null, text: m.text || '',
  ...(m.subtype ? { subtype: m.subtype } : {}), ...(m.thread_ts ? { thread_ts: m.thread_ts } : {}),
  ...(m.reply_count ? { replies: m.reply_count } : {}),
});

/**
 * A Slack client. Everything is injectable for tests: fetch, the config getter, env, sleep.
 * Config and env are read on every call, so a token set later takes effect without a restart.
 */
export function createSlack({ fetch: fetchImpl, getConfig = () => config(), env = process.env, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxRetries = 2, maxWaitMs = 20000, timeoutMs = 15000 } = {}) {
  const doFetch = (...a) => (fetchImpl || globalThis.fetch)(...a);
  const tokenFor = (kind) => resolveToken(getConfig(), env, kind);

  /** One Web API call. Throws SlackError; the message never contains the token. */
  async function api(method, params = {}, { confirm = false, kind = 'bot' } = {}) {
    if (!READ_METHODS.has(method) && confirm !== true) {
      throw new SlackError('confirm_required', `${method} writes to Slack: pass confirm: true to send it`, 400);
    }
    let { token } = tokenFor(kind);
    if (!token && kind === 'user') token = tokenFor('bot').token;
    if (!token) throw new SlackError('not_configured', 'Slack is not configured: set connectors.slack.token in the RIGS config or SLACK_BOT_TOKEN', 503);
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') form.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await doFetch(SLACK_API + method, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
          body: form.toString(),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
        throw new SlackError(timedOut ? 'timeout' : 'network', timedOut ? `Slack did not answer ${method} within ${timeoutMs / 1000}s` : `could not reach Slack (${e?.cause?.code || e?.message || 'network error'})`, 502);
      }
      if (res.status === 429) {
        const wait = retryAfterSeconds(res.headers?.get?.('retry-after'));
        if (attempt < maxRetries && wait * 1000 <= maxWaitMs) { await sleep(wait * 1000); continue; }
        throw new SlackError('rate_limited', `Slack rate-limited ${method}; retry in ${wait}s`, 429, { retryAfter: wait });
      }
      if (!res.ok) throw new SlackError(`http_${res.status}`, `Slack answered ${method} with HTTP ${res.status}`, 502);
      let data;
      try { data = await res.json(); } catch { throw new SlackError('bad_response', `Slack sent a non-JSON answer to ${method}`, 502); }
      if (!data || data.ok !== true) {
        const code = String(data?.error || 'unknown_error');
        const hint = code === 'not_allowed_token_type' && method === 'search.messages' ? ' — search needs a user token (xoxp-): set connectors.slack.userToken or SLACK_USER_TOKEN' : code === 'missing_scope' && data?.needed ? ` (needs scope ${data.needed})` : '';
        throw new SlackError(code, `Slack ${method}: ${code}${hint}`, code === 'channel_not_found' ? 404 : 502);
      }
      return data;
    }
  }

  /** Configured or not, which source, token length — never the token. check: true also runs auth.test. */
  async function status({ check = true } = {}) {
    const bot = tokenFor('bot');
    const user = tokenFor('user');
    const out = {
      configured: !!bot.token, source: bot.source, token: bot.token ? `len=${bot.token.length}` : null,
      searchToken: user.token ? 'user' : bot.token ? 'bot' : null, checkedAt: null,
    };
    if (!bot.token || !check) return out;
    out.checkedAt = new Date().toISOString();
    try {
      const a = await api('auth.test');
      return { ...out, ok: true, team: a.team || null, teamId: a.team_id || null, user: a.user || null, botId: a.bot_id || null, url: a.url || null };
    } catch (e) {
      return { ...out, ok: false, error: e.code || 'error', message: e.message };
    }
  }

  async function listChannels({ limit = 200, cursor, types = 'public_channel,private_channel', archived = false } = {}) {
    const d = await api('conversations.list', { limit: clampInt(limit, 1, 1000, 200), cursor, types, exclude_archived: archived ? 'false' : 'true' });
    return { channels: (d.channels || []).map(pickChannel), next_cursor: d.response_metadata?.next_cursor || null };
  }

  /** "#general" / "general" → its id (walks conversations.list, a few pages at most). An id passes through. */
  async function resolveChannel(channel) {
    const c = String(channel || '').trim();
    if (!c) throw new SlackError('bad_request', 'channel is required', 400);
    if (CHANNEL_ID.test(c)) return c;
    const name = c.replace(/^#/, '').toLowerCase();
    let cursor;
    for (let page = 0; page < 10; page++) {
      const r = await listChannels({ limit: 1000, cursor, archived: true });
      const hit = r.channels.find((x) => x.name?.toLowerCase() === name);
      if (hit) return hit.id;
      if (!r.next_cursor) break;
      cursor = r.next_cursor;
    }
    throw new SlackError('channel_not_found', `no channel named #${name} visible to the bot`, 404);
  }

  async function readHistory({ channel, limit = 50, oldest, cursor } = {}) {
    const ts = toSlackTs(oldest);
    const id = await resolveChannel(channel);
    const d = await api('conversations.history', { channel: id, limit: clampInt(limit, 1, 1000, 50), oldest: ts, cursor });
    return { channel: id, messages: (d.messages || []).map(pickMessage), has_more: !!d.has_more, next_cursor: d.response_metadata?.next_cursor || null };
  }

  async function searchMessages({ query, count = 20, page, sort = 'score' } = {}) {
    const q = String(query || '').trim();
    if (!q) throw new SlackError('bad_request', 'query is required', 400);
    const d = await api('search.messages', { query: q, count: clampInt(count, 1, 100, 20), page, sort: sort === 'timestamp' ? 'timestamp' : 'score' }, { kind: 'user' });
    const m = d.messages || {};
    return {
      query: q, total: m.total ?? (m.matches || []).length,
      matches: (m.matches || []).map((x) => ({ ...pickMessage(x), channel: x.channel ? { id: x.channel.id, name: x.channel.name } : null, permalink: x.permalink || null })),
    };
  }

  /** The one write. Refused (before any network call) unless confirm === true. */
  async function postMessage({ channel, text, thread_ts, confirm = false } = {}) {
    if (confirm !== true) throw new SlackError('confirm_required', 'posting to Slack needs confirm: true — nothing was sent', 400);
    const ch = String(channel || '').trim();
    const t = String(text ?? '');
    if (!ch) throw new SlackError('bad_request', 'channel is required', 400);
    if (!t.trim()) throw new SlackError('bad_request', 'text is required', 400);
    if (t.length > MAX_TEXT) throw new SlackError('bad_request', `text is longer than ${MAX_TEXT} characters`, 400);
    const d = await api('chat.postMessage', { channel: ch, text: t, thread_ts: thread_ts ? String(thread_ts) : undefined }, { confirm: true });
    return { ok: true, channel: d.channel, ts: d.ts, ...(thread_ts ? { thread_ts: String(thread_ts) } : {}) };
  }

  return { api, status, listChannels, readHistory, searchMessages, postMessage, resolveChannel };
}

let shared = null;
const client = () => (shared ||= createSlack());

export const status = (opts) => client().status(opts);
export const listChannels = (opts) => client().listChannels(opts);
export const readHistory = (opts) => client().readHistory(opts);
export const searchMessages = (opts) => client().searchMessages(opts);
export const postMessage = (opts) => client().postMessage(opts);

/** HTTP routes under /api/local/connectors/slack/ (`sub` is what follows that prefix). */
export async function slackRoute(slack, { method, sub, q, body }) {
  if (sub === 'status' && method === 'GET') return slack.status({ check: q.get('check') !== '0' });
  if (sub === 'channels' && method === 'GET') return slack.listChannels({ limit: q.get('limit') || undefined, cursor: q.get('cursor') || undefined, types: q.get('types') || undefined, archived: q.get('archived') === '1' });
  if (sub === 'history' && method === 'GET') return slack.readHistory({ channel: q.get('channel'), limit: q.get('limit') || undefined, oldest: q.get('oldest') || undefined, cursor: q.get('cursor') || undefined });
  if (sub === 'search' && method === 'GET') return slack.searchMessages({ query: q.get('query') ?? q.get('q'), count: q.get('count') || undefined, page: q.get('page') || undefined, sort: q.get('sort') || undefined });
  if (sub === 'post' && method === 'POST') {
    const b = (await body()) || {};
    return slack.postMessage({ channel: b.channel, text: b.text, thread_ts: b.thread_ts, confirm: b.confirm === true });
  }
  throw new SlackError('not_found', `no Slack route ${method} ${sub}`, 404);
}
