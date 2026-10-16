import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, CONFIG_FILE, loadConfig, saveConfig } from './config.js';
import * as service from './service.js';
import * as ssh from './ssh.js';
import * as ts from './tailscale.js';
import { bin, detectTools } from './tools.js';
import { APP_DIR, HOME, clearWhichCache, isWin, run, upsertManagedBlock } from './util.js';

/**
 * `rigs setup` — make this machine a mesh node and make every coding agent on it mesh-aware:
 *  1. config + SSH mesh key
 *  2. register the `rigs` MCP server with Claude Code and Codex
 *  3. global agent instructions (CLAUDE.md / AGENTS.md) describing the mesh, REA and OpenRig
 *  4. REA for every detected coding agent (`npx rea-agents@latest setup`)
 *  5. OpenRig (`rig setup` + daemon)
 *  6. autostart service, optional `tailscale serve` HTTPS
 */

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const step = (m) => console.log(`\n\x1b[36m▸ ${m}\x1b[0m`);

const CLI = path.join(APP_DIR, 'bin', 'rigs.js');

async function registerClaudeMcp() {
  const claude = bin('claude');
  if (!claude) return warn('Claude Code not installed — skipped MCP registration');
  await run(claude, ['mcp', 'remove', '--scope', 'user', 'rigs'], { timeout: 20000 });
  const r = await run(claude, ['mcp', 'add', '--scope', 'user', 'rigs', '--', process.execPath, CLI, 'mcp'], { timeout: 30000 });
  if (r.code === 0) ok('Claude Code: rigs MCP registered (user scope)');
  else warn('Claude Code MCP registration failed: ' + (r.stderr || r.stdout).trim().slice(0, 200));
}

async function registerCodexMcp() {
  const codexHome = process.env.CODEX_HOME || path.join(HOME, '.codex');
  if (!bin('codex') && !fs.existsSync(codexHome)) return warn('Codex not installed — skipped MCP registration');
  const file = path.join(codexHome, 'config.toml');
  let text = '';
  try { text = await fsp.readFile(file, 'utf8'); } catch {}
  const outside = text.replace(/# >>> rigs mesh >>>[\s\S]*?# <<< rigs mesh <<<\n?/, '');
  if (/\[mcp_servers\.rigs\]/.test(outside)) return ok('Codex: rigs MCP already configured');
  const toml = `[mcp_servers.rigs]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(CLI)}, "mcp"]\nstartup_timeout_sec = 20`;
  await upsertManagedBlock(file, toml);
  ok(`Codex: rigs MCP registered in ${file}`);
}

function agentInstructions() {
  const cfg = config();
  return `## RIGS mesh (managed by rigs setup — edits inside this block are overwritten)

You are running on **${cfg.name}**, one node of the user's RIGS mesh: every workstation on their
Tailscale network (macOS, Ubuntu, Windows) runs the RIGS daemon, and you can reach all of them.

- **rigs MCP** (\`mesh_*\` tools): \`mesh_status\` lists machines; \`mesh_exec\`, \`mesh_read_file\`,
  \`mesh_write_file\` act on any machine; \`mesh_sessions\` / \`mesh_session_transcript\` / \`mesh_send\`
  read and drive Claude Code, Codex, OpenRig and chat sessions anywhere; \`mesh_start_agent\` starts a
  new agent on any machine; \`mesh_ask\` asks another machine's brain (e.g. a local Ollama model);
  \`mesh_notify\` speaks to the user through the JARVIS UI.
- **REA — Reverse Engineer Anything** (\`rea\` MCP, or \`npx -y rea-agents@latest <command>\`): use it
  whenever asked how an app, binary, Electron/JS bundle, .NET assembly, APK or website works, and to
  gather evidence before re-implementing a feature. Keep it current with \`npx rea-agents@latest setup\`.
- **OpenRig** (\`rig\` CLI): persistent agent teams. \`rig ps --nodes\`, \`rig send <seat> "<msg>"\`,
  \`rig queue\`, \`rig transcript\`. Other mesh machines are registered as OpenRig hosts (\`rig host list\`).
- **Projects**: work is often planned by the core brain (Opus) and delegated per task to a machine +
  model + effort. If your prompt is a RIGS task brief, finish by calling \`project_task_update\`
  (owner, project, task, status, summary) — dependents start automatically after you report.
  \`project_create\` plans and routes a new goal across the mesh.
- **Tools**: \`mesh_status\` lists each machine's tools (e.g. ComfyUI for image generation). Use the
  machine that has the tool you need.
- **SSH**: \`ssh <machine-name>\` works between all nodes (aliases in ~/.ssh/config).
- **Changing the mesh itself**: the source is the public repo checked out at \`${APP_DIR}\`
  (see its AGENTS.md). Edit, run \`npm test\`, commit, push to \`main\`, then call \`mesh_update\`
  so every machine pulls the change and restarts.
`;
}

async function writeInstructions() {
  const md = { start: '<!-- >>> rigs mesh >>> -->', end: '<!-- <<< rigs mesh <<< -->' };
  const targets = [path.join(HOME, '.claude', 'CLAUDE.md'), path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'AGENTS.md')];
  for (const f of targets) {
    if (!fs.existsSync(path.dirname(f))) continue;
    await upsertManagedBlock(f, agentInstructions(), md);
    ok(`agent instructions → ${f}`);
  }
}

