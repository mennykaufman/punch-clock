// Pay calculation engine.
// Status (2026-08-01): the "corrected" formula from the forensic investigation (425min
// night standard, unpaid-break deduction, monthly-lagged seniority bonus) showed an
// 11-15% deviation against real May/June payslips — worse than expected. Pending an
// official answer from payroll (Bar) on the open questions (night-shift OT threshold,
// exact Shabbat window, seniority-bonus timing/rate), this file is deliberately reverted
// to a conservative state:
//  - The +10% seniority ("פריון") bonus is REMOVED from the calculation entirely — we
//    know the old per-shift model was wrong and don't yet know the right one, so it's
//    better to show 0 than a confidently-wrong number. Re-add once Bar confirms the rule.
//  - The unpaid half-hour break deduction IS kept by default — this one we've confirmed
//    to the minute against real payslips independent of the other open questions.
//  - Base wage 35.40 ILS/hour (or whatever's configured in Settings).
//
// options.skipBreakDeduction (admin-only rollout, 2026-08-01): re-verifying June/May
// against real payslips shows the 425-min night-OT threshold lines up almost exactly
// with the RAW shift duration, not the post-break "payable" duration — i.e. the unpaid
// break doesn't shift where overtime starts. With the break subtracted first (the
// default below), computed 225% hours came out ~9h short of the real June payslip;
// without it, the gap shrank to under 1h for June and under 6 minutes for May. Still a
// small unexplained residual, so this is opt-in (admin only) until confirmed further.
//  - Every minute of the actual worked shift is classified as day/evening/night/shabbat
//    by real clock time, then overtime is layered on top of that per-minute rate.
//  - "Night flip": if the shift's overlap with the night window (22:00-06:00, counted
//    across the whole shift, including minutes that are also inside the Shabbat window)
//    is >= 2h16m, every NON-Shabbat minute is reclassified to night rate. Evening minutes
//    never contribute to this threshold and never trigger a flip on their own.
//  - Overtime: day-classified shifts get a 8h/day standard (hours 9-10 = x1.25, 11+ = x1.5,
//    the classic two-step Israeli law). Night-classified (flipped) shifts get a 7h standard
//    with a single x1.5 bump beyond that.
//  - Shabbat minutes are always flat 300%, never bumped by overtime.

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
const UNPAID_BREAK_THRESHOLD_MINUTES = 6 * 60; // shifts longer than this lose an unpaid break
const UNPAID_BREAK_MINUTES = 30; // deducted from the shift's tail end, not the middle

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
// Kept for the Settings "eligible after 3 months" display — not used by calculatePay
// right now, since the bonus itself is disabled pending payroll's answer.
export function isProductivityBonusEligible(employmentStartDate, today = new Date()) {
  if (!employmentStartDate) return false;
  const start = new Date(employmentStartDate);
  const threeMonthsIn = new Date(start);
  threeMonthsIn.setMonth(threeMonthsIn.getMonth() + 3);
  return today >= threeMonthsIn;
}

// clockIn/clockOut: real Date objects captured at the moment of punching (clockOut > clockIn).
// options: { idfBonusPercent: 0|2|3, baseWageILS?: number, skipBreakDeduction?: boolean }
export function calculatePay(clockIn, clockOut, options = {}) {
  const wage = options.baseWageILS > 0 ? options.baseWageILS : BASE_WAGE_ILS;
  const totalMinutes = Math.round((clockOut.getTime() - clockIn.getTime()) / 60000);
  // Number.isFinite (not just <= 0) so an invalid Date or NaN input throws here loudly
  // instead of silently producing a zero-hours, zero-pay result further down.
  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) {
    throw new Error("clockOut must be after clockIn");
  }

  let nightOverlapMinutes = 0;
  for (let i = 0; i < totalMinutes; i++) {
    const t = new Date(clockIn.getTime() + i * 60000);
    if (isInNightWindow(t)) nightOverlapMinutes++;
  }
  const flip = nightOverlapMinutes >= NIGHT_FLIP_THRESHOLD_MINUTES;
  const standardMinutes = flip ? NIGHT_STANDARD_MINUTES : DAY_STANDARD_MINUTES;

  const breakMinutes = !options.skipBreakDeduction && totalMinutes > UNPAID_BREAK_THRESHOLD_MINUTES
    ? UNPAID_BREAK_MINUTES
    : 0;
  // Simply stop counting the last `breakMinutes` minutes of the shift — since the loop
  // below walks forward from clock-in, this naturally lands the deduction on whichever
  // rate was in effect right at the end, matching how the real payslip does it. When
  // skipBreakDeduction is set, breakMinutes is 0 and the standard/OT split runs over the
  // shift's full raw duration instead (see the file header for why).
  const payableMinutes = Math.max(0, totalMinutes - breakMinutes);

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

  for (let i = 0; i < payableMinutes; i++) {
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

  // No seniority bonus applied — disabled pending payroll's answer (see file header).
  const idfBonusPercent = options.idfBonusPercent > 0 ? options.idfBonusPercent : 0;
  const finalPay = preBonusPay * (1 + idfBonusPercent / 100);

  return {
    totalHours: round2(totalMinutes / 60),
    breakMinutesDeducted: breakMinutes,
    payableHours: round2(payableMinutes / 60),
    nightOverlapHours: round2(nightOverlapMinutes / 60),
    nightFlipTriggered: flip,
    standardHours: round2(standardMinutes / 60),
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
    idfBonusPercent,
    // Records which OT model produced this result, so a caller can cheaply detect
    // drift later (e.g. after a role change) without having to recompute to check.
    skipBreakDeductionApplied: !!options.skipBreakDeduction,
    finalPayILS: round2(finalPay),
  };
}
