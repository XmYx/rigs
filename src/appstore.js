import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as appsReg from './apps.js';
import { config, RIGS_HOME, saveConfig } from './config.js';
import { APP_DIR, HOME, augmentedPath, expandHome, isWin, platformName, run, spawnCmd, which } from './util.js';

/**
 * App Store: a catalog of installable apps for the App Cloud, and the installer that puts one on this machine.
 *
 * Catalog: one JSON manifest per app in appstore/catalog/ (ships with RIGS) and ~/.rigs/appstore/catalog/
 * (local additions; a later file with the same id wins). The format is documented in appstore/README.md:
 * id, name, icon, description, version, platforms, needs {gpu, vramGB, diskGB, python}, source (git | rigs |
 * tarball), runtime (python | node | none), models [{name, kind: hf|url, …, dest, sizeGB}], port, healthPath,
 * env, launch {command, cwd, systemd {unit, after, wants, service}}, gpuOverseer, postInstall, rewrite.
 * Placeholders in launch, env, postInstall, model dests and gpuOverseer: {id} {root} {appDir} {venv} {python}
 * {node} {port} {home} {rigsApp} {modelsDir} {hfHome}. A relative model dest is inside the app folder.
 *
 * Install: a job of resumable steps (STEPS) with progress events. Everything lands in <appsDir>/<id> (default
 * ~/.rigs/apps/<id>): app/ (the source; a "rigs" source runs in place from the RIGS checkout), venv/,
 * install.json (step state) and install.log. A step records a key (a hash of what it depends on) when it
 * finishes, so installing again skips what is done and redoes only what changed; a failed or cancelled install
 * resumes from the failed step. Linux with a user systemd gets an enabled `systemctl --user` unit; elsewhere a
 * launcher script that apps.js startApp runs (registered as { command } on macOS/Linux, { windows: { command } } on
 * Windows). Paths are built with path.join, so a Windows install uses venv\Scripts\python.exe and backslashes. The app is registered in config.apps (installedBy: "appstore")
 * and started. Uninstall unregisters it, disables the unit and moves the files to ~/.rigs/trash — never deletes.
 *
 * Test hooks: RIGS_APPS_DIR, RIGS_NO_SYSTEMD=1, RIGS_SYSTEMD_USER_DIR, RIGS_GPU_OVERSEER_CLIENTS; every entry
 * point takes `deps` ({ exec, which, fetch, startApp, platform, systemd, gpus, freeGB, unitDir }) to fake the world.
 */

export const CATALOG_DIR = path.join(APP_DIR, 'appstore', 'catalog');
export const PLATFORMS = Object.freeze(['linux', 'mac', 'windows']);
export const STEPS = Object.freeze([
  { id: 'check', label: 'Check this machine', weight: 1 },
  { id: 'fetch', label: 'Fetch the app', weight: 8 },
  { id: 'venv', label: 'Create the environment', weight: 4 },
  { id: 'deps', label: 'Install dependencies', weight: 25 },
  { id: 'models', label: 'Download models', weight: 50 },
  { id: 'post', label: 'Post-install steps', weight: 3 },
  { id: 'launch', label: 'Set up the launcher', weight: 2 },
  { id: 'register', label: 'Register in the App Cloud', weight: 1 },
  { id: 'health', label: 'Start and check health', weight: 6 },
]);
export const MARKER = 'Managed by the RIGS App Store';
const STORE_TAG = 'appstore';
const OVERSEER_TAG = 'rigs-appstore';
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const PLACEHOLDERS = ['id', 'root', 'appDir', 'venv', 'python', 'node', 'port', 'home', 'rigsApp', 'modelsDir', 'hfHome'];
const GB = 1024 ** 3;
const TOP_KEYS = ['id', 'name', 'icon', 'description', 'version', 'homepage', 'license', 'notes', 'platforms', 'needs', 'source', 'runtime', 'models', 'port', 'healthPath', 'healthTimeoutSec', 'env', 'launch', 'gpuOverseer', 'postInstall', 'rewrite'];

// ---------------------------------------------------------------- manifest validation

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isStrList = (v) => Array.isArray(v) && v.every(isStr);
/** A relative path that stays inside its base (no absolute path, no `..`). */
const relSafe = (p) => isStr(p) && !path.isAbsolute(p) && !/^[a-zA-Z]:/.test(p) && !p.split(/[\\/]/).includes('..');

function unknownKeys(obj, known, field, bad) {
  for (const k of Object.keys(obj)) if (!known.includes(k) && !k.startsWith('_') && !k.startsWith('$')) bad(field ? `${field}.${k}` : k, `is not a known field (${known.join(', ')})`);
}

/**
 * Validate one manifest. Returns { manifest, errors }: manifest is the normalized app (defaults filled in) or
 * null, errors are readable lines like "live-video: models[0].repo must be a Hugging Face repo id like org/name".
 */
