import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_THEME, THEMES } from '../ui/src/themes.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(root, 'ui/src/styles.css'), 'utf8');
const VARS = ['--bg', '--panel', '--panel-solid', '--accent-rgb', '--accent-2-rgb', '--line', '--line-strong', '--text', '--muted', '--accent', '--accent-2', '--warn', '--danger'];

test('themes: every theme has graph + terminal colors, and the default exists', () => {
  assert.ok(THEMES[DEFAULT_THEME]);
  assert.ok(THEMES.atari, 'the 8-bit Atari theme is registered');
  for (const [id, t] of Object.entries(THEMES)) {
    assert.match(id, /^[a-z][a-z0-9-]*$/, id);
    assert.ok(t.name, `${id} has a name`);
    assert.match(t.graph.background, /^#[0-9a-f]{6}$/i, `${id} graph background`);
    assert.equal(typeof t.graph.stars, 'number', `${id} star color`);
    for (const k of ['background', 'foreground', 'cursor']) assert.ok(t.terminal[k], `${id} terminal.${k}`);
  }
});

test('themes: each non-default theme has a CSS block that sets every color variable', () => {
  for (const id of Object.keys(THEMES).filter((x) => x !== DEFAULT_THEME)) {
    const m = css.match(new RegExp(`:root\\[data-theme="${id}"\\]\\s*\\{([^}]*)\\}`));
    assert.ok(m, `styles.css has :root[data-theme="${id}"]`);
    for (const v of VARS) assert.match(m[1], new RegExp(`${v}\\s*:`), `${id} sets ${v}`);
  }
});

test('themes: the accent color is only spelled in :root, so themes can recolor it', () => {
  const body = css.slice(css.indexOf('}') + 1);
  assert.doesNotMatch(body, /rgba\(45, ?212, ?191|rgba\(94, ?234, ?212|#2dd4bf/i);
});

test('playbooks: a theme request matches the ui-theme playbook and plans one task + the final review', async () => {
  const { findPlaybook, playbookTasks, parsePlaybook } = await import('../src/planner.js');
  const pb = await findPlaybook('add an 8bit dark atari theme to JARVIS');
  assert.equal(pb?.file, 'ui-theme.md');
  assert.equal(await findPlaybook('fix the merge steward retry loop'), null);
  assert.equal((await findPlaybook('write an internal p5.js animation library that fits our theme and use it in the exhibitor'))?.file, 'p5-sketch.md', 'mentioning the theme is not asking for one');
  assert.equal((await findPlaybook('add a p5.js sketch for the exhibitor'))?.file, 'p5-sketch.md');
  const tasks = playbookTasks({ goal: 'add a solarized theme', request: '' }, pb);
  assert.deepEqual(tasks.map((t) => t.kind), ['code', 'review']);
  assert.match(tasks[0].description, /themes\.js/);
  assert.equal(parsePlaybook('no front matter'), null);
  assert.equal(parsePlaybook('---\ntitle: x\n---\nbody'), null, 'a playbook needs a match pattern');
});
