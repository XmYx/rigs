// Live Video applet: workflow templates and node maps, the missing node/model/option check, settings
// (persisted under RIGS_HOME, the token never echoed), and the live loop against a mocked ComfyUI
// (HTTP + websocket): pipelining, prompt drift, last-frame chaining, stop → /interrupt + queue cleanup,
// the GPU-overseer lease, SSE, the /view proxy. No network, no GPU.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-lv-'));
const W = await import('../applets/live-video/workflows.js');
const S = await import('../applets/live-video/settings.js');
const L = await import('../applets/live-video/live.js');
const { createLiveVideoServer } = await import('../applets/live-video/server.js');
const { createMockComfy } = await import('../applets/live-video/scripts/mock-comfy.js');
const { authValue } = await import('../applets/live-video/comfy.js');

const templates = W.loadTemplates();
const servers = [];
after(() => { for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch {} } });

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => { servers.push(srv); r(`http://127.0.0.1:${srv.address().port}`); }));
const until = async (fn, ms = 5000, what = 'condition') => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 15)); }
  throw new Error('timed out waiting for ' + what);
};
const req = async (base, p, { method = 'GET', body, headers = {} } = {}) => {
  const r = await fetch(base + p, { method, headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, text, headers: r.headers };
};

/** A mock ComfyUI plus an applet server pointed at it, with its own RIGS_HOME dir and a recording overseer. */
async function setup({ mock: mockOpts = {}, settings = {}, overseer = false } = {}) {
  const mock = createMockComfy(mockOpts);
  const comfyUrl = await listen(mock);
  const dir = fs.mkdtempSync(path.join(process.env.RIGS_HOME, 'lv-'));
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ comfyUrl, overseer: { mode: overseer ? 'on' : 'off' }, ...settings }));
  const calls = [];
  const overseerFactory = () => ({
    async acquire(need) { calls.push(['acquire', need, mock.prompts.length]); return { ok: true, free_mb: 20000, unloaded: [] }; },
    async release() { calls.push(['release', mock.prompts.length]); return { ok: true }; },
  });
  const app = createLiveVideoServer({ settingsPath, dataDir: dir, detect: async () => null, tickMs: 40, overseerFactory });
  const base = await listen(app);
  return { mock, comfyUrl, app, base, dir, settingsPath, live: app.live, overseerCalls: calls };
}

// ---- Templates and node maps --------------------------------------------------------------------------

test('templates: LTX t2v + i2v and Wan 2.1 load, each map points at real nodes', () => {
  assert.deepEqual([...templates.keys()].sort(), ['fasth3-i2v', 'fasth3-t2v', 'ltxv-i2v', 'ltxv-t2v', 'wan21-t2v']);
  for (const t of templates.values()) {
    for (const k of ['prompt', 'seed', 'width', 'height', 'frames', 'fps']) assert.ok(t.params[k]?.length, `${t.id} maps ${k}`);
    assert.ok(t.outputs.video && t.workflow[t.outputs.video], `${t.id} has a video output`);
    assert.ok(t.limits.maxWidth <= 1280 && t.limits.maxHeight <= 720, `${t.id} stays within 1280x720`);
    for (const [w, h] of t.resolutions) assert.deepEqual(W.fitSize(w, h, t.limits), { width: w, height: h }, `${t.id} preset ${w}x${h} is valid`);
  }
  assert.equal(templates.get('ltxv-t2v').i2v, 'ltxv-i2v');
  assert.throws(() => W.loadTemplates(writeBrokenTemplate()), /points at node 999/);
});

function writeBrokenTemplate() {
  const dir = fs.mkdtempSync(path.join(process.env.RIGS_HOME, 'tpl-'));
  fs.writeFileSync(path.join(dir, 'x.api.json'), JSON.stringify({ 1: { class_type: 'A', inputs: { text: '' } } }));
  fs.writeFileSync(path.join(dir, 'x.map.json'), JSON.stringify({ id: 'x', workflow: 'x.api.json', params: { prompt: [{ node: '999', input: 'text' }] } }));
  return dir;
}

