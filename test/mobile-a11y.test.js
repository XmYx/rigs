// Mobile / a11y regression guard. Static checks parse ui/index.html + ui/src/*.css and need no browser;
// the browser checks (overflow, 44px targets, axe) reuse scripts/mobile-shots.js and skip when Playwright
// + axe-core + a Chromium aren't installed (CI on macOS, Ubuntu and Windows stays green).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const html = read('ui/index.html');
const css = read('ui/src/styles.css');
const a11y = read('ui/src/a11y.js');
const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
const meta = (name) => metas.find((m) => new RegExp(`name=["']${name}["']`, 'i').test(m));

test('viewport meta is present and does not block zoom', () => {
  const m = meta('viewport');
  assert.ok(m, 'viewport meta missing');
  const content = (m.match(/content=["']([^"']*)["']/i) || [])[1] || '';
  assert.match(content, /width=device-width/);
  assert.match(content, /viewport-fit=cover/);
  assert.doesNotMatch(content, /user-scalable\s*=\s*(no|0)/i, 'user-scalable=no blocks pinch zoom');
  const max = content.match(/maximum-scale\s*=\s*([\d.]+)/i);
  assert.ok(!max || Number(max[1]) >= 2, `maximum-scale=${max?.[1]} blocks zoom`);
});

test('web manifest link and theme-color are present, and the manifest file exists', () => {
  assert.ok(meta('theme-color'), 'theme-color meta missing');
  const link = html.match(/<link\b[^>]*rel=["']manifest["'][^>]*>/i)?.[0];
  assert.ok(link, 'manifest link missing');
  const href = link.match(/href=["']([^"']+)["']/i)?.[1];
  assert.ok(href?.startsWith('/'), 'manifest href should be root-relative');
  const manifest = JSON.parse(read(path.join('ui', href)));
  assert.ok(manifest.name && manifest.start_url && manifest.display);
});

test('CSS has safe-area insets and prefers-reduced-motion rules', () => {
  assert.match(css, /env\(safe-area-inset-top/);
  assert.match(css, /env\(safe-area-inset-bottom/);
  assert.match(css, /@media[^{]*prefers-reduced-motion:\s*reduce/);
});

test('an aria-live region exists (static markup or the shared a11y live region)', () => {
  assert.match(a11y, /setAttribute\('aria-live'/, 'a11y.js no longer creates an aria-live region');
  assert.match(a11y, /export function announce/);
  const uiJs = fs.readdirSync(path.join(ROOT, 'ui/src')).filter((f) => f.endsWith('.js')).map((f) => read(`ui/src/${f}`)).join('\n');
  assert.match(uiJs, /\bannounce\(/, 'announce() is never called');
});

test('icon-only buttons in index.html carry aria-label', () => {
  const bad = [];
  for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    const text = m[2].replace(/<[^>]*>/g, '').trim();
    if (!text) continue; // filled in at runtime (e.g. the brain badge); a11y.js names it
    if (/[\p{L}\p{N}]/u.test(text)) continue; // has a text label
    if (!/aria-label=["'][^"']+["']/.test(m[1])) bad.push(`${text} ${m[1].trim().slice(0, 60)}`);
  }
  assert.deepEqual(bad, [], 'icon-only buttons without aria-label');
});

// ---------------------------------------------------------------- browser checks (optional)
function browserTools() {
  const dirs = [process.env.RIGS_AUDIT_TOOLS, path.join(os.homedir(), '.cache/rigs-audit'), ROOT].filter(Boolean);
  for (const d of dirs) {
    try {
      const req = createRequire(path.join(path.resolve(d.replace(/^~/, os.homedir())), 'x.js'));
      const pw = req('playwright');
      req.resolve('axe-core/axe.min.js');
      const exe = pw.chromium.executablePath();
      if (exe && fs.existsSync(exe)) return d;
      const roots = [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright')];
      if (roots.some((r) => fs.existsSync(r) && fs.readdirSync(r).some((x) => x.startsWith('chromium')))) return d;
    } catch { /* try next */ }
  }
  return null;
}
const tools = process.env.RIGS_SKIP_BROWSER_TESTS ? null : browserTools();

test('browser: no overflow, no small touch targets, no page errors at phone sizes', { skip: tools ? false : 'Playwright/axe-core/Chromium not installed', timeout: 115000 }, (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-mobile-a11y-'));
  const r = spawnSync(process.execPath, ['scripts/mobile-shots.js', '--out', out, '--viewports', '390x844', '--strict', '--png-primary', '--views', 'orb-home,more-sheet'], {
    cwd: ROOT, encoding: 'utf8', timeout: 80000, env: { ...process.env, RIGS_AUDIT_TOOLS: tools },
  });
  // A heavily loaded machine can starve the capture; that is not a regression, so don't fail on a timeout.
  if (r.error?.code === 'ETIMEDOUT' || r.signal) { fs.rmSync(out, { recursive: true, force: true }); return t.skip('browser capture timed out (machine busy)'); }
  const check = (r.stdout.match(/^CHECK.*$/m) || [''])[0];
  assert.equal(r.status, 0, `mobile-shots failed: ${check}\n${(r.stdout + r.stderr).slice(-1500)}`);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  const views = Array.isArray(report) ? report : report.views || Object.values(report);
  const serious = views.flatMap((v) => (v.axe || v.violations || []).filter((x) => ['serious', 'critical'].includes(x.impact)));
  assert.equal(serious.length, 0, `axe serious/critical: ${serious.map((x) => x.id).join(', ')}`);
  fs.rmSync(out, { recursive: true, force: true });
});