export function validateManifest(raw, { file = '' } = {}) {
  const errors = [];
  const bad = (field, msg) => errors.push(`${field} ${msg}`);
  if (!isObj(raw)) return { manifest: null, errors: [`${file || 'manifest'}: must be a JSON object`] };
  unknownKeys(raw, TOP_KEYS, '', bad);
  const id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase() : '';
  if (!ID_RE.test(id)) bad('id', 'must be 1-40 chars of a-z, 0-9, - or _ (it becomes the App Cloud app id)');
  if (!isStr(raw.name)) bad('name', 'is required');
  for (const k of ['icon', 'description', 'version', 'homepage', 'license', 'notes']) if (raw[k] !== undefined && typeof raw[k] !== 'string') bad(k, 'must be a string');

  let platforms = [...PLATFORMS];
  if (raw.platforms !== undefined) {
    const unknown = Array.isArray(raw.platforms) ? raw.platforms.filter((p) => !PLATFORMS.includes(p)) : [];
    if (!Array.isArray(raw.platforms) || !raw.platforms.length) bad('platforms', `must be a non-empty list of ${PLATFORMS.join(', ')}`);
    else if (unknown.length) bad('platforms', `has unknown platform(s) ${unknown.join(', ')} (use ${PLATFORMS.join(', ')})`);
    else platforms = [...new Set(raw.platforms)];
  }

  const needs = { gpu: false, vramGB: 0, diskGB: 0, python: '' };
  if (raw.needs !== undefined) {
    const n = raw.needs;
    if (!isObj(n)) bad('needs', 'must be an object');
    else {
      unknownKeys(n, ['gpu', 'vramGB', 'diskGB', 'python'], 'needs', bad);
      if (n.gpu !== undefined) { if (![true, false, 'nvidia'].includes(n.gpu)) bad('needs.gpu', 'must be true, false or "nvidia"'); else needs.gpu = n.gpu; }
      for (const k of ['vramGB', 'diskGB']) if (n[k] !== undefined) { if (!isNum(n[k])) bad(`needs.${k}`, 'must be a number ≥ 0'); else needs[k] = n[k]; }
      if (n.python !== undefined) { if (typeof n.python !== 'string' || !/^3\.\d{1,2}$/.test(n.python)) bad('needs.python', 'must be a Python minor version like "3.11"'); else needs.python = n.python; }
    }
  }

  let source = null;
  const s = raw.source;
  if (!isObj(s)) bad('source', 'is required: { "type": "git", "url", "ref" } | { "type": "rigs", "path" } | { "type": "tarball", "url" }');
  else if (s.type === 'git') {
    unknownKeys(s, ['type', 'url', 'ref', 'subdir'], 'source', bad);
    if (!isStr(s.url) || !/^(https?:\/\/|ssh:\/\/|git@|file:\/\/)/.test(s.url)) bad('source.url', 'must be a git URL (https://, ssh://, git@… or file://)');
    if (s.ref !== undefined && (typeof s.ref !== 'string' || /\s/.test(s.ref) || s.ref.startsWith('-'))) bad('source.ref', 'must be a branch, tag or commit');
    if (s.subdir !== undefined && s.subdir !== '' && !relSafe(s.subdir)) bad('source.subdir', 'must be a relative path inside the repo');
    source = { type: 'git', url: String(s.url || ''), ref: s.ref || '', subdir: s.subdir || '' };
  } else if (s.type === 'rigs') {
    unknownKeys(s, ['type', 'path', 'copy'], 'source', bad);
    if (!relSafe(s.path)) bad('source.path', 'must be a relative path inside the RIGS repo, e.g. "applets/navigation"');
    if (s.copy !== undefined && typeof s.copy !== 'boolean') bad('source.copy', 'must be true or false');
    source = { type: 'rigs', path: String(s.path || '').replace(/\\/g, '/').replace(/\/+$/, ''), copy: !!s.copy };
  } else if (s.type === 'tarball') {
    unknownKeys(s, ['type', 'url', 'sha256', 'subdir'], 'source', bad);
    if (!isStr(s.url) || !/^(https?|file):\/\//.test(s.url)) bad('source.url', 'must be an http(s):// or file:// URL of a .tar.gz, .tar.xz, .tgz or .zip');
    if (s.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(String(s.sha256))) bad('source.sha256', 'must be 64 hex chars');
    if (s.subdir !== undefined && s.subdir !== '' && !relSafe(s.subdir)) bad('source.subdir', 'must be a relative path inside the archive');
    source = { type: 'tarball', url: String(s.url || ''), sha256: s.sha256 ? String(s.sha256).toLowerCase() : '', subdir: s.subdir || '' };
  } else bad('source.type', 'must be git, rigs or tarball');

  let runtime = { type: 'none' };
  const r = raw.runtime;
  if (r !== undefined) {
    if (!isObj(r)) bad('runtime', 'must be an object');
    else if (r.type === 'python') {
      unknownKeys(r, ['type', 'requirements', 'packages', 'extras', 'project', 'torch', 'pipArgs'], 'runtime', bad);
      const requirements = typeof r.requirements === 'string' ? [r.requirements] : r.requirements ?? [];
      if (!Array.isArray(requirements) || !requirements.every(relSafe)) bad('runtime.requirements', 'must be requirement file path(s) relative to the app folder');
      for (const k of ['packages', 'extras', 'pipArgs']) if (r[k] !== undefined && !isStrList(r[k])) bad(`runtime.${k}`, 'must be a list of strings');
      if (Array.isArray(r.packages) && r.packages.some((p) => String(p).startsWith('-'))) bad('runtime.packages', 'holds package specs only; put pip flags in runtime.pipArgs');
      if (r.project !== undefined && typeof r.project !== 'boolean') bad('runtime.project', 'must be true or false');
      let torch = null;
      if (r.torch !== undefined) {
        if (!isObj(r.torch) || !isStr(r.torch.index) || !/^https?:\/\//.test(r.torch.index)) bad('runtime.torch', 'must be { "index": "https://download.pytorch.org/whl/cu128", "packages": ["torch", …] }');
        else if (r.torch.packages !== undefined && !isStrList(r.torch.packages)) bad('runtime.torch.packages', 'must be a list of package specs');
        else torch = { index: r.torch.index, packages: r.torch.packages || [] };
      }
      runtime = { type: 'python', requirements: Array.isArray(requirements) ? requirements : [], packages: r.packages || [], extras: r.extras || [], project: !!r.project, torch, pipArgs: r.pipArgs || [] };
    } else if (r.type === 'node') {
      unknownKeys(r, ['type', 'npm'], 'runtime', bad);
      if (r.npm !== undefined && !['auto', 'ci', 'install', false].includes(r.npm)) bad('runtime.npm', 'must be "auto", "ci", "install" or false');
      runtime = { type: 'node', npm: r.npm ?? 'auto' };
    } else if (r.type !== 'none') bad('runtime.type', 'must be python, node or none');
  }
  if (needs.python && runtime.type !== 'python') bad('needs.python', 'only applies to runtime.type "python"');

  const models = [];
  if (raw.models !== undefined && !Array.isArray(raw.models)) bad('models', 'must be a list');
  for (const [i, x] of (Array.isArray(raw.models) ? raw.models : []).entries()) {
    const f = `models[${i}]`;
    if (!isObj(x)) { bad(f, 'must be an object'); continue; }
    if (!isStr(x.name)) bad(`${f}.name`, 'is required');
    else if (models.some((o) => o.name === x.name)) bad(`${f}.name`, `"${x.name}" is listed twice`);
    if (!isNum(x.sizeGB)) bad(`${f}.sizeGB`, 'must be the download size in GB (used for the disk check and progress)');
    if (x.dest !== undefined && (!isStr(x.dest) || x.dest.split(/[\\/]/).includes('..'))) bad(`${f}.dest`, 'must be a path without ".." (relative to the app folder, a {placeholder} path, ~/… or absolute)');
    else if (x.dest !== undefined && source?.type === 'rigs' && !source.copy && relSafe(x.dest) && !x.dest.startsWith('{') && !x.dest.startsWith('~')) bad(`${f}.dest`, 'must not be inside the RIGS checkout (in-place "rigs" source): use {root}/… or {hfHome}/…');
    const base = { name: String(x.name || ''), kind: x.kind, sizeGB: isNum(x.sizeGB) ? x.sizeGB : 0, dest: x.dest || '', gated: !!x.gated };
    if (x.kind === 'hf') {
      unknownKeys(x, ['name', 'kind', 'repo', 'files', 'include', 'revision', 'repoType', 'dest', 'sizeGB', 'gated'], f, bad);
      if (!isStr(x.repo) || !/^[\w.-]+\/[\w.-]+$/.test(x.repo)) bad(`${f}.repo`, 'must be a Hugging Face repo id like "org/name"');
      for (const k of ['files', 'include']) if (x[k] !== undefined && !isStrList(x[k])) bad(`${f}.${k}`, 'must be a list of file names / glob patterns');
      if (Array.isArray(x.files) && x.files.some((p) => String(p).split(/[\\/]/).includes('..'))) bad(`${f}.files`, 'must stay inside the repo');
      if (x.revision !== undefined && !isStr(x.revision)) bad(`${f}.revision`, 'must be a branch, tag or commit');
      if (x.repoType !== undefined && !['model', 'dataset', 'space'].includes(x.repoType)) bad(`${f}.repoType`, 'must be model, dataset or space');
      models.push({ ...base, repo: String(x.repo || ''), files: x.files || [], include: x.include || [], revision: x.revision || '', repoType: x.repoType || 'model' });
    } else if (x.kind === 'url') {
      unknownKeys(x, ['name', 'kind', 'url', 'dest', 'sizeGB', 'sha256', 'gated'], f, bad);
      if (!isStr(x.url) || !/^(https?|file):\/\//.test(x.url)) bad(`${f}.url`, 'must be an http(s):// URL');
      if (!isStr(x.dest)) bad(`${f}.dest`, 'is required for a url model (the file path to save to)');
      if (x.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(String(x.sha256))) bad(`${f}.sha256`, 'must be 64 hex chars');
      models.push({ ...base, url: String(x.url || ''), sha256: x.sha256 ? String(x.sha256).toLowerCase() : '' });
    } else bad(`${f}.kind`, 'must be "hf" or "url"');
  }

  const port = Number(raw.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) bad('port', 'must be an integer 1-65535 (the port the app listens on)');
  const healthPath = raw.healthPath === undefined || raw.healthPath === '' ? '/' : String(raw.healthPath);
  if (!healthPath.startsWith('/')) bad('healthPath', 'must start with /');
  if (raw.healthTimeoutSec !== undefined && !(isNum(raw.healthTimeoutSec) && raw.healthTimeoutSec > 0)) bad('healthTimeoutSec', 'must be a number of seconds > 0');

  const env = {};
  if (raw.env !== undefined) {
    if (!isObj(raw.env)) bad('env', 'must be an object of NAME: "value"');
    else for (const [k, v] of Object.entries(raw.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) bad(`env.${k}`, 'is not a valid variable name');
      else if (!['string', 'number', 'boolean'].includes(typeof v) || /[\r\n]/.test(String(v))) bad(`env.${k}`, 'must be a one-line string');
      else env[k] = String(v);
    }
  }

  let launch = null;
  const l = raw.launch;
  if (!isObj(l)) bad('launch', 'is required: { "command": ["{python}", "{appDir}/server.py", "--port", "{port}"] }');
  else {
    unknownKeys(l, ['command', 'cwd', 'systemd'], 'launch', bad);
    if (!Array.isArray(l.command) || !l.command.length || !l.command.every((a) => typeof a === 'string') || !isStr(l.command[0])) {
      bad('launch.command', 'must be the argv list, e.g. ["{python}", "{appDir}/server.py", "--port", "{port}"]');
    }
    if (l.cwd !== undefined && typeof l.cwd !== 'string') bad('launch.cwd', 'must be a path (relative to the app folder)');
    let systemd = null;
    if (l.systemd !== undefined) {
      const sd = l.systemd;
      if (!isObj(sd)) bad('launch.systemd', 'must be an object { unit, after, wants, service }');
      else {
        unknownKeys(sd, ['unit', 'after', 'wants', 'service'], 'launch.systemd', bad);
        const unit = sd.unit === undefined ? '' : String(sd.unit).replace(/\.service$/, '');
        if (sd.unit !== undefined && !/^[\w@.:-]{1,80}$/.test(unit)) bad('launch.systemd.unit', 'is not a valid unit name');
        for (const k of ['after', 'wants']) if (sd[k] !== undefined && !(isStrList(sd[k]) && sd[k].every((u) => /^[\w@.:-]+$/.test(u)))) bad(`launch.systemd.${k}`, 'must be a list of unit names');
        const service = {};
        if (sd.service !== undefined) {
          if (!isObj(sd.service)) bad('launch.systemd.service', 'must be an object of [Service] settings');
          else for (const [k, v] of Object.entries(sd.service)) {
            if (!/^[A-Z][A-Za-z]+$/.test(k)) bad(`launch.systemd.service.${k}`, 'is not a systemd setting name');
            else if (['ExecStart', 'WorkingDirectory', 'Environment'].includes(k)) bad(`launch.systemd.service.${k}`, 'comes from launch.command, launch.cwd and env');
            else if (!['string', 'number'].includes(typeof v) || /[\r\n]/.test(String(v))) bad(`launch.systemd.service.${k}`, 'must be a one-line value');
            else service[k] = String(v);
          }
        }
        systemd = { unit, after: sd.after || [], wants: sd.wants || [], service };
      }
    }
    launch = { command: Array.isArray(l.command) ? l.command.map(String) : [], cwd: typeof l.cwd === 'string' ? l.cwd : '', systemd };
  }

  let gpuOverseer = null;
  const g = raw.gpuOverseer;
  if (g !== undefined && g !== null) {
    const http = (o) => isObj(o) && isStr(o.url) && /^https?:\/\//.test(o.url);
    if (!isObj(g)) bad('gpuOverseer', 'must be an object { match, unload: { url, body }, busy: { url, method } }');
    else {
      unknownKeys(g, ['match', 'unload', 'busy'], 'gpuOverseer', bad);
      if (!http(g.unload)) bad('gpuOverseer.unload', 'must be { "url": "http://127.0.0.1:{port}/…", "body": {} } (the call that frees the app\'s VRAM)');
      if (g.busy !== undefined && !http(g.busy)) bad('gpuOverseer.busy', 'must be { "url": "http://…", "method": "GET" }');
      if (g.match !== undefined && !isStr(g.match)) bad('gpuOverseer.match', 'must be a substring of the app\'s command line');
      gpuOverseer = { match: g.match || '', unload: { url: g.unload?.url, body: g.unload?.body ?? {} }, busy: g.busy ? { url: g.busy.url, method: g.busy.method || 'GET' } : null };
    }
  }

  const postInstall = [];
  if (raw.postInstall !== undefined && !Array.isArray(raw.postInstall)) bad('postInstall', 'must be a list of { name, run: [argv…] }');
  for (const [i, p] of (Array.isArray(raw.postInstall) ? raw.postInstall : []).entries()) {
    const f = `postInstall[${i}]`;
    if (!isObj(p)) { bad(f, 'must be an object'); continue; }
    unknownKeys(p, ['name', 'run', 'cwd', 'timeoutSec', 'platforms'], f, bad);
    if (!Array.isArray(p.run) || !p.run.length || !p.run.every((a) => typeof a === 'string') || !isStr(p.run[0])) bad(`${f}.run`, 'must be the argv list, e.g. ["{python}", "scripts/setup.py"]');
    if (p.cwd !== undefined && typeof p.cwd !== 'string') bad(`${f}.cwd`, 'must be a path');
    if (p.timeoutSec !== undefined && !(isNum(p.timeoutSec) && p.timeoutSec > 0)) bad(`${f}.timeoutSec`, 'must be a number of seconds > 0');
    if (p.platforms !== undefined && !(Array.isArray(p.platforms) && p.platforms.length && p.platforms.every((x) => PLATFORMS.includes(x)))) bad(`${f}.platforms`, `must be a non-empty list of ${PLATFORMS.join(', ')}`);
    postInstall.push({ name: String(p.name || (Array.isArray(p.run) ? p.run.join(' ') : '')), run: Array.isArray(p.run) ? p.run.map(String) : [], cwd: typeof p.cwd === 'string' ? p.cwd : '', timeoutSec: p.timeoutSec || 1800, platforms: Array.isArray(p.platforms) ? p.platforms : [] });
  }

  let rewrite = {};
  if (raw.rewrite !== undefined) {
    const { app, errors: errs } = appsReg.validateApp({ id: 'x', port: 1, rewrite: raw.rewrite }, 'check');
    if (app) rewrite = app.rewrite;
    else errs.forEach((e) => errors.push(e.replace(/^x: /, '')));
  }

  // An unknown {placeholder} is a typo that would end up verbatim on a command line.
  const scan = (field, v) => {
    for (const [, name] of String(v || '').matchAll(/\{([A-Za-z]+)\}/g)) if (!PLACEHOLDERS.includes(name)) bad(field, `uses unknown placeholder {${name}} (known: ${PLACEHOLDERS.map((p) => `{${p}}`).join(' ')})`);
  };
  launch?.command.forEach((a, i) => scan(`launch.command[${i}]`, a));
  scan('launch.cwd', launch?.cwd);
  for (const [k, v] of Object.entries(env)) scan(`env.${k}`, v);
  postInstall.forEach((p, i) => { p.run.forEach((a) => scan(`postInstall[${i}].run`, a)); scan(`postInstall[${i}].cwd`, p.cwd); });
  models.forEach((x, i) => scan(`models[${i}].dest`, x.dest));
  if (runtime.type === 'python') runtime.pipArgs.forEach((a, i) => scan(`runtime.pipArgs[${i}]`, a));
  if (gpuOverseer) for (const [k, v] of [['match', gpuOverseer.match], ['unload.url', gpuOverseer.unload.url], ['busy.url', gpuOverseer.busy?.url]]) scan(`gpuOverseer.${k}`, v);

  if (errors.length) return { manifest: null, errors: errors.map((e) => `${id || file || '?'}: ${e}`) };
  return {
    manifest: {
      id, name: raw.name.trim(), icon: raw.icon || '', description: raw.description || '', version: raw.version || '',
      homepage: raw.homepage || '', license: raw.license || '', notes: raw.notes || '',
      platforms, needs, source, runtime, models, port, healthPath, healthTimeoutSec: raw.healthTimeoutSec || 180,
      env, launch, gpuOverseer, postInstall, rewrite, file,
    },
    errors: [],
  };
}

// ---------------------------------------------------------------- catalog

export function appsDir() {
  return path.resolve(expandHome(process.env.RIGS_APPS_DIR || config().appstore?.appsDir || path.join(RIGS_HOME, 'apps')));
}

/** Built-in catalog, then the local one; a later manifest with the same id replaces an earlier one. */
export function catalogDirs() {
  return [CATALOG_DIR, path.join(RIGS_HOME, 'appstore', 'catalog')];
}

/** Read and validate every *.json in the catalog dirs. Invalid manifests are reported in `errors`, not served. */
export function loadCatalog(dirs = catalogDirs()) {
  const byId = new Map();
  const errors = [];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { continue; }
    for (const name of names) {
      const file = path.join(dir, name);
      let raw;
      try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { errors.push(`${name}: not valid JSON (${e.message})`); continue; }
      const { manifest, errors: errs } = validateManifest(raw, { file: name });
      if (!manifest) { errors.push(...errs.map((e) => `${name}: ${e}`)); continue; }
      byId.set(manifest.id, { ...manifest, file });
    }
  }
  return { apps: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)), errors };
}

function catalogApp(id) {
  return loadCatalog().apps.find((a) => a.id === id) || null;
}

