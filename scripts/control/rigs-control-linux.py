#!/usr/bin/env python3
"""RIGS Control helper for Linux: screen capture, input and window list for the RIGS daemon.

Spawned by src/control-linux.js when control is enabled; speaks JSON lines on stdio:
  request  {"id": 1, "op": "shot", ...}
  reply    {"id": 1, "ok": true, "result": {...}}  or  {"id": 1, "ok": false, "error": {"code", "message"}}
  event    {"event": "closed" | "restore-token", ...}

Backends (chosen by the daemon, see selectBackend in src/control.js):
  capture: mutter (org.gnome.Mutter.ScreenCast) | portal (xdg-desktop-portal ScreenCast)
  input:   mutter (org.gnome.Mutter.RemoteDesktop) | portal (RemoteDesktop) | uinput (/dev/uinput)
  windows: rigs-extension (dev.rigs.Control) | atspi (list only)

Needs python3 stdlib; the D-Bus backends need PyGObject (Gio/GLib); frames come from gst-launch-1.0
(pipewiresrc). The helper owns every session it opens: when it exits, Mutter/the portal end them, which
also turns off GNOME's "being shared" indicator. Everything it holds (keys, buttons) is released on
'release', on 'stop' and on exit.
"""
import fcntl
import json
import os
import struct
import subprocess
import sys
import threading
import time

try:
    import gi
    gi.require_version('Gio', '2.0')
    from gi.repository import Gio, GLib
except Exception:  # noqa: BLE001 - optional: uinput works without it
    gi = Gio = GLib = None

OUT_LOCK = threading.Lock()


def send(obj):
    with OUT_LOCK:
        sys.stdout.write(json.dumps(obj) + '\n')
        sys.stdout.flush()


def event(name, **kw):
    send({'event': name, **kw})