test('buildWorkflow: values land on the mapped node inputs; the template itself is untouched', () => {
  const t = templates.get('ltxv-t2v');
  const wf = W.buildWorkflow(t, { prompt: 'a red fox', negative: 'blur', seed: 1234, width: 1280, height: 704, frames: 121, fps: 30, prefix: 'live-video/abc-0001' });
  assert.equal(wf['6'].inputs.text, 'a red fox');
  assert.equal(wf['7'].inputs.text, 'blur');
  assert.equal(wf['72'].inputs.noise_seed, 1234);
  assert.deepEqual([wf['70'].inputs.width, wf['70'].inputs.height, wf['70'].inputs.length], [1280, 704, 121]);
  assert.equal(wf['69'].inputs.frame_rate, 30);
  assert.equal(wf['80'].inputs.fps, 30);
  assert.equal(wf['90'].inputs.batch_index, 120, 'last-frame index follows the frame count');
  assert.equal(wf['80'].inputs.filename_prefix, 'live-video/abc-0001');
  assert.equal(wf['6']._meta, undefined, '_meta stripped');
  assert.deepEqual(wf['72'].inputs.positive, ['69', 0], 'links kept');
  assert.equal(t.workflow['6'].inputs.text.startsWith('a neon'), true, 'template not mutated');

  const w = W.buildWorkflow(templates.get('wan21-t2v'), { prompt: 'p', seed: 7, width: 832, height: 480, frames: 33, fps: 16 });
  assert.deepEqual([w['3'].inputs.seed, w['40'].inputs.width, w['40'].inputs.length, w['80'].inputs.fps, w['90'].inputs.batch_index], [7, 832, 33, 16, 32]);

  const i = W.buildWorkflow(templates.get('ltxv-i2v'), { prompt: 'p', image: 'live-video-x-last.png', width: 768, height: 512, frames: 73 });
  assert.equal(i['78'].inputs.image, 'live-video-x-last.png');
  assert.deepEqual([i['77'].inputs.width, i['77'].inputs.length], [768, 73]);

  const o = W.buildWorkflow(t, {}, { ltxv: { checkpoint: 'my-ltx.safetensors' } });
  assert.equal(o['44'].inputs.ckpt_name, 'my-ltx.safetensors', 'model override by family');
  assert.equal(o['38'].inputs.clip_name, 't5xxl_fp16.safetensors', 'other slots keep the default');
});

test('FastH3: 17k+5 frames, and the V3 dynamic-combo options (SaveVideo format, sparse attention) are read as keys', () => {
  const h3 = templates.get('fasth3-t2v');
  assert.equal(W.framesFor(3, 24, h3.limits), 73);
  assert.equal(W.framesFor(5, 24, h3.limits), 124);
  const dyn = { SaveVideo: { input: { required: { format: ['COMFY_DYNAMICCOMBO_V3', { options: [{ key: 'auto', inputs: { required: {} } }, { key: 'mp4', inputs: { required: {} } }] }] } } } };
  assert.deepEqual(W.inputOptions(dyn, 'SaveVideo', 'format'), ['auto', 'mp4']);
  // sub-inputs of a dynamic combo are named "format.codec"; they are not in /object_info's top level, so they are skipped
  assert.equal(W.inputOptions(dyn, 'SaveVideo', 'format.codec'), null);
});

test('framesFor / fitSize: model constraints (LTX 8n+1, Wan 4n+1, sizes in steps, ≤1280x720)', () => {
  const ltx = templates.get('ltxv-t2v').limits;
  const wan = templates.get('wan21-t2v').limits;
  assert.equal(W.framesFor(3, 24, ltx), 73);
  assert.equal(W.framesFor(4, 24, ltx), 97);
  assert.equal(W.framesFor(60, 24, ltx), 257, 'capped at maxFrames');
  assert.equal(W.framesFor(2, 16, wan), 33);
  assert.equal(W.framesFor(5, 16, wan), 81);
  for (const n of [1, 2, 3, 5, 8].map((s) => W.framesFor(s, 24, ltx))) assert.equal((n - 1) % 8, 0);
  assert.deepEqual(W.fitSize(1920, 1080, ltx), { width: 1280, height: 704 });
  assert.deepEqual(W.fitSize(1920, 1080, wan), { width: 1280, height: 720 });
  assert.deepEqual(W.fitSize(10, 10, ltx), { width: 32, height: 32 });
  assert.deepEqual(W.fitSize(770, 515, ltx), { width: 768, height: 512 });
});

