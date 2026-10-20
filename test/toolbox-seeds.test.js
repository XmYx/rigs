// Seed tools (tools/<id>/ in the checkout): every manifest is valid and declares a smoke check that passes, the
// registry loads seeds next to RIGS_HOME/tools without writing into the checkout, and each tool does its job against
// small fake services (no ComfyUI, GPU, Unity or daemon needed). Chrome and ffmpeg parts skip when not installed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEEDS = path.join(ROOT, 'tools');
process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-seeds-'));
process.env.RIGS_NAME = 'box';
delete process.env.RIGS_SEED_TOOLS;
process.env.RIGS_ADHOC_TOOLS = path.join(process.env.RIGS_HOME, 'adhoc'); // filed tools go here, never into the checkout's tools/local
const T = await import('../src/toolbox.js');
const { validateApp } = await import('../src/apps.js');

// tools/local is this machine's gitignored ad-hoc folder, not a seed.
const seedIds = fs.readdirSync(SEEDS, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== T.ADHOC_DIR).map((d) => d.name).sort();
const manifestOf = (id) => JSON.parse(fs.readFileSync(path.join(SEEDS, id, 'manifest.json'), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-seed-t-'));
const run = async (id, args) => { const r = await T.runTool(id, { args, allowMutating: true, cwd: tmp() }); return r.result; };
const serve = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}`, port: s.address().port })); });
const closed = async () => { const { s, port } = await serve(() => {}); await new Promise((r) => s.close(r)); return port; };
const which = (n) => { try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', [n], { encoding: 'utf8' }).split('\n')[0].trim() || null; } catch { return null; } };

test('there are at least 6 seed tools and each folder is a valid tool', () => {
  assert.ok(seedIds.length >= 6, `only ${seedIds.length} seeds`);
  for (const id of seedIds) {
    const raw = manifestOf(id);
    const { manifest, errors } = T.validateManifest(raw);
    assert.deepEqual(errors, [], id);
    assert.equal(manifest.id, id, `${id}: id matches its folder`);
    assert.ok(fs.existsSync(path.join(SEEDS, id, manifest.entry)), `${id}: entry file exists`);
    assert.ok(manifest.tags.length >= 3, `${id}: at least 3 tags so search finds it`);
    assert.ok(manifest.description.length >= 80, `${id}: description says what it does and when to use it`);
    assert.ok(manifest.smoke?.args, `${id}: declares a smoke check`);
    assert.equal(manifest.language, 'node', `${id}: node runs everywhere RIGS does`);
    assert.equal(manifest.adhoc, undefined, `${id}: a seed carries no ad-hoc block`);
    const files = Object.fromEntries(fs.readdirSync(path.join(SEEDS, id)).filter((f) => f !== 'manifest.json').map((f) => [f, fs.readFileSync(path.join(SEEDS, id, f))]));
    assert.deepEqual(T.seedProblems(manifest, files), [], `${id}: the rules promotion checks (toolbox.seedProblems)`);
  }
});

test('seed files hold no secrets', () => {
  const secret = /sk-[A-Za-z0-9]{16,}|(?:token|password|secret|api[_-]?key)["']?\s*[:=]\s*["'][^"'\s]{8,}|Bearer\s+[A-Za-z0-9._-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY/i;
  for (const id of seedIds) for (const f of fs.readdirSync(path.join(SEEDS, id))) assert.doesNotMatch(fs.readFileSync(path.join(SEEDS, id, f), 'utf8'), secret, `${id}/${f}`);
});

test('seed sources have no BOM or CRLF', () => {
  for (const id of seedIds) for (const f of fs.readdirSync(path.join(SEEDS, id))) {
    const buf = fs.readFileSync(path.join(SEEDS, id, f));
    assert.notEqual(buf.subarray(0, 3).toString('hex'), 'efbbbf', `${id}/${f} has a BOM`);
    assert.equal(buf.includes('\r\n'), false, `${id}/${f} has CRLF`);
  }
});

test('the registry loads the seeds next to RIGS_HOME/tools and search finds them', async () => {
  const l = await T.listLocal();
  assert.deepEqual(l.errors, []);
  for (const id of seedIds) assert.equal(l.tools.find((t) => t.id === id)?.seed, true, `${id} listed as a seed`);
  assert.equal(T.searchCatalog(l.tools, { q: 'screenshot' })[0].id, 'cdp-screenshot');
  assert.equal(T.searchCatalog(l.tools, { q: 'vram lease' })[0].id, 'gpu-lease');
  assert.equal(T.searchCatalog(l.tools, { q: 'ffmpeg contact sheet' })[0].id, 'ffmpeg-frames');
  assert.equal(T.searchCatalog(l.tools, { tag: 'unity' })[0].id, 'unity-compile-check');
  assert.equal(T.searchCatalog(l.tools, { q: 'publish app app-cloud' })[0].id, 'app-publish');
});

test('every seed passes its smoke check, which leaves the checkout and usage counts alone', async () => {
  const before = Object.fromEntries(seedIds.map((id) => [id, fs.readFileSync(path.join(SEEDS, id, 'manifest.json'), 'utf8')]));
  for (const id of seedIds) { const r = await T.smokeTool(id); assert.equal(r.ok, true, `${id}: ${r.problem}`); }
  for (const id of seedIds) assert.equal(fs.readFileSync(path.join(SEEDS, id, 'manifest.json'), 'utf8'), before[id], `${id} manifest untouched`);
  assert.equal(fs.existsSync(path.join(process.env.RIGS_HOME, 'tools', '.usage.json')), false);
});

test('running a seed counts its use in RIGS_HOME, never in the seed folder; a filed tool with the same id overrides it', async () => {
  const seedManifest = fs.readFileSync(path.join(SEEDS, 'healthz-wait', 'manifest.json'), 'utf8');
  const { s, url } = await serve((q, r) => r.end('ok'));
  try {
    assert.equal((await run('healthz-wait', { url })).ok, true);
    assert.equal((await run('healthz-wait', { url })).ok, true);
  } finally { s.close(); }
  assert.equal(fs.readFileSync(path.join(SEEDS, 'healthz-wait', 'manifest.json'), 'utf8'), seedManifest, 'seed manifest not rewritten');
  const usage = JSON.parse(fs.readFileSync(path.join(process.env.RIGS_HOME, 'tools', '.usage.json'), 'utf8'));
  assert.equal(usage['healthz-wait'].uses, 2);
  assert.equal((await T.listLocal()).tools.find((t) => t.id === 'healthz-wait').uses, 2);
  await T.registerTool({ id: 'healthz-wait', name: 'Mine', description: 'A local override of the seed tool, for tests.', language: 'node', entry: 'main.js', safety: 'read-only', source: 'console.log(JSON.stringify({ mine: true }))' });
  const l = await T.listLocal();
  assert.equal(l.tools.find((t) => t.id === 'healthz-wait').name, 'Mine');
  assert.equal(l.tools.find((t) => t.id === 'healthz-wait').seed, undefined);
  assert.deepEqual((await T.runTool('healthz-wait')).result, { mine: true });
  fs.rmSync(path.join(process.env.RIGS_ADHOC_TOOLS, 'healthz-wait'), { recursive: true });
});

test('smoke field: validated, matched as a subset, reported when a tool has none or fails', async () => {
  const base = { id: 'sm', name: 'Smoke', description: 'Prints a fixed JSON object, for tests.', language: 'node', entry: 'main.js', safety: 'read-only' };
  assert.match(T.validateManifest({ ...base, smoke: { args: 'x' } }).errors.join(), /smoke must be/);
  assert.deepEqual(T.validateManifest({ ...base, smoke: { args: { a: 1 }, expect: { ok: true } } }).manifest.smoke, { args: { a: 1 }, expect: { ok: true } });
  assert.equal(T.containsSubset({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 2 } }), true);
  assert.equal(T.containsSubset({ a: 1 }, { a: 2 }), false);
  assert.equal(T.containsSubset('x', { a: 1 }), false);
  const src = 'console.log(JSON.stringify({ ok: true, n: 2 }))';
  await T.registerTool({ ...base, source: src });
  assert.equal((await T.smokeTool('sm')).skipped, true);
  await T.registerTool({ ...base, source: src, smoke: { args: {}, expect: { n: 2 } } });
  assert.equal((await T.smokeTool('sm')).ok, true);
  await T.registerTool({ ...base, source: src, smoke: { args: {}, expect: { n: 3 } } });
  assert.match((await T.smokeTool('sm')).problem, /does not contain/);
  await T.registerTool({ ...base, source: 'process.exit(3)', smoke: { args: {} } });
  assert.match((await T.smokeTool('sm')).problem, /exit 3/);
  fs.rmSync(path.join(process.env.RIGS_ADHOC_TOOLS, 'sm'), { recursive: true });
});

test('usage-transcript-parse: totals, dedup, no message text; ledger grouping', async () => {
  const d = tmp();
  const a = (id, model, u, content, at) => ({ type: 'assistant', timestamp: at, sessionId: 's1', message: { id, model, usage: u, content } });
  const lines = [
    { type: 'user', timestamp: '2026-10-18T10:00:00Z', sessionId: 's1', message: { content: 'SECRET-PASTED-PASSWORD hunter2' } },
    a('m1', 'claude-opus-5-5', { input_tokens: 5, output_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 10 }, [{ type: 'text', text: 'SECRET-REPLY' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }], '2026-10-18T10:00:01Z'),
    a('m1', 'claude-opus-5-5', { input_tokens: 5, output_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 10 }, [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }], '2026-10-18T10:00:02Z'),
    a('m2', 'claude-sonnet-5-5', { input_tokens: 1, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, [], '2026-10-18T10:05:00Z'),
  ];
  fs.writeFileSync(path.join(d, 's.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\nnot json\n`);
  const r = await run('usage-transcript-parse', { path: path.join(d, 's.jsonl') });
  assert.equal(r.ok, true);
  assert.deepEqual(r.totals, { messages: 2, input: 6, output: 107, cacheRead: 2000, cacheWrite: 10 });
  assert.deepEqual(r.toolCalls, { Bash: 1, Read: 1 });
  assert.equal(r.skipped, 1);
  assert.equal(r.firstAt, '2026-10-18T10:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(r), /SECRET|hunter2/);
  const ledger = [{ model: 'm-a', inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, durationMs: 10, costUsd: 0.5, tsStart: 1792325559599 }, { model: 'm-a', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, durationMs: 5, tsStart: 1792325559599 }];
  fs.writeFileSync(path.join(d, '2026-10.jsonl'), ledger.map((l) => JSON.stringify(l)).join('\n'));
  const g = await run('usage-transcript-parse', { path: path.join(d, '2026-10.jsonl') });
  assert.deepEqual(g.groups['m-a'], { runs: 2, inputTokens: 2, outputTokens: 3, cacheReadTokens: 3, cacheWriteTokens: 4, durationMs: 15, costUsd: 0.5 });
  assert.equal((await run('usage-transcript-parse', { path: path.join(d, 'nope.jsonl') })).ok, false);
});