class Fail(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


# ------------------------------------------------------------------------- keys

# Normalized key names (src/control.js parseCombo) → X keysyms.
KEYSYMS = {
    'ctrl': 0xffe3, 'shift': 0xffe1, 'alt': 0xffe9, 'super': 0xffeb,
    'enter': 0xff0d, 'tab': 0xff09, 'esc': 0xff1b, 'space': 0x20, 'backspace': 0xff08,
    'delete': 0xffff, 'insert': 0xff63, 'up': 0xff52, 'down': 0xff54, 'left': 0xff51, 'right': 0xff53,
    'home': 0xff50, 'end': 0xff57, 'pageup': 0xff55, 'pagedown': 0xff56, 'capslock': 0xffe5,
    'printscreen': 0xff61, 'menu': 0xff67,
}
for _i in range(1, 25):
    KEYSYMS['f%d' % _i] = 0xffbe + _i - 1


def keysym_for_char(ch):
    o = ord(ch)
    if ch == '\n':
        return 0xff0d
    if ch == '\t':
        return 0xff09
    if 0x20 <= o <= 0x7e or 0xa0 <= o <= 0xff:
        return o
    return 0x01000000 + o


def keysym_for(name):
    if name in KEYSYMS:
        return KEYSYMS[name]
    if len(name) == 1:
        return keysym_for_char(name)
    raise Fail('bad-args', 'unknown key: %s' % name)


# Linux evdev codes (input-event-codes.h) for uinput.
EV_SYN, EV_KEY, EV_REL, EV_ABS = 0, 1, 2, 3
BTN = {'left': 0x110, 'right': 0x111, 'middle': 0x112}
EVDEV = {
    'esc': 1, 'backspace': 14, 'tab': 15, 'enter': 28, 'ctrl': 29, 'shift': 42, 'alt': 56, 'space': 57,
    'capslock': 58, 'super': 125, 'menu': 127, 'home': 102, 'up': 103, 'pageup': 104, 'left': 105,
    'right': 106, 'end': 107, 'down': 108, 'pagedown': 109, 'insert': 110, 'delete': 111, 'printscreen': 99,
}
for _i, _c in enumerate([59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 87, 88]):
    EVDEV['f%d' % (_i + 1)] = _c
for _i in range(13, 25):
    EVDEV['f%d' % _i] = 183 + _i - 13
# US layout: char → (code, shift)
US = {}
for _row, _start in (('1234567890', 2), ('qwertyuiop', 16), ('asdfghjkl', 30), ('zxcvbnm', 44)):
    for _i, _c in enumerate(_row):
        US[_c] = (_start + _i, False)
for _c in 'qwertyuiopasdfghjklzxcvbnm':
    US[_c.upper()] = (US[_c][0], True)
for _c, _s in zip('!@#$%^&*()', '1234567890'):
    US[_c] = (US[_s][0], True)
for _c, _code, _sh in ((' ', 57, False), ('-', 12, False), ('_', 12, True), ('=', 13, False), ('+', 13, True),
                       ('[', 26, False), ('{', 26, True), (']', 27, False), ('}', 27, True), ('\\', 43, False),
                       ('|', 43, True), (';', 39, False), (':', 39, True), ("'", 40, False), ('"', 40, True),
                       ('`', 41, False), ('~', 41, True), (',', 51, False), ('<', 51, True), ('.', 52, False),
                       ('>', 52, True), ('/', 53, False), ('?', 53, True), ('\n', 28, False), ('\t', 15, False)):
    US[_c] = (_code, _sh)


# ------------------------------------------------------------------------- D-Bus helpers

def bus():
    if Gio is None:
        raise Fail('needs-permission', 'python3-gi is not installed')
    if not hasattr(bus, 'conn'):
        bus.conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    return bus.conn


def call(dest, path, iface, method, args=None, sig=None, timeout=8000, fd_list=False):
    try:
        if fd_list:
            res, out_fds = bus().call_with_unix_fd_list_sync(dest, path, iface, method, args,
                                                             GLib.VariantType(sig) if sig else None,
                                                             Gio.DBusCallFlags.NONE, timeout, None, None)
            return res.unpack(), out_fds
        res = bus().call_sync(dest, path, iface, method, args, GLib.VariantType(sig) if sig else None,
                              Gio.DBusCallFlags.NONE, timeout, None)
        return res.unpack() if res is not None else None
    except GLib.Error as e:
        msg = e.message or str(e)
        if 'AccessDenied' in msg or 'NotAuthorized' in msg:
            raise Fail('needs-permission', '%s.%s: %s' % (iface, method, msg))
        if 'ServiceUnknown' in msg or 'UnknownMethod' in msg or 'UnknownObject' in msg or 'UnknownInterface' in msg:
            raise Fail('unsupported', '%s.%s: %s' % (iface, method, msg))
        if 'Timeout' in msg or 'TimedOut' in msg:
            raise Fail('timeout', '%s.%s did not answer (is the desktop busy?)' % (iface, method))
        raise Fail('error', '%s.%s: %s' % (iface, method, msg))


def get_prop(dest, path, iface, name, timeout=8000):
    return call(dest, path, 'org.freedesktop.DBus.Properties', 'Get', GLib.Variant('(ss)', (iface, name)), '(v)',
                timeout=timeout)[0]


def pump():
    ctx = GLib.MainContext.default()
    while ctx.pending():
        ctx.iteration(False)


def wait_for(pred, timeout=10.0):
    end = time.monotonic() + timeout
    while True:
        pump()
        if pred():
            return True
        if time.monotonic() > end:
            return False
        time.sleep(0.01)


def has_name(name):
    try:
        return bool(call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameHasOwner',
                         GLib.Variant('(s)', (name,)), '(b)', timeout=3000)[0])
    except Fail:
        return False


# ------------------------------------------------------------------------- displays

def mutter_displays():
    """Logical monitors from org.gnome.Mutter.DisplayConfig, with the physical pixel size of each."""
    serial, monitors, logical, props = call('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
                                            'org.gnome.Mutter.DisplayConfig', 'GetCurrentState', None,
                                            '(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})')
    modes = {}
    for spec, mlist, mprops in monitors:
        for mode in mlist:
            mid, w, h, rate, pref_scale, scales, mp = mode
            if mp.get('is-current'):
                modes[spec[0]] = (w, h)
    out = []
    for x, y, scale, transform, primary, specs, lprops in logical:
        for spec in specs:
            w, h = modes.get(spec[0], (0, 0))
            if transform in (1, 3, 5, 7):
                w, h = h, w
            out.append({'id': spec[0], 'name': spec[0], 'x': x, 'y': y, 'width': w, 'height': h,
                        'scale': scale, 'primary': bool(primary)})
    out.sort(key=lambda d: (not d['primary'], d['x'], d['y']))
    return out


# ------------------------------------------------------------------------- frames

