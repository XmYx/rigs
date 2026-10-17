// Mesh SSH host keys: peers pin each other's published OpenSSH host keys in known_hosts, replacing
// stale entries (the Tailscale SSH → OpenSSH switch broke `ssh magix-system`). Throwaway RIGS_SSH_DIR,
// never the real ~/.ssh.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-ssh-'));
const SSH_DIR = path.join(ROOT, 'ssh');
const HOST_KEY_DIR = path.join(ROOT, 'etc-ssh');
Object.assign(process.env, {
  RIGS_HOME: path.join(ROOT, '.rigs'), RIGS_SSH_DIR: SSH_DIR, RIGS_SSH_HOST_KEY_DIR: HOST_KEY_DIR,
  RIGS_NO_MIGRATIONS: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_OPENRIG: '1', RIGS_NAME: 'test-node', RIGS_PEERS: '',
});
const ssh = await import('../src/ssh.js');
const { sshServerEnabled } = await import('../src/tailscale.js');
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

/** A real OpenSSH ed25519 public key ("ssh-ed25519 base64"). */
function edKey() {
  const raw = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const str = (b) => Buffer.concat([Buffer.from([0, 0, 0, b.length]), b]);
  return 'ssh-ed25519 ' + Buffer.concat([str(Buffer.from('ssh-ed25519')), str(raw)]).toString('base64');
}

const DNS = 'magix-system.tail34565a.ts.net';
const IP4 = '100.82.152.1';
const IP6 = 'fd7a:115c:a1e0::1f01:9801';
const TAILSCALE_KEY = edKey(); // what Tailscale SSH presented before
const OPENSSH_KEY = edKey(); // what OpenSSH presents now
const OTHER_KEY = edKey();
const magix = (extra = {}) => ({
  id: 'magix', name: 'magix-system', rigs: true, online: true, viaToken: false, sshUser: 'magix', sshHostKeys: [`${OPENSSH_KEY} root@magix-system`],
  tailscale: { ip: IP4, ips: [IP4, IP6], dnsName: DNS }, ...extra,
});

test('pins a peer under its MagicDNS name, short name and tailnet IPs, dropping the stale Tailscale SSH key', () => {
  const before = [
    `github.com ${OTHER_KEY}`,
    `${DNS} ${TAILSCALE_KEY}`, // the line ssh refused with "Host key ... has changed"
    `other-box,${IP4} ${TAILSCALE_KEY}`, // shared line: only magix's name goes
    `[${DNS}]:2222 ${TAILSCALE_KEY}`, // other port: not ours
    `*.ts.net ${TAILSCALE_KEY}`, // pattern: not ours
    `@revoked ${DNS} ${TAILSCALE_KEY}`, // markers are never touched
    `${DNS} ${OPENSSH_KEY}`, // already right: kept
    '',
  ].join('\n');
  const r = ssh.pinHostKeys(before, [magix()]);
  assert.deepEqual(r.replaced.sort(), [DNS, IP4].sort());
  assert.equal(r.pinned, 1);
  const lines = r.text.split('\n');
  assert.ok(lines.includes(`github.com ${OTHER_KEY}`));
  assert.ok(!lines.includes(`${DNS} ${TAILSCALE_KEY}`));
  assert.ok(lines.includes(`other-box ${TAILSCALE_KEY}`));
  assert.ok(lines.includes(`[${DNS}]:2222 ${TAILSCALE_KEY}`));
  assert.ok(lines.includes(`*.ts.net ${TAILSCALE_KEY}`));
  assert.ok(lines.includes(`@revoked ${DNS} ${TAILSCALE_KEY}`));
  assert.ok(lines.includes(`${DNS},magix-system,${IP4},${IP6} ${OPENSSH_KEY} rigs-peer:magix-system`));
  // Idempotent: a second pass changes nothing.
  const again = ssh.pinHostKeys(r.text, [magix()]);
  assert.equal(again.text, r.text);
  assert.deepEqual(again.replaced, []);
});

test('never pins token peers, self, or peers that publish no OpenSSH keys (e.g. Tailscale SSH on)', () => {
  const before = `${DNS} ${TAILSCALE_KEY}\n`;
  for (const p of [magix({ viaToken: true }), magix({ self: true }), magix({ sshHostKeys: null }), magix({ sshHostKeys: ['not a key'] }), magix({ tailscale: null })]) {
    const r = ssh.pinHostKeys(before, [p]);
    assert.equal(r.text, before);
    assert.equal(r.pinned, 0);
  }
});

