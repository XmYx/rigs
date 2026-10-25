// Plan coordination (src/coordinate.js): merge same-file work, one testing agent, serialize overlaps, ownership briefs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coordinateTasks, normalizeFiles, ownershipBrief, shared } from '../src/coordinate.js';

const T = (id, files, extra = {}) => ({ id, title: id, description: `do ${id}`, kind: 'code', size: 'M', deps: [], needs: { platform: 'any', tool: '' }, acceptance: [`${id} works`], verify: '', files, ...extra });

test('normalizeFiles and glob/folder overlap', () => {
  assert.deepEqual(normalizeFiles('./src/a.js, src/a.js\nui/'), ['src/a.js', 'ui/']);
  assert.deepEqual(shared(['src/*.js'], ['src/a.js', 'ui/b.js']), ['src/*.js']);
  assert.deepEqual(shared(['ui/'], ['ui/src/x.js']), ['ui/']);
  assert.deepEqual(shared(['src/a.js'], ['src/b.js']), []);
});

test('tasks that mostly edit the same files are merged; deps on the merged task follow it', () => {
  const { tasks, notes } = coordinateTasks([T('t1', ['src/a.js', 'src/b.js']), T('t2', ['src/a.js']), T('t3', ['docs/x.md'], { deps: ['t2'] })]);
  assert.deepEqual(tasks.map((t) => t.id), ['t1', 't3']);
  assert.equal(tasks[0].title, 't1 + t2');
  assert.equal(tasks[0].size, 'L');
  assert.deepEqual(tasks[0].mergedFrom, ['t2']);
  assert.deepEqual(tasks[1].deps, ['t1']);
  assert.match(notes[0], /merged t2 into t1/);
});

test('two L tasks on the same files are serialized, not merged; no cycles', () => {
  const { tasks } = coordinateTasks([T('t1', ['src/a.js'], { size: 'L' }), T('t2', ['src/a.js'], { size: 'L' })]);
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks[1].deps, ['t1']);
  assert.deepEqual(tasks[0].deps, []);
});

test('a small overlap serializes; disjoint tasks stay parallel', () => {
  const { tasks } = coordinateTasks([T('t1', ['a.js', 'b.js', 'c.js']), T('t2', ['c.js', 'd.js', 'e.js']), T('t3', ['z.js'])]);
  assert.deepEqual(tasks.find((t) => t.id === 't2').deps, ['t1']);
  assert.deepEqual(tasks.find((t) => t.id === 't3').deps, []);
});

test('tests several tasks would write go to one testing agent the review waits for', () => {
  const { tasks, notes } = coordinateTasks([T('t1', ['a.js'], { tests: 'a.test.js' }), T('t2', ['b.js'], { tests: 'b.test.js' }), T('t3', [], { kind: 'review', deps: ['t1', 't2'] })]);
  const tt = tasks.find((t) => t.kind === 'test');
  assert.ok(tt);
  assert.deepEqual(tt.deps, ['t1', 't2']);
  assert.match(tt.description, /a\.test\.js[\s\S]*b\.test\.js/);
  assert.ok(tasks.find((t) => t.id === 't1').description.includes(`written by ${tt.id}`));
  assert.equal(tasks.find((t) => t.id === 't1').tests, '');
  assert.ok(tasks.find((t) => t.id === 't3').deps.includes(tt.id));
  assert.ok(notes.some((n) => n.includes('one testing agent')));
  // a single task with tests keeps them
  assert.equal(coordinateTasks([T('t1', ['a.js'], { tests: 'x' })]).tasks.length, 1);
});

test('ownershipBrief lists files of tasks that can run at the same time, not of dependencies', () => {
  const tasks = [T('t1', ['a.js']), T('t2', ['b.js']), T('t3', ['c.js'], { deps: ['t1'] })];
  const b = ownershipBrief(tasks, tasks[2]);
  assert.match(b, /Your files: c\.js/);
  assert.match(b, /t2: b\.js/);
  assert.doesNotMatch(b, /t1: a\.js/);
  assert.equal(ownershipBrief([T('t1', [])], T('t1', [])), '');
});
