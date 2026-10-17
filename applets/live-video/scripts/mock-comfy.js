#!/usr/bin/env node
// A fake ComfyUI (HTTP + websocket) for tests and for trying the applet without a GPU:
//   GET /system_stats · GET /object_info · POST /prompt · GET|POST /queue · POST /interrupt
//   GET /history/:id · GET /view · POST /upload/image · /ws?clientId=
// Prompts run one at a time: execution_start, `steps` progress ticks over genMs, executed, executing
// node=null, execution_success, then /history has the outputs. /object_info is built from the applet's
// own templates, so they pass the check unless `missingNodes` / `missingModels` take something away.
//
//   node applets/live-video/scripts/mock-comfy.js [--port=8189] [--gen-ms=4000] [--missing]
// With ffmpeg on PATH the CLI makes a few colourful test clips, so the player has something to show.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { loadTemplates } from '../workflows.js';

/** /object_info for every class the templates use; model inputs list `models` (default: the templates' own files). */
export function mockObjectInfo({ templates = loadTemplates(), missingNodes = [], missingModels = [], extraModels = [] } = {}) {
  const info = {};
  const modelInputs = new Set();
  for (const t of templates.values()) for (const r of Object.values(t.models || {})) modelInputs.add(`${t.workflow[r.node].class_type}.${r.input}`);
  for (const t of templates.values()) {
    for (const n of Object.values(t.workflow)) {
      if (missingNodes.includes(n.class_type)) continue;
      const def = (info[n.class_type] ||= { input: { required: {} }, output: [], name: n.class_type });
      for (const [k, v] of Object.entries(n.inputs)) {
        if (Array.isArray(v)) { def.input.required[k] ||= ['*', {}]; continue; }
        if (typeof v !== 'string' || ['text', 'filename_prefix'].includes(k)) { def.input.required[k] ||= [typeof v === 'number' ? 'INT' : typeof v === 'boolean' ? 'BOOLEAN' : 'STRING', {}]; continue; }
        const list = (def.input.required[k] ||= [[]])[0];
        if (!Array.isArray(list)) continue;
        const isModel = modelInputs.has(`${n.class_type}.${k}`);
        if (!(isModel && missingModels.includes(v)) && !list.includes(v)) list.push(v);
        if (isModel) for (const e of extraModels) if (!list.includes(e)) list.push(e);
      }
    }
  }
  return info;
}

// A valid 1×1 PNG, the last-frame image when no real frames were made.
const PNG_1PX = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cf500f0004850181d1a3f5e10000000049454e44ae426082', 'hex');

