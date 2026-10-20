// The "Local responder" control in the Brain popover: switches the optional local first-responder model
// (src/responder.js, config.quick.local) and shows whether its model and its voice are reachable. Off by default;
// the setting is mesh-global (POST /api/local/quick {local}). The view model is pure and unit-tested.

/** status = GET responder/status of the host, tts = GET /api/local/tts, → what the control shows. */
export function responderView({ settings = {}, status = null, tts = null, hostKnown = true } = {}) {
  const on = !!settings.enabled;
  const host = settings.node || status?.node || '';
  const model = settings.model || status?.model || 'qwen3:8b';
  let modelDot = 'off';
  let modelText = 'Off — quick replies use Haiku.';
  if (on) {
    if (!status || !hostKnown) { modelDot = 'bad'; modelText = `${host || 'host'} is not reachable`; }
    else if (status.reachable === false) { modelDot = 'bad'; modelText = status.error || 'Ollama is not reachable'; }
    else if (status.installed === false) { modelDot = 'bad'; modelText = `${model} is not installed`; }
    else if (status.loaded) { modelDot = 'ok'; modelText = `${model} loaded${status.sizeVramMb ? ` · ${(status.sizeVramMb / 1024).toFixed(1)} GB VRAM` : ''}`; }
    else { modelDot = 'warn'; modelText = `${model} installed, not loaded yet — it loads on the first reply`; }
  }
  const voiceOk = !!tts?.engine;
  const voiceName = tts?.engine === 'piper' ? 'JARVIS voice (Piper)' : tts?.engine || '';
  return {
    on, host, model, modelDot, modelText,
    voiceDot: voiceOk ? 'ok' : 'bad',
    voiceText: voiceOk ? voiceName : 'no speech engine — the browser voice speaks',
    title: `Local responder${host ? ` (${host})` : ''}`,
    where: 'Configured in config.quick.local · `rigs quick local on|off|status`',
  };
}

/** The discreet label a locally answered reply carries (the start event of a quick turn). */
export function replyLabel(e = {}) {
  if (e.lane !== 'quick') return null;
  if (e.tier === 'local') return { name: 'local', detail: `${e.model || 'local model'}${e.node ? ' · ' + e.node : ''}` };
  return null;
}