// ---- Missing node / model / option check ----------------------------------------------------------------

test('checkTemplate reports missing nodes, missing models (with what is available) and bad options', async () => {
  const { mockObjectInfo } = await import('../applets/live-video/scripts/mock-comfy.js');
  const t = templates.get('ltxv-t2v');
  assert.deepEqual(W.checkTemplate(t, mockObjectInfo()), { ok: true, missingNodes: [], missingModels: [], badValues: [] });

  const oi = mockObjectInfo({ missingNodes: ['LTXVScheduler'], missingModels: ['ltxv-2b-0.9.8-distilled.safetensors'], extraModels: ['other.safetensors'] });
  const c = W.checkTemplate(t, oi);
  assert.equal(c.ok, false);
  assert.deepEqual(c.missingNodes, [{ node: '71', classType: 'LTXVScheduler' }]);
  assert.equal(c.missingModels.length, 1);
  assert.equal(c.missingModels[0].want, 'ltxv-2b-0.9.8-distilled.safetensors');
  assert.equal(c.missingModels[0].slot, 'checkpoint');
  assert.ok(c.missingModels[0].available.includes('other.safetensors'));
  assert.match(c.missingModels[0].url, /^https:\/\/huggingface\.co\//);
  assert.match(W.describeMissing(t.id, c), /missing nodes LTXVScheduler; models ltxv-2b-0\.9\.8-distilled\.safetensors \(CheckpointLoaderSimple\.ckpt_name\)/);
  assert.equal(W.checkTemplate(t, oi, { ltxv: { checkpoint: 'other.safetensors' } }).missingModels.length, 0, 'an override to an installed file fixes it');

  const old = structuredClone(mockObjectInfo());
  old.KSamplerSelect.input.required.sampler_name = ['COMBO', { options: ['dpmpp_2m'] }];
  const b = W.checkTemplate(t, old);
  assert.deepEqual(b.badValues.map((x) => `${x.classType}.${x.input}=${x.want}`), ['KSamplerSelect.sampler_name=euler'], 'new-style COMBO option lists are read too');
  assert.equal(W.inputOptions(old, 'KSamplerSelect', 'sampler_name')[0], 'dpmpp_2m');
});

test('start with a missing model or node → 409 naming it, and nothing is ever queued on ComfyUI', async () => {
  const { mock, base } = await setup({ mock: { missingModels: ['t5xxl_fp16.safetensors'], missingNodes: ['UNETLoader'] } });
  const r = await req(base, '/api/live/start', { method: 'POST', body: { template: 'ltxv-t2v', prompt: 'a fox' } });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /t5xxl_fp16\.safetensors/);
  assert.equal(r.data.details[0].missingModels[0].slot, 'textEncoder');
  const w = await req(base, '/api/live/start', { method: 'POST', body: { template: 'wan21-t2v', prompt: 'a fox' } });
  assert.equal(w.status, 409);
  assert.match(w.data.error, /nodes UNETLoader/);
  assert.equal(mock.prompts.length, 0, 'no /prompt when something is missing (it can trigger model downloads)');

  const st = await req(base, '/api/status');
  assert.equal(st.data.connection.ok, true);
  const byId = Object.fromEntries(st.data.templates.map((t) => [t.id, t]));
  assert.equal(byId['ltxv-t2v'].check.ok, false);
  assert.equal(byId['wan21-t2v'].check.missingNodes[0].classType, 'UNETLoader');
  assert.equal(byId['ltxv-t2v'].workflow, undefined, 'workflow bodies stay on the server');
});

// ---- Settings ----------------------------------------------------------------------------------------------

