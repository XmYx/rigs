import path from 'node:path';
import { RIGS_HOME } from './config.js';
import * as desktopInstall from './desktop-install.js';
import * as rootsteps from './rootsteps.js';
import { tailscaleBin } from './tailscale.js';
import * as sshSession from './sshsession.js';
import { detectTools } from './tools.js';
import { log, readJsonSync, writeJsonAtomic } from './util.js';

/**
 * One-time steps that a self-update brings to every machine. They run in the background after the
 * new version starts, are recorded in ~/.rigs/migrations.json, and never block or crash the node.
 * Append new entries; never edit or reorder old ones.
 */
const MIGRATIONS = [
  { id: '2026-10-16-ssh-session-hook', run: () => sshSession.installHook() },
  { id: '2026-10-16-desktop-sunshine-moonlight', run: async () => { const s = await desktopInstall.ensure(); await detectTools(true); return { state: s.state, steps: s.steps }; } },
  { id: '2026-10-16-prefer-openssh', run: async () => { const r = await rootsteps.preferOpenSsh(tailscaleBin()); const u = await rootsteps.tryUnattended(); return { ...r, unattended: u.ran, pending: u.steps.map((x) => x.id) }; } },
];

MIGRATIONS.push({ id: '2026-10-16-sunshine-gpu-encoder', run: () => desktopInstall.tuneSunshine() });

// JARVIS gets write access in the home (only where the old read-only defaults are still in place).
MIGRATIONS.push({
  id: '2026-10-16-jarvis-home-write',
  run: async () => {
    const { config, saveConfig } = await import('./config.js');
    const c = config();
    const oldTools = ['mcp__rigs', 'mcp__rea', 'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
    const changed = [];
    if (c.brain.claudePermissionMode === 'default') { c.brain.claudePermissionMode = 'acceptEdits'; changed.push('claude: acceptEdits'); }
    if (JSON.stringify(c.brain.claudeAllowedTools) === JSON.stringify(oldTools)) { c.brain.claudeAllowedTools = [...oldTools.slice(0, 5), 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', ...oldTools.slice(5)]; changed.push('claude: edit/write/bash tools'); }
    if (c.brain.codexSandbox === 'read-only') { c.brain.codexSandbox = 'workspace-write'; changed.push('codex: workspace-write'); }
    c.brain.workRoot ||= '~';
    saveConfig(c);
    return { changed };
  },
});

MIGRATIONS.push({ id: '2026-10-16-windows-controlled-folder-access', run: () => rootsteps.allowControlledFolderAccess() });

// Nodes that ran the first desktop migration before root steps were bundled re-register theirs.
MIGRATIONS.push({ id: '2026-10-16-desktop-root-steps', run: async () => { const s = await desktopInstall.ensure(); await detectTools(true); return { state: s.state, steps: s.steps.slice(-2) }; } });

const FILE = path.join(RIGS_HOME, 'migrations.json');

export function status() {
  const done = readJsonSync(FILE, {});
  return MIGRATIONS.map((m) => ({ id: m.id, ...(done[m.id] || { pending: true }) }));
}

export async function runPending(notify) {
  const done = readJsonSync(FILE, {});
  for (const m of MIGRATIONS) {
    if (done[m.id]?.ok) continue;
    try {
      const result = await m.run();
      done[m.id] = { ok: true, at: Date.now(), result };
      log(`migration ${m.id}: ok`);
    } catch (e) {
      done[m.id] = { ok: false, at: Date.now(), error: e.message };
      log(`migration ${m.id}: ${e.message}`);
    }
    await writeJsonAtomic(FILE, done);
    notify?.(m, done[m.id]);
  }
  return status();
}
