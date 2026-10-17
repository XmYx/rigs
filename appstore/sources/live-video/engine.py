#!/usr/bin/env python3
"""Live LTX-Video engine: one GPU process, driven by server.py over stdin/stdout.

    T5-XXL on the CPU (text_encoder.py, separate process)  ->  prompt embeddings
    LTX-Video 2B 0.9.6 distilled, transformer compiled once  ->  97-frame segments, 8 steps
    full LTX VAE decode (no TAE exists for this latent space, see bench/RESULTS.md)

The first segment of a scene is text-to-video. Each later segment is image-to-video conditioned on the last
frame(s) of the previous one, until the prompt changes, the user cuts, the resolution changes, or the automatic
scene-change trigger fires (segment count, duration, or a pixel-drift threshold).

Protocol. stdin: one JSON command per line (start, prompt, cut, res, settings, pause, buffer, quit).
stdout: frames of [4-byte big-endian header length][JSON header][payload]; header["size"] is the payload length.
A segment's payload is its JPEG frames back to back, header["sizes"] their lengths. Library noise on stdout is
redirected to stderr (the systemd journal).
"""
import json
import os
import queue
import random
import struct
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

PROTO = os.fdopen(os.dup(1), "wb", buffering=0)
os.dup2(2, 1)  # anything else printed goes to stderr

import cv2  # noqa: E402
import numpy as np  # noqa: E402
import torch  # noqa: E402

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

HF = Path.home() / ".cache/huggingface/hub/models--Lightricks--LTX-Video/snapshots"
BF16 = torch.bfloat16
CHECKPOINT = "ltxv-2b-0.9.6-distilled-04-25.safetensors"
FPS = 24
# 0.9.6 distilled timestep schedules (bench/models.py); the 4-step one is a measured option, not the default
TIMESTEPS = {8: [1000, 993, 987, 981, 975, 909, 725, 0.03], 4: [1000, 993, 909, 725]}
RESOLUTIONS = ["1280x704", "960x544", "768x448", "704x480", "512x320"]  # the benchmarked ones
USER_CAUSES = {"start", "prompt", "cut", "res"}

DEFAULTS = dict(
    frames=97,             # frames per segment (8n+1)
    steps=8,
    cond_frames=1,         # frames of the previous segment an i2v continuation is conditioned on (1 or 8n+1)
    auto_segments=6,       # fresh text-to-video after this many segments in one scene (0 = off)
    auto_seconds=0,        # ... or after this many seconds of scene (0 = off)
    drift_check=False,     # ... or when the last frame drifts this far from the scene's first frame
    drift_threshold=40.0,  # mean abs difference of 32x18 thumbnails, 0-255
    jpeg_quality=85,
    max_ahead=120,         # do not start a continuation while the player holds more frames than this
)

_wlock = threading.Lock()


def send(header, payload=b""):
    header = dict(header, size=len(payload))
    h = json.dumps(header).encode()
    with _wlock:
        PROTO.write(struct.pack(">I", len(h)) + h + payload)


def status(state, **kw):
    send({"type": "status", "state": state, **kw})


def log(msg):
    print(f"[engine] {msg}", file=sys.stderr, flush=True)


def vram():
    free, total = torch.cuda.mem_get_info()
    return dict(alloc_gb=round(torch.cuda.memory_allocated() / 2**30, 2),
                peak_gb=round(torch.cuda.max_memory_allocated() / 2**30, 2),
                reserved_gb=round(torch.cuda.memory_reserved() / 2**30, 2),
                device_used_gb=round((total - free) / 2**30, 2), device_total_gb=round(total / 2**30, 2))


class Abort(Exception):
    pass


