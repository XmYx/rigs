// Home Security t2: camera discovery + ingest. Pure parts only (no ffmpeg, no network, no real cameras) plus the
// camera registry on a temp dir and ONVIF/WS-Security payloads.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const D = await import('../apps/home-security/discovery.js');
const I = await import('../apps/home-security/ingest.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hs-disc-'));

// ── webcam enumeration ───────────────────────────────────────────────────────────────────────────────────────────

test('avfoundation: video devices only, screens dropped, log prefix stripped', () => {
  const stderr = [
    '[AVFoundation indev @ 0x7f8] AVFoundation video devices:',
    '[AVFoundation indev @ 0x7f8] [0] FaceTime HD Camera',
    "[AVFoundation indev @ 0x7f8] [1] Mike's iPhone Camera",
    '[AVFoundation indev @ 0x7f8] [2] Capture screen 0',
    '[AVFoundation indev @ 0x7f8] AVFoundation audio devices:',
    '[AVFoundation indev @ 0x7f8] [0] MacBook Pro Microphone',
  ].join('\n');
  assert.deepEqual(D.parseAvfoundationDevices(stderr), [{ index: 0, name: 'FaceTime HD Camera' }, { index: 1, name: "Mike's iPhone Camera" }]);
  assert.deepEqual(D.parseAvfoundationDevices(''), []);
});

test('dshow: modern "(video)" form and legacy section form, alternative name attached', () => {
  const modern = [
    '[dshow @ 000001] "Integrated Camera" (video)',
    '[dshow @ 000001]   Alternative name "@device_pnp_\\\\?\\usb#vid_1"',
    '[dshow @ 000001] "Microphone Array" (audio)',
    '[dshow @ 000001]   Alternative name "@device_cm_{33D9}"',
    '[dshow @ 000001] "OBS Virtual Camera" (none)',
  ].join('\n');
  const m = D.parseDshowDevices(modern);
  assert.equal(m.length, 1);
  assert.equal(m[0].name, 'Integrated Camera');
  assert.equal(m[0].altName, '@device_pnp_\\\\?\\usb#vid_1');

  const legacy = [
    '[dshow @ 1] DirectShow video devices',
    '[dshow @ 1]  "USB Webcam"',
    '[dshow @ 1]     Alternative name "@device_pnp_x"',
    '[dshow @ 1] DirectShow audio devices',
    '[dshow @ 1]  "Line In"',
  ].join('\n');
  const l = D.parseDshowDevices(legacy);
  assert.deepEqual(l, [{ name: 'USB Webcam', altName: '@device_pnp_x' }]);
});

test('v4l2 sysfs: only index 0 capture nodes, by-id path preferred, sorted numerically', () => {
  const out = D.parseV4l2Sysfs([
    { node: 'video10', index: '0', name: 'Cam B' },
    { node: 'video1', index: '1', name: 'Cam A metadata' },
    { node: 'video0', index: '0', name: 'Cam A', byId: '/dev/v4l/by-id/usb-A-video-index0' },
    { node: 'media0', index: '0', name: 'not video' },
  ]);
  assert.deepEqual(out.map((d) => d.node), ['video0', 'video10']);
  assert.equal(out[0].device, '/dev/v4l/by-id/usb-A-video-index0');
  assert.equal(out[1].device, '/dev/video10');
});

test('webcamCameras: per-OS source, unique ids for duplicate names, linux id from by-id', () => {
  const mac = D.webcamCameras('darwin', [{ name: 'FaceTime HD Camera' }, { name: 'FaceTime HD Camera' }]);
  assert.equal(mac[0].id, 'webcam-facetime-hd-camera');
  assert.equal(mac[1].id, 'webcam-facetime-hd-camera-2');
  assert.deepEqual(mac[0].source, { format: 'avfoundation', device: 'FaceTime HD Camera' });
  assert.equal(mac[0].kind, 'webcam');

  const win = D.webcamCameras('win32', [{ name: 'Integrated Camera', altName: '@alt' }]);
  assert.equal(win[0].source.format, 'dshow');
  assert.equal(win[0].source.device, '@alt'); // opened by alternative name

  const lin = D.webcamCameras('linux', [{ name: 'Cam', device: '/dev/v4l/by-id/usb-X-video-index0', node: 'video0' }]);
  assert.equal(lin[0].source.format, 'v4l2');
  assert.equal(lin[0].id, 'webcam-usb-x-video-index0');
});

