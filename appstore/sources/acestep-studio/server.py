#!/usr/bin/env python3
"""ACE-Step Studio: a web front-end for ACE-Step 1.5 music generation (the model MadMaxUnity's radio used).

Run with ACE-Step's own venv:
    ~/PycharmProjects/MadMaxUnity/audio/ace15/.venv/bin/python server.py [--port 8191]

Every GenerationParams / GenerationConfig field is exposed: the schema is read from the dataclasses at
startup (types, defaults, and the descriptions from their docstring and inline comments), so new ACE-Step
options appear in the UI without code changes. Models load lazily on the first job and can be unloaded to
free VRAM. Jobs run one at a time from a queue; outputs and history.json live next to this file.
All URLs are relative so the page works behind the JARVIS App Cloud path prefix.
"""
import argparse, dataclasses, inspect, json, os, re, shutil, sys, threading, time, traceback, typing, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ACE = os.environ.get("ACESTEP_ROOT", "/home/magix/PycharmProjects/MadMaxUnity/audio/ace15")
OUT = os.path.join(HERE, "outputs")
UPLOADS = os.path.join(HERE, "uploads")
HISTORY = os.path.join(HERE, "history.json")
for d in (OUT, UPLOADS):
    os.makedirs(d, exist_ok=True)

sys.path.insert(0, ACE)
os.chdir(ACE)  # ACE-Step resolves checkpoints relative to its project root
from acestep.inference import GenerationConfig, GenerationParams, generate_music  # noqa: E402
from acestep.constants import VALID_LANGUAGES  # noqa: E402

# ------------------------------------------------------------------ parameter schema

CHOICES = {
    "task_type": ["text2music", "cover", "repaint", "lego", "extract", "complete"],
    "infer_method": ["ode", "sde"],
    "sampler_mode": ["euler", "heun"],
    "dcw_mode": ["low", "high", "double", "pix"],
    "repaint_mode": ["conservative", "balanced", "aggressive"],
    "chunk_mask_mode": ["auto", "explicit"],
    "audio_format": ["flac", "mp3", "wav", "wav32", "opus", "aac"],
    "vocal_language": ["unknown"] + list(VALID_LANGUAGES),
    "cot_vocal_language": ["unknown"] + list(VALID_LANGUAGES),
    "mp3_bitrate": ["64k", "96k", "128k", "192k", "256k", "320k"],
}
AUDIO_FIELDS = {"reference_audio", "src_audio"}
LONG_TEXT = {"lyrics", "caption", "global_caption", "audio_codes", "instruction", "lm_negative_prompt",
             "flow_edit_source_caption", "flow_edit_source_lyrics", "cot_caption", "cot_lyrics"}
GROUPS = [
    ("Song", ["caption", "lyrics", "instrumental", "vocal_language", "bpm", "keyscale", "timesignature", "duration"]),
    ("Sampling", ["inference_steps", "seed", "guidance_scale", "shift", "infer_method", "sampler_mode", "timesteps",
                  "use_adg", "cfg_interval_start", "cfg_interval_end", "velocity_norm_threshold", "velocity_ema_factor"]),
    ("Output", ["batch_size", "use_random_seed", "seeds", "audio_format", "mp3_bitrate", "mp3_sample_rate",
                "enable_normalization", "normalization_db", "fade_in_duration", "fade_out_duration",
                "latent_shift", "latent_rescale"]),
    ("Task & source audio", ["task_type", "instruction", "reference_audio", "src_audio", "audio_codes", "global_caption",
                             "audio_cover_strength", "cover_noise_strength", "repainting_start", "repainting_end",
                             "repaint_mode", "repaint_strength", "chunk_mask_mode", "repaint_latent_crossfade_frames",
                             "repaint_wav_crossfade_sec", "retake_seed", "retake_variance"]),
    ("Flow-edit morph", ["flow_edit_morph", "flow_edit_source_caption", "flow_edit_source_lyrics",
                         "flow_edit_n_min", "flow_edit_n_max", "flow_edit_n_avg"]),
    ("Language model (5Hz LM)", ["thinking", "lm_temperature", "lm_cfg_scale", "lm_top_k", "lm_top_p", "lm_negative_prompt",
                                 "use_cot_metas", "use_cot_caption", "use_cot_lyrics", "use_cot_language",
                                 "use_constrained_decoding", "allow_lm_batch", "lm_batch_chunk_size", "constrained_decoding_debug"]),
    ("LM overrides (CoT)", ["cot_bpm", "cot_keyscale", "cot_timesignature", "cot_duration", "cot_vocal_language",
                            "cot_caption", "cot_lyrics"]),
    ("DCW (wavelet correction)", ["dcw_enabled", "dcw_mode", "dcw_scaler", "dcw_high_scaler", "dcw_wavelet"]),
]
HELP_EXTRA = {
    "retake_variance": "Retake: variance-preserving noise mix for a variation of a previous take (0 = off; uses retake_seed).",
    "flow_edit_morph": "Flow-edit overlay on cover tasks: morph the source audio toward the caption/lyrics.",
    "flow_edit_source_caption": "Flow-edit: caption describing the ORIGINAL source audio.",
    "flow_edit_source_lyrics": "Flow-edit: lyrics of the ORIGINAL source audio.",
    "flow_edit_n_min": "Flow-edit: start of the integration window (0.0–1.0).",
    "flow_edit_n_max": "Flow-edit: end of the integration window (0.0–1.0).",
    "flow_edit_n_avg": "Flow-edit: number of noise samples averaged per step.",
    "use_constrained_decoding": "Constrain the LM's output to valid metadata/code tokens.",
    "cot_bpm": "Force the LM's BPM instead of letting it reason one out.",
    "cot_keyscale": "Force the LM's key/scale.",
    "cot_timesignature": "Force the LM's time signature.",
    "cot_duration": "Force the LM's duration (seconds).",
    "cot_vocal_language": "Force the LM's vocal language.",
    "cot_caption": "Force the LM's rewritten caption.",
    "cot_lyrics": "Force the LM's lyrics.",
}
# Defaults that differ from the dataclass defaults: what MadMaxUnity's radio pack used (XL turbo, 8 steps, shift 3).
UI_DEFAULTS = {"shift": 3.0, "batch_size": 1, "vocal_language": "en"}