test('healthz-wait: waits for a late server, honours strict, and gives up with the last error', async () => {
  const port = await closed();
  const late = http.createServer((q, r) => { r.statusCode = q.url === '/login' ? 401 : 200; r.end('ok'); });
  setTimeout(() => late.listen(port, '127.0.0.1'), 700);
  try {
    const up = await run('healthz-wait', { url: `http://127.0.0.1:${port}/healthz`, timeoutSec: 10, intervalMs: 200 });
    assert.equal(up.ok, true);
    assert.ok(up.attempts > 1, 'it waited');
    assert.equal((await run('healthz-wait', { url: `http://127.0.0.1:${port}/login`, timeoutSec: 5 })).ok, true, 'a 401 still means up');
    const strict = await run('healthz-wait', { url: `http://127.0.0.1:${port}/login`, timeoutSec: 1, intervalMs: 200, strict: true });
    assert.equal(strict.ok, false);
    assert.equal(strict.status, 401);
  } finally { late.close(); }
  const down = await run('healthz-wait', { url: `http://127.0.0.1:${await closed()}/`, timeoutSec: 1, intervalMs: 200 });
  assert.equal(down.ok, false);
  assert.equal(down.lastError, 'ECONNREFUSED');
});

test('comfyui-client reads only: stats, models, graph check; it never POSTs and never prints the auth value', async () => {
  const seen = [];
  const info = { CheckpointLoaderSimple: { input: { required: { ckpt_name: [['a.safetensors', 'b.safetensors']] } } }, CLIPTextEncode: { input: { required: { text: ['STRING'], clip: ['CLIP'] } } } };
  const { s, url } = await serve((q, r) => {
    seen.push(`${q.method} ${q.url} ${q.headers['x-comfy-key'] || ''}`);
    r.setHeader('content-type', 'application/json');
    const m = /^\/object_info\/(\w+)/.exec(q.url);
    if (q.method !== 'GET') { r.statusCode = 405; return r.end('{}'); }
    if (q.url === '/system_stats') return r.end(JSON.stringify({ system: { comfyui_version: '9.9' }, devices: [{ name: 'gpu0', type: 'cuda', vram_total: 8 * 1073741824, vram_free: 3 * 1073741824 }] }));
    if (q.url === '/queue') return r.end(JSON.stringify({ queue_running: [1], queue_pending: [1, 2] }));
    if (m) return r.end(JSON.stringify(info[m[1]] ? { [m[1]]: info[m[1]] } : {}));
    r.statusCode = 404; r.end('{}');
  });
  process.env.COMFYUI_AUTH_HEADER = 'X-Comfy-Key: s3cr3t-value-123';
  try {
    const st = await run('comfyui-client', { action: 'stats', url });
    assert.deepEqual(st.devices, [{ name: 'gpu0', type: 'cuda', vramTotalMb: 8192, vramFreeMb: 3072 }]);
    assert.equal(st.version, '9.9');
    assert.deepEqual((await run('comfyui-client', { action: 'queue', url })), { ok: true, url, running: 1, pending: 2 });
    assert.deepEqual((await run('comfyui-client', { action: 'choices', url, nodeType: 'CheckpointLoaderSimple', input: 'ckpt_name' })).choices, ['a.safetensors', 'b.safetensors']);
    const good = { 1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.safetensors' } }, 2: { class_type: 'CLIPTextEncode', inputs: { text: 'x', clip: ['1', 1] } } };
    assert.equal((await run('comfyui-client', { action: 'check', url, workflow: good })).ok, true);
    const bad = await run('comfyui-client', { action: 'check', url, workflow: { 1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'gone.safetensors' } }, 2: { class_type: 'Nope', inputs: {} } } });
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.missingNodes, [{ node: '2', class_type: 'Nope' }]);
    assert.deepEqual(bad.badValues[0].choices, ['a.safetensors', 'b.safetensors']);
    const dead = await run('comfyui-client', { action: 'stats', url: `http://127.0.0.1:${await closed()}` });
    assert.equal(dead.ok, false);
    assert.doesNotMatch(JSON.stringify(dead), /s3cr3t/);
  } finally { s.close(); delete process.env.COMFYUI_AUTH_HEADER; }
  assert.ok(seen.every((l) => l.startsWith('GET ')), `only GETs: ${seen.join(' | ')}`);
  assert.ok(!seen.some((l) => l.includes('/prompt')), 'never touched /prompt');
  assert.ok(seen.every((l) => l.endsWith('s3cr3t-value-123')), 'the auth header was sent');
});