test('enumerateWebcams without ffmpeg reports an error instead of throwing', async () => {
  const r = await D.enumerateWebcams({ ffmpeg: null, platform: 'darwin' });
  assert.deepEqual(r.devices, []);
  assert.match(r.error, /ffmpeg/);
  const w = await D.enumerateWebcams({ ffmpeg: null, platform: 'plan9' });
  assert.deepEqual(w.devices, []);
});

// ── subnets ──────────────────────────────────────────────────────────────────────────────────────────────────────

const v4 = (address, cidr, extra = {}) => ({ address, family: 'IPv4', internal: false, cidr, ...extra });

test('cidr helpers', () => {
  assert.equal(D.ipToInt('192.168.1.5'), 3232235781);
  assert.equal(D.ipToInt('300.1.1.1'), null);
  assert.equal(D.intToIp(3232235781), '192.168.1.5');
  assert.equal(D.parseCidr('192.168.1.77/24').cidr, '192.168.1.0/24');
  assert.equal(D.parseCidr('nope'), null);
  assert.equal(D.parseCidr('1.2.3.4/33'), null);
  assert.ok(D.cidrContains('10.0.0.0/8', '10.255.1.1'));
  assert.ok(!D.cidrContains('10.0.0.0/8', '11.0.0.1'));
});

test('localSubnets: own LANs only; tailscale, loopback, link-local, docker/bridge/awdl excluded', () => {
  const ifaces = {
    en0: [v4('192.168.1.20', '192.168.1.20/24'), { address: 'fe80::1', family: 'IPv6', internal: false }],
    utun4: [v4('100.95.1.2', '100.95.1.2/32')],
    tailscale0: [v4('100.64.0.9', '100.64.0.9/10')],
    lo0: [v4('127.0.0.1', '127.0.0.1/8', { internal: true })],
    docker0: [v4('172.17.0.1', '172.17.0.1/16')],
    'br-abc': [v4('172.18.0.1', '172.18.0.1/16')],
    bridge100: [v4('192.168.64.1', '192.168.64.1/24')],
    awdl0: [v4('169.254.3.3', '169.254.3.3/16')],
    en5: [v4('169.254.9.9', '169.254.9.9/16')],
  };
  const subs = D.localSubnets(ifaces, {});
  assert.deepEqual(subs.map((s) => s.cidr), ['192.168.1.0/24']);
  assert.equal(subs[0].iface, 'en0');
  assert.equal(subs[0].address, '192.168.1.20');
});

test('localSubnets: a wide LAN is clamped to the /24 we sit in; host routes ignored; netmask form works', () => {
  const subs = D.localSubnets({
    en0: [v4('10.20.30.40', '10.20.30.40/8')],
    en1: [{ address: '192.168.5.9', family: 'IPv4', internal: false, netmask: '255.255.255.0' }],
    en2: [v4('192.168.9.9', '192.168.9.9/32')],
  }, {});
  assert.deepEqual(subs.map((s) => s.cidr).sort(), ['10.20.30.0/24', '192.168.5.0/24']);
});

test('localSubnets: excludeCidrs and extraCidrs (RFC1918, /22 or narrower)', () => {
  const ifaces = { en0: [v4('192.168.1.20', '192.168.1.20/24')], en1: [v4('10.0.0.5', '10.0.0.5/24')] };
  const ex = D.localSubnets(ifaces, { discovery: { excludeCidrs: ['10.0.0.0/24'] } });
  assert.deepEqual(ex.map((s) => s.cidr), ['192.168.1.0/24']);

  const extra = D.localSubnets(ifaces, { discovery: { extraCidrs: ['192.168.50.0/23', '8.8.8.0/24', '10.0.0.0/8', '100.64.1.0/24'] } });
  assert.deepEqual(extra.map((s) => s.cidr), ['192.168.1.0/24', '10.0.0.0/24', '192.168.50.0/23']);
  assert.equal(extra[2].iface, null);
});