async function setupRea(opts) {
  const npx = bin('npx') || (isWin ? 'npx.cmd' : 'npx');
  const plan = await run(npx, ['-y', 'rea-agents@latest', 'setup', '--all-detected', '--dry-run', '--format', 'json'], { timeout: 300000 });
  let clients = [];
  try {
    const j = JSON.parse(plan.stdout.slice(plan.stdout.indexOf('{')));
    clients = (j.clientStates || []).filter((c) => c.detected).map((c) => c.client.name);
  } catch {}
  // Claude Desktop must be fully quit while REA edits its config, so it's opt-in here.
  if (!opts.includeDesktop) clients = clients.filter((c) => c !== 'claude_desktop');
  if (!clients.length) return warn('REA: no supported coding agents detected yet (install Claude Code / Codex, then rerun)');
  const args = ['-y', 'rea-agents@latest', 'setup', '--yes', ...clients.flatMap((c) => ['--client', c])];
  const r = await run(npx, args, { timeout: 600000 });
  if (r.code === 0) ok(`REA registered for: ${clients.join(', ')}`);
  else warn('REA setup failed: ' + (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' '));
}

async function setupOpenRig(opts) {
  if (isWin) return warn('OpenRig needs tmux — on Windows run it inside WSL (see docs/INSTALL.md). Skipped natively.');
  let rig = bin('rig');
  if (!rig) {
    const npm = bin('npm') || 'npm';
    const i = await run(npm, ['install', '-g', '@openrig/cli@latest'], { timeout: 600000 });
    clearWhichCache();
    rig = bin('rig');
    if (!rig) return warn('OpenRig install failed: ' + i.stderr.trim().slice(-200));
    ok('OpenRig CLI installed');
  }
  const providers = ['claude', 'codex'].filter((p) => bin(p));
  if (providers.length) {
    const s = await run(rig, ['setup', '--providers', providers.join(','), '--no-ghostty'], { timeout: 900000 });
    if (s.code === 0) ok(`rig setup done (providers: ${providers.join(', ')})`);
    else warn('rig setup reported issues (often just a provider sign-in): ' + (s.stdout + s.stderr).trim().split('\n').filter((l) => /FAIL|error/i.test(l)).slice(0, 3).join(' | '));
  }
  const st = await run(rig, ['daemon', 'status'], { timeout: 15000 });
  if (/running/i.test(st.stdout) && !/not running|stopped/i.test(st.stdout)) return ok('OpenRig daemon already running');
  const args = ['daemon', 'start', ...(opts.openrigKernel ? [] : ['--no-kernel'])];
  const d = await run(rig, args, { timeout: 180000 });
  if (d.code === 0) ok(`OpenRig daemon started${opts.openrigKernel ? ' (with kernel/operator)' : ''}`);
  else warn('rig daemon start failed: ' + (d.stdout + d.stderr).trim().slice(-200));
}

