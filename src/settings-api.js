// Unified settings read/patch API (docs/settings.md "API contract"): GET/POST /api/local/settings over the schema in
// ui/src/settings-model.js. Reads go through each writer's normaliser; writes go through the same setters as the
// per-feature endpoints, so validation and side effects stay exactly as they are there.
import { config, currentGlobal, markGlobalChanged, patchConfig, saveConfig, PATCH_BLOCKED } from './config.js';
import { homeNode } from './globalbrain.js';
import { log } from './util.js';
import * as models from './models.js';
import * as exhibits from './exhibits.js';
import * as starnet from './starnet.js';
import { applyQuickPatch, localSettings, quickSettings } from './quick.js';
import { applyRouterPatch, routerSettings } from './router.js';
import { applyYoloPatch, yoloSettings } from './yolo.js';
import { loadSettings as loadComfy } from './comfyui.js';
import { loadSettings as loadLinear, resolveApiKey } from './linear.js';
import { loadSettings as loadDrive } from './connectors/google-drive.js';
import {
  CATEGORIES, SCHEMA_VERSION, WRITERS, getPath, isWritable, itemById, planPatch, secretStatus, serverItems,
} from '../ui/src/settings-model.js';

export class SettingsError extends Error {
  constructor(status, message, extra = {}) { super(message); this.name = 'SettingsError'; this.status = status; Object.assign(this, extra); }
}

/** The object each writer's normaliser reads, and where an item's path sits in it. */
function writerView(writer, cfg) {
  switch (writer) {
    case 'router': return routerSettings(cfg.router);
    case 'quick': return { ...quickSettings(cfg.quick), local: localSettings(cfg.quick?.local) };
    case 'yolo': return yoloSettings(cfg.yolo);
    case 'exhibits': return exhibits.settings(cfg);
    case 'starnet': return starnet.settings(cfg);
    case 'comfyui': return loadComfy(cfg);
    case 'linear': return loadLinear(cfg);
    case 'googleDrive': return loadDrive(cfg);
    default: return undefined; // brainHome / brainChat / brainCore / config read the config itself
  }
}

const relPath = (it) => {
  const w = WRITERS[it.writer || 'config'];
  return it.config === w.prefix ? w.field : it.config.slice(w.prefix ? w.prefix.length + 1 : 0);
};

/** The effective value of a config item (secrets excluded). */
function effectiveValue(it, cfg) {
  let v;
  const w = it.writer;
  if (w === 'brainHome') v = homeNode(cfg);
  else if (w && w !== 'config' && w !== 'brainChat' && w !== 'brainCore') v = getPath(writerView(w, cfg), relPath(it));
  else v = getPath(cfg, it.config);
  return v === undefined ? it.default : v;
}

function secretEntry(it, cfg, env) {
  const stored = getPath(cfg, it.config);
  if (typeof stored === 'string' && stored) return secretStatus(stored, 'config');
  if (it.id === 'linear.apiKey') { const r = resolveApiKey(loadLinear(cfg), env); return secretStatus(r.key, r.source || 'config'); }
  const fromEnv = it.env ? env[it.env] : '';
  return fromEnv ? secretStatus(fromEnv, 'env') : secretStatus('');
}

/** GET payload: every server-side item of the schema, grouped by category, with its current value. */
export function readSettings({ cfg = config(), env = process.env, node } = {}) {
  const items = new Set(serverItems().map((i) => i.id));
  const categories = [];
  for (const c of CATEGORIES) {
    const out = [];
    for (const it of c.items) {
      if (!items.has(it.id)) continue;
      const e = { id: it.id, scope: it.scope, readOnly: !isWritable(it.id) };
      if (it.secret) e.secret = secretEntry(it, cfg, env);
      else e.value = effectiveValue(it, cfg);
      if (it.env) {
        e.env = it.env;
        if (!it.secret && env[it.env] !== undefined && env[it.env] !== '') e.overridden = true;
      }
      out.push(e);
    }
    if (out.length) categories.push({ id: c.id, items: out });
  }
  return { node: node ?? cfg.name, schemaVersion: SCHEMA_VERSION, global: { ...currentGlobalMeta(), home: homeNode(cfg) }, categories };
}

function currentGlobalMeta() { const { rev, by } = currentGlobal(); return { rev, by }; }