test('gpu-lease: acquire and release send the overseer API calls; no overseer is reported, not thrown', async () => {
  const calls = [];
  const { s, url } = await serve((q, r) => {
    let b = ''; q.on('data', (d) => { b += d; });
    q.on('end', () => { calls.push(`${q.method} ${q.url} ${b}`); r.setHeader('content-type', 'application/json'); r.end(q.url === '/api/acquire' ? JSON.stringify({ ok: true, free_mb: 20000, unloaded: ['other'] }) : '{"ok":true}'); });
  });
  try {
    const a = await run('gpu-lease', { action: 'acquire', needMb: 18000, url });
    assert.deepEqual(a, { ok: true, freeMb: 20000, unloaded: ['other'], client: 'comfyui', needMb: 18000 });
    assert.equal((await run('gpu-lease', { action: 'release', url })).released, 'comfyui');
    assert.equal((await run('gpu-lease', { action: 'status', url })).overseer, 'up');
  } finally { s.close(); }
  assert.deepEqual(calls.map((c) => c.split(' ').slice(0, 2).join(' ')), ['POST /api/acquire', 'POST /api/release', 'GET /healthz']);
  assert.deepEqual(JSON.parse(calls[0].slice(calls[0].indexOf('{'))), { client: 'comfyui', need_mb: 18000, timeout: 90 });
  const none = await run('gpu-lease', { action: 'acquire', needMb: 1000, url: `http://127.0.0.1:${await closed()}` });
  assert.equal(none.ok, false);
  assert.equal(none.unreachable, true);
  assert.equal((await run('gpu-lease', { action: 'acquire', url })).ok, false, 'needMb is required');
});

