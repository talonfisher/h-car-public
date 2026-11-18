const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Client, Environment } = require('square');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const detector = require('./detector');
const googleHealth = require('./google-health');

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://*.squarecdn.com", "https://js.squareup.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://*.squarecdn.com"],
      connectSrc: ["'self'", "https://connect.squareup.com", "https://web.squarecdn.com", "https://pci-connect.squareup.com", "https://o160250.ingest.sentry.io"],
      frameSrc: ["'self'", "https://web.squarecdn.com", "https://js.squareup.com", "https://connect.squareup.com"],
      imgSrc: ["'self'", "data:", "https://*.squarecdn.com"],
      fontSrc: ["'self'", "https://*.squarecdn.com", "https://square-fonts-production-f.squarecdn.com", "https://d1g145x70srn7h.cloudfront.net"],
    }
  }
}));
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests, please try again later.'
});
app.use('/api/', limiter);

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Too many signup attempts, please try again later.'
});

// Capitalize each word in a name (e.g., "talon james fisher" -> "Talon James Fisher")
function capitalizeName(name) {
  return name
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

// Database - Neon Postgres (persistent, survives deploys)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('Unexpected pool error:', err);
});

// Create tables if they don't exist
async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      consent_given INTEGER DEFAULT 0,
      consent_date TEXT,
      square_customer_id TEXT,
      square_subscription_id TEXT,
      subscription_status TEXT DEFAULT 'inactive',
      subscription_period_end TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // Google Health API tokens (Fitbit data). Tokens are AES-256-GCM
    // encrypted before storage; see google-health.js.
    await client.query(`CREATE TABLE IF NOT EXISTS fitbit_tokens (
      user_id INTEGER PRIMARY KEY,
      access_token_enc TEXT,
      refresh_token_enc TEXT,
      expires_at BIGINT,
      connected_at TEXT,
      last_sync_at TEXT,
      last_sync_error TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    // One row per user per day of wearable summaries.
    await client.query(`CREATE TABLE IF NOT EXISTS daily_summaries (
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      rhr REAL,
      hrv REAL,
      spo2_avg REAL,
      spo2_min REAL,
      breathing_rate REAL,
      sleep_minutes REAL,
      sleep_efficiency REAL,
      skin_temp_delta REAL,
      deep_minutes REAL,
      rem_minutes REAL,
      signals_present INTEGER,
      PRIMARY KEY(user_id, date)
    )`);

    // Detector v2 output, one row per user per scored/baseline day.
    await client.query(`CREATE TABLE IF NOT EXISTS detector_results (
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      z_scores TEXT,
      composite REAL,
      n_off INTEGER,
      n_signals INTEGER,
      watch INTEGER DEFAULT 0,
      act INTEGER DEFAULT 0,
      in_baseline INTEGER DEFAULT 0,
      scored INTEGER DEFAULT 0,
      PRIMARY KEY(user_id, date)
    )`);

    // Merged episodes (episodes <= 14 days apart count as one for paging).
    await client.query(`CREATE TABLE IF NOT EXISTS episodes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      days INTEGER,
      is_act INTEGER DEFAULT 0,
      trigger_date TEXT,
      peak_composite REAL,
      top_signals TEXT,
      merged_parts INTEGER DEFAULT 1
    )`);

    // Current per-signal baselines (median centre + MAD sigma).
    await client.query(`CREATE TABLE IF NOT EXISTS baselines (
      user_id INTEGER NOT NULL,
      signal TEXT NOT NULL,
      centre REAL,
      sigma REAL,
      n INTEGER,
      updated_at TEXT,
      PRIMARY KEY(user_id, signal)
    )`);

    // Page visit counter. One row per visit (deduplicated by IP per hour).
    await client.query(`CREATE TABLE IF NOT EXISTS page_visits (
      id SERIAL PRIMARY KEY,
      visited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ip_address TEXT,
      user_agent TEXT
    )`);

    console.log('Database tables initialized');
  } finally {
    client.release();
  }
}

// Promise helpers for pg Pool.
async function dbGet(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows[0] || null;
}
async function dbAll(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}
async function dbRun(sql, params = []) {
  const result = await pool.query(sql, params);
  return { lastID: result.rows[0]?.id, changes: result.rowCount };
}

// Square client
const squareClient = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: Environment.Production,
});

const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID || 'L5A30BMAGNY4E';
const SQUARE_PLAN_VARIATION_ID = process.env.SQUARE_PLAN_VARIATION_ID || 'XU5OAQ4SZB4GA4DYN65KZYFD';
const SQUARE_APPLICATION_ID = process.env.SQUARE_APPLICATION_ID || 'sq0idp-AjjPPKKmlIAWk17Uf6sQvw';
const JWT_SECRET = process.env.JWT_SECRET || 'hcar-change-this-secret-in-production';

// Auth middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
}

// Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', app: 'H-CAR', version: '1.2.0', googleHealthConfigured: googleHealth.isConfigured(), database: 'postgres' });
});

// Page visitor counter (public, no auth required)
// POST /api/visit - Records a visit. Deduplicates by IP: only one visit
// per IP per hour is counted, so refreshes do not inflate the number.
app.post('/api/visit', async (req, res) => {
  try {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || '';
    // Only count if this IP has not visited in the last hour
    const recent = await dbGet(
      `SELECT id FROM page_visits
       WHERE ip_address = $1
       AND visited_at > NOW() - INTERVAL '1 hour'
       LIMIT 1`,
      [ip]
    );
    if (!recent) {
      await dbRun(
        'INSERT INTO page_visits (ip_address, user_agent) VALUES ($1, $2)',
        [ip, userAgent]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Visit record error:', err);
    // Do not fail the page load if the counter breaks
    res.json({ ok: false });
  }
});

// GET /api/visits/count - Returns the total visit count (public).
app.get('/api/visits/count', async (req, res) => {
  try {
    const row = await dbGet('SELECT COUNT(*) AS count FROM page_visits');
    res.json({ count: parseInt(row.count, 10) });
  } catch (err) {
    console.error('Visit count error:', err);
    res.status(500).json({ error: 'Failed to get visit count' });
  }
});

// Get Square config (public keys only)
app.get('/api/config', (req, res) => {
  res.json({
    squareApplicationId: SQUARE_APPLICATION_ID,
    squareLocationId: SQUARE_LOCATION_ID,
    price: 5.00,
    currency: 'CAD'
  });
});

// Signup
app.post('/api/signup', signupLimiter, async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  try {
    const capitalizedName = capitalizeName(name.trim());
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [capitalizedName, email.toLowerCase(), hash]
    );
    const userId = result.rows[0].id;
    const token = jwt.sign({ id: userId, email: email.toLowerCase() }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, userId, message: 'Account created' });
  } catch (err) {
    if (err.code === '23505' || (err.message && err.message.includes('duplicate'))) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Signup failed' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  try {
    const user = await dbGet('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        consentGiven: !!user.consent_given,
        subscriptionStatus: user.subscription_status
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Record consent (11 acknowledgments: the original 10 plus research use
// of de-identified data, added when the trial data collection shipped).
app.post('/api/consent', authenticateToken, async (req, res) => {
  const { acknowledgments } = req.body;
  if (!acknowledgments || !Array.isArray(acknowledgments) || acknowledgments.length !== 11 || !acknowledgments.every(a => a === true)) {
    return res.status(400).json({ error: 'All 11 acknowledgments must be checked' });
  }
  try {
    await dbRun(
      'UPDATE users SET consent_given = 1, consent_date = $1 WHERE id = $2',
      [new Date().toISOString(), req.user.id]
    );
    res.json({ message: 'Consent recorded' });
  } catch (err) {
    console.error('Consent error:', err);
    res.status(500).json({ error: 'Failed to record consent' });
  }
});

// Create subscription (Square checkout)
app.post('/api/subscribe', authenticateToken, async (req, res) => {
  const { sourceId } = req.body;
  if (!sourceId) {
    return res.status(400).json({ error: 'Payment source required' });
  }
  if (!process.env.SQUARE_ACCESS_TOKEN) {
    return res.status(500).json({ error: 'Square token not configured. Operator must set SQUARE_ACCESS_TOKEN.' });
  }
  try {
    const user = await dbGet('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.consent_given) return res.status(400).json({ error: 'Consent must be given before subscribing' });
    if (user.subscription_status === 'active' && user.square_subscription_id) {
      return res.json({ message: 'Already subscribed', subscriptionId: user.square_subscription_id });
    }
    let customerId = user.square_customer_id;
    // Create Square customer if needed
    if (!customerId) {
      const { result } = await squareClient.customersApi.createCustomer({
        givenName: user.name.split(' ')[0],
        familyName: user.name.split(' ').slice(1).join(' ') || '',
        emailAddress: user.email,
      });
      customerId = result.customer.id;
    }
    // Create subscription
    const idempotencyKey = `hcar-${user.id}-${Date.now()}`;
    const { result } = await squareClient.subscriptionsApi.createSubscription({
      locationId: SQUARE_LOCATION_ID,
      planVariationId: SQUARE_PLAN_VARIATION_ID,
      customerId: customerId,
      sourceId: sourceId,
      idempotencyKey: idempotencyKey,
    });
    const subscription = result.subscription;
    await dbRun(
      'UPDATE users SET square_customer_id = $1, square_subscription_id = $2, subscription_status = $3, subscription_period_end = $4 WHERE id = $5',
      [customerId, subscription.id, subscription.status.toLowerCase(), subscription.currentPeriodEnd || null, user.id]
    );
    res.json({
      message: 'Subscription created',
      subscriptionId: subscription.id,
      status: subscription.status
    });
  } catch (err) {
    console.error('Square error:', err);
    res.status(500).json({ error: 'Payment failed: ' + (err.message || 'Unknown error') });
  }
});

// Get user status
app.get('/api/me', authenticateToken, async (req, res) => {
  try {
    const user = await dbGet('SELECT id, name, email, consent_given, subscription_status, subscription_period_end, created_at FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      consentGiven: !!user.consent_given,
      subscriptionStatus: user.subscription_status,
      subscriptionPeriodEnd: user.subscription_period_end,
      createdAt: user.created_at
    });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// Cancel subscription
app.post('/api/cancel', authenticateToken, async (req, res) => {
  try {
    const user = await dbGet('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!user || !user.square_subscription_id) {
      return res.status(404).json({ error: 'No active subscription' });
    }
    await squareClient.subscriptionsApi.cancelSubscription(user.square_subscription_id);
    await dbRun(
      'UPDATE users SET subscription_status = $1 WHERE id = $2',
      ['canceled', user.id]
    );
    res.json({ message: 'Subscription canceled. Access continues until end of paid period.' });
  } catch (err) {
    console.error('Cancel error:', err);
    res.status(500).json({ error: 'Cancel failed: ' + err.message });
  }
});

// ---- Fitbit (Google Health API) integration ----

function dateStrUTC(d) {
  return d.toISOString().slice(0, 10);
}
function addDaysStr(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return dateStrUTC(new Date(Date.UTC(y, m - 1, d + n)));
}
function todayStr() {
  return dateStrUTC(new Date());
}

// Start the Google OAuth flow. Returns the consent URL; the frontend
// navigates there. State is a short-lived signed JWT binding the flow
// to the logged-in user.
app.get('/api/fitbit/connect', authenticateToken, (req, res) => {
  if (!googleHealth.isConfigured()) {
    return res.status(503).json({ error: 'Google Health is not configured yet. The operator must set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.' });
  }
  const state = jwt.sign(
    { userId: req.user.id, nonce: Math.random().toString(36).slice(2) },
    JWT_SECRET,
    { expiresIn: '10m' }
  );
  res.json({ url: googleHealth.getAuthUrl(state) });
});

// OAuth callback from Google. Exchanges the code, encrypts and stores
// the tokens, then redirects back to the app.
app.get('/api/fitbit/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const fail = (message) => res.redirect('/?fitbit=error&message=' + encodeURIComponent(message));
  if (error) return fail('Google sign-in failed: ' + error);
  if (!code || !state) return fail('Missing code or state from Google.');
  let payload;
  try {
    payload = jwt.verify(state, JWT_SECRET);
  } catch (e) {
    return fail('The connection request expired. Please try again.');
  }
  try {
    const tokens = await googleHealth.exchangeCode(code);
    if (!tokens.refresh_token) {
      return fail('Google did not return a refresh token. Please disconnect H-CAR in your Google account settings and try again.');
    }
    await dbRun(
      `INSERT INTO fitbit_tokens (user_id, access_token_enc, refresh_token_enc, expires_at, connected_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT(user_id) DO UPDATE SET
         access_token_enc = EXCLUDED.access_token_enc,
         refresh_token_enc = EXCLUDED.refresh_token_enc,
         expires_at = EXCLUDED.expires_at,
         connected_at = EXCLUDED.connected_at,
         last_sync_error = NULL`,
      [
        payload.userId,
        googleHealth.encryptToken(tokens.access_token),
        googleHealth.encryptToken(tokens.refresh_token),
        tokens.expiry_date || Date.now() + 3600000,
        new Date().toISOString(),
      ]
    );
    res.redirect('/?fitbit=connected');
  } catch (e) {
    console.error('Fitbit callback error:', e.message);
    return fail('Could not complete the Fitbit connection. Please try again.');
  }
});

app.get('/api/fitbit/status', authenticateToken, async (req, res) => {
  try {
    const row = await dbGet('SELECT connected_at, last_sync_at, last_sync_error FROM fitbit_tokens WHERE user_id = $1', [req.user.id]);
    res.json({
      connected: !!row,
      connectedAt: row ? row.connected_at : null,
      lastSyncAt: row ? row.last_sync_at : null,
      lastSyncError: row ? row.last_sync_error : null,
      googleConfigured: googleHealth.isConfigured(),
    });
  } catch (err) {
    console.error('Fitbit status error:', err);
    res.status(500).json({ error: 'Failed to get Fitbit status' });
  }
});

app.post('/api/fitbit/disconnect', authenticateToken, async (req, res) => {
  try {
    const row = await dbGet('SELECT access_token_enc FROM fitbit_tokens WHERE user_id = $1', [req.user.id]);
    await dbRun('DELETE FROM fitbit_tokens WHERE user_id = $1', [req.user.id]);
    // Best-effort revoke at Google; ignore failures (token may be expired).
    if (row) {
      try {
        const token = googleHealth.decryptToken(row.access_token_enc);
        await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(token), { method: 'POST' });
      } catch (e) { /* ignore */ }
    }
    res.json({ message: 'Fitbit disconnected. Your stored summaries and detector history are kept; delete your account to remove them.' });
  } catch (err) {
    console.error('Fitbit disconnect error:', err);
    res.status(500).json({ error: 'Failed to disconnect Fitbit' });
  }
});

// Load a valid access token for a user, refreshing when needed.
// Throws { code: 'RECONNECT_REQUIRED' } when the refresh token is dead.
async function getValidAccessToken(userId) {
  const row = await dbGet('SELECT * FROM fitbit_tokens WHERE user_id = $1', [userId]);
  if (!row) {
    const err = new Error('Fitbit is not connected');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  if (row.expires_at && row.expires_at - Date.now() > 5 * 60 * 1000) {
    return googleHealth.decryptToken(row.access_token_enc);
  }
  try {
    const refreshToken = googleHealth.decryptToken(row.refresh_token_enc);
    const creds = await googleHealth.refreshAccessToken(refreshToken);
    const updates = [googleHealth.encryptToken(creds.access_token), creds.expiry_date || Date.now() + 3600000];
    let sql = 'UPDATE fitbit_tokens SET access_token_enc = $1, expires_at = $2';
    let paramIndex = 3;
    if (creds.refresh_token) {
      sql += `, refresh_token_enc = $${paramIndex}`;
      updates.push(googleHealth.encryptToken(creds.refresh_token));
      paramIndex++;
    }
    sql += ` WHERE user_id = $${paramIndex}`;
    updates.push(userId);
    await dbRun(sql, updates);
    return creds.access_token;
  } catch (e) {
    await dbRun('UPDATE fitbit_tokens SET last_sync_error = $1 WHERE user_id = $2', ['Token refresh failed: ' + e.message, userId]);
    const err = new Error('Fitbit connection expired. Please reconnect your Fitbit.');
    err.code = 'RECONNECT_REQUIRED';
    throw err;
  }
}

// Map a daily_summaries row to detector signal values.
function rowToDetectorVals(row) {
  const vals = {};
  if (row.rhr !== null && row.rhr !== undefined) vals.resting_hr = row.rhr;
  if (row.hrv !== null && row.hrv !== undefined) vals.rmssd = row.hrv;
  if (row.spo2_avg !== null && row.spo2_avg !== undefined) vals.spo2 = row.spo2_avg;
  if (row.skin_temp_delta !== null && row.skin_temp_delta !== undefined) vals.nightly_temperature = row.skin_temp_delta;
  if (row.sleep_minutes !== null && row.sleep_minutes !== undefined) vals.sleep_duration_h = row.sleep_minutes / 60;
  if (row.breathing_rate !== null && row.breathing_rate !== undefined) vals.full_sleep_breathing_rate = row.breathing_rate;
  return vals;
}

// Re-run detector v2 over all of a user's days and store the results.
// The detector is deterministic, so a full re-run after each sync is
// correct and keeps baselines, episodes and flags consistent.
async function runDetectorForUser(userId) {
  const rows = await dbAll('SELECT * FROM daily_summaries WHERE user_id = $1 ORDER BY date ASC', [userId]);
  const dayRows = rows.map((r) => ({ date: r.date, vals: rowToDetectorVals(r) }));
  const result = detector.runPerson(dayRows);

  await dbRun('DELETE FROM detector_results WHERE user_id = $1', [userId]);
  await dbRun('DELETE FROM episodes WHERE user_id = $1', [userId]);
  await dbRun('DELETE FROM baselines WHERE user_id = $1', [userId]);

  const actTriggerDates = new Set(result.episodes.filter((e) => e.is_act && e.trigger_date).map((e) => e.trigger_date));
  for (const d of result.dayResults) {
    await dbRun(
      `INSERT INTO detector_results (user_id, date, z_scores, composite, n_off, n_signals, watch, act, in_baseline, scored)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        userId, d.date, JSON.stringify(d.zs), d.composite, d.nOff, d.nSignals,
        d.watch ? 1 : 0, actTriggerDates.has(d.date) ? 1 : 0,
        d.inBaseline ? 1 : 0, d.scored ? 1 : 0,
      ]
    );
  }
  for (const e of result.mergedEpisodes) {
    await dbRun(
      `INSERT INTO episodes (user_id, start_date, end_date, days, is_act, trigger_date, peak_composite, top_signals, merged_parts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [userId, e.start, e.end, e.days, e.is_act ? 1 : 0, e.trigger_date, e.peak_composite, JSON.stringify(e.top_signals), e.merged_parts || 1]
    );
  }
  for (const [signal, b] of Object.entries(result.baseline)) {
    await dbRun(
      `INSERT INTO baselines (user_id, signal, centre, sigma, n, updated_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, signal, b.centre, b.sigma, b.n, new Date().toISOString()]
    );
  }
  return result;
}