async function sunshineCreds() {
  const s = bin('sunshine');
  if (!s) return warn('Sunshine not installed — remote desktop hosting unavailable on this machine (see docs/INSTALL.md)');
  const { sunshineUser, sunshinePass } = config().desktop;
  const r = await run(s, ['--creds', sunshineUser, sunshinePass], { timeout: 20000 });
  if (r.code === 0) ok('Sunshine credentials set (stored in ~/.rigs/config.json, used for automatic Moonlight pairing)');
  else warn('could not set Sunshine credentials: ' + (r.stderr || r.stdout).trim().slice(0, 200));
}

export async function setup(argv) {
  const opts = {
    service: !argv.includes('--no-service'), rea: !argv.includes('--no-rea'), openrig: !argv.includes('--no-openrig'),
    includeDesktop: argv.includes('--include-claude-desktop'), https: argv.includes('--https'), desktop: argv.includes('--desktop'),
    openrigKernel: !argv.includes('--no-kernel'),
  };
  const nameIdx = argv.indexOf('--name');
  loadConfig();
  if (nameIdx >= 0 && argv[nameIdx + 1]) { const c = config(); c.name = argv[nameIdx + 1].toLowerCase(); saveConfig(c); }
  console.log(`\n\x1b[1mRIGS setup\x1b[0m — node "${config().name}" (${CONFIG_FILE})`);

  step('Network');
  const tsStatus = await ts.status(0);
  if (!tsStatus) warn('Tailscale not found or not logged in — install it and run `tailscale up` (the mesh still works on localhost / static peers)');
  else ok(`Tailscale ${tsStatus.backendState}: ${tsStatus.self.dnsName || tsStatus.self.hostName} (${tsStatus.self.ips[0]}) as ${tsStatus.self.login} — ${tsStatus.peers.length} peer device(s)`);
  if (opts.https && tsStatus) {
    const s = await ts.enableServe(config().port);
    if (s.ok) ok(`HTTPS on the tailnet: https://${tsStatus.self.dnsName}/ (microphone works there)`);
    else warn('tailscale serve failed (enable MagicDNS + HTTPS certificates in the admin console): ' + s.message.slice(0, 200));
  }

  step('SSH');
  const key = await ssh.ensureKey();
  if (key) ok(`mesh key ${key}`); else warn('ssh-keygen not found — install OpenSSH');
  const sv = await ssh.serverStatus();
  if (sv.running) ok('SSH server: ' + sv.detail); else warn('SSH server: ' + sv.detail + ' — the installer can enable it');

  step('Agents');
  const tools = await detectTools(true);
  for (const t of ['claude', 'codex', 'ollama', 'rig', 'tmux']) (tools[t]?.installed ? ok : warn)(`${t}: ${tools[t]?.installed ? tools[t].version || 'installed' : 'not installed'}`);
  await registerClaudeMcp();
  await registerCodexMcp();
  await writeInstructions();
  if (opts.rea) { step('REA (reverse engineer anything)'); await setupRea(opts); }
  if (opts.openrig) { step('OpenRig'); await setupOpenRig(opts); }
  if (opts.desktop) { step('Remote desktop'); await sunshineCreds(); }

  if (opts.service) {
    step('Service');
    const r = await service.installService();
    (r.ok ? ok : warn)(`${r.how}: ${r.file}${r.ok ? '' : ' — ' + r.message}`);
  }

  const url = `http://localhost:${config().port}`;
  console.log(`\n\x1b[1mDone.\x1b[0m Open ${url}${tsStatus ? `  ·  from other machines: http://${tsStatus.self.ips.find((i) => i.includes('.'))}:${config().port}` : ''}\n`);
}
