#!/usr/bin/env python3
"""Live video generator applet: web UI + player for engine.py (LTX-Video 2B on the RTX 4090).

    livevideo/.venv/bin/python livevideo/server.py --port 8211

This process never touches CUDA. On Start it leases VRAM from the GPU overseer (localhost:8195), spawns
engine.py (GPU) and plays the segments it produces to every browser over one WebSocket (JPEG frames, paced on
the server so all viewers and recordings see the same stream). On Stop it releases the lease and keeps the
engine warm for --idle-unload seconds, then ends it so all of its VRAM goes back. The overseer may also unload
it (POST /api/unload) any time it is not generating.
"""
import argparse
import asyncio
import collections
import json
import os
import struct
import sys
import time
import urllib.request
from pathlib import Path

from aiohttp import web

HERE = Path(__file__).resolve().parent
ROOT = Path(os.environ.get("LIVEVIDEO_ROOT") or HERE)  # recordings (api/record) must stay inside it
VENV_PY = HERE / ".venv/bin/python"
LOGS = HERE / "logs"
STOPPED_UNITS = LOGS / "stopped_units.json"
OVERSEER = os.environ.get("GPU_OVERSEER", "http://127.0.0.1:8195")
CLIENT = os.environ.get("GPU_OVERSEER_CLIENT", "live-video")
OLLAMA = os.environ.get("OLLAMA_HOST_URL", "http://127.0.0.1:11434")
RESOLUTIONS = ["1280x704", "960x544", "768x448", "704x480", "512x320"]
MAX_FPS = 24.0
SETTING_KEYS = {"auto_segments", "auto_seconds", "drift_check", "drift_threshold", "prompt_mode"}


def log(msg):
    print(f"[server] {msg}", flush=True)


def jlog(name, row):
    LOGS.mkdir(exist_ok=True)
    with open(LOGS / name, "a") as f:
        f.write(json.dumps(row) + "\n")


def http_json(url, body=None, timeout=10):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


class Overseer:
    def __init__(self, need_mb):
        self.need_mb = need_mb
        self.leased = False
        self.gpu = None

    def _acquire(self, timeout):
        try:
            return http_json(OVERSEER + "/api/acquire", {"client": CLIENT, "need_mb": self.need_mb,
                                                         "timeout": timeout}, timeout=timeout + 15)
        except Exception as e:
            log(f"overseer acquire failed: {e}")
            return None

    def acquire(self):
        """Blocking. Returns (ok, message)."""
        r = self._acquire(20)
        if r is None:
            return True, "overseer unreachable: continuing without a lease"
        if not r.get("ok"):
            free_ollama()  # Ollama's llama-server is not matched by the overseer's client list
            r = self._acquire(100)
        self.leased = bool(r and r.get("ok"))
        if not self.leased:
            return False, f"GPU busy: only {r and r.get('free_mb')} MB free, need {self.need_mb} MB"
        return True, f"lease ok ({r.get('free_mb')} MB free, unloaded {r.get('unloaded') or 'nothing'})"

    def renew(self):
        if self.leased:
            self._acquire(5)

    def release(self):
        if not self.leased:
            return
        self.leased = False
        try:
            http_json(OVERSEER + "/api/release", {"client": CLIENT})
            log("lease released")
        except Exception as e:
            log(f"overseer release failed: {e}")

    def poll(self):
        try:
            st = http_json(OVERSEER + "/api/status", timeout=5)
            g = st["gpu"]
            me = next((c for c in st.get("clients", []) if c["id"] == CLIENT), None)
            self.gpu = dict(used_mb=g["used_mb"], total_mb=g["total_mb"], free_mb=g["free_mb"],
                            held_mb=me and me["held_mb"], lease=bool(me and me["lease"]), registered=me is not None)
        except Exception as e:
            self.gpu = dict(error=str(e))


def free_ollama():
    try:
        ps = http_json(OLLAMA + "/api/ps", timeout=3)
        for m in ps.get("models", []):
            http_json(OLLAMA + "/api/generate", {"model": m["name"], "keep_alive": 0}, timeout=30)
            log(f"unloaded Ollama model {m['name']}")
    except Exception as e:
        log(f"ollama unload skipped: {e}")


class Client:
    def __init__(self, ws):
        self.ws = ws
        self.q = asyncio.Queue(maxsize=4)

    def offer(self, item):
        if self.q.full():  # a slow viewer drops frames instead of delaying everyone
            try:
                self.q.get_nowait()
            except asyncio.QueueEmpty:
                pass
        self.q.put_nowait(item)

    async def pump(self):
        while True:
            item = await self.q.get()
            if isinstance(item, bytes):
                await self.ws.send_bytes(item)
            else:
                await self.ws.send_str(item)


