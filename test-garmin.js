// Unit tests for Garmin Health API integration.
// Tests webhook payload parsing, PKCE helpers, and data mapping.

const garminHealth = require('./garmin-health');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log('  PASS: ' + message);
  } else {
    failed++;
    console.log('  FAIL: ' + message);
  }
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    passed++;
    console.log('  PASS: ' + message);
  } else {
    failed++;
    console.log('  FAIL: ' + message + ' (expected ' + expected + ', got ' + actual + ')');
  }
}

console.log('Testing Garmin Health API integration...\n');

// Test 1: PKCE helpers
console.log('1. PKCE helpers');
const verifier = garminHealth.generateCodeVerifier();
assert(verifier.length >= 43 && verifier.length <= 128, 'Code verifier is 43-128 chars');
assert(/^[A-Za-z0-9\-_]+$/.test(verifier), 'Code verifier is base64url');

const challenge = garminHealth.generateCodeChallenge(verifier);
assert(challenge.length === 43, 'Code challenge is 43 chars (SHA256 base64url)');
assert(/^[A-Za-z0-9\-_]+$/.test(challenge), 'Code challenge is base64url');

// Same verifier should produce same challenge
const challenge2 = garminHealth.generateCodeChallenge(verifier);
assertEqual(challenge, challenge2, 'Same verifier produces same challenge');

// Different verifier should produce different challenge
const verifier2 = garminHealth.generateCodeVerifier();
const challenge3 = garminHealth.generateCodeChallenge(verifier2);
assert(challenge !== challenge3, 'Different verifier produces different challenge');

// Test 2: Configuration check
console.log('\n2. Configuration check');
assert(!garminHealth.isConfigured() || process.env.GARMIN_CLIENT_ID, 'isConfigured returns false when env vars not set (or true if set)');

// Test 3: Webhook payload parsing - Dailies
console.log('\n3. Webhook payload parsing - Dailies');
const dailiesPayload = {
  dailies: [
    {
      userId: 'garmin-user-123',
      calendarDate: '2026-11-22',
      restingHeartRate: 58,
      totalSteps: 8432,
    },
    {
      userId: 'garmin-user-123',
      calendarDate: '2026-11-21',
      restingHeartRate: 60,
      totalSteps: 7200,
    },
  ],
};
const dailiesDays = garminHealth.parseWebhookPayload('dailies', dailiesPayload);
assertEqual(dailiesDays['2026-11-22'].rhr, 58, 'Dailies RHR parsed for 2026-11-22');
assertEqual(dailiesDays['2026-11-21'].rhr, 60, 'Dailies RHR parsed for 2026-11-21');
assertEqual(dailiesDays['2026-11-22'].hrv, null, 'Dailies HRV is null (not in dailies)');
assertEqual(Object.keys(dailiesDays).length, 2, 'Two days parsed from dailies');

// Test 4: Webhook payload parsing - Sleep
console.log('\n4. Webhook payload parsing - Sleep');
const sleepPayload = {
  sleeps: [
    {
      userId: 'garmin-user-123',
      calendarDate: '2026-11-22',
      durationInSeconds: 25200, // 7 hours
      averageSpO2Value: 95,
      lowestSpO2Value: 92,
      averageRespirationValue: 14.2,
      sleepScores: { overall: { value: 82 } },
      sleepLevels: [
        { sleepLevel: 'deep', durationInSeconds: 3600 },
        { sleepLevel: 'rem', durationInSeconds: 5400 },
      ],
    },
  ],
};
const sleepDays = garminHealth.parseWebhookPayload('sleep', sleepPayload);
assertEqual(sleepDays['2026-11-22'].sleep_minutes, 420, 'Sleep duration converted to minutes (25200s = 420min)');
assertEqual(sleepDays['2026-11-22'].spo2_avg, 95, 'Sleep SpO2 avg parsed');
assertEqual(sleepDays['2026-11-22'].spo2_min, 92, 'Sleep SpO2 min parsed');
assertEqual(sleepDays['2026-11-22'].breathing_rate, 14.2, 'Sleep breathing rate parsed');
assertEqual(sleepDays['2026-11-22'].sleep_efficiency, 82, 'Sleep score used as efficiency proxy');
assertEqual(sleepDays['2026-11-22'].deep_minutes, 60, 'Deep sleep minutes parsed (3600s = 60min)');
assertEqual(sleepDays['2026-11-22'].rem_minutes, 90, 'REM sleep minutes parsed (5400s = 90min)');

// Test 5: Webhook payload parsing - HRV
console.log('\n5. Webhook payload parsing - HRV');
const hrvPayload = {
  hrvSummaries: [
    {
      userId: 'garmin-user-123',
      calendarDate: '2026-11-22',
      lastNightAvg: 42,
      lastNight5MinHigh: 68,
    },
  ],
};
const hrvDays = garminHealth.parseWebhookPayload('hrv', hrvPayload);
assertEqual(hrvDays['2026-11-22'].hrv, 42, 'HRV lastNightAvg parsed');

