import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { bin } from './tools.js';
import { APP_DIR, HOME, clearWhichCache, escapeRe, isWin, run } from './util.js';

/**
 * Codex side of "agents run in auto mode, and say when they need you":
 *  - a `rigs-auto` profile (~/.codex/rigs-auto.config.toml, selected with `-p rigs-auto`, e.g. by OpenRig's
 *    codex_config_profile): workspace-write sandbox with network, approval on-request (asks only to escalate);
 *  - a top-level `notify` hook in ~/.codex/config.toml → `rigs hook codex '<json>'`, so an approval request
 *    reaches the attention feed (blinking planet + notification) the moment Codex asks.
 */

export const CODEX_AUTO_PROFILE = 'rigs-auto';
const START = '# >>> rigs notify (managed) >>>';
const END = '# <<< rigs notify <<<';

const codexHome = () => process.env.CODEX_HOME || path.join(HOME, '.codex');
const profileFile = () => path.join(codexHome(), `${CODEX_AUTO_PROFILE}.config.toml`);

export function codexAutoProfileReady() {
  return fs.existsSync(profileFile());
}

const PROFILE = `# Managed by RIGS (rewritten on update). Codex "auto": edit and run in the workspace without asking,
# with network; the model asks only when it needs to escalate — and RIGS shows that as "needs you".
sandbox_mode = "workspace-write"
approval_policy = "on-request"

[sandbox_workspace_write]
network_access = true
`;

/** Top-level keys must come before the first [table], so the managed block goes at the very top of config.toml. */
export function withNotify(text, cmd) {
  const re = new RegExp(escapeRe(START) + '[\\s\\S]*?' + escapeRe(END) + '\\n?');
  const rest = text.replace(re, '');
  const head = rest.split(/^\s*\[/m)[0];
  if (/^\s*notify\s*=/m.test(head)) return { text, skipped: 'config.toml already has its own notify program' };
  const block = `${START}\nnotify = [${cmd.map((x) => JSON.stringify(x)).join(', ')}]\n${END}\n`;
  const next = block + rest.replace(/^\n+/, '');
  return { text: next, changed: next !== text };
}

export async function installCodex() {
  const home = codexHome();
  if (!fs.existsSync(home)) return { skipped: 'Codex not set up on this machine' };
  const out = {};
  const pf = profileFile();
  let cur = '';
  try { cur = await fsp.readFile(pf, 'utf8'); } catch {}
  if (cur !== PROFILE) { await fsp.writeFile(pf, PROFILE); out.profile = pf; }
  const file = path.join(home, 'config.toml');
  let text = '';
  try { text = await fsp.readFile(file, 'utf8'); } catch {}
  const r = withNotify(text, [process.execPath, path.join(APP_DIR, 'bin', 'rigs.js'), 'hook', 'codex']);
  if (r.skipped) out.notify = r.skipped;
  else if (r.changed) {
    if (text) await fsp.writeFile(file + '.rigs.bak', text);
    await fsp.writeFile(file, r.text);
    out.notify = file;
  }
  return out;
}

// ---------------------------------------------------------------- node CLI wrappers
// `rig` and `codex` are Node scripts (`#!/usr/bin/env node`). An agent's shell may find another `node`
// first (an old Homebrew node with a missing ICU, an x64 nvm default…), and then `rig queue` fails inside
// the seat and the task never arrives. A tiny wrapper in ~/.local/bin runs each with the Node it was
// installed under. Only written where ~/.local/bin has nothing of that name; removed if its target goes.
const MARK = '# Managed by RIGS';

export function wrapperTarget(p) {
  try {
    const t = fs.readFileSync(p, 'utf8');
    return t.includes(MARK) ? (t.match(/^# target: (.+)$/m) || [])[1] || null : null;
  } catch { return null; }
}

export async function ensureCliWrappers({ tools = ['rig', 'codex'], dir = path.join(HOME, '.local', 'bin') } = {}) {
  if (isWin) return { skipped: 'not needed on Windows (npm writes .cmd shims with an absolute node)' };
  const out = {};
  for (const tool of tools) {
    const wrapper = path.join(dir, tool);
    const mine = wrapperTarget(wrapper);
    if (mine) {
      if (fs.existsSync(mine)) { out[tool] = 'ok'; continue; }
      fs.rmSync(wrapper, { force: true }); // its install moved — fall through and re-resolve
      clearWhichCache();
    } else if (fs.existsSync(wrapper)) { out[tool] = 'left alone (not ours)'; continue; }
    const p = bin(tool);
    if (!p) continue;
    let script;
    try { script = fs.realpathSync(p); } catch { continue; }
    if (!/\.[cm]?js$/.test(script)) { out[tool] = 'native binary'; continue; }
    const sibling = path.join(path.dirname(p), 'node');
    const node = fs.existsSync(sibling) ? sibling : process.execPath;
    const q = (x) => `'${x.replace(/'/g, `'\\''`)}'`;
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(wrapper, `#!/bin/sh\n${MARK}: run ${tool} with the Node it was installed for, whatever \`node\` PATH finds first.\n# target: ${script}\nexec ${q(node)} ${q(script)} "$@"\n`, { mode: 0o755 });
    const v = await run(wrapper, ['--version'], { timeout: 20000 });
    if (v.code !== 0) { fs.rmSync(wrapper, { force: true }); out[tool] = 'wrapper failed, removed: ' + (v.stderr || v.stdout).trim().slice(0, 120); continue; }
    out[tool] = `${wrapper} → ${node}`;
  }
  clearWhichCache();
  return out;
}
