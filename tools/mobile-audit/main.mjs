// Mobile audit of the JARVIS UI: runs scripts/mobile-shots.js from the RIGS app checkout (screenshots at phone sizes,
// axe-core, layout and touch-target metrics) and returns the summary instead of the log. Needs playwright + axe-core
// installed OUTSIDE the repo (RIGS_AUDIT_TOOLS=<dir>, default ~/.cache/rigs-audit): mkdir -p ~/.cache/rigs-audit && cd it && npm i playwright axe-core
//   { "out": "docs/mobile-audit/after", "viewports": "390x844,360x740", "views": "home,apps", "strict": true }
// Without url it starts its own server on :4781 with a scratch RIGS_HOME; never point url at a production daemon.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = JSON.parse(process.env.RIGS_TOOL_ARGS || process.argv[2] || '{}');
const done = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 1); };
const expand = (p) => path.resolve(String(p).replace(/^~(?=$|[\\/])/, os.homedir()));

// An explicit appDir is the only place looked in: a wrong one is an error, not a silent switch to another checkout.
const candidates = (args.appDir ? [args.appDir] : [process.env.RIGS_APP_DIR, process.env.RIGS_TOOL_DIR && path.join(process.env.RIGS_TOOL_DIR, '..', '..'), path.join(os.homedir(), '.rigs', 'app')]).filter(Boolean).map(expand);
const appDir = candidates.find((d) => fs.existsSync(path.join(d, 'scripts', 'mobile-shots.js')));
if (!appDir && !args.dryRun) done({ ok: false, error: 'scripts/mobile-shots.js not found: pass appDir (a RIGS checkout)' });
const script = path.join(appDir || candidates[0] || '.', 'scripts', 'mobile-shots.js');
const out = path.resolve(appDir || '.', String(args.out || 'docs/mobile-audit/after'));
const flags = ['--out', out];
for (const k of ['url', 'viewports', 'views']) if (args[k]) flags.push(`--${k}`, String(args[k]));
for (const k of ['reducedMotion', 'strict']) if (args[k]) flags.push(`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
if (args.pngPrimary) flags.push('--png-primary');
if (args.dryRun) done({ ok: true, dryRun: true, plan: { appDir, script, command: [process.execPath, script, ...flags].join(' '), auditTools: process.env.RIGS_AUDIT_TOOLS || '~/.cache/rigs-audit' } });

const r = await new Promise((resolve) => execFile(process.execPath, [script, ...flags], { cwd: appDir, maxBuffer: 64 * 1024 * 1024, timeout: 540000, env: { ...process.env } }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr })));
let summary = null;
try {
  // report.json (written by scripts/mobile-shots.js): { check: { overflow, smallTargets, pageErrors, captureFailed }, views: [{ view, viewport, failures, errors, axeViolationRules, captureFailed }] }
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  const views = Array.isArray(report.views) ? report.views : [];
  const bad = (v) => (v.failures?.overflow || 0) + (v.failures?.smallTargets || 0) + (v.errors?.length || 0) + (v.axeViolationRules || 0) + (v.captureFailed ? 1 : 0) > 0;
  summary = {
    count: views.length, ...(report.check || {}), axeViolationRules: views.reduce((a, v) => a + (v.axeViolationRules || 0), 0),
    failing: views.filter(bad).slice(0, 12).map((v) => ({ view: v.view, viewport: v.viewport, overflow: v.failures?.overflow || 0, smallTargets: v.failures?.smallTargets || 0, errors: (v.errors || []).length, axe: v.axeViolationRules || 0, ...(v.captureFailed ? { captureFailed: true } : {}) })),
  };
} catch { /* the script failed before writing its report */ }
const tail = (s) => s.trim().split('\n').slice(-6).join('\n');
const check = /CHECK.*/.exec(r.stdout)?.[0] || null;
done({ ok: r.code === 0, code: r.code, out, check, report: summary, ...(r.code ? { error: tail(r.stderr || r.stdout) } : {}) });