def gst_frame(node, out, fd=None, max_width=0, fmt='png', quality=80, crop=None, src_size=None):
    """One frame of a PipeWire stream → PNG/JPEG file, via gst-launch-1.0."""
    src = ['pipewiresrc', 'path=%d' % node, 'num-buffers=1', 'always-copy=true']
    if fd is not None:
        src.insert(1, 'fd=%d' % fd)
    chain = src + ['!', 'videoconvert']
    if crop and src_size:
        x, y, w, h = crop
        sw, sh = src_size
        chain += ['!', 'videocrop', 'left=%d' % x, 'top=%d' % y,
                  'right=%d' % max(0, sw - x - w), 'bottom=%d' % max(0, sh - y - h)]
    if max_width:
        chain += ['!', 'videoscale', 'method=bilinear', '!', 'video/x-raw,width=%d,pixel-aspect-ratio=1/1' % max_width]
    if fmt == 'jpeg':
        chain += ['!', 'videoconvert', '!', 'jpegenc', 'quality=%d' % quality]
    else:
        chain += ['!', 'pngenc', 'compression-level=1']
    chain += ['!', 'filesink', 'location=%s' % out]
    try:
        r = subprocess.run(['gst-launch-1.0', '-q'] + chain, capture_output=True, timeout=8,
                           pass_fds=(fd,) if fd is not None else ())
    except subprocess.TimeoutExpired:
        raise Fail('timeout', 'no frame from the screen stream within 8 s')
    except FileNotFoundError:
        raise Fail('needs-permission', 'gst-launch-1.0 is not installed (gstreamer1.0-tools, gstreamer1.0-pipewire)')
    if r.returncode != 0 or not os.path.exists(out) or os.path.getsize(out) == 0:
        raise Fail('error', 'gst-launch failed: %s' % (r.stderr.decode(errors='replace').strip()[-400:] or r.returncode))


def image_size(path):
    with open(path, 'rb') as f:
        head = f.read(64 * 1024)
    if head[:8] == b'\x89PNG\r\n\x1a\n':
        return struct.unpack('>II', head[16:24])
    i = 2  # JPEG: walk to the SOF marker
    while i + 9 < len(head):
        if head[i] != 0xff:
            i += 1
            continue
        m = head[i + 1]
        if m in (0xc0, 0xc1, 0xc2):
            h, w = struct.unpack('>HH', head[i + 5:i + 9])
            return w, h
        i += 2 + struct.unpack('>H', head[i + 2:i + 4])[0]
    return 0, 0


# ------------------------------------------------------------------------- Mutter (GNOME)

RD = 'org.gnome.Mutter.RemoteDesktop'
SC = 'org.gnome.Mutter.ScreenCast'


class Mutter:
    """A linked Mutter RemoteDesktop + ScreenCast session with one stream per monitor. Mutter cannot add a
    stream to a running session, so asking for a new monitor restarts the session with all of them."""

    def __init__(self):
        self.rd = None
        self.sc = None
        self.streams = {}  # connector → {path, node, size}
        self.started = False
        self.subs = []

    def _closed(self, *a):
        if self.rd:
            self.rd = None
            self.started = False
            event('closed', backend='mutter')

    def stream(self, connector):
        if self.started and self.rd and connector in self.streams:
            return self.streams[connector]
        wanted = [c for c in self.streams if c != connector] + [connector]
        self.stop()
        self.rd = call(RD, '/org/gnome/Mutter/RemoteDesktop', RD, 'CreateSession', None, '(o)')[0]
        sid = get_prop(RD, self.rd, RD + '.Session', 'SessionId')
        self.sc = call(SC, '/org/gnome/Mutter/ScreenCast', SC, 'CreateSession',
                       GLib.Variant('(a{sv})', ({'remote-desktop-session-id': GLib.Variant('s', sid)},)), '(o)')[0]
        self.subs.append(bus().signal_subscribe(RD, RD + '.Session', 'Closed', self.rd, None,
                                                Gio.DBusSignalFlags.NONE, self._closed))
        for c in wanted:
            path = call(SC, self.sc, SC + '.Session', 'RecordMonitor',
                        GLib.Variant('(sa{sv})', (c, {'cursor-mode': GLib.Variant('u', 1)})), '(o)')[0]
            st = {'path': path, 'node': None, 'size': None}

            def added(conn, sender, obj, iface, sig, params, st=st):
                st['node'] = params.unpack()[0]
            self.subs.append(bus().signal_subscribe(SC, SC + '.Stream', 'PipeWireStreamAdded', path, None,
                                                    Gio.DBusSignalFlags.NONE, added))
            self.streams[c] = st
        call(RD, self.rd, RD + '.Session', 'Start', None, None)
        self.started = True
        for c, st in self.streams.items():
            if not wait_for(lambda st=st: st['node'] is not None, 5):
                raise Fail('timeout', 'Mutter did not announce a PipeWire stream for %s' % c)
            try:
                p = get_prop(SC, st['path'], SC + '.Stream', 'Parameters')
                st['size'] = tuple(p['size']) if 'size' in p else None
            except Fail:
                pass
        return self.streams[connector]

    def stop(self):
        for s in self.subs:
            try:
                bus().signal_unsubscribe(s)
            except Exception:  # noqa: BLE001
                pass
        self.subs = []
        if self.rd:
            try:
                call(RD, self.rd, RD + '.Session', 'Stop', None, None, timeout=3000)
            except Fail:
                pass
        self.rd = self.sc = None
        self.started = False

    def _rd(self, method, sig, args):
        if not self.rd or not self.started:
            self.stream(primary_connector())
        call(RD, self.rd, RD + '.Session', method, GLib.Variant(sig, args), None)

    def move(self, connector, x, y):
        st = self.stream(connector)
        self._rd('NotifyPointerMotionAbsolute', '(sdd)', (st['path'], float(x), float(y)))

    def button(self, name, down):
        self._rd('NotifyPointerButton', '(ib)', (BTN[name], bool(down)))

    def scroll(self, dx, dy):
        if dy:
            self._rd('NotifyPointerAxisDiscrete', '(ui)', (0, int(dy)))
        if dx:
            self._rd('NotifyPointerAxisDiscrete', '(ui)', (1, int(dx)))

    def keysym(self, sym, down):
        self._rd('NotifyKeyboardKeysym', '(ub)', (sym, bool(down)))


