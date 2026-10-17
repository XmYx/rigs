import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const isWin = process.platform === 'win32';
export const isMac = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';
export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOME = os.homedir();

export function platformName() {
  return isMac ? 'mac' : isWin ? 'windows' : 'linux';
}

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(HOME, p.slice(2));
  return p;
}

const whichCache = new Map();

/**
 * Resolve an executable on PATH (plus a few well-known install locations). Hits are cached;
 * misses expire after a minute so tools installed while the node runs (Tailscale, Sunshine…) appear.
 */
export function which(name, extra = []) {
  const key = name + '|' + extra.join('|');
  const hit = whichCache.get(key);
  if (hit && (hit.path || Date.now() - hit.at < 60000)) return hit.path;
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.PS1').split(';').map((e) => e.toLowerCase()) : [''];
  // The service's own PATH first, then the usual install dirs: launchd/systemd hand services a thin PATH.
  const dirs = augmentedPath().split(path.delimiter).filter(Boolean);
  const candidates = [];
  for (const d of dirs) for (const e of exts) candidates.push(path.join(d, isWin && path.extname(name) ? name : name + e));
  candidates.push(...extra);
  let found = null;
  for (const c of candidates) {
    try {
      const st = fs.statSync(c);
      if (st.isFile()) { found = c; break; }
    } catch {}
  }
  whichCache.set(key, { path: found, at: Date.now() });
  return found;
}

export function clearWhichCache() { whichCache.clear(); }

/** Extra PATH entries where agent CLIs usually live, so services started by launchd/systemd still find them. */
export function augmentedPath() {
  const extra = isWin
    ? [path.join(HOME, 'AppData', 'Roaming', 'npm'), path.join(HOME, '.local', 'bin'), 'C:\\Program Files\\Tailscale', 'C:\\Program Files\\nodejs', 'C:\\Program Files\\Git\\cmd', 'C:\\Program Files\\Ollama', path.join(HOME, 'AppData', 'Local', 'Programs', 'Ollama')]
    : [path.join(HOME, '.local', 'bin'), path.join(HOME, '.npm-global', 'bin'), path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/snap/bin', '/Applications/Tailscale.app/Contents/MacOS'];
  const cur = (process.env.PATH || '').split(path.delimiter);
  return [...cur, ...extra.filter((e) => !cur.includes(e))].filter(Boolean).join(path.delimiter);
}

/** Needs a shell on Windows for .cmd/.bat shims (npm-installed CLIs). */
export function needsShell(cmd) {
  return isWin && /\.(cmd|bat)$/i.test(cmd || '');
}

function quoteWinArg(a) {
  if (a === '') return '""';
  if (!/[\s"&|<>^%]/.test(a)) return a;
  return '"' + String(a).replace(/"/g, '""') + '"';
}

/** Spawn wrapper that handles Windows .cmd/.bat shims and .ps1 scripts safely. */
export function spawnCmd(cmd, args = [], opts = {}) {
  if (isWin && /\.ps1$/i.test(cmd || '')) {
    return spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cmd, ...args], { windowsHide: true, ...opts });
  }
  if (needsShell(cmd)) {
    const line = [quoteWinArg(cmd), ...args.map(quoteWinArg)].join(' ');
    return spawn(line, { ...opts, shell: true, windowsHide: true });
  }
  return spawn(cmd, args, { windowsHide: true, ...opts });
}

/** Run a command and collect output. Never throws; resolves {code, stdout, stderr}. */
export function run(cmd, args = [], opts = {}) {
  const { timeout = 15000, input, cwd, env, maxBuffer = 8 * 1024 * 1024 } = opts;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnCmd(cmd, args, { cwd, env: env || { ...process.env, PATH: augmentedPath() }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e.message || e) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = timeout ? setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(-2, '\n[timed out]'); }, timeout) : null;
    function finish(code, extra = '') {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr: stderr + extra });
    }
    child.stdout.on('data', (d) => { if (stdout.length < maxBuffer) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < maxBuffer) stderr += d; });
    child.on('error', (e) => finish(-1, String(e.message || e)));
    child.on('close', (code) => finish(code ?? -1));
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

export async function readJson(file, fallback = null) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}

export function readJsonSync(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}

export const MANAGED_START = '# >>> rigs mesh >>>';
export const MANAGED_END = '# <<< rigs mesh <<<';

/** `text` with the block delimited by marker comments replaced by `body` (appended if absent). Pure. */
export function applyManagedBlock(text, body, { start = MANAGED_START, end = MANAGED_END } = {}) {
  const block = `${start}\n${body.trim() ? body.trimEnd() + '\n' : ''}${end}\n`;
  const re = new RegExp(`${escapeRe(start)}[\\s\\S]*?${escapeRe(end)}\\n?`);
  return re.test(text) ? text.replace(re, () => block) : (text && !text.endsWith('\n') ? text + '\n' : text) + (text ? '\n' : '') + block;
}

/** Replace (or append) a block delimited by marker comments inside a text file. */
export async function upsertManagedBlock(file, body, { start = MANAGED_START, end = MANAGED_END, mode } = {}) {
  let text = '';
  try { text = await fsp.readFile(file, 'utf8'); } catch {}
  const next = applyManagedBlock(text, body, { start, end });
  if (next === text) return false;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, next, mode ? { mode } : undefined);
  return true;
}

export function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>NOMDEHc78]|\r/g, '');
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function shortHost() {
  return os.hostname().split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

export function log(...args) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}]`, ...args);
}
