// GPU overseer client (localhost:8195): before ComfyUI loads a video model we ask for a VRAM lease, so
// the overseer unloads idle holders (other apps) instead of letting the GPU run out; when the live loop
// goes idle we release it.
//   POST api/acquire {client, need_mb, timeout} → {ok, free_mb, unloaded}
//   POST api/release {client}
// The lease is taken in ComfyUI's name (client "comfyui" by default): ComfyUI is the process that holds
// the memory, so what it has already loaded counts toward the need and it is never unloaded for us.
export function createOverseer({ url = 'http://127.0.0.1:8195', client = 'comfyui', fetchImpl = globalThis.fetch, timeoutS = 90 } = {}) {
  const base = String(url).replace(/\/+$/, '');
  let held = false;
  const post = async (p, body, ms) => {
    const r = await fetchImpl(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  return {
    get held() { return held; },
    /** {ok, free_mb, unloaded} from the overseer, or {ok:false, unreachable:true, error} when it is not there. */
    async acquire(needMb) {
      try {
        const r = await post('/api/acquire', { client, need_mb: Math.round(needMb), timeout: timeoutS }, (timeoutS + 15) * 1000);
        held = !!r?.ok;
        return { ok: !!r?.ok, free_mb: r?.free_mb ?? null, unloaded: r?.unloaded || [] };
      } catch (e) {
        return { ok: false, unreachable: true, error: e.message };
      }
    },
    async release() {
      if (!held) return { ok: true, skipped: true };
      held = false;
      try { return await post('/api/release', { client }, 5000); } catch (e) { return { ok: false, error: e.message }; }
    },
  };
}
