import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { ControlRPC } from './control-rpc.js';
import { ControlError } from './control-error.js';
import { decideMacHelper } from './access.js';
import { helperPaths, readHelperState, stopMacHelper } from './control-mac-helper.js';

/**
 * Talks to RIGS Control.app (scripts/control/macos/RigsControl.swift) over RIGS_HOME/run/control.sock. Building,
 * the LaunchAgent and the grant flow live in control-mac-helper.js; first-run setup starts it (control-setup.js).
 */
export function createMacAdapter({ home, connect = net.createConnection, stopHelper = () => stopMacHelper({ home }) } = {}) {
  const socketPath = path.join(home, 'run', 'control.sock');
  const tokenPath = path.join(home, 'run', 'control.token');
  const notRunning = { kind: 'helper', text: 'Start RIGS Control: click Grant in JARVIS → Access & control, or run `rigs control helper install` on this Mac. Then switch it on in Screen Recording and Accessibility.' };
  const open = () => new Promise((resolve, reject) => {
    let token;
    try { token = fs.readFileSync(tokenPath, 'utf8').trim(); }
    catch { reject(new ControlError('needs-permission', 'RIGS Control helper is not installed or running', notRunning)); return; }
    const socket = connect(socketPath);
    const timer = setTimeout(() => { socket.destroy(); reject(new ControlError('timeout', 'RIGS Control socket did not connect')); }, 3000);
    socket.once('error', (e) => { clearTimeout(timer); reject(new ControlError('needs-permission', `RIGS Control helper is not running (${e.code || e.message})`, notRunning)); });
    socket.once('connect', () => { clearTimeout(timer); resolve({ socket, token }); });
  });
  const rpc = new ControlRPC({ connect: async () => {
    const { socket, token } = await open();
    return { read: socket, write: socket, token, destroy: () => socket.destroy(), onClose: (fn) => socket.once('close', fn) };
  } });

  // The kill hotkey (⌃⌥⌘⎋) must work between leases too, when the action connection is closed: keep a second,
  // authenticated connection that only listens for helper events.
  let watcher = null, watching = true;
  async function watch() {
    if (watcher || !watching) return;
    watcher = 'opening';
    try {
      const { socket, token } = await open();
      if (!watching) { socket.destroy(); watcher = null; return; }
      watcher = socket;
      socket.write(JSON.stringify({ id: 0, op: 'hello', token }) + '\n');
      createInterface({ input: socket }).on('line', (line) => {
        let m;
        try { m = JSON.parse(line); } catch { return; }
        if (['hotkey', 'closed'].includes(m.event)) rpc.emit('event', m);
      });
      socket.on('error', () => {});
      socket.once('close', () => { watcher = null; if (watching) setTimeout(watch, 5000).unref(); });
    } catch { watcher = null; }
  }

  return {
    events: rpc,
    async inspect() {
      // Status never launches an app or causes a permission prompt: it only asks a helper that is already running.
      const app = helperPaths(home).app, regrant = !!readHelperState(home).regrant;
      const missing = (error) => ({ session: 'quartz', desktop: '', available: {}, displays: [], locked: null, permissions: decideMacHelper({ running: false, app, error }), helper: { kind: 'mac-helper', running: false } });
      if (!fs.existsSync(socketPath)) return missing(fs.existsSync(app) ? 'stopped' : 'not installed');
      let result;
      try { result = await rpc.request('probe'); } catch (e) {
        if (e.code === 'needs-permission' || e.code === 'no-session') return missing(e.message);
        throw e;
      }
      watching = true; watch();
      return {
        session: 'quartz', desktop: '', available: { macHelper: true }, locked: result.locked ?? null, displays: result.displays || [],
        helper: result.helper || { kind: 'mac-helper', running: true },
        permissions: decideMacHelper({ running: true, grants: result.grants, app: result.helper?.path || app, regrant }),
      };
    },
    request: (op, args) => rpc.request(op, args),
    async configure() {},
    async stop() {
      // Ask the independent helper to release everything it holds before disconnecting; the helper keeps running.
      try { if (rpc.stream) await rpc.request('stop'); } finally { rpc.close(); }
    },
    /** Kill switch / control off: also unload the LaunchAgent, so nothing holding the grants runs while control is off. */
    async shutdown() {
      watching = false;
      if (watcher && watcher !== 'opening') watcher.destroy();
      try { await this.stop(); } catch {}
      await stopHelper();
    },
  };
}
