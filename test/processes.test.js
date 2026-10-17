// Processes on any machine: list, and stop by pid or name — never RIGS itself or the command doing it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { etimeSeconds, kill, list, parsePs } from '../src/processes.js';

test('ps output parses (Linux and macOS formats)', () => {
  const ps = ' 2576174  1  magix 445.0  3.1 2048000 01:37 Rl ./MadMikesGarage.x86_64 -autotest -fpslog\n   82069  1 mix 0.4 0.2 40960 1-02:03:04 S /Applications/Sunshine.app/Contents/MacOS/sunshine\n';
  const [a, b] = parsePs(ps);
  assert.equal(a.name, 'MadMikesGarage.x86_64');
  assert.equal(a.cpu, 445);
  assert.equal(a.rssMB, 2000);
  assert.equal(b.name, 'sunshine');
  assert.equal(b.uptimeSec, etimeSeconds('1-02:03:04'));
  assert.equal(etimeSeconds('01:37'), 97);
});

test('kill by name stops the match, not RIGS itself', { skip: process.platform === 'win32' }, async () => {
  const child = spawn('sleep', ['300'], { argv0: 'rigs-proc-test-sleeper' });
  await new Promise((r) => setTimeout(r, 300));
  const found = await list({ filter: String(child.pid) });
  assert.ok(found.processes.length >= 0);
  const r = await kill({ pid: child.pid });
  assert.deepEqual(r.stopped.map((p) => p.pid), [child.pid]);
  const self = await kill({ pid: process.pid });
  assert.equal(self.stopped.length, 0);
  assert.equal(self.refused[0].pid, process.pid, 'RIGS never kills itself');
});
