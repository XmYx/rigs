import { config, saveConfig } from './config.js';
import { log } from './util.js';

/**
 * Linear connector: list, search and read Linear issues, and create / update an issue or add a comment, for JARVIS
 * brains (MCP `linear_*` tools in src/mcp.js) and anything else on the mesh. Served under /api/local/linear/*, so
 * /api/nodes/<id>/linear/* reaches the Linear workspace configured on any machine.
 *
 * Settings, per machine, in ~/.rigs/config.json → "linear" (written only by POST linear/config or `rigs linear key`,
 * never by the generic settings patch):
 *   { "apiKey": "lin_api_…",                       // a SECRET: never returned, logged or put in errors
 *     "url": "https://api.linear.app/graphql",     // the GraphQL endpoint ('' = Linear's)
 *     "timeoutMs": 15000 }
 * Without apiKey the daemon's LINEAR_API_KEY environment variable is used. No key at all = "not configured".
 *
 * Reads never change anything. Writes (issueCreate, issueUpdate, commentCreate) only happen on an explicit POST —
 * the brain's own tool call on Sir's request; nothing here writes on its own.
 *
 * The pure parts (settings, key detection, redaction, query + filter building, response mapping, error wording) are
 * exported and tested in test/linear.test.js; the client and service take an injectable fetch.
 */

export const LINEAR_URL = 'https://api.linear.app/graphql';
export const DEFAULTS = Object.freeze({ apiKey: '', url: '', timeoutMs: 15000 });
export const ENV_KEY = 'LINEAR_API_KEY';
export const NOT_CONFIGURED = `Linear is not configured on this machine: set an API key with \`rigs linear key\` (Linear → Settings → Security & access → Personal API keys) or the ${ENV_KEY} environment variable of the RIGS daemon.`;
const LIST_MAX = 100;
const DESC_MAX = 20000;

export class LinearError extends Error {
  constructor(code, message, { status, details } = {}) {
    super(message);
    this.name = 'LinearError';
    this.code = code;
    this.status = status || ({ not_configured: 409, bad_request: 400, not_found: 404, unauthorized: 502, rate_limited: 429 }[code] || 502);
    if (details) this.details = details;
  }
}

// ---------------------------------------------------------------- settings and secrets

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,9}-\d{1,7}$/;
const KEY_PATTERN = /\blin_(?:api|oauth)_[A-Za-z0-9]{8,}/g;

/** Endpoint URL: http(s), no credentials, query or fragment. '' = Linear's own. */
export function validateUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { url: '' };
  let u;
  try { u = new URL(s); } catch { return { error: `not a valid URL (example: ${LINEAR_URL})` }; }
  if (!/^https?:$/.test(u.protocol)) return { error: 'URL must start with https:// (or http:// for a local proxy)' };
  if (u.username || u.password || u.search || u.hash) return { error: 'URL must not carry credentials, a ?query or a #fragment' };
  return { url: `${u.origin}${u.pathname.replace(/\/+$/, '')}` };
}

/** An API key as typed: one line, no spaces, sane length. Errors never echo the value. */
export function validateKey(raw) {
  const s = String(raw ?? '').trim().replace(/^bearer\s+/i, '');
  if (!s) return { key: '' };
  if (/\s/.test(s) || /[\0-\x1f\x7f]/.test(s)) return { error: 'the API key must be a single word without spaces' };
  if (s.length < 16 || s.length > 300) return { error: 'that does not look like a Linear API key (lin_api_…)' };
  return { key: s };
}

/**
 * Validate a settings change on top of the current settings. `apiKey` undefined keeps the stored key; '' or
 * clearKey removes it. Returns { value, errors }.
 */
