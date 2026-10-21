// The app catalog (src/app-catalog.js): .desktop and Info.plist parsing, Exec field codes, icon lookup, the Linux and
// macOS scanners over fixture trees, host limits and the shaped answer. Fixtures: test/fixtures/app-catalog.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const C = await import('../src/app-catalog.js');
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/app-catalog');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');

test('parseDesktopEntry: [Desktop Entry] keys only, unlocalized, booleans and lists typed', () => {
  const e = C.parseDesktopEntry(read('applications/filmcraft.desktop'));
  assert.equal(e.Name, 'FilmCraft');
  assert.equal(e.GenericName, 'Video editor');
  assert.deepEqual(e.Categories, ['AudioVideo', 'Video']);
  assert.equal(e.Terminal, false);
  assert.equal(e.StartupNotify, true);
  // groups other than [Desktop Entry] (actions) do not leak in
  const d = C.parseDesktopEntry(read('applications/dbus.desktop'));
  assert.equal(d.Name, 'Files');
  assert.equal(d.Exec, 'nautilus --new-window %U');
  assert.equal(d.DBusActivatable, true);
});

test('desktopExecArgv: quoting, field codes, %% and unknown codes', () => {
  const f = ['/a b/x.mp4', '/c.mp4'];
  assert.deepEqual(C.desktopExecArgv('"/home/magix/.local/bin/filmcraft" %F', f), ['/home/magix/.local/bin/filmcraft', '/a b/x.mp4', '/c.mp4']);
  assert.deepEqual(C.desktopExecArgv('app %f', f), ['app', '/a b/x.mp4']);
  assert.deepEqual(C.desktopExecArgv('app %U', []), ['app']);
  assert.deepEqual(C.desktopExecArgv('app %i %c', [], { name: 'My App', icon: 'my-icon' }), ['app', '--icon', 'my-icon', 'My App']);
  assert.deepEqual(C.desktopExecArgv('app --pct=100%% %k %d', [], { path: '/x.desktop' }), ['app', '--pct=100%', '/x.desktop']);
  assert.deepEqual(C.desktopExecArgv('sh -c "echo \\"hi\\" \\$HOME"', []), ['sh', '-c', 'echo "hi" $HOME']);
  assert.deepEqual(C.desktopExecArgv('env A=1 app "" x', []), ['env', 'A=1', 'app', '', 'x']);
});

test('desktopSkip: hidden, wrong type, other desktop, missing TryExec', () => {
  const skip = (f, o) => C.desktopSkip(C.parseDesktopEntry(read(`applications/${f}`)), o);
  assert.equal(skip('filmcraft.desktop'), null);
  assert.equal(skip('hidden.desktop'), 'hidden');
  assert.equal(skip('link.desktop'), 'not an application');
  assert.equal(skip('kdeonly.desktop', { desktop: 'ubuntu:GNOME' }), 'not for this desktop');
  assert.equal(skip('kdeonly.desktop', { desktop: 'KDE' }), null);
  assert.equal(skip('trymissing.desktop', { hasExe: () => false }), 'TryExec missing');
  assert.equal(skip('trymissing.desktop', { hasExe: () => true }), null);
  assert.equal(C.desktopSkip({ Type: 'Application', Name: 'X', Exec: 'x', NotShowIn: ['GNOME'] }, { desktop: 'ubuntu:GNOME' }), 'not for this desktop');
});

