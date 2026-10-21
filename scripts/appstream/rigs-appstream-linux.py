#!/usr/bin/env python3
"""RIGS app-stream runner (Linux): one isolated app session (docs/app-streaming.md §3.1).

Started by src/app-stream.js in a transient `systemd --user` unit, so it outlives daemon restarts:
  private D-Bus bus → headless compositor (mutter, or gnome-shell --mode=rigs-app) → ScreenCast RecordVirtual +
  RemoteDesktop on that bus → the app (WAYLAND_DISPLAY/DISPLAY of the session only) → GStreamer pipeline
  (pipewiresrc → NVENC/VA-API/x264 → appsink) → Unix socket to the daemon.

Nothing here touches the person's desktop: not their session bus, compositor, clipboard, audio output or /dev/uinput.
Input goes through Mutter RemoteDesktop on the private bus only.

Socket protocol (the runner listens, the daemon connects and may reconnect): u32 LE body length + u8 type + body;
type 1 = JSON (ops from the daemon, events from the runner), type 2 = a media frame (32-byte header + access unit).

Usage: python3 rigs-appstream-linux.py --session as-xxxxxxxx --socket <path> --state <session.json> --log <file>
"""
import argparse
import collections
import json
import os
import re
import shutil
import signal
import socket
import struct
import subprocess
import sys
import threading
import time

import gi
gi.require_version('Gst', '1.0')
from gi.repository import Gio, GLib, Gst  # noqa: E402

RD, SC = 'org.gnome.Mutter.RemoteDesktop', 'org.gnome.Mutter.ScreenCast'
TEXT = 'text/plain;charset=utf-8'
HEADER = struct.Struct('<BBHIQIIHHI')
FLAG_KEY, FLAG_CONFIG, FLAG_DISCONT = 1, 2, 4
BUTTONS = [0x110, 0x112, 0x111, 0x113, 0x114]  # left middle right back forward
KEY_CTRL, KEY_V, KEYSYM_SHIFT = 29, 47, 0xffe1
STRIP_ENV = ('DISPLAY', 'WAYLAND_DISPLAY', 'XDG_SESSION_ID', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_CURRENT_DESKTOP',
             'XDG_SESSION_TYPE', 'XAUTHORITY', 'GNOME_SETUP_DISPLAY', 'XDG_SESSION_DESKTOP', 'DESKTOP_SESSION')

ap = argparse.ArgumentParser()
ap.add_argument('--session', required=True)
ap.add_argument('--socket', required=True)
ap.add_argument('--state', required=True)
ap.add_argument('--log', default='')
ARGS = ap.parse_args()
SID = ARGS.session
if not re.match(r'^as-[0-9a-f]{8}$', SID):
    sys.exit('bad session id')
with open(ARGS.state) as fh:
    SPEC = json.load(fh)

LOGF = open(ARGS.log, 'a', buffering=1) if ARGS.log else sys.stderr
T0 = time.monotonic()


def log(*a):
    try:
        LOGF.write('[%7.2f runner] %s\n' % (time.monotonic() - T0, ' '.join(str(x) for x in a)))
    except Exception:  # noqa: BLE001
        pass


def mono_us():
    return int(time.monotonic() * 1_000_000)


Gst.init(None)
LOOP = GLib.MainLoop()
CTX = GLib.MainContext.default()
RT = os.environ.get('XDG_RUNTIME_DIR') or '/run/user/%d' % os.getuid()
PDIR = os.path.join(RT, 'rigs-as-' + SID)
os.makedirs(PDIR, mode=0o700, exist_ok=True)
BASE_ENV = {k: v for k, v in os.environ.items() if k not in STRIP_ENV}
procs = {}       # name → Popen
st = {'bus': None, 'rd': None, 'sc': None, 'stream': None, 'node': None, 'display': None, 'xauth': None,
      'wayland': None, 'sink_id': None, 'stopping': False, 'app_pgid': None, 'app_exited': False}


def pump(sec):
    end = time.monotonic() + sec
    while time.monotonic() < end:
        while CTX.pending():
            CTX.iteration(False)
        time.sleep(0.003)


def wait_for(pred, sec):
    end = time.monotonic() + sec
    while time.monotonic() < end:
        while CTX.pending():
            CTX.iteration(False)
        if pred():
            return True
        time.sleep(0.01)
    return False


# ------------------------------------------------------------------ daemon socket

