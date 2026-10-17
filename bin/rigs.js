#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [cmd = 'help', ...argv] = process.argv.slice(2);

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.error(`RIGS needs Node.js 22+ (found ${process.version}).`);
  process.exit(1);
}

async function daemonFetch(p, opts = {}) {
  const { config } = await import('../src/config.js');
  const r = await fetch(`http://127.0.0.1:${config().port}${p}`, {
    ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) }, signal: AbortSignal.timeout(opts.timeout || 30000),
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
}

/**
 * Supervisor: keeps `rigs serve` alive. Exit code 75 = planned restart (after an update).
 * If a freshly updated version crash-loops, roll back to the previous commit.
 */
async function supervise() {
  const { RESTART_CODE, previousSha, markBad, ensureDependencies } = await import('../src/updater.js');
  const { run, APP_DIR } = await import('../src/util.js');
  let crashes = [];
  let backoff = 1000;
  let child = null;
  let stopping = false;
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopping = true; if (child) child.kill(sig); else process.exit(0); });
  for (;;) {
    const started = Date.now();
    await ensureDependencies().catch(() => {});
    const code = await new Promise((resolve) => {
      child = spawn(process.execPath, [path.join(HERE, 'rigs.js'), 'serve'], { stdio: 'inherit', env: process.env });
      child.on('exit', (c, sig) => { child = null; resolve(sig ? `signal ${sig}` : c); });
    });
    // Only a stop of the supervisor itself ends the loop; a child killed from outside is restarted.
    if (stopping) process.exit(0);
    if (code === RESTART_CODE) { backoff = 1000; crashes = []; continue; }
    crashes = crashes.filter((t) => Date.now() - t < 120000).concat(Date.now());
    if (crashes.length >= 3) {
      const prev = previousSha();
      if (prev) {
        const cur = (await run('git', ['rev-parse', 'HEAD'], { cwd: APP_DIR, timeout: 10000 })).stdout.trim();
        if (cur && cur !== prev) await markBad(cur);
        console.error(`[rigs] crash loop — rolling back to ${prev.slice(0, 7)} (won't auto-apply ${cur.slice(0, 7)} again)`);
        await run('git', ['reset', '--hard', prev], { cwd: APP_DIR, timeout: 60000 });
        await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { cwd: APP_DIR, timeout: 600000 });
      }
      crashes = [];
    }
    if (Date.now() - started > 60000) backoff = 1000;
    console.error(`[rigs] server exited (${code}); restarting in ${backoff / 1000}s`);
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 30000);
  }
}

