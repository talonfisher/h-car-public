// Tests for health context helpers (context.js) and the detector
// adjustments for pregnancy, altitude, menopause, and medications.
// Run with: node test-context.js
const assert = require('assert');
const context = require('./context');
const detector = require('./detector');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log('ok - ' + name);
}

// ---- Pregnancy ----
check('pregnancy RHR correction is 0 at conception', () => {
  assert.strictEqual(context.pregnancyRhrCorrection(0), 0);
});

check('pregnancy RHR correction scales with weeks', () => {
  assert.strictEqual(context.pregnancyRhrCorrection(20), 7.5);
  assert.strictEqual(context.pregnancyRhrCorrection(40), 15);
});

check('pregnancy RHR correction caps at term', () => {
  assert.strictEqual(context.pregnancyRhrCorrection(50), 15);
});

check('pregnancy info finds active pregnancy and weeks', () => {
  const pregnancies = [{ start_date: '2026-09-01', due_date: '2027-06-08', end_date: null, status: 'active' }];
  const info = context.pregnancyInfoOn(pregnancies, '2026-11-24');
  assert.strictEqual(info.pregnant, true);
  assert.strictEqual(info.weeks, 12);
});

check('pregnancy info ignores ended pregnancies', () => {
  const pregnancies = [{ start_date: '2026-09-01', due_date: null, end_date: '2026-10-01', status: 'ended' }];
  assert.strictEqual(context.pregnancyInfoOn(pregnancies, '2026-11-24').pregnant, false);
});

check('pregnancy info returns not pregnant with no data', () => {
  assert.strictEqual(context.pregnancyInfoOn([], '2026-11-24').pregnant, false);
});

// ---- Altitude ----
check('altitude SpO2 correction is 0 below 1500 m', () => {
  assert.strictEqual(context.altitudeSpo2Correction(500), 0);
  assert.strictEqual(context.altitudeSpo2Correction(1499), 0);
});

check('altitude SpO2 correction is 3 at or above 1500 m', () => {
  assert.strictEqual(context.altitudeSpo2Correction(1500), 3);
  assert.strictEqual(context.altitudeSpo2Correction(3000), 3);
});

// ---- Menopause ----
check('perimenopause widens the temperature sigma floor', () => {
  assert.strictEqual(context.tempSigmaFloorForMenopause('peri'), 0.3);
});

check('other menopause statuses do not widen the floor', () => {
  assert.strictEqual(context.tempSigmaFloorForMenopause('pre'), null);
  assert.strictEqual(context.tempSigmaFloorForMenopause('post'), null);
  assert.strictEqual(context.tempSigmaFloorForMenopause(null), null);
});

// ---- Medications ----
check('medication change is recent within 14 days', () => {
  assert.strictEqual(context.medChangeRecentOn(['2026-11-20'], '2026-11-24'), true);
  assert.strictEqual(context.medChangeRecentOn(['2026-11-10'], '2026-11-24'), true);
});

check('medication change is not recent after 14 days', () => {
  assert.strictEqual(context.medChangeRecentOn(['2026-11-09'], '2026-11-24'), false);
  assert.strictEqual(context.medChangeRecentOn(['2026-12-01'], '2026-11-24'), false);
});

check('medication change is false with no medications', () => {
  assert.strictEqual(context.medChangeRecentOn([], '2026-11-24'), false);
});

// ---- Detector integration ----
function buildStableDays(elevated) {
  const rows = [];
  for (let i = 0; i < 28; i++) {
    const d = new Date(Date.UTC(2026, 9, 1) + i * 86400000).toISOString().slice(0, 10);
    const spo2 = [96, 97, 98][i % 3];
    rows.push({ date: d, vals: { resting_hr: 70, rmssd: 50, spo2, nightly_temperature: 0, sleep_duration_h: 7, full_sleep_breathing_rate: 14 } });
  }
  for (let i = 28; i < 30; i++) {
    const d = new Date(Date.UTC(2026, 9, 1) + i * 86400000).toISOString().slice(0, 10);
    rows.push({ date: d, vals: elevated });
  }
  return rows;
}

