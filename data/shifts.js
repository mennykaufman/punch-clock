// Cafeteria points/voucher catalog, transcribed from the employer's shift table.
// Each row: scheduled start/end time, meal vouchers (dairy/meat), and points awarded.
// dayRestriction is set only where the source table noted one (e.g. "(א'-ו')" = Sun-Fri only).
export const SHIFT_CATALOG = [
  { start: "00:00", end: "07:00", vouchers: "2 חלבי", points: 100 },
  { start: "00:30", end: "08:30", vouchers: "2 חלבי", points: 100 },
  { start: "00:30", end: "09:30", vouchers: "2 חלבי", points: 100 },
  { start: "01:00", end: "08:30", vouchers: "2 חלבי", points: 100 },
  { start: "02:00", end: "07:00", vouchers: "1 בשרי", points: 100 },
  { start: "02:00", end: "08:30", vouchers: "2 חלבי", points: 100 },
  { start: "02:00", end: "09:30", vouchers: "2 חלבי", points: 100 },
  { start: "02:00", end: "10:15", vouchers: "2 חלבי", points: 100 },
  { start: "02:00", end: "11:00", vouchers: "2 חלבי", points: 100 },
  { start: "02:00", end: "12:00", vouchers: "2 חלבי", points: 100 },
  { start: "02:00", end: "12:30", vouchers: "2 חלבי + 1 בשרי", points: 200 },
  { start: "02:00", end: "14:00", vouchers: "2 חלבי + 1 בשרי", points: 200 },
  { start: "03:00", end: "13:00", vouchers: "2 חלבי", points: 100 },
  { start: "03:00", end: "14:00", vouchers: "2 חלבי + 1 בשרי", points: 200 },
  { start: "03:30", end: "08:30", vouchers: "1 בשרי", points: 100 },
  { start: "03:30", end: "09:30", vouchers: "1 בשרי", points: 100 },
  { start: "03:30", end: "10:15", vouchers: "2 חלבי", points: 100 },
  { start: "03:30", end: "11:00", vouchers: "2 חלבי", points: 100 },
  { start: "03:30", end: "12:30", vouchers: "2 חלבי", points: 100 },
  { start: "03:30", end: "13:00", vouchers: "2 חלבי", points: 100 },
  { start: "03:30", end: "13:30", vouchers: "2 חלבי", points: 100 },
  { start: "03:30", end: "14:30", vouchers: "2 חלבי + 1 בשרי", points: 200 },
  { start: "03:30", end: "15:30", vouchers: "2 חלבי + 1 בשרי", points: 200 },
  { start: "04:00", end: "09:30", vouchers: "1 חלבי + 1 בשרי", points: 150 },
  { start: "04:00", end: "10:15", vouchers: "1 חלבי + 1 בשרי", points: 150 },
  { start: "04:00", end: "11:00", vouchers: "1 חלבי + 1 בשרי", points: 150 },
  { start: "05:00", end: "10:15", vouchers: "1 חלבי + 1 בשרי", points: 150 },
  { start: "05:00", end: "11:00", vouchers: "1 חלבי + 1 בשרי", points: 150 },
  { start: "05:00", end: "13:00", vouchers: "1 חלבי + 1 בשרי", points: 150 },
  { start: "05:00", end: "13:30", vouchers: "1 חלבי + 1 בשרי", points: 150 },
  { start: "05:00", end: "14:30", vouchers: "1 חלבי + 1 בשרי", points: 150 },
  { start: "05:00", end: "15:30", vouchers: "1 חלבי + 1 בשרי", points: 150 },
  { start: "06:00", end: "16:00", vouchers: "1 חלבי + 1 בשרי", points: 150 },
  { start: "06:00", end: "17:00", vouchers: "1 חלבי + 1 בשרי", points: 150 },
  { start: "06:00", end: "18:00", vouchers: "1 חלבי + 2 בשרי", points: 250 },
  { start: "06:40", end: "13:00", vouchers: "1 חלבי + 1 בשרי", points: 150 },
  { start: "06:40", end: "16:00", vouchers: "1 חלבי + 1 בשרי", points: 150 },
  { start: "07:00", end: "17:00", vouchers: "1 חלבי + 1 בשרי", points: 150 },
  { start: "07:00", end: "18:00", vouchers: "1 חלבי + 1 בשרי", points: 150 },
  { start: "07:00", end: "19:00", vouchers: "1 חלבי + 2 בשרי", points: 250 },
  { start: "08:00", end: "13:00", vouchers: "1 בשרי", points: 100 },
  { start: "08:00", end: "14:00", vouchers: "1 בשרי", points: 100 },
  { start: "08:00", end: "16:00", vouchers: "1 בשרי", points: 100, dayRestriction: "א'-ו'" },
  { start: "08:00", end: "17:00", vouchers: "1 בשרי", points: 100 },
  { start: "08:00", end: "18:00", vouchers: "1 בשרי", points: 100 },
  { start: "09:00", end: "18:00", vouchers: "1 בשרי", points: 100 },
  { start: "09:00", end: "19:00", vouchers: "1 בשרי", points: 100 },
  { start: "09:00", end: "21:00", vouchers: "2 בשרי", points: 200 },
  { start: "09:30", end: "17:30", vouchers: "1 בשרי", points: 100 },
  { start: "09:30", end: "18:30", vouchers: "1 בשרי", points: 100 },
  { start: "10:00", end: "16:00", vouchers: "1 בשרי", points: 100 },
  { start: "10:00", end: "17:00", vouchers: "1 בשרי", points: 100 },
  { start: "10:00", end: "18:00", vouchers: "1 בשרי", points: 100 },
  { start: "10:00", end: "19:00", vouchers: "1 בשרי", points: 100 },
  { start: "10:00", end: "21:00", vouchers: "1 בשרי", points: 100 },
  { start: "11:00", end: "16:00", vouchers: "1 בשרי", points: 100 },
  { start: "11:00", end: "17:00", vouchers: "1 בשרי", points: 100 },
  { start: "11:00", end: "18:00", vouchers: "1 בשרי", points: 100 },
  { start: "11:00", end: "19:00", vouchers: "1 בשרי", points: 100 },
  { start: "11:00", end: "21:00", vouchers: "2 בשרי", points: 200 },
  { start: "11:00", end: "22:00", vouchers: "2 בשרי", points: 200 },
  { start: "11:00", end: "23:00", vouchers: "2 בשרי", points: 200 },
  { start: "12:30", end: "17:30", vouchers: "2 בשרי", points: 200 },
  { start: "12:30", end: "18:00", vouchers: "1 בשרי", points: 100 },
  { start: "12:30", end: "19:00", vouchers: "1 בשרי", points: 100 },
  { start: "12:30", end: "21:00", vouchers: "2 בשרי", points: 200 },
  { start: "12:30", end: "22:00", vouchers: "2 בשרי", points: 200 },
  { start: "12:30", end: "00:30", vouchers: "2 בשרי", points: 200 },
  { start: "13:00", end: "00:30", vouchers: "2 בשרי", points: 200 },
  { start: "13:30", end: "01:30", vouchers: "2 בשרי", points: 200 },
  { start: "14:00", end: "19:00", vouchers: "1 בשרי", points: 100 },
  { start: "14:00", end: "21:00", vouchers: "1 בשרי", points: 100 },
  { start: "14:00", end: "22:00", vouchers: "1 בשרי", points: 100 },
  { start: "14:00", end: "00:30", vouchers: "2 בשרי", points: 200 },
  { start: "14:00", end: "01:30", vouchers: "2 בשרי", points: 200 },
  { start: "15:45", end: "21:00", vouchers: "1 בשרי", points: 100 },
  { start: "15:45", end: "00:30", vouchers: "1 בשרי", points: 100 },
  { start: "15:45", end: "01:30", vouchers: "1 בשרי", points: 100 },
  { start: "15:45", end: "02:30", vouchers: "2 בשרי", points: 200 },
  { start: "15:45", end: "03:00", vouchers: "2 בשרי", points: 200 },
  { start: "18:00", end: "00:30", vouchers: "1 בשרי", points: 100 },
  { start: "18:00", end: "01:30", vouchers: "1 בשרי", points: 100 },
  { start: "18:00", end: "02:30", vouchers: "1 בשרי", points: 100 },
  { start: "18:00", end: "03:00", vouchers: "1 בשרי", points: 100 },
  { start: "18:00", end: "06:00", vouchers: "2 חלבי + 1 בשרי", points: 200 },
  { start: "19:00", end: "00:30", vouchers: "1 בשרי", points: 100 },
  { start: "19:00", end: "01:30", vouchers: "2 חלבי", points: 100 },
  { start: "19:00", end: "02:30", vouchers: "2 חלבי", points: 100 },
  { start: "19:00", end: "03:00", vouchers: "2 חלבי", points: 100 },
  { start: "19:00", end: "04:00", vouchers: "2 חלבי", points: 100 },
  { start: "19:00", end: "06:00", vouchers: "2 חלבי + 1 בשרי", points: 200 },
  { start: "20:00", end: "00:30", vouchers: "1 בשרי", points: 100 },
  { start: "20:00", end: "01:30", vouchers: "1 בשרי", points: 100 },
  { start: "20:00", end: "03:00", vouchers: "2 חלבי", points: 100 },
  { start: "20:00", end: "06:00", vouchers: "2 חלבי", points: 100 },
  { start: "20:00", end: "07:00", vouchers: "2 חלבי + 1 בשרי", points: 200 },
  { start: "21:00", end: "01:30", vouchers: "1 חלבי", points: 50 },
  { start: "21:00", end: "02:30", vouchers: "1 בשרי", points: 100 },
  { start: "21:00", end: "03:00", vouchers: "1 בשרי", points: 100 },
  { start: "21:00", end: "04:00", vouchers: "2 חלבי", points: 100 },
  { start: "21:00", end: "06:00", vouchers: "2 חלבי", points: 100 },
  { start: "21:00", end: "07:00", vouchers: "2 חלבי", points: 100 },
  { start: "21:00", end: "08:30", vouchers: "3 חלבי", points: 150 },
  { start: "22:00", end: "03:00", vouchers: "1 חלבי", points: 50 },
  { start: "22:00", end: "06:00", vouchers: "2 חלבי", points: 100 },
  { start: "22:00", end: "07:00", vouchers: "2 חלבי", points: 100 },
  { start: "22:00", end: "08:30", vouchers: "3 חלבי", points: 150 },
  { start: "22:00", end: "09:30", vouchers: "3 חלבי", points: 150 },
  { start: "22:30", end: "06:00", vouchers: "2 חלבי", points: 100 },
  { start: "22:30", end: "07:00", vouchers: "2 חלבי", points: 100 },
  { start: "22:30", end: "08:00", vouchers: "2 חלבי", points: 100 },
  { start: "23:30", end: "06:00", vouchers: "2 חלבי", points: 100 },
  { start: "23:30", end: "07:00", vouchers: "2 חלבי", points: 100 },
  { start: "23:30", end: "08:30", vouchers: "2 חלבי", points: 100 },
  { start: "23:30", end: "09:30", vouchers: "2 חלבי", points: 100 },
  { start: "23:30", end: "10:15", vouchers: "3 חלבי", points: 150 },
  { start: "23:30", end: "11:00", vouchers: "3 חלבי", points: 150 },
];

