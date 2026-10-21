#!/usr/bin/env python3
"""RIGS app-streaming spike. Run under `dbus-run-session`, so the compositor below lives on a private session
bus and never touches the person's own GNOME session:

  isolated headless GNOME compositor (gnome-shell --headless, mutter inside) → org.gnome.Mutter.ScreenCast
  (PipeWire node) → pipewiresrc → cudaupload → nvh264enc (NVENC) → H.264 Annex-B access units, and
  org.gnome.Mutter.RemoteDesktop input into that compositor only.

Prints one JSON report on stdout. Usage: dbus-run-session -- python3 spike.py <workdir> [app-binary]
"""
import json
import os
import re
import statistics
import subprocess
import sys
import time

import gi
gi.require_version('Gst', '1.0')
from gi.repository import Gio, GLib, Gst  # noqa: E402

OUT = sys.argv[1]
APP = sys.argv[2] if len(sys.argv) > 2 else ''
HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 1280, 720
T0 = time.monotonic()
report = {'steps': []}
RD, SC = 'org.gnome.Mutter.RemoteDesktop', 'org.gnome.Mutter.ScreenCast'


def step(name, **k):
    report['steps'].append({'step': name, 't': round(time.monotonic() - T0, 2), **k})
    print(name, json.dumps(k)[:300], file=sys.stderr, flush=True)


bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
ctx = GLib.MainContext.default()


def call(dest, path, iface, method, args=None, sig=None, timeout=8000):
    r = bus.call_sync(dest, path, iface, method, args, GLib.VariantType(sig) if sig else None,
                      Gio.DBusCallFlags.NONE, timeout, None)
    return r.unpack() if r else None


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
        time.sleep(0.004)


def wait_for(pred, sec):
    end = time.monotonic() + sec
    while time.monotonic() < end:
        while ctx.pending():
            ctx.iteration(False)
        if pred():
            return True
        time.sleep(0.02)
    return False


def methods(dest, path):
    xml = call(dest, path, 'org.freedesktop.DBus.Introspectable', 'Introspect', None, '(s)')[0]
    return sorted(set(re.findall(r'<method name="(\w+)"', xml)))


def pct(xs, p):
    if not xs:
        return None
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(len(xs) * p))], 2)


Gst.init(None)


def bench(node, seconds, label, out_h264=None, caps_extra=''):
    desc = ('pipewiresrc path=%d do-timestamp=true ! video/x-raw%s ! queue max-size-buffers=2 leaky=downstream ! '
            'cudaupload name=up ! cudaconvertscale ! video/x-raw(memory:CUDAMemory),format=NV12 ! '
            'nvh264enc name=enc preset=p1 tune=ultra-low-latency zerolatency=true bframes=0 gop-size=-1 '
            'rc-mode=cbr bitrate=8000 ! video/x-h264,stream-format=byte-stream,alignment=au,profile=high ! '
            'appsink name=sink emit-signals=true sync=false max-buffers=8 drop=true') % (node, caps_extra)
    p = Gst.parse_launch(desc)
    tin, lat, sizes, times, keys = {}, [], [], [], [0]
    up = p.get_by_name('up').get_static_pad('sink')

    def pin(pad, info):
        tin[info.get_buffer().pts] = time.monotonic()
        return Gst.PadProbeReturn.OK
    up.add_probe(Gst.PadProbeType.BUFFER, pin)
    f = open(out_h264, 'wb') if out_h264 else None

    def on_sample(sink):
        s = sink.emit('pull-sample')
        b = s.get_buffer()
        now = time.monotonic()
        t = tin.pop(b.pts, None)
        if t is not None:
            lat.append((now - t) * 1000)
        sizes.append(b.get_size())
        times.append(now)
        if not b.has_flags(Gst.BufferFlags.DELTA_UNIT):
            keys[0] += 1
        if f:
            ok, m = b.map(Gst.MapFlags.READ)
            if ok:
                f.write(bytes(m.data))
                b.unmap(m)
        return Gst.FlowReturn.OK
    p.get_by_name('sink').connect('new-sample', on_sample)
    p.set_state(Gst.State.PLAYING)
    start, err, caps = time.monotonic(), None, None
    while time.monotonic() - start < seconds:
        pump(0.05)
        msg = p.get_bus().pop_filtered(Gst.MessageType.ERROR)
        if msg:
            e, dbg = msg.parse_error()
            err = '%s | %s' % (e.message, (dbg or '')[-300:])
            break
        if caps is None:
            c = up.get_current_caps()
            caps = c.to_string() if c else None
    p.set_state(Gst.State.NULL)
    if f:
        f.close()
    span = (times[-1] - times[0]) if len(times) > 1 else 0
    r = {'label': label, 'seconds': seconds, 'frames': len(times), 'fps': round((len(times) - 1) / span, 1) if span else 0,
         'encodeMs': {'p50': pct(lat, 0.5), 'p95': pct(lat, 0.95), 'max': pct(lat, 1.0)},
         'kbps': round(sum(sizes) * 8 / 1000 / max(span, 0.001)) if span else 0, 'keyframes': keys[0],
         'firstFrameAfterMs': round((times[0] - start) * 1000) if times else None, 'inputCaps': caps, 'error': err}
    step('bench', **r)
    return r


