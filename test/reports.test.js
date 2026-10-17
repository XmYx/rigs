// Results reach JARVIS durably, and switched-off providers never get work.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-reports-'));
const { routeProject, tell } = await import('../src/planner.js');
const { config } = await import('../src/config.js');
const chat = await import('../src/chat.js');

test('routing.avoid: a switched-off provider gets no task, even a cross-check review', () => {
  config().routing.avoid = ['codex'];
  try {
    const p = { name: 'x', goal: 'g', repo: { node: 'm', path: '' }, gitUrl: '', tasks: [
      { id: 't1', title: 'code', kind: 'code', size: 'M', deps: [], needs: { platform: 'any', gpu: false, tool: '' }, status: 'done', assign: { node: 'm', provider: 'claude' }, suggest: {} },
      { id: 't2', title: 'review', kind: 'review', size: 'M', deps: ['t1'], needs: { platform: 'any', gpu: false, tool: '' }, status: 'todo', suggest: { provider: 'codex' } },
    ] };
    const snap = [{ node: { name: 'm', online: true, rigs: true, platform: 'linux', stats: { cpu: 1, memUsed: 1, memTotal: 10 } }, brains: [{ id: 'claude', models: [] }, { id: 'codex', models: [] }] }];
    routeProject(p, snap);
    assert.equal(p.tasks[1].assign.provider, 'claude');
  } finally { config().routing.avoid = []; }
});

test('results and problems are kept in JARVIS; progress chatter is only spoken', async () => {
  const notes = []; const kept = [];
  const ctx = { notify: (t, l) => notes.push([t, l]), report: async (p, t, l) => kept.push([p.id, t, l]) };
  const p = { id: 'p1', name: 'P' };
  tell(ctx, p, 'P: started 2 tasks');
  tell(ctx, p, 'P is done', 'info', { keep: true });
  tell(ctx, p, 'P needs you', 'error');
  await new Promise((r) => setImmediate(r));
  assert.equal(notes.length, 3);
  assert.deepEqual(kept.map((k) => k[1]), ['P is done', 'P needs you']);
});

test('a report lands in the JARVIS thread and in the thread the request came from', async () => {
  const req = await chat.createChat({ title: 'MadMax FPS' });
  const r = await chat.postReport({ text: 'MadMax · FPS is done: 6 tasks finished.', chatId: req.id, project: { id: 'p9' } });
  assert.equal(r.chats.length, 2);
  const main = await chat.mainChat();
  const again = await chat.getChat(req.id);
  for (const c of [main, again]) {
    const m = c.messages.at(-1);
    assert.equal(m.report, true);
    assert.equal(m.project, 'p9');
    assert.match(m.text, /is done/);
  }
});
