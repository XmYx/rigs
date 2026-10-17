#!/usr/bin/env python3
"""Krea Studio: a tiny web front-end for Krea 2 Turbo on the local ComfyUI.

Run:  python3 server.py  [--port 8190] [--comfy http://127.0.0.1:8188]
Stdlib only. History lives in history.json next to this file; images stay in
ComfyUI's output/krea_studio folder and are served through /img/<file>.
All URLs are relative so the page works behind a path-prefix proxy (JARVIS App Cloud).
"""
import argparse, json, os, random, threading, time, urllib.error, urllib.parse, urllib.request
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

HERE = os.path.dirname(os.path.abspath(__file__))
HISTORY = os.path.join(HERE, "history.json")
COMFY_DIR = "/home/magix/ai/ComfyUI"
OUT_SUBDIR = "krea_studio"
OUT_DIR = os.path.join(COMFY_DIR, "output", OUT_SUBDIR)
lock = threading.Lock()
jobs = {}  # prompt_id -> job dict, only while pending in ComfyUI

ENHANCE_SYSTEM = (
    "You are an expert prompt engineer for text-to-image models. Expand the user's prompt into a single "
    "highly effective image-generation paragraph. Preserve all original subjects, actions, colors and spatial "
    "relationships; do not add new objects or characters. Choose fitting style, medium, framing and lighting, "
    "but do not over-specify details the input does not support. If the user requests visible text, quote it "
    "exactly. If the prompt is already detailed, only lightly polish it. Honor any medium the user names. "
    "Output only the final prompt as one cohesive paragraph: no headings, labels, bullets, JSON or markdown.\n\nUser's Input:\n\n"
)


def load_history():
    try:
        with open(HISTORY) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def save_history(items):
    tmp = HISTORY + ".tmp"
    with open(tmp, "w") as f:
        json.dump(items, f, indent=1)
    os.replace(tmp, HISTORY)


