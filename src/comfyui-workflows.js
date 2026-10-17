/**
 * ComfyUI workflow templates (API-format graphs) and what they are built from: model presets read
 * from /object_info, styles, aspect ratios and sizes. Pure functions only, no I/O, so the Krea Studio
 * applet, the live-video applet and the tests share them. src/comfyui.js does the talking to ComfyUI.
 *
 * A model spec is one of
 *   { family: 'checkpoint', ckpt }                                   CheckpointLoaderSimple (SD 1.x / SDXL / …)
 *   { family: 'unet', unet, clip, clipType, vae, weightDtype? }      split loaders (Krea 2, Flux-style models)
 * Graphs use readable node ids ('sampler', 'decode', …); ComfyUI accepts any string id.
 */

export const OUTPUT_PREFIX = 'rigs-krea';

export const STYLES = [
  { id: 'none', label: 'No style', prompt: '' },
  { id: 'photo', label: 'Photo', prompt: 'professional photograph, natural light, sharp focus, rich detail' },
  { id: 'cinematic', label: 'Cinematic', prompt: 'cinematic film still, dramatic lighting, shallow depth of field, color graded' },
  { id: 'illustration', label: 'Illustration', prompt: 'detailed digital illustration, clean linework, vibrant colors' },
  { id: 'anime', label: 'Anime', prompt: 'anime style, cel shading, expressive, studio quality' },
  { id: '3d', label: '3D render', prompt: '3D render, soft global illumination, physically based materials' },
  { id: 'watercolor', label: 'Watercolor', prompt: 'watercolor painting, soft washes, visible paper texture' },
  { id: 'oil', label: 'Oil paint', prompt: 'oil painting, impasto brush strokes, canvas texture' },
  { id: 'sketch', label: 'Pencil sketch', prompt: 'pencil sketch, graphite, cross-hatching, on paper' },
  { id: 'neon', label: 'Neon', prompt: 'neon cyberpunk, glowing lights at night, wet reflections' },
  { id: 'product', label: 'Product shot', prompt: 'studio product shot, seamless background, softbox lighting' },
];

export const ASPECTS = ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '21:9'];
/** Output sizes in megapixels; S suits realtime, L is the native size of most current models. */
export const SIZES = [
  { id: 'S', label: 'S · 0.25 MP', megapixels: 0.25 },
  { id: 'M', label: 'M · 0.5 MP', megapixels: 0.5 },
  { id: 'L', label: 'L · 1 MP', megapixels: 1 },
  { id: 'XL', label: 'XL · 1.5 MP', megapixels: 1.5 },
];

export const MAX_SEED = 2 ** 48;
export const randomSeed = (rnd = Math.random) => Math.floor(rnd() * MAX_SEED);

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  e.code = 'bad_request';
  return e;
}

/** Width/height for an aspect ("W:H") at a pixel budget, both multiples of 16, each within 256-2048. */
export function sizeFor(aspect = '1:1', megapixels = 1) {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(aspect));
  if (!m) throw badRequest(`aspect must look like 16:9 (got ${String(aspect).slice(0, 20)})`);
  const r = Number(m[1]) / Number(m[2]);
  const mp = Number(megapixels);
  if (!Number.isFinite(r) || r > 4 || r < 0.25) throw badRequest('aspect must be between 1:4 and 4:1');
  if (!(mp >= 0.05 && mp <= 4)) throw badRequest('size must be between 0.05 and 4 megapixels');
  const px = mp * 1024 * 1024;
  const snap = (v) => Math.min(2048, Math.max(256, Math.round(v / 16) * 16));
  return { width: snap(Math.sqrt(px * r)), height: snap(Math.sqrt(px / r)) };
}

// ---------------------------------------------------------------- /object_info → models and presets

/** Choices of one combo input in /object_info, old ([[...]]) and new ("COMBO", {options}) shapes. */
export function comboOptions(info, nodeClass, input) {
  const spec = inputSpec(info, nodeClass, input);
  if (!Array.isArray(spec)) return [];
  if (Array.isArray(spec[0])) return spec[0].map(String);
  if (spec[0] === 'COMBO' && Array.isArray(spec[1]?.options)) return spec[1].options.map(String);
  return [];
}

