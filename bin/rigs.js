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
 * rigs quick local [on|off|status|warm|model <name>|node <machine>] — the local responder (config.quick.local,
 * src/responder.js). `on` without a host makes this machine the host; the setting is mesh-global.
 */
async function quickLocal([sub = 'status', value = '']) {
  const fail = (m) => { console.error(m || 'RIGS daemon is not running (rigs start).'); process.exit(1); };
  const patch = sub === 'on' ? { enabled: true } : sub === 'off' ? { enabled: false } : sub === 'model' ? { model: value } : sub === 'node' ? { node: value } : null;
  if (!patch && !['status', 'warm'].includes(sub)) fail('usage: rigs quick local [on|off|status|warm|model <name>|node <machine>]');
  if (sub === 'model' && !value) fail('usage: rigs quick local model <ollama model, e.g. qwen3:8b>');
  if (patch) {
    const r = await daemonFetch('/api/local/quick', { method: 'POST', body: JSON.stringify({ local: patch }) }).catch((e) => ({ error: e.message }));
    if (r.error || !r.local) fail(r.error);
  }
  if (sub === 'warm') {
    const w = await daemonFetch('/api/local/responder/warm', { method: 'POST', timeout: 130000 }).catch((e) => ({ error: e.message }));
    if (!w.ok) fail(`warm-up failed: ${w.error || JSON.stringify(w)}`);
    console.log(`warm in ${w.ms} ms`);
  }
  const st = await daemonFetch('/api/local/responder').catch((e) => ({ error: e.message }));
  if (st.enabled === undefined) fail(st.error); // st.error alone is the host's Ollama being unreachable: shown below
  const model = st.host ? `${st.model} ${st.loaded ? `loaded (${st.sizeVramMb} MB VRAM, ${st.contextLength} ctx)` : st.installed ? 'installed, not loaded' : st.reachable === false ? `— ${st.error}` : 'NOT installed'}` : st.model;
  console.log(`local responder ${st.enabled ? 'on' : 'off'} · host ${st.node}${st.host ? ' (this machine)' : ''} · ${model} · tiers ${st.tiers.join(', ')} · tools ${st.tools.length}${st.lastError ? ` · last error: ${st.lastError}` : ''}`);
}

/** A secret from stdin: piped in, or typed at a prompt without echo. Never from argv (shell history, ps). */
async function readSecret(prompt) {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) { let s = ''; for await (const c of stdin) s += c; return s.trim(); }
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let s = '';
    const done = (v) => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', on); stderr.write('\n'); resolve(v); };
    const on = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(s.trim());
        if (ch === '\u0003') { done(''); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') s = s.slice(0, -1);
        else if (ch >= ' ') s += ch;
      }
    };
    stdin.on('data', on);
  });
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
      child = spawn(process.execPath, [path.join(HERE, 'rigs.js'), 'serve'], { stdio: 'inherit', env: { ...process.env, RIGS_SUPERVISOR_PID: String(process.pid) } });
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

/**
 * A `serve` whose supervisor is gone, or a throwaway one (own RIGS_HOME) whose launching shell is gone, has nobody
 * left to stop it: it would keep discovering, probing and answering on the tailnet forever. Leave instead.
 */
function exitWhenOrphaned() {
  const sup = Number(process.env.RIGS_SUPERVISOR_PID) || 0;
  const throwaway = !sup && !!process.env.RIGS_HOME;
  if (!sup && !throwaway) return;
  const parent = process.ppid;
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  setInterval(() => {
    const gone = sup ? !alive(sup) : process.ppid !== parent && !alive(parent);
    if (gone) { console.error(`[rigs] ${sup ? 'supervisor' : 'launching process'} is gone — stopping this orphaned server`); process.exit(0); }
  }, 30000).unref();
}