// Sync one user's wearable data from Google Health, then re-run the
// detector. Returns a summary of what changed.
async function syncUser(userId, daysBack = 35) {
  const accessToken = await getValidAccessToken(userId);
  const lastRow = await dbGet('SELECT MAX(date) AS max_date FROM daily_summaries WHERE user_id = $1', [userId]);
  const endDate = addDaysStr(todayStr(), 1); // exclusive end
  let startDate;
  if (lastRow && lastRow.max_date) {
    // Overlap 3 days to catch late-arriving or corrected data.
    startDate = addDaysStr(lastRow.max_date, -3);
  } else {
    startDate = addDaysStr(todayStr(), -daysBack);
  }
  // Bound a single sync to 60 days.
  if (addDaysStr(startDate, 60) < endDate) startDate = addDaysStr(endDate, -60);

  const { days, errors } = await googleHealth.fetchDailySummaries(accessToken, startDate, endDate);
  let upserted = 0;
  for (const [date, s] of Object.entries(days)) {
    const signalsPresent = [s.rhr, s.hrv, s.spo2_avg, s.breathing_rate, s.sleep_minutes, s.skin_temp_delta]
      .filter((v) => v !== null && v !== undefined).length;
    if (signalsPresent === 0) continue;
    await dbRun(
      `INSERT INTO daily_summaries
         (user_id, date, rhr, hrv, spo2_avg, spo2_min, breathing_rate, sleep_minutes, sleep_efficiency, skin_temp_delta, deep_minutes, rem_minutes, signals_present)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT(user_id, date) DO UPDATE SET
         rhr = COALESCE(EXCLUDED.rhr, daily_summaries.rhr),
         hrv = COALESCE(EXCLUDED.hrv, daily_summaries.hrv),
         spo2_avg = COALESCE(EXCLUDED.spo2_avg, daily_summaries.spo2_avg),
         spo2_min = COALESCE(EXCLUDED.spo2_min, daily_summaries.spo2_min),
         breathing_rate = COALESCE(EXCLUDED.breathing_rate, daily_summaries.breathing_rate),
         sleep_minutes = COALESCE(EXCLUDED.sleep_minutes, daily_summaries.sleep_minutes),
         sleep_efficiency = COALESCE(EXCLUDED.sleep_efficiency, daily_summaries.sleep_efficiency),
         skin_temp_delta = COALESCE(EXCLUDED.skin_temp_delta, daily_summaries.skin_temp_delta),
         deep_minutes = COALESCE(EXCLUDED.deep_minutes, daily_summaries.deep_minutes),
         rem_minutes = COALESCE(EXCLUDED.rem_minutes, daily_summaries.rem_minutes),
         signals_present = EXCLUDED.signals_present`,
      [userId, date, s.rhr, s.hrv, s.spo2_avg, s.spo2_min, s.breathing_rate, s.sleep_minutes, s.sleep_efficiency, s.skin_temp_delta, s.deep_minutes, s.rem_minutes, signalsPresent]
    );
    upserted += 1;
  }

  const det = await runDetectorForUser(userId);
  const syncError = errors.length > 0 ? errors.join('; ') : null;
  await dbRun('UPDATE fitbit_tokens SET last_sync_at = $1, last_sync_error = $2 WHERE user_id = $3',
    [new Date().toISOString(), syncError, userId]);

  return {
    daysFetched: Object.keys(days).length,
    daysStored: upserted,
    range: { start: startDate, end: addDaysStr(endDate, -1) },
    baselineDays: det.baselineDays,
    baselineComplete: det.baselineDays >= detector.BASELINE_DAYS,
    episodes: det.mergedEpisodes.length,
    actEpisodes: det.mergedEpisodes.filter((e) => e.is_act).length,
    fetchErrors: errors,
  };
}

