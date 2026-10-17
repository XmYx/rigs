// ComfyUI connector (src/comfyui.js, src/comfyui-workflows.js): URL / auth / settings validation, the
// workflow builders and graph checks, and full round trips against a mocked ComfyUI (HTTP + /ws):
// test connection, txt2img with live progress, a missing model refused before /prompt, realtime lanes
// superseding stale jobs, execution errors, a lost job, auth, the GPU overseer and the HTTP routes.
// No network, no real ComfyUI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-comfy-'));
process.env.RIGS_NO_OPENRIG = '1';
process.env.RIGS_NO_AUTOUPDATE = '1';
process.env.RIGS_NO_MIGRATIONS = '1';
const C = await import('../src/comfyui.js');
const W = await import('../src/comfyui-workflows.js');
const { config, patchConfig, publicConfig } = await import('../src/config.js');

const SECRET = 'Bearer s3cret-token-123';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201ed1d0e5e0000000049454e44ae426082', 'hex');

// ---------------------------------------------------------------- a fake /object_info

const combo = (opts) => ['COMBO', { multiselect: false, options: opts }];
const INFO = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sd15.safetensors', 'LTX23_audio_vae_bf16.safetensors']] } } },
  UNETLoader: { input: { required: { unet_name: [['krea2_turbo_fp8_scaled.safetensors', 'flux2-dev.safetensors']], weight_dtype: [['default', 'fp8_e4m3fn']] } } },
  CLIPLoader: { input: { required: { clip_name: [['qwen3vl_4b_fp8_scaled.safetensors', 't5.safetensors']], type: combo(['sd3', 'flux2', 'krea2']) }, optional: { device: [['default', 'cpu']] } } },
  VAELoader: { input: { required: { vae_name: [['qwen_image_vae.safetensors', 'ae.safetensors']] } } },
  LoraLoader: { input: { required: { model: ['MODEL'], clip: ['CLIP'], lora_name: [['style.safetensors']], strength_model: ['FLOAT'], strength_clip: ['FLOAT'] } } },
  LoraLoaderModelOnly: { input: { required: { model: ['MODEL'], lora_name: [['style.safetensors']], strength_model: ['FLOAT'] } } },
  UpscaleModelLoader: { input: { required: { model_name: combo([]) } } },
  ImageUpscaleWithModel: { input: { required: { upscale_model: ['UPSCALE_MODEL'], image: ['IMAGE'] } } },
  ImageScaleBy: { input: { required: { image: ['IMAGE'], upscale_method: [['nearest-exact', 'bilinear', 'lanczos']], scale_by: ['FLOAT'] } } },
  ImageScaleToTotalPixels: { input: { required: { image: ['IMAGE', {}], upscale_method: combo(['nearest-exact', 'lanczos']), megapixels: ['FLOAT', {}], resolution_steps: ['INT', {}] } } },
  LoadImage: { input: { required: { image: [['example.png'], { image_upload: true }] } } },
  VAEEncode: { input: { required: { pixels: ['IMAGE'], vae: ['VAE'] } } },
  VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } } },
  KSampler: { input: { required: { model: ['MODEL'], seed: ['INT'], steps: ['INT'], cfg: ['FLOAT'], sampler_name: [['euler', 'dpmpp_2m', 'euler_ancestral']], scheduler: [['simple', 'karras', 'sgm_uniform']], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'], denoise: ['FLOAT'] } } },
  CLIPTextEncode: { input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } } },
  ConditioningZeroOut: { input: { required: { conditioning: ['CONDITIONING'] } } },
  EmptyLatentImage: { input: { required: { width: ['INT'], height: ['INT'], batch_size: ['INT'] } } },
  SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'] } } },
};

// ---------------------------------------------------------------- a mocked ComfyUI

/**
 * ComfyUI look-alike: /system_stats, /object_info, /prompt (then replays execution events on /ws to
 * the client id), /history, /queue, /api/jobs/<id>/cancel, /upload/image, /view. `auth` = required
 * Authorization value. st.mode: run | hold (accept, never run) | fail (execution_error) | forget
 * (drop prompts silently: no events, no history, not in the queue).
 */
