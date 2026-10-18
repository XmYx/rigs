import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config, saveConfig, RIGS_HOME } from './config.js';
import { platformName } from './util.js';
import * as access from './access.js';
import { createLinuxAdapter } from './control-linux.js';
import { createMacAdapter } from './control-mac.js';
import { createWindowsAdapter } from './control-win.js';
import { ControlError } from './control-error.js';
export { ControlError } from './control-error.js';

/** Selection uses facts only. A forced backend never silently falls back to a different one. */
export function selectBackend({ platform, session, desktop = '', available: a = {}, force = 'auto' } = {}) {
  let capture = null, input = null, windows = null;
  const mac = ['mac', 'darwin'].includes(platform), win = ['windows', 'win32'].includes(platform);
  const mutter = a.gi && a.mutterScreenCast > 0 && a.mutterRemoteDesktop > 0;
  const portal = a.gi && a.portalScreenCast > 0 && a.portalRemoteDesktop > 0;
  const forced = force && force !== 'auto';
  if (mac) {
    if ((!forced || force === 'mac-helper') && a.macHelper) capture = input = windows = 'mac-helper';
  } else if (win) {
    if ((!forced || force === 'windows') && a.windowsHelper) capture = input = windows = 'windows';
  } else if (session === 'wayland') {
    const use = forced ? force : mutter ? 'mutter' : a.grim ? 'wlroots' : 'portal';
    if (use === 'mutter' && mutter) { capture = a['gst-launch-1.0'] ? 'mutter' : null; input = 'mutter'; }
    if (use === 'portal' && portal) { capture = a['gst-launch-1.0'] ? 'portal' : null; input = 'portal'; }
    if (use === 'wlroots') { capture = a.grim ? 'grim' : null; input = a.uinputWritable ? 'uinput' : a.wtype && a.wlrctl ? 'wlroots' : null; }
    if (use === 'uinput' && a.uinputWritable) { input = 'uinput'; capture = mutter && a['gst-launch-1.0'] ? 'mutter' : a.grim ? 'grim' : portal && a['gst-launch-1.0'] ? 'portal' : null; }
    if (!forced && !input) input = a.uinputWritable ? 'uinput' : portal ? 'portal' : null;
    windows = a.rigsExtension ? 'rigs-extension' : a.swaymsg ? 'sway' : a.hyprctl ? 'hyprland' : a.atspi ? 'atspi' : null;
  } else if (session === 'x11' && (!forced || force === 'x11' || force === 'uinput')) {
    capture = a.import || a.scrot ? 'x11' : null;
    input = force === 'uinput' ? a.uinputWritable ? 'uinput' : null : a.xdotool ? 'x11' : a.uinputWritable ? 'uinput' : null;
    windows = a.wmctrl && a.xdotool ? 'x11' : a.atspi ? 'atspi' : null;
  }
  return { capture, input, windows, missing: Object.entries({ capture, input, windows }).filter(([, v]) => !v).map(([k]) => k) };
}

/**
 * The permission an operation needs. Pure. macOS lists windows with CGWindowList, whose titles need Screen Recording;
 * focusing a window goes through AX and needs Accessibility. Elsewhere the window backend needs accessibility.
 */
export function permissionFor(op, backendKey, platform) {
  if (backendKey === 'capture' || (op === 'windows' && ['mac', 'darwin'].includes(platform))) return 'screenCapture';
  return backendKey === 'windows' ? 'accessibility' : 'input';
}

