// Garmin Health API client for H-CAR.
//
// Garmin does NOT use Google Health. It requires direct integration with
// the Garmin Health API through the Garmin Connect Developer Program.
//
// Access tiers:
//   Personal: Self-serve, own data only, pull-based. Not for H-CAR.
//   Business Starter: Application required, push only, no historical data,
//     limited user capacity. Free after approval.
//   Business Enterprise: Push or ping/pull, 1 month history, unlimited users,
//     negotiated terms. Free after approval (Garmin says "approved companies
//     get free access").
//
// Auth: OAuth 2.0 with PKCE (Proof Key for Code Exchange).
//   Authorization: https://connect.garmin.com/oauth2Confirm
//   Token: https://diauth.garmin.com/di-oauth2-service/oauth/token
//   API base: https://apis.garmin.com/wellness-api/rest/
//
// Data delivery: PUSH-based for Business tiers. Garmin sends data to your
// registered webhook URLs when a user syncs their device. There is no
// polling endpoint for Starter tier. Enterprise can also use ping/pull.
//
// Data types (Health API):
//   dailies          -> steps, resting HR, stress, Body Battery, etc.
//   sleep            -> sleep duration, stages, score, SpO2, respiration
//   hrv              -> overnight RMSSD average, 5-min samples
//   pulseox          -> SpO2 samples (continuous and on-demand)
//   allDayRespiration -> all-day respiration samples
//   skinTemp         -> average skin-temp deviation for sleep interval
//                      (available on Fenix 7, Epix Gen 2, and newer models)
//   stressDetails    -> 3-min stress samples, Body Battery
//   userMetrics      -> VO2 max, fitness age
//   bodyComps        -> weight, BMI, body fat, etc.
//   healthSnapshot   -> snapshot HR, respiration, stress, SpO2, HRV
//
// H-CAR mapping:
//   dailies.restingHeartRate          -> rhr
//   hrv.lastNightAvg                  -> hrv (RMSSD in ms)
//   pulseox (sleep avg)               -> spo2_avg
//   pulseox (lowest)                  -> spo2_min
//   allDayRespiration (avg)           -> breathing_rate
//   sleep (duration)                  -> sleep_minutes
//   sleep (efficiency)                -> sleep_efficiency
//   skinTemp (avg deviation)          -> skin_temp_delta (when available)
//
// Notes:
// - Skin temperature is available on newer Garmin watches (Fenix 7 series,
//   Epix Gen 2, Forerunner 965, etc.) but not on older models. The detector
//   works with 5 signals when skin temp is missing.
// - Historical backfill requires the user to grant HISTORICAL_DATA_EXPORT
//   permission during authorization. Without it, backfill returns 403.
// - Garmin may send the same data multiple times. Webhook processing must
//   be idempotent (upsert by user_id + date).
// - Webhook endpoints must be publicly reachable with valid HTTPS.
//   Render provides this automatically.

const axios = require('axios');
const crypto = require('crypto');

// Garmin OAuth 2.0 endpoints
const GARMIN_AUTH_URL = 'https://connect.garmin.com/oauth2Confirm';
const GARMIN_TOKEN_URL = 'https://diauth.garmin.com/di-oauth2-service/oauth/token';
const GARMIN_API_BASE = 'https://apis.garmin.com/wellness-api/rest';

// Scopes requested during OAuth. These determine what data Garmin will
// push to our webhooks. Request only what H-CAR needs.
const SCOPES = [
  'dailies',
  'sleep',
  'hrv',
  'pulseox',
  'respiration',
  'skinTemp',
  'stress',
];

function baseUrl() {
  return (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function redirectUri() {
  return baseUrl() + '/api/garmin/callback';
}

function isConfigured() {
  return !!(process.env.GARMIN_CLIENT_ID && process.env.GARMIN_CLIENT_SECRET);
}

// ---- PKCE helpers ----
// PKCE (RFC 7636) prevents authorization code interception. We generate a
// random code_verifier, derive a code_challenge (SHA256, base64url), send
// the challenge with the auth request, and send the verifier when
// exchanging the code for tokens.

function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function getAuthUrl(state, codeChallenge) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.GARMIN_CLIENT_ID,
    redirect_uri: redirectUri(),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state: state,
  });
  return GARMIN_AUTH_URL + '?' + params.toString();
}

async function exchangeCode(code, codeVerifier) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: redirectUri(),
    client_id: process.env.GARMIN_CLIENT_ID,
    client_secret: process.env.GARMIN_CLIENT_SECRET,
    code_verifier: codeVerifier,
  });
  const res = await axios.post(GARMIN_TOKEN_URL, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 30000,
  });
  return res.data; // { access_token, refresh_token, expires_in, token_type, scope }
}

