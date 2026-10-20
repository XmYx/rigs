// Publish a web app to the RIGS App Cloud: a `systemctl --user` unit (Linux, enabled so it survives reboots), a wait for
// its /healthz, and the App Cloud registration on this machine (POST /api/local/apps, the same call as the MCP tool
// mesh_app_register). Elsewhere (macOS, Windows, no systemd) it registers a launch command and asks JARVIS to start it.
// The app must serve relative URLs (it lives under /api/nodes/<node>/apps/<id>/) and answer GET <healthPath>.
// Ad-hoc apps live in the shared folder synced across the mesh (`rigs shared path`, default ~/RIGS-Shared): apps/<id>.
//   { "id": "wordcloud", "name": "Word cloud", "icon": "☁️", "port": 8750, "command": "node server.js", "cwd": "~/RIGS-Shared/apps/wordcloud",
//     "description": "what it does", "tags": ["text"] }
// It refuses to take over an App Cloud id that points at another port, or a unit file it did not write, unless force: true.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = JSON.parse(process.env.RIGS_TOOL_ARGS || process.argv[2] || '{}');
const done = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const expand = (p) => String(p).replace(/^~(?=$|[\\/])/, os.homedir());
const which = (name) => (process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, name)).find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
const exec = (cmd, a) => new Promise((resolve) => execFile(cmd, a, { timeout: 60000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr })));

const id = String(args.id || '').trim().toLowerCase();
if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) done({ ok: false, error: 'id must be 1-40 chars of a-z, 0-9, - or _' });
const port = Number(args.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) done({ ok: false, error: 'port must be an integer 1-65535' });
const command = String(args.command || '').trim();
if (!command) done({ ok: false, error: 'command is required: the line that starts the server, e.g. "node server.js"' });
const name = String(args.name || id);
const healthPath = String(args.healthPath || '/healthz');
if (!healthPath.startsWith('/')) done({ ok: false, error: 'healthPath must start with /' });
const cwd = args.cwd ? expand(args.cwd) : os.homedir();
const env = args.env && typeof args.env === 'object' && !Array.isArray(args.env) ? args.env : {};
for (const k of Object.keys(env)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) done({ ok: false, error: `env.${k} is not a valid variable name` });
const unit = String(args.unit || `rigs-${id}.service`);
if (!/^[\w@.:-]+\.service$/.test(unit)) done({ ok: false, error: 'unit must be a systemd unit name ending in .service' });
const daemon = String(args.daemon || 'http://127.0.0.1:4719').replace(/\/+$/, '');
const force = args.force === true;
const waitSec = Math.min(300, Math.max(1, Number(args.waitSec ?? 30)));
// RIGS_NO_SYSTEMD and RIGS_SYSTEMD_USER_DIR are the same test hooks src/appstore.js honours.
// A shell started outside a login session lacks XDG_RUNTIME_DIR, and `systemctl --user` then cannot find the user bus.
if (process.platform === 'linux' && !process.env.XDG_RUNTIME_DIR && process.getuid && fs.existsSync(`/run/user/${process.getuid()}`)) process.env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
const useSystemd = process.platform === 'linux' && !!which('systemctl') && args.systemd !== false && !process.env.RIGS_NO_SYSTEMD
  && (await exec('systemctl', ['--user', 'show-environment'])).code === 0;
const unitPath = path.join(process.env.RIGS_SYSTEMD_USER_DIR || path.join(os.homedir(), '.config', 'systemd', 'user'), unit);
const MARK = `# Managed by the rigs app-publish tool for app "${id}"`;

