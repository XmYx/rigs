#!/usr/bin/env python3
# A tiny GTK4 window for checking the app stream viewer end to end (docs/app-streaming.md §11): it animates (a frame counter
# and a moving bar, so the stream always has new frames) and prints the last input it received (pointer position, buttons,
# wheel total, last keys, typed text). Start it as a session: POST appstream/sessions {command:["python3", "<this file>"]}.
import gi, json, os, time
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk, GLib

state = {'x': 0, 'y': 0, 'btn': '-', 'clicks': 0, 'wheel': 0.0, 'keys': [], 'frames': 0, 't0': time.time()}

def on_activate(app):
    win = Gtk.ApplicationWindow(application=app, title='RIGS stream test client')
    win.set_default_size(960, 600)
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8, margin_top=16, margin_bottom=16, margin_start=16, margin_end=16)
    info = Gtk.Label(xalign=0)
    info.add_css_class('title-1')
    bar = Gtk.ProgressBar()
    entry = Gtk.Entry(placeholder_text='type here: keys and text (őű) arrive from the viewer')
    area = Gtk.DrawingArea(vexpand=True)
    box.append(info); box.append(bar); box.append(entry); box.append(area)
    win.set_child(box)

    def draw(_a, cr, w, h):
        cr.set_source_rgb(0.08, 0.1, 0.13); cr.paint()
        cr.set_source_rgb(0.2, 0.9, 0.7); cr.arc(state['x'], state['y'], 14, 0, 6.3); cr.fill()
        cr.set_source_rgb(0.9, 0.6, 0.2); cr.rectangle((state['frames'] * 7) % max(w, 1), h - 24, 60, 24); cr.fill()
    area.set_draw_func(draw)

    motion = Gtk.EventControllerMotion()
    def moved(_c, x, y): state['x'], state['y'] = x, y
    motion.connect('motion', moved); area.add_controller(motion)
    click = Gtk.GestureClick(button=0)
    def pressed(g, n, x, y): state['btn'] = f'button {g.get_current_button()} down'; state['clicks'] += 1
    def released(g, n, x, y): state['btn'] = f'button {g.get_current_button()} up'
    click.connect('pressed', pressed); click.connect('released', released); area.add_controller(click)
    scroll = Gtk.EventControllerScroll(flags=Gtk.EventControllerScrollFlags.BOTH_AXES)
    def scrolled(_c, dx, dy): state['wheel'] += dy; return True
    scroll.connect('scroll', scrolled); area.add_controller(scroll)
    keys = Gtk.EventControllerKey()
    def key(_c, keyval, code, mods):
        from gi.repository import Gdk
        state['keys'] = (state['keys'] + [Gdk.keyval_name(keyval) or str(keyval)])[-6:]
    keys.connect('key-pressed', lambda *a: (key(*a), False)[1]); win.add_controller(keys)

    def tick():
        state['frames'] += 1
        fps = state['frames'] / max(time.time() - state['t0'], 0.001)
        bar.set_fraction((state['frames'] % 120) / 120)
        info.set_label(f"frame {state['frames']}  ptr {int(state['x'])},{int(state['y'])}  {state['btn']}  clicks {state['clicks']}  wheel {state['wheel']:.1f}\nkeys {' '.join(state['keys'])}")
        area.queue_draw()
        if state['frames'] % 15 == 0:  # for scripted checks: RIGS_TEST_STATE=<file> gets the last input as JSON
            path = os.environ.get('RIGS_TEST_STATE')
            if path:
                try:
                    with open(path + '.tmp', 'w') as f: json.dump({**state, 'text': entry.get_text(), 'fps': round(fps, 1)}, f)
                    os.replace(path + '.tmp', path)
                except OSError: pass
        return True
    GLib.timeout_add(16, tick)
    win.present()

app = Gtk.Application(application_id='eu.rigs.StreamTestClient')
app.connect('activate', on_activate)
app.run(None)
