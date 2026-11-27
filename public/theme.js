// H-CAR theme: Dark, Light, Auto.
// The app ships dark by default. The user can pick Dark, Light, or Auto
// (follow the device setting) in Profile, Appearance, or with the quick
// toggle in the header. The choice is stored in localStorage so it
// applies instantly, and on the server (users.theme_preference) so it
// follows the user across devices. This file is presentation only: it
// never touches health data, the detector, or alerts.
//
// Usage in the browser: HCAR_Theme.applyTheme(preference) applies a
// preference and persists it. HCAR_Theme.init() wires the Auto media
// query listener. A tiny inline script in <head> applies the stored
// theme before first paint, so the page never flashes the wrong theme.
//
// In Node (tests) the same functions are exported via module.exports
// and take an explicit env object { document, matchMedia, storage }
// so they can be tested without a browser.
(function () {
  'use strict';

  var STORAGE_KEY = 'hcar_theme';
  var VALID_PREFERENCES = ['dark', 'light', 'auto'];
  var DEFAULT_PREFERENCE = 'dark';

  // Any unknown, missing, or mistyped value falls back to Dark, so
  // existing users see no change unless they choose otherwise.
  function normalizePreference(value) {
    if (typeof value !== 'string') return DEFAULT_PREFERENCE;
    var v = value.trim().toLowerCase();
    return VALID_PREFERENCES.indexOf(v) !== -1 ? v : DEFAULT_PREFERENCE;
  }

  // Resolve a stored preference to the theme that is actually shown.
  // Auto follows the device: dark when the device prefers dark, light
  // otherwise. An explicit Dark or Light always wins over the device.
  function resolveTheme(preference, prefersDark) {
    var pref = normalizePreference(preference);
    if (pref === 'auto') return prefersDark ? 'dark' : 'light';
    return pref;
  }

  function getStoredPreference(storage) {
    try {
      if (!storage) return DEFAULT_PREFERENCE;
      return normalizePreference(storage.getItem(STORAGE_KEY));
    } catch (e) {
      return DEFAULT_PREFERENCE;
    }
  }

  function prefersDarkMedia(env) {
    try {
      if (!env || !env.matchMedia) return false;
      return !!env.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch (e) {
      return false;
    }
  }

  // Apply a preference to a document. Returns the resolved theme
  // ('dark' or 'light') that was actually applied.
  // env: { document, matchMedia, storage }. Any part may be omitted.
  function applyTheme(preference, env) {
    var doc = (env && env.document) || (typeof document !== 'undefined' ? document : null);
    var storage = (env && env.storage) || (typeof localStorage !== 'undefined' ? localStorage : null);
    var mm = (env && env.matchMedia) || (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia.bind(window) : null);
    var pref = normalizePreference(preference);
    var resolved = resolveTheme(pref, prefersDarkMedia({ matchMedia: mm }));
    if (doc && doc.documentElement) {
      doc.documentElement.setAttribute('data-theme', resolved);
    }
    if (doc) {
      var meta = doc.querySelector ? doc.querySelector('meta[name="color-scheme"]') : null;
      if (meta && meta.setAttribute) meta.setAttribute('content', resolved);
    }
    try {
      if (storage) storage.setItem(STORAGE_KEY, pref);
    } catch (e) {
      // Storage unavailable (private mode). Theme still applies.
    }
    return resolved;
  }

  // Apply the stored preference (or Dark when nothing is stored).
  // This is what the inline <head> script does before first paint.
  function applyStoredTheme(env) {
    var storage = (env && env.storage) || (typeof localStorage !== 'undefined' ? localStorage : null);
    return applyTheme(getStoredPreference(storage), env);
  }

  // Watch the device setting while the preference is Auto, so the app
  // follows a device theme change without a reload. Returns a cleanup
  // function, or null when the environment cannot listen.
  function watchDeviceTheme(env, onChange) {
    try {
      var mm = (env && env.matchMedia) || (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia.bind(window) : null);
      if (!mm) return null;
      var query = mm('(prefers-color-scheme: dark)');
      if (!query || typeof query.addEventListener !== 'function') return null;
      var handler = function () {
        if (typeof onChange === 'function') onChange();
      };
      query.addEventListener('change', handler);
      return function () { query.removeEventListener('change', handler); };
    } catch (e) {
      return null;
    }
  }

  var api = {
    STORAGE_KEY: STORAGE_KEY,
    VALID_PREFERENCES: VALID_PREFERENCES,
    DEFAULT_PREFERENCE: DEFAULT_PREFERENCE,
    normalizePreference: normalizePreference,
    resolveTheme: resolveTheme,
    getStoredPreference: getStoredPreference,
    applyTheme: applyTheme,
    applyStoredTheme: applyStoredTheme,
    watchDeviceTheme: watchDeviceTheme
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.HCAR_Theme = api;
  }
})();