test('desktopItem: id from the path, source from the directory, terminal apps not streamable', () => {
  const root = path.join(FIX, 'applications');
  assert.equal(C.desktopId(path.join(root, 'sub/nested.desktop'), root), 'sub-nested');
  assert.equal(C.desktopId('/usr/share/applications/org.gnome.Nautilus.desktop', '/usr/share/applications'), 'org.gnome.Nautilus');
  assert.equal(C.desktopSource('/var/lib/flatpak/exports/share/applications/a.desktop'), 'flatpak');
  assert.equal(C.desktopSource('/var/lib/snapd/desktop/applications/a.desktop'), 'snap');
  assert.equal(C.desktopSource('/usr/share/applications/a.desktop'), 'desktop');
  const f = C.desktopItem(C.parseDesktopEntry(read('applications/filmcraft.desktop')), path.join(root, 'filmcraft.desktop'), 'filmcraft');
  assert.equal(f.name, 'FilmCraft');
  assert.equal(f.streamable, true);
  assert.equal(f.launch.acceptsFiles, true);
  assert.deepEqual(f.launch.argv, ['/home/magix/.local/bin/filmcraft']);
  const t = C.desktopItem(C.parseDesktopEntry(read('applications/htop.desktop')), '/x/htop.desktop', 'htop');
  assert.equal(t.terminal, true);
  assert.equal(t.streamable, false);
  assert.match(t.why, /terminal/);
  const ff = C.desktopItem({ Type: 'Application', Name: 'Firefox', Exec: 'firefox %u' }, '/x/firefox.desktop', 'firefox');
  assert.match(ff.note, /profile lock/);
});

test('sanitizeId keeps ids URL-safe', () => {
  assert.equal(C.sanitizeId('com.apple.Safari'), 'com.apple.Safari');
  assert.equal(C.sanitizeId('My App/x y'), 'My_App_x_y');
  assert.equal(C.sanitizeId(''), '');
});

test('iconCandidates: absolute paths as given; names over theme dirs, then pixmaps', () => {
  assert.deepEqual(C.iconCandidates('/opt/x/icon.png'), ['/opt/x/icon.png']);
  assert.deepEqual(C.iconCandidates(''), []);
  const c = C.iconCandidates('ai.storyteller.filmcraft', { dataDirs: ['/usr/share'], home: '/home/m' });
  assert.equal(c[0], '/home/m/.local/share/icons/hicolor/256x256/apps/ai.storyteller.filmcraft.png');
  assert.ok(c.indexOf('/usr/share/icons/hicolor/256x256/apps/ai.storyteller.filmcraft.png') < c.indexOf('/usr/share/icons/hicolor/scalable/apps/ai.storyteller.filmcraft.svg'));
  assert.ok(c.includes('/usr/share/pixmaps/ai.storyteller.filmcraft.png'));
  assert.deepEqual(C.iconCandidates('foo.png', { dataDirs: [], home: '/h' }).filter((x) => x.endsWith('/foo.png')).length > 0, true);
});

test('parseInfoPlist: name, id, icon file; background-only apps and non-apps skipped', () => {
  const j = (f) => JSON.parse(read(`macos/${f}`));
  const s = C.parseInfoPlist(j('Safari.json'), '/Applications/Safari.app');
  assert.equal(s.id, 'com.apple.Safari');
  assert.equal(s.name, 'Safari');
  assert.equal(s.iconFile, 'AppIcon.icns');
  assert.deepEqual(s.categories, ['productivity']);
  assert.equal(s.launch.path, '/Applications/Safari.app');
  assert.equal(C.parseInfoPlist(j('Agent.json'), '/Applications/Agent.app'), null);
  const p = C.parseInfoPlist(j('Plain.json'), '/Applications/Plain Thing.app');
  assert.equal(p.id, 'Plain_Thing');
  assert.equal(p.iconFile, 'thing.icns');
  assert.equal(C.parseInfoPlist(null, '/x.app'), null);
  assert.equal(C.parseInfoPlist({ CFBundlePackageType: 'BNDL' }, '/x.app'), null);
});

