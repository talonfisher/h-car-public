// Google Health API client for H-CAR.
//
// Uses the Google Health API (health.googleapis.com/v4), the successor
// to the Fitbit Web API (sunset Nov 2026) and the Google Fit REST API
// (supported only until end of 2026). Do NOT build new work on Fit.
//
// Data types read (all Daily except sleep, which is a Session):
//   daily-resting-heart-rate        -> RHR (beatsPerMinute)
//   daily-heart-rate-variability    -> HRV RMSSD (averageHeartRateVariabilityMilliseconds)
//   daily-oxygen-saturation         -> SpO2 avg + lower bound (averagePercentage, lowerBoundPercentage)
//   daily-respiratory-rate          -> breathing rate (breathsPerMinute)
//   daily-sleep-temperature-derivations -> skin temp delta
//     (nightlyTemperatureCelsius - baselineTemperatureCelsius)
//   sleep                           -> sleep minutes + efficiency (summary.minutesAsleep,
//                                      summary.minutesInSleepPeriod), main sleep only
//
// Scopes (readonly):
//   https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly
//   https://www.googleapis.com/auth/googlehealth.sleep.readonly
//
// Notes:
// - We use :reconcile (merged, de-duplicated across sources) so a night
//   recorded by both Fitbit and Health Connect is not counted twice.
// - Daily points carry a `date` (year/month/day in the user's timezone).
//   Sleep is attributed to the local date its interval ENDS (wake date).
// - Field names verified against the v4 discovery document
//   (https://health.googleapis.com/$discovery/rest?version=v4).
// - Each data type is fetched independently; a failure in one type leaves
//   that signal null for the affected days instead of failing the sync.
//   The detector needs >= 3 of 6 signals to score a day.

const { google } = require('googleapis');
const axios = require('axios');
const crypto = require('crypto');

const HEALTH_API_BASE = 'https://health.googleapis.com/v4';
const SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
];

function baseUrl() {
  return (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function redirectUri() {
  return baseUrl() + '/api/fitbit/callback';
}

function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri()
  );
}

function getAuthUrl(state) {
  const client = getOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
  });
}

async function exchangeCode(code) {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  return tokens; // { access_token, refresh_token, expiry_date, scope, token_type }
}

async function refreshAccessToken(refreshToken) {
  const client = getOAuth2Client();
  client.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await client.refreshAccessToken();
  return credentials; // { access_token, expiry_date, ... }
}