// Test 6: Webhook payload parsing - PulseOx
console.log('\n6. Webhook payload parsing - PulseOx');
const pulseoxPayload = {
  pulseOx: [
    {
      userId: 'garmin-user-123',
      calendarDate: '2026-11-22',
      averageSpO2Value: 96,
      lowestSpO2Value: 93,
    },
  ],
};
const pulseoxDays = garminHealth.parseWebhookPayload('pulseox', pulseoxPayload);
assertEqual(pulseoxDays['2026-11-22'].spo2_avg, 96, 'PulseOx SpO2 avg parsed');
assertEqual(pulseoxDays['2026-11-22'].spo2_min, 93, 'PulseOx SpO2 min parsed');

// Test 7: Webhook payload parsing - Skin Temp
console.log('\n7. Webhook payload parsing - Skin Temp');
const skinTempPayload = {
  skinTemp: [
    {
      userId: 'garmin-user-123',
      calendarDate: '2026-11-22',
      averageDeviation: 0.15,
    },
  ],
};
const skinTempDays = garminHealth.parseWebhookPayload('skinTemp', skinTempPayload);
assertEqual(skinTempDays['2026-11-22'].skin_temp_delta, 0.15, 'Skin temp deviation parsed');

// Test 8: Webhook payload parsing - Respiration
console.log('\n8. Webhook payload parsing - Respiration');
const respirationPayload = {
  allDayRespiration: [
    {
      userId: 'garmin-user-123',
      calendarDate: '2026-11-22',
      respirationValues: [
        { breathsPerMinute: 14 },
        { breathsPerMinute: 15 },
        { breathsPerMinute: 14 },
      ],
    },
  ],
};
const respirationDays = garminHealth.parseWebhookPayload('respiration', respirationPayload);
assertEqual(respirationDays['2026-11-22'].breathing_rate, 14.3, 'Respiration average calculated (14+15+14)/3 = 14.3');

// Test 9: Empty payload handling
console.log('\n9. Empty payload handling');
const emptyDays = garminHealth.parseWebhookPayload('dailies', { dailies: [] });
assertEqual(Object.keys(emptyDays).length, 0, 'Empty dailies array returns empty days');

const nullDays = garminHealth.parseWebhookPayload('dailies', {});
assertEqual(Object.keys(nullDays).length, 0, 'Missing dailies key returns empty days');

// Test 10: Missing fields handling
console.log('\n10. Missing fields handling');
const incompletePayload = {
  dailies: [
    {
      userId: 'garmin-user-123',
      calendarDate: '2026-11-22',
      // No restingHeartRate
      totalSteps: 8432,
    },
  ],
};
const incompleteDays = garminHealth.parseWebhookPayload('dailies', incompletePayload);
assertEqual(incompleteDays['2026-11-22'].rhr, null, 'Missing RHR results in null, not error');

// Test 11: Token encryption
console.log('\n11. Token encryption');
const testToken = 'test-access-token-12345';
const encrypted = garminHealth.encryptToken(testToken);
assert(encrypted !== testToken, 'Encrypted token differs from plaintext');
assert(encrypted.length > testToken.length, 'Encrypted token is longer (includes IV and tag)');

const decrypted = garminHealth.decryptToken(encrypted);
assertEqual(decrypted, testToken, 'Decrypted token matches original');

// Test 12: Auth URL generation
console.log('\n12. Auth URL generation');
process.env.GARMIN_CLIENT_ID = 'test-client-id';
process.env.BASE_URL = 'https://h-car.onrender.com';
const testState = 'test-state-123';
const testChallenge = 'test-challenge-abc';
const authUrl = garminHealth.getAuthUrl(testState, testChallenge);
assert(authUrl.includes('https://connect.garmin.com/oauth2Confirm'), 'Auth URL uses Garmin endpoint');
assert(authUrl.includes('client_id=test-client-id'), 'Auth URL includes client ID');
assert(authUrl.includes('state=test-state-123'), 'Auth URL includes state');
assert(authUrl.includes('code_challenge=test-challenge-abc'), 'Auth URL includes code challenge');
assert(authUrl.includes('code_challenge_method=S256'), 'Auth URL uses S256 challenge method');
assert(authUrl.includes('response_type=code'), 'Auth URL requests code response');

// Summary
console.log('\n' + '='.repeat(50));
console.log('Tests passed: ' + passed);
console.log('Tests failed: ' + failed);
console.log('='.repeat(50));

if (failed > 0) {
  process.exit(1);
} else {
  console.log('\nALL TESTS PASSED');
  process.exit(0);
}
