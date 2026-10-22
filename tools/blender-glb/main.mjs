// Build a 3D object headless in Blender and export it as a .glb (plus a turntable PNG) into the shared folder.
//   preset: { "preset": "chair", "name": "chair" }                → <shared>/files/3d/chair.glb + chair.png
//   script: { "script": "import bpy\nbpy.ops.mesh.primitive_monkey_add()", "name": "suzanne" }
// Blender runs with `-b --python <tmp.py>`: the generated script clears the default scene, runs the preset builder or
// the given bpy code, exports everything left in the scene and renders a 512x512 Workbench still (headless-safe).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = JSON.parse(process.env.RIGS_TOOL_ARGS || process.argv[2] || '{}');
const done = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 1); };
const HOME = os.homedir();
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const expand = (p) => String(p || '').replace(/^~(?=$|[\\/])/, HOME);
const which = (name) => {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of isWin ? ['.exe', '.cmd', ''] : ['']) { const p = path.join(dir, name + ext); try { if (fs.statSync(p).isFile()) return p; } catch {} }
  }
  return null;
};
const globDir = (dir, pattern, rest) => {
  const [pre, suf] = pattern.split('*');
  try { return fs.readdirSync(dir).filter((n) => n.startsWith(pre) && n.endsWith(suf)).sort().reverse().map((n) => path.join(dir, n, ...rest)); } catch { return []; }
};

// The same places src/capabilities.js looks (keep them in step).
function blenderCandidates() {
  const out = [args.blender, process.env.BLENDER].filter(Boolean).map(expand);
  if (isMac) out.push('/Applications/Blender.app/Contents/MacOS/Blender', path.join(HOME, 'Applications', 'Blender.app', 'Contents', 'MacOS', 'Blender'));
  else if (isWin) out.push(...globDir('C:\\Program Files\\Blender Foundation', 'Blender*', ['blender.exe']));
  else {
    const onPath = which('blender');
    if (onPath) out.push(onPath);
    out.push('/usr/bin/blender', ...globDir('/opt', 'blender*', ['blender']), ...globDir(path.join(HOME, 'Downloads'), 'blender-*', ['blender']));
  }
  return [...new Set(out)];
}
const findBlender = () => blenderCandidates().find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || null;

/** The shared folder (src/files.js sharedRoot): config.shared.path, RIGS_SHARED, else ~/RIGS-Shared (RIGS_HOME/RIGS-Shared on a scratch node). */
function sharedRoot() {
  const home = process.env.RIGS_HOME ? path.resolve(process.env.RIGS_HOME) : path.join(HOME, '.rigs');
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')); } catch {}
  const p = cfg?.shared?.path || process.env.RIGS_SHARED || (process.env.RIGS_HOME ? path.join(home, 'RIGS-Shared') : '~/RIGS-Shared');
  return path.resolve(expand(p));
}

const PRESETS = {
  cube: `
obj = add_primitive('cube', size=1.0)
obj.name = NAME
bevel(obj, 0.04, 3)
`,
  sphere: `
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.5, segments=48, ring_count=24, location=(0, 0, 0.5))
obj = bpy.context.active_object
obj.name = NAME
smooth(obj)
`,
  chair: `
seat = add_primitive('cube', size=1.0, location=(0, 0, 0.45), scale=(0.45, 0.45, 0.05))
bevel(seat, 0.01, 2)
legs = []
for x in (-0.19, 0.19):
    for y in (-0.19, 0.19):
        bpy.ops.mesh.primitive_cylinder_add(radius=0.02, depth=0.43, vertices=16, location=(x, y, 0.215))
        legs.append(bpy.context.active_object)
back = add_primitive('cube', size=1.0, location=(0, -0.215, 0.725), scale=(0.45, 0.04, 0.5))
bevel(back, 0.01, 2)
obj = join([seat, back] + legs, NAME)
`,
  table: `
top = add_primitive('cube', size=1.0, location=(0, 0, 0.75), scale=(1.2, 0.7, 0.04))
bevel(top, 0.01, 2)
legs = []
for x in (-0.55, 0.55):
    for y in (-0.3, 0.3):
        legs.append(add_primitive('cube', size=1.0, location=(x, y, 0.365), scale=(0.05, 0.05, 0.73)))
obj = join([top] + legs, NAME)
`,
  mug: `
bpy.ops.mesh.primitive_cylinder_add(radius=0.04, depth=0.10, vertices=48, location=(0, 0, 0.05))
body = bpy.context.active_object
bpy.ops.mesh.primitive_cylinder_add(radius=0.035, depth=0.10, vertices=48, location=(0, 0, 0.0575))
inner = bpy.context.active_object
cut = body.modifiers.new('hollow', 'BOOLEAN')
cut.operation = 'DIFFERENCE'
cut.object = inner
apply_modifiers(body)
bpy.data.objects.remove(inner, do_unlink=True)
bpy.ops.mesh.primitive_torus_add(major_radius=0.028, minor_radius=0.007, major_segments=32, minor_segments=12, location=(0.052, 0, 0.05), rotation=(math.radians(90), 0, 0))
handle = bpy.context.active_object
smooth(body)
smooth(handle)
obj = join([body, handle], NAME)
`,
};

