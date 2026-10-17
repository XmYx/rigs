import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { ControlRPC } from './control-rpc.js';
import { ControlError } from './control-error.js';

/** The LaunchAgent/helper installation and TCC grant flow live outside this adapter (t6). */
export function createMacAdapter({ home, connect = net.createConnection } = {}) {
  const rpc = new ControlRPC({ connect: () => new Promise((resolve, reject) => {
    const socketPath = path.join(home, 'run', 'control.sock');
    let token;
    try { token = fs.readFileSync(path.join(home, 'run', 'control.token'), 'utf8').trim(); }
    catch { reject(new ControlError('needs-permission', 'RIGS Control helper is not installed or running', { kind: 'helper', text: 'Install/start RIGS Control.app, then grant Screen Recording and Accessibility.' })); return; }
    const socket = connect(socketPath);
    const timer = setTimeout(() => { socket.destroy(); reject(new ControlError('timeout', 'RIGS Control socket did not connect')); }, 3000);
    socket.once('error', (e) => { clearTimeout(timer); reject(new ControlError('needs-permission', e.message)); });
    socket.once('connect', () => { clearTimeout(timer); resolve({ read: socket, write: socket, token, destroy: () => socket.destroy(), onClose: (fn) => socket.once('close', fn) }); });
  }) });
  return {
    events: rpc,
    async inspect() {
      // Status never launches an app or causes a permission prompt.
      if (!fs.existsSync(path.join(home, 'run', 'control.sock'))) return { session: 'quartz', desktop: '', available: {}, displays: [], locked: null };
      const result = await rpc.request('probe');
      return { session: 'quartz', desktop: '', available: { macHelper: true }, ...result };
    },
    request: (op, args) => rpc.request(op, args),
    async configure() {},
    async stop() {
      // Ask the independent helper to release and stop its session before disconnecting.
      try { if (rpc.stream) await rpc.request('stop'); } finally { rpc.close(); }
    },
  };
}
