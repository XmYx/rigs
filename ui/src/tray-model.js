// Pure helpers for the menu bar's status tray (clock, calendar, session limit) — no DOM, unit-tested in test/tray.test.js.

export const WARN_PCT = 70;
export const BAD_PCT = 90;

/** Clock text for a Date: "14:05" (24h) or "2:05 PM" (12h). */
export function formatClock(date, hour12 = false) {
  const m = String(date.getMinutes()).padStart(2, '0');
  if (!hour12) return `${String(date.getHours()).padStart(2, '0')}:${m}`;
  const hr = date.getHours() % 12 || 12;
  return `${hr}:${m} ${date.getHours() < 12 ? 'AM' : 'PM'}`;
}

/** Milliseconds until the next whole minute (so one timer can tick exactly on the minute). */
export const msToNextMinute = (now) => 60000 - (now % 60000) || 60000;

/** Stored clock preference: only 'h12' means 12-hour; anything else (or no storage) is 24-hour. */
export const parseHour12 = (raw) => raw === 'h12';

/**
 * A month as weeks of 7 cells (Monday first): { day, inMonth, today } with leading/trailing days of the neighbouring
 * months filled in. `month` is 0–11.
 */
export function monthGrid(year, month, today = new Date(), weekStart = 1) {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() - weekStart + 7) % 7;
  const start = new Date(year, month, 1 - lead);
  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const row = [];
    for (let d = 0; d < 7; d++) {
      const cell = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d);
      row.push({
        day: cell.getDate(),
        inMonth: cell.getMonth() === month,
        today: cell.getFullYear() === today.getFullYear() && cell.getMonth() === today.getMonth() && cell.getDate() === today.getDate(),
      });
    }
    if (w >= 4 && !row.some((c) => c.inMonth)) break; // no empty trailing week
    weeks.push(row);
  }
  return weeks;
}

/** Previous/next month with year rollover. */
export function shiftMonth(year, month, delta) {
  const d = new Date(year, month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

/** 'ok' | 'warn' | 'bad' for a used percentage; 'unknown' when it isn't a number. */
export function limitTone(pct) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return 'unknown';
  return pct >= BAD_PCT ? 'bad' : pct >= WARN_PCT ? 'warn' : 'ok';
}

/** Used percentage clamped to 0–100 and rounded, or null. */
export const clampPct = (pct) => (typeof pct === 'number' && Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : null);

/** "in 2h 5m" / "in 3d 4h" / "now" for a reset time; '' when unknown. */
export function untilText(resetsAt, now = Date.now()) {
  const t = resetsAt ? Date.parse(resetsAt) : NaN;
  if (!Number.isFinite(t)) return '';
  const min = Math.round((t - now) / 60000);
  if (min <= 0) return 'now';
  if (min < 60) return `in ${min}m`;
  if (min < 48 * 60) return `in ${Math.floor(min / 60)}h ${min % 60}m`;
  return `in ${Math.floor(min / 1440)}d ${Math.floor((min % 1440) / 60)}h`;
}

/**
 * What the session-limit icon shows, from a plan-limits object ({ session, week, models, error } as /api/local/work?plan=1 returns it).
 * { tone, pct, label, title, rows } — `rows` are the popover lines.
 */
export function limitView(plan, now = Date.now()) {
  const s = plan?.session;
  const pct = clampPct(s?.pct);
  if (pct == null) {
    return { tone: 'unknown', pct: null, label: '–', title: plan?.error ? `Session limit unavailable: ${plan.error}` : 'Session limit: no data yet', rows: [] };
  }
  const row = (name, w) => ({ name, pct: clampPct(w.pct), tone: limitTone(w.pct), reset: untilText(w.resetsAt, now), resetsAt: w.resetsAt || null });
  const rows = [row('5-hour session', s)];
  if (plan.week && clampPct(plan.week.pct) != null) rows.push(row('Week · all models', plan.week));
  for (const m of plan.models || []) if (clampPct(m.pct) != null) rows.push(row(`Week · ${m.name}`, m));
  const reset = rows[0].reset;
  return { tone: limitTone(s.pct), pct, label: `${pct}%`, title: `Session limit: ${pct}% used${reset ? `, resets ${reset}` : ''}`, rows };
}