def _docs(cls):
    """Field descriptions from the class docstring ('name: text') and inline '# comments' in its source."""
    out = {}
    for m in re.finditer(r"^\s{4,}(\w+): (.+)$", inspect.getdoc(cls) or "", re.M):
        out[m.group(1)] = m.group(2).strip()
    try:
        block = []
        for line in inspect.getsource(cls).splitlines():
            st = line.strip()
            if st.startswith("#"):
                block.append(st.lstrip("# ").strip())
                continue
            m = re.match(r"^\s{4}(\w+):[^=]+=[^#]*(?:#\s*(.+))?$", line)
            if m:
                out.setdefault(m.group(1), (m.group(2) or " ".join(block)).strip())
            block = []
    except (OSError, TypeError):
        pass
    return out


def _kind(tp):
    origin, args = typing.get_origin(tp), typing.get_args(tp)
    optional = origin is typing.Union and type(None) in args
    if origin is typing.Union:
        rest = [a for a in args if a is not type(None)]
        tp = rest[0] if len(rest) == 1 else str
        origin = typing.get_origin(tp)
    if origin is list or tp is list:
        return "list", optional
    if tp is bool:
        return "bool", optional
    if tp is int:
        return "int", optional
    if tp is float:
        return "float", optional
    return "str", optional


def build_schema():
    fields = {}
    for owner, cls in (("params", GenerationParams), ("config", GenerationConfig)):
        docs = _docs(cls)
        hints = typing.get_type_hints(cls)
        for f in dataclasses.fields(cls):
            kind, optional = _kind(hints.get(f.name, str))
            if f.default is not dataclasses.MISSING:
                default = f.default
            elif f.default_factory is not dataclasses.MISSING:
                default = f.default_factory()
            else:
                default = None
            d = {"name": f.name, "owner": owner, "kind": kind, "optional": optional, "default": UI_DEFAULTS.get(f.name, default),
                 "help": docs.get(f.name) or HELP_EXTRA.get(f.name, ""), "choices": CHOICES.get(f.name)}
            if f.name in AUDIO_FIELDS:
                d["kind"] = "audio"
            elif f.name in LONG_TEXT:
                d["kind"] = "text"
            fields[f.name] = d
    groups, seen = [], set()
    for title, names in GROUPS:
        items = [fields[n] for n in names if n in fields]
        seen.update(n for n in names if n in fields)
        if items:
            groups.append({"title": title, "fields": items})
    rest = [f for n, f in fields.items() if n not in seen]
    if rest:
        groups.append({"title": "Other", "fields": rest})
    return groups, fields


SCHEMA, FIELDS = build_schema()


def available_models():
    ck = os.path.join(ACE, "checkpoints")
    names = sorted(n for n in os.listdir(ck) if os.path.isdir(os.path.join(ck, n)))
    return {"dit": [n for n in names if n.startswith("acestep-v15")], "lm": [n for n in names if "lm" in n.lower()]}


MODEL_DEFAULTS = {"config_path": "acestep-v15-xl-turbo", "use_lm": True, "lm_model_path": "acestep-5Hz-lm-1.7B",
                  "lm_backend": "pt", "device": "cuda", "use_flash_attention": False, "compile_model": False,
                  "offload_to_cpu": False, "offload_dit_to_cpu": False, "lm_offload_to_cpu": False, "quantization": ""}

# ------------------------------------------------------------------ models + worker

state_lock = threading.Lock()
models = {"dit": None, "llm": None, "settings": None, "status": "unloaded", "message": ""}
queue, jobs = [], {}
cond = threading.Condition()

# DiT and 5Hz LM are separate components: own settings, own timestamps, own lock. A job holds both locks for its whole
# run (load + generate), so the idle watchdog and /api/unload can never free a model mid-generation.
IDLE_UNLOAD_S = float(os.environ.get("ACESTEP_IDLE_UNLOAD_S", "600"))  # 0 disables the idle watchdog
DIT_KEYS = ("config_path", "device", "use_flash_attention", "compile_model", "offload_to_cpu", "offload_dit_to_cpu", "quantization")
LM_KEYS = ("use_lm", "lm_model_path", "lm_backend", "device", "lm_offload_to_cpu")
dit_lock, lm_lock = threading.Lock(), threading.Lock()
models.update(dit_cfg=None, lm_cfg=None, dit_loaded=None, lm_loaded=None, dit_used=None, lm_used=None, activity=time.time())
_no_lm = []


def touch_activity():
    models["activity"] = time.time()


def no_lm_handler():
    """An uninitialised LLMHandler: generate_music skips the LM when llm_initialized is False."""
    if not _no_lm:
        from acestep.llm_inference import LLMHandler
        _no_lm.append(LLMHandler())
    return _no_lm[0]


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


