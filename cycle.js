// Menstrual cycle phase helpers for H-CAR.
//
// Purpose: baseline adjustment only. A menstrual cycle changes the same
// signals H-CAR tracks (resting heart rate rises a little in the luteal
// phase, skin temperature rises, HRV dips). Without accounting for this,
// normal cycle changes look like abnormal changes and cause false flags
// for female users.
//
// What this is NOT:
// - It does not diagnose menstrual disorders.
// - It does not predict ovulation or fertility.
// - It does not predict periods. It only looks backwards at logged
//   cycle start dates to estimate which phase a past day fell in.
//
// Privacy: cycle dates are private to the user. They are never shared
// with family members, emergency contacts, or anyone else, never used
// for advertising, and never sold. Logging is optional; the app works
// fine without it.

// Expected luteal-phase rises, used to correct values before z-scoring
// so normal cycle changes are not flagged as abnormal. Magnitudes are
// conservative mid-range values from the literature:
// - resting heart rate rises about 2 to 3 bpm in the luteal phase.
// - skin temperature rises about 0.3 to 0.5 C in the luteal phase.
// HRV dips in the luteal phase but no single magnitude is well
// established, so HRV is not corrected here.
const LUTEAL_RHR_CORRECTION_BPM = 2.5;
const LUTEAL_TEMP_CORRECTION_C = 0.4;

// Day counts are 0-based offsets from cycle start (day 1 of bleeding).
// Follicular phase covers day 1 through day 14, luteal phase covers
// day 15 until the next cycle starts.
const FOLLICULAR_LAST_DAY_OFFSET = 13;

// If the most recent logged cycle started more than this many days ago
// and no new cycle was logged, the phase is unknown (stale data).
const MAX_CYCLE_AGE_DAYS = 45;

function parseDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return null;
  return Date.UTC(y, m - 1, d);
}

function dayDiff(startStr, endStr) {
  const s = parseDate(startStr);
  const e = parseDate(endStr);
  if (s === null || e === null) return null;
  return Math.round((e - s) / 86400000);
}

// Given logged cycles and a date, return 'follicular', 'luteal', or null.
// cycles: [{ start_date: 'YYYY-MM-DD', end_date: 'YYYY-MM-DD' | null }]
// sorted by start_date ascending. Returns null when there is no usable
// cycle history for the date.
function getCyclePhase(cycles, dateStr) {
  if (!Array.isArray(cycles) || cycles.length === 0) return null;
  const target = parseDate(dateStr);
  if (target === null) return null;

  // Latest cycle that started on or before the date.
  let current = null;
  for (const c of cycles) {
    if (!c || !c.start_date) continue;
    const start = parseDate(c.start_date);
    if (start === null || start > target) continue;
    if (!current || start > parseDate(current.start_date)) current = c;
  }
  if (!current) return null;

  // Note: end_date is when bleeding ended, not when the cycle ended.
  // The cycle runs until the next cycle starts, so end_date is not
  // used for phase estimation.
  const offset = dayDiff(current.start_date, dateStr);
  if (offset === null || offset < 0) return null;
  if (offset > MAX_CYCLE_AGE_DAYS) return null;
  return offset <= FOLLICULAR_LAST_DAY_OFFSET ? 'follicular' : 'luteal';
}

// 1-based cycle day for a date, or null when unknown.
function getCycleDay(cycles, dateStr) {
  if (!Array.isArray(cycles) || cycles.length === 0) return null;
  const target = parseDate(dateStr);
  if (target === null) return null;
  let current = null;
  for (const c of cycles) {
    if (!c || !c.start_date) continue;
    const start = parseDate(c.start_date);
    if (start === null || start > target) continue;
    if (!current || start > parseDate(current.start_date)) current = c;
  }
  if (!current) return null;
  const offset = dayDiff(current.start_date, dateStr);
  if (offset === null || offset < 0 || offset > MAX_CYCLE_AGE_DAYS) return null;
  return offset + 1;
}

// Mean gap in days between consecutive cycle starts, or null when fewer
// than two cycles are logged.
function averageCycleLength(cycles) {
  if (!Array.isArray(cycles) || cycles.length < 2) return null;
  const starts = cycles
    .map((c) => (c && c.start_date ? parseDate(c.start_date) : null))
    .filter((v) => v !== null)
    .sort((a, b) => a - b);
  if (starts.length < 2) return null;
  let total = 0;
  for (let i = 1; i < starts.length; i++) {
    total += Math.round((starts[i] - starts[i - 1]) / 86400000);
  }
  return Math.round((total / (starts.length - 1)) * 10) / 10;
}

// Summary of where the user is in their cycle today.
function currentPhaseInfo(cycles, todayStr) {
  const phase = getCyclePhase(cycles, todayStr);
  const cycleDay = getCycleDay(cycles, todayStr);
  const avgLength = averageCycleLength(cycles);
  return { phase, cycleDay, averageCycleLength: avgLength };
}

module.exports = {
  LUTEAL_RHR_CORRECTION_BPM,
  LUTEAL_TEMP_CORRECTION_C,
  FOLLICULAR_LAST_DAY_OFFSET,
  MAX_CYCLE_AGE_DAYS,
  getCyclePhase,
  getCycleDay,
  averageCycleLength,
  currentPhaseInfo,
};