export function validateSettings(input = {}, prev = DEFAULTS) {
  const errors = [];
  const value = { ...DEFAULTS, ...prev };
  if (input.clearKey) value.apiKey = '';
  else if (input.apiKey !== undefined) {
    const r = validateKey(input.apiKey);
    if (r.error) errors.push(`apiKey: ${r.error}`); else value.apiKey = r.key;
  }
  if (input.url !== undefined) {
    const r = validateUrl(input.url);
    if (r.error) errors.push(`url: ${r.error}`); else value.url = r.url;
  }
  if (input.timeoutMs !== undefined) {
    const n = Number(input.timeoutMs);
    if (!Number.isFinite(n) || n < 1000 || n > 120000) errors.push('timeoutMs: 1000-120000'); else value.timeoutMs = Math.round(n);
  }
  return { value, errors };
}

/** Stored settings, validated; an invalid field falls back to its default (logged by name, never by value). */
export function loadSettings(cfg = config()) {
  const stored = cfg.linear && typeof cfg.linear === 'object' ? cfg.linear : {};
  const { value, errors } = validateSettings(stored, DEFAULTS);
  if (!errors.length) return value;
  log(`linear: ignoring invalid settings (${errors.map((e) => e.split(':')[0]).join(', ')})`);
  const ok = {};
  for (const k of Object.keys(stored)) if (!errors.some((e) => e.startsWith(`${k}:`))) ok[k] = stored[k];
  return validateSettings(ok, DEFAULTS).value;
}

/** Which key applies: the configured one, else the environment's. { key, source: 'config' | 'env' | null }. */
export function resolveApiKey(settings = DEFAULTS, env = process.env) {
  const own = validateKey(settings?.apiKey).key;
  if (own) return { key: own, source: 'config' };
  const fromEnv = validateKey(env?.[ENV_KEY]).key;
  if (fromEnv) return { key: fromEnv, source: 'env' };
  return { key: '', source: null };
}

/** Whether Linear is set up, without the key: { configured, source, url, message? }. */
export function configStatus(settings = DEFAULTS, env = process.env) {
  const { key, source } = resolveApiKey(settings, env);
  return { configured: !!key, source, url: settings?.url || LINEAR_URL, ...(key ? {} : { message: NOT_CONFIGURED }) };
}

/** Settings as the UI and peers may see them: the key only as "set" + where it comes from. */
export function publicSettings(settings = DEFAULTS, env = process.env) {
  const { source } = resolveApiKey(settings, env);
  return { apiKey: { set: !!source, source }, url: settings.url || '', timeoutMs: settings.timeoutMs };
}

/** Personal keys (lin_api_…) go as they are; OAuth access tokens as a Bearer token. */
export function authHeader(key) {
  return /^lin_api_/.test(key) ? key : `Bearer ${key}`;
}

/** Strip the key (and anything shaped like a Linear key) from text before it reaches a log, an answer or the UI. */
export function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('•••');
  return out.replace(KEY_PATTERN, 'lin_***');
}

/** Deep copy with every string redacted (see redact). */
export function redactValue(v, secrets = [], depth = 0) {
  if (typeof v === 'string') return redact(v, secrets);
  if (v == null || typeof v !== 'object' || depth > 12) return v;
  if (Array.isArray(v)) return v.map((x) => redactValue(x, secrets, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactValue(x, secrets, depth + 1)]));
}

// ---------------------------------------------------------------- query building

export const PRIORITIES = Object.freeze({ none: 0, urgent: 1, high: 2, medium: 3, normal: 3, low: 4 });
export const STATE_TYPES = Object.freeze(['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled']);
const CLOSED = ['completed', 'canceled'];

/** 0-4 or a word (none, urgent, high, medium/normal, low) → 0-4; undefined/'' → undefined. Throws bad_request. */
export function parsePriority(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim().toLowerCase();
  if (/^[0-4]$/.test(s)) return Number(s);
  if (s in PRIORITIES) return PRIORITIES[s];
  throw new LinearError('bad_request', 'priority: 0-4 or none | urgent | high | medium | low');
}