def gpu_make_room(need_mb):
    """Ask the GPU Overseer (~/apps/gpu-overseer) to unload idle GPU apps (e.g. ComfyUI) before we load.
    Our own queue marks us busy while generating, so the lease is handed straight back."""
    import urllib.request
    base = os.environ.get("GPU_OVERSEER", "http://127.0.0.1:8195")
    models.update(status="loading", message="asking the GPU overseer for VRAM…")
    try:
        req = urllib.request.Request(base + "/api/acquire", data=json.dumps({"client": "acestep-studio", "need_mb": need_mb, "timeout": 180}).encode(),
                                     headers={"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=200) as r:
            res = json.load(r)
        urllib.request.urlopen(urllib.request.Request(base + "/api/release", data=b'{"client": "acestep-studio"}',
                                                      headers={"content-type": "application/json"}), timeout=10).close()
        if not res.get("ok"):
            raise RuntimeError(f"GPU busy: only {res.get('free_mb')} MB free and nothing idle to unload")
    except RuntimeError:
        raise
    except Exception:
        pass  # overseer not running: load anyway, as before


def _free_dit(h):
    """AceStepHandler has no unload(): drop every module/tensor it holds so the weights can really be freed."""
    if h is None:
        return
    import torch
    for k, v in list(vars(h).items()):
        if isinstance(v, (torch.nn.Module, torch.Tensor)) or k in ("model", "vae", "text_encoder", "text_tokenizer", "silence_latent"):
            try:
                setattr(h, k, None)
            except Exception:
                pass


def unload_models(which=("llm", "dit")):
    """Free the named components (default both, as before). Callers hold the component locks."""
    import gc
    import torch
    if "llm" in which:
        h = models.get("llm")
        if h is not None and hasattr(h, "unload"):
            try:
                h.unload()
            except Exception:
                pass
        models.update(llm=None, lm_cfg=None, lm_loaded=None, lm_used=None)
    if "dit" in which:
        _free_dit(models.get("dit"))
        models.update(dit=None, dit_cfg=None, dit_loaded=None, dit_used=None)
    if models["dit"] is None:
        models.update(settings=None, status="unloaded", message="")
    else:
        models["message"] = f"{models['dit_cfg']['config_path']} + no LM"
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.synchronize()
        torch.cuda.empty_cache()
        torch.cuda.ipc_collect()


def try_unload(reason=""):
    """Unload everything unless a job holds a component lock; True when freed."""
    if not dit_lock.acquire(blocking=False):
        return False
    try:
        if not lm_lock.acquire(blocking=False):
            return False
        try:
            unload_models()
            if reason:
                models["message"] = reason
                print(f"[unload] {reason}", flush=True)
            return True
        finally:
            lm_lock.release()
    finally:
        dit_lock.release()


def ensure_models(settings, need_lm=True):
    want = {**MODEL_DEFAULTS, **{k: v for k, v in (settings or {}).items() if k in MODEL_DEFAULTS}}
    dit_cfg, lm_cfg = {k: want[k] for k in DIT_KEYS}, {k: want[k] for k in LM_KEYS}
    lm_wanted = bool(need_lm and want["use_lm"] and want["lm_model_path"])
    # Each component reloads only when its own settings changed; an unneeded LM is freed.
    if models["dit"] is not None and models["dit_cfg"] != dit_cfg:
        unload_models(("dit",))
    if models["llm"] is not None and (not lm_wanted or models["lm_cfg"] != lm_cfg):
        unload_models(("llm",))
    load_dit, load_lm = models["dit"] is None, lm_wanted and models["llm"] is None
    if load_dit or load_lm:
        from acestep.handler import AceStepHandler
        from acestep.llm_inference import LLMHandler
        # Ask the overseer only for what is being loaded. Measured: DiT (xl-turbo) ~12.3 GB, + 1.7B LM ~5 GB resident.
        dit_mb, lm_mb = int(os.environ.get("ACESTEP_VRAM_DIT_MB", "12800")), int(os.environ.get("ACESTEP_VRAM_LM_MB", "5000"))
        if os.environ.get("ACESTEP_VRAM_MB"):  # legacy single knob: split it
            dit_mb, lm_mb = int(int(os.environ["ACESTEP_VRAM_MB"]) * 0.72), int(int(os.environ["ACESTEP_VRAM_MB"]) * 0.28)
    if load_dit:
        jb_free_ollama()  # resident Ollama models are invisible to the overseer (snap llama-server) and reload on demand
        gpu_make_room(dit_mb)
        models.update(status="loading", message=f"loading {want['config_path']}…")
        dit = AceStepHandler()
        msg, ok = dit.initialize_service(project_root=ACE, config_path=want["config_path"], device=want["device"],
                                         use_flash_attention=bool(want["use_flash_attention"]), compile_model=bool(want["compile_model"]),
                                         offload_to_cpu=bool(want["offload_to_cpu"]), offload_dit_to_cpu=bool(want["offload_dit_to_cpu"]),
                                         quantization=want["quantization"] or None)
        if not ok:
            models.update(status="error", message=str(msg)[:500])
            _free_dit(dit)
            raise RuntimeError(f"DiT init failed: {msg}")
        models.update(dit=dit, dit_cfg=dit_cfg, dit_loaded=time.time())  # kept even if the LM below fails
    if load_lm:
        jb_free_ollama()  # again right before the LM: it reloads whenever JARVIS needs it
        gpu_make_room(lm_mb)
        models.update(status="loading", message=f"loading {want['lm_model_path']}…")
        llm = LLMHandler()
        lmsg, lok = llm.initialize(checkpoint_dir=os.path.join(ACE, "checkpoints"), lm_model_path=want["lm_model_path"],
                                   backend=want["lm_backend"], device=want["device"], offload_to_cpu=bool(want["lm_offload_to_cpu"]))
        if not lok:
            models.update(status="error", message=str(lmsg)[:500])
            llm.unload()
            raise RuntimeError(f"LM init failed: {lmsg}")
        models.update(llm=llm, lm_cfg=lm_cfg, lm_loaded=time.time())
    models.update(settings=want, status="ready",
                  message=f"{want['config_path']} + {want['lm_model_path'] if models['llm'] is not None else 'no LM'}")


def model_status():
    now = time.time()
    busy = bool(queue) or any(j.get("status") == "running" for j in list(jobs.values()))
    loaded = models["dit"] is not None or models["llm"] is not None
    left = None
    if IDLE_UNLOAD_S > 0 and loaded and not busy:
        left = max(0.0, IDLE_UNLOAD_S - (now - models["activity"]))
    comp = lambda k, cfg_key, name: {"loaded": models[k] is not None, "model": (models[cfg_key] or {}).get(name),
                                     "loaded_at": models[k + "_loaded"] if k != "llm" else models["lm_loaded"],
                                     "last_used": models["dit_used" if k == "dit" else "lm_used"]}
    return {"dit": comp("dit", "dit_cfg", "config_path"), "lm": comp("llm", "lm_cfg", "lm_model_path"),
            "idle_unload_s": IDLE_UNLOAD_S, "unload_in_s": left, "busy": busy}


def idle_watchdog():
    while True:
        time.sleep(5)
        try:
            if IDLE_UNLOAD_S <= 0 or (models["dit"] is None and models["llm"] is None):
                continue
            if queue or any(j.get("status") == "running" for j in list(jobs.values())):
                continue
            if time.time() - models["activity"] >= IDLE_UNLOAD_S:
                try_unload(f"unloaded after {int(IDLE_UNLOAD_S)} s idle")
        except Exception:
            traceback.print_exc()


def coerce(name, value):
    """Turn a form value into the dataclass field's type. Returns (value, known_field)."""
    f = FIELDS.get(name)
    if f is None:
        return None, False
    k = f["kind"]
    if value is None or (isinstance(value, str) and value.strip() == "" and k not in ("text", "str")):
        return (None if f["optional"] or k in ("audio", "list") else f["default"]), True
    if k == "bool":
        return (value if isinstance(value, bool) else str(value).lower() in ("1", "true", "yes", "on")), True
    if k == "int":
        return int(float(value)), True
    if k == "float":
        return float(value), True
    if k == "list":
        items = value if isinstance(value, list) else [x for x in re.split(r"[,\s]+", str(value)) if x]
        cast = int if name == "seeds" else float
        return [cast(x) for x in items] or None, True
    if k == "audio":
        rel = str(value)
        p = os.path.realpath(rel if os.path.isabs(rel) else os.path.join(HERE, rel))
        if not (p.startswith(OUT + os.sep) or p.startswith(UPLOADS + os.sep)) or not os.path.isfile(p):
            raise ValueError(f"{name}: pick an uploaded file or a previous output")
        return p, True
    if name == "dcw_enabled":  # Optional[bool] rendered as auto / on / off
        return {"auto": None, "true": True, "false": False}.get(str(value).lower()), True
    return str(value), True


def run_job(job):
    with dit_lock, lm_lock:
        touch_activity()
        try:
            return _run_job(job)
        finally:
            touch_activity()


def _run_job(job):
    pkw, ckw = {}, {}
    for name, value in job["values"].items():
        v, ok = coerce(name, value)
        if ok:
            (pkw if FIELDS[name]["owner"] == "params" else ckw)[name] = v
    if ckw.get("use_random_seed") is False and not ckw.get("seeds") and (pkw.get("seed") or -1) >= 0:
        ckw["seeds"] = [pkw["seed"]]
    params, config = GenerationParams(**pkw), GenerationConfig(**ckw)
    need_lm = bool(params.thinking or params.use_cot_metas or params.use_cot_caption or params.use_cot_language)
    ensure_models(job["models"], need_lm=need_lm)
    now = time.time()
    models["dit_used"] = now
    if models["llm"] is not None and need_lm:
        models["lm_used"] = now
    tmp = os.path.join(OUT, ".tmp-" + job["id"])
    os.makedirs(tmp, exist_ok=True)
    try:
        res = generate_music(models["dit"], models["llm"] or no_lm_handler(), params, config, save_dir=tmp)
        if not res.success or not res.audios:
            raise RuntimeError(res.error or res.status_message or "generation failed")
        files = []
        for i, a in enumerate(res.audios):
            if not a.get("path"):
                continue
            ext = os.path.splitext(a["path"])[1]
            name = f"{time.strftime('%Y%m%d-%H%M%S')}-{job['id'][:6]}-{i}{ext}"
            shutil.move(a["path"], os.path.join(OUT, name))
            files.append({"file": name, "seed": (a.get("params") or {}).get("seed")})
        meta = {}
        for k, v in (res.extra_outputs or {}).items():
            if isinstance(v, (str, int, float, bool)) or (isinstance(v, (dict, list)) and len(json.dumps(v, default=str)) < 6000):
                meta[k] = v
        return files, json.loads(json.dumps(meta, default=str)), res.status_message
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def worker():
    while True:
        with cond:
            while not queue:
                cond.wait()
            job = queue.pop(0)
        job.update(status="running", started=time.time())
        try:
            files, meta, msg = run_job(job)
            job.update(status="done", files=files, meta=meta, message=msg)
        except Exception as e:
            traceback.print_exc()
            job.update(status="error", error=str(e)[:1000])
        job["done"] = time.time()
        with state_lock:
            items = load_history()
            items.insert(0, {k: job[k] for k in ("id", "values", "models", "status", "files", "meta", "message", "error",
                                                  "created", "started", "done", "jukebox") if k in job})
            save_history(items[:500])
        jobs.pop(job["id"], None)
        try:
            jukebox_job_done(job)
        except Exception:
            traceback.print_exc()

# ------------------------------------------------------------------ jukebox
# Keywords -> Haiku writes one song spec at a time -> normal job queue renders it -> the page plays the playlist.
# Additive: songs are ordinary jobs (marked job["jukebox"]), so ensure_models / gpu_make_room / unload are untouched.

JB_MODEL = "claude-haiku-5-5"
JB_STATUSES = ("writing", "queued", "generating", "ready", "playing", "played", "error", "cancelled")
JB_ACTIVE = ("writing", "queued", "generating", "ready", "playing")  # unplayed: counts towards the look-ahead
jb_lock = threading.RLock()
jb_wake = threading.Event()
jb_thread = None
jb = {"running": False, "keywords": "", "keep_ahead": 2, "duration": 60, "session": "", "songs": [], "now_id": None,
      "error": "", "writer": "", "fails": 0, "seq": 0}


JB_FILE = os.path.join(HERE, "jukebox.json")
JB_KEEP = ("id", "n", "title", "keywords", "caption", "lyrics", "bpm", "keyscale", "duration", "file", "listed", "created")


def _jb_save():
    """Persist settings + every rendered song (listed or not) so the library survives restarts. Call with jb_lock held."""
    songs = [{k: s[k] for k in JB_KEEP if k in s} | {"status": "played" if s["status"] == "played" else "ready"}
             for s in jb["songs"] if s.get("file")]
    tmp = JB_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"keywords": jb["keywords"], "keep_ahead": jb["keep_ahead"], "duration": jb["duration"], "songs": songs}, f, indent=1)
    os.replace(tmp, JB_FILE)


