// Krea Studio page: controls → api/generate (the RIGS ComfyUI connector), live progress by polling the
// job, the result stage, the history gallery and the connection settings. All URLs are relative.
import { createSketch } from './sketch.js';
import { REALTIME_DEBOUNCE_MS, buildRequest, debounce, errorView, megapixelsFor, progressText, viewUrl } from './studio.js';

const $ = (id) => document.getElementById(id);
const TERMINAL = new Set(['done', 'error', 'cancelled']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  mode: 'txt2img', style: 'none', aspect: '1:1', srcMode: 'upload',
  meta: null, config: null, settings: { node: '' },
  token: 0, job: null, current: null, gallery: [],
  src: { blob: null, ref: null }, sketchRef: null, up: { blob: null, ref: null, url: '' },
};

async function api(path, { method = 'GET', json, body, headers } = {}) {
  let r;
  try {
    r = await fetch(path, { method, headers: json !== undefined ? { 'content-type': 'application/json' } : headers, body: json !== undefined ? JSON.stringify(json) : body });
  } catch (e) {
    throw Object.assign(new Error(`The Krea Studio server is not answering (${e.message}).`), { code: 'unreachable' });
  }
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 300) }; }
  if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status, code: data.code });
  return data;
}

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, ms);
}

function option(value, label, selected = false) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  o.selected = selected;
  return o;
}

// ---------------------------------------------------------------- connection

function setConn(kind, text) {
  $('conn').className = `conn ${kind}`;
  $('connText').textContent = text;
}

async function loadConfig() {
  state.config = await api('api/comfy/config');
  return state.config;
}

/** Test the active connection and load the model lists; any failure shows in the chip and the stage. */
async function connect() {
  setConn('', 'Connecting…');
  try {
    const cfg = await loadConfig();
    if (!cfg.effective.url) {
      setConn('bad', 'Not connected');
      $('emptyText').textContent = 'Krea Studio runs on your own ComfyUI. Enter its address to start.';
      $('emptySettings').hidden = false;
      openSettings();
      return false;
    }
    const t = await api('api/comfy/test', { method: 'POST', json: {} });
    if (!t.ok) {
      setConn('bad', 'ComfyUI unreachable');
      showError({ code: t.error.code, message: t.error.message });
      return false;
    }
    state.meta = await api('api/comfy/models');
    fillMeta(state.meta);
    const host = new URL(t.url).host;
    setConn('ok', `ComfyUI ${t.version || ''} · ${host}${cfg.effective.source === 'detected' ? ' (detected)' : ''}${state.settings.node ? ` via ${state.settings.node}` : ''}`);
    $('emptySettings').hidden = true;
    if (!state.meta.presets.length) showError({ code: 'missing_model', message: 'This ComfyUI has no image model Krea Studio can use: no image checkpoint, and no Krea 2 UNET with its text encoder and VAE.' });
    return true;
  } catch (e) {
    setConn('bad', 'Connection problem');
    showError(e);
    return false;
  }
}

function fillMeta(m) {
  const preset = $('preset');
  const was = preset.value;
  preset.replaceChildren(...m.presets.map((p) => option(p.id, p.label, p.id === was)));
  if (!preset.value && m.presets[0]) preset.value = m.presets[0].id;
  $('styles').replaceChildren(...m.styles.map((s) => chip(s.label, s.id === state.style, () => { state.style = s.id; markChips('styles', s.id); onEdit(); }, s.id)));
  $('aspects').replaceChildren(...m.aspects.map((a) => chip(a, a === state.aspect, () => { state.aspect = a; markChips('aspects', a); onEdit(); }, a)));
  const size = $('size');
  const sizeWas = size.value || 'L';
  size.replaceChildren(...m.sizes.map((s) => option(s.id, s.label, s.id === sizeWas)));
  $('sampler').replaceChildren(option('', 'Model default'), ...m.models.samplers.map((s) => option(s, s)));
  $('scheduler').replaceChildren(option('', 'Model default'), ...m.models.schedulers.map((s) => option(s, s)));
  $('lora').replaceChildren(option('', 'None'), ...m.models.loras.map((s) => option(s, s.replace(/\.safetensors$/, ''))));
  $('upscaler').replaceChildren(option('', 'Lanczos (no model)'), ...m.models.upscalers.map((s) => option(s, s.replace(/\.(safetensors|pth|pt)$/, ''))));
  applyPresetDefaults();
}

