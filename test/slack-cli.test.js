import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSlackArgs, slackTools } from '../src/connectors/slack-cli.js';

test('status / channels / history / search parse to GET routes', () => {
  assert.equal(parseSlackArgs(['status']).path, '/api/local/connectors/slack/status');
  assert.equal(parseSlackArgs(['status', '--no-check']).path, '/api/local/connectors/slack/status?check=0');
  assert.equal(parseSlackArgs(['channels', '--limit', '20']).path, '/api/local/connectors/slack/channels?limit=20');
  const h = parseSlackArgs(['history', '#general', '--limit=5', '--since', '2026-10-18']);
  assert.equal(h.method, 'GET');
  assert.equal(h.path, '/api/local/connectors/slack/history?channel=%23general&limit=5&oldest=2026-10-18');
  assert.equal(parseSlackArgs(['search', 'deploy', 'failed', '--count', '3']).path, '/api/local/connectors/slack/search?query=deploy+failed&count=3');
});

test('missing arguments and unknown subcommands are errors with usage', () => {
  for (const a of [[], ['nope'], ['history'], ['search'], ['post', '#x']]) assert.match(parseSlackArgs(a).error, /usage:/);
});

test('post needs --confirm and sends confirm: true', () => {
  const refused = parseSlackArgs(['post', '#general', 'hello', 'team']);
  assert.match(refused.error, /--confirm/);
  assert.equal(refused.path, undefined);
  const ok = parseSlackArgs(['post', '#general', 'hello', 'team', '--confirm', '--thread', '1.2']);
  assert.deepEqual(ok, { method: 'POST', path: '/api/local/connectors/slack/post', body: { channel: '#general', text: 'hello team', thread_ts: '1.2', confirm: true } });
});

test('JARVIS tools are read-only, well-formed and call the read routes', async () => {
  const calls = [];
  const tools = slackTools(async (p) => { calls.push(p); return {}; });
  assert.deepEqual(tools.map((t) => t.name), ['slack_status', 'slack_channels', 'slack_history', 'slack_search']);
  assert.ok(!tools.some((t) => /post|send|write/.test(t.name)));
  for (const t of tools) { assert.ok(t.description && t.inputSchema.type === 'object' && typeof t.run === 'function'); }
  assert.deepEqual(tools.find((t) => t.name === 'slack_history').inputSchema.required, ['channel']);
  await tools.find((t) => t.name === 'slack_history').run({ channel: 'general', since: '2026-10-18' });
  await tools.find((t) => t.name === 'slack_search').run({ query: 'x' });
  assert.deepEqual(calls, ['/api/local/connectors/slack/history?channel=general&oldest=2026-10-18', '/api/local/connectors/slack/search?query=x']);
});
