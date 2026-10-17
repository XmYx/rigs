import { isWin, run, sleep } from './util.js';

/**
 * Processes on this machine — list them and stop them, from any machine on the mesh (an app that locked up a
 * desktop, a runaway build). Killing by name never touches RIGS itself, its supervisor, or the command doing it.
 */

/** "1-02:03:04" / "02:03:04" / "03:04" → seconds. */
export function etimeSeconds(s) {
  const m = String(s || '').trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return 0;
  return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + Number(m[3]) * 60 + Number(m[4]);
}

export function parsePs(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) return null;
    const args = m[9];
    const exe = args.split(/\s+/)[0] || '';
    return { pid: Number(m[1]), ppid: Number(m[2]), user: m[3], cpu: Number(m[4]), mem: Number(m[5]), rssMB: Math.round(Number(m[6]) / 1024),
      uptimeSec: etimeSeconds(m[7]), state: m[8], name: exe.split('/').pop(), args };
  }).filter(Boolean);
}

async function all() {
  if (isWin) {
    const r = await run('powershell.exe', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize | ConvertTo-Json -Compress'], { timeout: 20000 });
    let j = [];
    try { j = JSON.parse(r.stdout || '[]'); } catch {}
    return [].concat(j).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, user: '', cpu: 0, mem: 0, rssMB: Math.round((p.WorkingSetSize || 0) / 2 ** 20),
      uptimeSec: 0, state: '', name: p.Name, args: p.CommandLine || p.Name }));
  }
  const r = await run('ps', ['-eo', 'pid=,ppid=,user=,pcpu=,pmem=,rss=,etime=,stat=,args='], { timeout: 15000 });
  return parsePs(r.stdout);
}

/** PIDs that must never be killed: this daemon, its ancestors (supervisor, service manager), init. */
function protectedPids(procs) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const keep = new Set([0, 1, process.pid]);
  for (let p = byPid.get(process.pid); p && p.ppid && !keep.has(p.ppid); p = byPid.get(p.ppid)) keep.add(p.ppid);
  keep.add(process.ppid);
  return keep;
}

/** Shells/commands RIGS itself is running right now (e.g. the mesh_exec that asked for the kill). */
function ownChildren(procs) {
  const kids = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of procs) if ((p.ppid === process.pid || kids.has(p.ppid)) && !kids.has(p.pid)) { kids.add(p.pid); grew = true; }
  }
  return kids;
}

export async function list({ filter = '', sort = 'cpu', limit = 80 } = {}) {
  const procs = await all();
  const re = filter ? new RegExp(filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
  const keep = protectedPids(procs);
  const out = procs.filter((p) => !re || re.test(p.args) || re.test(p.name)).map((p) => ({ ...p, protected: keep.has(p.pid) }));
  const key = { cpu: (p) => -p.cpu, mem: (p) => -p.rssMB, name: (p) => p.name.toLowerCase(), pid: (p) => p.pid, age: (p) => -p.uptimeSec }[sort] || ((p) => -p.cpu);
  out.sort((a, b) => { const x = key(a); const y = key(b); return x < y ? -1 : x > y ? 1 : 0; });
  return { total: procs.length, shown: Math.min(out.length, limit), processes: out.slice(0, limit) };
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/**
 * Stop processes by pid or by name/command-line match. TERM first; whatever is still there after `graceMs`
 * gets KILL (unless escalate=false). Returns what was stopped and what was refused.
 */
export async function kill({ pid, name, signal = 'TERM', escalate = true, graceMs = 3000 } = {}) {
  if (!pid && !name) throw new Error('give a pid or a name');
  const procs = await all();
  const keep = protectedPids(procs);
  const mine = ownChildren(procs);
  let targets;
  if (pid) targets = procs.filter((p) => p.pid === Number(pid));
  else {
    const re = new RegExp(String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    targets = procs.filter((p) => (re.test(p.name) || re.test(p.args)) && !mine.has(p.pid));
  }
  const refused = targets.filter((p) => keep.has(p.pid)).map((p) => ({ pid: p.pid, name: p.name, why: 'RIGS itself or a system process' }));
  targets = targets.filter((p) => !keep.has(p.pid));
  if (!targets.length) return { stopped: [], refused, message: pid ? `no process ${pid}` : `nothing matches "${name}"` };
  if (isWin) {
    for (const p of targets) await run('taskkill', ['/PID', String(p.pid), '/T', '/F'], { timeout: 15000 });
  } else {
    const sig = `SIG${String(signal).toUpperCase().replace(/^SIG/, '')}`;
    for (const p of targets) { try { process.kill(p.pid, sig); } catch {} }
    if (escalate && sig !== 'SIGKILL') {
      const until = Date.now() + graceMs;
      while (Date.now() < until && targets.some((p) => alive(p.pid))) await sleep(200);
      for (const p of targets) if (alive(p.pid)) { try { process.kill(p.pid, 'SIGKILL'); p.forced = true; } catch {} }
      await sleep(300);
    }
  }
  return {
    stopped: targets.filter((p) => !alive(p.pid)).map((p) => ({ pid: p.pid, name: p.name, forced: !!p.forced })),
    stillRunning: targets.filter((p) => alive(p.pid)).map((p) => ({ pid: p.pid, name: p.name })),
    refused,
  };
}
