// H-CAR detector v2 - JavaScript port of detector_v2.py (robust mode).
//
// Faithful port of the Python implementation that passed the blind
// validation trial (H-CAR-BLIND-2026-11-14). Do not "improve" the math
// here without re-running the full validation suite against the Python
// reference; the spec (H-CAR-DET-SPEC v0.9) is the authority and this
// file must match it.
//
// Core rules:
// - 28-day anchored baseline, expanding over clean days only.
// - Baselines are median + MAD: sigma = max(1.4826 * MAD, per-signal floor).
// - z = direction * (value - centre) / sigma, winsorized to [-4, +4].
// - A day is scored only with >= 3 signals present.
// - Watch = n_off >= 3 (z > 1.5) AND composite (mean of z) >= 1.2,
//   on 2 consecutive days.
// - Act = 3 consecutive Watch-grade days with worsening composite
//   (c2 > c0 and c1 >= c0) AND a strong signal (n_off >= 4 or any
//   z > 2.5) AND >= 4 signals present on the trigger day.
// - 14-day lockout after an episode freezes baseline learning only;
//   a new episode can start once the previous ends.
// - Episodes <= 14 days apart merge into one for paging counts.
// - A gap in dates breaks a run.
// - Cycle adjustment (optional): when opts.phaseByDate maps a date to
//   'luteal', the expected luteal rises in resting heart rate and skin
//   temperature are subtracted before z-scoring, so normal cycle
//   changes are not flagged as abnormal. Baseline learning always uses
//   the original values. Without opts.phaseByDate the detector behaves
//   exactly as before. See cycle.js for magnitudes and limits.
// - Pregnancy adjustment (optional): opts.pregnancyByDate maps a date
//   to { weeks }. The expected gradual resting heart rate rise is
//   subtracted before z-scoring. See context.js.
// - Altitude adjustment (optional): opts.altitudeByDate maps a date to
//   metres. At or above 1500 m the expected SpO2 drop is corrected
//   before z-scoring. See context.js.
// - Menopause adjustment (optional): opts.sigmaFloorOverrides can widen
//   the nightly temperature sigma floor for perimenopausal users, so
//   normal temperature swings are less likely to trigger a flag.
// - Medication context (optional): opts.medChangeByDate maps a date to
//   true when a medication was started within the last 14 days. It is
//   recorded as context only; no value is changed and no effect is
//   predicted. See context.js.
// All context fields are recorded on each dayResult so a user can see
// why a flag was or was not raised on a given day.

const cycle = require('./cycle');
const context = require('./context');

const SIGNALS = {
  resting_hr: +1,
  rmssd: -1,
  spo2: -1,
  nightly_temperature: +1,
  sleep_duration_h: -1,
  full_sleep_breathing_rate: +1,
};

const SIGMA_FLOORS = {
  resting_hr: 2.0, // bpm
  rmssd: 5.0, // ms
  spo2: 0.5, // percent
  nightly_temperature: 0.15, // deg C deviation
  sleep_duration_h: 0.5, // hours
  full_sleep_breathing_rate: 0.5, // breaths per minute
};

const BASELINE_DAYS = 28;
const MIN_BASELINE_N = 5;
const LOCKOUT_DAYS = 14;
const Z_CAP = 4.0;
const ACT_MIN_SIGNALS = 4;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function baselineStats(vals, signal, floors) {
  if (vals.length < MIN_BASELINE_N) return null;
  const centre = median(vals);
  const deviations = vals.map((v) => Math.abs(v - centre));
  const mad = median(deviations);
  let sigma = 1.4826 * mad;
  const floor = (floors && floors[signal] !== undefined) ? floors[signal] : SIGMA_FLOORS[signal];
  sigma = Math.max(sigma, floor);
  return { centre, sigma };
}