test('windowsItems: shortcuts and AppX, never streamable, noise dropped, ids unique', () => {
  const items = C.windowsItems([
    { Name: 'Notepad++', Path: 'C:\\ProgramData\\Start\\Notepad++.lnk', Target: 'C:\\npp.exe', Args: '' },
    { Name: 'Uninstall Notepad++', Path: 'C:\\x\\u.lnk' },
    { Name: 'Calculator', AppId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' },
    { Name: 'Notepad++', Path: 'C:\\ProgramData\\Start\\Notepad++.lnk' },
    { Name: '' },
  ]);
  assert.deepEqual(items.map((i) => i.name), ['Notepad++', 'Calculator']);
  assert.deepEqual(items.map((i) => i.source), ['startmenu', 'appx']);
  assert.ok(items.every((i) => i.streamable === false && /not available/.test(i.why) && /^[\w.+-]+$/.test(i.id)));
});

test('hostSupport and shapeItems: sorted by name, host limit applied, icon URL only with an icon', () => {
  assert.deepEqual(C.hostSupport('linux'), { supported: true });
  assert.equal(C.hostSupport('darwin').supported, false);
  assert.match(C.hostSupport('win32').why, /Windows/);
  const raw = [
    { id: 'b', name: 'beta', streamable: true, iconPath: '/i.png' },
    { id: 'a', name: 'Alpha 10', streamable: true },
    { id: 'c', name: 'Alpha 2', streamable: false, why: 'a terminal program' },
  ];
  const ok = C.shapeItems(raw, { hasIcon: (i) => !!i.iconPath });
  assert.deepEqual(ok.map((i) => i.id), ['c', 'a', 'b']); // natural order: Alpha 2 before Alpha 10
  assert.equal(ok[2].icon, 'appstream/catalog/b/icon');
  assert.equal(ok[1].icon, null);
  assert.equal(ok[0].streamable, false);
  assert.equal(ok[0].why, 'a terminal program');
  assert.ok(!('iconPath' in ok[2]));
  const blocked = C.shapeItems(raw, { host: { supported: false, why: 'macOS hosting is not available yet' } });
  assert.ok(blocked.every((i) => i.streamable === false && i.why === 'macOS hosting is not available yet'));
});

test('scanLinux: fixture tree, hidden and TryExec-missing skipped, first directory wins', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'appcat-'));
  try {
    const userApps = path.join(home, '.local/share/applications');
    fs.mkdirSync(userApps, { recursive: true });
    fs.writeFileSync(path.join(userApps, 'filmcraft.desktop'), '[Desktop Entry]\nType=Application\nName=FilmCraft (mine)\nExec=fc\nIcon=/nonexistent.png\n');
    fs.mkdirSync(path.join(home, 'sys/share'), { recursive: true });
    fs.cpSync(path.join(FIX, 'applications'), path.join(home, 'sys/share/applications'), { recursive: true });
    const items = C.scanLinux({ home, env: { XDG_DATA_DIRS: path.join(home, 'sys/share'), XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', PATH: '' } });
    const names = items.map((i) => i.name).sort();
    assert.deepEqual(names, ['FilmCraft (mine)', 'Files', 'Nested App', 'htop'].sort());
    assert.equal(items.find((i) => i.id === 'filmcraft').name, 'FilmCraft (mine)');
    assert.equal(items.find((i) => i.id === 'sub-nested').launch.acceptsFiles, true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('scanLinux: icons resolve from the theme tree; oversized SVG is not served', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'appcat-'));
  try {
    const apps = path.join(home, '.local/share/applications');
    fs.mkdirSync(apps, { recursive: true });
    fs.writeFileSync(path.join(apps, 'a.desktop'), '[Desktop Entry]\nType=Application\nName=A\nExec=a\nIcon=aicon\n');
    fs.writeFileSync(path.join(apps, 'b.desktop'), '[Desktop Entry]\nType=Application\nName=B\nExec=b\nIcon=bicon\n');
    const hi = path.join(home, '.local/share/icons/hicolor');
    fs.mkdirSync(path.join(hi, '64x64/apps'), { recursive: true });
    fs.mkdirSync(path.join(hi, 'scalable/apps'), { recursive: true });
    fs.writeFileSync(path.join(hi, '64x64/apps/aicon.png'), 'png');
    fs.writeFileSync(path.join(hi, 'scalable/apps/bicon.svg'), 'x'.repeat(300 * 1024));
    const items = C.scanLinux({ home, env: { XDG_DATA_DIRS: '/nonexistent', PATH: '' } });
    assert.equal(items.find((i) => i.id === 'a').iconPath, path.join(hi, '64x64/apps/aicon.png'));
    assert.equal(items.find((i) => i.id === 'b').iconPath, '');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
