import os from 'node:os';
import { isLinux, isMac, isWin, run } from './util.js';

/** Native desktop notification on THIS machine (where the waiting agent runs). Best effort. */
export async function osNotify(title, body) {
  const t = String(title).slice(0, 120);
  const b = String(body).slice(0, 240);
  if (isMac) {
    const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return run('osascript', ['-e', `display notification "${esc(b)}" with title "${esc(t)}" sound name "Glass"`], { timeout: 8000 });
  }
  if (isLinux) {
    const uid = os.userInfo().uid;
    const env = { ...process.env, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${uid}/bus` };
    return run('notify-send', ['-u', 'critical', '-a', 'RIGS', t, b], { timeout: 8000, env });
  }
  if (isWin) {
    const ps = "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; "
      + "$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); "
      + "$n = $x.GetElementsByTagName('text'); $n.Item(0).AppendChild($x.CreateTextNode($env:RIGS_T)) > $null; $n.Item(1).AppendChild($x.CreateTextNode($env:RIGS_B)) > $null; "
      + "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('RIGS').Show([Windows.UI.Notifications.ToastNotification]::new($x))";
    return run('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 15000, env: { ...process.env, RIGS_T: t, RIGS_B: b } });
  }
  return null;
}