def primary_connector():
    ds = mutter_displays()
    if not ds:
        raise Fail('no-session', 'no monitors')
    return ds[0]['id']


# ------------------------------------------------------------------------- xdg-desktop-portal

PORTAL = 'org.freedesktop.portal.Desktop'
PPATH = '/org/freedesktop/portal/desktop'


class Portal:
    """xdg-desktop-portal RemoteDesktop (+ ScreenCast) session; persists a restore token so the dialog
    shows once per machine (persist_mode 2)."""

    def __init__(self, restore_token=None):
        self.token = restore_token
        self.session = None
        self.streams = []
        self.fd = None
        self.counter = 0

    def _request(self, iface, method, args_fn, timeout=120):
        self.counter += 1
        tok = 'rigs%d_%d' % (os.getpid(), self.counter)
        sender = bus().get_unique_name()[1:].replace('.', '_')
        req_path = '/org/freedesktop/portal/desktop/request/%s/%s' % (sender, tok)
        box = {}

        def resp(conn, snd, obj, i, sig, params):
            box['r'] = params.unpack()
        sub = bus().signal_subscribe(PORTAL, 'org.freedesktop.portal.Request', 'Response', req_path, None,
                                     Gio.DBusSignalFlags.NONE, resp)
        try:
            call(PORTAL, PPATH, iface, method, args_fn(tok), '(o)')
            if not wait_for(lambda: 'r' in box, timeout):
                raise Fail('timeout', 'no answer to the screen-sharing dialog on this machine')
        finally:
            bus().signal_unsubscribe(sub)
        code, results = box['r']
        if code == 1:
            raise Fail('needs-permission', 'screen sharing was declined at the machine')
        if code != 0:
            raise Fail('error', 'portal %s failed (%d)' % (method, code))
        return results

    def ensure(self):
        if self.session:
            return
        V = GLib.Variant
        res = self._request('org.freedesktop.portal.RemoteDesktop', 'CreateSession', lambda t: V('(a{sv})', ({
            'handle_token': V('s', t), 'session_handle_token': V('s', t + 's')},)))
        self.session = res['session_handle']
        opts = {'types': V('u', 3), 'persist_mode': V('u', 2)}
        if self.token:
            opts['restore_token'] = V('s', self.token)
        self._request('org.freedesktop.portal.RemoteDesktop', 'SelectDevices',
                      lambda t: V('(oa{sv})', (self.session, {**opts, 'handle_token': V('s', t)})))
        self._request('org.freedesktop.portal.ScreenCast', 'SelectSources', lambda t: V('(oa{sv})', (
            self.session, {'handle_token': V('s', t), 'types': V('u', 1), 'multiple': V('b', True),
                           'cursor_mode': V('u', 2)})))
        res = self._request('org.freedesktop.portal.RemoteDesktop', 'Start', lambda t: V('(osa{sv})', (
            self.session, '', {'handle_token': V('s', t)})), timeout=300)
        self.streams = [{'node': n, 'props': p} for n, p in res.get('streams', [])]
        if res.get('restore_token'):
            self.token = res['restore_token']
            event('restore-token', token=self.token)
        bus().signal_subscribe(PORTAL, 'org.freedesktop.portal.Session', 'Closed', self.session, None,
                               Gio.DBusSignalFlags.NONE, self._closed)
        (_, fds) = call(PORTAL, PPATH, 'org.freedesktop.portal.ScreenCast', 'OpenPipeWireRemote',
                        V('(oa{sv})', (self.session, {})), '(h)', fd_list=True)
        self.fd = fds.steal_fds()[0] if fds and fds.get_length() else None

    def _closed(self, *a):
        self.session = None
        event('closed', backend='portal')

    def stream(self, index):
        self.ensure()
        if not self.streams:
            raise Fail('error', 'the portal session has no screen')
        return self.streams[min(index, len(self.streams) - 1)]

    def stop(self):
        if self.session:
            try:
                call(PORTAL, self.session, 'org.freedesktop.portal.Session', 'Close', None, None, timeout=3000)
            except Fail:
                pass
        if self.fd is not None:
            try:
                os.close(self.fd)
            except OSError:
                pass
        self.session = None
        self.fd = None

    def _n(self, method, sig, args):
        self.ensure()
        call(PORTAL, PPATH, 'org.freedesktop.portal.RemoteDesktop', method, GLib.Variant(sig, (self.session, {}) + args), None)

    def move(self, index, x, y):
        self._n('NotifyPointerMotionAbsolute', '(oa{sv}udd)', (self.stream(index)['node'], float(x), float(y)))

    def button(self, name, down):
        self._n('NotifyPointerButton', '(oa{sv}iu)', (BTN[name], 1 if down else 0))

    def scroll(self, dx, dy):
        if dy:
            self._n('NotifyPointerAxisDiscrete', '(oa{sv}ui)', (0, int(dy)))
        if dx:
            self._n('NotifyPointerAxisDiscrete', '(oa{sv}ui)', (1, int(dx)))

    def keysym(self, sym, down):
        self._n('NotifyKeyboardKeysym', '(oa{sv}iu)', (sym, 1 if down else 0))