test('validateExtraCidrs rejects public, CGNAT/tailnet, too-wide and malformed ranges', () => {
  const r = D.validateExtraCidrs(['192.168.7.0/24', '172.16.0.0/22', '10.0.0.0/21', '8.8.8.0/24', '100.100.0.0/24', 'abc', '172.15.0.0/24', '192.168.0.0/16']);
  assert.deepEqual(r.ok, ['192.168.7.0/24', '172.16.0.0/22']);
  assert.equal(r.errors.length, 6);
  assert.ok(r.errors.some((e) => /wider than \/22/.test(e)));
  assert.ok(r.errors.some((e) => /RFC1918/.test(e)));
  assert.ok(r.errors.some((e) => /not an IPv4 CIDR/.test(e)));
});

test('subnetHosts: excludes network, broadcast and skipped addresses; refuses wide ranges', () => {
  const h = D.subnetHosts('192.168.1.0/24', ['192.168.1.20']);
  assert.equal(h.length, 253);
  assert.ok(!h.includes('192.168.1.0') && !h.includes('192.168.1.255') && !h.includes('192.168.1.20'));
  assert.deepEqual(D.subnetHosts('10.0.0.0/16'), []);
});

// ── ONVIF ────────────────────────────────────────────────────────────────────────────────────────────────────────

const PROBE_MATCHES = `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
 xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"><s:Body>
<d:ProbeMatches><d:ProbeMatch>
<a:EndpointReference><a:Address>urn:uuid:AAAAAAAA-1111-2222-3333-444444444444</a:Address></a:EndpointReference>
<d:Types>dn:NetworkVideoTransmitter tds:Device</d:Types>
<d:Scopes>onvif://www.onvif.org/name/Front_Door onvif://www.onvif.org/hardware/DS-2CD2 onvif://www.onvif.org/Profile/S</d:Scopes>
<d:XAddrs>http://10.9.9.9/onvif/device_service http://192.168.1.50:8080/onvif/device_service</d:XAddrs>
</d:ProbeMatch></d:ProbeMatches></s:Body></s:Envelope>`;

test('WS-Discovery probe is addressed to the NetworkVideoTransmitter type', () => {
  const p = D.buildProbe('abc');
  assert.match(p, /uuid:abc/);
  assert.match(p, /dn:NetworkVideoTransmitter/);
  assert.match(p, /discovery\/Probe/);
});

test('parseProbeMatches extracts uuid, XAddrs, name and hardware scopes', () => {
  const [m] = D.parseProbeMatches(PROBE_MATCHES);
  assert.equal(m.uuid, 'aaaaaaaa-1111-2222-3333-444444444444');
  assert.equal(m.xaddrs.length, 2);
  assert.equal(m.name, 'Front Door');
  assert.equal(m.hardware, 'DS-2CD2');
  assert.deepEqual(D.parseProbeMatches('garbage'), []);
  assert.deepEqual(D.parseProbeMatches(''), []);
});

test('onvifCamera prefers the XAddr inside our subnets and carries no credentials', () => {
  const [m] = D.parseProbeMatches(PROBE_MATCHES);
  const cam = D.onvifCamera(m, [{ cidr: '192.168.1.0/24' }]);
  assert.equal(cam.kind, 'onvif');
  assert.equal(cam.source.host, '192.168.1.50');
  assert.equal(cam.source.onvif.xaddr, 'http://192.168.1.50:8080/onvif/device_service');
  assert.equal(cam.id, 'onvif-aaaaaaaa-1111-2222-3333-444444444444');
  assert.equal(cam.name, 'Front Door DS-2CD2');
  assert.equal(cam.fingerprint, 'onvif:aaaaaaaa-1111-2222-3333-444444444444');
});

