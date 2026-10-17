// Router: keyword rules, model-output validation and project parsing (no model needed).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardRoute, heuristicRoute, parseDecision, parseProjects, withWork } from '../src/router.js';

const threads = [{ id: 't1', title: 'Props studio dashboard fix' }];

test('heuristicRoute: questions answer, code changes implement, multi-part goals plan', () => {
  assert.equal(heuristicRoute('what is the weather', threads).route, 'answer');
  assert.equal(heuristicRoute('build a login page for the app cloud', threads).route, 'implement');
  assert.equal(heuristicRoute('plan the whole deploy end to end', threads).route, 'plan');
});

test('heuristicRoute: imperative code requests about JARVIS itself implement', () => {
  assert.equal(heuristicRoute('implement in jarvis that in the future, requests like this get routed correctly', []).route, 'implement');
  assert.equal(heuristicRoute('patch the router so it stops misreading requests', []).route, 'implement');
  assert.equal(heuristicRoute('develop a status widget for the mesh', []).route, 'implement');
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

const TABLE = [
  // [phrase, expected route]
  ['make sure that\'s not happening', 'implement'],
  ['lets separate the questions panel, the projects panel, the active agents panel and the work log into their own pages', 'plan'],
  ['fix the router', 'implement'],
  ['please improve the navigation applet on mobile', 'implement'],
  ['can you make the galaxy view faster?', 'implement'],
  ['could you please update the nightly flow', 'implement'],
  ['JARVIS, add a dark mode toggle', 'implement'],
  ['I want you to rename the hubs tab to teams', 'implement'],
  ['lets run the Mad Mike update tonight', 'implement'],
  ['build a status page, deploy it to the linux machine, and set up a systemd unit for it', 'plan'],
  ['update the docs and also refactor chat.js, then add tests for it, and ship it to every machine', 'plan'],
  ['what is the weather', 'answer'],
  ['why did the last project fail?', 'answer'],
  ['how does the router decide where a request goes', 'answer'],
  ['is the navigation app running?', 'answer'],
  ['open the terminal window', 'answer'],
  ['read the README file', 'answer'],
  ['can you tell me which machines are online?', 'answer'],
];

test('guardRoute: imperatives are never answered, questions and one-step actions still are', () => {
  for (const [phrase, expected] of TABLE) {
    const got = guardRoute({ route: 'answer', reason: 'model said answer' }, phrase).route;
    assert.equal(got, expected, `${phrase} → ${got}, expected ${expected}`);
  }
});

test('guardRoute: leaves other routes and non-answers alone', () => {
  assert.equal(guardRoute({ route: 'plan' }, 'fix the router').route, 'plan');
  assert.equal(guardRoute({ route: 'continue', threadId: 'x' }, 'fix the router').route, 'continue');
});

test('withWork and heuristicRoute apply the guard', () => {
  assert.equal(withWork({ route: 'answer' }, 'make sure that\'s not happening', {}).route, 'implement');
  assert.equal(heuristicRoute('can you fix the router?', []).route, 'implement');
  assert.equal(heuristicRoute('what does the router do', []).route, 'answer');
});