const ALIASES = { control: 'ctrl', option: 'alt', cmd: 'super', command: 'super', win: 'super', meta: 'super', return: 'enter', escape: 'esc' };
const NAMED = new Set('enter tab esc space backspace delete insert up down left right home end pageup pagedown capslock printscreen menu'.split(' '));
export function parseCombo(combo, platform = platformName()) {
  if (typeof combo !== 'string' || !combo || combo.length > 100) throw new ControlError('bad-args', 'combo must name a key or shortcut');
  if (combo === '+') return ['+'];
  // A trailing '++' means the plus key itself, e.g. 'ctrl++' is ctrl and plus.
  const plusKey = combo.endsWith('++');
  const parts = (plusKey ? combo.slice(0, -2) : combo).toLowerCase().split('+').map((x) => x.trim()).map((x) => x === 'mod' ? ['mac', 'darwin'].includes(platform) ? 'super' : 'ctrl' : ALIASES[x] || x);
  const key = plusKey ? '+' : parts.pop();
  if (!key || !(NAMED.has(key) || /^f([1-9]|1\d|2[0-4])$/.test(key) || [...key].length === 1) || parts.some((x) => !['ctrl', 'alt', 'shift', 'super'].includes(x)) || new Set(parts).size !== parts.length) throw new ControlError('bad-args', 'Unknown key or modifier in combo');
  return [...parts, key];
}

const finite = (v, name, min = 0, max = 100000) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new ControlError('bad-args', `${name} must be a number from ${min} to ${max}`);
  return v;
};
const integer = (v, name, min, max) => { finite(v, name, min, max); if (!Number.isInteger(v)) throw new ControlError('bad-args', `${name} must be an integer`); return v; };
const callerInfo = (c = {}) => Object.fromEntries(['via', 'who', 'from', 'agent', 'session', 'seat', 'cwd', 'human'].filter((k) => c[k] != null).map((k) => [k, typeof c[k] === 'string' ? c[k].slice(0, 1000) : c[k] === true]));
/**
 * Who holds the lease: an agent session (or OpenRig seat), or the person, on the machine where the call entered the mesh.
 * Never the transport identity (`who` is `local`, `peer` or the tailnet login depending on the path), so one caller
 * cannot lock itself out by reaching the machine another way. Pure.
 */
export const holderKey = (c = {}) => JSON.stringify([c.from || '', c.agent && c.human !== true ? c.agent : 'human', c.session || c.seat || '']);

const GRANT_NAMES = {
  mac: { screenCapture: 'Screen Recording', accessibility: 'Accessibility', input: 'Accessibility' },
  linux: { screenCapture: 'screen capture', accessibility: 'the window list (accessibility)', input: 'input injection' },
};

/**
 * The refusal text for a missing OS grant: which grant, for which app or binary, on which machine. The `fix` that
 * travels with it says how to grant it. Pure.
 */
export function permissionMessage(op, key, permission = {}, { platform, node } = {}) {
  const names = GRANT_NAMES[['mac', 'darwin'].includes(platform) ? 'mac' : 'linux'];
  const grant = names[permission.fix?.permission || key] || names[key] || key;
  const app = permission.fix?.app;
  const holder = app ? ` for ${path.basename(app)} (${app})` : permission.via ? ` (checked via ${permission.via})` : '';
  return `${op} needs ${grant}${holder}, which is not granted${node ? ` on ${node}` : ''}`;
}

export function imageSize(data) {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (data[0] === 0xff && data[1] === 0xd8) {
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) { i++; continue; }
      const marker = data[i + 1];
      if ([0xc0, 0xc1, 0xc2].includes(marker)) return { height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7) };
      const len = data.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
  }
  throw new ControlError('error', 'Helper did not produce a PNG or JPEG image');
}

