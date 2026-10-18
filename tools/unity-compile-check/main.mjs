// Compile a Unity project's C# outside the editor, exactly as Unity does (same references, defines, analyzers), for a
// checkout the editor does not have open (a git worktree used by a parallel agent). Errors only. It reads the response
// files and package DLLs of a MAIN project that the editor has compiled once (Library/Bee/artifacts/*E.dag), and
// compiles the checkout's Assets/ into a temp dir that is always removed.
//   { "root": "/path/to/worktree", "mainProject": "/path/to/main/project" }
//   MadMax-style layout (the checkout owns Assets/MadMax, other missing files come from main): "ownedPrefixes": ["Assets/MadMax/"]
// Handles the default Assembly-CSharp / Assembly-CSharp-Editor pair; projects split into .asmdef assemblies are not covered.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = JSON.parse(process.env.RIGS_TOOL_ARGS || process.argv[2] || '{}');
const done = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 1); };
const expand = (p) => path.resolve(String(p).replace(/^~(?=$|[\\/])/, os.homedir()));
const isWin = process.platform === 'win32';
const posix = (p) => p.split(path.sep).join('/');

const root = expand(args.root || process.cwd());
const main = expand(args.mainProject || process.env.UNITY_MAIN_PROJECT || root);
const owned = Array.isArray(args.ownedPrefixes) ? args.ownedPrefixes.map(String) : [];
const maxErrors = Math.max(1, Math.min(500, Number(args.maxErrors ?? 50)));