test('settings: applyPatch validation, effective URL and the public view without the token', () => {
  const base = S.loadSettings(path.join(process.env.RIGS_HOME, 'nope.json'));
  assert.equal(base.comfyUrl, null);
  assert.match(S.applyPatch(base, { comfyUrl: 'ftp://x' }).error, /comfyUrl/);
  assert.match(S.applyPatch(base, { comfyUrl: 'http://u:p@host:8188' }).error, /without user:password/);
  assert.match(S.applyPatch(base, { authHeader: 'bad header' }).error, /authHeader/);
  assert.match(S.applyPatch(base, { authToken: 'a\nb' }).error, /single-line/);
  assert.match(S.applyPatch(base, { overseer: { mode: 'sometimes' } }).error, /overseer\.mode/);
  const { settings } = S.applyPatch(base, { comfyUrl: 'http://gpu-box:8188/', authToken: 's3cret-token', models: { ltxv: { checkpoint: 'x.safetensors' } } });
  assert.equal(settings.comfyUrl, 'http://gpu-box:8188');
  const pub = S.publicSettings(settings, 'http://127.0.0.1:8188');
  assert.equal(pub.comfyUrl, 'http://gpu-box:8188');
  assert.equal(pub.source, 'saved');
  assert.equal(pub.authTokenSet, true);
  assert.equal(pub.authTokenLength, 12);
  assert.ok(!JSON.stringify(pub).includes('s3cret'), 'token not in the public view');
  assert.deepEqual(S.effectiveUrl(base, 'http://127.0.0.1:8188'), { url: 'http://127.0.0.1:8188', source: 'detected' });
  assert.deepEqual(S.effectiveUrl(base, null), { url: '', source: 'none' });
  assert.equal(S.overseerApplies(base, 'http://127.0.0.1:8188'), true, 'auto: local ComfyUI');
  assert.equal(S.overseerApplies(base, 'http://gpu-box:8188'), false, 'auto: remote ComfyUI');
  assert.equal(S.overseerApplies({ overseer: { mode: 'off' } }, 'http://127.0.0.1:8188'), false);
  assert.equal(authValue('Authorization', 'abc'), 'Bearer abc');
  assert.equal(authValue('Authorization', 'Basic dXNlcjpwYXNz'), 'Basic dXNlcjpwYXNz');
  assert.equal(authValue('X-API-Key', 'abc'), 'abc');
});

test('settings round-trip over HTTP: default is the detected ComfyUI; PUT persists under RIGS_HOME; token never echoed', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.RIGS_HOME, 'set-'));
  const settingsPath = path.join(dir, 'settings.json');
  const app = createLiveVideoServer({ settingsPath, dataDir: dir, detect: async () => 'http://127.0.0.1:8188' });
  const base = await listen(app);
  let r = await req(base, '/api/settings');
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.comfyUrl, r.data.source, r.data.authTokenSet], ['http://127.0.0.1:8188', 'detected', false]);

  r = await req(base, '/api/settings', { method: 'PUT', body: { comfyUrl: 'http://gpu-box:8188', authHeader: 'X-Comfy-Key', authToken: 'tok-1234567890' } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.comfyUrl, r.data.source, r.data.authHeader, r.data.authTokenSet, r.data.authTokenLength], ['http://gpu-box:8188', 'saved', 'X-Comfy-Key', true, 14]);
  assert.ok(!r.text.includes('tok-1234567890'), 'PUT response has no token');
  const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(saved.authToken, 'tok-1234567890', 'token persisted');
  if (process.platform !== 'win32') assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600, 'settings file is 0600');

  r = await req(base, '/api/settings');
  assert.ok(!r.text.includes('tok-1234567890'), 'GET has no token');
  assert.equal(r.data.authTokenLength, 14);
  r = await req(base, '/api/settings', { method: 'PUT', body: { comfyUrl: 'http://other:8188' } });
  assert.equal(r.data.authTokenSet, true, 'absent token = kept');
  r = await req(base, '/api/settings', { method: 'PUT', body: { authToken: '' } });
  assert.equal(r.data.authTokenSet, false, 'empty token = cleared');
  r = await req(base, '/api/settings', { method: 'PUT', body: { comfyUrl: 'not a url' } });
  assert.equal(r.status, 400);
  r = await req(base, '/api/settings', { method: 'PUT', body: { comfyUrl: '' } });
  assert.deepEqual([r.data.comfyUrl, r.data.source], ['http://127.0.0.1:8188', 'detected'], 'clearing returns to the detected instance');

  const fresh = createLiveVideoServer({ settingsPath, dataDir: dir, detect: async () => null });
  const b2 = await listen(fresh);
  assert.equal((await req(b2, '/api/settings')).data.authHeader, 'X-Comfy-Key', 'persisted across restarts');
});

