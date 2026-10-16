import fs from 'node:fs';
import path from 'node:path';
import { HOME, isMac, isWin, run, which } from './util.js';
import { config } from './config.js';
import { tailscaleBin } from './tailscale.js';

const WIN_PF = 'C:\\Program Files';
const macApp = (app, bins) => ['/Applications', path.join(HOME, 'Applications')].flatMap((d) => bins.map((b) => path.join(d, `${app}.app`, 'Contents', 'MacOS', b)));
const KNOWN = {
  claude: { extra: [path.join(HOME, '.local', 'bin', isWin ? 'claude.exe' : 'claude'), path.join(HOME, '.claude', 'local', 'claude')], args: ['--version'] },
  codex: { extra: [], args: ['--version'] },
  ollama: { extra: isWin ? [path.join(HOME, 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe')] : ['/usr/local/bin/ollama', '/opt/homebrew/bin/ollama'], args: ['--version'] },
  rig: { extra: [], args: ['--version'] },
  rea: { extra: [], args: ['--version'] },
  tmux: { extra: ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'], args: ['-V'] },
  git: { extra: isWin ? [WIN_PF + '\\Git\\cmd\\git.exe'] : [], args: ['--version'] },
  gh: { extra: ['/opt/homebrew/bin/gh', WIN_PF + '\\GitHub CLI\\gh.exe'], args: ['--version'] },
  ssh: { extra: isWin ? ['C:\\Windows\\System32\\OpenSSH\\ssh.exe'] : [], args: ['-V'] },
  sunshine: { extra: isWin ? [WIN_PF + '\\Sunshine\\sunshine.exe'] : isMac ? ['/opt/homebrew/bin/sunshine', ...macApp('Sunshine', ['sunshine', 'Sunshine'])] : ['/usr/bin/sunshine'], args: ['--version'] },
  moonlight: { extra: isWin ? [WIN_PF + '\\Moonlight Game Streaming\\Moonlight.exe', path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'RIGS', 'Moonlight', 'Moonlight.exe')] : isMac ? macApp('Moonlight', ['Moonlight']) : ['/usr/bin/moonlight', '/usr/bin/moonlight-qt', path.join(HOME, '.local', 'bin', 'moonlight')], args: null },
  rustdesk: { extra: isWin ? [WIN_PF + '\\RustDesk\\rustdesk.exe'] : isMac ? ['/Applications/RustDesk.app/Contents/MacOS/RustDesk'] : ['/usr/bin/rustdesk'], args: null },
};

export function bin(name) {
  if (name === 'tailscale') return tailscaleBin();
  const k = KNOWN[name];
  return which(name, k?.extra || []);
}

function firstLine(s) {
  return String(s || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) || '';
}

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

/** Is REA registered as an MCP server for each coding agent on this machine? */
function reaRegistrations() {
  const claudeJson = readTextSafe(path.join(HOME, '.claude.json'));
  const codexToml = readTextSafe(path.join(HOME, '.codex', 'config.toml'));
  return {
    claude: /"rea"\s*:/.test(claudeJson) || /rea-agents/.test(claudeJson),
    codex: /\[mcp_servers\.rea\]/.test(codexToml) || /rea-agents/.test(codexToml),
  };
}

function rigsRegistrations() {
  const claudeJson = readTextSafe(path.join(HOME, '.claude.json'));
  const codexToml = readTextSafe(path.join(HOME, '.codex', 'config.toml'));
  return {
    claude: /"rigs"\s*:\s*\{/.test(claudeJson),
    codex: /\[mcp_servers\.rigs\]/.test(codexToml),
  };
}

export async function ollamaModels() {
  const url = config().brain.ollamaUrl.replace(/\/$/, '');
  try {
    const r = await fetch(url + '/api/tags', { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return { running: false, models: [] };
    const j = await r.json();
    return {
      running: true,
      models: (j.models || []).map((m) => ({ name: m.name, size: m.size, family: m.details?.family || '', params: m.details?.parameter_size || '' })),
    };
  } catch {
    return { running: false, models: [] };
  }
}

let cache = { at: 0, value: null };

export async function detectTools(force = false) {
  if (!force && cache.value && Date.now() - cache.at < 5 * 60 * 1000) return cache.value;
  const out = {};
  await Promise.all(Object.entries(KNOWN).map(async ([name, k]) => {
    const p = bin(name);
    if (!p) { out[name] = { installed: false }; return; }
    let version = '';
    if (k.args) {
      const r = await run(p, k.args, { timeout: 8000 });
      version = firstLine(r.stdout || r.stderr).replace(/^(tmux|git version|gh version|ollama version is)\s*/i, '');
    }
    out[name] = { installed: true, path: p, version: version.slice(0, 60) };
  }));
  const ts = tailscaleBin();
  out.tailscale = { installed: !!ts, path: ts || undefined };
  out.reaRegistered = reaRegistrations();
  out.rigsRegistered = rigsRegistrations();
  // `npx rea-agents` works without a global install; count a registration as "REA available".
  out.rea.available = out.rea.installed || out.reaRegistered.claude || out.reaRegistered.codex;
  cache = { at: Date.now(), value: out };
  return out;
}