app.post('/api/fitbit/sync', authenticateToken, async (req, res) => {
  try {
    const summary = await syncUser(req.user.id);
    res.json({ message: 'Sync complete', ...summary });
  } catch (e) {
    if (e.code === 'NOT_CONNECTED') return res.status(400).json({ error: e.message, code: e.code });
    if (e.code === 'RECONNECT_REQUIRED') return res.status(401).json({ error: e.message, code: e.code });
    console.error('Sync error:', e);
    res.status(500).json({ error: 'Sync failed: ' + e.message });
  }
});

// Detector status for the dashboard: baseline progress, current status,
// baselines, and recent flags.
app.get('/api/detector/status', authenticateToken, async (req, res) => {
  try {
    const tokenRow = await dbGet('SELECT last_sync_at FROM fitbit_tokens WHERE user_id = $1', [req.user.id]);
    const range = await dbGet('SELECT MIN(date) AS first_date, MAX(date) AS last_date, COUNT(*) AS n_days FROM daily_summaries WHERE user_id = $1', [req.user.id]);
    const baselines = await dbAll('SELECT signal, centre, sigma, n FROM baselines WHERE user_id = $1', [req.user.id]);
    const episodes = await dbAll('SELECT * FROM episodes WHERE user_id = $1 ORDER BY start_date DESC LIMIT 5', [req.user.id]);
    const latest = await dbGet('SELECT * FROM detector_results WHERE user_id = $1 ORDER BY date DESC LIMIT 1', [req.user.id]);

    if (!range || !range.first_date) {
      return res.json({
        connected: !!tokenRow,
        lastSyncAt: tokenRow ? tokenRow.last_sync_at : null,
        baselineDay: 0,
        baselineDays: 0,
        baselineComplete: false,
        status: tokenRow ? 'learning' : 'not_connected',
        baselines: [],
        recentFlags: [],
        daysSynced: 0,
      });
    }

    const firstOrd = detector.dayOrdinal(range.first_date);
    const lastOrd = detector.dayOrdinal(range.last_date);
    const spanDays = lastOrd - firstOrd + 1;
    const baselineComplete = spanDays > detector.BASELINE_DAYS;
    const baselineDay = Math.min(spanDays, detector.BASELINE_DAYS);

    let status = baselineComplete ? 'monitoring' : 'learning';
    if (latest && latest.watch) {
      const inAct = episodes.some((e) => e.is_act && latest.date >= e.start_date && latest.date <= e.end_date);
      status = inAct ? 'act_active' : 'watch_active';
    }

    res.json({
      connected: !!tokenRow,
      lastSyncAt: tokenRow ? tokenRow.last_sync_at : null,
      firstDate: range.first_date,
      lastDate: range.last_date,
      daysSynced: parseInt(range.n_days, 10),
      baselineDay,
      baselineDays: baselineDay,
      baselineComplete,
      status,
      baselines,
      recentFlags: episodes.map((e) => ({
        startDate: e.start_date,
        endDate: e.end_date,
        days: e.days,
        isAct: !!e.is_act,
        triggerDate: e.trigger_date,
        peakComposite: e.peak_composite,
        topSignals: e.top_signals ? JSON.parse(e.top_signals) : [],
      })),
    });
  } catch (err) {
    console.error('Detector status error:', err);
    res.status(500).json({ error: 'Failed to get detector status' });
  }
});

