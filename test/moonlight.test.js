// Stale Moonlight host pruning (the cause of pairing loops after a host's Sunshine identity changed).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-ml-'));
const { _test } = await import('../src/moonlight-hosts.js');

test('drops the stale entry for a re-identified host and renumbers the rest', async () => {
  const file = path.join(process.env.RIGS_HOME, 'Moonlight.conf');
  fs.writeFileSync(file, [
    '[General]', 'certificate=@ByteArray(abc)', '', '[hosts]',
    '1\\hostname=magix-system', '1\\localaddress=192.168.1.137', '1\\uuid=D5CE46D0', '1\\apps\\size=1', '1\\apps\\1\\name=Desktop',
    '2\\hostname=MacBookPro.home', '2\\localaddress=100.95.245.33', '2\\manualaddress=mix.ts.net', '2\\uuid=E0652632',
    '3\\hostname=other', '3\\localaddress=10.0.0.9', '3\\uuid=AAAA', 'size=3', '', '[gcmapping]', 'size=0', '',
  ].join('\n'));
  const n = await _test.pruneIni(file, { hostname: 'MacBookPro.home', uuid: '9F7044FB' }, '100.95.245.33');
  assert.equal(n, 1);
  const out = fs.readFileSync(file, 'utf8');
  assert.match(out, /1\\hostname=magix-system/);
  assert.match(out, /1\\apps\\1\\name=Desktop/);
  assert.match(out, /2\\hostname=other/);
  assert.match(out, /size=2/);
  assert.doesNotMatch(out, /E0652632/);
  assert.match(out, /\[gcmapping\]\nsize=0/);
});

test('keeps entries whose uuid matches the live host', () => {
  assert.equal(_test.stale({ hostname: 'x', uuid: 'abc' }, { hostname: 'x', uuid: 'ABC' }, '1.2.3.4'), false);
  assert.equal(_test.stale({ hostname: 'y', uuid: 'zzz', manualaddress: '1.2.3.4' }, { hostname: 'x', uuid: 'ABC' }, '1.2.3.4'), true);
});