// systemd quoting: inside double quotes \ and " are escaped; % and $ would be expanded, so they are doubled.
const sd = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
const unitText = [
  MARK, '[Unit]', `Description=${name} (RIGS App Cloud)`, 'After=network.target', '',
  '[Service]', 'Type=simple', `WorkingDirectory=${cwd}`, `ExecStart=/bin/sh -c ${sd(command)}`,
  ...Object.entries(env).map(([k, v]) => `Environment=${sd(`${k}=${v}`)}`), 'Restart=on-failure', 'RestartSec=3', '',
  '[Install]', 'WantedBy=default.target', '',
].join('\n');
const launch = { ...(useSystemd ? { systemd: unit } : {}), command, cwd, ...(Object.keys(env).length ? { env } : {}) };
const registration = {
  id, name, icon: String(args.icon || ''), port, healthPath, launch,
  ...(args.description ? { description: String(args.description) } : {}), ...(Array.isArray(args.tags) ? { tags: args.tags.map(String) } : {}),
};

async function daemonApps() {
  try { return (await (await fetch(`${daemon}/api/local/apps`, { signal: AbortSignal.timeout(3000) })).json()).apps || []; } catch { return null; }
}
const existing = (await daemonApps())?.find((a) => a.id === id) || null;
const takesOver = existing && !existing.target.endsWith(`:${port}`);
const unitForeign = fs.existsSync(unitPath) && !fs.readFileSync(unitPath, 'utf8').includes(MARK);

if (args.dryRun) done({ ok: true, dryRun: true, plan: { steps: [useSystemd ? `write + enable ${unitPath}` : 'no systemd unit on this machine (launch command only)', `wait for http://127.0.0.1:${port}${healthPath}`, `POST ${daemon}/api/local/apps`], registration, unit: useSystemd ? unitText : undefined }, existing: existing && { target: existing.target, health: existing.health?.status }, warnings: [takesOver && `App Cloud id "${id}" already points at ${existing.target}`, unitForeign && `${unitPath} was not written by this tool`].filter(Boolean) });
if (takesOver && !force) done({ ok: false, error: `App Cloud id "${id}" already points at ${existing.target}: pick another id, or pass force: true to repoint it` });
if (useSystemd && unitForeign && !force) done({ ok: false, error: `${unitPath} exists and was not written by this tool: pick another unit name, or pass force: true to replace it` });
if (existing === null && !(await daemonApps())) done({ ok: false, error: `the RIGS daemon is not answering at ${daemon}` });

const steps = [];
try {
  if (useSystemd) {
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, unitText);
    for (const a of [['daemon-reload'], ['enable', '--now', unit]]) {
      const r = await exec('systemctl', ['--user', ...a]);
      if (r.code) throw new Error(`systemctl --user ${a.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
    }
    steps.push(`unit ${unit} enabled and started`);
  }
  const reg = await fetch(`${daemon}/api/local/apps`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(registration), signal: AbortSignal.timeout(15000) });
  const regJson = await reg.json().catch(() => ({}));
  if (!reg.ok) throw new Error(`registration refused (HTTP ${reg.status}): ${regJson.error || 'unknown'}`);
  steps.push('registered in the App Cloud');
  if (!useSystemd) await fetch(`${daemon}/api/local/app-start/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(waitSec * 1000) }).catch(() => {});
  const until = Date.now() + waitSec * 1000;
  let status = 0;
  while (Date.now() < until) {
    try { status = (await fetch(`http://127.0.0.1:${port}${healthPath}`, { signal: AbortSignal.timeout(3000), redirect: 'manual' })).status; if (status && status < 500) break; } catch { status = 0; }
    await sleep(500);
  }
  const app = (await daemonApps())?.find((a) => a.id === id);
  done({ ok: status > 0 && status < 500, steps, healthStatus: status || null, ...(useSystemd ? { unit, unitPath } : {}), path: app ? `/api/nodes/${encodeURIComponent(app.node)}/apps/${id}/` : undefined, ...(status && status < 500 ? {} : { error: `registered, but http://127.0.0.1:${port}${healthPath} did not answer within ${waitSec}s` }) });
} catch (e) {
  done({ ok: false, steps, error: e.message });
}