function inputSpec(info, nodeClass, input) {
  const node = info?.[nodeClass]?.input;
  return node?.required?.[input] ?? node?.optional?.[input];
}

const NEEDED = ['CheckpointLoaderSimple', 'UNETLoader', 'CLIPLoader', 'VAELoader', 'LoraLoader', 'LoraLoaderModelOnly', 'UpscaleModelLoader',
  'ImageUpscaleWithModel', 'ImageScaleBy', 'ImageScaleToTotalPixels', 'LoadImage', 'VAEEncode', 'VAEDecode', 'KSampler', 'CLIPTextEncode',
  'ConditioningZeroOut', 'EmptyLatentImage', 'SaveImage'];

/** The models and samplers /object_info lists, and which of the node classes used here exist. */
export function parseModels(info) {
  const o = (n, i) => comboOptions(info, n, i);
  return {
    checkpoints: o('CheckpointLoaderSimple', 'ckpt_name'),
    unets: o('UNETLoader', 'unet_name'),
    clips: o('CLIPLoader', 'clip_name'),
    clipTypes: o('CLIPLoader', 'type'),
    vaes: o('VAELoader', 'vae_name'),
    loras: o('LoraLoader', 'lora_name'),
    upscalers: o('UpscaleModelLoader', 'model_name'),
    samplers: o('KSampler', 'sampler_name'),
    schedulers: o('KSampler', 'scheduler'),
    nodes: NEEDED.filter((n) => info?.[n]),
    nodeCount: Object.keys(info || {}).length,
  };
}

const stem = (f) => String(f).replace(/\.[a-z0-9]+$/i, '').split(/[\\/]/).pop();
// Files in checkpoints/ that are not image models (VAEs, audio, video) stay out of the presets.
const NOT_IMAGE_CKPT = /(^|[_\-.])(vae|audio)([_\-.]|$)|ltx|wan2|hunyuan_?video|svd/i;

/**
 * Ready-to-use model presets with sensible sampler defaults: Krea 2 (its UNET + the Qwen3-VL text
 * encoder + the Qwen-Image VAE) when those files are present, then every image checkpoint.
 */
export function buildPresets(models) {
  const out = [];
  const pick = (list, re) => list.find((x) => re.test(x));
  if (models.clipTypes.includes('krea2')) {
    const clip = pick(models.clips, /qwen3.?vl.?4b/i) || pick(models.clips, /qwen3.?vl/i);
    const vae = pick(models.vaes, /qwen.?image/i);
    const unets = models.unets.filter((u) => /krea.?2/i.test(u));
    if (clip && vae) {
      for (const unet of unets) {
        const turbo = /turbo|distill|lightning/i.test(unet);
        out.push({
          id: `krea2:${unet}`, label: `Krea 2${turbo ? ' Turbo' : ''}${unets.length > 1 ? ` (${stem(unet)})` : ''}`,
          model: { family: 'unet', unet, clip, clipType: 'krea2', vae, weightDtype: 'default' },
          defaults: turbo ? { steps: 8, cfg: 1, sampler: 'euler', scheduler: 'simple' } : { steps: 28, cfg: 3.5, sampler: 'euler', scheduler: 'simple' },
        });
      }
    }
  }
  for (const ckpt of models.checkpoints.filter((c) => !NOT_IMAGE_CKPT.test(c))) {
    const fast = /turbo|lightning|lcm|hyper/i.test(ckpt);
    out.push({
      id: `ckpt:${ckpt}`, label: stem(ckpt),
      model: { family: 'checkpoint', ckpt },
      defaults: fast ? { steps: 6, cfg: 1.5, sampler: 'euler_ancestral', scheduler: 'sgm_uniform' } : { steps: 25, cfg: 6.5, sampler: 'dpmpp_2m', scheduler: 'karras' },
    });
  }
  return out;
}

// ---------------------------------------------------------------- params