class Live:
    def __init__(self, args):
        self.args = args
        self.overseer = Overseer(args.need_mb)
        self.proc = None
        self.state = "stopped"     # stopped | starting | loading | warming | running | paused | error
        self.detail = ""
        self.prompt = ""
        self.res = RESOLUTIONS[0]
        # prompt_mode: "transition" morphs from the last frame into the new prompt, "cut" starts a fresh scene
        self.settings = dict(auto_segments=6, auto_seconds=0, drift_check=False, drift_threshold=40.0,
                             prompt_mode="transition")
        self.clients = set()
        self.buf = collections.deque()   # (jpeg, meta) waiting to be shown
        self.have_frames = asyncio.Event()
        self.shown = collections.deque(maxlen=240)  # display timestamps
        self.rate = MAX_FPS
        self.gen_fps = None
        self.last_seg = None
        self.last_arrival = 0.0
        self.encoded = None
        self.action = None               # (kind, t) of the last user action awaiting its first frame
        self.latency = None
        self.stalls = 0
        self.played_any = False
        self.recording = None
        self.record_result = None
        self.idle_task = None
        self.stopped_units = []          # services we stopped for the run; restarted on unload
        self.no_viewer_since = time.time()
        self.lock = asyncio.Lock()

    # ------------------------------------------------------------------ engine process
    async def spawn(self):
        py = str(VENV_PY if VENV_PY.exists() else sys.executable)
        env = dict(os.environ, PYTORCH_CUDA_ALLOC_CONF="expandable_segments:True")  # aborted segments fragment VRAM
        self.proc = await asyncio.create_subprocess_exec(py, str(HERE / "engine.py"), stdin=asyncio.subprocess.PIPE,
                                                         stdout=asyncio.subprocess.PIPE, limit=2**26, env=env)
        asyncio.create_task(self.read_engine(self.proc))
        log(f"engine pid {self.proc.pid}")

    async def systemctl(self, *args):
        p = await asyncio.create_subprocess_exec("systemctl", "--user", *args)
        return await p.wait()

    async def pause_units(self):
        """Stop RAM/VRAM-heavy services the user allows us to close while generating (jarvis-voice: ~16 GB RAM)."""
        for unit in self.args.pause_units:
            if unit not in self.stopped_units and await self.systemctl("is-active", "--quiet", unit) == 0:
                await self.systemctl("stop", unit)
                self.stopped_units.append(unit)
                LOGS.mkdir(exist_ok=True)
                STOPPED_UNITS.write_text(json.dumps(self.stopped_units))  # survives a crash: restarted at startup
                log(f"stopped {unit} for the run")

    async def resume_units(self):
        while self.stopped_units:
            unit = self.stopped_units.pop()
            await self.systemctl("start", unit)
            log(f"restarted {unit}")
        STOPPED_UNITS.unlink(missing_ok=True)

    async def tell(self, **cmd):
        if self.proc and self.proc.returncode is None:
            try:
                self.proc.stdin.write((json.dumps(cmd) + "\n").encode())
                await self.proc.stdin.drain()
            except (BrokenPipeError, ConnectionResetError):
                pass

    async def read_engine(self, proc):
        try:
            while True:
                n = struct.unpack(">I", await proc.stdout.readexactly(4))[0]
                h = json.loads(await proc.stdout.readexactly(n))
                payload = await proc.stdout.readexactly(h["size"]) if h["size"] else b""
                self.on_engine(h, payload)
        except (asyncio.IncompleteReadError, ConnectionResetError):
            pass
        code = await proc.wait()
        log(f"engine exited ({code})")
        if proc is self.proc:  # not an unload we asked for
            self.proc = None
            self.buf.clear()
            self.state, self.detail = ("error", f"engine exited with code {code}") if code else ("stopped", "")
            await asyncio.get_running_loop().run_in_executor(None, self.overseer.release)
            await self.resume_units()

    def on_engine(self, h, payload):
        t = h["type"]
        if t == "status":
            st = h["state"]
            if st in ("loading", "warming"):
                self.state, self.detail = st, h.get("detail", "")
            elif st == "ready":
                self.detail = "model ready"
                if self.state in ("loading", "warming"):
                    self.state = "running"
            elif st == "generating" and self.state in ("warming", "loading"):
                self.state = "running"
        elif t == "encoded":
            self.encoded = h
            jlog("events.jsonl", dict(h, t=time.time()))
        elif t == "error":
            self.detail = h["msg"]
            log(f"engine error: {h['msg']}")
            jlog("events.jsonl", dict(h, t=time.time()))
            if h.get("fatal"):
                asyncio.get_running_loop().create_task(self.fail(h["msg"]))
        elif t == "segment":
            if self.state == "paused":
                return  # finished just after Stop
            frames, o = [], 0
            for s in h["sizes"]:
                frames.append(payload[o:o + s])
                o += s
            if h["flush"]:
                self.buf.clear()  # hard cut: drop what is left of the previous scene
            meta = {k: h[k] for k in ("epoch", "seg", "mode", "cause", "flush")}
            for i, f in enumerate(frames):
                self.buf.append((f, dict(meta, first=i == 0)))
            self.have_frames.set()
            self.last_arrival = time.monotonic()
            self.gen_fps = h["gen_fps"] if self.gen_fps is None else 0.7 * self.gen_fps + 0.3 * h["gen_fps"]
            self.last_seg = {k: v for k, v in h.items() if k != "sizes"}
            self.state = "running"
            jlog("segments.jsonl", dict(self.last_seg, buffer_after=len(self.buf),
                                        kb_per_frame=round(len(payload) / max(1, len(frames)) / 1024, 1)))

    # ------------------------------------------------------------------ controls
    async def start(self, prompt, res):
        async with self.lock:
            self.prompt = prompt.strip() or self.prompt
            if res in RESOLUTIONS:
                self.res = res
            if not self.prompt:
                raise web.HTTPBadRequest(text="prompt is empty")
            if self.idle_task:
                self.idle_task.cancel()
                self.idle_task = None
            self.action = ("start", time.monotonic())
            self.state, self.detail = "starting", "asking the GPU overseer for VRAM"
            await self.pause_units()
            ok, msg = await asyncio.get_running_loop().run_in_executor(None, self.overseer.acquire)
            log(msg)
            if not ok:
                self.state, self.detail = "error", msg
                return
            self.detail = msg
            if not self.proc:
                self.state = "loading"
                await self.spawn()
            else:
                self.state = "running"
            await self.tell(cmd="start", prompt=self.prompt, res=self.res, settings=self.settings)

    async def stop(self):
        async with self.lock:
            if self.state in ("stopped", "paused"):
                return
            await self.tell(cmd="pause")
            self.buf.clear()
            self.state, self.detail = "paused", f"lease released; engine stays warm for {self.args.idle_unload} s"
            await asyncio.get_running_loop().run_in_executor(None, self.overseer.release)
            if self.idle_task:
                self.idle_task.cancel()
            self.idle_task = asyncio.create_task(self._idle_unload())

    async def _idle_unload(self):
        await asyncio.sleep(self.args.idle_unload)
        await self.unload("idle")

    async def unload(self, why):
        proc, self.proc = self.proc, None
        self.buf.clear()
        self.state, self.detail = "stopped", f"unloaded ({why})"
        if proc and proc.returncode is None:
            try:
                proc.stdin.write(b'{"cmd": "quit"}\n')
                await proc.stdin.drain()
                await asyncio.wait_for(proc.wait(), 15)
            except Exception:
                proc.kill()
                await proc.wait()
        await asyncio.get_running_loop().run_in_executor(None, self.overseer.release)
        await self.resume_units()
        log(f"engine unloaded ({why})")

    async def fail(self, msg):
        await self.unload("error")
        self.state, self.detail = "error", msg

    async def user(self, kind, **cmd):
        if self.state in ("running", "loading", "warming", "starting"):
            self.action = (kind, time.monotonic())
            await self.tell(**cmd)

    # ------------------------------------------------------------------ player
    def target_rate(self):
        """Pace playback so the buffer lasts until the next segment is expected; never faster than 24 fps."""
        if self.state != "running" or not self.gen_fps or not self.last_seg:
            return MAX_FPS
        lo = max(6.0, 0.75 * min(self.gen_fps, MAX_FPS))
        t_next = self.last_arrival + self.last_seg["gen_s"] + self.last_seg.get("jpeg_s", 0) + 0.6 - time.monotonic()
        r = len(self.buf) / t_next if t_next > 0.4 else lo
        return max(lo, min(MAX_FPS, r))

    async def player(self):
        loop = asyncio.get_running_loop()
        next_t = loop.time()
        while True:
            if not self.buf:
                if self.played_any and self.state == "running":
                    self.stalls += 1
                self.played_any = False
                self.have_frames.clear()
                await self.have_frames.wait()
                next_t = loop.time()
            jpeg, meta = self.buf.popleft()
            now = time.monotonic()
            if meta["first"] and self.action and (meta["flush"] or meta["cause"] == self.action[0]):
                self.latency = dict(kind=self.action[0], s=round(now - self.action[1], 2))
                jlog("events.jsonl", dict(type="latency", **self.latency, t=time.time()))
                self.action = None
            self.played_any = True
            self.shown.append(now)
            for c in list(self.clients):
                c.offer(jpeg)
            if self.recording is not None:
                self.recording["frames"].append((now, jpeg))
            want = self.target_rate()
            self.rate += max(-0.6, min(0.6, want - self.rate))  # glide, so pacing changes are invisible
            next_t += 1.0 / self.rate
            delay = next_t - loop.time()
            if delay < -0.25:
                next_t = loop.time()
            elif delay > 0:
                await asyncio.sleep(delay)

    def play_fps(self):
        now = time.monotonic()
        recent = [t for t in self.shown if now - t <= 2.0]
        if len(recent) < 2 or recent[-1] <= recent[0]:
            return 0.0
        return round((len(recent) - 1) / (recent[-1] - recent[0]), 1)

    # ------------------------------------------------------------------ housekeeping
    def stats(self):
        s = self.last_seg or {}
        rec = self.recording
        return dict(type="stats", state=self.state, detail=self.detail, prompt=self.prompt, res=self.res,
                    play_fps=self.play_fps(), pace_fps=round(self.rate, 1),
                    gen_fps=s.get("gen_fps"), gen_fps_avg=self.gen_fps and round(self.gen_fps, 1),
                    buffer=len(self.buf), seg=s.get("seg"), scene_seg=s.get("scene_seg"), mode=s.get("mode"),
                    cause=s.get("cause"),
                    epoch=s.get("epoch"), drift=s.get("drift"), next_cut=s.get("next_cut"), gen_s=s.get("gen_s"),
                    vram=s.get("vram"), gpu=self.overseer.gpu, lease=self.overseer.leased, latency=self.latency,
                    encode_s=self.encoded and self.encoded["cpu_s"], stalls=self.stalls, viewers=len(self.clients),
                    settings=self.settings, recording=rec and round(rec["until"] - time.monotonic(), 1),
                    record_result=self.record_result)

    async def ticker(self):
        loop = asyncio.get_running_loop()
        n = 0
        while True:
            await asyncio.sleep(0.25)
            n += 1
            await self.tell(cmd="buffer", frames=len(self.buf))
            if n % 2 == 0:
                msg = json.dumps(self.stats())
                for c in list(self.clients):
                    c.offer(msg)
            if n % 8 == 0:
                await loop.run_in_executor(None, self.overseer.poll)
            if n % 2400 == 0 and self.state == "running":  # every 10 min: the overseer's lease TTL is 30 min
                await loop.run_in_executor(None, self.overseer.renew)
            if self.clients:
                self.no_viewer_since = time.time()
            elif self.state == "running" and time.time() - self.no_viewer_since > self.args.no_viewer_stop:
                log("no viewers: stopping")
                await self.stop()
            if self.recording and time.monotonic() >= self.recording["until"]:
                rec, self.recording = self.recording, None
                asyncio.create_task(self.write_recording(rec))

    async def write_recording(self, rec):
        """Re-time the shown frames onto a 24 fps grid (as a viewer saw them) and encode an mp4."""
        frames = rec["frames"]
        if len(frames) < 2:
            self.record_result = dict(ok=False, error="no frames were shown while recording")
            return
        t0, t1 = frames[0][0], frames[-1][0]
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "mjpeg", "-framerate", "24", "-i", "pipe:0",
               "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", str(rec["path"])]
        p = await asyncio.create_subprocess_exec(*cmd, stdin=asyncio.subprocess.PIPE)
        i = 0
        for k in range(int((t1 - t0) * 24) + 1):
            t = t0 + k / 24
            while i + 1 < len(frames) and frames[i + 1][0] <= t:
                i += 1
            p.stdin.write(frames[i][1])
            await p.stdin.drain()
        p.stdin.close()
        code = await p.wait()
        self.record_result = dict(ok=code == 0, path=str(rec["path"].relative_to(ROOT)), seconds=round(t1 - t0, 1),
                                  shown_frames=len(frames), shown_fps=round((len(frames) - 1) / (t1 - t0), 1))
        jlog("events.jsonl", dict(type="recording", **self.record_result, t=time.time()))
        log(f"recording: {self.record_result}")


