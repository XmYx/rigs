import { meshCatalogApps } from './apps.js';
import { config } from './config.js';
import { escapeRe, log, truncate } from './util.js';

/**
 * Dashboards (D5): an App Cloud app entry may declare `opensFor: { workspace, keywords[], path? }`. When a task starts
 * whose project matches `workspace` and whose text matches a keyword, RIGS opens that app in Sir's UI at `path`
 * (ui_open view "app") and the task's brief says Sir is watching it. The matching is pure (dashboardsFor); the push
 * goes through POST /api/mesh/ui/open on this machine's daemon (ctx.uiOpen replaces it in tests).
 */

const lower = (s) => String(s || '').toLowerCase();
const basename = (p) => lower(String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop());

/** Does the app's `opensFor.workspace` name this project: its repo folder's basename, its name, or a word of its goal? */
export function workspaceMatches(project, workspace) {
  const w = lower(workspace).trim();
  if (!w) return false;
  if (basename(project?.repo?.path) === w) return true;
  if (lower(project?.name).trim() === w) return true;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(w)}(?=$|[^\\p{L}\\p{N}_])`, 'iu');
  return re.test(String(project?.goal || '')) || re.test(String(project?.name || ''));
}

/** Which of the app's keywords appear (as whole words, case-insensitive) in the task's title, description or kind. */
export function keywordHits(task, keywords) {
  const text = `${task?.title || ''} ${task?.description || ''} ${task?.kind || ''}`;
  return (Array.isArray(keywords) ? keywords : []).map((k) => String(k || '').trim()).filter(Boolean)
    .filter((k) => new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(k)}(?=$|[^\\p{L}\\p{N}_])`, 'iu').test(text));
}

/**
 * The dashboards that watch this task: every app with `opensFor` whose workspace matches the project and whose
 * keywords hit the task. Pure. → [{ id, name, node, path, keywords }]
 */
export function dashboardsFor(project, task, apps) {
  const out = [];
  for (const a of Array.isArray(apps) ? apps : []) {
    const o = a?.opensFor;
    if (!o || typeof o !== 'object' || !a.id) continue;
    if (!workspaceMatches(project, o.workspace)) continue;
    const hits = keywordHits(task, o.keywords);
    if (!hits.length) continue;
    out.push({ id: String(a.id), name: String(a.name || a.id), node: String(a.node || config().name), path: typeof o.path === 'string' ? o.path : '', keywords: hits });
  }
  return out;
}

/** The apps the planner matches against: ctx.apps() when the server provides it, else the last aggregated mesh catalog. */
export async function knownApps(ctx) {
  try { return ctx?.apps ? (await ctx.apps()) || [] : meshCatalogApps(); } catch { return []; }
}

/** Push one ui-open to this machine's JARVIS UIs through the daemon's own API (the route the ui_open MCP tool uses). */
async function pushUiOpen(body) {
  if (process.env.RIGS_NO_OPENRIG === '1') return { ok: false, skipped: 'scratch node' };
  const r = await fetch(`http://127.0.0.1:${config().port}/api/mesh/ui/open`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-rigs-token': config().meshToken }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/**
 * Open every dashboard matched for a task in Sir's UI. Never throws; resolves to [{ app, ok, error? }] once every
 * push has been tried. `ctx.uiOpen(body)` replaces the daemon call (tests, or a server that wires its own).
 */
export async function openDashboards(project, task, ctx, { trace } = {}) {
  const open = ctx?.uiOpen || pushUiOpen;
  const results = [];
  for (const d of task?.dashboards || []) {
    const body = { view: 'app', app: d.id, node: d.node, path: d.path || '', ...(trace ? { trace } : {}) };
    try { const r = await open(body); results.push({ app: d.id, ok: r?.ok !== false, ...(r?.skipped ? { skipped: r.skipped } : {}) }); }
    catch (e) { results.push({ app: d.id, ok: false, error: truncate(e.message, 160) }); log(`project ${project?.id} ${task?.id}: opening dashboard ${d.id}: ${e.message}`); }
  }
  return results;
}

/** The brief's section for a task Sir watches on a dashboard (src/work.js adds it when the task carries `dashboards`). */
export function dashboardSection(dashboards) {
  const ds = (dashboards || []).filter((d) => d?.id);
  if (!ds.length) return '';
  const lines = ds.map((d) => `- **${d.name || d.id}**${d.path ? ` at ${d.path}` : ''} on ${d.node || 'this machine'}`);
  return `## Dashboard\nSir is watching ${ds.length === 1 ? `${ds[0].name || ds[0].id}${ds[0].path ? ` at ${ds[0].path}` : ''} on ${ds[0].node || 'this machine'}` : 'these dashboards'}:\n${lines.join('\n')}\nKeep it fed: make sure this run shows up there (for a run on another machine, mirror or sync it, e.g. \`scripts/mirror_magix_run.sh <run>\`) and report the dashboard path in your summary.\n\n`;
}