async function refreshAccessToken(refreshToken) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: process.env.GARMIN_CLIENT_ID,
    client_secret: process.env.GARMIN_CLIENT_SECRET,
  });
  const res = await axios.post(GARMIN_TOKEN_URL, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 30000,
  });
  return res.data;
}

// ---- Token encryption (AES-256-GCM) ----
// Reuses the same encryption as google-health.js. Key from
// TOKEN_ENCRYPTION_KEY env var, or derived from JWT_SECRET.
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

// ---- Webhook payload parsing ----
// Garmin sends push notifications to our registered webhook URLs. Each
// data type has its own endpoint, or a single endpoint receives all types
// with an X-Record-Type header indicating the data type.
//
// Payload format (example for dailies):
// {
//   "dailies": [
//     {
//       "userId": "garmin-user-id",
//       "calendarDate": "2026-11-22",
//       "restingHeartRate": 58,
//       "totalSteps": 8432,
//       "activeTime": 3600,
//       ...
//     }
//   ]
// }
//
// For sleep:
// {
//   "sleeps": [
//     {
//       "userId": "garmin-user-id",
//       "calendarDate": "2026-11-22",
//       "durationInSeconds": 25200,
//       "sleepScores": { "overall": { "value": 82 } },
//       "averageSpO2Value": 95,
//       "averageRespirationValue": 14.2,
//       ...
//     }
//   ]
// }
//
// For HRV:
// {
//   "hrvSummaries": [
//     {
//       "userId": "garmin-user-id",
//       "calendarDate": "2026-11-22",
//       "lastNightAvg": 42,
//       "lastNight5MinHigh": 68,
//       ...
//     }
//   ]
// }