def read_log(path):
    try:
        with open(path) as fh:
            return [json.loads(x) for x in fh if x.strip()]
    except OSError:
        return []


procs = []
try:
    disp = 'rigs-spike-%d' % os.getpid()
    env = {k: v for k, v in os.environ.items()
           if k not in ('DISPLAY', 'WAYLAND_DISPLAY', 'XDG_SESSION_ID', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP')}
    xs_before = set(os.listdir('/tmp/.X11-unix'))
    shell_log = open(os.path.join(OUT, 'shell.log'), 'w')
    shell = subprocess.Popen(['gnome-shell', '--headless', '--wayland', '--virtual-monitor', '%dx%d@60' % (W, H),
                              '--wayland-display', disp], env=env, stdout=shell_log, stderr=subprocess.STDOUT,
                             start_new_session=True)
    procs.append(shell)
    ok = wait_for(lambda: shell.poll() is None and has_name(SC) and has_name(RD), 40)
    step('compositor', ok=ok, pid=shell.pid, wayland=disp, alive=shell.poll() is None)
    if not ok:
        raise SystemExit('compositor did not come up')
    pump(2)
    report['versions'] = {'remoteDesktop': prop(RD, '/org/gnome/Mutter/RemoteDesktop', RD, 'Version'),
                          'screenCast': prop(SC, '/org/gnome/Mutter/ScreenCast', SC, 'Version'),
                          'rdDeviceTypes': prop(RD, '/org/gnome/Mutter/RemoteDesktop', RD, 'SupportedDeviceTypes')}
    st = call('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig', 'org.gnome.Mutter.DisplayConfig',
              'GetCurrentState', None, '(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})')
    monitors = [{'connector': m[0][0], 'modes': [md[0] for md in m[1]][:4]} for m in st[1]]
    report['monitors'] = monitors
    xs_new = sorted(set(os.listdir('/tmp/.X11-unix')) - xs_before)
    report['xwaylandSockets'] = xs_new
    step('monitors', monitors=monitors, xwayland=xs_new)

    rd = call(RD, '/org/gnome/Mutter/RemoteDesktop', RD, 'CreateSession', None, '(o)')[0]
    sid = prop(RD, rd, RD + '.Session', 'SessionId')
    sc = call(SC, '/org/gnome/Mutter/ScreenCast', SC, 'CreateSession',
              GLib.Variant('(a{sv})', ({'remote-desktop-session-id': GLib.Variant('s', sid)},)), '(o)')[0]
    report['rdSessionMethods'] = methods(RD, rd)
    report['scSessionMethods'] = methods(SC, sc)
    stream_path = call(SC, sc, SC + '.Session', 'RecordMonitor',
                       GLib.Variant('(sa{sv})', (monitors[0]['connector'], {'cursor-mode': GLib.Variant('u', 1)})), '(o)')[0]
    node = [None]
    bus.signal_subscribe(SC, SC + '.Stream', 'PipeWireStreamAdded', stream_path, None, Gio.DBusSignalFlags.NONE,
                         lambda *a: node.__setitem__(0, a[5].unpack()[0]))
    call(RD, rd, RD + '.Session', 'Start', None, None)
    wait_for(lambda: node[0] is not None, 8)
    params = prop(SC, stream_path, SC + '.Stream', 'Parameters')
    step('screencast', node=node[0], params={k: list(v) if isinstance(v, tuple) else v for k, v in params.items()})

    # 1. Nothing on screen but the shell: mutter only sends frames on damage.
    report['benchIdle'] = bench(node[0], 3, 'idle desktop (no client)')

    # 2. An animating Wayland client + input injection.
    il = os.path.join(OUT, 'input.jsonl')
    cenv = dict(env, WAYLAND_DISPLAY=disp, GDK_BACKEND='wayland')
    client = subprocess.Popen(['python3', os.path.join(HERE, 'inputlog.py'), il], env=cenv,
                              stdout=open(os.path.join(OUT, 'client.log'), 'w'), stderr=subprocess.STDOUT,
                              start_new_session=True)
    procs.append(client)
    ready = wait_for(lambda: any(e['ev'] == 'ready' for e in read_log(il)), 15)
    step('client', ready=ready)
    pump(1.5)
    report['benchAnimated'] = bench(node[0], 6, 'gtk4 client animating every frame, 1280x720', os.path.join(OUT, 'gtk.h264'))

    def rdc(method, sig, args):
        call(RD, rd, RD + '.Session', method, GLib.Variant(sig, args), None)

    lats, misses = [], 0
    for i in range(25):
        x, y = 100 + i * 37, 120 + (i % 5) * 90
        t = time.monotonic()
        rdc('NotifyPointerMotionAbsolute', '(sdd)', (stream_path, float(x), float(y)))
        got = wait_for(lambda: any(e['ev'] == 'motion' and e['x'] == x and e['y'] == y and e['t'] >= t for e in read_log(il)), 1.5)
        if got:
            ev = next(e for e in read_log(il) if e['ev'] == 'motion' and e['x'] == x and e['y'] == y and e['t'] >= t)
            lats.append((ev['t'] - t) * 1000)
        else:
            misses += 1
    rdc('NotifyPointerButton', '(ib)', (0x110, True))
    rdc('NotifyPointerButton', '(ib)', (0x110, False))
    rdc('NotifyPointerButton', '(ib)', (0x111, True))
    rdc('NotifyPointerButton', '(ib)', (0x111, False))
    rdc('NotifyKeyboardKeysym', '(ub)', (0x61, True))
    rdc('NotifyKeyboardKeysym', '(ub)', (0x61, False))
    rdc('NotifyKeyboardKeysym', '(ub)', (0x00e1, True))   # aacute: a non-ASCII keysym
    rdc('NotifyKeyboardKeysym', '(ub)', (0x00e1, False))
    rdc('NotifyPointerAxisDiscrete', '(ui)', (0, 1))
    rdc('NotifyPointerAxis', '(ddu)', (0.0, 15.0, 1))       # smooth scroll, finish flag
    pump(1.0)
    evs = read_log(il)
    report['input'] = {'motionToClientMs': {'p50': pct(lats, 0.5), 'p95': pct(lats, 0.95), 'max': pct(lats, 1.0)},
                       'motionsMatched': len(lats), 'motionsMissed': misses,
                       'clicks': [e for e in evs if e['ev'] == 'click'], 'keys': [e for e in evs if e['ev'] == 'key'],
                       'scrolls': [e for e in evs if e['ev'] == 'scroll']}
    step('input', **{k: v for k, v in report['input'].items() if k != 'scrolls'})
    client.terminate()
    client.wait(5)

    # 3. A stream whose size the consumer picks (RecordVirtual): a phone-shaped portrait monitor.
    try:
        rd2 = call(RD, '/org/gnome/Mutter/RemoteDesktop', RD, 'CreateSession', None, '(o)')[0]
        sid2 = prop(RD, rd2, RD + '.Session', 'SessionId')
        sc2 = call(SC, '/org/gnome/Mutter/ScreenCast', SC, 'CreateSession',
                   GLib.Variant('(a{sv})', ({'remote-desktop-session-id': GLib.Variant('s', sid2)},)), '(o)')[0]
        vpath = call(SC, sc2, SC + '.Session', 'RecordVirtual',
                     GLib.Variant('(a{sv})', ({'cursor-mode': GLib.Variant('u', 1), 'is-platform': GLib.Variant('b', True)},)), '(o)')[0]
        vnode = [None]
        bus.signal_subscribe(SC, SC + '.Stream', 'PipeWireStreamAdded', vpath, None, Gio.DBusSignalFlags.NONE,
                             lambda *a: vnode.__setitem__(0, a[5].unpack()[0]))
        call(RD, rd2, RD + '.Session', 'Start', None, None)
        wait_for(lambda: vnode[0] is not None, 8)
        report['benchVirtualPortrait'] = bench(vnode[0], 3, 'RecordVirtual, consumer asks 780x1688', caps_extra=',width=780,height=1688')
        st2 = call('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig', 'org.gnome.Mutter.DisplayConfig',
                   'GetCurrentState', None, '(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})')
        report['monitorsWithVirtual'] = [{'connector': m[0][0], 'modes': [md[0] for md in m[1]][:3]} for m in st2[1]]
        step('virtual', monitors=report['monitorsWithVirtual'])
        call(RD, rd2, RD + '.Session', 'Stop', None, None)
    except Exception as e:  # noqa: BLE001
        step('virtual', error=str(e)[:400])

    # 4. The real test app (FilmCraft: Rust, eframe/egui on wgpu) in the isolated display.
    if APP:
        fl = os.path.join(OUT, 'app.log')
        app = subprocess.Popen([APP], env=dict(env, WAYLAND_DISPLAY=disp, RUST_LOG='wgpu_core=warn,info'),
                               stdout=open(fl, 'w'), stderr=subprocess.STDOUT, start_new_session=True)
        procs.append(app)
        pump(14)
        step('app', alive=app.poll() is None, code=app.returncode)
        rdc('NotifyPointerMotionAbsolute', '(sdd)', (stream_path, 640.0, 360.0))
        report['benchApp'] = bench(node[0], 5, 'FilmCraft in the isolated display', os.path.join(OUT, 'app.h264'))
        app.terminate()
        try:
            app.wait(8)
        except subprocess.TimeoutExpired:
            app.kill()
        step('app-exit', code=app.returncode)
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
