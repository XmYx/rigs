# RIGS app streaming — binding design

Stream any real application from one mesh machine to any JARVIS viewer (desktop or phone browser) on
the RIGS stack: hardware encoding on the host, H.264 over the existing authenticated WebSocket proxy,
WebCodecs decoding in the browser, and mouse, keyboard, touch and clipboard sent back. Each machine
gets an **Applications** section in the file browser.

Project `0f2cc186fc` (JARVIS · RIGS app streaming to mesh), task t1. Written 2026-10-21 on
`macbookpro` from live probes of `magix-system` and `macbookpro`. Section 2 lists the probe
commands and their output. This document is binding for t2–t7. Where it differs from a task
brief, it says so in §13.

**The existing Sunshine/Moonlight remote desktop is left untouched.** `src/desktop.js`,
`src/desktop-install.js`, `src/moonlight-hosts.js`, the Sunshine LaunchAgent/service, pairing and the
"remote desktop" window keep working exactly as they do today. App streaming is a separate,
RIGS-native path. It shares no code, port, process or configuration with Sunshine or Moonlight. The
JPEG screen stream (`src/screen-stream.js`, Desktops panel) also stays as it is.

**Test target (Sir, 2026-10-21):** FilmCraft from the `main` checkout on `magix-system`
(`/home/magix/src/filmcraft`, branch `main` @ `cee1feb`, FilmCraft 0.7.2 installed as
`~/.local/bin/filmcraft` with desktop file `ai.storyteller.filmcraft.desktop`). Streaming must work in
**desktop and mobile browsers**.

---

## 0. Decisions at a glance

