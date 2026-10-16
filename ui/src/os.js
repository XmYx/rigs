// The agentic-OS layer: what JARVIS is doing shows up on screen as it happens. A tray of activity chips
// pops in for every tool the brain uses (and fades out when it finishes), and items that appear on the
// mesh (new apps, sessions, projects) materialise with an animation instead of just appearing.

let tray = null;
const seen = new Map(); // key → Set of ids already on screen

function ensureTray() {
  if (tray) return tray;
  tray = document.createElement('div');
  tray.id = 'activity';
  tray.setAttribute('aria-live', 'polite');
  document.body.append(tray);
  return tray;
}

/** Human label for a tool name: mcp__rigs__mesh_app_register → "mesh app register". */
export function toolLabel(name = '') {
  return String(name).replace(/^mcp__[^_]+(?:_[^_]+)*__/, '').replace(/[_-]+/g, ' ').trim() || 'working';
}

/**
 * Show an activity chip. Returns { done(ok?), update(detail) }. Chips stay while running (pulsing ring),
 * turn green or red on finish and leave after a moment; at most six are kept.
 */
export function activity(name, detail = '') {
  const t = ensureTray();
  const chip = document.createElement('div');
  chip.className = 'act-chip running';
  chip.innerHTML = '<span class="act-ring"></span><span class="act-name"></span><span class="act-detail"></span>';
  chip.querySelector('.act-name').textContent = toolLabel(name);
  chip.querySelector('.act-detail').textContent = String(detail || '').slice(0, 90);
  t.prepend(chip);
  while (t.children.length > 6) t.lastElementChild.remove();
  requestAnimationFrame(() => chip.classList.add('in'));
  const finish = (ok = true) => {
    chip.classList.remove('running');
    chip.classList.add(ok ? 'ok' : 'bad');
    setTimeout(() => { chip.classList.add('out'); setTimeout(() => chip.remove(), 500); }, ok ? 2200 : 5000);
  };
  return {
    done: finish,
    update(d) { chip.querySelector('.act-detail').textContent = String(d || '').slice(0, 90); },
  };
}

/**
 * Items that newly appear in a list get the materialise animation. `key` names the list; `ids` is the
 * current set of ids. Returns the ids that are new since the last call (the first call marks none as new).
 */
export function freshIds(key, ids) {
  const prev = seen.get(key);
  const now = new Set(ids);
  seen.set(key, now);
  if (!prev) return new Set();
  return new Set([...now].filter((id) => !prev.has(id)));
}