/** Total model download in GB. */
const downloadGB = (m) => Math.round(m.models.reduce((a, x) => a + x.sizeGB, 0) * 100) / 100;

/** The catalog card for one app: what the UI and MCP show. */
export function summarize(m) {
  return {
    id: m.id, name: m.name, icon: m.icon, description: m.description, version: m.version, homepage: m.homepage, notes: m.notes,
    platforms: m.platforms, needs: m.needs, port: m.port,
    source: m.source.type === 'rigs' ? { type: 'rigs', path: m.source.path } : { type: m.source.type, url: redact(m.source.url), ...(m.source.ref ? { ref: m.source.ref } : {}) },
    runtime: m.runtime.type,
    models: m.models.map((x) => ({ name: x.name, kind: x.kind, sizeGB: x.sizeGB, gated: x.gated, ...(x.kind === 'hf' ? { repo: x.repo } : {}) })),
    downloadGB: downloadGB(m), diskGB: Math.round((m.needs.diskGB + downloadGB(m)) * 100) / 100,
  };
}

// ---------------------------------------------------------------- machine facts

let gpuCache = null;
async function detectGpus() {
  if (gpuCache && Date.now() - gpuCache.at < 60000) return gpuCache.list;
  let list = [];
  const smi = which('nvidia-smi');
  if (smi) {
    const r = await run(smi, ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { timeout: 8000 });
    list = r.stdout.split('\n').map((l) => l.split(',').map((x) => x.trim())).filter((x) => x[0])
      .map(([name, mb]) => ({ name, vramGB: Number(mb) ? Math.round((Number(mb) / 1024) * 10) / 10 : null, nvidia: true }));
  }
  if (!list.length) {
    const { gpu } = await import('./system.js');
    list = (await gpu()).map((name) => ({ name, vramGB: null, nvidia: /nvidia/i.test(name) }));
  }
  gpuCache = { at: Date.now(), list };
  return list;
}

/** Free GB on the filesystem that holds `dir` (or its nearest existing parent); null when unknown. */
function freeDiskGB(dir) {
  let d = dir;
  while (d && !fs.existsSync(d)) { const up = path.dirname(d); if (up === d) break; d = up; }
  try { const s = fs.statfsSync(d); return Math.round(((s.bavail * s.bsize) / GB) * 10) / 10; } catch { return null; }
}

let systemdCache = null;
async function systemdUsable() {
  if (process.env.RIGS_NO_SYSTEMD || process.platform !== 'linux' || !which('systemctl')) return false;
  // A daemon started from a bare shell or tmux lacks XDG_RUNTIME_DIR, and `systemctl --user` then cannot find the
  // user bus. Point it at the standard place (process-wide, so apps.js startApp's systemctl calls work too).
  const runtimeDir = `/run/user/${process.getuid?.()}`;
  if (!process.env.XDG_RUNTIME_DIR && fs.existsSync(runtimeDir)) process.env.XDG_RUNTIME_DIR = runtimeDir;
  if (systemdCache === null) systemdCache = (await run('systemctl', ['--user', 'show-environment'], { timeout: 8000 })).code === 0;
  return systemdCache;
}

const realDeps = {
  exec: execStream,
  which: (name) => which(name),
  fetch: (...a) => fetch(...a),
  startApp: (id, opts) => appsReg.startApp(id, opts),
  platform: () => platformName(),
  systemd: systemdUsable,
  gpus: detectGpus,
  freeGB: freeDiskGB,
  unitDir: () => process.env.RIGS_SYSTEMD_USER_DIR || path.join(HOME, '.config', 'systemd', 'user'),
};
const withDeps = (deps = {}) => ({ ...realDeps, ...deps });

async function machineFacts(d) {
  return { platform: d.platform(), gpus: await Promise.resolve(d.gpus()).catch(() => []), freeGB: d.freeGB(appsDir()), memGB: Math.round(os.totalmem() / GB) };
}

/**
 * Does this app fit the machine? Pure. `diskGB` overrides the disk need (a resumed install only needs what is
 * still missing). Unknown VRAM (no nvidia-smi) is a warning, not a blocker; a Mac's GPU shares system memory.
 */
export function fitFor(m, facts, { diskGB } = {}) {
  const reasons = [];
  const warnings = [];
  if (!m.platforms.includes(facts.platform)) reasons.push(`runs on ${m.platforms.join(', ')} only (this machine is ${facts.platform})`);
  const gpus = facts.gpus || [];
  if (m.needs.gpu === 'nvidia' && !gpus.some((g) => g.nvidia)) reasons.push('needs an NVIDIA GPU (CUDA)');
  else if (m.needs.gpu === true && !gpus.length) reasons.push('needs a GPU');
  if (m.needs.vramGB > 0) {
    const known = gpus.filter((g) => g.vramGB);
    const best = facts.platform === 'mac' ? facts.memGB : known.length ? Math.max(...known.map((g) => g.vramGB)) : null;
    if (!best) warnings.push(`needs ${m.needs.vramGB} GB VRAM (could not read this machine's VRAM)`);
    else if (best < m.needs.vramGB) reasons.push(`needs ${m.needs.vramGB} GB VRAM (${facts.platform === 'mac' ? 'this Mac has' : 'the largest GPU here has'} ${best} GB)`);
  }
  const need = Math.round((diskGB ?? m.needs.diskGB + downloadGB(m)) * 10) / 10;
  if (typeof facts.freeGB === 'number' && need > facts.freeGB) reasons.push(`needs ${need} GB of disk (${facts.freeGB} GB free)`);
  return { ok: !reasons.length, reasons, warnings };
}

// ---------------------------------------------------------------- helpers

const keyOf = (v) => crypto.createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 16);
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fmtGB = (bytes) => `${(bytes / GB).toFixed(bytes < GB ? 2 : 1)} GB`;
const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const normId = (id) => String(id || '').trim().toLowerCase();
const lastLines = (s, n = 4) => redact(String(s || '').trim().split('\n').slice(-n).map((l) => l.trim()).filter(Boolean).join(' | '));

/** Path flavour for a Node platform name, so Windows paths can be built (and tested) anywhere. */
const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);
/** The venv's Python: venv\Scripts\python.exe on Windows, venv/bin/python elsewhere. */
export const venvPython = (venv, platform = process.platform) => (platform === 'win32' ? pathFor(platform).join(venv, 'Scripts', 'python.exe') : pathFor(platform).join(venv, 'bin', 'python'));
/** The venv's script folder (put first on PATH for post-install steps). */
export const venvBin = (venv, platform = process.platform) => pathFor(platform).join(venv, platform === 'win32' ? 'Scripts' : 'bin');
const hfHome = () => path.resolve(expandHome(process.env.HF_HOME || path.join(HOME, '.cache', 'huggingface')));
function hfRepoCacheDir(x) {
  const hub = process.env.HF_HUB_CACHE ? path.resolve(expandHome(process.env.HF_HUB_CACHE)) : path.join(hfHome(), 'hub');
  return path.join(hub, `${x.repoType}s--${x.repo.replace('/', '--')}`);
}
function hfToken() {
  return process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || readText(path.join(hfHome(), 'token'))?.trim() || '';
}

/** Hide tokens, passwords and URL credentials before a line reaches a log, the UI or an agent. */
export function redact(s) {
  return String(s ?? '')
    .replace(/hf_[A-Za-z0-9]{8,}/g, 'hf_***')
    .replace(/(bearer\s+)[^\s"']+/gi, '$1***')
    .replace(/((?:--token|--password)[= ]|(?:token|password|secret)=)[^\s&"']+/gi, '$1***')
    .replace(/(\/\/[^/\s:@]+:)[^@\s/]+@/g, '$1***@');
}

function dirSize(p) {
  let total = 0;
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) { try { total += fs.statSync(f).size; } catch {} }
    }
  };
  try { const st = fs.statSync(p); if (st.isFile()) return st.size; } catch { return 0; }
  walk(p);
  return total;
}

/** Content hash of a folder (relative paths + bytes), skipping __pycache__ and node_modules. '' if missing. */
function treeHash(dir) {
  const h = crypto.createHash('sha256');
  const walk = (d, rel) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === '__pycache__' || e.name === 'node_modules') continue;
      const f = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(f, r);
      else if (e.isFile()) { h.update(`${r}\0`); try { h.update(fs.readFileSync(f)); } catch {} h.update('\0'); }
    }
  };
  if (!exists(dir)) return '';
  walk(dir, '');
  return h.digest('hex').slice(0, 16);
}

/** A Hugging Face --local-dir download left half-finished files behind. */
function hasIncomplete(dir) {
  let found = false;
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) { if (found) return; if (e.isDirectory()) walk(path.join(d, e.name)); else if (e.name.endsWith('.incomplete')) found = true; }
  };
  walk(path.join(dir, '.cache', 'huggingface'));
  return found;
}

/**
 * Move a file or folder into ~/.rigs/trash (never delete). When the trash is on another disk the folder goes to
 * <appsDir>/.trash instead, rather than copying an app with its models (tens of GB) across disks; only when that
 * is a different disk again is the item copied into the trash and removed from its old place.
 */
async function moveToTrash(src, name) {
  const dir = path.join(RIGS_HOME, 'trash');
  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, trashName(name));
  try { await renameRetry(src, dest); return dest; } catch (e) { if (e.code !== 'EXDEV') throw e; }
  const near = path.join(appsDir(), '.trash');
  await fsp.mkdir(near, { recursive: true });
  const alt = path.join(near, trashName(name));
  try { await renameRetry(src, alt); return alt; } catch (e) { if (e.code !== 'EXDEV') throw e; }
  // A third disk (e.g. the systemd unit dir on /home while RIGS_HOME and the apps are elsewhere): copy, verify, remove.
  await fsp.cp(src, dest, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
  await fsp.rm(src, { recursive: true, force: true });
  return dest;
}

/** "<ms>-<name>" with characters Windows forbids in file names (: * ? " < > |, e.g. from a unit name) replaced. Pure. */
export const trashName = (name, now = Date.now()) => `${now}-${String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}`;

