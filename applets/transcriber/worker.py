#!/usr/bin/env python3
"""Transcriber worker: faster-whisper behind a JSON-lines pipe, started by server.js.

stdin  one JSON request per line  {"id", "path", "language"?, "beam"?}   ("language" empty/"auto" = detect)
stdout one JSON event per line     {"type": "loading"|"loaded"|"info"|"segment"|"done"|"error", "id"?, ...}
Everything else the libraries print goes to stderr, so stdout stays a clean protocol channel.

The model loads on the first request (GPU through the GPU overseer's lease when one answers, else CPU int8) and
stays loaded until server.js ends this process after its idle timeout, which gives the VRAM back.
"""
import argparse
import glob
import json
import os
import site
import subprocess
import sys
import time
import urllib.request

PROTO = sys.stdout
sys.stdout = sys.stderr


def emit(**event):
    PROTO.write(json.dumps(event, ensure_ascii=False) + "\n")
    PROTO.flush()


def overseer(base, path, body, timeout):
    """POST to the GPU overseer; an overseer that is down or unknown means 'no arbitration, load anyway'."""
    try:
        req = urllib.request.Request(base + path, data=json.dumps(body).encode(), headers={"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except Exception:
        return {"ok": True, "unarbitrated": True}


def preload_cuda12():
    """CTranslate2 wants the CUDA 12 cuBLAS/cuDNN; pip ships them as nvidia-*-cu12 wheels that are not on the loader path."""
    import ctypes
    for sp in site.getsitepackages():
        for pattern in ("nvidia/cublas/lib/libcublasLt.so.12", "nvidia/cublas/lib/libcublas.so.12", "nvidia/cudnn/lib/libcudnn.so.9"):
            for f in glob.glob(os.path.join(sp, pattern)):
                try:
                    ctypes.CDLL(f, mode=ctypes.RTLD_GLOBAL)
                except OSError:
                    pass


def load_model(args):
    from faster_whisper import WhisperModel
    want = args.device
    if want in ("auto", "cuda"):
        grant = {"ok": True}
        if args.overseer and want == "auto":
            grant = overseer(args.overseer, "/api/acquire", {"client": "transcriber", "need_mb": args.need_mb, "timeout": 40}, 60)
        try:
            if not grant.get("ok"):
                raise RuntimeError("GPU busy (%s MB free)" % grant.get("free_mb"))
            preload_cuda12()
            for compute in args.compute.split(","):
                try:
                    return WhisperModel(args.model, device="cuda", compute_type=compute), "cuda", compute
                except Exception as e:  # out of memory with this precision: try the next, then the CPU
                    emit(type="info", message="cuda/%s unavailable: %s" % (compute, str(e)[:160]))
        except Exception as e:
            emit(type="info", message="using the CPU: %s" % str(e)[:160])
        finally:
            if args.overseer and want == "auto":
                overseer(args.overseer, "/api/release", {"client": "transcriber"}, 10)
    threads = args.cpu_threads or max(1, (os.cpu_count() or 4) // 2)
    return WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=threads), "cpu", "int8"


def decode16k(path):
    """Any browser recording or audio/video file → 16 kHz mono float32 (ffmpeg)."""
    import numpy as np
    r = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", path, "-vn", "-f", "f32le", "-ac", "1", "-ar", "16000", "pipe:1"],
                       capture_output=True)
    if r.returncode != 0 or not r.stdout:
        raise ValueError("could not read audio: " + (r.stderr.decode(errors="replace").strip()[-240:] or "no audio stream"))
    return np.frombuffer(r.stdout, dtype=np.float32)


def run(model, req):
    t0 = time.time()
    pcm = decode16k(req["path"])
    total = len(pcm) / 16000.0
    lang = (req.get("language") or "").strip().lower()
    lang = None if lang in ("", "auto") else lang
    emit(type="info", id=req["id"], duration=round(total, 2))
    segs, info = model.transcribe(
        pcm, language=lang, beam_size=int(req.get("beam") or 5), vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500}, condition_on_previous_text=False,
    )
    parts = []
    for s in segs:
        text = s.text.strip()
        if not text:
            continue
        parts.append(text)
        emit(type="segment", id=req["id"], start=round(s.start, 2), end=round(s.end, 2), text=text,
             progress=min(1.0, s.end / total) if total else 1.0)
    emit(type="done", id=req["id"], text=" ".join(parts), language=info.language,
         probability=round(info.language_probability, 3), duration=round(total, 2), elapsed=round(time.time() - t0, 2))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="large-v3-turbo")
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--compute", default="float16,int8_float16", help="comma list tried in order on the GPU")
    ap.add_argument("--overseer", default="http://127.0.0.1:8195", help="GPU overseer URL ('' = none)")
    ap.add_argument("--need-mb", type=int, default=2500)
    ap.add_argument("--cpu-threads", type=int, default=0)
    args = ap.parse_args()

    model = None
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = {}
        try:
            req = json.loads(line)
            if model is None:
                emit(type="loading", id=req.get("id"), model=args.model)
                t = time.time()
                model, device, compute = load_model(args)
                emit(type="loaded", id=req.get("id"), model=args.model, device=device, compute=compute, seconds=round(time.time() - t, 1))
            run(model, req)
        except Exception as e:
            emit(type="error", id=req.get("id"), error=str(e)[:400])


if __name__ == "__main__":
    main()