async function mockComfy({ auth = null } = {}) {
  const st = { prompts: [], cancels: [], uploads: [], history: {}, pending: [], running: new Set(), wsHeaders: [], mode: 'run', seq: 0, requests: [] };
  const sockets = new Map();
  const send = (cid, msg) => { const ws = sockets.get(cid); if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); };
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const read = async (req) => { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c); };

  async function run(p) {
    const tick = () => new Promise((r) => setTimeout(r, 15));
    const { id, cid, graph } = p;
    st.running.add(id);
    try { await execute(p, tick); } finally { st.running.delete(id); }
  }

  async function execute(p, tick) {
    const { id, cid, graph } = p;
    send(cid, { type: 'execution_start', data: { prompt_id: id } });
    for (const nid of Object.keys(graph)) {
      if (p.cancelled) { send(cid, { type: 'execution_interrupted', data: { prompt_id: id } }); return; }
      send(cid, { type: 'executing', data: { node: nid, prompt_id: id } });
      if (graph[nid].class_type === 'KSampler') {
        if (st.mode === 'fail') {
          send(cid, { type: 'execution_error', data: { prompt_id: id, node_id: nid, node_type: 'KSampler', exception_message: 'CUDA out of memory. Tried to allocate 2 GiB', exception_type: 'torch.OutOfMemoryError' } });
          st.history[id] = { status: { status_str: 'error', completed: false, messages: [] }, outputs: {} };
          return;
        }
        for (let v = 1; v <= 3; v++) {
          send(cid, { type: 'progress', data: { value: v, max: 3, node: nid, prompt_id: id } });
          const head = Buffer.alloc(8);
          head.writeUInt32BE(1, 0);
          head.writeUInt32BE(2, 4);
          sockets.get(cid)?.send(Buffer.concat([head, PNG]));
          await tick();
        }
      }
      await tick();
    }
    const out = { filename: `txt2img_${String(++st.seq).padStart(5, '0')}_.png`, subfolder: 'rigs-krea', type: 'output' };
    send(cid, { type: 'executed', data: { node: 'save', output: { images: [out] }, prompt_id: id } });
    st.history[id] = { status: { status_str: 'success', completed: true, messages: [] }, outputs: { save: { images: [out] } } };
    send(cid, { type: 'executing', data: { node: null, prompt_id: id } });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    st.requests.push(`${req.method} ${url.pathname}`);
    if (auth && req.headers.authorization !== auth) return json(res, 401, { error: 'unauthorized' });
    if (url.pathname === '/system_stats') return json(res, 200, { system: { comfyui_version: '0.35.0', python_version: '3.12.1 (main)', pytorch_version: '2.6.0', os: 'linux' }, devices: [{ name: 'cuda:0 NVIDIA Test GPU : cudaMallocAsync', type: 'cuda', vram_total: 25769803776, vram_free: 20000000000 }] });
    if (url.pathname === '/object_info') return json(res, 200, INFO);
    if (url.pathname === '/prompt' && req.method === 'POST') {
      const b = JSON.parse(String(await read(req)));
      const id = `p-${st.prompts.length + 1}`;
      const p = { id, cid: b.client_id, graph: b.prompt, cancelled: false };
      st.prompts.push(p);
      if (st.mode === 'run' || st.mode === 'fail') setTimeout(() => run(p), 10);
      else if (st.mode === 'hold') st.pending.push(p);
      return json(res, 200, { prompt_id: id, number: st.prompts.length, node_errors: {} });
    }
    let m;
    if ((m = url.pathname.match(/^\/history\/(.+)$/))) return json(res, 200, st.history[m[1]] ? { [m[1]]: st.history[m[1]] } : {});
    if (url.pathname === '/queue') return json(res, 200, { queue_running: [...st.running].map((id, i) => [i, id, {}, {}, []]), queue_pending: st.pending.filter((p) => !p.cancelled).map((p, i) => [i, p.id, {}, {}, []]) });
    if ((m = url.pathname.match(/^\/api\/jobs\/(.+)\/cancel$/)) && req.method === 'POST') {
      st.cancels.push(m[1]);
      const p = st.prompts.find((x) => x.id === m[1]);
      if (p) p.cancelled = true;
      return json(res, 200, { cancelled: !!p });
    }
    if (url.pathname === '/upload/image' && req.method === 'POST') {
      const body = await read(req);
      const name = /filename="([^"]+)"/.exec(String(body))?.[1] || 'x.png';
      st.uploads.push({ name, bytes: body.length, type: req.headers['content-type'] });
      return json(res, 200, { name, subfolder: 'rigs-krea', type: 'input' });
    }
    if (url.pathname === '/view') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
    return json(res, 404, { error: 'nope' });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    st.wsHeaders.push(req.headers.authorization || null);
    if (auth && req.headers.authorization !== auth) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    const cid = new URL(req.url, 'http://x').searchParams.get('clientId');
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.set(cid, ws);
      ws.send(JSON.stringify({ type: 'status', data: { status: { exec_info: { queue_remaining: 0 } }, sid: cid } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, st,
    close: () => { for (const ws of sockets.values()) ws.terminate(); wss.close(); server.closeAllConnections?.(); return new Promise((r) => server.close(r)); },
  };
}

const settings = (over = {}) => ({ ...C.DEFAULTS, gpuOverseer: 'off', ...over });
const noOverseer = { resolve: () => '', acquire: async () => ({ ok: true }), release() {} };
const service = (s, extra = {}) => C.createComfyService({ getSettings: () => s, setSettings: () => {}, overseer: noOverseer, pollMs: 40, lostAfterMs: 300, ...extra });
async function waitJob(svc, id, ms = 5000) {
  const until = Date.now() + ms;
  let j;
  const stages = new Set();
  while (Date.now() < until) {
    j = svc.job(id);
    stages.add(j.stage);
    if (['done', 'error', 'cancelled'].includes(j.state)) return { ...j, stages: [...stages] };
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`job ${id} still ${j?.state} (${j?.stage})`);
}

// ---------------------------------------------------------------- settings and validation

test('validateUrl: http(s) only, no credentials/query, trailing slash trimmed, path prefix kept, scheme added', () => {
  assert.deepEqual(C.validateUrl('http://127.0.0.1:8188/'), { url: 'http://127.0.0.1:8188' });
  assert.deepEqual(C.validateUrl('https://gpu.example.com/comfy//'), { url: 'https://gpu.example.com/comfy' });
  assert.deepEqual(C.validateUrl('  192.168.1.20:8188 '), { url: 'http://192.168.1.20:8188' });
  assert.deepEqual(C.validateUrl(''), { url: '' });
  for (const bad of ['ftp://host:21', 'http://user:pw@host:8188', 'http://host:8188/?x=1', 'http://host:8188/#a', 'http://ho st', 'http://']) {
    assert.ok(C.validateUrl(bad).error, `${bad} should be rejected`);
  }
  assert.match(C.validateUrl('http://user:pw@host').error, /auth header/);
});

test('parseAuthHeader: "Name: value", a bare value → Authorization, one line only', () => {
  assert.deepEqual(C.parseAuthHeader('X-Api-Key: abc123'), { name: 'X-Api-Key', value: 'abc123' });
  assert.deepEqual(C.parseAuthHeader('Bearer abc'), { name: 'Authorization', value: 'Bearer abc' });
  assert.deepEqual(C.parseAuthHeader('Authorization: Basic dXNlcjpwdw=='), { name: 'Authorization', value: 'Basic dXNlcjpwdw==' });
  assert.equal(C.parseAuthHeader('  '), null);
  assert.throws(() => C.parseAuthHeader('Authorization: a\r\nX-Evil: 1'), /single line/);
});

test('validateSettings: keeps the stored secret unless replaced or cleared; errors never echo it', () => {
  const prev = { ...C.DEFAULTS, url: 'http://a:8188', authHeader: `Authorization: ${SECRET}` };
  assert.equal(C.validateSettings({ url: 'http://b:8188' }, prev).value.authHeader, `Authorization: ${SECRET}`, 'kept');
  assert.equal(C.validateSettings({ clearAuth: true }, prev).value.authHeader, '', 'cleared');
  assert.equal(C.validateSettings({ authHeader: '' }, prev).value.authHeader, '', 'emptied');
  assert.equal(C.validateSettings({ authHeader: 'X-Key: k' }, prev).value.authHeader, 'X-Key: k', 'replaced');
  const r = C.validateSettings({ url: 'nope://x', authHeader: `${SECRET}\nX: y`, gpuOverseer: 'ftp://x', gpuNeedMb: -5, timeoutSec: 1 }, prev);
  assert.equal(r.errors.length, 5, r.errors.join(' | '));
  assert.ok(!r.errors.join(' ').includes('s3cret'), 'secret not echoed');
  assert.equal(C.validateSettings({ gpuOverseer: 'http://10.0.0.2:8195/' }).value.gpuOverseer, 'http://10.0.0.2:8195');
});

test('publicSettings and redact never expose the auth value', () => {
  const p = C.publicSettings({ ...C.DEFAULTS, url: 'http://a', authHeader: `Authorization: ${SECRET}` });
  assert.deepEqual(p.auth, { set: true, name: 'Authorization' });
  assert.ok(!JSON.stringify(p).includes('s3cret'));
  assert.equal(C.redact(`failed with ${SECRET}`, [SECRET]), 'failed with •••');
});

test('settings persist in RIGS config per machine; the generic config API can neither change nor read them', () => {
  C.saveSettings({ url: 'http://10.1.1.5:8188/', authHeader: `Authorization: ${SECRET}` });
  const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.RIGS_HOME, 'config.json'), 'utf8'));
  assert.equal(onDisk.comfyui.url, 'http://10.1.1.5:8188');
  assert.equal(C.loadSettings().authHeader, `Authorization: ${SECRET}`);
  assert.throws(() => C.saveSettings({ url: 'gopher://x' }), /url/);
  patchConfig({ comfyui: { url: 'http://evil:1', authHeader: 'x' } });
  assert.equal(config().comfyui.url, 'http://10.1.1.5:8188', 'POST /api/local/config cannot bypass validation');
  assert.ok(!JSON.stringify(publicConfig()).includes('s3cret'), 'GET /api/local/config never returns the secret');
  C.saveSettings({ url: '', clearAuth: true });
});

