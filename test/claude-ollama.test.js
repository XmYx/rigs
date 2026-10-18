// "Claude via Ollama" brain: the Claude Code harness on a local Ollama model. Pure env/flag/catalog helpers, and one
// real JARVIS turn on a throwaway node whose `claude` is a fake that records how it was spawned (against a fake Ollama).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-claude-ollama-'));
Object.assign(process.env, { RIGS_HOME: path.join(TMP, 'rigs'), RIGS_NO_OPENRIG: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_MIGRATIONS: '1', RIGS_NAME: 'test-node' });
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const M = await import('../src/models.js');

test('catalog entry: its own provider, Claude Code runtime, no effort levels', () => {
  const p = M.PROVIDERS['claude-ollama'];
  assert.equal(M.CLAUDE_OLLAMA, 'claude-ollama');
  assert.deepEqual([p.label, p.runtime, p.efforts], ['Claude via Ollama', 'claude-code', []]);
  assert.ok(M.PROVIDERS.claude.efforts.length, 'the Claude entry is untouched');
});

test('claudeOllamaUrl: the claudeOllama override, else the ollama brain URL, else localhost; no trailing slash', () => {
  assert.equal(M.claudeOllamaUrl({ ollamaUrl: 'http://10.0.0.5:11434/', claudeOllama: { url: '' } }), 'http://10.0.0.5:11434');
  assert.equal(M.claudeOllamaUrl({ ollamaUrl: 'http://10.0.0.5:11434', claudeOllama: { url: 'http://gpu:1234//' } }), 'http://gpu:1234');
  assert.equal(M.claudeOllamaUrl({}), 'http://localhost:11434');
});

