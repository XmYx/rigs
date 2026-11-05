#!/usr/bin/env node
// Publish Home Security to the App Cloud of THIS machine (run once per node that should record; idempotent).
//   node apps/home-security/launch/install.mjs [--install-dir <rigs checkout>] [--daemon http://127.0.0.1:4719] [--dry-run]
// - Linux: fills apps/home-security/rigs-home-security.service.tmpl, writes ~/.config/systemd/user/rigs-home-security.service,
//   daemon-reload + `enable --now` (starts at boot; Restart=always).
// - macOS / Windows: nothing to install; the registered launch command is run by the daemon, and the resident keeper
//   (src/tts.js startResidentKeeper) starts it again whenever it is down.
// - Registers app.json (keepAlive: true, per-OS launch recipes) with POST /api/local/apps. The MCP tool mesh_app_register
//   and the app-publish tool cannot pass keepAlive, so this is the one registration path.
// The install dir defaults to the RIGS checkout this file lives in (<dir>/apps/home-security/launch/install.mjs).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.dirname(HERE);
const argv = process.argv.slice(2);
const opt = (name, d) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : d; };
const dryRun = argv.includes('--dry-run');
const installDir = path.resolve(opt('install-dir', path.resolve(APP_DIR, '..', '..')));
const daemon = String(opt('daemon', 'http://127.0.0.1:4719')).replace(/\/+$/, '');

const fill = (s, vars) => String(s).replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => { if (!(k in vars)) throw new Error(`unknown placeholder ${m}`); return vars[k]; });
const manifest = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'app.json'), 'utf8'));
const vars = { INSTALL_DIR: installDir, NODE: process.execPath, PORT: String(manifest.port) };
// This machine's recipe gets its real install dir; the other OSes keep the default checkout location (~/.rigs/app).
const OS_KEY = { darwin: 'darwin', win32: 'windows', linux: 'linux' }[process.platform];
const registration = structuredClone(manifest);
for (const [os_, recipe] of Object.entries(registration.launch)) {
  if (typeof recipe.cwd === 'string') recipe.cwd = os_ === OS_KEY ? fill(recipe.cwd, vars) : os_ === 'windows' ? '~\\.rigs\\app' : '~/.rigs/app';
}
if (!fs.existsSync(path.join(installDir, 'apps', 'home-security', 'server.js'))) throw new Error(`${installDir} has no apps/home-security/server.js`);

const steps = [];
if (process.platform === 'linux') {
  if (!process.env.XDG_RUNTIME_DIR && process.getuid && fs.existsSync(`/run/user/${process.getuid()}`)) process.env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
  const unit = manifest.launch.linux.systemd;
  const unitPath = path.join(process.env.RIGS_SYSTEMD_USER_DIR || path.join(os.homedir(), '.config', 'systemd', 'user'), unit);
  const text = fill(fs.readFileSync(path.join(APP_DIR, 'rigs-home-security.service.tmpl'), 'utf8'), vars);
  steps.push(`write ${unitPath}`, `systemctl --user daemon-reload`, `systemctl --user enable --now ${unit}`);
  if (!dryRun) {
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, text);
    execFileSync('systemctl', ['--user', 'daemon-reload']);
    // restart (not just start) so a re-run after an update picks up the new code
    execFileSync('systemctl', ['--user', 'enable', unit]);
    execFileSync('systemctl', ['--user', 'restart', unit]);
  }
}
steps.push(`POST ${daemon}/api/local/apps (${manifest.id}, keepAlive ${registration.keepAlive})`);
if (dryRun) { console.log(JSON.stringify({ ok: true, dryRun: true, steps, registration }, null, 2)); process.exit(0); }
const r = await fetch(`${daemon}/api/local/apps`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(registration), signal: AbortSignal.timeout(15000) });
const body = await r.json().catch(() => ({}));
if (!r.ok) { console.error(JSON.stringify({ ok: false, error: body.error || `HTTP ${r.status}` })); process.exit(1); }
if (process.platform === 'linux') {
  try { const l = execFileSync('loginctl', ['show-user', os.userInfo().username, '-p', 'Linger'], { encoding: 'utf8' }).trim(); if (l !== 'Linger=yes') steps.push(`WARNING ${l}: without a login session the unit only starts at boot after: sudo loginctl enable-linger ${os.userInfo().username}`); } catch { /* no loginctl */ }
}
console.log(JSON.stringify({ ok: true, steps, installDir, health: `http://127.0.0.1:${manifest.port}${manifest.healthPath}` }));
