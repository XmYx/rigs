import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { RIGS_HOME } from './config.js';
import { isWin, readJsonSync, run } from './util.js';

/**
 * Steps that need root/administrator on this machine (installing Sunshine, switching port 22 from
 * Tailscale SSH to OpenSSH, …). Modules register them here; they are bundled into ONE script,
 * ~/.rigs/finish-root.sh (.ps1 on Windows), that runs everything with a single password prompt.
 * When sudo needs no password the node runs it itself; otherwise JARVIS offers a "Finish setup"
 * button that opens a terminal on that machine with the script.
 */

const FILE = path.join(RIGS_HOME, 'root-steps.json');
const DONE = path.join(RIGS_HOME, 'root-steps.done');
export const SCRIPT = path.join(RIGS_HOME, isWin ? 'finish-root.ps1' : 'finish-root.sh');

function load() {
  const s = readJsonSync(FILE, { steps: {} });
  // The script stamps DONE on success; anything registered before that stamp is finished.
  let doneAt = 0;
  try { doneAt = fs.statSync(DONE).mtimeMs; } catch {}
  for (const [id, st] of Object.entries(s.steps)) if (st.at <= doneAt) delete s.steps[id];
  return s;
}

async function save(s) {
  await fsp.mkdir(RIGS_HOME, { recursive: true });
  await fsp.writeFile(FILE, JSON.stringify(s, null, 2));
  await writeScript(s);
}

async function writeScript(s) {
  const steps = Object.values(s.steps);
  if (isWin) {
    const body = ['# Finishes RIGS setup steps that need an administrator. Safe to re-run.', ...steps.flatMap((x) => [`Write-Host '> ${x.title}'`, ...x.lines]), `New-Item -ItemType File -Force '${DONE}' | Out-Null`, "Write-Host 'Done.'"].join('\r\n');
    await fsp.writeFile(SCRIPT, body);
    return;
  }
  const body = ['#!/bin/sh', '# Finishes RIGS setup steps that need root (one sudo password). Safe to re-run.', 'set -e', 'sudo -v',
    ...steps.flatMap((x) => [`echo "> ${x.title}"`, ...x.lines]), `touch "${DONE}"`, 'echo "Done — RIGS will pick this up within a minute."', ''].join('\n');
  await fsp.writeFile(SCRIPT, body, { mode: 0o700 });
}

export async function add(id, title, lines) {
  const s = load();
  s.steps[id] = { title, lines, at: Date.now() };
  await save(s);
}

export async function remove(id) {
  const s = load();
  if (!s.steps[id]) return;
  delete s.steps[id];
  await save(s);
}

export function pending() {
  const s = load();
  const steps = Object.entries(s.steps).map(([id, x]) => ({ id, title: x.title }));
  return { steps, command: steps.length ? (isWin ? `Start-Process powershell -Verb RunAs -ArgumentList '-ExecutionPolicy Bypass -File "${SCRIPT}"'` : `sh ${SCRIPT}`) : '' };
}

/** Run the bundle unattended when sudo needs no password. */
export async function tryUnattended() {
  const p = pending();
  if (!p.steps.length || isWin) return { ran: false, ...p };
  const ok = (await run('sudo', ['-n', 'true'], { timeout: 5000 })).code === 0;
  if (!ok) return { ran: false, ...p };
  const r = await run('sh', [SCRIPT], { timeout: 20 * 60 * 1000 });
  return { ran: true, ok: r.code === 0, output: (r.stdout + r.stderr).slice(-600), ...pending() };
}

/** Windows Defender "Controlled folder access" blocks writes to Documents/Desktop by unknown apps. */
export async function allowControlledFolderAccess() {
  if (!isWin) return { skipped: true };
  const r = await run('powershell.exe', ['-NoProfile', '-Command', '(Get-MpPreference).EnableControlledFolderAccess'], { timeout: 15000 });
  if (r.stdout.trim() !== '1') { await remove('cfa'); return { controlledFolderAccess: false }; }
  await add('cfa', 'Let RIGS (node.exe) write in Documents/Desktop under Controlled folder access', [
    `Add-MpPreference -ControlledFolderAccessAllowedApplications '${process.execPath}'`,
  ]);
  return { controlledFolderAccess: true, pendingRoot: true };
}

/** Tailscale SSH takes over port 22 on the tailnet and ignores the mesh keys; hand it back to OpenSSH. */
export async function preferOpenSsh(tailscaleBin) {
  if (!tailscaleBin || isWin) return { skipped: true };
  const r = await run(tailscaleBin, ['debug', 'prefs'], { timeout: 8000 });
  if (!/"RunSSH":\s*true/.test(r.stdout)) { await remove('openssh'); return { tailscaleSsh: false }; }
  await add('openssh', 'Mesh SSH: let OpenSSH (with the RIGS mesh keys) answer port 22 instead of Tailscale SSH', [
    `sudo "${tailscaleBin}" set --ssh=false`,
    'sudo systemctl enable --now ssh 2>/dev/null || sudo systemctl enable --now sshd 2>/dev/null || true',
  ]);
  return { tailscaleSsh: true, pendingRoot: true };
}