/** An issue reference: an identifier like "ENG-123" (uppercased) or an issue UUID. Throws bad_request. */
export function issueRef(v) {
  const s = String(v ?? '').trim();
  if (IDENTIFIER.test(s)) return s.toUpperCase();
  if (UUID.test(s)) return s.toLowerCase();
  throw new LinearError('bad_request', `not an issue id: give its identifier (like ENG-123) or its UUID`);
}

/** Page size: 1-100, default 25. */
export function pageSize(v, dflt = 25) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, LIST_MAX) : dflt;
}

const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => String(x).trim()).filter(Boolean);

/**
 * Linear IssueFilter from friendly arguments:
 *   team      key ("ENG") or name                     state     a state name ("In Review"), a state type
 *   assignee  "me" | "none" | a name or email                   (backlog, started, …), "open" (default), "closed" or "all"
 *   priority  0-4 or a word                           label     a label name (or several, comma-separated: any of them)
 *   project   part of a project name                  text      words in the title or description
 * Unknown values are passed as filters, not checked: an empty result means nothing matched.
 */
export function buildIssueFilter(a = {}) {
  const and = [];
  const team = String(a.team ?? '').trim();
  if (team) and.push({ team: UUID.test(team) ? { id: { eq: team } } : { or: [{ key: { eqIgnoreCase: team } }, { name: { eqIgnoreCase: team } }] } });
  const state = String(a.state ?? '').trim().toLowerCase();
  if (!state || state === 'open') and.push({ state: { type: { nin: CLOSED } } });
  else if (state === 'closed' || state === 'done') and.push({ state: { type: { in: CLOSED } } });
  else if (STATE_TYPES.includes(state)) and.push({ state: { type: { eq: state } } });
  else if (state !== 'all' && state !== 'any') and.push({ state: { name: { eqIgnoreCase: String(a.state).trim() } } });
  const who = String(a.assignee ?? '').trim();
  if (/^(me|myself|mine)$/i.test(who)) and.push({ assignee: { isMe: { eq: true } } });
  else if (/^(none|unassigned|nobody)$/i.test(who)) and.push({ assignee: { null: true } });
  else if (UUID.test(who)) and.push({ assignee: { id: { eq: who } } });
  else if (who) and.push({ assignee: { or: [{ name: { containsIgnoreCase: who } }, { displayName: { containsIgnoreCase: who } }, { email: { eqIgnoreCase: who } }] } });
  const priority = parsePriority(a.priority);
  if (priority !== undefined) and.push({ priority: { eq: priority } });
  const labels = list(a.label ?? a.labels);
  if (labels.length) and.push({ labels: { some: { or: labels.map((l) => ({ name: { eqIgnoreCase: l } })) } } });
  const project = String(a.project ?? '').trim();
  if (project) and.push({ project: { name: { containsIgnoreCase: project } } });
  const text = String(a.text ?? '').trim();
  if (text) and.push({ or: [{ title: { containsIgnoreCase: text } }, { description: { containsIgnoreCase: text } }] });
  return and.length ? { and } : {};
}

const ISSUE_LIST_FIELDS = `id identifier title url priority priorityLabel estimate dueDate createdAt updatedAt
  state { name type } assignee { name displayName email } team { key name } project { name } labels(first: 20) { nodes { name } }`;
const ISSUE_FULL_FIELDS = `${ISSUE_LIST_FIELDS} description branchName completedAt canceledAt creator { name displayName }
  parent { identifier title } children(first: 50) { nodes { identifier title state { name } } }`;
const COMMENT_FIELDS = 'id body url createdAt updatedAt user { name displayName }';

/** Issues matching the filter, most recently updated first. → { query, variables } */
export function buildListQuery(a = {}) {
  return {
    query: `query RigsIssues($filter: IssueFilter, $first: Int, $after: String) {
  issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) { nodes { ${ISSUE_LIST_FIELDS} } pageInfo { hasNextPage endCursor } }
}`,
    variables: { filter: buildIssueFilter(a), first: pageSize(a.limit ?? a.first), ...(a.after ? { after: String(a.after) } : {}) },
  };
}

