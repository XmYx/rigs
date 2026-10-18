// Read-only ComfyUI client: system stats, queue, history, model/combo choices and a pre-flight check of an
// API-format graph against /object_info. It NEVER POSTs /prompt: some ComfyUI installs start downloading a missing
// model when a graph naming it is queued, and a GPU job needs a lease first (see the gpu-lease tool). To run a graph,
// check it here, then use the RIGS ComfyUI connector (POST /api/local/comfyui/jobs).
// URL and auth header come from args.url / COMFYUI_URL / COMFYUI_AUTH_HEADER or the machine's RIGS_HOME/config.json
// "comfyui" settings; the header is a secret and is never printed or taken as an argument.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = JSON.parse(process.env.RIGS_TOOL_ARGS || process.argv[2] || '{}');
const done = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 1); };

let saved = {};
try { saved = JSON.parse(fs.readFileSync(path.join(process.env.RIGS_HOME || path.join(os.homedir(), '.rigs'), 'config.json'), 'utf8')).comfyui || {}; } catch {}
const clean = (u) => String(u || '').trim().replace(/\/+$/, '');
const base = clean(args.url || process.env.COMFYUI_URL || saved.url || 'http://127.0.0.1:8188');
if (!/^https?:\/\/[^\s/?#@]+/i.test(base)) done({ ok: false, error: 'url must be an http(s):// base URL like http://127.0.0.1:8188' });
const sameAsSaved = !args.url || clean(args.url) === clean(saved.url);
const authLine = process.env.COMFYUI_AUTH_HEADER || (sameAsSaved ? saved.authHeader : '') || '';
const [authName, ...authRest] = authLine.split(':');
const authValue = authRest.join(':').trim();
const redact = (s) => (authValue ? String(s).split(authValue).join('***') : String(s));

const MODEL_LOADERS = [['CheckpointLoaderSimple', 'ckpt_name'], ['LoraLoader', 'lora_name'], ['VAELoader', 'vae_name'], ['UNETLoader', 'unet_name'], ['CLIPLoader', 'clip_name'], ['ControlNetLoader', 'control_net_name']];
const action = String(args.action || 'stats');
const ACTIONS = ['stats', 'queue', 'history', 'choices', 'models', 'check'];
if (!ACTIONS.includes(action)) done({ ok: false, error: `action must be one of ${ACTIONS.join(', ')}` });

async function get(p, timeout = 15000) {
  let r;
  try { r = await fetch(base + p, { headers: authName && authValue ? { [authName.trim()]: authValue } : {}, signal: AbortSignal.timeout(timeout) }); }
  catch (e) { throw new Error(redact(`ComfyUI at ${base} is not reachable: ${e.cause?.code || e.cause?.errors?.[0]?.code || e.cause?.message || e.message}`)); }
  if (!r.ok) throw new Error(`ComfyUI answered HTTP ${r.status} for ${p}`);
  return r.json();
}
const comboOf = (info, input) => {
  const spec = info?.input?.required?.[input] ?? info?.input?.optional?.[input];
  return Array.isArray(spec) && Array.isArray(spec[0]) ? spec[0] : null;
};
const nodeInfo = async (type) => (await get(`/object_info/${encodeURIComponent(type)}`, 30000))[type] || null;

const plan = {
  stats: ['/system_stats'], queue: ['/queue'], history: [`/history/${args.promptId || '<promptId>'}`],
  choices: [`/object_info/${args.nodeType || '<nodeType>'}`], models: MODEL_LOADERS.map(([n]) => `/object_info/${n}`),
  check: ['/object_info/<each class_type of the graph>'],
}[action];
if (args.dryRun) done({ ok: true, dryRun: true, plan: { url: base, action, get: plan, auth: authValue ? 'configured' : 'none' } });

try {
  if (action === 'stats') {
    const s = await get('/system_stats');
    done({ ok: true, url: base, version: s.system?.comfyui_version || null, python: s.system?.python_version || null, devices: (s.devices || []).map((d) => ({ name: d.name, type: d.type, vramTotalMb: Math.round((d.vram_total || 0) / 1048576), vramFreeMb: Math.round((d.vram_free || 0) / 1048576) })) });
  }
  if (action === 'queue') {
    const q = await get('/queue');
    done({ ok: true, url: base, running: (q.queue_running || []).length, pending: (q.queue_pending || []).length });
  }
  if (action === 'history') {
    const id = String(args.promptId || '');
    if (!/^[\w-]{6,80}$/.test(id)) done({ ok: false, error: 'promptId is required' });
    const e = (await get(`/history/${id}`))[id];
    if (!e) done({ ok: true, found: false, promptId: id });
    const outputs = Object.entries(e.outputs || {}).flatMap(([node, o]) => Object.values(o).flat().filter((f) => f && f.filename).map((f) => ({ node, type: f.type, subfolder: f.subfolder, filename: f.filename })));
    done({ ok: true, found: true, promptId: id, status: e.status?.status_str || null, completed: !!e.status?.completed, outputs });
  }
  if (action === 'choices') {
    if (!args.nodeType || !args.input) done({ ok: false, error: 'choices needs nodeType and input, e.g. CheckpointLoaderSimple + ckpt_name' });
    const list = comboOf(await nodeInfo(args.nodeType), args.input);
    if (!list) done({ ok: false, error: `${args.nodeType}.${args.input} is not a choice list on this ComfyUI` });
    done({ ok: true, nodeType: args.nodeType, input: args.input, count: list.length, choices: list });
  }
  if (action === 'models') {
    const out = {};
    for (const [type, input] of MODEL_LOADERS) { try { out[`${type}.${input}`] = comboOf(await nodeInfo(type), input) || []; } catch { out[`${type}.${input}`] = null; } }
    done({ ok: true, url: base, models: out });
  }
  // check
  const graph = args.workflow;
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) done({ ok: false, error: 'check needs workflow: an API-format graph { "<id>": { class_type, inputs } }' });
  const types = [...new Set(Object.values(graph).map((n) => n?.class_type).filter(Boolean))];
  const infos = {};
  for (const t of types) infos[t] = await nodeInfo(t);
  const missingNodes = [];
  const badValues = [];
  for (const [id, n] of Object.entries(graph)) {
    if (!n?.class_type) continue;
    const info = infos[n.class_type];
    if (!info) { missingNodes.push({ node: id, class_type: n.class_type }); continue; }
    for (const [input, value] of Object.entries(n.inputs || {})) {
      if (Array.isArray(value)) continue; // a link to another node's output
      const list = comboOf(info, input);
      if (list && !list.includes(value)) badValues.push({ node: id, class_type: n.class_type, input, value, choices: list.slice(0, 8), more: Math.max(0, list.length - 8) });
    }
  }
  done({ ok: !missingNodes.length && !badValues.length, nodes: Object.keys(graph).length, classTypes: types.length, missingNodes, badValues, note: 'checked against /object_info only; nothing was queued' });
} catch (e) {
  done({ ok: false, error: redact(e.message) });
}