test('claudeOllamaEnv: Ollama as the endpoint, a dummy token, every real credential blanked', () => {
  const env = M.claudeOllamaEnv({ url: 'http://localhost:11434/', model: 'glm-4.7-flash:latest' });
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://localhost:11434');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'ollama');
  assert.equal(env.ANTHROPIC_API_KEY, '');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, '');
  // side calls (titles, summaries) must not ask Ollama for "haiku"
  for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']) assert.equal(env[k], 'glm-4.7-flash:latest', k);
  // merged over a process environment that holds real keys, none survives
  const merged = { ...{ ANTHROPIC_API_KEY: 'sk-ant-api03-REAL', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-REAL', ANTHROPIC_AUTH_TOKEN: 'real', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, ...env };
  assert.ok(!JSON.stringify(merged).includes('REAL') && !JSON.stringify(merged).includes('"real"'), JSON.stringify(merged));
  assert.equal(merged.ANTHROPIC_BASE_URL, 'http://localhost:11434');
  assert.ok(!('ANTHROPIC_MODEL' in M.claudeOllamaEnv({ url: 'http://x' })), 'no model, no model env');
});

test('claudeOllamaFlags: --model only (no --effort, no permission flag of its own)', () => {
  assert.deepEqual(M.claudeOllamaFlags({ model: 'qwen3-coder:30b', effort: 'high', permissionMode: 'auto' }), ['--model', 'qwen3-coder:30b']);
  assert.deepEqual(M.claudeOllamaFlags({}), []);
});

test('pickClaudeOllamaModel: a tool-capable model if one is installed, else the first that can chat', () => {
  const models = [{ name: 'moondream', capabilities: ['completion', 'vision'] }, { name: 'embed', capabilities: ['embedding'] }, { name: 'glm', capabilities: ['completion', 'tools', 'thinking'] }, { name: 'aya', capabilities: ['completion'] }];
  assert.equal(M.pickClaudeOllamaModel(models), 'glm');
  assert.equal(M.pickClaudeOllamaModel(models.filter((m) => m.name !== 'glm')), 'moondream');
  assert.equal(M.pickClaudeOllamaModel([{ name: 'old' }]), 'old', 'an Ollama that reports no capabilities');
  assert.equal(M.pickClaudeOllamaModel([]), '');
});

test('claudeOllamaStatus: says exactly why it cannot run', () => {
  const ok = { claude: true, ollama: true, url: 'http://localhost:11434', models: [{ name: 'a' }] };
  assert.deepEqual(M.claudeOllamaStatus(ok), { available: true, reason: '' });
  assert.match(M.claudeOllamaStatus({ ...ok, claude: false }).reason, /claude CLI is not installed/);
  const down = M.claudeOllamaStatus({ ...ok, ollama: false });
  assert.equal(down.available, false);
  assert.match(down.reason, /not reachable at http:\/\/localhost:11434/);
  assert.match(M.claudeOllamaStatus({ ...ok, models: [] }).reason, /no models/);
  assert.match(M.claudeOllamaStatus({ ...ok, model: 'gone' }).warning, /gone is not installed/);
});

// -------------------------------------------------------------------- a real turn through the server

// A fake `claude`: records argv and the credential/endpoint env it was started with, then streams a one-line reply.
const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('9.9.9 (fake)'); process.exit(0); }
const env = {};
for (const k of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_CODE_)/.test(k)) env[k] = process.env[k];
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, env }) + '\n');
const out = (e) => process.stdout.write(JSON.stringify(e) + '\n');
out({ type: 'system', subtype: 'init', session_id: 'local-session' });
out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Running locally, sir.' } } });
out({ type: 'result', subtype: 'success', is_error: false, result: 'Running locally, sir.', session_id: 'local-session', total_cost_usd: 0.42,
  usage: { input_tokens: 7, output_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  modelUsage: { 'glm-4.7-flash:latest': { inputTokens: 7, outputTokens: 9, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.42 } } });
`;

test('API: a turn on Claude via Ollama spawns claude against Ollama only, traces it and files it at zero cost', { skip: process.platform === 'win32' && 'the fake claude is a POSIX script' }, async () => {
  const HOME = path.join(TMP, 'node');
  const BIN = path.join(TMP, 'bin');
  fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
  fs.mkdirSync(BIN, { recursive: true });
  fs.writeFileSync(path.join(BIN, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  const settings = '{"model":"opus","env":{"KEEP":"me"}}\n';
  fs.writeFileSync(path.join(HOME, '.claude', 'settings.json'), settings);
  const calls = path.join(TMP, 'calls.jsonl');

  const ollama = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ models: [
      { name: 'moondream:latest', details: { family: 'phi2', parameter_size: '1B' }, capabilities: ['completion', 'vision'] },
      { name: 'glm-4.7-flash:latest', details: { family: 'glm', parameter_size: '29.9B' }, capabilities: ['completion', 'tools', 'thinking'] },
    ] }));
  });
  await new Promise((r) => ollama.listen(0, '127.0.0.1', r));
  const OLLAMA = `http://127.0.0.1:${ollama.address().port}`;

  const PORT = 20000 + Math.floor(Math.random() * 20000);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env, HOME, RIGS_HOME: path.join(HOME, '.rigs'), RIGS_SSH_DIR: path.join(HOME, 'ssh'), RIGS_CLAUDE_DIR: path.join(HOME, 'claude'), RIGS_CODEX_DIR: path.join(HOME, 'codex'),
    RIGS_PORT: String(PORT), RIGS_NAME: 'test-node', RIGS_PEERS: '', RIGS_MESH_TOKEN: 'test-token', RIGS_OLLAMA_URL: OLLAMA, PATH: `${BIN}${path.delimiter}${process.env.PATH}`,
    FAKE_CLAUDE_LOG: calls, ANTHROPIC_API_KEY: 'sk-ant-api03-REALKEYREALKEY', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-REALTOKEN',
  };
  const server = spawn(process.execPath, [path.join(ROOT, 'bin/rigs.js'), 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  const get = async (p) => (await fetch(BASE + p)).json();
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(BASE + '/api/self')).ok; } catch {} if (!up) await new Promise((r) => setTimeout(r, 200)); }
    assert.ok(up, 'server did not start:\n' + log);

    // settings sees it, with the installed models, a tool-capable default and an availability state
    const brain = (await get('/api/local/brains')).find((b) => b.id === 'claude-ollama');
    assert.ok(brain, 'listed');
    assert.deepEqual([brain.label, brain.available, brain.default, brain.models, brain.toolModels, brain.url], ['Claude via Ollama', true, 'glm-4.7-flash:latest', ['moondream:latest', 'glm-4.7-flash:latest'], ['glm-4.7-flash:latest'], OLLAMA]);

    // choosing it as the core brain persists the choice and the model
    const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    await post('/api/local/brain/core', { provider: 'claude-ollama', model: 'glm-4.7-flash:latest', effort: '' });
    assert.equal((await get('/api/local/brain/core')).provider, 'claude-ollama');
    assert.equal((await get('/api/local/config')).brain.claudeOllama.model, 'glm-4.7-flash:latest');

    const res = await post('/api/local/jarvis/send', { text: 'are you local?', brain: 'claude-ollama', preroute: false });
    const events = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const done = events.find((e) => e.type === 'done');
    assert.equal(done?.text, 'Running locally, sir.', JSON.stringify(events) + log);
    assert.deepEqual([done.brain, done.model], ['claude-ollama', 'glm-4.7-flash:latest']);

    // how claude was started: Ollama endpoint, dummy token, the model, no real credential anywhere
    const [spawned] = fs.readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(spawned.args[spawned.args.indexOf('--model') + 1], 'glm-4.7-flash:latest');
    assert.ok(!spawned.args.includes('--effort'));
    assert.equal(spawned.env.ANTHROPIC_BASE_URL, OLLAMA);
    assert.equal(spawned.env.ANTHROPIC_AUTH_TOKEN, 'ollama');
    assert.equal(spawned.env.ANTHROPIC_API_KEY, '');
    assert.equal(spawned.env.CLAUDE_CODE_OAUTH_TOKEN, '');
    assert.ok(!JSON.stringify(spawned).includes('REALKEY') && !JSON.stringify(spawned).includes('REALTOKEN'));
    assert.equal(fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8'), settings, 'the global Claude settings are untouched');
    assert.ok(!fs.existsSync(path.join(HOME, '.claude.json')), 'no Claude state was written by RIGS');

    // the trace span and the usage ledger
    const traceId = events.find((e) => e.type === 'trace')?.traceId;
    const t = await get(`/api/local/traces/${traceId}`);
    const turn = t.spans.find((s) => s.kind === 'brain-turn');
    assert.deepEqual([turn.meta.provider, turn.meta.model, turn.meta.costUsd, turn.meta.inputTokens, turn.meta.endpoint], ['claude-ollama', 'glm-4.7-flash:latest', 0, 7, OLLAMA]);
    assert.equal(turn.name, 'claude-ollama glm-4.7-flash:latest');
    const month = new Date().toISOString().slice(0, 7);
    const ledger = fs.readFileSync(path.join(HOME, '.rigs', 'usage', `${month}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.kind === 'chat-turn');
    assert.deepEqual(ledger.map((r) => [r.provider, r.model, r.costUsd, r.inputTokens, r.outputTokens]), [['claude-ollama', 'glm-4.7-flash:latest', 0, 7, 9]]);

    // a second turn resumes its own Claude session, not a Claude-API one
    const again = await post('/api/local/jarvis/send', { text: 'and again', brain: 'claude-ollama', preroute: false });
    await again.text();
    const second = fs.readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l))[1];
    assert.equal(second.args[second.args.indexOf('--resume') + 1], 'local-session');

    // a model Ollama does not have is refused clearly, without starting claude
    const bad = await post('/api/local/jarvis/send', { text: 'x', brain: 'claude-ollama', model: 'nope:1b', preroute: false });
    const badEvents = (await bad.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const msg = badEvents.find((e) => e.type === 'error')?.message || JSON.stringify(badEvents);
    assert.match(msg, /nope:1b is not installed in Ollama/);
    assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 2);
  } finally {
    server.kill();
    ollama.close();
  }
});
