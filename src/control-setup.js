import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RIGS_HOME } from './config.js';
import { APP_DIR, platformName, run } from './util.js';
import { refreshSessionEnv, guiEnv } from './desktop.js';
import * as rootsteps from './rootsteps.js';

// Control is on by default (docs/full-access.md). This module holds what used to wait for a person's
// control.enable(): the one-time switch-on of machines still on the old off defaults, and the first-run setup
// that runs at boot whenever control is on.

export const EXTENSION_UUID = 'rigs-control@rigs.dev';

/** What happened to control on this machine: the persistent kill marker, and whether a person or a kill ever set it. */
export function controlHistory(home = RIGS_HOME) {
  let killed = null;
  try { killed = JSON.parse(fs.readFileSync(path.join(home, 'control-state.json'), 'utf8')).killed || null; } catch {}
  let touched = false;
  for (const f of ['control.jsonl', 'control.jsonl.1', 'control.jsonl.2']) {
    let text;
    try { text = fs.readFileSync(path.join(home, 'logs', f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes('"op":"enable"') && !line.includes('"op":"kill"')) continue;
      try { const a = JSON.parse(line); if (a.ok && ['enable', 'kill'].includes(a.op)) touched = true; } catch {}
    }
  }
  return { killed, touched };
}

/** Pure: switch on only the untouched old defaults (both off). A kill or a person's switch-off stays off. */
export function defaultOnDecision({ control = {}, killed = null, touched = false } = {}) {
  if (control.enabled !== false || control.input !== false) return { change: false, reason: 'not the old off defaults' };
  if (killed) return { change: false, reason: 'killed' };
  if (touched) return { change: false, reason: 'set by a person' };
  return { change: true, reason: 'old off defaults' };
}

/** gsettings strv text (`['a', 'b']` or `@as []`) ⇄ list. */
export function parseStrv(text = '') {
  return [...String(text).matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
}
export function formatStrv(list) {
  return `[${list.map((s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(', ')}]`;
}

/**
 * GNOME: install the RIGS Shell extension (window list + focus) for this user and enable it. The running Shell
 * only loads extensions present at login, so a new install becomes active after one log-out/in.
 */
export async function installGnomeExtension({ home = os.homedir(), runner = run, env } = {}) {
  if (!env) { await refreshSessionEnv(); env = guiEnv(); }
  const src = path.join(APP_DIR, 'scripts/control/gnome-extension', EXTENSION_UUID);
  const dst = path.join(home, '.local/share/gnome-shell/extensions', EXTENSION_UUID);
  let copied = false;
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const data = fs.readFileSync(path.join(src, f));
    let old = null;
    try { old = fs.readFileSync(path.join(dst, f)); } catch {}
    if (!old?.equals(data)) { fs.writeFileSync(path.join(dst, f), data); copied = true; }
  }
  const got = await runner('gsettings', ['get', 'org.gnome.shell', 'enabled-extensions'], { env, timeout: 5000 });
  // Never write the list back from a failed read: that would switch off every other extension.
  if (got.code !== 0) return { copied, enabled: false, path: dst, error: (got.stderr || 'gsettings failed').trim() };
  const list = parseStrv(got.stdout);
  if (list.includes(EXTENSION_UUID)) return { copied, enabled: true, path: dst, relogin: copied };
  const now = await runner('gnome-extensions', ['enable', EXTENSION_UUID], { env, timeout: 10000 });
  if (now.code === 0) return { copied, enabled: true, path: dst, relogin: copied };
  const set = await runner('gsettings', ['set', 'org.gnome.shell', 'enabled-extensions', formatStrv([...list, EXTENSION_UUID])], { env, timeout: 5000 });
  return { copied, enabled: set.code === 0, path: dst, relogin: true, ...(set.code ? { error: (set.stderr || 'gsettings failed').trim() } : {}) };
}

async function setup({ control, platform = platformName(), home = os.homedir(), runner = run, env, uinput = rootsteps.ensureUinput } = {}) {
  // Inspecting starts the helper (Linux python, Windows PowerShell) and probes the desktop.
  const st = await control.status({ force: true });
  if (!st.enabled) return { skipped: st.killed ? 'killed' : 'off' };
  const out = { session: st.session, desktop: st.desktop, helper: st.backend?.helper || null };
  if (platform === 'linux' && st.session !== 'none') {
    out.uinput = await uinput();
    if (st.desktop === 'gnome') out.extension = await installGnomeExtension({ home, runner, env }).catch((e) => ({ error: e.message }));
  }
  // macOS: Screen Recording and Accessibility need a person in System Settings; the Access & control panel guides it.
  if (platform === 'mac') out.grants = ['screenCapture', 'accessibility'].filter((k) => st.permissions?.[k]?.ok !== true);
  return out;
}

let running = null;
/** First-run setup for a machine where control is on. Idempotent; concurrent calls share one run. */
export function ensureControlSetup(opts) {
  running ||= setup(opts).finally(() => { running = null; });
  return running;
}