// Parse a YYYY-MM-DD date as a UTC day ordinal (days since epoch).
function dayOrdinal(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function ordinalToDateStr(ord) {
  return new Date(ord * 86400000).toISOString().slice(0, 10);
}

function buildEpisode(runDays, isAct, triggerDate) {
  const start = runDays[0].date;
  const end = runDays[runDays.length - 1].date;
  const peak = Math.max(...runDays.map((r) => r.comp));
  const meanZ = {};
  for (const s of Object.keys(SIGNALS)) {
    const vals = runDays.filter((r) => s in r.zs).map((r) => r.zs[s]);
    if (vals.length > 0) {
      meanZ[s] = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
    }
  }
  const top = Object.entries(meanZ)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  return {
    start,
    end,
    days: runDays.length,
    is_act: !!isAct,
    trigger_date: triggerDate || null,
    peak_composite: Math.round(peak * 100) / 100,
    top_signals: top,
    _start_ord: dayOrdinal(start),
    _end_ord: dayOrdinal(end),
  };
}

// Merge same-person episodes separated by <= gapDays (paging count).
function mergeEpisodes(eps, gapDays = 14) {
  if (!eps || eps.length === 0) return [];
  const sorted = [...eps].sort((a, b) => a._start_ord - b._start_ord);
  const merged = [{ ...sorted[0], merged_parts: 1 }];
  for (const e of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (e._start_ord - last._end_ord <= gapDays) {
      last.end = e.end;
      last._end_ord = e._end_ord;
      last.days += e.days;
      last.is_act = last.is_act || e.is_act;
      last.peak_composite = Math.max(last.peak_composite, e.peak_composite);
      last.merged_parts = (last.merged_parts || 1) + 1;
      if (!last.trigger_date && e.trigger_date) last.trigger_date = e.trigger_date;
    } else {
      merged.push({ ...e, merged_parts: 1 });
    }
  }
  return merged;
}

// Run the detector over one person's days.
// dayRows: [{ date: 'YYYY-MM-DD', vals: { signal: number } }] in date order.
// opts.phaseByDate (optional): { 'YYYY-MM-DD': 'follicular' | 'luteal' | null }.
//   On luteal days, the expected luteal rises are corrected before scoring.
// opts.pregnancyByDate (optional): { 'YYYY-MM-DD': { weeks: number } }.
// opts.altitudeByDate (optional): { 'YYYY-MM-DD': metres }.
// opts.medChangeByDate (optional): { 'YYYY-MM-DD': true }.
// opts.sigmaFloorOverrides (optional): { signal: floor }.
// opts.menopauseStatus (optional): 'pre' | 'peri' | 'post' | null, recorded as context.
// Returns { scoredDays, episodes, mergedEpisodes, dayResults, baseline, baselineDays }.
// dayResults: one entry per input day with { date, zs, composite, nOff, nSignals,
//   watch, scored, inBaseline, cyclePhase, pregnant, pregnantWeeks, altitudeM,
//   medChangeRecent, menopauseStatus }.
function runPerson(dayRows, opts) {
  const phaseByDate = (opts && opts.phaseByDate) || {};
  const pregnancyByDate = (opts && opts.pregnancyByDate) || {};
  const altitudeByDate = (opts && opts.altitudeByDate) || {};
  const medChangeByDate = (opts && opts.medChangeByDate) || {};
  const sigmaFloors = { ...SIGMA_FLOORS, ...((opts && opts.sigmaFloorOverrides) || {}) };
  const menopauseStatus = (opts && opts.menopauseStatus) || null;
  const baseline = {};
  for (const s of Object.keys(SIGNALS)) baseline[s] = [];

  if (!dayRows || dayRows.length === 0) {
    return { scoredDays: 0, episodes: [], mergedEpisodes: [], dayResults: [], baseline: {}, baselineDays: 0 };
  }

  const firstOrd = dayOrdinal(dayRows[0].date);
  let scoredDays = 0;
  const episodes = [];
  const dayResults = [];
  let run = [];
  let lockoutUntil = null; // ordinal, inclusive
  let prevOrd = null;

  function addToBaseline(vals) {
    for (const [s, v] of Object.entries(vals)) {
      if (s in baseline && typeof v === 'number' && Number.isFinite(v)) {
        baseline[s].push(v);
      }
    }
  }

  function resolveRun(runDays) {
    if (runDays.length < 2) {
      // A lone watch day is absorbed into the baseline (as-run behaviour).
      if (runDays.length === 1) addToBaseline(runDays[0].vals);
      return;
    }
    let isAct = false;
    let triggerDate = null;
    for (let i = 0; i <= runDays.length - 3; i++) {
      const c0 = runDays[i].comp;
      const c1 = runDays[i + 1].comp;
      const c2 = runDays[i + 2].comp;
      const worsening = c2 > c0 && c1 >= c0;
      const day3 = runDays[i + 2];
      const maxZ = Math.max(...Object.values(day3.zs));
      const strong = day3.nOff >= 4 || maxZ > 2.5;
      const presenceOk = Object.keys(day3.zs).length >= ACT_MIN_SIGNALS;
      if (worsening && strong && presenceOk) {
        isAct = true;
        triggerDate = day3.date;
        break;
      }
    }
    lockoutUntil = dayOrdinal(runDays[runDays.length - 1].date) + LOCKOUT_DAYS;
    episodes.push(buildEpisode(runDays, isAct, triggerDate));
  }

  for (const { date, vals } of dayRows) {
    const ord = dayOrdinal(date);
    const di = ord - firstOrd;

    if (di < BASELINE_DAYS) {
      addToBaseline(vals);
      dayResults.push({ date, zs: {}, composite: null, nOff: 0, nSignals: 0, watch: false, scored: false, inBaseline: true, cyclePhase: phaseByDate[date] || null, pregnant: !!(pregnancyByDate[date] && pregnancyByDate[date].weeks !== undefined), pregnantWeeks: (pregnancyByDate[date] && pregnancyByDate[date].weeks !== undefined) ? pregnancyByDate[date].weeks : null, altitudeM: (altitudeByDate[date] !== undefined ? altitudeByDate[date] : null), medChangeRecent: !!medChangeByDate[date], menopauseStatus });
      prevOrd = ord;
      continue;
    }

    // A gap in dates breaks a run.
    if (prevOrd !== null && ord - prevOrd > 1 && run.length > 0) {
      resolveRun(run);
      run = [];
    }

    const cyclePhase = phaseByDate[date] || null;
    const pregInfo = pregnancyByDate[date] || null;
    const pregnant = !!(pregInfo && pregInfo.weeks !== undefined);
    const pregnantWeeks = pregnant ? pregInfo.weeks : null;
    const altitudeM = altitudeByDate[date] !== undefined ? altitudeByDate[date] : null;
    const medChangeRecent = !!medChangeByDate[date];
    // Luteal-phase correction: subtract the expected luteal rises so
    // normal cycle changes do not inflate z-scores. Baseline learning
    // and run records keep the original values.
    const scoreVals = { ...vals };
    if (cyclePhase === 'luteal') {
      if (typeof scoreVals.resting_hr === 'number') {
        scoreVals.resting_hr -= cycle.LUTEAL_RHR_CORRECTION_BPM;
      }
      if (typeof scoreVals.nightly_temperature === 'number') {
        scoreVals.nightly_temperature -= cycle.LUTEAL_TEMP_CORRECTION_C;
      }
    }
    // Pregnancy correction: subtract the expected gradual resting heart
    // rate rise for the gestational week.
    if (pregnant && typeof scoreVals.resting_hr === 'number') {
      scoreVals.resting_hr -= context.pregnancyRhrCorrection(pregnantWeeks);
    }
    // Altitude correction: at or above 1500 m, add back the expected
    // SpO2 drop so an expected altitude drop is not flagged.
    if (typeof altitudeM === 'number' && typeof scoreVals.spo2 === 'number') {
      scoreVals.spo2 += context.altitudeSpo2Correction(altitudeM);
    }

    const zs = {};
    for (const [s, direction] of Object.entries(SIGNALS)) {
      if (!(s in scoreVals)) continue;
      const st = baselineStats(baseline[s], s, sigmaFloors);
      if (!st) continue;
      let z = ((scoreVals[s] - st.centre) / st.sigma) * direction;
      z = Math.max(-Z_CAP, Math.min(Z_CAP, z));
      zs[s] = Math.round(z * 1000) / 1000;
    }

    let watch = false;
    let comp = null;
    let nOff = 0;
    let scored = false;
    if (Object.keys(zs).length >= 3) {
      scored = true;
      scoredDays += 1;
      nOff = Object.values(zs).filter((z) => z > 1.5).length;
      comp = Object.values(zs).reduce((a, b) => a + b, 0) / Object.values(zs).length;
      comp = Math.round(comp * 1000) / 1000;
      watch = nOff >= 3 && comp >= 1.2;
    }

    dayResults.push({
      date,
      zs,
      composite: comp,
      nOff,
      nSignals: Object.keys(zs).length,
      watch,
      scored,
      inBaseline: false,
      cyclePhase,
      pregnant,
      pregnantWeeks,
      altitudeM,
      medChangeRecent,
      menopauseStatus,
    });

    if (watch) {
      run.push({ date, zs, comp, nOff, vals });
    } else {
      if (run.length > 0) {
        resolveRun(run);
        run = [];
      }
      // Lockout freezes baseline learning only; clean days outside
      // lockout keep growing the baseline.
      if (lockoutUntil === null || ord > lockoutUntil) {
        addToBaseline(vals);
      }
    }
    prevOrd = ord;
  }
  if (run.length > 0) resolveRun(run);

  // Final baseline stats per signal (for display and audit).
  const baselineOut = {};
  for (const s of Object.keys(SIGNALS)) {
    const st = baselineStats(baseline[s], s, sigmaFloors);
    if (st) {
      baselineOut[s] = {
        centre: Math.round(st.centre * 1000) / 1000,
        sigma: Math.round(st.sigma * 1000) / 1000,
        n: baseline[s].length,
      };
    }
  }

  // Baseline day count: number of distinct days in the first 28-day window.
  const baselineDays = dayRows.filter((r) => dayOrdinal(r.date) - firstOrd < BASELINE_DAYS).length;

  return {
    scoredDays,
    episodes,
    mergedEpisodes: mergeEpisodes(episodes, LOCKOUT_DAYS),
    dayResults,
    baseline: baselineOut,
    baselineDays,
  };
}

module.exports = {
  SIGNALS,
  SIGMA_FLOORS,
  BASELINE_DAYS,
  MIN_BASELINE_N,
  LOCKOUT_DAYS,
  Z_CAP,
  ACT_MIN_SIGNALS,
  median,
  baselineStats,
  dayOrdinal,
  ordinalToDateStr,
  runPerson,
  mergeEpisodes,
  buildEpisode,
};