def _jb_load():
    try:
        with open(JB_FILE) as f:
            d = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return
    jb.update(keywords=d.get("keywords", ""), keep_ahead=d.get("keep_ahead", 2), duration=d.get("duration", 60))
    jb["songs"] = [s for s in d.get("songs", []) if s.get("file") and os.path.isfile(os.path.join(OUT, s["file"]))]
    for s in jb["songs"]:
        s.setdefault("listed", True)
    jb["seq"] = max([s.get("n", 0) for s in jb["songs"]] or [0])


def _jb_song(sid):
    return next((s for s in jb["songs"] if s["id"] == sid), None)


def _jb_titles(limit=40):
    """Titles already written (this playlist + earlier jukebox history), newest last, so Haiku avoids repeats."""
    titles = [(it.get("jukebox") or {}).get("title") for it in reversed(load_history()) if it.get("jukebox")]
    titles += [s["title"] for s in jb["songs"] if s.get("title")]
    seen, out = set(), []
    for t in titles:
        if t and t.lower() not in seen:
            seen.add(t.lower())
            out.append(t)
    return out[-limit:]


def _jb_extract(text):
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", (text or "").strip())
    a, b = text.find("{"), text.rfind("}")
    if a < 0 or b <= a:
        raise ValueError("Haiku reply had no JSON object")
    return json.loads(text[a:b + 1])