| # | Question | Decision |
| --- | --- | --- |
| 1 | Session model | **One app = one isolated headless compositor** (private D-Bus bus + headless mutter + one virtual monitor sized by the viewer) on the host. Sir's own desktop, input devices, clipboard, audio and session bus are never touched. Whole-desktop mode is optional, Linux-only, view-only and gated by screen control (Phase 3). |
| 2 | Linux compositor | `mutter --headless` (package `mutter`, one root step). Fallback that works today without root: `gnome-shell --headless --mode=rigs-app` (verified). Other desktops: `unsupported` in v1. |
| 3 | Capture | Mutter ScreenCast `RecordVirtual` (the stream's size **is** the monitor's size), PipeWire → GStreamer `pipewiresrc` in a per-session Python runner. |
| 4 | Encode | H.264 High, no B-frames, infinite GOP with IDR on demand. NVENC through `nvh264enc`: DMA-BUF → GL → NVENC first, SHM → CUDA second. VA-API (`vah264lpenc`/`vah264enc`) where present. `x264enc` as the software fallback. macOS: VideoToolbox. |
| 5 | Transport | **WebSocket over the existing RIGS auth and peer proxy** (`/api/nodes/<n>/appstream/sessions/<id>/stream`). Binary messages carry a 32-byte header plus one Annex-B access unit. No WebRTC, STUN or TURN. |
| 6 | Browser decode | WebCodecs `VideoDecoder` (needs a secure context: `https://<machine>.<tailnet>.ts.net` via `tailscale serve`, or `localhost`). Fallback 1: MSE / ManagedMediaSource with fMP4 remuxed **in the browser**. Fallback 2: JPEG frames (same protocol, kind 3). |
| 7 | Flow control | End-to-end acks across every proxy hop. Drop **raw** frames before the encoder, never encoded ones. A congested viewer resumes on a fresh IDR. AIMD bitrate. |
| 8 | Input | Mutter RemoteDesktop on the session's private bus: absolute pointer on the stream, evdev keycodes from `KeyboardEvent.code`, keysyms for text, the session's private clipboard (paste) for text the keymap cannot type, and touch. **Never uinput** (it is seat-global and would reach Sir's desktop). |
| 9 | Gate | Isolated sessions are *human remote apps* (the category Sunshine is in, `docs/full-access.md` §1). They have their own switch `config.appStream`, audit log, announcement and stop. A **control kill or switch-off ends every live viewer at once**. Whole-desktop mode and the macOS host touch the real desktop, so they go through the screen-control gate unchanged (§6). |
| 10 | API prefix | `/api/local/appstream/*`, reached as `/api/nodes/<n>/appstream/*`. Not `apps/…`: `APP_ROUTE` (`src/proxy.js:115`) already owns `/api/nodes/<n>/apps/<id>/*` for App Cloud apps. |
| 11 | Process model | Each session runs in a transient `systemd --user` unit (`rigs-appstream-<id>.service`), so a daemon restart or self-update never kills an app with unsaved work. The daemon reattaches through a Unix socket. |
| 12 | UI | File browser: an **Applications** place (`@apps`) per machine, shown in Favourites and under every machine in Locations. Stream viewer: a `wm.js` window (full screen on phones) with toolbar, stats, touch modes and a soft keyboard. |
| 13 | OS support | Linux host (GNOME/mutter): **required now**. macOS host (ScreenCaptureKit + VideoToolbox, shared-desktop app capture under the control gate): **stretch**. Windows host: **designed, deferred**. Viewers: Chrome/Edge/Firefox/Safari desktop, iOS Safari, Android Chrome. |

---

## 1. Goal, scope, non-goals

**Goal.** Sir opens *Applications* on any machine in the file browser, picks an app (FilmCraft on
`magix-system`) and gets it live in a JARVIS window on any other machine or on his phone, with
hardware encode/decode and full mouse, keyboard and touch control. Closing the window leaves the app
running, and he can come back to it.

**In scope:** host sessions on Linux GNOME (mutter); NVENC/VA-API/x264; viewer on desktop and phone
browsers; catalog per OS; gate, audit and kill integration; FilmCraft as the reference app.

**Not in v1:** WebRTC; audio (the protocol reserves it and §5.8 designs it; Phase 2); gamepads;
several monitors per session; file transfer inside the viewer (the file browser already
copies between machines); KDE/wlroots/X11-only Linux hosts; the Windows host; interactive
whole-desktop mode (Moonlight remains the tool for that).

---

## 2. Probe results (evidence)

All probes ran 2026-10-21 between 14:36 and 15:01Z with `mesh_exec` against `magix-system` and
locally on `macbookpro`. The probes changed no settings and installed nothing. Every compositor
that was started ran inside its own `dbus-run-session`, and none outlived its probe (each run ended
with `pgrep -af 'gnome-shell --headless'` → `no leftovers`). The probe scripts are in
`docs/app-streaming-spike/` (throwaway reference code; run them with
`dbus-run-session -- python3 spikeN.py <workdir> rigs-app`).

### 2.1 magix-system — system

```
$ uname -r; . /etc/os-release; echo $PRETTY_NAME; gnome-shell --version
7.0.0-38-generic
Ubuntu 26.04.1 LTS
GNOME Shell 50.1                      # libmutter-18; no /usr/bin/mutter
$ loginctl show-session 215 -p Type   → Type=wayland  (Sir's session, seat0, tty2)
$ nvidia-smi --query-gpu=name,driver_version,encoder.stats.sessionCount --format=csv
NVIDIA GeForce RTX 4090, 610.57.04, 0
GPUs: Intel UHD 770 (00:02.0 → /dev/dri/renderD128, boot VGA) + RTX 4090 (01:00.0 → /dev/dri/renderD129)
$ systemctl --user is-active pipewire wireplumber   → active active   (PipeWire 1.6.2)
```

### 2.2 magix-system — encoders

```
$ gst-inspect-1.0 --version → GStreamer 1.28.2
nvh264enc YES  nvh265enc YES  nvav1enc YES  nvautogpuh264enc YES   (libgstnvcodec.so)
cudaupload YES cudaconvert YES cudascale YES cudaconvertscale YES
nvh264enc SINK caps: video/x-raw(memory:CUDAMemory) | video/x-raw(memory:GLMemory) | video/x-raw
vah264enc no  vah264lpenc no  vaapih264enc no  qsvh264enc no      (no VA driver: see FilmCraft log below)
x264enc YES  openh264enc YES  vp8enc/vp9enc YES  svtav1enc YES  av1enc YES
pipewiresrc YES  ximagesrc YES  glupload/gldownload YES  h264parse YES  mp4mux YES
isofmp4mux no  cmafmux no                                        (gst-plugins-rs not installed)
opusenc YES  pulsesrc YES  webrtcbin YES  appsink YES
pipewiresrc properties: always-copy autoconnect … keepalive-time max-buffers min-buffers … path
                        resend-last stream-properties target-object use-bufferpool
$ ffmpeg -encoders (8.0.1): h264_nvenc hevc_nvenc av1_nvenc h264_vaapi h264_qsv h264_vulkan libx264 …
  devices: x11grab kmsgrab; hwaccels: vdpau cuda vaapi qsv drm opencl vulkan
FilmCraft log: "no VA-API hardware decoding: /dev/dri/renderD129: vaInitialize: unknown libva error"
               "hardware decoding through NVDEC"   → VA-API is unusable here today; NVENC is the path.
```

Synthetic encode run (videotestsrc-bound, so this measures throughput, not latency):
`nvh264enc preset=p1 tune=ultra-low-latency` 300 frames 1080p60 → wall 1.96 s, 98 % CPU (the test
source dominates); `x264enc ultrafast zerolatency` 300 frames 1080p60 → wall 1.86 s, 162 % CPU.

### 2.3 magix-system — virtual displays and input tools

```
Xvfb no (apt candidate 2:21.1.22)   weston no (14.0.2)   cage no (0.2.1)   gamescope no (3.16.20)
sway no (1.11)   mutter no (50.1-0ubuntu2.4)   VirtualGL no (not packaged)   Xorg YES (+ nvidia_drv)
gnome-shell --help: --headless  --virtual-monitor WxH[@R]  --wayland  --no-x11  --wayland-display  --mode=MODE
Xwayland 24.1.10 YES   wl-copy/wl-paste YES   xdpyinfo/xprop/xwininfo/xrandr YES
xdotool no  ydotool no  wtype no  wlrctl no  dotool no  python3-xlib no  python3-evdev no
libei 1.5 runtime YES (libei.so.1, libeis.so.1, liboeffis.so.1; no -dev)
/dev/uinput crw-rw----+ root input, ACL user:magix:rw-   ← seat-global: must not be used for sessions
dbus-python YES   PyGObject + Gst 1.28.2 YES   GTK 4.22 YES   python3-gi-cairo no
```

### 2.4 magix-system — spikes (isolated headless GNOME in a private bus)

| Spike | What | Result |
| --- | --- | --- |
| 1 | `gnome-shell --headless --wayland --virtual-monitor 1280x720@60`, RecordMonitor, SHM → cudaupload → nvh264enc | Compositor on the private bus in **0.34 s**; monitor `Meta-0 1280x720@60`; Xwayland `:2` on demand; ScreenCast API v4, RemoteDesktop v1, device types 7 (keyboard+pointer+touch). RD session methods: `ConnectToEIS EnableClipboard NotifyKeyboardKeycode NotifyKeyboardKeysym NotifyPointerAxis NotifyPointerAxisDiscrete NotifyPointerButton NotifyPointerMotionAbsolute NotifyPointerMotionRelative NotifyTouchDown/Motion/Up SelectionRead SelectionWrite SelectionWriteDone SetKeymap SetKeymapLayoutIndex SetSelection Start Stop`. ScreenCast: `RecordArea RecordMonitor RecordVirtual RecordWindow`. Idle desktop: **1 frame in 3 s** (frames come only on damage). Pointer motion → GTK client **p50 10.4 ms, p95 16.6 ms** (24/25 matched); left/right click and wheel arrived; no keys (see spike 3). |
| 1 | **FilmCraft 0.7.2** launched with `WAYLAND_DISPLAY=<session>` | Ran on Vulkan (adapters listed: UHD 770, **RTX 4090**, llvmpipe), NVDEC detected, editor and demo project rendered and encoded; decoded frame: `docs/screenshots/app-stream/spike-filmcraft-isolated.png`. Clipboard warning without `DISPLAY` → sessions export both `WAYLAND_DISPLAY` and `DISPLAY`. |
| 1 | `RecordVirtual` asked 780x1688 | mutter created `Meta-1 780x1688@60`: **the consumer picks the monitor size**. |
| 1 | Side effects of the default (user) shell mode | `Registering session with GDM`, `Will monitor session 215` (Sir's logind session), full top bar, calendar/evolution services; screensaver settings `idle-delay 300`, `lock-enabled true` would lock an unattended session → **not acceptable as the primary compositor**. |
| 2/3 | `--mode=rigs-app` (a session-mode file via `XDG_DATA_DIRS`, §3.2) | No `org.gnome.ScreenSaver` on the bus, empty 32-px top strip, window maximized below it. Still logs GDM registration (a residual risk; `mutter` avoids it). |
| 3 | Keyboard and clipboard (GTK4 entry client) | After focus: `i`, `c` (keysym and evdev keycode 46) typed; **the first key after session start was lost** (`h`) → warm-up rule §5.4. Ctrl+V pasted `rigs-says-őű` from `SetSelection` + `SelectionWrite`; Ctrl+A, Ctrl+C → `SelectionOwnerChanged` → `SelectionRead` returned `icrigs-says-őű`. Keysym ő (0x1f5) on layout `us`: mutter `No keycode found for keyval 1f5 in current group`; `SetKeymapLayoutIndex(1)` → `Invalid current keymap (0)`. → Text that the keymap cannot type goes through the private clipboard. Screenshot: `docs/screenshots/app-stream/spike-keyboard-clipboard.png`. |
| 3/4/5 | RecordMonitor 1920x1080 rate | SHM 35.5 fps (no encoder), always-copy 38.8, min-buffers=8 35.6, DMA-BUF→GL→nvh264enc 48.9, while the client drew 60. NVENC encode **p50 4.59 ms, p95 4.96 ms**. |
| 6 | Resize by changing the capsfilter in place | Monitor resized (1600x900, then 780x1688), but the stream stalled after the second change → in-place renegotiation is **unreliable**. |
| 7 | Resize by **rebuilding the consumer pipeline on the same RecordVirtual node** | 1600x900 first frame **58 ms**, 780x1688 **59 ms**, 1920x1080 **40 ms**, 1688x780 **43 ms**; 61 frames in the next second each time; monitor follows every size. **This is the resize method.** |
| 8 | RecordVirtual 1920x1080 → NVENC | SHM → cudaupload → nvh264enc: **59.8 fps**, encode **p50 4.41 / p95 4.91 / max 7.32 ms**, compositor 20 % CPU, runner 23 %. DMA-BUF → GL → nvh264enc: **60.0 fps**, encode p50 6.83 / p95 7.78 ms, compositor **7 %**, runner 19 %. `ffprobe`: `h264 High level 42 1920x1080`, 298/298 frames decodable. |
| X11 | Xwayland auth | `Xwayland … -auth /run/user/1000/.mutter-Xwaylandauth.4I6BX3`; with `DISPLAY=:2 XAUTHORITY=<that file>`, `xdpyinfo` connects. A numbered socket name `wayland-77` works (needed for snaps, §3.3). |

### 2.5 macbookpro

```
$ sw_vers → macOS 26.3.1 (25D2128); Apple M1; swift 5.6 (SDK 12.3, Xcode CLT); no GStreamer; ffmpeg h264_videotoolbox/hevc_videotoolbox
VTCopyVideoEncoderList: avc1 HW "Apple H.264 (HW)"  hvc1 HW "Apple HEVC (HW)"  jpeg HW
VTCompressionSessionCreate 1920x1080 H.264 with EnableLowLatencyRateControl → ok
ScreenCaptureKit with SDK 12.3: SCStream, SCContentFilter, SCStreamConfiguration (NV12 pixelFormat,
  queueDepth, minimumFrameInterval, showsCursor, capturesAudio) compile and link (no capture run: no TCC prompt)
RigsControl.swift captures through /usr/sbin/screencapture today (SCScreenshotManager needs the macOS 14 SDK)
GET /api/local/control → enabled:false input:false session:quartz backend mac-helper (RIGS Control.app dev.rigs.control, running)
```

### 2.6 Gate and HTTPS state on the hosts

```
magix-system control: enabled:false input:false
  killed: {at: 2026-10-18T19:17:48Z, by: {via: local, from: magix-system, human: true}, reason: "Stopped from the JARVIS panel"}
macbookpro control: enabled:false input:false
magix-system: tailscale serve → https://magix-system.tail34565a.ts.net (tailnet only) → http://127.0.0.1:4719
macbookpro:  tailscale serve status → "No serve config"
Mesh: iphone172 (iOS, tailnet, no RIGS) is the phone viewer to test with.
```

### 2.7 Browser facts this design relies on

- WebCodecs (`VideoDecoder`, `AudioDecoder`) exist **only in secure contexts**
  ([MDN VideoDecoder](https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder),
  [MDN AudioDecoder](https://developer.mozilla.org/en-US/docs/Web/API/AudioDecoder)). JARVIS opened as
  `http://<machine>:4719` from another device is **not** secure, but
  `https://<machine>.<tailnet>.ts.net` (`rigs setup --https`) and `http://localhost:4719` are.
- Safari's `ManagedMediaSource` only opens when `video.disableRemotePlayback = true` (or an AirPlay
  alternative source is given) ([MDN ManagedMediaSource](https://developer.mozilla.org/en-US/docs/Web/API/ManagedMediaSource)).
- The viewer never relies on a version table: it feature-detects (`isSecureContext`,
  `VideoDecoder.isConfigSupported`, `ManagedMediaSource ?? MediaSource` + `isTypeSupported`) and
  reports what it found in its `hello`.

---

## 3. Session model

### 3.1 Isolated app session (Linux, the default)

```
systemd --user transient unit  rigs-appstream-<sid>.service   (survives daemon restarts/self-updates)
└─ python3 scripts/appstream/rigs-appstream-linux.py --session <sid> --state <dir>   (the "runner")
   ├─ dbus-daemon --session --address=unix:path=<rt>/rigs-as-<sid>/bus     (private session bus)
   ├─ mutter --headless --wayland --wayland-display wayland-<n>           (or gnome-shell --headless --mode=rigs-app)
   │    └─ Xwayland :<x> (on demand, -auth $XDG_RUNTIME_DIR/.mutter-Xwaylandauth.*)
   ├─ the app (gio launch <file>.desktop | argv), env: WAYLAND_DISPLAY DISPLAY XAUTHORITY
   │    DBUS_SESSION_BUS_ADDRESS(private) XDG_SESSION_TYPE=wayland PULSE_SINK/PIPEWIRE_NODE=rigs-as-<sid>
   ├─ ScreenCast + RemoteDesktop session (RecordVirtual) on the private bus → PipeWire node
   └─ GStreamer pipeline in-process (pipewiresrc → encoder → appsink) → Unix socket → daemon
```

- **Isolation.** Each session has its own compositor, so its own windows, focus, cursor, keyboard
  state, clipboard and virtual monitor. Session D-Bus services such as portals, a11y and
  notifications start on the private bus. The person's desktop, session bus, clipboard, `/dev/uinput`
  and default audio output are never used. The app runs as Sir's uid: these are "real apps" with
  his files and settings, the same trust level as a terminal opened through RIGS.
- **Monitor = stream.** No `--virtual-monitor` flag. The runner calls
  `ScreenCast.CreateSession({remote-desktop-session-id})` → `RecordVirtual({cursor-mode: 1
  (embedded), is-platform: true})` → `RemoteDesktop.Start`, then builds the pipeline with caps
  `width=W,height=H`. mutter creates `Meta-0` at exactly W×H@60 (spike 7).
- **Order of start** (target ≤ 1.5 s to first frame): bus → compositor (0.3 s measured) → ScreenCast
  session and first pipeline at the requested size → warm-up key (§5.4) → launch the app → `ready`.
  The app is launched only after the monitor exists.
- **Resize** (window resize, phone rotation): set the pipeline to NULL and build a new one on the
  **same node** with the new caps (40–60 ms measured). Debounce 250 ms on the viewer side, clamp
  per §5.2, and send `meta` to every viewer. In-place caps renegotiation is not used (spike 6).
- **Idle cost.** With no viewer attached the runner tears the pipeline down (this frees the NVENC
  session). The compositor and app keep running. A viewer joining rebuilds the pipeline, and its
  first frame is an IDR.

### 3.2 Compositor selection (Linux)

`compositorFor(facts)`, a pure function in `src/app-stream.js`:

1. `mutter` binary present → `mutter --headless --wayland --wayland-display wayland-<n>` (no shell, no
   GDM, no lock screen, no panel). Installing it is a root step: `rootsteps.add('appstream-mutter',
   'Install mutter for isolated app sessions', ['apt-get install -y mutter'])`. Offer the step
   from the Applications view and from `rigs doctor`/setup only on GNOME hosts without it.
2. `gnome-shell` ≥ 45 with `--headless` → `gnome-shell --headless --wayland --wayland-display
   wayland-<n> --mode=rigs-app`, with `XDG_DATA_DIRS=$RIGS_HOME/appstream/share:$XDG_DATA_DIRS` and
   the mode file `share/gnome-shell/modes/rigs-app.json` (shipped as
   `scripts/appstream/gnome-shell/rigs-app.json`, verified in spikes 2–8):
   ```json
   {"hasWindows": true, "components": [], "panel": {"left": [], "center": [], "right": []},
    "allowExtensions": true, "enabledExtensions": ["rigs-control@rigs.dev"]}
   ```
   The `rigs-control` extension listed there did not load in this mode (spike 2), and nothing depends
   on it. Known residuals: it registers with GDM and watches Sir's logind session, and an empty 32-px
   strip stays at the top. Hiding that strip through a mode `stylesheetName` is optional polish. The
   Applications view shows "Install mutter for lighter, fully isolated sessions" while this fallback
   is in use.
3. Anything else (KDE, wlroots, X11-only session, no GNOME) → `unsupported`, with the reason
   "isolated app sessions need GNOME/mutter on Linux (KDE/wlroots hosts are not supported yet)".
   Future options (not v1): `kwin_wayland --virtual`, `cage`/`sway` headless with wlr protocols, Xvfb +
   VirtualGL.

### 3.3 Names, environment, files

- Wayland socket: `wayland-<n>`, with `n` the first free number ≥ 50 in `$XDG_RUNTIME_DIR`. **Numbered
  names are required**: snap's AppArmor `wayland` interface only allows `$XDG_RUNTIME_DIR/wayland-[0-9]*`.
- X11: mutter logs `Using public X11 display :<x>`. The runner reads it from the compositor's
  stderr and takes `XAUTHORITY` from the `.mutter-Xwaylandauth.*` file that appeared in
  `$XDG_RUNTIME_DIR` after the compositor started (verified with `xdpyinfo`).
- Environment for the app: the current GUI env (`desktop.guiEnv()`) minus `DISPLAY`,
  `WAYLAND_DISPLAY`, `XDG_SESSION_ID`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_CURRENT_DESKTOP`, plus the
  session values above and `XDG_CURRENT_DESKTOP=GNOME`, `XDG_SESSION_TYPE=wayland`,
  `GDK_BACKEND=wayland,x11`, `QT_QPA_PLATFORM=wayland;xcb`, `SDL_VIDEODRIVER=wayland,x11`,
  `ELECTRON_OZONE_PLATFORM_HINT=auto`, `PULSE_SINK=rigs-as-<sid>`, `PIPEWIRE_NODE=rigs-as-<sid>`.
- State: `RIGS_HOME/appstream/sessions/<sid>.json` (session object, unit name, socket path, pids),
  socket `RIGS_HOME/run/appstream/<sid>.sock` (0600, dir 0700), log
  `RIGS_HOME/logs/appstream/<sid>.log` (runner + compositor + app stderr, rotated at 5 MB).
- Session id: `as-` + 8 hex (`crypto.randomBytes(4)`).

### 3.4 Lifecycle

```
starting ─ready→ running ─last viewer leaves→ parked ─viewer joins→ running
   │                │                            │
   └─error→ failed  └──── app exits / DELETE / parkMinutes over / runner dies ──→ stopping → ended
```

- `POST sessions` with `reuse` (default true) returns the existing live session of the same app on
  that host instead of starting a second one (single-instance apps, "open FilmCraft" twice).
- **Parked** sessions keep the app alive (unsaved work in an editor). `appStream.parkMinutes`
  (default 120) is the limit. The Applications view shows a countdown ("closes in 1 h 52 min")
  and a Keep-open action that resets it. When the limit passes, the stop is graceful (below).
- **Stop (DELETE, park expiry):** SIGTERM to the app's process group, wait up to 10 s (the app may
  save or ask), then SIGKILL, ScreenCast/RemoteDesktop `Stop`, compositor SIGTERM, bus exit,
  `systemctl --user stop` of the unit, then remove the socket and state file. `?force=1` skips the
  wait. A session is never stopped while a viewer is attached, except by DELETE or the app exiting.
- **App exit** → `end {reason:'app-exited', code}` to viewers, then clean up as above.
- **Daemon start:** read `appstream/sessions/*.json`. Units still active get their socket reconnected
  and the session resumes. Dead units have their files removed (startup `reconcile()`). Orphaned
  `rigs-appstream-*` units with no state file are stopped.
- **Limits:** `appStream.maxSessions` (default 4 per host). GeForce drivers cap concurrent NVENC
  sessions, and Sunshine may hold one, so an encoder that fails to open falls back to x264 for that
  session with `status:'encoder-fallback'`.

### 3.5 Whole-desktop mode (Phase 3, optional, Linux)

`mode:'desktop'` streams Sir's real GNOME desktop with H.264 instead of JPEG. Capture is
`RecordMonitor` on the **real** session bus through the control helper's mutter session. It is
**view-only** in v1 and fully under the screen-control gate (§6). For interactive whole-desktop use,
Moonlight remains the tool. Not part of t2–t7.

### 3.6 macOS host (stretch, t5) — shared-desktop app capture

Built in t5; §16 records what was built, how it differs from this plan and its limits.

macOS has no isolated per-app display without private APIs (`CGVirtualDisplay`). The macOS host
therefore streams **one app's windows on the real desktop**:

- Capture: ScreenCaptureKit `SCStream` with `SCContentFilter(display:including:[SCRunningApplication]
  exceptingWindows:[])` (macOS 12.3 API; the probe linked `SCStream`/`SCContentFilter` and built an
  NV12 `SCStreamConfiguration` with this SDK, but captured nothing) → `CVPixelBuffer` NV12 (IOSurface) →
  `VTCompressionSession` H.264 HW with `EnableLowLatencyRateControl` (verified) → the same wire format.
  This runs in **RIGS Control.app** (`scripts/control/macos/RigsControl.swift`), which already holds
  Screen Recording + Accessibility: a new `streamApp` op on its socket. No second TCC grant.
- Input moves the real cursor and focus. It goes through the control gate with the lease held by
  the person (§6). Keyboard events go with `CGEvent.postToPid(pid)`; pointer events are posted at
  global coordinates mapped from the app's capture rect.
- Launch: `open -b <bundleId>` (or attach to the running app). Stream size = the app's window bounds,
  so a remote resize resizes the app's front window through AX. Today macbookpro has control
  **off**, so a macOS host session is refused (`control-off`) until a person switches control on.
  t5 must report that precisely, not work around it.

### 3.7 Windows host (designed, deferred)

Windows Graphics Capture (per window) → Media Foundation H.264 encoder MFT (hardware: NVENC / QSV /
AMF) → the same protocol. Input with `SendInput` on the real desktop, under the control gate, like
macOS. An isolated display needs an IddCx virtual display driver (a driver install), so it is out
of scope. The catalog already lists Windows apps with `streamable:false` and `why:'Windows hosting
is designed but not built yet'`.

---

## 4. Capture → encode (per OS)

### 4.1 Encoder choice

`pickEncoder(facts, prefs)`, pure. `facts` = `{ gst: {element: true…}, gpus: [...], vaDriver: bool }`
probed once per runner start with `gst-inspect-1.0 <el>`. `prefs.encoder` comes from
`appStream.encoder` (`auto | nvenc | vaapi | x264`):

1. `nvh264enc` present and an NVIDIA GPU → **nvenc**. Path `dmabuf-gl` if a test negotiation of
   `video/x-raw(memory:DMABuf)` + `glupload` succeeds within 2 s, else `shm-cuda`.
2. `vah264lpenc` or `vah264enc` present → **vaapi** (untested on this mesh, see §2.2).
3. `x264enc` → **x264**. `openh264enc` is the last resort.

The hello and stats report `encoder: {name, hw, path}` (for example
`{name:'nvh264enc', hw:true, path:'dmabuf-gl'}`).

### 4.2 Pipelines (templates; W, H, FPS, KBPS filled in by the runner)

Common head: `pipewiresrc path=<node> do-timestamp=true keepalive-time=500 ! <caps>`.
`keepalive-time` resends the last frame every 500 ms while nothing changes, so a requested IDR
appears within 0.5 s on an idle screen. Common tail:
`… ! video/x-h264,profile=<p>,stream-format=byte-stream,alignment=au ! h264parse config-interval=-1 ! appsink name=out emit-signals=true sync=false max-buffers=4 drop=false`
(SPS/PPS precede every IDR).

| Path | Middle |
| --- | --- |
| nvenc / dmabuf-gl | `video/x-raw(memory:DMABuf),width=W,height=H ! glupload ! glcolorconvert ! video/x-raw(memory:GLMemory),format=NV12 ! nvh264enc name=enc preset=p1 tune=ultra-low-latency zerolatency=true bframes=0 gop-size=-1 rc-mode=cbr bitrate=KBPS vbv-buffer-size=KBPS/FPS aud=false` (profile high) |
| nvenc / shm-cuda | `video/x-raw,width=W,height=H ! cudaupload ! cudaconvertscale ! video/x-raw(memory:CUDAMemory),format=NV12 ! nvh264enc …same…` |
| vaapi | `video/x-raw(memory:DMABuf),width=W,height=H ! vapostproc ! video/x-raw(memory:VAMemory),format=NV12 ! vah264lpenc rate-control=cbr bitrate=KBPS key-int-max=0 b-frames=0 target-usage=7` (fall back to `vah264enc` when lp is missing) |
| x264 | `video/x-raw,width=W,height=H ! videoconvert n-threads=4 ! video/x-raw,format=I420 ! x264enc speed-preset=ultrafast tune=zerolatency bitrate=KBPS key-int-max=0 bframes=0 sliced-threads=true byte-stream=true` (profile constrained-baseline) |

- **Skip gate.** A buffer probe on the encoder's sink pad returns `DROP` while flow control asks to
  skip frames (§5.6). Raw frames are dropped; encoded ones never are.
- **IDR on demand:** `GstVideo.video_event_new_upstream_force_key_unit(all_headers=True)` sent to the
  encoder's src pad. Requests are coalesced, at most one per 500 ms.
- **Bitrate changes** at runtime: set `bitrate` on the encoder while PLAYING (x264enc's property is
  mutable in PLAYING; check nvh264enc on 1.28 in t2, and if it does not take effect, rebuild the pipeline as
  for a resize). **fps cap:** `videorate drop-only=true max-rate=FPS` after the caps when
  the cap is below 60.
- **Profile/level:** High (nvenc, vaapi) or Constrained Baseline (x264). The level is whatever the
  encoder writes, and the viewer derives `codec` from the SPS (§5.3), so the host never needs to
  compute it.
- **Timestamps:** the runner stamps each access unit with `CLOCK_MONOTONIC` µs taken when the
  buffer leaves `pipewiresrc` (pad probe) as `captureUs`, and measures `encodeUs` up to `appsink`.

### 4.3 Defaults and limits (`config.appStream`)

```js
appStream: {
  enabled: true, input: true, allowFrom: [],            // gate (§6); in PATCH_BLOCKED
  maxSessions: 4, parkMinutes: 120,
  encoder: 'auto', compositor: 'auto',                  // §4.1, §3.2
  fps: 60, maxWidth: 3840, maxHeight: 2160,
  bitrate: { low: 3000, balanced: 8000, high: 16000, max: 40000 },   // kbit/s; default preset 'balanced'
  clipboard: true, audio: false,
}
```

`'appStream'` joins `PATCH_BLOCKED` in `src/config.js`, so no settings patch or agent `POST config`
can switch it on. Only `POST appstream/enable` from a confirmed human surface can (§6).

### 4.4 macOS

VideoToolbox `VTCompressionSession` (H.264, `RealTime=true`, `AllowFrameReordering=false`,
`MaxKeyFrameInterval=0` with `ForceKeyFrame` on demand, `AverageBitRate`, `ExpectedFrameRate`,
`EnableLowLatencyRateControl` in the encoder specification). The output is converted to Annex-B
(start codes, SPS/PPS before each IDR) in the helper, so the daemon and viewers see the same stream
as from Linux.

---

## 5. Transport and wire protocol (v1)

### 5.1 Path and hops

```
browser ──wss/ws──▶ entry daemon  /api/nodes/<host>/appstream/sessions/<sid>/stream
                     │  (self)  → app-stream hub (WS)  ⇄ runner (Unix socket)
                     └ (peer)   → forwardWs(node, …, 'appstream/sessions/<sid>/stream' + search)
                                   → host daemon /api/local/appstream/sessions/<sid>/stream
```

- `server.js` `onUpgrade` gets two branches modelled on `screen/stream`: `/api/local/appstream/sessions/<sid>/stream`
  (local) and `/api/nodes/<n>/appstream/sessions/<sid>/stream` (self → local, peer → `forwardWs`).
  `forwardWs` already relays binary frames, close codes, `x-rigs-via` and `x-rigs-caller`.
  `perMessageDeflate` stays off (it is ws's default; compressing video is wasted CPU).
- HTTP `/api/nodes/<n>/appstream/*` needs no change: the generic `/api/nodes/<id>/<rest>` forward
  (`server.js` ~1438) already relays it.
- Auth is `authorize()` as for every route: loopback, same-owner tailnet login (including
  `tailscale serve`'s `Tailscale-User-Login`), or the mesh token between daemons. The opaque-origin
  refusal (`yolo.opaqueOriginRefused`) applies to these upgrades unchanged.

### 5.2 Size policy

`sizeFor({viewer, mode, prefs})`, pure. The viewer sends its stage box in CSS px and its DPR.

- `fit: 'window'` (desktop default): `W = round(cssW × min(dpr, 2))`, `H = round(cssH × min(dpr, 2))`.
- `fit: 'fixed'` with `{width, height}` (presets 1280x720, 1600x900, 1920x1080, 2560x1440).
- **Phones default to `fixed` 1280x720**, letterboxed and zoomable, because desktop apps are unusable at
  390 px wide. "Match screen" switches to `window` (portrait 780x1688 and landscape 1688x780 are
  verified).
- Clamp to [640×360, `maxWidth`×`maxHeight`] and to the decoder limits the viewer reported, round
  down to even numbers, and keep at least 16 px per side.

### 5.3 Messages

Every message is a WebSocket message. Text messages are JSON objects with a `type`. Binary messages
are media frames.

**Binary media frame** (little-endian, header length 32; the runner builds it and the daemon only
forwards it):

| Offset | Type | Field |
| --- | --- | --- |
| 0 | u8 | `kind`: 1 = H.264 access unit (Annex-B), 2 = audio packet (Opus), 3 = JPEG frame |
| 1 | u8 | `flags`: bit0 key (IDR), bit1 has SPS/PPS, bit2 discontinuity (decoder must reset), bit3 repeat (keepalive) |
| 2 | u16 | header length (32; readers skip unknown extra bytes) |
| 4 | u32 | `seq` (per session, +1 per encoded frame) |
| 8 | u64 | `captureUs` (host `CLOCK_MONOTONIC`, µs) |
| 16 | u32 | `encodeUs` |
| 20 | u32 | `inputSeq`: the last input batch applied before this frame was captured |
| 24 | u16 | width |
| 26 | u16 | height |
| 28 | u32 | reserved (0) |
| 32 | … | payload |

**Server → viewer (text):**

```js
{type:'hello', v:1, session:'as-1a2b3c4d', node:'magix-system', app:{id, name, icon},
 transport:'h264'|'jpeg', encoder:{name:'nvh264enc', hw:true, path:'dmabuf-gl'},
 width, height, fps, bitrateKbps, role:'controller'|'viewer', input:true|false, clipboard:true|false,
 audio:null|{codec:'opus', rate:48000, channels:2}, viewers:1, serverUs:<monotonic µs>}
{type:'meta', width, height}                      // after a resize; the next frame is an IDR
{type:'status', status:'ok'|'starting'|'encoder-fallback'|'throttled'|'app-not-responding', message}
{type:'role', role:'controller'|'viewer', by?}    // control taken by another viewer, or given back
{type:'clipboard', text}                          // the session's clipboard changed (≤ 1 MB, text only)
{type:'pong', t0, serverUs}                       // answer to ping
{type:'stats', fps, kbps, encodeMsP50, skipped, viewers, encoder}   // every 2 s
{type:'end', reason:'app-exited'|'stopped'|'killed'|'parked-expired'|'host-restart', code?}
{type:'error', status, code, message, fix?}       // then close (5.5)
```

**Viewer → server (text):**

```js
{type:'hello', v:1, caps:{decoders:['webcodecs','mse','jpeg'], maxWidth, maxHeight, touch:bool, secure:bool,
 platform:'mac'|'win'|'linux'|'ios'|'android'}, want:{fit:'window'|'fixed', width, height, dpr, fps, quality}}
{type:'ack', seq, decodeMs?}                       // after each frame is decoded (§5.6)
{type:'keyframe', reason:'join'|'decode-error'|'gap'}
{type:'config', fps?, quality?:'low'|'balanced'|'high'|'max', bitrateKbps?}
{type:'resize', width, height}                     // CSS px × dpr, debounced 250 ms (fit:'window' only)
{type:'in', seq, e:[ …events… ]}                   // one batch per animation frame
{type:'clipboard', text}                           // the viewer pastes: becomes the session clipboard
{type:'ping', t0}                                  // every 1 s
{type:'take-control'} | {type:'stop'}              // stop = DELETE the session (controller only)
```

**Input events** (`e` entries; coordinates are in **stream pixels**, already mapped by the viewer):

```js
{k:'pm', x, y}                 // pointer move (absolute)
{k:'pb', b:0..4, d:1|0}        // button: 0 left, 1 middle, 2 right, 3 back, 4 forward
{k:'pw', dx, dy, mode:'px'|'line'}   // wheel (px: smooth, line: discrete steps)
{k:'kc', c:'KeyA', d:1|0}      // physical key by KeyboardEvent.code
{k:'tx', s:'őű…'}              // text (soft keyboards, IME commit), ≤ 4000 chars
{k:'tc', id, ph:'down'|'move'|'up', x, y}   // touch passthrough (only in touch mode 'native')
{k:'ra'}                       // release everything held (blur, hidden tab, window close)
```

The viewer derives the WebCodecs `codec` string from the first SPS: `avc1.` followed by the hex of
`profile_idc`, `constraint flags` and `level_idc` (bytes 1–3 after the NAL header). It converts each
access unit from Annex-B to length-prefixed form and passes an `avcC` `description`. This works the
same in every WebCodecs implementation, and the MSE muxer shares the converter.

### 5.4 Input semantics (runner side)

- `pm` → `NotifyPointerMotionAbsolute(streamPath, x, y)`. `pb` → `NotifyPointerButton(code, d)` with
  evdev codes `BTN_LEFT 0x110, BTN_MIDDLE 0x112, BTN_RIGHT 0x111, BTN_SIDE 0x113, BTN_EXTRA 0x114`.
- `pw` px → `NotifyPointerAxis(dx, dy, 0)` (finish flag 1 after 150 ms quiet); `line` →
  `NotifyPointerAxisDiscrete(axis, steps)`. Both were verified in spike 1.
- `kc` → `NotifyKeyboardKeycode(evdev, d)` through a fixed table `CODE_TO_EVDEV`
  (`KeyA`→30 … `Enter`→28, `ShiftLeft`→42, `ControlLeft`→29, `AltLeft`→56, `MetaLeft`→125, F1–F12,
  arrows, numpad, `IntlBackslash`→86, …). The table is shared and pure, in `ui/src/app-stream-model.js`
  and its Python mirror. The session's own keymap (Sir's input sources: `us`, `hu+qwerty`) decides
  the characters, as at a real keyboard.
- `tx` → for each character: if the keymap has a keysym for it in the current group, keysym
  down/up (`NotifyKeyboardKeysym`). Otherwise the whole remaining string goes through the **private
  clipboard**: `SetSelection(text/plain;charset=utf-8)` → Ctrl+V. The previous clipboard content is
  restored 1 s later. This was verified with ő/ű (spike 3). The runner never calls `SetKeymap` or
  `SetKeymapLayoutIndex`.
- **Warm-up:** right after `RemoteDesktop.Start` the runner sends one `Shift_L` press/release.
  The first key event of a fresh session is dropped (spike 3).
- **Held state:** the runner tracks pressed keys and buttons and releases them on `ra`, on viewer
  disconnect, on a role change and on stop.
- Touch, mode `native`: `NotifyTouchDown/Motion/Up(streamPath, slot, x, y)` (device type 7
  advertises a touchscreen). The default phone modes are pointer emulation on the viewer (§8.3).
- Rate guard: at most 240 batches/s and 64 events per batch per viewer. Excess moves are coalesced
  to the latest one. An invalid event is dropped and counted in stats; it does not close the socket.

### 5.5 Close codes and errors

As in `screen-stream.js` (`ENDINGS`), plus the codes for sessions:

| Close | status | When |
| --- | --- | --- |
| 4400 | `bad-args` | malformed hello or values |
| 4403 | `appstream-off` / `not-allowed` / `killed` / `control-off` | app streaming off, caller not in `allowFrom`, live viewers ended by a control kill or switch-off (§6), or (desktop/macOS modes) control off |
| 4404 | `no-session` | unknown or ended session id |
| 4409 | `busy` | `maxSessions` reached (on POST: HTTP 409) |
| 4410 | `ended` | app exited, stopped, park expired |
| 4412 | `needs-permission` | macOS TCC grant missing (`fix` included) |
| 4409 / HTTP 409 | `busy-lease` | macOS host: an agent holds the screen-control lease (input refused with a status; a start is refused) |
| 4423 / HTTP 423 | `locked` | macOS host: the Mac's screen is locked (start refused; input refused with a status) |
| 4501 | `unsupported` | host cannot host sessions (§3.2 rule 3, Windows), with the reason |
| 4503 | `host-restart` | the host daemon is restarting; the viewer reconnects with backoff |

The viewer reconnects after 1006/4503 with a 0.5 → 8 s backoff. It never reconnects after
4403/4404/4410/4501.

### 5.6 Backpressure and frame-drop policy

- **Acks.** The viewer acks every frame after decoding it (`{type:'ack', seq}`). For each viewer the
  host knows `inflight = lastSentSeq − lastAckedSeq`. Acks work end to end, so flow control holds
  across `forwardWs` hops, which have no backpressure of their own.
- **Budget** per viewer: `inflight ≤ max(2, ceil(fps × 0.1))` frames **and** `ws.bufferedAmount ≤ 2 MB`.
- **Over budget:** stop sending that viewer anything but keyframes and mark it `needsIdr`. When it
  is back under budget (`inflight == 0`), request a (coalesced) IDR and resume from it. A viewer
  never receives a P-frame whose reference it did not get.
- **Encoder side:** when **every** viewer is over budget, the skip gate drops raw frames before the
  encoder, which saves GPU/CPU and lets the queue drain. With no viewer at all the pipeline is torn
  down (§3.1).
- **Bitrate (AIMD, per session):** on each congestion event, `bitrate × 0.7` (floor 1000 kbit/s,
  `status:'throttled'`). After 5 s without congestion, +10 % up to the preset. The `stats` message
  reports it.
- **Viewer side:** if `decoder.decodeQueueSize > 3` or a frame arrives with a `seq` gap, drop frames
  until the next IDR and send `{type:'keyframe', reason:'gap'}`. On a decode error, `reset()`,
  request a keyframe and wait for one. Render only the newest decoded frame per animation frame and
  `close()` the rest.
- **Several viewers:** one encoder per session. Every viewer gets the same frames, each with its own
  budget. One viewer is the `controller` (the first human viewer). The others are `viewer` (input
  ignored) until they send `take-control`, which moves control (`role` messages to both).

### 5.7 Fallback transports in the browser

1. **WebCodecs** (`isSecureContext && 'VideoDecoder' in window` and
   `VideoDecoder.isConfigSupported({codec, optimizeForLatency:true, hardwareAcceleration:'prefer-hardware'})`) →
   `<canvas>` (2D `drawImage(VideoFrame)`).
2. **MSE**: `ManagedMediaSource ?? MediaSource` with `isTypeSupported('video/mp4; codecs="avc1.…"')`.
   `ui/src/app-stream-mse.js` remuxes Annex-B into fMP4 (init segment `ftyp`+`moov` with `avcC` from
   SPS/PPS; one `moof`+`mdat` per access unit, `baseMediaDecodeTime` from `captureUs`) into a muted,
   `playsinline`, `disableRemotePlayback=true` `<video>`. To keep latency low: `mode='sequence'`;
   when `buffered.end − currentTime > 0.15 s`, jump to `buffered.end − 0.05`; trim everything older
   than 2 s. Expect 100–250 ms more latency than WebCodecs. The viewer says so in the stats.
3. **JPEG** (`want.transport:'jpeg'`): the runner swaps the encoder for `jpegenc quality=70` at ≤ 15 fps,
   with the same header and kind 3, shown in an `<img>` via object URLs. This is the path for a
   browser that has neither of the above.

When the viewer falls back because it is not in a secure context, it shows once: "For hardware
decoding open JARVIS over HTTPS: https://magix-system.tail34565a.ts.net (or run `rigs setup --https`
on this machine)."

### 5.8 Audio (Phase 2, protocol reserved)

The runner creates a per-session null sink while the session lives:
`pw-cli create-node adapter '{ factory.name=support.null-audio-sink node.name=rigs-as-<sid> media.class=Audio/Sink audio.position=[FL FR] }'`.
The app gets `PULSE_SINK`/`PIPEWIRE_NODE` = that sink, so **its sound never plays on the host's
speakers**. This isolation is part of v1, even without audio streaming. Phase 2 captures
`pipewiresrc target-object=rigs-as-<sid> stream-properties=props,stream.capture.sink=true ! audioconvert ! audioresample ! opusenc frame-size=10 bitrate=128000`
into kind-2 frames. The viewer plays them with `AudioDecoder('opus')` → an AudioWorklet jitter buffer
(target 60 ms) and drops audio, not video, when behind. There is no audio on the MSE/JPEG paths.

---

## 6. Access gate

| Action | Isolated session (Linux) | Whole-desktop (Phase 3) | macOS host app (t5) |
| --- | --- | --- | --- |
| Catalog, session list | auth only | auth only | auth only |
| Start session | `appStream.enabled` ∧ caller in `appStream.allowFrom` (empty = all) | control `accessCheck` (enabled, not killed, allowFrom) + `streamReadiness` | control `accessCheck` + `streamReadiness` (`needs-permission` with fix) |
| View (each viewer) | as start; re-checked every 500 ms and on events | `control.accessFor(caller)` every 500 ms, plus `kill`/`change` events (like `createStreamHub`) | same as whole-desktop |
| Input | `appStream.input` ∧ role controller ∧ a viewer socket without an agent `x-rigs-caller` | not offered (view-only) | new `control.inputStream(batch, caller)`: `perform()` with lease (holder = the person), lock check at most every 250 ms, own bucket `maxStreamInputPerMin` (12000), audit only start/end/refusals |
| Stop / DELETE | always allowed | — | always allowed |

- **Why isolated sessions are not under the screen-control switch.** That switch (and its persistent
  kill) protects the person's desktop from agents: screenshots of it and input into it. An isolated
  session never sees or touches that desktop. It is a human remote-app feature, the role Sunshine
  plays today, and `docs/full-access.md` §1 keeps Sunshine outside the control gate ("Remote desktop
  **for humans**… no kill switch"). Coupling the two would make Sir re-enable agent control of his
  desktop just to use his own app on his phone. Both hosts have control off today (§2.6).
- **The kill switch still stops it at once.** `control` `kill` events (`rigs control off`,
  `POST control/kill`, `POST /api/mesh/control/kill`, ⌃⌥⌘⎋, "Stop on every machine") and `change`
  events to `enabled:false` end **every live app-stream viewer and all input within 500 ms**. The
  status is `killed`, close 4403, and it goes to the audit log. Sessions are parked, not killed, so
  no unsaved work is lost. The kill is not persisted for app streaming: a person reopening the
  viewer is a new, deliberate human action. App streaming's own persistent off is below.
- **Own switch, same rules as control.** `POST /api/local/appstream/enable {enabled?, input?, confirm}`:
  switching **on** requires `caller.human === true`, no agent, `via !== 'mcp'` and
  `confirm === <machine name>` (the same check as `control.enable`). Switching off is open to every
  authorized caller, agents included. `POST appstream/kill {reason}` = off + end every viewer + stop
  input, persisted in `RIGS_HOME/appstream-state.json` (`killed {at, by, reason}`). CLI:
  `rigs appstream status|off|sessions|stop <sid>`. There is no CLI `on`, as with `rigs control`.
- **Agents.** No MCP tool sends input to or reads frames from a session. Read-only MCP:
  `appstream_catalog {node}` and `appstream_sessions {node}`. JARVIS opens an app *for Sir* through
  `ui_open {view:'app', node, app}` (§8.4): the UI starts the session and becomes its human viewer.
- **Audit:** `RIGS_HOME/logs/appstream.jsonl` (0600, rotated at 5 MB like `control.jsonl`): `start`,
  `stop`, `end`, `join`, `leave`, `role`, `refused`, `kill`, `enable`, `clipboard` (direction and
  byte count only, never the text) and `input-on/off`. Individual input events are not logged.
- **Announcement:** while an **agent** watches a session (agents may view, never send input), an attention item
  `{key:'appstream:<node>:<sid>', kind:'appstream', title:'FilmCraft on magix-system is being watched by an agent', since (epoch ms), stop:{method:'DELETE', path:'appstream/sessions/<sid>'}}`,
  like control's "JARVIS is watching this screen". Human viewers raise none: every attention item lands in the "agents
  need you" banner, and a person streaming their own app (on a phone, too) must not get it over the stream (t4 finding).
  Human sessions are visible in the audit log, `GET appstream` and the Applications view's Running section.
- `GET /api/local/appstream` reports `{enabled, input, killed, sessions}`, and `mesh_access` (`src/mcp.js`)
  shows that block next to the control status. `src/access.js` needs no new grant on Linux. On macOS the existing
  Screen Recording and Accessibility grants of RIGS Control.app cover t5.

---

## 7. REST and WebSocket API

All routes are under `/api/local/appstream/` on the host and reachable from any machine as
`/api/nodes/<node>/appstream/…`. JSON in and out. Errors use the usual
`{error, code, status, fix?}` with HTTP 400/403/404/409/412/501/503.

| Method | Path | Body / query | Answer |
| --- | --- | --- | --- |
| GET | `appstream` | — | `{node, os, enabled, input, killed, host:{supported, why?, compositor, encoders:[{name, hw, path}], https:bool}, sessions:[…], limits:{maxSessions, maxWidth, maxHeight}}` |
| POST | `appstream/enable` | `{enabled?, input?, confirm}` | the GET answer (§6 rules) |
| POST | `appstream/kill` | `{reason?}` | `{ok, ended:<viewers>}` |
| GET | `appstream/catalog` | `?refresh=1` (rescan; otherwise cached 60 s and on a directory mtime change) | `{node, os, generatedAt, items:[CatalogItem]}` |
| GET | `appstream/catalog/<appId>/icon` | `?size=64\|128\|256` | `image/png` or `image/svg+xml`, `Cache-Control: max-age=86400`, `ETag` |
| GET | `appstream/sessions` | — | `{sessions:[Session]}` |
| POST | `appstream/sessions` | `{app?:<appId>, command?:[argv], files?:[abs paths], mode?:'app'\|'desktop', size?:{width,height}, fit?, fps?, quality?, reuse?:true}` | `201 {session}` (`200` when reused) |
| GET | `appstream/sessions/<sid>` | — | `{session}` |
| DELETE | `appstream/sessions/<sid>` | `?force=1` | `{ok, state}` |
| POST | `appstream/sessions/<sid>/keep` | — | `{parkUntil}` (resets the park timer) |
| WS | `appstream/sessions/<sid>/stream` | query `?t=<viewer-tab-id>` | §5 |

```ts
CatalogItem = { id: string /* ^[\w.+-]{1,200}$: desktop-file id / bundle id / AppID hash */,
  name, generic?, comment?, icon: 'appstream/catalog/<id>/icon' | null,
  source: 'desktop'|'flatpak'|'snap'|'bundle'|'startmenu'|'appx', path /* .desktop/.app/.lnk */,
  categories: string[], terminal: boolean, streamable: boolean, why?: string, running: string[] /* sids */ }
Session = { id, node, app:{id, name, icon}, mode, state, createdAt, lastViewerAt, parkUntil?,
  width, height, fps, encoder:{name, hw, path}, compositor, viewers:[{id, from, who, role, since}],
  exit?:{code, signal, at}, error?:{code, message} }
```

`command` sessions (any argv) are allowed: every authorized caller can already run commands on the
host through RIGS. Their `app` is `{id:'command', name:<argv[0] basename>}`. `files` are passed to
the app as its `%f/%F/%u/%U` arguments.

Daemon ↔ runner socket (`RIGS_HOME/run/appstream/<sid>.sock`). Frames: `u32 length` (little-endian, body
only) + `u8 type` + body. Type 1 is JSON; type 2 is a media frame with the §5.3 header, forwarded byte for byte.
The runner listens and the daemon connects (and reconnects after a restart); the runner sends `ready` on every
connection once the session is up.

- Daemon → runner: `{op:'start-stream', width, height, fps, bitrateKbps, transport, kind, candidates:[{encoder, desc}]}`
  (the daemon builds the pipelines with `pipelineFor`; the runner tries them in order and answers
  `{ev:'stream', encoder, width, height, fps, fallback, fallbackReason}`), `{op:'stop-stream'}`,
  `{op:'resize', width, height}`, `{op:'keyframe'}`, `{op:'bitrate', kbps}`, `{op:'skip', on}`,
  `{op:'input', seq, e}`, `{op:'clipboard-set', text}`, `{op:'release-all'}`, `{op:'stop', force}`.
- Runner → daemon: `{ev:'ready', compositor, display, encoder, width, height}`, `{ev:'meta', width, height}`,
  `{ev:'clipboard', text}`, `{ev:'app-exit', code, signal}`, `{ev:'stats', …}`,
  `{ev:'error', code, message}`, `{ev:'log', line}`.

The daemon starts the runner with
`systemd-run --user --unit rigs-appstream-<sid> --collect -p KillMode=control-group -p TimeoutStopSec=15 --setenv=… python3 …/rigs-appstream-linux.py --session <sid> --socket <path> --state <file>`.
Without systemd (`RIGS_NO_SYSTEMD`, tests), it falls back to a detached `spawnCmd` child with
`setsid`.

---

## 8. UI

### 8.1 Applications in the file browser (`ui/src/files.js`, `ui/src/finder-model.js`)

- A virtual place **`@apps`** (not a filesystem path; `files.js` `navigate()` special-cases it and
  never calls `files?path=` for it). `FAVOURITES` gains `{id:'apps', label:'Applications', icon:'🚀',
  path:'@apps'}` for the machine being browsed.
- **Locations:** under every machine row an indented child row **Applications** (`data-apps-node`)
  goes to `{nodeId, path:'@apps'}`. On offline or no-RIGS machines it is shown greyed and not
  clickable, like the machine row.
- Crumbs: `magix-system › Applications`. Back/forward history stores `@apps` like any path.
  `⌘F`/search filters by name, generic name, comment and categories.
- **View:** the icon grid by default (the existing icon-view styles, 64-px icons from the icon route)
  and list view (Name · Kind/source · Status). Two sections: **Running** (sessions on that host,
  with state, viewers and park countdown, and Reconnect/Stop) and **All applications** (sorted by
  name, natural order).
- Open (double-click, Enter, ⌘↓, the preview's Open button) → `POST appstream/sessions {app,
  fit/size from this tab}` → the stream viewer (§8.2). The preview pane shows icon, name, comment,
  source and path, plus Open and "Open new session". Context menu (`ctx-providers.js`, kind `app`):
  Open · Open new session · Show in folder (navigates to the `.desktop`/`.app` location) · Copy
  launch command.
- **Not streamable** (`streamable:false`): dimmed, with Open disabled and the `why` text as tooltip
  and in the preview. Reasons: "Windows hosting is designed but not built yet", "macOS hosting is
  not available yet" (until t5), "Terminal apps are not streamable yet", "App streaming is off on
  this machine — turn it on in Access & control", "This host needs GNOME/mutter".
- When the host uses the gnome-shell fallback, a one-line hint at the top offers the root step:
  "Install mutter for lighter, fully isolated sessions".
- Phones: the same view in the full-screen file-browser window. The sidebar is the ☰ drawer. Tap
  selects, a second tap opens (the existing double-tap rule).

### 8.2 Stream viewer window (`ui/src/app-stream.js`, pure logic in `ui/src/app-stream-model.js`, MSE muxer `ui/src/app-stream-mse.js`)

- `openAppStream({nodeId, nodeName, sessionId, app})` → `wm.js` `openWindow({key:'appstream:<nodeId>:<sid>',
  title:'<App> — <machine>', icon})`. Opening the same session again raises the window. It docks and
  tiles like any window, is full screen on phones, and the window's disposer closes the socket and
  sends `ra`.
- **Stage:** `<canvas>` (WebCodecs), `<video>` (MSE) or `<img>` (JPEG), `object-fit: contain`,
  letterboxed on black. `touch-action: none`, `user-select: none`; `cursor: none` over the stage on
  desktop (the cursor is embedded in the video).
- **Toolbar** (top on desktop; a bottom bar on phones that auto-hides after 3 s, tap the top edge to
  show it): Quality (Auto·Low·Balanced·High·Max) · FPS (30/60) · Size (Match window · 1280×720 ·
  1920×1080 · Match screen) · ⌨ (phones: soft keyboard) · special keys menu (Esc, Tab, Super,
  Ctrl+Alt+…, F1–F12, arrows; phones) · 📋 Paste · 🖱 touch mode (phones) · ⛶ Full screen
  (desktop/Android: Fullscreen API + `navigator.keyboard.lock()` where available) · 🔒 Pointer lock ·
  📊 Stats · ✋ Take control (viewer role) · ⏹ Stop app (asks first; DELETE).
- **Closing the window disconnects; it does not stop the app.** Toast: "FilmCraft keeps running on
  magix-system — reopen it from Applications."
- **Stats overlay:** fps (decoded/rendered), bitrate, encoder + path, decoder (`webcodecs hw|sw`, `mse`,
  `jpeg`), decode ms p50, RTT (ping), **glass-to-glass** ms p50/p95 and **input-to-photon** ms (§9),
  skipped frames, resolution, role.
- **States:** connecting · starting app · live · reconnecting (backoff) · parked elsewhere (another
  viewer has control) · ended (reason + Reopen) · refused (the error text and `fix`; for
  `appstream-off` a button "Turn on app streaming on <machine>" that opens Access & control, where the
  confirm happens).

### 8.3 Input capture in the viewer

- **Desktop:** pointer events on the stage → stream coordinates (account for letterbox, zoom and
  DPR). Wheel → `pw` (`deltaMode` 0 px, 1 lines, 2 pages = 3 lines). Keys: `keydown`/`keyup` →
  `kc` by `e.code` with `preventDefault()` while the stage has focus, except Cmd+Tab/Alt+Tab and the
  JARVIS global shortcuts given up when "keyboard capture" is off (the default). In full screen with
  `navigator.keyboard.lock()` everything is captured. **Mac viewer → Linux host:** Meta↔Control swap
  (on by default, toggle in ⋯): ⌘C/⌘V/⌘Z behave as Ctrl+C/V/Z on the host, and the Ctrl key becomes
  Super. Blur, `visibilitychange` (hidden) and window close send `ra`.
- **Phones** (`pointerType === 'touch'`), mode **Direct** (default):
  1-finger tap = left click at the point · 1-finger press and hold 500 ms = right click · 1-finger
  drag = left drag · 2-finger drag = wheel · 2-finger pinch = **local zoom** of the stage (1×–4×,
  not sent) · 2-finger tap = right click · double-tap = double click. Mode **Touchpad**: 1-finger
  drag moves the cursor relatively (1.5× acceleration), tap = click, 2-finger tap = right click,
  2-finger drag = wheel. Mode **Native**: touches pass through as `tc` (apps with real touch
  support).
- **Soft keyboard:** ⌨ focuses a hidden `<textarea>` (inside the tap handler, which iOS requires).
  `beforeinput`/`input` (`insertText`, `insertCompositionText` on `compositionend`) → `tx`.
  `deleteContentBackward` → Backspace `kc`, `insertLineBreak` → Enter. The stage moves above the
  keyboard using `visualViewport`. While the keyboard is up the viewer sends no remote resize.
- **Clipboard:** 📋 Paste or Ctrl/⌘+V in the viewer reads `navigator.clipboard.readText()` (secure
  context, user gesture) → `{type:'clipboard', text}`, then sends the paste chord to the host. A
  `clipboard` message from the host is written with `navigator.clipboard.writeText` when allowed.
  Otherwise a toast "Copied on FilmCraft — tap to copy" does it on tap. Sir's own desktop
  clipboard on the host is never involved.

### 8.4 ui_open and voice

- `ui_open {view:'files', node, path:'applications'}`: `NAMED_PLACES` gains `applications: '@apps'`,
  `apps: '@apps'` and `programs: '@apps'`. `resolveTarget`/`nearestExisting` skip `ui/locate` for
  `@apps`. `ui-open-model.js` `uiOpenAction` passes it to `files.js`.
- New view `app` in `UI_VIEWS`: `ui_open {view:'app', node, app:'<id or name>'}` → `validateOpen`
  checks it; the UI (the requesting tab first, as today) runs `POST appstream/sessions {app, reuse:true}`
  and `openAppStream`. "Open FilmCraft on magix-system on my phone" then works by voice without an
  agent ever driving the app.

---

## 9. App catalog sources (`src/app-catalog.js`, pure parsers + per-OS scanners)

**Linux** (`parseDesktopEntry(text)`, `desktopExecArgv(exec, files)`, `catalogItem(entry, path, source)`):

- Directories, in precedence order (earlier ids win): `~/.local/share/applications`,
  `~/.local/share/flatpak/exports/share/applications`,
  `/var/lib/flatpak/exports/share/applications`, `/var/lib/snapd/desktop/applications`, then each
  `$XDG_DATA_DIRS/applications` (default `/usr/local/share:/usr/share`). Subdirectories make ids with
  `-` (spec).
- Keep `Type=Application` only. Skip `NoDisplay=true`, `Hidden=true`, `OnlyShowIn` without GNOME,
  `NotShowIn` with GNOME, and a missing `TryExec`. `Terminal=true` → `streamable:false`, `why`.
- `Name`/`GenericName`/`Comment`: the unlocalized keys (the JARVIS UI is English; localized keys are
  ignored in v1). `Categories` split on `;`. Field codes `%f %F %u %U` take `files`, `%i` → `--icon <Icon>`, `%c` → Name, `%k` → path;
  `%%` → `%`, quoting per the spec.
- Launch: `gio launch <path> [files…]` in the session env, which handles `DBusActivatable=true` on the
  private bus. Fallback: `desktopExecArgv` + `spawn`.
- Source: `flatpak` / `snap` from the directory, else `desktop`. Known single-instance profile apps
  (Firefox, Chromium, Discord, JetBrains IDEs) are marked `note:'may refuse to start while it runs on
  the desktop (profile lock)'`.
- **Icons:** absolute `Icon=` paths are used as they are. Names are looked up in `~/.local/share/icons`,
  `$XDG_DATA_DIRS/icons/{hicolor,Yaru,Adwaita}/{256x256,128x128,scalable,64x64,48x48}/apps/<name>.{png,svg}`,
  then `/usr/share/pixmaps`. SVG is served as is if ≤ 256 kB (`Content-Security-Policy:
  default-src 'none'; style-src 'unsafe-inline'` on the response). PNG is served as is. No raster
  conversion on Linux.
- FilmCraft: id `ai.storyteller.filmcraft`, Exec `"/home/magix/.local/bin/filmcraft" %F`,
  Icon `ai.storyteller.filmcraft`.

**macOS:** `/Applications`, `/Applications/Utilities`, `/System/Applications`,
`/System/Applications/Utilities`, `~/Applications`, one level deep, `*.app`. `Contents/Info.plist`
goes through `plutil -convert json -o - <plist>` into a pure `parseInfoPlist(json)`. Name =
`CFBundleDisplayName || CFBundleName || basename`; id = `CFBundleIdentifier`. Skip `LSUIElement`/
`LSBackgroundOnly` true. Icon: `CFBundleIconFile` (add `.icns`) or `CFBundleIconName` →
`sips -s format png -Z <size> <icns> --out <cache>`, cached in `RIGS_HOME/appstream/icons/<id>-<size>.png`
by icns mtime. `streamable` is false with "macOS hosting is not available yet" until t5 lands,
then true when control is on and the TCC grants are present.

**Windows** (deferred host, catalog only): `.lnk` files under
`%ProgramData%\Microsoft\Windows\Start Menu\Programs` and `%AppData%\Microsoft\Windows\Start Menu\Programs`
(target, arguments and icon through PowerShell `WScript.Shell.CreateShortcut`), plus AppX/MSIX from
`Get-StartApps` (Name, AppID). Icons from `[System.Drawing.Icon]::ExtractAssociatedIcon` → PNG,
cached. All `streamable:false`.

Tests (`test/app-catalog.test.js`) use fixture `.desktop` files (field codes, locale keys, NoDisplay,
TryExec, DBusActivatable, flatpak/snap paths), fixture Info.plist JSON, and the icon lookup over a
temp icon tree.

---

## 10. Per-OS support matrix

| Role | OS / environment | v1 status | Notes |
| --- | --- | --- | --- |
| Host | Ubuntu/GNOME ≥ 45 (Wayland or X11 login), mutter installed | **Required now** (t2) | Isolated sessions, NVENC/VA-API/x264, input, clipboard, resize |
| Host | GNOME without the `mutter` package | **Works** (fallback) | `gnome-shell --headless --mode=rigs-app`; residuals in §3.2 |
| Host | KDE / wlroots / X11-only Linux | `unsupported` | §3.2 rule 3 |
| Host | macOS (Apple silicon/Intel, 12.3+) | **Built** (t5, §16) | Shared-desktop app capture in RIGS Control, control gate + the person's lease, VideoToolbox (low-latency HW) |
| Host | Windows 10/11 | **Designed, deferred** | §3.7; catalog only |
| Host | Linux whole desktop | Phase 3, optional | View-only, control gate |
| Viewer | Chrome/Edge (desktop, Android) | ✓ | WebCodecs in a secure context, else MSE |
| Viewer | Safari macOS | ✓ | WebCodecs (secure context) or MSE |
| Viewer | iOS Safari (iPhone) | ✓ | WebCodecs over `https://…ts.net`, else ManagedMediaSource (`disableRemotePlayback`), else JPEG; no element full screen on iPhone (the window fills the viewport; "Add to Home Screen" for standalone) |
| Viewer | Firefox desktop | ✓ | WebCodecs where present, else MSE |
| Audio | all | Phase 2 | §5.8; app audio already isolated to a null sink in v1 |

---

## 11. Latency and frame-rate targets, and how to measure them

**Targets** (Linux NVENC host, viewer on the same tailnet LAN, WebCodecs):

| Metric | Target | Measured baseline (spikes) |
| --- | --- | --- |
| Capture rate, 1080p, animated content | 60 fps (≥ 55 sustained) | RecordVirtual 59.8 (SHM) / 60.0 (DMA-BUF) |
| Encode time per frame | p95 ≤ 8 ms | 4.9 ms (SHM) / 7.8 ms (DMA-BUF) |
| Session start → first frame | ≤ 1.5 s (+ app start-up time) | compositor 0.22–0.34 s |
| Resize → first frame at new size | ≤ 150 ms | 40–59 ms |
| Glass-to-glass (capture → presented in viewer) | p50 ≤ 50 ms, p95 ≤ 100 ms | to be measured (t6) |
| Input-to-photon (input sent → first frame showing it) | p50 ≤ 80 ms, p95 ≤ 150 ms | injection → app: p50 10.4 ms, p95 16.6 ms |
| Phone (iPhone, Wi-Fi, 1280×720) | 60 fps, glass-to-glass p50 ≤ 80 ms | to be measured (t6) |
| Host CPU per 1080p60 session | compositor ≤ 25 %, runner ≤ 30 % of one core | 7–20 % / 19–23 % |

**How to measure** (all built into the viewer's stats; t6 records the numbers in §15):

- **Clock offset:** `ping {t0}` every second → `pong {t0, serverUs}`. With `t1` the arrival time,
  `offset = serverUs − (t0 + t1)/2` from the sample with the smallest RTT in the last 10 s (NTP-style).
- **Glass-to-glass:** for each presented frame,
  `presentedAtViewer − (captureUs − offset)`. This includes encode, both proxy hops, decode and paint.
  It excludes the compositor's own paint (≤ 1 frame), which `captureUs` starts after.
- **Input-to-photon:** each input batch has `seq`, and each frame carries `inputSeq` (the last batch
  applied before capture). Latency = present time of the first frame with `inputSeq ≥ seq` −
  send time of `seq`. This is an upper bound: it includes the app's reaction and the next damage.
- **Fps / bitrate / decode:** counted in the viewer over 2 s windows; host-side `stats` gives the
  encoder view.
- **Test pattern app** for t6: `scripts/appstream/latency-pattern.py` (GTK4, no cairo dependency;
  draws a frame counter and flips a big square on every click) gives repeatable damage at 60 fps and
  a visible click response. The spikes' `entrylog.py` is the starting point.
- **Real app:** FilmCraft playing its demo timeline (Space), scrubbing, opening menus, typing in a
  title field from the phone (Hungarian characters → the clipboard path).
- **Gate check:** `rigs control off` on the host while streaming. The stream must end within 1 s with
  4403 `killed`; input is refused; the session is parked. `rigs appstream off` → same, and new
  sessions are refused 403.
- **Network blip:** close the viewer's socket (DevTools offline for 3 s). The viewer must reconnect
  with backoff, request an IDR and resume, with no corrupted frames.

---

## 12. Code layout (binding names)

| File | Contents |
| --- | --- |
| `src/app-stream.js` | Host manager: sessions registry, runner supervision (`systemd-run`), reconcile on start, gate (`gateDecision`), WS hub (viewers, roles, acks, budgets, AIMD), REST handlers, audit, announcements, kill/change listeners. Pure exports for tests: `streamSettings`, `sizeFor`, `compositorFor`, `pickEncoder`, `pipelineFor`, `encodeHeader`/`decodeHeader`, `gateDecision`, `flowStep`, `validateInput`, `nextState`, `ENDINGS`. |
| `src/app-catalog.js` | Catalog scanners per OS and pure parsers (§9). |
| `scripts/appstream/rigs-appstream-linux.py` | The per-session runner (Python 3 + PyGObject Gio/GLib/Gst; no extra modules): bus, compositor, ScreenCast/RemoteDesktop, pipelines, input, clipboard, null sink, socket protocol. Reuse the D-Bus code in `scripts/control/rigs-control-linux.py` (`Mutter` class) and the spikes. |
| `scripts/appstream/gnome-shell/rigs-app.json` | The fallback session mode (§3.2). |
| `scripts/control/macos/RigsControl.swift` | t5: `streamApp` op (SCStream + VTCompressionSession) on the helper socket. |
| `src/control.js` | t5 only: `inputStream()` (§6). No other change. |
| `src/server.js` | `appstream/*` local routes, two `onUpgrade` branches, `appStream` in `/api/local/config` reads. |
| `src/config.js` | `appStream` defaults; `'appStream'` in `PATCH_BLOCKED`. |
| `src/mcp.js` | `appstream_catalog`, `appstream_sessions` (read-only). |
| `src/ui-open.js`, `ui/src/ui-open-model.js` | `applications` place, view `app`. |
| `ui/src/files.js`, `ui/src/finder-model.js` | `@apps` place, Locations child rows, apps view. |
| `ui/src/app-stream.js`, `ui/src/app-stream-model.js`, `ui/src/app-stream-mse.js` | Viewer, pure protocol/input/size/flow logic, Annex-B → fMP4. |
| `bin/rigs.js` | `rigs appstream status\|off\|sessions\|stop <sid>`. |
| Tests | `test/app-stream.test.js` (gate, pure helpers, header round trip, flow control, a fake runner over a socket pair, WS through a peer relay), `test/app-catalog.test.js`, `test/app-stream-ui.test.js` (input mapping, gestures, SPS → codec string, AVCC conversion, fMP4 boxes, size policy). |

`AGENTS.md` gets one layout row per new module when it lands, written by the task that adds it.

---

## 13. Implementation plan and notes for t2–t7

- **t2 (Linux host).** Build §3.1–§3.4, §4, §5 host side, §6 (own gate, kill/change listener, audit,
  announcement), §7. Install nothing system-wide. Use the gnome-shell fallback on magix-system today
  and offer the `mutter` root step. Verify against a **scratch daemon** (own `RIGS_HOME`,
  `RIGS_NO_OPENRIG=1`, another port, a checkout outside `~/.rigs/app`) and with **FilmCraft**
  (`ai.storyteller.filmcraft`) as the app, plus the test pattern client. **Acceptance mapping:** the
  brief's "with screen control off, session start and input are refused" becomes "with **app
  streaming** off (`appstream/kill` or `appStream.enabled:false`) start and input are refused with
  the screen-stream error shape (§5.5), and a **control kill** ends live viewers within 1 s". The
  routes are `appstream/…`, not `apps/…` (§0 #10).
- **t3 (catalog + Applications).** §9 and §8.1, §8.4 (`applications` place). Routes
  `appstream/catalog` (the brief's `apps/catalog` collides with App Cloud). macOS items stay
  `streamable:false` until t5.
- **t4 (viewer).** §5 client side, §5.7 fallbacks, §8.2, §8.3. Test on desktop Chrome (macbookpro,
  `http://localhost:4719` = secure), on iPhone Safari (`iphone172`) at `https://magix-system.tail34565a.ts.net`,
  and at 390×844 in a headless browser. Mobile and desktop browsers both have to work (Sir).
- **t5 (macOS host).** §3.6, §4.4, `control.inputStream`. Control is **off** on macbookpro (§2.6). If it
  is still off, report `control-off` precisely; never switch it on or bypass it.
- **t6 (end-to-end).** §11 with FilmCraft (installed; Sir asked for it), including the phone path.
  Write the results into §15.
- **t7 (review).** Check §6 on every path (start, view, input, relay, kill), orphan cleanup (§3.4
  reconcile, units, sockets, NVENC sessions), Sunshine/Moonlight unchanged, and no uinput/real-bus
  use in the runner.

**System packages on Linux hosts:** present on magix-system already: `gstreamer1.0-pipewire`,
`gstreamer1.0-plugins-bad` (nvcodec, va), `gstreamer1.0-gl`, `gstreamer1.0-plugins-ugly` (x264),
`python3-gi`, `gir1.2-gstreamer-1.0`, PipeWire (`pipewire-bin`: `pw-cli`/`pw-dump` for the per-session null sink),
`dbus-daemon`, `systemd-run`, `gnome-shell` ≥ 45. To add through a root step: `mutter` (recommended);
optionally `intel-media-va-driver` for VA-API on Intel. The runner does **not** need `gir1.2-gst-plugins-base-1.0`
(GstVideo): magix-system lacks it, so the force-key-unit event is built by hand. Missing ones are reported in
`GET appstream` (`host.why`, `host.missing`) and by `rigs appstream status` (there is no `rigs doctor`), which also
prints the `apt-get` line.

---

## 14. t2 — Linux host as built (2026-10-21)

`src/app-stream.js`, `scripts/appstream/rigs-appstream-linux.py`, `scripts/appstream/gnome-shell/rigs-app.json`, server routes
and upgrades, `config.appStream`, `rigs appstream`, `test/app-stream.test.js`. Verified on magix-system against a scratch
daemon (own `RIGS_HOME`, port 4797, a copy of the branch outside `~/.rigs/app`), gnome-shell fallback compositor:

| Check | Result |
| --- | --- |
| `POST appstream/sessions {command}` → ready (parked, no viewer) | 0.9 s; unit `rigs-appstream-<sid>`, private bus, `wayland-50`, Xwayland `:2` |
| `POST appstream/sessions {app:'ai.storyteller.filmcraft'}` (catalog id via t3's `findItem`) | 0.9 s; FilmCraft renders; env: `WAYLAND_DISPLAY=wayland-50`, private `DBUS_SESSION_BUS_ADDRESS`, `PULSE_SINK=rigs-as-<sid>`, cgroup = the session unit |
| WS 10 s, 1280x720, NVENC dmabuf-gl | 558 frames, ffprobe `h264 High level 32 1280x720`, 558/558 decodable, first frame 290 ms after connect, 55.6 fps |
| FilmCraft 1920x1080 | ffprobe `h264 High level 42 1920x1080`, all frames decodable (`docs/screenshots/app-stream/t2-filmcraft-nvenc.png`) |
| Resize 1280x720 → 780x1688 → 1920x1080 | new pipeline on the same node, IDR at each size, every frame decodable |
| Input over the WS | click focuses, evdev keys type `rigs`, keysyms type ` t2 ok `, `őű` via the private clipboard + Ctrl+V, right click at the stream position (`docs/screenshots/app-stream/t2-isolated-input-nvenc.png`) |
| Relay: second daemon → `/api/nodes/magix-t2/appstream/sessions/<sid>/stream` | 54 fps, input applied, decodable |
| `appStream.encoder: 'x264'` | hello `x264enc/sw`, Constrained Baseline, decodable |
| `POST control/kill` while streaming | viewer closed 4403 `killed` at once, session parked, app kept running |
| `appstream/kill` | start → 403 `appstream-off`, viewer → 4403; agent `enable` refused; human `enable` with confirm restores |
| Daemon restart | runner unit kept running; new daemon reattached the session (`reconcile`) |
| `DELETE` (FilmCraft ignores SIGTERM) | 10.3 s (10 s grace, then SIGKILL); unit, processes, bus dir, socket, state file and null sink gone |

Encode latency (capture at `pipewiresrc` → `appsink`, 1080p, the GTK test client drawing every frame): **dmabuf-gl**
54 fps, p50 29–31 ms, p95 54–56 ms; **shm-cuda** 41–43 fps, p50 4–5 ms, p95 7–7.5 ms (the SHM copy also slows the
client to ~43 fps). x264 at 720p: p50 3 ms. The order stays dmabuf-gl → shm-cuda (frame rate first, as in §4.1);
dmabuf-gl misses the 8 ms encode target by the GL upload/convert stage, shm-cuda misses the 55 fps target. **t6 picks
the default with glass-to-glass numbers.**

Implementation notes that refine the design:
- Encoders shift PTS (x264enc and nvh264enc add 1000 h), so capture times travel in a FIFO from the encoder's sink pad
  (one in, one out: no B-frames, zero latency) rather than by PTS.
- The encoder skip gate fires only when **every** viewer is over budget (frames in flight / bytes buffered). A viewer
  that only waits for an IDR is not over budget; gating it starved the encoder in the first run.
- A viewer resumes from `needsIdr` only with nothing in flight, and the ack baseline restarts at that IDR.
- The pipeline's first IDR goes out before viewers have their hello, so the daemon asks for a fresh IDR on every
  `stream` event (first frame 290 ms after connect).
- The first pointer motion of a fresh session is dropped as well as the first key (t4): the runner's warm-up also moves
  the pointer to (8, 8) before the app starts (first click on fresh sessions: 0/3 → 3/3 on magix-system).
- Apps launched through `gio launch` (D-Bus-activatable apps, or with `files`) are not tracked for exit; others end the
  session when their process group is gone.
- HTTP refusals carry `code` = the WS `status` (`appstream-off`, `not-allowed`, …); the WS error keeps screen-stream's
  `{type:'error', status, code, message}` with `code: 'off'` for a switched-off host.

Open for later tasks: FilmCraft's timeline playback did not advance inside the headless session (Space toggles the
play button and moves the audio meters, but the program monitor and timecode stay still, and no audio stream is
opened); t6 should look at it with FilmCraft's own logging. The `mutter` root step is reported (`host.hint`), not
yet offered as a button (t3/t4 UI).

## 15. Measured results (filled in by t6)

| Direction | App | Viewer | Decoder | Size | fps | kbit/s | glass-to-glass p50/p95 | input-to-photon p50 | host CPU (comp/runner) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| magix-system → macbookpro | FilmCraft | Chrome | | | | | | | |
| magix-system → iphone172 | FilmCraft | iOS Safari | | | | | | | |
| magix-system → macbookpro | latency-pattern | Chrome | | | | | | | |

## 16. t5 — macOS host as built (2026-10-21)

**What runs where.** The daemon (`src/app-stream.js`, `platform === 'darwin'`) keeps the same session registry, hub,
flow control, audit and REST/WS API as on Linux. There is no per-session runner process: **RIGS Control.app**
(`scripts/control/macos/RigsControl.swift`, helper version 2), which already holds Screen Recording and Accessibility,
serves each session. Its control-socket op `appStream {sid, socket, path, files}` launches the `.app` (or attaches to
it when it is already running), opens `RIGS_HOME/run/appstream/<sid>.sock` (0600, only that path is accepted) and
returns `{pid, launched, name, bundleId}`. From then on the daemon talks to the session over that socket with **the
Linux runner's protocol unchanged** (§7: `start-stream`, `stop-stream`, `keyframe`, `bitrate`, `skip`, `input`,
`resize`, `clipboard-set`, `release-all`, `stop` / `ready`, `stream`, `meta`, `stats`, `clipboard`, `app-exit`,
`error`). Sessions live in the LaunchAgent, so a daemon restart reattaches them (`reconcile()` now also runs on
macOS); with no daemon connected for 10 minutes a session ends itself (the app keeps running). `appStreams` lists the
helper's sessions.

**Capture → encode.** The target window is the app's front ordinary window (CGWindowList, layer 0), followed every
250 ms (move: new `sourceRect`; resize: new output size, a new encoder, `meta` and an IDR; another display: the
stream restarts there; all windows closed or minimized: `error no-window`, and the stream resumes when one appears).
`SCContentFilter(display:including:[the app]:exceptingWindows:[])` + `sourceRect` = the window ∩ its display, so the
app's own menus and sheets over the window are in the picture and other apps' windows are not. NV12 (`420v`, BT.709),
`minimumFrameInterval` = 1/fps, queue depth 5, cursor shown. Output size = the window in pixels (points × backing
scale), fitted into `maxWidth × maxHeight` (config, and the first viewer's decoder limits). **The viewer's size does
not resize the window at start**; only an explicit `resize` from the controller does (below).
VideoToolbox: `EnableLowLatencyRateControl` + `RequireHardwareAcceleratedVideoEncoder` first (the encoder is
`com.apple.videotoolbox.videoencoder.h264.rtvc`), then low-latency without the requirement, then the default encoder.
The low-latency encoder does not answer `UsingHardwareAcceleratedVideoEncoder` (-12900), so `hw` comes from the
specification it was created with. `RealTime`, no frame reordering, ConstrainedHigh (High as fallback), no automatic
keyframes, `ForceKeyFrame` on request, `AverageBitRate` + `DataRateLimits` (1.5× per second), changed live by
`bitrate`. Output is converted to Annex-B with SPS/PPS before every IDR and framed with the §5.3 header (`captureUs`
from the sample's host-clock PTS = the daemon's `hrtime` clock; `encodeUs` up to the encoder output; `inputSeq`).
Frames are numbered as they leave the encoder, so a frame the rate control dropped leaves no `seq` gap. SCK sends
nothing while the window is idle, so a keyframe request re-encodes the last image as an IDR (flag `repeat`) after
120 ms. `skip` drops raw frames before the encoder. JPEG viewers get `VTCreateCGImageFromCVPixelBuffer` → JPEG q70 at
≤ 15 fps (kind 3). hello/stats report `encoder: {name:'h264_videotoolbox', hw, path:'sck-lowlatency'}`.

**Gate (§6, macOS column).** Every check of the Linux host (the `appStream` switch, its kill, `allowFrom`, input only
for the human controller) **plus screen control**, because this is the real desktop:
- *Start*: `control.appStream()` runs control's whole capture gate (enabled, not killed, `allowFrom`, unlocked, helper
  running, Screen Recording) before the helper op, without taking the lease. Refusals: `control-off` (403, "Screen
  control is off on this Mac…"), `needs-permission` (412 with control's `fix`), `locked` (423), `unsupported` (501;
  also when the running RIGS Control is version 1, with the `rigs control helper install` fix). The helper itself
  refuses again without Screen Recording, before it launches or attaches to anything.
- *View*: `control.accessFor(caller)` on join and every 500 ms; `kill`/`change` events end viewers at once (4403
  `killed`). A control kill also unloads RIGS Control (as before), which ends its sessions; the apps keep running.
- *Input, clipboard paste, resize*: per batch `control.inputStream(caller)` (new): the switches and `allowFrom`, the
  screen lease taken/renewed **for the person** (an agent holding it → `busy-lease`; an agent's pointer/key calls get
  `busy` while the person drives), helper + Accessibility, lock re-probed at most every 250 ms, own budget
  `control.maxStreamInputPerMin` (12000), audited in `control.jsonl` as `stream-input` start/end/refused (not per
  batch). Batches run in order per viewer. A refusal is a `status` message to the viewer, shown once per streak.

**Input semantics on the Mac.** Keys (`kc`, mapped with the pure `CODE_TO_MAC` table, Carbon `kVK_*` ANSI positions;
the Mac's own layout decides the characters) and text (`tx`, as Unicode key events, so ő/ű need no clipboard) are
posted **to the app's process only** (`CGEvent.postToPid`). The pointer cannot be: `pm`/`pb`/`pw` are posted at the
global position mapped from the captured rect (HID tap), drags and double clicks included. Before a button press the
app and its window are brought to the front (AX raise + activate, 60 ms). `ra`, a viewer leaving, `stop-stream`, a
daemon disconnect, the ⌃⌥⌘⎋ hotkey and SIGTERM release every held key and button. Touch passthrough (`tc`) has no
macOS equivalent and is ignored (the viewer's pointer emulation works). `resize` sets the window's AX size so the
stream reaches the requested pixels (clamped to the display).

**Limits (macOS genuinely does not isolate these; stated, not worked around).**
1. *Pointer isolation*: remote pointer input moves Sir's real cursor and clicks whatever is at that spot on the real
   desktop. Raising the window first makes that the app in nearly every case; a window that floats above it (an
   always-on-top panel, a notification) can still take the click. Sir's own mouse and the remote one share one cursor.
   Keyboard input is isolated to the app (postToPid); apps that read only HID-level keys (some games) may ignore it.
2. *Shared screen*: the app is on Sir's desktop, visible locally; resizing from the viewer resizes the real window;
   streaming does not work while the screen is locked (start 423, input refused).
3. *Clipboard*: the viewer's paste sets the Mac's real pasteboard (through the input gate). The Mac → viewer direction
   is sent only for copies made while the streamed app is frontmost, so the viewer never gets what Sir copies elsewhere.
4. *Stop*: an app the session launched is asked to quit like ⌘Q (it may save or ask) and given 10 s (`force=1`: force
   quit, 3 s); it is **never killed** after the wait, because on the real desktop that would lose Sir's work. An app
   that was already running when the session attached keeps running. `app-exit` is noticed within 250 ms.
5. *Size and rate*: a full Retina window (3200×2000) encodes in ~15 ms per frame, so it does not reach 60 fps; 1080p
   is ~7 ms. Below ~8 Mbit/s the low-latency rate control drops frames of fully changing content at that size.
6. *TCC*: Screen Recording and Accessibility belong to RIGS Control. **This change rebuilds RIGS Control (new source
   hash) on every Mac when it rolls out; an ad-hoc build's grants are pinned to its cdhash, so Sir has to grant RIGS
   Control again** (JARVIS → Access & control → Grant, as after any helper change).
7. Needs macOS 12.3+ (ScreenCaptureKit); older Macs report `host.why`.

**Verified on macbookpro (2026-10-21; scratch daemon `macbookpro-t5`, port 4795, `RIGS_HOME=~/rigs-scratch-t5/rigs`,
the dev worktree's code; the dev helper "RIGS Control (dev)", bundle id `dev.rigs.control.9720511b`, has no grants).**

| Check | Result |
| --- | --- |
| Helper builds with the Mac's toolchain (Swift 5.6, macOS 12.3 SDK) | `rigs control helper install` → built, version 2, no warnings |
| VideoToolbox path (`node scripts/appstream/mac-encode-check.js`: test pattern → the session's encoder, Annex-B and §5.3 header, no capture) | `h264_videotoolbox`, hw true, low-latency; 1280×720: 90/90 decodable (ffprobe `h264 High level 31`), encode p50 4.8 / p95 7.9 ms; 1920×1080: 90/90, `High level 40`, p50 7.1 / p95 8.9 ms; 3200×2000 at 8 Mbit/s: 90/90, `High level 51`, p50 15.4 ms; IDRs exactly where requested |
| Start from magix-system (`curl` over the tailnet) with screen control **off** | HTTP 403 `{code:'control-off', error:'Screen control is off on this Mac, so its apps cannot be streamed. A person can switch it on in JARVIS → Access & control.'}` |
| Start from magix-system with control on, RIGS Control without Screen Recording | HTTP 412 `needs-permission` + control's `fix` (System Settings URL, "switch on RIGS Control (dev)…") |
| `appStream` op sent straight to the helper without the grant | `needs-permission` before any launch or attach (TextEdit, already open, untouched) |
| Tests | `test/app-stream.test.js` (pure Mac parts; a Mac host with a fake RIGS Control: control-off / needs-permission / old helper starts, VideoToolbox hello at the window's size, Mac key codes, input/resize/paste through `inputStream`, `busy-lease` refusal, a mid-stream TCC loss → 4412 with fix, control off → 4403 within 500 ms, DELETE never signals the app), `test/control.test.js` (`inputStream`, `appStream`) |

**Not verified live: capture of a real app window, input into it, and a viewer on another machine.** The real
macbookpro has screen control **off and killed** (by Sir from the JARVIS panel, 2026-10-20), and the design forbids
working around it; a scratch helper needs a person to grant it Screen Recording + Accessibility. To finish the live
check: grant "RIGS Control (dev)" (`~/rigs-scratch-t5/rigs/bin/RIGS Control.app`) both rights, then
`POST http://macbookpro:4795/api/local/appstream/sessions {app:'com.apple.TextEdit'}` and open the stream from another
machine — or, after the rollout, switch control on for macbookpro, re-grant RIGS Control, and open TextEdit from
Applications in JARVIS on magix-system.

## 17. t7 — independent review against the goal (2026-10-21)

Branch head reviewed: `057c430` plus the fixes below. `npm run build` OK; `npm test`: 1453 tests, 1452 pass, 0 fail,
1 skip.

**Live, magix-system → macbookpro** (scratch host daemon of this branch on magix-system, own `RIGS_HOME` and
`XDG_DATA_DIRS`, reached through an SSH tunnel; scratch viewer daemon on macbookpro; Google Chrome through Playwright):

- `node scripts/appstream-viewer-check.js --state <file>`: 19/19. Applications → RIGS Stream Test Client → viewer;
  WebCodecs; `nvh264enc (hw) dmabuf-gl`; 52 fps, RTT 6.9 ms, 0 dropped; click, wheel and keys reach the app; window
  resize resizes the remote display (1112×622 → 698×446); ⏹ ends the session on the host; phone 390×844: 1280×720
  letterboxed, a tap clicks at the touched point; no console errors.
- FilmCraft from Applications (`docs/screenshots/app-stream/review.png`): 986×552, NVENC dmabuf-gl, encode 4.5 ms,
  RTT 5.9 ms, glass-to-glass p50/p95 22/34 ms (idle UI, 2–4 fps of damage).
- Cleanup: viewer closed → `parked` (runner kept); host daemon restarted → session reattached, same runner pid;
  `DELETE` → no unit, app, headless shell, null sink, socket, state file or private bus dir left.

**Gate and auth, per path.** Every new HTTP route and both WebSocket routes sit behind the same `authorize()` as the
rest of `/api/local` (request handler and `onUpgrade`). Start: `gateDecision` (switch, kill, allowFrom), plus
`control.accessFor` on macOS, refusals audited. Stream: the same gate on join, re-checked every 500 ms; a control kill
or switch-off ends viewers. Input, paste and macOS resize: the input gate (input switch, no agents, controller only;
on macOS `control.inputStream` with the person's lease, lock and rate). Peer proxy: `forwardHttp` and `forwardWs` keep
`x-rigs-caller` and set `x-rigs-via`, so an agent stays an agent on the host. Enable: a human caller with the
machine-name confirm; `appStream` is in `PATCH_BLOCKED`. Icons are looked up by catalog id only (no path from the
request); SVG is served with a CSP and `nosniff`. Existing remote desktop: `screen-stream.js`, `desktop.js`,
`moonlight-hosts.js`, `access.js` and `proxy.js` are unchanged; the `control.js` additions leave
`accessFor(caller)` as it was for its existing callers.

**Fixed in this review**
- `src/app-stream.js`: the app's clipboard went to every viewer. On macOS that is the person's real pasteboard, so an
  agent viewer could read it. It now goes only to human viewers (test in `test/app-stream.test.js`).
- `src/app-stream.js` `reconcile()`: re-parking a reattached session reset `parkUntil`, so every daemon restart
  (auto-update) gave a parked app another `parkMinutes` and it might never be stopped. The deadline it had is kept
  (test).
- `src/ui-open.js`: the `isPathLike` doc comment had slid above `APPS_PLACE`.

**Open items**
1. macOS host: never run live (capture, input, remote viewer). Screen control on macbookpro is off and killed by Sir,
   and RIGS Control needs Screen Recording + Accessibility. Finish as in §16.
2. t6 was closed without results: §15 is still empty. The figures above are the only end-to-end numbers; no
   iPhone run and no input-to-photon measurement.
3. magix-system has no `mutter`, so sessions use the gnome-shell fallback: it registers with GDM and watches the
   person's logind session, and the empty 32-px strip at the top is visible in `review.png`. The root step
   `appstream-mutter` from §3.2 is not built; only `rigs appstream status` prints the `apt-get` line.
4. An app whose minimum size is larger than the virtual monitor is cropped, not fitted: FilmCraft at 986×552 shows its
   left edge cut off (`review.png`). The size policy does not know the app's minimum size.
5. Single-instance apps with a profile lock (Chrome/Chromium, Firefox, …) carry only a catalog note. Not tested: a
   second Chrome may hand its window to the instance on the person's real desktop rather than open in the session.
6. Not built: Windows host (catalog only, `streamable:false`), audio (sound goes to a per-session null sink), the MSE
   fallback of §5.7 (viewers without WebCodecs or a secure context get JPEG; §10 still says "else MSE"), whole-desktop
   mode (Phase 3), and FilmCraft timeline playback in the headless session (§14).
7. Same trust model as screen control: "human" means a request without `x-rigs-caller`. Any authenticated caller may
   start a session (also with a `command` argv, no more than `mesh_exec` already allows) and stop any session.
8. Earlier tasks left scratch copies and captures in `magix-system:~/rigs-scratch` (`appstream-t2`, `appstream-t6`,
   `home-t2*`, `home-t6`, `*.h264`, …): no units or processes, only files, for Sir to delete.