// ---------------------------------------------------------------- workflow builders

test('sizeFor: aspect at a pixel budget, multiples of 16, clamped; bad input is a 400', () => {
  assert.deepEqual(W.sizeFor('1:1', 1), { width: 1024, height: 1024 });
  const w = W.sizeFor('16:9', 1);
  assert.equal(w.width % 16, 0);
  assert.equal(w.height % 16, 0);
  assert.ok(Math.abs(w.width / w.height - 16 / 9) < 0.03);
  assert.deepEqual(W.sizeFor('1:1', 0.25), { width: 512, height: 512 });
  assert.throws(() => W.sizeFor('wide', 1), /aspect/);
  assert.throws(() => W.sizeFor('9:1', 1), /between/);
  assert.equal(W.sizeFor('1:1', 4).width, 2048);
});

test('parseModels reads old and new combo shapes; presets: Krea 2 first, image checkpoints, no VAE/audio files', () => {
  const m = W.parseModels(INFO);
  assert.deepEqual(m.clipTypes, ['sd3', 'flux2', 'krea2']);
  assert.deepEqual(m.upscalers, []);
  assert.deepEqual(m.loras, ['style.safetensors']);
  const presets = W.buildPresets(m);
  assert.deepEqual(presets.map((p) => p.id), ['krea2:krea2_turbo_fp8_scaled.safetensors', 'ckpt:sd15.safetensors']);
  assert.equal(presets[0].label, 'Krea 2 Turbo');
  assert.deepEqual(presets[0].model, { family: 'unet', unet: 'krea2_turbo_fp8_scaled.safetensors', clip: 'qwen3vl_4b_fp8_scaled.safetensors', clipType: 'krea2', vae: 'qwen_image_vae.safetensors', weightDtype: 'default' });
  assert.deepEqual(presets[0].defaults, { steps: 8, cfg: 1, sampler: 'euler', scheduler: 'simple' });
  assert.equal(W.buildPresets({ ...m, clipTypes: ['sd3'] }).length, 1, 'no Krea preset without the krea2 text-encoder type');
});

