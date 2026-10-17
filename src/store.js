import path from 'node:path';
import { validateApp } from './apps.js';

/**
 * App-store manifests → concrete install plans. Everything here is pure: no fs, no spawn, no config
 * read. The caller supplies the platform, install dir, node binary, RIGS_HOME and the unit template
 * text, and gets back the files to write, the command to run and the app registration payload.
 *
 * Manifest (applets/navigation/store.json is the reference): id, name, description, icon, version,
 * category, platforms[], runtime.node, requirements{gpu,diskMB}, python/venv/models (explicitly
 * null/false/[] when the app needs none; an installer skips its venv and model steps then), port,
 * healthPath, install[], launch{linux|darwin|win32}, env, data{dir,keepOnUninstall}, settings[],
 * uninstall{steps[]}. Placeholders in strings: {{INSTALL_DIR}} {{NODE}} {{RIGS_HOME}} {{DATA_DIR}}
 * {{PORT}} {{ENV_FILE}}.
 */

const PLATFORMS = ['linux', 'darwin', 'win32'];
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['manifest must be an object'];
  if (!ID_RE.test(String(m.id || ''))) errors.push('id must be 1-40 chars of a-z, 0-9, - or _');
  for (const k of ['name', 'description', 'icon', 'version', 'category']) if (typeof m[k] !== 'string' || !m[k].trim()) errors.push(`${k} must be a non-empty string`);
  if (!Array.isArray(m.platforms) || !m.platforms.length || m.platforms.some((p) => !PLATFORMS.includes(p))) errors.push(`platforms must list some of ${PLATFORMS.join(', ')}`);
  if (typeof m.runtime?.node !== 'string') errors.push('runtime.node is required');
  if (typeof m.requirements?.gpu !== 'boolean' || !Number.isFinite(m.requirements?.diskMB)) errors.push('requirements needs gpu (boolean) and diskMB (number)');
  if (!Number.isInteger(m.port) || m.port < 1 || m.port > 65535) errors.push('port must be an integer 1-65535');
  if (typeof m.healthPath !== 'string' || !m.healthPath) errors.push('healthPath is required');
  if (!Array.isArray(m.install) || !m.install.length) errors.push('install steps are required');
  if (!m.launch || typeof m.launch !== 'object') errors.push('launch is required');
  else for (const p of m.platforms || []) if (!m.launch[p]) errors.push(`launch.${p} is missing`);
  if (m.launch?.linux && !(m.launch.linux.systemd?.unit && m.launch.linux.systemd?.template)) errors.push('launch.linux.systemd needs unit and template');
  for (const p of ['darwin', 'win32']) if (m.launch?.[p] && typeof m.launch[p].command !== 'string') errors.push(`launch.${p}.command is required`);
  if (!Array.isArray(m.uninstall?.steps)) errors.push('uninstall.steps is required');
  if (!m.data || typeof m.data.dir !== 'string' || typeof m.data.keepOnUninstall !== 'boolean') errors.push('data needs dir and keepOnUninstall');
  if (!('python' in m) || !('venv' in m) || !Array.isArray(m.models)) errors.push('python, venv and models must be stated explicitly (null / false / [] when not needed)');
  for (const s of m.settings || []) if (!/^[A-Z][A-Z0-9_]*$/.test(String(s?.key || ''))) errors.push(`settings key ${JSON.stringify(s?.key)} must be an env-style name`);
  return errors;
}

/** Fill {{NAME}} placeholders from vars; an unknown placeholder throws instead of shipping a broken unit. */
export function fill(text, vars) {
  return String(text).replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`unknown placeholder {{${k}}}`);
    return vars[k];
  });
}

/** True when the manifest needs a Python venv or any model download. */
export function needsVenvOrModels(m) {
  return !!(m.venv || m.python || (m.models && m.models.length));
}

/**
 * The install plan for one platform.
 * @param {object} manifest  parsed store.json
 * @param {{platform:string, installDir:string, rigsHome:string, nodePath:string, unitTemplate?:string, home?:string, port?:number}} o
 * @returns {{id, platform, vars, steps:string[], dirs:string[], files:{path,content,mode?}[], launch:{kind,unit?,command?,cwd?}, registration:object, envFile, settings, uninstall:{steps:string[], keepData:boolean, dataDir:string}}}
 */
export function installPlan(manifest, { platform, installDir, rigsHome, nodePath, unitTemplate, home, port } = {}) {
  const errors = validateManifest(manifest);
  if (errors.length) throw new Error(`invalid manifest: ${errors.join('; ')}`);
  if (!manifest.platforms.includes(platform)) throw new Error(`${manifest.id} does not support ${platform}`);
  if (!installDir || !rigsHome || !nodePath) throw new Error('installDir, rigsHome and nodePath are required');
  const win = platform === 'win32';
  const j = win ? path.win32.join : path.posix.join;
  const useport = port ?? manifest.port;
  const base = { INSTALL_DIR: installDir, NODE: nodePath, RIGS_HOME: rigsHome, PORT: String(useport) };
  const dataDir = fill(manifest.data.dir, base).replace(/[\\/]/g, win ? '\\' : '/');
  const envFile = j(rigsHome, manifest.id, 'env');
  const vars = { ...base, DATA_DIR: dataDir, ENV_FILE: envFile };

  const launch = manifest.launch[platform];
  const files = [];
  let launchInfo;
  let registrationLaunch;
  if (platform === 'linux') {
    if (typeof unitTemplate !== 'string') throw new Error('unitTemplate text is required for linux');
    const { unit } = launch.systemd;
    const unitDir = j(home || path.posix.dirname(rigsHome), '.config', 'systemd', 'user');
    files.push({ path: j(unitDir, unit), content: fill(unitTemplate, vars) });
    launchInfo = { kind: 'systemd', unit, scope: launch.systemd.scope || 'user', start: ['systemctl', '--user', 'enable', '--now', unit] };
    registrationLaunch = { systemd: unit };
  } else {
    const command = fill(launch.command, vars);
    launchInfo = { kind: 'command', command, cwd: fill(launch.cwd || installDir, vars) };
    registrationLaunch = { command };
  }

  const hp = manifest.healthPath.startsWith('/') ? manifest.healthPath : `/${manifest.healthPath}`;
  const registration = { id: manifest.id, name: manifest.name, icon: manifest.icon, port: useport, healthPath: hp, launch: registrationLaunch };
  const steps = manifest.install.map((s) => s.step);
  return {
    id: manifest.id,
    platform,
    vars,
    steps,
    dirs: [dataDir],
    files,
    launch: launchInfo,
    env: Object.fromEntries(Object.entries(manifest.env || {}).map(([k, v]) => [k, fill(v, vars)])),
    envFile,
    settings: (manifest.settings || []).map(({ key, secret = false, optional = false, label, description }) => ({ key, secret, optional, label, description })),
    registration,
    uninstall: { steps: manifest.uninstall.steps.map((s) => s.step), keepData: manifest.data.keepOnUninstall, dataDir },
  };
}