/** Full-text search (Linear's searchIssues, ranked), narrowed by the same filters (state defaults to "all" here). */
export function buildSearchQuery(a = {}) {
  const term = String(a.query ?? a.term ?? '').trim();
  if (!term) throw new LinearError('bad_request', 'query: what to search for');
  return {
    query: `query RigsSearch($term: String!, $filter: IssueFilter, $first: Int, $after: String) {
  searchIssues(term: $term, filter: $filter, first: $first, after: $after) { nodes { ${ISSUE_LIST_FIELDS} } pageInfo { hasNextPage endCursor } }
}`,
    variables: { term, filter: buildIssueFilter({ state: 'all', ...a }), first: pageSize(a.limit ?? a.first), ...(a.after ? { after: String(a.after) } : {}) },
  };
}

/** One issue with its description and latest comments. */
export function buildIssueQuery(id, { comments = 20 } = {}) {
  return {
    query: `query RigsIssue($id: String!, $comments: Int) {
  issue(id: $id) { ${ISSUE_FULL_FIELDS} comments(first: $comments, orderBy: createdAt) { nodes { ${COMMENT_FIELDS} } } }
}`,
    variables: { id: issueRef(id), comments: Math.max(0, Math.min(Math.round(Number(comments)) || 0, 100)) },
  };
}

export const VIEWER_QUERY = 'query RigsViewer { viewer { id name displayName email } organization { name urlKey } teams(first: 50) { nodes { id key name } } }';
export const TEAMS_QUERY = 'query RigsTeams { teams(first: 250) { nodes { id key name } } }';
export const ISSUE_ID_QUERY = 'query RigsIssueId($id: String!) { issue(id: $id) { id identifier team { id } } }';
export const STATES_QUERY = 'query RigsStates($team: ID!) { workflowStates(first: 100, filter: { team: { id: { eq: $team } } }) { nodes { id name type } } }';
export const LABELS_QUERY = 'query RigsLabels($team: ID!) { issueLabels(first: 250, filter: { or: [{ team: { id: { eq: $team } } }, { team: { null: true } }] }) { nodes { id name } } }';
export const USERS_QUERY = 'query RigsUsers { users(first: 250) { nodes { id name displayName email active } } }';
export const PROJECTS_QUERY = 'query RigsProjects($name: String!) { projects(first: 10, filter: { name: { containsIgnoreCase: $name } }) { nodes { id name } } }';

/**
 * The plain fields of an issue create/update input from the tool's arguments. Names (team, state, assignee,
 * labels, project) are resolved to ids by the service and passed in `ids`. Undefined fields are left out.
 */
export function issueInput(a = {}, ids = {}) {
  const out = {};
  if (a.title !== undefined) {
    const t = String(a.title).trim();
    if (!t) throw new LinearError('bad_request', 'title must not be empty');
    out.title = t.slice(0, 500);
  }
  if (a.description !== undefined) out.description = String(a.description).slice(0, 100000);
  const p = parsePriority(a.priority);
  if (p !== undefined) out.priority = p;
  if (a.dueDate !== undefined) {
    const d = String(a.dueDate || '').trim();
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new LinearError('bad_request', 'dueDate: YYYY-MM-DD');
    out.dueDate = d || null;
  }
  if (a.estimate !== undefined) {
    const n = Number(a.estimate);
    if (!Number.isFinite(n) || n < 0) throw new LinearError('bad_request', 'estimate: a number of points');
    out.estimate = n;
  }
  for (const k of ['teamId', 'stateId', 'assigneeId', 'projectId', 'parentId']) if (ids[k] !== undefined) out[k] = ids[k];
  if (ids.labelIds !== undefined) out.labelIds = ids.labelIds;
  return out;
}