def build_graph(p):
    seed = int(p["seed"])
    g = {
        "unet": {"class_type": "UNETLoader", "inputs": {"unet_name": "krea2_turbo_fp8_scaled.safetensors", "weight_dtype": "default"}},
        "clip": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_4b_fp8_scaled.safetensors", "type": "krea2", "device": "default"}},
        "vae": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
        "latent": {"class_type": "EmptyLatentImage", "inputs": {"width": int(p["width"]), "height": int(p["height"]), "batch_size": int(p["batch"])}},
        "neg": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["pos", 0]}},
        "sampler": {"class_type": "KSampler", "inputs": {
            "model": ["unet", 0], "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["latent", 0],
            "seed": seed, "steps": int(p["steps"]), "cfg": float(p["cfg"]),
            "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0}},
        "decode": {"class_type": "VAEDecode", "inputs": {"samples": ["sampler", 0], "vae": ["vae", 0]}},
        "save": {"class_type": "SaveImage", "inputs": {"images": ["decode", 0], "filename_prefix": f"{OUT_SUBDIR}/krea"}},
    }
    if p.get("enhance"):
        g["sys"] = {"class_type": "StringConcatenate", "inputs": {"string_a": ENHANCE_SYSTEM, "string_b": p["prompt"], "delimiter": ""}}
        g["llm"] = {"class_type": "TextGenerate", "inputs": {
            "clip": ["clip", 0], "prompt": ["sys", 0], "max_length": 512,
            "sampling_mode": "on", "sampling_mode.temperature": 0.7, "sampling_mode.top_k": 64,
            "sampling_mode.top_p": 0.95, "sampling_mode.min_p": 0.05, "sampling_mode.repetition_penalty": 1.05,
            "sampling_mode.seed": seed % 2**32, "thinking": False, "use_default_template": True}}
        g["show"] = {"class_type": "PreviewAny", "inputs": {"source": ["llm", 0]}}
        text = ["llm", 0]
    else:
        text = p["prompt"]
    g["pos"] = {"class_type": "CLIPTextEncode", "inputs": {"clip": ["clip", 0], "text": text}}
    return g


def comfy(path, body=None):
    req = urllib.request.Request(ARGS.comfy + path, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def gpu_acquire():
    """Ask the GPU Overseer to make room for ComfyUI (it unloads idle apps such as Music Studio).
    ComfyUI's own queue keeps it marked busy while it renders, so the lease is handed back at once."""
    try:
        req = urllib.request.Request(ARGS.overseer + "/api/acquire", data=json.dumps({"client": "comfyui", "need_mb": ARGS.vram_mb, "timeout": 120}).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=150) as r:
            res = json.load(r)
        rel = urllib.request.Request(ARGS.overseer + "/api/release", data=b'{"client": "comfyui"}', headers={"Content-Type": "application/json"})
        urllib.request.urlopen(rel, timeout=10).close()
        return res
    except Exception:
        return {"ok": True}  # overseer down: behave as before


def error_text(status):
    for kind, msg in status.get("messages", []):
        if kind == "execution_error":
            return msg.get("exception_message", "execution error")
    return "no image produced"


def poll():
    """Move finished ComfyUI jobs into the gallery history."""
    while True:
        time.sleep(1)
        for pid, job in list(jobs.items()):
            try:
                h = comfy(f"/history/{pid}").get(pid)
            except Exception:
                continue
            if not h:
                continue
            status = h.get("status", {})
            if not status.get("completed") and status.get("status_str") != "error":
                continue
            outs = h.get("outputs", {})
            images = [i["filename"] for i in outs.get("save", {}).get("images", [])]
            enhanced = "".join(outs.get("show", {}).get("text", [])) or None
            job.update(images=images, enhanced=enhanced, done=time.time(),
                       error=None if images else error_text(status))
            with lock:
                items = load_history()
                items.insert(0, job)
                save_history(items)
                jobs.pop(pid, None)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json", cache=False):
        if not isinstance(body, bytes):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=31536000, immutable" if cache else "no-store")
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        return json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path in ("/", "/index.html"):
            with open(os.path.join(HERE, "index.html"), "rb") as f:
                return self.send(200, f.read(), "text/html; charset=utf-8")
        if u.path == "/healthz":
            return self.send(200, {"ok": True})
        if u.path == "/api/history":
            with lock:
                return self.send(200, {"pending": list(jobs.values()), "items": load_history()})
        if u.path == "/api/status":
            try:
                q = comfy("/queue")
                return self.send(200, {"online": True, "running": len(q["queue_running"]), "queued": len(q["queue_pending"])})
            except Exception as e:
                return self.send(200, {"online": False, "error": str(e)})
        if u.path.startswith("/img/"):
            path = os.path.join(OUT_DIR, os.path.basename(urllib.parse.unquote(u.path[5:])))
            if not os.path.isfile(path):
                return self.send(404, {"error": "not found"})
            with open(path, "rb") as f:
                return self.send(200, f.read(), "image/png", cache=True)
        self.send(404, {"error": "not found"})

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/api/generate":
            p = self.body()
            if not p.get("prompt", "").strip():
                return self.send(400, {"error": "empty prompt"})
            if p.get("seed") in (None, "", -1, "-1"):
                p["seed"] = random.randint(0, 2**48)
            for k, v in (("width", 1024), ("height", 1024), ("steps", 8), ("cfg", 1.0), ("batch", 1)):
                if p.get(k) in (None, ""):
                    p[k] = v
            g = gpu_acquire()
            if not g.get("ok"):
                return self.send(503, {"error": f"GPU busy: {g.get('free_mb')} MB free and nothing idle to unload. Try again shortly."})
            try:
                r = comfy("/prompt", {"prompt": build_graph(p), "client_id": "krea-studio"})
            except urllib.error.HTTPError as e:
                return self.send(502, {"error": e.read().decode(errors="replace")[:2000]})
            except Exception as e:
                return self.send(502, {"error": f"ComfyUI unreachable: {e}"})
            job = {"id": r["prompt_id"], "prompt": p["prompt"], "enhance": bool(p.get("enhance")),
                   "seed": int(p["seed"]), "width": int(p["width"]), "height": int(p["height"]),
                   "steps": int(p["steps"]), "cfg": float(p["cfg"]), "batch": int(p["batch"]),
                   "created": time.time(), "images": []}
            jobs[job["id"]] = job
            return self.send(200, job)
        if u.path == "/api/delete":
            ids = set(self.body().get("ids", []))
            with lock:
                items = load_history()
                for it in items:
                    if it["id"] in ids:
                        for name in it.get("images", []):
                            try:
                                os.remove(os.path.join(OUT_DIR, os.path.basename(name)))
                            except FileNotFoundError:
                                pass
                save_history([it for it in items if it["id"] not in ids])
            return self.send(200, {"ok": True})
        self.send(404, {"error": "not found"})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8190)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--comfy", default="http://127.0.0.1:8188")
    ap.add_argument("--overseer", default="http://127.0.0.1:8195")
    ap.add_argument("--vram-mb", type=int, default=18000, help="VRAM ComfyUI needs for Krea 2 (the overseer counts what it already holds)")
    ARGS = ap.parse_args()
    threading.Thread(target=poll, daemon=True).start()
    print(f"Krea Studio on http://{ARGS.host}:{ARGS.port}  (ComfyUI {ARGS.comfy})")
    ThreadingHTTPServer((ARGS.host, ARGS.port), H).serve_forever()
