# Home Security — architecture and API contract

App Cloud app `home-security` ("Home Security", icon 📹). It finds every webcam on every RIGS machine and the IP
cameras on each machine's LAN, records them with motion detection and pre-roll, and shows a live grid. A timeline
scrolls every camera back in sync, an event library holds the motion clips, and old footage is deleted once a GB or
day limit is reached.

This document is the contract for tasks t2 (discovery + ingest), t3 (motion, recording, timeline, retention), t4 (UI)
and t5 (publish). If you change a route, a field or a file location, change it here in the same commit.

## 0. Where it lives

| Path | Owner | What |
| --- | --- | --- |
| `apps/home-security/server.js` | t1 stub → t2 | HTTP server: `createServer()` export, routing, mesh fan-out, process lifecycle |
| `apps/home-security/discovery.js` | t2 | Webcam enumeration per OS, ONVIF WS-Discovery, LAN port probe, subnet selection |
| `apps/home-security/ingest.js` | t2 | One supervised ffmpeg per enabled camera → segments, motion frames, snapshot |
| `apps/home-security/camera-helper.js`, `macos/` | t2 | macOS only: builds/launches `RIGS Camera.app` (the app bundle that holds the camera permission; ffmpeg runs inside it), authorization status, the "Grant camera access" action |
| `apps/home-security/motion.js` | t3 | Pure frame-diff scoring + event state machine |
| `apps/home-security/recorder.js` | t3 | Segment indexing, events (pre/post-roll windows, thumbnails, clips), timeline queries |
| `apps/home-security/retention.js` | t3 | Victim selection (pure) + deletion confined to the data dir |
| `apps/home-security/store.js` | t3 | `node:sqlite` index, `settings.json`, `cameras.json`, `secrets.json` (atomic writes) |
| `apps/home-security/public/**` | t4 | The UI: static files, relative URLs only, vendored `hls.js` |
| `apps/home-security/rigs-home-security.service.tmpl` | t1 → t5 | Linux `systemctl --user` unit template |
| `test/home-security*.test.js` | t1, t7 | Tests. Root `npm test` runs them. |

It lives in `apps/home-security/`, not `applets/`, because every task brief of this project names that path. Otherwise
it follows the applet conventions (`applets/vertex-cow` is the smallest example): plain Node ESM, **no npm dependencies
and no build step**, run from the RIGS checkout that every machine already has (`~/.rigs/app`). The UI is static files.
Third-party browser code (only `hls.js`, Apache-2.0) is vendored into `public/vendor/` and never loaded from a CDN.
`package.json` exists for `npm start` / `npm test` convenience and declares no dependencies.

Env: `PORT` (default **8749**), `HOST` (default `127.0.0.1`; never `0.0.0.0`, because only the RIGS proxy may reach
it), `HOME_SECURITY_DATA` (default `<RIGS_HOME or ~/.rigs>/home-security`), `RIGS_PORT` (default 4719, the local
daemon), `FFMPEG` / `FFPROBE` (default: found on PATH), `HOME_SECURITY_TEST_CAMERA=1` (development/integration:
discovery adds a `test-pattern` camera, `kind: "test"`, that ffmpeg generates with `lavfi testsrc2`).

`server.js` exports `createApp({ background })` → `{ server, start(), close(), ready, registry, manager, … }` and
`createServer()` (= `createApp().server`). Only `createApp({ background: true })` + `start()` (the CLI entry) runs
discovery, ingest and the recorder's timers; tests get the HTTP surface without touching cameras or the network.

## 1. Process model — one instance per node, aggregated through the RIGS proxy

**Every node that has cameras runs its own instance**, from the same code in its RIGS checkout. It owns:
- the webcams plugged into that machine (USB/built-in devices can only be opened locally);
- the IP cameras on that machine's own LAN(s) (often only routable from there);
- its own recordings, index, settings and retention on its own disk.

**Reads are aggregated server-side over loopback, media goes browser → owning node directly, writes go to the owner.**

- `GET api/cameras`, `api/events` and `api/timeline*` take `scope=mesh` (the default) or `scope=local`. With `mesh`,
  the instance lists its peers from the local daemon (`GET http://127.0.0.1:$RIGS_PORT/api/apps`: entries with
  `id === 'home-security'` and another `node`). It then calls each one through the daemon's peer proxy
  `http://127.0.0.1:$RIGS_PORT/api/nodes/<node>/apps/home-security/<same path>?scope=local&…`, with a 3 s timeout
  per peer, all in parallel. It merges the results with its own. Loopback is authorized by the daemon
  (`src/auth.js`), so the app holds no mesh token. A fan-out call **always** sends `scope=local`, so instances
  never recurse.
