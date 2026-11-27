// Tests for automatic elevation detection (public/elevation.js).
// Covers elevation lookup response parsing, the 1500 m SpO2 correction
// still applying to auto-detected values, coordinates never being
// persisted, and geolocation failure falling back to manual.
// Run with: node test-elevation.js
const assert = require('assert');
const elevation = require('./public/elevation');
const context = require('./context');

let passed = 0;
function check(name, fn) {
  const out = fn();
  if (out && typeof out.then === 'function') {
    return out.then(() => {
      passed += 1;
      console.log('ok - ' + name);
    });
  }
  passed += 1;
  console.log('ok - ' + name);
  return Promise.resolve();
}

function fakeStorage() {
  const data = {};
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    _data: data
  };
}

function fakeGeoSuccess(lat, lon) {
  return { getCurrentPosition: (ok) => ok({ coords: { latitude: lat, longitude: lon } }) };
}

function fakeGeoFail() {
  return { getCurrentPosition: (ok, err) => err(new Error('Permission denied')) };
}

function fakeFetchOk(json) {
  return async () => ({ ok: true, json: async () => json });
}

async function run() {
  // ---- Open-Meteo response parsing ----
  await check('Open-Meteo parses a valid elevation', () => {
    assert.strictEqual(elevation.parseOpenMeteoElevation({ elevation: [850] }), 850);
  });

  await check('Open-Meteo keeps decimal elevations', () => {
    assert.strictEqual(elevation.parseOpenMeteoElevation({ elevation: [1500.4] }), 1500.4);
  });

  await check('Open-Meteo returns null for an empty elevation list', () => {
    assert.strictEqual(elevation.parseOpenMeteoElevation({ elevation: [] }), null);
  });

  await check('Open-Meteo returns null when elevation is missing', () => {
    assert.strictEqual(elevation.parseOpenMeteoElevation({}), null);
    assert.strictEqual(elevation.parseOpenMeteoElevation(null), null);
  });

  await check('Open-Meteo returns null for a non-numeric elevation', () => {
    assert.strictEqual(elevation.parseOpenMeteoElevation({ elevation: ['abc'] }), null);
  });

  await check('Open-Meteo returns null for an out of range elevation', () => {
    assert.strictEqual(elevation.parseOpenMeteoElevation({ elevation: [20000] }), null);
  });

  // ---- OpenTopoData response parsing (fallback service) ----
  await check('OpenTopoData parses a valid elevation', () => {
    assert.strictEqual(elevation.parseOpenTopoDataElevation({ results: [{ elevation: 1200, location: { lat: 49, lng: -124 } }] }), 1200);
  });

  await check('OpenTopoData returns null for empty results', () => {
    assert.strictEqual(elevation.parseOpenTopoDataElevation({ results: [] }), null);
    assert.strictEqual(elevation.parseOpenTopoDataElevation({}), null);
  });

  await check('OpenTopoData returns null when elevation is null', () => {
    assert.strictEqual(elevation.parseOpenTopoDataElevation({ results: [{ elevation: null }] }), null);
  });

  // ---- Lookup URLs ----
  await check('lookup URLs use https and carry the coordinates', () => {
    const url = elevation.openMeteoLookupUrl(49.25, -124.0);
    assert.ok(url.startsWith('https://api.open-meteo.com/v1/elevation?'));
    assert.ok(url.includes('latitude=49.25'));
    assert.ok(url.includes('longitude=-124'));
    const url2 = elevation.openTopoDataLookupUrl(49.25, -124.0);
    assert.ok(url2.startsWith('https://api.opentopodata.org/v1/srtm90m?'));
    assert.ok(url2.includes('locations=49.25'));
  });

  // ---- Elevation validation ----
  await check('elevation bounds accept the full range', () => {
    assert.strictEqual(elevation.isValidElevation(0), true);
    assert.strictEqual(elevation.isValidElevation(-500), true);
    assert.strictEqual(elevation.isValidElevation(9000), true);
    assert.strictEqual(elevation.isValidElevation(850), true);
  });

  await check('elevation bounds reject bad values', () => {
    assert.strictEqual(elevation.isValidElevation(-501), false);
    assert.strictEqual(elevation.isValidElevation(9001), false);
    assert.strictEqual(elevation.isValidElevation(NaN), false);
    assert.strictEqual(elevation.isValidElevation(Infinity), false);
    assert.strictEqual(elevation.isValidElevation('850'), false);
    assert.strictEqual(elevation.isValidElevation(null), false);
  });

  // ---- Payload: only date and elevation, never coordinates ----
  await check('payload carries only date and elevation', () => {
    const payload = elevation.buildAltitudePayload('2026-11-26', 850);
    assert.deepStrictEqual(Object.keys(payload).sort(), ['altitude_m', 'date']);
    assert.strictEqual(payload.date, '2026-11-26');
    assert.strictEqual(payload.altitude_m, 850);
  });

  await check('payload rounds to whole metres', () => {
    assert.strictEqual(elevation.buildAltitudePayload('2026-11-26', 850.6).altitude_m, 851);
    assert.strictEqual(elevation.buildAltitudePayload('2026-11-26', 850.4).altitude_m, 850);
  });

  await check('payload is null for an invalid elevation', () => {
    assert.strictEqual(elevation.buildAltitudePayload('2026-11-26', NaN), null);
    assert.strictEqual(elevation.buildAltitudePayload('2026-11-26', 20000), null);
  });

  // ---- Dedupe: record once per day or on a real move ----
  await check('records when nothing was recorded before', () => {
    assert.strictEqual(elevation.shouldRecordElevation(null, '2026-11-26', 850), true);
  });

  await check('does not record the same value on the same day', () => {
    assert.strictEqual(elevation.shouldRecordElevation({ date: '2026-11-26', altitude_m: 850 }, '2026-11-26', 850), false);
  });

  await check('does not record a small move on the same day', () => {
    assert.strictEqual(elevation.shouldRecordElevation({ date: '2026-11-26', altitude_m: 850 }, '2026-11-26', 900), false);
    assert.strictEqual(elevation.shouldRecordElevation({ date: '2026-11-26', altitude_m: 850 }, '2026-11-26', 950), false);
  });

  await check('records a move of more than 100 m on the same day', () => {
    assert.strictEqual(elevation.shouldRecordElevation({ date: '2026-11-26', altitude_m: 850 }, '2026-11-26', 951), true);
    assert.strictEqual(elevation.shouldRecordElevation({ date: '2026-11-26', altitude_m: 850 }, '2026-11-26', 699), true);
  });

  await check('records again on a new day even when the value is the same', () => {
    assert.strictEqual(elevation.shouldRecordElevation({ date: '2026-11-25', altitude_m: 850 }, '2026-11-26', 850), true);
  });

  await check('does not record an invalid elevation', () => {
    assert.strictEqual(elevation.shouldRecordElevation(null, '2026-11-26', NaN), false);
  });

  // ---- 1500 m correction still applies to auto-detected values ----
  await check('auto-detected 1800 m still gets the plus 3 SpO2 correction', () => {
    const detected = elevation.parseOpenMeteoElevation({ elevation: [1800] });
    assert.strictEqual(detected, 1800);
    assert.strictEqual(context.altitudeSpo2Correction(detected), 3);
  });

  await check('auto-detected 1500 m gets the correction, 1499 m does not', () => {
    assert.strictEqual(context.altitudeSpo2Correction(1500), 3);
    assert.strictEqual(context.altitudeSpo2Correction(1499), 0);
  });

  await check('auto-detected low elevation gets no correction', () => {
    const detected = elevation.parseOpenMeteoElevation({ elevation: [850] });
    assert.strictEqual(context.altitudeSpo2Correction(detected), 0);
  });

  // ---- Coordinates are never persisted ----
  await check('local storage keeps only date and elevation, never coordinates', () => {
    const storage = fakeStorage();
    elevation.writeLastRecorded(storage, '2026-11-26', 850);
    const stored = JSON.parse(storage._data[elevation.STORAGE_KEY]);
    assert.deepStrictEqual(Object.keys(stored).sort(), ['altitude_m', 'date']);
    assert.strictEqual(stored.altitude_m, 850);
    assert.strictEqual(stored.date, '2026-11-26');
    const readBack = elevation.readLastRecorded(storage);
    assert.deepStrictEqual(readBack, { date: '2026-11-26', altitude_m: 850 });
  });

  // ---- Full flow: success records only date and elevation ----
  await check('full flow records the detected elevation and nothing else', async () => {
    const storage = fakeStorage();
    const posted = [];
    const apiCall = async (endpoint, method, body) => {
      posted.push({ endpoint, method, body });
      return { ok: true };
    };
    let noted = null;
    const result = await elevation.autoDetectElevation({
      enabled: true,
      apiCall: apiCall,
      storage: storage,
      todayStr: '2026-11-26',
      geolocation: fakeGeoSuccess(49.25, -124.0),
      fetchFn: fakeFetchOk({ elevation: [850] }),
      onDetected: (m, recorded) => { noted = { m, recorded }; }
    });
    assert.strictEqual(result, 850);
    assert.strictEqual(posted.length, 1);
    assert.strictEqual(posted[0].endpoint, '/altitude');
    assert.deepStrictEqual(Object.keys(posted[0].body).sort(), ['altitude_m', 'date']);
    assert.deepStrictEqual(posted[0].body, { date: '2026-11-26', altitude_m: 850 });
    const stored = JSON.parse(storage._data[elevation.STORAGE_KEY]);
    assert.deepStrictEqual(Object.keys(stored).sort(), ['altitude_m', 'date']);
    assert.deepStrictEqual(noted, { m: 850, recorded: true });
  });

  await check('full flow does not repeat the same value on the same day', async () => {
    const storage = fakeStorage();
    elevation.writeLastRecorded(storage, '2026-11-27', 850);
    let calls = 0;
    const apiCall = async () => { calls += 1; return { ok: true }; };
    const result = await elevation.autoDetectElevation({
      enabled: true,
      apiCall: apiCall,
      storage: storage,
      todayStr: '2026-11-27',
      geolocation: fakeGeoSuccess(49.25, -124.0),
      fetchFn: fakeFetchOk({ elevation: [850] })
    });
    assert.strictEqual(result, 850);
    assert.strictEqual(calls, 0);
  });

  await check('full flow records again after a move of more than 100 m', async () => {
    const storage = fakeStorage();
    elevation.writeLastRecorded(storage, '2026-11-28', 850);
    const posted = [];
    const apiCall = async (endpoint, method, body) => { posted.push(body); return { ok: true }; };
    const result = await elevation.autoDetectElevation({
      enabled: true,
      apiCall: apiCall,
      storage: storage,
      todayStr: '2026-11-28',
      geolocation: fakeGeoSuccess(49.25, -124.0),
      fetchFn: fakeFetchOk({ elevation: [1000] })
    });
    assert.strictEqual(result, 1000);
    assert.strictEqual(posted.length, 1);
    assert.deepStrictEqual(posted[0], { date: '2026-11-28', altitude_m: 1000 });
  });

  await check('full flow falls back to OpenTopoData when Open-Meteo fails', async () => {
    const storage = fakeStorage();
    const posted = [];
    const apiCall = async (endpoint, method, body) => { posted.push(body); return { ok: true }; };
    let calls = 0;
    const fetchFn = async (url) => {
      calls += 1;
      if (url.includes('open-meteo')) throw new Error('network down');
      return { ok: true, json: async () => ({ results: [{ elevation: 1200 }] }) };
    };
    const result = await elevation.autoDetectElevation({
      enabled: true,
      apiCall: apiCall,
      storage: storage,
      todayStr: '2026-11-29',
      geolocation: fakeGeoSuccess(49.25, -124.0),
      fetchFn: fetchFn
    });
    assert.strictEqual(result, 1200);
    assert.strictEqual(calls, 2);
    assert.strictEqual(posted.length, 1);
    assert.deepStrictEqual(posted[0], { date: '2026-11-29', altitude_m: 1200 });
  });

  // ---- Geolocation failure falls back to manual ----
  await check('detection returns null when permission is denied', async () => {
    const result = await elevation.detectElevationNow({
      geolocation: fakeGeoFail(),
      fetchFn: fakeFetchOk({ elevation: [850] })
    });
    assert.strictEqual(result, null);
  });

  await check('detection returns null when geolocation is unavailable', async () => {
    const result = await elevation.detectElevationNow({
      geolocation: null,
      fetchFn: fakeFetchOk({ elevation: [850] })
    });
    assert.strictEqual(result, null);
  });

  await check('detection returns null when the lookup fails', async () => {
    const result = await elevation.detectElevationNow({
      geolocation: fakeGeoSuccess(49.25, -124.0),
      fetchFn: async () => { throw new Error('network down'); }
    });
    assert.strictEqual(result, null);
  });

  await check('detection returns null when both services give bad data', async () => {
    const result = await elevation.detectElevationNow({
      geolocation: fakeGeoSuccess(49.25, -124.0),
      fetchFn: fakeFetchOk({})
    });
    assert.strictEqual(result, null);
  });

  await check('full flow posts nothing and calls onUnavailable when denied', async () => {
    const storage = fakeStorage();
    let calls = 0;
    let unavailable = false;
    const apiCall = async () => { calls += 1; return { ok: true }; };
    const result = await elevation.autoDetectElevation({
      enabled: true,
      apiCall: apiCall,
      storage: storage,
      todayStr: '2026-11-30',
      geolocation: fakeGeoFail(),
      fetchFn: fakeFetchOk({ elevation: [850] }),
      onUnavailable: () => { unavailable = true; }
    });
    assert.strictEqual(result, null);
    assert.strictEqual(calls, 0);
    assert.strictEqual(unavailable, true);
  });

  await check('full flow does nothing when the opt-in is off', async () => {
    let calls = 0;
    const apiCall = async () => { calls += 1; return { ok: true }; };
    const result = await elevation.autoDetectElevation({
      enabled: false,
      apiCall: apiCall,
      storage: fakeStorage(),
      todayStr: '2026-12-01',
      geolocation: fakeGeoSuccess(49.25, -124.0),
      fetchFn: fakeFetchOk({ elevation: [850] })
    });
    assert.strictEqual(result, null);
    assert.strictEqual(calls, 0);
  });

  console.log('\n' + passed + ' elevation tests passed.');
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
