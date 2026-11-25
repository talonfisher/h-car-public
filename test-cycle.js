// Tests for menstrual cycle phase helpers (cycle.js) and the luteal
// adjustment in the detector. Run with: node test-cycle.js
const assert = require('assert');
const cycle = require('./cycle');
const detector = require('./detector');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log('ok - ' + name);
}

const cycles = [
  { start_date: '2026-10-01', end_date: '2026-10-05' },
  { start_date: '2026-10-29', end_date: '2026-11-02' },
];

check('day 1 of cycle is follicular', () => {
  assert.strictEqual(cycle.getCyclePhase(cycles, '2026-10-01'), 'follicular');
});

check('day 14 of cycle is follicular', () => {
  assert.strictEqual(cycle.getCyclePhase(cycles, '2026-10-14'), 'follicular');
});

check('day 15 of cycle is luteal', () => {
  assert.strictEqual(cycle.getCyclePhase(cycles, '2026-10-15'), 'luteal');
});

check('new cycle start resets to follicular', () => {
  assert.strictEqual(cycle.getCyclePhase(cycles, '2026-10-29'), 'follicular');
  assert.strictEqual(cycle.getCyclePhase(cycles, '2026-11-12'), 'luteal');
});

check('no cycles returns null', () => {
  assert.strictEqual(cycle.getCyclePhase([], '2026-10-10'), null);
});

check('date before first cycle returns null', () => {
  assert.strictEqual(cycle.getCyclePhase(cycles, '2026-09-15'), null);
});

check('phase continues past bleeding end until next cycle', () => {
  assert.strictEqual(cycle.getCyclePhase(cycles, '2026-11-10'), 'follicular');
  assert.strictEqual(cycle.getCyclePhase(cycles, '2026-11-13'), 'luteal');
});

check('stale cycle over 45 days old returns null', () => {
  const old = [{ start_date: '2026-01-01', end_date: null }];
  assert.strictEqual(cycle.getCyclePhase(old, '2026-03-01'), null);
});

check('cycle day is 1-based', () => {
  assert.strictEqual(cycle.getCycleDay(cycles, '2026-10-01'), 1);
  assert.strictEqual(cycle.getCycleDay(cycles, '2026-10-15'), 15);
  assert.strictEqual(cycle.getCycleDay([], '2026-10-15'), null);
});

check('average cycle length from start dates', () => {
  assert.strictEqual(cycle.averageCycleLength(cycles), 28);
  assert.strictEqual(cycle.averageCycleLength([cycles[0]]), null);
});

check('current phase info', () => {
  const info = cycle.currentPhaseInfo(cycles, '2026-10-20');
  assert.strictEqual(info.phase, 'luteal');
  assert.strictEqual(info.cycleDay, 20);
  assert.strictEqual(info.averageCycleLength, 28);
});

// Detector integration: a luteal-phase day with the expected rises
// (RHR +4, temp +0.6, HRV -10) flags Watch without the correction
// and does not flag with it.
function buildDays() {
  const rows = [];
  for (let i = 0; i < 28; i++) {
    const d = new Date(Date.UTC(2026, 9, 1) + i * 86400000).toISOString().slice(0, 10);
    rows.push({ date: d, vals: { resting_hr: 70, rmssd: 50, spo2: 97, nightly_temperature: 0, sleep_duration_h: 7, full_sleep_breathing_rate: 14 } });
  }
  for (let i = 28; i < 31; i++) {
    const d = new Date(Date.UTC(2026, 9, 1) + i * 86400000).toISOString().slice(0, 10);
    rows.push({ date: d, vals: { resting_hr: 74, rmssd: 40, spo2: 97, nightly_temperature: 0.6, sleep_duration_h: 7, full_sleep_breathing_rate: 14 } });
  }
  return rows;
}

check('detector flags luteal-like rises without phase info', () => {
  const res = detector.runPerson(buildDays());
  const day29 = res.dayResults.find((d) => d.date === '2026-10-29');
  assert.strictEqual(day29.watch, true);
  assert.strictEqual(day29.nOff, 3);
});

check('detector does not flag the same rises with luteal phase', () => {
  const phaseByDate = { '2026-10-29': 'luteal', '2026-10-30': 'luteal', '2026-10-31': 'luteal' };
  const res = detector.runPerson(buildDays(), { phaseByDate });
  const day29 = res.dayResults.find((d) => d.date === '2026-10-29');
  assert.strictEqual(day29.watch, false);
  assert.strictEqual(day29.cyclePhase, 'luteal');
  assert.ok(day29.nOff < 3);
});

check('detector without opts behaves exactly as before', () => {
  const a = detector.runPerson(buildDays());
  const b = detector.runPerson(buildDays(), {});
  assert.deepStrictEqual(a.dayResults, b.dayResults);
});

console.log('\n' + passed + ' cycle tests passed.');