// Recent daily summaries joined with detector results (most recent first).
app.get('/api/days', authenticateToken, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 120);
    const rows = await dbAll(
      `SELECT s.*, r.composite, r.n_off, r.n_signals, r.watch, r.act, r.in_baseline, r.scored, r.z_scores
       FROM daily_summaries s
       LEFT JOIN detector_results r ON r.user_id = s.user_id AND r.date = s.date
       WHERE s.user_id = $1
       ORDER BY s.date DESC LIMIT $2`,
      [req.user.id, limit]
    );
    res.json({
      days: rows.map((r) => ({
        date: r.date,
        rhr: r.rhr,
        hrv: r.hrv,
        spo2Avg: r.spo2_avg,
        spo2Min: r.spo2_min,
        breathingRate: r.breathing_rate,
        sleepMinutes: r.sleep_minutes,
        sleepEfficiency: r.sleep_efficiency,
        skinTempDelta: r.skin_temp_delta,
        signalsPresent: r.signals_present,
        composite: r.composite,
        nOff: r.n_off,
        nSignals: r.n_signals,
        watch: !!r.watch,
        act: !!r.act,
        inBaseline: !!r.in_baseline,
        scored: !!r.scored,
        zScores: r.z_scores ? JSON.parse(r.z_scores) : {},
      })),
    });
  } catch (err) {
    console.error('Days error:', err);
    res.status(500).json({ error: 'Failed to get days' });
  }
});