/** Injectable instance: tests exercise policy without spawning a process or reading owner config. */
export function createControl({ home = RIGS_HOME, getConfig = config, persistConfig = saveConfig, platform = platformName(), adapter, permissions = () => access.status(), now = Date.now, timeoutMs = 10000 } = {}) {
  adapter ||= platform === 'mac' ? createMacAdapter({ home }) : platform === 'windows' ? createWindowsAdapter() : createLinuxAdapter();
  const events = new EventEmitter();
  const stateFile = path.join(home, 'control-state.json'), logFile = path.join(home, 'logs/control.jsonl');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  let lease = null, leaseTimer, cached, inspecting, serial = Promise.resolve(), generation = 0;
  const active = new Set();
  function revoke(message) {
    generation++; cached = null;
    for (const reject of active) reject(new ControlError('off', message));
  }
  const shots = new Map(), rates = { shots: [], actions: [] };
  const settings = () => getConfig().control || {};
  const saveState = () => {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const temp = stateFile + `.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temp, stateFile);
    fs.chmodSync(stateFile, 0o600);
  };
  function audit(op, args, caller, ok, started, error, backend) {
    const line = { ts: new Date(now()).toISOString(), node: getConfig().name, op, ok, ms: now() - started, caller: callerInfo(caller), args, lease: lease?.id || null, backend: backend || null, ...(error ? { error: { code: error.code || 'error', ...(op === 'type' ? {} : { message: error.message }) } } : {}) };
    fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
    if (fs.existsSync(logFile) && fs.statSync(logFile).size >= 5 * 1024 * 1024) {
      if (fs.existsSync(logFile + '.1')) fs.renameSync(logFile + '.1', logFile + '.2');
      fs.renameSync(logFile, logFile + '.1');
    }
    fs.appendFileSync(logFile, JSON.stringify(line) + '\n', { mode: 0o600 });
    fs.chmodSync(logFile, 0o600);
    events.emit('action', line);
  }
  async function endLease(reason) {
    clearTimeout(leaseTimer);
    if (!lease) return;
    const old = lease; lease = null;
    events.emit('lease', { ...old, phase: 'end', reason });
  }
  function touchLease(caller) {
    const t = now();
    if (!lease) {
      lease = { id: crypto.randomUUID(), holder: callerInfo(caller), since: t, lastAt: t, actions: 0 };
      events.emit('lease', { ...lease, phase: 'start' });
    }
    lease.lastAt = t;
    clearTimeout(leaseTimer);
    leaseTimer = setTimeout(() => {
      // Revoke before waiting for the helper, so queued calls cannot inherit a stale controller.
      revoke('Screen lease expired'); endLease('idle'); adapter.stop().catch(() => {});
    }, Math.max(1, settings().leaseIdleSec ?? 60) * 1000);
    leaseTimer.unref?.();
  }
  async function inspect(force = false) {
    if (!force && cached && now() - cached.at < 5000) return cached.value;
    if (inspecting) return inspecting;
    inspecting = (async () => {
      const info = await adapter.inspect();
      const backend = selectBackend({ platform, ...info, force: settings().backend });
      const result = { ...info, backend, permissions: info.permissions || await permissions() };
      cached = { at: now(), value: result };
      return result;
    })().finally(() => { inspecting = null; });
    return inspecting;
  }
  async function status({ force = false } = {}) {
    let info;
    try { info = await inspect(force); }
    catch (e) { info = { session: platform === 'mac' ? 'quartz' : platform === 'windows' ? 'windows' : 'none', desktop: '', displays: [], locked: null, backend: { capture: null, input: null, windows: null, missing: ['capture', 'input', 'windows'] }, permissions: {}, error: { code: e.code || 'error', message: e.message } }; }
    const s = settings(), enabled = !!s.enabled && !state.killed, input = enabled && !!s.input;
    return { node: getConfig().name, platform, session: info.session, desktop: info.desktop, enabled, input, killed: state.killed || null, backend: { ...info.backend, helper: info.helper || null }, permissions: info.permissions, ready: { see: enabled && !!info.backend.capture && info.locked === false && info.permissions?.screenCapture?.ok !== false, act: input && !!info.backend.input && info.locked === false && info.permissions?.input?.ok !== false }, displays: info.displays || [], locked: info.locked, lease: lease ? structuredClone(lease) : null, needs: access.missingGrants(info.permissions, platform), ...(info.error ? { error: info.error } : {}) };
  }
  async function gate(caller, act) {
    const s = settings();
    if (!s.enabled || state.killed) throw new ControlError('off', 'Screen access is off on this machine (switched off or stopped). A person can switch it back on in JARVIS → Access & control.');
    if (act && !s.input) throw new ControlError('input-off', 'Input control is off on this machine.');
    if (s.allowFrom?.length && !s.allowFrom.includes(caller.from)) throw new ControlError('not-allowed', 'Caller node is not in control.allowFrom');
    if (lease && now() - lease.lastAt >= (s.leaseIdleSec ?? 60) * 1000) { await endLease('idle'); await adapter.stop(); cached = null; }
    if (lease && holderKey(lease.holder) !== holderKey(caller)) throw new ControlError('busy', `Screen lease is held by ${lease.holder.agent || lease.holder.who || 'another caller'} on ${lease.holder.from || 'this machine'}`);
    // The lease is only checked here. perform() takes it once every other check passed, so a refused call never holds it.
  }
  /** `dryRun`: run every check a real call runs (switches, allowFrom, lease, lock, backend, permission), touch nothing. */
  function perform(op, args, caller, act, backendKey, fn, { dryRun = false } = {}) {
    caller = callerInfo(caller);
    const submitted = generation;
    const task = serial.then(async () => {
      const started = now(); let backend, timer, cancel, opened = false, touched = false;
      try {
        if (submitted !== generation) throw new ControlError('off', 'Control was stopped before this action ran');
        await gate(caller, act);
        // Fail closed before touching the desktop when the required audit cannot be written.
        fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
        const auditFd = fs.openSync(logFile, 'a', 0o600); fs.closeSync(auditFd);
        const canceled = new Promise((_, reject) => { cancel = reject; active.add(reject); });
        const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
          generation++; cached = null; adapter.stop().catch(() => {});
          reject(new ControlError('timeout', `Control ${op} exceeded ${timeoutMs} ms; helper stopped`));
        }, timeoutMs); });
        const work = (async () => {
          const info = await inspect();
          if (submitted !== generation) throw new ControlError('off', 'Control stopped');
          if (info.session === 'none') throw new ControlError('no-session', 'No graphical session is reachable');
          const request = async (op, args) => {
            if (submitted !== generation) throw new ControlError('off', 'Control stopped');
            const result = await adapter.request(op, args);
            if (submitted !== generation) throw new ControlError('off', 'Control stopped');
            return result;
          };
          opened = true;
          await adapter.configure({ ...info.backend, displays: info.displays, restoreToken: state.restoreToken });
          // Always re-probe lock immediately before acting, even when status was cached.
          const lock = await request('locked');
          if (lock.locked !== false) throw new ControlError('locked', lock.locked ? 'The screen is locked' : 'Cannot verify that the screen is unlocked');
          const key = permissionFor(op, backendKey, platform), permission = info.permissions[key];
          const chosen = info.backend[backendKey];
          // macOS has one backend, the RIGS Control helper: when it is not running, say how to start it.
          if (!chosen && platform === 'mac' && permission?.fix) throw new ControlError('needs-permission', `RIGS Control is not running on ${getConfig().name}, so ${op} is not possible`, permission.fix);
          if (!chosen) throw new ControlError('unsupported', `No ${backendKey} backend is available for this desktop`, { kind: 'backend', text: `Install/configure a supported ${backendKey} backend; see docs/full-access.md` });
          if (permission?.ok === false) throw new ControlError('needs-permission', permissionMessage(op, key, permission, { platform, node: getConfig().name }), permission.fix);
          backend = chosen;
          if (dryRun) return { ok: true, op, dryRun: true, backend, permission: { [key]: permission?.ok ?? null }, lease: lease ? callerInfo(lease.holder) : null };
          // A refused call must not use up the budget either.
          const bucket = rates[op === 'screenshot' ? 'shots' : 'actions'];
          while (bucket.length && now() - bucket[0] >= 60000) bucket.shift();
          const max = op === 'screenshot' ? settings().maxShotsPerMin ?? 30 : settings().maxActionsPerMin ?? 120;
          if (bucket.length >= max) throw new ControlError('rate', 'Control rate limit reached; try again in a minute');
          bucket.push(now());
          // Only now, about to touch the desktop, does the call take (or renew) the lease.
          touchLease(caller); touched = true;
          const result = await fn(info, request);
          if (submitted !== generation) throw new ControlError('off', 'Control was stopped during this action');
          lease.actions++;
          touchLease(caller);
          return result;
        })();
        const result = await Promise.race([work, deadline, canceled]);
        // Nothing holds a lease to idle the helper out later: a dry run leaves it as it found it.
        if (dryRun && !lease) { try { await adapter.stop(); } catch {} }
        audit(dryRun ? 'check' : op, dryRun ? { op, ...args } : args, caller, true, started, null, backend);
        return result;
      } catch (e) {
        // An error must never leave a pressed key/button behind. Policy refusals do not touch the device; a refusal
        // after the helper was opened stops it when no lease would idle it out.
        if (touched || (opened && !lease)) { try { await adapter.stop(); } catch {} cached = null; }
        audit(dryRun ? 'check' : op, dryRun ? { op, ...args } : args, caller, false, started, e, backend);
        throw e;
      } finally { clearTimeout(timer); active.delete(cancel); }
    });
    serial = task.catch(() => {});
    return task;
  }
  function screenshot(options = {}, caller) {
    const summary = Object.fromEntries(['display', 'window', 'region', 'maxWidth', 'format', 'quality'].filter((k) => options[k] != null).map((k) => [k, options[k]]));
    return perform('screenshot', summary, caller, false, 'capture', async (info, request) => {
      const { display, window, region, maxWidth, format = 'png', quality = 80 } = options;
      if (window != null && region) throw new ControlError('bad-args', 'Choose a window or a region');
      if (!['png', 'jpeg'].includes(format)) throw new ControlError('bad-args', 'format must be png or jpeg');
      integer(quality, 'quality', 1, 100);
      if (maxWidth != null) integer(maxWidth, 'maxWidth', 1, 16384);
      if (region) { integer(region.x, 'region.x', 0, 100000); integer(region.y, 'region.y', 0, 100000); integer(region.width, 'region.width', 1, 100000); integer(region.height, 'region.height', 1, 100000); }
      const dir = path.join(home, 'run', 'shots');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
      const shot = crypto.randomUUID(), file = path.join(dir, `${shot}.${format === 'png' ? 'png' : 'jpg'}`);
      try {
        const r = await request('shot', { display, window, region, maxWidth, format, quality, file });
        // Read only the file we allocated. A compromised/misconfigured helper cannot select another path.
        const data = fs.readFileSync(file), size = imageSize(data);
        const actualRegion = r.region || region;
        const scale = (actualRegion?.width || r.sourceWidth || size.width) / size.width;
        const meta = { shot, mime: format === 'png' ? 'image/png' : 'image/jpeg', ...size, display: r.display ?? display, scale, region: actualRegion, at: new Date(now()).toISOString() };
        Object.assign(summary, { display: meta.display, width: size.width, height: size.height });
        shots.set(shot, { ...meta, ts: now() });
        while (shots.size > 20) shots.delete(shots.keys().next().value);
        return { ...meta, data };
      } finally { fs.rmSync(file, { force: true }); }
    });
  }
  const listWindows = (caller) => perform('windows', {}, caller, false, 'windows', (_, request) => request('windows'));
  // Which backend and permission each op needs, and whether it acts (needs the input switch).
  const OP_NEEDS = { screenshot: ['capture', false], windows: ['windows', false], focus: ['windows', true], pointer: ['input', true], type: ['input', true], key: ['input', true] };
  /** Read-only: would `op` be allowed right now? Runs the real call's checks, takes no lease, sends no input. */
  function check(op = 'pointer', caller) {
    if (!OP_NEEDS[op]) return Promise.reject(new ControlError('bad-args', `op must be one of ${Object.keys(OP_NEEDS).join(', ')}`));
    const [backendKey, act] = OP_NEEDS[op];
    return perform(op, {}, caller, act, backendKey, null, { dryRun: true });
  }
  const focusWindow = (id, caller) => perform('focus', { windowId: id }, caller, true, 'windows', async (_, request) => {
    if (!['string', 'number'].includes(typeof id) || !String(id) || String(id).length > 256) throw new ControlError('bad-args', 'A window id is required');
    return { ok: true, id: String(id), ...await request('focus', { windowId: String(id) }) };
  });
  function pointer(options = {}, caller) {
    return perform('pointer', options, caller, true, 'input', async (info, request) => {
      let { action = 'move', x, y, display, shot, button = 'left', count = 1, dx = 0, dy = 0, to } = options;
      if (!['move', 'click', 'down', 'up', 'scroll', 'drag'].includes(action) || !['left', 'right', 'middle'].includes(button)) throw new ControlError('bad-args', 'Invalid pointer action or button');
      integer(count, 'count', 1, 3); integer(dx, 'dx', -100, 100); integer(dy, 'dy', -100, 100);
      const transform = (point) => {
        finite(point.x, 'x'); finite(point.y, 'y');
        if (!shot) return point;
        const s = shots.get(shot);
        if (!s || now() - s.ts > 300000) throw new ControlError('bad-args', 'Unknown or expired shot; capture a fresh screenshot');
        if (display != null && display !== s.display) throw new ControlError('bad-args', 'display does not match shot');
        if (point.x >= s.width || point.y >= s.height) throw new ControlError('bad-args', 'Coordinates are outside the shot');
        display = s.display;
        return { x: point.x * s.scale + (s.region?.x || 0), y: point.y * s.scale + (s.region?.y || 0) };
      };
      if (x != null || y != null || ['move', 'drag'].includes(action)) ({ x, y } = transform({ x, y }));
      if (action === 'drag') { if (!to) throw new ControlError('bad-args', 'drag needs to: {x,y}'); to = transform(to); }
      if (info.backend.input === 'wlroots') return { ok: true, ...await request('pointer', { action, x, y, display, button, count, dx, dy, to }) };
      if (x != null) await request('move', { x, y, display });
      if (action === 'scroll') await request('scroll', { dx, dy });
      else if (action === 'down' || action === 'up') await request('button', { button, down: action === 'down' });
      else if (action === 'click' || action === 'drag') {
        for (let i = 0; i < (action === 'drag' ? 1 : count); i++) {
          await request('button', { button, down: true });
          try { if (action === 'drag') await request('move', { ...to, display }); }
          finally { await request('button', { button, down: false }); }
        }
      }
      return { ok: true, x, y, display };
    });
  }
  function typeText(text, options = {}, caller) {
    // Never retain the raw text in the closure's audit args, even on an error.
    const { delayMs = 0, secret = false } = options;
    const args = { length: typeof text === 'string' ? [...text].length : 0, ...(!secret && typeof text === 'string' && settings().auditPreview > 0 ? { preview: text.slice(0, Math.min(4000, settings().auditPreview)) } : {}) };
    return perform('type', args, caller, true, 'input', async (_, request) => {
      if (typeof text !== 'string' || [...text].length > 4000 || text.includes('\0')) throw new ControlError('bad-args', 'text must be a string of at most 4000 characters with no NUL');
      integer(delayMs, 'delayMs', 0, 1000);
      if ([...text].length * Math.max(4, delayMs) > 8000) throw new ControlError('bad-args', 'Text and delay exceed the 8-second input budget; split into smaller calls');
      const r = await request('type', { text, delayMs });
      return { ok: true, ...r };
    });
  }
  function key(combo, { repeat = 1 } = {}, caller) {
    return perform('key', { combo, repeat }, caller, true, 'input', async (info, request) => {
      const keys = parseCombo(combo, platform); integer(repeat, 'repeat', 1, 20);
      if (info.backend.input === 'wlroots') { await request('combo', { keys, repeat }); return { ok: true, combo }; }
      for (let i = 0; i < repeat; i++) {
        const held = [];
        try { for (const key of keys) { await request('key', { key, down: true }); held.push(key); } }
        finally { for (const key of held.reverse()) await request('key', { key, down: false }); }
      }
      return { ok: true, combo };
    });
  }
  async function enable({ enabled, input, confirm } = {}, caller = {}) {
    const started = now();
    try {
      if (typeof enabled !== 'boolean' && typeof input !== 'boolean') throw new ControlError('bad-args', 'Specify enabled and/or input as booleans');
      const s = settings(), next = { ...s, ...(enabled != null ? { enabled } : {}), ...(input != null ? { input } : {}) };
      const grants = enabled === true || input === true;
      if (grants && (caller.human !== true || caller.agent || caller.via === 'mcp' || confirm !== getConfig().name)) throw new ControlError('not-allowed', 'Only a confirmed human surface may enable access/input; confirm must match this machine name');
      if (!next.enabled) next.input = false;
      revoke('Control settings changed');
      persistConfig({ ...getConfig(), control: next });
      if (grants) { delete state.killed; saveState(); }
      await endLease('settings changed');
      // Switched off: also stop the helper process where it is a separate service (macOS LaunchAgent).
      if (!next.enabled && adapter.shutdown) await adapter.shutdown().catch(() => {}); else await adapter.stop();
      cached = null;
      audit('enable', { enabled: next.enabled, input: next.input }, caller, true, started);
      events.emit('change', { enabled: next.enabled, input: next.input, caller: callerInfo(caller) });
      return status({ force: true });
    } catch (e) { audit('enable', { enabled, input }, caller, false, started, e); throw e; }
  }
  async function kill({ reason = '' } = {}, caller = {}) {
    const started = now(), wasEnabled = !!settings().enabled;
    revoke('Control killed'); shots.clear();
    state.killed = { at: new Date(now()).toISOString(), by: callerInfo(caller), reason: String(reason).slice(0, 500) };
    // Persist the kill marker first: even a config write failure must fail closed on restart.
    saveState();
    let error;
    try { persistConfig({ ...getConfig(), control: { ...settings(), enabled: false, input: false } }); } catch (e) { error = e; }
    await endLease('kill');
    try { await (adapter.shutdown || adapter.stop).call(adapter); } catch (e) { error ||= e; }
    audit('kill', { reason: state.killed.reason }, caller, !error, started, error);
    events.emit('kill', { ...state.killed, wasEnabled });
    if (error) throw error;
    return { ok: true, wasEnabled, stopped: ['helper', 'lease'] };
  }
  function auditTail({ limit = 50 } = {}) {
    integer(limit, 'limit', 1, 500);
    if (!fs.existsSync(logFile)) return [];
    // Bounded read even when the log has reached its rotation threshold.
    const fd = fs.openSync(logFile, 'r');
    try {
      const size = fs.fstatSync(fd).size, start = Math.max(0, size - 1024 * 1024), b = Buffer.alloc(size - start);
      fs.readSync(fd, b, 0, b.length, start);
      const lines = b.toString('utf8').split('\n');
      if (start) lines.shift();
      return lines.filter(Boolean).slice(-limit).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    } finally { fs.closeSync(fd); }
  }
  adapter.events?.on('event', (msg) => {
    if (msg.event === 'restore-token') { state.restoreToken = msg.token; saveState(); }
    if (msg.event === 'exit') { revoke('Control helper stopped'); endLease('helper exit'); return; }
    if (['closed', 'hotkey', 'locked'].includes(msg.event) && settings().enabled) kill({ reason: msg.reason || `helper ${msg.event}` }, { who: 'desktop' }).catch((e) => events.emit('fault', e));
  });
  return { status, screenshot, listWindows, check, focusWindow, pointer, typeText, key, enable, kill, auditTail, events };
}

const instance = createControl();
export const { status, screenshot, listWindows, check, focusWindow, pointer, typeText, key, enable, kill, auditTail, events } = instance;