def jb_ask(prompt):
    """One Haiku call. anthropic SDK when ANTHROPIC_API_KEY is set (and the SDK is installed), else `claude -p`."""
    import subprocess
    import tempfile
    key = os.environ.get("ANTHROPIC_API_KEY")
    if key:
        try:
            import anthropic
            msg = anthropic.Anthropic(api_key=key).messages.create(
                model=JB_MODEL, max_tokens=3000, messages=[{"role": "user", "content": prompt}])
            return "".join(b.text for b in msg.content if getattr(b, "type", "") == "text"), "anthropic-sdk"
        except ImportError:
            pass  # SDK not installed in this venv: use the CLI route
        except Exception as e:
            print(f"[jukebox] anthropic SDK failed ({type(e).__name__}); trying the claude CLI", flush=True)
    exe = shutil.which("claude") or os.path.expanduser("~/.local/bin/claude")
    if not os.path.exists(exe):
        raise RuntimeError("song writer unavailable: no ANTHROPIC_API_KEY/anthropic SDK and no `claude` CLI found")
    env = {k: v for k, v in os.environ.items() if k not in ("ANTHROPIC_API_KEY", "CLAUDECODE")}
    env.setdefault("HOME", os.path.expanduser("~"))
    env["PATH"] = os.path.dirname(exe) + os.pathsep + env.get("PATH", "/usr/bin:/bin")
    try:
        r = subprocess.run([exe, "-p", "--model", JB_MODEL, "--output-format", "json", "--tools", "", "--no-session-persistence",
                            "--strict-mcp-config", "--disable-slash-commands"], input=prompt, capture_output=True, text=True,
                           timeout=240, cwd=tempfile.gettempdir(), env=env)
    except subprocess.TimeoutExpired:
        raise RuntimeError("song writer timed out (claude -p took over 240 s)")
    try:
        out = json.loads(r.stdout)
    except json.JSONDecodeError:
        raise RuntimeError(f"song writer failed: claude -p exit {r.returncode}: {(r.stderr or r.stdout).strip()[:300]}")
    if r.returncode != 0 or out.get("is_error"):
        raise RuntimeError(f"song writer failed: {str(out.get('result') or r.stderr)[:300]}")
    return str(out.get("result") or ""), "claude-cli"


def jb_clean(spec, duration, avoid):
    """Validate + clamp one song spec from Haiku into the fields the generator takes."""
    if not isinstance(spec, dict):
        raise ValueError("spec is not an object")
    title = re.sub(r"\s+", " ", str(spec.get("title") or "")).strip()[:80]
    if not title:
        raise ValueError("spec has no title")
    if title.lower() in {t.lower() for t in avoid}:
        raise ValueError(f"title '{title}' repeats an earlier song")
    instrumental = spec.get("instrumental") in (True, "true", "True", 1)
    caption = re.sub(r"\s+", " ", str(spec.get("caption") or "")).strip()[:400]
    if not caption:
        raise ValueError("spec has no caption")
    lyrics = str(spec.get("lyrics") or "").strip()[:3500]
    if instrumental:
        lyrics = "[Instrumental]"
    elif len(lyrics) < 40:
        raise ValueError("spec has no usable lyrics")
    try:
        bpm = max(60, min(200, int(float(spec.get("bpm")))))
    except (TypeError, ValueError):
        bpm = None
    ks = str(spec.get("keyscale") or "").strip()
    ks = ks if re.fullmatch(r"[A-G][#b]? (?:major|minor)", ks) else ""
    lang = str(spec.get("vocal_language") or "en").strip()
    if lang not in VALID_LANGUAGES:
        lang = "en"
    return {"title": title, "caption": caption, "lyrics": lyrics, "bpm": bpm, "keyscale": ks, "duration": duration,
            "vocal_language": lang, "instrumental": instrumental}