// Parse a Garmin webhook payload into H-CAR daily summary format.
// Returns { 'YYYY-MM-DD': { rhr, hrv, spo2_avg, spo2_min, breathing_rate,
//   sleep_minutes, sleep_efficiency, skin_temp_delta } }.
// Any signal may be null when Garmin has no data for that day.
function parseWebhookPayload(recordType, payload) {
  const days = {};

  function ensure(date) {
    if (!days[date]) {
      days[date] = {
        rhr: null, hrv: null, spo2_avg: null, spo2_min: null,
        breathing_rate: null, sleep_minutes: null, sleep_efficiency: null,
        skin_temp_delta: null, deep_minutes: null, rem_minutes: null,
      };
    }
    return days[date];
  }

  // Dailies: resting HR, steps, stress, Body Battery
  if (recordType === 'dailies' && Array.isArray(payload.dailies)) {
    for (const d of payload.dailies) {
      if (!d.calendarDate) continue;
      const day = ensure(d.calendarDate);
      if (d.restingHeartRate !== undefined && d.restingHeartRate !== null) {
        day.rhr = d.restingHeartRate;
      }
    }
  }

  // Sleep: duration, efficiency, SpO2, respiration
  if (recordType === 'sleep' && Array.isArray(payload.sleeps)) {
    for (const s of payload.sleeps) {
      if (!s.calendarDate) continue;
      const day = ensure(s.calendarDate);
      if (s.durationInSeconds !== undefined && s.durationInSeconds !== null) {
        day.sleep_minutes = Math.round(s.durationInSeconds / 60);
      }
      // Sleep efficiency: Garmin provides sleep scores, not direct efficiency.
      // Estimate from duration vs time in bed if available.
      if (s.sleepScores && s.sleepScores.overall && s.sleepScores.overall.value !== undefined) {
        // Sleep score is 0-100, not efficiency, but we can use it as a proxy
        // for now. H-CAR uses efficiency for context, not as a detector signal.
        day.sleep_efficiency = s.sleepScores.overall.value;
      }
      if (s.averageSpO2Value !== undefined && s.averageSpO2Value !== null) {
        day.spo2_avg = s.averageSpO2Value;
      }
      if (s.lowestSpO2Value !== undefined && s.lowestSpO2Value !== null) {
        day.spo2_min = s.lowestSpO2Value;
      }
      if (s.averageRespirationValue !== undefined && s.averageRespirationValue !== null) {
        day.breathing_rate = s.averageRespirationValue;
      }
      // Deep and REM sleep minutes from sleep stages
      if (s.sleepLevels) {
        let deepSeconds = 0;
        let remSeconds = 0;
        for (const level of s.sleepLevels) {
          if (level.sleepLevel === 'deep' && level.durationInSeconds) {
            deepSeconds += level.durationInSeconds;
          }
          if (level.sleepLevel === 'rem' && level.durationInSeconds) {
            remSeconds += level.durationInSeconds;
          }
        }
        if (deepSeconds > 0) day.deep_minutes = Math.round(deepSeconds / 60);
        if (remSeconds > 0) day.rem_minutes = Math.round(remSeconds / 60);
      }
    }
  }

  // HRV: overnight RMSSD average
  if (recordType === 'hrv' && Array.isArray(payload.hrvSummaries)) {
    for (const h of payload.hrvSummaries) {
      if (!h.calendarDate) continue;
      const day = ensure(h.calendarDate);
      if (h.lastNightAvg !== undefined && h.lastNightAvg !== null) {
        day.hrv = h.lastNightAvg;
      }
    }
  }

  // PulseOx: SpO2 samples
  if (recordType === 'pulseox' && Array.isArray(payload.pulseOx)) {
    for (const p of payload.pulseOx) {
      if (!p.calendarDate) continue;
      const day = ensure(p.calendarDate);
      // Garmin sends multiple SpO2 readings per day. Use the sleep average
      // if available, otherwise the daily average.
      if (p.averageSpO2Value !== undefined && p.averageSpO2Value !== null) {
        // Only set if not already set from sleep data (sleep is more accurate)
        if (day.spo2_avg === null) {
          day.spo2_avg = p.averageSpO2Value;
        }
      }
      if (p.lowestSpO2Value !== undefined && p.lowestSpO2Value !== null) {
        if (day.spo2_min === null) {
          day.spo2_min = p.lowestSpO2Value;
        }
      }
    }
  }

  // Respiration: all-day breathing rate
  if (recordType === 'respiration' && Array.isArray(payload.allDayRespiration)) {
    for (const r of payload.allDayRespiration) {
      if (!r.calendarDate) continue;
      const day = ensure(r.calendarDate);
      // Average the respiration samples for the day
      if (Array.isArray(r.respirationValues) && r.respirationValues.length > 0) {
        const sum = r.respirationValues.reduce((acc, v) => acc + (v.breathsPerMinute || 0), 0);
        const avg = sum / r.respirationValues.length;
        if (!Number.isNaN(avg) && avg > 0) {
          // Only set if not already set from sleep data
          if (day.breathing_rate === null) {
            day.breathing_rate = Math.round(avg * 10) / 10;
          }
        }
      }
    }
  }

  // Skin temperature: average deviation for sleep interval
  // Available on Fenix 7, Epix Gen 2, Forerunner 965, and newer models.
  if (recordType === 'skinTemp' && Array.isArray(payload.skinTemp)) {
    for (const t of payload.skinTemp) {
      if (!t.calendarDate) continue;
      const day = ensure(t.calendarDate);
      if (t.averageDeviation !== undefined && t.averageDeviation !== null) {
        day.skin_temp_delta = Math.round(t.averageDeviation * 1000) / 1000;
      }
    }
  }

  return days;
}

// ---- Pull API (Enterprise tier or Personal API fallback) ----
// For Enterprise tier, Garmin supports ping/pull: we receive a ping
// notification, then fetch the data from Garmin's API. For Starter tier,
// data is pushed directly to our webhook, so this is not needed.
// This function is provided for completeness and for testing with the
// Personal API.

async function fetchDailySummaries(accessToken, startDate, endDate) {
  // This is a placeholder for the pull model. In practice, Garmin Business
  // Starter tier uses push only, so this function is not used in production.
  // Enterprise tier can use ping/pull, but the exact endpoints are documented
  // only in the Developer Portal after approval.
  //
  // For now, this function returns an empty result. Webhook push is the
  // primary data ingestion method.
  //
  // TODO: Implement pull API once Garmin approves H-CAR and provides
  // the endpoint documentation in the Developer Portal.
  return { days: {}, errors: ['Garmin pull API not implemented. Garmin uses push notifications for Business tier.'] };
}

module.exports = {
  GARMIN_AUTH_URL,
  GARMIN_TOKEN_URL,
  GARMIN_API_BASE,
  SCOPES,
  baseUrl,
  redirectUri,
  isConfigured,
  generateCodeVerifier,
  generateCodeChallenge,
  getAuthUrl,
  exchangeCode,
  refreshAccessToken,
  encryptToken,
  decryptToken,
  parseWebhookPayload,
  fetchDailySummaries,
};
