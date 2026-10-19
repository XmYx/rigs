import { config } from './config.js';
import { isLinux, log, run, spawnCmd, which } from './util.js';

/**
 * Keep this machine reachable: a mesh node that idle-sleeps drops off Tailscale and every peer loses it.
 * The installed server holds a sleep inhibitor for as long as it runs; nothing is changed
 * system-wide except GNOME's "suspend when idle on AC power", which would otherwise override it.
 * Off with `keepAwake: false` in config.json or RIGS_NO_KEEPAWAKE=1.
 */

/** The inhibitor process for this platform, tied to `pid` (it ends when that process does). Null when unsupported. */
export function keepAwakeCommand(platform, pid) {
  if (platform === 'darwin') return { cmd: 'caffeinate', args: ['-i', '-s', '-w', String(pid)] };
  if (platform === 'linux') {
    return {
      cmd: 'systemd-inhibit',
      args: ['--what=sleep:idle', '--who=RIGS', '--why=Keep the RIGS mesh node reachable', '--mode=block',
        'sh', '-c', `while kill -0 ${pid} 2>/dev/null; do sleep 30; done`],
    };
  }
  if (platform === 'win32') {
    // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, refreshed while the supervisor lives.
    const ps = `$k = Add-Type -Name P -Namespace RigsAwake -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { [void]$k::SetThreadExecutionState([uint32]2147483649); Start-Sleep -Seconds 30 }`;
    return { cmd: 'powershell', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps] };
  }
  return null;
}

export function keepAwakeEnabled() {
  if (process.env.RIGS_NO_KEEPAWAKE) return false;
  try { return config().keepAwake !== false; } catch { return true; }
}

let child = null;

/** Start (or restart, if it died) the inhibitor for this process. Safe to call repeatedly. */
export async function startKeepAwake(pid = process.pid) {
  if (!keepAwakeEnabled() || (child && child.exitCode === null)) return;
  const c = keepAwakeCommand(process.platform, pid);
  const exe = c && which(c.cmd);
  if (!exe) return;
  try {
    child = spawnCmd(exe, c.args, { stdio: 'ignore', windowsHide: true });
    child.on?.('error', () => { child = null; });
    child.unref?.();
  } catch (e) {
    log(`keep-awake: could not start ${c.cmd}: ${e.message}`);
    return;
  }
  if (isLinux) await relaxGnomeIdleSuspend();
}

/** GNOME's own idle suspend on AC power ignores nothing we can hold as a user; switch just that one setting off. */
async function relaxGnomeIdleSuspend() {
  if (!which('gsettings')) return;
  const key = ['org.gnome.settings-daemon.plugins.power', 'sleep-inactive-ac-type'];
  const r = await run('gsettings', ['get', ...key], { timeout: 5000 });
  const v = r.code === 0 ? r.stdout.trim().replace(/'/g, '') : '';
  if (v && v !== 'nothing') {
    const s = await run('gsettings', ['set', ...key, 'nothing'], { timeout: 5000 });
    if (s.code === 0) log(`keep-awake: GNOME idle suspend on AC power was '${v}' — set to 'nothing' so this node stays on the mesh`);
  }
}