const num = (v, def, min, max, int = false) => {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw badRequest(`expected a number, got ${String(v).slice(0, 20)}`);
  const c = Math.min(max, Math.max(min, n));
  return int ? Math.round(c) : c;
};

/** The prompt actually sent: the user's text plus the style's suffix. */
export function composePrompt(prompt, styleId) {
  const style = STYLES.find((s) => s.id === styleId);
  const text = String(prompt || '').trim();
  if (!style || !style.prompt) return text;
  return text ? `${text}, ${style.prompt}` : style.prompt;
}

/** An uploaded input image: "name" or { name, subfolder } → the LoadImage value "subfolder/name". */
export function imageRef(img) {
  const name = typeof img === 'string' ? img : img?.name;
  const sub = typeof img === 'string' ? '' : img?.subfolder || '';
  const all = `${sub}/${name}`;
  if (!name || /(^|[\\/])\.\.([\\/]|$)/.test(all) || /^[\\/]/.test(sub || name) || /[\0\r\n]/.test(all)) throw badRequest('image must be the name of an uploaded image');
  return sub ? `${String(sub).replace(/[\\/]+$/, '')}/${name}` : String(name);
}

/**
 * Normalize user parameters against a preset's defaults; throws 400s for bad input. `raw.model` must
 * already be a model spec (src/comfyui.js resolves presets) unless the job needs no model.
 */
export function normalizeParams(raw = {}, { defaults = {}, needModel = true } = {}) {
  const model = raw.model || null;
  if (needModel || model) {
    if (!model || (model.family !== 'checkpoint' && model.family !== 'unet')) throw badRequest('pick a model (a checkpoint or a UNET model spec)');
    if (model.family === 'checkpoint' && !model.ckpt) throw badRequest('model.ckpt is required');
    if (model.family === 'unet' && !(model.unet && model.clip && model.clipType && model.vae)) throw badRequest('a UNET model needs unet, clip, clipType and vae');
  }
  const prompt = String(raw.prompt ?? '').slice(0, 4000);
  const seedGiven = raw.seed !== undefined && raw.seed !== null && raw.seed !== '' && Number(raw.seed) >= 0;
  const size = raw.width && raw.height
    ? { width: num(raw.width, 1024, 64, 4096, true), height: num(raw.height, 1024, 64, 4096, true) }
    : sizeFor(raw.aspect || '1:1', raw.megapixels ?? 1);
  return {
    model,
    lora: raw.lora && raw.lora.name ? { name: String(raw.lora.name), strength: num(raw.lora.strength, 0.8, -4, 4) } : null,
    prompt, style: String(raw.style || 'none'), text: composePrompt(prompt, raw.style),
    negative: String(raw.negative ?? '').slice(0, 2000),
    seed: seedGiven ? num(raw.seed, 0, 0, MAX_SEED, true) : randomSeed(),
    ...size,
    megapixels: num(raw.megapixels, 1, 0.05, 4),
    steps: num(raw.steps, defaults.steps ?? 20, 1, 150, true),
    cfg: num(raw.cfg, defaults.cfg ?? 5, 0, 30),
    sampler: String(raw.sampler || defaults.sampler || 'euler'),
    scheduler: String(raw.scheduler || defaults.scheduler || 'simple'),
    batch: num(raw.batch, 1, 1, 4, true),
    strength: num(raw.strength, 0.65, 0.01, 1),
    image: raw.image ? imageRef(raw.image) : null,
    scale: num(raw.scale, 2, 1, 4),
    upscaler: raw.upscaler ? String(raw.upscaler) : '',
    enhance: num(raw.enhance, 0, 0, 0.8),
  };
}

// ---------------------------------------------------------------- graph pieces

const node = (class_type, inputs) => ({ class_type, inputs });