# ------------------------------------------------------------------------- uinput

UI_DEV_CREATE, UI_DEV_DESTROY = 0x5501, 0x5502
UI_SET_EVBIT, UI_SET_KEYBIT, UI_SET_RELBIT, UI_SET_ABSBIT = 0x40045564, 0x40045565, 0x40045566, 0x40045567
UI_DEV_SETUP, UI_ABS_SETUP = 0x405c5503, 0x401c5504
ABS_X, ABS_Y, REL_HWHEEL, REL_WHEEL = 0, 1, 6, 8


class UInput:
    """A virtual keyboard + absolute pointer (tablet style) written straight to /dev/uinput.
    Keys go through a US layout table: characters it cannot type are reported, not guessed."""

    def __init__(self, width, height):
        self.fd = None
        self.size = (max(1, width), max(1, height))

    def ensure(self):
        if self.fd is not None:
            return
        try:
            fd = os.open('/dev/uinput', os.O_WRONLY | os.O_NONBLOCK)
        except OSError as e:
            raise Fail('needs-permission', '/dev/uinput: %s' % e.strerror)
        for ev in (EV_KEY, EV_ABS, EV_REL):
            fcntl.ioctl(fd, UI_SET_EVBIT, ev)
        for code in list(range(1, 249)) + list(BTN.values()):
            fcntl.ioctl(fd, UI_SET_KEYBIT, code)
        for rel in (REL_WHEEL, REL_HWHEEL):
            fcntl.ioctl(fd, UI_SET_RELBIT, rel)
        for axis, size in ((ABS_X, self.size[0]), (ABS_Y, self.size[1])):
            fcntl.ioctl(fd, UI_SET_ABSBIT, axis)
            # struct uinput_abs_setup { __u16 code; struct input_absinfo { value, min, max, fuzz, flat, res } }
            fcntl.ioctl(fd, UI_ABS_SETUP, struct.pack('Hxxiiiiii', axis, 0, 0, size - 1, 0, 0, 0))
        # struct uinput_setup { struct input_id { bustype, vendor, product, version }; char name[80]; ff_effects_max }
        fcntl.ioctl(fd, UI_DEV_SETUP, struct.pack('HHHH80sI', 0x06, 0x1d6b, 0x0104, 1, b'RIGS Control', 0))
        fcntl.ioctl(fd, UI_DEV_CREATE)
        self.fd = fd
        time.sleep(0.3)  # let the compositor pick the new device up

    def _emit(self, typ, code, value):
        now = time.time()
        os.write(self.fd, struct.pack('llHHi', int(now), int((now % 1) * 1e6), typ, code, value))

    def _syn(self):
        self._emit(EV_SYN, 0, 0)

    def move(self, x, y):
        self.ensure()
        self._emit(EV_ABS, ABS_X, int(x))
        self._emit(EV_ABS, ABS_Y, int(y))
        self._syn()

    def button(self, name, down):
        self.ensure()
        self._emit(EV_KEY, BTN[name], 1 if down else 0)
        self._syn()

    def scroll(self, dx, dy):
        self.ensure()
        if dy:
            self._emit(EV_REL, REL_WHEEL, -int(dy))
        if dx:
            self._emit(EV_REL, REL_HWHEEL, int(dx))
        self._syn()

    def code(self, code, down):
        self.ensure()
        self._emit(EV_KEY, code, 1 if down else 0)
        self._syn()

    def stop(self):
        if self.fd is not None:
            try:
                fcntl.ioctl(self.fd, UI_DEV_DESTROY)
                os.close(self.fd)
            except OSError:
                pass
            self.fd = None