const KREA = { family: 'unet', unet: 'krea2_turbo_fp8_scaled.safetensors', clip: 'qwen3vl_4b_fp8_scaled.safetensors', clipType: 'krea2', vae: 'qwen_image_vae.safetensors' };
const SD = { family: 'checkpoint', ckpt: 'sd15.safetensors' };

test('txt2img: split loaders with a zeroed negative at cfg 1; checkpoint + LoRA wires model and clip through it', () => {
  const p = W.normalizeParams({ model: KREA, prompt: 'a fox', style: 'photo', aspect: '1:1', megapixels: 1, seed: 7, steps: 8, cfg: 1 });
  assert.equal(p.text, `a fox, ${W.STYLES.find((s) => s.id === 'photo').prompt}`);
  const g = W.buildTxt2Img(p);
  assert.equal(g.unet.class_type, 'UNETLoader');
  assert.deepEqual(g.clip.inputs, { clip_name: KREA.clip, type: 'krea2' });
  assert.equal(g.neg.class_type, 'ConditioningZeroOut');
  assert.deepEqual(g.latent.inputs, { width: 1024, height: 1024, batch_size: 1 });
  assert.deepEqual(g.sampler.inputs, { seed: 7, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['unet', 0], positive: ['pos', 0], negative: ['neg', 0], latent_image: ['latent', 0] });
  assert.equal(g.save.inputs.filename_prefix, 'rigs-krea/txt2img');
  assert.deepEqual(W.checkGraph(g, INFO), []);

  const g2 = W.buildTxt2Img(W.normalizeParams({ model: SD, prompt: 'x', negative: 'blurry', cfg: 7, lora: { name: 'style.safetensors', strength: 0.6 } }, { defaults: { steps: 25, sampler: 'dpmpp_2m', scheduler: 'karras' } }));
  assert.deepEqual(g2.lora.inputs, { model: ['ckpt', 0], clip: ['ckpt', 1], lora_name: 'style.safetensors', strength_model: 0.6, strength_clip: 0.6 });
  assert.deepEqual(g2.pos.inputs.clip, ['lora', 1]);
  assert.equal(g2.neg.class_type, 'CLIPTextEncode');
  assert.equal(g2.neg.inputs.text, 'blurry');
  assert.deepEqual(g2.sampler.inputs.model, ['lora', 0]);
  assert.equal(g2.sampler.inputs.steps, 25, 'preset default');
  assert.deepEqual(g2.decode.inputs.vae, ['ckpt', 2]);
  assert.deepEqual(W.checkGraph(g2, INFO), []);
  const g3 = W.buildTxt2Img(W.normalizeParams({ model: KREA, prompt: 'x', lora: { name: 'style.safetensors' } }));
  assert.equal(g3.lora.class_type, 'LoraLoaderModelOnly');
});

test('img2img: uploaded image (subfolder/name), fit to the size budget, denoise = strength; needs an image', () => {
  const p = W.normalizeParams({ model: KREA, prompt: 'oil painting', image: { name: 'sketch.png', subfolder: 'rigs-krea' }, strength: 0.7, megapixels: 0.5, cfg: 1 });
  const g = W.buildImg2Img(p);
  assert.equal(g.load.inputs.image, 'rigs-krea/sketch.png');
  assert.deepEqual(g.fit.inputs, { image: ['load', 0], upscale_method: 'lanczos', megapixels: 0.5, resolution_steps: 16 });
  assert.deepEqual(g.encode.inputs, { pixels: ['fit', 0], vae: ['vae', 0] });
  assert.equal(g.sampler.inputs.denoise, 0.7);
  assert.deepEqual(g.sampler.inputs.latent_image, ['encode', 0]);
  assert.deepEqual(W.checkGraph(g, INFO), [], 'the uploaded file is not checked against the stale LoadImage list');
  assert.throws(() => W.buildImg2Img(W.normalizeParams({ model: KREA })), /input image/);
  for (const bad of ['../../etc/passwd', { name: 'x.png', subfolder: '../..' }, { name: '/abs.png' }]) assert.throws(() => W.imageRef(bad), /uploaded image/);
});