function editorDataDirs() {
  const home = os.homedir();
  const hubs = process.platform === 'darwin' ? [['/Applications/Unity/Hub/Editor', 'Unity.app/Contents']]
    : isWin ? [['C:\\Program Files\\Unity\\Hub\\Editor', 'Editor\\Data']] : [[path.join(home, 'Unity/Hub/Editor'), 'Editor/Data']];
  const out = [];
  for (const [hub, sub] of hubs) {
    try { for (const v of fs.readdirSync(hub)) out.push({ version: v, data: path.join(hub, v, sub) }); } catch {}
  }
  return out;
}
function unityData() {
  const explicit = args.unityEditorData || process.env.UNITY_EDITOR_DATA;
  if (explicit) return { version: 'explicit', data: expand(explicit) };
  let want = args.unityVersion;
  try { want = want || /m_EditorVersion:\s*(\S+)/.exec(fs.readFileSync(path.join(main, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8'))?.[1]; } catch {}
  const all = editorDataDirs().filter((e) => fs.existsSync(path.join(e.data, 'DotNetSdk')));
  return all.find((e) => e.version === want) || (want ? null : all.sort((a, b) => b.version.localeCompare(a.version))[0]) || null;
}
function dagDir() {
  const base = path.join(main, 'Library', 'Bee', 'artifacts');
  let dirs = [];
  try { dirs = fs.readdirSync(base).filter((d) => d.endsWith('E.dag') && fs.existsSync(path.join(base, d, 'Assembly-CSharp.rsp')) && fs.existsSync(path.join(base, d, 'Assembly-CSharp-Editor.rsp'))); } catch {}
  return dirs.map((d) => ({ d: path.join(base, d), t: fs.statSync(path.join(base, d, 'Assembly-CSharp-Editor.rsp')).mtimeMs })).sort((a, b) => b.t - a.t)[0]?.d || null;
}

const unity = unityData();
const dag = dagDir();
const dotnet = unity && path.join(unity.data, 'DotNetSdk', isWin ? 'dotnet.exe' : 'dotnet');
let csc = null;
try { if (unity) { const sdk = path.join(unity.data, 'DotNetSdk', 'sdk'); const v = fs.readdirSync(sdk).sort().pop(); csc = path.join(sdk, v, 'Roslyn', 'bincore', 'csc.dll'); } } catch {}
const plan = { root, mainProject: main, unityVersion: unity?.version || null, dotnet, csc, dagDir: dag, ownedPrefixes: owned };
const problems = [!fs.existsSync(path.join(root, 'Assets')) && `${root} has no Assets folder`, !unity && 'no Unity editor found: set unityEditorData (the .../Editor/Data folder) or unityVersion',
  (!dotnet || !fs.existsSync(dotnet)) && 'Unity DotNetSdk not found in that editor', !csc && 'Roslyn csc.dll not found in the editor DotNetSdk',
  !dag && `no compiled response files under ${path.join(main, 'Library/Bee/artifacts')}: open mainProject in the Unity editor once so it compiles`].filter(Boolean);
if (args.dryRun) done({ ok: true, dryRun: true, plan, problems });
if (problems.length) done({ ok: false, error: problems.join('; '), plan });

const absolutize = (line) => {
  const m = /^(-r:|-analyzer:|\/additionalfile:)"(.*)"$/.exec(line);
  return m && !path.isAbsolute(m[2]) ? `${m[1]}"${path.join(main, m[2])}"` : line;
};
function sources(editor) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.cs') && (/\/Editor(\/|$)/.test(posix(path.dirname(p)).slice(posix(root).length) + '/') === editor)) out.push(p);
    }
  };
  walk(path.join(root, 'Assets'));
  return out;
}
const exec = (cmd, a, cwd) => new Promise((resolve) => execFile(cmd, a, { cwd, maxBuffer: 256 * 1024 * 1024, timeout: 540000 }, (err, stdout, stderr) => resolve({ stdout, stderr, code: err ? (err.code ?? 1) : 0 })));

async function build(rspName, editor, extraRefs, outDll) {
  const keep = [];
  const listed = new Set();
  for (const raw of fs.readFileSync(path.join(dag, rspName), 'utf8').split(/\r?\n/)) {
    const s = raw.trim();
    if (!s) continue;
    if (s.startsWith('"Assets/') || s.startsWith('Assets/')) { listed.add(s.replace(/^"|"$/g, '')); continue; }
    if (s.startsWith('-out:') || s.startsWith('-refout:')) continue;
    if (editor && s.startsWith('-r:') && s.includes('Assembly-CSharp') && !s.includes('Editor')) continue; // the runtime assembly: use the one just built
    keep.push(absolutize(s));
  }
  const srcs = sources(editor);
  // files the editor compiles that this checkout lacks (plugins, folders it does not own) come from the main project
  for (const rel of listed) {
    if (!fs.existsSync(path.join(root, rel)) && fs.existsSync(path.join(main, rel)) && !owned.some((p) => rel.startsWith(p))) srcs.push(path.join(main, rel));
  }
  keep.push(...extraRefs.map((r) => `-r:"${r}"`), `-out:"${outDll}"`, ...srcs.map((s) => `"${s}"`));
  const rsp = `${outDll}.rsp`;
  fs.writeFileSync(rsp, keep.join('\n'));
  const r = await exec(dotnet, ['exec', csc, `@${rsp}`], root);
  return { errors: r.stdout.split(/\r?\n/).filter((l) => l.includes(': error ')), crashed: r.code !== 0 && !r.stdout.includes(': error ') ? (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ') : '' };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unity_csc_')); // the DLLs are throwaway: never leave them on tmpfs
let result;
try {
  const runtime = path.join(tmp, 'Assembly-CSharp.dll');
  let r = await build('Assembly-CSharp.rsp', false, [], runtime);
  if (!r.errors.length && !r.crashed) r = await build('Assembly-CSharp-Editor.rsp', true, [runtime], path.join(tmp, 'Assembly-CSharp-Editor.dll'));
  if (r.crashed) result = { ok: false, error: `the compiler failed: ${r.crashed}` };
  else {
    const errors = r.errors.map((e) => e.split(root + path.sep).join('').split(root + '/').join(''));
    result = { ok: !errors.length, errorCount: errors.length, errors: errors.slice(0, maxErrors), ...(errors.length > maxErrors ? { more: errors.length - maxErrors } : {}), unityVersion: unity.version };
  }
} catch (e) {
  result = { ok: false, error: e.message };
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
done(result); // after the cleanup: done() exits the process
