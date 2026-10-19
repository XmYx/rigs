import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { agentModes, claudeFlags, codexFlags } from './models.js';
import { bin } from './tools.js';
import * as openrig from './openrig.js';
import { listPtys, ptyTranscript, getPty, createPty, shellWrap } from './pty.js';
import { HOME, augmentedPath, isWin, run, spawnCmd, truncate } from './util.js';

const CLAUDE_DIR = path.join(HOME, '.claude', 'projects');
const CODEX_DIR = path.join(HOME, '.codex', 'sessions');
const LIVE_MS = 3 * 60 * 1000;
const LIMIT = 40;

async function readSlice(file, start, len) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally { await fh.close(); }
}

function parseLines(text, dropFirst = false, dropLast = false) {
  const lines = text.split('\n');
  if (dropFirst) lines.shift();
  if (dropLast) lines.pop();
  const out = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch {}
  }
  return out;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text')).map((b) => b.text).join('\n');
}

function cleanPrompt(t) {
  return String(t || '').replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function newestFiles(globDirs, limit) {
  const files = [];
  for (const d of globDirs) {
    let names = [];
    try { names = await fsp.readdir(d); } catch { continue; }
    await Promise.all(names.filter((n) => n.endsWith('.jsonl')).map(async (n) => {
      const f = path.join(d, n);
      try { const st = await fsp.stat(f); files.push({ file: f, mtime: st.mtimeMs, size: st.size }); } catch {}
    }));
  }
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

// ---------- Claude Code ----------
const claudeMetaCache = new Map();

async function claudeMeta(f) {
  const key = f.file + ':' + f.mtime;
  if (claudeMetaCache.has(key)) return claudeMetaCache.get(key);
  const head = parseLines(await readSlice(f.file, 0, 192 * 1024), false, f.size > 192 * 1024);
  const tail = f.size > 192 * 1024 ? parseLines(await readSlice(f.file, Math.max(0, f.size - 128 * 1024), 128 * 1024), true) : head;
  let cwd = '';
  let branch = '';
  let first = '';
  let title = '';
  let sessionId = path.basename(f.file, '.jsonl');
  for (const e of head) {
    if (!cwd && e.cwd) cwd = e.cwd;
    if (!branch && e.gitBranch) branch = e.gitBranch;
    if (!first && e.type === 'user' && !e.isMeta && !e.isSidechain) {
      const t = cleanPrompt(textOf(e.message?.content));
      if (t && !t.startsWith('Caveat:')) first = t;
    }
  }
  for (const e of [...head, ...tail]) {
    if (e.type === 'custom-title' && e.customTitle) title = e.customTitle;
    else if (e.type === 'ai-title' && (e.aiTitle || e.title) && !title) title = e.aiTitle || e.title;
    else if (e.type === 'summary' && e.summary && !title) title = e.summary;
  }
  const meta = { sessionId, cwd, branch, title: truncate(title || first || 'Claude session', 90) };
  claudeMetaCache.set(key, meta);
  return meta;
}

async function claudeSessions() {
  let dirs = [];
  try { dirs = (await fsp.readdir(CLAUDE_DIR)).map((d) => path.join(CLAUDE_DIR, d)); } catch { return []; }
  const files = await newestFiles(dirs, LIMIT);
  return Promise.all(files.map(async (f) => {
    const m = await claudeMeta(f);
    return {
      kind: 'claude', agent: 'claude', id: m.sessionId, title: m.title, cwd: m.cwd, branch: m.branch,
      project: m.cwd ? path.basename(m.cwd) : '', updatedAt: f.mtime, live: Date.now() - f.mtime < LIVE_MS, size: f.size,
    };
  }));
}

async function claudeTranscript(id, max = 400) {
  const f = await findClaudeFile(id);
  if (!f) return null;
  const st = await fsp.stat(f);
  const start = Math.max(0, st.size - 3 * 1024 * 1024);
  const entries = parseLines(await readSlice(f, start, st.size - start), start > 0);
  const msgs = [];
  for (const e of entries) {
    if (e.isSidechain || e.isMeta) continue;
    const ts = e.timestamp ? Date.parse(e.timestamp) : null;
    if (e.type === 'user') {
      const c = e.message?.content;
      if (Array.isArray(c) && c.some((b) => b.type === 'tool_result')) {
        for (const b of c.filter((x) => x.type === 'tool_result')) {
          const t = typeof b.content === 'string' ? b.content : textOf(b.content);
          msgs.push({ role: 'tool', text: truncate(t, 1200), ts });
        }
      } else {
        const t = textOf(c).trim();
        if (t) msgs.push({ role: 'user', text: t, ts });
      }
    } else if (e.type === 'assistant') {
      for (const b of e.message?.content || []) {
        if (b.type === 'text' && b.text?.trim()) msgs.push({ role: 'assistant', text: b.text, ts });
        else if (b.type === 'tool_use') msgs.push({ role: 'tool', name: b.name, text: truncate(JSON.stringify(b.input), 600), ts });
      }
    }
  }
  return msgs.slice(-max);
}

async function findClaudeFile(id) {
  if (!/^[\w-]+$/.test(id)) return null;
  let dirs = [];
  try { dirs = await fsp.readdir(CLAUDE_DIR); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(CLAUDE_DIR, d, id + '.jsonl');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// ---------- Codex ----------
async function codexDayDirs() {
  const out = [];
  const years = (await fsp.readdir(CODEX_DIR).catch(() => [])).sort().reverse();
  for (const y of years) {
    const months = (await fsp.readdir(path.join(CODEX_DIR, y)).catch(() => [])).sort().reverse();
    for (const m of months) {
      const days = (await fsp.readdir(path.join(CODEX_DIR, y, m)).catch(() => [])).sort().reverse();
      for (const d of days) out.push(path.join(CODEX_DIR, y, m, d));
      if (out.length > 60) return out;
    }
  }
  return out;
}

async function codexMeta(f) {
  const head = parseLines(await readSlice(f.file, 0, 128 * 1024), false, f.size > 128 * 1024);
  let id = '';
  let cwd = '';
  let first = '';
  for (const e of head) {
    const p = e.payload || {};
    if (e.type === 'session_meta') { id = p.id || id; cwd = p.cwd || cwd; }
    if (!first && e.type === 'event_msg' && p.type === 'user_message') first = cleanPrompt(p.message);
    if (!first && e.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      const t = cleanPrompt(textOf(p.content));
      if (t && !t.startsWith('<')) first = t;
    }
  }
  if (!id) id = (path.basename(f.file).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/) || [])[1] || path.basename(f.file, '.jsonl');
  return { id, cwd, title: truncate(first || 'Codex session', 90) };
}

async function codexSessions() {
  const files = await newestFiles(await codexDayDirs(), LIMIT);
  return Promise.all(files.map(async (f) => {
    const m = await codexMeta(f);
    return {
      kind: 'codex', agent: 'codex', id: m.id, title: m.title, cwd: m.cwd, project: m.cwd ? path.basename(m.cwd) : '',
      updatedAt: f.mtime, live: Date.now() - f.mtime < LIVE_MS, file: f.file, size: f.size,
    };
  }));
}

async function codexTranscript(id, max = 400) {
  const sessions = await codexSessions();
  const s = sessions.find((x) => x.id === id);
  if (!s) return null;
  const st = await fsp.stat(s.file);
  const start = Math.max(0, st.size - 3 * 1024 * 1024);
  const entries = parseLines(await readSlice(s.file, start, st.size - start), start > 0);
  const msgs = [];
  for (const e of entries) {
    const p = e.payload || {};
    const ts = e.timestamp ? Date.parse(e.timestamp) : null;
    if (e.type === 'event_msg' && p.type === 'user_message') msgs.push({ role: 'user', text: p.message, ts });
    else if (e.type === 'event_msg' && p.type === 'agent_message') msgs.push({ role: 'assistant', text: p.message, ts });
    else if (e.type === 'response_item' && (p.type === 'function_call' || p.type === 'local_shell_call' || p.type === 'custom_tool_call')) {
      msgs.push({ role: 'tool', name: p.name || p.type, text: truncate(p.arguments || JSON.stringify(p.action || p.input || ''), 600), ts });
    }
  }
  return msgs.slice(-max);
}

// ---------- tmux (incl. OpenRig seats) ----------
/** The agent a tmux session runs: from its command, else from startAgent's `<agent>-<folder>-<id>` name (Claude Code's
 *  native binary titles its process with its version, e.g. "2.1.303", so the command alone misses it). Pure. */
export function tmuxAgent(name, cmd) {
  if (/claude/i.test(cmd)) return 'claude';
  if (/codex/i.test(cmd)) return 'codex';
  if (/ollama/i.test(cmd)) return 'ollama';
  if (/^ssh-/.test(name)) return 'ssh';
  const started = /^(claude|codex|ollama)-/.exec(name || '');
  return started && !/^(-?bash|-?zsh|-?fish|sh|login)$/.test(cmd || '') ? started[1] : 'shell';
}

async function tmuxSessions() {
  const t = bin('tmux');
  if (!t || isWin) return [];
  const fmt = ['#{session_name}', '#{session_created}', '#{session_activity}', '#{session_attached}', '#{pane_current_path}', '#{pane_current_command}', '#{session_windows}'].join('|~|');
  const r = await run(t, ['list-sessions', '-F', fmt], { timeout: 4000 });
  if (r.code !== 0) return [];
  return r.stdout.split('\n').filter(Boolean).map((l) => {
    // Newer tmux rewrites tabs in -F output, so fields are split on a printable marker.
    const [name, created, activity, attached, cwd, cmd, windows] = l.split('|~|');
    const ssh = /^ssh-/.test(name);
    const agent = tmuxAgent(name, cmd);
    const sshFrom = ssh ? name.replace(/^ssh-/, '').replace(/--\d+$/, '') : undefined;
    return {
      kind: 'tmux', agent, id: name, title: ssh ? `SSH from ${sshFrom}${cmd && !/^(-?bash|-?zsh|sh)$/.test(cmd) ? ' · ' + cmd : ''}` : name, sshFrom, cwd, project: ssh ? '' : cwd ? path.basename(cwd) : '', command: cmd,
      updatedAt: Number(activity) * 1000, createdAt: Number(created) * 1000, live: true, attached: Number(attached) > 0, windows: Number(windows),
    };
  });
}

async function tmuxCapture(name, lines = 2000) {
  const t = bin('tmux');
  if (!t) return null;
  const r = await run(t, ['capture-pane', '-p', '-J', '-t', name, '-S', `-${lines}`], { timeout: 5000 });
  if (r.code !== 0) return null;
  return [{ role: 'terminal', text: r.stdout.replace(/\n+$/, '') }];
}

// ---------- unified ----------
export async function listSessions({ chats = [] } = {}) {
  const [claude, codex, tmux, rig] = await Promise.all([
    claudeSessions().catch(() => []), codexSessions().catch(() => []), tmuxSessions().catch(() => []), openrig.seats().catch(() => []),
  ]);
  // Tag tmux sessions that belong to OpenRig seats.
  const seatBySession = new Map(rig.map((s) => [s.session, s]));
  for (const t of tmux) {
    const seat = seatBySession.get(t.id);
    if (seat) { t.kind = 'rig'; t.rig = seat.rig; t.role = seat.role; t.agent = seat.runtime || t.agent; t.title = seat.title || t.title; }
  }
  const ptys = listPtys().map((p) => ({
    kind: 'pty', agent: p.meta?.agent || (p.kind === 'shell' ? 'shell' : p.kind), id: p.id, title: p.title, cwd: p.cwd,
    project: p.cwd ? path.basename(p.cwd) : '', updatedAt: p.lastActivity, live: !p.exited, clients: p.clients,
  }));
  const chatItems = chats.map((c) => ({
    kind: 'chat', agent: c.brain, id: c.id, title: c.title, model: c.model, updatedAt: c.updatedAt, live: false, messages: c.count,
  }));
  return [...ptys, ...tmux, ...chatItems, ...claude, ...codex].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function transcript(kind, id) {
  if (kind === 'claude') return claudeTranscript(id);
  if (kind === 'codex') return codexTranscript(id);
  if (kind === 'tmux' || kind === 'rig') return tmuxCapture(id);
  if (kind === 'pty') { const t = ptyTranscript(id); return t == null ? null : [{ role: 'terminal', text: t }]; }
  return null;
}

/** Type into a live session (tmux/OpenRig seat/our PTY), or continue a stored agent session headlessly. */
export async function send(kind, id, text) {
  if (kind === 'pty') {
    const p = getPty(id);
    if (!p || p.exited) throw new Error('terminal is not running');
    p.write(text + '\r');
    return { ok: true, delivered: 'pty' };
  }
  if (kind === 'rig' && bin('rig')) {
    const r = await run(bin('rig'), ['send', id, text], { timeout: 20000 });
    if (r.code === 0) return { ok: true, delivered: 'openrig', output: r.stdout.trim() };
  }
  if (kind === 'tmux' || kind === 'rig') {
    const t = bin('tmux');
    if (!t) throw new Error('tmux not available');
    const a = await run(t, ['send-keys', '-t', id, '-l', text], { timeout: 5000 });
    if (a.code !== 0) throw new Error(a.stderr.trim() || 'tmux send-keys failed');
    await run(t, ['send-keys', '-t', id, 'Enter'], { timeout: 5000 });
    return { ok: true, delivered: 'tmux' };
  }
  if (kind === 'claude' || kind === 'codex') return resumeWith(kind, id, text);
  throw new Error(`cannot type into a ${kind} session`);
}

/**
 * The numbered choice dialog on a live tmux/OpenRig screen ("❯ 1. Yes / 2. No" under a question), so the
 * chat can offer its answers without anyone attaching a terminal. Only a block at the bottom of the
 * screen counts: numbered lines in the middle of a reply are just text.
 */
export async function promptOptions(kind, id) {
  const t = bin('tmux');
  if (!t || (kind !== 'tmux' && kind !== 'rig') || !id) return null;
  const r = await run(t, ['capture-pane', '-p', '-J', '-t', id, '-S', '-40'], { timeout: 4000 });
  if (r.code !== 0) return null;
  const lines = r.stdout.split('\n').map((l) => l.replace(/\s+$/, ''));
  const opt = /^\s*(?:[❯>]\s*)?(\d{1,2})[.)]\s+(\S.*)$/;
  let end = lines.length - 1;
  while (end >= 0 && !lines[end].trim()) end--;
  while (end >= 0 && !opt.test(lines[end])) end--;
  if (end < 0) return null;
  // Below the options only the dialog's footer ("Esc to cancel", key hints) may follow.
  const tail = lines.slice(end + 1).filter((l) => l.trim());
  if (tail.some((l) => !/esc|enter|tab|cancel|↑|↓|select|navigate/i.test(l))) return null;
  let start = end;
  while (start > 0 && opt.test(lines[start - 1])) start--;
  const options = [];
  for (let i = start; i <= end; i++) { const m = lines[i].match(opt); options.push({ n: Number(m[1]), label: m[2].trim().slice(0, 120) }); }
  if (options.length < 2 || options.some((o, i) => o.n !== i + 1)) return null;
  let question = '';
  for (let i = start - 1; i >= 0 && i >= start - 8; i--) if (lines[i].trim()) { question = lines[i].replace(/^[│|\s]+|[│|\s]+$/g, '').trim(); break; }
  return { question: question.slice(0, 300), options };
}

/** Pick an option in a live tmux/OpenRig dialog: Claude Code and Codex take the option's number as a keypress. */
export async function answerOption(kind, id, choice) {
  const t = bin('tmux');
  if (!t) throw new Error('tmux not available');
  if (kind !== 'tmux' && kind !== 'rig') throw new Error(`cannot answer a ${kind} session here`);
  const n = String(choice ?? '').trim();
  if (!/^\d{1,2}$/.test(n)) throw new Error('choice must be an option number');
  const a = await run(t, ['send-keys', '-t', id, '-l', n], { timeout: 5000 });
  if (a.code !== 0) throw new Error(a.stderr.trim() || 'tmux send-keys failed');
  return { ok: true, delivered: 'tmux' };
}

// Stored Claude Code / Codex sessions are continued headlessly: `claude -p --resume <id>` and
// `codex exec resume <id>` append the turn to the same session, so its transcript (and the JARVIS chat
// dock attached to it) shows the reply. One turn at a time per session.
const resuming = new Map(); // `${kind}:${id}` → { startedAt }

export function resumeState(kind, id) {
  const r = resuming.get(`${kind}:${id}`);
  return r ? { running: true, startedAt: r.startedAt } : { running: false };
}

async function resumeWith(kind, id, text) {
  const key = `${kind}:${id}`;
  if (resuming.has(key)) throw new Error('that session is still working on the previous message');
  const tool = bin(kind);
  if (!tool) throw new Error(`${kind} is not installed on this machine`);
  let cwd;
  if (kind === 'claude') { const f = await findClaudeFile(id); if (!f) throw new Error('session not found'); cwd = (await claudeMeta({ file: f, mtime: 0, size: (await fsp.stat(f)).size })).cwd; }
  else cwd = (await codexSessions()).find((x) => x.id === id)?.cwd;
  if (cwd && !fs.existsSync(cwd)) cwd = undefined;
  const modes = agentModes();
  const args = kind === 'claude'
    ? ['-p', text, '--resume', id, '--permission-mode', modes.claude.permissionMode]
    : ['exec', 'resume', '--skip-git-repo-check', id, text];
  const env = { ...process.env, PATH: augmentedPath() };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDECODE') || k === 'CLAUDE_CODE_ENTRYPOINT') delete env[k];
  const child = spawnCmd(tool, args, { cwd: cwd || HOME, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr?.on('data', (d) => { if (err.length < 4000) err += d; });
  resuming.set(key, { startedAt: Date.now() });
  child.on('error', () => resuming.delete(key));
  child.on('close', (code) => { resuming.delete(key); if (code) console.error(`[sessions] ${kind} resume ${id} exited ${code}: ${err.trim().slice(-300)}`); });
  return { ok: true, delivered: 'resume', running: true };
}

function q(s) {
  return isWin ? `'${String(s).replace(/'/g, "''")}'` : `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Open (or reuse) a terminal attached to a session, on the machine where that session lives. */
export async function attach(kind, id, { cwd, cols, rows } = {}) {
  if (kind === 'pty') { if (!getPty(id)) throw new Error('terminal not found'); return { ptyId: id }; }
  let line;
  let dir = cwd;
  let title;
  if (kind === 'tmux' || kind === 'rig') { line = `tmux attach -t ${q(id)}`; title = `tmux · ${id}`; }
  else if (kind === 'claude') {
    if (!dir) { const f = await findClaudeFile(id); if (f) dir = (await claudeMeta({ file: f, mtime: 0, size: (await fsp.stat(f)).size })).cwd; }
    line = `claude --resume ${q(id)}`; title = 'claude · resume';
  } else if (kind === 'codex') {
    if (!dir) dir = (await codexSessions()).find((s) => s.id === id)?.cwd;
    line = `codex resume ${q(id)}`; title = 'codex · resume';
  } else throw new Error(`cannot attach to ${kind}`);
  const w = shellWrap(line);
  const p = createPty({ ...w, cwd: dir, cols, rows, title, kind, meta: { agent: kind === 'tmux' ? 'shell' : kind, attachOf: id } });
  return { ptyId: p.id };
}

/** Start a fresh agent (Claude Code / Codex / Ollama) on this machine, in tmux when available so it survives disconnects. */
export async function startAgent({ agent = 'claude', cwd, prompt = '', model = '', name } = {}) {
  const dir = cwd && fs.existsSync(cwd) ? cwd : HOME;
  let line;
  const modes = agentModes();
  if (agent === 'claude') line = ['claude', ...claudeFlags({ model, ...modes.claude }).map(q), prompt ? q(prompt) : ''].filter(Boolean).join(' ');
  else if (agent === 'codex') line = ['codex', ...codexFlags({ model, ...modes.codex }).map(q), prompt ? q(prompt) : ''].filter(Boolean).join(' ');
  else if (agent === 'ollama') line = `ollama run ${q(model || 'llama3.2')}`;
  else if (agent === 'rig') line = 'rig tui';
  else throw new Error('unknown agent ' + agent);
  const t = bin('tmux');
  if (t && !isWin) {
    const sname = (name || `${agent}-${path.basename(dir)}-${Date.now().toString(36).slice(-4)}`).replace(/[^\w.-]/g, '-');
    const sh = shellWrap(line);
    const r = await run(t, ['new-session', '-d', '-s', sname, '-c', dir, '-x', '200', '-y', '50', sh.cmd, ...sh.args], { timeout: 8000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'tmux new-session failed');
    return { kind: 'tmux', id: sname };
  }
  const p = createPty({ ...shellWrap(line), cwd: dir, title: `${agent} · ${path.basename(dir)}`, kind: agent, meta: { agent } });
  return { kind: 'pty', id: p.id, ptyId: p.id };
}