test('WS-Security header carries a correct PasswordDigest = base64(sha1(nonce + created + password))', () => {
  const nonce = Buffer.from('0123456789abcdef');
  const created = '2026-11-05T12:00:00.000Z';
  const h = D.wsSecurityHeader('admin', 'secret', { nonce, created });
  const expected = crypto.createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created), Buffer.from('secret')])).digest('base64');
  assert.ok(h.includes(`>${expected}</Password>`));
  assert.ok(h.includes(nonce.toString('base64')));
  assert.ok(h.includes(created));
  assert.ok(h.includes('<Username>admin</Username>'));
  assert.ok(!h.includes('secret'), 'the clear-text password must not appear');
  assert.match(h, /PasswordDigest/);
});

test('WS-Security header escapes the username', () => {
  const h = D.wsSecurityHeader('a<b&c', 'x');
  assert.ok(h.includes('<Username>a&lt;b&amp;c</Username>'));
});

// ── probes ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('probeCamera: RTSP and HTTP hits need setup and keep no credentials', () => {
  const r = D.probeCamera({ ip: '192.168.1.9', port: 554, kind: 'rtsp' });
  assert.equal(r.id, 'ip-192.168.1.9-554');
  assert.equal(r.source.url, 'rtsp://192.168.1.9:554/');
  assert.equal(r.needsSetup, true);
  const h = D.probeCamera({ ip: '192.168.1.9', port: 8080, kind: 'mjpeg' });
  assert.equal(h.source.url, 'http://192.168.1.9:8080/');
});

test('portProbe on an empty subnet list does nothing and never throws', async () => {
  assert.deepEqual(await D.portProbe([]), []);
});

// ── URLs, credentials, redaction ─────────────────────────────────────────────────────────────────────────────────

test('stripUserInfo splits credentials and validates scheme', () => {
  const s = D.stripUserInfo('rtsp://al%40:p%3Ass@192.168.1.5:554/live');
  assert.equal(s.url, 'rtsp://192.168.1.5:554/live');
  assert.equal(s.username, 'al@');
  assert.equal(s.password, 'p:ss');
  assert.throws(() => D.stripUserInfo('file:///etc/passwd'), /scheme/);
  assert.throws(() => D.stripUserInfo('not a url'), /invalid/);
});

test('withCredentials round-trips with stripUserInfo', () => {
  const url = D.withCredentials('rtsp://h/live', { username: 'u@x', password: 'p/w' });
  const s = D.stripUserInfo(url);
  assert.equal(s.username, 'u@x');
  assert.equal(s.password, 'p/w');
  assert.equal(D.withCredentials('rtsp://h/live', null), 'rtsp://h/live');
});

test('redact hides user info and password params everywhere', () => {
  assert.equal(D.redact('open rtsp://admin:hunter2@192.168.1.5/live failed'), 'open rtsp://***@192.168.1.5/live failed');
  assert.equal(D.redact('http://h/x?user=a&password=hunter2&z=1'), 'http://h/x?user=a&password=***&z=1');
  assert.ok(!D.redact('rtsp://a:b@h').includes('a:b'));
  assert.equal(D.redact(null), '');
});

// ── registry ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('registry: manual camera keeps credentials in secrets.json (0600) and never in cameras.json', () => {
  const dir = tmp();
  const reg = new D.CameraRegistry(D.fileStore(dir));
  const cam = reg.addManual({ name: 'Garage', url: 'rtsp://admin:hunter2@192.168.1.60:554/stream1' });
  assert.match(cam.id, /^manual-[0-9a-f]{6}$/);
  assert.equal(cam.kind, 'rtsp');
  assert.equal(cam.source.url, 'rtsp://192.168.1.60:554/stream1');
  assert.equal(cam.hasCredentials, true);
  assert.equal(cam.enabled, false);
  const cams = fs.readFileSync(path.join(dir, 'cameras.json'), 'utf8');
  assert.ok(!cams.includes('hunter2') && !cams.includes('admin'));
  const sec = path.join(dir, 'secrets.json');
  assert.ok(fs.readFileSync(sec, 'utf8').includes('hunter2'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(sec).mode & 0o777, 0o600);
  assert.equal(reg.sourceUrl(cam.id), 'rtsp://admin:hunter2@192.168.1.60:554/stream1');

  const pub = JSON.stringify(D.publicCamera(cam, { error: 'failed rtsp://admin:hunter2@h/x' }));
  assert.ok(!pub.includes('hunter2'));
});