const commands = {
  async serve() {
    const { startServer } = await import('../src/server.js');
    const { config } = await import('../src/config.js');
    await startServer();
    exitWhenOrphaned();
    // The installed node (no throwaway RIGS_HOME) holds a sleep inhibitor while it serves.
    if (!process.env.RIGS_HOME) (await import('../src/keepawake.js')).startKeepAwake().catch(() => {});
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
  /** rigs preroute [on|off|engine <jev|claude|rules>|stats [--since 30d]] — pre-routing toggle and the time it saves */
  async preroute() {
    const [sub = 'status', val] = argv;
    const fail = (e) => { console.error(e || 'RIGS daemon is not running (rigs start).'); process.exit(1); };
    if (sub === 'stats') {
      const i = argv.indexOf('--since');
      const r = await daemonFetch(`/api/preroute/stats?since=${encodeURIComponent(i >= 0 ? argv[i + 1] : '30d')}`, { timeout: 60000 }).catch((e) => ({ error: e.message }));
      if (r.error || !r.classes) fail(r.error);
      const s = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`);
      console.log(`${r.requests} requests (${r.preroute.on} pre-routed, ${r.preroute.off} not) · saved ${s(r.total.savedMs)} in total, ${s(r.total.savedPerRequestMs)} per request${r.estimated ? ' (estimated)' : ''}`);
      for (const [c, x] of Object.entries(r.classes)) console.log(`  ${c.padEnd(7)} off ${s(x.off.medianMs).padStart(7)} (${x.off.n})  on ${s(x.on.medianMs).padStart(7)} (${x.on.n}, router ${s(x.on.routerMedianMs)})  baseline ${s(x.baselineMs)} [${x.baselineSource}]  saved ${s(x.savedPerRequestMs)}/req`);
      return;
    }
    const patch = sub === 'on' ? { preroute: true } : sub === 'off' ? { preroute: false } : sub === 'engine' ? { engine: val } : null;
    const r = await daemonFetch('/api/local/router', patch ? { method: 'POST', body: JSON.stringify(patch) } : {}).catch((e) => ({ error: e.message }));
    if (r.error || r.preroute === undefined) fail(r.error);
    console.log(`pre-routing ${r.preroute ? 'on' : 'off'} · engine ${r.engine} (fallback ${r.fallback})${r.engine === 'jev' ? ` · Jev API ${r.jevUrl || 'not found'}` : ''}`);
  },
  /** rigs connectors slack status|channels|history|search|post — the Slack connector through the local daemon */
  async connectors() {
    const [name, ...rest] = argv;
    const { parseSlackArgs, SLACK_USAGE } = await import('../src/connectors/slack-cli.js');
    if (name !== 'slack') { console.error(`usage: rigs connectors slack …\n${SLACK_USAGE}`); process.exit(1); }
    const req = parseSlackArgs(rest);
    if (req.error) { console.error(req.error); process.exit(1); }
    const r = await daemonFetch(req.path, { method: req.method, body: req.body ? JSON.stringify(req.body) : undefined }).catch((e) => ({ error: e.message }));
    if (typeof r === 'string' || r?.error) { console.error(typeof r === 'string' ? r : `${r.error}${r.code ? ` (${r.code})` : ''}`); process.exit(1); }
    console.log(JSON.stringify(r, null, 2));
  },
  /**
   * rigs quick [on|off|status] — the quick-task fast path (answers on Haiku / Sonnet instead of the full brain)
   * rigs quick local [on|off|status|warm|model <name>|node <machine>] — the local responder (src/responder.js)
   */
  async quick() {
    const [sub = 'status'] = argv;
    if (sub === 'local') return quickLocal(argv.slice(1));
    const patch = sub === 'on' ? { enabled: true } : sub === 'off' ? { enabled: false } : null;
    if (!patch && sub !== 'status') { console.error('usage: rigs quick [on|off|status]'); process.exit(1); }
    const r = await daemonFetch('/api/local/quick', patch ? { method: 'POST', body: JSON.stringify(patch) } : {}).catch((e) => ({ error: e.message }));
    if (r.error || r.enabled === undefined) { console.error(r.error || 'RIGS daemon is not running (rigs start).'); process.exit(1); }
    const t = (x) => `${x.provider} ${x.model}${x.effort ? ` (${x.effort})` : ''}`;
    console.log(`quick fast path ${r.enabled ? 'on' : 'off'} · simple ${t(r.simple)} · standard ${t(r.standard)} · max ${r.maxTurns} turns, ${Math.round(r.timeoutMs / 1000)} s`);
  },
  /** rigs linear [status] · rigs linear key [--clear] — the Linear connector (the key is read from stdin, never argv) */
  async linear() {
    const [sub = 'status'] = argv;
    const fail = (m) => { console.error(m || 'RIGS daemon is not running (rigs start).'); process.exit(1); };
    if (sub === 'key') {
      let body;
      if (argv.includes('--clear')) body = { clearKey: true };
      else {
        if (argv.length > 1) fail('usage: rigs linear key   (paste the key when asked, or pipe it in; never as an argument)');
        const key = await readSecret('Linear API key (lin_api_…): ');
        if (!key) fail('no key given — nothing changed');
        body = { apiKey: key };
      }
      const r = await daemonFetch('/api/local/linear/config', { method: 'POST', body: JSON.stringify(body) }).catch((e) => ({ error: e.message }));
      if (r.error || !r.apiKey) fail(r.error);
      console.log(r.apiKey.set ? `Linear key saved (${r.apiKey.source === 'env' ? 'from LINEAR_API_KEY' : 'in ~/.rigs/config.json'}).` : 'Linear key removed.');
    } else if (sub !== 'status') fail('usage: rigs linear [status] | rigs linear key [--clear]');
    const s = await daemonFetch('/api/local/linear/status', { timeout: 30000 }).catch((e) => ({ error: e.message }));
    if (s.error && s.configured === undefined) fail(s.error);
    if (!s.configured) { console.log(`Linear: not configured — ${s.message}`); process.exit(sub === 'status' ? 1 : 0); }
    const from = s.source === 'env' ? 'LINEAR_API_KEY' : 'config';
    if (!s.reachable) { console.log(`Linear: key set (${from}) but not reachable — ${s.error}`); process.exit(1); }
    console.log(`Linear: connected as ${s.user?.name || '?'}${s.user?.email ? ` <${s.user.email}>` : ''} · ${s.organization?.name || '?'} · key from ${from} · ${s.latencyMs} ms`);
    if (s.teams?.length) console.log(`  teams: ${s.teams.map((t) => `${t.key} (${t.name})`).join(', ')}`);
  },
  /** rigs usage [--since 7d] [--group model|project|task|node|day] · rigs usage backfill */
  async usage() {
    if (argv[0] === 'backfill') {
      const r = await daemonFetch('/api/local/usage/backfill', { method: 'POST', body: '{}', timeout: 10 * 60 * 1000 }).catch((e) => ({ error: e.message }));
      if (r.error) { console.error(r.error); process.exit(1); }
      console.log(`backfilled ${r.tasks} task run${r.tasks === 1 ? '' : 's'} and ${r.chatTurns} chat turn${r.chatTurns === 1 ? '' : 's'} (estimated)`);
      return;
    }
    const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
    const group = opt('--group', 'model');
    const qs = new URLSearchParams({ since: opt('--since', '7d'), groupBy: group, limit: '0' });
    const r = await daemonFetch(`/api/usage?${qs}`, { timeout: 60000 }).catch((e) => ({ error: e.message }));
    if (r.error || !r.totals) { console.error(r.error || 'RIGS daemon is not running (rigs start).'); process.exit(1); }
    const k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
    const h = (ms) => (ms / 3600000).toFixed(1) + 'h';
    console.log(`${r.totals.count} records since ${opt('--since', '7d')} · ${k(r.totals.totalTokens)} tokens · ${h(r.totals.durationMs)}${r.totals.costUsd != null ? ` · $${r.totals.costUsd.toFixed(2)}` : ''}`);
    for (const g of r.groups[group] || []) console.log(`  ${String(g.label).slice(0, 40).padEnd(40)} ${String(g.count).padStart(5)}  ${k(g.totalTokens).padStart(7)} tok  ${h(g.durationMs).padStart(7)}  ${g.done} done / ${g.failed} failed`);
    for (const e of r.errors || []) console.log(`  (${e.node}: ${e.error})`);
  },
  /** rigs exhibits attach <projectId> — build a project's exhibit document from its current state (it was running before exhibits were on) */
  async exhibits() {
    const [sub, id] = argv;
    if (sub !== 'attach' || !id) { console.error('usage: rigs exhibits attach <projectId>   — backfill the project\'s exhibit document (idempotent; run on the machine that owns the project)'); process.exit(1); }
    const r = await daemonFetch('/api/local/exhibits/attach', { method: 'POST', body: JSON.stringify({ projectId: id }), timeout: 60000 }).catch((e) => ({ error: e.message }));
    if (r?.error || !r?.docId) { console.error(r?.error || (typeof r === 'string' ? r : 'RIGS daemon is not running (rigs start).')); process.exit(1); }
    console.log(`${r.docId}: ${r.added} entr${r.added === 1 ? 'y' : 'ies'} added, ${r.entries} in the document${r.final ? ' (final)' : ''}`);
  },
  /** rigs starnet [status|on|off|install [--from <checkout>] [--force]|remove] — experimental StarNet space-station view (src/starnet.js) */
  async starnet() {
    const [sub = 'status'] = argv;
    const sn = await import('../src/starnet.js');
    const fail = (m) => { console.error(m); process.exit(1); };
    const show = (r, note = '') => {
      console.log(`StarNet space-station view ${r.enabled ? 'on' : 'off'} · ${r.installed ? `installed (${r.pinned ? 'pinned ' : ''}${r.ref.slice(0, 12)}${r.bytes ? `, ${Math.round(r.bytes / 1e6)} MB` : ''})` : 'not installed'} · ${r.dir}${note}`);
      if (r.enabled && !r.installed) console.log('  the galaxy stays on screen until the station files are here: rigs starnet install');
    };
    if (sub === 'status' || sub === 'on' || sub === 'off') {
      const patch = sub === 'status' ? null : { enabled: sub === 'on' };
      const r = await daemonFetch('/api/local/starnet/config', patch ? { method: 'POST', body: JSON.stringify(patch) } : {}).catch(() => null);
      if (r && r.enabled !== undefined) return show(r, patch ? ' — open JARVIS windows switch now' : '');
      if (r?.error) fail(r.error);
      // daemon not running: change the config file; the daemon reads it when it starts
      return show(patch ? sn.saveSettings(patch) : sn.status(), patch ? ' — saved; applies when the RIGS daemon starts' : ' (daemon not running)');
    }
    if (sub === 'install') {
      const i = argv.indexOf('--from');
      const from = i >= 0 ? argv[i + 1] : '';
      if (i >= 0 && !from) fail('usage: rigs starnet install [--from <StarNet checkout at the pinned commit>] [--force]');
      try {
        const r = await sn.install({ from, force: argv.includes('--force'), onProgress: (m) => console.log(`  ${m}`) });
        return show(r, r.already ? ' — already installed (--force reinstalls)' : '');
      } catch (e) { fail(`StarNet install failed: ${e.message}`); }
    }
    if (sub === 'remove') {
      const r = await sn.remove();
      console.log(`removed ${r.removed}${r.kept ? ` (left the custom dir ${r.kept} alone)` : ''}${r.enabled ? ' — the flag is still on: JARVIS shows the galaxy until it is reinstalled (rigs starnet off to switch it off)' : ''}`);
      return;
    }
    fail('usage: rigs starnet [status|on|off|install [--from <checkout>] [--force]|remove]');
  },
  /** rigs tools [list [query] [--tag t] [--kind tool|applet]] · rigs tools show <id> [--node n] · rigs tools run <id> ['{json}'] [--node n] [--allow-mutating] */
  async tools() {
    const [sub = 'list', ...rest] = argv;
    const flags = new Set(['--tag', '--kind', '--node', '--timeout', '--cwd']);
    const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
    const pos = rest.filter((x, i) => !x.startsWith('--') && !flags.has(rest[i - 1]));
    const fail = (msg) => { console.error(msg); process.exit(1); };
    const node = encodeURIComponent(opt('--node') || 'self');
    if (sub === 'list') {
      const qs = new URLSearchParams({ q: pos.join(' '), tag: opt('--tag') || '', kind: opt('--kind') || '', limit: '0' });
      const r = await daemonFetch(`/api/tools?${qs}`, { timeout: 60000 }).catch((e) => ({ error: e.message }));
      if (r.error || !r.results) fail(r.error || 'RIGS daemon is not running (rigs start).');
      if (!r.results.length) console.log('no tools or applets match');
      for (const x of r.results) {
        const what = x.kind === 'applet' ? `applet ${x.status}` : `${x.language} ${x.safety}${x.uses ? ` · ${x.uses} run${x.uses === 1 ? '' : 's'}` : ''}`;
        console.log(`${x.kind === 'applet' ? '▦' : '⚙'} ${String(x.id).padEnd(28)} ${String(x.node).padEnd(16)} ${what.padEnd(28)} ${String(x.description || '').split('\n')[0].slice(0, 70)}`);
      }
      for (const e of r.errors || []) console.log(`  (${e.node}: ${e.error})`);
      return;
    }
    if (sub === 'smoke') {
      // Run each tool's declared smoke call (a dry run) on this machine: `rigs tools smoke [id…]`, every tool without ids.
      const T = await import('../src/toolbox.js');
      const ids = pos.length ? pos : (await T.listLocal()).tools.map((t) => t.id);
      let bad = 0;
      for (const tid of ids) {
        const r = await T.smokeTool(tid).catch((e) => ({ ok: false, problem: e.message }));
        if (!r.ok && !r.skipped) bad++;
        console.log(`${r.ok ? '✓' : r.skipped ? '·' : '✗'} ${String(tid).padEnd(24)} ${r.durationMs != null ? `${r.durationMs} ms` : ''} ${r.problem || ''}`.trimEnd());
      }
      process.exit(bad ? 1 : 0);
    }
    const id = pos[0];
    if (!id || !['show', 'run'].includes(sub)) fail('usage: rigs tools [list [query] [--tag t] [--kind tool|applet]]\n       rigs tools show <id> [--node n]\n       rigs tools smoke [id…]   (run each tool\'s declared dry-run check on this machine)\n       rigs tools run <id> [\'{"arg": 1}\'] [--node n] [--allow-mutating] [--timeout sec] [--cwd dir]');
    if (sub === 'show') {
      const r = await daemonFetch(`/api/nodes/${node}/tools/${encodeURIComponent(id)}`).catch((e) => ({ error: e.message }));
      if (r.error || !r.manifest) fail(r.error || 'RIGS daemon is not running (rigs start).');
      console.log(JSON.stringify(r.manifest, null, 2));
      for (const [f, text] of Object.entries(r.files)) console.log(`\n--- ${f}\n${text}`);
      return;
    }
    let args = {};
    if (pos[1]) { try { args = JSON.parse(pos[1]); } catch { fail('arguments must be a JSON object, e.g. \'{"path": "~/x"}\''); } }
    const body = { args, allowMutating: rest.includes('--allow-mutating'), timeoutSec: Number(opt('--timeout')) || undefined, cwd: opt('--cwd') ? path.resolve(opt('--cwd')) : process.cwd() };
    const r = await daemonFetch(`/api/nodes/${node}/tools/${encodeURIComponent(id)}/run`, { method: 'POST', body: JSON.stringify(body), timeout: 11 * 60 * 1000 }).catch((e) => ({ error: e.message }));
    if (r.ok === undefined) fail(r.error ? `${r.error}${r.code ? ` (${r.code})` : ''}` : String(r));
    console.log(typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2));
    if (r.stderr) console.error(r.stderr);
    if (!r.ok) fail(`${id}: ${r.error || `exit code ${r.code}`}`);
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
          console.log(JSON.stringify({ label: p.label, name: p.name, app: p.app, built: fs.existsSync(p.hashFile), current: H.builtHash(p) === H.wantedHash(p), ...probe }, null, 2));
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
  rigs usage [--since 7d] [--group model|project|task|node|day]  tokens and time per model/task across the mesh
  rigs preroute [on|off|engine jev|claude|rules|stats]  pre-routing toggle (LocalJev router) and the time it saves
  rigs linear [status]  is the Linear connector configured and reachable (never prints the key)
  rigs linear key [--clear]  set the Linear API key (asked for, or piped in on stdin) or remove it
  rigs quick [on|off|status]  quick-task fast path: answers on Haiku (simple) / Sonnet (search, report) instead of the full brain
  rigs quick local [on|off|status|warm|model <m>|node <machine>]  the local responder: a local Ollama model answers the fast path (read-only tools)
  rigs connectors slack status|channels|history|search|post  Slack connector (post needs --confirm)
  rigs usage backfill  estimate ledger records from earlier project tasks and chats
  rigs exhibits attach <projectId>  build a project's exhibit document from its current state (idempotent)
  rigs starnet [status|on|off]  experimental: StarNet space station in place of the galaxy (this machine's UI)
  rigs starnet install [--from <checkout>] | remove  fetch StarNet's renderer at the pinned commit into ~/.rigs/starnet, or delete it
  rigs tools [list [query] [--tag t]]  search the tool registry + App Cloud applets across the mesh
  rigs tools show <id> | run <id> ['{json args}'] [--node n] [--allow-mutating]
                       read or run a filed tool (mutating tools need --allow-mutating)
  rigs service [uninstall]  (re)install or remove the autostart service`);
  },
};

const fn = commands[cmd];
if (!fn) { await commands.help(); process.exit(1); }
await fn();
