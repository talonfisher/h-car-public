// Automatic elevation detection for H-CAR.
//
// The phone looks up the ground elevation where the user is, so high
// altitude days are handled without anyone having to remember to log
// it. The lookup runs on the phone: the browser asks the device for
// its position, sends the coordinates to a free elevation service
// (Open-Meteo first, OpenTopoData as a fallback), and gets a number
// back in metres. Only that number is saved, in the existing
// altitude_m field, through the existing POST /api/altitude endpoint.
//
// Privacy, strict:
// - Coordinates are never sent to H-CAR servers.
// - Coordinates are never stored in the database, in logs, or in
//   localStorage. Only the date and the elevation in metres are stored.
// - Detection is opt-in and off by default. When it is off, or when
//   geolocation is denied, unavailable, or times out, nothing happens
//   and the manual check-in question is the fallback.
//
// This file is written so the pure helpers can be tested in Node
// (require('./public/elevation')) as well as loaded in the browser,
// where it exposes window.HCAR_Elevation.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.HCAR_Elevation = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var OPEN_METEO_URL = 'https://api.open-meteo.com/v1/elevation';
  var OPENTOPODATA_URL = 'https://api.opentopodata.org/v1/srtm90m';
  // Record again when the elevation moved by more than this, or on a
  // new day. Smaller moves are noise (walking around the same town).
  var RECORD_CHANGE_M = 100;
  var STORAGE_KEY = 'hcar_last_elevation';
  var GEOLOCATION_TIMEOUT_MS = 10000;
  var GEOLOCATION_MAX_AGE_MS = 3600000;

  function openMeteoLookupUrl(lat, lon) {
    return OPEN_METEO_URL + '?latitude=' + encodeURIComponent(lat) + '&longitude=' + encodeURIComponent(lon);
  }

  // Open-Meteo answers { elevation: [850] }.
  function parseOpenMeteoElevation(json) {
    if (!json || !Array.isArray(json.elevation) || json.elevation.length === 0) return null;
    var raw = json.elevation[0];
    if (raw === null || raw === undefined || raw === '') return null;
    var m = Number(raw);
    return isValidElevation(m) ? m : null;
  }

  function openTopoDataLookupUrl(lat, lon) {
    return OPENTOPODATA_URL + '?locations=' + encodeURIComponent(lat + ',' + lon);
  }

  // OpenTopoData answers { results: [{ elevation: 850, location: {...} }] }.
  function parseOpenTopoDataElevation(json) {
    if (!json || !Array.isArray(json.results) || json.results.length === 0) return null;
    var raw = json.results[0].elevation;
    if (raw === null || raw === undefined || raw === '') return null;
    var m = Number(raw);
    return isValidElevation(m) ? m : null;
  }

  function isValidElevation(m) {
    return typeof m === 'number' && Number.isFinite(m) && m >= -500 && m <= 9000;
  }

  // The payload sent to H-CAR. Only the date and the elevation in
  // metres. Coordinates are never in this payload.
  function buildAltitudePayload(dateStr, altitudeM) {
    if (typeof dateStr !== 'string' || !isValidElevation(altitudeM)) return null;
    return { date: dateStr, altitude_m: Math.round(altitudeM) };
  }

  // Record when there is no previous value, when the day changed, or
  // when the elevation moved by more than the threshold. This keeps
  // noisy repeat writes out of the database.
  function shouldRecordElevation(last, todayStr, nextM, thresholdM) {
    if (!isValidElevation(nextM)) return false;
    if (!last || typeof last !== 'object') return true;
    if (last.date !== todayStr) return true;
    var prev = Number(last.altitude_m);
    if (!Number.isFinite(prev)) return true;
    var threshold = typeof thresholdM === 'number' ? thresholdM : RECORD_CHANGE_M;
    return Math.abs(nextM - prev) > threshold;
  }

  function readLastRecorded(storage) {
    try {
      if (!storage) return null;
      var raw = storage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch (e) {
      return null;
    }
  }

  function writeLastRecorded(storage, dateStr, altitudeM) {
    try {
      if (!storage) return;
      // Only the date and the elevation number are stored. Never
      // coordinates.
      storage.setItem(STORAGE_KEY, JSON.stringify({ date: dateStr, altitude_m: Math.round(altitudeM) }));
    } catch (e) {
      // Storage can be unavailable (for example, private browsing).
      // Detection still works, it just cannot dedupe.
    }
  }

  function getPosition(geolocation, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!geolocation || typeof geolocation.getCurrentPosition !== 'function') {
        reject(new Error('Geolocation is not available'));
        return;
      }
      var timeout = timeoutMs || GEOLOCATION_TIMEOUT_MS;
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) {
          settled = true;
          reject(new Error('Geolocation timed out'));
        }
      }, timeout);
      geolocation.getCurrentPosition(
        function (pos) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
        },
        function (err) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error('Geolocation failed'));
        },
        { timeout: timeout, maximumAge: GEOLOCATION_MAX_AGE_MS }
      );
    });
  }

  // Look up ground elevation for a position. Tries Open-Meteo first,
  // then OpenTopoData. Returns metres, or null when both fail.
  async function lookupElevation(lat, lon, fetchFn) {
    var doFetch = fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) return null;
    try {
      var res = await doFetch(openMeteoLookupUrl(lat, lon));
      if (res) {
        var data = await res.json();
        var m = parseOpenMeteoElevation(data);
        if (m !== null) return m;
      }
    } catch (e) {
      // Fall through to the second service.
    }
    try {
      var res2 = await doFetch(openTopoDataLookupUrl(lat, lon));
      if (res2) {
        var data2 = await res2.json();
        return parseOpenTopoDataElevation(data2);
      }
    } catch (e2) {
      return null;
    }
    return null;
  }

  // Full detection flow. Returns the elevation in metres, or null when
  // geolocation is unavailable, denied, or timed out, or when the
  // lookup fails. Never throws. Coordinates are used only for the
  // lookup and are never stored or returned.
  async function detectElevationNow(deps) {
    var d = deps || {};
    var geo = d.geolocation || (typeof navigator !== 'undefined' ? navigator.geolocation : null);
    try {
      var pos = await getPosition(geo, d.timeoutMs);
      return await lookupElevation(pos.latitude, pos.longitude, d.fetchFn);
    } catch (e) {
      return null;
    }
  }

  // At most one detection attempt per day in a page session. A failed
  // attempt still counts, so a denied permission does not re-prompt
  // on every dashboard load. The manual check-in question is the
  // fallback for that day.
  var lastAttemptDate = null;

  // Runs one automatic detection and records it when it is new enough
  // to matter. Options: { enabled, apiCall, storage, todayStr, fetchFn,
  // geolocation, onDetected(elevationM, recorded), onUnavailable() }.
  // Never throws. Does nothing when disabled.
  async function autoDetectElevation(options) {
    var opts = options || {};
    if (!opts.enabled) return null;
    var todayStr = opts.todayStr || new Date().toISOString().split('T')[0];
    if (lastAttemptDate === todayStr) return null;
    lastAttemptDate = todayStr;
    var elevationM = await detectElevationNow({ fetchFn: opts.fetchFn, geolocation: opts.geolocation });
    if (elevationM === null) {
      if (typeof opts.onUnavailable === 'function') {
        try { opts.onUnavailable(); } catch (e) { /* ignore */ }
      }
      return null;
    }
    var storage = opts.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    var last = readLastRecorded(storage);
    var recorded = false;
    if (shouldRecordElevation(last, todayStr, elevationM)) {
      var payload = buildAltitudePayload(todayStr, elevationM);
      if (payload && typeof opts.apiCall === 'function') {
        try {
          await opts.apiCall('/altitude', 'POST', payload);
          recorded = true;
          writeLastRecorded(storage, todayStr, elevationM);
        } catch (e) {
          recorded = false;
        }
      }
    }
    if (typeof opts.onDetected === 'function') {
      try { opts.onDetected(elevationM, recorded); } catch (e) { /* ignore */ }
    }
    return elevationM;
  }

  return {
    RECORD_CHANGE_M: RECORD_CHANGE_M,
    STORAGE_KEY: STORAGE_KEY,
    openMeteoLookupUrl: openMeteoLookupUrl,
    parseOpenMeteoElevation: parseOpenMeteoElevation,
    openTopoDataLookupUrl: openTopoDataLookupUrl,
    parseOpenTopoDataElevation: parseOpenTopoDataElevation,
    isValidElevation: isValidElevation,
    buildAltitudePayload: buildAltitudePayload,
    shouldRecordElevation: shouldRecordElevation,
    readLastRecorded: readLastRecorded,
    writeLastRecorded: writeLastRecorded,
    getPosition: getPosition,
    lookupElevation: lookupElevation,
    detectElevationNow: detectElevationNow,
    autoDetectElevation: autoDetectElevation
  };
});
