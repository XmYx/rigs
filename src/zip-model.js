// Pure rules behind zip/unzip (src/files.js `zip` / `unzip`): which archive entry names may be written, how a name
// is made unique instead of overwriting, and the size limits. No fs here, so it is unit-tested in
// test/file-tools.test.js.

export const ZIP_LIMITS = Object.freeze({
  maxBytes: 512 * 1024 * 1024, // total uncompressed bytes going into or coming out of one archive
  maxEntries: 20000,
});

/** Limits from config.files.zip ({ maxBytes, maxEntries }), clamped to sane values. */
export function zipLimits(cfg = {}) {
  const num = (v, d, lo, hi) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.min(hi, Math.max(lo, Math.floor(Number(v)))) : d);
  return {
    maxBytes: num(cfg?.maxBytes, ZIP_LIMITS.maxBytes, 1024, 4 * 1024 * 1024 * 1024),
    maxEntries: num(cfg?.maxEntries, ZIP_LIMITS.maxEntries, 1, 1000000),
  };
}

/**
 * The relative path an archive entry may be extracted to, or null when it must be refused (zip-slip):
 * absolute paths (/x, \x, C:\x, C:x, //server/share), any '..' segment, NUL or other control characters.
 * Backslashes count as separators; empty and '.' segments are dropped. A directory entry keeps its trailing '/'.
 */
export function safeEntryPath(name) {
  if (typeof name !== 'string' || !name) return null;
  if (/[\u0000-\u001f]/.test(name)) return null;
  const s = name.replace(/\\/g, '/');
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return null;
  const dir = s.endsWith('/');
  const parts = s.split('/').filter((p) => p && p !== '.');
  if (!parts.length || parts.some((p) => p === '..')) return null;
  // Windows reads "a:b" as a stream and "con"/"nul" as devices; refuse names no OS can hold safely.
  if (parts.some((p) => /[<>:"|?*]/.test(p) || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(p) || /[. ]$/.test(p))) return null;
  return parts.join('/') + (dir ? '/' : '');
}

/** Split "report.final.csv" → ["report.final", ".csv"], keeping double extensions like ".tar.gz" together. */
export function splitExt(name) {
  const m = /^(.+?)(\.tar\.(?:gz|bz2|xz|zst)|\.[^.\s]{1,10})?$/i.exec(name);
  if (!m || !m[2]) return [name, ''];
  return [m[1], m[2]];
}

/**
 * `name` itself when free, else "name (2).ext", "name (3).ext", … — never overwrite. `taken(n)` says whether a
 * name is used (sync). A folder (`dir`) gets the suffix at the end: "sales.csv (2)".
 */
export function uniqueName(name, taken, { dir = false } = {}) {
  if (!taken(name)) return name;
  const [base, ext] = dir ? [name, ''] : splitExt(name);
  for (let i = 2; i < 100000; i++) {
    const n = `${base} (${i})${ext}`;
    if (!taken(n)) return n;
  }
  throw new Error(`no free name for ${name}`);
}

/** Default archive name for a selection: "<name>.zip" for one item, "Archive.zip" for several. */
export function archiveName(paths) {
  if (paths.length === 1) {
    const n = String(paths[0]).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    return (n || 'Archive') + '.zip';
  }
  return 'Archive.zip';
}

/** Default folder to extract "photos.zip" into: "photos". */
export function extractFolderName(archive) {
  const n = String(archive).split(/[\\/]/).pop() || 'archive';
  const base = n.replace(/\.zip$/i, '');
  return base && base !== n ? base : n + ' contents';
}

/**
 * Check what an archive says it holds before anything is inflated. `entries` = [{ name, originalSize }].
 * → { ok: true, entries: [{ name, path, dir, size }], total } or { ok: false, error, name? }.
 */
export function planExtract(entries, limits = ZIP_LIMITS) {
  if (entries.length > limits.maxEntries) return { ok: false, error: `archive has ${entries.length} entries; the limit is ${limits.maxEntries}` };
  const out = [];
  let total = 0;
  for (const e of entries) {
    const p = safeEntryPath(e.name);
    if (!p) return { ok: false, error: `unsafe path in archive: ${JSON.stringify(e.name)}`, name: e.name };
    total += Math.max(0, Number(e.originalSize) || 0);
    if (total > limits.maxBytes) return { ok: false, error: `archive unpacks to more than ${limits.maxBytes} bytes (size cap)` };
    out.push({ name: e.name, path: p.replace(/\/$/, ''), dir: p.endsWith('/'), size: Number(e.originalSize) || 0 });
  }
  return { ok: true, entries: out, total };
}
