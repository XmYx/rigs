import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME, isLinux, isMac, isWin, platformName, run } from './util.js';

let lastCpu = os.cpus();
let cpuPct = 0;

function sampleCpu() {
  const now = os.cpus();
  let idle = 0;
  let total = 0;
  now.forEach((c, i) => {
    const p = lastCpu[i]?.times || c.times;
    const t = c.times;
    const dIdle = t.idle - p.idle;
    const dTotal = (t.user - p.user) + (t.nice - p.nice) + (t.sys - p.sys) + (t.irq - p.irq) + dIdle;
    idle += dIdle;
    total += dTotal;
  });
  lastCpu = now;
  if (total > 0) cpuPct = Math.round((1 - idle / total) * 100);
}
setInterval(sampleCpu, 3000).unref();

async function macMemUsed() {
  // os.freemem() on macOS ignores reclaimable cache; vm_stat gives a truer "used" figure.
  const r = await run('vm_stat', [], { timeout: 3000 });
  if (r.code !== 0) return null;
  const page = Number((r.stdout.match(/page size of (\d+)/) || [])[1] || 16384);
  const get = (k) => Number((r.stdout.match(new RegExp(k + ':\\s+(\\d+)')) || [])[1] || 0);
  return (get('Pages active') + get('Pages wired down') + get('Pages occupied by compressor')) * page;
}

export async function stats() {
  const total = os.totalmem();
  let used = total - os.freemem();
  if (isMac) used = (await macMemUsed()) ?? used;
  return {
    cpu: cpuPct,
    cores: os.cpus().length,
    load: os.loadavg().map((n) => Math.round(n * 100) / 100),
    memTotal: total,
    memUsed: used,
    uptime: Math.round(os.uptime()),
  };
}

let gpuCache = null;

export async function gpu() {
  if (gpuCache) return gpuCache;
  let names = [];
  try {
    if (isMac) {
      const r = await run('system_profiler', ['SPDisplaysDataType', '-json'], { timeout: 10000 });
      const j = JSON.parse(r.stdout || '{}');
      names = (j.SPDisplaysDataType || []).map((g) => g.sppci_model || g._name).filter(Boolean);
    } else if (isWin) {
      const r = await run('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController).Name'], { timeout: 10000 });
      names = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    } else {
      const r = await run('sh', ['-c', "lspci 2>/dev/null | grep -iE 'vga|3d|display' | sed 's/^[^:]*: //'"], { timeout: 5000 });
      names = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    }
  } catch {}
  gpuCache = names;
  return names;
}

function linuxDesktop() {
  return {
    session: process.env.XDG_SESSION_TYPE || (process.env.WAYLAND_DISPLAY ? 'wayland' : process.env.DISPLAY ? 'x11' : 'tty'),
    desktop: process.env.XDG_CURRENT_DESKTOP || '',
  };
}

let distroCache = null;
function distro() {
  if (distroCache !== null) return distroCache;
  distroCache = '';
  if (isLinux) {
    try {
      const t = fs.readFileSync('/etc/os-release', 'utf8');
      distroCache = (t.match(/^PRETTY_NAME="?([^"\n]+)"?/m) || [])[1] || '';
    } catch {}
  } else if (isMac) {
    distroCache = 'macOS ' + os.release();
  } else if (isWin) {
    distroCache = 'Windows ' + os.release();
  }
  return distroCache;
}

export async function systemInfo() {
  return {
    platform: platformName(),
    arch: process.arch,
    hostname: os.hostname(),
    user: os.userInfo().username,
    home: HOME,
    distro: distro(),
    cpuModel: os.cpus()[0]?.model || '',
    gpus: await gpu(),
    display: isLinux ? linuxDesktop() : { session: isMac ? 'quartz' : 'windows', desktop: '' },
    node: process.version,
    pathSep: path.sep,
  };
}
