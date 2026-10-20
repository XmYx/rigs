#!/usr/bin/env python3
"""Resident Piper voice: the CPU fallback for JARVIS's speech when the neural voice (jarvis-voice / Kokoro) is down.

The model stays loaded (the per-call piper CLI reloads it for 1.2-1.4 s every sentence; resident it is ~30-150 ms).
  GET  /healthz           -> {"ok": true, "model": ...}
  POST /tts {"text"}      -> audio/wav (mono 16-bit, the model's rate)
Env: PIPER_MODEL (path to .onnx, required), PIPER_PORT (default 8210), PIPER_HOST (default 127.0.0.1).
Needs `pip install piper-tts` (>= 1.3) in the venv that runs this.
"""
import io
import json
import os
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from piper import PiperVoice

MODEL = os.environ["PIPER_MODEL"]
VOICE = PiperVoice.load(MODEL)
LOCK = threading.Lock()


def synth(text):
    buf = io.BytesIO()
    with LOCK, wave.open(buf, "wb") as w:
        VOICE.synthesize_wav(text, w)
    return buf.getvalue()


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json"):
        if not isinstance(body, (bytes, bytearray)):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] in ("/healthz", "/"):
            return self.send(200, {"ok": True, "model": os.path.basename(MODEL)})
        self.send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.split("?")[0] != "/tts":
            return self.send(404, {"error": "not found"})
        try:
            n = int(self.headers.get("content-length") or 0)
            text = str(json.loads(self.rfile.read(n) or b"{}").get("text", "")).strip()
            if not text:
                return self.send(204, b"", "audio/wav")
            self.send(200, synth(text), "audio/wav")
        except Exception as e:  # noqa: BLE001
            self.send(503, {"error": str(e)})


if __name__ == "__main__":
    synth("ready")  # warm the model so the first real sentence is fast
    ThreadingHTTPServer((os.environ.get("PIPER_HOST", "127.0.0.1"), int(os.environ.get("PIPER_PORT", "8210"))), H).serve_forever()
