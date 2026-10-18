// Linear connector (src/linear.js): settings and key detection, secret redaction, filter / query building, response
// mapping and error wording (pure), the service against a fake Linear GraphQL API (status, list, search with its
// fallback, read, create / update / comment with name → id resolution), and an end-to-end run through a real node and
// `rigs mcp` (the brains' tool list, linear_status, linear_create_issue). The API key must never show up in an answer,
// an error, the daemon's output or the test output. No network, no real Linear.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-linear-'));
process.env.RIGS_NO_OPENRIG = '1';
process.env.RIGS_NO_AUTOUPDATE = '1';
process.env.RIGS_NO_MIGRATIONS = '1';
delete process.env.LINEAR_API_KEY;
const L = await import('../src/linear.js');
const { patchConfig, publicConfig, config } = await import('../src/config.js');
const trace = await import('../src/trace.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Built at runtime so this file holds no key-shaped literal; the value is fake either way.
const KEY = ['lin', 'api', 'T3stK3yZZ9qWm2RcV7xYpLd4N8sFh6Gj'].join('_');
const ENV_KEY_VALUE = ['lin', 'api', 'EnvK3y00aaBBccDDeeFFggHHiiJJkk'].join('_');
const noKey = (v, where) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  assert.ok(!s.includes(KEY) && !s.includes(ENV_KEY_VALUE), `the API key leaked into ${where}`);
};

// ---------------------------------------------------------------- a fake Linear GraphQL API

const TEAM = { id: '11111111-1111-4111-8111-111111111111', key: 'ENG', name: 'Engineering' };
const ISSUE = (over = {}) => ({
  id: '22222222-2222-4222-8222-222222222222', identifier: 'ENG-42', title: 'Fix the flux capacitor', url: 'https://linear.app/acme/issue/ENG-42',
  priority: 2, priorityLabel: 'High', estimate: 3, dueDate: null, createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-18T10:00:00.000Z',
  state: { name: 'In Progress', type: 'started' }, assignee: { name: 'Tony Stark', displayName: 'tony', email: 'tony@acme.test' },
  team: { key: 'ENG', name: 'Engineering' }, project: { name: 'Mark II' }, labels: { nodes: [{ name: 'bug' }] }, ...over,
});