class Link:
    """The listening Unix socket and the one connected daemon. Frames are written from GStreamer's thread."""

    def __init__(self, path):
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        self.srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        old = os.umask(0o177)
        try:
            self.srv.bind(path)
        finally:
            os.umask(old)
        os.chmod(path, 0o600)
        self.srv.listen(2)
        self.path = path
        self.client = None
        self.buf = b''
        self.lock = threading.Lock()
        GLib.io_add_watch(self.srv.fileno(), GLib.IO_IN, self._accept)
        self.on_connect = lambda: None
        self.on_op = lambda op: None

    def _accept(self, *a):
        c, _ = self.srv.accept()
        with self.lock:
            if self.client:
                try:
                    self.client.close()
                except OSError:
                    pass
            c.settimeout(2.0)
            self.client = c
            self.buf = b''
        GLib.io_add_watch(c.fileno(), GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, self._read, c)
        log('daemon connected')
        self.on_connect()
        return True

    def _read(self, fd, cond, c):
        if c is not self.client:
            return False
        try:
            data = c.recv(1 << 20) if cond & GLib.IO_IN else b''
        except (socket.timeout, BlockingIOError):
            return True
        except OSError:
            data = b''
        if not data:
            log('daemon disconnected')
            with self.lock:
                if self.client is c:
                    self.client = None
            try:
                c.close()
            except OSError:
                pass
            on_daemon_gone()
            return False
        self.buf += data
        while len(self.buf) >= 5:
            n, t = struct.unpack_from('<IB', self.buf)
            if len(self.buf) < 5 + n:
                break
            body, self.buf = self.buf[5:5 + n], self.buf[5 + n:]
            if t == 1:
                try:
                    self.on_op(json.loads(body))
                except Exception as e:  # noqa: BLE001
                    log('op failed:', repr(e)[:400])
        return True

    def send(self, typ, body):
        with self.lock:
            c = self.client
            if not c:
                return False
            try:
                c.sendall(struct.pack('<IB', len(body), typ) + body)
                return True
            except OSError as e:
                log('send failed:', e)
                try:
                    c.close()
                except OSError:
                    pass
                self.client = None
                return False

    def event(self, ev, **k):
        self.send(1, json.dumps(dict(ev=ev, **k)).encode())

    def close(self):
        with self.lock:
            if self.client:
                try:
                    self.client.close()
                except OSError:
                    pass
                self.client = None
        try:
            self.srv.close()
            os.unlink(self.path)
        except OSError:
            pass


LINK = Link(ARGS.socket)


# ------------------------------------------------------------------ D-Bus on the private bus

def call(dest, path, iface, method, args=None, sig=None, timeout=8000):
    r = st['bus'].call_sync(dest, path, iface, method, args, GLib.VariantType(sig) if sig else None,
                            Gio.DBusCallFlags.NONE, timeout, None)
    return r.unpack() if r else None


def call_fd(dest, path, iface, method, args, sig):
    r, fds = st['bus'].call_with_unix_fd_list_sync(dest, path, iface, method, args, GLib.VariantType(sig),
                                                   Gio.DBusCallFlags.NONE, 8000, None, None)
    return r.unpack(), fds.steal_fds()


def prop(dest, path, iface, name):
    return call(dest, path, 'org.freedesktop.DBus.Properties', 'Get', GLib.Variant('(ss)', (iface, name)), '(v)')[0]


def has_name(n):
    try:
        return call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameHasOwner',
                    GLib.Variant('(s)', (n,)), '(b)')[0]
    except GLib.Error:
        return False


def rdc(method, sig=None, args=None):
    """Fire-and-forget RemoteDesktop call: ordered on the connection, never blocks the loop."""
    if not st['rd']:
        return
    st['bus'].call(RD, st['rd'], RD + '.Session', method, GLib.Variant(sig, args) if sig else None, None,
                   Gio.DBusCallFlags.NONE, 5000, None, None, None)


