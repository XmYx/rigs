import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { HOME, augmentedPath, isWin, stripAnsi, which } from './util.js';

const require = createRequire(import.meta.url);
let nodePty = null;
try { nodePty = require('@lydell/node-pty'); } catch { nodePty = null; }

const MAX_BUFFER = 400 * 1024;
const sessions = new Map();

export function ptyAvailable() { return !!nodePty; }

export function defaultShell() {
  if (isWin) {
    const pwsh = which('pwsh');
    return { cmd: pwsh || 'powershell.exe', args: ['-NoLogo'] };
  }
  // Services (launchd/systemd) may not export $SHELL, so fall back to the account's login shell.
  let login = '';
  try { login = os.userInfo().shell || ''; } catch {}
  const sh = [process.env.SHELL, login, '/bin/bash', '/bin/sh'].find((p) => p && fs.existsSync(p));
  return { cmd: sh, args: ['-l'] };
}

/**
 * Run a command line inside the user's login shell so PATH, nvm, aliases etc. match a normal
 * terminal. Used for "attach"/"resume" actions like `claude --resume <id>`.
 */
export function shellWrap(commandLine) {
  if (isWin) {
    const { cmd } = defaultShell();
    return { cmd, args: ['-NoLogo', '-NoExit', '-Command', commandLine] };
  }
  const { cmd } = defaultShell();
  return { cmd, args: ['-l', '-c', commandLine] };
}

function cleanEnv(extra = {}) {
  const env = { ...process.env, PATH: augmentedPath(), TERM: 'xterm-256color', COLORTERM: 'truecolor', RIGS_NODE: '1', ...extra };
  // Never leak a parent Claude Code session's identity into shells we spawn.
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDECODE') || k === 'CLAUDE_CODE_ENTRYPOINT') delete env[k];
  return env;
}

export function createPty({ cmd, args, cwd, cols = 120, rows = 32, title, kind = 'shell', meta = {} } = {}) {
  const sh = defaultShell();
  const command = cmd || sh.cmd;
  const argv = cmd ? (args || []) : sh.args;
  let dir = cwd && fs.existsSync(cwd) ? cwd : HOME;
  const id = crypto.randomBytes(6).toString('hex');
  const s = {
    id, title: title || (cmd ? [cmd, ...(args || [])].join(' ').slice(0, 60) : 'shell'), kind, meta,
    cmd: command, args: argv, cwd: dir, cols, rows, createdAt: Date.now(), lastActivity: Date.now(),
    buffer: '', clients: new Set(), exited: false, exitCode: null, proc: null, isPty: !!nodePty,
  };
  const onData = (d) => {
    s.lastActivity = Date.now();
    s.buffer += d;
    if (s.buffer.length > MAX_BUFFER) s.buffer = s.buffer.slice(s.buffer.length - MAX_BUFFER);
    const msg = JSON.stringify({ t: 'o', d });
    for (const c of s.clients) if (c.readyState === 1) c.send(msg);
  };
  const onExit = (code) => {
    s.exited = true;
    s.exitCode = code;
    const msg = JSON.stringify({ t: 'x', code });
    for (const c of s.clients) if (c.readyState === 1) c.send(msg);
    setTimeout(() => sessions.delete(id), 15 * 60 * 1000).unref?.();
  };

  if (nodePty) {
    s.proc = nodePty.spawn(command, argv, { name: 'xterm-256color', cols, rows, cwd: dir, env: cleanEnv(), useConpty: true });
    s.proc.onData(onData);
    s.proc.onExit(({ exitCode }) => onExit(exitCode));
    s.write = (d) => s.proc.write(d);
    s.resize = (c, r) => { try { s.proc.resize(Math.max(2, c), Math.max(2, r)); } catch {} };
    s.kill = () => { try { s.proc.kill(); } catch {} };
  } else {
    // Degraded mode without a pseudo-terminal: still usable for line-oriented commands.
    const p = spawn(command, argv, { cwd: dir, env: cleanEnv(), shell: isWin, windowsHide: true });
    s.proc = p;
    p.stdout.on('data', (d) => onData(d.toString()));
    p.stderr.on('data', (d) => onData(d.toString()));
    p.on('close', (code) => onExit(code));
    s.write = (d) => p.stdin.write(d.replace(/\r/g, '\n'));
    s.resize = () => {};
    s.kill = () => { try { p.kill(); } catch {} };
    onData('\x1b[33m[rigs] node-pty unavailable — running without a TTY\x1b[0m\r\n');
  }
  sessions.set(id, s);
  return s;
}

export function getPty(id) { return sessions.get(id); }

export function listPtys() {
  return [...sessions.values()].map((s) => ({
    id: s.id, title: s.title, kind: s.kind, meta: s.meta, cwd: s.cwd, createdAt: s.createdAt, lastActivity: s.lastActivity,
    exited: s.exited, exitCode: s.exitCode, clients: s.clients.size, isPty: s.isPty,
  }));
}

export function ptyTranscript(id, maxChars = 20000) {
  const s = sessions.get(id);
  if (!s) return null;
  return stripAnsi(s.buffer).slice(-maxChars);
}

export function killPty(id) {
  const s = sessions.get(id);
  if (!s) return false;
  s.kill();
  return true;
}

/** Wire a WebSocket to a PTY: replay scrollback, then stream both ways. */
export function attachWs(id, ws) {
  const s = sessions.get(id);
  if (!s) { ws.send(JSON.stringify({ t: 'e', message: 'no such terminal' })); ws.close(); return; }
  s.clients.add(ws);
  ws.send(JSON.stringify({ t: 'h', title: s.title, cwd: s.cwd, exited: s.exited }));
  if (s.buffer) ws.send(JSON.stringify({ t: 'o', d: s.buffer }));
  if (s.exited) ws.send(JSON.stringify({ t: 'x', code: s.exitCode }));
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.t === 'i' && typeof m.d === 'string' && !s.exited) s.write(m.d);
    else if (m.t === 'r' && m.c && m.r) { s.cols = m.c; s.rows = m.r; s.resize(m.c, m.r); }
  });
  ws.on('close', () => s.clients.delete(ws));
}
