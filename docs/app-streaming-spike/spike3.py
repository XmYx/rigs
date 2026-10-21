#!/usr/bin/env python3
"""RIGS app-streaming spike 3 (keyboard, clipboard paste/copy, layout switch, encode latency) (run under dbus-run-session): a RIGS session mode for the headless shell (no
panel, not the primary session → no GDM registration / screen shield), 1080p60 rate + NVENC latency, keyboard
after focus, the session's private clipboard both ways, Xwayland reachability and CPU cost.

Usage: dbus-run-session -- python3 spike2.py <workdir> [mode]
"""
import collections
import json
import os
import re
import subprocess
import sys
import time

import gi
gi.require_version('Gst', '1.0')
from gi.repository import Gio, GLib, Gst  # noqa: E402

OUT = sys.argv[1]
MODE = sys.argv[2] if len(sys.argv) > 2 else 'rigs-app'
HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 1920, 1080
T0 = time.monotonic()
report = {'steps': [], 'mode': MODE}
RD, SC = 'org.gnome.Mutter.RemoteDesktop', 'org.gnome.Mutter.ScreenCast'
TEXT = 'text/plain;charset=utf-8'


def step(name, **k):
    report['steps'].append({'step': name, 't': round(time.monotonic() - T0, 2), **k})
    print(name, json.dumps(k, default=str)[:400], file=sys.stderr, flush=True)


bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
ctx = GLib.MainContext.default()


def call(dest, path, iface, method, args=None, sig=None, timeout=8000):
    r = bus.call_sync(dest, path, iface, method, args, GLib.VariantType(sig) if sig else None,
                      Gio.DBusCallFlags.NONE, timeout, None)
    return r.unpack() if r else None


def call_fd(dest, path, iface, method, args, sig):
    r, fds = bus.call_with_unix_fd_list_sync(dest, path, iface, method, args, GLib.VariantType(sig),
                                             Gio.DBusCallFlags.NONE, 8000, None, None)
    return r.unpack(), fds.steal_fds()


def prop(dest, path, iface, name):
    return call(dest, path, 'org.freedesktop.DBus.Properties', 'Get', GLib.Variant('(ss)', (iface, name)), '(v)')[0]


def has_name(n):
    return call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameHasOwner',
                GLib.Variant('(s)', (n,)), '(b)')[0]


def pump(sec):
    end = time.monotonic() + sec
    while time.monotonic() < end:
        while ctx.pending():
            ctx.iteration(False)
        time.sleep(0.003)


def wait_for(pred, sec):
    end = time.monotonic() + sec
    while time.monotonic() < end:
        while ctx.pending():
            ctx.iteration(False)
        if pred():
            return True
        time.sleep(0.01)
    return False


def pct(xs, p):
    if not xs:
        return None
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(len(xs) * p))], 2)


def cpu_ticks(pid):
    try:
        with open('/proc/%d/stat' % pid) as fh:
            f = fh.read().rsplit(')', 1)[1].split()
        return int(f[11]) + int(f[12])
    except OSError:
        return 0


def read_log(path):
    try:
        with open(path) as fh:
            return [json.loads(x) for x in fh if x.strip()]
    except OSError:
        return []


Gst.init(None)