# ---------------------------------------------------------------------- HTTP
def routes(live: Live):
    r = web.RouteTableDef()

    async def body(req):
        try:
            return await req.json()
        except Exception:
            return {}

    @r.get("/")
    async def index(req):
        return web.FileResponse(HERE / "static/index.html", headers={"Cache-Control": "no-cache"})

    @r.get("/healthz")
    async def healthz(req):
        return web.json_response({"ok": True, "state": live.state})

    @r.get("/api/state")
    async def state(req):
        return web.json_response(live.stats())

    @r.get("/api/busy")
    async def busy(req):  # GPU overseer probe: never unload us mid-generation
        return web.json_response({"busy": live.state in ("starting", "loading", "warming", "running")})

    @r.post("/api/unload")
    async def unload(req):  # GPU overseer asks for our VRAM back
        await live.unload("overseer")
        return web.json_response({"ok": True})

    @r.post("/api/start")
    async def start(req):
        b = await body(req)
        await live.start(b.get("prompt", ""), b.get("res", live.res))
        return web.json_response(live.stats())

    @r.post("/api/stop")
    async def stop(req):
        await live.stop()
        return web.json_response(live.stats())

    @r.post("/api/cut")
    async def cut(req):
        await live.user("cut", cmd="cut")
        return web.json_response(live.stats())

    @r.post("/api/prompt")
    async def prompt(req):
        b = await body(req)
        p = (b.get("prompt") or "").strip()
        mode = b.get("mode") or live.settings["prompt_mode"]
        if p and p != live.prompt:
            live.prompt = p
            await live.user("transition" if mode == "transition" else "prompt", cmd="prompt", prompt=p, mode=mode)
        return web.json_response(live.stats())

    @r.post("/api/res")
    async def res(req):
        v = (await body(req)).get("res")
        if v not in RESOLUTIONS:
            raise web.HTTPBadRequest(text=f"res must be one of {RESOLUTIONS}")
        if v != live.res:
            live.res = v
            await live.user("res", cmd="res", res=v)
        return web.json_response(live.stats())

    @r.post("/api/settings")
    async def settings(req):
        b = await body(req)
        live.settings.update({k: v for k, v in b.items() if k in SETTING_KEYS})
        await live.tell(cmd="settings", **live.settings)
        return web.json_response(live.stats())

    @r.post("/api/record")
    async def record(req):
        b = await body(req)
        path = (ROOT / (b.get("path") or "docs/samples/live.mp4")).resolve()
        if ROOT not in path.parents or path.suffix != ".mp4":
            raise web.HTTPBadRequest(text="path must be an .mp4 inside the project")
        path.parent.mkdir(parents=True, exist_ok=True)
        secs = float(b.get("seconds") or 30)
        live.record_result = None
        live.recording = dict(path=path, until=time.monotonic() + secs, frames=[])
        return web.json_response({"recording": str(path.relative_to(ROOT)), "seconds": secs})

    @r.get("/ws")
    async def ws(req):
        sock = web.WebSocketResponse(heartbeat=20)
        await sock.prepare(req)
        c = Client(sock)
        live.clients.add(c)
        c.offer(json.dumps(live.stats()))
        pump = asyncio.create_task(c.pump())
        try:
            async for _ in sock:  # control goes over HTTP; the socket only carries frames and stats
                pass
        finally:
            live.clients.discard(c)
            pump.cancel()
        return sock

    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8211)
    ap.add_argument("--need-mb", type=int, default=16500, help="VRAM to lease (1280x704 peaks at 14.4 GB)")
    ap.add_argument("--idle-unload", type=int, default=60, help="seconds after Stop before the engine exits")
    ap.add_argument("--pause-units", type=lambda v: [u for u in v.split(",") if u], default=["jarvis-voice.service"],
                    help="systemd --user units to stop while the engine is loaded (comma list, '' for none)")
    ap.add_argument("--no-viewer-stop", type=int, default=120, help="stop generating after this long unwatched")
    args = ap.parse_args()
    live = Live(args)
    app = web.Application()
    app.add_routes(routes(live))

    async def on_start(app):
        if STOPPED_UNITS.exists():  # a previous run died while it had services stopped
            live.stopped_units = json.loads(STOPPED_UNITS.read_text())
            await live.resume_units()
        app["tasks"] = [asyncio.create_task(live.player()), asyncio.create_task(live.ticker())]

    async def on_cleanup(app):
        await live.unload("shutdown")

    app.on_startup.append(on_start)
    app.on_cleanup.append(on_cleanup)
    log(f"listening on http://{args.host}:{args.port}")
    web.run_app(app, host=args.host, port=args.port, print=None)


if __name__ == "__main__":
    main()
