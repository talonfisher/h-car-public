// Health context helpers for H-CAR detector adjustments.
//
// These helpers estimate expected physiological changes from context a
// user optionally provides: pregnancy, high altitude, menopause status,
// and recent medication changes. They are used only to adjust detector
// expectations so normal, expected changes are not flagged as abnormal.
//
// What this is NOT:
// - It does not diagnose anything, including pregnancy complications,
//   medication side effects, or menopause-related conditions.
// - It does not predict medication effects. Medication changes are
//   only noted as context, never interpreted.
// - It does not predict ovulation, fertility, or due dates.
//
// Privacy: all of this context is optional and private to the user. It
// is never shared with family members, emergency contacts, or anyone
// else, never used for advertising, and never sold.

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

// ---- Pregnancy ----
// Resting heart rate rises gradually in pregnancy, roughly 10 to 20 bpm
// by term. The correction scales linearly from 0 at conception to 15 bpm
// (the middle of the range) at 40 weeks, and stays at 15 after that.
const PREGNANCY_RHR_MAX_BPM = 15;
const PREGNANCY_TERM_WEEKS = 40;

function pregnancyRhrCorrection(weeks) {
  if (typeof weeks !== 'number' || !Number.isFinite(weeks) || weeks <= 0) return 0;
  const w = Math.min(weeks, PREGNANCY_TERM_WEEKS);
  return Math.round((PREGNANCY_RHR_MAX_BPM * w / PREGNANCY_TERM_WEEKS) * 10) / 10;
}

// Given logged pregnancies and a date, return { pregnant, weeks }.
// pregnancies: [{ start_date, end_date, status }] where status is
// 'active', 'completed', or 'ended'. A pregnancy counts for a date when
// the date is on or after start_date and (no end_date or date is on or
// before end_date) and status is 'active' (or status is missing).
function pregnancyInfoOn(pregnancies, dateStr) {
  if (!Array.isArray(pregnancies) || pregnancies.length === 0) return { pregnant: false, weeks: null };
  const target = parseDate(dateStr);
  if (target === null) return { pregnant: false, weeks: null };
  for (const p of pregnancies) {
    if (!p || !p.start_date) continue;
    if (p.status && p.status !== 'active') continue;
    const start = parseDate(p.start_date);
    if (start === null || start > target) continue;
    if (p.end_date) {
      const end = parseDate(p.end_date);
      if (end !== null && target > end) continue;
    }
    const days = dayDiff(p.start_date, dateStr);
    if (days === null || days < 0) continue;
    return { pregnant: true, weeks: Math.floor(days / 7) };
  }
  return { pregnant: false, weeks: null };
}

// ---- Altitude ----
// Above 1500 m, blood oxygen runs lower (about 90 to 94 percent instead
// of 95 to 100 percent) and breathing rate runs higher. The SpO2
// correction adds 3 percentage points before scoring so an expected
// altitude drop is not flagged as abnormal.
const HIGH_ALTITUDE_M = 1500;
const ALTITUDE_SPO2_CORRECTION = 3;

function altitudeSpo2Correction(altitudeM) {
  if (typeof altitudeM !== 'number' || !Number.isFinite(altitudeM)) return 0;
  return altitudeM >= HIGH_ALTITUDE_M ? ALTITUDE_SPO2_CORRECTION : 0;
}

// ---- Menopause ----
// Perimenopause brings more temperature variation (hot flashes) and
// disrupted sleep. Rather than correcting values, the detector widens
// the temperature sigma floor for perimenopausal users so normal
// temperature swings are less likely to trigger a flag. The widened
// floor is twice the standard 0.15 C floor.
const PERI_TEMP_SIGMA_FLOOR = 0.3;

function tempSigmaFloorForMenopause(menopauseStatus) {
  return menopauseStatus === 'peri' ? PERI_TEMP_SIGMA_FLOOR : null;
}

// ---- Medications ----
// A medication started recently is noted as context only. No effect is
// predicted. windowDays defaults to 14.
function medChangeRecentOn(medStartDates, dateStr, windowDays) {
  if (!Array.isArray(medStartDates) || medStartDates.length === 0) return false;
  const win = typeof windowDays === 'number' ? windowDays : 14;
  for (const s of medStartDates) {
    const diff = dayDiff(s, dateStr);
    if (diff !== null && diff >= 0 && diff <= win) return true;
  }
  return false;
}

module.exports = {
  PREGNANCY_RHR_MAX_BPM,
  PREGNANCY_TERM_WEEKS,
  HIGH_ALTITUDE_M,
  ALTITUDE_SPO2_CORRECTION,
  PERI_TEMP_SIGMA_FLOOR,
  pregnancyRhrCorrection,
  pregnancyInfoOn,
  altitudeSpo2Correction,
  tempSigmaFloorForMenopause,
  medChangeRecentOn,
};