test('a peer that stops publishing keys is dropped from the managed block', () => {
  const pinned = ssh.pinHostKeys('', [magix()]).text;
  assert.match(pinned, /rigs-peer:magix-system/);
  const r = ssh.pinHostKeys(pinned, [magix({ sshHostKeys: null })]);
  assert.doesNotMatch(r.text, /rigs-peer:magix-system/);
  assert.match(r.text, /# >>> rigs mesh >>>\n# <<< rigs mesh <<<\n/);
});

const keygen = spawnSync('ssh-keygen', ['-?'], { encoding: 'utf8' });
test('matches hashed known_hosts entries and leaves a file OpenSSH resolves to the new key', { skip: keygen.error ? 'ssh-keygen not installed' : false }, () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'hashed-'));
  const file = path.join(dir, 'known_hosts');
  fs.writeFileSync(file, `${DNS} ${TAILSCALE_KEY}\ngithub.com ${OTHER_KEY}\n`);
  assert.equal(spawnSync('ssh-keygen', ['-H', '-f', file]).status, 0); // HashKnownHosts-style file, as on Ubuntu
  const hashed = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(hashed, /magix|github/);
  const r = ssh.pinHostKeys(hashed, [magix()]);
  assert.deepEqual(r.replaced, [DNS]);
  fs.writeFileSync(file, r.text);
  for (const host of [DNS, 'magix-system', IP4]) {
    const found = spawnSync('ssh-keygen', ['-F', host, '-f', file], { encoding: 'utf8' }).stdout;
    assert.ok(found.includes(OPENSSH_KEY.split(' ')[1]), `${host} → OpenSSH key`);
    assert.ok(!found.includes(TAILSCALE_KEY.split(' ')[1]), `${host} → no stale key`);
  }
  assert.equal(spawnSync('ssh-keygen', ['-F', 'github.com', '-f', file]).status, 0, 'other hashed hosts kept');
});

test('syncPeers writes known_hosts under RIGS_SSH_DIR and keeps the previous file', async () => {
  fs.mkdirSync(SSH_DIR, { recursive: true });
  const kh = path.join(SSH_DIR, 'known_hosts');
  fs.writeFileSync(kh, `${DNS} ${TAILSCALE_KEY}\n`, { mode: 0o600 });
  const r = await ssh.syncPeers([{ id: 'me', name: 'test-node', self: true, rigs: true, online: true }, magix()]);
  assert.equal(r.hostKeys, 1);
  assert.deepEqual(r.replaced, [DNS]);
  assert.match(fs.readFileSync(kh, 'utf8'), new RegExp(`rigs-peer:magix-system`));
  assert.doesNotMatch(fs.readFileSync(kh, 'utf8'), new RegExp(TAILSCALE_KEY.split(' ')[1].replace(/[+/]/g, '\\$&')));
  assert.equal(fs.readFileSync(kh + '.rigs.old', 'utf8'), `${DNS} ${TAILSCALE_KEY}\n`);
  if (process.platform !== 'win32') assert.equal(fs.statSync(kh + '.rigs.old').mode & 0o777, 0o600, 'backup no more readable than known_hosts');
  assert.match(fs.readFileSync(path.join(SSH_DIR, 'config'), 'utf8'), /Host magix-system magix-system\.rigs\n {2}HostName magix-system\.tail34565a\.ts\.net/);
  const again = await ssh.syncPeers([magix()]);
  assert.deepEqual(again.replaced, []);
});

test('publishes this machine\'s OpenSSH host keys from the host key dir', async (t) => {
  if ((await sshServerEnabled()) !== false) return t.skip('Tailscale SSH is on (or unknown) here, so no OpenSSH keys are published');
  fs.mkdirSync(HOST_KEY_DIR, { recursive: true });
  fs.writeFileSync(path.join(HOST_KEY_DIR, 'ssh_host_ed25519_key.pub'), `${OPENSSH_KEY} root@magix-system\n`);
  fs.writeFileSync(path.join(HOST_KEY_DIR, 'ssh_host_ed25519_key'), 'PRIVATE — never read');
  fs.writeFileSync(path.join(HOST_KEY_DIR, 'ssh_host_bogus_key.pub'), 'garbage\n');
  assert.deepEqual(await ssh.hostKeys(), [OPENSSH_KEY]);
});
