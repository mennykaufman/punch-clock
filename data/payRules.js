// Pay calculation engine.
// Rules confirmed with the user (see plan doc for full reasoning):
//  - Base wage 35.40 ILS/hour.
//  - Every minute of the actual worked shift is classified as day/evening/night/shabbat
//    by real clock time, then overtime is layered on top of that per-minute rate.
//  - "Night flip": if the shift's overlap with the night window (22:00-06:00, counted
//    across the whole shift, including minutes that are also inside the Shabbat window)
//    is >= 2h16m, every NON-Shabbat minute is reclassified to night rate. Evening minutes
//    never contribute to this threshold and never trigger a flip on their own.
//  - Overtime: day-classified shifts get a 8h/day standard (hours 9-10 = x1.25, 11+ = x1.5,
//    the classic two-step Israeli law). Night-classified (flipped) shifts get a 7h standard
//    (matches the real "night worker" reduced workday law) with a single x1.5 bump beyond
//    that -- this was reverse-engineered from one PDF example and is flagged as best-effort;
//    expect to adjust once verified against a real payslip.
//  - Shabbat minutes are always flat 300%, never bumped by overtime.
//  - +10% "פריון" bonus applied last, once employment has passed 3 months.

export const BASE_WAGE_ILS = 35.4;

const RATE = {
  day: 1.0,
  evening: 1.3,
  night: 1.5,
  shabbat: 3.0,
};

const NIGHT_FLIP_THRESHOLD_MINUTES = 136; // 2h16m
const DAY_STANDARD_MINUTES = 8 * 60;
const NIGHT_STANDARD_MINUTES = 7 * 60;
const DAY_OT_TIER1_MINUTES = 2 * 60; // hours 9-10

function isInNightWindow(date) {
  const hour = date.getHours() + date.getMinutes() / 60;
  return hour >= 22 || hour < 6;
}

// Shabbat window: Friday 16:00 through Sunday 06:00 (local time).
function isInShabbatWindow(date) {
  const dow = date.getDay(); // 0=Sun, 5=Fri, 6=Sat
  const hour = date.getHours() + date.getMinutes() / 60;
  if (dow === 5 && hour >= 16) return true;
  if (dow === 6) return true;
  if (dow === 0 && hour < 6) return true;
  return false;
}

function naturalCategory(date) {
  const hour = date.getHours() + date.getMinutes() / 60;
  if (hour >= 6 && hour < 16) return "day";
  if (hour >= 16 && hour < 22) return "evening";
  return "night";
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// today/startDate: Date objects (or anything `new Date(x)` accepts).
export function isProductivityBonusEligible(employmentStartDate, today = new Date()) {
  if (!employmentStartDate) return false;
  const start = new Date(employmentStartDate);
  const threeMonthsIn = new Date(start);
  threeMonthsIn.setMonth(threeMonthsIn.getMonth() + 3);
  return today >= threeMonthsIn;
}

// clockIn/clockOut: real Date objects captured at the moment of punching (clockOut > clockIn).
// options: { productivityBonusEligible: boolean, idfBonusPercent: 0|2|3, baseWageILS?: number }
export function calculatePay(clockIn, clockOut, options = {}) {
  const wage = options.baseWageILS > 0 ? options.baseWageILS : BASE_WAGE_ILS;
  const totalMinutes = Math.round((clockOut.getTime() - clockIn.getTime()) / 60000);
  if (totalMinutes <= 0) {
    throw new Error("clockOut must be after clockIn");
  }

  let nightOverlapMinutes = 0;
  for (let i = 0; i < totalMinutes; i++) {
    const t = new Date(clockIn.getTime() + i * 60000);
    if (isInNightWindow(t)) nightOverlapMinutes++;
  }
  const flip = nightOverlapMinutes >= NIGHT_FLIP_THRESHOLD_MINUTES;
  const standardMinutes = flip ? NIGHT_STANDARD_MINUTES : DAY_STANDARD_MINUTES;

  const hoursByCategory = { day: 0, evening: 0, night: 0, shabbat: 0 };
  // Minutes are bucketed by their exact final rate percentage (e.g. "100", "130", "150",
  // "162.5") so the breakdown can show precisely which rates applied and for how long —
  // night (150%) and Shabbat (300%) always land in separate buckets since they're
  // different percentages, and any rate with 0 minutes just never appears.
  const minutesByRatePercent = {};
  let regularMinutes = 0;
  let otTier1Minutes = 0; // the "125%-of-category" bracket (day-standard shifts only)
  let otTier2Minutes = 0; // the "150%-of-category" bracket (day-standard past tier 1, and the single night-shift OT bump)
  let preBonusPay = 0;

  for (let i = 0; i < totalMinutes; i++) {
    const t = new Date(clockIn.getTime() + i * 60000);
    const shabbat = isInShabbatWindow(t);
    const category = shabbat ? "shabbat" : flip ? "night" : naturalCategory(t);

    let multiplier = RATE[category];

    if (!shabbat && i >= standardMinutes) {
      if (flip) {
        multiplier *= 1.5;
        otTier2Minutes++;
      } else {
        const minutesPastThreshold = i - standardMinutes;
        if (minutesPastThreshold < DAY_OT_TIER1_MINUTES) {
          multiplier *= 1.25;
          otTier1Minutes++;
        } else {
          multiplier *= 1.5;
          otTier2Minutes++;
        }
      }
    } else if (!shabbat) {
      regularMinutes++;
    }

    const ratePercent = Math.round(multiplier * 1000) / 10; // e.g. 100, 130, 162.5
    minutesByRatePercent[ratePercent] = (minutesByRatePercent[ratePercent] || 0) + 1;

    hoursByCategory[category] += 1 / 60;
    preBonusPay += multiplier * (wage / 60);
  }

  const hoursByRate = Object.entries(minutesByRatePercent)
    .map(([rate, minutes]) => ({ ratePercent: Number(rate), hours: round2(minutes / 60) }))
    .sort((a, b) => a.ratePercent - b.ratePercent);

  const productivityBonusApplied = !!options.productivityBonusEligible;
  const idfBonusPercent = options.idfBonusPercent > 0 ? options.idfBonusPercent : 0;
  let bonusMultiplier = 1.0;
  if (productivityBonusApplied) bonusMultiplier *= 1.1;
  if (idfBonusPercent) bonusMultiplier *= 1 + idfBonusPercent / 100;
  const finalPay = preBonusPay * bonusMultiplier;

  return {
    totalHours: round2(totalMinutes / 60),
    nightOverlapHours: round2(nightOverlapMinutes / 60),
    nightFlipTriggered: flip,
    standardHours: standardMinutes / 60,
    overtimeHours: round2((otTier1Minutes + otTier2Minutes) / 60),
    regularHours: round2(regularMinutes / 60),
    overtimeTier1Hours: round2(otTier1Minutes / 60),
    overtimeTier2Hours: round2(otTier2Minutes / 60),
    hoursByCategory: {
      day: round2(hoursByCategory.day),
      evening: round2(hoursByCategory.evening),
      night: round2(hoursByCategory.night),
      shabbat: round2(hoursByCategory.shabbat),
    },
    hoursByRate,
    baseWageILS: wage,
    preBonusPayILS: round2(preBonusPay),
    productivityBonusApplied,
    idfBonusPercent,
    finalPayILS: round2(finalPay),
  };
}
