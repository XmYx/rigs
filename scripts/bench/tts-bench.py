#!/usr/bin/env python3
"""TTS latency benchmark for JARVIS's voice (see docs/local-responder.md).

Reads ONE JSON object on stdin, prints ONE JSON object on stdout (progress goes to stderr). No secrets, no network
access except the URLs you pass. Each engine entry runs in its own interpreter (`"python"`, default: this one), so
engines that need different venvs (Kokoro/torch in the jarvis-voice venv, Piper) are measured in one call, each with a cold
process. Stdlib only in this process; the engine packages are imported inside the worker.

Engines (entry "engine"):
  http         POST {"text", "voice"} to a URL that answers audio/wav: the jarvis-voice applet (/tts), the RIGS
               daemon (/api/local/tts, voice_format "neural:{voice}") or the App Cloud proxy
               (/api/nodes/<node>/apps/jarvis-voice/tts). TTFA = first body byte. Optional "vram_match" (a cmdline
               substring) reports that process's VRAM before/after; "status_url" is read first (an "unloaded" status
               means the warm-up run is the service's cold start).
  kokoro       hexgrad Kokoro-82M through the `kokoro` package (KModel + KPipeline), "device": "cuda" | "cpu".
  piper        piper-tts >= 1.3: "models": ["/path/en_GB-alan-medium.onnx", {"model": "...", "speaker": "obadiah"}].
Any entry may set its own "gpu_min_free_mb". A GPU entry = "gpu": true, "device": "cuda" or "use_cuda": true.
For JARVIS-realistic HTTP numbers measure through the daemon (/api/local/tts): Python's urllib talking straight to
the applet's http.server measured ~10-15 ms slower than curl or the Node daemon doing the same call.

Input (all keys optional except engines; defaults shown):
  {
    "runs": 5, "warmup": 1,
    "texts": {"short": "Good evening, sir. All systems are online.", "medium": "<25 words, one sentence>"},
    "sample_text": "medium",          # which text is saved as one WAV per engine/voice
    "samples_dir": "",                # "" = don't save WAVs
    "gpu_wait_for_absent": [],        # lock files of other GPU users: wait while any exists
    "gpu_wait_max_s": 3600, "gpu_poll_s": 30,
    "gpu_lock": "",                   # created while a GPU engine runs, removed afterwards ("" = none)
    "gpu_min_free_mb": 2500,          # wait for this much free VRAM before a GPU engine (keeps the GPU overseer's
                                      # min_free watchdog from evicting other apps' models because of the benchmark)
    "engines": [
      {"engine": "http", "name": "applet", "url": "http://127.0.0.1:8197/tts", "voices": ["bm_george"],
       "gpu": true, "vram_match": "jarvis-voice/server.py", "status_url": "http://127.0.0.1:8197/api/status"},
      {"engine": "kokoro", "python": "~/apps/jarvis-voice/.venv/bin/python", "device": "cuda",
       "voices": ["bm_george", "bm_lewis", "bm_daniel", "bm_fable"], "speed": 1.0, "threads": 0},
      {"engine": "piper", "python": "<venv>/bin/python", "models": ["..."], "use_cuda": false, "threads": 0}
    ]
  }

Output: {"host", "texts", "runs", "results": [{engine, name, voice, device, cold_start_ms, warmup_ms,
  ttfa_ms: {short, medium} (median), total_ms, audio_s, rtf, chunks, streams, vram_mb, audio_check, sample, raw}],
  "errors": [...]}. Times are wall clock in ms; RTF = synthesis time / audio duration (lower is faster).

Example:  python3 scripts/bench/tts-bench.py < tts-bench.json > results.json
"""
import json
import os
import statistics
import subprocess
import sys
import time

DEFAULT_TEXTS = {
    "short": "Good evening, sir. All systems are online.",
    "medium": ("The build finished a moment ago, sir; all forty-two tests passed, and the new voice pipeline is "
               "ready whenever you would like to hear it."),
}


def log(*a):
    print("[tts-bench]", *a, file=sys.stderr, flush=True)


def expand(p):
    return os.path.expanduser(os.path.expandvars(p)) if isinstance(p, str) else p


