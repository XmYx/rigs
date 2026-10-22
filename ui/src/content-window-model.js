// Pure rules of the generic content window (content-window.js): what the iframe may do and where "open in a tab"
// goes. No DOM, tested in test/content-window.test.js.

/** The sandbox every framed page gets: scripts, forms, popups and downloads, never the UI's own origin by default. */
export const BASE_SANDBOX = 'allow-scripts allow-forms allow-popups allow-downloads';

/** A same-origin API path: /api/... (an app's route, a report, a raw file). Absolute URLs and anything else are not. */
export const isSameOriginApi = (url) => /^\/api\/(?:[^/?#]|$)/.test(String(url || '').trim());

/**
 * Raw user content served from the mesh (a file in a folder or the shared folder): same-origin API, but it is
 * whatever an agent or a download put there, so it never runs with the UI's origin.
 */
export const isRawFile = (url) => /^\/api\/(?:nodes\/[^/]+\/|local\/)?(?:files\/raw|shared\/file)(?:[?#]|$)/.test(String(url || '').trim());

/**
 * The iframe sandbox for `url`: allow-same-origin only for a same-origin /api path that is not a raw file (App Cloud
 * apps need their cookies and fetches; a raw .html must not reach the API as the UI). `html` (srcdoc) gets scripts only.
 */
export function sandboxFor({ url = '', html = '' } = {}) {
  if (html && !url) return 'allow-scripts';
  const u = String(url || '').trim();
  return isSameOriginApi(u) && !isRawFile(u) ? `${BASE_SANDBOX} allow-same-origin` : BASE_SANDBOX;
}

/** Which of url / html / el the window shows (the first given wins), or null when nothing was given. */
export function frameKind({ url, html, el } = {}) {
  if (url) return 'url';
  if (html) return 'html';
  if (el) return 'el';
  return null;
}

/** Where "open in a browser tab" goes: the url as given; a srcdoc page gets a blob later (none here); an element has nowhere. */
export const tabTarget = ({ url = '' } = {}) => (/^(?:https?:\/\/|\/)/i.test(String(url || '').trim()) ? String(url).trim() : '');

/** A stable window key, so the same page reopens where it was: the caller's key, else the url. */
export const contentKey = ({ key, url, title } = {}) => String(key || (url ? `content:${url}` : title ? `content:${title}` : '')).slice(0, 200) || undefined;

/** The browser-tab-safe title: the host of an absolute URL, the last path segment of an API path, else the url. */
export function titleFor({ title, url = '' } = {}) {
  if (title) return String(title);
  const u = String(url || '').trim();
  const m = /^https?:\/\/([^/?#]+)/i.exec(u);
  if (m) return m[1];
  const seg = u.split(/[?#]/)[0].split('/').filter(Boolean).pop();
  return seg || u || 'Page';
}
