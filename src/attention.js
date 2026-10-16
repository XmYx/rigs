import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import * as openrig from './openrig.js';
import { bin } from './tools.js';
import { HOME, isWin, run } from './util.js';

/**
 * "An agent needs you" — one feed per machine, from the agents' own signals (best first):
 *  1. Claude Code self-report: ~/.claude/sessions/<pid>.json status "waiting" (a permission or
 *     question dialog is open). It names the tmux pane, so JARVIS can jump straight to it.
 *  2. OpenRig seats: needs-input activity, attention_required startup/lifecycle.
 *  3. Codex: its `notify` hook ("approval-requested" … "agent-turn-complete"), via `rigs hook codex`.
 *  4. Fallback: visible approval chrome in other agents' tmux panes / RIGS terminals.
 *  5. Project tasks an agent marked blocked (or that ended without reporting).
 * Items carry a session reference the UI can attach to.
 */

export const events = new EventEmitter();
const codexPending = new Map(); // key -> item from the codex notify hook
let current = [];
let primed = false; // the first pass after a (re)start only learns what is already waiting — no re-announcing

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function tmuxRef(pane) {
  // "task-code@app-cloud-szuf-t1:@2.%2" → session "task-code@app-cloud-szuf-t1"
  const name = String(pane || '').split(':')[0];
  if (!name) return null;
  return { kind: name.includes('@') ? 'rig' : 'tmux', id: name };
}

function claudeWaiting() {
  const dir = path.join(HOME, '.claude', 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)); } catch { return []; }
  const out = [];
  for (const f of files) {
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (s.status !== 'waiting' || !alive(s.pid)) continue;
    out.push({
      key: `claude:${s.sessionId || s.pid}`, agent: 'claude', kind: 'waiting',
      title: s.name || path.basename(s.cwd || '') || 'Claude Code', cwd: s.cwd,
      reason: 'waiting for your answer (permission or question)', since: s.statusUpdatedAt || s.updatedAt || Date.now(),
      session: tmuxRef(s.tmux) || { kind: 'claude', id: s.sessionId }, where: s.entrypoint === 'claude-desktop' ? 'Claude app' : s.tmux ? 'tmux' : 'terminal',
    });
  }
  return out;
}

// A live seat waiting on a person. Detached seats that failed to start ("attention_required" with no
// session) are broken, not asking — they would blink forever, so they're left to `rig ps`.
const RIG_GONE = /detached|stopped|exited|dead|failed/i;
async function openrigNeeds() {
  const st = await openrig.status().catch(() => ({}));
  return rigNeeds(st.nodes || []);
}

export function rigNeeds(nodes) {
  return nodes.filter((n) => !RIG_GONE.test(n.status || '') && (/needs?_input|blocked/i.test(n.activity || '') || /attention|needs?_input/i.test(n.startupStatus || '')))
    .map((n) => ({
      key: `rig:${n.session}`, agent: n.runtime === 'codex' ? 'codex' : 'claude', kind: 'needs-input',
      title: n.title, reason: n.reason || n.startupStatus || 'needs input', since: Date.now(),
      session: { kind: 'rig', id: n.session },
    }));
}

export const CHROME = [
  /would you like to (run|make|apply)/i, /allow (this )?command\??/i, /approve (this|the)/i, /do you want to (proceed|make this edit|create|allow)/i,
  /\b(yes|y)\b.{0,30}\b(no|n)\b.{0,30}(esc|enter)/i, /\[y\/n\]|\(y\/n\)|\[Y\/n\]/, /press enter to (confirm|continue)/i,
  // Codex: folder trust and hook review screens block a session before it even starts.
  /trust this folder\?|do you trust the (contents|files)/i, /hooks? needs? review/i, /enter (confirm|continue) · esc/i,
];

