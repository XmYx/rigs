// Krea Studio applet: config loading, the gallery store, the applet server against a fake RIGS daemon
// (healthz, static files, the api/comfy pass-through incl. uploads, generate → gallery, keeping a
// realtime result, download/delete, a remote connector machine), the page helpers (request building,
// progress/error text, the realtime debouncer, the sketch's pointer mapping) and that every element
// app.js addresses exists in index.html. No network, no ComfyUI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-krea-'));
process.env.RIGS_NO_OPENRIG = '1';
const S = await import('../applets/krea-studio/server.js');
const U = await import('../applets/krea-studio/public/studio.js');
const { canvasPoint } = await import('../applets/krea-studio/public/sketch.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'applets', 'krea-studio');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000400000003008060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201ed1d0e5e0000000049454e44ae426082', 'hex'); // 64×48

/** A RIGS daemon look-alike: /api/local/comfyui/* and /api/nodes[/<node>/comfyui/*]. */
async function fakeDaemon() {
  const st = { jobs: new Map(), submitted: [], uploads: [], calls: [] };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    st.calls.push(`${req.method} ${url.pathname}`);
    const c = [];
    for await (const x of req) c.push(x);
    const raw = Buffer.concat(c);
    const json = (code, b) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (url.pathname === '/api/nodes') return json(200, [{ name: 'here', self: true, online: true, rigs: true }, { name: 'gpu-box', online: true, rigs: true, tools: { secret: 'x' } }]);
    const m = url.pathname.match(/^\/api\/(?:local|nodes\/([^/]+))\/comfyui\/(.+)$/);
    if (!m) return json(404, { error: 'not found' });
    const [, node, sub] = m;
    if (sub === 'config') return json(200, { node: node || 'local', config: { url: 'http://127.0.0.1:8188', auth: { set: false } } });
    if (sub === 'upload') { st.uploads.push({ type: req.headers['content-type'], bytes: raw.length, name: url.searchParams.get('name') }); return json(200, { name: 'in.png', subfolder: 'rigs-krea', type: 'input' }); }
    if (sub === 'jobs' && req.method === 'POST') {
      const b = JSON.parse(String(raw));
      if (b.params?.preset === 'missing') return json(422, { error: '"missing" is not installed on this ComfyUI' });
      const id = `cj-${st.submitted.length + 1}`;
      st.submitted.push({ ...b, node: node || '' });
      st.jobs.set(id, { id, kind: b.kind, state: 'running', polls: 0, params: { prompt: b.params?.prompt, seed: 5, presetLabel: 'Krea 2 Turbo' } });
      return json(200, { id, kind: b.kind, state: 'preparing' });
    }
    const jm = sub.match(/^jobs\/([\w-]+)$/);
    if (jm) {
      const j = st.jobs.get(jm[1]);
      if (!j) return json(404, { error: 'no such job' });
      if (++j.polls >= 2) Object.assign(j, { state: 'done', outputs: [{ filename: `${j.id}.png`, subfolder: 'rigs-krea', type: 'output' }], elapsedMs: 1200 });
      return json(200, j);
    }
    if (sub === 'view') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
    return json(404, { error: `unknown ${sub}` });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, st, close: () => new Promise((r) => server.close(r)) };
}

async function applet(daemonUrl) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krea-data-'));
  const server = S.createKreaServer({ cfg: { ...S.DEFAULTS, rigsUrl: daemonUrl, dataDir, galleryMax: 50 }, watchMs: 20 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const call = async (p, opts = {}) => {
    const r = await fetch(base + p, opts);
    const type = r.headers.get('content-type') || '';
    return { status: r.status, type, headers: r.headers, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  const post = (p, json) => call(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) });
  return { server, base, call, post, dataDir, close: () => new Promise((r) => server.close(r)) };
}

const until = async (fn, ms = 3000) => {
  const t = Date.now() + ms;
  while (Date.now() < t) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 15)); }
  throw new Error('timed out');
};

// ---------------------------------------------------------------- config and storage

