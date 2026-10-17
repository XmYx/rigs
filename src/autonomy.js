import { config } from './config.js';
import { truncate } from './util.js';

/**
 * The completion loop's policy, kept pure so it can be unit-tested: how a project reaches 100% without Sir.
 * A task that fails, stalls or goes silent is retried with a fresh brief, one step up the model ladder each time,
 * until the project's attempt budget is spent; questions an agent asks get the standing safe-default answer; a
 * task never commits, pushes or switches branches outside a RIGS dev worktree; and when the loop ends Sir gets
 * one report that asks how it worked out. Settings: config.autonomy (see config.js).
 */

export const DEFAULT_LADDER = [
  { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
  { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
  { provider: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' },
];

const EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
const num = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);

/** Effective settings for a project: config.autonomy, with an optional per-project `p.autonomy` override. */
export function settings(p) {
  const a = { ...(config().autonomy || {}), ...(p?.autonomy || {}) };
  const avoid = (config().routing?.avoid || []).map((x) => String(x).toLowerCase());
  const ladder = (Array.isArray(a.ladder) && a.ladder.length ? a.ladder : DEFAULT_LADDER).filter((r) => r?.provider && !avoid.includes(r.provider));
  return {
    enabled: a.enabled !== false,
    maxAttempts: num(a.maxAttempts, 3, 1, 10),
    ladder,
    stallMs: num(a.stallMinutes, 60, 1, 24 * 60) * 60000,
    answerAfterMs: num(a.answerAfterSec, 90, 0, 3600) * 1000,
    maxAnswers: num(a.maxSelfAnswers, 3, 0, 20),
    retryDelayMs: num(a.retryDelaySec, 60, 0, 3600) * 1000,
  };
}

/** Where an assignment sits on the ladder: its exact rung, else the highest rung it is at least as strong as, else -1. */
export function rungOf(a, ladder) {
  if (!a) return -1;
  const exact = ladder.findIndex((r) => r.provider === a.provider && r.model === a.model && r.effort === a.effort);
  if (exact >= 0) return exact;
  const onLadder = ladder.some((r) => r.model === a.model);
  const e = EFFORTS.indexOf(a.effort || 'medium');
  let best = -1;
  ladder.forEach((r, i) => { if ((!onLadder || r.model === a.model) && EFFORTS.indexOf(r.effort) <= e) best = i; });
  return best;
}

/** The next rung up (the top rung stays the top rung); null when the ladder is empty (every provider switched off). */
export function nextAssign(a, ladder) {
  if (!ladder.length) return null;
  const i = Math.min(ladder.length - 1, rungOf(a, ladder) + 1);
  return { ...ladder[i], rung: i };
}

// ------------------------------------------------------------------ automatic answers

/** What RIGS answers, on Sir's behalf, when an agent asks something mid-task. */
export const selfAnswerText = (p, t, question) => `RIGS, answering for Sir (his standing answer — nobody else will reply): you asked or were stopped on: "${truncate(String(question || 'a question'), 400)}".
Take the safe default and carry on with task ${t.id}. Stay inside the task; pick the reversible, non-destructive option. Never delete data you did not create, never force-push, reset, stash or discard changes, publish, deploy or spend money, and never commit, push or switch branches outside a RIGS dev worktree. If a step needs one of those, skip it, finish everything else, and report "done" with the skipped step listed as a follow-up for Sir. If a permission prompt was declined, take another route (a different tool or a smaller step). Your question is logged on the task. Report with project_task_update (owner "${p.owner}", project "${p.id}", task "${t.id}") when you are done.`;

// ------------------------------------------------------------------ git guard

// Git writes a task may never run outside a dev worktree, and the ones it may never run even inside one.
const OUTSIDE = ['commit', 'push', 'checkout', 'switch', 'rebase', 'merge', 'pull', 'reset', 'stash', 'cherry-pick', 'revert', 'am'];
const INSIDE = ['push', 'checkout', 'switch'];
const forbidden = (devWorktree) => (devWorktree ? INSIDE : OUTSIDE);
const NEGATED = /(?<![\w-])(never|not|no|don't|do not|must not|without)(?![\w-])/i; // not the "no" in --no-edit

/** Claude Code `--disallowedTools` rules that enforce the guard for a directly started agent. */
export function gitDenyRules({ devWorktree = false } = {}) {
  return forbidden(devWorktree).map((c) => `Bash(git ${c}:*)`);
}

/** Does this command line (as an agent would run it) break the guard? */
export function gitViolation(command, { devWorktree = false } = {}) {
  const words = forbidden(devWorktree).map((c) => c.replace('-', '\\-')).join('|');
  const m = String(command || '').match(new RegExp(`\\bgit\\s+(?:-[Cc]\\s+\\S+\\s+|--?[\\w-]+(?:=\\S+)?\\s+)*(${words})(?![\\w-])`));
  return m ? m[1] : null;
}

/**
 * Make a task brief safe: every sentence that tells the agent to run a forbidden git step (or, outside a dev
 * worktree, to commit/push/switch branches in words) is removed, and the rule is stated at the end.
 * Sentences that forbid the step ("do not push") stay. Returns { prompt, stripped }.
 */
export function guardBrief(prompt, { devWorktree = false, branch = '' } = {}) {
  const words = forbidden(devWorktree);
  const plain = new RegExp(`^(?:then\\s+|and\\s+|finally\\s+)?(?:${devWorktree ? 'push|switch (?:to )?(?:another |a )?branch' : 'commit|push|check ?out|switch (?:to )?(?:another |a |the )?branch|create (?:a |your own )?(?:work )?branch|rebase|merge'})\\b`, 'i');
  const stripped = [];
  const bad = (s) => !NEGATED.test(s) && (gitViolation(s, { devWorktree }) || plain.test(s.replace(/^[\s>*\-\d.)\]`'"]+/, '')));
  const lines = String(prompt).split('\n').flatMap((line) => {
    const parts = line.split(/(?<=[.;!?])\s+/);
    const keep = parts.filter((s) => { if (bad(s)) { stripped.push(s.trim()); return false; } return true; });
    if (keep.length === parts.length) return [line];
    return keep.length ? [keep.join(' ')] : [];
  });
  const rule = devWorktree
    ? `## Git guard (enforced by RIGS)\nThis folder is a RIGS dev worktree${branch ? ` on branch \`${branch}\`` : ''}: commit here. Never push and never switch branches (git ${words.join(' / ')} are blocked) — RIGS hands the branch to the merge steward.`
    : `## Git guard (enforced by RIGS)\nThis folder is not a RIGS dev worktree: no commits, pushes or branch switches here (git ${words.join(', ')} are blocked). Leave every change in the working tree and list the files plus a suggested commit message in your summary.`;
  const note = stripped.length ? `\nRIGS removed ${stripped.length} step${stripped.length > 1 ? 's' : ''} from this brief that asked for one of these.` : '';
  return { prompt: `${lines.join('\n').replace(/\s+$/, '')}\n\n${rule}${note}\n`, stripped };
}

// ------------------------------------------------------------------ the end of the loop

const modelLine = (h) => [h.provider, h.model, h.effort].filter(Boolean).join(' ');

/**
 * The one message Sir gets when the loop stops (100%, budget spent, or a hand-off that can't finish): what was
 * done, what was retried, what is still open, and the question. Spoken line first, details after '---'.
 */
export function completionReport(p, { why = 'done', merged = '' } = {}) {
  const n = p.tasks.length;
  const done = p.tasks.filter((t) => t.status === 'done');
  const open = p.tasks.filter((t) => t.status !== 'done');
  const retried = p.tasks.filter((t) => t.attempts > 0 || t.history?.length);
  const asked = p.tasks.flatMap((t) => (t.questions || []).map((q) => ({ t, q })));
  const pct = n ? Math.round((done.length / n) * 100) : 100;
  const head = why === 'done'
    ? `${p.name} reached 100%: ${n} task${n === 1 ? '' : 's'} done${merged ? ', merged and rolled out' : ''}${retried.length ? `, ${retried.length} after a retry` : ''}.`
    : `${p.name} stopped at ${pct}%: ${why}.`;
  const lines = [
    merged ? `Merged as ${merged}.` : '',
    `**Done (${done.length}/${n})**`,
    ...done.map((t) => `- ${t.title} (${t.assign?.node || '?'}, ${modelLine(t.assign || {}) || '?'}): ${truncate(t.summary || 'done', 300)}`),
    retried.length ? `\n**Retried**` : '',
    ...retried.map((t) => `- ${t.title}: ${(t.history || []).map((h) => `attempt ${h.attempt} ${modelLine(h)} — ${truncate(h.why, 120)}`).join('; ')}${t.status === 'done' ? ` → done with ${modelLine(t.assign || {})}` : ''}`),
    asked.length ? `\n**Answered automatically (safe default)**` : '',
    ...asked.map(({ t, q }) => `- ${t.id}: ${truncate(q.question, 160)}`),
    open.length ? `\n**Still open**` : '',
    ...open.map((t) => `- ${t.title}: ${t.status}${t.lastFailure || t.summary ? ' — ' + truncate(t.lastFailure || t.summary, 200) : ''}`),
    `\n(JARVIS: store Sir's answer with project_feedback — owner "${p.owner}", project "${p.id}".)`,
  ].filter(Boolean);
  return `${head} How did it work out, sir?\n---\n${lines.join('\n')}`;
}