test('auth: the header reaches ComfyUI (HTTP and websocket); a wrong token is reported, not echoed', async () => {
  const { base, mock } = await setup({ mock: { requireAuth: { header: 'Authorization', value: 'Bearer good-token' } }, settings: { authToken: 'good-token' } });
  const st = await req(base, '/api/status');
  assert.equal(st.data.connection.ok, true);
  assert.equal(st.data.connection.version, '0.0.0-mock');
  const r = await req(base, '/api/live/start', { method: 'POST', body: { template: 'ltxv-t2v', prompt: 'x', seconds: 1 } });
  assert.equal(r.status, 202);
  await until(() => mock.socketCount > 0, 3000, 'authenticated websocket');
  await req(base, '/api/live/stop', { method: 'POST' });

  await req(base, '/api/settings', { method: 'PUT', body: { authToken: 'wrong-token' } });
  const bad = await req(base, '/api/status');
  assert.equal(bad.data.connection.ok, false);
  assert.match(bad.data.connection.error, /refused the request \(401\)/);
  assert.ok(!bad.text.includes('wrong-token') && !bad.text.includes('good-token'));
});

// ---- The live loop --------------------------------------------------------------------------------------------

test('live: the next clip is queued while the current one generates; clips arrive in order with progress', async () => {
  const { mock, base, live, dir } = await setup({ mock: { genMs: 120, steps: 4 } });
  const events = [];
  const sse = await openSse(base + '/api/events', events);
  const r = await req(base, '/api/live/start', { method: 'POST', body: { template: 'ltxv-t2v', prompt: 'neon city', resolution: '960x544', seconds: 2, seed: 100 } });
  assert.equal(r.status, 202);
  assert.equal(r.data.session.frames, 49);
  assert.deepEqual([r.data.session.width, r.data.session.height], [960, 544]);
  // Pipelining: a second prompt is in ComfyUI's queue before the first one has finished.
  await until(() => mock.prompts.length >= 2, 3000, 'second prompt');
  assert.ok(!mock.history[mock.prompts[0].id], 'second prompt queued before the first clip was done');
  await until(() => live.clips.length >= 3, 5000, 'three clips');
  assert.deepEqual(live.clips.slice(0, 3).map((c) => c.index), [0, 1, 2]);
  assert.ok(live.clips[0].url.startsWith('api/view?'), 'relative clip URL');
  assert.ok(live.clips[0].poster.startsWith('api/view?'), 'last frame as poster');
  assert.deepEqual(mock.prompts.slice(0, 3).map((p) => p.workflow['72'].inputs.noise_seed), [100, 101, 102], 'a new seed per clip');
  assert.ok(mock.prompts.every((p) => p.workflow['6'].inputs.text === 'neon city'));
  assert.equal(mock.prompts[0].workflow['70'].inputs.length, 49);
  assert.ok(mock.prompts.every((p) => p.clientId === mock.prompts[0].clientId && p.clientId.startsWith('live-video-')));
  assert.ok(live.snapshot().pending.length <= 2, 'never more than two of ours in ComfyUI');
  await until(() => events.some((e) => e.type === 'clip') && events.some((e) => e.type === 'progress'), 3000, 'SSE clip + progress');
  const prog = events.find((e) => e.type === 'progress').data;
  assert.ok(prog.max === 4 && prog.value >= 1);
  await req(base, '/api/live/stop', { method: 'POST' });
  sse.close();
  await until(() => fs.existsSync(path.join(dir, 'clips.json')), 2000, 'clips.json');
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'clips.json'), 'utf8')).length >= 3, 'recent clips persisted');
});

test('live: it does not run away — at most ~3 clips are buffered ahead of playback', async () => {
  const { mock, live, base } = await setup({ mock: { genMs: 8, steps: 1 } });
  await req(base, '/api/live/start', { method: 'POST', body: { template: 'wan21-t2v', prompt: 'x', seconds: 2 } });
  await new Promise((r) => setTimeout(r, 600));
  // 2 s clips generated in ~8 ms: without the cap this would be dozens.
  assert.ok(mock.prompts.length <= 4, `queued ${mock.prompts.length} prompts`);
  assert.ok(live.clips.length >= 2);
  await req(base, '/api/live/stop', { method: 'POST' });
});