/**
 * Apply a plan write by write, through the setter the endpoint it mirrors uses. `deps`: discovery (brain/home), comfy,
 * linear, drive (the connector services), warm (responder warm-up), emit (starnet config to open UIs).
 */
async function applyWrite(w, deps) {
  const b = w.body;
  const cfg = config();
  switch (w.writer) {
    case 'router': {
      let next;
      try { next = applyRouterPatch(cfg.router, b); } catch (e) { throw new SettingsError(400, e.message); }
      cfg.router = next; saveConfig(cfg); markGlobalChanged();
      return;
    }
    case 'quick': {
      let next;
      try { next = applyQuickPatch(cfg.quick, b); } catch (e) { throw new SettingsError(400, e.message); }
      if (b.local?.enabled !== undefined && next.local?.enabled && !next.local.node) next.local.node = cfg.name;
      cfg.quick = next; saveConfig(cfg);
      markGlobalChanged(); // every quick change: quick is mesh-global (docs/settings.md, POST step 4)
      if (b.local !== undefined && next.local?.enabled && next.local.node === cfg.name) deps.warm?.(next.local);
      return;
    }
    case 'yolo': {
      let next;
      try { next = applyYoloPatch(cfg.yolo, b); } catch (e) { throw new SettingsError(400, e.message); }
      cfg.yolo = next; saveConfig(cfg); markGlobalChanged();
      return;
    }
    case 'brainHome': {
      const n = b.node ? deps.discovery?.get(b.node) : null;
      if (b.node && !n) throw new SettingsError(400, `unknown machine ${b.node}`);
      patchConfig({ brain: { home: n ? n.name : '' } });
      return;
    }
    case 'brainChat': {
      patchConfig({ brain: { chat: { provider: b.provider || 'claude', model: b.model || '', effort: b.effort || '' } } });
      if (b.provider === models.CLAUDE_OLLAMA && b.model) patchConfig({ brain: { claudeOllama: { model: b.model } } });
      return;
    }
    case 'brainCore': {
      const core = { provider: b.provider || 'auto', model: b.model || '', effort: b.effort || '', node: b.node || cfg.name };
      patchConfig({ brain: { core } });
      if (core.provider === models.CLAUDE_OLLAMA && core.model) patchConfig({ brain: { claudeOllama: { model: core.model } } });
      return;
    }
    case 'exhibits': try { exhibits.saveSettings(b); } catch (e) { throw new SettingsError(400, e.message); } return;
    case 'starnet': try { starnet.saveSettings(b); } catch (e) { throw new SettingsError(400, e.message); } deps.emit?.('starnet', starnet.status()); return;
    case 'comfyui': try { await deps.comfy.setConfig(b); } catch (e) { throw new SettingsError(400, e.message); } return;
    case 'linear': try { deps.linear.setConfig(b); } catch (e) { throw new SettingsError(400, e.message); } return;
    case 'googleDrive': try { deps.drive.setSettings(b); } catch (e) { throw new SettingsError(400, e.message); } return;
    case 'config': {
      for (const k of Object.keys(b)) if (PATCH_BLOCKED.includes(k)) throw new SettingsError(400, `${k} cannot be changed here`);
      patchConfig(b);
      return;
    }
    default: throw new SettingsError(500, `no writer ${w.writer}`);
  }
}

/** POST body { values: { id: value } } → plan, apply, answer with the fresh GET plus applied / restart. */
export async function patchSettings(body, deps = {}) {
  const values = body?.values;
  const { writes, errors } = planPatch(values, { current: (p) => getPath(config(), p) });
  if (errors.length) throw new SettingsError(400, `${errors[0].id ? `${errors[0].id}: ` : ''}${errors[0].error}`, { errors });
  const applied = [];
  for (const w of writes) {
    try { await applyWrite(w, deps); } catch (e) {
      if (e instanceof SettingsError) { e.applied = applied; e.errors = [{ id: w.ids[0], error: e.message }]; }
      throw e;
    }
    applied.push(...w.ids);
  }
  if (applied.length) log(`settings: changed ${applied.join(', ')}`); // ids only — never a value
  const restart = applied.filter((id) => itemById(id)?.restart);
  const res = { ...readSettings({ node: deps.node }), applied };
  if (restart.length) res.restart = restart;
  return res;
}