/** Loaders (+ optional LoRA) → { model, clip, vae } links. */
function addLoaders(g, p) {
  const m = p.model;
  let model; let clip; let vae;
  if (m.family === 'checkpoint') {
    g.ckpt = node('CheckpointLoaderSimple', { ckpt_name: m.ckpt });
    model = ['ckpt', 0]; clip = ['ckpt', 1]; vae = ['ckpt', 2];
  } else {
    g.unet = node('UNETLoader', { unet_name: m.unet, weight_dtype: m.weightDtype || 'default' });
    g.clip = node('CLIPLoader', { clip_name: m.clip, type: m.clipType });
    g.vae = node('VAELoader', { vae_name: m.vae });
    model = ['unet', 0]; clip = ['clip', 0]; vae = ['vae', 0];
  }
  if (p.lora) {
    if (m.family === 'checkpoint') {
      g.lora = node('LoraLoader', { model, clip, lora_name: p.lora.name, strength_model: p.lora.strength, strength_clip: p.lora.strength });
      model = ['lora', 0]; clip = ['lora', 1];
    } else {
      g.lora = node('LoraLoaderModelOnly', { model, lora_name: p.lora.name, strength_model: p.lora.strength });
      model = ['lora', 0];
    }
  }
  return { model, clip, vae };
}

/** Positive + negative conditioning. Split-loader models at cfg ≤ 1 ignore the negative: zero it out. */
function addConditioning(g, p, clip, text = p.text) {
  g.pos = node('CLIPTextEncode', { text, clip });
  g.neg = p.model.family === 'unet' && p.cfg <= 1
    ? node('ConditioningZeroOut', { conditioning: ['pos', 0] })
    : node('CLIPTextEncode', { text: p.negative, clip });
  return { positive: ['pos', 0], negative: ['neg', 0] };
}

function addSampler(g, p, links, latent, denoise) {
  g.sampler = node('KSampler', {
    seed: p.seed, steps: p.steps, cfg: p.cfg, sampler_name: p.sampler, scheduler: p.scheduler, denoise,
    model: links.model, positive: links.positive, negative: links.negative, latent_image: latent,
  });
  return ['sampler', 0];
}

function addSave(g, images, kind) {
  g.save = node('SaveImage', { images, filename_prefix: `${OUTPUT_PREFIX}/${kind}` });
}

// ---------------------------------------------------------------- templates

/** Text → image. */
export function buildTxt2Img(p) {
  const g = {};
  const l = addLoaders(g, p);
  const c = addConditioning(g, p, l.clip);
  g.latent = node('EmptyLatentImage', { width: p.width, height: p.height, batch_size: p.batch });
  const s = addSampler(g, p, { ...l, ...c }, ['latent', 0], 1);
  g.decode = node('VAEDecode', { samples: s, vae: l.vae });
  addSave(g, ['decode', 0], 'txt2img');
  return g;
}

/** Image (upload or sketch) → image: the input is scaled to the size budget, then denoised by `strength`. */
export function buildImg2Img(p) {
  if (!p.image) throw badRequest('image-to-image needs an input image (upload one or draw a sketch)');
  const g = {};
  const l = addLoaders(g, p);
  const c = addConditioning(g, p, l.clip);
  g.load = node('LoadImage', { image: p.image });
  // resolution_steps keeps both sides multiples of 16; older ComfyUI builds ignore the extra input.
  g.fit = node('ImageScaleToTotalPixels', { image: ['load', 0], upscale_method: 'lanczos', megapixels: p.megapixels, resolution_steps: 16 });
  g.encode = node('VAEEncode', { pixels: ['fit', 0], vae: l.vae });
  const s = addSampler(g, p, { ...l, ...c }, ['encode', 0], p.strength);
  g.decode = node('VAEDecode', { samples: s, vae: l.vae });
  addSave(g, ['decode', 0], 'img2img');
  return g;
}

/** Upscale factor an upscale model's file name implies ("4x-UltraSharp" → 4, "RealESRGAN_x2" → 2); 4 when it does not say. */
export function upscalerFactor(name) {
  const m = /(?:^|[^a-z0-9])([1-8])x|(?:^|[^a-z0-9])x([1-8])(?![0-9])/i.exec(String(name || ''));
  return m ? Number(m[1] || m[2]) : 4;
}

