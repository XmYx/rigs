// Pure part of the Projects window list (ui/src/projects.js): search, status filter, machine filter and sort.
// Tests: test/projects-model.test.js.

// Lower = more "live". Work in motion first, then work waiting on someone, then queued, parked and finished.
const RANK = { running: 0, planning: 0, merging: 0, blocked: 1, planned: 2, draft: 2, paused: 3, done: 4 };
export const rank = (status) => RANK[status] ?? 2;

export const STATUS_FILTERS = [
  ['all', 'All'],
  ['active', 'Active'],
  ['open', 'Not done'],
  ['blocked', 'Blocked'],
  ['paused', 'Paused'],
  ['done', 'Done'],
];

export const SORTS = [
  ['active', 'Active, then latest'],
  ['latest', 'Latest'],
  ['oldest', 'Oldest'],
  ['name', 'Name'],
  ['progress', 'Progress'],
];

export const DEFAULT_VIEW = { q: '', status: 'all', machine: '', sort: 'active' };

const time = (p) => Date.parse(p.updatedAt || p.createdAt || 0) || 0;
const progress = (p) => (p.tasks?.length ? p.tasks.filter((t) => t.status === 'done').length / p.tasks.length : 0);

export function matchesStatus(p, status) {
  switch (status) {
    case 'active': return rank(p.status) === 0;
    case 'open': return p.status !== 'done';
    case 'blocked': case 'paused': case 'done': return p.status === status;
    default: return true;
  }
}

// Every word of the query must appear in the name, goal, owner, id, status or a task title.
export function matchesQuery(p, q) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [p.name, p.goal, p.owner, p.id, p.status, ...(p.tasks || []).map((t) => t.title)].filter(Boolean).join('\n').toLowerCase();
  return words.every((w) => hay.includes(w));
}

const COMPARE = {
  active: (a, b) => rank(a.status) - rank(b.status) || time(b) - time(a),
  latest: (a, b) => time(b) - time(a),
  oldest: (a, b) => time(a) - time(b),
  name: (a, b) => String(a.name || '').localeCompare(String(b.name || '')),
  progress: (a, b) => progress(b) - progress(a) || time(b) - time(a),
};

export function viewProjects(list, view = {}) {
  const v = { ...DEFAULT_VIEW, ...view };
  const cmp = COMPARE[v.sort] || COMPARE.active;
  return (list || [])
    .filter((p) => matchesStatus(p, v.status) && (!v.machine || p.owner === v.machine) && matchesQuery(p, v.q))
    .sort(cmp);
}

export const machinesOf = (list) => [...new Set((list || []).map((p) => p.owner).filter(Boolean))].sort();

export function normalizeView(raw) {
  const v = { ...DEFAULT_VIEW, ...(raw && typeof raw === 'object' ? raw : {}) };
  if (!STATUS_FILTERS.some(([k]) => k === v.status)) v.status = DEFAULT_VIEW.status;
  if (!SORTS.some(([k]) => k === v.sort)) v.sort = DEFAULT_VIEW.sort;
  v.q = typeof v.q === 'string' ? v.q : '';
  v.machine = typeof v.machine === 'string' ? v.machine : '';
  return v;
}