export function createMockComfy({ templates = loadTemplates(), genMs = 80, steps = 4, missingNodes = [], missingModels = [], extraModels = [], requireAuth = null, clips = [], posters = [], failPrompts = 0 } = {}) {
  const objectInfo = mockObjectInfo({ templates, missingNodes, missingModels, extraModels });
  const prompts = [];   // every accepted /prompt: {id, number, clientId, workflow}
  const queue = [];     // waiting ids
  const history = {};
  const interrupts = []; // bodies of /interrupt calls
  const deletes = [];    // ids asked to be deleted
  const uploads = [];    // {filename, bytes}
  const sockets = new Map(); // clientId → Set<ws>
  let running = null;    // {id, timer, step}
  let counter = 0;
  let failLeft = failPrompts;
  const clipBuffers = clips.length ? clips.map((f) => fs.readFileSync(f)) : [Buffer.from('1a45dfa3', 'hex')];
  const posterBuffers = posters.length ? posters.map((f) => fs.readFileSync(f)) : [PNG_1PX];

  const send = (clientId, type, data) => { for (const ws of sockets.get(clientId) || []) if (ws.readyState === 1) ws.send(JSON.stringify({ type, data })); };
  const broadcastStatus = () => { for (const id of sockets.keys()) send(id, 'status', { status: { exec_info: { queue_remaining: queue.length + (running ? 1 : 0) } } }); };

  function outputsFor(p) {
    const wf = p.workflow;
    const out = {};
    for (const [id, n] of Object.entries(wf)) {
      if (n.class_type === 'SaveWEBM') out[id] = { images: [{ filename: `${String(n.inputs.filename_prefix).split('/').pop()}_${String(p.number).padStart(5, '0')}_.webm`, subfolder: String(n.inputs.filename_prefix).split('/').slice(0, -1).join('/'), type: 'output' }], animated: [true] };
      if (n.class_type === 'PreviewImage') out[id] = { images: [{ filename: `ComfyUI_temp_${p.number}.png`, subfolder: '', type: 'temp' }] };
    }
    return out;
  }

  function runNext() {
    if (running || !queue.length) return;
    const id = queue.shift();
    const p = prompts.find((x) => x.id === id);
    running = { id, step: 0, timer: null };
    send(p.clientId, 'execution_start', { prompt_id: id, timestamp: Date.now() });
    send(p.clientId, 'executing', { node: Object.keys(p.workflow)[0], display_node: Object.keys(p.workflow)[0], prompt_id: id });
    const tick = () => {
      if (!running || running.id !== id) return;
      running.step++;
      send(p.clientId, 'progress', { value: running.step, max: steps, prompt_id: id, node: 'sampler' });
      if (running.step < steps) { running.timer = setTimeout(tick, genMs / steps); return; }
      running = null;
      if (failLeft > 0) {
        failLeft--;
        history[id] = { prompt: [p.number, id, p.workflow], outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_error', { prompt_id: id, node_type: 'SamplerCustom', exception_message: 'mock failure' }]] } };
        send(p.clientId, 'execution_error', { prompt_id: id, node_type: 'SamplerCustom', exception_message: 'mock failure' });
      } else {
        const outputs = outputsFor(p);
        history[id] = { prompt: [p.number, id, p.workflow], outputs, status: { status_str: 'success', completed: true, messages: [] } };
        for (const [node, output] of Object.entries(outputs)) send(p.clientId, 'executed', { node, output, prompt_id: id });
        send(p.clientId, 'executing', { node: null, prompt_id: id });
        send(p.clientId, 'execution_success', { prompt_id: id, timestamp: Date.now() });
      }
      broadcastStatus();
      setImmediate(runNext);
    };
    running.timer = setTimeout(tick, genMs / steps);
  }

  const body = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
  const json = (res, status, data) => { const b = Buffer.from(JSON.stringify(data)); res.writeHead(status, { 'content-type': 'application/json', 'content-length': b.length }); res.end(b); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const p = url.pathname;
    if (requireAuth && req.headers[requireAuth.header.toLowerCase()] !== requireAuth.value) return json(res, 401, { error: 'unauthorized' });
    if (p === '/system_stats') return json(res, 200, { system: { os: 'posix', comfyui_version: '0.0.0-mock', python_version: '3.12' }, devices: [{ name: 'cuda:0 Mock GPU', type: 'cuda', index: 0, vram_total: 24 * 2 ** 30, vram_free: 20 * 2 ** 30 }] });
    if (p === '/object_info') return json(res, 200, objectInfo);
    if (p === '/prompt' && req.method === 'POST') {
      const b = JSON.parse((await body(req)).toString() || '{}');
      const wf = b.prompt || {};
      const bad = Object.entries(wf).filter(([, n]) => !objectInfo[n.class_type]);
      if (bad.length) return json(res, 400, { error: { type: 'invalid_prompt', message: 'Cannot execute because a node is missing the class_type property.', details: `Node ID '#${bad[0][0]}'` }, node_errors: {} });
      const id = `mock-${++counter}-${Math.random().toString(36).slice(2, 8)}`;
      prompts.push({ id, number: counter, clientId: b.client_id, workflow: wf });
      queue.push(id);
      setImmediate(runNext);
      return json(res, 200, { prompt_id: id, number: counter, node_errors: {} });
    }
    if (p === '/queue' && req.method === 'GET') {
      const entry = (id) => { const x = prompts.find((q) => q.id === id); return [x.number, id, x.workflow, { client_id: x.clientId }, []]; };
      return json(res, 200, { queue_running: running ? [entry(running.id)] : [], queue_pending: queue.map(entry) });
    }
    if (p === '/queue' && req.method === 'POST') {
      const b = JSON.parse((await body(req)).toString() || '{}');
      for (const id of b.delete || []) { deletes.push(id); const i = queue.indexOf(id); if (i >= 0) queue.splice(i, 1); }
      if (b.clear) queue.length = 0;
      return json(res, 200, {});
    }
    if (p === '/interrupt' && req.method === 'POST') {
      const b = JSON.parse((await body(req)).toString() || '{}');
      interrupts.push(b);
      if (running && (!b.prompt_id || b.prompt_id === running.id)) {
        const id = running.id;
        const pr = prompts.find((x) => x.id === id);
        clearTimeout(running.timer);
        running = null;
        history[id] = { prompt: [pr.number, id, pr.workflow], outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_interrupted', { prompt_id: id }]] } };
        send(pr.clientId, 'execution_interrupted', { prompt_id: id, node_id: 'sampler' });
        setImmediate(runNext);
      }
      return json(res, 200, {});
    }
    if (p.startsWith('/history/')) {
      const id = decodeURIComponent(p.slice(9));
      return json(res, 200, history[id] ? { [id]: history[id] } : {});
    }
    if (p === '/view') {
      const name = url.searchParams.get('filename') || '';
      if (name.endsWith('.png')) {
        const png = posterBuffers[Number((name.match(/_(\d+)\.png$/) || [])[1] || 0) % posterBuffers.length];
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
        return res.end(png);
      }
      const n = Number((name.match(/_(\d+)_\.webm$/) || [])[1] || 0);
      const buf = clipBuffers[n % clipBuffers.length];
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), buf.length - 1) : buf.length - 1;
        res.writeHead(206, { 'content-type': 'video/webm', 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${buf.length}`, 'accept-ranges': 'bytes' });
        return res.end(buf.subarray(start, end + 1));
      }
      res.writeHead(200, { 'content-type': 'video/webm', 'content-length': buf.length, 'accept-ranges': 'bytes' });
      return res.end(buf);
    }
    if (p === '/upload/image' && req.method === 'POST') {
      const raw = await body(req);
      const filename = (/filename="([^"]+)"/.exec(raw.toString('latin1')) || [])[1] || 'upload.png';
      uploads.push({ filename, bytes: raw.length });
      return json(res, 200, { name: filename, subfolder: '', type: 'input' });
    }
    if (p === '/free' && req.method === 'POST') return json(res, 200, {});
    json(res, 404, { error: 'not found' });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://mock');
    if (url.pathname !== '/ws' || (requireAuth && req.headers[requireAuth.header.toLowerCase()] !== requireAuth.value)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const id = url.searchParams.get('clientId') || 'anon';
      if (!sockets.has(id)) sockets.set(id, new Set());
      sockets.get(id).add(ws);
      ws.send(JSON.stringify({ type: 'status', data: { status: { exec_info: { queue_remaining: queue.length } }, sid: id } }));
      ws.on('close', () => sockets.get(id)?.delete(ws));
    });
  });
  const close = server.close.bind(server);
  server.close = (cb) => { if (running) clearTimeout(running.timer); for (const c of wss.clients) c.terminate(); wss.close(); return close(cb); };

  Object.assign(server, { prompts, queue, history, interrupts, deletes, uploads, objectInfo, setGenMs(ms) { genMs = ms; } });
  return Object.defineProperties(server, {
    running: { get: () => running?.id || null },
    socketCount: { get: () => { let n = 0; for (const s of sockets.values()) n += s.size; return n; } },
  });
}

/** A few short, distinct WebM clips and their last frames, made with ffmpeg (null when ffmpeg is missing). */
export function makeDemoClips(dir, { count = 4, seconds = 3, size = '768x512' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const out = { clips: [], posters: [] };
  for (let i = 0; i < count; i++) {
    const f = path.join(dir, `clip${i}.webm`);
    const hue = i * 80;
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `mandelbrot=size=${size}:rate=24:start_scale=${0.3 + i * 0.4}`, '-t', String(seconds), '-vf', `hue=h=${hue},format=yuv420p`, '-c:v', 'libvpx-vp9', '-b:v', '600k', '-deadline', 'realtime', '-cpu-used', '8', f]);
    if (r.status !== 0) return null;
    const png = f.replace(/\.webm$/, '.png');
    if (spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-sseof', '-0.2', '-i', f, '-frames:v', '1', '-vf', 'scale=320:-2', png]).status !== 0) return null;
    out.clips.push(f);
    out.posters.push(png);
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
  const port = Number(arg('port', 8189));
  const dir = path.join(os.tmpdir(), 'live-video-mock-clips');
  const demo = makeDemoClips(dir) || { clips: [], posters: [] };
  if (!demo.clips.length) console.log('ffmpeg not found: clips are placeholders that will not play');
  const missing = process.argv.includes('--missing');
  const server = createMockComfy({ genMs: Number(arg('gen-ms', 4000)), steps: 8, ...demo, ...(missing && { missingModels: ['ltxv-2b-0.9.8-distilled.safetensors'], missingNodes: ['UNETLoader'] }) });
  server.listen(port, '127.0.0.1', () => console.log(`mock ComfyUI on http://127.0.0.1:${port}/ (clips in ${dir})`));
}