# ------------------------------------------------------------------ audio helpers (stdlib + optional numpy)
def wav_bytes(samples, rate):
    """float samples (list/ndarray, -1..1) → 16-bit mono WAV bytes."""
    import io
    import wave
    try:
        import numpy as np
        pcm = (np.clip(np.asarray(samples, dtype=np.float32), -1, 1) * 32767).astype("<i2").tobytes()
    except ImportError:
        import array
        pcm = array.array("h", [int(max(-1.0, min(1.0, s)) * 32767) for s in samples]).tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(rate))
        w.writeframes(pcm)
    return buf.getvalue()


def wav_info(data):
    """WAV bytes → (rate, float samples list, channels)."""
    import array
    import io
    import wave
    with wave.open(io.BytesIO(data)) as w:
        rate, ch, width, n = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
        raw = w.readframes(n)
    if width != 2:
        return rate, [], ch
    a = array.array("h")
    a.frombytes(raw)
    if sys.byteorder == "big":
        a.byteswap()
    s = [x / 32768.0 for x in a[::ch]]
    return rate, s, ch


def audio_check(samples, rate, words):
    """Objective sanity checks (not a listening test): duration, peak, clipping, edge silence, speech rate."""
    samples = [float(x) for x in samples]
    n = len(samples)
    if not n or not rate:
        return {"duration_s": 0}
    dur = n / rate
    peak = max(abs(x) for x in samples)
    clip = sum(1 for x in samples if abs(x) >= 0.999) / n
    win = max(1, int(rate * 0.02))
    thr = 10 ** (-40 / 20)  # -40 dBFS

    def loud(i):
        seg = samples[i:i + win]
        return len(seg) > 0 and (sum(x * x for x in seg) / len(seg)) ** 0.5 > thr
    lead = 0
    while lead < n and not loud(lead):
        lead += win
    trail = n
    while trail > lead and not loud(max(0, trail - win)):
        trail -= win
    voiced = max(1e-6, (trail - lead) / rate)
    return {"duration_s": round(dur, 3), "peak": round(peak, 3), "clipped_frac": round(clip, 5),
            "lead_silence_s": round(lead / rate, 3), "trail_silence_s": round((n - trail) / rate, 3),
            "words_per_min": round(words / voiced * 60, 1)}


def summarize(results, words_by_text):
    """Per-voice raw runs → medians."""
    out = []
    for r in results:
        raw = r.pop("raw_runs", {})
        r["ttfa_ms"], r["total_ms"], r["audio_s"], r["rtf"], r["chunks"] = {}, {}, {}, {}, {}
        for key, runs in raw.items():
            if not runs:
                continue
            med = lambda f: round(statistics.median(f(x) for x in runs), 1)  # noqa: E731
            r["ttfa_ms"][key] = med(lambda x: x["ttfa_ms"])
            r["total_ms"][key] = med(lambda x: x["total_ms"])
            r["audio_s"][key] = round(statistics.median(x["audio_s"] for x in runs), 3)
            r["rtf"][key] = round(statistics.median(x["total_ms"] / 1000 / max(1e-6, x["audio_s"]) for x in runs), 4)
            r["chunks"][key] = max(x.get("chunks", 1) for x in runs)
        r["raw"] = {k: [{kk: round(vv, 1) if isinstance(vv, float) else vv for kk, vv in x.items()} for x in v] for k, v in raw.items()}
        multi = [k for k, v in r["chunks"].items() if v > 1]
        if r.get("streams") is None:
            r["streams"] = bool(multi)
        out.append(r)
    return out


# ------------------------------------------------------------------ GPU helpers
def smi(args):
    try:
        return subprocess.run(["nvidia-smi", *args], capture_output=True, text=True, timeout=15).stdout
    except Exception:
        return ""


def gpu_free_mb():
    out = smi(["--query-gpu=memory.free", "--format=csv,noheader,nounits"]).strip().splitlines()
    return int(out[0]) if out else None


def pid_vram_mb(pid):
    for line in smi(["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"]).splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) == 2 and parts[0] == str(pid):
            return int(parts[1])
    return 0


def pid_matching(substr):
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                if substr.encode() in f.read():
                    return int(pid)
        except OSError:
            continue
    return None