test('registry: http URL is mjpeg; password patch is write-only and survives a reload', () => {
  const dir = tmp();
  const reg = new D.CameraRegistry(D.fileStore(dir));
  const cam = reg.addManual({ url: 'http://192.168.1.61/video.mjpg' });
  assert.equal(cam.kind, 'mjpeg');
  assert.equal(cam.hasCredentials, false);
  const { restart } = reg.patch(cam.id, { username: 'u', password: 'pw1' });
  assert.equal(restart, true);
  const again = new D.CameraRegistry(D.fileStore(dir));
  assert.equal(again.get(cam.id).hasCredentials, true);
  assert.equal(again.credentials(cam.id).password, 'pw1');
  assert.ok(!JSON.stringify(D.publicCamera(again.get(cam.id))).includes('pw1'));
  again.patch(cam.id, { username: '', password: '' });
  assert.equal(again.get(cam.id).hasCredentials, false);
  assert.equal(again.credentials(cam.id), null);
});

test('registry.patch validates input with status 400 and 404', () => {
  const reg = new D.CameraRegistry(D.fileStore(tmp()));
  const cam = reg.addManual({ url: 'rtsp://192.168.1.2/s' });
  const status = (fn) => { try { fn(); } catch (e) { return e.status; } return null; };
  assert.equal(status(() => reg.patch('nope', {})), 404);
  assert.equal(status(() => reg.patch(cam.id, { name: '  ' })), 400);
  assert.equal(status(() => reg.patch(cam.id, { enabled: 'yes' })), 400);
  assert.equal(status(() => reg.patch(cam.id, { mode: 'always' })), 400);
  assert.equal(status(() => reg.patch(cam.id, { transcode: 'vp9' })), 400);
  assert.equal(status(() => reg.patch(cam.id, { input: { width: 10 } })), 400);
  assert.equal(status(() => reg.patch(cam.id, { input: { fps: 500 } })), 400);
  assert.equal(status(() => reg.patch(cam.id, { motion: { sensitivity: 0 } })), 400);
  assert.equal(status(() => reg.patch(cam.id, { motion: { zones: 'x' } })), 400);
  assert.equal(status(() => reg.patch(cam.id, { url: 'ftp://x/y' })), 400);
  assert.equal(reg.patch(cam.id, { enabled: true }).restart, true);
  assert.equal(reg.patch(cam.id, { enabled: true }).restart, false);
  assert.equal(reg.patch(cam.id, { name: 'Renamed' }).camera.name, 'Renamed');
});

test('registry.patch: a webcam has no URL', () => {
  const reg = new D.CameraRegistry(D.fileStore(tmp()));
  reg.applyScan(D.webcamCameras('darwin', [{ name: 'FaceTime HD Camera' }]), { kinds: ['webcam'] });
  assert.throws(() => reg.patch('webcam-facetime-hd-camera', { url: 'rtsp://x/y' }), /webcam has no URL/);
});

test('scan merge: new cameras start disabled, known ones keep settings, vanished ones become missing, manual never', () => {
  const dir = tmp();
  const reg = new D.CameraRegistry(D.fileStore(dir));
  const manual = reg.addManual({ url: 'rtsp://192.168.1.3/s' });
  const found = D.webcamCameras('darwin', [{ name: 'Cam A' }, { name: 'Cam B' }]);
  reg.applyScan(found, { kinds: ['webcam'], now: 1000 });
  const a = reg.get('webcam-cam-a');
  assert.equal(a.enabled, false);
  assert.equal(a.discoveredAt, 1000);
  reg.patch('webcam-cam-a', { enabled: true, name: 'Kitchen' });

  reg.applyScan(found.filter((f) => f.id !== 'webcam-cam-b'), { kinds: ['webcam'], now: 2000 });
  assert.equal(reg.get('webcam-cam-a').name, 'Kitchen');
  assert.equal(reg.get('webcam-cam-a').enabled, true);
  assert.equal(reg.get('webcam-cam-a').lastSeenAt, 2000);
  assert.equal(reg.get('webcam-cam-b').missing, true);
  assert.ok(!reg.get(manual.id).missing);

  reg.applyScan(found, { kinds: ['webcam'], now: 3000 });
  assert.equal(reg.get('webcam-cam-b').missing, false);
});

