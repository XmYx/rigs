// Plan coordination (optional, config.routing.coordinate or a project's own `coordinate`): before anything starts,
// the planner's task proposals are revised so parallel workers do not edit the same files and the merge steward gets
// fewer conflicts. Deterministic, no model call (no extra tokens). With coordination on, the planner proposes for
// every task the files it expects to edit (`files`) and the tests it would write (`tests`); then:
//  1. Merge: two tasks whose files mostly overlap (≥ half of the smaller set) become one task, unless both are L
//     (too big for one session together): one agent edits those files, nobody waits on or conflicts with another.
//  2. Testing agent: when two or more tasks would write tests, one "test" task writes them all after those tasks;
//     the workers run only the existing tests for their own files (the full suite runs once, in the test task).
//  3. Serialize: tasks that still share a file get a dependency (the later one waits for the earlier), never a cycle.
//  4. Ownership: every brief lists the files owned by tasks that may run at the same time ("don't edit these").
// Review tasks are never merged or serialized. Tests: test/coordinate.test.js.

const isReview = (t) => t.kind === 'review';
const editable = (t) => !isReview(t) && ['code', 'test', 'docs', 'text', 'architecture'].includes(t.kind);

export function normalizeFiles(x) {
  const list = Array.isArray(x) ? x : typeof x === 'string' && x ? x.split(/[,\n]/) : [];
  return [...new Set(list.map((f) => String(f).trim().replace(/^\.\//, '')).filter((f) => f && f.length < 200 && !f.includes('\0')))].slice(0, 40);
}

// A glob ("src/*.js", "ui/**") or a folder ("src/") covers the paths under it.
const covers = (a, b) => {
  if (a === b) return true;
  if (a.endsWith('/')) return b.startsWith(a);
  if (a.includes('*')) return new RegExp('^' + a.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$').test(b);
  return false;
};
export const shared = (fa, fb) => fa.filter((a) => fb.some((b) => covers(a, b) || covers(b, a)));
const overlapRatio = (fa, fb) => (fa.length && fb.length ? shared(fa, fb).length / Math.min(fa.length, fb.length) : 0);

function dependsOn(tasks, from, target, seen = new Set()) {
  if (from.id === target.id) return true;
  if (seen.has(from.id)) return false;
  seen.add(from.id);
  return from.deps.some((d) => { const x = tasks.find((t) => t.id === d); return x && dependsOn(tasks, x, target, seen); });
}
const SIZE = { S: 1, M: 2, L: 3 };
const mergedSize = (a, b) => (SIZE[a] + SIZE[b] >= 4 ? 'L' : 'M');

/** Revise a plan. `tasks` are normalized planner tasks (with files / tests). → { tasks, notes: [string] }. Pure. */
export function coordinateTasks(input, { mergeAt = 0.5 } = {}) {
  let tasks = input.map((t) => ({ ...t, deps: [...(t.deps || [])], files: normalizeFiles(t.files), tests: String(t.tests || '').trim() }));
  const notes = [];
  const renameDep = (from, to) => { for (const t of tasks) t.deps = [...new Set(t.deps.map((d) => (d === from ? to : d)))].filter((d) => d !== t.id); };

  // 1. merge tasks on the same files
  for (let changed = true; changed;) {
    changed = false;
    outer: for (const a of tasks) {
      for (const b of tasks) {
        if (a === b || !editable(a) || !editable(b) || a.needs?.tool !== b.needs?.tool || (a.needs?.platform || 'any') !== (b.needs?.platform || 'any')) continue;
        if (tasks.indexOf(b) < tasks.indexOf(a) || overlapRatio(a.files, b.files) < mergeAt || (a.size === 'L' && b.size === 'L')) continue;
        Object.assign(a, {
          title: `${a.title} + ${b.title}`.slice(0, 120),
          description: `${a.description}\n\nAlso (merged from ${b.id}, it edits the same files): ${b.description}`,
          size: mergedSize(a.size, b.size),
          deps: [...new Set([...a.deps, ...b.deps])].filter((d) => d !== a.id && d !== b.id),
          files: [...new Set([...a.files, ...b.files])],
          tests: [a.tests, b.tests].filter(Boolean).join('; '),
          acceptance: [...new Set([...(a.acceptance || []), ...(b.acceptance || [])])].slice(0, 8),
          verify: [a.verify, b.verify].filter(Boolean).join(' · ').slice(0, 600),
          mergedFrom: [...(a.mergedFrom || []), b.id],
        });
        tasks = tasks.filter((t) => t !== b);
        renameDep(b.id, a.id);
        notes.push(`merged ${b.id} into ${a.id}: both edit ${shared(a.files, b.files).slice(0, 3).join(', ')}`);
        changed = true;
        break outer;
      }
    }
  }

  // 2. one testing agent for the tests several tasks would write
  const testers = tasks.filter((t) => editable(t) && t.kind !== 'test' && t.tests);
  if (testers.length >= 2) {
    let n = tasks.length + 1;
    while (tasks.some((t) => t.id === `t${n}`)) n++;
    const id = `t${n}`;
    const tt = {
      ...testers[0], id, kind: 'test', size: testers.length > 3 ? 'L' : 'M', mergedFrom: undefined,
      title: `Tests for ${testers.map((t) => t.id).join(', ')}`,
      description: `Write the tests the other tasks would each have written, once, after they finish:\n${testers.map((t) => `- ${t.id} ${t.title}: ${t.tests}`).join('\n')}\nThen run the whole test suite once and fix or report what fails.`,
      deps: testers.map((t) => t.id), files: [], tests: '',
      acceptance: ['every listed test exists and passes', 'the full test suite passes'], verify: 'the full test suite; list the command and its result',
      status: 'todo', assign: null, reason: '', run: null, summary: '',
    };
    for (const t of testers) {
      t.description += `\n\nTests for this work are written by ${id} after you: do not write new tests; run only the existing tests that cover the files you changed.`;
      t.tests = '';
    }
    for (const r of tasks.filter(isReview)) r.deps = [...new Set([...r.deps, id])];
    tasks.push(tt);
    notes.push(`${id} writes the tests of ${testers.map((t) => t.id).join(', ')} (one testing agent, one full test run)`);
  }

  // 3. serialize what still shares files
  for (const a of tasks) {
    for (const b of tasks) {
      if (tasks.indexOf(b) <= tasks.indexOf(a) || !editable(a) || !editable(b)) continue;
      const both = shared(a.files, b.files);
      if (!both.length || dependsOn(tasks, b, a) || dependsOn(tasks, a, b)) continue;
      b.deps.push(a.id);
      notes.push(`${b.id} waits for ${a.id}: both edit ${both.slice(0, 3).join(', ')}`);
    }
  }
  return { tasks, notes };
}

/** Brief section: files that tasks able to run at the same time own. Empty when there are none. Pure. */
export function ownershipBrief(tasks, t) {
  const parallel = tasks.filter((x) => x.id !== t.id && x.files?.length && x.status !== 'done' && !dependsOn(tasks, t, x) && !dependsOn(tasks, x, t));
  const mine = t.files?.length ? `Your files: ${t.files.join(', ')}.\n` : '';
  if (!parallel.length && !mine) return '';
  return `## Coordination\n${mine}${parallel.length ? `Other agents work at the same time on these files: do not edit them (note what you would change there in your summary instead):\n${parallel.map((x) => `- ${x.id}: ${x.files.join(', ')}`).join('\n')}\n` : ''}\n`;
}

/** What the planner is asked for when coordination is on. */
export const PLAN_FIELDS_NOTE = `- Coordination is on: give every task "files" (the paths or globs it expects to edit, best guess) and "tests" (the tests it
  would write, or ""). RIGS merges tasks on the same files, serializes overlapping ones and gives the tests to one testing agent.`;
