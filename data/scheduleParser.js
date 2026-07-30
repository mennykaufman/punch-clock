// Parses a personal weekly-shift SMS from "משמרות.קום" into structured shifts.
// Each line looks like: "2.8 א' - 10:00-18:00 מלווה נוסעים" (day.month, a
// Hebrew day-of-week letter we never need since it's derivable from the date,
// a 24h start-end range, then free-text role). The header line and any
// unparseable text is reported back separately rather than silently dropped,
// since this data becomes visible to colleagues once saved.
const SHIFT_LINE_RE = /^(\d{1,2})\.(\d{1,2})\s+\S+\s*-\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s+(.+)$/;

export function parseDateOnlyLocal(dateISO) {
  const [y, m, d] = dateISO.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function inferYear(day, month, now) {
  const year = now.getFullYear();
  const candidate = new Date(year, month - 1, day);
  const diffDays = (candidate - now) / 86400000;
  // Schedules are always pasted for the current/near-future week; if the naive
  // current-year date lands more than 2 weeks in the past, it must be next year
  // (e.g. a schedule for early January pasted in late December).
  return diffDays < -14 ? year + 1 : year;
}

export function parseScheduleSms(text, { now = new Date() } = {}) {
  const shifts = [];
  const skippedLines = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(SHIFT_LINE_RE);
    if (!m) {
      skippedLines.push(raw);
      continue;
    }
    const [, dayStr, monthStr, sh, sm, eh, em, roleRaw] = m;
    const day = Number(dayStr);
    const month = Number(monthStr);
    if (day < 1 || day > 31 || month < 1 || month > 12) {
      skippedLines.push(raw);
      continue;
    }
    const year = inferYear(day, month, now);
    const startMinutes = Number(sh) * 60 + Number(sm);
    const endMinutes = Number(eh) * 60 + Number(em);
    const startDate = new Date(year, month - 1, day, Number(sh), Number(sm));
    const endDate = new Date(year, month - 1, day, Number(eh), Number(em));
    if (endMinutes <= startMinutes) endDate.setDate(endDate.getDate() + 1); // crosses midnight

    const pad = (n) => String(n).padStart(2, "0");
    shifts.push({
      dateISO: `${startDate.getFullYear()}-${pad(startDate.getMonth() + 1)}-${pad(startDate.getDate())}`,
      startISO: startDate.toISOString(),
      endISO: endDate.toISOString(),
      role: roleRaw.trim(),
    });
  }

  shifts.sort((a, b) => new Date(a.startISO) - new Date(b.startISO));
  return { shifts, skippedLines };
}
