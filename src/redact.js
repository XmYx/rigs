// Secret redaction shared by the server (trace.js: every span field) and the UI (ui/src/exhibits-model.js: tool-call
// summaries in the Exhibit window). No imports, so the UI bundle and Node tests load it as is. Pure.

export const SECRET_KEY = /^(?:.*[_-])?(?:pass(?:word|wd)?|secret|token|api[_-]?key|apikey|auth(?:orization)?|cookie|credentials?|private[_-]?key|session[_-]?key)$|^(?:meshToken|authHeader|accessToken|refreshToken|apiKey|clientSecret)$/i;
export const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  [/\bsk-ant-[\w-]{10,}/g, 'sk-ant-***'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, 'sk-***'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, 'gh*_***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_***'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, 'xox*-***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, 'AIza***'],
  [/\bhf_[A-Za-z0-9]{8,}/g, 'hf_***'],
  [/\blin_(?:api|oauth)_[A-Za-z0-9]{8,}/g, 'lin_***'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted jwt]'],
  [/(bearer\s+)[^\s"']+/gi, '$1***'],
  [/(\b(?:x-rigs-token|authorization|cookie)\s*[:=]\s*)[^\s"',}]+/gi, '$1***'],
  [/((?:--token|--password|--api-key|--secret)[= ])[^\s&"']+/gi, '$1***'],
  [/(\b[\w-]*(?:token|password|passwd|secret|api_?key)\s*[=:]\s*["']?)[^\s&"',}*]{4,}/gi, '$1***'],
  [/(\/\/[^/\s:@]+:)[^@\s/]+@/g, '$1***@'],
];

/** Hide secret-looking values in a string (API keys, tokens, bearer headers, passwords, URL credentials, private keys). */
export function redact(s) {
  let out = String(s ?? '');
  for (const [re, to] of SECRET_PATTERNS) out = out.replace(re, to);
  return out;
}

/** Deep copy with every string redacted and every secret-named key's value replaced. Pure. */
export function redactValue(v, depth = 0) {
  if (typeof v === 'string') return redact(v);
  if (v == null || typeof v !== 'object') return v;
  if (depth > 12) return '[too deep]';
  if (Array.isArray(v)) return v.map((x) => redactValue(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) && x != null && x !== '' && typeof x !== 'boolean' && typeof x !== 'number' ? '***' : redactValue(x, depth + 1);
  return out;
}