function pyScript({ name, glb, png, render, body }) {
  const q = (s) => JSON.stringify(String(s));
  return `import bpy, math, json, sys
NAME = ${q(name)}
GLB = ${q(glb)}
PNG = ${q(png)}
RENDER = ${render ? 'True' : 'False'}

# 1. an empty scene (no default cube, light or camera)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

def add_primitive(kind, size=1.0, location=(0, 0, 0), scale=(1, 1, 1)):
    getattr(bpy.ops.mesh, 'primitive_%s_add' % kind)(size=size, location=location)
    o = bpy.context.active_object
    o.scale = scale
    return o

def smooth(o):
    for p in o.data.polygons:
        p.use_smooth = True

def bevel(o, width=0.02, segments=2):
    m = o.modifiers.new('bevel', 'BEVEL')
    m.width = width
    m.segments = segments

def apply_modifiers(o):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = o.evaluated_get(dg)
    mesh = bpy.data.meshes.new_from_object(ev)
    old = o.data
    o.modifiers.clear()
    o.data = mesh
    if old.users == 0:
        bpy.data.meshes.remove(old)

def join(objects, name):
    objects = [o for o in objects if o and o.type == 'MESH']
    for o in objects:
        apply_modifiers(o)  # scale/bevel are part of the mesh before joining
    if len(objects) == 1:
        objects[0].name = name
        return objects[0]
    try:
        with bpy.context.temp_override(active_object=objects[0], selected_editable_objects=objects, selected_objects=objects):
            bpy.ops.object.join()
        objects[0].name = name
        return objects[0]
    except Exception as e:  # join needs a usable context; a parent empty keeps the parts together in the export
        root = bpy.data.objects.new(name, None)
        scene.collection.objects.link(root)
        for o in objects:
            o.parent = root
        return root

# 2. build the object
${body.trim()}

# 3. export everything left in the scene as a binary glTF
meshes = [o for o in scene.objects if o.type == 'MESH']
if not meshes:
    print('RIGS_RESULT ' + json.dumps({'ok': False, 'error': 'the script left no mesh in the scene'}))
    sys.exit(2)
bpy.ops.export_scene.gltf(filepath=GLB, export_format='GLB', export_apply=True)

tris = 0
for o in meshes:
    o.data.calc_loop_triangles()
    tris += len(o.data.loop_triangles)

# 4. a turntable still: camera on a 3/4 view framed on the objects' bounds, Workbench (works without a GPU)
if RENDER:
    from mathutils import Vector
    pts = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    center = (lo + hi) / 2
    radius = max((hi - lo).length / 2, 0.05)
    cam_data = bpy.data.cameras.new('turntable')
    cam_data.lens = 50
    cam = bpy.data.objects.new('turntable', cam_data)
    scene.collection.objects.link(cam)
    dist = radius / math.sin(math.radians(cam_data.angle_y * 180 / math.pi / 2)) * 1.15
    az, el = math.radians(35), math.radians(25)
    cam.location = center + Vector((dist * math.cos(el) * math.sin(az), -dist * math.cos(el) * math.cos(az), dist * math.sin(el)))
    direction = center - cam.location
    cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    scene.camera = cam
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 3
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(30))
    scene.collection.objects.link(sun)
    scene.render.engine = 'BLENDER_WORKBENCH'
    sh = scene.display.shading
    sh.light = 'STUDIO'
    sh.color_type = 'SINGLE'
    sh.single_color = (0.75, 0.78, 0.82)
    sh.show_cavity = True
    scene.render.resolution_x = 512
    scene.render.resolution_y = 512
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.filepath = PNG
    bpy.ops.render.render(write_still=True)

print('RIGS_RESULT ' + json.dumps({'ok': True, 'triangles': tris, 'objects': [o.name for o in meshes], 'version': bpy.app.version_string}))
`;
}