check('detector corrects pregnancy RHR rise at 20 weeks', () => {
  const elevated = { resting_hr: 78, rmssd: 40, spo2: 97, nightly_temperature: 0.6, sleep_duration_h: 7, full_sleep_breathing_rate: 14 };
  const plain = detector.runPerson(buildStableDays(elevated));
  const day29plain = plain.dayResults.find((d) => d.date === '2026-10-29');
  assert.strictEqual(day29plain.watch, true);
  const withPreg = detector.runPerson(buildStableDays(elevated), {
    pregnancyByDate: { '2026-10-29': { weeks: 20 }, '2026-10-30': { weeks: 20 } },
  });
  const day29preg = withPreg.dayResults.find((d) => d.date === '2026-10-29');
  assert.strictEqual(day29preg.watch, false);
  assert.strictEqual(day29preg.pregnant, true);
  assert.strictEqual(day29preg.pregnantWeeks, 20);
});

check('detector corrects SpO2 drop at high altitude', () => {
  const elevated = { resting_hr: 74, rmssd: 50, spo2: 92, nightly_temperature: 0.6, sleep_duration_h: 7, full_sleep_breathing_rate: 14 };
  const plain = detector.runPerson(buildStableDays(elevated));
  const day29plain = plain.dayResults.find((d) => d.date === '2026-10-29');
  assert.strictEqual(day29plain.watch, true);
  const withAlt = detector.runPerson(buildStableDays(elevated), {
    altitudeByDate: { '2026-10-29': 1800, '2026-10-30': 1800 },
  });
  const day29alt = withAlt.dayResults.find((d) => d.date === '2026-10-29');
  assert.strictEqual(day29alt.watch, false);
  assert.strictEqual(day29alt.altitudeM, 1800);
});

check('detector widens temperature sigma for perimenopause', () => {
  const rows = [];
  for (let i = 0; i < 28; i++) {
    const d = new Date(Date.UTC(2026, 9, 1) + i * 86400000).toISOString().slice(0, 10);
    rows.push({ date: d, vals: { resting_hr: 70, rmssd: 50, spo2: 97, nightly_temperature: 0, sleep_duration_h: 7, full_sleep_breathing_rate: 14 } });
  }
  for (let i = 28; i < 30; i++) {
    const d = new Date(Date.UTC(2026, 9, 1) + i * 86400000).toISOString().slice(0, 10);
    rows.push({ date: d, vals: { resting_hr: 74, rmssd: 40, spo2: 97, nightly_temperature: 0.45, sleep_duration_h: 7, full_sleep_breathing_rate: 14 } });
  }
  const plain = detector.runPerson(rows);
  const day29plain = plain.dayResults.find((d) => d.date === '2026-10-29');
  assert.strictEqual(day29plain.zs.nightly_temperature, 3);
  const withPeri = detector.runPerson(rows, {
    sigmaFloorOverrides: { nightly_temperature: 0.3 },
    menopauseStatus: 'peri',
  });
  const day29peri = withPeri.dayResults.find((d) => d.date === '2026-10-29');
  assert.strictEqual(day29peri.zs.nightly_temperature, 1.5);
  assert.strictEqual(day29peri.menopauseStatus, 'peri');
});

check('detector records recent medication change as context only', () => {
  const rows = buildStableDays({ resting_hr: 70, rmssd: 50, spo2: 97, nightly_temperature: 0, sleep_duration_h: 7, full_sleep_breathing_rate: 14 });
  const res = detector.runPerson(rows, {
    medChangeByDate: { '2026-10-29': true, '2026-10-30': true },
  });
  const day29 = res.dayResults.find((d) => d.date === '2026-10-29');
  assert.strictEqual(day29.medChangeRecent, true);
  const day10 = res.dayResults.find((d) => d.date === '2026-10-10');
  assert.strictEqual(day10.medChangeRecent, false);
});

console.log('\n' + passed + ' context tests passed.');
