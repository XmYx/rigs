// RIGS Control: exports the window list and window focus on the session bus (dev.rigs.Control), which
// GNOME Shell keeps private on Wayland (org.gnome.Shell.Introspect is allow-listed). Read by
// scripts/control/rigs-control-linux.py; installed per user when control is enabled on the machine.
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const IFACE = `<node>
  <interface name="dev.rigs.Control">
    <method name="ListWindows"><arg type="s" direction="out" name="json"/></method>
    <method name="FocusWindow"><arg type="s" direction="in" name="id"/><arg type="b" direction="out" name="ok"/></method>
  </interface>
</node>`;

function windows() {
    return global.get_window_actors().map((a) => a.meta_window)
        .filter((w) => w && !w.is_skip_taskbar() && w.get_window_type() === Meta.WindowType.NORMAL);
}

class Service {
    ListWindows() {
        const tracker = Shell.WindowTracker.get_default();
        const focus = global.display.focus_window;
        return JSON.stringify(windows().map((w) => {
            const r = w.get_frame_rect();
            const app = tracker.get_window_app(w);
            return {
                id: String(w.get_id()), title: w.get_title() || '', app: app ? app.get_name() : (w.get_wm_class() || ''),
                pid: w.get_pid(), display: w.get_monitor(), bounds: { x: r.x, y: r.y, width: r.width, height: r.height },
                focused: w === focus, minimized: w.minimized,
            };
        }));
    }

    FocusWindow(id) {
        const w = windows().find((x) => String(x.get_id()) === id);
        if (!w) return false;
        w.activate(global.get_current_time());
        return true;
    }
}

export default class RigsControlExtension extends Extension {
    enable() {
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, new Service());
        this._dbus.export(Gio.DBus.session, '/dev/rigs/Control');
        this._name = Gio.bus_own_name_on_connection(Gio.DBus.session, 'dev.rigs.Control', Gio.BusNameOwnerFlags.NONE, null, null);
    }

    disable() {
        if (this._name) Gio.bus_unown_name(this._name);
        this._dbus?.unexport();
        this._dbus = null;
        this._name = 0;
    }
}