test('ffmpeg-frames: dry run prints the commands; real probe, frames and sheet when ffmpeg is installed', async (t) => {
  const plan = await run('ffmpeg-frames', { action: 'frames', input: 'clip.mp4', timestamps: [0, 2.5], width: 320, outDir: '/tmp/o', dryRun: true });
  assert.equal(plan.plan.length, 2);
  assert.match(plan.plan[1], /-ss 2.5 -i .*clip\.mp4 -frames:v 1 -vf scale=320:-2 .*frame_2_5s\.png/);
  assert.equal((await run('ffmpeg-frames', { action: 'frames', input: 'x.mp4', fps: 0 })).ok, false);
  await assert.rejects(run('ffmpeg-frames', { action: 'wat', input: 'x.mp4' }), /action must be one of/, 'the registry checks the enum before the script runs');
  if (!which('ffmpeg') || !which('ffprobe')) return t.skip('ffmpeg not installed');
  const d = tmp();
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=10', path.join(d, 'c.mp4')]);
  const p = await run('ffmpeg-frames', { action: 'probe', input: path.join(d, 'c.mp4') });
  assert.deepEqual([p.video.width, p.video.height, p.video.fps, Math.round(p.durationSec)], [320, 240, 10, 4]);
  const f = await run('ffmpeg-frames', { action: 'frames', input: path.join(d, 'c.mp4'), fps: 1, outDir: path.join(d, 'f') });
  assert.equal(f.count, 4);
  const sh = await run('ffmpeg-frames', { action: 'sheet', input: path.join(d, 'c.mp4'), count: 4, cols: 2, outDir: path.join(d, 's') });
  assert.equal(sh.count, 1);
  assert.deepEqual([...fs.readFileSync(sh.files[0]).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal((await run('ffmpeg-frames', { action: 'probe', input: path.join(d, 'missing.mp4') })).ok, false);
});

test('cdp-screenshot: real Chrome shot with page problems reported (skips without Chrome)', async (t) => {
  const dry = await run('cdp-screenshot', { url: 'http://127.0.0.1:1/', size: '390x844', out: 'a.png', eval: '1+1', dryRun: true });
  assert.deepEqual(dry.plan.steps.map((s) => Object.keys(s)[0]), ['viewport', 'eval', 'sleep', 'shot']);
  assert.equal((await run('cdp-screenshot', { url: 'ftp://x/', out: 'a.png' })).ok, false);
  assert.equal((await run('cdp-screenshot', { url: 'http://127.0.0.1:1/' })).ok, false, 'needs out or steps');
  if (!dry.chromeFound) return t.skip('no Chrome/Chromium installed');
  const { s, url } = await serve((q, r) => { if (q.url === '/') { r.setHeader('content-type', 'text/html'); r.end('<title>t</title><h1 id=h>Hello</h1><script>console.error("page-boom")</script><img src="/missing.png">'); } else { r.statusCode = 404; r.end(); } });
  const out = path.join(tmp(), 'shot.png');
  try {
    const r = await run('cdp-screenshot', { url, out, size: '390x844', eval: 'document.getElementById("h").textContent' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.evals, ['Hello']);
    assert.ok(r.problems.some((p) => p.includes('page-boom')) && r.problems.some((p) => p.includes('HTTP 404') && p.includes('missing.png')), r.problems.join('|'));
    const png = fs.readFileSync(out);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [780, 1688], 'a 390x844 phone is captured at 2x');
  } finally { s.close(); }
});

test('app-publish: registers with description and tags, waits for health, and refuses to take over another app', async () => {
  const registered = [];
  let existing = null;
  const app = await serve((q, r) => r.end('ok'));
  const daemon = await serve((q, r) => {
    let b = ''; q.on('data', (d) => { b += d; });
    q.on('end', () => {
      r.setHeader('content-type', 'application/json');
      if (q.method === 'POST' && q.url === '/api/local/apps') { registered.push(JSON.parse(b)); return r.end(JSON.stringify({ apps: [] })); }
      if (q.url === '/api/local/apps') return r.end(JSON.stringify({ apps: [...(existing ? [existing] : []), ...registered.map((a) => ({ ...a, node: 'box', target: `http://127.0.0.1:${a.port}` }))] }));
      if (q.url.startsWith('/api/local/app-start/')) return r.end('{}');
      r.statusCode = 404; r.end('{}');
    });
  });
  process.env.RIGS_NO_SYSTEMD = '1';
  try {
    const args = { id: 'word-cloud', name: 'Word cloud', icon: '☁️', port: app.port, command: 'node server.js', cwd: '/srv/wc', env: { MODE: 'x' }, description: 'Counts words in text and draws a cloud.', tags: ['text'], daemon: daemon.url, waitSec: 5 };
    const r = await run('app-publish', args);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.path, '/api/nodes/box/apps/word-cloud/');
    assert.deepEqual(registered[0], { id: 'word-cloud', name: 'Word cloud', icon: '☁️', port: app.port, healthPath: '/healthz', launch: { command: 'node server.js', cwd: '/srv/wc', env: { MODE: 'x' } }, description: 'Counts words in text and draws a cloud.', tags: ['text'] });
    assert.ok(validateApp(registered[0]).app, 'what it registers is a valid App Cloud entry');
    existing = { id: 'taken', target: 'http://127.0.0.1:1', health: { status: 'up' } };
    const taken = await run('app-publish', { ...args, id: 'taken' });
    assert.equal(taken.ok, false);
    assert.match(taken.error, /already points at/);
    assert.equal(registered.length, 1, 'nothing was registered over it');
    assert.equal((await run('app-publish', { ...args, id: 'taken', force: true })).ok, true);
    const bad = await run('app-publish', { ...args, id: 'Bad Id' });
    assert.match(bad.error, /id must be/);
    const dead = await run('app-publish', { ...args, id: 'ghost', port: await closed(), waitSec: 1 });
    assert.equal(dead.ok, false);
    assert.match(dead.error, /did not answer/);
  } finally { delete process.env.RIGS_NO_SYSTEMD; app.s.close(); daemon.s.close(); }
});

test('app-publish dry run writes nothing and shows a systemd unit with the command quoted safely', async () => {
  const dir = tmp();
  const r = await run('app-publish', { id: 'q-app', port: 51234, command: 'node server.js --title "50% $HOME"', cwd: '/srv/q', env: { A: 'b c' }, dryRun: true, daemon: 'http://127.0.0.1:1' });
  assert.equal(r.ok, true);
  if (r.plan.unit) {
    assert.match(r.plan.unit, /ExecStart=\/bin\/sh -c "node server\.js --title \\"50%% \$\$HOME\\""/);
    assert.match(r.plan.unit, /Environment="A=b c"/);
    assert.match(r.plan.unit, /WantedBy=default\.target/);
    assert.equal(r.plan.registration.launch.systemd, 'rigs-q-app.service');
  }
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('mobile-audit dry run names the script of the RIGS checkout', async () => {
  const r = await run('mobile-audit', { viewports: '390x844', strict: true, dryRun: true });
  assert.equal(r.ok, true);
  assert.match(r.plan.command, /mobile-shots\.js --out .*mobile-audit.*--viewports 390x844 --strict/s);
  assert.equal(fs.existsSync(r.plan.script), true, 'scripts/mobile-shots.js exists next to the seeds');
});

test('mobile-audit summarises the real report.json shape, naming the failing views', async () => {
  const appDir = tmp();
  fs.mkdirSync(path.join(appDir, 'scripts'));
  fs.writeFileSync(path.join(appDir, 'scripts', 'mobile-shots.js'), `
    const fs = require('node:fs'); const path = require('node:path');
    const out = process.argv[process.argv.indexOf('--out') + 1];
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ generated: 'x', url: 'u', check: { overflow: 2, smallTargets: 5, pageErrors: 1, captureFailed: 0 }, views: [
      { view: 'home', viewport: '390x844', failures: { overflow: 0, smallTargets: 0 }, errors: [], axeViolationRules: 0, axe: [] },
      { view: 'apps', viewport: '390x844', failures: { overflow: 2, smallTargets: 5 }, errors: ['boom'], axeViolationRules: 3, axe: [{}, {}, {}] } ] }));
    console.log('CHECK overflow 2 · small touch targets 5 · page errors 1 · capture failed 0');
  `.replace(/^\s+/gm, ''));
  fs.writeFileSync(path.join(appDir, 'package.json'), '{"type":"commonjs"}');
  const r = await run('mobile-audit', { appDir, out: path.join(appDir, 'o'), viewports: '390x844' });
  assert.equal(r.ok, true);
  assert.match(r.check, /^CHECK overflow 2/);
  assert.deepEqual(r.report, { count: 2, overflow: 2, smallTargets: 5, pageErrors: 1, captureFailed: 0, axeViolationRules: 3, failing: [{ view: 'apps', viewport: '390x844', overflow: 2, smallTargets: 5, errors: 1, axe: 3 }] });
  assert.equal((await run('mobile-audit', { appDir: tmp() })).ok, false, 'no mobile-shots.js there');
});

test('unity-compile-check dry run reports what is missing instead of failing', async () => {
  const r = await run('unity-compile-check', { root: tmp(), mainProject: tmp(), dryRun: true });
  assert.equal(r.ok, true);
  assert.ok(r.problems.length >= 1);
  const real = await run('unity-compile-check', { root: tmp(), mainProject: tmp() });
  assert.equal(real.ok, false);
  assert.match(real.error, /no Assets folder|no Unity editor|no compiled response files/);
});

test('tools/applets.json describes every registered applet; an applet\'s own description and tags win', () => {
  const meta = T.appletMeta();
  const ids = Object.keys(meta);
  assert.ok(ids.length >= 15);
  for (const [id, m] of Object.entries(meta)) {
    assert.ok(m.description.length >= 40, `${id}: description`);
    assert.ok(m.tags.length >= 3, `${id}: tags`);
  }
  // every App Cloud applet the survey (docs/tool-registry-survey.md) lists as registered
  const survey = JSON.parse(/```json\n([\s\S]*?)\n```\s*$/.exec(fs.readFileSync(path.join(ROOT, 'docs', 'tool-registry-survey.md'), 'utf8'))[1]);
  const registered = survey.applets.filter((a) => a.registered && a.kind !== 'infra').map((a) => (a.id === 'krea-studio-legacy' ? 'krea-studio' : a.id));
  for (const id of registered) assert.ok(meta[id], `${id} has search metadata`);
  const app = { id: 'navigation', name: 'Navigation', node: 'box', health: { status: 'up' } };
  assert.match(T.appletEntry(app, meta).description, /trip navigation/);
  assert.ok(T.appletEntry(app, meta).tags.includes('gps'));
  const own = T.appletEntry({ ...app, description: 'Mine.', tags: ['custom'] }, meta);
  assert.equal(own.description, 'Mine.');
  assert.deepEqual(own.tags, ['applet', 'custom']);
  assert.match(T.appletEntry(app).description, /web applet in the App Cloud/, 'without a catalog it falls back to a generic line');
  assert.deepEqual(T.searchCatalog(['navigation', 'szuf', 'acestep-studio'].map((id) => T.appletEntry({ id, name: id, node: 'box' }, meta)), { q: 'speed camera' }).map((e) => e.id), ['navigation']);
  assert.deepEqual(T.appletMeta({ file: path.join(os.tmpdir(), 'nope', 'applets.json') }), {}, 'a missing file is not an error');
});

test('apps: description and tags are validated and carried on the app', () => {
  const base = { id: 'wc', port: 8750 };
  const { app } = validateApp({ ...base, description: '  Counts words.  ', tags: ['Text', 'text', 'nlp'] });
  assert.equal(app.description, 'Counts words.');
  assert.deepEqual(app.tags, ['text', 'nlp']);
  assert.equal(validateApp(base).app.description, undefined);
  assert.match(validateApp({ ...base, description: 'x'.repeat(501) }).errors[0], /at most 500/);
  assert.match(validateApp({ ...base, tags: ['two words'] }).errors[0], /tags must be/);
  assert.match(validateApp({ ...base, tags: 'text' }).errors[0], /tags must be/);
  const entry = T.appletEntry({ ...app, node: 'box', health: { status: 'up' } });
  assert.deepEqual(T.searchCatalog([entry], { q: 'words' }).map((e) => e.id), ['wc']);
  assert.deepEqual(T.searchCatalog([entry], { tag: 'nlp' }).map((e) => e.id), ['wc']);
});