class TextEncoder:
    """Owns the CPU encoder process; encode() returns at once and calls back when the embedding is ready."""

    def __init__(self, repo):
        import multiprocessing as mp
        ctx = mp.get_context("spawn")
        self.req, self.resp = ctx.Queue(), ctx.Queue()
        threads = max(4, (os.cpu_count() or 8) - 6)
        old = os.environ.get("CUDA_VISIBLE_DEVICES")
        os.environ["CUDA_VISIBLE_DEVICES"] = ""  # the child can never create a CUDA context
        try:
            from text_encoder import serve
            self.proc = ctx.Process(target=serve, args=(str(repo), self.req, self.resp, threads), daemon=True)
            self.proc.start()
        finally:
            if old is None:
                os.environ.pop("CUDA_VISIBLE_DEVICES")
            else:
                os.environ["CUDA_VISIBLE_DEVICES"] = old
        self.ready = threading.Event()
        self.cache = {}
        self.callbacks = {}
        self.n = 0
        self.lock = threading.Lock()
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        while True:
            rid, prompt, emb, mask, info = self.resp.get()
            if rid == "ready":
                self.ready.set()
                log(f"text encoder ready (pid {self.proc.pid}, CPU)")
                continue
            with self.lock:
                cb = self.callbacks.pop(rid, None)
                if emb is not None:
                    self.cache[prompt] = (emb, mask)
                    while len(self.cache) > 16:
                        self.cache.pop(next(iter(self.cache)))
            if cb:
                cb(prompt, None if emb is None else (emb, mask), info)

    def encode(self, prompt, cb):
        with self.lock:
            hit = self.cache.get(prompt)
            if hit is None:
                self.n += 1
                self.callbacks[self.n] = cb
                self.req.put((self.n, prompt))
                return
        cb(prompt, hit, 0.0)

    def close(self):
        try:
            self.req.put(None)
            self.proc.join(5)
        finally:
            if self.proc.is_alive():
                self.proc.kill()


