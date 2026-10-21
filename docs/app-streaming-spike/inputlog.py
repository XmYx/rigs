#!/usr/bin/env python3
"""Spike test client: a fullscreen GTK4 window that animates every frame and logs pointer/key input with
CLOCK_MONOTONIC timestamps, so the spike can check that injected input lands in the isolated display."""
import json
import sys
import time

import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk  # noqa: E402

log = open(sys.argv[1], 'a', buffering=1)
moves = [0]


def w(**k):
    k['t'] = time.monotonic()
    log.write(json.dumps(k) + '\n')


def on_activate(app):
    win = Gtk.ApplicationWindow(application=app, title='rigs-spike-input')
    win.set_default_size(1280, 720)
    da = Gtk.DrawingArea()
    da.set_hexpand(True)
    da.set_vexpand(True)
    t0 = time.monotonic()

    def draw(area, cr, wdt, hgt):
        x = ((time.monotonic() - t0) * 400) % max(1, wdt)
        cr.set_source_rgb(0.1, 0.1, 0.2)
        cr.paint()
        cr.set_source_rgb(1, 0.6, 0)
        cr.rectangle(x, 0, 60, hgt)
        cr.fill()

    da.set_draw_func(draw)
    ticks = {'n': 0, 'sec': int(time.monotonic())}

    def tick(wdg, clk):
        wdg.queue_draw()
        ticks['n'] += 1
        now = int(time.monotonic())
        if now != ticks['sec']:
            w(ev='fps', n=ticks['n'])
            ticks['n'], ticks['sec'] = 0, now
        return True
    da.add_tick_callback(tick)

    def motion(c, x, y):
        moves[0] += 1
        if moves[0] <= 500:
            w(ev='motion', x=round(x), y=round(y))

    mot = Gtk.EventControllerMotion()
    mot.connect('motion', motion)
    clk = Gtk.GestureClick()
    clk.set_button(0)
    clips = {'n': 0}

    def pressed(g, n, x, y):
        w(ev='click', button=g.get_current_button(), x=round(x), y=round(y))
        clips['n'] += 1
        if clips['n'] == 1:
            cb = win.get_clipboard()

            def done(c, res):
                try:
                    w(ev='clip-read', text=c.read_text_finish(res))
                except Exception as e:  # noqa: BLE001
                    w(ev='clip-read', error=str(e))
                c.set('client-says-\u0151\u0171')
                w(ev='clip-set')
            cb.read_text_async(None, done)
    clk.connect('pressed', pressed)
    key = Gtk.EventControllerKey()
    key.connect('key-pressed', lambda c, kv, kc, st: (w(ev='key', keyval=kv, keycode=kc), False)[1])
    scr = Gtk.EventControllerScroll(flags=Gtk.EventControllerScrollFlags.BOTH_AXES)
    scr.connect('scroll', lambda c, dx, dy: (w(ev='scroll', dx=dx, dy=dy), False)[1])
    win.add_controller(key)
    da.add_controller(mot)
    da.add_controller(clk)
    da.add_controller(scr)
    win.set_child(da)
    win.fullscreen()
    win.present()
    w(ev='ready')


app = Gtk.Application(application_id='dev.rigs.spike.input')
app.connect('activate', on_activate)
app.run([])