test('upscale: lanczos resize, a model upscale resized to the asked factor, an optional enhance pass', () => {
  const plain = W.buildUpscale(W.normalizeParams({ image: 'r.png', scale: 2 }, { needModel: false }));
  assert.deepEqual(Object.keys(plain), ['load', 'resize', 'save']);
  assert.deepEqual(plain.resize.inputs, { image: ['load', 0], upscale_method: 'lanczos', scale_by: 2 });
  const model = W.buildUpscale(W.normalizeParams({ image: 'r.png', scale: 2, upscaler: '4x-UltraSharp.pth' }, { needModel: false }));
  assert.equal(model.upscale.class_type, 'ImageUpscaleWithModel');
  assert.equal(model.resize.inputs.scale_by, 0.5, '4× model then ×0.5 = 2×');
  assert.equal(W.upscalerFactor('RealESRGAN_x2plus.pth'), 2);
  assert.equal(W.upscalerFactor('2xNomosUni.safetensors'), 2);
  assert.equal(W.upscalerFactor('something.pth'), 4);
  const same = W.buildUpscale(W.normalizeParams({ image: 'r.png', scale: 4, upscaler: '4x_foolhardy.pth' }, { needModel: false }));
  assert.equal(same.resize, undefined, 'no resize when the model already gives the factor');
  const enh = W.buildUpscale(W.normalizeParams({ image: 'r.png', scale: 2, enhance: 0.3, model: KREA, prompt: 'p', cfg: 1 }));
  assert.deepEqual(enh.encode.inputs.pixels, ['resize', 0]);
  assert.equal(enh.sampler.inputs.denoise, 0.3);
  assert.deepEqual(enh.save.inputs.images, ['decode', 0]);
  assert.equal(W.needsModel('upscale', { enhance: 0 }), false);
  assert.equal(W.needsModel('upscale', { enhance: 0.2 }), true);
  // no upscale models installed → a clear "missing model" problem before anything is queued
  const probs = W.checkGraph(model, INFO);
  assert.equal(probs[0].code, 'missing_model');
  assert.match(probs[0].message, /no model models are installed on this ComfyUI \("4x-UltraSharp\.pth" was asked for\)/);
});

test('checkGraph: a missing model, a missing node class and a bad sampler are reported with the node', () => {
  const g = W.buildTxt2Img(W.normalizeParams({ model: { ...SD, ckpt: 'gone.safetensors' }, prompt: 'x', sampler: 'nope' }));
  g.extra = { class_type: 'SomeCustomNode', inputs: {} };
  const probs = W.checkGraph(g, INFO);
  assert.deepEqual(probs.map((p) => p.code).sort(), ['bad_value', 'missing_model', 'missing_node']);
  const mm = probs.find((p) => p.code === 'missing_model');
  assert.equal(mm.nodeId, 'ckpt');
  assert.match(mm.message, /"gone\.safetensors" is not installed.*sd15\.safetensors/);
});

test('normalizeParams: bad input is a 400 before any graph exists; values are clamped', () => {
  assert.throws(() => W.normalizeParams({}), /pick a model/);
  assert.throws(() => W.normalizeParams({ model: { family: 'unet', unet: 'x' } }), /needs unet, clip/);
  assert.throws(() => W.normalizeParams({ model: SD, steps: 'many' }), /number/);
  const p = W.normalizeParams({ model: SD, steps: 999, cfg: -3, batch: 9, strength: 5 });
  assert.equal(p.steps, 150);
  assert.equal(p.cfg, 0);
  assert.equal(p.batch, 4);
  assert.equal(p.strength, 1);
  assert.ok(p.seed >= 0 && p.seed < W.MAX_SEED, 'a random seed when none is given');
});

// ---------------------------------------------------------------- round trips against the mock

