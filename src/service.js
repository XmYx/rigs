import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RIGS_HOME } from './config.js';
import { APP_DIR, HOME, augmentedPath, isMac, isWin, run } from './util.js';

/** Autostart at login: launchd (macOS), systemd --user (Linux), Task Scheduler (Windows). */

const LABEL = 'dev.rigs.mesh';
const CLI = path.join(APP_DIR, 'bin', 'rigs.js');

function xml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

export async function installService() {
  const node = process.execPath;
  const logs = path.join(RIGS_HOME, 'logs');
  await fsp.mkdir(logs, { recursive: true });
  const envHome = process.env.RIGS_HOME ? { RIGS_HOME } : {};

  if (isMac) {
    const plist = path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const env = { PATH: augmentedPath(), HOME, ...envHome };
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(CLI)}</string><string>start</string></array>
  <key>WorkingDirectory</key><string>${xml(APP_DIR)}</string>
  <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`).join('')}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(path.join(logs, 'rigs.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logs, 'rigs.log'))}</string>
</dict></plist>
`;
    await fsp.mkdir(path.dirname(plist), { recursive: true });
    await fsp.writeFile(plist, body);
    const uid = os.userInfo().uid;
    await run('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { timeout: 10000 });
    const r = await run('launchctl', ['bootstrap', `gui/${uid}`, plist], { timeout: 10000 });
    return { ok: r.code === 0, how: 'launchd', file: plist, message: r.stderr.trim() };
  }

  if (isWin) {
    // A hidden VBS launcher keeps a console window from popping up at every login.
    const vbs = path.join(RIGS_HOME, 'rigs-launch.vbs');
    await fsp.writeFile(vbs, `Set sh = CreateObject("WScript.Shell")\r\nsh.Run """${node}"" ""${CLI}"" start", 0, False\r\n`);
    const ps = [
      `$a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"${vbs}"'`,
      `$t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME`,
      `$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 3650) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)`,
      `Register-ScheduledTask -TaskName 'RIGS Mesh' -Action $a -Trigger $t -Settings $s -Force | Out-Null`,
      `Start-ScheduledTask -TaskName 'RIGS Mesh'`,
    ].join('; ');
    const r = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeout: 30000 });
    return { ok: r.code === 0, how: 'Task Scheduler', file: vbs, message: (r.stderr || r.stdout).trim() };
  }

  const unitDir = path.join(HOME, '.config', 'systemd', 'user');
  const unit = path.join(unitDir, 'rigs.service');
  const envLines = [`Environment=PATH=${augmentedPath()}`, ...Object.entries(envHome).map(([k, v]) => `Environment=${k}=${v}`)];
  await fsp.mkdir(unitDir, { recursive: true });
  await fsp.writeFile(unit, `[Unit]
Description=RIGS mesh node
After=network-online.target tailscaled.service

[Service]
ExecStart="${node}" "${CLI}" start
WorkingDirectory=${APP_DIR}
${envLines.join('\n')}
Restart=always
RestartSec=3
StandardOutput=append:${path.join(logs, 'rigs.log')}
StandardError=append:${path.join(logs, 'rigs.log')}

[Install]
WantedBy=default.target
`);
  await run('systemctl', ['--user', 'daemon-reload'], { timeout: 15000 });
  const r = await run('systemctl', ['--user', 'enable', '--now', 'rigs.service'], { timeout: 20000 });
  await run('systemctl', ['--user', 'restart', 'rigs.service'], { timeout: 20000 });
  // Keep running after logout / at boot (needs polkit permission or sudo; the installer runs it with sudo).
  await run('loginctl', ['enable-linger', os.userInfo().username], { timeout: 10000 });
  return { ok: r.code === 0, how: 'systemd --user', file: unit, message: r.stderr.trim() };
}

export async function uninstallService() {
  if (isMac) {
    const plist = path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    await run('launchctl', ['bootout', `gui/${os.userInfo().uid}/${LABEL}`], { timeout: 10000 });
    await fsp.rm(plist, { force: true });
    return { ok: true };
  }
  if (isWin) {
    await run('powershell.exe', ['-NoProfile', '-Command', "Unregister-ScheduledTask -TaskName 'RIGS Mesh' -Confirm:$false"], { timeout: 20000 });
    return { ok: true };
  }
  await run('systemctl', ['--user', 'disable', '--now', 'rigs.service'], { timeout: 20000 });
  await fsp.rm(path.join(HOME, '.config', 'systemd', 'user', 'rigs.service'), { force: true });
  return { ok: true };
}

export function serviceInstalled() {
  if (isMac) return fs.existsSync(path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`));
  if (isWin) return fs.existsSync(path.join(RIGS_HOME, 'rigs-launch.vbs'));
  return fs.existsSync(path.join(HOME, '.config', 'systemd', 'user', 'rigs.service'));
}
