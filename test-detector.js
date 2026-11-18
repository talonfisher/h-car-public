// Synthetic tests for detector.js (detector v2 port).
// Run: node test-detector.js
// No network or database needed. Exits non-zero on any failure.

const { runPerson, BASELINE_DAYS } = require('./detector');

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) {
    console.log('PASS  ' + name);
  } else {
    failures += 1;
    console.log('FAIL  ' + name + (extra ? '  [' + extra + ']' : ''));
  }
}

// Deterministic pseudo-random helper (mulberry32).
function rng(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dateStr(baseOrd, offset) {
  return new Date((baseOrd + offset) * 86400000).toISOString().slice(0, 10);
}

// Healthy person: stable signals with small noise for 118 days.
function healthyPerson(days, seed = 42) {
  const r = rng(seed);
  const base = Math.floor(Date.UTC(2026, 0, 1) / 86400000);
  const rows = [];
  for (let i = 0; i < days; i++) {
    rows.push({
      date: dateStr(base, i),
      vals: {
        resting_hr: 72 + (r() - 0.5) * 4,
        rmssd: 18 + (r() - 0.5) * 4,
        spo2: 96 + (r() - 0.5) * 1,
        nightly_temperature: (r() - 0.5) * 0.2,
        sleep_duration_h: 7 + (r() - 0.5) * 1,
        full_sleep_breathing_rate: 14 + (r() - 0.5) * 1,
      },
    });
  }
  return rows;
}

// Fast decline starting day 60: RHR up, HRV down, SpO2 down, sleep short,
// temp up, breathing up, sustained for 10 days.
function decliningPerson(days, seed = 7) {
  const rows = healthyPerson(days, seed);
  for (let i = 60; i < 70 && i < days; i++) {
    const k = (i - 59) / 3; // ramps up
    rows[i].vals = {
      resting_hr: 72 + 9 * k,
      rmssd: 18 - 8 * k,
      spo2: 96 - 2.5 * k,
      nightly_temperature: 0.6 * k,
      sleep_duration_h: 7 - 2.5 * k,
      full_sleep_breathing_rate: 14 + 2.5 * k,
    };
  }
  return rows;
}

// Thin data: only 3 signals present during a decline (caps at Watch, never Act).
function thinDeclinePerson(days, seed = 11) {
  const rows = decliningPerson(days, seed);
  for (let i = 60; i < 70 && i < days; i++) {
    rows[i].vals = {
      resting_hr: rows[i].vals.resting_hr,
      rmssd: rows[i].vals.rmssd,
      spo2: rows[i].vals.spo2,
    };
  }
  return rows;
}

// ---- Test 1: healthy person, no flags ----
{
  const res = runPerson(healthyPerson(118));
  check('healthy: 0 episodes', res.episodes.length === 0, 'got ' + res.episodes.length);
  check('healthy: 0 merged episodes', res.mergedEpisodes.length === 0);
  check('healthy: baseline complete (28 days)', res.baselineDays === 28, 'got ' + res.baselineDays);
  check('healthy: all 6 baselines computed', Object.keys(res.baseline).length === 6);
  check('healthy: scored days = 90', res.scoredDays === 90, 'got ' + res.scoredDays);
  const rhr = res.baseline.resting_hr;
  check('healthy: RHR centre near 72', rhr && Math.abs(rhr.centre - 72) < 1.5, JSON.stringify(rhr));
  check('healthy: RHR sigma at floor (>= 2.0)', rhr && rhr.sigma >= 2.0, JSON.stringify(rhr));
}

// ---- Test 2: fast decline fires Watch then Act ----
{
  const res = runPerson(decliningPerson(118));
  check('decline: >= 1 episode', res.episodes.length >= 1, 'got ' + res.episodes.length);
  const acts = res.episodes.filter((e) => e.is_act);
  check('decline: >= 1 Act episode', acts.length >= 1, 'got ' + acts.length);
  check('decline: episode starts on/after day 60', res.episodes[0] && res.episodes[0].start >= '2026-03-02', res.episodes[0] ? res.episodes[0].start : 'none');
  check('decline: trigger date set on Act', acts.length > 0 && !!acts[0].trigger_date);
  const watchDays = res.dayResults.filter((d) => d.watch);
  check('decline: watch days present', watchDays.length >= 3, 'got ' + watchDays.length);
  // No flags during the 28-day baseline window.
  const baselineFlags = res.dayResults.filter((d) => d.inBaseline && d.watch);
  check('decline: no flags during baseline', baselineFlags.length === 0);
}

// ---- Test 3: thin data (3 signals) caps at Watch, never Act ----
{
  const res = runPerson(thinDeclinePerson(118));
  check('thin: >= 1 episode', res.episodes.length >= 1, 'got ' + res.episodes.length);
  const acts = res.episodes.filter((e) => e.is_act);
  check('thin: 0 Act episodes (needs >= 4 signals)', acts.length === 0, 'got ' + acts.length);
}

// ---- Test 4: gap days break runs; <3 signals unscored ----
{
  const rows = healthyPerson(60);
  // Day 40: only 2 signals present -> unscored.
  rows[40].vals = { resting_hr: 72, rmssd: 18 };
  // Day 41: remove entirely (gap), then a decline run.
  const rows2 = rows.filter((_, i) => i !== 41);
  const res = runPerson(rows2);
  const d40 = res.dayResults.find((d) => d.date === rows[40].date);
  check('gap: 2-signal day unscored', d40 && d40.scored === false && d40.nSignals === 2, JSON.stringify(d40));
  check('gap: no episodes on healthy data with gap', res.episodes.length === 0, 'got ' + res.episodes.length);
}

// ---- Test 5: episode merging (two episodes <= 14 days apart merge) ----
{
  const rows = decliningPerson(118, 21);
  // Second decline 10 days after the first ends (first ends ~day 69, second starts day 79).
  for (let i = 79; i < 87; i++) {
    const k = (i - 78) / 3;
    rows[i].vals = {
      resting_hr: 72 + 9 * k,
      rmssd: 18 - 8 * k,
      spo2: 96 - 2.5 * k,
      nightly_temperature: 0.6 * k,
      sleep_duration_h: 7 - 2.5 * k,
      full_sleep_breathing_rate: 14 + 2.5 * k,
    };
  }
  const res = runPerson(rows);
  check('merge: 2 raw episodes', res.episodes.length === 2, 'got ' + res.episodes.length);
  check('merge: 1 merged episode', res.mergedEpisodes.length === 1, 'got ' + res.mergedEpisodes.length);
  check('merge: merged_parts = 2', res.mergedEpisodes[0] && res.mergedEpisodes[0].merged_parts === 2);
}

// ---- Test 6: z-score capping (one freak value cannot dominate) ----
{
  const rows = healthyPerson(60);
  // One wild RHR spike on day 40 (150 bpm). z should cap at 4.
  rows[40].vals.resting_hr = 150;
  const res = runPerson(rows);
  const d40 = res.dayResults.find((d) => d.date === rows[40].date);
  check('cap: RHR z capped at 4', d40 && d40.zs.resting_hr === 4, JSON.stringify(d40 && d40.zs));
  check('cap: single-signal spike is not a Watch', d40 && d40.watch === false);
}

// ---- Test 7: short history (fewer than 28 days) ----
{
  const res = runPerson(healthyPerson(14));
  check('short: 0 episodes', res.episodes.length === 0);
  check('short: baselineDays = 14', res.baselineDays === 14, 'got ' + res.baselineDays);
  check('short: 0 scored days', res.scoredDays === 0, 'got ' + res.scoredDays);
}

console.log('\n' + (failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