def start_bus():
    p = subprocess.Popen(['dbus-daemon', '--session', '--nofork', '--print-address=1',
                          '--address=unix:path=' + os.path.join(PDIR, 'bus')],
                         stdout=subprocess.PIPE, stderr=LOGF, env=BASE_ENV, start_new_session=True)
    procs['dbus'] = p
    addr = p.stdout.readline().decode().strip()
    if not addr:
        raise RuntimeError('dbus-daemon did not start')
    st['bus_addr'] = addr
    st['bus'] = Gio.DBusConnection.new_for_address_sync(
        addr, Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
    log('private bus', addr)


def free_wayland_name():
    for n in range(50, 200):
        if not os.path.exists(os.path.join(RT, 'wayland-%d' % n)) and not os.path.exists(os.path.join(RT, 'wayland-%d.lock' % n)):
            return 'wayland-%d' % n
    raise RuntimeError('no free wayland socket name')


def start_compositor():
    disp = free_wayland_name()
    env = dict(BASE_ENV, DBUS_SESSION_BUS_ADDRESS=st['bus_addr'])
    comp = SPEC.get('compositor') or 'gnome-shell'
    if comp == 'mutter':
        args = ['mutter', '--headless', '--wayland', '--wayland-display', disp]
    else:
        # The rigs-app session mode: no panel, no screen shield, no GDM-style user session (docs §3.2).
        share = os.path.join(SPEC.get('home') or os.path.expanduser('~/.rigs'), 'appstream', 'share')
        modes = os.path.join(share, 'gnome-shell', 'modes')
        os.makedirs(modes, exist_ok=True)
        shutil.copyfile(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'gnome-shell', 'rigs-app.json'),
                        os.path.join(modes, 'rigs-app.json'))
        env['XDG_DATA_DIRS'] = share + ':' + BASE_ENV.get('XDG_DATA_DIRS', '/usr/local/share:/usr/share')
        args = ['gnome-shell', '--headless', '--wayland', '--wayland-display', disp, '--mode=rigs-app']
    started = time.time()
    p = subprocess.Popen(args, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    procs['compositor'] = p
    st['wayland'] = disp

    def reader():
        for raw in iter(p.stdout.readline, b''):
            line = raw.decode('utf-8', 'replace').rstrip()
            LOGF.write('[compositor] %s\n' % line)
            m = re.search(r'Using public X11 display (:\d+)', line)
            if m:
                st['display'] = m.group(1)
    threading.Thread(target=reader, daemon=True).start()
    if not wait_for(lambda: p.poll() is not None or (has_name(SC) and has_name(RD)), 40) or p.poll() is not None:
        raise RuntimeError('%s did not come up (exit %s)' % (comp, p.poll()))
    wait_for(lambda: st['display'] is not None, 3)
    if st['display']:
        auths = [os.path.join(RT, f) for f in os.listdir(RT) if f.startswith('.mutter-Xwaylandauth.')]
        auths = [a for a in auths if os.path.getmtime(a) >= started - 1]
        st['xauth'] = max(auths, key=os.path.getmtime) if auths else None
    log('compositor', comp, 'up:', disp, 'X11', st['display'], st['xauth'])
    return comp


def start_session():
    st['rd'] = call(RD, '/org/gnome/Mutter/RemoteDesktop', RD, 'CreateSession', None, '(o)')[0]
    rsid = prop(RD, st['rd'], RD + '.Session', 'SessionId')
    st['sc'] = call(SC, '/org/gnome/Mutter/ScreenCast', SC, 'CreateSession',
                    GLib.Variant('(a{sv})', ({'remote-desktop-session-id': GLib.Variant('s', rsid)},)), '(o)')[0]
    st['stream'] = call(SC, st['sc'], SC + '.Session', 'RecordVirtual',
                        GLib.Variant('(a{sv})', ({'cursor-mode': GLib.Variant('u', 1), 'is-platform': GLib.Variant('b', True)},)), '(o)')[0]
    b = st['bus']
    b.signal_subscribe(SC, SC + '.Stream', 'PipeWireStreamAdded', st['stream'], None, Gio.DBusSignalFlags.NONE,
                       lambda *a: st.__setitem__('node', a[5].unpack()[0]))
    b.signal_subscribe(RD, RD + '.Session', 'Closed', st['rd'], None, Gio.DBusSignalFlags.NONE, lambda *a: fatal('compositor-closed', 'The remote desktop session closed'))
    b.signal_subscribe(RD, RD + '.Session', 'SelectionOwnerChanged', st['rd'], None, Gio.DBusSignalFlags.NONE, on_owner_changed)
    b.signal_subscribe(RD, RD + '.Session', 'SelectionTransfer', st['rd'], None, Gio.DBusSignalFlags.NONE, on_transfer)
    call(RD, st['rd'], RD + '.Session', 'Start', None, None)
    if not wait_for(lambda: st['node'] is not None, 8):
        raise RuntimeError('no PipeWire stream from RecordVirtual')
    try:
        call(RD, st['rd'], RD + '.Session', 'EnableClipboard', GLib.Variant('(a{sv})', ({},)), None)
        st['clipboard'] = True
    except GLib.Error as e:
        log('clipboard unavailable:', e.message)
    log('screencast node', st['node'])


def start_null_sink():
    """The app's sound goes to a per-session null sink, never to the host's speakers (docs §5.8)."""
    if not shutil.which('pw-cli'):
        return
    try:
        r = subprocess.run(['pw-cli', 'create-node', 'adapter',
                            '{ factory.name=support.null-audio-sink node.name=rigs-as-%s node.description="RIGS app stream %s" '
                            'media.class=Audio/Sink audio.position=[FL FR] object.linger=true }' % (SID, SID)],
                           capture_output=True, text=True, timeout=10, env=BASE_ENV)
        st['sink_id'] = sink_ids() or None
        log('null sink', st['sink_id'], (r.stdout + r.stderr).strip()[:200])
    except Exception as e:  # noqa: BLE001
        log('null sink failed:', e)


def sink_ids():
    """PipeWire object ids of this session's null sink (pw-cli prints no id, so look it up by node.name)."""
    try:
        objs = json.loads(subprocess.run(['pw-dump'], capture_output=True, text=True, timeout=10, env=BASE_ENV).stdout or '[]')
    except Exception:  # noqa: BLE001
        return []
    return [str(o['id']) for o in objs if ((o.get('info') or {}).get('props') or {}).get('node.name') == 'rigs-as-' + SID]


def app_env():
    env = dict(BASE_ENV, WAYLAND_DISPLAY=st['wayland'], DBUS_SESSION_BUS_ADDRESS=st['bus_addr'], XDG_SESSION_TYPE='wayland',
               XDG_CURRENT_DESKTOP='GNOME', GDK_BACKEND='wayland,x11', QT_QPA_PLATFORM='wayland;xcb',
               SDL_VIDEODRIVER='wayland,x11', ELECTRON_OZONE_PLATFORM_HINT='auto',
               PULSE_SINK='rigs-as-' + SID, PIPEWIRE_NODE='rigs-as-' + SID)
    if st['display']:
        env['DISPLAY'] = st['display']
        if st['xauth']:
            env['XAUTHORITY'] = st['xauth']
    return env


def launch_app():
    L = SPEC['launch']
    files = L.get('files') or []
    if L['kind'] == 'desktop' and (L.get('dbus') or files or not L.get('argv')):
        argv = ['gio', 'launch', L['file']] + files
    else:
        argv = L['argv']
    p = subprocess.Popen(argv, env=app_env(), cwd=os.path.expanduser('~'), stdout=LOGF, stderr=LOGF, start_new_session=True)
    procs['app'] = p
    st['app_pgid'] = p.pid
    st['gio'] = argv[0] == 'gio'
    log('app started', p.pid, argv)
    GLib.timeout_add(1000, watch_app)


def group_alive(pgid):
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def watch_app():
    """The app has exited when its first process and every process of its group are gone (launchers that exec or fork)."""
    p = procs.get('app')
    if not p or st['stopping']:
        return False
    code = p.poll()
    if code is None or (st['gio'] and code == 0):
        # `gio launch` returns at once; the app it started is no longer ours to track.
        return code is None or not st['gio']
    if group_alive(st['app_pgid']):
        return True
    st['app_exited'] = True
    log('app exited', code)
    sig = -code if code < 0 else None
    LINK.event('app-exit', code=code if code >= 0 else None, signal=sig)
    GLib.timeout_add(1500, lambda: shutdown(force=True) and False)
    return False


# ------------------------------------------------------------------ clipboard (the session's own, never the person's)

clip = {'text': None, 'pending_restore': None}


def on_owner_changed(*a):
    opts = a[5].unpack()[0]
    if opts.get('session-is-owner') or not st.get('clipboard'):
        return
    mimes = opts.get('mime-types') or []
    mime = TEXT if TEXT in mimes else 'text/plain' if 'text/plain' in mimes else None
    if not mime:
        return

    def read():
        try:
            (_,), fds = call_fd(RD, st['rd'], RD + '.Session', 'SelectionRead', GLib.Variant('(s)', (mime,)), '(h)')
            chunks, total = [], 0
            with os.fdopen(fds[0], 'rb') as fh:
                while total < (1 << 20):
                    b = fh.read(65536)
                    if not b:
                        break
                    chunks.append(b)
                    total += len(b)
            text = b''.join(chunks).decode('utf-8', 'replace')
            GLib.idle_add(lambda: LINK.event('clipboard', text=text) and False)
        except Exception as e:  # noqa: BLE001
            log('clipboard read failed:', repr(e)[:200])
    threading.Thread(target=read, daemon=True).start()


def on_transfer(*a):
    mime, serial = a[5].unpack()
    try:
        (_,), fds = call_fd(RD, st['rd'], RD + '.Session', 'SelectionWrite', GLib.Variant('(u)', (serial,)), '(h)')
        with os.fdopen(fds[0], 'wb') as fh:
            fh.write((clip['text'] or '').encode('utf-8'))
        call(RD, st['rd'], RD + '.Session', 'SelectionWriteDone', GLib.Variant('(ub)', (serial, True)), None)
    except Exception as e:  # noqa: BLE001
        log('clipboard write failed:', repr(e)[:200])
        try:
            call(RD, st['rd'], RD + '.Session', 'SelectionWriteDone', GLib.Variant('(ub)', (serial, False)), None)
        except Exception:  # noqa: BLE001
            pass


def set_clipboard(text):
    if not st.get('clipboard'):
        return False
    clip['text'] = text
    rdc('SetSelection', '(a{sv})', ({'mime-types': GLib.Variant('as', [TEXT, 'text/plain'])},))
    return True


# ------------------------------------------------------------------ input (RemoteDesktop on the private bus)

held = {'keys': set(), 'buttons': set()}
inp = {'seq': 0, 'axis_timer': 0}


def keycode(code, down):
    rdc('NotifyKeyboardKeycode', '(ub)', (code, bool(down)))
    (held['keys'].add if down else held['keys'].discard)(code)


def keysym_tap(sym):
    rdc('NotifyKeyboardKeysym', '(ub)', (sym, True))
    rdc('NotifyKeyboardKeysym', '(ub)', (sym, False))


def release_all():
    for c in list(held['keys']):
        rdc('NotifyKeyboardKeycode', '(ub)', (c, False))
    for b in list(held['buttons']):
        rdc('NotifyPointerButton', '(ib)', (b, False))
    held['keys'].clear()
    held['buttons'].clear()


def axis_finish():
    inp['axis_timer'] = 0
    rdc('NotifyPointerAxis', '(ddu)', (0.0, 0.0, 1))
    return False


def type_text(s):
    """ASCII through keysyms; anything else (ő, emoji, …) through the session clipboard + Ctrl+V (docs §5.4)."""
    for i, ch in enumerate(s):
        o = ord(ch)
        if ch == '\n':
            keysym_tap(0xff0d)
        elif ch == '\t':
            keysym_tap(0xff09)
        elif 0x20 <= o < 0x7f:
            keysym_tap(o)
        else:
            rest = s[i:]
            prev = clip['text']
            if set_clipboard(rest):
                def paste():
                    keycode(KEY_CTRL, 1)
                    keycode(KEY_V, 1)
                    keycode(KEY_V, 0)
                    keycode(KEY_CTRL, 0)
                    if prev is not None:
                        GLib.timeout_add(1000, lambda: set_clipboard(prev) and False)
                    return False
                GLib.timeout_add(60, paste)
            return


def apply_input(seq, events):
    for e in events:
        k = e.get('k')
        if k == 'pm':
            rdc('NotifyPointerMotionAbsolute', '(sdd)', (st['stream'], float(e['x']), float(e['y'])))
        elif k == 'pb':
            code = BUTTONS[e['b']]
            rdc('NotifyPointerButton', '(ib)', (code, bool(e['d'])))
            (held['buttons'].add if e['d'] else held['buttons'].discard)(code)
        elif k == 'pw':
            if e.get('mode') == 'line':
                if e['dy']:
                    rdc('NotifyPointerAxisDiscrete', '(ui)', (0, int(round(e['dy'])) or (1 if e['dy'] > 0 else -1)))
                if e['dx']:
                    rdc('NotifyPointerAxisDiscrete', '(ui)', (1, int(round(e['dx'])) or (1 if e['dx'] > 0 else -1)))
            else:
                rdc('NotifyPointerAxis', '(ddu)', (float(e['dx']), float(e['dy']), 0))
                if inp['axis_timer']:
                    GLib.source_remove(inp['axis_timer'])
                inp['axis_timer'] = GLib.timeout_add(150, axis_finish)
        elif k == 'kc':
            keycode(int(e['code']), e['d'])
        elif k == 'tx':
            type_text(e['s'])
        elif k == 'tc':
            slot, x, y = int(e['id']), float(e['x']), float(e['y'])
            if e['ph'] == 'down':
                rdc('NotifyTouchDown', '(sudd)', (st['stream'], slot, x, y))
            elif e['ph'] == 'move':
                rdc('NotifyTouchMotion', '(sudd)', (st['stream'], slot, x, y))
            else:
                rdc('NotifyTouchUp', '(u)', (slot,))
        elif k == 'ra':
            release_all()
    inp['seq'] = seq & 0xffffffff


# ------------------------------------------------------------------ capture → encode

class Stream:
    """One GStreamer pipeline on the session's PipeWire node. Rebuilt (not renegotiated) on resize (spike 7)."""

    def __init__(self):
        self.pipe = None
        self.enc = None
        self.encoder = None
        self.idle = None
        self.cfg = None
        self.seq = 0
        self.skip = False
        self.discont = True
        self.cap = collections.OrderedDict()   # pts at pipewiresrc → capture time
        self.fifo = collections.deque()         # capture times of frames that entered the encoder, in order
        self.lock = threading.Lock()
        self.win = {'frames': 0, 'bytes': 0, 'enc': [], 'skipped': 0, 'since': time.monotonic()}

    # -- idle consumer: keeps the virtual monitor at its size while nobody watches (no encoder, no NVENC session)
    def idle_on(self, w, h):
        self.idle_off()
        p = Gst.parse_launch('pipewiresrc path=%d do-timestamp=true ! video/x-raw,width=%d,height=%d ! fakesink sync=false' % (st['node'], w, h))
        p.set_state(Gst.State.PLAYING)
        self.idle = p

    def idle_off(self):
        if self.idle:
            self.idle.set_state(Gst.State.NULL)
            self.idle = None

    def stop(self):
        if self.pipe:
            self.pipe.set_state(Gst.State.NULL)
            self.pipe = None
            self.enc = None

    def start(self, cfg):
        """Try each candidate pipeline in order; the first that reaches a frame (or 3 s without error) wins."""
        self.stop()
        self.idle_off()
        self.cfg = cfg
        failures = []
        for i, cand in enumerate(cfg['candidates']):
            desc = cand['desc'].replace('%NODE%', str(st['node']))
            err = self._try(desc, cfg)
            if err is None:
                self.encoder = cand['encoder']
                # Put the working encoder first, so a resize rebuilds with it directly.
                cfg['candidates'] = [cand] + [c for c in cfg['candidates'] if c is not cand]
                LINK.event('stream', encoder=cand['encoder'], width=cfg['width'], height=cfg['height'], fps=cfg['fps'],
                           fallback=i > 0, fallbackReason='; '.join(failures)[:300] if i else None)
                log('stream', cand['encoder'], cfg['width'], cfg['height'], 'after', len(failures), 'failure(s)')
                return True
            failures.append('%s/%s: %s' % (cand['encoder']['name'], cand['encoder']['path'], err[:160]))
            log('candidate failed:', failures[-1])
        LINK.event('error', code='stream-failed', message='; '.join(failures)[:600])
        return False

    def _try(self, desc, cfg):
        try:
            p = Gst.parse_launch(desc)
        except GLib.Error as e:
            return e.message
        enc, src, out = p.get_by_name('enc'), p.get_by_name('src'), p.get_by_name('out')
        self.kind = cfg.get('kind', 1)
        src.get_static_pad('src').add_probe(Gst.PadProbeType.BUFFER, self._on_capture)
        enc.get_static_pad('sink').add_probe(Gst.PadProbeType.BUFFER, self._skip_gate)
        first = {'n': 0}

        def sample(sink):
            first['n'] += 1
            return self._on_sample(sink)
        out.connect('new-sample', sample)
        self.discont = True
        with self.lock:
            self.cap.clear()
            self.fifo.clear()
        p.set_state(Gst.State.PLAYING)
        bus = p.get_bus()
        end = time.monotonic() + 3
        err = None
        while time.monotonic() < end and not first['n']:
            pump(0.02)
            msg = bus.pop_filtered(Gst.MessageType.ERROR)
            if msg:
                e, dbg = msg.parse_error()
                err = '%s (%s)' % (e.message, (dbg or '')[-200:])
                break
        if err:
            p.set_state(Gst.State.NULL)
            return err
        self.pipe, self.enc = p, enc
        bus.add_signal_watch()
        bus.connect('message::error', self._on_error)
        return None

    def _on_error(self, bus, msg):
        e, dbg = msg.parse_error()
        log('pipeline error:', e.message, (dbg or '')[-300:])
        LINK.event('error', code='pipeline', message=e.message)
        if self.cfg:
            GLib.idle_add(lambda: self.start(self.cfg) and False)

    def _on_capture(self, pad, info):
        b = info.get_buffer()
        with self.lock:
            self.cap[b.pts] = mono_us()
            while len(self.cap) > 64:
                self.cap.popitem(last=False)
        return Gst.PadProbeReturn.OK

    def _skip_gate(self, pad, info):
        if self.skip:
            self.win['skipped'] += 1
            return Gst.PadProbeReturn.DROP
        # Encoders shift PTS (x264enc/nvh264enc add 1000 h), so capture times follow the frame in order: with no
        # B-frames and zero latency every encoder here is one frame in, one access unit out.
        with self.lock:
            self.fifo.append(self.cap.pop(info.get_buffer().pts, None))
            while len(self.fifo) > 16:
                self.fifo.popleft()
        return Gst.PadProbeReturn.OK

    def _on_sample(self, sink):
        s = sink.emit('pull-sample')
        if s is None:
            return Gst.FlowReturn.OK
        b = s.get_buffer()
        ok, m = b.map(Gst.MapFlags.READ)
        if not ok:
            return Gst.FlowReturn.OK
        try:
            data = bytes(m.data)
        finally:
            b.unmap(m)
        now = mono_us()
        with self.lock:
            cap = self.fifo.popleft() if self.fifo else None
        key = not b.has_flags(Gst.BufferFlags.DELTA_UNIT)
        flags = (FLAG_KEY if key else 0) | (FLAG_DISCONT if self.discont else 0)
        if self.kind == 1 and key and has_sps(data):
            flags |= FLAG_CONFIG
        self.discont = False
        cfg = self.cfg
        self.seq = (self.seq + 1) & 0xffffffff
        enc_us = now - cap if cap else 0
        hdr = HEADER.pack(self.kind, flags, 32, self.seq, cap or now, max(0, min(enc_us, 0xffffffff)), inp['seq'],
                          cfg['width'], cfg['height'], 0)
        LINK.send(2, hdr + data)
        w = self.win
        w['frames'] += 1
        w['bytes'] += len(data)
        if cap:
            w['enc'].append(enc_us / 1000)
        return Gst.FlowReturn.OK

    def keyframe(self):
        log('keyframe requested', 'enc' if self.enc else 'no encoder yet')
        if self.enc:
            # What gst_video_event_new_upstream_force_key_unit() builds, without needing the GstVideo typelib.
            ev = Gst.Event.new_custom(Gst.EventType.CUSTOM_UPSTREAM, Gst.Structure.new_from_string(
                'GstForceKeyUnit, running-time=(guint64)18446744073709551615, all-headers=(boolean)true, count=(uint)0'))
            self.enc.get_static_pad('src').send_event(ev)

    def bitrate(self, kbps):
        if not self.enc or not self.encoder:
            return
        name = self.encoder['name']
        try:
            if name == 'openh264enc':
                self.enc.set_property('bitrate', int(kbps) * 1000)
            elif name != 'jpegenc':
                self.enc.set_property('bitrate', int(kbps))
            for c in self.cfg['candidates']:
                c['desc'] = re.sub(r'\bbitrate=\d+', 'bitrate=%d' % (int(kbps) * (1000 if c['encoder']['name'] == 'openh264enc' else 1)), c['desc'])
                c['desc'] = re.sub(r'vbv-buffer-size=\d+', 'vbv-buffer-size=%d' % max(1, int(kbps) // max(1, self.cfg['fps'])), c['desc'])
        except Exception as e:  # noqa: BLE001
            log('bitrate change failed:', e)

    def resize(self, w, h):
        if not self.cfg:
            return
        cfg = dict(self.cfg, width=w, height=h)
        cfg['candidates'] = [dict(c, desc=re.sub(r'width=\d+,height=\d+', 'width=%d,height=%d' % (w, h), c['desc'])) for c in self.cfg['candidates']]
        if self.pipe:
            self.start(cfg)
            LINK.event('meta', width=w, height=h)
        else:
            self.cfg = cfg
            self.idle_on(w, h)

    def stats(self):
        w = self.win
        span = max(0.001, time.monotonic() - w['since'])
        enc = sorted(w['enc'])
        r = {'fps': round(w['frames'] / span, 1), 'kbps': round(w['bytes'] * 8 / 1000 / span), 'skipped': w['skipped'],
             'encodeMsP50': round(enc[len(enc) // 2], 2) if enc else None, 'encodeMsP95': round(enc[int(len(enc) * 0.95)], 2) if enc else None,
             'encoder': self.encoder}
        self.win = {'frames': 0, 'bytes': 0, 'enc': [], 'skipped': 0, 'since': time.monotonic()}
        return r


def has_sps(data):
    i = data.find(b'\x00\x00\x01')
    while 0 <= i < len(data) - 3 and i < 512:
        if data[i + 3] & 0x1f == 7:
            return True
        i = data.find(b'\x00\x00\x01', i + 3)
    return False


STREAM = Stream()


def stats_tick():
    if STREAM.pipe:
        LINK.event('stats', **STREAM.stats())
    return not st['stopping']


# ------------------------------------------------------------------ ops from the daemon

def on_op(m):
    op = m.get('op')
    if op == 'start-stream':
        STREAM.start({'width': int(m['width']), 'height': int(m['height']), 'fps': int(m.get('fps') or 60),
                      'kind': int(m.get('kind') or 1), 'candidates': list(m['candidates'])})
        STREAM.skip = False
    elif op == 'stop-stream':
        w, h = (STREAM.cfg['width'], STREAM.cfg['height']) if STREAM.cfg else (SPEC.get('width', 1920), SPEC.get('height', 1080))
        STREAM.stop()
        STREAM.idle_on(w, h)
        release_all()
    elif op == 'resize':
        STREAM.resize(int(m['width']), int(m['height']))
    elif op == 'keyframe':
        STREAM.keyframe()
    elif op == 'bitrate':
        STREAM.bitrate(int(m['kbps']))
    elif op == 'skip':
        STREAM.skip = bool(m.get('on'))
    elif op == 'input':
        apply_input(int(m.get('seq') or 0), m.get('e') or [])
    elif op == 'clipboard-set':
        set_clipboard(str(m.get('text') or ''))
    elif op == 'release-all':
        release_all()
    elif op == 'stop':
        shutdown(force=bool(m.get('force')))


def on_connect():
    if not st.get('ready'):
        return  # sent by main() once the session is up
    LINK.event('ready', compositor=st.get('compositor'), display=st['wayland'], x11=st['display'], node=st['node'],
               streaming=bool(STREAM.pipe), encoder=STREAM.encoder,
               width=STREAM.cfg['width'] if STREAM.cfg else None, height=STREAM.cfg['height'] if STREAM.cfg else None)


def on_daemon_gone():
    # The daemon restarted (or is updating): drop the encoder and input state, keep the app. It reconnects.
    if STREAM.pipe and STREAM.cfg:
        w, h = STREAM.cfg['width'], STREAM.cfg['height']
        STREAM.stop()
        STREAM.idle_on(w, h)
    release_all()


LINK.on_op = on_op
LINK.on_connect = on_connect


# ------------------------------------------------------------------ teardown

def fatal(code, message):
    log('fatal', code, message)
    LINK.event('error', code=code, message=message)
    GLib.idle_add(lambda: shutdown(force=True) and False)


def terminate(p, sec):
    if not p or p.poll() is not None:
        return
    try:
        os.killpg(p.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        p.terminate()
    try:
        p.wait(sec)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            p.kill()


def shutdown(force=False):
    """App first (SIGTERM, up to 10 s to save or ask; force: 1 s), then the session, compositor, bus, sink, socket."""
    if st['stopping']:
        return True
    st['stopping'] = True
    log('stopping, force=%s' % force)
    STREAM.stop()
    STREAM.idle_off()
    release_all()
    app = procs.get('app')
    if app and st['app_pgid'] and group_alive(st['app_pgid']):
        try:
            os.killpg(st['app_pgid'], signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
        end = time.monotonic() + (1 if force else 10)
        while time.monotonic() < end and group_alive(st['app_pgid']):
            pump(0.1)
        if group_alive(st['app_pgid']):
            try:
                os.killpg(st['app_pgid'], signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
    for path in (st['sc'], st['rd']):
        if path:
            try:
                iface = (SC if path == st['sc'] else RD) + '.Session'
                call(SC if path == st['sc'] else RD, path, iface, 'Stop', None, None, timeout=2000)
            except Exception:  # noqa: BLE001
                pass
    terminate(procs.get('compositor'), 5)
    terminate(procs.get('dbus'), 3)
    if st['sink_id'] is not None:
        for i in sink_ids():
            subprocess.run(['pw-cli', 'destroy', i], capture_output=True, timeout=10, env=BASE_ENV)
    shutil.rmtree(PDIR, ignore_errors=True)
    LINK.close()
    log('stopped')
    LOOP.quit()
    return True


def on_signal():
    shutdown(force=False)
    return False


GLib.unix_signal_add(GLib.PRIORITY_HIGH, signal.SIGTERM, on_signal)
GLib.unix_signal_add(GLib.PRIORITY_HIGH, signal.SIGINT, on_signal)


def watch_compositor():
    p = procs.get('compositor')
    if st['stopping']:
        return False
    if p and p.poll() is not None:
        fatal('compositor-exit', 'The headless compositor exited (%s)' % p.poll())
        return False
    return True


def main():
    try:
        start_bus()
        st['compositor'] = start_compositor()
        start_session()
        # The first key event of a fresh session is dropped (spike 3): spend it on a Shift tap.
        rdc('NotifyKeyboardKeysym', '(ub)', (KEYSYM_SHIFT, True))
        rdc('NotifyKeyboardKeysym', '(ub)', (KEYSYM_SHIFT, False))
        STREAM.idle_on(int(SPEC.get('width') or 1920), int(SPEC.get('height') or 1080))
        start_null_sink()
        # The app starts only once the monitor exists.
        wait_for(lambda: False, 0.3)
        launch_app()
    except Exception as e:  # noqa: BLE001
        log('start failed:', repr(e))
        st['start_error'] = str(e)
        LINK.on_connect = lambda: LINK.event('error', code='start-failed', message=st['start_error'])
        if LINK.client:
            LINK.on_connect()
        GLib.timeout_add(3000, lambda: shutdown(force=True) and False)
        LOOP.run()
        return 1
    GLib.timeout_add(1000, watch_compositor)
    GLib.timeout_add(2000, stats_tick)
    st['ready'] = True
    if LINK.client:
        on_connect()
    log('ready')
    LOOP.run()
    return 0


if __name__ == '__main__':
    sys.exit(main())