# ------------------------------------------------------------------------- windows

def atspi_windows():
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
    desk = Atspi.get_desktop(0)
    out = []
    for i in range(desk.get_child_count()):
        app = desk.get_child_at_index(i)
        if app is None:
            continue
        try:
            app_name = app.get_name() or ''
            pid = app.get_process_id()
        except Exception:  # noqa: BLE001
            continue
        if app_name in ('gnome-shell', 'mutter-x11-frames'):
            continue
        for j in range(min(app.get_child_count(), 50)):
            w = app.get_child_at_index(j)
            if w is None:
                continue
            try:
                if w.get_role_name() not in ('frame', 'window', 'dialog'):
                    continue
                st = w.get_state_set()
                ext = w.get_extents(Atspi.CoordType.SCREEN)
                out.append({'id': 'atspi:%d:%d' % (pid, j), 'title': w.get_name() or '', 'app': app_name, 'pid': pid,
                            'display': None, 'bounds': {'x': ext.x, 'y': ext.y, 'width': ext.width, 'height': ext.height},
                            'focused': st.contains(Atspi.StateType.ACTIVE), 'minimized': st.contains(Atspi.StateType.ICONIFIED)})
            except Exception:  # noqa: BLE001
                continue
    return out


EXT = 'dev.rigs.Control'


def ext_windows():
    return json.loads(call(EXT, '/dev/rigs/Control', EXT, 'ListWindows', None, '(s)')[0])


def ext_focus(wid):
    return call(EXT, '/dev/rigs/Control', EXT, 'FocusWindow', GLib.Variant('(s)', (str(wid),)), '(b)')[0]


# ------------------------------------------------------------------------- lock state

def locked():
    for dest, path, iface in (('org.gnome.ScreenSaver', '/org/gnome/ScreenSaver', 'org.gnome.ScreenSaver'),
                              ('org.freedesktop.ScreenSaver', '/org/freedesktop/ScreenSaver', 'org.freedesktop.ScreenSaver')):
        try:
            return bool(call(dest, path, iface, 'GetActive', None, '(b)', timeout=3000)[0])
        except Fail:
            continue
    return None


# ------------------------------------------------------------------------- the helper