def jb_write_song(keywords, duration):
    """Ask Haiku for one song spec (up to 3 tries); returns (spec, route)."""
    avoid = _jb_titles()
    note, last = "", None
    for _ in range(3):
        prompt = (
            "You write songs for a jukebox in a post-apocalyptic wasteland radio world (Mad Mike's Garage).\n"
            f"Keywords from the listener: {keywords}\n"
            f"Titles already played (never reuse or closely echo them): {json.dumps(avoid)}\n"
            f"The song must be about {duration} seconds long. Write ONE new, original song that clearly fits the keywords.\n"
            "Reply with ONLY a JSON object, no prose and no code fences, with exactly these fields:\n"
            '{"title": str (max 6 words), "caption": str (music style prompt: genre, mood, instruments, vocals, tempo feel; 20-40 words, English), '
            '"lyrics": str (full lyrics with section tags such as [Verse 1], [Chorus], [Bridge]; sized so it fits the duration, '
            "about 12 lines per 60 seconds; use \\n for line breaks), \"bpm\": int 60-200, \"keyscale\": str like \"A minor\" or \"D major\", "
            "\"duration\": int seconds, \"vocal_language\": ISO code such as \"en\", \"instrumental\": bool}\n" + note)
        text, route = jb_ask(prompt)
        try:
            return jb_clean(_jb_extract(text), duration, avoid), route
        except (ValueError, json.JSONDecodeError) as e:
            last = str(e)
            note = f"Your previous reply was rejected ({last}). Fix that and reply with the JSON object only.\n"
    raise RuntimeError(f"Haiku did not produce a usable song spec: {last}")


def _jb_assign_now():
    """Point now_id at the first ready song when nothing valid is current (call with jb_lock held)."""
    cur = _jb_song(jb["now_id"])
    if cur and cur["status"] in ("ready", "playing") and cur.get("listed", True):
        return
    nxt = next((s for s in jb["songs"] if s["status"] == "ready" and s.get("listed", True)), None)
    jb["now_id"] = nxt["id"] if nxt else None


def jb_free_ollama():
    """Unload resident Ollama models (they reload on demand) so the DiT + 5Hz LM fit; only when ACE-Step has to load."""
    import urllib.request
    base = os.environ.get("OLLAMA_HOST_URL", "http://127.0.0.1:11434")
    try:
        with urllib.request.urlopen(base + "/api/ps", timeout=3) as r:
            names = [m.get("name") or m.get("model") for m in json.load(r).get("models", [])]
        for n in filter(None, names):
            urllib.request.urlopen(urllib.request.Request(base + "/api/generate", data=json.dumps({"model": n, "keep_alive": 0}).encode(),
                                                          headers={"content-type": "application/json"}), timeout=15).close()
    except Exception:
        pass  # no Ollama running: nothing to free


def jb_submit(song):
    """Queue the song as an ordinary job; the worker, ensure_models and history stay as they are."""
    if models["dit"] is None:
        jb_free_ollama()
    values = {"caption": song["caption"], "lyrics": song["lyrics"], "instrumental": song["instrumental"],
              "vocal_language": song["vocal_language"], "duration": song["duration"], "audio_format": "mp3",
              "shift": UI_DEFAULTS["shift"], "batch_size": 1}
    if song.get("no_lm"):
        values.update(thinking=False, use_cot_metas=False, use_cot_caption=False, use_cot_language=False)
    if song.get("bpm"):
        values["bpm"] = song["bpm"]
    if song.get("keyscale"):
        values["keyscale"] = song["keyscale"]
    for name, value in values.items():
        coerce(name, value)
    job = {"id": uuid.uuid4().hex, "values": values, "models": {}, "status": "queued", "created": time.time(),
           "jukebox": {"song": song["id"], "session": jb["session"], "title": song["title"], "keywords": song["keywords"]}}
    song.update(job_id=job["id"], status="queued")
    jobs[job["id"]] = job
    with cond:
        queue.append(job)
        cond.notify()


def jukebox_job_done(job):
    """Worker hook: a finished job that belongs to a jukebox song makes it ready (or error)."""
    meta = job.get("jukebox")
    if not meta:
        return
    with jb_lock:
        song = _jb_song(meta.get("song"))
        if not song or song.get("job_id") != job["id"]:
            return
        if job.get("status") == "done" and job.get("files"):
            song.update(file=job["files"][0]["file"], status="ready")
            jb["fails"] = 0
            _jb_save()
        elif "LM init failed" in (job.get("error") or "") and "out of memory" in (job.get("error") or "") and not song.get("no_lm"):
            song["no_lm"] = True  # Haiku already wrote caption + lyrics: render once with the DiT alone
            jb_submit(song)
        else:
            song.update(status="error", error=job.get("error") or "generation failed")
            jb["fails"] += 1
            if jb["fails"] >= 3 and jb["running"]:
                jb.update(running=False, error=f"stopped after 3 failed songs: {song['error']}")
        _jb_assign_now()
    jb_wake.set()


def jukebox_tick():
    with jb_lock:
        if not jb["running"]:
            return False
        unplayed = [s for s in jb["songs"] if s["status"] in JB_ACTIVE and s.get("listed", True)]
        if len(unplayed) >= jb["keep_ahead"] + 1:  # the song now playing + keep_ahead more
            return False
        session, keywords, duration = jb["session"], jb["keywords"], jb["duration"]
        jb["seq"] += 1
        song = {"id": uuid.uuid4().hex[:10], "n": jb["seq"], "title": "", "keywords": keywords, "status": "writing",
                "created": time.time(), "duration": duration, "listed": True}
        jb["songs"].append(song)
    try:
        spec, route = jb_write_song(keywords, duration)
    except Exception as e:
        with jb_lock:
            song.update(status="error", error=str(e)[:400])
            if jb["session"] == session:
                jb["fails"] += 1
                jb["error"] = str(e)[:400]
                if jb["fails"] >= 3:
                    jb.update(running=False, error=f"stopped after 3 failures: {str(e)[:300]}")
        time.sleep(10)  # back off before the next attempt
        return False
    with jb_lock:
        if not jb["running"] or jb["session"] != session:
            song.update(status="cancelled")  # stopped while Haiku was writing: nothing gets generated
            return False
        song.update(spec, keywords=keywords)
        jb.update(writer=route, error="")
        jb_submit(song)
    return True