def bench(node, seconds, label, pids, out_h264=None):
    desc = ('pipewiresrc name=src path=%d do-timestamp=true ! video/x-raw ! queue max-size-buffers=2 leaky=downstream ! '
            'cudaupload name=up ! cudaconvertscale ! video/x-raw(memory:CUDAMemory),format=NV12 ! '
            'nvh264enc preset=p1 tune=ultra-low-latency zerolatency=true bframes=0 gop-size=-1 rc-mode=cbr '
            'bitrate=12000 ! video/x-h264,stream-format=byte-stream,alignment=au,profile=high ! '
            'appsink name=sink emit-signals=true sync=false max-buffers=8 drop=true') % node
    p = Gst.parse_launch(desc)
    fifo, lat, sizes, times, raw = collections.deque(), [], [], [], [0]
    p.get_by_name('src').get_static_pad('src').add_probe(Gst.PadProbeType.BUFFER, lambda pad, info: (raw.__setitem__(0, raw[0] + 1), Gst.PadProbeReturn.OK)[1])

    def pin(pad, info):
        fifo.append((info.get_buffer().pts, time.monotonic()))
        return Gst.PadProbeReturn.OK
    p.get_by_name('up').get_static_pad('sink').add_probe(Gst.PadProbeType.BUFFER, pin)
    f = open(out_h264, 'wb') if out_h264 else None

    def on_sample(sink):
        b = sink.emit('pull-sample').get_buffer()
        now = time.monotonic()
        if fifo:
            pts, t = fifo.popleft()
            lat.append((now - t) * 1000)
        sizes.append(b.get_size())
        times.append(now)
        if f:
            ok, m = b.map(Gst.MapFlags.READ)
            if ok:
                f.write(bytes(m.data))
                b.unmap(m)
        return Gst.FlowReturn.OK
    p.get_by_name('sink').connect('new-sample', on_sample)
    clk = os.sysconf('SC_CLK_TCK')
    before = {k: cpu_ticks(v) for k, v in pids.items()}
    p.set_state(Gst.State.PLAYING)
    start, err = time.monotonic(), None
    while time.monotonic() - start < seconds:
        pump(0.05)
        msg = p.get_bus().pop_filtered(Gst.MessageType.ERROR)
        if msg:
            e, dbg = msg.parse_error()
            err = '%s | %s' % (e.message, (dbg or '')[-300:])
            break
    took = time.monotonic() - start
    cpu = {k: round((cpu_ticks(v) - before[k]) / clk / took * 100) for k, v in pids.items()}
    p.set_state(Gst.State.NULL)
    if f:
        f.close()
    span = (times[-1] - times[0]) if len(times) > 1 else 0
    r = {'label': label, 'frames': len(times), 'rawFrames': raw[0], 'fps': round((len(times) - 1) / span, 1) if span else 0,
         'encodeMs': {'p50': pct(lat, 0.5), 'p95': pct(lat, 0.95), 'max': pct(lat, 1.0), 'n': len(lat)},
         'kbps': round(sum(sizes) * 8 / 1000 / max(span, 0.001)) if span else 0, 'cpuPct': cpu, 'error': err}
    step('bench', **r)
    return r