function chip(label, pressed, onclick, value) {
  const b = document.createElement('button');
  b.className = 'chip';
  b.type = 'button';
  b.textContent = label;
  b.dataset.value = value;
  b.setAttribute('aria-pressed', String(pressed));
  b.onclick = onclick;
  return b;
}
function markChips(id, value) {
  for (const b of $(id).children) b.setAttribute('aria-pressed', String(b.dataset.value === value));
}

function applyPresetDefaults() {
  const p = state.meta?.presets.find((x) => x.id === $('preset').value);
  const d = p?.defaults || {};
  $('steps').placeholder = d.steps ?? '';
  $('cfg').placeholder = d.cfg ?? '';
  if ($('sampler').options[0]) $('sampler').options[0].textContent = `Model default${d.sampler ? ` (${d.sampler})` : ''}`;
  if ($('scheduler').options[0]) $('scheduler').options[0].textContent = `Model default${d.scheduler ? ` (${d.scheduler})` : ''}`;
}

// ---------------------------------------------------------------- modes and inputs

function setMode(mode) {
  state.mode = mode;
  for (const b of document.querySelectorAll('.modes button')) b.setAttribute('aria-selected', String(b.dataset.mode === mode));
  $('srcPanel').hidden = mode !== 'img2img';
  $('upPanel').hidden = mode !== 'upscale';
  $('aspectLabel').hidden = mode !== 'txt2img';
  $('aspects').hidden = mode !== 'txt2img';
  $('go').textContent = mode === 'upscale' ? 'Upscale' : 'Generate';
  syncUpscaleModel();
}

/** A plain upscale needs no diffusion model; the model and style only matter with Enhance. */
function syncUpscaleModel() {
  const up = state.mode === 'upscale';
  const enh = Number($('enhance').value) > 0;
  $('presetField').hidden = up && !enh;
  $('stylePanel').hidden = up && !enh;
  $('seedRow').hidden = up && !enh;
  $('modelPanel').hidden = up && !enh;
  $('advanced').hidden = up && !enh;
  $('sizeRow').hidden = up;
  $('realtimeSwitch').hidden = up;
}

function setSrcMode(m) {
  state.srcMode = m;
  for (const b of document.querySelectorAll('.seg button')) b.setAttribute('aria-selected', String(b.dataset.src === m));
  $('uploadBox').hidden = m !== 'upload';
  $('sketchBox').hidden = m !== 'sketch';
  if (m === 'sketch' && Number($('strength').value) < 0.75) { $('strength').value = 0.85; $('strengthOut').textContent = '0.85'; }
  onEdit();
}

function setSourceBlob(blob, { mode = 'img2img' } = {}) {
  const url = URL.createObjectURL(blob);
  if (mode === 'upscale') {
    state.up = { blob, ref: null, url };
    $('upImg').src = url;
    $('upImg').hidden = false;
    $('upText').hidden = true;
  } else {
    state.src = { blob, ref: null };
    $('srcImg').src = url;
    $('srcImg').hidden = false;
    $('dropText').hidden = true;
  }
}