/** A fake Linear: answers by operation name, records every call, and checks the Authorization header. */
function fakeLinear({ key = KEY, search = true } = {}) {
  const calls = [];
  const answer = (headers, raw) => {
    const { query, variables } = JSON.parse(raw);
    const op = /^(?:query|mutation)\s+(\w+)/.exec(query.trim())?.[1];
    calls.push({ op, variables, auth: headers.authorization });
    if (headers.authorization !== key && headers.authorization !== `Bearer ${key}`) return [401, { errors: [{ message: 'Authentication required, not authenticated', extensions: { code: 'AUTHENTICATION_ERROR' } }] }];
    const data = {
      RigsViewer: () => ({ viewer: { id: 'u-me', name: 'Tony Stark', displayName: 'tony', email: 'tony@acme.test' }, organization: { name: 'Acme', urlKey: 'acme' }, teams: { nodes: [TEAM] } }),
      RigsTeams: () => ({ teams: { nodes: [TEAM, { id: 't2', key: 'OPS', name: 'Operations' }] } }),
      RigsIssues: () => ({ issues: { nodes: [ISSUE()], pageInfo: { hasNextPage: true, endCursor: 'cur-1' } } }),
      RigsSearch: () => (search ? { searchIssues: { nodes: [ISSUE({ identifier: 'ENG-7' })], pageInfo: { hasNextPage: false, endCursor: null } } } : null),
      RigsIssue: () => (variables.id === 'ENG-404' ? null : { issue: { ...ISSUE(), description: 'It needs 1.21 gigawatts.', creator: { name: 'Pepper' }, branchName: 'tony/eng-42', parent: null, children: { nodes: [] }, comments: { nodes: [{ id: 'c1', body: 'On it.', url: 'u', createdAt: '2026-10-02T00:00:00.000Z', user: { name: 'Happy', displayName: 'happy' } }] } } }),
      RigsIssueId: () => (variables.id === 'ENG-404' ? null : { issue: { id: ISSUE().id, identifier: variables.id, team: { id: TEAM.id } } }),
      RigsStates: () => ({ workflowStates: { nodes: [{ id: 's-todo', name: 'Todo', type: 'unstarted' }, { id: 's-review', name: 'In Review', type: 'started' }, { id: 's-done', name: 'Done', type: 'completed' }] } }),
      RigsLabels: () => ({ issueLabels: { nodes: [{ id: 'l-bug', name: 'Bug' }, { id: 'l-ui', name: 'UI' }] } }),
      RigsUsers: () => ({ users: { nodes: [{ id: 'u-pepper', name: 'Pepper Potts', displayName: 'pepper', email: 'pepper@acme.test', active: true }] } }),
      RigsMe: () => ({ viewer: { id: 'u-me' } }),
      RigsProjects: () => ({ projects: { nodes: [{ id: 'p-mk2', name: 'Mark II' }] } }),
      RigsIssueCreate: () => ({ issueCreate: { success: true, issue: ISSUE({ identifier: 'ENG-43', title: variables.input.title }) } }),
      RigsIssueUpdate: () => ({ issueUpdate: { success: true, issue: ISSUE({ title: variables.input.title ?? ISSUE().title }) } }),
      RigsComment: () => ({ commentCreate: { success: true, comment: { id: 'c2', body: variables.input.body, url: 'https://linear.app/c2', createdAt: '2026-10-18T12:00:00.000Z', user: { name: 'Tony Stark', displayName: 'tony' } } } }),
    }[op]?.();
    if (op === 'RigsSearch' && !search) return [400, { errors: [{ message: 'Cannot query field "searchIssues" on type "Query".', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] }];
    if ((op === 'RigsIssue' || op === 'RigsIssueId') && !data) return [200, { data: null, errors: [{ message: 'Entity not found: Issue', extensions: { code: 'INVALID_INPUT', type: 'invalid input', userPresentableMessage: 'Could not find referenced Issue.' } }] }];
    if (!data) return [400, { errors: [{ message: `unknown operation ${op}` }] }];
    return [200, { data }];
  };
  const fetchImpl = async (url, init) => {
    const [status, body] = answer(Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v])), init.body);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, answer, fetchImpl };
}

const svcWith = ({ settings = { apiKey: KEY }, env = {}, ...fake } = {}) => {
  const f = fakeLinear(fake);
  return { ...f, svc: L.createLinearService({ cfg: () => ({ linear: settings }), env, fetchImpl: f.fetchImpl }) };
};

// ---------------------------------------------------------------- settings, key detection, redaction

test('settings: key validation keeps, replaces and clears the key; errors never echo it', () => {
  assert.deepEqual(L.validateKey(''), { key: '' });
  assert.deepEqual(L.validateKey(`  Bearer ${KEY} `), { key: KEY });
  for (const bad of ['short', 'has a space in it ok?', `${KEY}\nx`]) {
    const r = L.validateKey(bad);
    assert.ok(r.error);
    assert.ok(!r.error.includes(bad.trim()), 'the error does not repeat the value');
  }
  const prev = { ...L.DEFAULTS, apiKey: KEY };
  assert.equal(L.validateSettings({ url: 'https://example.test/graphql/' }, prev).value.apiKey, KEY, 'apiKey undefined keeps the stored key');
  assert.equal(L.validateSettings({ url: 'https://example.test/graphql/' }, prev).value.url, 'https://example.test/graphql');
  assert.equal(L.validateSettings({ clearKey: true }, prev).value.apiKey, '');
  assert.equal(L.validateSettings({ apiKey: '' }, prev).value.apiKey, '');
  const bad = L.validateSettings({ apiKey: 'x y', url: 'ftp://nope', timeoutMs: 5 }, prev);
  assert.deepEqual(bad.errors.map((e) => e.split(':')[0]), ['apiKey', 'url', 'timeoutMs']);
  assert.match(L.validateUrl('https://user:pw@example.test').error, /credentials/);
});