# ------------------------------------------------------------------ engines (run inside the worker)
def timed_runs(synth_stream, texts, runs, warmup, words_by_text):
    """synth_stream(text) yields (samples, rate) chunks. Returns (warmup_ms, raw_runs, last_audio_by_text)."""
    def once(text):
        t0 = time.perf_counter()
        first = None
        chunks, rate, n = [], 0, 0
        for samples, rate in synth_stream(text):
            if first is None:
                first = time.perf_counter()
            chunks.append(samples)
            n += len(samples)
        t1 = time.perf_counter()
        return {"ttfa_ms": (first - t0) * 1000, "total_ms": (t1 - t0) * 1000, "audio_s": n / rate if rate else 0,
                "chunks": len(chunks)}, chunks, rate
    w0 = time.perf_counter()
    for _ in range(max(0, warmup)):
        once(next(iter(texts.values())))
    warmup_ms = (time.perf_counter() - w0) * 1000
    raw, last = {}, {}
    for key, text in texts.items():
        raw[key] = []
        for _ in range(runs):
            m, chunks, rate = once(text)
            raw[key].append(m)
        last[key] = (chunks, rate)
    return warmup_ms, raw, last


def concat(chunks):
    try:
        import numpy as np
        return np.concatenate([np.asarray(c, dtype=np.float32).reshape(-1) for c in chunks]) if chunks else np.zeros(0)
    except ImportError:
        out = []
        for c in chunks:
            out.extend(c)
        return out


def run_kokoro(e, common):
    t0 = time.perf_counter()
    if e.get("offline", True):
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
    import torch
    if e.get("threads"):
        torch.set_num_threads(int(e["threads"]))
    from kokoro import KModel, KPipeline
    dev = e.get("device") or ("cuda" if torch.cuda.is_available() else "cpu")
    model = KModel(repo_id=e.get("repo_id", "hexgrad/Kokoro-82M")).to(dev).eval()
    pipe = KPipeline(lang_code=e.get("lang_code", "b"), repo_id=e.get("repo_id", "hexgrad/Kokoro-82M"), model=model)
    if dev == "cuda":
        torch.cuda.synchronize()
    load_ms = (time.perf_counter() - t0) * 1000
    speed = float(e.get("speed", 1.0))
    results = []
    for voice in e.get("voices", ["bm_george"]):
        def stream(text, voice=voice):
            for r in pipe(text, voice=voice, speed=speed):
                if r.audio is not None:
                    yield r.audio.detach().cpu().numpy(), 24000  # .cpu() synchronises CUDA
        if dev == "cuda":
            torch.cuda.reset_peak_memory_stats()
        warm, raw, last = timed_runs(stream, common["texts"], common["runs"], common["warmup"], common["words"])
        res = {"engine": "kokoro", "name": e.get("name", f"kokoro ({dev})"), "voice": voice, "device": dev,
               "cold_start_ms": round(load_ms, 1), "warmup_ms": round(warm, 1), "raw_runs": raw,
               "streams_note": "KPipeline yields one segment per newline-separated block / 510-phoneme chunk; "
                               "no audio before a whole segment is synthesized (non-autoregressive)",
               "_last": last}
        if dev == "cuda":
            res["vram_mb"] = {"torch_peak_alloc": round(torch.cuda.max_memory_allocated() / 2**20),
                              "process_nvidia_smi": pid_vram_mb(os.getpid())}
        results.append(res)
    return results


def run_piper(e, common):
    import onnxruntime as rt  # noqa: F401  (fail early with a clear error)
    from piper import PiperVoice, SynthesisConfig
    results = []
    for m in e.get("models", []):
        spec = m if isinstance(m, dict) else {"model": m}
        path = expand(spec["model"])
        t0 = time.perf_counter()
        voice = PiperVoice.load(path, use_cuda=bool(e.get("use_cuda")))
        if e.get("threads"):
            so = rt.SessionOptions()
            so.intra_op_num_threads = int(e["threads"])
            voice.session = rt.InferenceSession(path, so, providers=["CPUExecutionProvider"])
        load_ms = (time.perf_counter() - t0) * 1000
        sid = None
        if spec.get("speaker") is not None:
            sid = voice.config.speaker_id_map.get(spec["speaker"], spec["speaker"]) if isinstance(spec["speaker"], str) else spec["speaker"]
        cfg = SynthesisConfig(speaker_id=sid, length_scale=spec.get("length_scale"))

        def stream(text):
            for chunk in voice.synthesize(text, syn_config=cfg):
                yield chunk.audio_float_array, chunk.sample_rate
        warm, raw, last = timed_runs(stream, common["texts"], common["runs"], common["warmup"], common["words"])
        name = os.path.basename(path).replace(".onnx", "") + (f":{spec['speaker']}" if spec.get("speaker") is not None else "")
        results.append({"engine": "piper", "name": e.get("name", "piper"), "voice": name,
                        "device": "cuda" if e.get("use_cuda") else "cpu", "cold_start_ms": round(load_ms, 1),
                        "warmup_ms": round(warm, 1), "raw_runs": raw,
                        "streams_note": "PiperVoice.synthesize yields one AudioChunk per sentence (espeak-ng sentence split)",
                        "_last": last})
    return results