const name = String(args.name || '').trim();
if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(name)) done({ ok: false, error: 'name is required: a-z, 0-9, - or _ (it names the .glb and .png)' });
const preset = args.preset === undefined || args.preset === null || args.preset === '' ? null : String(args.preset);
if (preset && !PRESETS[preset]) done({ ok: false, error: `preset must be one of ${Object.keys(PRESETS).join(', ')}` });
const script = typeof args.script === 'string' && args.script.trim() ? args.script : '';
if (!script && !preset) done({ ok: false, error: 'give a preset (cube, sphere, chair, table, mug) or a bpy script' });
if (script && /\bos\.(system|popen|remove|unlink|rmdir)|subprocess|shutil\.rmtree/.test(script)) done({ ok: false, error: 'the script must build geometry, not run shell commands or delete files' });
const render = args.render !== false;
const glb = path.resolve(expand(args.out || path.join(sharedRoot(), 'files', '3d', `${name}.glb`)));
if (!glb.toLowerCase().endsWith('.glb')) done({ ok: false, error: 'out must end in .glb' });
const png = glb.replace(/\.glb$/i, '.png');
const blender = findBlender();
const body = script || PRESETS[preset];
const py = pyScript({ name, glb, png, render, body });
const node = process.env.RIGS_NAME || os.hostname().split('.')[0].toLowerCase();

if (args.dryRun) done({ ok: true, dryRun: true, blender, candidates: blenderCandidates(), glb, png: render ? png : null, node, preset, python: py });
if (!blender) done({ ok: false, error: `Blender was not found (looked at ${blenderCandidates().join(', ')}); install it or set BLENDER / "blender"` });

fs.mkdirSync(path.dirname(glb), { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-blender-'));
const pyFile = path.join(tmpDir, 'build.py');
fs.writeFileSync(pyFile, py);
const r = await new Promise((resolve) => execFile(blender, ['-b', '--factory-startup', '--python-exit-code', '3', '--python', pyFile], { maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000, env: { ...process.env, BLENDER_USER_SCRIPTS: '', PYTHONDONTWRITEBYTECODE: '1' } },
  (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, killed: !!err?.killed, stdout: String(stdout || ''), stderr: String(stderr || '') })));
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
const line = r.stdout.split('\n').reverse().find((l) => l.startsWith('RIGS_RESULT '));
let result = null;
try { result = line ? JSON.parse(line.slice('RIGS_RESULT '.length)) : null; } catch {}
const tail = (s) => s.trim().split('\n').slice(-25).join('\n');
if (r.killed) done({ ok: false, error: 'Blender ran past the 10 minute limit and was stopped', log: tail(r.stdout + '\n' + r.stderr) });
if (!result?.ok || !fs.existsSync(glb)) done({ ok: false, error: result?.error || `Blender exited with ${r.code} without writing ${glb}`, blender, log: tail(r.stdout + '\n' + r.stderr) });
done({ ok: true, glb, png: render && fs.existsSync(png) ? png : null, node, triangles: result.triangles, objects: result.objects, blender, version: result.version });