// ---- Token encryption (AES-256-GCM) ----
// Key: TOKEN_ENCRYPTION_KEY env (64 hex chars = 32 bytes). If unset, a key
// is derived from JWT_SECRET via scrypt; set the env var in production so
// rotating JWT_SECRET does not destroy stored tokens.
function encryptionKey() {
  if (process.env.TOKEN_ENCRYPTION_KEY) {
    const k = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, 'hex');
    if (k.length === 32) return k;
    throw new Error('TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  }
  const secret = process.env.JWT_SECRET || 'hcar-change-this-secret-in-production';
  return crypto.scryptSync(secret, 'hcar-token-encryption', 32);
}

function encryptToken(plaintext) {
  const key = encryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptToken(blob) {
  const key = encryptionKey();
  const buf = Buffer.from(blob, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// ---- Data fetching ----

function dateObjToStr(d) {
  // d: { year, month, day } -> 'YYYY-MM-DD'
  const m = String(d.month).padStart(2, '0');
  const day = String(d.day).padStart(2, '0');
  return d.year + '-' + m + '-' + day;
}

// Local date of an RFC3339 timestamp given its UTC offset ("-07:00").
function localDateOf(timestamp, utcOffset) {
  if (!timestamp) return null;
  try {
    const t = new Date(timestamp).getTime();
    let offsetMs = 0;
    if (utcOffset && /^[+-]\d{2}:\d{2}$/.test(utcOffset)) {
      const sign = utcOffset[0] === '-' ? -1 : 1;
      const [h, m] = utcOffset.slice(1).split(':').map(Number);
      offsetMs = sign * (h * 60 + m) * 60000;
    }
    return new Date(t + offsetMs).toISOString().slice(0, 10);
  } catch (e) {
    return timestamp.slice(0, 10);
  }
}

async function reconcile(accessToken, dataType, filter) {
  const url = HEALTH_API_BASE + '/users/me/dataTypes/' + dataType + '/dataPoints:reconcile';
  const res = await axios.get(url, {
    headers: { Authorization: 'Bearer ' + accessToken },
    params: { filter, pageSize: 500 },
    timeout: 30000,
  });
  return res.data.dataPoints || [];
}

// Fetch one daily data type over [startDate, endDate) and map points to
// { date: value } using the provided extractor.
async function fetchDaily(accessToken, dataType, snakeName, camelField, startDate, endDate, extract) {
  const filter = snakeName + '.date >= "' + startDate + '" AND ' + snakeName + '.date < "' + endDate + '"';
  const points = await reconcile(accessToken, dataType, filter);
  const out = {};
  for (const p of points) {
    const rec = p[camelField];
    if (!rec || !rec.date) continue;
    const value = extract(rec);
    if (value === null || value === undefined || Number.isNaN(value)) continue;
    out[dateObjToStr(rec.date)] = value;
  }
  return out;
}

// Fetch sleep sessions ending in [startDate, endDate). Returns
// { date: { minutes, efficiency, deepMinutes, remMinutes } }.
// Prefers the main sleep of each date; falls back to the longest session.
async function fetchSleep(accessToken, startDate, endDate) {
  const filter =
    'sleep.interval.end_time >= "' + startDate + 'T00:00:00Z" AND sleep.interval.end_time < "' + endDate + 'T00:00:00Z"';
  let points;
  try {
    points = await reconcile(accessToken, 'sleep', filter);
  } catch (e) {
    // Fall back to an unfiltered list (API caps sleep at 25 sessions).
    points = await reconcile(accessToken, 'sleep', '');
  }
  const byDate = {};
  for (const p of points) {
    const s = p.sleep;
    if (!s || !s.interval || !s.interval.endTime) continue;
    const date = localDateOf(s.interval.endTime, s.interval.endUtcOffset);
    if (!date || date < startDate || date >= endDate) continue;
    const summary = s.summary || {};
    const minutesAsleep = summary.minutesAsleep !== undefined ? parseFloat(summary.minutesAsleep) : null;
    const minutesInPeriod = summary.minutesInSleepPeriod !== undefined ? parseFloat(summary.minutesInSleepPeriod) : null;
    if (minutesAsleep === null || Number.isNaN(minutesAsleep)) continue;
    const efficiency =
      minutesInPeriod && minutesInPeriod > 0 ? Math.round((minutesAsleep / minutesInPeriod) * 1000) / 10 : null;
    // Deep / REM minutes from the stage summary, when present.
    let deepMinutes = null;
    let remMinutes = null;
    if (Array.isArray(summary.stagesSummary)) {
      for (const st of summary.stagesSummary) {
        const kind = (st.stage || st.type || '').toString().toUpperCase();
        const mins = st.minutes !== undefined ? parseFloat(st.minutes) : st.durationMinutes !== undefined ? parseFloat(st.durationMinutes) : null;
        if (mins === null || Number.isNaN(mins)) continue;
        if (kind === 'DEEP') deepMinutes = mins;
        if (kind === 'REM') remMinutes = mins;
      }
    }
    const candidate = {
      minutes: minutesAsleep,
      efficiency,
      deepMinutes,
      remMinutes,
      main: !!(s.metadata && s.metadata.mainSleep),
    };
    const existing = byDate[date];
    if (!existing || (candidate.main && !existing.main) || (!existing.main && !candidate.main && candidate.minutes > existing.minutes)) {
      byDate[date] = candidate;
    }
  }
  const out = {};
  for (const [date, c] of Object.entries(byDate)) {
    out[date] = { minutes: c.minutes, efficiency: c.efficiency, deepMinutes: c.deepMinutes, remMinutes: c.remMinutes };
  }
  return out;
}

// Fetch daily summaries for [startDate, endDate).
// Returns { 'YYYY-MM-DD': { rhr, hrv, spo2_avg, spo2_min, breathing_rate,
//   skin_temp_delta, sleep_minutes, sleep_efficiency, deep_minutes, rem_minutes } }.
// Any signal may be null when the source has no data for that day.
async function fetchDailySummaries(accessToken, startDate, endDate) {
  const days = {};
  function ensure(date) {
    if (!days[date]) {
      days[date] = {
        rhr: null, hrv: null, spo2_avg: null, spo2_min: null,
        breathing_rate: null, skin_temp_delta: null,
        sleep_minutes: null, sleep_efficiency: null,
        deep_minutes: null, rem_minutes: null,
      };
    }
    return days[date];
  }

  const jobs = [
    (async () => {
      const v = await fetchDaily(accessToken, 'daily-resting-heart-rate', 'daily_resting_heart_rate', 'dailyRestingHeartRate', startDate, endDate,
        (r) => (r.beatsPerMinute !== undefined ? parseFloat(r.beatsPerMinute) : null));
      for (const [d, val] of Object.entries(v)) ensure(d).rhr = val;
    })(),
    (async () => {
      const v = await fetchDaily(accessToken, 'daily-heart-rate-variability', 'daily_heart_rate_variability', 'dailyHeartRateVariability', startDate, endDate,
        (r) => (r.averageHeartRateVariabilityMilliseconds !== undefined ? r.averageHeartRateVariabilityMilliseconds : null));
      for (const [d, val] of Object.entries(v)) ensure(d).hrv = val;
    })(),
    (async () => {
      const avg = await fetchDaily(accessToken, 'daily-oxygen-saturation', 'daily_oxygen_saturation', 'dailyOxygenSaturation', startDate, endDate,
        (r) => (r.averagePercentage !== undefined ? r.averagePercentage : null));
      const low = await fetchDaily(accessToken, 'daily-oxygen-saturation', 'daily_oxygen_saturation', 'dailyOxygenSaturation', startDate, endDate,
        (r) => (r.lowerBoundPercentage !== undefined ? r.lowerBoundPercentage : null));
      for (const [d, val] of Object.entries(avg)) ensure(d).spo2_avg = val;
      for (const [d, val] of Object.entries(low)) ensure(d).spo2_min = val;
    })(),
    (async () => {
      const v = await fetchDaily(accessToken, 'daily-respiratory-rate', 'daily_respiratory_rate', 'dailyRespiratoryRate', startDate, endDate,
        (r) => (r.breathsPerMinute !== undefined ? r.breathsPerMinute : null));
      for (const [d, val] of Object.entries(v)) ensure(d).breathing_rate = val;
    })(),
    (async () => {
      const v = await fetchDaily(accessToken, 'daily-sleep-temperature-derivations', 'daily_sleep_temperature_derivations', 'dailySleepTemperatureDerivations', startDate, endDate,
        (r) => {
          if (r.nightlyTemperatureCelsius === undefined || r.baselineTemperatureCelsius === undefined) return null;
          const delta = r.nightlyTemperatureCelsius - r.baselineTemperatureCelsius;
          return Math.round(delta * 1000) / 1000;
        });
      for (const [d, val] of Object.entries(v)) ensure(d).skin_temp_delta = val;
    })(),
    (async () => {
      const v = await fetchSleep(accessToken, startDate, endDate);
      for (const [d, s] of Object.entries(v)) {
        const day = ensure(d);
        day.sleep_minutes = s.minutes;
        day.sleep_efficiency = s.efficiency;
        day.deep_minutes = s.deepMinutes;
        day.rem_minutes = s.remMinutes;
      }
    })(),
  ];

  // Run all fetches; one type failing must not fail the whole sync.
  const results = await Promise.allSettled(jobs);
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const names = ['resting heart rate', 'HRV', 'SpO2', 'respiratory rate', 'skin temperature', 'sleep'];
      const msg = (r.reason && r.reason.response && r.reason.response.data && r.reason.response.data.error && r.reason.response.data.error.message) || (r.reason && r.reason.message) || 'unknown error';
      errors.push(names[i] + ': ' + msg);
    }
  });

  return { days, errors };
}

module.exports = {
  HEALTH_API_BASE,
  SCOPES,
  baseUrl,
  redirectUri,
  isConfigured,
  getOAuth2Client,
  getAuthUrl,
  exchangeCode,
  refreshAccessToken,
  encryptToken,
  decryptToken,
  fetchDailySummaries,
  fetchDaily,
  fetchSleep,
  dateObjToStr,
  localDateOf,
};