export function buildCreateMutation(input) {
  if (!input?.teamId) throw new LinearError('bad_request', 'team is required to create an issue');
  if (!input.title) throw new LinearError('bad_request', 'title is required to create an issue');
  return {
    query: `mutation RigsIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_LIST_FIELDS} } } }`,
    variables: { input },
  };
}

export function buildUpdateMutation(id, input) {
  if (!input || !Object.keys(input).length) throw new LinearError('bad_request', 'nothing to change: give at least one of title, description, state, priority, assignee, labels, project, dueDate, estimate');
  return {
    query: `mutation RigsIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_LIST_FIELDS} } } }`,
    variables: { id, input },
  };
}

export function buildCommentMutation(issueId, body) {
  const text = String(body ?? '').trim();
  if (!text) throw new LinearError('bad_request', 'body: the comment text');
  return {
    query: `mutation RigsComment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { ${COMMENT_FIELDS} } } }`,
    variables: { input: { issueId, body: text.slice(0, 100000) } },
  };
}

// ---------------------------------------------------------------- response mapping

const person = (u) => (u ? u.displayName || u.name || null : null);

/** A Linear issue node → the flat shape the tools return. `full` keeps the description, parent and sub-issues. */
export function mapIssue(n, { full = false } = {}) {
  if (!n) return null;
  const out = {
    id: n.id, identifier: n.identifier, title: n.title, url: n.url,
    state: n.state?.name ?? null, stateType: n.state?.type ?? null,
    priority: n.priority ?? null, priorityLabel: n.priorityLabel ?? null,
    assignee: person(n.assignee), team: n.team?.key ?? null, project: n.project?.name ?? null,
    labels: (n.labels?.nodes || []).map((l) => l.name),
    estimate: n.estimate ?? null, dueDate: n.dueDate ?? null, createdAt: n.createdAt ?? null, updatedAt: n.updatedAt ?? null,
  };
  if (!full) return out;
  const desc = n.description ?? '';
  return {
    ...out,
    description: desc.length > DESC_MAX ? `${desc.slice(0, DESC_MAX)}…[truncated ${desc.length - DESC_MAX} chars]` : desc,
    creator: person(n.creator), branchName: n.branchName ?? null, completedAt: n.completedAt ?? null, canceledAt: n.canceledAt ?? null,
    parent: n.parent ? { identifier: n.parent.identifier, title: n.parent.title } : null,
    children: (n.children?.nodes || []).map((c) => ({ identifier: c.identifier, title: c.title, state: c.state?.name ?? null })),
    comments: (n.comments?.nodes || []).map(mapComment),
  };
}

export function mapComment(c) {
  return c ? { id: c.id, author: person(c.user), body: c.body ?? '', url: c.url ?? null, createdAt: c.createdAt ?? null } : null;
}

/** An issue connection ({ nodes, pageInfo }) → { issues, hasMore, next }. */
export function mapIssueList(conn) {
  return { issues: (conn?.nodes || []).map((n) => mapIssue(n)), hasMore: !!conn?.pageInfo?.hasNextPage, next: conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null };
}

/** HTTP status + GraphQL body → a LinearError (already redacted by the caller) or null when the call succeeded. */
export function responseError(status, body) {
  const errs = Array.isArray(body?.errors) ? body.errors : [];
  const codes = errs.map((e) => e?.extensions?.code || e?.extensions?.type || '').map(String);
  const msg = errs.map((e) => e?.extensions?.userPresentableMessage || e?.message).filter(Boolean).join('; ');
  if (status === 401 || codes.some((c) => /AUTHENTICATION/i.test(c))) return new LinearError('unauthorized', 'Linear rejected the API key (it may be revoked or mistyped) — set it again with `rigs linear key`');
  if (status === 429 || codes.some((c) => /RATELIMIT/i.test(c))) return new LinearError('rate_limited', 'Linear rate limit reached — try again in a minute');
  if (status === 403 || codes.some((c) => /FORBIDDEN/i.test(c))) return new LinearError('forbidden', `Linear refused: ${msg || 'no access to that'}`);
  if (errs.length) {
    const notFound = codes.some((c) => /NOT_?FOUND|ENTITY/i.test(c)) || /not found|could not find/i.test(msg);
    return new LinearError(notFound ? 'not_found' : (status >= 500 ? 'linear_error' : 'bad_request'), `Linear: ${msg || 'request failed'}`, { status: notFound ? 404 : (status >= 500 ? 502 : 400) });
  }
  if (status < 200 || status >= 300) return new LinearError('linear_error', `Linear answered HTTP ${status}`);
  if (!body || typeof body !== 'object' || !body.data) return new LinearError('linear_error', 'Linear sent an answer without data');
  return null;
}