const commands = {
  async serve() {
    const { startServer } = await import('../src/server.js');
    const { config } = await import('../src/config.js');
    await startServer();
    console.log(`\n  RIGS OS — node "${config().name}" ready at http://localhost:${config().port}\n`);
  },
  start: supervise,
  async setup() {
    const { setup } = await import('../src/setup.js');
    await setup(argv);
  },
  async mcp() {
    const { startMcp } = await import('../src/mcp.js');
    startMcp();
  },
  async dev() {
    const topic = argv.join(' ').trim();
    if (!topic) { console.log('usage: rigs dev <topic>   — a worktree on its own work branch, off the latest main'); process.exit(1); }
    const r = await daemonFetch('/api/local/dev/start', { method: 'POST', body: JSON.stringify({ topic }), timeout: 120000 });
    if (r.error) { console.error(r.error); process.exit(1); }
    console.log(`${r.existing ? 'existing' : 'new'} worktree ${r.dir}\nbranch ${r.branch}\n\ncd ${r.dir}   # work + commit here, then: rigs propose`);
  },
  async propose() {
    const t = argv.indexOf('--title');
    const s = argv.indexOf('--summary');
    const r = await daemonFetch('/api/local/dev/propose', { method: 'POST', body: JSON.stringify({ dir: process.cwd(), title: t >= 0 ? argv[t + 1] : undefined, summary: s >= 0 ? argv[s + 1] : undefined }), timeout: 60000 });
    if (r.error) { console.error(r.error); process.exit(1); }
    if (r.empty) { console.log(`nothing to propose: ${r.branch} has no commits ahead of origin/main`); return; }
    console.log(`proposed ${r.branch} → merge steward ${r.steward} (request ${r.id}, ${r.status}). Watch: rigs merge`);
  },
  async merge() {
    const r = await daemonFetch('/api/mesh/merge', { timeout: 20000 });
    console.log(`steward: ${r.steward || 'none'}${r.note ? ' — ' + r.note : ''}`);
    for (const x of r.queue || []) console.log(`  ${x.id}  ${x.status.padEnd(14)} ${x.branch}  (${x.node})  ${x.sha || ''}  ${x.log?.slice(-1)[0]?.text || ''}`);
  },
  /** Agent hooks → the local daemon's attention feed. Codex calls: rigs hook codex '<json>' */
  async hook() {
    const [source, ...rest] = argv;
    let payload = {};
    try { payload = JSON.parse(rest.join(' ') || '{}'); } catch {}
    if (process.env.TMUX_PANE) {
      const { spawnSync } = await import('node:child_process');
      const r = spawnSync('tmux', ['display', '-p', '-t', process.env.TMUX_PANE, '#S'], { encoding: 'utf8' });
      if (r.stdout?.trim()) payload.tmux = r.stdout.trim();
    }
    if (source === 'codex') await daemonFetch('/api/local/attention/codex', { method: 'POST', body: JSON.stringify(payload), timeout: 3000 }).catch(() => {});
  },
  async 'ssh-session'() {
    const { runSession } = await import('../src/sshsession.js');
    process.exit(await runSession());
  },
  async desktop() {
    const d = await import('../src/desktop-install.js');
    const r = argv[0] === 'status' ? await d.status() : await d.ensure({ force: argv.includes('--force') });
    console.log(JSON.stringify(r, null, 2));
  },
  async status() {
    const nodes = await daemonFetch('/api/nodes').catch(() => null);
    if (!Array.isArray(nodes)) { console.log('RIGS daemon is not running (rigs start).'); process.exit(1); }
    for (const n of nodes) {
      const tools = n.tools ? Object.entries(n.tools).filter(([k, v]) => v && typeof v === 'string' && ['claude', 'codex', 'ollama', 'rig', 'rea', 'sunshine'].includes(k)).map(([k]) => k).join(',') : '';
      console.log(`${n.self ? '*' : ' '} ${String(n.name).padEnd(18)} ${String(n.platform || '?').padEnd(8)} ${n.online ? 'online ' : 'offline'} ${n.rigs ? 'rigs ' + (n.version || '') : 'no-rigs'}  ${n.tailscale?.ip || n.url || ''}  ${tools}`);
    }
  },
  async update() {
    const all = argv.includes('--all');
    const r = await daemonFetch(all ? '/api/mesh/update' : '/api/local/update', { method: 'POST', body: '{}', timeout: 20 * 60 * 1000 });
    console.log(JSON.stringify(r, null, 2));
  },
  async notify() {
    const r = await daemonFetch('/api/mesh/notify', { method: 'POST', body: JSON.stringify({ text: argv.join(' '), speak: true }) });
    console.log(JSON.stringify(r));
  },
  async open() {
    const { config } = await import('../src/config.js');
    const url = `http://localhost:${config().port}`;
    const opener = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
    spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref();
  },
  async ssh() {
    const target = argv[0];
    if (!target) { console.log('usage: rigs ssh <machine>'); process.exit(1); }
    spawn('ssh', [target, ...argv.slice(1)], { stdio: 'inherit' }).on('exit', (c) => process.exit(c ?? 0));
  },
  async service() {
    const s = await import('../src/service.js');
    const r = argv[0] === 'uninstall' ? await s.uninstallService() : await s.installService();
    console.log(JSON.stringify(r, null, 2));
  },
  async control() {
    const [sub, ...rest] = argv;
    if (sub === 'helper' && process.platform === 'darwin') {
      // macOS: RIGS Control.app, the helper that holds Screen Recording + Accessibility (docs/full-access.md §4).
      const H = await import('../src/control-mac-helper.js');
      const { default: fs } = await import('node:fs');
      const what = rest[0] || 'status';
      try {
        if (what === 'install') console.log(JSON.stringify(await H.installMacHelper(), null, 2));
        else if (what === 'stop') console.log(JSON.stringify(await H.stopMacHelper(), null, 2));
        else if (what === 'remove') console.log(JSON.stringify(await H.uninstallMacHelper(), null, 2));
        else if (what === 'status') {
          const p = H.helperPaths();
          let probe = null;
          try { probe = await H.requestHelper(undefined, 'probe'); } catch (e) { probe = { error: e.message }; }
          console.log(JSON.stringify({ label: p.label, app: p.app, built: fs.existsSync(p.hashFile), current: fs.existsSync(p.hashFile) && fs.readFileSync(p.hashFile, 'utf8').trim() === H.sourceHash(), ...probe }, null, 2));
        } else { console.log('usage: rigs control helper [status|install|stop|remove]'); process.exit(1); }
      } catch (e) { console.error(`${e.message}${e.fix?.text ? `\n${e.fix.text}` : ''}`); process.exit(1); }
      return;
    }
    if (sub !== 'off') { console.log('usage: rigs control off [reason]   — local kill switch: stop OS control (screen + input) on this machine and keep it off until a person re-enables it in JARVIS\n       rigs control helper [status|install|stop|remove]   — macOS: the RIGS Control helper app and its LaunchAgent'); process.exit(sub ? 1 : 0); }
    const reason = rest.join(' ') || 'rigs control off';
    const caller = { via: 'cli', who: 'cli' };
    let r;
    try { r = await daemonFetch('/api/local/control/kill', { method: 'POST', body: JSON.stringify({ reason }), timeout: 15000 }); } catch {}
    if (r?.ok) { console.log('OS control is off on this machine (daemon stopped it). It stays off until switched on in JARVIS → Access & control.'); return; }
    if (r && r.error) console.error(`daemon refused: ${r.error?.message || r.error}; killing locally`);
    // Daemon not running: write the persistent kill marker + config directly (fails closed on next start).
    const { createControl } = await import('../src/control.js');
    try { await createControl().kill({ reason }, caller); } catch (e) { console.error(`kill: ${e.message}`); process.exit(1); }
    console.log('OS control is off on this machine (daemon not running; kill recorded, it stays off at next start).');
  },
  async help() {
    console.log(`rigs — RIGS OS mesh node  (changes: rigs dev <topic> → commit → rigs propose; never main)

  rigs setup [--name N] [--https] [--desktop] [--no-service] [--no-rea] [--no-openrig] [--no-kernel]
                       make this machine a mesh node and wire up Claude Code / Codex / REA / OpenRig
  rigs start           run the node (supervised; this is what the service runs)
  rigs serve           run the server in the foreground without the supervisor
  rigs status          list machines in the mesh
  rigs open            open the JARVIS UI
  rigs ssh <machine>   ssh to another node
  rigs update [--all]  pull the latest code from GitHub (this node or every node) and restart
  rigs notify <text>   speak a message on every open JARVIS UI
  rigs mcp             stdio MCP server for coding agents (registered by setup)
  rigs desktop [status|--force]  install Sunshine + Moonlight (hardware-accelerated remote desktop)
  rigs ssh-session     (used by the SSH login hook) attach this SSH login to a JARVIS-visible tmux session
  rigs dev <topic>     start a change: worktree on branch work/<machine>/<topic> off the latest main
  rigs propose [--title T]  hand the committed branch (cwd) to the merge steward
  rigs merge           merge steward + queue status
  rigs control off [reason]  kill switch: stop OS control (screen + input) on this machine, stays off
  rigs control helper [status|install|stop|remove]
                       macOS: build/start RIGS Control.app (holds Screen Recording + Accessibility)
  rigs service [uninstall]  (re)install or remove the autostart service`);
  },
};

const fn = commands[cmd];
if (!fn) { await commands.help(); process.exit(1); }
await fn();
