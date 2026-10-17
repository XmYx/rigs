// Pure helpers for the studio page: the job request built from the controls, progress and error
// text, and the realtime debouncer. No DOM, so the tests import this file directly.

export const REALTIME_LANE = 'realtime';
export const REALTIME_DEBOUNCE_MS = 650;

/**
 * Controls → the POST api/generate body.
 * ui: { mode, prompt, style, preset, aspect, megapixels, seed, steps, cfg, sampler, scheduler, negative,
 *       lora, loraStrength, batch, strength, image, scale, upscaler, enhance, realtime }
 * Empty advanced fields are left out so the model preset's defaults apply.
 */
export function buildRequest(ui) {
  const kind = ui.mode === 'img2img' || ui.mode === 'upscale' ? ui.mode : 'txt2img';
  const params = { prompt: String(ui.prompt || '').trim(), style: ui.style || 'none' };
  if (ui.preset) params.preset = ui.preset;
  const n = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? undefined : Number(v));
  const set = (k, v) => { if (v !== undefined) params[k] = v; };
  if (kind !== 'upscale') {
    set('megapixels', n(ui.megapixels));
    if (kind === 'txt2img') params.aspect = ui.aspect || '1:1';
    set('batch', n(ui.batch));
  }
  set('seed', n(ui.seed));
  set('steps', n(ui.steps));
  set('cfg', n(ui.cfg));
  if (ui.sampler) params.sampler = ui.sampler;
  if (ui.scheduler) params.scheduler = ui.scheduler;
  if (ui.negative) params.negative = String(ui.negative);
  if (ui.lora) params.lora = { name: ui.lora, strength: n(ui.loraStrength) ?? 0.8 };
  if (kind === 'img2img') { params.image = ui.image || null; set('strength', n(ui.strength)); }
  if (kind === 'upscale') {
    params.image = ui.image || null;
    set('scale', n(ui.scale));
    if (ui.upscaler) params.upscaler = ui.upscaler;
    set('enhance', n(ui.enhance));
    if (!(Number(ui.enhance) > 0)) { delete params.preset; delete params.lora; }
  }
  const body = { kind, params, realtime: !!ui.realtime };
  if (ui.realtime) body.lane = REALTIME_LANE;
  return body;
}

/** One line for the progress overlay. */
export function progressText(job) {
  if (!job) return '';
  if (job.state === 'queued') return job.queuePosition ? `Queued (#${job.queuePosition} in line)` : 'Queued';
  if (job.state === 'preparing') return job.stage || 'Preparing';
  if (job.state === 'running') return `${job.stage || 'Working'} · ${Math.round((job.progress || 0) * 100)}%`;
  if (job.state === 'done') return `Done in ${(job.elapsedMs / 1000).toFixed(1)} s`;
  if (job.state === 'cancelled') return job.stage || 'Cancelled';
  return job.stage || job.state;
}

/** Codes where the fix is in Settings (URL, auth, a stopped ComfyUI). */
export const SETTINGS_ERRORS = new Set(['not_configured', 'unreachable', 'auth']);

/** An API failure or a failed job → { title, text, settings } for the error box. */
export function errorView(err) {
  const text = String(err?.message || err || 'Unknown error');
  const titles = {
    not_configured: 'ComfyUI is not set up', unreachable: 'ComfyUI is not reachable', auth: 'ComfyUI refused the request',
    missing_model: 'A model is missing', missing_node: 'A ComfyUI node is missing', node_errors: 'ComfyUI rejected the workflow',
    execution: 'ComfyUI failed while generating', timeout: 'The job took too long', lost: 'ComfyUI lost the job',
  };
  let c = err?.code || '';
  if (!titles[c]) {
    if (/No ComfyUI is set up/i.test(text)) c = 'not_configured';
    else if (/Can't reach ComfyUI|not answering/i.test(text)) c = 'unreachable';
    else if (/refused the request/i.test(text)) c = 'auth';
    else if (/not installed|models are installed/i.test(text)) c = 'missing_model';
  }
  return { title: titles[c] || 'Something went wrong', text, settings: SETTINGS_ERRORS.has(c) };
}

/** Trailing-edge debounce with cancel() and pending(); timers are injectable for tests. */
export function debounce(fn, ms, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let t = null;
  const d = (...args) => {
    if (t) clearTimer(t);
    t = setTimer(() => { t = null; fn(...args); }, ms);
  };
  d.cancel = () => { if (t) clearTimer(t); t = null; };
  d.pending = () => t !== null;
  return d;
}

/** Megapixels for a size id, from the connector's SIZES list. */
export const megapixelsFor = (sizes, id) => sizes.find((s) => s.id === id)?.megapixels ?? 1;

/** URL of a ComfyUI output through the applet (relative: works behind the App Cloud proxy). */
export const viewUrl = (o) => `api/comfy/view?${new URLSearchParams({ filename: o.filename, subfolder: o.subfolder || '', type: o.type || 'output' })}`;