class Engine:
    def __init__(self):
        self.repo = next(iter(sorted(HF.glob("*"))))
        self.settings = dict(DEFAULTS)
        self.lock = threading.Condition()  # RLock-based: helpers may re-enter it
        self.running = False
        self.res = RESOLUTIONS[0]
        self.prompt = ""
        self.cond = None          # (emb, mask) of the prompt being generated
        self.fresh = None         # pending fresh-scene request: dict(cause, cond, res); cond None = still encoding
        self.transition = False   # next continuation uses a new prompt, still conditioned on the last frame
        self.abort = threading.Event()
        self.buffer_frames = 0
        self.last = None          # last frames of the previous segment (numpy RGB) for i2v
        self.epoch = 0
        self.seg = 0
        self.scene = None         # dict(segments, t0, thumb)
        self.warmed = set()
        self.out_q = queue.Queue(maxsize=3)
        self.jpeg_pool = ThreadPoolExecutor(8)
        self.text = None
        self.text_created = threading.Event()
        self.pipe = None

    # ---------------------------------------------------------------- loading
    def load(self):
        from diffusers import (AutoencoderKLLTXVideo, FlowMatchEulerDiscreteScheduler, LTXConditionPipeline,
                               LTXVideoTransformer3DModel)
        from huggingface_hub import hf_hub_download
        status("loading", detail="loading LTX-Video 2B to the GPU")
        t = time.perf_counter()
        ckpt = hf_hub_download("Lightricks/LTX-Video", CHECKPOINT)
        tr = LTXVideoTransformer3DModel.from_single_file(ckpt, torch_dtype=BF16)
        vae = AutoencoderKLLTXVideo.from_single_file(ckpt, torch_dtype=BF16)
        sched = FlowMatchEulerDiscreteScheduler.from_pretrained(
            f"{self.repo}/scheduler", use_dynamic_shifting=False, shift=1.0, shift_terminal=None)
        self.pipe = LTXConditionPipeline(scheduler=sched, vae=vae, text_encoder=None, tokenizer=None,
                                         transformer=tr)
        self.pipe.to("cuda")
        self.pipe.set_progress_bar_config(disable=True)
        self.vae = vae
        torch._dynamo.config.cache_size_limit = 64  # t2v + i2v graphs for every resolution
        tr.compile(dynamic=False)
        log(f"model on GPU in {time.perf_counter() - t:.1f}s, {vram()}")
        # the encoder loads after the checkpoint has left CPU RAM (this box has little to spare)
        self.text = TextEncoder(self.repo)
        self.text_created.set()

    def warm(self, res):
        if res in self.warmed:
            return
        w, h = map(int, res.split("x"))
        status("warming", detail=f"compiling for {res} (first time ~30-60 s)", res=res)
        dummy = (torch.zeros(1, 256, 4096, dtype=BF16), torch.ones(1, 256, dtype=torch.long))
        t = time.perf_counter()
        frames = self.decode(self.generate(dummy, w, h, None, abortable=False))
        self.generate(dummy, w, h, frames[-self.settings["cond_frames"]:].cpu().numpy(), abortable=False)
        torch.cuda.synchronize()
        self.warmed.add(res)
        log(f"warmed {res} in {time.perf_counter() - t:.1f}s")

    # ---------------------------------------------------------------- generation
    def _check_abort(self, pipe, i, t, kw):
        if self.abort.is_set():
            raise Abort()
        return {}

    @torch.inference_mode()
    def generate(self, cond, w, h, prev, abortable=True):
        from PIL import Image
        emb, mask = cond
        kw = {}
        if prev is not None:
            imgs = [Image.fromarray(f) for f in prev]
            if len(imgs) == 1:
                kw.update(image=imgs[0], frame_index=0, strength=1.0)
            else:
                kw.update(video=imgs, frame_index=0, strength=1.0)
        if abortable:
            kw["callback_on_step_end"] = self._check_abort
        s = self.settings
        out = self.pipe(prompt_embeds=emb.cuda(), prompt_attention_mask=mask.cuda(), height=h, width=w,
                        num_frames=s["frames"], frame_rate=FPS, guidance_scale=1.0,
                        timesteps=TIMESTEPS[s["steps"]], image_cond_noise_scale=0.025,
                        generator=torch.Generator("cuda").manual_seed(random.randrange(2**31)),
                        output_type="latent", **kw)
        return out.frames

    @torch.inference_mode()
    def decode(self, latents):
        p, v = self.pipe, self.vae
        lat = p._denormalize_latents(latents, v.latents_mean, v.latents_std, v.config.scaling_factor).to(BF16)
        ts = None
        if v.config.timestep_conditioning:
            lat = 0.975 * lat + 0.025 * torch.randn_like(lat)
            ts = torch.tensor([0.05], device=lat.device, dtype=lat.dtype)
        video = v.decode(lat, ts, return_dict=False)[0]
        return ((video[0].float().clamp(-1, 1) + 1) * 127.5).round().to(torch.uint8).permute(1, 2, 3, 0)

    # ---------------------------------------------------------------- commands (stdin thread)
    def request_fresh(self, cause, cond=None, res=None):
        with self.lock:
            self.fresh = dict(cause=cause, cond=cond if cond is not None else self.cond, res=res or self.res)
            self.abort.set()
            self.lock.notify_all()

    def on_prompt(self, prompt, cause):
        """Encode on the CPU; the GPU keeps generating the old prompt until the embedding is ready, then cuts."""
        t = time.perf_counter()
        before = torch.cuda.memory_reserved()

        def done(p, cond, info):
            if cond is None:
                send({"type": "error", "msg": f"text encoding failed: {info}"})
                return
            send({"type": "encoded", "prompt": p, "cpu_s": round(info, 2), "wait_s": round(time.perf_counter() - t, 2),
                  "gpu_reserved_before_gb": round(before / 2**30, 2),
                  "gpu_reserved_after_gb": round(torch.cuda.memory_reserved() / 2**30, 2),
                  "encoder_pid": self.text.proc.pid})
            with self.lock:
                if p != self.prompt:  # superseded by a newer edit while encoding
                    return
                if self.fresh and self.fresh["cond"] is None:
                    self.fresh["cond"] = cond
                    self.lock.notify_all()
                elif cause == "transition" and self.last is not None and not self.fresh:
                    # no abort: the segment in flight finishes, the next one morphs from its last frame
                    self.cond, self.transition = cond, True
                    self.lock.notify_all()
                else:
                    self.request_fresh("prompt" if cause == "transition" else cause, cond=cond)

        def submit():  # a prompt can arrive while the model is still loading, before the encoder exists
            self.text_created.wait()
            self.text.encode(prompt, done)
        threading.Thread(target=submit, daemon=True).start()

    def command(self, c):
        cmd = c.get("cmd")
        if cmd == "start":
            with self.lock:
                self.settings.update({k: v for k, v in (c.get("settings") or {}).items() if k in DEFAULTS})
                self.running = True
                if c.get("res") in RESOLUTIONS:
                    self.res = c["res"]
                prompt = (c.get("prompt") or self.prompt).strip()
                if prompt == self.prompt and self.cond is not None:
                    self.request_fresh("start")
                    return
                self.prompt = prompt
                self.fresh = dict(cause="start", cond=None, res=self.res)
                self.abort.set()
            self.on_prompt(prompt, "start")
        elif cmd == "prompt":
            text = (c.get("prompt") or "").strip()
            if text and text != self.prompt:
                with self.lock:
                    self.prompt = text
                self.on_prompt(text, "transition" if c.get("mode") == "transition" else "prompt")
        elif cmd == "cut":
            self.request_fresh("cut")
        elif cmd == "res":
            if c.get("res") in RESOLUTIONS and c["res"] != self.res:
                with self.lock:
                    self.res = c["res"]
                self.request_fresh("res", res=c["res"])
        elif cmd == "settings":
            with self.lock:
                self.settings.update({k: v for k, v in c.items() if k in DEFAULTS})
            send({"type": "settings", "settings": self.settings})
        elif cmd == "pause":
            with self.lock:
                self.running = False
                self.abort.set()
                self.lock.notify_all()
        elif cmd == "buffer":
            with self.lock:
                self.buffer_frames = int(c.get("frames", 0))
                self.lock.notify_all()
        elif cmd == "quit":
            self.shutdown()

    def stdin_loop(self):
        for line in sys.stdin:
            try:
                self.command(json.loads(line))
            except Exception as e:
                log(f"bad command {line.strip()[:200]}: {e!r}")
        self.shutdown()

    def shutdown(self):
        log("quit")
        if self.text:
            self.text.close()
        os._exit(0)

    # ---------------------------------------------------------------- output thread
    def output_loop(self):
        def enc(f):
            ok, buf = cv2.imencode(".jpg", np.ascontiguousarray(f[:, :, ::-1]),
                                   [cv2.IMWRITE_JPEG_QUALITY, self.settings["jpeg_quality"]])
            return buf.tobytes()
        while True:
            header, frames = self.out_q.get()
            t = time.perf_counter()
            jpgs = list(self.jpeg_pool.map(enc, frames))
            header["jpeg_s"] = round(time.perf_counter() - t, 3)
            header["sizes"] = [len(j) for j in jpgs]
            send(header, b"".join(jpgs))

    # ---------------------------------------------------------------- director (main thread)
    def next_job(self):
        """Block until there is something to generate; returns (cause, mode, cond, res)."""
        with self.lock:
            while True:
                if self.running and self.fresh and self.fresh["cond"] is not None:
                    f, self.fresh = self.fresh, None
                    self.abort.clear()
                    self.cond, self.res = f["cond"], f["res"]
                    return f["cause"], "t2v", f["cond"], f["res"]
                if (self.running and not self.fresh and self.last is not None and self.cond is not None
                        and self.buffer_frames <= self.settings["max_ahead"]):
                    self.abort.clear()
                    cause, self.transition = ("transition" if self.transition else "continue"), False
                    return cause, "i2v", self.cond, self.res
                self.lock.wait(0.25)

    def scene_cut_reason(self, frames):
        s, sc = self.settings, self.scene
        small = lambda f: cv2.resize(f, (32, 18), interpolation=cv2.INTER_AREA).astype(np.float32)
        if sc["thumb"] is None:
            sc["thumb"] = small(frames[0])
        drift = float(np.abs(small(frames[-1]) - sc["thumb"]).mean())
        reason = None
        if s["auto_segments"] and sc["segments"] >= s["auto_segments"]:
            reason = f"{sc['segments']} segments"
        elif s["auto_seconds"] and time.time() - sc["t0"] >= s["auto_seconds"]:
            reason = f"{s['auto_seconds']} s"
        elif s["drift_check"] and drift > s["drift_threshold"]:
            reason = f"drift {drift:.0f} > {s['drift_threshold']:.0f}"
        return drift, reason

    def run(self):
        threading.Thread(target=self.stdin_loop, daemon=True).start()
        threading.Thread(target=self.output_loop, daemon=True).start()
        try:
            self.load()
            self.warm(self.res)
        except Exception as e:
            send({"type": "error", "msg": f"load failed: {e!r}"})
            raise
        status("ready", vram=vram())
        while True:
            cause, mode, cond, res = self.next_job()
            if res not in self.warmed:
                self.warm(res)
            w, h = map(int, res.split("x"))
            if mode == "t2v":
                self.epoch += 1
                self.last = None
            if mode == "t2v" or cause == "transition":  # auto-cut counters start over for the new prompt
                self.scene = dict(segments=0, t0=time.time(), thumb=None)
            status("generating", mode=mode, cause=cause, res=res, epoch=self.epoch)
            torch.cuda.reset_peak_memory_stats()
            torch.cuda.synchronize()
            t0 = time.perf_counter()
            k = self.settings["cond_frames"]
            try:
                for attempt in (1, 2):
                    try:
                        lat = self.generate(cond, w, h, self.last if mode == "i2v" else None)
                        torch.cuda.synchronize()
                        t1 = time.perf_counter()
                        frames = self.decode(lat)
                        torch.cuda.synchronize()
                        break
                    except torch.OutOfMemoryError as e:
                        lat = None
                        torch.cuda.empty_cache()
                        log(f"CUDA out of memory (attempt {attempt}): {str(e)[:300]}")
                        if attempt == 2:
                            raise
            except Abort:
                log(f"aborted {mode} segment after {time.perf_counter() - t0:.1f}s")
                continue
            except torch.OutOfMemoryError as e:
                send({"type": "error", "fatal": True, "msg": f"CUDA out of memory: {str(e)[:400]}"})
                with self.lock:
                    self.running = False
                continue
            t2 = time.perf_counter()
            if self.abort.is_set():  # a cut arrived during decode: drop the stale segment
                continue
            frames = frames.cpu().numpy()
            if mode == "i2v":
                frames = frames[k:]  # the first k frames re-create the conditioning frames
            self.last = frames[-k:]
            self.seg += 1
            self.scene["segments"] += 1
            drift, reason = self.scene_cut_reason(frames)
            header = dict(type="segment", epoch=self.epoch, seg=self.seg, scene_seg=self.scene["segments"],
                          mode=mode, cause=cause, flush=cause in USER_CAUSES, res=res, prompt=self.prompt,
                          new_frames=len(frames), denoise_s=round(t1 - t0, 3), decode_s=round(t2 - t1, 3),
                          gen_s=round(t2 - t0, 3), gen_fps=round(len(frames) / (t2 - t0), 2),
                          drift=round(drift, 1), next_cut=reason, vram=vram(), t=time.time())
            self.out_q.put((header, frames))
            log(f"seg {self.seg} {mode}/{cause} {res}: {len(frames)} frames in {t2 - t0:.2f}s "
                f"({header['gen_fps']} fps) drift {drift:.1f}{' -> cut: ' + reason if reason else ''}")
            if reason:
                with self.lock:
                    if not self.fresh:
                        self.fresh = dict(cause="auto", cond=self.cond, res=self.res)


if __name__ == "__main__":
    Engine().run()