- Every item in a merged response carries `node` (machine name) and `base`: the relative URL from the app root to the
  instance that owns it. That is `"./"` for this node and `"../../../<node>/apps/home-security/"` for a peer. The
  page is served at `/api/nodes/<self>/apps/home-security/` and `../../../` climbs to `/api/nodes/`. The UI resolves
  `new URL(item.base + path, appRootUrl)` for **all media** (HLS playlists, segments, snapshots, MJPEG, thumbnails,
  clips) and for **all writes** (PATCH a camera, delete an event, change that node's settings). Video therefore
  travels owner daemon → browser's daemon → browser. It is never relayed through a third instance.
- A peer that times out or errors appears in `nodes[]` with `online: false` and an `error`. Its items are missing
  and nothing fails.
- When the app is opened directly (`http://127.0.0.1:8749/`, no `X-Forwarded-Prefix` header), peers are listed with
  `base: null` (not reachable from this page). The UI greys them out. This path is for development only.

Why not the alternatives:
- *One central recorder pulling every camera over the tailnet* would stream every camera across the mesh 24/7. It
  can't open other machines' USB webcams, and one machine going down stops all recording.
- *A UI that only talks to the daemon's `/api/apps` and fans out in the browser* would couple the UI to daemon paths
  and lose a single mesh-wide API that curl, agents and the t2 acceptance check can call.

The browser gets the node list, and each instance gets its own name, from the daemon: `GET /api/self` → `{ id, name }`
over loopback, cached; that call fails when the daemon is down, and the instance then falls back to `os.hostname()`.

## 2. Camera discovery (t2)

Discovery runs at startup, then on schedule (§7 `discovery`), and on `POST api/discovery/scan`. It never runs in the
request path. Results go to `cameras.json`. A rediscovered camera updates `lastSeenAt` and keeps its user settings
(name, enabled, motion, zones).

### Webcams
| OS | Enumerate | Stable id / open |
| --- | --- | --- |
| macOS | `ffmpeg -hide_banner -f avfoundation -list_devices true -i ""` (stderr). Take the "AVFoundation video devices" block and **drop `Capture screen N`** entries. | id `webcam-<slug(name)>`. Open by name (`-i "<name>:none"`); the index can change between boots. |
| Linux | `/sys/class/video4linux/video*`: keep nodes whose `index` file is `0` (the others are UVC metadata nodes). Read `name` from sysfs. Optionally confirm with `ffmpeg -f v4l2 -list_formats all -i /dev/videoN`. | Prefer the `/dev/v4l/by-id/*` symlink that resolves to the node, else `/dev/videoN`. id `webcam-<slug(by-id or name)>`. |
| Windows | `ffmpeg -hide_banner -f dshow -list_devices true -i dummy` (stderr): `"<name>" (video)` lines and their `Alternative name "@device_pnp_…"`. | Open by the alternative name (`-i video="@device_pnp_…"`), which is stable across same-name devices. id `webcam-<slug(name)>`. |

The device-list parsers are pure functions over ffmpeg's stderr text, with captured fixtures in the tests. Known
gotchas that t2 must handle and report:
- **macOS camera permission (TCC) — the RIGS Camera helper.** macOS shows the camera Allow prompt, and lists an app
  under Privacy & Security › Camera, only for an app bundle with `NSCameraUsageDescription`. A bare `node` with an
  `ffmpeg` child is neither, so it never gets the prompt and ffmpeg just waits for frames forever (seen on
  macbookpro). On macOS every webcam therefore runs as a child of **`~/.rigs/bin/RIGS Camera.app`**
  (`apps/home-security/macos/`: `RigsCamera.swift`, `Info.plist`, `build.sh`; module `camera-helper.js`), bundle id
  `dev.rigs.camera` (a scratch `RIGS_HOME` gets `dev.rigs.camera.<hash8>`, so it never touches the real grant). The app
  builds it with `swiftc` + an ad-hoc `codesign` the first time it needs it, and only again when the sources change
  (an ad-hoc signature pins the grant to the build, so a rebuild resets this app's camera entry and needs a new Allow).
  The helper is started through LaunchServices (`open -W -n -g -j -a … --args run --dir D --cwd C --parent PID -- ffmpeg …`),
  which makes it its own responsible process; it asks for camera access if undecided (the Allow prompt), then runs
  ffmpeg with stderr in `D/ffmpeg.log`, `D/pid.json` `{helper, child}`, `D/auth.json` `{status, at}` and `D/exit.json`
  `{code, signal}`. ffmpeg is not our direct child there, so its motion frames go to a unix socket
  (`-f rawvideo unix:<data>/run/m-<hash>.sock`, `-nostdin`) and a stop is `SIGTERM` to the helper (ffmpeg gets `SIGINT`).
  Without Xcode's command line tools (no `swiftc`) the camera falls back to the bare ffmpeg and says so.
  The camera's `status` is **`needs-permission`** (never `error`, never a restart loop) with
  `error: "waiting for camera permission — click Allow on the Mac, or enable “RIGS Camera” in System Settings › Privacy & Security › Camera"`
  while the prompt is up, a "switch it on in System Settings" text when it is denied (re-checked every 15 s), and a
  Screen Time/MDM text when restricted. `GET api/camera-access` returns `{ supported, status: authorized | notDetermined | denied | restricted | helper-unavailable | unsupported, message, helper, node }`;
  `POST api/camera-access/grant` raises the prompt (`status: "prompting"`) or, when denied, opens System Settings › Camera
  (`openedSettings`). The UI offers it as "Grant camera access" in Settings and on the camera tile.
- Linux v4l2 devices are exclusive. A device busy in another app is reported as `error: "device busy"` and retried
  with backoff.

### IP cameras
Only on **this node's LAN subnets**. Selection is a pure, unit-tested `localSubnets(os.networkInterfaces(), settings)`:
- IPv4, non-internal interfaces only;
- **excluded**: `100.64.0.0/10` (Tailscale/CGNAT), `127.0.0.0/8`, `169.254.0.0/16`, `224.0.0.0/4`, and interfaces
  named `/^(tailscale|utun|docker|br-|veth|virbr|vboxnet|vmnet|zt|wg|lo)/i`, plus `discovery.excludeCidrs`;
- a prefix shorter than /24 is clamped to the /24 that holds the node's own address (no /16 sweeps);
- `discovery.extraCidrs` adds subnets by hand (e.g. a camera VLAN). Each must be RFC1918 and /22 or narrower, or it is
  rejected with a 400.

Methods:
1. **ONVIF WS-Discovery.** A SOAP `Probe` for `dn:NetworkVideoTransmitter` sent to `239.255.255.250:3702` from each
   selected interface (`setMulticastInterface`). Collect `ProbeMatch` for 3 s and parse the `EndpointReference`
   address (`urn:uuid:…`), `XAddrs` and `Scopes` (name/hardware). id `onvif-<uuid>`. When credentials are set,
   `GetProfiles` + `GetStreamUri` (WS-Security UsernameToken digest via `node:crypto`) fill in the RTSP URL. Without
   them the camera is `status: "needs-credentials"`.
2. **Port probe** (only on manual scan, or when `discovery.portProbe` is true): TCP connect to `discovery.ports`
   (default `[554, 8554, 80, 8080]`) on every host of the selected subnets, ≤ 64 connects in flight, 400 ms timeout.
   An open 554/8554 is confirmed with an RTSP `OPTIONS` request. Hits become `kind: "rtsp"` candidates with
   `status: "needs-setup"` (stored as `needsSetup: true`, cleared by a PATCH of `url` or credentials), and hosts
   already known via ONVIF are skipped. Open 80/8080 hosts are kept only when the HTTP answer looks like a camera
   (server header/body hints), as `kind: "mjpeg"`. id `ip-<ip>-<port>`.
3. **Manual entry**: `POST api/cameras` with an `rtsp://`, `rtsps://` or `http(s)://` (MJPEG) URL plus
   `username`/`password`. id `manual-<random6>`.

**Credentials stay server-side.** User info is stripped from any URL into `secrets.json` (file mode 0600). They are
written to the API (`username`/`password` fields), never read back. Responses carry the URL without user info and
`hasCredentials: true|false`. ffmpeg needs them in the URL, so every ffmpeg/ffprobe stderr line, error message and log
line passes through `redact()` (`//user:pass@` → `//***@`, `password=` query values → `***`) before it is stored or
returned.

**Same camera seen by two nodes** (two machines on one LAN): every camera has a `fingerprint` (ONVIF uuid, else
`ip:port`). The mesh listing groups them as `seenBy: [node…]` on each copy. Recording happens on whichever node has it
`enabled`. If two have it enabled, the mesh listing marks both `warning: "recorded by 2 nodes"`.

## 3. Ingest and live preview (t2)

**One supervised ffmpeg per enabled camera**, with three outputs from a single decode:

1. **Recording segments**: `-f segment -segment_time <segmentSeconds> -segment_format mpegts -reset_timestamps 1`
   into `segments/<cam>/.incoming/seg-%06d.ts`, with `-segment_list .incoming/list.csv -segment_list_type csv`.
   MPEG-TS works for both HLS live and VOD with no init segment to manage.
   - IP cameras that send H.264: `-c:v copy` (cheap; segments cut on the camera's keyframes, so they are 1–4 s).
     `-rtsp_transport tcp`.
   - Webcams, MJPEG and H.265 sources: H.264 encode. On macOS use `h264_videotoolbox`. Elsewhere use `libx264
     -preset veryfast -tune zerolatency`. Both use `-g <2×fps> -force_key_frames expr:gte(t,n_forced*<segmentSeconds>)`
     and a default 1280×720 at 15 fps (camera `input` overrides). `transcode: "auto"` picks copy vs encode from an
     `ffprobe` of the source.
   - Audio: dropped (`-an`) in v1.
   Node tails `list.csv`. For each completed segment it computes `startMs` = the ffmpeg run's wall-clock start + the
   CSV start time (must stay within ±1 s of real time). It then **moves** the file to
   `segments/<cam>/<YYYY-MM-DD>/<HH>/<startMs>.ts` (day/hour in **UTC**) and hands the row to `recorder.onSegment`
   (§5). The day/hour folders keep directories small.
2. **Motion frames**: `-vf fps=<motion.fps>,scale=<motion.width>:-2,format=gray -f rawvideo pipe:1`. Node reads
   fixed-size gray frames from stdout and passes them to `motion.js` (§4).
3. **Snapshot**: `-vf fps=<live.snapshotFps>,scale=640:-2 -q:v 5 -update 1 -atomic_writing 1
   live/<cam>/latest.jpg`.

**The ring buffer = the segment index.** A camera in `mode: "continuous"` keeps every segment until retention
(§6). In `mode: "motion"`, a trimmer runs every few seconds. It drops segments older than `recording.ringSeconds`
(default 60, never below `preRollSeconds + 2×segmentSeconds`) unless an event window covers them. That way, the
pre-roll is always on disk when motion starts. `mode: "off"` runs no ffmpeg at all.

**Supervision**: the restart backoff is 2 s → ×2 → 60 s max, reset after 5 min healthy. A stall (no new segment for
`3×segmentSeconds + 10 s`) kills and restarts the process. A camera's runtime `status` is one of `idle` (disabled),
`starting`, `recording`, `error` (with redacted `error` text and `retryAt`), `needs-credentials`, `needs-setup`,
`needs-permission` (macOS camera access not granted yet, §2) or `unavailable` (not seen in the last scan). Shutdown (SIGTERM/SIGINT, and the HTTP server closing) writes `q` to each
ffmpeg's stdin, then kills after 5 s. ffmpeg pids are written to `run/ffmpeg.json`. At startup, any recorded pid that
is still alive and is an ffmpeg is killed, so a crash leaves no orphans.

**No ffmpeg**: the server still starts. `/healthz` reports `ffmpeg.found: false`, every camera is `error: "ffmpeg not
found"`, discovery skips webcams but still does ONVIF/port probe, and the UI shows how to install it.

**Live preview** (relative URLs, served by the owning node):
- `api/cameras/<id>/live.m3u8` is generated by Node from the index, not by ffmpeg's HLS muxer. It is a sliding window
  of the last `live.hlsWindowSegments` (default 6) segments with `#EXT-X-PROGRAM-DATE-TIME` and segment URIs
  `seg/<startMs>.ts`, relative to the playlist. The proxy does not rewrite `.m3u8`, so the URIs must be relative.
  Latency is about 2–3 segments. It is built from the ingest worker's in-memory ring of recent segments (so media
  sequence numbers are stable); because of `-reset_timestamps 1` every segment boundary carries
  `#EXT-X-DISCONTINUITY` and the header `#EXT-X-DISCONTINUITY-SEQUENCE`, like t3's VOD playlists.
- `api/cameras/<id>/snapshot.jpg`: the latest frame. Grid posters and a fallback.
- `api/cameras/<id>/live.mjpeg`: `multipart/x-mixed-replace` of `latest.jpg` at `snapshotFps`. The fallback for a
  browser with neither native HLS nor MSE.
- The UI plays HLS natively when `video.canPlayType('application/vnd.apple.mpegurl')` (Safari/iOS), otherwise with
  the vendored `hls.js`.

## 4. Motion detection (t3)

Pure `motion.js`, fed gray frames `W×H` (default 160 wide at 5 fps):

- **Background**: an exponential moving average per pixel (α = 0.05). The first 2 s after a (re)start only build the
  background.
- **Changed pixel**: `|frame − background| > pixelThreshold`, where `pixelThreshold = round(70 − 0.6 × sensitivity)`
  (sensitivity 1–100, default 50 → 40).
- **Zones**: polygons in normalized `[0..1]` coordinates, rasterized once to a mask at the frame size.
  `include` zones (if any) limit detection to their area, and `exclude` zones are always removed. No zones = the
  whole frame.
- **Score** = changed pixels in the mask / mask pixels, in `[0, 1]`. Motion when `score ≥ areaThreshold`, with
  `areaThreshold = 0.002 + 0.05 × (100 − sensitivity) / 100` (default 0.027). A frame with `score > 0.8` counts as a
  lighting change and is ignored (no event; the background resets).
- **Event state machine**: `idle` → motion sustained for `motion.minDurationMs` (default 500) → `active`, with
  `startMs` = the first frame over threshold → no motion for `recording.postRollSeconds` → `closed`, with `endMs` =
  the last frame over threshold. Motion while active extends the event. An event longer than
  `motion.maxEventSeconds` (default 600) is closed and a new one opened at once.
- **Clip window** = `[startMs − preRollSeconds·1000, endMs + postRollSeconds·1000]`. While an event is active its
  window is open-ended. Segments that overlap a window are protected (§6).
- **Thumbnail**: the `latest.jpg` at the moment of peak score is copied to `events/<id>/thumb.jpg`.

Everything above that is not I/O (EMA, threshold math, mask rasterization, the state machine, window math) is pure and
unit-tested on synthetic frames.

## 5. Storage layout (t3)

All on the node's local disk, under `HOME_SECURITY_DATA`. It is **never in the RIGS shared folder**, which syncs to
every machine and would copy every GB of video around the mesh.

```
<data>/
  settings.json        node settings (§7), atomic write (tmp + rename)
  cameras.json         camera list incl. user settings, NO credentials
  secrets.json         { <cameraId>: { username, password } }, mode 0600
  index.sqlite         segment + event index (node:sqlite, WAL)
  segments/<cam>/<YYYY-MM-DD>/<HH>/<startMs>.ts
  segments/<cam>/.incoming/          ffmpeg's working dir (seg-*.ts, list.csv)
  events/<eventId>/thumb.jpg
  events/<eventId>/clip.mp4          built on demand (concat, -c copy), cache; deletable any time
  live/<cam>/latest.jpg
  run/ffmpeg.json                    pids of running ffmpeg children
  logs/<cam>.log                     redacted ffmpeg stderr, rotated at 1 MB
```

**Index: `node:sqlite`** (built into Node ≥ 22.13; RIGS requires ≥ 22.19, so no native build on any OS). JSON can't
hold it: 2 s segments × 30 days ≈ 1.3 M rows per camera. The `ExperimentalWarning` Node prints is expected; the
server silences only that one warning (a `process.emitWarning` filter for `SQLite`). Schema:

```sql
CREATE TABLE segments (
  id INTEGER PRIMARY KEY, camera TEXT NOT NULL, start_ms INTEGER NOT NULL, dur_ms INTEGER NOT NULL,
  path TEXT NOT NULL,               -- relative to <data>, forward slashes
  bytes INTEGER NOT NULL);
CREATE INDEX segments_cam_start ON segments(camera, start_ms);
CREATE INDEX segments_start ON segments(start_ms);
CREATE TABLE events (
  id TEXT PRIMARY KEY,              -- '<cam>-<startMs>'
  camera TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER,   -- NULL while active
  clip_from_ms INTEGER NOT NULL, clip_to_ms INTEGER,                  -- NULL while active
  peak_score REAL NOT NULL, frames INTEGER NOT NULL DEFAULT 0,
  zones TEXT,                       -- JSON array of zone names that fired
  locked INTEGER NOT NULL DEFAULT 0, reviewed INTEGER NOT NULL DEFAULT 0, note TEXT,
  created_ms INTEGER NOT NULL);
CREATE INDEX events_start ON events(start_ms);
CREATE INDEX events_cam_start ON events(camera, start_ms);
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);   -- schema version
```

At startup, `.incoming/` leftovers whose segments never made it into the index are indexed if complete or deleted, and
index rows whose file is missing are dropped. This reconciliation keeps the index and the disk in step after a crash.

### Module wiring (t2 ↔ t3)

`store.js`: `await openStore(dataDir)` → index + `getSettings()/patchSettings()`; standalone `loadSettings`, `loadCameras`,
`saveCameras`, `loadSecrets`, `saveSecrets` (0600), `writeJsonAtomic`, `DEFAULT_SETTINGS`.
`recorder.js`: `await createRecorder({ dataDir, store?, getCamera?, node?, emit?(type, data), log? })` →
`{ onSegment({ camera, startMs, durMs, path, bytes }), onFrame({ camera, frame, width, height, t }), stopCamera(camera),
liveSegments(camera, n), segmentPath(camera, startMs), handle(req, res, url, ctx) → bool, runRetention(), storage(), trim(),
close() }`. ingest moves finished segments into place and calls `onSegment`; `handle` serves every t3 route in §8 and
takes `ctx = { self: { node, base }, fanout?(pathWithQuery) → [{ node, base, online, version?, error?, body }],
onSettingsChanged?(next, prev) }` (no `fanout` = local only). `emit` carries the SSE `motion` and `event`
(`{ type: 'opened'|'closed', event }`) messages. The recorder runs its own retention timer and the motion-mode ring trimmer.

## 6. Retention (t3)

Runs every `retention.intervalMinutes` (default 5), after every closed event, and on `POST api/storage/retention/run`.
Victim selection is a pure function: `selectVictims({ segments, events, now, settings, usage })` → `{ segments[],
events[] }`. Deletion then removes exactly those, oldest first:

1. **Age, footage**: segments with `start_ms + dur_ms < now − maxDays` that no kept event window covers.
2. **Age, events**: events with `end_ms < now − eventMaxDays` (default 30) that are not `locked`, plus the segments only
   they covered.
3. **Size**: while `total > maxGB` or free disk `< minFreeGB` (default 2), delete in this order: unprotected segments
   (continuous footage) oldest first across all cameras; then unlocked events oldest first with their segments; then
   clip/thumbnail caches. **Events win over continuous footage.** Locked events are never deleted automatically. If
   only locked events are left over the limit, `api/storage` reports `overLimit: true` and the UI warns.

A segment is *protected* when it overlaps any kept event's clip window on the same camera (an active event counts as
open to now). The `maxDays` default is 14 and `maxGB` is 50.

**Never outside the data dir**: every delete goes through one `safeRemove(rel)` that resolves
`fs.realpathSync(path.join(data, rel))`. It refuses (and logs) anything that is not inside `realpath(data)/segments/`
or `realpath(data)/events/`, including through symlinks. Empty hour/day folders are pruned the same way. This is
unit-tested with `../` and symlink escapes.

## 7. Settings and camera schema

`GET api/settings` returns this (defaults shown). `PATCH api/settings` deep-merges a partial object, validates it,
and answers `400 { error, errors: [ "retention.maxGB must be a number ≥ 1", … ] }` or `200 <full settings>`. Changes
take effect without a restart: ingest workers restart only for the cameras a change affects. Settings are **per
node**, and the UI edits each node's settings at its `base`.

```jsonc
{
  "version": 1,
  "recording": {
    "defaultMode": "continuous",      // continuous | motion | off — a camera's mode, when it has none of its own
    "segmentSeconds": 2,              // 1–10
    "preRollSeconds": 10,             // 0–60
    "postRollSeconds": 10,            // 0–120
    "ringSeconds": 60                 // motion mode only; clamped to ≥ preRoll + 2×segment
  },
  "motion": {
    "enabled": true,
    "sensitivity": 50,                // 1–100
    "minDurationMs": 500,             // 0–10000
    "maxEventSeconds": 600,           // 30–3600
    "fps": 5,                         // 1–15
    "width": 160                      // 64–640
  },
  "retention": {
    "maxGB": 50,                      // ≥ 1
    "maxDays": 14,                    // ≥ 1, continuous footage
    "eventMaxDays": 30,               // ≥ maxDays
    "minFreeGB": 2,                   // ≥ 0
    "intervalMinutes": 5              // 1–60
  },
  "discovery": {
    "onvif": true,
    "intervalMinutes": 60,            // 0 = only at start and on demand
    "portProbe": false,               // include the port probe in scheduled scans
    "ports": [554, 8554, 80, 8080],
    "excludeCidrs": [],
    "extraCidrs": []                  // RFC1918, /22 or narrower
  },
  "live": { "hlsWindowSegments": 6, "snapshotFps": 1 },
  "ffmpeg": { "path": "", "hwaccel": "auto" }   // path "" = PATH lookup; hwaccel auto | none
}
```

A **camera** as the API returns it. `cameras.json` stores the same fields minus the runtime ones (`status`, `error`,
`retryAt`, `node`, `base`, `seenBy`, `warning`):

```jsonc
{
  "id": "onvif-2b7a…",
  "name": "Front door",
  "kind": "webcam | onvif | rtsp | mjpeg",
  "source": { "device": "FaceTime HD Camera", "url": "rtsp://192.168.1.40:554/stream1", "onvif": { "xaddr": "http://192.168.1.40/onvif/device_service", "uuid": "2b7a…" } },
  "fingerprint": "onvif:2b7a…",
  "hasCredentials": true,
  "enabled": false,                    // nothing records until the user selects it
  "mode": null,                        // null = settings.recording.defaultMode
  "transcode": "auto",                 // auto | copy | h264
  "input": { "width": 1280, "height": 720, "fps": 15 },   // webcams / encode only, optional
  "motion": { "enabled": true, "sensitivity": null, "zones": [ { "name": "porch", "mode": "include", "points": [[0.1,0.5],[0.9,0.5],[0.9,1],[0.1,1]] } ] },
  "discoveredAt": 1793892000000, "lastSeenAt": 1793892000000,
  "status": "recording", "error": null, "retryAt": null,
  "node": "macbookpro", "base": "./", "seenBy": ["macbookpro"]
}
```

`source.url` never contains user info. `motion.sensitivity: null` inherits the node setting.

## 8. REST API

All paths are **relative to the app root** (`/api/nodes/<node>/apps/home-security/`): the server routes on
`/healthz`, `/api/...`, and static files from `public/`. Bodies are JSON (`content-type: application/json`), times are
**epoch milliseconds**, and errors are `{ "error": "…" }` with a 4xx/5xx status. `scope` defaults to `mesh` where it is
listed. Merged responses add `nodes: [{ node, base, online, version?, error? }]` and tag each item with `node` and
`base`. Media and write routes always act on the node that answers them.

| Method | Path | Owner | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `healthz` | t1/t2 | — | `200 { ok: true, app: "home-security", version, node, ffmpeg: { found, path, version }, storage: { dataDir, usedBytes, freeBytes, maxBytes }, cameras: { total, enabled, recording, failing } }`. Always 200 while the server is up; problems are fields, not a 5xx. |
| GET | `api/status` | t2 | — | healthz body + `workers: [{ camera, status, pid, since, restarts, error }]`, `discovery: <api/discovery>` |
| GET | `api/mesh` | t2 | — | `{ self, nodes: [{ node, base, online, version, error? }] }` |
| GET | `api/camera-access` | t2 | — | `{ supported, status, message, helper: { bundleId, name, app, problem }, node }`; macOS camera authorization of the RIGS Camera helper (§2). `supported: false` off macOS. |
| POST | `api/camera-access/grant` | t2 | — | `{ ok, status, message, openedSettings? }`: undecided → raises the Allow prompt (`status: "prompting"`); denied → opens System Settings › Camera. |
| GET | `api/cameras` | t2 | `?scope=mesh\|local` | `{ nodes, cameras: [Camera] }` |
| POST | `api/cameras` | t2 | `{ name, url, username?, password?, transcode? }` | `201 Camera` (manual). `400` for a bad scheme or URL. |
| GET | `api/cameras/:id` | t2 | — | `Camera` |
| PATCH | `api/cameras/:id` | t2/t3 | any of `{ name, enabled, mode, transcode, input, motion, username, password, url }` | `200 Camera`; `enabled` starts/stops ingest; `username`/`password` are write-only (`""` clears them) |
| DELETE | `api/cameras/:id` | t2 | `?purge=1` also deletes its footage and events | `204`. A discovered camera that is seen again comes back disabled. |
| POST | `api/cameras/:id/test` | t2 | — | `{ ok, codec, width, height, fps, error? }` (ffprobe with the stored credentials; error text redacted) |
| GET | `api/discovery` | t2 | — | `{ running, startedAt, finishedAt, subnets: ["192.168.1.0/24"], found: { webcam, onvif, rtsp }, errors: [] }` |
| POST | `api/discovery/scan` | t2 | `{ webcams?: true, onvif?: true, portProbe?: false }` | `202 <api/discovery>`; `409` if a scan is running |
| GET | `api/cameras/:id/live.m3u8` | t2 | — | HLS live playlist (relative `seg/…` URIs) |
| GET | `api/cameras/:id/seg/:startMs.ts` | t2 | `Range` honoured | `video/mp2t` |
| GET | `api/cameras/:id/snapshot.jpg` | t2 | — | `image/jpeg`, `cache-control: no-store`; `404` before the first frame |
| GET | `api/cameras/:id/live.mjpeg` | t2 | — | `multipart/x-mixed-replace` stream |
| GET | `api/timeline` | t3 | `?from&to[&scope]` (max 7 days) | `{ nodes, cameras: [{ camera, node, base, spans: [{ from, to }], events: [{ id, start, end, peak }] }] }`. Spans are merged; a gap is any hole > 1.5 × the segment length. |
| GET | `api/timeline/at` | t3 | `?t[&scope]` | `{ t, nodes, cameras: [{ camera, node, base, segment: { url, start, dur } \| null, offsetMs, gap: bool, nextStart \| null }] }`. `url` is relative to `base`. |
| GET | `api/cameras/:id/vod.m3u8` | t3 | `?from&to` (max 6 h) | HLS VOD playlist: `#EXT-X-PLAYLIST-TYPE:VOD`, `#EXT-X-PROGRAM-DATE-TIME` on every segment, `#EXT-X-DISCONTINUITY` before every segment after the first (segments are cut with `-reset_timestamps 1`, so PTS restarts at each one; gaps are covered too), relative `seg/…` URIs |
| GET | `api/events` | t3 | `?camera&node&from&to&reviewed&locked&limit(≤200, default 50)&before[&scope]` | `{ nodes, events: [Event], next: <before cursor> \| null }`, newest first |
| GET | `api/events/:id` | t3 | — | `Event` |
| GET | `api/events/:id/thumb.jpg` | t3 | — | `image/jpeg` |
| GET | `api/events/:id/clip.m3u8` | t3 | — | VOD playlist of the clip window |
| GET | `api/events/:id/clip.mp4` | t3 | — | `video/mp4`, `content-disposition: attachment`, built on the first request and cached |
| PATCH | `api/events/:id` | t3 | `{ locked?, reviewed?, note? }` | `200 Event` |
| DELETE | `api/events/:id` | t3 | — | `204`: removes the event, thumbnail and clip cache. Its segments then fall under normal retention (and the ring trimmer in motion mode). |
| GET | `api/settings` | t3 | — | Settings (§7) |
| PATCH | `api/settings` | t3 | partial Settings | `200` Settings, or `400 { error, errors[] }` |
| GET | `api/storage` | t3 | — | `{ dataDir, totalBytes, segmentsBytes, eventsBytes, freeBytes, maxBytes, oldestMs, overLimit, cameras: { <id>: bytes } }` |
| POST | `api/storage/retention/run` | t3 | — | `{ before: <api/storage>, after: <api/storage>, deleted: { segments, events, bytes } }` |
| GET | `api/stream` | t2/t3 | — | Server-Sent Events, local only: `camera` (status change), `motion` (`{ camera, score }` at most 2/s), `event` (opened/closed), `discovery`. The UI opens one per node `base`. |

**Event** = `{ id, camera, cameraName, node, base, start, end | null, clipFrom, clipTo | null, peak, zones: [],
locked, reviewed, note, thumb: "api/events/<id>/thumb.jpg", clip: "api/events/<id>/clip.m3u8",
download: "api/events/<id>/clip.mp4" }`. The three URLs are relative to `base`.

Static: everything else under the root is served from `public/` (`index.html` at `/`), with a path-escape guard as in
`applets/vertex-cow/server.js`. The UI must not use a single root-relative (`/…`) or absolute URL. The proxy shim
would catch most, but the contract is relative URLs only, and t4 checks this with a grep.

## 9. Resident: keepAlive and starting at boot

A recorder that the janitor stops after 30 idle minutes, or that only starts when someone opens it, is no security
system. Two parts:

1. **Register with `"keepAlive": true`** (`mesh_app_register` / `POST /api/local/apps`). `src/janitor.js` then never
   stops it (`apps.isKeepAlive` → `idleVictims` `keep`), and on Linux `apps.js` `launch` runs
   `systemctl --user enable --now` for the unit, so it starts at boot. The filed `app-publish` tool does **not** pass
   `keepAlive` or per-OS recipes, so t5 registers directly with `mesh_app_register`.
2. **macOS and Windows have no boot start for a `command` recipe.** Today only JARVIS's voice app is revived when it
   goes down (`src/tts.js` `startVoiceKeeper` → `reviveVoice` → `wakeApp`, which is already generic: it takes any app
   ref and is rate-limited to once a minute). **t5 adds a general resident keeper** in the daemon. On every health
   change of this machine's apps, and every 30 s, it calls `wakeApp(id)` for each local app with `keepAlive: true`
   whose health is `down` (excluding the voice app, which keeps its own keeper). The daemon itself starts at login on
   every OS, so every resident app comes back after a reboot or a crash. This is a small change in
   `src/server.js`/`src/apps.js` with a unit test, and needs a one-line row in AGENTS.md (`src/janitor.js` /
   `src/apps.js`).

The Linux unit uses `Restart=always`. On Linux, booting without a login session also needs `loginctl enable-linger
<user>` (a root step via `src/rootsteps.js`, if not already set). t5 checks it with `loginctl show-user $USER -p
Linger` and reports it rather than changing it.

## 10. Launch recipe per OS (t5 registers it)

Port **8749** on every node. `cwd` is the node's RIGS checkout (default `~/.rigs/app`). t5 takes the real path from
that node rather than assuming it (`mesh_exec`: `rigs` prints it, or the daemon's working directory).

```json
{
  "id": "home-security", "name": "Home Security", "icon": "📹", "port": 8749, "healthPath": "/healthz",
  "keepAlive": true, "startupGraceMs": 60000,
  "description": "Webcams on every RIGS machine and IP cameras on their LANs: live grid, motion events with pre-roll, multi-camera timeline, event library, GB/day retention.",
  "tags": ["security", "cameras", "cctv", "motion", "video"],
  "launch": {
    "linux":   { "systemd": "rigs-home-security.service" },
    "darwin":  { "command": "node apps/home-security/server.js", "cwd": "~/.rigs/app", "env": { "PORT": "8749" } },
    "windows": { "command": "node apps\\home-security\\server.js", "cwd": "~\\.rigs\\app", "env": { "PORT": "8749" } }
  }
}
```

The Linux unit comes from `apps/home-security/rigs-home-security.service.tmpl` (placeholders `{{INSTALL_DIR}}`,
`{{NODE}}`, `{{PORT}}`) and is installed at `~/.config/systemd/user/rigs-home-security.service`.
`KillMode=mixed` lets the server stop its ffmpeg children itself before systemd kills what is left.

Register it on **every node that should record** (each owns its webcams and LAN cameras). Any one instance's UI shows
the whole mesh (§1).

## 11. Security checklist (t6 verifies)

- Binds `127.0.0.1` only. The RIGS proxy (tailnet identity / mesh token) is the only way in.
- No credential in any response, log, error, SSE message or ffmpeg log (`redact()`, plus a test that greps responses
  for the test password).
- Discovery never touches `100.64.0.0/10`, loopback, link-local, docker/VPN interfaces or anything but the node's own
  /24-clamped LANs and explicit `extraCidrs` (unit-tested).
- Retention and `DELETE … ?purge=1` delete only through `safeRemove` inside `data/segments` and `data/events`
  (unit-tested).
- One ffmpeg per enabled camera at most. Children are stopped on shutdown, and orphans are killed at startup.
- Relative URLs only in `public/`. Playlists use relative URIs.
- Missing ffmpeg degrades (`/healthz` 200 with `ffmpeg.found: false`) and never crash-loops.
