// OpenRig status refreshes are shared: concurrent callers never multiply `rig` processes (a fake `rig` on PATH counts them).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-openrig-'));
process.env.RIGS_HOME = path.join(ROOT, '.rigs');
const callLog = [];
const openrig = await import('../src/openrig.js');
// A fake `rig` through the runner hook (rig itself is found via the RIGS wrapper first, not PATH).
openrig._setRunner(async (bin, args) => {
  callLog.push(args.join(' '));
  await new Promise((r) => setTimeout(r, 300));
  const out = args[0] === 'daemon' ? 'Daemon running on port 7433' : args[0] === '--version' ? '0.0.0-test' : '[]';
  return { code: 0, stdout: out, stderr: '' };
});

test('concurrent status calls share one refresh; force reuses a fresh result', { skip: process.platform === 'win32' }, async () => {
  const all = await Promise.all([...Array(10)].map((_, i) => openrig.status(i % 2 === 0)));
  assert.ok(all.every((s) => s === all[0] && s.daemon === 'running'));
  const n = () => callLog.filter((l) => l.startsWith('daemon status')).length;
  assert.equal(n(), 1, 'one refresh for ten callers');
  await openrig.status(true);
  assert.equal(n(), 1, 'force within 2 s reuses it');
});