test('test connection: version, GPU, models and presets; unreachable and wrong-auth answers are clear and never leak the secret', async () => {
  const mock = await mockComfy({ auth: SECRET });
  try {
    const svc = service(settings({ url: mock.url, authHeader: `Authorization: ${SECRET}` }));
    const ok = await svc.test();
    assert.equal(ok.ok, true, JSON.stringify(ok.error));
    assert.equal(ok.version, '0.35.0');
    assert.equal(ok.devices[0].name, 'NVIDIA Test GPU');
    assert.deepEqual(ok.models.checkpoints, ['sd15.safetensors', 'LTX23_audio_vae_bf16.safetensors']);
    assert.deepEqual(ok.presets.map((p) => p.label), ['Krea 2 Turbo', 'sd15']);

    const wrong = await svc.test({ url: mock.url, authHeader: 'Authorization: Bearer wrong-value-999' });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.error.code, 'auth');
    assert.match(wrong.error.message, /refused the request \(HTTP 401\).*auth header/);
    assert.ok(!JSON.stringify(wrong).includes('wrong-value-999') && !JSON.stringify(wrong).includes('s3cret'));

    const down = await svc.test({ url: 'http://127.0.0.1:9' });
    assert.equal(down.ok, false);
    assert.equal(down.error.code, 'unreachable');
    assert.match(down.error.message, /Can't reach ComfyUI at http:\/\/127\.0\.0\.1:9/);

    const notComfy = await service(settings()).test({ url: `${mock.url}/nope`, authHeader: `Authorization: ${SECRET}` });
    assert.equal(notComfy.ok, false);
  } finally { await mock.close(); }
});

test('txt2img round trip: graph from the template, auth on HTTP and /ws, live progress, previews, outputs', async () => {
  const mock = await mockComfy({ auth: SECRET });
  const svc = service(settings({ url: mock.url, authHeader: `Authorization: ${SECRET}` }));
  try {
    const j0 = await svc.submit({ kind: 'txt2img', params: { preset: 'krea2:krea2_turbo_fp8_scaled.safetensors', prompt: 'a fox', aspect: '1:1', megapixels: 0.25, seed: 42 } });
    assert.equal(j0.state, 'preparing');
    assert.deepEqual([j0.params.width, j0.params.height, j0.params.seed, j0.params.steps, j0.params.presetLabel], [512, 512, 42, 8, 'Krea 2 Turbo']);
    let sawPreview = false;
    const until = Date.now() + 5000;
    while (Date.now() < until && !['done', 'error'].includes(svc.job(j0.id).state)) {
      if (svc.preview(j0.id)) sawPreview = true;
      await new Promise((r) => setTimeout(r, 3));
    }
    const j = await waitJob(svc, j0.id);
    assert.equal(j.state, 'done', JSON.stringify(j.error));
    assert.equal(j.progress, 1);
    assert.deepEqual(j.outputs, [{ filename: 'txt2img_00001_.png', subfolder: 'rigs-krea', type: 'output' }]);
    assert.ok(sawPreview, 'binary preview frames reach the job');
    const sent = mock.st.prompts[0].graph;
    assert.equal(sent.sampler.inputs.seed, 42);
    assert.equal(sent.unet.inputs.unet_name, 'krea2_turbo_fp8_scaled.safetensors');
    assert.deepEqual(mock.st.wsHeaders, [SECRET], 'the event socket carries the auth header');
    assert.ok(mock.st.prompts[0].cid, 'the prompt names the socket client id');
  } finally { svc.close(); await mock.close(); }
});

test('progress stages over /ws: loading, sampling n/m, done — never stuck at "queued"', async () => {
  const mock = await mockComfy();
  const svc = service(settings({ url: mock.url }));
  try {
    const j = await waitJob(svc, (await svc.submit({ kind: 'txt2img', params: { prompt: 'x', megapixels: 0.25 } })).id);
    assert.equal(j.state, 'done');
    assert.ok(j.stages.some((s) => /Sampling \d\/3/.test(s)), j.stages.join(', '));
    assert.ok(j.stages.includes('Loading model'), j.stages.join(', '));
  } finally { svc.close(); await mock.close(); }
});

test('a missing model is refused (422) before /prompt: nothing is ever queued for it', async () => {
  const mock = await mockComfy();
  const svc = service(settings({ url: mock.url }));
  try {
    await assert.rejects(
      svc.submit({ kind: 'txt2img', params: { preset: 'krea2:krea2_turbo_fp8_scaled.safetensors', prompt: 'x', lora: { name: 'not-here.safetensors' } } }),
      (e) => e.status === 422 && e.code === 'missing_model' && /not-here\.safetensors" is not installed/.test(e.message),
    );
    await assert.rejects(svc.submit({ kind: 'txt2img', params: { preset: 'ckpt:gone.safetensors', prompt: 'x' } }), (e) => e.status === 422 && /not installed/.test(e.message));
    await assert.rejects(svc.submit({ kind: 'upscale', params: { image: 'r.png', upscaler: '4x.pth' } }), (e) => e.code === 'missing_model');
    await assert.rejects(svc.submit({ kind: 'raw', graph: { a: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'downloads-me.safetensors' } } } }), (e) => e.code === 'missing_model', 'raw graphs are checked too');
    await assert.rejects(svc.submit({ kind: 'img2img', params: { prompt: 'x' } }), (e) => e.status === 400 && /input image/.test(e.message));
    await assert.rejects(svc.submit({ kind: 'video', params: {} }), (e) => e.status === 400);
    assert.equal(mock.st.prompts.length, 0, 'no /prompt was sent');
  } finally { svc.close(); await mock.close(); }
});