test('stop: interrupts our running prompt, deletes our queued one, leaves the queue clean', async () => {
  const { mock, base, live } = await setup({ mock: { genMs: 4000, steps: 4 } });
  await req(base, '/api/live/start', { method: 'POST', body: { template: 'ltxv-t2v', prompt: 'slow', seconds: 2 } });
  await until(() => mock.prompts.length === 2 && mock.running, 3000, 'one running + one queued');
  const [first, second] = mock.prompts.map((p) => p.id);
  assert.equal(mock.running, first);
  const r = await req(base, '/api/live/stop', { method: 'POST' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.interrupted, [first]);
  assert.deepEqual(r.data.deleted, [second]);
  assert.deepEqual(mock.interrupts, [{ prompt_id: first }], '/interrupt names our prompt');
  assert.deepEqual(mock.deletes, [second]);
  assert.equal(mock.queue.length, 0);
  assert.equal(mock.running, null);
  assert.equal(r.data.state.status, 'idle');
  assert.equal(live.snapshot().pending.length, 0);
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(mock.prompts.length, 2, 'nothing queued after stop');
});

test('stop leaves someone else\'s running job alone', async () => {
  const { mock, comfyUrl, base } = await setup({ mock: { genMs: 4000, steps: 4 } });
  // Another client's job is running; ours wait behind it.
  await fetch(comfyUrl + '/prompt', { method: 'POST', body: JSON.stringify({ prompt: templates.get('ltxv-t2v').workflow, client_id: 'someone-else' }) });
  await req(base, '/api/live/start', { method: 'POST', body: { template: 'ltxv-t2v', prompt: 'x', seconds: 2 } });
  await until(() => mock.prompts.length === 3, 3000, 'our two prompts');
  const r = await req(base, '/api/live/stop', { method: 'POST' });
  assert.deepEqual(r.data.interrupted, []);
  assert.equal(mock.interrupts.length, 0, 'no /interrupt: the running job is not ours');
  assert.deepEqual(new Set(mock.deletes), new Set(mock.prompts.slice(1).map((p) => p.id)));
  assert.equal(mock.running, mock.prompts[0].id, 'their job still running');
});

test('drift: one prompt line per clip, cycling; update changes the clips not queued yet', async () => {
  const { mock, base } = await setup({ mock: { genMs: 60, steps: 2 } });
  await req(base, '/api/live/start', { method: 'POST', body: { template: 'wan21-t2v', prompt: 'a forest\na river\n\na mountain', mode: 'drift', seconds: 1 } });
  await until(() => mock.prompts.length >= 3, 3000, 'three prompts');
  assert.deepEqual(mock.prompts.slice(0, 3).map((p) => p.workflow['6'].inputs.text), ['a forest', 'a river', 'a mountain']);
  const u = await req(base, '/api/live/update', { method: 'POST', body: { prompt: 'the sea' } });
  assert.equal(u.status, 200);
  const n = mock.prompts.length;
  await until(() => mock.prompts.length > n, 3000, 'a prompt after the update');
  assert.equal(mock.prompts.at(-1).workflow['6'].inputs.text, 'the sea');
  assert.equal((await req(base, '/api/live/update', { method: 'POST', body: { mode: 'chain' } })).status, 400, 'Wan cannot chain');
  await req(base, '/api/live/stop', { method: 'POST' });
});

test('chain: each clip after the first starts from the previous clip\'s last frame (i2v template)', async () => {
  const { mock, base } = await setup({ mock: { genMs: 60, steps: 2 } });
  await req(base, '/api/live/start', { method: 'POST', body: { template: 'ltxv-t2v', prompt: 'a long road', mode: 'chain', seconds: 1 } });
  await until(() => mock.prompts.length >= 3, 4000, 'three chained prompts');
  const [a, b] = mock.prompts;
  assert.ok(a.workflow['70'] && !a.workflow['78'], 'first clip: text-to-video');
  assert.ok(b.workflow['77'] && b.workflow['78'], 'next clips: image-to-video');
  assert.match(b.workflow['78'].inputs.image, /^live-video-[0-9a-f]+-last\.png$/);
  assert.equal(mock.uploads[0].filename, b.workflow['78'].inputs.image, 'the uploaded last frame is the start image');
  assert.ok(mock.history[a.id], 'one at a time: the next is queued only after the previous finished');
  await req(base, '/api/live/stop', { method: 'POST' });
});

test('image-to-video: an uploaded start image goes through api/image into the i2v workflow', async () => {
  const { mock, base } = await setup({ mock: { genMs: 50, steps: 1 } });
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const up = await fetch(base + '/api/image', { method: 'POST', headers: { 'content-type': 'image/png' }, body: png });
  const { name } = await up.json();
  assert.match(name, /^live-video-start-\w+\.png$/);
  assert.equal((await fetch(base + '/api/image', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })).status, 415);
  await req(base, '/api/live/start', { method: 'POST', body: { template: 'ltxv-t2v', prompt: 'p', image: name, seconds: 1 } });
  await until(() => mock.prompts.length >= 1, 3000, 'a prompt');
  assert.equal(mock.prompts[0].workflow['78'].inputs.image, name);
  await req(base, '/api/live/stop', { method: 'POST' });
  const bad = await req(base, '/api/live/start', { method: 'POST', body: { template: 'ltxv-t2v', prompt: 'p', image: '../../etc/passwd' } });
  assert.equal(bad.status, 400);
});