// ---------------------------------------------------------------- client

/** Minimal GraphQL client. The key rides only in the Authorization header; every error is redacted. */
export function createClient({ apiKey, url = '', timeoutMs = DEFAULTS.timeoutMs, fetchImpl = globalThis.fetch } = {}) {
  const key = validateKey(apiKey).key;
  if (!key) throw new LinearError('not_configured', NOT_CONFIGURED);
  const endpoint = validateUrl(url).url || LINEAR_URL;
  const secrets = [key];
  async function request(query, variables = {}) {
    let r;
    try {
      r = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: authHeader(key), 'user-agent': 'rigs-jarvis' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const why = e.name === 'TimeoutError' ? `no answer in ${Math.round(timeoutMs / 1000)} s` : (e.cause?.code || e.cause?.message || e.message);
      throw new LinearError('unreachable', redact(`Linear is not reachable at ${endpoint}: ${why}`, secrets));
    }
    const text = await r.text().catch(() => '');
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON: reported below */ }
    const err = responseError(r.status, body);
    if (err) { err.message = redact(err.message, secrets); throw err; }
    return redactValue(body.data, secrets);
  }
  return { request, endpoint };
}

// ---------------------------------------------------------------- service

const ieq = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

/** Pick the one entry whose name (or other keys) matches, case-insensitive; a clear error naming the choices otherwise. */
export function pickNamed(items, want, { what, keys = ['name'] } = {}) {
  const w = String(want ?? '').trim();
  const hit = items.find((x) => x.id === w) || items.find((x) => keys.some((k) => ieq(x[k], w)));
  if (hit) return hit;
  const names = items.map((x) => x[keys[0]]).filter(Boolean);
  throw new LinearError('bad_request', `no ${what} "${w}"${names.length ? ` — choose one of: ${names.slice(0, 30).join(', ')}` : ''}`);
}

/**
 * The connector: status check, reads, and the three writes. `cfg` and `env` are read on every call, so a key set
 * with POST linear/config (or a changed environment in tests) applies at once.
 */
