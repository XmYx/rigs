// Workflow templates: API-format ComfyUI workflows (workflows/*.api.json) plus a node map each
// (workflows/*.map.json) that says which node input takes the prompt, seed, size, length and fps, which
// loaders name a model file, and which nodes produce the clip and its last frame.
//   loadTemplates()        every template in workflows/, by id
//   buildWorkflow()        a fresh API-format workflow with the values (and model overrides) filled in
//   checkTemplate()        what /object_info says is missing: node classes and model files
//   framesFor(), fitSize() clamp user choices to what a model accepts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKFLOW_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'workflows');

/** Read every workflows/*.map.json and its workflow. Throws when a map points at a node the workflow lacks. */
export function loadTemplates(dir = WORKFLOW_DIR) {
  const out = new Map();
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.map.json')).sort()) {
    const map = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const workflow = JSON.parse(fs.readFileSync(path.join(dir, map.workflow), 'utf8'));
    const t = { ...map, workflow };
    validateMap(t);
    out.set(t.id, t);
  }
  return out;
}

function validateMap(t) {
  const has = (ref, what) => {
    const node = t.workflow[ref.node];
    if (!node) throw new Error(`${t.id}: ${what} points at node ${ref.node}, which the workflow does not have`);
    if (ref.input && !(ref.input in node.inputs)) throw new Error(`${t.id}: ${what} points at ${node.class_type}.${ref.input}, which node ${ref.node} does not have`);
  };
  for (const [k, refs] of Object.entries(t.params || {})) for (const r of refs) has(r, `param ${k}`);
  for (const [k, r] of Object.entries(t.models || {})) has(r, `model ${k}`);
  for (const [k, id] of Object.entries(t.outputs || {})) has({ node: id }, `output ${k}`);
}

/** Seconds at fps → a frame count the model accepts (step·k + offset), within maxFrames. */
export function framesFor(seconds, fps, limits = {}) {
  const step = limits.framesStep || 1;
  const off = limits.framesOffset || 0;
  const max = limits.maxFrames || 1e6;
  const want = Math.max(1, Math.round(Number(seconds) * Number(fps)));
  let k = Math.max(1, Math.round((want - off) / step));
  while (k > 1 && k * step + off > max) k--;
  return k * step + off;
}

/** Width/height → multiples of sizeStep, at least one step, within maxWidth × maxHeight. */
export function fitSize(width, height, limits = {}) {
  const step = limits.sizeStep || 8;
  const clamp = (v, max) => Math.max(step, Math.min(Math.floor((max || 1280) / step) * step, Math.round(Number(v) / step) * step));
  return { width: clamp(width, limits.maxWidth), height: clamp(height, limits.maxHeight) };
}

/** The model file each slot uses: the template's own name unless settings override it for the family. */
export function modelChoices(t, overrides = {}) {
  const fam = overrides[t.family] || {};
  const out = {};
  for (const [slot, r] of Object.entries(t.models || {})) out[slot] = fam[slot] || t.workflow[r.node].inputs[r.input];
  return out;
}

/**
 * A deep copy of the template's workflow with `values` applied through the node map. Only keys the map
 * knows are applied; `frames` also sets `lastFrameIndex` (frames − 1) unless that is given.
 */
export function buildWorkflow(t, values = {}, overrides = {}) {
  const wf = structuredClone(t.workflow);
  for (const n of Object.values(wf)) delete n._meta;
  const v = { ...values };
  if (v.frames != null && v.lastFrameIndex == null) v.lastFrameIndex = v.frames - 1;
  for (const [key, refs] of Object.entries(t.params || {})) {
    if (v[key] == null) continue;
    for (const r of refs) wf[r.node].inputs[r.input] = v[key];
  }
  const models = modelChoices(t, overrides);
  for (const [slot, r] of Object.entries(t.models || {})) wf[r.node].inputs[r.input] = models[slot];
  return wf;
}

/** The option list /object_info gives for an input: old style [[...]] or the newer ["COMBO", {options}]. */
export function inputOptions(objectInfo, classType, input) {
  const def = objectInfo?.[classType]?.input;
  const spec = def?.required?.[input] || def?.optional?.[input];
  if (!spec) return null;
  if (Array.isArray(spec[0])) return spec[0];
  if (Array.isArray(spec[1]?.options)) return spec[1].options;
  return null;
}

/**
 * What a ComfyUI instance lacks for this template, from its /object_info:
 * {ok, missingNodes:[{node, classType}], missingModels:[{slot, node, classType, input, want, available, url, dir}]}.
 * Submitting a workflow with a missing model can make ComfyUI (or a downloader node) fetch gigabytes,
 * so nothing is queued unless this says ok.
 */
export function checkTemplate(t, objectInfo, overrides = {}) {
  const missingNodes = [];
  const seen = new Set();
  for (const [id, n] of Object.entries(t.workflow)) {
    if (objectInfo?.[n.class_type] || seen.has(n.class_type)) continue;
    seen.add(n.class_type);
    missingNodes.push({ node: id, classType: n.class_type });
  }
  const missingModels = [];
  const models = modelChoices(t, overrides);
  for (const [slot, r] of Object.entries(t.models || {})) {
    const classType = t.workflow[r.node].class_type;
    if (!objectInfo?.[classType]) continue; // already reported as a missing node
    const available = inputOptions(objectInfo, classType, r.input) || [];
    if (!available.includes(models[slot])) missingModels.push({ slot, node: r.node, classType, input: r.input, want: models[slot], available, url: r.url || null, dir: r.dir || null });
  }
  // Every other fixed choice (sampler, scheduler, encoder type, codec…) must be one this instance offers.
  // Inputs the node map fills at run time (the start image) and model slots are skipped.
  const skip = new Set([...Object.values(t.params || {}).flat(), ...Object.values(t.models || {})].map((r) => `${r.node}.${r.input}`));
  const badValues = [];
  for (const [id, n] of Object.entries(t.workflow)) {
    if (!objectInfo?.[n.class_type]) continue;
    for (const [input, value] of Object.entries(n.inputs)) {
      if (Array.isArray(value) || skip.has(`${id}.${input}`)) continue;
      const options = inputOptions(objectInfo, n.class_type, input);
      if (options && !options.includes(value)) badValues.push({ node: id, classType: n.class_type, input, want: value, available: options.slice(0, 50) });
    }
  }
  return { ok: !missingNodes.length && !missingModels.length && !badValues.length, missingNodes, missingModels, badValues };
}

/** One readable line for a failed check. */
export function describeMissing(id, check) {
  const parts = [];
  if (check.missingNodes.length) parts.push('nodes ' + check.missingNodes.map((m) => m.classType).join(', '));
  if (check.missingModels.length) parts.push('models ' + check.missingModels.map((m) => `${m.want} (${m.classType}.${m.input})`).join(', '));
  if (check.badValues?.length) parts.push('options ' + check.badValues.map((m) => `${m.classType}.${m.input}=${m.want}`).join(', '));
  return `${id}: ComfyUI is missing ${parts.join('; ')}`;
}

/** Template summary for the browser: no workflow body. */
export function templateInfo(t) {
  const { workflow, params, ...rest } = t;
  return { ...rest, params: Object.keys(params || {}) };
}