test('a refusal re-reads a stale /object_info first: a model added since is accepted', async () => {
  const mock = await mockComfy();
  let t = 0;
  const svc = service(settings({ url: mock.url }), { now: () => t });
  try {
    await svc.models(); // cache /object_info at t=0
    INFO.LoraLoaderModelOnly.input.required.lora_name[0].push('new.safetensors');
    t = 10000;
    const j = await svc.submit({ kind: 'txt2img', params: { prompt: 'x', megapixels: 0.25, lora: { name: 'new.safetensors' } } });
    assert.equal(j.state, 'preparing');
    assert.ok(mock.st.requests.filter((r) => r === 'GET /object_info').length >= 2);
  } finally {
    INFO.LoraLoaderModelOnly.input.required.lora_name[0].pop();
    svc.close();
    await mock.close();
  }
});

test('realtime lane: a newer request cancels the stale one in ComfyUI; prompts never pile up', async () => {
  const mock = await mockComfy();
  mock.st.mode = 'hold';
  const svc = service(settings({ url: mock.url }));
  try {
    const a = await svc.submit({ kind: 'txt2img', lane: 'realtime', params: { prompt: 'a', megapixels: 0.25 } });
    const until = Date.now() + 3000;
    while (svc.job(a.id).state !== 'queued' && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    assert.equal(svc.job(a.id).state, 'queued');
    const b = await svc.submit({ kind: 'txt2img', lane: 'realtime', params: { prompt: 'ab', megapixels: 0.25 } });
    const c = await svc.submit({ kind: 'txt2img', lane: 'realtime', params: { prompt: 'abc', megapixels: 0.25 } });
    const other = await svc.submit({ kind: 'txt2img', params: { prompt: 'not in the lane', megapixels: 0.25 } });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(svc.job(a.id).state, 'cancelled');
    assert.equal(svc.job(a.id).stage, 'Superseded by a newer request');
    assert.equal(svc.job(b.id).state, 'cancelled', 'b was superseded before it was even queued');
    assert.ok(mock.st.cancels.includes(svc.job(a.id).promptId), 'ComfyUI was told to drop the stale prompt');
    assert.equal(svc.job(c.id).state, 'queued');
    assert.equal(svc.job(other.id).state, 'queued', 'jobs outside the lane are untouched');
    const live = mock.st.prompts.filter((p) => !p.cancelled).map((p) => p.graph.pos.inputs.text);
    assert.deepEqual(live.sort(), ['abc', 'not in the lane']);
    await svc.cancel(c.id);
    assert.equal(svc.job(c.id).state, 'cancelled');
  } finally { svc.close(); await mock.close(); }
});

test('an execution error ends the job with the node, the message and a hint', async () => {
  const mock = await mockComfy();
  mock.st.mode = 'fail';
  const svc = service(settings({ url: mock.url }));
  try {
    const j = await waitJob(svc, (await svc.submit({ kind: 'txt2img', params: { prompt: 'x', megapixels: 0.25 } })).id);
    assert.equal(j.state, 'error');
    assert.equal(j.error.code, 'execution');
    assert.equal(j.error.nodeType, 'KSampler');
    assert.match(j.error.message, /KSampler \(#sampler\) failed: CUDA out of memory.*GPU ran out of memory/);
  } finally { svc.close(); await mock.close(); }
});

test('a job ComfyUI forgets (restart, cleared queue) fails clearly instead of hanging', async () => {
  const mock = await mockComfy();
  mock.st.mode = 'forget';
  const svc = service(settings({ url: mock.url }));
  try {
    const j = await waitJob(svc, (await svc.submit({ kind: 'txt2img', params: { prompt: 'x', megapixels: 0.25 } })).id, 8000);
    assert.equal(j.state, 'error');
    assert.equal(j.error.code, 'lost');
    assert.match(j.error.message, /no longer knows this job/);
  } finally { svc.close(); await mock.close(); }
});

test('the user URL wins over the detected one; with neither, jobs are refused with a settings hint', async () => {
  const mock = await mockComfy();
  try {
    const detectedOnly = service(settings(), { suggest: async () => ({ url: mock.url }) });
    assert.deepEqual((await detectedOnly.getConfig()).effective, { url: mock.url, source: 'detected' });
    const both = service(settings({ url: 'http://10.9.9.9:8188' }), { suggest: async () => ({ url: mock.url }) });
    assert.deepEqual((await both.getConfig()).effective, { url: 'http://10.9.9.9:8188', source: 'configured' });
    const none = service(settings());
    await assert.rejects(none.submit({ kind: 'txt2img', params: { prompt: 'x' } }), (e) => e.code === 'not_configured' && e.status === 409 && /Open Settings/.test(e.message));
    await assert.rejects(none.models(), (e) => e.code === 'not_configured');
  } finally { await mock.close(); }
});

test('GPU overseer: a local ComfyUI takes a lease before queueing and releases it after the burst', async () => {
  const calls = [];
  const ov = http.createServer(async (req, res) => {
    const c = [];
    for await (const x of req) c.push(x);
    calls.push({ path: req.url, body: JSON.parse(String(Buffer.concat(c)) || '{}') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/acquire' ? { ok: true, free_mb: 20000, unloaded: ['acestep-studio'] } : { ok: true }));
  });
  await new Promise((r) => ov.listen(0, '127.0.0.1', r));
  const ovUrl = `http://127.0.0.1:${ov.address().port}`;
  const mock = await mockComfy();
  const overseer = C.createOverseer({ releaseDelayMs: 80 });
  assert.equal(overseer.resolve({ gpuOverseer: 'auto' }, 'http://127.0.0.1:8188'), C.OVERSEER_URL, 'auto → the local overseer for a local ComfyUI');
  assert.equal(overseer.resolve({ gpuOverseer: 'auto' }, 'http://10.0.0.7:8188'), '', 'auto → none for a remote ComfyUI');
  assert.equal(overseer.resolve({ gpuOverseer: 'off' }, 'http://127.0.0.1:8188'), '');
  const svc = C.createComfyService({ getSettings: () => settings({ url: mock.url, gpuOverseer: ovUrl, gpuNeedMb: 9000 }), overseer, pollMs: 40 });
  try {
    const j = await waitJob(svc, (await svc.submit({ kind: 'txt2img', params: { prompt: 'x', megapixels: 0.25 } })).id);
    assert.equal(j.state, 'done');
    assert.deepEqual(calls[0], { path: '/api/acquire', body: { client: 'comfyui', need_mb: 9000, timeout: 60 } });
    await new Promise((r) => setTimeout(r, 250));
    assert.deepEqual(calls.at(-1), { path: '/api/release', body: { client: 'comfyui' } });
  } finally { svc.close(); await mock.close(); await new Promise((r) => ov.close(r)); }
});

test('HTTP routes: config, test, models, jobs, upload and view, with clear status codes', async () => {
  const mock = await mockComfy();
  let stored = settings();
  const svc = C.createComfyService({
    getSettings: () => stored,
    setSettings: (input) => { const r = C.validateSettings(input, stored); if (r.errors.length) throw new C.ComfyError('bad_request', r.errors.join('; ')); stored = r.value; },
    overseer: noOverseer, pollMs: 40,
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = async () => { const c = []; for await (const x of req) c.push(x); const t = String(Buffer.concat(c)); return t ? JSON.parse(t) : {}; };
    try {
      const out = await C.comfyRoute(svc, { method: req.method, sub: url.pathname.slice(1), q: url.searchParams, req, res, body });
      if (out !== undefined) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); }
    } catch (e) { res.writeHead(e.status || 500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const call = async (p, opts = {}) => {
    const r = await fetch(base + p, opts);
    const type = r.headers.get('content-type') || '';
    return { status: r.status, type, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  const post = (p, json) => call(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) });
  try {
    assert.equal((await post('jobs', { kind: 'txt2img', params: { prompt: 'x' } })).status, 409, 'not configured');
    assert.equal((await post('config', { url: 'gopher://x' })).status, 400);
    const cfg = await post('config', { url: mock.url, authHeader: 'X-Key: hidden-key-77' });
    assert.equal(cfg.status, 200);
    assert.deepEqual(cfg.body.config.auth, { set: true, name: 'X-Key' });
    assert.ok(!JSON.stringify(cfg.body).includes('hidden-key-77'));
    await post('config', { clearAuth: true });
    assert.equal((await post('test', {})).body.ok, true);
    const m = await call('models');
    assert.equal(m.body.presets[0].label, 'Krea 2 Turbo');
    assert.equal(m.body.styles.length, W.STYLES.length);
    const up = await call('upload?name=../../evil name.png', { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG });
    assert.equal(up.status, 200);
    assert.ok(!up.body.name.includes('/'), 'upload names are sanitized');
    assert.equal((await call('upload', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hi' })).status, 400);
    const job = await post('jobs', { kind: 'img2img', params: { prompt: 'p', image: up.body, strength: 0.5, megapixels: 0.25 } });
    assert.equal(job.status, 200);
    const done = await waitJob(svc, job.body.id);
    assert.equal(done.state, 'done');
    assert.equal(mock.st.prompts.at(-1).graph.load.inputs.image, `rigs-krea/${up.body.name}`);
    const v = await call(`view?filename=${done.outputs[0].filename}&subfolder=rigs-krea&type=output`);
    assert.equal(v.status, 200);
    assert.equal(v.type, 'image/png');
    assert.ok(v.body.equals(PNG));
    assert.equal((await call('view?filename=../x.png')).status, 400);
    assert.equal((await call(`jobs/${job.body.id}`)).body.state, 'done');
    assert.equal((await call('jobs/nope')).status, 404);
    assert.equal((await call(`jobs/${job.body.id}/preview`)).status, 404, 'no preview after the job ended');
    assert.equal((await post('jobs', { kind: 'txt2img', params: { preset: 'ckpt:missing.safetensors', prompt: 'x' } })).status, 422);
    assert.equal((await call('nope')).status, 404);
  } finally { svc.close(); await mock.close(); await new Promise((r) => server.close(r)); }
});