test('loadKreaConfig: defaults, env overrides, the daemon port from RIGS config, data under RIGS_HOME', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'krea-cfg-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port: 4800, kreaStudio: { galleryMax: 20 } }));
  const { cfg, warnings } = S.loadKreaConfig({ env: { RIGS_HOME: home } });
  assert.equal(cfg.port, 8732);
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.rigsUrl, 'http://127.0.0.1:4800');
  assert.equal(cfg.dataDir, path.join(home, 'krea-studio'));
  assert.equal(cfg.galleryMax, 20);
  assert.deepEqual(warnings, []);
  const e = S.loadKreaConfig({ env: { RIGS_HOME: home, KREA_PORT: '9001', KREA_RIGS_URL: 'http://127.0.0.1:4799/', RIGS_PORT: '1' } }).cfg;
  assert.equal(e.port, 9001);
  assert.equal(e.rigsUrl, 'http://127.0.0.1:4799');
  const bad = S.loadKreaConfig({ env: { RIGS_HOME: home, KREA_PORT: 'x', KREA_RIGS_URL: 'ftp://nope' } });
  assert.equal(bad.cfg.port, 8732);
  assert.equal(bad.cfg.rigsUrl, 'http://127.0.0.1:4800');
  assert.equal(bad.warnings.length, 2);
});

test('imageSize reads PNG and JPEG headers', () => {
  assert.deepEqual(S.imageSize(PNG), { width: 64, height: 48 });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x00, 0x03, 0x00, 0x03, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(S.imageSize(jpeg), { width: 768, height: 512 });
  assert.equal(S.imageSize(Buffer.from('nope')), null);
});

test('gallery: newest first, survives a reload, the oldest images are pruned past the cap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krea-gal-'));
  let t = 1000;
  const g = S.createGallery({ dir, max: 2, now: () => t++ });
  const a = g.add({ jobId: 'j1', kind: 'txt2img' }, PNG, 'image/png');
  const b = g.add({ jobId: 'j2', kind: 'img2img' }, PNG, 'image/png');
  const c = g.add({ jobId: 'j3', kind: 'upscale' }, PNG, 'image/png');
  assert.deepEqual(g.list().map((x) => x.jobId), ['j3', 'j2']);
  assert.ok(!fs.existsSync(path.join(dir, 'images', a.file)), 'a pruned image file is removed');
  assert.equal(c.width, 64);
  const again = S.createGallery({ dir, max: 2 });
  assert.deepEqual(again.list().map((x) => x.id), [c.id, b.id]);
  assert.ok(again.hasJob('j2'));
  assert.equal(again.remove(b.id), true);
  assert.ok(!fs.existsSync(path.join(dir, 'images', b.file)));
  assert.equal(again.remove('nope'), false);
});

// ---------------------------------------------------------------- the applet server