// All distinct scheduled start times present in the catalog, sorted as minutes-from-midnight.
export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function distinctStarts() {
  return [...new Set(SHIFT_CATALOG.map((s) => s.start))];
}

// Given an actual clock-in Date, return every catalog row whose scheduled start is
// closest to the actual time (wrapping across midnight) — e.g. clocking in at 17:42
// shows only the 18:00 shifts, never a shift starting hours away. A fixed window (the
// previous approach) could come up empty in the catalog's sparser stretches — e.g. the
// 15:45→18:00 gap — silently dumping the user into the full unfiltered list, which is
// exactly the "long list of every shift" complaint this replaces. Picking the nearest
// start(s) instead always returns a short, relevant set.
export function matchShiftByClockIn(clockInDate) {
  const actualMinutes = clockInDate.getHours() * 60 + clockInDate.getMinutes();

  let bestDist = Infinity;
  for (const s of SHIFT_CATALOG) {
    const dist = Math.abs(toMinutes(s.start) - actualMinutes);
    bestDist = Math.min(bestDist, dist, 1440 - dist);
  }

  const candidates = SHIFT_CATALOG.filter((s) => {
    const dist = Math.abs(toMinutes(s.start) - actualMinutes);
    return Math.min(dist, 1440 - dist) === bestDist;
  });

  return { candidates };
}

// Given the shift's start (already fixed at clock-in) and the ACTUAL clock-out time,
// find the catalog row (sharing that start) whose end best matches reality — so a
// shift that ran longer or shorter than originally picked still gets the right
// points/vouchers. Returns null if nothing reasonably close is found (keep the
// originally picked row in that case).
export function matchShiftByActualEnd(start, clockOutDate, maxDistanceMinutes = 90) {
  const actualMinutes = clockOutDate.getHours() * 60 + clockOutDate.getMinutes();
  const candidates = SHIFT_CATALOG.filter((s) => s.start === start);

  let best = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const endMinutes = toMinutes(c.end);
    let dist = Math.abs(endMinutes - actualMinutes);
    dist = Math.min(dist, 1440 - dist); // wrap around midnight
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }

  if (best === null || bestDist > maxDistanceMinutes) return null;
  return best;
}
