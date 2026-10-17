import path from 'node:path';
import { APP_DIR, spawnCmd } from './util.js';
import { ControlRPC } from './control-rpc.js';

export function createWindowsAdapter({ spawn = spawnCmd } = {}) {
  const rpc = new ControlRPC({ connect: async () => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(APP_DIR, 'scripts/control/rigs-control.ps1')], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.on('data', () => {});
    return { read: child.stdout, write: child.stdin, pid: child.pid, destroy: () => {
      // The helper reads stop on an independent thread, releases input and exits before forced teardown.
      if (!child.stdin.destroyed) child.stdin.end(JSON.stringify({ id: -1, op: 'stop' }) + '\n');
      const timer = setTimeout(() => child.kill(), 1500); timer.unref?.();
      child.once('exit', () => clearTimeout(timer));
    }, onClose: (fn) => { child.once('error', fn); child.once('exit', fn); } };
  } });
  return {
    events: rpc,
    async inspect() {
      const result = await rpc.request('probe');
      return { session: 'windows', desktop: '', available: { windowsHelper: true }, ...result, helper: { kind: 'powershell', running: true, pid: rpc.stream?.pid } };
    },
    async configure() {},
    request: (op, args) => rpc.request(op, args),
    async stop() {
      try { if (rpc.stream) await rpc.request('stop'); } finally { rpc.close(); }
    },
  };
}