/** fs.rename that rides out Windows' brief EPERM/EBUSY locks (an app just stopped, a virus scanner) for ~3 s. */
async function renameRetry(src, dest, tries = isWin ? 15 : 1) {
  for (let i = 1; ; i++) {
    try { return await fsp.rename(src, dest); } catch (e) {
      if (i >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * Run a command and stream its output line by line (\r-separated progress bars too). Never throws; resolves
 * { code, stdout, stderr } with the last 64 KB of each. code -2 = timed out, -3 = cancelled through `signal`.
 */
export function execStream(cmd, args = [], { cwd, env, onLine, signal, timeout = 0 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnCmd(cmd, args, { cwd, env: { ...process.env, PATH: augmentedPath(), ...(env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { resolve({ code: -1, stdout: '', stderr: String(e.message || e) }); return; }
    const out = { stdout: '', stderr: '' };
    const partial = { stdout: '', stderr: '' };
    const feed = (k) => (data) => {
      const s = data.toString();
      out[k] = (out[k] + s).slice(-65536);
      const parts = (partial[k] + s).split(/\r\n|\n|\r/);
      partial[k] = parts.pop();
      for (const line of parts) if (line.trim()) onLine?.(line, k);
    };
    child.stdout.on('data', feed('stdout'));
    child.stderr.on('data', feed('stderr'));
    let done = false;
    const kill = () => {
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000).unref();
    };
    const onAbort = () => { kill(); finish(-3, '\n[cancelled]'); };
    const timer = timeout ? setTimeout(() => { kill(); finish(-2, '\n[timed out]'); }, timeout) : null;
    function finish(code, extra = '') {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      for (const k of ['stdout', 'stderr']) if (partial[k].trim()) onLine?.(partial[k], k);
      resolve({ code, stdout: out.stdout, stderr: out.stderr + extra });
    }
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => finish(-1, String(e.message || e)));
    child.on('close', (code) => finish(code ?? -1));
  });
}

/**
 * Download `url` to `dest`, resuming a previous partial download (<dest>.part, HTTP Range). An existing `dest`
 * is kept as is. `onBytes(n)` reports bytes on disk. Throws on HTTP errors and sha256 mismatches (the bad file is
 * renamed aside, not deleted).
 */
export async function downloadFile(url, dest, { fetchImpl = fetch, onBytes = () => {}, signal, sha256 = '', headers = {} } = {}) {
  if (exists(dest)) { const size = fs.statSync(dest).size; onBytes(size); return { skipped: true, resumed: false, bytes: size }; }
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let start = exists(part) ? fs.statSync(part).size : 0;
  const res = await fetchImpl(url, { headers: { ...headers, ...(start ? { range: `bytes=${start}-` } : {}) }, redirect: 'follow', signal });
  const resumed = res.status === 206 && start > 0;
  if (res.status === 416 && start) {
    res.body?.cancel?.().catch?.(() => {}); // the .part is already complete
  } else {
    if (res.status === 200) start = 0; // the server ignored the range: start over
    else if (!resumed) {
      res.body?.cancel?.().catch?.(() => {});
      throw new Error(`HTTP ${res.status} for ${redact(url)}`);
    }
    let bytes = start;
    onBytes(bytes);
    const count = new Transform({ transform(chunk, _enc, cb) { bytes += chunk.length; onBytes(bytes); cb(null, chunk); } });
    await pipeline(Readable.fromWeb(res.body), count, fs.createWriteStream(part, { flags: start ? 'a' : 'w' }), { signal });
  }
  if (sha256) {
    const h = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(part), h);
    const got = h.digest('hex');
    if (got !== sha256) {
      await fsp.rename(part, `${part}.bad-${Date.now()}`);
      throw new Error(`sha256 mismatch for ${path.basename(dest)} (got ${got.slice(0, 12)}…, want ${sha256.slice(0, 12)}…)`);
    }
  }
  await fsp.rename(part, dest);
  return { skipped: false, resumed, bytes: fs.statSync(dest).size };
}

// ---------------------------------------------------------------- install state

const rootOf = (id) => path.join(appsDir(), id);
const stateFile = (id) => path.join(rootOf(id), 'install.json');
export function readState(id) {
  try { return JSON.parse(fs.readFileSync(stateFile(normId(id)), 'utf8')); } catch { return null; }
}
function writeState(state) {
  state.updatedAt = Date.now();
  writeFileAtomic(stateFile(state.id), JSON.stringify(state, null, 2));
}

function registryEntry(id) {
  return (appsReg.declaredApps() || []).find((a) => normId(a.id) === id) || null;
}

function logTail(id, n = 30) {
  const text = readText(path.join(rootOf(id), 'install.log'));
  return text ? text.trimEnd().split('\n').slice(-n) : [];
}

/** Paths and names of one install of `m` (choices stored by the last run win over the manifest's defaults). */
function instanceFor(m, opts = {}, prev = null) {
  const root = rootOf(m.id);
  const suffix = opts.suffix ?? prev?.suffix ?? '';
  const port = opts.port ?? prev?.portOverride ?? m.port; // a port chosen at install time sticks; else the manifest's
  const inPlace = m.source.type === 'rigs' && !m.source.copy;
  const appDir = inPlace ? path.join(APP_DIR, m.source.path) : path.join(root, 'app', m.source.subdir || '');
  const unitBase = m.launch.systemd?.unit || `rigs-app-${m.id}`;
  return { root, appDir, inPlace, venv: path.join(root, 'venv'), port, suffix, unit: `${unitBase}${suffix}.service`, overseerId: `${m.id}${suffix}` };
}

/** The system Python. On Windows `python3` is often the Microsoft Store stub, so python / py come first there. */
export function systemPython(find, fallback = isWin ? 'python' : 'python3', win = isWin) {
  return (win ? find('python') || find('py') : find('python3') || find('python')) || fallback;
}

function placeholderVars(m, inst) {
  const python = m.runtime.type === 'python' ? venvPython(inst.venv) : systemPython(which);
  return {
    id: m.id, root: inst.root, appDir: inst.appDir, venv: inst.venv, python, node: process.execPath, port: String(inst.port),
    home: HOME, rigsApp: APP_DIR, modelsDir: path.join(inst.root, 'models'), hfHome: hfHome(),
  };
}
const render = (s, vars) => String(s).replace(/\{([A-Za-z]+)\}/g, (all, k) => (k in vars ? vars[k] : all));

function resolveDest(ctx, dest) {
  const p = expandHome(render(dest, ctx.vars));
  return path.isAbsolute(p) ? path.normalize(p) : path.join(ctx.inst.appDir, p);
}

/** Is this model's data already on disk? Exact files are checked; whole-repo downloads also need the recorded state. */
function modelPresent(ctx, x) {
  const recorded = ctx.state.models?.[x.name]?.key === keyOf(x);
  if (x.kind === 'url') return exists(resolveDest(ctx, x.dest));
  const exact = x.files.length > 0 && !x.include.length;
  if (x.dest) {
    const dest = resolveDest(ctx, x.dest);
    if (exact) return x.files.every((f) => exists(path.join(dest, f))) && !hasIncomplete(dest);
    return recorded && exists(dest) && fs.readdirSync(dest).length > 0 && !hasIncomplete(dest);
  }
  const snaps = path.join(hfRepoCacheDir(x), 'snapshots');
  let revs = [];
  try { revs = fs.readdirSync(snaps); } catch { return false; }
  if (exact) return revs.some((rev) => x.files.every((f) => exists(path.join(snaps, rev, f))));
  return recorded && revs.length > 0;
}

// ---------------------------------------------------------------- launch recipe

const sdQuote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
const shQuote = (s, platform = process.platform) => (platform === 'win32' ? `"${s}"` : `'${String(s).replace(/'/g, `'\\''`)}'`);

/**
 * The App Cloud recipe that runs a launcher script: { command } through the shell on macOS/Linux, and
 * { windows: { command } } on Windows, a "node.exe" "launch.mjs" line that apps.js runs without any shell. Pure.
 */
export function launcherRecipe({ node, file, platform = process.platform }) {
  const command = `${shQuote(node, platform)} ${shQuote(file, platform)}`;
  return platform === 'win32' ? { windows: { command } } : { command };
}

/** A rendered argv[0] like "{appDir}/run.cmd" → a native absolute path (C:\…\app\run.cmd on Windows). Pure. */
export const nativeExe = (s, platform = process.platform) => (pathFor(platform).isAbsolute(s) ? pathFor(platform).normalize(s) : s);

/**
 * A rendered argument such as "{rigsApp}/appstore/x.txt" → native separators when it is an absolute Windows path
 * (C:\…/x → C:\…\x, or \\server\…); anything else (flags, URLs, POSIX paths) unchanged. Pure.
 */
export const nativeArg = (s, platform = process.platform) => (platform === 'win32' && /^(?:[A-Za-z]:[\\/]|\\\\)/.test(s) ? path.win32.normalize(s) : s);

/** The postInstall steps that run on `platform` (linux | mac | windows): those without `platforms`, or listing it. Pure. */
export const postStepsFor = (m, platform) => m.postInstall.filter((p) => !p.platforms.length || p.platforms.includes(platform));

/** A step that needs a POSIX shell (bash/sh/zsh, or a .sh script), which a Windows machine does not have. Pure. */
export const needsPosixShell = (argv) => /^(ba|z)?sh(\.exe)?$/i.test(path.posix.basename(String(argv[0] || '').replace(/\\/g, '/'))) || /\.sh$/i.test(String(argv[0] || ''));

/** The systemd --user unit for an app. Pure. */
export function renderUnit({ m, argv, cwd, env }) {
  const sd = m.launch.systemd || { after: [], wants: [], service: {} };
  const service = { Restart: 'on-failure', RestartSec: '5', ...sd.service };
  return [
    `# ${MARKER} (app ${m.id}). Reinstalling the app rewrites this file; uninstalling moves it to the trash.`,
    '[Unit]',
    `Description=${m.name.replace(/[\r\n%]/g, ' ')} (RIGS App Store)`,
    `After=${['network-online.target', ...sd.after].join(' ')}`,
    ...(sd.wants.length ? [`Wants=${sd.wants.join(' ')}`] : []),
    '',
    '[Service]',
    `WorkingDirectory=${cwd.replace(/%/g, '%%')}`,
    `ExecStart=${argv.map(sdQuote).join(' ')}`,
    ...Object.entries(env).map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`),
    ...Object.entries(service).map(([k, v]) => `${k}=${v}`),
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** The cross-OS launcher (a small Node script) used where there is no user systemd. Pure. */
export function renderLauncher({ m, argv, cwd, env, pidFile }) {
  const spec = JSON.stringify({ id: m.id, argv, cwd, env, pidFile }, null, 2);
  return `// ${MARKER} (app ${m.id}). Reinstalling the app rewrites this file.
// RIGS runs it (apps.js startApp) when the app is opened while down. It starts the app and records the pids,
// so uninstalling can stop it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const spec = ${spec};
const shell = process.platform === 'win32' && /\\.(cmd|bat)$/i.test(spec.argv[0]);
const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: 'inherit', windowsHide: true, shell });
try { fs.writeFileSync(spec.pidFile, JSON.stringify({ launcher: process.pid, child: child.pid, argv0: spec.argv[0], at: Date.now() })); } catch {}
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { try { child.kill(sig); } catch {} });
child.on('error', (e) => { console.error(String(e.message || e)); process.exit(1); });
child.on('exit', (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
`;
}

async function launchPlan(ctx) {
  const { m, inst, vars, d } = ctx;
  const argv = m.launch.command.map((a, i) => (i ? nativeArg(render(a, vars)) : nativeExe(render(a, vars))));
  const cwd = m.launch.cwd ? path.resolve(inst.appDir, render(m.launch.cwd, vars)) : inst.appDir;
  const env = { ...(m.runtime.type === 'python' ? { PYTHONUNBUFFERED: '1' } : {}), ...Object.fromEntries(Object.entries(m.env).map(([k, v]) => [k, render(v, vars)])) };
  if (await d.systemd()) {
    const text = renderUnit({ m, argv, cwd, env });
    return { kind: 'systemd', unit: inst.unit, file: path.join(d.unitDir(), inst.unit), text, key: keyOf(text), recipe: { systemd: inst.unit } };
  }
  const file = path.join(inst.root, 'launch.mjs');
  const text = renderLauncher({ m, argv, cwd, env, pidFile: path.join(inst.root, 'app.pid') });
  const platform = d.platform() === 'windows' ? 'win32' : process.platform;
  return { kind: 'command', file, text, key: keyOf(text), recipe: launcherRecipe({ node: process.execPath, file, platform }) };
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Stop an app started through its launcher (pids recorded in <root>/app.pid). Returns the pids signalled. */
async function stopLaunched(root) {
  let rec;
  try { rec = JSON.parse(fs.readFileSync(path.join(root, 'app.pid'), 'utf8')); } catch { return []; }
  const owns = (pid, needle) => {
    if (process.platform !== 'linux') return true;
    const cmd = readText(`/proc/${pid}/cmdline`);
    return cmd !== null && cmd.includes(needle);
  };
  const targets = [[rec.child, path.basename(String(rec.argv0 || ''))], [rec.launcher, 'launch.mjs']]
    .filter(([pid, needle]) => Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidAlive(pid) && owns(pid, needle)).map(([pid]) => pid);
  if (isWin) {
    // No signals on Windows: end each process with its tree (a .cmd shim's cmd.exe and the app under it).
    for (const pid of targets) await run('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 15000 });
  } else for (const pid of targets) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  for (let i = 0; i < 30 && targets.some(pidAlive); i++) await new Promise((r) => setTimeout(r, 100));
  for (const pid of targets) if (pidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  return targets;
}

// ---------------------------------------------------------------- GPU Overseer

function overseerFile() {
  return path.resolve(expandHome(process.env.RIGS_GPU_OVERSEER_CLIENTS || config().appstore?.gpuOverseerClients || '~/apps/gpu-overseer/clients.json'));
}

function overseerEntry(ctx) {
  const { m, inst, vars } = ctx;
  const g = m.gpuOverseer;
  const match = g.match ? render(g.match, vars) : (m.runtime.type === 'python' ? inst.venv : inst.appDir) + path.sep;
  return {
    id: inst.overseerId, name: m.name, match,
    unload: { url: render(g.unload.url, vars), body: g.unload.body },
    ...(g.busy ? { busy: { url: render(g.busy.url, vars), method: g.busy.method } } : {}),
    managedBy: OVERSEER_TAG,
  };
}

/** Add or refresh this app's client in the GPU Overseer's clients.json. Entries the store did not add are left alone. */
function overseerUpsert(ctx) {
  const { m, opts, dryRun } = ctx;
  if (!m.gpuOverseer || opts.gpuOverseer === false) return { changed: false, note: '' };
  const file = overseerFile();
  if (!exists(file)) { ctx.log(`GPU Overseer not found (${file}) — no client entry added`); return { changed: false, note: '' }; }
  let list;
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { ctx.log(`GPU Overseer clients.json is unreadable (${e.message}) — left as is`); return { changed: false, note: '' }; }
  if (!Array.isArray(list)) { ctx.log('GPU Overseer clients.json is not a list — left as is'); return { changed: false, note: '' }; }
  const entry = overseerEntry(ctx);
  const i = list.findIndex((c) => c && c.id === entry.id);
  if (i >= 0 && list[i].managedBy !== OVERSEER_TAG) {
    ctx.log(`GPU Overseer already has a client "${entry.id}" that the App Store did not add — left as is`);
    return { changed: false, note: '' };
  }
  if (i >= 0 && sameJson(list[i], entry)) { ctx.state.overseer = { file, id: entry.id }; return { changed: false, note: ' · GPU Overseer client' }; }
  if (dryRun) return { changed: true, note: ' · would add a GPU Overseer client' };
  if (i >= 0) list[i] = entry; else list.push(entry);
  writeFileAtomic(file, JSON.stringify(list, null, 2) + '\n');
  ctx.state.overseer = { file, id: entry.id };
  return { changed: true, note: ' · GPU Overseer client' };
}

function overseerRemove(rec) {
  if (!rec?.file || !exists(rec.file)) return false;
  let list;
  try { list = JSON.parse(fs.readFileSync(rec.file, 'utf8')); } catch { return false; }
  if (!Array.isArray(list)) return false;
  const next = list.filter((c) => !(c && c.id === rec.id && c.managedBy === OVERSEER_TAG));
  if (next.length === list.length) return false;
  writeFileAtomic(rec.file, JSON.stringify(next, null, 2) + '\n');
  return true;
}

// ---------------------------------------------------------------- python helpers

/** The interpreters to try for Python `ver` on `platform` (linux | mac | windows), in order: [name, leading args]. Pure. */
export function pythonCandidates(ver, platform) {
  return platform === 'windows'
    ? [['py', ver ? [`-${ver}`] : ['-3']], ['python', []]]
    : [...(ver ? [[`python${ver}`, []]] : []), ['python3', []], ['python', []]];
}

async function findPython(ver, ctx) {
  const { d } = ctx;
  const candidates = pythonCandidates(ver, d.platform());
  for (const [name, pre] of candidates) {
    const exe = d.which(name);
    if (!exe) continue;
    const r = await d.exec(exe, [...pre, '-c', 'import sys;print("%d.%d"%sys.version_info[:2])'], { timeout: 15000 });
    const got = r.stdout.trim();
    if (r.code === 0 && (!ver || got === ver)) return { cmd: exe, pre, version: got };
  }
  return null;
}

/** The command that installs into the app's venv: uv when present, else the venv's own pip. */
function pipInstaller(ctx) {
  const uv = ctx.d.which('uv');
  const py = venvPython(ctx.inst.venv);
  return uv ? { uv: true, cmd: uv, args: ['pip', 'install', '--python', py] } : { uv: false, cmd: py, args: ['-m', 'pip', 'install'] };
}

function runEnv(ctx) {
  const { m, inst } = ctx;
  const env = Object.fromEntries(Object.entries(m.env).map(([k, v]) => [k, render(v, ctx.vars)]));
  if (m.runtime.type === 'python') Object.assign(env, { VIRTUAL_ENV: inst.venv, PATH: venvBin(inst.venv) + path.delimiter + augmentedPath(), PYTHONUNBUFFERED: '1' });
  return env;
}

// ---------------------------------------------------------------- steps

const isProgressBar = (l) => /\d+%\|/.test(l) || /^(Receiving|Resolving|Counting|Compressing|Unpacking|remote:)/.test(l.trim());
const done = (ctx, step, key) => !!ctx.state.steps?.[step] && ctx.state.steps[step].key === key;

const STEP_IMPL = {
  async check(ctx) {
    const { m, inst, d } = ctx;
    const facts = await machineFacts(d);
    const missingGB = m.models.filter((x) => !modelPresent(ctx, x)).reduce((a, x) => a + x.sizeGB, 0);
    const fetched = !!ctx.state.steps?.fetch && exists(inst.appDir);
    const fit = fitFor(m, facts, { diskGB: (fetched ? 0 : m.needs.diskGB) + missingGB });
    const problems = [...fit.reasons];
    fit.warnings.forEach((w) => ctx.log(`warning: ${w}`));
    if (m.source.type === 'git' && !d.which('git')) problems.push('git is not installed');
    if (m.source.type === 'rigs' && !exists(path.join(APP_DIR, m.source.path))) problems.push(`${m.source.path} is missing from this RIGS checkout (update RIGS)`);
    if (m.source.type === 'tarball' && !d.which('tar')) problems.push('tar is not installed');
    if (m.runtime.type === 'python' && !exists(venvPython(inst.venv)) && !d.which('uv') && !(await findPython(m.needs.python, ctx))) {
      problems.push(`needs Python ${m.needs.python || '3'}: install uv (https://docs.astral.sh/uv/) or python${m.needs.python || '3'}`);
    }
    for (const x of m.models) if (x.gated && !hfToken() && !modelPresent(ctx, x)) problems.push(`${x.name} is gated on Hugging Face: accept its license at https://huggingface.co/${x.repo} and run "hf auth login" on this machine`);
    if (facts.platform === 'windows') {
      for (const p of postStepsFor(m, facts.platform)) if (needsPosixShell(p.run)) problems.push(`post-install step "${p.name}" needs a POSIX shell, which Windows lacks: give it "platforms": ["linux", "mac"] and add a Windows step (e.g. {python} or {node})`);
    }
    const reg = registryEntry(m.id);
    if (reg && reg.installedBy !== STORE_TAG) problems.push(`"${m.id}" is already in the App Cloud, registered by hand (port ${reg.port ?? reg.url}) — remove that entry first`);
    const clash = (appsReg.declaredApps() || []).find((a) => normId(a.id) !== m.id && Number(a.port) === inst.port && (!a.host || /^(127\.0\.0\.1|localhost)$/.test(a.host)));
    if (clash) problems.push(`port ${inst.port} is already used by app "${clash.id}" — install with another port`);
    const plan = await launchPlan(ctx);
    const cur = readText(plan.file);
    if (plan.kind === 'systemd' && cur !== null && !cur.includes(MARKER)) problems.push(`${plan.unit} already exists in ${path.dirname(plan.file)} and was not written by the App Store`);
    if (problems.length) throw new Error(problems.join('; '));
    const gpu = facts.gpus.find((x) => x.vramGB) || facts.gpus[0];
    return { always: true, detail: [facts.platform, gpu ? `${gpu.name}${gpu.vramGB ? ` ${gpu.vramGB} GB` : ''}` : '', typeof facts.freeGB === 'number' ? `${facts.freeGB} GB free` : ''].filter(Boolean).join(' · ') };
  },

  async fetch(ctx) {
    const { m, inst, d } = ctx;
    const src = m.source;
    // A copied RIGS folder changes with RIGS updates: its content is part of the key, so the copy is refreshed.
    const tree = src.type === 'rigs' && src.copy ? treeHash(path.join(APP_DIR, src.path)) : '';
    const key = keyOf(tree ? { ...src, tree } : src);
    if (src.type === 'rigs' && !src.copy) {
      if (!exists(inst.appDir)) throw new Error(`${src.path} is missing from this RIGS checkout`);
      ctx.ensureRoot();
      return { skipped: done(ctx, 'fetch', key), key, detail: `built into RIGS (${src.path}), runs in place` };
    }
    const appRoot = path.join(inst.root, 'app');
    if (done(ctx, 'fetch', key) && exists(inst.appDir)) return { skipped: true, key, detail: ctx.state.sourceRev ? `already fetched (${ctx.state.sourceRev.slice(0, 10)})` : 'already fetched' };
    if (ctx.dryRun) return { skipped: true, key, detail: `dry run: would fetch ${src.type === 'rigs' ? src.path : redact(src.url)}${src.ref ? `@${src.ref}` : ''} into ${appRoot}` };
    ctx.ensureRoot();
    const tmp = path.join(inst.root, '.fetch-tmp');
    fs.rmSync(tmp, { recursive: true, force: true }); // only ever our own half-finished fetch
    const trashOld = async () => { if (exists(appRoot)) ctx.log(`moved the previous source to ${await moveToTrash(appRoot, `appstore-${m.id}-app`)}`); };

    if (src.type === 'git') {
      const git = d.which('git') || 'git';
      const ref = src.ref || 'HEAD';
      const progress = (l) => { const p = /Receiving objects:\s+(\d+)%/.exec(l); if (p) ctx.progress(Number(p[1])); };
      let updated = false;
      if (exists(path.join(appRoot, '.git'))) {
        const cur = await d.exec(git, ['-C', appRoot, 'remote', 'get-url', 'origin'], { timeout: 15000 });
        if (cur.code === 0 && cur.stdout.trim() === src.url) {
          await ctx.sh(git, ['-C', appRoot, 'fetch', '--depth', '1', '--progress', 'origin', ref], { onLine: progress });
          const co = await ctx.sh(git, ['-C', appRoot, 'checkout', '-q', 'FETCH_HEAD'], { allowFail: true });
          if (co.code !== 0) throw new Error(`local changes in ${appRoot} block the update — commit or move them, then install again`);
          updated = true;
        }
      }
      if (!updated) {
        await trashOld();
        await ctx.sh(git, ['init', '-q', tmp]);
        await ctx.sh(git, ['-C', tmp, 'remote', 'add', 'origin', src.url]);
        await ctx.sh(git, ['-C', tmp, 'fetch', '--depth', '1', '--progress', 'origin', ref], { onLine: progress });
        await ctx.sh(git, ['-C', tmp, 'checkout', '-q', 'FETCH_HEAD']);
        if (exists(path.join(tmp, '.gitmodules'))) await ctx.sh(git, ['-C', tmp, 'submodule', 'update', '--init', '--recursive', '--depth', '1']);
        fs.renameSync(tmp, appRoot);
      }
      const rev = await d.exec(git, ['-C', appRoot, 'rev-parse', 'HEAD'], { timeout: 15000 });
      ctx.state.sourceRev = rev.code === 0 ? rev.stdout.trim() : '';
    } else if (src.type === 'rigs') {
      await fsp.cp(path.join(APP_DIR, src.path), tmp, { recursive: true });
      await trashOld();
      fs.renameSync(tmp, appRoot);
      ctx.state.sourceRev = tree;
    } else {
      const ext = /\.zip($|\?)/i.test(src.url) ? '.zip' : /\.(tar\.xz|txz)($|\?)/i.test(src.url) ? '.tar.xz' : '.tar.gz';
      const archive = path.join(inst.root, 'downloads', `source-${keyOf(src.url)}${ext}`);
      await downloadFile(src.url, archive, { fetchImpl: d.fetch, signal: ctx.signal, sha256: src.sha256, onBytes: (b) => ctx.detailThrottled(`${fmtGB(b)} downloaded`) });
      fs.mkdirSync(tmp, { recursive: true });
      if (ext === '.zip' && !isWin && d.which('unzip')) await ctx.sh(d.which('unzip'), ['-q', archive, '-d', tmp]);
      else await ctx.sh(d.which('tar') || 'tar', ['-xf', archive, '-C', tmp]);
      const ents = fs.readdirSync(tmp);
      const top = ents.length === 1 && fs.statSync(path.join(tmp, ents[0])).isDirectory() ? path.join(tmp, ents[0]) : tmp;
      await trashOld();
      fs.renameSync(top, appRoot);
      fs.rmSync(tmp, { recursive: true, force: true });
      ctx.state.sourceRev = src.sha256 || '';
    }
    if (!exists(inst.appDir)) throw new Error(`the source has no ${src.subdir || 'files'}`);
    return { key, detail: ctx.state.sourceRev ? `at ${ctx.state.sourceRev.slice(0, 10)}` : 'fetched' };
  },

  async venv(ctx) {
    const { m, inst, d } = ctx;
    if (m.runtime.type !== 'python') return { skipped: true, key: 'none', detail: 'no Python environment needed' };
    const key = keyOf({ python: m.needs.python });
    const py = venvPython(inst.venv);
    if (done(ctx, 'venv', key) && exists(py)) return { skipped: true, key, detail: `already created${ctx.state.python ? ` (${ctx.state.python})` : ''}` };
    if (ctx.dryRun) return { skipped: true, key, detail: `dry run: would create a Python ${m.needs.python || '3'} venv in ${inst.venv}${d.which('uv') ? ' with uv' : ''}` };
    ctx.ensureRoot();
    if (exists(inst.venv)) ctx.log(`moved the previous environment to ${await moveToTrash(inst.venv, `appstore-${m.id}-venv`)}`);
    const uv = d.which('uv');
    if (uv) await ctx.sh(uv, ['venv', '--seed', ...(m.needs.python ? ['--python', m.needs.python] : []), inst.venv]);
    else {
      const p = await findPython(m.needs.python, ctx);
      if (!p) throw new Error(`Python ${m.needs.python || '3'} not found: install uv (https://docs.astral.sh/uv/) or python${m.needs.python || '3'}`);
      await ctx.sh(p.cmd, [...p.pre, '-m', 'venv', inst.venv]);
      await ctx.sh(py, ['-m', 'pip', 'install', '-q', '--upgrade', 'pip'], { allowFail: true });
    }
    if (!exists(py)) throw new Error(`the environment was created but ${py} is missing`);
    const v = await d.exec(py, ['-c', 'import sys;print("%d.%d.%d"%sys.version_info[:3])'], { timeout: 15000 });
    ctx.state.python = v.code === 0 && v.stdout.trim() ? `Python ${v.stdout.trim()}` : '';
    return { key, detail: ctx.state.python || 'created' };
  },

  async deps(ctx) {
    const { m, inst, d } = ctx;
    const rt = m.runtime;
    if (rt.type === 'python') {
      const reqs = rt.requirements.map((r) => path.join(inst.appDir, r));
      const what = [...rt.requirements, ...(rt.torch?.packages || []), ...rt.packages].join(', ') || 'the project';
      if (ctx.dryRun && !exists(inst.appDir)) return { skipped: true, detail: `dry run: would install ${what}${rt.torch ? ` (torch index ${rt.torch.index})` : ''}` };
      for (const [i, r] of reqs.entries()) if (!exists(r)) throw new Error(`${rt.requirements[i]} is not in the app source`);
      const pipArgs = rt.pipArgs.map((a) => nativeArg(render(a, ctx.vars)));
      // A file named in pipArgs (e.g. --constraint {rigsApp}/…/constraints.txt) counts like a requirements file.
      const argFiles = pipArgs.filter((a) => path.isAbsolute(a) && exists(a)).map(readText);
      const key = keyOf({ rt, reqs: reqs.map(readText), argFiles, venv: ctx.state.steps?.venv?.at || 0, rev: ctx.state.sourceRev || '' });
      if (done(ctx, 'deps', key) && exists(venvPython(inst.venv))) return { skipped: true, key, detail: 'already installed' };
      const items = [...(rt.torch?.packages || []), ...reqs.flatMap((r) => ['-r', r]), ...rt.packages];
      if (rt.project || rt.extras.length) items.push(rt.extras.length ? `${inst.appDir}[${rt.extras.join(',')}]` : inst.appDir);
      if (!items.length) return { key, detail: 'no Python packages listed' };
      if (ctx.dryRun) return { skipped: true, key, detail: `dry run: would install ${what}` };
      const pip = pipInstaller(ctx);
      const args = [...pip.args, ...items];
      if (rt.torch) { args.push('--extra-index-url', rt.torch.index); if (pip.uv) args.push('--index-strategy', 'unsafe-best-match'); }
      args.push(...pipArgs);
      await ctx.sh(pip.cmd, args, { cwd: inst.appDir, env: { PIP_DISABLE_PIP_VERSION_CHECK: '1', VIRTUAL_ENV: inst.venv }, timeout: 2 * 60 * 60 * 1000 });
      return { key, detail: `${what} installed${pip.uv ? ' (uv)' : ''}` };
    }
    if (rt.type === 'node') {
      const pkg = path.join(inst.appDir, 'package.json');
      if (rt.npm === false || !exists(pkg)) return { skipped: true, key: 'none', detail: 'no package.json — nothing to install' };
      const lock = path.join(inst.appDir, 'package-lock.json');
      const key = keyOf({ pkg: readText(pkg), lock: readText(lock) });
      if (done(ctx, 'deps', key) && exists(path.join(inst.appDir, 'node_modules'))) return { skipped: true, key, detail: 'already installed' };
      const mode = rt.npm === 'auto' ? (exists(lock) ? 'ci' : 'install') : rt.npm;
      if (ctx.dryRun) return { skipped: true, key, detail: `dry run: would run npm ${mode}` };
      const npm = d.which('npm');
      if (!npm) throw new Error('npm is not installed');
      await ctx.sh(npm, [mode, '--omit=dev', '--no-audit', '--no-fund'], { cwd: inst.appDir, timeout: 30 * 60 * 1000 });
      return { key, detail: `npm ${mode}` };
    }
    return { skipped: true, key: 'none', detail: 'no dependencies' };
  },

  async models(ctx) {
    const { m } = ctx;
    if (!m.models.length) return { skipped: true, key: 'none', detail: 'no models' };
    const key = keyOf(m.models);
    const total = Math.max(1, m.models.reduce((a, x) => a + x.sizeGB * GB, 0));
    let doneBytes = 0;
    const todo = [];
    for (const x of m.models) {
      if (modelPresent(ctx, x)) { doneBytes += x.sizeGB * GB; ctx.log(`${x.name}: already on disk`); } else todo.push(x);
    }
    if (!todo.length) return { skipped: true, key, detail: `${m.models.length} model(s) already on disk` };
    const todoGB = Math.round(todo.reduce((a, x) => a + x.sizeGB, 0) * 10) / 10;
    if (ctx.dryRun) return { skipped: true, key, detail: `dry run: would download ${todo.length} model(s), ${todoGB} GB: ${todo.map((x) => x.name).join(', ')}` };
    ctx.ensureRoot();
    ctx.state.models = ctx.state.models || {};
    for (const x of todo) {
      const size = x.sizeGB * GB;
      const base = doneBytes;
      const onBytes = (b) => ctx.progress(Math.min(99, ((base + Math.min(b, size)) / total) * 100), `${x.name}: ${fmtGB(Math.min(b, size))} of ${x.sizeGB} GB`);
      ctx.log(`${x.name}: downloading ${x.sizeGB} GB${x.kind === 'hf' ? ` from ${x.repo}` : ''}`);
      if (x.kind === 'url') await downloadUrlModel(ctx, x, onBytes);
      else await downloadHfModel(ctx, x, onBytes);
      doneBytes += size;
      ctx.state.models[x.name] = { key: keyOf(x), at: Date.now() };
      ctx.saveState();
    }
    return { key, detail: `${m.models.length} model(s), ${downloadGB(m)} GB` };
  },

  async post(ctx) {
    const { m, inst } = ctx;
    const steps = postStepsFor(m, ctx.d.platform());
    if (!steps.length) return { skipped: true, key: 'none', detail: 'none' };
    // The version is in the key so a new release reruns steps that copy files from outside the source.
    // Steps without platforms keep their pre-`platforms` shape, so existing installs keep their key.
    const key = keyOf({ post: steps.map(({ platforms, ...p }) => (platforms.length ? { ...p, platforms } : p)), rev: ctx.state.sourceRev || '', deps: ctx.state.steps?.deps?.at || 0, port: inst.port, version: m.version });
    if (done(ctx, 'post', key)) return { skipped: true, key, detail: 'already done' };
    if (ctx.dryRun) return { skipped: true, key, detail: `dry run: would run ${steps.map((p) => p.name).join(', ')}` };
    for (const [i, p] of steps.entries()) {
      ctx.progress((i / steps.length) * 100, p.name);
      const argv = p.run.map((a, j) => (j ? nativeArg(render(a, ctx.vars)) : nativeExe(render(a, ctx.vars))));
      await ctx.sh(argv[0], argv.slice(1), { cwd: p.cwd ? path.resolve(inst.appDir, render(p.cwd, ctx.vars)) : inst.appDir, env: runEnv(ctx), timeout: p.timeoutSec * 1000 });
    }
    return { key, detail: steps.map((p) => p.name).join(', ') };
  },

  async launch(ctx) {
    const { inst } = ctx;
    const plan = await launchPlan(ctx);
    const prev = readText(plan.file);
    if (prev !== null && !prev.includes(MARKER)) throw new Error(`${plan.file} exists and was not written by the App Store — refusing to overwrite it`);
    const what = plan.kind === 'systemd' ? `systemd --user ${plan.unit}` : `launcher ${path.basename(plan.file)} (no user systemd here)`;
    if (prev === plan.text && done(ctx, 'launch', plan.key)) return { skipped: true, key: plan.key, detail: what };
    if (ctx.dryRun) return { skipped: true, key: plan.key, detail: `dry run: would write ${plan.file}${plan.kind === 'systemd' ? ' and enable it' : ''}` };
    ctx.ensureRoot();
    writeFileAtomic(plan.file, plan.text);
    ctx.state.launch = plan.recipe;
    if (plan.kind === 'systemd') {
      ctx.state.unit = plan.unit;
      await ctx.sh('systemctl', ['--user', 'daemon-reload']);
      await ctx.sh('systemctl', ['--user', 'enable', plan.unit]);
      if (prev !== null) await ctx.sh('systemctl', ['--user', 'try-restart', plan.unit], { allowFail: true });
      return { key: plan.key, detail: `${what} (enabled)` };
    }
    if (prev !== null) {
      const pids = await stopLaunched(inst.root);
      if (pids.length) ctx.log(`stopped the running instance (pid ${pids.join(', ')}) so the new launcher takes over`);
    }
    return { key: plan.key, detail: what };
  },

  async register(ctx) {
    const { m, inst } = ctx;
    const plan = await launchPlan(ctx);
    const entry = {
      id: m.id, name: m.name, icon: m.icon, port: inst.port, healthPath: m.healthPath, launch: plan.recipe,
      ...(Object.keys(m.rewrite).length ? { rewrite: m.rewrite } : {}), installedBy: STORE_TAG,
    };
    const { app, errors } = appsReg.validateApp(entry);
    if (!app) throw new Error(errors.join('; '));
    const cur = registryEntry(m.id);
    if (cur && cur.installedBy !== STORE_TAG) throw new Error(`"${m.id}" is already in the App Cloud, registered by hand — remove that entry first`);
    const ov = overseerUpsert(ctx);
    const key = keyOf(entry);
    const detail = `App Cloud app "${m.id}" on port ${inst.port}${ov.note}`;
    if (cur && sameJson(cur, entry)) return { skipped: !ov.changed, key, detail };
    if (ctx.dryRun) return { skipped: true, key, detail: `dry run: would register "${m.id}" on port ${inst.port}${ov.note}` };
    const cfg = config();
    cfg.apps = [...(appsReg.declaredApps() || []).filter((a) => normId(a.id) !== m.id), entry];
    saveConfig(cfg);
    appsReg.checkAll().catch(() => {});
    return { key, detail };
  },

  async health(ctx) {
    const { m, inst, d } = ctx;
    if (ctx.dryRun) return { skipped: true, always: true, detail: `dry run: would start it and wait for ${m.healthPath} on port ${inst.port}` };
    ctx.progress(null, `waiting for ${m.healthPath} on port ${inst.port} (up to ${m.healthTimeoutSec}s)`);
    try {
      const r = await d.startApp(m.id, { waitMs: m.healthTimeoutSec * 1000, pollMs: 1000 });
      return { always: true, detail: `${r.started ? 'started' : 'running'} — answering ${m.healthPath}` };
    } catch (e) {
      if (ctx.state.unit && (await d.systemd())) {
        const j = await d.exec('journalctl', ['--user', '-u', ctx.state.unit, '-n', '40', '--no-pager'], { timeout: 15000 });
        (j.stdout || '').trim().split('\n').filter(Boolean).forEach((l) => ctx.log(`journal: ${l}`));
      } else {
        const tail = readText(path.join(RIGS_HOME, 'logs', `app-${m.id}.log`));
        if (tail) tail.trimEnd().split('\n').slice(-40).forEach((l) => ctx.log(`app: ${l}`));
      }
      throw e;
    }
  },
};

async function downloadUrlModel(ctx, x, onBytes) {
  const dest = resolveDest(ctx, x.dest);
  const token = /(^|\.)huggingface\.co$/.test(new URL(x.url).hostname) ? hfToken() : '';
  const r = await downloadFile(x.url, dest, { fetchImpl: ctx.d.fetch, signal: ctx.signal, sha256: x.sha256, headers: token ? { authorization: `Bearer ${token}` } : {}, onBytes });
  ctx.log(`${x.name}: ${r.skipped ? 'already on disk' : `${r.resumed ? 'resumed and ' : ''}saved ${fmtGB(r.bytes)} to ${dest}`}`);
}

/**
 * Download an exact, revision-pinned file list straight from the Hub with our own Range-resumable downloader
 * (huggingface_hub >= 1 writes every attempt to a fresh process-unique .incomplete file, so its CLI restarts a
 * 20 GB file from byte 0 after an interruption). Into `dest` as plain files, or into the standard hub cache layout
 * (blobs/<etag> + snapshots/<commit>/<file> symlinks) so huggingface_hub finds them.
 */
async function downloadHfFiles(ctx, x, dest, onBytes) {
  const prefix = x.repoType === 'model' ? '' : `${x.repoType}s/`;
  const token = hfToken();
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const sizes = new Array(x.files.length).fill(0);
  const report = () => onBytes(sizes.reduce((a, b) => a + b, 0));
  for (const [i, file] of x.files.entries()) {
    const url = `https://huggingface.co/${prefix}${x.repo}/resolve/${x.revision}/${file.split('/').map(encodeURIComponent).join('/')}`;
    const onFile = (b) => { sizes[i] = b; report(); };
    if (dest) { await downloadFile(url, path.join(dest, file), { fetchImpl: ctx.d.fetch, signal: ctx.signal, headers, onBytes: onFile }); continue; }
    const head = await ctx.d.fetch(url, { method: 'HEAD', headers, redirect: 'manual', signal: ctx.signal });
    if (head.status >= 400) throw new Error(`HTTP ${head.status} for ${x.repo}/${file} — a gated or private repo needs an HF token (HF_TOKEN)`);
    const etag = (head.headers.get('x-linked-etag') || head.headers.get('etag') || '').replace(/^W\//, '').replace(/"/g, '');
    if (!/^[0-9a-f]{40,64}$/.test(etag)) throw new Error(`no usable etag for ${x.repo}/${file}`);
    const repoDir = hfRepoCacheDir(x);
    const blob = path.join(repoDir, 'blobs', etag);
    await downloadFile(url, blob, { fetchImpl: ctx.d.fetch, signal: ctx.signal, headers, sha256: etag.length === 64 ? etag : '', onBytes: onFile });
    const link = path.join(repoDir, 'snapshots', x.revision, file);
    await fsp.mkdir(path.dirname(link), { recursive: true });
    await fsp.rm(link, { force: true });
    await linkBlob(blob, link);
  }
}

/**
 * snapshots/<rev>/<file> → blobs/<etag>: a relative symlink, as huggingface_hub makes. Windows without Developer Mode
 * may not create symlinks (EPERM); then a hard link (same disk, no extra space), else a copy — which is what
 * huggingface_hub itself falls back to there.
 */
async function linkBlob(blob, link, fsx = fsp) {
  try { await fsx.symlink(path.relative(path.dirname(link), blob), link); return 'symlink'; } catch (e) { if (!['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(e.code)) throw e; }
  try { await fsx.link(blob, link); return 'hardlink'; } catch { /* another disk or no hard links */ }
  await fsx.copyFile(blob, link);
  return 'copy';
}
export { linkBlob as _linkBlob };

/** Every file of a repo at a pinned revision, from the Hub tree API (follows its Link: rel="next" pages). */
async function listHfFiles(ctx, x) {
  const token = hfToken();
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  let url = `https://huggingface.co/api/${x.repoType}s/${x.repo}/tree/${x.revision}?recursive=true`;
  const files = [];
  while (url) {
    const res = await ctx.d.fetch(url, { headers, signal: ctx.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} listing ${x.repo}@${x.revision.slice(0, 8)}${res.status === 401 || res.status === 403 ? ' — a gated or private repo needs an HF token (HF_TOKEN)' : ''}`);
    for (const e of await res.json()) if (e.type === 'file') files.push(e.path);
    url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') || '')?.[1] || '';
  }
  if (!files.length) throw new Error(`${x.repo}@${x.revision.slice(0, 8)} lists no files`);
  return files;
}

async function downloadHfModel(ctx, x, onBytes) {
  const { d, inst } = ctx;
  const dest = x.dest ? resolveDest(ctx, x.dest) : '';
  const watch = dest || hfRepoCacheDir(x);
  const timer = setInterval(() => onBytes(dirSize(watch)), 1000);
  try {
    if (!x.include.length && /^[0-9a-f]{40}$/.test(x.revision || '')) {
      await downloadHfFiles(ctx, { ...x, files: x.files.length ? x.files : await listHfFiles(ctx, x) }, dest, onBytes);
      onBytes(x.sizeGB * GB);
      return;
    }
    const bin = venvBin(inst.venv);
    const local = ['hf', 'huggingface-cli'].map((n) => path.join(bin, isWin ? `${n}.exe` : n)).find(exists);
    const cli = local || d.which('hf') || d.which('huggingface-cli');
    if (cli) {
      // Whole-repo or unpinned downloads: the hub CLI skips files it already has (it cannot resume a partial one).
      const args = ['download', x.repo, ...x.files, ...(x.revision ? ['--revision', x.revision] : []), ...(x.repoType !== 'model' ? ['--repo-type', x.repoType] : []), ...x.include.flatMap((g) => ['--include', g]), ...(dest ? ['--local-dir', dest] : [])];
      await ctx.sh(cli, args, { env: { HF_HUB_DISABLE_TELEMETRY: '1' }, timeout: 0 });
    } else {
      // No CLI: huggingface_hub's snapshot_download, from the app's venv (installed there when missing).
      const py = exists(venvPython(inst.venv)) ? venvPython(inst.venv) : systemPython(d.which, null);
      if (!py) throw new Error('downloading from Hugging Face needs the hf CLI: pip install -U huggingface_hub');
      const kw = { repo_id: x.repo, repo_type: x.repoType, ...(x.revision ? { revision: x.revision } : {}), ...(x.files.length || x.include.length ? { allow_patterns: [...x.files, ...x.include] } : {}), ...(dest ? { local_dir: dest } : {}) };
      const script = 'import json,sys\nfrom huggingface_hub import snapshot_download\nprint(snapshot_download(**json.loads(sys.argv[1])))';
      let r = await ctx.sh(py, ['-c', script, JSON.stringify(kw)], { allowFail: true, timeout: 0 });
      if (r.code !== 0 && /No module named .?huggingface_hub/.test(r.stderr + r.stdout) && exists(venvPython(inst.venv))) {
        const pip = pipInstaller(ctx);
        await ctx.sh(pip.cmd, [...pip.args, 'huggingface_hub']);
        r = await ctx.sh(py, ['-c', script, JSON.stringify(kw)], { allowFail: true, timeout: 0 });
      }
      if (r.code !== 0) throw new Error(`download of ${x.repo} failed: ${lastLines(r.stderr || r.stdout)}`);
    }
  } finally { clearInterval(timer); }
  if (x.files.length && !x.include.length && !modelPresent(ctx, x)) throw new Error(`${x.name}: the download finished but ${x.files.join(', ')} is missing`);
  onBytes(x.sizeGB * GB);
}

// ---------------------------------------------------------------- jobs

const jobs = new Map(); // app id → its latest install job since the daemon started (running or finished)
const bus = new EventEmitter();
bus.setMaxListeners(50);

/** Subscribe to job progress (throttled to ~3/s; step and state changes always go out). Returns unsubscribe. */
export function onJobEvent(fn) { bus.on('job', fn); return () => bus.off('job', fn); }

function overallPercent(job) {
  const total = STEPS.reduce((a, s) => a + s.weight, 0);
  let got = 0;
  for (const s of STEPS) {
    const js = job.steps.find((x) => x.id === s.id);
    if (js.status === 'done' || js.status === 'skipped') got += s.weight;
    else if (js.status === 'running' || js.status === 'failed') got += (s.weight * (js.percent || 0)) / 100;
  }
  return Math.round((got / total) * 100);
}

function snapshot(job, { log = 200 } = {}) {
  return {
    id: job.id, op: job.op, state: job.state, dryRun: !!job.opts.dryRun, until: job.opts.until || undefined, step: job.step,
    stepLabel: STEPS.find((s) => s.id === job.step)?.label || '', percent: overallPercent(job),
    error: job.error, startedAt: job.startedAt, endedAt: job.endedAt,
    steps: job.steps.map((s) => ({ id: s.id, label: s.label, status: s.status, percent: Math.round(s.percent || 0), detail: s.detail })),
    ...(log ? { log: job.lines.slice(-log) } : {}), lastLine: job.lines[job.lines.length - 1] || '',
  };
}

function emit(job, force = false) {
  clearTimeout(job.emitTimer);
  const now = Date.now();
  if (!force && now - job.lastEmit < 300) { job.emitTimer = setTimeout(() => emit(job, true), 300); job.emitTimer.unref?.(); return; }
  job.lastEmit = now;
  bus.emit('job', snapshot(job, { log: 0 }));
}

/** Validate the options of POST …/install. Throws 400 errors. */
export function installOptions(raw = {}) {
  const o = {};
  if (raw.port !== undefined && raw.port !== null && raw.port !== '') {
    const p = Number(raw.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw httpError(400, 'port must be an integer 1-65535');
    o.port = p;
  }
  if (raw.suffix !== undefined && raw.suffix !== null && raw.suffix !== '') {
    if (!/^[a-z0-9_-]{1,24}$/.test(String(raw.suffix))) throw httpError(400, 'suffix must be 1-24 chars of a-z, 0-9, - or _');
    o.suffix = String(raw.suffix);
  }
  if (raw.until !== undefined && raw.until !== null && raw.until !== '') {
    if (!STEPS.some((s) => s.id === raw.until)) throw httpError(400, `until must be one of ${STEPS.map((s) => s.id).join(', ')}`);
    o.until = raw.until;
  }
  if (raw.dryRun) o.dryRun = true;
  if (raw.gpuOverseer === false) o.gpuOverseer = false;
  return o;
}

/**
 * Start (or resume) installing catalog app `id`; returns the job snapshot at once while it runs in the background.
 * opts: { port, suffix (appended to the systemd unit and GPU Overseer client id, so a test install can sit
 * beside a live one), dryRun (check + plan, change nothing), until: <step id>, gpuOverseer: false }.
 * Asked again while the job runs, it returns that job (already: true).
 */
export function install(id, rawOpts = {}, deps = {}) {
  id = normId(id);
  const running = jobs.get(id);
  if (running?.state === 'running') return { ...snapshot(running), already: true };
  const m = catalogApp(id);
  if (!m) throw httpError(404, `"${id}" is not in the App Store catalog`);
  const opts = installOptions(rawOpts);
  const job = {
    id, op: 'install', opts, state: 'running', step: '', error: '', startedAt: Date.now(), endedAt: null,
    steps: STEPS.map((s) => ({ id: s.id, label: s.label, status: 'pending', percent: 0, detail: '' })),
    lines: [], abort: new AbortController(), lastEmit: 0, emitTimer: null, promise: null, log: () => {},
  };
  jobs.set(id, job);
  job.promise = runInstall(job, m, withDeps(deps));
  return snapshot(job);
}

/** Resolves when the app's current job has finished (for tests and callers that want to wait). */
export function whenDone(id) { return jobs.get(normId(id))?.promise || Promise.resolve(); }

/** Cancel a running install. It stops in the current step and resumes from there when installed again. */
export function cancel(id) {
  id = normId(id);
  const job = jobs.get(id);
  if (!job || job.state !== 'running') throw httpError(409, `no install of "${id}" is running`);
  job.log('cancel requested');
  job.abort.abort();
  return snapshot(job);
}

async function runInstall(job, m, d) {
  const { opts } = job;
  const dryRun = !!opts.dryRun;
  const prev = readState(m.id);
  const inst = instanceFor(m, opts, prev);
  const state = dryRun ? structuredClone(prev || { id: m.id, steps: {}, models: {} }) : prev || { v: 1, id: m.id, steps: {}, models: {}, createdAt: Date.now() };
  state.steps = state.steps || {};
  Object.assign(state, { suffix: inst.suffix, port: inst.port, portOverride: opts.port ?? prev?.portOverride ?? null });
  const logFile = path.join(inst.root, 'install.log');
  let rootReady = !dryRun && exists(inst.root);
  const pending = [];
  const log = (line) => {
    for (const l of redact(line).split('\n')) {
      job.lines.push(l);
      if (job.lines.length > 600) job.lines.splice(0, job.lines.length - 500);
      if (dryRun) continue;
      const stamped = `[${new Date().toISOString().slice(0, 19).replace('T', ' ')}] ${l}\n`;
      if (rootReady) { try { fs.appendFileSync(logFile, stamped); } catch {} } else pending.push(stamped);
    }
    emit(job);
  };
  job.log = log;
  const current = () => job.steps.find((s) => s.id === job.step);
  let lastDetailAt = 0;
  const ctx = {
    m, inst, d, opts, dryRun, state, log, signal: job.abort.signal, vars: placeholderVars(m, inst),
    progress(percent, detail) {
      const s = current();
      if (!s) return;
      if (typeof percent === 'number') s.percent = Math.max(0, Math.min(100, percent));
      if (detail !== undefined && detail !== null) s.detail = redact(detail);
      emit(job);
    },
    detailThrottled(detail) { if (Date.now() - lastDetailAt > 500) { lastDetailAt = Date.now(); ctx.progress(undefined, detail); } },
    /** Create <appsDir>/<id> with the first real change (a failed check leaves nothing behind). */
    ensureRoot() {
      if (dryRun || rootReady) return;
      fs.mkdirSync(inst.root, { recursive: true });
      rootReady = true;
      try { fs.appendFileSync(logFile, pending.join('')); } catch {}
      pending.length = 0;
      state.state = 'installing';
      writeState(state);
    },
    saveState() { if (!dryRun && rootReady) writeState(state); },
    async sh(cmd, args, { cwd, env, timeout = 60 * 60 * 1000, allowFail = false, onLine } = {}) {
      log(`$ ${[cmd, ...args].map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
      const r = await d.exec(cmd, args, {
        cwd, env, timeout, signal: job.abort.signal,
        onLine: (line) => {
          onLine?.(line);
          if (!isProgressBar(line)) log(line);
          ctx.detailThrottled(line.trim().slice(0, 160));
        },
      });
      if (job.abort.signal.aborted) throw new Error('cancelled');
      if (r.code !== 0 && !allowFail) throw new Error(`${path.basename(cmd)} ${args.find((a) => !a.startsWith('-')) || ''} failed (exit ${r.code})${r.stderr || r.stdout ? `: ${lastLines(r.stderr || r.stdout)}` : ''}`);
      return r;
    },
  };

  log(`${dryRun ? 'Dry run: ' : ''}installing ${m.name}${m.version ? ` ${m.version}` : ''} into ${inst.root}${inst.inPlace ? ` (runs from ${inst.appDir})` : ''}`);
  if (rootReady) { Object.assign(state, { state: 'installing', error: '', failedStep: '' }); writeState(state); }
  try {
    for (const s of STEPS) {
      if (job.abort.signal.aborted) throw new Error('cancelled');
      job.step = s.id;
      const js = current();
      js.status = 'running';
      emit(job, true);
      log(`── ${s.label}`);
      const r = (await STEP_IMPL[s.id](ctx)) || {};
      js.status = r.skipped ? 'skipped' : 'done';
      js.percent = 100;
      if (r.detail) js.detail = redact(r.detail);
      log(`${r.skipped ? '·' : '✓'} ${s.label}${js.detail ? `: ${js.detail}` : ''}`);
      if (!dryRun && rootReady && !r.always && r.key !== undefined) {
        const kept = state.steps[s.id];
        state.steps[s.id] = kept?.key === r.key ? kept : { key: r.key, at: Date.now(), detail: js.detail };
        writeState(state);
      }
      emit(job, true);
      if (opts.until === s.id) break;
    }
    const complete = !opts.until || opts.until === STEPS[STEPS.length - 1].id;
    if (!dryRun) {
      ctx.ensureRoot();
      Object.assign(state, complete ? { state: 'installed', version: m.version, installedAt: Date.now(), error: '', failedStep: '' } : { state: 'partial', error: '', failedStep: '' });
      writeState(state);
    }
    job.state = 'done';
    log(dryRun ? 'Dry run finished — nothing was changed.' : complete ? `${m.name} is installed.` : `Stopped after "${opts.until}" as asked — install again to finish.`);
  } catch (e) {
    const cancelled = job.abort.signal.aborted;
    const js = current();
    job.state = cancelled ? 'cancelled' : 'failed';
    job.error = redact(cancelled ? 'cancelled' : e.message);
    if (js) { js.status = 'failed'; js.detail = job.error; }
    log(`✗ ${js?.label || 'install'}: ${job.error}`);
    if (!dryRun && rootReady) { Object.assign(state, { state: 'failed', error: job.error, failedStep: job.step }); writeState(state); }
  } finally {
    job.endedAt = Date.now();
    emit(job, true);
  }
}

// ---------------------------------------------------------------- status, uninstall, list

/**
 * Install state of one app on this machine:
 *  not-installed | external (in the App Cloud, registered by hand) | installing (step, percent) |
 *  installed (version, updateAvailable) | partial (stopped early with `until`) | failed (error, failedStep, logTail).
 */
export function statusFor(id, m = null) {
  id = normId(id);
  const job = jobs.get(id);
  if (job?.state === 'running') return { state: 'installing', dryRun: !!job.opts.dryRun, step: job.step, stepLabel: STEPS.find((s) => s.id === job.step)?.label || '', percent: overallPercent(job), startedAt: job.startedAt };
  const st = readState(id);
  const reg = registryEntry(id);
  const registered = !!reg && reg.installedBy === STORE_TAG;
  if (!st) {
    const failed = job && !job.opts.dryRun && job.state !== 'done' ? job : null;
    if (reg && !registered) return { state: 'external', port: reg.port ?? null, launch: reg.launch || null, ...(failed ? { error: failed.error } : {}) };
    if (failed) return { state: 'failed', error: failed.error, failedStep: failed.step, logTail: failed.lines.slice(-30) };
    return reg ? { state: 'installed', registered, port: reg.port, version: '' } : { state: 'not-installed' };
  }
  const common = { root: rootOf(id), port: st.port, unit: st.unit || null, registered, sourceRev: st.sourceRev || '', python: st.python || '' };
  if (st.state === 'installed') return { ...common, state: 'installed', version: st.version || '', installedAt: st.installedAt, updateAvailable: !!m && (m.version || '') !== (st.version || '') };
  if (st.state === 'partial') return { ...common, state: 'partial', stepsDone: Object.keys(st.steps || {}) };
  if (st.state === 'installing') return { ...common, state: 'failed', error: 'interrupted (RIGS restarted during the install) — install again to resume', failedStep: '', logTail: logTail(id) };
  return { ...common, state: 'failed', error: st.error || 'failed', failedStep: st.failedStep || '', logTail: logTail(id) };
}

/** GET …/job: the live job when one ran since the daemon started, else rebuilt from install.json + install.log. */
export function jobFor(id) {
  id = normId(id);
  const job = jobs.get(id);
  if (job) return { ...snapshot(job), install: statusFor(id, catalogApp(id)) };
  const st = readState(id);
  const m = catalogApp(id);
  if (!st && !m && !registryEntry(id)) throw httpError(404, `"${id}" is not in the App Store catalog`);
  const status = statusFor(id, m);
  const steps = STEPS.map((s) => {
    const rec = st?.steps?.[s.id];
    const ok = rec || (st?.state === 'installed' && (s.id === 'check' || s.id === 'health'));
    return { id: s.id, label: s.label, status: ok ? 'done' : st?.failedStep === s.id ? 'failed' : 'pending', percent: ok ? 100 : 0, detail: rec?.detail || (st?.failedStep === s.id ? st.error : '') };
  });
  const state = { installed: 'done', partial: 'done', failed: 'failed' }[status.state] || 'idle';
  return { id, op: 'install', state, step: status.failedStep || '', error: status.error || '', percent: status.state === 'installed' ? 100 : 0, steps, install: status, log: st ? logTail(id, 200) : [] };
}

/**
 * Uninstall: unregister from the App Cloud, stop and disable the unit (or the launched process), drop the GPU
 * Overseer entry the store added, and move <appsDir>/<id> and the unit file into ~/.rigs/trash. Models kept
 * outside the app folder (the Hugging Face cache, absolute paths) stay where they are and are listed in `kept`.
 */
export async function uninstall(id, deps = {}) {
  const d = withDeps(deps);
  id = normId(id);
  if (jobs.get(id)?.state === 'running') throw httpError(409, `"${id}" is being installed — cancel the install first`);
  const st = readState(id);
  const reg = registryEntry(id);
  const ours = !!reg && reg.installedBy === STORE_TAG;
  if (!st && !ours) throw httpError(reg ? 409 : 404, reg ? `"${id}" was registered by hand, not installed by the App Store — remove it from the App Cloud instead` : `"${id}" is not installed`);
  const root = rootOf(id);
  const out = { id, unregistered: false, unit: null, stopped: [], overseer: false, trashed: [], kept: [] };

  if (ours) {
    const cfg = config();
    cfg.apps = (appsReg.declaredApps() || []).filter((a) => normId(a.id) !== id);
    saveConfig(cfg);
    out.unregistered = true;
    appsReg.checkAll().catch(() => {});
  }
  const unit = st?.unit || (ours ? reg.launch?.systemd : null);
  if (unit) {
    out.unit = unit;
    const file = path.join(d.unitDir(), unit);
    const managed = (readText(file) || '').includes(MARKER);
    if (managed && (await d.systemd())) {
      const r = await d.exec('systemctl', ['--user', 'disable', '--now', unit], { timeout: 60000 });
      if (r.code !== 0) out.warning = `systemctl --user disable --now ${unit}: ${lastLines(r.stderr || r.stdout)}`;
    }
    if (managed) {
      out.trashed.push(await moveToTrash(file, `appstore-${unit}`));
      if (await d.systemd()) await d.exec('systemctl', ['--user', 'daemon-reload'], { timeout: 30000 });
    }
  }
  out.stopped = await stopLaunched(root);
  out.overseer = overseerRemove(st?.overseer);
  const m = catalogApp(id);
  if (m) {
    const ctx = { m, inst: instanceFor(m, {}, st), state: st || { models: {} } };
    ctx.vars = placeholderVars(m, ctx.inst);
    for (const x of m.models) {
      const where = x.dest ? resolveDest(ctx, x.dest) : hfRepoCacheDir(x);
      if (!where.startsWith(root + path.sep) && exists(where)) out.kept.push(`${x.name}: ${where}`);
    }
  }
  if (exists(root)) out.trashed.push(await moveToTrash(root, `appstore-${id}`));
  jobs.delete(id);
  bus.emit('job', { id, op: 'uninstall', state: 'done', step: '', percent: 100, error: '', steps: [] });
  return out;
}

/** GET /api/local/appstore: the catalog with fit and install state per app. */
export async function list(deps = {}) {
  const d = withDeps(deps);
  const { apps, errors } = loadCatalog();
  const facts = await machineFacts(d);
  return {
    node: config().name, platform: facts.platform, appsDir: appsDir(), gpus: facts.gpus, freeGB: facts.freeGB,
    apps: apps.map((m) => ({ ...summarize(m), fit: fitFor(m, facts), install: statusFor(m.id, m) })),
    errors,
  };
}

/** GET /api/local/appstore/<id>: one app's card, its manifest, fit and install state. */
export async function detail(id, deps = {}) {
  const m = catalogApp(normId(id));
  if (!m) throw httpError(404, `"${normId(id)}" is not in the App Store catalog`);
  const facts = await machineFacts(withDeps(deps));
  const { file, ...manifest } = m;
  const rel = path.relative(APP_DIR, file);
  return { ...summarize(m), manifest: { ...manifest, file: rel.startsWith('..') ? file : rel }, fit: fitFor(m, facts), install: statusFor(m.id, m) };
}

/** Tests: forget jobs and cached probes. */
export function resetAppstoreState() { jobs.clear(); gpuCache = null; systemdCache = null; }