test('scan of one kind does not mark other kinds missing', () => {
  const reg = new D.CameraRegistry(D.fileStore(tmp()));
  reg.applyScan([D.probeCamera({ ip: '192.168.1.9', port: 554, kind: 'rtsp' })], { kinds: ['rtsp'] });
  reg.applyScan(D.webcamCameras('darwin', [{ name: 'Cam A' }]), { kinds: ['webcam'] });
  assert.ok(!reg.get('ip-192.168.1.9-554').missing);
});

test('registry.save drops runtime fields; remove deletes the camera and its secret', () => {
  const dir = tmp();
  const reg = new D.CameraRegistry(D.fileStore(dir));
  const cam = reg.addManual({ url: 'rtsp://u:p@192.168.1.4/s' });
  cam.status = 'recording'; cam.error = 'x'; cam.seenBy = ['a'];
  reg.save();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'cameras.json'), 'utf8'));
  for (const k of D.RUNTIME_FIELDS) assert.ok(!(k in saved[0]), k);
  assert.equal(reg.remove(cam.id), true);
  assert.equal(reg.remove(cam.id), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')), {});
});

test('slug: accents stripped, punctuation collapsed, never empty', () => {
  assert.equal(D.slug('Café  Cam #1!'), 'cafe-cam-1');
  assert.equal(D.slug('***'), 'camera');
  assert.ok(D.CAMERA_ID_RE.test('webcam-facetime-hd-camera'));
  assert.ok(!D.CAMERA_ID_RE.test('../x'));
  assert.ok(!D.CAMERA_ID_RE.test('A'));
});

// ── ingest: pure helpers ─────────────────────────────────────────────────────────────────────────────────────────

test('parseSegmentList reads csv rows and ignores a partial trailing line', () => {
  const csv = 'seg-000000.ts,0.000000,2.000000\nseg-000001.ts,2.000000,4.010000\nseg-000002.ts,4.0';
  assert.deepEqual(I.parseSegmentList(csv), [
    { file: 'seg-000000.ts', start: 0, end: 2 },
    { file: 'seg-000001.ts', start: 2, end: 4.01 },
  ]);
  assert.equal(I.parseSegmentList(`${csv}\n`).length, 2); // "4.0" has no end column
  assert.deepEqual(I.parseSegmentList(''), []);
});

test('segmentRelPath uses UTC day/hour folders', () => {
  const ms = Date.UTC(2026, 10, 5, 7, 3, 9);
  assert.equal(I.segmentRelPath('cam1', ms), `segments/cam1/2026-11-05/07/${ms}.ts`);
});

test('SegmentRing: capacity, monotonic seq, rejects out-of-order and duplicates', () => {
  const r = new I.SegmentRing(3);
  for (const t of [1000, 3000, 5000, 7000]) assert.ok(r.push({ startMs: t, durMs: 2000 }));
  assert.equal(r.push({ startMs: 7000, durMs: 2000 }), null);
  assert.equal(r.push({ startMs: 100, durMs: 2000 }), null);
  assert.deepEqual(r.items.map((s) => s.startMs), [3000, 5000, 7000]);
  assert.deepEqual(r.items.map((s) => s.seq), [1, 2, 3]);
  assert.equal(r.find(5000).seq, 2);
  assert.equal(r.find(1), null);
  assert.equal(r.last.startMs, 7000);
  assert.equal(r.recent(2).length, 2);
  r.clear();
  assert.equal(r.last, null);
});

