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

/** Live agents across every online machine, waiting first, then most recently active. */
export function activeAgents(snap, now = Date.now()) {
  const out = [];
  for (const e of snap || []) {
    if (!e.node?.online) continue;
    const waiting = waitingKeys(e);
    for (const s of withoutShadowed(e.sessions || [])) {
      out.push({ machine: e.node, session: s, state: agentState(s, waiting, now) });
    }
  }
  const rank = { waiting: 0, working: 1, idle: 2 };
  return out.sort((a, b) => rank[a.state] - rank[b.state] || (b.session.updatedAt || 0) - (a.session.updatedAt || 0));
}