async function paneChrome(skip) {
  const t = bin('tmux');
  if (!t || isWin) return [];
  const ls = await run(t, ['list-panes', '-a', '-F', '#{session_name}|~|#{pane_current_command}|~|#{pane_id}'], { timeout: 4000 });
  if (ls.code !== 0) return [];
  const out = [];
  for (const line of ls.stdout.split('\n').filter(Boolean)) {
    const [session, cmd, pane] = line.split('|~|');
    if (skip.has(session) || !/codex|node|ollama|gemini|aider|python/i.test(cmd)) continue;
    const cap = await run(t, ['capture-pane', '-p', '-J', '-t', pane, '-S', '-25'], { timeout: 3000 });
    const tail = cap.stdout.split('\n').filter((l) => l.trim()).slice(-12).join('\n');
    if (!CHROME.some((re) => re.test(tail))) continue;
    out.push({
      key: `pane:${session}`, agent: /codex/i.test(cmd) ? 'codex' : cmd, kind: 'waiting', title: session,
      reason: 'prompt on screen: ' + (tail.split('\n').reverse().find((l) => CHROME.some((re) => re.test(l))) || '').trim().slice(0, 100),
      since: Date.now(), session: { kind: session.includes('@') ? 'rig' : 'tmux', id: session },
    });
  }
  return out;
}

/** Codex notify hook payloads (`rigs hook codex '<json>'`). */
export function codexEvent(payload) {
  const p = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const key = `codex:${p['thread-id'] || p.thread_id || p.cwd || 'default'}`;
  const type = p.type || '';
  if (/approval/i.test(type)) {
    codexPending.set(key, {
      key, agent: 'codex', kind: 'waiting', title: path.basename(p.cwd || '') || 'Codex', cwd: p.cwd,
      reason: 'approval requested' + (p.command ? `: ${[].concat(p.command).join(' ').slice(0, 100)}` : ''), since: Date.now(),
      session: p.tmux ? tmuxRef(p.tmux) : null,
    });
  } else codexPending.delete(key);
  refresh().catch(() => {});
  return { ok: true };
}

let lastProjects = [];
let chain = Promise.resolve();

/** Recompute (serialized: the 5 s tick and hook events never race); emits 'new' for items that just appeared. */
export function refresh(opts = {}) {
  chain = chain.then(() => compute(opts), () => compute(opts));
  return chain;
}

async function compute({ projects } = {}) {
  if (projects) lastProjects = projects; else projects = lastProjects;
  const claude = claudeWaiting();
  // Claude's own report is the better one for a seat it runs in; OpenRig's only fills the gaps.
  const claudeSessions = new Set(claude.map((x) => x.session?.id));
  const rig = (await openrigNeeds()).filter((x) => !claudeSessions.has(x.session.id));
  const covered = new Set([...claude, ...rig, ...codexPending.values()].map((x) => x.session?.id).filter(Boolean));
  const panes = await paneChrome(covered);
  const tasks = projects.flatMap((p) => (p.tasks || []).filter((t) => t.status === 'blocked' || t.status === 'review').map((t) => ({
    key: `task:${p.id}:${t.id}`, agent: t.assign?.provider || 'agent', kind: t.status === 'blocked' ? 'blocked' : 'review',
    title: `${p.name}: ${t.title}`, reason: t.summary || (t.status === 'blocked' ? 'the agent is blocked' : 'session ended without reporting'),
    since: p.updatedAt, session: t.run?.session || null, project: { id: p.id, task: t.id }, node: t.assign?.node,
  })));
  const seen = new Set();
  const next = [...claude, ...rig, ...codexPending.values(), ...panes, ...tasks].filter((x) => !seen.has(x.key) && seen.add(x.key));
  const before = new Set(current.map((x) => x.key));
  const fresh = next.filter((x) => !before.has(x.key));
  const changed = fresh.length || next.length !== current.length;
  current = next;
  if (fresh.length && primed) events.emit('new', fresh);
  primed = true;
  if (changed) events.emit('change', current);
  return current;
}

export function list() { return current; }