def worker():
    job = json.loads(sys.stdin.read())
    e, common = job["entry"], job["common"]
    fn = {"kokoro": run_kokoro, "piper": run_piper}[e["engine"]]
    results = fn(e, common)
    for r in results:
        last = r.pop("_last", {})
        key = common.get("sample_text", "medium")
        if key in last:
            chunks, rate = last[key]
            audio = concat(chunks)
            r["audio_check"] = audio_check(audio, rate, common["words"][key])
            if common.get("samples_dir"):
                os.makedirs(common["samples_dir"], exist_ok=True)
                fn_ = os.path.join(common["samples_dir"], f"{r['engine']}-{r['device']}__{r['voice'].replace('/', '_')}.wav")
                with open(fn_, "wb") as f:
                    f.write(wav_bytes(audio, rate))
                r["sample"] = fn_
    print(json.dumps(results))


# ------------------------------------------------------------------ http engine (in this process, stdlib only)
def run_http(e, common):
    import urllib.request
    url = e["url"]
    fmt = e.get("voice_format", "{voice}")
    status_before = None
    if e.get("status_url"):
        try:
            with urllib.request.urlopen(e["status_url"], timeout=10) as r:
                status_before = json.loads(r.read()).get("status")
        except Exception as ex:  # noqa: BLE001
            status_before = f"error: {ex}"
    pid = pid_matching(e["vram_match"]) if e.get("vram_match") else None
    vram_before = pid_vram_mb(pid) if pid else None
    results = []

    def post(text, voice):
        body = {"text": text}
        if voice:
            body["voice"] = fmt.format(voice=voice)
        req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"content-type": "application/json"})
        t0 = time.perf_counter()
        with urllib.request.urlopen(req, timeout=float(e.get("timeout", 120))) as r:
            first = r.read(1)
            t1 = time.perf_counter()
            data = first + r.read()
            hdr = {k.lower(): v for k, v in r.headers.items()}
        t2 = time.perf_counter()
        rate, samples, _ = wav_info(data)
        return {"ttfa_ms": (t1 - t0) * 1000, "total_ms": (t2 - t0) * 1000, "audio_s": len(samples) / rate if rate else 0,
                "chunks": 1, "visemes": bool(hdr.get("x-visemes")), "engine_hdr": hdr.get("x-tts-engine", "")}, samples, rate

    for voice in e.get("voices", [""]):
        w0 = time.perf_counter()
        for _ in range(max(0, common["warmup"])):
            post(next(iter(common["texts"].values())), voice)
        warm = (time.perf_counter() - w0) * 1000
        raw, last = {}, {}
        for key, text in common["texts"].items():
            raw[key] = []
            for _ in range(common["runs"]):
                m, samples, rate = post(text, voice)
                raw[key].append(m)
                last[key] = (samples, rate)
        res = {"engine": "http", "name": e.get("name", url), "url": url, "voice": voice or "(service default)",
               "device": e.get("device", "remote"), "warmup_ms": round(warm, 1), "raw_runs": raw,
               "streams": False, "streams_note": "one complete WAV per request (no chunked audio)"}
        if status_before and "unloaded" in str(status_before) and not results:
            res["cold_start_ms"] = round(warm, 1)
            res["cold_start_note"] = "service was unloaded: warm-up = model load + first synthesis"
        res["service_status_before"] = status_before
        key = common.get("sample_text", "medium")
        if key in last:
            samples, rate = last[key]
            res["audio_check"] = audio_check(samples, rate, common["words"][key])
            if common.get("samples_dir"):
                os.makedirs(common["samples_dir"], exist_ok=True)
                fn_ = os.path.join(common["samples_dir"], f"http-{e.get('name', 'http').replace(' ', '_')}__{(voice or 'default').replace('*', 'x').replace('+', '_')}.wav")
                with open(fn_, "wb") as f:
                    f.write(wav_bytes(samples, rate))
                res["sample"] = fn_
        results.append(res)
    if pid:
        after = pid_vram_mb(pid)
        for r in results:
            r["vram_mb"] = {"process_before": vram_before, "process_after": after}
    return results