test('livePlaylist: relative seg/ URIs, discontinuity before each later segment, sequences from the first item', () => {
  const pl = I.livePlaylist([{ seq: 5, startMs: 10000, durMs: 2000 }, { seq: 6, startMs: 12000, durMs: 2500 }]);
  const lines = pl.split('\n');
  assert.equal(lines[0], '#EXTM3U');
  assert.ok(pl.includes('#EXT-X-MEDIA-SEQUENCE:5'));
  assert.ok(pl.includes('#EXT-X-DISCONTINUITY-SEQUENCE:5'));
  assert.ok(pl.includes('#EXT-X-TARGETDURATION:3'));
  assert.equal(pl.match(/#EXT-X-DISCONTINUITY\n/g).length, 1);
  assert.ok(pl.includes('seg/10000.ts') && pl.includes('seg/12000.ts'));
  assert.ok(!/^\/|https?:/m.test(pl.replace(/^#.*$/gm, '')), 'URIs must be relative');
  assert.ok(pl.includes('#EXTINF:2.500,'));
  assert.ok(pl.includes('#EXT-X-PROGRAM-DATE-TIME:1970-01-01T00:00:10.000Z'));
  assert.ok(pl.endsWith('\n'));
});

test('livePlaylist of nothing is still a valid playlist header', () => {
  const pl = I.livePlaylist([]);
  assert.ok(pl.startsWith('#EXTM3U'));
  assert.ok(pl.includes('#EXT-X-MEDIA-SEQUENCE:0'));
});

test('nextBackoff: 2 s → doubles → capped at 60 s, resets after a healthy 5 min run', () => {
  assert.equal(I.nextBackoff(0, 0), 2000);
  assert.equal(I.nextBackoff(2000, 1000), 4000);
  assert.equal(I.nextBackoff(32000, 1000), 60000);
  assert.equal(I.nextBackoff(60000, 1000), 60000);
  assert.equal(I.nextBackoff(60000, 300000), 2000);
});

test('classifyError: friendly reasons, macOS TCC only for webcams, credentials redacted', () => {
  const c = I.classifyError;
  assert.match(c('Not authorized to capture video', { platform: 'darwin', kind: 'webcam' }), /System Settings/);
  assert.doesNotMatch(c('permission denied', { platform: 'linux', kind: 'webcam' }), /System Settings/);
  assert.equal(c('Device or resource busy'), 'device busy');
  assert.match(c('method DESCRIBE failed: 401 Unauthorized'), /authentication failed/);
  assert.equal(c('Connection refused'), 'connection refused');
  assert.match(c('Connection timed out'), /not reachable/);
  assert.match(c('Server returned 404 Not Found'), /stream not found/);
  assert.equal(c('/dev/video9: No such file or directory'), 'device not found');
  assert.match(c('Selected framerate (30) is not supported by the device'), /size or frame rate/);
  assert.match(c('Unknown encoder libx264'), /H\.264 encoder/);
  const leak = c('error opening rtsp://admin:hunter2@10.0.0.1/x: weird failure');
  assert.ok(!leak.includes('hunter2'));
});

test('stallReason: a webcam that never delivers on macOS is a TCC permission problem', () => {
  assert.match(I.stallReason({ gotSegment: false, platform: 'darwin', kind: 'webcam' }), /permission/);
  assert.match(I.stallReason({ gotSegment: false, platform: 'linux', kind: 'webcam' }), /no video/);
  assert.match(I.stallReason({ gotSegment: true, platform: 'darwin', kind: 'webcam' }), /stopped sending/);
});

test('parseMotionDims reads the gray rawvideo output size from ffmpeg banner', () => {
  const banner = [
    'Output #0, segment, to \'seg-%06d.ts\':',
    '  Stream #0:0: Video: h264, yuv420p, 1280x720, q=2-31',
    'Output #1, rawvideo, to \'pipe:1\':',
    '  Stream #1:0: Video: rawvideo (Y800 / 0x30303859), gray, 160x90, q=2-31, 5 fps',
    'Output #2, image2, to \'latest.jpg\':',
    '  Stream #2:0: Video: mjpeg, yuvj420p, 640x360',
  ].join('\n');
  assert.deepEqual(I.parseMotionDims(banner), { width: 160, height: 90 });
  assert.equal(I.parseMotionDims('nothing'), null);
});

test('cameraMode: camera override, then the global default, then continuous', () => {
  assert.equal(I.cameraMode({ mode: 'motion' }, { recording: { defaultMode: 'continuous' } }), 'motion');
  assert.equal(I.cameraMode({ mode: null }, { recording: { defaultMode: 'motion' } }), 'motion');
  assert.equal(I.cameraMode({}, {}), 'continuous');
});

const SETTINGS = { recording: { segmentSeconds: 2 }, motion: { fps: 5, width: 160 }, live: { snapshotFps: 1 } };
const argsOf = (o) => I.buildFfmpegArgs({ settings: SETTINGS, snapshotPath: '/d/latest.jpg', ...o });
const has = (a, ...seq) => a.some((_, i) => seq.every((s, k) => a[i + k] === s));

test('buildFfmpegArgs: three outputs (segments, motion pipe, snapshot) for every camera kind', () => {
  const rtsp = argsOf({ camera: { kind: 'rtsp', source: {} }, inputUrl: 'rtsp://u:p@h/s', encoder: 'libx264' });
  assert.ok(has(rtsp, '-rtsp_transport', 'tcp'));
  assert.ok(has(rtsp, '-i', 'rtsp://u:p@h/s'));
  assert.ok(has(rtsp, '-f', 'segment', '-segment_time', '2'));
  assert.ok(has(rtsp, '-reset_timestamps', '1'));
  assert.ok(has(rtsp, '-f', 'rawvideo', 'pipe:1'));
  assert.equal(rtsp[rtsp.length - 1], '/d/latest.jpg');
  assert.ok(has(rtsp, '-c:v', 'libx264'));
  assert.ok(rtsp.includes('-an'));

  const mjpeg = argsOf({ camera: { kind: 'mjpeg', source: {} }, inputUrl: 'http://h/v.mjpg', encoder: 'libx264' });
  assert.ok(has(mjpeg, '-use_wallclock_as_timestamps', '1'));

  const test_ = argsOf({ camera: { kind: 'test', source: {} }, encoder: 'libx264' });
  assert.ok(has(test_, '-f', 'lavfi'));
  assert.ok(test_.some((a) => /^testsrc2=size=1280x720:rate=15$/.test(a)));
});

test('buildFfmpegArgs: webcam input per OS, relaxInput drops size/rate', () => {
  const cam = { kind: 'webcam', source: { device: 'FaceTime HD Camera' }, input: { width: 640, height: 480, fps: 30 } };
  const mac = argsOf({ camera: cam, platform: 'darwin', encoder: 'libx264' });
  assert.ok(has(mac, '-f', 'avfoundation'));
  assert.ok(has(mac, '-video_size', '640x480'));
  assert.ok(has(mac, '-i', 'FaceTime HD Camera:none'));
  const macRelaxed = argsOf({ camera: cam, platform: 'darwin', encoder: 'libx264', relaxInput: true });
  assert.ok(!macRelaxed.includes('-video_size') && !macRelaxed.includes('-framerate'));

  const win = argsOf({ camera: { ...cam, source: { device: '@alt' } }, platform: 'win32', encoder: 'libx264' });
  assert.ok(has(win, '-f', 'dshow'));
  assert.ok(has(win, '-i', 'video=@alt'));

  const lin = argsOf({ camera: { ...cam, source: { device: '/dev/video0' } }, platform: 'linux', encoder: 'libx264' });
  assert.ok(has(lin, '-f', 'v4l2'));
  assert.ok(has(lin, '-i', '/dev/video0'));
});

test('buildFfmpegArgs: copy mode keeps the stream, transcode forces keyframes on segment boundaries, videotoolbox on request', () => {
  const copy = argsOf({ camera: { kind: 'rtsp', source: {} }, inputUrl: 'rtsp://h/s', copy: true });
  assert.ok(has(copy, '-c:v', 'copy'));
  assert.ok(!copy.includes('libx264'));
  const enc = argsOf({ camera: { kind: 'rtsp', source: {}, input: { fps: 10 } }, inputUrl: 'rtsp://h/s', encoder: 'libx264' });
  assert.ok(has(enc, '-g', '20'));
  assert.ok(enc.some((a) => /^expr:gte\(t,n_forced\*2\)$/.test(a)));
  const vt = argsOf({ camera: { kind: 'rtsp', source: {} }, inputUrl: 'rtsp://h/s', encoder: 'h264_videotoolbox' });
  assert.ok(has(vt, '-c:v', 'h264_videotoolbox'));
});
