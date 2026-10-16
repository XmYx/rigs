import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { APP_DIR, HOME, escapeRe } from './util.js';

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