def jukebox_loop():
    while True:
        jb_wake.wait(2.0)
        jb_wake.clear()
        try:
            if jukebox_tick():
                jb_wake.set()
        except Exception:
            traceback.print_exc()
            time.sleep(5)


def jukebox_snapshot():
    with jb_lock:
        _jb_assign_now()
        songs, library = [], []
        for s in jb["songs"]:
            st = s["status"]
            if st == "cancelled":
                continue  # stopped before it was written or rendered: nothing to show
            if st == "queued":
                j = jobs.get(s.get("job_id"))
                st = "generating" if j and j.get("status") == "running" else "queued"
            (songs if s.get("listed", True) else library).append({
                "id": s["id"], "n": s["n"], "title": s.get("title", ""), "keywords": s.get("keywords", ""), "status": st,
                "audio": ("out/" + s["file"]) if s.get("file") else None, "lyrics": s.get("lyrics", ""),
                "caption": s.get("caption", ""), "bpm": s.get("bpm"), "keyscale": s.get("keyscale", ""),
                "duration": s.get("duration"), "position": s.get("position", 0), "error": s.get("error", "")})
        now = next((i for i, s in enumerate(songs) if s["id"] == jb["now_id"]), -1)
        return {"running": jb["running"], "keywords": jb["keywords"], "keep_ahead": jb["keep_ahead"], "duration": jb["duration"],
                "now_id": jb["now_id"], "now_index": now, "playlist": songs, "removed": library, "error": jb["error"],
                "writer": jb["writer"]}


def jukebox_start(b):
    global jb_thread
    keywords = re.sub(r"\s+", " ", str(b.get("keywords") or "")).strip()[:300]
    if not keywords:
        raise ValueError("give the jukebox some keywords")
    try:
        keep = max(1, min(5, int(b.get("keep_ahead") or 2)))
        duration = max(20, min(240, int(float(b.get("duration") or 60))))
    except (TypeError, ValueError):
        raise ValueError("keep_ahead and duration must be numbers")
    with jb_lock:
        # Songs are never cleared: keywords/length only steer the songs written from now on, playback is undisturbed.
        jb.update(keywords=keywords, keep_ahead=keep, duration=duration)
        if not jb["running"]:
            jb.update(running=True, session=uuid.uuid4().hex[:8], error="", writer="", fails=0)
        _jb_save()
        if jb_thread is None:
            jb_thread = threading.Thread(target=jukebox_loop, daemon=True)
            jb_thread.start()
    jb_wake.set()
    return jukebox_snapshot()


def jukebox_cancel_queued():
    """Drop jukebox songs that have not started; a job the worker already runs is left alone."""
    with cond:
        mine = [j for j in queue if j.get("jukebox")]
        queue[:] = [j for j in queue if not j.get("jukebox")]
    with jb_lock:
        for j in mine:
            jobs.pop(j["id"], None)
            song = _jb_song(j["jukebox"].get("song"))
            if song and song["status"] == "queued":
                song["status"] = "cancelled"


def jukebox_stop():
    with jb_lock:
        jb["running"] = False
    jukebox_cancel_queued()
    return jukebox_snapshot()


def jukebox_skip():
    with jb_lock:
        cur = _jb_song(jb["now_id"])
        if cur and cur["status"] in ("ready", "playing"):
            cur["status"] = "played"
        jb["now_id"] = None
        _jb_assign_now()
        _jb_save()
    jb_wake.set()
    return jukebox_snapshot()


def jukebox_playing(b):
    """The page reports what it is playing: position keeps look-ahead tied to real playback; ended advances."""
    with jb_lock:
        song = _jb_song(b.get("id"))
        if song and song["id"] == jb["now_id"] and song["status"] in ("ready", "playing"):
            song["position"] = float(b.get("position") or 0)
            if b.get("ended") or b.get("failed"):
                song.update(status="played", error="could not be played in the browser" if b.get("failed") else song.get("error", ""))
                jb["now_id"] = None
                _jb_assign_now()
                _jb_save()
            else:
                song["status"] = "playing"
    jb_wake.set()
    return {"ok": True}


def jukebox_patch(b):
    with jb_lock:
        if "keywords" in b:
            kw = re.sub(r"\s+", " ", str(b["keywords"] or "")).strip()[:300]
            if not kw:
                raise ValueError("keywords cannot be empty")
            jb["keywords"] = kw
        if "keep_ahead" in b:
            jb["keep_ahead"] = max(1, min(5, int(b["keep_ahead"])))
        if "duration" in b:
            jb["duration"] = max(20, min(240, int(float(b["duration"]))))
        _jb_save()
    jb_wake.set()
    return jukebox_snapshot()


def jukebox_remove(b):
    """Take a song off the playlist (it stays in the library, file untouched; a song still rendering is let finish)."""
    with jb_lock:
        song = _jb_song(b.get("id"))
        if not song:
            raise ValueError("no such song")
        song["listed"] = False
        if jb["now_id"] == song["id"]:
            jb["now_id"] = None
        _jb_assign_now()
        _jb_save()
    jb_wake.set()
    return jukebox_snapshot()


def jukebox_add(b):
    """Put a removed (or already played) song back at the end of the playlist, ready to play again."""
    with jb_lock:
        song = _jb_song(b.get("id"))
        if not song or not song.get("file"):
            raise ValueError("no such rendered song")
        song.update(listed=True, status="ready", position=0)
        jb["songs"].remove(song)
        jb["songs"].append(song)
        _jb_assign_now()
        _jb_save()
    jb_wake.set()
    return jukebox_snapshot()


