// The blender-glb seed tool (tools/blender-glb) and the Blender capability (D6): manifest validity and script syntax
// without Blender; the cube preset end to end only where Blender is installed (skipped otherwise).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'blender-glb');
process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-blender-'));
process.env.RIGS_NAME = 'box';
process.env.RIGS_NO_OPENRIG = '1';
process.env.RIGS_ADHOC_TOOLS = path.join(process.env.RIGS_HOME, 'adhoc');
const T = await import('../src/toolbox.js');
const C = await import('../src/capabilities.js');
const { defaults } = await import('../src/config.js');
const P = await import('../src/planner.js');
const W = await import('../src/work.js');

const runTool = (args, env = {}) => JSON.parse(execFileSync(process.execPath, [path.join(TOOL, 'main.mjs')], { input: '', env: { ...process.env, ...env, RIGS_TOOL_ARGS: JSON.stringify(args) }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().split('\n').at(-1));
const runToolFailing = (args, env = {}) => { try { return runTool(args, env); } catch (e) { return JSON.parse(String(e.stdout).trim().split('\n').at(-1)); } };

test('manifest: valid, mutating, searchable (tags 3d/blender/glb/mesh/model), with a dry-run smoke call', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(TOOL, 'manifest.json'), 'utf8'));
  const { manifest, errors } = T.validateManifest(raw);
  assert.deepEqual(errors, []);
  assert.equal(manifest.id, 'blender-glb');
  assert.equal(manifest.safety, 'mutating');
  for (const tag of ['3d', 'blender', 'glb', 'mesh', 'model']) assert.ok(manifest.tags.includes(tag), tag);
  assert.deepEqual(manifest.inputs.required, ['name']);
  assert.deepEqual(manifest.inputs.properties.preset.enum, ['cube', 'sphere', 'chair', 'table', 'mug']);
  const files = Object.fromEntries(fs.readdirSync(TOOL).filter((f) => f !== 'manifest.json').map((f) => [f, fs.readFileSync(path.join(TOOL, f))]));
  assert.deepEqual(T.seedProblems(manifest, files), []);
  execFileSync(process.execPath, ['--check', path.join(TOOL, manifest.entry)]); // the entry parses
});

