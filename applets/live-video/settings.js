// Live Video settings: which ComfyUI to drive and how to reach it. Stored in
// <RIGS_HOME>/live-video/settings.json (mode 0600, it can hold a token):
//   { comfyUrl, authHeader, authToken, overseer: { mode, url, client }, models: { <family>: { <slot>: file } } }
// The token never leaves this process: publicSettings() reports only whether one is set and its length.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HOME } from '../../src/util.js';

export const DEFAULT_COMFY_URL = 'http://127.0.0.1:8188';

export const DEFAULTS = {
  // null = not chosen yet: use the locally detected ComfyUI (src/capabilities.js), if any.
  comfyUrl: null,
  authHeader: 'Authorization',
  authToken: null,
  // GPU overseer (VRAM leases between the apps sharing this GPU). 'auto' = only when ComfyUI is on this machine.
  overseer: { mode: 'auto', url: 'http://127.0.0.1:8195', client: 'comfyui' },
  // Model file per slot, per template family, when the instance names its files differently.
  models: {},
};

export function settingsFile(env = process.env) {
  const rigsHome = env.RIGS_HOME ? path.resolve(env.RIGS_HOME) : path.join(HOME, '.rigs');
  return path.join(rigsHome, 'live-video', 'settings.json');
}

export function loadSettings(file = settingsFile()) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
  return { ...DEFAULTS, ...saved, overseer: { ...DEFAULTS.overseer, ...(saved.overseer || {}) }, models: { ...(saved.models || {}) } };
}

export async function saveSettings(file, settings) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, file);
}

/** http(s) URL without credentials or query, trailing slashes trimmed; null when it is not one. */
export function normalizeUrl(s) {
  let u;
  try { u = new URL(String(s).trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash) return null;
  return u.toString().replace(/\/+$/, '');
}

const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
const MODE_RE = /^(auto|on|off)$/;
const FILE_RE = /^[^\0\r\n]{1,255}$/;

/**
 * Apply a PUT body to the current settings. Absent keys are kept; authToken "" or null clears the token.
 * Returns {settings} or {error}. Errors name the field, never the value.
 */
export function applyPatch(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { error: 'settings must be a JSON object' };
  const next = structuredClone(current);
  if ('comfyUrl' in patch) {
    if (patch.comfyUrl == null || patch.comfyUrl === '') next.comfyUrl = null;
    else {
      const u = normalizeUrl(patch.comfyUrl);
      if (!u) return { error: 'comfyUrl must be an http(s) URL without user:password, query or fragment (put credentials in the auth token)' };
      next.comfyUrl = u;
    }
  }
  if ('authHeader' in patch) {
    if (patch.authHeader == null || patch.authHeader === '') next.authHeader = DEFAULTS.authHeader;
    else if (typeof patch.authHeader === 'string' && HEADER_RE.test(patch.authHeader)) next.authHeader = patch.authHeader;
    else return { error: 'authHeader must be a header name (letters, digits, dashes)' };
  }
  if ('authToken' in patch) {
    if (patch.authToken == null || patch.authToken === '') next.authToken = null;
    else if (typeof patch.authToken === 'string' && patch.authToken.length <= 4096 && !/[\r\n\0]/.test(patch.authToken)) next.authToken = patch.authToken;
    else return { error: 'authToken must be a single-line string' };
  }
  if ('overseer' in patch) {
    const o = patch.overseer || {};
    if (o.mode != null && !MODE_RE.test(o.mode)) return { error: 'overseer.mode must be auto, on or off' };
    if (o.url != null && !normalizeUrl(o.url)) return { error: 'overseer.url must be an http(s) URL' };
    if (o.client != null && !/^[\w.-]{1,64}$/.test(o.client)) return { error: 'overseer.client must be a client id' };
    next.overseer = { ...next.overseer, ...(o.mode != null && { mode: o.mode }), ...(o.url != null && { url: normalizeUrl(o.url) }), ...(o.client != null && { client: o.client }) };
  }
  if ('models' in patch) {
    if (!patch.models || typeof patch.models !== 'object') return { error: 'models must be {family: {slot: file}}' };
    for (const [fam, slots] of Object.entries(patch.models)) {
      if (slots == null) { delete next.models[fam]; continue; }
      if (typeof slots !== 'object') return { error: 'models must be {family: {slot: file}}' };
      const merged = { ...(next.models[fam] || {}) };
      for (const [slot, file] of Object.entries(slots)) {
        if (file == null || file === '') delete merged[slot];
        else if (typeof file === 'string' && FILE_RE.test(file)) merged[slot] = file;
        else return { error: `models.${fam}.${slot} must be a file name` };
      }
      if (Object.keys(merged).length) next.models[fam] = merged; else delete next.models[fam];
    }
  }
  return { settings: next };
}

/** The ComfyUI URL in effect: saved, else detected, else none. */
export function effectiveUrl(settings, detectedUrl) {
  if (settings.comfyUrl) return { url: settings.comfyUrl, source: 'saved' };
  if (detectedUrl) return { url: detectedUrl, source: 'detected' };
  return { url: '', source: 'none' };
}

/** What GET api/settings returns: everything but the token, which is reported as set + length only. */
export function publicSettings(settings, detectedUrl) {
  const { url, source } = effectiveUrl(settings, detectedUrl);
  return {
    comfyUrl: url, source, savedUrl: settings.comfyUrl, detectedUrl: detectedUrl || null,
    authHeader: settings.authHeader, authTokenSet: !!settings.authToken, authTokenLength: settings.authToken ? settings.authToken.length : 0,
    overseer: { ...settings.overseer }, models: structuredClone(settings.models),
  };
}

/** Whether to lease VRAM from the overseer for this ComfyUI: on, off, or auto = only when it is local. */
export function overseerApplies(settings, comfyUrl) {
  const mode = settings.overseer?.mode || 'auto';
  if (mode === 'off' || !comfyUrl) return false;
  if (mode === 'on') return true;
  try { return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(comfyUrl).hostname); } catch { return false; }
}