class Helper:
    def __init__(self):
        self.capture = self.input = self.windows = None
        self.mutter = Mutter() if Gio else None
        self.portal = None
        self.uinput = None
        self.held_keys = []  # ('sym' | 'code', value), released in reverse order
        self.held_buttons = set()
        self.restore_token = None

    def op_hello(self, a):
        return {'pid': os.getpid(), 'python': sys.version.split()[0], 'gi': Gio is not None}

    def op_configure(self, a):
        self.capture, self.input, self.windows = a.get('capture'), a.get('input'), a.get('windows')
        self.restore_token = a.get('restoreToken') or self.restore_token
        return {'capture': self.capture, 'input': self.input, 'windows': self.windows}

    def op_probe(self, a):
        """Facts for selectBackend: which D-Bus APIs this session offers."""
        out = {'gi': Gio is not None, 'mutterScreenCast': 0, 'mutterRemoteDesktop': 0, 'portalScreenCast': 0,
               'portalRemoteDesktop': 0, 'portalScreenshot': 0, 'rigsExtension': False, 'atspi': False}
        if Gio is None:
            return out
        for key, dest, path, iface, prop in (
                ('mutterScreenCast', SC, '/org/gnome/Mutter/ScreenCast', SC, 'Version'),
                ('mutterRemoteDesktop', RD, '/org/gnome/Mutter/RemoteDesktop', RD, 'Version'),
                ('portalScreenCast', PORTAL, PPATH, 'org.freedesktop.portal.ScreenCast', 'version'),
                ('portalRemoteDesktop', PORTAL, PPATH, 'org.freedesktop.portal.RemoteDesktop', 'version'),
                ('portalScreenshot', PORTAL, PPATH, 'org.freedesktop.portal.Screenshot', 'version')):
            if has_name(dest):
                try:
                    out[key] = int(get_prop(dest, path, iface, prop, timeout=3000))
                except Fail as e:
                    out[key] = -1 if e.code == 'timeout' else 0  # -1: there, but not answering
        out['rigsExtension'] = has_name(EXT)
        out['atspi'] = has_name('org.a11y.Bus')
        return out

    def op_displays(self, a):
        if self.capture == 'portal' and self.portal and self.portal.streams:
            out = []
            for i, s in enumerate(self.portal.streams):
                pos, size = s['props'].get('position', (0, 0)), s['props'].get('size', (0, 0))
                out.append({'id': str(i), 'name': 'screen %d' % i, 'x': pos[0], 'y': pos[1], 'width': size[0],
                            'height': size[1], 'scale': 1, 'primary': i == 0})
            return out
        return mutter_displays()

    def _portal(self):
        if not self.portal:
            self.portal = Portal(self.restore_token)
        return self.portal

    def _display(self, a):
        ds = self.op_displays({})
        want = a.get('display')
        if want in (None, ''):
            for i, d in enumerate(ds):
                if d['primary']:
                    return i, d
            if ds:
                return 0, ds[0]
        for i, d in enumerate(ds):
            if str(want) in (str(d['id']), str(i)):
                return i, d
        raise Fail('bad-args', 'no display %s (have %s)' % (want, ', '.join(str(d['id']) for d in ds) or 'none'))

    def op_shot(self, a):
        out = a['file']
        r = a.get('region')
        crop = (r['x'], r['y'], r['width'], r['height']) if r else None
        fmt = a.get('format') or 'png'
        if self.capture == 'mutter':
            i, d = self._display(a)
            st = self.mutter.stream(d['id'])
            size = st['size'] or (d['width'], d['height'])
            gst_frame(st['node'], out, max_width=a.get('maxWidth') or 0, fmt=fmt, quality=a.get('quality', 80),
                      crop=crop, src_size=size)
        elif self.capture == 'portal':
            p = self._portal()
            p.ensure()
            i, d = self._display(a)
            s = p.stream(i)
            size = tuple(s['props'].get('size', (d['width'], d['height'])))
            gst_frame(s['node'], out, fd=p.fd, max_width=a.get('maxWidth') or 0, fmt=fmt,
                      quality=a.get('quality', 80), crop=crop, src_size=size)
        else:
            raise Fail('unsupported', 'capture backend %s is not handled by the helper' % self.capture)
        w, h = image_size(out)
        return {'file': out, 'width': w, 'height': h, 'display': d['id'], 'sourceWidth': size[0], 'sourceHeight': size[1]}

    def _uinput(self):
        if not self.uinput:
            try:
                ds = mutter_displays()
                w, h = max(d['x'] + d['width'] for d in ds), max(d['y'] + d['height'] for d in ds)
            except Exception:  # noqa: BLE001
                w, h = 3840, 2160
            self.uinput = UInput(w, h)
        return self.uinput

    def _dev(self):
        if self.input == 'mutter':
            return self.mutter
        if self.input == 'portal':
            return self._portal()
        if self.input == 'uinput':
            return self._uinput()
        raise Fail('unsupported', 'input backend %s is not handled by the helper' % self.input)

    def op_move(self, a):
        x, y = a['x'], a['y']
        i, d = self._display(a)
        dev = self._dev()
        if self.input == 'mutter':
            dev.move(d['id'], x, y)
        elif self.input == 'portal':
            dev.move(i, x, y)
        else:
            dev.move(d['x'] + x, d['y'] + y)
        return {'x': x, 'y': y, 'display': d['id']}

    def op_button(self, a):
        name, down = a.get('button', 'left'), bool(a['down'])
        if name not in BTN:
            raise Fail('bad-args', 'unknown button %s' % name)
        self._dev().button(name, down)
        (self.held_buttons.add if down else self.held_buttons.discard)(name)
        return {}

    def op_scroll(self, a):
        self._dev().scroll(a.get('dx', 0), a.get('dy', 0))
        return {}

    def _press(self, name, down):
        if self.input == 'uinput':
            if name in EVDEV:
                code = EVDEV[name]
            elif len(name) == 1 and name.lower() in US:
                code = US[name.lower()][0]
            else:
                raise Fail('unsupported', 'uinput cannot press %r on a US layout' % name)
            self._uinput().code(code, down)
            entry = ('code', code)
        else:
            sym = keysym_for(name)
            self._dev().keysym(sym, down)
            entry = ('sym', sym)
        if down:
            self.held_keys.append(entry)
        elif entry in self.held_keys:
            self.held_keys.remove(entry)

    def op_key(self, a):
        self._press(a['key'], bool(a['down']))
        return {}

    def op_type(self, a):
        text, delay = a['text'], max(0, a.get('delayMs', 0)) / 1000.0
        if self.input == 'uinput':
            bad = sorted({c for c in text if c not in US})
            if bad:
                raise Fail('unsupported', 'uinput types a US layout only; cannot type %s' % ''.join(bad)[:20])
            ui = self._uinput()
            for c in text:
                code, shift = US[c]
                if shift:
                    ui.code(EVDEV['shift'], True)
                ui.code(code, True)
                ui.code(code, False)
                if shift:
                    ui.code(EVDEV['shift'], False)
                time.sleep(delay or 0.004)
            return {'typed': len(text), 'via': 'keycode'}
        dev = self._dev()
        for c in text:
            sym = keysym_for_char(c)
            dev.keysym(sym, True)
            dev.keysym(sym, False)
            time.sleep(delay or 0.004)
        return {'typed': len(text), 'via': 'keysym'}

    def op_release(self, a):
        released = 0
        for name in list(self.held_buttons):
            try:
                self._dev().button(name, False)
            except Exception:  # noqa: BLE001
                pass
            released += 1
        self.held_buttons.clear()
        for kind, v in reversed(self.held_keys):
            try:
                if kind == 'code':
                    self._uinput().code(v, False)
                else:
                    self._dev().keysym(v, False)
            except Exception:  # noqa: BLE001
                pass
            released += 1
        self.held_keys = []
        return {'released': released}

    def op_windows(self, a):
        if self.windows == 'rigs-extension':
            return ext_windows()
        if self.windows == 'atspi':
            return atspi_windows()
        raise Fail('unsupported', 'window backend %s is not handled by the helper' % self.windows)

    def op_focus(self, a):
        if self.windows != 'rigs-extension':
            raise Fail('unsupported', 'focusing windows on GNOME needs the RIGS Shell extension (rigs-control@rigs.dev)')
        if not ext_focus(a['id']):
            raise Fail('bad-args', 'no window %s' % a['id'])
        return {}

    def op_locked(self, a):
        return {'locked': locked() if Gio else None}

    def op_stop(self, a):
        self.op_release({})
        for x in (self.mutter, self.portal, self.uinput):
            if x:
                x.stop()
        return {}


def main():
    h = Helper()
    lines = []
    cond = threading.Condition()

    def reader():  # stdin on a thread, so D-Bus signals (session closed) are dispatched while idle
        for line in sys.stdin:
            with cond:
                lines.append(line)
                cond.notify()
        with cond:
            lines.append(None)
            cond.notify()
    threading.Thread(target=reader, daemon=True).start()
    while True:
        with cond:
            if not lines:
                cond.wait(0.05)
            line = lines.pop(0) if lines else ''
        if GLib:
            pump()
        if line is None:
            break
        if not line.strip():
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        rid = req.get('id')
        fn = getattr(h, 'op_' + str(req.get('op')), None)
        try:
            if fn is None:
                raise Fail('bad-args', 'unknown op %s' % req.get('op'))
            send({'id': rid, 'ok': True, 'result': fn(req)})
        except Fail as e:
            send({'id': rid, 'ok': False, 'error': {'code': e.code, 'message': str(e)}})
        except Exception as e:  # noqa: BLE001
            send({'id': rid, 'ok': False, 'error': {'code': 'error', 'message': '%s: %s' % (type(e).__name__, e)}})
    try:
        h.op_stop({})
    except Exception:  # noqa: BLE001
        pass


if __name__ == '__main__':
    main()