/**
 * Upscale / enhance: an upscale model when one is chosen (then resized to the asked factor), else a
 * lanczos resize; `enhance` > 0 adds a low-denoise pass with the diffusion model to put detail back.
 */
export function buildUpscale(p) {
  if (!p.image) throw badRequest('upscale needs an input image');
  const g = {};
  g.load = node('LoadImage', { image: p.image });
  let img = ['load', 0];
  if (p.upscaler) {
    g.upmodel = node('UpscaleModelLoader', { model_name: p.upscaler });
    g.upscale = node('ImageUpscaleWithModel', { upscale_model: ['upmodel', 0], image: img });
    img = ['upscale', 0];
    const ratio = p.scale / upscalerFactor(p.upscaler);
    if (Math.abs(ratio - 1) > 1e-6) {
      g.resize = node('ImageScaleBy', { image: img, upscale_method: 'lanczos', scale_by: Math.round(ratio * 10000) / 10000 });
      img = ['resize', 0];
    }
  } else {
    g.resize = node('ImageScaleBy', { image: img, upscale_method: 'lanczos', scale_by: p.scale });
    img = ['resize', 0];
  }
  if (p.enhance > 0) {
    if (!p.model) throw badRequest('enhance needs a model');
    const l = addLoaders(g, p);
    const c = addConditioning(g, p, l.clip, p.text || 'high detail, sharp focus, crisp textures');
    g.encode = node('VAEEncode', { pixels: img, vae: l.vae });
    const s = addSampler(g, p, { ...l, ...c }, ['encode', 0], p.enhance);
    g.decode = node('VAEDecode', { samples: s, vae: l.vae });
    img = ['decode', 0];
  }
  addSave(g, img, 'upscale');
  return g;
}

export const BUILDERS = { txt2img: buildTxt2Img, img2img: buildImg2Img, upscale: buildUpscale };

/** Does this kind of job need a diffusion model? (A plain upscale does not.) */
export const needsModel = (kind, raw = {}) => kind !== 'upscale' || Number(raw.enhance) > 0;

// ---------------------------------------------------------------- validation against /object_info

/**
 * Check a graph against /object_info before queueing it, so a missing model or custom node is a clear
 * message instead of a ComfyUI stack trace. Returns [{ nodeId, nodeType, input?, code, message }].
 * Uploaded images (LoadImage) are not checked: a cached list never has the file just uploaded.
 */
export function checkGraph(graph, info) {
  const problems = [];
  for (const [id, n] of Object.entries(graph || {})) {
    if (!info?.[n?.class_type]) {
      problems.push({ nodeId: id, nodeType: n?.class_type, code: 'missing_node', message: `ComfyUI has no "${n?.class_type}" node (a custom node that is not installed, or an older ComfyUI)` });
      continue;
    }
    for (const [input, value] of Object.entries(n.inputs || {})) {
      if (typeof value !== 'string') continue;
      const spec = inputSpec(info, n.class_type, input);
      if (!Array.isArray(spec) || spec[1]?.image_upload) continue;
      if (!(Array.isArray(spec[0]) || spec[0] === 'COMBO')) continue;
      const opts = comboOptions(info, n.class_type, input);
      if (opts.includes(value)) continue;
      const model = /Loader/.test(n.class_type) && /_name$/.test(input);
      const list = `${opts.slice(0, 6).join(', ')}${opts.length > 6 ? ', …' : ''}`;
      problems.push({
        nodeId: id, nodeType: n.class_type, input, code: model ? 'missing_model' : 'bad_value',
        message: model
          ? (opts.length ? `"${value}" is not installed on this ComfyUI (${n.class_type} has: ${list})` : `no ${input.replace(/_name$/, '').replace(/_/g, ' ')} models are installed on this ComfyUI ("${value}" was asked for)`)
          : `${n.class_type}.${input} does not accept "${value}" (choices: ${list})`,
      });
    }
  }
  return problems;
}

/** Relative weight of a node in the progress bar: sampling dominates, loading and upscaling count a little. */
export const nodeWeight = (classType) => (classType === 'KSampler' ? 8 : /Loader|Upscale/.test(classType || '') ? 2 : 1);
