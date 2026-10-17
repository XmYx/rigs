// OpenRig status refreshes are shared: concurrent callers never multiply `rig` processes (a fake `rig` on PATH counts them).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-openrig-'));
process.env.RIGS_HOME = path.join(ROOT, '.rigs');
const binDir = path.join(ROOT, 'bin');
const calls = path.join(ROOT, 'calls.log');
fs.mkdirSync(binDir);
fs.writeFileSync(path.join(binDir, 'rig'), `#!/bin/sh\necho "$*" >> '${calls}'\nsleep 0.3\ncase "$1" in\n  daemon) echo "Daemon running on port 7433";;\n  --version) echo "0.0.0-test";;\n  *) echo "[]";;\nesac\n`, { mode: 0o755 });
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
const openrig = await import('../src/openrig.js');

test('concurrent status calls share one refresh; force reuses a fresh result', { skip: process.platform === 'win32' }, async () => {
  const all = await Promise.all([...Array(10)].map((_, i) => openrig.status(i % 2 === 0)));
  assert.ok(all.every((s) => s === all[0] && s.daemon === 'running'));
  const n = () => fs.readFileSync(calls, 'utf8').split('\n').filter((l) => l.startsWith('daemon status')).length;
  assert.equal(n(), 1, 'one refresh for ten callers');
  await openrig.status(true);
  assert.equal(n(), 1, 'force within 2 s reuses it');
});