export function createLinearService({ cfg = config, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const settings = () => loadSettings(cfg());
  let teamCache = null;
  const client = () => {
    const s = settings();
    const { key } = resolveApiKey(s, env);
    return createClient({ apiKey: key, url: s.url, timeoutMs: s.timeoutMs, fetchImpl });
  };
  const q = (built) => client().request(built.query, built.variables);

  async function teams() {
    if (teamCache && Date.now() - teamCache.at < 5 * 60000) return teamCache.teams;
    const d = await client().request(TEAMS_QUERY);
    teamCache = { at: Date.now(), teams: d.teams?.nodes || [] };
    return teamCache.teams;
  }
  async function issueIds(ref) {
    const d = await client().request(ISSUE_ID_QUERY, { id: issueRef(ref) });
    if (!d.issue) throw new LinearError('not_found', `no Linear issue ${ref}`);
    return d.issue;
  }
  async function resolveIds(a, teamId) {
    const ids = {};
    const c = client();
    if (a.state !== undefined && String(a.state).trim()) {
      const states = (await c.request(STATES_QUERY, { team: teamId })).workflowStates?.nodes || [];
      const s = String(a.state).trim();
      ids.stateId = (states.find((x) => x.id === s || ieq(x.name, s)) || states.find((x) => ieq(x.type, s)) || pickNamed(states, s, { what: 'state' })).id;
    }
    if (a.assignee !== undefined) {
      const who = String(a.assignee ?? '').trim();
      if (!who || /^(none|unassigned|nobody)$/i.test(who)) ids.assigneeId = null;
      else if (/^(me|myself)$/i.test(who)) ids.assigneeId = (await c.request('query RigsMe { viewer { id } }')).viewer.id;
      else if (UUID.test(who)) ids.assigneeId = who;
      else {
        const users = ((await c.request(USERS_QUERY)).users?.nodes || []).filter((u) => u.active !== false);
        ids.assigneeId = pickNamed(users, who, { what: 'person', keys: ['displayName', 'name', 'email'] }).id;
      }
    }
    if (a.labels !== undefined || a.label !== undefined) {
      const want = list(a.labels ?? a.label);
      const labels = want.length ? (await c.request(LABELS_QUERY, { team: teamId })).issueLabels?.nodes || [] : [];
      ids.labelIds = want.map((l) => pickNamed(labels, l, { what: 'label' }).id);
    }
    if (a.project !== undefined) {
      const name = String(a.project ?? '').trim();
      if (!name || /^none$/i.test(name)) ids.projectId = null;
      else {
        const projects = (await c.request(PROJECTS_QUERY, { name })).projects?.nodes || [];
        ids.projectId = (projects.find((p) => ieq(p.name, name)) || (projects.length === 1 ? projects[0] : pickNamed(projects, name, { what: 'project' }))).id;
      }
    }
    if (a.parent !== undefined && String(a.parent).trim()) ids.parentId = (await issueIds(a.parent)).id;
    return ids;
  }

  return {
    settings,
    getConfig: () => ({ ...publicSettings(settings(), env), ...configStatus(settings(), env) }),
    setConfig(input = {}) {
      const c = cfg();
      const { value, errors } = validateSettings(input, loadSettings(c));
      if (errors.length) throw new LinearError('bad_request', errors.join('; '), { details: errors });
      c.linear = value;
      saveConfig(c);
      teamCache = null;
      return { ...publicSettings(value, env), ...configStatus(value, env) };
    },
    /** configured? and, when it is, reachable? — with who the key belongs to and its teams. Never the key. */
    async status() {
      const base = configStatus(settings(), env);
      if (!base.configured) return { ...base, reachable: false };
      const t0 = Date.now();
      try {
        const d = await client().request(VIEWER_QUERY);
        return {
          ...base, reachable: true, latencyMs: Date.now() - t0,
          user: d.viewer ? { name: person(d.viewer), email: d.viewer.email || null } : null,
          organization: d.organization ? { name: d.organization.name, urlKey: d.organization.urlKey } : null,
          teams: (d.teams?.nodes || []).map((x) => ({ key: x.key, name: x.name })),
        };
      } catch (e) {
        return { ...base, reachable: false, latencyMs: Date.now() - t0, error: e.message, code: e.code };
      }
    },
    async listIssues(a = {}) { return mapIssueList((await q(buildListQuery(a))).issues); },
    async searchIssues(a = {}) {
      try {
        return mapIssueList((await q(buildSearchQuery(a))).searchIssues);
      } catch (e) {
        // A workspace or API version without searchIssues: fall back to a title/description filter.
        if (!(e instanceof LinearError) || e.code !== 'bad_request' || !/searchIssues/.test(e.message)) throw e;
        return mapIssueList((await q(buildListQuery({ state: 'all', ...a, text: a.query ?? a.term }))).issues);
      }
    },
    async getIssue(id, opts = {}) {
      const d = await q(buildIssueQuery(id, opts));
      if (!d.issue) throw new LinearError('not_found', `no Linear issue ${id}`);
      return mapIssue(d.issue, { full: true });
    },
    teams: async () => (await teams()).map((x) => ({ key: x.key, name: x.name })),
    async createIssue(a = {}) {
      if (!String(a.team ?? '').trim()) throw new LinearError('bad_request', 'team is required to create an issue (its key, like ENG)');
      const team = pickNamed(await teams(), String(a.team).trim(), { what: 'team', keys: ['key', 'name'] });
      const input = issueInput(a, { teamId: team.id, ...(await resolveIds(a, team.id)) });
      const d = await q(buildCreateMutation(input));
      if (!d.issueCreate?.success) throw new LinearError('linear_error', 'Linear did not create the issue');
      return { created: true, issue: mapIssue(d.issueCreate.issue) };
    },
    async updateIssue(a = {}) {
      const cur = await issueIds(a.id);
      let teamId = cur.team?.id;
      const ids = {};
      if (a.team !== undefined && String(a.team).trim()) teamId = ids.teamId = pickNamed(await teams(), String(a.team).trim(), { what: 'team', keys: ['key', 'name'] }).id;
      Object.assign(ids, await resolveIds(a, teamId));
      const d = await q(buildUpdateMutation(cur.id, issueInput(a, ids)));
      if (!d.issueUpdate?.success) throw new LinearError('linear_error', `Linear did not update ${cur.identifier}`);
      return { updated: true, issue: mapIssue(d.issueUpdate.issue) };
    },
    async addComment(a = {}) {
      const built = buildCommentMutation('pending', a.body); // validate the text before any request
      const cur = await issueIds(a.id);
      built.variables.input.issueId = cur.id;
      const d = await q(built);
      if (!d.commentCreate?.success) throw new LinearError('linear_error', `Linear did not add the comment to ${cur.identifier}`);
      return { commented: true, issue: cur.identifier, comment: mapComment(d.commentCreate.comment) };
    },
  };
}

// ---------------------------------------------------------------- HTTP routes (/api/local/linear/*)

/** Query-string arguments of a list/search call. */
function listArgs(q) {
  const a = {};
  for (const k of ['team', 'state', 'assignee', 'priority', 'label', 'project', 'text', 'query', 'limit', 'after']) if (q.get(k)) a[k] = q.get(k);
  return a;
}

/**
 * GET status · GET/POST config · GET teams · GET issues[?team&state&assignee&priority&label&project&text&limit&after]
 * GET search?query=… (same filters) · GET issues/<id>[?comments=N] · POST issues (create) · POST issues/<id> (update)
 * POST issues/<id>/comments ({ body }). Writes are POST only and never happen without one of these calls.
 */
export async function linearRoute(svc, { method, sub, q, body }) {
  let m;
  if (sub === 'status' && method === 'GET') return svc.status();
  if (sub === 'config' && method === 'GET') return svc.getConfig();
  if (sub === 'config' && method === 'POST') return svc.setConfig(await body());
  if (sub === 'teams' && method === 'GET') return { teams: await svc.teams() };
  if (sub === 'issues' && method === 'GET') return svc.listIssues(listArgs(q));
  if (sub === 'search' && method === 'GET') return svc.searchIssues(listArgs(q));
  if (sub === 'issues' && method === 'POST') return svc.createIssue(await body());
  if ((m = sub.match(/^issues\/([\w-]+)$/)) && method === 'GET') return svc.getIssue(m[1], { comments: q.get('comments') ?? 20 });
  if ((m = sub.match(/^issues\/([\w-]+)$/)) && method === 'POST') return svc.updateIssue({ ...(await body()), id: m[1] });
  if ((m = sub.match(/^issues\/([\w-]+)\/comments$/)) && method === 'POST') return svc.addComment({ ...(await body()), id: m[1] });
  throw new LinearError('not_found', `unknown endpoint: ${method} linear/${sub}`);
}
