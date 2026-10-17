#!/usr/bin/env node
// End-to-end check of the completion loop on a scratch server (no OpenRig, no real agents, no updates):
//   RIGS_HOME=$PWD/.rigs-dev RIGS_NO_OPENRIG=1 RIGS_NO_AUTOUPDATE=1 RIGS_NO_MIGRATIONS=1 node scripts/e2e-completion-loop.js
// A fake `claude` (first on PATH, in a private tmux server) fails the task's first attempt and finishes the second.
// Passes when the retry is escalated one rung, the project reaches 100%, and exactly one "How did it work out, sir?"
// notification goes out. Writes the run to docs/audits/self-optimize-e2e.log.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = path.resolve(process.env.RIGS_HOME || path.join(ROOT, '.rigs-dev'));
const LOG = path.join(ROOT, 'docs', 'audits', 'self-optimize-e2e.log');
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
// Outside the checkout: the server runs from it, and agents are never started inside the RIGS checkout itself.
const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-e2e-loop-'));
const BIN = path.join(RUN, 'bin');
const WORK = path.join(RUN, 'work');
const AGENTS = path.join(RUN, 'agents.jsonl');
fs.mkdirSync(BIN, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });

const lines = [];
const t0 = Date.now();
const out = (s) => { const l = `[+${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${s}`; lines.push(l); console.log(l); };

// The scratch home is shared with scripts/mobile-shots.js: add what this run needs, put its config back afterwards.
const CFG = path.join(HOME, 'config.json');
const before = fs.existsSync(CFG) ? fs.readFileSync(CFG, 'utf8') : null;
const cfg = before ? JSON.parse(before) : {};
fs.writeFileSync(CFG, JSON.stringify({
  ...cfg,
  routing: { ...(cfg.routing || {}), avoid: ['codex'] }, // Codex is switched off: it must never be used
  persona: { ...(cfg.persona || {}), speakAloud: 'never' }, // no speech from a scratch node
  openrig: { ...(cfg.openrig || {}), registerPeers: false, hubs: { enabled: false, jarvis: false } },
  autonomy: { enabled: true, maxAttempts: 3, ladder: [], stallMinutes: 60, answerAfterSec: 90, maxSelfAnswers: 3, retryDelaySec: 60 },
}, null, 2));

// The fake agent: reads its brief, fails attempt 1 of every task, reports done on later attempts.
fs.writeFileSync(path.join(BIN, 'claude'), `#!${process.execPath}
const fs = require('fs');
const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('2.0.0 (Claude Code, e2e fake)'); process.exit(0); }
const flag = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const pointer = argv[argv.indexOf('--') + 1] || argv.at(-1) || '';
const brief = (pointer.match(/^Read (\\S+) and carry out/) || [])[1];
const text = brief ? fs.readFileSync(brief, 'utf8') : '';
const j = JSON.parse((text.match(/\\{"owner": "[^}]+"status"/) || ['{}'])[0].replace(/, "status"$/, '}') || '{}');
const attempt = Number((text.match(/This is attempt (\\d+)/) || [])[1] || 1);
const rec = { at: Date.now(), task: j.task, attempt, model: flag('--model'), effort: flag('--effort'), permissionMode: flag('--permission-mode'),
  disallowedTools: flag('--disallowedTools'), gitGuardInBrief: /## Git guard \\(enforced by RIGS\\)/.test(text), gitStepsStripped: !/git commit -am|git push\\./.test(text) && /RIGS removed \\d+ step/.test(text), previousFailureInBrief: /## Previous attempt \\d+ did not finish/.test(text) };
const fail = attempt === 1;
rec.reports = fail ? 'failed' : 'done';
fs.appendFileSync(${JSON.stringify(AGENTS)}, JSON.stringify(rec) + '\\n');
fetch(${JSON.stringify(BASE)} + '/api/local/projects/' + j.project + '/tasks/' + j.task, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ status: rec.reports, summary: fail ? 'e2e: simulated failure on the first attempt (npm test red: 2 failing)' : 'e2e: fixed on attempt ' + attempt + ' — npm test green' }) })
  .then((r) => r.text()).catch((e) => fs.appendFileSync(${JSON.stringify(AGENTS)}, JSON.stringify({ error: e.message }) + '\\n'))
  .finally(() => setTimeout(() => process.exit(0), 300));
`, { mode: 0o755 });

const env = {
  ...process.env, RIGS_HOME: HOME, RIGS_NO_OPENRIG: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_MIGRATIONS: '1',
  RIGS_PORT: String(PORT), RIGS_NAME: 'e2e-node', RIGS_PEERS: '', RIGS_MESH_TOKEN: 'e2e-token', RIGS_SSH_DIR: path.join(HOME, 'ssh'),
  RIGS_NO_SYSTEMD: '1', PATH: `${BIN}${path.delimiter}${process.env.PATH}`,
  TMUX_TMPDIR: RUN, // a private tmux server: its sessions get this PATH (the fake agent), never the user's tmux
};
delete env.TMUX;

