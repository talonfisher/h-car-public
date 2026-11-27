// Tests for the light/dark theme toggle (public/theme.js).
// Covers preference normalization and resolution, applying the theme
// to a document stub, both themes defining the same CSS variables,
// text contrast in both themes, and no hard-coded dark palette color
// leaking outside the theme definitions in public/index.html.
// Run with: node test-theme.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const theme = require('./public/theme');

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log('ok - ' + name);
}

function fakeStorage(initial) {
  const data = Object.assign({}, initial || {});
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    _data: data
  };
}

function fakeDocument() {
  const attrs = {};
  const meta = { attrs: { content: 'dark' }, setAttribute(k, v) { this.attrs[k] = v; } };
  return {
    documentElement: { attrs, setAttribute(k, v) { attrs[k] = v; } },
    querySelector: () => meta,
    _attrs: attrs,
    _meta: meta
  };
}

function fakeMatchMedia(prefersDark) {
  return function () {
    return { matches: !!prefersDark, addEventListener: function () {}, removeEventListener: function () {} };
  };
}

// ---- Preference logic ----

async function run() {
  await check('normalizePreference accepts dark, light, auto', () => {
    assert.strictEqual(theme.normalizePreference('dark'), 'dark');
    assert.strictEqual(theme.normalizePreference('light'), 'light');
    assert.strictEqual(theme.normalizePreference('auto'), 'auto');
    assert.strictEqual(theme.normalizePreference(' Light '), 'light');
    assert.strictEqual(theme.normalizePreference('AUTO'), 'auto');
  });

  await check('normalizePreference falls back to dark for anything else', () => {
    assert.strictEqual(theme.normalizePreference('bogus'), 'dark');
    assert.strictEqual(theme.normalizePreference(''), 'dark');
    assert.strictEqual(theme.normalizePreference(null), 'dark');
    assert.strictEqual(theme.normalizePreference(undefined), 'dark');
    assert.strictEqual(theme.normalizePreference(42), 'dark');
  });

  await check('resolveTheme: explicit Dark or Light always wins', () => {
    assert.strictEqual(theme.resolveTheme('dark', true), 'dark');
    assert.strictEqual(theme.resolveTheme('dark', false), 'dark');
    assert.strictEqual(theme.resolveTheme('light', true), 'light');
    assert.strictEqual(theme.resolveTheme('light', false), 'light');
  });

  await check('resolveTheme: Auto follows the device', () => {
    assert.strictEqual(theme.resolveTheme('auto', true), 'dark');
    assert.strictEqual(theme.resolveTheme('auto', false), 'light');
  });

  await check('getStoredPreference reads localStorage and defaults to dark', () => {
    assert.strictEqual(theme.getStoredPreference(fakeStorage({ hcar_theme: 'light' })), 'light');
    assert.strictEqual(theme.getStoredPreference(fakeStorage({ hcar_theme: 'auto' })), 'auto');
    assert.strictEqual(theme.getStoredPreference(fakeStorage({})), 'dark');
    assert.strictEqual(theme.getStoredPreference(fakeStorage({ hcar_theme: 'purple' })), 'dark');
    assert.strictEqual(theme.getStoredPreference(null), 'dark');
  });

  await check('applyTheme sets data-theme, meta color-scheme, and stores the preference', () => {
    const doc = fakeDocument();
    const storage = fakeStorage();
    const resolved = theme.applyTheme('light', { document: doc, matchMedia: fakeMatchMedia(true), storage });
    assert.strictEqual(resolved, 'light');
    assert.strictEqual(doc._attrs['data-theme'], 'light');
    assert.strictEqual(doc._meta.attrs.content, 'light');
    assert.strictEqual(storage._data.hcar_theme, 'light');
  });

  await check('applyTheme with Auto resolves from the device setting', () => {
    const docDark = fakeDocument();
    assert.strictEqual(theme.applyTheme('auto', { document: docDark, matchMedia: fakeMatchMedia(true), storage: fakeStorage() }), 'dark');
    assert.strictEqual(docDark._attrs['data-theme'], 'dark');
    const docLight = fakeDocument();
    assert.strictEqual(theme.applyTheme('auto', { document: docLight, matchMedia: fakeMatchMedia(false), storage: fakeStorage() }), 'light');
    assert.strictEqual(docLight._attrs['data-theme'], 'light');
  });

  await check('applyTheme survives missing storage and missing matchMedia', () => {
    const doc = fakeDocument();
    const resolved = theme.applyTheme('light', { document: doc, matchMedia: null, storage: null });
    assert.strictEqual(resolved, 'light');
    assert.strictEqual(doc._attrs['data-theme'], 'light');
  });

  await check('applyStoredTheme applies the stored preference', () => {
    const doc = fakeDocument();
    const storage = fakeStorage({ hcar_theme: 'auto' });
    const resolved = theme.applyStoredTheme({ document: doc, matchMedia: fakeMatchMedia(false), storage });
    assert.strictEqual(resolved, 'light');
  });

  // ---- CSS variable coverage ----

  const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

  function extractRootBlock(html, light) {
    const pattern = light
      ? /:root\[data-theme="light"\]\{([\s\S]*?)\}/
      : /:root\{([\s\S]*?)\}/;
    const m = html.match(pattern);
    assert.ok(m, light ? 'light :root block missing' : 'dark :root block missing');
    return m[1];
  }

  function parseVars(block) {
    const vars = {};
    const re = /--([a-z0-9-]+)\s*:\s*([^;}]+)/g;
    let m;
    while ((m = re.exec(block)) !== null) vars['--' + m[1]] = m[2].trim();
    return vars;
  }

  const REQUIRED_VARS = [
    '--bg', '--bg2', '--surface', '--surface2', '--ink', '--muted', '--line',
    '--teal', '--teal2', '--teal-soft', '--teal-hover',
    '--amber', '--amber-bg', '--amber-ink',
    '--red', '--red-bg', '--red-ink',
    '--green', '--green-bg', '--green-ink',
    '--error-border', '--success-border',
    '--shadow', '--shadow-sm', '--accent-glow', '--radius',
    '--chart-ink', '--chart-muted', '--chart-teal', '--chart-amber',
    '--chart-red', '--chart-green', '--chart-track', '--chart-soft-teal',
    '--chart-soft-amber', '--chart-soft-red', '--chart-soft-green',
    '--chart-amber-ink', '--chart-red-ink', '--chart-red-soft'
  ];

  const darkVars = parseVars(extractRootBlock(indexHtml, false));
  const lightVars = parseVars(extractRootBlock(indexHtml, true));

  await check('dark theme defines every required variable', () => {
    for (const v of REQUIRED_VARS) assert.ok(darkVars[v], 'dark theme missing ' + v);
  });

  await check('light theme defines every required variable', () => {
    for (const v of REQUIRED_VARS) assert.ok(lightVars[v], 'light theme missing ' + v);
  });

  await check('light theme differs from dark theme (it is not a copy)', () => {
    const differing = REQUIRED_VARS.filter((v) => darkVars[v] !== lightVars[v]);
    assert.ok(differing.length >= 20, 'expected most variables to differ, only ' + differing.length + ' do');
    assert.strictEqual(darkVars['--bg'], '#0A0A1A');
    assert.strictEqual(lightVars['--bg'], '#F4F3EE');
    assert.strictEqual(lightVars['--teal'], '#0E7A68');
    assert.strictEqual(lightVars['--ink'], '#16211C');
  });

  // ---- Contrast (WCAG relative luminance) ----

  function luminance(hex) {
    const c = hex.replace('#', '');
    const rgb = [0, 2, 4].map((i) => parseInt(c.substr(i, 2), 16) / 255);
    const lin = rgb.map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  }

  function contrast(hexA, hexB) {
    const l1 = luminance(hexA);
    const l2 = luminance(hexB);
    const hi = Math.max(l1, l2);
    const lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }

  // Body text pairs must reach 4.5:1. Accent button text (large bold)
  // must reach 3:1.
  const TEXT_PAIRS = [
    ['ink on page', '--ink', '--bg', 4.5],
    ['ink on card', '--ink', '--surface', 4.5],
    ['muted on page', '--muted', '--bg', 4.5],
    ['muted on card', '--muted', '--surface', 4.5],
    ['link teal on card', '--teal2', '--surface', 4.5],
    ['amber ink on amber bg', '--amber-ink', '--amber-bg', 4.5],
    ['red ink on red bg', '--red-ink', '--red-bg', 4.5],
    ['green ink on green bg', '--green-ink', '--green-bg', 4.5],
    ['white button text on accent', '#FFFFFF', '--teal', 3.0]
  ];

  await check('dark theme text contrast meets WCAG', () => {
    for (const [name, fg, bg, min] of TEXT_PAIRS) {
      const ratio = contrast(fg.startsWith('#') ? fg : darkVars[fg], darkVars[bg]);
      assert.ok(ratio >= min, 'dark ' + name + ' is ' + ratio.toFixed(2) + ':1, needs ' + min + ':1');
    }
  });

  await check('light theme text contrast meets WCAG', () => {
    for (const [name, fg, bg, min] of TEXT_PAIRS) {
      const ratio = contrast(fg.startsWith('#') ? fg : lightVars[fg], lightVars[bg]);
      assert.ok(ratio >= min, 'light ' + name + ' is ' + ratio.toFixed(2) + ':1, needs ' + min + ':1');
    }
  });

  // ---- No hard-coded theme colors outside the :root blocks ----

  await check('no hard-coded dark palette color outside the theme definitions', () => {
    // Strip both :root blocks; what remains must not contain a dark
    // theme hex. White button text (#FFFFFF / #fff) and the danger
    // hover red (#8F1B12) are intentional in both themes and excluded.
    let stripped = indexHtml
      .replace(/:root\{[\s\S]*?\n\}/, '')
      .replace(/:root\[data-theme="light"\]\{[\s\S]*?\n\}/, '');
    const darkHexes = ['#0A0A1A', '#1A1A2E', '#12122A', '#22223A', '#2D2D4A',
      '#7C5CFF', '#9D7BFF', '#2A2350', '#6B4FE0', '#F59E0B', '#EF4444',
      '#10B981', '#0F2E22', '#2E2410', '#2E1512'];
    for (const hex of darkHexes) {
      assert.ok(!stripped.includes(hex), 'dark color ' + hex + ' still hard-coded outside :root');
    }
    const lightHexes = ['#F4F3EE', '#E9E7DE', '#F0EEE6', '#DCE0D9', '#0E7A68',
      '#0A5C4C', '#DDF0E9', '#9A6B12', '#B42318', '#137333', '#FEF3C7',
      '#FEF2F2', '#e6f4ea', '#713F12', '#7A271A', '#5C6B62', '#16211C'];
    for (const hex of lightHexes) {
      assert.ok(!stripped.includes(hex), 'light color ' + hex + ' still hard-coded outside :root');
    }
  });

  await check('index.html wires the theme toggle and the pre-paint script', () => {
    assert.ok(indexHtml.includes('src="/theme.js"'), 'theme.js not loaded');
    assert.ok(indexHtml.includes("localStorage.getItem('hcar_theme')"), 'pre-paint script missing');
    assert.ok(indexHtml.includes('id="theme-quick-toggle"'), 'header quick toggle missing');
    assert.ok(indexHtml.includes('id="appearance-card"'), 'Appearance card missing');
    assert.ok(indexHtml.includes("setThemePreference('dark')"), 'Dark option missing');
    assert.ok(indexHtml.includes("setThemePreference('light')"), 'Light option missing');
    assert.ok(indexHtml.includes("setThemePreference('auto')"), 'Auto option missing');
    assert.ok(indexHtml.includes('cycleTheme()'), 'quick toggle handler missing');
  });

  // ---- Standalone pages ----

  await check('privacy.html and reset-password.html follow the stored theme', () => {
    for (const file of ['public/privacy.html', 'public/reset-password.html']) {
      const html = fs.readFileSync(path.join(__dirname, file), 'utf8');
      assert.ok(html.includes(':root[data-theme="light"]'), file + ' has no light theme block');
      assert.ok(html.includes("localStorage.getItem('hcar_theme')"), file + ' has no pre-paint theme script');
      assert.ok(html.includes('data-theme'), file + ' never sets data-theme');
    }
  });

  // ---- Server settings field ----

  await check('server.js stores and returns themePreference', () => {
    const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    assert.ok(server.includes('theme_preference TEXT DEFAULT'), 'migration missing');
    assert.ok(server.includes("themePreference must be dark, light, or auto"), 'validation missing');
    assert.ok(server.includes('themePreference: user.theme_preference'), 'GET settings missing field');
    assert.ok(server.includes('themePreference: updated.theme_preference'), 'PUT settings missing field');
  });

  console.log('\n' + passed + ' theme checks passed');
}

run().catch((e) => {
  console.error('FAILED: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