// ---- Operator endpoints (admin key) ----
// Used by the daily sync cron (Render Cron Job or an external scheduler).
// Header: x-admin-key: <ADMIN_SYNC_KEY>. Disabled when the env var is unset.

function requireAdminKey(req, res, next) {
  const key = process.env.ADMIN_SYNC_KEY;
  if (!key) return res.status(503).json({ error: 'Admin endpoints are disabled (ADMIN_SYNC_KEY not set).' });
  if (req.headers['x-admin-key'] !== key) return res.status(403).json({ error: 'Forbidden' });
  next();
}

app.post('/api/admin/sync-all', requireAdminKey, async (req, res) => {
  try {
    const users = await dbAll('SELECT user_id FROM fitbit_tokens');
    const results = [];
    for (const u of users) {
      try {
        const summary = await syncUser(u.user_id);
        results.push({ userId: u.user_id, ok: true, ...summary });
      } catch (e) {
        results.push({ userId: u.user_id, ok: false, error: e.message, code: e.code || null });
      }
    }
    res.json({ synced: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results });
  } catch (err) {
    console.error('Sync-all error:', err);
    res.status(500).json({ error: 'Sync-all failed' });
  }
});

// Trial overview for the operator. Per-user rows carry user IDs only,
// never names or emails, and no raw health values.
app.get('/api/admin/trial-summary', requireAdminKey, async (req, res) => {
  try {
    const totals = await dbGet(
      `SELECT
         (SELECT COUNT(*) FROM users) AS total_users,
         (SELECT COUNT(*) FROM users WHERE consent_given = 1) AS consented_users,
         (SELECT COUNT(*) FROM users WHERE subscription_status = 'active') AS paying_users,
         (SELECT COUNT(*) FROM fitbit_tokens) AS fitbit_connected,
         (SELECT COUNT(*) FROM episodes) AS total_episodes,
         (SELECT COUNT(*) FROM episodes WHERE is_act = 1) AS total_act_episodes`
    );
    const perUser = await dbAll(
      `SELECT u.id AS user_id,
              (SELECT COUNT(*) FROM daily_summaries d WHERE d.user_id = u.id) AS days_synced,
              (SELECT MIN(date) FROM daily_summaries d WHERE d.user_id = u.id) AS first_date,
              (SELECT MAX(date) FROM daily_summaries d WHERE d.user_id = u.id) AS last_date,
              (SELECT COUNT(*) FROM episodes e WHERE e.user_id = u.id) AS episodes,
              (SELECT COUNT(*) FROM episodes e WHERE e.user_id = u.id AND e.is_act = 1) AS act_episodes,
              CASE WHEN EXISTS (SELECT 1 FROM fitbit_tokens f WHERE f.user_id = u.id) THEN 1 ELSE 0 END AS fitbit_connected
       FROM users u ORDER BY u.id`
    );
    // Convert counts from strings to numbers (pg returns COUNT as string)
    const totalsNum = {
      total_users: parseInt(totals.total_users, 10),
      consented_users: parseInt(totals.consented_users, 10),
      paying_users: parseInt(totals.paying_users, 10),
      fitbit_connected: parseInt(totals.fitbit_connected, 10),
      total_episodes: parseInt(totals.total_episodes, 10),
      total_act_episodes: parseInt(totals.total_act_episodes, 10),
    };
    const perUserNum = perUser.map((u) => ({
      user_id: u.user_id,
      days_synced: parseInt(u.days_synced, 10),
      first_date: u.first_date,
      last_date: u.last_date,
      episodes: parseInt(u.episodes, 10),
      act_episodes: parseInt(u.act_episodes, 10),
      fitbit_connected: parseInt(u.fitbit_connected, 10),
    }));
    res.json({ totals: totalsNum, users: perUserNum });
  } catch (err) {
    console.error('Trial summary error:', err);
    res.status(500).json({ error: 'Failed to get trial summary' });
  }
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize database then start server
initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`H-CAR server running on port ${PORT} (Postgres)`);
  });
}).catch((err) => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