_jb_load()

# ------------------------------------------------------------------ HTTP

TYPES ={".flac": "audio/flac", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".opus": "audio/ogg", ".ogg": "audio/ogg",
         ".aac": "audio/aac", ".m4a": "audio/mp4"}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        b = json.dumps(obj, default=str).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    def _body(self):
        n = int(self.headers.get("content-length") or 0)
        return self.rfile.read(n) if n else b""

    def _file(self, path, ctype):
        size = os.path.getsize(path)
        rng = self.headers.get("range")
        start, end = 0, size - 1
        if rng and rng.startswith("bytes=") and size:
            a, _, b = rng[6:].partition("-")
            start = int(a) if a else max(0, size - int(b))
            end = min(int(b), size - 1) if a and b else size - 1
            self.send_response(206)
            self.send_header("content-range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("content-type", ctype)
        self.send_header("accept-ranges", "bytes")
        self.send_header("content-length", str(max(0, end - start + 1)))
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(1 << 16, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    def do_GET(self):
        p = self.path.split("?")[0]
        if p in ("/", "/index.html"):
            return self._file(os.path.join(HERE, "index.html"), "text/html; charset=utf-8")
        if p == "/healthz":
            return self._json(200, {"ok": True})
        if p == "/api/schema":
            return self._json(200, {"groups": SCHEMA, "models": available_models(), "modelDefaults": MODEL_DEFAULTS})
        if p == "/api/status":
            return self._json(200, {"models": {**{k: models[k] for k in ("status", "message", "settings")}, "components": model_status()},
                                    "queue": list(jobs.values())})
        if p == "/api/history":
            return self._json(200, load_history())
        if p == "/api/uploads":
            return self._json(200, sorted(os.listdir(UPLOADS), reverse=True))
        if p == "/api/jukebox":
            return self._json(200, jukebox_snapshot())
        for prefix, base in (("/out/", OUT), ("/uploads/", UPLOADS)):
            if p.startswith(prefix):
                name = os.path.basename(p[len(prefix):])
                fp = os.path.join(base, name)
                if name and os.path.isfile(fp):
                    return self._file(fp, TYPES.get(os.path.splitext(name)[1].lower(), "application/octet-stream"))
        self._json(404, {"error": "not found"})

    def do_POST(self):
        p = self.path.split("?")[0]
        try:
            if p == "/api/generate":
                b = json.loads(self._body() or b"{}")
                job = {"id": uuid.uuid4().hex, "values": b.get("values", {}), "models": b.get("models", {}), "status": "queued", "created": time.time()}
                for name, value in job["values"].items():
                    coerce(name, value)  # validate early (audio paths, numbers)
                jobs[job["id"]] = job
                with cond:
                    queue.append(job)
                    cond.notify()
                return self._json(200, job)
            if p.startswith("/api/jukebox/"):
                b = json.loads(self._body() or b"{}")
                fn = {"start": jukebox_start, "playing": jukebox_playing, "add": jukebox_add, "remove": jukebox_remove}.get(p[13:])
                if fn:
                    return self._json(200, fn(b))
                if p[13:] in ("stop", "skip"):
                    return self._json(200, jukebox_stop() if p[13:] == "stop" else jukebox_skip())
            if p == "/api/upload":
                name = re.sub(r"[^\w.\- ]+", "_", os.path.basename(self.headers.get("x-filename") or "upload.wav"))
                name = f"{time.strftime('%Y%m%d-%H%M%S')}-{name}"
                with open(os.path.join(UPLOADS, name), "wb") as f:
                    f.write(self._body())
                return self._json(200, {"path": "uploads/" + name})
            if p == "/api/unload":
                if any(j["status"] == "running" for j in list(jobs.values())) or not try_unload():
                    return self._json(409, {"error": "a job is running"})
                return self._json(200, {"ok": True})
            if p == "/api/keepalive":
                touch_activity()
                return self._json(200, {"ok": True, "unload_in_s": model_status()["unload_in_s"]})
            if p == "/api/cancel":
                b = json.loads(self._body() or b"{}")
                with cond:
                    queue[:] = [j for j in queue if j["id"] != b.get("id")]
                if jobs.get(b.get("id"), {}).get("status") == "queued":
                    jobs.pop(b.get("id"), None)
                return self._json(200, {"ok": True})
            if p == "/api/delete":
                # Never delete outright: generated files move to ~/.rigs/trash.
                b = json.loads(self._body() or b"{}")
                trash = os.path.expanduser("~/.rigs/trash")
                os.makedirs(trash, exist_ok=True)
                with state_lock:
                    keep = []
                    for it in load_history():
                        if it["id"] != b.get("id"):
                            keep.append(it)
                            continue
                        for fl in it.get("files", []):
                            src = os.path.join(OUT, fl["file"])
                            if os.path.exists(src):
                                shutil.move(src, os.path.join(trash, fl["file"]))
                    save_history(keep)
                return self._json(200, {"ok": True})
        except (ValueError, json.JSONDecodeError) as e:
            return self._json(400, {"error": str(e)})
        self._json(404, {"error": "not found"})

    def do_PATCH(self):
        try:
            if self.path.split("?")[0] == "/api/jukebox":
                return self._json(200, jukebox_patch(json.loads(self._body() or b"{}")))
        except (ValueError, TypeError, json.JSONDecodeError) as e:
            return self._json(400, {"error": str(e)})
        self._json(404, {"error": "not found"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8191)
    a = ap.parse_args()
    threading.Thread(target=worker, daemon=True).start()
    threading.Thread(target=idle_watchdog, daemon=True).start()
    print(f"ACE-Step Studio on http://{a.host}:{a.port}", flush=True)
    ThreadingHTTPServer((a.host, a.port), H).serve_forever()


if __name__ == "__main__":
    main()