test('config detection: the configured key wins, LINEAR_API_KEY is the fallback, none = not configured', () => {
  assert.deepEqual(L.resolveApiKey({ apiKey: KEY }, { LINEAR_API_KEY: ENV_KEY_VALUE }), { key: KEY, source: 'config' });
  assert.deepEqual(L.resolveApiKey({ apiKey: '' }, { LINEAR_API_KEY: ENV_KEY_VALUE }), { key: ENV_KEY_VALUE, source: 'env' });
  assert.deepEqual(L.resolveApiKey({}, {}), { key: '', source: null });
  const off = L.configStatus({}, {});
  assert.equal(off.configured, false);
  assert.match(off.message, /not configured/);
  assert.match(off.message, /rigs linear key/);
  const on = L.configStatus({ apiKey: KEY }, {});
  assert.deepEqual([on.configured, on.source, on.url, on.message], [true, 'config', L.LINEAR_URL, undefined]);
  const pub = L.publicSettings({ ...L.DEFAULTS, apiKey: KEY }, { LINEAR_API_KEY: ENV_KEY_VALUE });
  assert.deepEqual(pub.apiKey, { set: true, source: 'config' });
  noKey(pub, 'publicSettings');
  noKey(on, 'configStatus');
});

test('redaction: the exact key and anything shaped like a Linear key are masked; auth header shape', () => {
  assert.equal(L.redact(`failed with ${KEY} at x`, [KEY]), 'failed with ••• at x');
  assert.equal(L.redact(`env had ${ENV_KEY_VALUE}`), 'env had lin_***');
  assert.equal(L.redact(['lin', 'oauth', 'abcdefgh12345678'].join('_')), 'lin_***');
  assert.equal(L.redact('nothing secret'), 'nothing secret');
  noKey(L.redactValue({ a: [`x ${KEY}`], b: { c: KEY } }, [KEY]), 'redactValue');
  assert.equal(L.authHeader(KEY), KEY, 'personal keys go bare');
  assert.equal(L.authHeader('oauth-access-token-123456'), 'Bearer oauth-access-token-123456');
  // the trace store (brain tool-call spans) masks Linear keys too
  assert.equal(trace.redact(`curl -H "Authorization: x" ${KEY}`).includes(KEY), false);
});

test('the generic settings patch cannot write the Linear key and publicConfig never carries it', () => {
  const before = JSON.stringify(config().linear ?? null);
  patchConfig({ linear: { apiKey: KEY }, persona: { humor: 61 } });
  assert.equal(JSON.stringify(config().linear ?? null), before);
  assert.equal(config().persona.humor, 61);
  noKey(publicConfig(), 'publicConfig');
  assert.equal('linear' in publicConfig(), false);
});

// ---------------------------------------------------------------- query building

test('filters: team, state, assignee, priority, label, project, text', () => {
  assert.deepEqual(L.buildIssueFilter({}), { and: [{ state: { type: { nin: ['completed', 'canceled'] } } }] }, 'open by default');
  assert.deepEqual(L.buildIssueFilter({ state: 'all' }), {});
  const f = L.buildIssueFilter({ team: 'eng', state: 'In Review', assignee: 'me', priority: 'urgent', label: 'bug, ui', project: 'mark', text: 'flux' });
  assert.deepEqual(f.and, [
    { team: { or: [{ key: { eqIgnoreCase: 'eng' } }, { name: { eqIgnoreCase: 'eng' } }] } },
    { state: { name: { eqIgnoreCase: 'In Review' } } },
    { assignee: { isMe: { eq: true } } },
    { priority: { eq: 1 } },
    { labels: { some: { or: [{ name: { eqIgnoreCase: 'bug' } }, { name: { eqIgnoreCase: 'ui' } }] } } },
    { project: { name: { containsIgnoreCase: 'mark' } } },
    { or: [{ title: { containsIgnoreCase: 'flux' } }, { description: { containsIgnoreCase: 'flux' } }] },
  ]);
  assert.deepEqual(L.buildIssueFilter({ state: 'started' }).and, [{ state: { type: { eq: 'started' } } }]);
  assert.deepEqual(L.buildIssueFilter({ state: 'closed' }).and, [{ state: { type: { in: ['completed', 'canceled'] } } }]);
  assert.deepEqual(L.buildIssueFilter({ state: 'all', assignee: 'none' }).and, [{ assignee: { null: true } }]);
  assert.deepEqual(L.buildIssueFilter({ state: 'all', assignee: 'pepper@acme.test' }).and[0].assignee.or[2], { email: { eqIgnoreCase: 'pepper@acme.test' } });
  assert.deepEqual(L.buildIssueFilter({ state: 'all', team: TEAM.id }).and, [{ team: { id: { eq: TEAM.id } } }]);
  assert.throws(() => L.buildIssueFilter({ priority: 'whenever' }), /priority/);
});