test('dry run: every preset generates Python that clears the scene, builds, exports GLB and renders; bad input is refused', () => {
  for (const preset of ['cube', 'sphere', 'chair', 'table', 'mug']) {
    const r = runTool({ preset, name: `smoke-${preset}`, dryRun: true });
    assert.equal(r.ok, true, preset);
    assert.equal(r.dryRun, true);
    assert.match(r.glb, new RegExp(`${path.sep.replace('\\', '\\\\')}files${path.sep.replace('\\', '\\\\')}3d${path.sep.replace('\\', '\\\\')}smoke-${preset}\\.glb$`), 'default output under the shared folder\'s files/3d');
    assert.equal(r.png, r.glb.replace(/\.glb$/, '.png'));
    assert.match(r.python, /read_factory_settings\(use_empty=True\)/);
    assert.match(r.python, /export_scene\.gltf\(filepath=GLB, export_format='GLB'/);
    assert.match(r.python, /BLENDER_WORKBENCH/);
    assert.match(r.python, /RIGS_RESULT/);
  }
  assert.match(runTool({ preset: 'chair', name: 'c', dryRun: true }).python, /legs\.append[\s\S]*back = add_primitive/, 'a chair is a seat, four legs and a back');
  assert.match(runTool({ preset: 'mug', name: 'm', dryRun: true }).python, /BOOLEAN[\s\S]*primitive_torus_add/, 'a mug is a hollowed cylinder with a torus handle');
  // a user script replaces the preset; the shared folder of a scratch node is RIGS_HOME/RIGS-Shared; out/render are honoured
  const own = runTool({ script: 'import bpy\nbpy.ops.mesh.primitive_monkey_add()', name: 'suzanne', out: '/tmp/x/suzanne.glb', render: false, dryRun: true });
  assert.match(own.python, /primitive_monkey_add/);
  assert.equal(own.glb, path.resolve('/tmp/x/suzanne.glb'));
  assert.equal(own.png, null);
  assert.equal(runTool({ preset: 'cube', name: 'd', dryRun: true }).glb.startsWith(path.join(process.env.RIGS_HOME, 'RIGS-Shared')), true);
  assert.match(runToolFailing({ preset: 'cube', dryRun: true }).error, /name is required/);
  assert.match(runToolFailing({ preset: 'pyramid', name: 'p', dryRun: true }).error, /preset must be one of/);
  assert.match(runToolFailing({ name: 'p', dryRun: true }).error, /give a preset .* or a bpy script/);
  assert.match(runToolFailing({ name: 'p', script: 'import os\nos.system("rm -rf /")', dryRun: true }).error, /must build geometry/);
  assert.match(runToolFailing({ name: 'p', preset: 'cube', out: '/tmp/p.obj', dryRun: true }).error, /must end in \.glb/);
  // the registry runs it as a seed and its smoke check passes
  const smoke = T.validateManifest(JSON.parse(fs.readFileSync(path.join(TOOL, 'manifest.json'), 'utf8'))).manifest.smoke;
  assert.equal(runTool(smoke.args).ok, true);
});

test('capability: the detector shape, the candidate paths per OS, and the routing rule for kind 3d', async () => {
  const known = C.knownTools().find((t) => t.id === 'blender');
  assert.deepEqual(known.kinds, ['3d']);
  assert.match(known.notes, /blender-glb/);
  assert.match(known.notes, /props-studio/);
  assert.deepEqual(C.blenderCandidates({ env: '', home: '/Users/u', mac: true, win: false }), ['/Applications/Blender.app/Contents/MacOS/Blender', '/Users/u/Applications/Blender.app/Contents/MacOS/Blender']);
  assert.deepEqual(C.blenderCandidates({ env: '/opt/b/blender', home: '/Users/u', mac: true, win: false })[0], '/opt/b/blender', 'BLENDER wins');
  const linux = C.blenderCandidates({ env: '', home: '/home/u', mac: false, win: false });
  assert.ok(linux.includes('/usr/bin/blender'));
  assert.equal(C.findBlender({ env: '', home: '/nope', mac: false, win: true }), null, 'no Program Files here');
  const rules = defaults().routing.rules;
  const i3d = rules.findIndex((r) => r.kind === '3d');
  assert.ok(i3d >= 0 && i3d < rules.findIndex((r) => r.kind === 'media'), 'the 3d rule comes before the media rule');
  assert.deepEqual(rules[i3d], { kind: '3d', tool: 'blender', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' });
  assert.ok(P.KINDS.includes('3d'));
  assert.match(P.planningPrompt({ id: 'p', name: 'p', goal: 'a mug', repo: { node: 'm', path: '' }, tasks: [] }, [], '', []), /"3d" for a 3D object[\s\S]*blender-glb/);
});

test('routing: a 3d task only goes to a machine with Blender, with the tool in the brief, even when the repo lives elsewhere', () => {
  const machine = (name, platform, tools = {}) => ({ node: { id: name, name, online: true, rigs: true, platform, gpus: [], stats: { cpu: 5, memUsed: 4, memTotal: 16 }, capabilities: tools }, brains: [{ id: 'claude', models: [], efforts: [] }], openrig: { daemon: 'running' } });
  const mesh = [machine('mac', 'mac'), machine('magix', 'linux', { blender: { id: 'blender', label: 'Blender 5.0.1', kinds: ['3d'], command: '/usr/bin/blender', notes: 'Headless 3D' } })];
  const t = { id: 't1', title: 'Model a coffee mug', description: 'a mug', kind: '3d', size: 'M', deps: [], needs: { platform: 'any', gpu: false, tool: '' }, suggest: {}, status: 'todo', assign: null };
  const p = P.routeProject({ id: 'p', name: 'p', goal: 'a mug', repo: { node: 'mac', path: '/Users/u/proj' }, gitUrl: '', tasks: [t] }, mesh);
  assert.equal(p.tasks[0].assign.node, 'magix');
  assert.equal(p.tasks[0].assign.model, 'claude-sonnet-5-5');
  assert.equal(p.tasks[0].needs.tool, 'blender');
  assert.match(p.tasks[0].toolInfo, /CLI \/usr\/bin\/blender/);
  const none = P.routeProject({ id: 'p', name: 'p', goal: 'g', repo: { node: 'mac', path: '' }, gitUrl: '', tasks: [{ ...t, assign: null }] }, [machine('mac', 'mac')]);
  assert.equal(none.tasks[0].assign, null);
  assert.match(none.tasks[0].reason, /blender/);
  // the brief of a 3d task names the blender-glb tool even when the tool catalog missed it
  const brief = W.enrichBrief('# Model a coffee mug\n\n## Task\na mug\n\n## Reusable tools\nnote\n\n## How to work\n- x', { kind: '3d' });
  assert.match(brief, /## Reusable tools\nnote\nLikely matches for this task \(read with `tool_get` first\):\n- `blender-glb` \(tool\)/);
  assert.equal((W.enrichBrief(brief, { kind: '3d' }).match(/`blender-glb`/g) || []).length, 1, 'never added twice');
  assert.doesNotMatch(W.enrichBrief('# Fix the login form\n\n## Reusable tools\nnote\n', { kind: 'code' }), /blender-glb/);
  assert.match(W.enrichBrief('# Export the robot as .glb\n\n## Reusable tools\nnote\nLikely matches for this task (read with `tool_get` first):\n- `other` (tool): x\n', { kind: 'code' }), /- `other` \(tool\): x\n- `blender-glb`/);
  const hints = P.toolHints([{ id: 'blender-glb', name: 'Build a 3D object headless in Blender', description: 'Run Blender in the background', tags: ['3d', 'blender', 'glb', 'mesh', 'model'] }], { title: 'Make a chair', description: 'a wooden chair', kind: '3d' });
  assert.equal(hints[0]?.id, 'blender-glb', 'the catalog match sees a 3d task as Blender work');
});

test('the cube preset builds a .glb and a PNG where Blender is installed (skipped otherwise)', { skip: !C.findBlender() && 'Blender is not installed here' }, async () => {
  const out = path.join(process.env.RIGS_HOME, 'out', 'cube.glb');
  const r = runTool({ preset: 'cube', name: 'cube', out });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.glb, out);
  assert.ok(fs.statSync(out).size > 500, 'a real glb');
  assert.equal(fs.readFileSync(out).subarray(0, 4).toString('ascii'), 'glTF', 'binary glTF magic');
  assert.ok(fs.statSync(r.png).size > 1000, 'a rendered PNG');
  assert.ok(r.triangles >= 12, `triangles: ${r.triangles}`);
  assert.deepEqual(r.objects, ['cube']);
  assert.match(r.version, /^\d+\.\d+/);
});
