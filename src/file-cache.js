// Files agents create for a project, kept instead of forbidden. A task brief allows new files; the agent lists them in
// project_task_update `files` ([{ path, reason }]). A file reported WITHOUT a reason is not refused or redone: RIGS
// keeps it (the entry is marked `cached`, and a copy of a text file up to 2 MB goes to ~/.rigs/file-cache/<project>/,
// so it survives a worktree cleanup). When a later report gives the reason for the same path, the entry is explained,
// and every later brief lists the project's files so the next agent reuses them instead of writing them again.
// Pure except cacheCopies. Tests: test/file-cache.test.js.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { RIGS_HOME } from './config.js';

const MAX_FILES = 200;
export const CACHE_DIR = path.join(RIGS_HOME, 'file-cache');

/** Accepts [{ path, reason }] or ["path", …] from an agent; drops junk. */
export function normalizeReported(files) {
  if (!Array.isArray(files)) return [];
  return files.map((f) => (typeof f === 'string' ? { path: f } : f))
    .filter((f) => f && typeof f.path === 'string' && f.path.trim() && !f.path.includes('\0'))
    .map((f) => ({ path: f.path.trim(), reason: typeof f.reason === 'string' ? f.reason.trim().slice(0, 300) : '' }));
}

/**
 * Merge a task's report into the project's file list (p.files). A new path without a reason → cached; a reason for a
 * known path explains it (the cached copy stays as the fallback). Returns { files, added, explained }.
 */
export function mergeFiles(existing, reported, { task = '', node = '', now = Date.now() } = {}) {
  const files = (existing || []).map((f) => ({ ...f }));
  const added = [];
  const explained = [];
  for (const r of normalizeReported(reported)) {
    const f = files.find((x) => x.path === r.path && (!node || !x.node || x.node === node));
    if (f) {
      if (r.reason && !f.reason) { f.reason = r.reason; f.explainedBy = task; f.explainedAt = now; explained.push(f); }
      f.usedBy = [...new Set([...(f.usedBy || []), task].filter(Boolean))];
      continue;
    }
    const e = { path: r.path, node, task, reason: r.reason, at: now, ...(r.reason ? {} : { cached: true }) };
    files.push(e);
    added.push(e);
  }
  return { files: files.slice(-MAX_FILES), added, explained };
}

/** The brief section: files earlier tasks made, to reuse rather than recreate. Empty when there are none. */
export function filesBrief(files, { taskId = '' } = {}) {
  const list = (files || []).filter((f) => f.task !== taskId || f.reason);
  if (!list.length) return '';
  const row = (f) => `- \`${f.path}\`${f.node ? ` on ${f.node}` : ''} (${f.task || 'earlier'})${f.reason ? ` — ${f.reason}` : ' — kept, no reason given yet'}${f.copy ? ` · cached copy \`${f.copy}\`` : ''}`;
  return `## Files this project already has\nEarlier tasks created these. Reuse them instead of writing them again; if one is missing, restore it from its cached copy. If you use a file that has no reason yet, give it in your report.\n${list.slice(-40).map(row).join('\n')}\n\n`;
}

/** The rule every brief carries, next to the shared-folder notes. */
export const FILES_RULE = '- You may create new files whenever the task needs them. In `project_task_update`, list each new file in `files` as `{ "path", "reason" }` (one line why). A file you made before knowing why is still kept: list it without a reason and RIGS caches it, so nobody recreates it later.';

/**
 * Best effort: copy each cached (unexplained) file into ~/.rigs/file-cache/<project>/ through the node that has it
 * (`call(node, 'files/read?path=…')`). A copy is recorded on the entry; failures are ignored (the entry stays).
 */
export async function cacheCopies(projectId, entries, call, { dir = CACHE_DIR } = {}) {
  for (const e of entries || []) {
    if (!e.cached || e.copy || !e.node) continue;
    try {
      const r = await call(e.node, `files/read?path=${encodeURIComponent(e.path)}`, { timeout: 20000 });
      if (!r || r.truncated || typeof r.text !== 'string') continue;
      const sha = crypto.createHash('sha256').update(r.text).digest('hex').slice(0, 12);
      const out = path.join(dir, String(projectId).replace(/[^\w.-]/g, '_'), `${sha}-${path.basename(e.path).replace(/[^\w.-]/g, '_')}`);
      await fsp.mkdir(path.dirname(out), { recursive: true });
      await fsp.writeFile(out, r.text);
      Object.assign(e, { copy: out, sha });
    } catch { /* the node is offline or the file is binary/gone: keep the entry */ }
  }
}