# ------------------------------------------------------------------ orchestration
class GpuGate:
    def __init__(self, cfg, entry=None):
        cfg = {**cfg, **{k: v for k, v in (entry or {}).items() if k == "gpu_min_free_mb"}}
        self.wait_for = [expand(p) for p in cfg.get("gpu_wait_for_absent", [])]
        self.lock = expand(cfg.get("gpu_lock", ""))
        self.max_s = float(cfg.get("gpu_wait_max_s", 3600))
        self.poll = float(cfg.get("gpu_poll_s", 30))
        self.min_free = int(cfg.get("gpu_min_free_mb", 2500))

    def __enter__(self):
        deadline = time.time() + self.max_s
        while True:
            busy = [p for p in self.wait_for if os.path.exists(p)]
            free = gpu_free_mb()
            short = free is not None and free < self.min_free
            if not busy and not short:
                break
            if time.time() > deadline:
                raise TimeoutError(f"GPU not available after {self.max_s:.0f}s (locks: {busy}, free {free} MB)")
            log(f"waiting for the GPU (locks: {busy or 'none'}, free {free} MB, need {self.min_free})")
            time.sleep(self.poll)
        if self.lock:
            with open(self.lock, "w") as f:
                f.write(json.dumps({"pid": os.getpid(), "since": time.time(), "by": "tts-bench"}))
        return self

    def __exit__(self, *exc):
        if self.lock:
            try:
                os.remove(self.lock)
            except OSError:
                pass


def host_info():
    info = {"python": sys.version.split()[0]}
    try:
        with open("/proc/cpuinfo") as f:
            info["cpu"] = next((l.split(":", 1)[1].strip() for l in f if l.startswith("model name")), "")
    except OSError:
        info["cpu"] = ""
    info["cpus"] = os.cpu_count()
    g = smi(["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader"]).strip()
    if g:
        info["gpu"] = g
    return info


def main():
    if "--worker" in sys.argv:
        return worker()
    cfg = json.loads(sys.stdin.read() or "{}")
    texts = cfg.get("texts") or DEFAULT_TEXTS
    common = {"texts": texts, "runs": int(cfg.get("runs", 5)), "warmup": int(cfg.get("warmup", 1)),
              "words": {k: len(v.split()) for k, v in texts.items()}, "sample_text": cfg.get("sample_text", "medium"),
              "samples_dir": expand(cfg.get("samples_dir", ""))}
    out = {"host": host_info(), "texts": texts, "words": common["words"], "runs": common["runs"],
           "warmup": common["warmup"], "results": [], "errors": []}
    for e in cfg.get("engines", []):
        gpu = bool(e.get("gpu")) or e.get("device") == "cuda" or bool(e.get("use_cuda"))
        label = e.get("name") or e["engine"]
        try:
            gate = GpuGate(cfg, e) if gpu else None
            if gate:
                gate.__enter__()
            try:
                log(f"running {label} ({'gpu' if gpu else 'cpu'})")
                if e["engine"] == "http":
                    res = run_http(e, common)
                else:
                    py = expand(e.get("python")) or sys.executable
                    p = subprocess.run([py, "-I", os.path.abspath(__file__), "--worker"],
                                       input=json.dumps({"entry": e, "common": common}), capture_output=True, text=True,
                                       timeout=float(e.get("timeout", 1800)))
                    if p.returncode != 0:
                        raise RuntimeError(p.stderr.strip()[-1500:] or f"worker exited {p.returncode}")
                    res = json.loads(p.stdout.strip().splitlines()[-1])
            finally:
                if gate:
                    gate.__exit__(None, None, None)
            out["results"] += summarize(res, common["words"])
        except Exception as ex:  # noqa: BLE001
            log(f"{label} failed: {ex}")
            out["errors"].append({"engine": e.get("engine"), "name": label, "error": str(ex)[-1500:]})
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
