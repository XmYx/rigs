import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RIGS_HOME } from './config.js';
import * as desktopInstall from './desktop-install.js';
import * as rootsteps from './rootsteps.js';
import { tailscaleBin } from './tailscale.js';
import * as sshSession from './sshsession.js';
import { detectTools } from './tools.js';
import { log, readJsonSync, run, which, writeJsonAtomic } from './util.js';

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

// Agents run in auto mode and announce when they need you (Claude auto mode, Codex rigs-auto profile + notify hook,
// OpenRig builtin:auto). Only defaults RIGS itself set are moved; a choice the user made stays.
MIGRATIONS.push({
  id: '2026-10-16-agents-auto-mode',
  run: async () => {
    const { config, saveConfig } = await import('./config.js');
    const { installCodex } = await import('./agentmodes.js');
    const planner = await import('./planner.js');
    const c = config();
    const changed = [];
    if (['acceptEdits', 'default'].includes(c.brain.claudePermissionMode)) { c.brain.claudePermissionMode = 'auto'; changed.push('jarvis claude: auto'); }
    saveConfig(c);
    for (const p of await planner.listProjects().catch(() => [])) {
      if (p.policy === 'builtin:standard' && p.status !== 'done') { p.policy = 'builtin:auto'; await planner.saveProject(p); changed.push(`project ${p.name}: builtin:auto`); }
    }
    const codex = await installCodex().catch((e) => ({ error: e.message }));
    return { changed, codex };
  },
});

// `rig`/`codex` run with the Node they were installed for, so seats can always read their OpenRig queue.
MIGRATIONS.push({ id: '2026-10-16-node-cli-wrappers', run: async () => (await import('./agentmodes.js')).ensureCliWrappers() });

// Every agent on every machine learns Sir's autonomy rule (non-destructive = go; other projects: no commits unasked).
MIGRATIONS.push({ id: '2026-10-17-autonomy-instructions', run: async () => { await (await import('./setup.js')).writeInstructions(); return { ok: true }; } });

// Moonlight on Wayland: native Wayland stream window + Vulkan, no VDPAU through XWayland (it locked up and
// crashed XWayland on NVIDIA); the AppImage is extracted once instead of on every start.
MIGRATIONS.push({ id: '2026-10-17-moonlight-wayland', run: () => desktopInstall.ensureMoonlightWrapper() });

// Live Video applet (applets/live-video): a systemd --user unit on Linux, a `command` elsewhere, and an App
// Cloud entry. The id is live-video-comfy because `live-video` may already be another app on this machine.
MIGRATIONS.push({
  id: '2026-10-17-live-video-applet',
  run: async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const dir = path.join(root, 'applets', 'live-video');
    if (!fs.existsSync(path.join(dir, 'server.js'))) return { skipped: 'applet not in this checkout' };
    const { config, saveConfig } = await import('./config.js');
    // Quote with plain "" (JSON.stringify would double the backslashes of a Windows path).
    const command = `node "${path.join(dir, 'server.js')}"`;
    let launch = process.platform === 'win32' ? { windows: { command, cwd: root } } : { command };
    if (process.platform === 'linux' && which('systemctl')) {
      const unit = 'rigs-live-video.service';
      const dest = path.join(os.homedir(), '.config', 'systemd', 'user');
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, unit), fs.readFileSync(path.join(dir, unit), 'utf8').replaceAll('%h/.rigs/app', root));
      await run('systemctl', ['--user', 'daemon-reload'], { timeout: 20000 });
      const r = await run('systemctl', ['--user', 'enable', '--now', unit], { timeout: 30000 });
      if (r.code === 0) launch = { systemd: unit };
    }
    const c = config();
    const entry = { id: 'live-video-comfy', name: 'Live Video', icon: '🎬', port: 8741, healthPath: '/healthz', launch };
    c.apps = [...(c.apps || []).filter((a) => a?.id !== entry.id), entry];
    saveConfig(c);
    return { app: entry.id, launch };
  },
});

// OS control (screen access + input) is on by default. Machines that saved the old off defaults are switched on;
// one where a person switched it or the kill switch fired stays as it is. The server runs the first-run setup after.
MIGRATIONS.push({
  id: '2026-10-17-control-default-on',
  run: async () => {
    const { config, saveConfig } = await import('./config.js');
    const { controlHistory, defaultOnDecision } = await import('./control-setup.js');
    const c = config();
    const d = defaultOnDecision({ control: c.control, ...controlHistory(RIGS_HOME) });
    if (d.change) { c.control = { ...c.control, enabled: true, input: true }; saveConfig(c); }
    return { ...d, enabled: !!c.control?.enabled, input: !!c.control?.input };
  },
});

// Every agent learns the screen-control tools and rules (on by default, ask first, never re-enable or bypass).
MIGRATIONS.push({ id: '2026-10-17-control-instructions', run: async () => { await (await import('./setup.js')).writeInstructions(); return { ok: true }; } });

// Usage ledger: estimated records for the project task runs and JARVIS chat turns from before it existed. Waits for
// peer discovery first, since a task's transcript lives on the machine that ran it (`rigs usage backfill` re-runs it).
MIGRATIONS.push({
  id: '2026-10-17-usage-backfill',
  run: async () => {
    await new Promise((r) => setTimeout(r, 20000));
    const usage = await import('./usage.js');
    return usage.backfill();
  },
});

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
