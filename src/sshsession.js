import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { APP_DIR, HOME, isWin, upsertManagedBlock, which } from './util.js';

/**
 * Every interactive SSH login lands in a tmux session named ssh-<client> that RIGS lists as a live
 * session: visible in JARVIS on every machine, attachable from the browser, and resumable after a
 * dropped connection (`ssh` again re-attaches the detached session instead of starting over).
 * Non-interactive SSH (commands, scp, rsync, OpenRig, VS Code Remote) is untouched.
 */

const MARK = { start: '# >>> rigs ssh session >>>', end: '# <<< rigs ssh session <<<' };

function hookBody() {
  const node = process.execPath;
  const cli = path.join(APP_DIR, 'bin', 'rigs.js');
  return `# Interactive SSH logins open a tmux session that RIGS/JARVIS shows on every machine.
# Opt out for one login:  ssh -t <host> 'RIGS_NO_SESSION=1 exec $SHELL -l'
if [ -n "$SSH_CONNECTION" ] && [ -z "$TMUX" ] && [ -z "$RIGS_NO_SESSION" ] && [ -t 0 ] && [ -t 1 ] && [ -x "${node}" ] && [ -f "${cli}" ]; then
  case $- in *i*) "${node}" "${cli}" ssh-session && exit ;; esac
fi`;
}

/** Add the hook to the rc files of the shells this user actually uses. */
export async function installHook() {
  if (isWin) return { skipped: 'Windows: SSH lands in PowerShell (no tmux); sessions show as RIGS terminals instead' };
  const login = path.basename(os.userInfo().shell || process.env.SHELL || 'bash');
  const files = new Set();
  if (login.includes('zsh') || fs.existsSync(path.join(HOME, '.zshrc'))) files.add(path.join(HOME, '.zshrc'));
  if (login.includes('bash') || fs.existsSync(path.join(HOME, '.bashrc'))) files.add(path.join(HOME, '.bashrc'));
  const changed = [];
  for (const f of files) if (await upsertManagedBlock(f, hookBody(), MARK)) changed.push(f);
  return { files: [...files], changed };
}

function slug(s) {
  return String(s || 'remote').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'remote';
}

/** `rigs ssh-session`: pick/attach the tmux session for this SSH login. Exit code ≠ 0 → normal shell. */
export async function runSession() {
  const tmux = which('tmux', ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']);
  if (!tmux) return 1;
  const clientIp = (process.env.SSH_CONNECTION || process.env.SSH_CLIENT || '').split(' ')[0];
  let from = clientIp || 'remote';
  const base = `http://127.0.0.1:${config().port}`;
  try {
    const nodes = await (await fetch(base + '/api/nodes', { signal: AbortSignal.timeout(1500) })).json();
    const n = nodes.find((x) => x.tailscale?.ip === clientIp || (x.url || '').includes(`//${clientIp}:`));
    if (n) from = n.name;
  } catch {}
  const prefix = `ssh-${slug(from)}`;
  const list = spawnSync(tmux, ['list-sessions', '-F', '#{session_name}|~|#{session_attached}'], { encoding: 'utf8' });
  const existing = (list.stdout || '').split('\n').filter(Boolean).map((l) => { const [name, att] = l.split('|~|'); return { name, attached: Number(att) }; })
    .filter((s) => s.name === prefix || s.name.startsWith(prefix + '-'));
  // Re-attach a detached session from this client (dropped connection), else start a new one.
  let name = existing.find((s) => !s.attached)?.name;
  if (!name) { let i = existing.length ? existing.length + 1 : 0; name = i ? `${prefix}-${i}` : prefix; while (existing.some((s) => s.name === name)) name = `${prefix}-${++i}`; }
  const resumed = existing.some((s) => s.name === name);
  fetch(base + '/api/local/notify', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(800),
    body: JSON.stringify({ text: `SSH from ${from} ${resumed ? 're-attached' : 'opened'} session ${name} on ${config().name}`, speak: false, from: config().name }),
  }).catch(() => {});
  const r = spawnSync(tmux, ['new-session', '-A', '-s', name], { stdio: 'inherit', env: { ...process.env, RIGS_SSH_FROM: from } });
  return r.status ?? 0;
}