test('serves healthz and the page with relative URLs only; every element app.js uses exists', async () => {
  const d = await fakeDaemon();
  const a = await applet(d.url);
  try {
    assert.deepEqual((await a.call('healthz')).body, { ok: true });
    const html = String((await a.call('')).body);
    assert.match(html, /<title>Krea Studio<\/title>/);
    assert.ok(!/(src|href)="\//.test(html), 'no root-relative URLs (the App Cloud serves the applet under a prefix)');
    const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    assert.ok(!/fetch\(['"`]\//.test(js) && !/api\(['"`]\//.test(js), 'no root-relative fetches in app.js');
    const ids = new Set([...js.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]));
    const missing = [...ids].filter((id) => !html.includes(`id="${id}"`));
    assert.deepEqual(missing, [], `ids used by app.js but missing from index.html: ${missing.join(', ')}`);
    assert.equal((await a.call('app.js')).type, 'text/javascript; charset=utf-8');
    assert.equal((await a.call('../server.js')).status, 404);
    assert.equal((await a.call('%2e%2e/server.js')).status, 404);
  } finally { await a.close(); await d.close(); }
});

test('api/comfy/* passes through to the daemon connector, uploads byte for byte; a down daemon is a clear 502', async () => {
  const d = await fakeDaemon();
  const a = await applet(d.url);
  try {
    assert.equal((await a.call('api/comfy/config')).body.node, 'local');
    const up = await a.call('api/comfy/upload?name=sketch.png', { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG });
    assert.equal(up.status, 200);
    assert.deepEqual(d.st.uploads, [{ type: 'image/png', bytes: PNG.length, name: 'sketch.png' }]);
    assert.equal((await a.call('api/comfy/view?filename=x.png')).type, 'image/png');
    assert.equal((await a.call('api/comfy/nope')).status, 404);
  } finally { await a.close(); await d.close(); }
  const dead = await applet('http://127.0.0.1:9');
  try {
    const r = await dead.call('api/comfy/config');
    assert.equal(r.status, 502);
    assert.match(r.body.error, /RIGS daemon at http:\/\/127\.0\.0\.1:9 is not answering/);
  } finally { await dead.close(); }
});

test('generate: a finished job lands in the gallery on its own; download, then delete', async () => {
  const d = await fakeDaemon();
  const a = await applet(d.url);
  try {
    const r = await a.post('api/generate', { kind: 'txt2img', params: { prompt: 'a fox', preset: 'krea2:x' } });
    assert.equal(r.status, 202);
    assert.deepEqual(d.st.submitted[0], { kind: 'txt2img', params: { prompt: 'a fox', preset: 'krea2:x' }, node: '' });
    const items = await until(async () => { const g = (await a.call('api/gallery')).body.items; return g.length ? g : null; });
    assert.equal(items[0].jobId, 'cj-1');
    assert.equal(items[0].prompt, 'a fox');
    assert.deepEqual([items[0].width, items[0].height], [64, 48]);
    const img = await a.call(`api/gallery/${items[0].id}/image?download=1`);
    assert.ok(img.body.equals(PNG));
    assert.match(img.headers.get('content-disposition'), /attachment; filename="krea-txt2img-5\.png"/);
    assert.equal((await a.call(`api/gallery/${items[0].id}`, { method: 'DELETE' })).status, 200);
    assert.deepEqual((await a.call('api/gallery')).body.items, []);
    assert.equal((await a.call(`api/gallery/${items[0].id}/image`)).status, 404);
  } finally { await a.close(); await d.close(); }
});

test('realtime results are not saved until kept; keeping is idempotent; errors pass through with their status', async () => {
  const d = await fakeDaemon();
  const a = await applet(d.url);
  try {
    const r = await a.post('api/generate', { kind: 'txt2img', params: { prompt: 'rt' }, lane: 'realtime', realtime: true });
    assert.equal(d.st.submitted[0].lane, 'realtime');
    await new Promise((res) => setTimeout(res, 150));
    assert.deepEqual((await a.call('api/gallery')).body.items, [], 'realtime frames do not fill the history');
    assert.equal((await a.post('api/gallery', { jobId: r.body.id })).status, 409, 'not finished yet');
    await until(async () => (await a.call(`api/comfy/jobs/${r.body.id}`)).body.state === 'done');
    const kept = await a.post('api/gallery', { jobId: r.body.id });
    assert.equal(kept.status, 200);
    assert.equal(kept.body.items.length, 1);
    await a.post('api/gallery', { jobId: r.body.id });
    assert.equal((await a.call('api/gallery')).body.items.length, 1);
    const bad = await a.post('api/generate', { kind: 'txt2img', params: { preset: 'missing' } });
    assert.equal(bad.status, 422);
    assert.match(bad.body.error, /not installed/);
    assert.equal((await a.post('api/gallery', { jobId: '../x' })).status, 400);
  } finally { await a.close(); await d.close(); }
});

test('a remote connector machine: settings route the studio through /api/nodes/<node>/comfyui/*', async () => {
  const d = await fakeDaemon();
  const a = await applet(d.url);
  try {
    const nodes = (await a.call('api/nodes')).body.nodes;
    assert.deepEqual(nodes, [{ name: 'here', self: true, online: true, rigs: true }, { name: 'gpu-box', self: false, online: true, rigs: true }], 'only names and state reach the page');
    assert.equal((await a.post('api/settings', { node: 'bad node/..' })).status, 400);
    assert.deepEqual((await a.post('api/settings', { node: 'gpu-box' })).body, { node: 'gpu-box' });
    assert.equal((await a.call('api/comfy/config')).body.node, 'gpu-box');
    await a.post('api/generate', { kind: 'txt2img', params: { prompt: 'remote' } });
    assert.equal(d.st.submitted[0].node, 'gpu-box');
    const items = await until(async () => { const g = (await a.call('api/gallery')).body.items; return g.length ? g : null; });
    assert.equal(items[0].node, 'gpu-box');
    assert.ok(d.st.calls.includes('GET /api/nodes/gpu-box/comfyui/view'), 'the image came from the remote connector');
    await a.post('api/settings', { node: '' });
    assert.equal((await a.call('api/comfy/config')).body.node, 'local');
  } finally { await a.close(); await d.close(); }
});

// ---------------------------------------------------------------- page helpers

test('buildRequest: one body per mode; realtime goes to the realtime lane; empty advanced fields are left out', () => {
  const base = { prompt: ' a cat ', style: 'photo', preset: 'krea2:x', aspect: '16:9', megapixels: 1, seed: '', steps: '', cfg: '', batch: '1' };
  assert.deepEqual(U.buildRequest({ ...base, mode: 'txt2img' }), { kind: 'txt2img', params: { prompt: 'a cat', style: 'photo', preset: 'krea2:x', megapixels: 1, aspect: '16:9', batch: 1 }, realtime: false });
  const rt = U.buildRequest({ ...base, mode: 'txt2img', realtime: true, seed: '42', steps: '6', lora: 'style.safetensors', loraStrength: '0.5' });
  assert.equal(rt.lane, U.REALTIME_LANE);
  assert.equal(rt.realtime, true);
  assert.equal(rt.params.seed, 42);
  assert.equal(rt.params.steps, 6);
  assert.deepEqual(rt.params.lora, { name: 'style.safetensors', strength: 0.5 });
  const i2i = U.buildRequest({ ...base, mode: 'img2img', image: { name: 'in.png', subfolder: 'rigs-krea' }, strength: '0.7' });
  assert.equal(i2i.kind, 'img2img');
  assert.equal(i2i.params.strength, 0.7);
  assert.equal(i2i.params.aspect, undefined, 'img2img keeps the input aspect');
  const up = U.buildRequest({ ...base, mode: 'upscale', image: { name: 'r.png' }, scale: '2', enhance: '0', upscaler: '' });
  assert.deepEqual(up.params, { prompt: 'a cat', style: 'photo', image: { name: 'r.png' }, scale: 2, enhance: 0 }, 'a plain upscale names no model');
  assert.equal(U.buildRequest({ ...base, mode: 'upscale', image: 'r.png', scale: '2', enhance: '0.3' }).params.preset, 'krea2:x');
});

test('progressText and errorView turn job states and failures into clear text', () => {
  assert.equal(U.progressText({ state: 'queued', queuePosition: 2 }), 'Queued (#2 in line)');
  assert.equal(U.progressText({ state: 'running', stage: 'Sampling 3/8', progress: 0.5 }), 'Sampling 3/8 · 50%');
  assert.equal(U.progressText({ state: 'done', elapsedMs: 3210 }), 'Done in 3.2 s');
  assert.equal(U.errorView({ code: 'not_configured', message: 'x' }).settings, true);
  assert.equal(U.errorView({ message: "Can't reach ComfyUI at http://h:1 (ECONNREFUSED)." }).title, 'ComfyUI is not reachable');
  assert.equal(U.errorView({ message: '"a" is not installed on this ComfyUI' }).title, 'A model is missing');
  assert.equal(U.errorView({ code: 'execution', message: 'KSampler failed' }).settings, false);
  assert.equal(U.errorView('weird').title, 'Something went wrong');
  assert.equal(U.viewUrl({ filename: 'a b.png', subfolder: 'rigs-krea' }), 'api/comfy/view?filename=a+b.png&subfolder=rigs-krea&type=output');
});

test('debounce: a burst of edits fires once, with the last arguments; cancel drops it', () => {
  const timers = [];
  const setTimer = (fn, ms) => { const t = { fn, ms, on: true }; timers.push(t); return t; };
  const clearTimer = (t) => { t.on = false; };
  const calls = [];
  const d = U.debounce((v) => calls.push(v), U.REALTIME_DEBOUNCE_MS, { setTimer, clearTimer });
  d('a'); d('ab'); d('abc');
  assert.equal(timers.filter((t) => t.on).length, 1);
  assert.equal(d.pending(), true);
  const due = timers.find((t) => t.on);
  due.on = false;
  due.fn();
  assert.deepEqual(calls, ['abc']);
  d('x');
  d.cancel();
  assert.equal(d.pending(), false);
  assert.equal(timers.filter((t) => t.on).length, 0);
});

test('sketch: pointer positions map to canvas pixels whatever size the canvas is shown at', () => {
  assert.deepEqual(canvasPoint({ left: 10, top: 20, width: 384, height: 384 }, 202, 212, 768, 768), { x: 384, y: 384 });
  assert.deepEqual(canvasPoint({ left: 0, top: 0, width: 300, height: 300 }, 0, 300, 768, 768), { x: 0, y: 768 });
});

test('the App Cloud launch recipe runs this server from the RIGS checkout', () => {
  const unit = fs.readFileSync(path.join(ROOT, 'rigs-krea-studio.service'), 'utf8');
  assert.match(unit, /ExecStart=\/usr\/bin\/node %h\/\.rigs\/app\/applets\/krea-studio\/server\.js/);
  assert.match(unit, /KREA_PORT=8732/);
  assert.match(unit, /WantedBy=default\.target/);
});