function upload(blob, name) {
  return api(`api/comfy/upload?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob, headers: { 'content-type': blob.type || 'image/png' } });
}

/** The LoadImage reference for the current input, uploading it to ComfyUI first when it changed. */
async function inputRef() {
  if (state.mode === 'upscale') {
    if (!state.up.blob) return null;
    if (!state.up.ref) state.up.ref = await upload(state.up.blob, `upscale-${Date.now()}.png`);
    return state.up.ref;
  }
  if (state.mode !== 'img2img') return null;
  if (state.srcMode === 'sketch') {
    if (!state.sketchRef) state.sketchRef = await upload(await sketch.toBlob(), 'sketch.png');
    return state.sketchRef;
  }
  if (!state.src.blob) return null;
  if (!state.src.ref) state.src.ref = await upload(state.src.blob, `input-${Date.now()}.png`);
  return state.src.ref;
}

function collect(realtime) {
  const lock = $('seedLock').checked || realtime;
  if (realtime && !$('seed').value) $('seed').value = String(Math.floor(Math.random() * 2 ** 32));
  return {
    mode: state.mode, prompt: $('prompt').value, style: state.style, preset: $('preset').value, aspect: state.aspect,
    megapixels: megapixelsFor(state.meta?.sizes || [], $('size').value),
    seed: lock ? $('seed').value : '', steps: $('steps').value, cfg: $('cfg').value, sampler: $('sampler').value, scheduler: $('scheduler').value,
    negative: $('negative').value, lora: $('lora').value, loraStrength: $('loraStrength').value, batch: $('batch').value,
    strength: $('strength').value, scale: $('scale').value, upscaler: $('upscaler').value, enhance: $('enhance').value, realtime,
  };
}

// ---------------------------------------------------------------- generating

async function generate({ realtime = false } = {}) {
  if (!state.meta && !(await connect())) return;
  hideError();
  const token = ++state.token;
  const ui = collect(realtime);
  if (state.mode === 'txt2img' && !ui.prompt.trim()) {
    hideProgress();
    if (!realtime) showError({ message: 'Write a prompt first.' });
    return;
  }
  showProgress({ state: 'preparing', stage: state.mode === 'txt2img' ? 'Sending' : 'Uploading the input' }, realtime);
  try {
    ui.image = await inputRef();
    if (token !== state.token) return;
    if (state.mode !== 'txt2img' && !ui.image) {
      hideProgress();
      showError({ message: state.mode === 'upscale' ? 'Pick an image to upscale: use the Upscale button on a result, or choose a file.' : 'Add an input image: upload one, or draw a sketch.' });
      return;
    }
    const job = await api('api/generate', { method: 'POST', json: buildRequest(ui) });
    if (token !== state.token) return;
    await track(job, token, realtime);
  } catch (e) {
    if (token !== state.token) return;
    hideProgress();
    showError(e);
  }
}

async function track(job, token, realtime) {
  state.job = job;
  let fails = 0;
  let seq = 0;
  render(job, realtime);
  while (!TERMINAL.has(job.state)) {
    await sleep(job.state === 'running' ? 300 : 500);
    if (token !== state.token) return;
    try {
      job = await api(`api/comfy/jobs/${encodeURIComponent(job.id)}`);
      fails = 0;
    } catch (e) {
      if (++fails >= 4) { hideProgress(); showError(e); return; }
      continue;
    }
    if (token !== state.token) return;
    state.job = job;
    render(job, realtime);
    if (job.previewSeq && job.previewSeq !== seq) {
      seq = job.previewSeq;
      $('preview').src = `api/comfy/jobs/${encodeURIComponent(job.id)}/preview?seq=${seq}`;
      $('preview').hidden = false;
    }
  }
  $('preview').hidden = true;
  hideProgress();
  if (job.state === 'done') {
    const p = job.params || {};
    if (p.seed !== undefined && job.kind !== 'upscale' && !$('seedLock').checked && !realtime) $('seed').value = String(p.seed);
    showResult({ url: viewUrl(job.outputs[0]), jobId: job.id, kind: job.kind, params: p, elapsedMs: job.elapsedMs, realtime, filename: job.outputs[0].filename });
    if (!realtime) { setTimeout(loadGallery, 700); setTimeout(loadGallery, 2500); }
  } else if (job.state === 'error') {
    showError(job.error || { message: 'The job failed.' });
  } else if (!/Superseded/.test(job.stage || '')) {
    toast(job.stage || 'Cancelled');
  }
  for (const w of job.warnings || []) toast(w, 5000);
}

function render(job, realtime) {
  $('progress').hidden = false;
  $('bar').style.width = `${Math.round((job.state === 'done' ? 1 : job.progress || 0) * 100)}%`;
  $('stageText').textContent = `${realtime ? 'Realtime · ' : ''}${progressText(job)}`;
}

function showProgress(job, realtime) {
  $('empty').hidden = true;
  render(job, realtime);
}
function hideProgress() { $('progress').hidden = true; }

function showError(err) {
  const v = errorView(err);
  $('errorTitle').textContent = v.title;
  $('errorText').textContent = v.text;
  $('errorAction').hidden = !v.settings;
  $('error').hidden = false;
  $('empty').hidden = true;
}
function hideError() { $('error').hidden = true; }

function describe(it) {
  const p = it.params || {};
  const bits = [];
  if (p.presetLabel && (it.kind !== 'upscale' || p.enhance)) bits.push(p.presetLabel);
  if (it.kind === 'upscale') bits.push(`upscale ${p.scale}×${p.enhance ? ` + enhance ${p.enhance}` : ''}`);
  if (it.kind === 'img2img') bits.push(`strength ${p.strength}`);
  if (it.width) bits.push(`${it.width}×${it.height}`);
  if (p.seed !== undefined && p.seed !== null && it.kind !== 'upscale') bits.push(`seed ${p.seed}`);
  if (it.elapsedMs) bits.push(`${(it.elapsedMs / 1000).toFixed(1)} s`);
  return bits.join(' · ');
}

/** Put an image on the stage: { url, jobId?, galleryId?, kind, params, realtime?, width?, height? }. */
function showResult(cur) {
  state.current = cur;
  const img = $('result');
  img.onload = () => { if (!cur.width) $('resultInfo').textContent = describe({ ...cur, width: img.naturalWidth, height: img.naturalHeight }); };
  img.onerror = () => showError({ message: 'The image could not be loaded from ComfyUI.' });
  img.src = cur.url;
  img.hidden = false;
  $('empty').hidden = true;
  $('resultInfo').textContent = describe(cur);
  $('actions').hidden = false;
  $('keep').hidden = !(cur.realtime && cur.jobId && !cur.galleryId);
  const dl = $('download');
  dl.href = cur.galleryId ? `api/gallery/${cur.galleryId}/image?download=1` : cur.url;
  dl.setAttribute('download', cur.filename || `krea-${cur.kind}-${cur.params?.seed ?? 'image'}.png`);
  for (const t of $('galleryGrid').children) t.classList.toggle('current', !!cur.galleryId && t.dataset.id === cur.galleryId);
}

async function sendTo(mode, url) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    setSourceBlob(await r.blob(), { mode });
    setMode(mode);
    if (mode === 'img2img') setSrcMode('upload');
    toast(mode === 'upscale' ? 'Ready to upscale: pick a scale and press Upscale' : 'Sent to Image → Image');
  } catch (e) { showError({ message: `Could not load that image: ${e.message}` }); }
}

// ---------------------------------------------------------------- realtime

const realtimeKick = debounce(() => generate({ realtime: true }), REALTIME_DEBOUNCE_MS);
function onEdit() {
  if (!$('realtime').checked || state.mode === 'upscale') return;
  realtimeKick();
}

// ---------------------------------------------------------------- gallery

async function loadGallery() {
  try {
    const { items } = await api('api/gallery');
    state.gallery = items;
    renderGallery();
  } catch (e) { $('galleryEmpty').textContent = `History unavailable: ${e.message}`; }
}

function button(text, title, onclick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.title = title;
  b.onclick = (e) => { e.stopPropagation(); onclick(); };
  return b;
}

function renderGallery() {
  $('galleryEmpty').hidden = state.gallery.length > 0;
  $('galleryCount').textContent = state.gallery.length ? String(state.gallery.length) : '';
  $('galleryGrid').replaceChildren(...state.gallery.map((it) => {
    const src = `api/gallery/${it.id}/image`;
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.id = it.id;
    tile.tabIndex = 0;
    tile.title = it.prompt || it.kind;
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = src;
    img.alt = it.prompt || it.kind;
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = it.kind === 'txt2img' ? 'text' : it.kind === 'img2img' ? 'image' : 'upscale';
    const acts = document.createElement('div');
    acts.className = 'tile-actions';
    const dl = document.createElement('a');
    dl.href = `${src}?download=1`;
    dl.textContent = '⤓';
    dl.title = 'Download';
    dl.setAttribute('download', '');
    dl.onclick = (e) => e.stopPropagation();
    acts.append(dl,
      button('→ i2i', 'Send to Image → Image', () => sendTo('img2img', src)),
      button('⤢', 'Upscale', () => sendTo('upscale', src)),
      button('✕', 'Delete', async () => {
        if (!confirm('Delete this image from the history?')) return;
        try { await api(`api/gallery/${it.id}`, { method: 'DELETE' }); await loadGallery(); } catch (er) { toast(er.message); }
      }));
    tile.append(img, kind, acts);
    const open = () => {
      if (it.prompt) $('prompt').value = it.prompt;
      hideError();
      showResult({ url: src, galleryId: it.id, jobId: it.jobId, kind: it.kind, params: it.params, width: it.width, height: it.height, elapsedMs: it.elapsedMs });
    };
    tile.onclick = open;
    tile.onkeydown = (e) => { if (e.key === 'Enter') open(); };
    return tile;
  }));
}

// ---------------------------------------------------------------- settings

async function openSettings() {
  $('testResult').hidden = true;
  try {
    const [{ nodes }, s] = await Promise.all([api('api/nodes').catch(() => ({ nodes: [] })), api('api/settings')]);
    state.settings = s;
    const sel = $('node');
    sel.replaceChildren(option('', 'This machine'), ...nodes.filter((n) => !n.self && n.rigs).map((n) => option(n.name, `${n.name}${n.online ? '' : ' (offline)'}`, n.name === s.node)));
    if (s.node && ![...sel.options].some((o) => o.value === s.node)) sel.append(option(s.node, `${s.node} (not seen)`, true));
    await loadConfig();
  } catch (e) { $('urlNote').textContent = e.message; }
  fillSettings();
  if (!$('settings').open) $('settings').showModal();
}

function fillSettings() {
  const c = state.config || { config: { url: '', auth: { set: false }, gpuOverseer: 'auto' }, effective: { url: '', source: 'none' }, suggested: null };
  $('url').value = c.config.url || '';
  $('url').placeholder = c.suggested?.url || 'http://127.0.0.1:8188';
  $('urlNote').textContent = c.config.url
    ? 'Saved on this machine.'
    : c.suggested ? `Not set: using the ComfyUI detected on this machine (${c.suggested.url}). A URL you enter always wins.` : 'Not set, and no ComfyUI was detected on this machine.';
  $('useDetected').hidden = !c.suggested || c.suggested.url === c.config.url;
  $('useDetected').textContent = c.suggested ? `Use detected: ${c.suggested.url}` : 'Use detected';
  $('auth').value = '';
  $('auth').placeholder = c.config.auth.set ? `${c.config.auth.name}: ••••••• (saved, type to replace)` : 'Authorization: Bearer …';
  $('clearAuthRow').hidden = !c.config.auth.set;
  $('clearAuth').checked = false;
  const ov = c.config.gpuOverseer || 'auto';
  $('overseer').value = ov === 'auto' || ov === 'off' ? ov : 'custom';
  $('overseerUrl').hidden = $('overseer').value !== 'custom';
  $('overseerUrl').value = $('overseer').value === 'custom' ? ov : '';
}

function settingsInput() {
  const body = { url: $('url').value.trim() };
  if ($('auth').value.trim()) body.authHeader = $('auth').value.trim();
  if ($('clearAuth').checked) body.clearAuth = true;
  body.gpuOverseer = $('overseer').value === 'custom' ? $('overseerUrl').value.trim() : $('overseer').value;
  return body;
}

async function testConnection() {
  const box = $('testResult');
  box.hidden = false;
  box.className = 'test-result';
  box.textContent = 'Testing…';
  const input = settingsInput();
  const r = await api('api/comfy/test', { method: 'POST', json: { url: input.url || state.config?.effective?.url || '', authHeader: input.authHeader } })
    .catch((e) => ({ ok: false, error: { message: e.message } }));
  box.replaceChildren();
  if (!r.ok) {
    box.className = 'test-result bad';
    box.textContent = `✕ ${r.error.message}`;
    return r;
  }
  box.className = 'test-result ok';
  const dev = r.devices?.[0];
  const head = document.createElement('div');
  head.textContent = `✓ Connected to ComfyUI ${r.version || '(version unknown)'} at ${r.url}${dev ? ` · ${dev.name}${dev.vramTotal ? ` (${Math.round(dev.vramTotal / 2 ** 30)} GB)` : ''}` : ''} · ${r.latencyMs} ms`;
  const m = r.models;
  const sum = document.createElement('div');
  sum.className = 'muted';
  sum.textContent = `${m.checkpoints.length} checkpoint(s), ${m.unets.length} UNET(s), ${m.loras.length} LoRA(s), ${m.upscalers.length} upscaler(s). Ready: ${r.presets.map((p) => p.label).join(', ') || 'no usable model'}`;
  const label = document.createElement('div');
  label.className = 'muted';
  label.textContent = 'Checkpoints:';
  const list = document.createElement('ul');
  for (const c of m.checkpoints) list.append(Object.assign(document.createElement('li'), { textContent: c }));
  if (!m.checkpoints.length) list.append(Object.assign(document.createElement('li'), { textContent: 'none' }));
  box.append(head, sum, label, list);
  return r;
}

async function saveSettings() {
  try {
    state.config = await api('api/comfy/config', { method: 'POST', json: settingsInput() });
    fillSettings();
    toast('Saved');
    $('settings').close();
    state.meta = null;
    hideError();
    await connect();
  } catch (e) {
    const box = $('testResult');
    box.hidden = false;
    box.className = 'test-result bad';
    box.textContent = `✕ ${e.message}`;
  }
}

// ---------------------------------------------------------------- wiring

const sketch = createSketch($('sketch'), { onChange: () => { state.sketchRef = null; onEdit(); } });

for (const b of document.querySelectorAll('.modes button')) b.onclick = () => setMode(b.dataset.mode);
for (const b of document.querySelectorAll('.seg button')) b.onclick = () => setSrcMode(b.dataset.src);
$('go').onclick = () => { realtimeKick.cancel(); generate(); };
$('prompt').addEventListener('input', onEdit);
$('prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); realtimeKick.cancel(); generate(); } });
$('realtime').onchange = () => {
  if ($('realtime').checked) { toast('Realtime: regenerates as you edit; a stale job is cancelled'); onEdit(); } else realtimeKick.cancel();
};
$('preset').onchange = () => { applyPresetDefaults(); onEdit(); };
for (const id of ['size', 'steps', 'cfg', 'sampler', 'scheduler', 'negative', 'lora', 'loraStrength', 'batch']) $(id).addEventListener('change', onEdit);
$('seed').addEventListener('input', () => { $('seedLock').checked = $('seed').value !== ''; onEdit(); });
$('dice').onclick = () => { $('seed').value = String(Math.floor(Math.random() * 2 ** 32)); $('seedLock').checked = true; onEdit(); };
$('strength').oninput = () => { $('strengthOut').textContent = Number($('strength').value).toFixed(2); onEdit(); };
$('enhance').oninput = () => { const v = Number($('enhance').value); $('enhanceOut').textContent = v ? v.toFixed(2) : 'off'; syncUpscaleModel(); };
$('cancel').onclick = async () => {
  const j = state.job;
  state.token++;
  realtimeKick.cancel();
  hideProgress();
  if (j && !TERMINAL.has(j.state)) {
    try { await api(`api/comfy/jobs/${encodeURIComponent(j.id)}/cancel`, { method: 'POST', json: {} }); toast('Cancelled'); } catch (e) { toast(e.message); }
  }
};
$('keep').onclick = async () => {
  const cur = state.current;
  if (!cur?.jobId) return;
  try {
    const { items } = await api('api/gallery', { method: 'POST', json: { jobId: cur.jobId } });
    cur.galleryId = items[0]?.id;
    $('keep').hidden = true;
    toast('Kept in the history');
    loadGallery();
  } catch (e) { toast(e.message); }
};
$('toImg2img').onclick = () => state.current && sendTo('img2img', state.current.url);
$('toUpscale').onclick = () => state.current && sendTo('upscale', state.current.url);

function wireDrop(label, input, mode) {
  input.onchange = () => { if (input.files[0]) { setSourceBlob(input.files[0], { mode }); onEdit(); } };
  label.addEventListener('dragover', (e) => { e.preventDefault(); label.classList.add('over'); });
  label.addEventListener('dragleave', () => label.classList.remove('over'));
  label.addEventListener('drop', (e) => {
    e.preventDefault();
    label.classList.remove('over');
    const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/'));
    if (f) { setSourceBlob(f, { mode }); onEdit(); }
  });
}
wireDrop($('drop'), $('file'), 'img2img');
wireDrop($('upDrop'), $('upFile'), 'upscale');

$('brushColor').oninput = () => { sketch.setColor($('brushColor').value); $('eraser').setAttribute('aria-pressed', 'false'); };
$('brushSize').oninput = () => sketch.setSize($('brushSize').value);
$('eraser').onclick = () => { sketch.setEraser(!sketch.eraser); $('eraser').setAttribute('aria-pressed', String(sketch.eraser)); };
$('undo').onclick = () => sketch.undo();
$('clearSketch').onclick = () => sketch.clear();

for (const id of ['conn', 'openSettings', 'emptySettings', 'errorAction']) $(id).onclick = () => openSettings();
$('closeSettings').onclick = () => $('settings').close();
$('test').onclick = () => testConnection();
$('save').onclick = () => saveSettings();
$('useDetected').onclick = () => { $('url').value = state.config?.suggested?.url || ''; };
$('overseer').onchange = () => { $('overseerUrl').hidden = $('overseer').value !== 'custom'; };
$('node').onchange = async () => {
  try {
    state.settings = await api('api/settings', { method: 'POST', json: { node: $('node').value } });
    await loadConfig();
    fillSettings();
    state.meta = null;
    connect();
  } catch (e) { $('urlNote').textContent = e.message; }
};

// For scripted screenshots and debugging.
window.__krea = { state, openSettings, testConnection, generate, setMode, setSrcMode, sendTo, sketch, loadGallery, showResult };

setMode('txt2img');
api('api/settings').then((s) => { state.settings = s; }).catch(() => {}).finally(() => connect());
loadGallery();