const server = spawn(process.execPath, [path.join(ROOT, 'bin/rigs.js'), 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

const api = async (p, body) => {
  const r = await fetch(BASE + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (!r.ok) throw new Error(`${p} → ${r.status} ${JSON.stringify(j)}`);
  return j;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ok = false;
const notes = [];
try {
  out(`scratch server on :${PORT}, RIGS_HOME=${path.relative(ROOT, HOME)}, RIGS_NO_OPENRIG=1 RIGS_NO_AUTOUPDATE=1 RIGS_NO_MIGRATIONS=1, routing.avoid=["codex"]`);
  for (let i = 0; ; i++) {
    try { if ((await fetch(BASE + '/api/self')).ok) break; } catch {}
    if (i > 150) throw new Error('server did not start:\n' + serverOut);
    await sleep(200);
  }
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws.on('message', (m) => { try { const x = JSON.parse(m); if (x.type === 'notify') { notes.push(x); out(`NOTIFY [${x.level}] ${String(x.text).split('\n')[0]}`); } } catch {} });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });

  await api('/api/mesh/refresh', {}); // discovery knows this node before routing
  const p = await api('/api/local/projects', { name: 'E2E · fails first, then 100%', goal: 'Prove the completion loop: a failing first attempt is retried with escalation and the project reaches 100%.', repoPath: WORK, dispatch: 'direct' });
  await api(`/api/local/projects/${p.id}/tasks`, { id: 't1', title: 'Make the scratch tests pass', kind: 'code', size: 'M', description: 'Fix the code until npm test passes. Then git commit -am "fix" and git push.' });
  const routed = await api(`/api/local/projects/${p.id}`);
  out(`project ${p.id}: t1 routed → ${routed.tasks[0].reason}`);
  await api(`/api/local/projects/${p.id}/dispatch`, {});
  out('dispatched');

  let pr;
  for (let i = 0; i < 300; i++) {
    pr = await api(`/api/local/projects/${p.id}`);
    if (['done', 'blocked'].includes(pr.status)) break;
    await sleep(500);
  }
  out(`project status: ${pr.status}`);
  // One more planner tick (every 20 s) must not report the same end again.
  await sleep(25000);
  pr = await api(`/api/local/projects/${p.id}`);

  const agents = fs.existsSync(AGENTS) ? fs.readFileSync(AGENTS, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  out('--- agent invocations (fake claude, started by work.js startDirect in tmux) ---');
  for (const a of agents) out(`agent ${a.task} attempt ${a.attempt}: --model ${a.model} --effort ${a.effort} --permission-mode ${a.permissionMode} --disallowedTools ${a.disallowedTools} | git guard in brief: ${a.gitGuardInBrief} | "git commit -am … git push" stripped: ${a.gitStepsStripped} | previous failure in brief: ${a.previousFailureInBrief} → reports ${a.reports}`);
  out('--- project log ---');
  for (const e of pr.log) out(`  ${new Date(e.ts).toISOString().slice(11, 19)} ${e.text}`);
  const done = notes.filter((n) => /How did it work out, sir\?/.test(n.text));
  out('--- completion notification(s) ---');
  for (const n of done) for (const l of String(n.text).split('\n')) out(`  | ${l}`);
  const fb = await api(`/api/local/projects/${p.id}/feedback`, { text: 'e2e: it worked out — retried once, then done.', by: 'e2e' });
  out(`feedback stored on the project: ${JSON.stringify(fb.feedback.at(-1).text)}`);

  const checks = {
    'first attempt failed and was retried': agents.length === 2 && agents[0].reports === 'failed' && agents[1].attempt === 2,
    'retry escalated one rung (sonnet medium → opus high)': agents[0]?.model === 'claude-sonnet-5-5' && agents[0]?.effort === 'medium' && agents[1]?.model === 'claude-opus-5-5' && agents[1]?.effort === 'high',
    'retry brief carried the previous failure': agents[1]?.previousFailureInBrief === true,
    'codex never used': !pr.tasks.some((t) => t.assign?.provider === 'codex') && (pr.tasks[0].history || []).every((h) => h.provider !== 'codex'),
    'git guard: brief guarded and git writes denied to the agent': agents.every((a) => a.gitGuardInBrief && a.gitStepsStripped && /Bash\(git commit:\*\)/.test(a.disallowedTools) && /Bash\(git push:\*\)/.test(a.disallowedTools)),
    'project reached 100%': pr.status === 'done' && pr.tasks.every((t) => t.status === 'done'),
    'exactly one completion notification': done.length === 1,
  };
  out('--- checks ---');
  for (const [k, v] of Object.entries(checks)) out(`${v ? 'PASS' : 'FAIL'}  ${k}`);
  ok = Object.values(checks).every(Boolean);
  out(ok ? 'E2E PASSED' : 'E2E FAILED');
  ws.close();
} catch (e) {
  out('E2E ERROR: ' + e.stack);
} finally {
  server.kill();
  spawnSync('tmux', ['kill-server'], { env, stdio: 'ignore' });
  if (before !== null) fs.writeFileSync(CFG, before); else fs.rmSync(CFG, { force: true });
  fs.rmSync(RUN, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.writeFileSync(LOG, lines.join('\n') + '\n');
  process.exit(ok ? 0 : 1);
}
