// Which sessions in a mesh snapshot are live agents, and what are they doing? Pure (no DOM) so it is unit-tested.

const WORKING_MS = 45 * 1000; // output within this window = busy; older = at the prompt

const AGENT = /claude|codex/i;

/** A live agent session: Claude/Codex run, OpenRig seat, or a tmux/pty session whose agent is Claude/Codex. */
export function isLiveAgent(s) {
  if (!s || !s.live) return false;
  if (s.kind === 'claude' || s.kind === 'codex') return true;
  if (s.kind === 'rig') return true;
  if (s.kind === 'tmux' || s.kind === 'pty') return AGENT.test(s.agent || '');
  return false;
}

/** Waiting sessions reported by the machine's attention list, keyed `kind:id` (a rig seat may also match as tmux). */
function waitingKeys(entry) {
  const keys = new Set();
  for (const it of entry.attention || []) if (it.session?.id) keys.add(`${it.session.kind}:${it.session.id}`);
  return keys;
}

/** 'waiting' (needs Sir), 'working' (recent activity), else 'idle'. */
export function agentState(s, waiting, now = Date.now()) {
  if (waiting.has(`${s.kind}:${s.id}`) || (s.kind === 'rig' && waiting.has(`tmux:${s.id}`)) || (s.kind === 'tmux' && waiting.has(`rig:${s.id}`))) return 'waiting';
  return s.updatedAt && now - s.updatedAt < WORKING_MS ? 'working' : 'idle';
}

const family = (s) => (/codex/i.test(s.agent || s.kind) ? 'codex' : 'claude');

/**
 * A running agent in a terminal (tmux, seat, pty) is also seen as a transcript (kind claude/codex) with the
 * same cwd. Show the terminal — it is what a click attaches to — and drop one such transcript per terminal.
 */
function withoutShadowed(sessions) {
  const live = sessions.filter(isLiveAgent);
  const covered = new Map(); // `${family}:${cwd}` → number of terminals running there
  for (const s of live) if (s.kind !== 'claude' && s.kind !== 'codex' && s.cwd) { const k = `${family(s)}:${s.cwd}`; covered.set(k, (covered.get(k) || 0) + 1); }
  const byRecent = [...live].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const drop = new Set();
  for (const s of byRecent) {
    if ((s.kind !== 'claude' && s.kind !== 'codex') || !s.cwd) continue;
    const k = `${family(s)}:${s.cwd}`;
    if (covered.get(k) > 0) { covered.set(k, covered.get(k) - 1); drop.add(s); }
  }
  return live.filter((s) => !drop.has(s));
}

/** A finished agent stays listed this long after its end / last activity. */
export const FINISHED_WINDOW_MS = 12 * 60 * 60 * 1000;

/** An agent session that is no longer live (finished, failed or stopped); chats and plain shells are not agents. */
function isEndedAgent(s) {
  if (!s || s.live) return false;
  if (s.kind === 'claude' || s.kind === 'codex' || s.kind === 'rig') return true;
  if (s.kind === 'tmux' || s.kind === 'pty') return AGENT.test(s.agent || '');
  return false;
}

/** Agents across every online machine: live ones (waiting first, then most recently active), then ones that ended within 12h. */
export function activeAgents(snap, now = Date.now()) {
  const out = [];
  for (const e of snap || []) {
    if (!e.node?.online) continue;
    const waiting = waitingKeys(e);
    for (const s of withoutShadowed(e.sessions || [])) {
      out.push({ machine: e.node, session: s, state: agentState(s, waiting, now) });
    }
    for (const s of e.sessions || []) {
      if (isEndedAgent(s) && s.updatedAt && now - s.updatedAt < FINISHED_WINDOW_MS) out.push({ machine: e.node, session: s, state: 'done' });
    }
  }
  const rank = { waiting: 0, working: 1, idle: 2, done: 3 };
  return out.sort((a, b) => rank[a.state] - rank[b.state] || (b.session.updatedAt || 0) - (a.session.updatedAt || 0));
}

/** Stable id of a row, and a signature that changes when its state does (finished rows: when it ended). */
export const agentKey = (r) => `${r.machine?.id || r.machine?.name || ''}:${r.session.kind}:${r.session.id}`;
export const agentSig = (r) => (r.state === 'done' ? `done@${r.session.updatedAt || 0}` : r.state === 'waiting' ? 'waiting' : 'running');

/** Forget dismissals made more than 12h ago. `dismissed` is { key: { sig, at } }. */
export function pruneDismissed(dismissed, now = Date.now()) {
  const out = {};
  for (const [k, v] of Object.entries(dismissed || {})) if (v && now - v.at < FINISHED_WINDOW_MS) out[k] = v;
  return out;
}

/** Rows to show: inside the window (running/waiting always; finished within 12h) and not dismissed in their current state. */
export function filterAgents(list, { now = Date.now(), dismissed = {} } = {}) {
  return (list || []).filter((r) => {
    if (r.state === 'done' && !(r.session.updatedAt && now - r.session.updatedAt < FINISHED_WINDOW_MS)) return false;
    const d = dismissed[agentKey(r)];
    return !(d && d.sig === agentSig(r) && now - d.at < FINISHED_WINDOW_MS);
  });
}