procs = []
try:
    disp = 'rigs-spike2-%d' % os.getpid()
    env = {k: v for k, v in os.environ.items()
           if k not in ('DISPLAY', 'WAYLAND_DISPLAY', 'XDG_SESSION_ID', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP')}
    sh_env = dict(env)
    args = ['gnome-shell', '--headless', '--wayland', '--virtual-monitor', '%dx%d@60' % (W, H), '--wayland-display', disp]
    if MODE != 'user':
        moddir = os.path.join(OUT, 'share', 'gnome-shell', 'modes')
        os.makedirs(moddir, exist_ok=True)
        with open(os.path.join(moddir, MODE + '.json'), 'w') as fh:
            json.dump({'hasWindows': True, 'components': [], 'panel': {'left': [], 'center': [], 'right': []},
                       'allowExtensions': True, 'enabledExtensions': ['rigs-control@rigs.dev']}, fh)
        sh_env['XDG_DATA_DIRS'] = os.path.join(OUT, 'share') + ':' + env.get('XDG_DATA_DIRS', '/usr/local/share:/usr/share')
        args.append('--mode=' + MODE)
    xs_before = set(os.listdir('/tmp/.X11-unix'))
    shell = subprocess.Popen(args, env=sh_env, stdout=open(os.path.join(OUT, 'shell2.log'), 'w'),
                             stderr=subprocess.STDOUT, start_new_session=True)
    procs.append(shell)
    ok = wait_for(lambda: shell.poll() is None and has_name(SC) and has_name(RD), 40)
    step('compositor', ok=ok, alive=shell.poll() is None)
    if not ok:
        raise SystemExit('compositor did not come up')
    pump(2.5)
    names = call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames', None, '(as)')[0]
    report['busNames'] = sorted(n for n in names if not n.startswith(':'))
    xs_new = sorted(set(os.listdir('/tmp/.X11-unix')) - xs_before)
    report['xwayland'] = xs_new
    pub = None
    with open(os.path.join(OUT, 'shell2.log')) as fh:
        m = re.search(r'Using public X11 display (:\d+)', fh.read())
        pub = m.group(1) if m else None
    if pub:
        r = subprocess.run(['xdpyinfo', '-display', pub], capture_output=True, text=True, timeout=10)
        report['xdpyinfo'] = [line.strip() for line in r.stdout.splitlines() if re.match(r'\s*(name of display|vendor string|dimensions)', line)]
    step('bus', screenSaver='org.gnome.ScreenSaver' in names, rigsControl='dev.rigs.Control' in names, xwayland=xs_new,
         display=pub, xdpyinfo=report.get('xdpyinfo'))

    st = call('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig', 'org.gnome.Mutter.DisplayConfig',
              'GetCurrentState', None, '(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})')
    connector = st[1][0][0][0]
    rd = call(RD, '/org/gnome/Mutter/RemoteDesktop', RD, 'CreateSession', None, '(o)')[0]
    sid = prop(RD, rd, RD + '.Session', 'SessionId')
    sc = call(SC, '/org/gnome/Mutter/ScreenCast', SC, 'CreateSession',
              GLib.Variant('(a{sv})', ({'remote-desktop-session-id': GLib.Variant('s', sid)},)), '(o)')[0]
    spath = call(SC, sc, SC + '.Session', 'RecordMonitor',
                 GLib.Variant('(sa{sv})', (connector, {'cursor-mode': GLib.Variant('u', 2)})), '(o)')[0]
    node = [None]
    bus.signal_subscribe(SC, SC + '.Stream', 'PipeWireStreamAdded', spath, None, Gio.DBusSignalFlags.NONE,
                         lambda *a: node.__setitem__(0, a[5].unpack()[0]))
    clip = {'owner': [], 'transfers': []}
    bus.signal_subscribe(RD, RD + '.Session', 'SelectionOwnerChanged', rd, None, Gio.DBusSignalFlags.NONE,
                         lambda *a: clip['owner'].append({k: v for k, v in a[5].unpack()[0].items()}))

    def transfer(*a):
        mime, serial = a[5].unpack()
        clip['transfers'].append(mime)
        try:
            (_,), fds = call_fd(RD, rd, RD + '.Session', 'SelectionWrite', GLib.Variant('(u)', (serial,)), '(h)')
            os.write(fds[0], 'rigs-says-őű'.encode())
            os.close(fds[0])
            call(RD, rd, RD + '.Session', 'SelectionWriteDone', GLib.Variant('(ub)', (serial, True)), None)
        except Exception as e:  # noqa: BLE001
            clip['transferError'] = str(e)[:300]
    bus.signal_subscribe(RD, RD + '.Session', 'SelectionTransfer', rd, None, Gio.DBusSignalFlags.NONE, transfer)
    call(RD, rd, RD + '.Session', 'Start', None, None)
    wait_for(lambda: node[0] is not None, 8)
    call(RD, rd, RD + '.Session', 'EnableClipboard', GLib.Variant('(a{sv})', ({},)), None)
    call(RD, rd, RD + '.Session', 'SetSelection', GLib.Variant('(a{sv})', ({'mime-types': GLib.Variant('as', [TEXT, 'text/plain'])},)), None)
    step('session', node=node[0], connector=connector)

    il = os.path.join(OUT, 'input3.jsonl')
    client = subprocess.Popen(['python3', os.path.join(HERE, 'entrylog.py'), il],
                              env=dict(env, WAYLAND_DISPLAY=disp, GDK_BACKEND='wayland'),
                              stdout=open(os.path.join(OUT, 'client3.log'), 'w'), stderr=subprocess.STDOUT,
                              start_new_session=True)
    procs.append(client)
    wait_for(lambda: any(e['ev'] == 'ready' for e in read_log(il)), 15)
    pump(1.5)
    report['bench1080'] = bench(node[0], 5, 'gtk4 label changing every frame, 1920x1080', {'compositor': shell.pid, 'client': client.pid, 'encoder(this process)': os.getpid()})
    report['clientFps'] = [e['n'] for e in read_log(il) if e['ev'] == 'fps'][-5:]

    def rdc(method, sig, a):
        call(RD, rd, RD + '.Session', method, GLib.Variant(sig, a), None)

    def sym(s, down):
        rdc('NotifyKeyboardKeysym', '(ub)', (s, down))

    def tap(*syms):
        for s_ in syms:
            sym(s_, True)
        for s_ in reversed(syms):
            sym(s_, False)
        pump(0.15)
    rdc('NotifyPointerMotionAbsolute', '(sdd)', (spath, 960.0, 600.0))
    pump(0.1)
    rdc('NotifyPointerButton', '(ib)', (0x110, True))
    rdc('NotifyPointerButton', '(ib)', (0x110, False))
    pump(0.6)
    t_key = time.monotonic()
    tap(0x68)                                   # h
    tap(0x69)                                   # i
    rdc('NotifyKeyboardKeycode', '(ub)', (46, True))   # evdev KEY_C
    rdc('NotifyKeyboardKeycode', '(ub)', (46, False))
    pump(0.3)
    tap(0xffe3, 0x76)                           # ctrl+v: paste from the RIGS side of the clipboard
    pump(0.8)
    tap(0x1f5)                                  # odoubleacute on layout 0 (us): not in the keymap
    try:
        rdc('SetKeymapLayoutIndex', '(u)', (1,))  # the person's 2nd input source (hu+qwerty)
        pump(0.3)
        tap(0x1f5)                              # ő on the Hungarian layout
        rdc('SetKeymapLayoutIndex', '(u)', (0,))
    except Exception as e:  # noqa: BLE001
        report['layoutError'] = str(e)[:300]
    pump(0.3)
    tap(0xffe3, 0x61)                           # ctrl+a
    tap(0xffe3, 0x63)                           # ctrl+c: the session now owns the clipboard
    wait_for(lambda: clip['owner'] and not clip['owner'][-1].get('session-is-owner', True), 2)
    owner_text = None
    if clip['owner'] and not clip['owner'][-1].get('session-is-owner', True):
        try:
            (_,), fds = call_fd(RD, rd, RD + '.Session', 'SelectionRead', GLib.Variant('(s)', (TEXT,)), '(h)')
            chunks, endt = [], time.monotonic() + 3
            os.set_blocking(fds[0], False)
            while time.monotonic() < endt:
                pump(0.02)
                try:
                    b = os.read(fds[0], 65536)
                except BlockingIOError:
                    continue
                if not b:
                    break
                chunks.append(b)
            os.close(fds[0])
            owner_text = b''.join(chunks).decode(errors='replace')
        except Exception as e:  # noqa: BLE001
            owner_text = 'error: %s' % e
    evs = read_log(il)
    keys = [e for e in evs if e['ev'] == 'key']
    report['keyboard'] = {'active': [e['value'] for e in evs if e['ev'] == 'active'],
                          'clicks': len([e for e in evs if e['ev'] == 'click']),
                          'firstKeyMs': round((keys[0]['t'] - t_key) * 1000, 1) if keys else None,
                          'keyvals': [e['keyval'] for e in keys], 'texts': [e['text'] for e in evs if e['ev'] == 'text']}
    report['clipboard'] = {'transfersServed': clip['transfers'], 'ownerChanges': clip['owner'],
                           'readFromSession': owner_text, 'error': clip.get('transferError')}
    step('keyboard', **report['keyboard'])
    step('clipboard', **report['clipboard'])
    report['benchShot'] = bench(node[0], 1.0, 'screenshot', {}, os.path.join(OUT, 'entry.h264'))
    call(RD, rd, RD + '.Session', 'Stop', None, None)
except SystemExit as e:
    report['fatal'] = str(e)
except Exception as e:  # noqa: BLE001
    report['fatal'] = repr(e)[:600]
finally:
    for p in reversed(procs):
        if p.poll() is None:
            p.terminate()
            try:
                p.wait(8)
            except subprocess.TimeoutExpired:
                p.kill()
    report['elapsed'] = round(time.monotonic() - T0, 1)
    print(json.dumps(report, default=str))