test('failures: a failed clip is reported and skipped; three in a row stop the loop with the reason', async () => {
  const one = await setup({ mock: { genMs: 30, steps: 1, failPrompts: 1 } });
  await req(one.base, '/api/live/start', { method: 'POST', body: { template: 'wan21-t2v', prompt: 'x', seconds: 1 } });
  await until(() => one.live.clips.length >= 1, 3000, 'a clip after one failure');
  assert.equal(one.live.status, 'running');
  await req(one.base, '/api/live/stop', { method: 'POST' });

  const many = await setup({ mock: { genMs: 30, steps: 1, failPrompts: 99 } });
  await req(many.base, '/api/live/start', { method: 'POST', body: { template: 'wan21-t2v', prompt: 'x', seconds: 1 } });
  await until(() => many.live.status === 'error', 3000, 'error state');
  assert.match(many.live.snapshot().error, /mock failure.*3 clips in a row failed/);
  assert.equal(many.mock.queue.length, 0, 'queue cleaned');
});

test('GPU overseer: VRAM is acquired before the first prompt and released when live stops', async () => {
  const { base, overseerCalls, mock } = await setup({ mock: { genMs: 50, steps: 1 }, overseer: true });
  await req(base, '/api/live/start', { method: 'POST', body: { template: 'ltxv-t2v', prompt: 'x', seconds: 1 } });
  await until(() => mock.prompts.length >= 1, 3000, 'a prompt');
  assert.deepEqual(overseerCalls[0], ['acquire', 12000, 0], 'acquired the template\'s VRAM need before any prompt');
  await req(base, '/api/live/stop', { method: 'POST' });
  assert.equal(overseerCalls.at(-1)[0], 'release');
});

test('GPU overseer client: speaks the overseer API; unreachable is reported, release only when held', async () => {
  const { createOverseer } = await import('../applets/live-video/overseer.js');
  const seen = [];
  const fake = http.createServer((rq, rs) => { let b = ''; rq.on('data', (d) => (b += d)); rq.on('end', () => { seen.push([rq.url, JSON.parse(b)]); rs.end(JSON.stringify(rq.url === '/api/acquire' ? { ok: true, free_mb: 15000, unloaded: ['acestep-studio'] } : { ok: true })); }); });
  const url = await listen(fake);
  const ov = createOverseer({ url, client: 'comfyui', timeoutS: 30 });
  assert.deepEqual(await ov.release(), { ok: true, skipped: true });
  assert.deepEqual(await ov.acquire(12000), { ok: true, free_mb: 15000, unloaded: ['acestep-studio'] });
  await ov.release();
  assert.deepEqual(seen, [['/api/acquire', { client: 'comfyui', need_mb: 12000, timeout: 30 }], ['/api/release', { client: 'comfyui' }]]);
  const d = await createOverseer({ url: 'http://127.0.0.1:9' }).acquire(1000);
  assert.equal(d.ok, false);
  assert.equal(d.unreachable, true);
});

