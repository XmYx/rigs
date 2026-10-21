#!/usr/bin/env python3
"""Spike test client 2: a GTK4 window with a text entry (keyboard + paste target) and a label that changes
every frame (so the compositor produces frames without cairo). Logs focus, keys, entry text and clicks."""
import json
import sys
import time

import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk  # noqa: E402

log = open(sys.argv[1], 'a', buffering=1)


def w(**k):
    k['t'] = time.monotonic()
    log.write(json.dumps(k) + '\n')


def on_activate(app):
    win = Gtk.ApplicationWindow(application=app, title='rigs-spike-entry')
    win.set_default_size(1280, 720)
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=20)
    entry = Gtk.Entry()
    entry.set_hexpand(True)
    label = Gtk.Label(label='0')
    box.append(entry)
    box.append(label)
    n = {'f': 0, 'sec': int(time.monotonic()), 'c': 0}

    def tick(wdg, clk):
        n['f'] += 1
        n['c'] += 1
        label.set_text('frame %d %s' % (n['f'], '#' * (n['f'] % 60)))
        now = int(time.monotonic())
        if now != n['sec']:
            w(ev='fps', n=n['c'])
            n['c'], n['sec'] = 0, now
        return True
    label.add_tick_callback(tick)
    entry.connect('changed', lambda e: w(ev='text', text=e.get_text()))
    key = Gtk.EventControllerKey()
    key.connect('key-pressed', lambda c, kv, kc, st: (w(ev='key', keyval=kv, keycode=kc), False)[1])
    key.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
    win.add_controller(key)
    clk = Gtk.GestureClick()
    clk.set_button(0)
    clk.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
    clk.connect('pressed', lambda g, c, x, y: w(ev='click', button=g.get_current_button(), x=round(x), y=round(y)))
    win.add_controller(clk)
    win.connect('notify::is-active', lambda *_: w(ev='active', value=win.is_active()))
    win.set_child(box)
    win.maximize()
    win.present()
    entry.grab_focus()
    w(ev='ready')


app = Gtk.Application(application_id='dev.rigs.spike.entry')
app.connect('activate', on_activate)
app.run([])
