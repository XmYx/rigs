import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR, run, spawnCmd, which } from './util.js';
import { refreshSessionEnv, guiEnv } from './desktop.js';
import { ControlRPC } from './control-rpc.js';
import { ControlError } from './control-error.js';

export function desktopName(value = '') {
  const name = value.toLowerCase();
  return ['gnome', 'kde', 'sway', 'hyprland', 'wlroots'].find((x) => name.includes(x)) || 'other';
}

/** All subprocess args are passed literally; no user text is interpolated into shell/script source. */
export function createLinuxAdapter({ runner = run, spawn = spawnCmd, find = which, refresh = refreshSessionEnv, environment = guiEnv } = {}) {
  let env;
  let selected = {};
  let displays = [];
  let commands = new AbortController();
  const heldKeys = new Set(), heldButtons = new Set();
  const rpc = new ControlRPC({ connect: async () => {
    await refresh();
    env = environment();
    if (!find('python3')) throw new ControlError('needs-permission', 'Install python3 and python3-gi');
    const child = spawn(find('python3'), ['-u', path.join(APP_DIR, 'scripts/control/rigs-control-linux.py')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.on('data', () => {}); // diagnostics are returned in the protocol; never retain typed text
    return { read: child.stdout, write: child.stdin, pid: child.pid, destroy: () => { child.stdin.end(); child.kill('SIGTERM'); }, onClose: (fn) => { child.once('error', fn); child.once('exit', fn); } };
  } });
  const command = async (cmd, args, opts = {}) => {
    const r = await runner(cmd, args, { env: env || environment(), timeout: 9000, signal: commands.signal, ...opts });
    if (r.code !== 0) throw new ControlError(r.code === -2 ? 'timeout' : 'unsupported', `${cmd}: ${r.stderr?.trim() || 'command failed'}`);
    return r.stdout;
  };
  const helper = async (op, args) => {
    // A dead helper may be started again for the NEXT call, never by replaying a possibly delivered op.
    await rpc.open();
    if (rpc.stream.selection !== selected) {
      await rpc.request('configure', selected);
      rpc.stream.selection = selected;
    }
    return rpc.request(op, args);
  };
  async function treeWindows() {
    if (selected.windows === 'sway') {
      const root = JSON.parse(await command('swaymsg', ['-r', '-t', 'get_tree']));
      const result = [];
      const walk = (n, display) => {
        if (n.type === 'output') display = n.name;
        if (n.pid && (n.app_id || n.window)) result.push({ id: String(n.id), title: n.name || '', app: n.app_id || n.window_properties?.class || '', pid: n.pid, display, bounds: n.rect, focused: !!n.focused, minimized: !!n.scratchpad_state && n.scratchpad_state !== 'none' });
        for (const c of [...(n.nodes || []), ...(n.floating_nodes || [])]) walk(c, display);
      };
      walk(root, null);
      return result;
    }
    if (selected.windows === 'hyprland') return JSON.parse(await command('hyprctl', ['-j', 'clients'])).map((w) => ({ id: w.address, title: w.title, app: w.class, pid: w.pid, display: String(w.monitor), bounds: { x: w.at[0], y: w.at[1], width: w.size[0], height: w.size[1] }, focused: w.focusHistoryID === 0, minimized: !!w.hidden }));
    const active = (await command('xdotool', ['getactivewindow'])).trim();
    return (await command('wmctrl', ['-lpG'])).trim().split('\n').filter(Boolean).map((line) => {
      const m = line.match(/^(\S+)\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+\S+\s*(.*)$/);
      if (!m) return null;
      return { id: m[1], pid: +m[3], title: m[8], app: '', display: null, bounds: { x: +m[4], y: +m[5], width: +m[6], height: +m[7] }, focused: BigInt(m[1]).toString() === active, minimized: +m[2] === -1 };
    }).filter(Boolean);
  }
  const xkey = (k) => ({ ctrl: 'Control_L', alt: 'Alt_L', super: 'Super_L', shift: 'Shift_L', enter: 'Return', esc: 'Escape', backspace: 'BackSpace', pageup: 'Prior', pagedown: 'Next', capslock: 'Caps_Lock', printscreen: 'Print', menu: 'Menu' })[k] || (/^f\d+$/.test(k) ? k.toUpperCase() : k.length > 1 ? k[0].toUpperCase() + k.slice(1) : k);
  return {
    events: rpc,
    async inspect() {
      await refresh(); env = environment();
      const session = env.XDG_SESSION_TYPE || (env.WAYLAND_DISPLAY ? 'wayland' : env.DISPLAY ? 'x11' : 'none');
      const tools = Object.fromEntries(['python3', 'gst-launch-1.0', 'grim', 'wtype', 'wlrctl', 'swaymsg', 'hyprctl', 'xdotool', 'wmctrl', 'import', 'scrot'].map((x) => [x, !!find(x)]));
      let facts = {}, locked = null; displays = [];
      if (session !== 'none' && tools.python3) {
        facts = await rpc.request('probe');
        locked = (await rpc.request('locked')).locked;
        // DisplayConfig is GNOME-specific; wlroots outputs below cover other compositors.
        if (facts.mutterScreenCast) displays = await rpc.request('displays');
      }
      if (tools.swaymsg) displays = JSON.parse(await command('swaymsg', ['-r', '-t', 'get_outputs'])).filter((o) => o.active).map((o, i) => ({ id: o.name, name: o.name, ...o.rect, width: o.current_mode.width, height: o.current_mode.height, scale: o.scale || 1, primary: i === 0 }));
      else if (tools.hyprctl) displays = JSON.parse(await command('hyprctl', ['-j', 'monitors'])).map((o, i) => ({ id: String(o.id), name: o.name, x: o.x, y: o.y, width: o.width, height: o.height, scale: o.scale, primary: i === 0 }));
      else if (session === 'x11' && tools.xdotool && !displays.length) {
        const [width, height] = (await command('xdotool', ['getdisplaygeometry'])).trim().split(/\s+/).map(Number);
        displays = [{ id: '0', name: 'X11 desktop', x: 0, y: 0, width, height, scale: 1, primary: true }];
      }
      let uinputWritable = false;
      try { fs.accessSync('/dev/uinput', fs.constants.W_OK); uinputWritable = true; } catch {}
      return { session, desktop: desktopName(env.XDG_CURRENT_DESKTOP || (tools.swaymsg ? 'sway' : tools.hyprctl ? 'hyprland' : '')), available: { ...facts, ...tools, uinputWritable }, locked, displays, helper: { kind: 'python', running: !!rpc.stream, pid: rpc.stream?.pid } };
    },
    async configure(next) { selected = { ...next }; if (next.displays?.length) displays = next.displays; },
    async request(op, a = {}) {
      if (op === 'locked' || op === 'release') {
        if (op === 'release' && selected.input === 'x11') {
          for (const k of heldKeys) await command('xdotool', ['keyup', k]);
          for (const b of heldButtons) await command('xdotool', ['mouseup', b]);
          heldKeys.clear(); heldButtons.clear(); return {};
        }
        return helper(op, a);
      }
      if (['windows', 'focus'].includes(op) && ['sway', 'hyprland', 'x11'].includes(selected.windows)) {
        if (op === 'windows') return treeWindows();
        if (selected.windows === 'sway') { if (!/^\d+$/.test(a.windowId)) throw new ControlError('bad-args', 'Invalid sway window id'); await command('swaymsg', ['-r', `[con_id=${a.windowId}] focus`]); }
        else if (selected.windows === 'hyprland') { if (!/^0x[\da-f]+$/i.test(a.windowId)) throw new ControlError('bad-args', 'Invalid Hyprland address'); await command('hyprctl', ['dispatch', 'focuswindow', `address:${a.windowId}`]); }
        else { if (!/^(0x[\da-f]+|\d+)$/i.test(a.windowId)) throw new ControlError('bad-args', 'Invalid X11 window id'); await command('xdotool', ['windowactivate', '--sync', a.windowId]); }
        return { ok: true, id: a.windowId };
      }
      if (op === 'shot' && ['grim', 'x11'].includes(selected.capture)) {
        if (a.window) throw new ControlError('unsupported', 'Use a region for capture of this window');
        if (selected.capture === 'grim') {
          const d = displays.find((d) => d.id === a.display || d.name === a.display) || (!a.display ? displays.find((d) => d.primary) || displays[0] : null);
          if (!d) throw new ControlError('bad-args', 'Unknown output; choose one from control.status().displays');
          const args = ['-t', a.format === 'jpeg' ? 'jpeg' : 'png'];
          const sourceWidth = a.region?.width || d.width;
          args.push('-o', d.name, '-s', String((d.scale || 1) * Math.min(1, a.maxWidth ? a.maxWidth / sourceWidth : 1)));
          if (a.format === 'jpeg') args.push('-q', String(a.quality));
          if (a.region) { const r = a.region, scale = d.scale || 1; args.push('-g', `${d.x + r.x / scale},${d.y + r.y / scale} ${r.width / scale}x${r.height / scale}`); }
          args.push(a.file); await command('grim', args);
          return { file: a.file, display: d.id, sourceWidth, sourceHeight: a.region?.height || d.height };
        } else {
          if (a.region || a.maxWidth || a.display && a.display !== '0') throw new ControlError('unsupported', 'X11 command adapter captures the whole desktop');
          if (find('import')) await command('import', ['-window', 'root', a.file]);
          else await command('scrot', [a.file]);
        }
        return { file: a.file, display: a.display || '0' };
      }
      if (['move', 'button', 'scroll', 'type', 'key'].includes(op) && selected.input === 'x11') {
        const button = { left: '1', middle: '2', right: '3' }[a.button];
        if (op === 'move') await command('xdotool', ['mousemove', '--sync', String(Math.round(a.x)), String(Math.round(a.y))]);
        if (op === 'button') { if (a.down) heldButtons.add(button); await command('xdotool', [a.down ? 'mousedown' : 'mouseup', button]); if (!a.down) heldButtons.delete(button); }
        if (op === 'scroll') for (const [v, pos, neg] of [[a.dy, '5', '4'], [a.dx, '7', '6']]) if (v) await command('xdotool', ['click', '--repeat', String(Math.abs(v)), v > 0 ? pos : neg]);
        if (op === 'key') { const k = xkey(a.key); if (a.down) heldKeys.add(k); await command('xdotool', [a.down ? 'keydown' : 'keyup', k]); if (!a.down) heldKeys.delete(k); }
        if (op === 'type') { await command('xdotool', ['type', '--clearmodifiers', '--delay', String(a.delayMs), '--file', '-'], { input: a.text }); return { typed: a.text.length, via: 'unicode' }; }
        return {};
      }
      if (selected.input === 'wlroots') {
        if (op === 'pointer') {
          if (['drag', 'down', 'up'].includes(a.action)) throw new ControlError('unsupported', 'Held pointer buttons need uinput or portal; wlrctl supports clicks only');
          if (a.x != null) {
            const d = displays.find((d) => d.id === a.display) || (!a.display ? displays.find((d) => d.primary) || displays[0] : null);
            if (!d) throw new ControlError('bad-args', 'Unknown display');
            const x = d.x + a.x / (d.scale || 1), y = d.y + a.y / (d.scale || 1);
            if (find('swaymsg')) await command('swaymsg', ['-r', 'seat', '-', 'cursor', 'set', String(x), String(y)]);
            else if (find('hyprctl')) await command('hyprctl', ['dispatch', 'movecursor', String(Math.round(x)), String(Math.round(y))]);
            else throw new ControlError('unsupported', 'Absolute pointer motion needs sway, Hyprland, uinput or portal');
          }
          if (a.action === 'click') for (let i = 0; i < a.count; i++) await command('wlrctl', ['pointer', 'click', a.button]);
          if (a.action === 'scroll') await command('wlrctl', ['pointer', 'scroll', String(a.dy * 15), String(a.dx * 15)]);
          return { x: a.x, y: a.y, display: a.display };
        }
        if (op === 'type') { await command('wtype', ['-d', String(a.delayMs), '-'], { input: a.text }); return { typed: a.text.length, via: 'unicode' }; }
        if (op === 'combo') {
          const args = [], mods = a.keys.slice(0, -1), key = a.keys.at(-1);
          for (let i = 0; i < a.repeat; i++) { for (const m of mods) args.push('-M', m); args.push('-P', xkey(key), '-p', xkey(key)); for (const m of [...mods].reverse()) args.push('-m', m); }
          await command('wtype', args); return {};
        }
        if (op === 'release') return {};
      }
      return helper(op, a);
    },
    async stop() {
      commands.abort(); commands = new AbortController();
      rpc.close();
      if (heldKeys.size || heldButtons.size) {
        for (const k of [...heldKeys]) { try { await command('xdotool', ['keyup', k]); } catch {} }
        for (const b of [...heldButtons]) { try { await command('xdotool', ['mouseup', b]); } catch {} }
        heldKeys.clear(); heldButtons.clear();
      }
    },
  };
}