test('normalizeRequest: validation and Wan chain fallback', () => {
  assert.throws(() => L.normalizeRequest({ template: 'nope', prompt: 'x' }, templates), /template must be one of: fasth3-t2v, ltxv-t2v, wan21-t2v/);
  assert.throws(() => L.normalizeRequest({ template: 'ltxv-i2v', prompt: 'x' }, templates), /template/);
  assert.throws(() => L.normalizeRequest({ template: 'ltxv-t2v', prompt: '  ' }, templates), /prompt is empty/);
  assert.throws(() => L.normalizeRequest({ template: 'ltxv-t2v', prompt: 'x', mode: 'warp' }, templates), /mode/);
  assert.throws(() => L.normalizeRequest({ template: 'ltxv-t2v', prompt: 'x', seconds: 99 }, templates), /seconds/);
  const d = L.normalizeRequest({ template: 'ltxv-t2v', prompt: 'x' }, templates);
  assert.deepEqual([d.width, d.height, d.fps, d.frames, d.mode], [768, 512, 24, 73, 'loop']);
  const w = L.normalizeRequest({ template: 'wan21-t2v', prompt: 'a\nb', mode: 'chain' }, templates);
  assert.equal(w.mode, 'drift');
  assert.match(w.notice, /no image-to-video/);
  assert.deepEqual(w.lines, ['a', 'b']);
});

// ---- Server plumbing ---------------------------------------------------------------------------------------------

test('server: healthz, static UI with relative URLs, /view proxied with Range, path traversal refused', async () => {
  const { base } = await setup();
  assert.deepEqual((await req(base, '/healthz')).data, { ok: true });
  assert.deepEqual((await req(base, '/api/busy')).data, { busy: false }, 'the GPU overseer probes this');
  const html = await req(base, '/');
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /text\/html/);
  assert.ok(!/(src|href)="\//.test(html.text), 'no root-relative URLs in index.html');
  const js = fs.readFileSync(path.join(import.meta.dirname, '../applets/live-video/public/app.js'), 'utf8');
  assert.ok(!/(fetch|EventSource)\(['`]\//.test(js), 'app.js uses relative API URLs');
  for (const id of new Set([...js.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]))) assert.ok(html.text.includes(`id="${id}"`), `index.html has #${id}`);
  const v = await fetch(base + '/api/view?filename=clip_00001_.webm&subfolder=live-video&type=output', { headers: { range: 'bytes=0-1' } });
  assert.equal(v.status, 206);
  assert.equal(v.headers.get('content-range'), 'bytes 0-1/4');
  assert.equal((await req(base, '/api/view?filename=../../secret&type=output')).status, 400);
  assert.equal((await req(base, '/api/view?filename=a.webm&type=elsewhere')).status, 400);
  assert.equal((await req(base, '/%2e%2e/server.js')).status, 404);
});

test('server: ComfyUI down → status says so; start → 502 with the reason; no URL → 409', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.RIGS_HOME, 'down-'));
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ comfyUrl: 'http://127.0.0.1:9', overseer: { mode: 'off' } }));
  const base = await listen(createLiveVideoServer({ settingsPath, dataDir: dir, detect: async () => null }));
  const st = await req(base, '/api/status');
  assert.equal(st.data.connection.ok, false);
  assert.match(st.data.connection.error, /unreachable at http:\/\/127\.0\.0\.1:9/);
  assert.equal(st.data.templates.length, 5, 'templates still listed');
  assert.equal((await req(base, '/api/live/start', { method: 'POST', body: { template: 'ltxv-t2v', prompt: 'x' } })).status, 502);

  const none = fs.mkdtempSync(path.join(process.env.RIGS_HOME, 'none-'));
  const b2 = await listen(createLiveVideoServer({ settingsPath: path.join(none, 'settings.json'), dataDir: none, detect: async () => null }));
  assert.match((await req(b2, '/api/status')).data.connection.error, /No ComfyUI URL/);
  assert.equal((await req(b2, '/api/live/start', { method: 'POST', body: { template: 'ltxv-t2v', prompt: 'x' } })).status, 409);
});

/** Minimal SSE reader over fetch: pushes {type, data} into `events`. */
async function openSse(url, events) {
  const ac = new AbortController();
  const res = await fetch(url, { signal: ac.signal });
  const reader = res.body.getReader();
  (async () => {
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += Buffer.from(value).toString();
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const type = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (type && data) events.push({ type, data: JSON.parse(data) });
        }
      }
    } catch {}
  })();
  return { close: () => ac.abort() };
}