test('queries: list, search, one issue; page size and ids are checked', () => {
  const l = L.buildListQuery({ team: 'ENG', limit: 500, after: 'c1' });
  assert.match(l.query, /^query RigsIssues/);
  assert.match(l.query, /orderBy: updatedAt/);
  assert.deepEqual([l.variables.first, l.variables.after], [100, 'c1']);
  assert.equal(L.buildListQuery({}).variables.first, 25);
  const s = L.buildSearchQuery({ query: ' flux ', limit: 5 });
  assert.match(s.query, /searchIssues\(term: \$term/);
  assert.deepEqual([s.variables.term, s.variables.first, s.variables.filter], ['flux', 5, {}], 'search covers every state unless asked');
  assert.throws(() => L.buildSearchQuery({}), /query/);
  const one = L.buildIssueQuery('eng-42', { comments: 500 });
  assert.deepEqual(one.variables, { id: 'ENG-42', comments: 100 });
  assert.match(one.query, /description/);
  assert.equal(L.issueRef(TEAM.id.toUpperCase()), TEAM.id);
  for (const bad of ['', 'ENG', '42', 'ENG-42; drop', '../x']) assert.throws(() => L.issueRef(bad), /not an issue id/);
});

test('mutations: inputs, required fields, nothing-to-change refused', () => {
  assert.deepEqual(L.issueInput({ title: '  New  ', description: 'd', priority: 'low', dueDate: '2026-11-01', estimate: 2 }, { teamId: 't', labelIds: ['l'] }),
    { title: 'New', description: 'd', priority: 4, dueDate: '2026-11-01', estimate: 2, teamId: 't', labelIds: ['l'] });
  assert.deepEqual(L.issueInput({}, { assigneeId: null }), { assigneeId: null }, 'unassign is an explicit null');
  assert.throws(() => L.issueInput({ title: ' ' }), /title/);
  assert.throws(() => L.issueInput({ dueDate: 'tomorrow' }), /dueDate/);
  assert.throws(() => L.buildCreateMutation({ title: 'x' }), /team/);
  assert.throws(() => L.buildCreateMutation({ teamId: 't' }), /title/);
  assert.match(L.buildCreateMutation({ teamId: 't', title: 'x' }).query, /issueCreate\(input: \$input\)/);
  assert.throws(() => L.buildUpdateMutation('id', {}), /nothing to change/);
  assert.deepEqual(L.buildUpdateMutation('id', { priority: 1 }).variables, { id: 'id', input: { priority: 1 } });
  assert.throws(() => L.buildCommentMutation('id', '  '), /body/);
  assert.deepEqual(L.buildCommentMutation('id', ' hi ').variables, { input: { issueId: 'id', body: 'hi' } });
  assert.deepEqual(['0', 1, 'Urgent', 'normal', undefined].map(L.parsePriority), [0, 1, 1, 3, undefined]);
});

// ---------------------------------------------------------------- response mapping and errors

test('mapping: issue (list and full), comment, connection', () => {
  const m = L.mapIssue(ISSUE());
  assert.deepEqual(m, {
    id: ISSUE().id, identifier: 'ENG-42', title: 'Fix the flux capacitor', url: 'https://linear.app/acme/issue/ENG-42', state: 'In Progress', stateType: 'started',
    priority: 2, priorityLabel: 'High', assignee: 'tony', team: 'ENG', project: 'Mark II', labels: ['bug'], estimate: 3, dueDate: null,
    createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-18T10:00:00.000Z',
  });
  const bare = L.mapIssue({ id: 'x', identifier: 'A-1', title: 't', url: 'u' });
  assert.deepEqual([bare.state, bare.assignee, bare.team, bare.labels], [null, null, null, []]);
  const full = L.mapIssue({ ...ISSUE(), description: 'x'.repeat(25000), comments: { nodes: [{ id: 'c', body: 'b', user: { name: 'N' } }] }, children: { nodes: [{ identifier: 'ENG-43', title: 'sub', state: { name: 'Todo' } }] } }, { full: true });
  assert.match(full.description, /…\[truncated 5000 chars\]$/);
  assert.deepEqual(full.comments, [{ id: 'c', author: 'N', body: 'b', url: null, createdAt: null }]);
  assert.deepEqual(full.children, [{ identifier: 'ENG-43', title: 'sub', state: 'Todo' }]);
  assert.deepEqual(L.mapIssueList({ nodes: [ISSUE()], pageInfo: { hasNextPage: true, endCursor: 'c9' } }).next, 'c9');
  assert.deepEqual(L.mapIssueList(null), { issues: [], hasMore: false, next: null });
});

test('errors: auth, rate limit, not found, validation, HTTP and empty answers', () => {
  assert.equal(L.responseError(200, { data: {} }), null);
  assert.equal(L.responseError(401, {}).code, 'unauthorized');
  assert.equal(L.responseError(400, { errors: [{ message: 'x', extensions: { code: 'AUTHENTICATION_ERROR' } }] }).code, 'unauthorized');
  assert.equal(L.responseError(429, {}).code, 'rate_limited');
  assert.equal(L.responseError(400, { errors: [{ message: 'x', extensions: { code: 'RATELIMITED' } }] }).status, 429);
  const nf = L.responseError(200, { data: null, errors: [{ message: 'Entity not found: Issue', extensions: { userPresentableMessage: 'Could not find referenced Issue.' } }] });
  assert.deepEqual([nf.code, nf.status, nf.message], ['not_found', 404, 'Linear: Could not find referenced Issue.']);
  assert.equal(L.responseError(400, { errors: [{ message: 'Argument Validation Error' }] }).code, 'bad_request');
  assert.equal(L.responseError(503, null).code, 'linear_error');
  assert.equal(L.responseError(200, { nope: 1 }).code, 'linear_error');
  assert.match(L.pickNamed([{ id: '1', name: 'Todo' }], 'todo', { what: 'state' }).name, /Todo/);
  assert.throws(() => L.pickNamed([{ id: '1', name: 'Todo' }], 'Doing', { what: 'state' }), /no state "Doing" — choose one of: Todo/);
});

// ---------------------------------------------------------------- the service against a fake Linear

test('service: not configured → a clear status, and no request is made', async () => {
  const { svc, calls } = svcWith({ settings: {} });
  const s = await svc.status();
  assert.deepEqual([s.configured, s.reachable, s.source], [false, false, null]);
  assert.match(s.message, /not configured/);
  await assert.rejects(svc.listIssues({}), (e) => e.code === 'not_configured' && e.status === 409);
  assert.equal(calls.length, 0);
});

test('service: status uses the key, says who and which teams; LINEAR_API_KEY works too; a bad key is reported, not echoed', async () => {
  const { svc, calls } = svcWith();
  const s = await svc.status();
  assert.deepEqual([s.configured, s.reachable, s.source, s.user, s.organization, s.teams], [true, true, 'config', { name: 'tony', email: 'tony@acme.test' }, { name: 'Acme', urlKey: 'acme' }, [{ key: 'ENG', name: 'Engineering' }]]);
  assert.equal(calls[0].auth, KEY);
  noKey(s, 'status');
  const viaEnv = svcWith({ settings: {}, env: { LINEAR_API_KEY: ENV_KEY_VALUE }, key: ENV_KEY_VALUE });
  assert.deepEqual([(await viaEnv.svc.status()).reachable, (await viaEnv.svc.status()).source], [true, 'env']);
  const wrong = svcWith({ key: ['lin', 'api', 'somethingElseEntirely00'].join('_') });
  const w = await wrong.svc.status();
  assert.deepEqual([w.configured, w.reachable, w.code], [true, false, 'unauthorized']);
  assert.match(w.error, /rejected the API key/);
  noKey(w, 'a failed status');
});

test('service: a network error that carries the key is redacted', async () => {
  const svc = L.createLinearService({ cfg: () => ({ linear: { apiKey: KEY } }), env: {}, fetchImpl: async () => { throw new Error(`connect ECONNREFUSED (sent ${KEY})`); } });
  const s = await svc.status();
  assert.equal(s.reachable, false);
  assert.match(s.error, /not reachable/);
  noKey(s, 'a network error');
  await assert.rejects(svc.getIssue('ENG-1'), (e) => { noKey(e.message, 'a thrown error'); return e.code === 'unreachable'; });
});

test('service: list, search (and its fallback), read one issue', async () => {
  const { svc, calls } = svcWith();
  const l = await svc.listIssues({ team: 'ENG', assignee: 'me' });
  assert.deepEqual([l.issues[0].identifier, l.hasMore, l.next], ['ENG-42', true, 'cur-1']);
  assert.equal(calls.at(-1).op, 'RigsIssues');
  assert.deepEqual(calls.at(-1).variables.filter.and[2], { assignee: { isMe: { eq: true } } });
  assert.equal((await svc.searchIssues({ query: 'flux' })).issues[0].identifier, 'ENG-7');
  const old = svcWith({ search: false });
  const fb = await old.svc.searchIssues({ query: 'flux' });
  assert.deepEqual(old.calls.map((c) => c.op), ['RigsSearch', 'RigsIssues'], 'falls back to a title/description filter');
  assert.deepEqual(old.calls[1].variables.filter.and[0].or[0], { title: { containsIgnoreCase: 'flux' } });
  assert.equal(fb.issues[0].identifier, 'ENG-42');
  const one = await svc.getIssue('eng-42');
  assert.deepEqual([one.identifier, one.description, one.comments[0].body, one.creator], ['ENG-42', 'It needs 1.21 gigawatts.', 'On it.', 'Pepper']);
  await assert.rejects(svc.getIssue('ENG-404'), (e) => e.code === 'not_found' && e.status === 404);
  await assert.rejects(svc.getIssue('nope'), (e) => e.code === 'bad_request');
});

test('service: create / update / comment resolve names to ids and only write when called', async () => {
  const { svc, calls } = svcWith();
  await svc.status(); await svc.listIssues({}); await svc.getIssue('ENG-42');
  assert.ok(!calls.some((c) => /Create|Update|Comment/.test(c.op)), 'reads never write');

  const c = await svc.createIssue({ team: 'eng', title: 'Repulsor misfires', description: 'Left hand.', state: 'todo', assignee: 'Pepper', labels: ['bug', 'UI'], project: 'mark ii', priority: 'high' });
  assert.deepEqual([c.created, c.issue.identifier, c.issue.title], [true, 'ENG-43', 'Repulsor misfires']);
  const create = calls.find((x) => x.op === 'RigsIssueCreate');
  assert.deepEqual(create.variables.input, { title: 'Repulsor misfires', description: 'Left hand.', priority: 2, teamId: TEAM.id, stateId: 's-todo', assigneeId: 'u-pepper', projectId: 'p-mk2', labelIds: ['l-bug', 'l-ui'] });
  await assert.rejects(svc.createIssue({ title: 'x' }), /team is required/);
  await assert.rejects(svc.createIssue({ team: 'NOPE', title: 'x' }), /no team "NOPE" — choose one of: ENG, OPS/);
  await assert.rejects(svc.createIssue({ team: 'ENG', title: 'x', state: 'Doing' }), /no state "Doing"/);

  calls.length = 0;
  const u = await svc.updateIssue({ id: 'ENG-42', state: 'In Review', assignee: 'me' });
  assert.equal(u.updated, true);
  const upd = calls.find((x) => x.op === 'RigsIssueUpdate');
  assert.deepEqual(upd.variables, { id: ISSUE().id, input: { stateId: 's-review', assigneeId: 'u-me' } });
  await assert.rejects(svc.updateIssue({ id: 'ENG-42' }), /nothing to change/);
  await assert.rejects(svc.updateIssue({ id: 'ENG-404', title: 'x' }), (e) => e.code === 'not_found');

  calls.length = 0;
  const cm = await svc.addComment({ id: 'ENG-42', body: 'Fixed in mark III.' });
  assert.deepEqual([cm.commented, cm.issue, cm.comment.body], [true, 'ENG-42', 'Fixed in mark III.']);
  assert.deepEqual(calls.find((x) => x.op === 'RigsComment').variables.input, { issueId: ISSUE().id, body: 'Fixed in mark III.' });
  calls.length = 0;
  await assert.rejects(svc.addComment({ id: 'ENG-42', body: '' }), /body/);
  assert.equal(calls.length, 0, 'an empty comment is refused before any request');
});

test('routes: endpoints map to the service; unknown ones are 404; config never returns the key', async () => {
  const { svc } = svcWith();
  const q = (s = '') => new URLSearchParams(s);
  const call = (method, sub, qs, b) => L.linearRoute(svc, { method, sub, q: q(qs), body: async () => b || {} });
  assert.equal((await call('GET', 'status')).reachable, true);
  assert.equal((await call('GET', 'issues', 'team=ENG&limit=5')).issues.length, 1);
  assert.equal((await call('GET', 'search', 'query=flux')).issues[0].identifier, 'ENG-7');
  assert.equal((await call('GET', 'issues/ENG-42', 'comments=0')).identifier, 'ENG-42');
  assert.equal((await call('POST', 'issues', '', { team: 'ENG', title: 'x' })).created, true);
  assert.equal((await call('POST', 'issues/ENG-42', '', { priority: 1 })).updated, true);
  assert.equal((await call('POST', 'issues/ENG-42/comments', '', { body: 'hi' })).commented, true);
  assert.deepEqual((await call('GET', 'teams')).teams.map((t) => t.key), ['ENG', 'OPS']);
  const cfg = await call('GET', 'config');
  assert.deepEqual([cfg.apiKey, cfg.configured], [{ set: true, source: 'config' }, true]);
  noKey(cfg, 'GET config');
  await assert.rejects(call('DELETE', 'issues/ENG-42'), (e) => e.status === 404);
  await assert.rejects(call('GET', 'issues/ENG-42/comments'), (e) => e.status === 404);
});

// ---------------------------------------------------------------- end to end: node + rigs mcp

test('end to end: a node with a key serves linear/*, `rigs mcp` lists the linear tools and runs them, the key never leaks', async () => {
  const fake = fakeLinear();
  const linearServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => { const [status, body] = fake.answer(req.headers, raw); res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); });
  });
  await new Promise((r) => linearServer.listen(0, '127.0.0.1', r));
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-linear-e2e-'));
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ linear: { apiKey: KEY, url: `http://127.0.0.1:${linearServer.address().port}/graphql` } }));
  const PORT = 20000 + Math.floor(Math.random() * 20000);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = { ...process.env, RIGS_NO_MIGRATIONS: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_OPENRIG: '1', RIGS_HOME: HOME, RIGS_SSH_DIR: path.join(HOME, 'ssh'), RIGS_PORT: String(PORT), RIGS_NAME: 'test-node', RIGS_PEERS: '', RIGS_MESH_TOKEN: 'test-token' };
  delete env.LINEAR_API_KEY;
  const server = spawn(process.execPath, [path.join(ROOT, 'bin/rigs.js'), 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout.on('data', (d) => { out += d; });
  server.stderr.on('data', (d) => { out += d; });
  let mcp;
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(BASE + '/api/self')).ok; } catch { await new Promise((r) => setTimeout(r, 200)); } }
    assert.ok(up, `server did not start:\n${out}`);
    // the MCP tools go through /api/nodes/self/…, which needs discovery to know this node
    let known = false;
    for (let i = 0; i < 150 && !known; i++) { known = (await fetch(`${BASE}/api/nodes/self/linear/status`)).ok; if (!known) await new Promise((r) => setTimeout(r, 200)); }
    assert.ok(known, 'discovery knows this node');

    const status = await (await fetch(`${BASE}/api/local/linear/status`)).json();
    assert.deepEqual([status.configured, status.reachable, status.organization?.name], [true, true, 'Acme']);
    const cfgRes = await (await fetch(`${BASE}/api/local/config`)).text();
    noKey(cfgRes, 'GET /api/local/config');
    const bad = await fetch(`${BASE}/api/local/linear/issues/ENG-404`);
    assert.equal(bad.status, 404);
    assert.equal((await bad.json()).code, 'not_found');

    mcp = spawn(process.execPath, [path.join(ROOT, 'bin/rigs.js'), 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const replies = new Map();
    let buf = '';
    mcp.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); replies.set(m.id, m); buf = buf.slice(i + 1); } });
    const ask = async (id, method, params) => {
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      for (let i = 0; i < 300 && !replies.has(id); i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(replies.has(id), `no MCP reply to ${method}`);
      return replies.get(id).result;
    };
    await ask(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    const names = (await ask(2, 'tools/list', {})).tools.map((t) => t.name);
    for (const t of ['linear_status', 'linear_issues', 'linear_issue', 'linear_create_issue', 'linear_update_issue', 'linear_comment']) assert.ok(names.includes(t), `${t} is in the brains' tool list`);
    const st = await ask(3, 'tools/call', { name: 'linear_status', arguments: {} });
    assert.ok(!st.isError, st.content[0].text);
    assert.equal(JSON.parse(st.content[0].text).user.name, 'tony');
    const created = await ask(4, 'tools/call', { name: 'linear_create_issue', arguments: { team: 'ENG', title: 'Made by JARVIS', priority: 'low' } });
    assert.ok(!created.isError, created.content[0].text);
    assert.equal(JSON.parse(created.content[0].text).issue.identifier, 'ENG-43');
    const searched = await ask(5, 'tools/call', { name: 'linear_issues', arguments: { query: 'flux' } });
    assert.equal(JSON.parse(searched.content[0].text).issues[0].identifier, 'ENG-7');
    const missing = await ask(6, 'tools/call', { name: 'linear_comment', arguments: { id: 'ENG-404', body: 'hi' } });
    assert.ok(missing.isError);
    assert.match(missing.content[0].text, /Could not find/);
    for (const r of replies.values()) noKey(r, 'an MCP reply');

    // clearing the key → a clear "not configured" status, through the same endpoint the CLI uses
    const cleared = await (await fetch(`${BASE}/api/local/linear/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clearKey: true }) })).json();
    assert.deepEqual([cleared.apiKey.set, cleared.configured], [false, false]);
    const off = await (await fetch(`${BASE}/api/local/linear/status`)).json();
    assert.deepEqual([off.configured, off.reachable], [false, false]);
    assert.match(off.message, /not configured/);
    const refused = await fetch(`${BASE}/api/local/linear/issues`);
    assert.equal(refused.status, 409);
  } finally {
    mcp?.kill();
    server.kill();
    linearServer.close();
  }
  await new Promise((r) => setTimeout(r, 200));
  noKey(out, 'the daemon output');
  const logs = path.join(HOME, 'logs');
  if (fs.existsSync(logs)) for (const f of fs.readdirSync(logs)) noKey(fs.readFileSync(path.join(logs, f), 'utf8'), `logs/${f}`);
});
