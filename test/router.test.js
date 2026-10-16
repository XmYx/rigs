// Router: keyword rules, model-output validation and project parsing (no model needed).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heuristicRoute, parseDecision, parseProjects } from '../src/router.js';

const threads = [{ id: 't1', title: 'Props studio dashboard fix' }];

test('heuristicRoute: questions answer, code changes implement, multi-part goals plan', () => {
  assert.equal(heuristicRoute('what is the weather', threads).route, 'answer');
  assert.equal(heuristicRoute('build a login page for the app cloud', threads).route, 'implement');
  assert.equal(heuristicRoute('plan the whole deploy end to end', threads).route, 'plan');
});

test('heuristicRoute: continues an ongoing thread only when the subject clearly matches', () => {
  const d = heuristicRoute('the props studio dashboard still crashes, fix it', threads);
  assert.equal(d.route, 'continue');
  assert.equal(d.threadId, 't1');
  assert.notEqual(heuristicRoute('what is the weather', threads).route, 'continue');
});

test('parseDecision: rejects unknown routes and threads that are not candidates', () => {
  assert.equal(parseDecision('{"route":"continue","threadId":"nope"}', threads, []), null);
  assert.equal(parseDecision('{"route":"dance"}', threads, []), null);
  assert.equal(parseDecision('no json here', threads, []), null);
  const ok = parseDecision('Sure: {"route":"continue","threadId":"t1","title":"x","reason":"same bug"}', threads, []);
  assert.equal(ok.threadId, 't1');
  assert.equal(ok.title, 'Props studio dashboard fix');
});

test('parseDecision: keeps a project only when it is an active one', () => {
  const projects = [{ id: 'rigs', name: 'RIGS', status: 'active' }];
  assert.equal(parseDecision('{"route":"implement","projectId":"rigs"}', [], projects).projectId, 'rigs');
  assert.equal(parseDecision('{"route":"implement","projectId":"ghost"}', [], projects).projectId, undefined);
});

test('parseProjects: reads the brain project list lines', () => {
  assert.deepEqual(parseProjects('- rigs · RIGS · active\n- x · Y z · running (2 running) · on m'), [
    { id: 'rigs', name: 'RIGS', status: 'active' },
    { id: 'x', name: 'Y z', status: 'running' },
  ]);
});
