const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Client, Environment } = require('square');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const detector = require('./detector');
const cycle = require('./cycle');
const context = require('./context');
const googleHealth = require('./google-health');
const garminHealth = require('./garmin-health');
const alertEngine = require('./alert-engine');
const axios = require('axios');

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
app.use(express.urlencoded({ extended: false }));
app.use(express.static('public'));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: 'Too many requests, please try again in a moment.',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  }
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

    // Emergency contact fields (added after launch, so ALTER in case
    // the table already exists in production).
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_contact_name TEXT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_contact_email TEXT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_contact_phone TEXT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_contact_relationship TEXT`);

    // Secondary emergency contact. If the primary contact does not
    // acknowledge an Act alert within 15 minutes, H-CAR escalates to
    // this person by SMS and email.
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS secondary_contact_name TEXT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS secondary_contact_email TEXT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS secondary_contact_phone TEXT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS secondary_contact_relationship TEXT`);

    // Sensitivity setting (gentle, balanced, sensitive). Default balanced.
    // Gentle requires 4 signals for Watch (fewer alerts). Sensitive requires 2 signals (more alerts).
    // Balanced requires 3 signals (the tested default).
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS sensitivity TEXT DEFAULT 'balanced'`);

    // Biological sex, optional and private. Used only to adjust the
    // detector for cycle-related changes in female users (see cycle.js).
    // Values: 'male', 'female', 'prefer_not_to_say', or NULL (not set).
    // It is never shown to other users and never used for anything else.
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS biological_sex TEXT`);

    // Menopause status, optional and private. Values: 'pre', 'peri',
    // 'post', or NULL (not set). Used only to widen the temperature
    // sigma floor for perimenopausal users (see context.js).
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS menopause_status TEXT`);

    // Automatic elevation detection, opt-in and off by default. When
    // enabled, the app looks up ground elevation from the phone
    // location on the device. Only the elevation in metres is stored
    // (in daily_summaries.altitude_m). Coordinates are never stored.
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS auto_elevation BOOLEAN DEFAULT FALSE`);

    // Theme preference: 'dark', 'light', or 'auto' (follow the device).
    // Dark is the default, so existing users see no change unless they
    // choose otherwise. Stored here so it follows the user across
    // devices; localStorage holds the same value for instant load.
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_preference TEXT DEFAULT 'dark'`);

    // Emergency-only location sharing. When enabled, H-CAR captures the
    // user's location when they sync their Fitbit, and includes their last
    // known location in Act alert emails to their emergency contact.
    // Location is NEVER shared otherwise, and NEVER tracked continuously.
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS location_sharing_enabled BOOLEAN DEFAULT FALSE`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_location_lat DOUBLE PRECISION`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_location_lng DOUBLE PRECISION`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_location_address TEXT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_location_updated TIMESTAMP`);

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

    // Garmin Health API tokens. Tokens are AES-256-GCM encrypted before
    // storage; see garmin-health.js. Garmin uses OAuth 2.0 with PKCE.
    // The garmin_user_id is Garmin's internal user ID, used to match
    // webhook push notifications to H-CAR users.
    await client.query(`CREATE TABLE IF NOT EXISTS garmin_tokens (
      user_id INTEGER PRIMARY KEY,
      garmin_user_id TEXT,
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

    // Elevation in metres for that day, when the user provides it.
    // Above 1500 m, blood oxygen runs lower and the detector corrects
    // for it (see context.js). Added after launch, so ALTER in case
    // the table already exists in production.
    await client.query(`ALTER TABLE daily_summaries ADD COLUMN IF NOT EXISTS altitude_m REAL`);

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

    // Cycle phase recorded for each scored day ('follicular', 'luteal',
    // or NULL when unknown). Lets users see why a flag was or was not
    // raised on a given day. Added after launch, so ALTER in case the
    // table already exists in production.
    await client.query(`ALTER TABLE detector_results ADD COLUMN IF NOT EXISTS cycle_phase TEXT`);

    // Full health context recorded for each day as JSON: cycle phase,
    // pregnancy status and week, altitude in metres, whether a
    // medication was started recently, and menopause status. Lets users
    // see why a flag was or was not raised on a given day.
    await client.query(`ALTER TABLE detector_results ADD COLUMN IF NOT EXISTS context_json TEXT`);

    // Menstrual cycle start dates, logged by the user. Private to the
    // user, used only to estimate cycle phase for baseline adjustment
    // (see cycle.js). Never shared, never sold, never used for ads.
    // end_date is optional; a cycle with no end date is treated as
    // ongoing until the next cycle start is logged.
    await client.query(`CREATE TABLE IF NOT EXISTS menstrual_cycles (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      start_date DATE NOT NULL,
      end_date DATE,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, start_date)
    )`);

    // Pregnancies, logged by the user. Private to the user, used only
    // to adjust the expected resting heart rate rise during pregnancy
    // (see context.js). Never shared, never sold, never used for ads.
    // start_date is the estimated conception date or first positive
    // test. due_date is the estimated due date. end_date is set when
    // the pregnancy ends. status is 'active', 'completed', or 'ended'.
    await client.query(`CREATE TABLE IF NOT EXISTS pregnancies (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      start_date DATE NOT NULL,
      due_date DATE,
      end_date DATE,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Medications, logged by the user. Private to the user. A medication
    // started within the last 14 days is noted as context on detector
    // results only; no effect is predicted (see context.js). Never
    // shared, never sold, never used for ads.
    await client.query(`CREATE TABLE IF NOT EXISTS medications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE,
      dosage TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

    // Emergency contact alerts already sent. One row per (user, Act
    // trigger date). The detector re-runs from scratch on every sync
    // and re-creates all episodes, so this table is what stops the
    // same Act episode from alerting the contact over and over.
    await client.query(`CREATE TABLE IF NOT EXISTS alerts_sent (
      user_id INTEGER NOT NULL,
      trigger_date TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      recipient_email TEXT,
      status TEXT,
      PRIMARY KEY(user_id, trigger_date)
    )`);

    // Life-saving alert records. One row per Act episode (or test alert).
    // Status flow:
    //   awaiting_user: Act fired, user has 5 min to answer "Are you okay?"
    //   alerting: primary contact notified, waiting for acknowledgment
    //   escalated: secondary contact notified (no ack in 15 min)
    //   acknowledged: a contact confirmed receipt
    //   cancelled_by_user: user said "I'm fine" within the 5 min window
    //   unacknowledged: no ack in 30 min, a human must call emergency services
    // H-CAR never calls 911 automatically.
    await client.query(`CREATE TABLE IF NOT EXISTS alerts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      trigger_date TEXT NOT NULL,
      episode_start TEXT,
      episode_end TEXT,
      episode_days INTEGER,
      top_signals TEXT,
      vitals_summary TEXT,
      status TEXT NOT NULL DEFAULT 'awaiting_user',
      ack_token TEXT UNIQUE NOT NULL,
      is_test INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      user_response TEXT,
      user_responded_at TIMESTAMP,
      primary_alerted_at TIMESTAMP,
      secondary_alerted_at TIMESTAMP,
      acknowledged_at TIMESTAMP,
      acknowledged_by TEXT,
      escalated_at TIMESTAMP,
      resolved_at TIMESTAMP,
      UNIQUE(user_id, trigger_date)
    )`);

    // Every outbound alert step, for the audit trail and the alert history view.
    await client.query(`CREATE TABLE IF NOT EXISTS alert_escalations (
      id SERIAL PRIMARY KEY,
      alert_id INTEGER NOT NULL REFERENCES alerts(id),
      level TEXT NOT NULL,
      channel TEXT NOT NULL,
      recipient TEXT,
      sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      result TEXT
    )`);

    // Web push subscriptions, one row per browser or device.
    await client.query(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      endpoint TEXT NOT NULL,
      p256dh TEXT,
      auth TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, endpoint)
    )`);

    // Symptom logs. One row per user per day. Symptoms are stored as
    // a comma-separated string (e.g., "Tired / poor sleep,Dizzy").
    await client.query(`CREATE TABLE IF NOT EXISTS symptom_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      logged_date TEXT NOT NULL,
      symptoms TEXT,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, logged_date)
    )`);

    // Morning sleep check-ins. One per user per day (upsert on conflict).
    // Q1 rested 1-5, Q2 body 1-5, Q3 sore 0-3, Q4 yesterday factors comma-separated.
    await client.query(`CREATE TABLE IF NOT EXISTS sleep_checkins (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      checkin_date DATE NOT NULL,
      rested INTEGER NOT NULL,
      body INTEGER NOT NULL,
      sore INTEGER NOT NULL,
      yesterday_factors TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, checkin_date)
    )`);

    // Password reset tokens. Single-use, expire after 1 hour.
    // A token is created when a user requests a password reset and
    // is marked used after the password is changed.
    await client.query(`CREATE TABLE IF NOT EXISTS password_resets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      used BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    // Family connections. Lets users share their status (not detailed
    // health data) with family members. user_id is the person sharing
    // their status, family_member_id is the person viewing it.
    // Status: pending, accepted, declined.
    await client.query(`CREATE TABLE IF NOT EXISTS family_connections (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      family_member_id INTEGER NOT NULL,
      relationship TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, family_member_id),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(family_member_id) REFERENCES users(id)
    )`);

    // Location history (for debugging). Keeps only the last 10 locations
    // per user. Location is captured only when user syncs Fitbit AND has
    // opted into emergency-only location sharing.
    await client.query(`CREATE TABLE IF NOT EXISTS location_history (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      lat DOUBLE PRECISION NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      address TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Promo codes for free passes (friends and family). Each code can be
    // used max_uses times (default 1). When redeemed, the user gets
    // subscription_status = 'complimentary' instead of paying via Square.
    // pass_type: 'family', 'friend', or 'trial'. Trial codes have a
    // duration_days (e.g., 118 for the full trial period) and the user's
    // subscription expires after that many days from redemption.
    await client.query(`CREATE TABLE IF NOT EXISTS promo_codes (
      code TEXT PRIMARY KEY,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      used_by INTEGER REFERENCES users(id),
      used_at TIMESTAMP,
      max_uses INTEGER DEFAULT 1,
      uses_count INTEGER DEFAULT 0,
      pass_type TEXT DEFAULT 'family',
      duration_days INTEGER,
      expires_at TIMESTAMP
    )`);

    // Add new columns if the table already exists (migration for existing DBs).
    await client.query(`ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS pass_type TEXT DEFAULT 'family'`);
    await client.query(`ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS duration_days INTEGER`);
    await client.query(`ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP`);

    // Track which promo code a user redeemed (if any).
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS promo_code_used TEXT`);
    // Subscription expiration for trial passes. NULL means no expiration.
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMP`);

    // Seed initial promo codes for Talon (user ID 1) if they don't exist.
    const seedCodes = [
      { code: 'FAMILY-2026-A1B2', pass_type: 'family', duration_days: null },
      { code: 'FAMILY-2026-C3D4', pass_type: 'family', duration_days: null },
      { code: 'FAMILY-2026-E5F6', pass_type: 'family', duration_days: null },
      { code: 'FRIEND-2026-G7H8', pass_type: 'friend', duration_days: null },
      { code: 'FRIEND-2026-I9J0', pass_type: 'friend', duration_days: null },
    ];
    for (const seed of seedCodes) {
      await client.query(
        `INSERT INTO promo_codes (code, created_by, max_uses, pass_type, duration_days) VALUES ($1, 1, 1, $2, $3) ON CONFLICT (code) DO NOTHING`,
        [seed.code, seed.pass_type, seed.duration_days]
      );
    }

    // Seed 50 trial guest passes for Meniere's groups. Each is good for
    // 118 days (28-day baseline + 90 days live monitoring) from redemption.
    const trialCodes = [
      'TRIAL-2026-23WH', 'TRIAL-2026-259J', 'TRIAL-2026-2AB8', 'TRIAL-2026-2ADJ',
      'TRIAL-2026-39D7', 'TRIAL-2026-4QQ3', 'TRIAL-2026-4S68', 'TRIAL-2026-668L',
      'TRIAL-2026-6ZDT', 'TRIAL-2026-7E9M', 'TRIAL-2026-8AXE', 'TRIAL-2026-8DLW',
      'TRIAL-2026-8J6K', 'TRIAL-2026-8PBS', 'TRIAL-2026-8VWW', 'TRIAL-2026-9TER',
      'TRIAL-2026-9VUU', 'TRIAL-2026-9XVP', 'TRIAL-2026-ARGE', 'TRIAL-2026-BFG7',
      'TRIAL-2026-CD8Z', 'TRIAL-2026-CDM6', 'TRIAL-2026-D9DV', 'TRIAL-2026-DAQQ',
      'TRIAL-2026-DMUB', 'TRIAL-2026-DU2Q', 'TRIAL-2026-EUSB', 'TRIAL-2026-F56Q',
      'TRIAL-2026-J8X2', 'TRIAL-2026-KH9C', 'TRIAL-2026-LF2B', 'TRIAL-2026-LXNR',
      'TRIAL-2026-M43D', 'TRIAL-2026-M874', 'TRIAL-2026-MGW8', 'TRIAL-2026-N7DQ',
      'TRIAL-2026-P6DG', 'TRIAL-2026-Q59L', 'TRIAL-2026-R67J', 'TRIAL-2026-R9P9',
      'TRIAL-2026-RA5Q', 'TRIAL-2026-RR62', 'TRIAL-2026-RWU2', 'TRIAL-2026-SLUN',
      'TRIAL-2026-UCZX', 'TRIAL-2026-UD59', 'TRIAL-2026-VCQY', 'TRIAL-2026-VYEM',
      'TRIAL-2026-WPPS', 'TRIAL-2026-XWDC'
    ];
    for (const code of trialCodes) {
      await client.query(
        `INSERT INTO promo_codes (code, created_by, max_uses, pass_type, duration_days) VALUES ($1, 1, 1, 'trial', 118) ON CONFLICT (code) DO NOTHING`,
        [code]
      );
    }

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
  res.json({ status: 'ok', app: 'H-CAR', version: '1.4.0', googleHealthConfigured: googleHealth.isConfigured(), garminConfigured: garminHealth.isConfigured(), database: 'postgres', smsConfigured: isSmsConfigured(), pushConfigured: isPushConfigured() });
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

// Forgot password - request a reset link
// POST /api/forgot-password
// Always returns success, even if the email does not exist (security:
// do not reveal whether an email is registered).
app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email address is required' });
  }
  const emailLower = email.toLowerCase().trim();
  if (!isValidEmail(emailLower)) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }
  try {
    const user = await dbGet('SELECT id, name, email FROM users WHERE email = $1', [emailLower]);
    // Always return success, even if the user does not exist.
    if (!user) {
      return res.json({ message: 'If an account exists with that email, a reset link has been sent.' });
    }
    // Generate a random token (32 bytes = 64 hex characters)
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now
    // Invalidate any existing unused tokens for this user
    await dbRun('UPDATE password_resets SET used = TRUE WHERE user_id = $1 AND used = FALSE', [user.id]);
    // Save the new token
    await dbRun(
      'INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, token, expiresAt]
    );
    // Send the reset email
    const baseUrl = process.env.BASE_URL || 'https://h-car.onrender.com';
    const resetLink = `${baseUrl}/reset-password.html?token=${token}`;
    const subject = 'Reset your H-CAR password';
    const text = [
      `Hi ${user.name},`,
      '',
      'You requested a password reset for your H-CAR account.',
      '',
      'Click this link to reset your password:',
      resetLink,
      '',
      'This link expires in 1 hour. If you did not request a password reset, you can ignore this email.',
      '',
      'H-CAR (https://h-car.onrender.com)',
    ].join('\n');
    // Send email in background, do not wait for it (prevents SMTP timeouts from blocking the response)
    sendEmail(user.email, subject, text).then(result => {
      if (!result.sent) {
        console.log(`Password reset requested for ${user.email}. Email failed: ${result.reason}. Reset link: ${resetLink}`);
      }
    }).catch(err => {
      console.error('Password reset email error:', err);
      console.log(`Password reset requested for ${user.email}. Reset link: ${resetLink}`);
    });
    res.json({ message: 'If an account exists with that email, a reset link has been sent.' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Failed to process password reset request' });
  }
});

// Verify a reset token (used by the reset page to check if the token is valid)
// GET /api/verify-reset-token?token=XXX
app.get('/api/verify-reset-token', async (req, res) => {
  const { token } = req.query;
  if (!token || typeof token !== 'string') {
    return res.json({ valid: false, error: 'Token is required' });
  }
  try {
    const reset = await dbGet(
      'SELECT * FROM password_resets WHERE token = $1',
      [token]
    );
    if (!reset) {
      return res.json({ valid: false, error: 'Invalid reset link' });
    }
    if (reset.used) {
      return res.json({ valid: false, error: 'This reset link has already been used' });
    }
    if (new Date(reset.expires_at) < new Date()) {
      return res.json({ valid: false, error: 'This reset link has expired. Please request a new one.' });
    }
    res.json({ valid: true });
  } catch (err) {
    console.error('Verify reset token error:', err);
    res.status(500).json({ valid: false, error: 'Failed to verify reset link' });
  }
});

// Reset password - set a new password using a valid token
// POST /api/reset-password
app.post('/api/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Reset token is required' });
  }
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'New password is required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  try {
    const reset = await dbGet(
      'SELECT * FROM password_resets WHERE token = $1',
      [token]
    );
    if (!reset) {
      return res.status(400).json({ error: 'Invalid reset link' });
    }
    if (reset.used) {
      return res.status(400).json({ error: 'This reset link has already been used' });
    }
    if (new Date(reset.expires_at) < new Date()) {
      return res.status(400).json({ error: 'This reset link has expired. Please request a new one.' });
    }
    // Hash the new password and update the user
    const hash = await bcrypt.hash(password, 10);
    await dbRun('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, reset.user_id]);
    // Mark the token as used
    await dbRun('UPDATE password_resets SET used = TRUE WHERE id = $1', [reset.id]);
    res.json({ message: 'Password has been reset. You can now sign in with your new password.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// Change password (authenticated user changes their own password).
// POST /api/change-password
app.post('/api/change-password', authenticateToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || typeof currentPassword !== 'string') {
    return res.status(400).json({ error: 'Current password is required' });
  }
  if (!newPassword || typeof newPassword !== 'string') {
    return res.status(400).json({ error: 'New password is required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  if (currentPassword === newPassword) {
    return res.status(400).json({ error: 'New password must be different from your current password' });
  }
  try {
    const user = await dbGet('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await dbRun('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// Record consent. Current clients send { agreed: true } after a single
// plain-language agreement checkbox. Older clients sent 11 separate
// acknowledgments (the original 10 plus research use of de-identified
// data); that format is still accepted.
app.post('/api/consent', authenticateToken, async (req, res) => {
  const { acknowledgments, agreed } = req.body;
  const legacyOk = Array.isArray(acknowledgments) && acknowledgments.length === 11 && acknowledgments.every(a => a === true);
  if (agreed !== true && !legacyOk) {
    return res.status(400).json({ error: 'Please agree to the consent to continue' });
  }
  try {
    // Free trial: grant complimentary access for 118 days (28-day baseline + 90 days live monitoring)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 118);
    await dbRun(
      'UPDATE users SET consent_given = 1, consent_date = $1, subscription_status = $2, subscription_expires_at = $3 WHERE id = $4',
      [new Date().toISOString(), 'complimentary', expiresAt.toISOString(), req.user.id]
    );
    res.json({ message: 'Consent recorded. Free trial activated for 118 days.' });
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

// ---- Promo code endpoints ----
// Free passes for friends and family. Talon creates codes, friends redeem
// them during signup to get complimentary access without paying via Square.

// Validate a promo code (check if it exists and has uses remaining).
// POST /api/promo/validate - Public (no auth needed, used during signup)
app.post('/api/promo/validate', async (req, res) => {
  const { code } = req.body;
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ valid: false, message: 'Promo code is required' });
  }
  const codeUpper = code.trim().toUpperCase();
  try {
    const promo = await dbGet('SELECT * FROM promo_codes WHERE code = $1', [codeUpper]);
    if (!promo) {
      return res.json({ valid: false, message: 'Invalid promo code' });
    }
    if (promo.uses_count >= promo.max_uses) {
      return res.json({ valid: false, message: 'This promo code has already been used' });
    }
    if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
      return res.json({ valid: false, message: 'This promo code has expired' });
    }
    const message = promo.pass_type === 'trial'
      ? `Promo code is valid - ${promo.duration_days} days of free access!`
      : 'Promo code is valid - Free access!';
    res.json({ valid: true, message, passType: promo.pass_type, durationDays: promo.duration_days });
  } catch (err) {
    console.error('Promo validate error:', err);
    res.status(500).json({ valid: false, message: 'Failed to validate promo code' });
  }
});

// Redeem a promo code (during signup/payment step).
// POST /api/promo/redeem - Requires auth (user must be signed up first)
app.post('/api/promo/redeem', authenticateToken, async (req, res) => {
  const { code } = req.body;
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Promo code is required' });
  }
  const codeUpper = code.trim().toUpperCase();
  try {
    const user = await dbGet('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.consent_given) return res.status(400).json({ error: 'Consent must be given before redeeming a promo code' });
    if (user.subscription_status === 'active' || user.subscription_status === 'complimentary') {
      return res.json({ message: 'Already subscribed', status: user.subscription_status });
    }
    // Check the promo code
    const promo = await dbGet('SELECT * FROM promo_codes WHERE code = $1', [codeUpper]);
    if (!promo) {
      return res.status(400).json({ error: 'Invalid promo code' });
    }
    if (promo.uses_count >= promo.max_uses) {
      return res.status(400).json({ error: 'This promo code has already been used' });
    }
    if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
      return res.status(400).json({ error: 'This promo code has expired' });
    }
    // Calculate expiration date for trial codes (duration_days from now)
    let expiresAt = null;
    if (promo.duration_days) {
      expiresAt = new Date(Date.now() + promo.duration_days * 24 * 60 * 60 * 1000);
    }
    // Redeem it: mark code as used, give user complimentary access
    await dbRun(
      'UPDATE promo_codes SET uses_count = uses_count + 1, used_by = $1, used_at = CURRENT_TIMESTAMP WHERE code = $2',
      [user.id, codeUpper]
    );
    await dbRun(
      'UPDATE users SET subscription_status = $1, promo_code_used = $2, subscription_expires_at = $3 WHERE id = $4',
      ['complimentary', codeUpper, expiresAt, user.id]
    );
    const message = promo.pass_type === 'trial'
      ? `Promo code redeemed! You have ${promo.duration_days} days of free access. Welcome to H-CAR.`
      : 'Promo code redeemed! Welcome to H-CAR.';
    res.json({ message, status: 'complimentary', expiresAt, durationDays: promo.duration_days });
  } catch (err) {
    console.error('Promo redeem error:', err);
    res.status(500).json({ error: 'Failed to redeem promo code' });
  }
});

// List promo codes created by the logged-in user.
// GET /api/promo/my-codes - Requires auth
app.get('/api/promo/my-codes', authenticateToken, async (req, res) => {
  try {
    const codes = await dbAll(
      `SELECT p.code, p.created_at, p.uses_count, p.max_uses, p.used_at,
              p.pass_type, p.duration_days, p.expires_at,
              u.name as used_by_name, u.email as used_by_email,
              u.subscription_expires_at as user_expires_at
       FROM promo_codes p
       LEFT JOIN users u ON p.used_by = u.id
       WHERE p.created_by = $1
       ORDER BY p.pass_type, p.created_at DESC`,
      [req.user.id]
    );
    res.json({ codes });
  } catch (err) {
    console.error('Promo my-codes error:', err);
    res.status(500).json({ error: 'Failed to list promo codes' });
  }
});

// Get user status
app.get('/api/me', authenticateToken, async (req, res) => {
  try {
    const user = await dbGet('SELECT id, name, email, consent_given, subscription_status, subscription_period_end, subscription_expires_at, promo_code_used, created_at, biological_sex, menopause_status, auto_elevation, theme_preference FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    // Check if trial subscription has expired
    let subscriptionStatus = user.subscription_status;
    if (subscriptionStatus === 'complimentary' && user.subscription_expires_at) {
      if (new Date(user.subscription_expires_at) < new Date()) {
        subscriptionStatus = 'expired';
      }
    }
    res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      consentGiven: !!user.consent_given,
      subscriptionStatus,
      subscriptionPeriodEnd: user.subscription_period_end,
      subscriptionExpiresAt: user.subscription_expires_at,
      promoCodeUsed: user.promo_code_used,
      createdAt: user.created_at,
      biologicalSex: user.biological_sex || null,
      menopauseStatus: user.menopause_status || null,
      autoElevation: !!user.auto_elevation,
      themePreference: user.theme_preference || 'dark'
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
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    // Complimentary (promo code) subscriptions have no Square subscription to cancel
    if (user.subscription_status === 'complimentary') {
      await dbRun(
        'UPDATE users SET subscription_status = $1 WHERE id = $2',
        ['canceled', user.id]
      );
      return res.json({ message: 'Complimentary access canceled.' });
    }
    if (!user.square_subscription_id) {
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

// ---- Emergency contact endpoints ----
// The person H-CAR alerts by email when an Act flag fires. Watch flags
// never alert anyone; only Act reaches another human.

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

app.get('/api/emergency-contact', authenticateToken, async (req, res) => {
  try {
    const user = await dbGet('SELECT emergency_contact_name, emergency_contact_email, emergency_contact_phone, emergency_contact_relationship, secondary_contact_name, secondary_contact_email, secondary_contact_phone, secondary_contact_relationship, location_sharing_enabled, last_location_lat, last_location_lng, last_location_address, last_location_updated FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      name: user.emergency_contact_name || null,
      email: user.emergency_contact_email || null,
      phone: user.emergency_contact_phone || null,
      relationship: user.emergency_contact_relationship || null,
      secondaryName: user.secondary_contact_name || null,
      secondaryEmail: user.secondary_contact_email || null,
      secondaryPhone: user.secondary_contact_phone || null,
      secondaryRelationship: user.secondary_contact_relationship || null,
      location_sharing_enabled: !!user.location_sharing_enabled,
      last_location_lat: user.last_location_lat || null,
      last_location_lng: user.last_location_lng || null,
      last_location_address: user.last_location_address || null,
      last_location_updated: user.last_location_updated || null,
    });
  } catch (err) {
    console.error('Emergency contact get error:', err);
    res.status(500).json({ error: 'Failed to get emergency contact' });
  }
});

app.put('/api/emergency-contact', authenticateToken, async (req, res) => {
  try {
    // Capitalize each word in the name (Talon's rule: all names capitalized)
    let name = (req.body.name || '').trim();
    if (name) {
      name = name.split(/\s+/).map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
    }
    const email = (req.body.email || '').trim();
    const phone = (req.body.phone || '').trim();
    const relationship = (req.body.relationship || '').trim();
    // Secondary contact (escalation target). All four blank clears it.
    let secondaryName = (req.body.secondaryName || '').trim();
    if (secondaryName) {
      secondaryName = secondaryName.split(/\s+/).map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
    }
    const secondaryEmail = (req.body.secondaryEmail || '').trim();
    const secondaryPhone = (req.body.secondaryPhone || '').trim();
    const secondaryRelationship = (req.body.secondaryRelationship || '').trim();
    const hasSecondary = !!(secondaryName || secondaryEmail || secondaryPhone || secondaryRelationship);
    if (hasSecondary) {
      if (!secondaryName) return res.status(400).json({ error: 'Please enter your secondary contact\'s name.' });
      if (!secondaryEmail && !secondaryPhone) return res.status(400).json({ error: 'Please enter an email or phone number for your secondary contact.' });
      if (secondaryEmail && !isValidEmail(secondaryEmail)) return res.status(400).json({ error: 'That secondary email address does not look valid.' });
    }
    // All primary fields blank clears the primary contact.
    if (!name && !email && !phone && !relationship) {
      await dbRun(
        'UPDATE users SET emergency_contact_name = NULL, emergency_contact_email = NULL, emergency_contact_phone = NULL, emergency_contact_relationship = NULL, secondary_contact_name = $1, secondary_contact_email = $2, secondary_contact_phone = $3, secondary_contact_relationship = $4 WHERE id = $5',
        [secondaryName || null, secondaryEmail || null, secondaryPhone || null, secondaryRelationship || null, req.user.id]
      );
      return res.json({ message: 'Emergency contact removed.', contact: { name: null, email: null, phone: null, relationship: null } });
    }
    if (!name) return res.status(400).json({ error: 'Please enter your contact\'s name.' });
    if (!email && !phone) return res.status(400).json({ error: 'Please enter an email address or phone number for your contact. Alerts are sent by text and email.' });
    if (email && !isValidEmail(email)) return res.status(400).json({ error: 'That email address does not look valid.' });
    await dbRun(
      'UPDATE users SET emergency_contact_name = $1, emergency_contact_email = $2, emergency_contact_phone = $3, emergency_contact_relationship = $4, secondary_contact_name = $5, secondary_contact_email = $6, secondary_contact_phone = $7, secondary_contact_relationship = $8 WHERE id = $9',
      [name, email || null, phone || null, relationship || null, secondaryName || null, secondaryEmail || null, secondaryPhone || null, secondaryRelationship || null, req.user.id]
    );
    res.json({ message: 'Emergency contact saved.', contact: { name, email: email || null, phone: phone || null, relationship: relationship || null } });
  } catch (err) {
    console.error('Emergency contact save error:', err);
    res.status(500).json({ error: 'Failed to save emergency contact' });
  }
});

// PUT /api/settings/location - Toggle emergency-only location sharing on/off
// When enabled, H-CAR captures location on Fitbit sync and includes last known
// location in Act alert emails. Location is NEVER shared otherwise.
app.put('/api/settings/location', authenticateToken, async (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Enabled must be true or false' });
    }
    if (enabled) {
      await dbRun('UPDATE users SET location_sharing_enabled = TRUE WHERE id = $1', [req.user.id]);
      res.json({ ok: true, enabled: true, message: 'Location sharing enabled. Your location will be saved when you sync your Fitbit, and shared with your emergency contact only if an Act flag fires.' });
    } else {
      // When turning off, delete all location data
      await dbRun('UPDATE users SET location_sharing_enabled = FALSE, last_location_lat = NULL, last_location_lng = NULL, last_location_address = NULL, last_location_updated = NULL WHERE id = $1', [req.user.id]);
      await dbRun('DELETE FROM location_history WHERE user_id = $1', [req.user.id]);
      res.json({ ok: true, enabled: false, message: 'Location sharing disabled. Your location data has been deleted.' });
    }
  } catch (err) {
    console.error('Location setting error:', err);
    res.status(500).json({ error: 'Failed to update location sharing setting' });
  }
});

// GET /api/settings/location - Get current location sharing status
app.get('/api/settings/location', authenticateToken, async (req, res) => {
  try {
    const user = await dbGet('SELECT location_sharing_enabled, last_location_lat, last_location_lng, last_location_address, last_location_updated FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      enabled: !!user.location_sharing_enabled,
      last_lat: user.last_location_lat || null,
      last_lng: user.last_location_lng || null,
      last_address: user.last_location_address || null,
      last_updated: user.last_location_updated || null,
    });
  } catch (err) {
    console.error('Get location setting error:', err);
    res.status(500).json({ error: 'Failed to get location sharing setting' });
  }
});

// POST /api/location/update - Update last known location
// Only updates if user has location_sharing_enabled = true.
// Called after Fitbit sync when user has opted in.
app.post('/api/location/update', authenticateToken, async (req, res) => {
  try {
    const { lat, lng, address } = req.body;
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'Latitude and longitude are required' });
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Invalid coordinates' });
    }
    // Check if user has location sharing enabled
    const user = await dbGet('SELECT location_sharing_enabled FROM users WHERE id = $1', [req.user.id]);
    if (!user || !user.location_sharing_enabled) {
      return res.status(403).json({ error: 'Location sharing is not enabled' });
    }
    const now = new Date().toISOString();
    const addressStr = (address && typeof address === 'string') ? address.trim().substring(0, 500) : null;
    // Update user's last known location
    await dbRun(
      'UPDATE users SET last_location_lat = $1, last_location_lng = $2, last_location_address = $3, last_location_updated = $4 WHERE id = $5',
      [lat, lng, addressStr, now, req.user.id]
    );
    // Insert into history (for debugging)
    await dbRun(
      'INSERT INTO location_history (user_id, lat, lng, address) VALUES ($1, $2, $3, $4)',
      [req.user.id, lat, lng, addressStr]
    );
    // Keep only last 10 locations per user, delete older ones
    await dbRun(
      `DELETE FROM location_history WHERE user_id = $1 AND id NOT IN (
        SELECT id FROM location_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10
      )`,
      [req.user.id]
    );
    res.json({ ok: true, message: 'Location updated' });
  } catch (err) {
    console.error('Location update error:', err);
    res.status(500).json({ error: 'Failed to update location' });
  }
});

// Sends a test email to the user's emergency contact so they can verify
// alerts reach them. Does not record anything in alerts_sent.
app.post('/api/alerts/send-test', authenticateToken, async (req, res) => {
  try {
    const user = await dbGet('SELECT name, emergency_contact_name, emergency_contact_email FROM users WHERE id = $1', [req.user.id]);
    if (!user || !user.emergency_contact_email) {
      return res.status(400).json({ error: 'Add an emergency contact with an email address first.' });
    }
    const subject = 'H-CAR test alert for ' + user.name;
    const text = [
      'Hi ' + (user.emergency_contact_name || 'there') + ',',
      '',
      'This is a test message from H-CAR. ' + user.name + ' listed you as their emergency contact.',
      '',
      'If H-CAR detects a serious, sustained change from ' + user.name + '\'s personal health baseline (an "Act" flag), you will get an email like this one. Smaller changes ("Watch" flags) are never sent to you.',
      '',
      'No action is needed. This was only a test.',
      '',
      'H-CAR (https://h-car.onrender.com)',
    ].join('\n');
    // Send email in background, do not wait for it (prevents SMTP timeouts from blocking the response)
    sendEmail(user.emergency_contact_email, subject, text).then(result => {
      if (!result.sent) {
        console.error('Test alert email failed for ' + user.emergency_contact_email + ': ' + result.reason);
      } else {
        console.log('Test alert sent to ' + user.emergency_contact_email);
      }
    }).catch(err => {
      console.error('Test alert email error:', err);
    });
    res.json({ message: 'Test alert sent to ' + user.emergency_contact_email + '.' });
  } catch (err) {
    console.error('Test alert error:', err);
    res.status(500).json({ error: 'Failed to send test alert' });
  }
});

// ---- Life-saving alert flow ----
// Act flags create an alert and give the user 5 minutes to answer
// "Are you okay?" before anyone is contacted. Contacts must acknowledge
// receipt; no acknowledgment escalates. See alert-engine.js.

// GET /api/alerts/status - The user's active alert, if any, with the
// seconds left in the current window. Runs the escalation sweep first,
// so a check-in here can move a timed-out alert forward even when the
// server was asleep. Never fails the dashboard: errors return no alert.
app.get('/api/alerts/status', authenticateToken, async (req, res) => {
  try {
    try {
      await alertEngine.processEscalations(alertDb, alertContext());
    } catch (e) {
      console.error('Opportunistic escalation sweep failed:', e.message);
    }
    const alert = await alertEngine.getActiveAlert(alertDb, req.user.id);
    if (!alert) {
      return res.json({ activeAlert: null, smsConfigured: isSmsConfigured(), pushConfigured: isPushConfigured() });
    }
    const now = Date.now();
    let secondsLeft = null;
    let windowLabel = null;
    if (alert.status === 'awaiting_user') {
      secondsLeft = Math.max(0, Math.round((new Date(alert.created_at).getTime() + alertEngine.USER_CHECKIN_MS - now) / 1000));
      windowLabel = 'answer the check-in';
    } else if (alert.status === 'alerting' || alert.status === 'escalated') {
      const t0 = alert.primary_alerted_at ? new Date(alert.primary_alerted_at).getTime() : now;
      secondsLeft = Math.max(0, Math.round((t0 + alertEngine.ACK_TOTAL_MS - now) / 1000));
      windowLabel = 'acknowledgment';
    }
    res.json({
      activeAlert: {
        id: alert.id,
        status: alert.status,
        trigger_date: alert.trigger_date,
        created_at: alert.created_at,
        vitals_summary: alert.vitals_summary,
        is_test: alert.is_test === 1,
        secondsLeft,
        windowLabel,
        user_response: alert.user_response,
        primary_alerted_at: alert.primary_alerted_at,
        secondary_alerted_at: alert.secondary_alerted_at,
        acknowledged_by: alert.acknowledged_by,
      },
      smsConfigured: isSmsConfigured(),
      pushConfigured: isPushConfigured(),
    });
  } catch (err) {
    console.error('Alert status error:', err);
    res.status(500).json({ error: 'Failed to get alert status' });
  }
});

// POST /api/alerts/user-response - Answer "Are you okay?"
// Body: { alertId, response } where response is 'fine' or 'need_help'.
// 'fine' cancels the alert. 'need_help' alerts the primary contact now.
app.post('/api/alerts/user-response', authenticateToken, async (req, res) => {
  try {
    const alertId = parseInt(req.body.alertId, 10);
    const response = req.body.response;
    if (!alertId || (response !== 'fine' && response !== 'need_help')) {
      return res.status(400).json({ error: 'Provide an alertId and a response of "fine" or "need_help".' });
    }
    const alert = await alertEngine.getAlertById(alertDb, alertId, req.user.id);
    if (!alert) return res.status(404).json({ error: 'Alert not found.' });
    const user = await dbGet('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const result = await alertEngine.recordUserResponse(alertDb, alertContext(), alert, user, response);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true, status: result.status, contacted: !!result.contacted });
  } catch (err) {
    console.error('User response error:', err);
    res.status(500).json({ error: 'Failed to record your answer' });
  }
});

// GET /api/alerts/history - Past alerts with their escalation trail.
app.get('/api/alerts/history', authenticateToken, async (req, res) => {
  try {
    const alerts = await alertEngine.getAlertHistory(alertDb, req.user.id, 20);
    res.json({ alerts });
  } catch (err) {
    console.error('Alert history error:', err);
    res.status(500).json({ error: 'Failed to get alert history' });
  }
});

// POST /api/alerts/test - Create a test alert that runs the full flow:
// the "Are you okay?" check-in appears, then (if unanswered, or on
// "I need help") the emergency contact is alerted with a TEST message.
// Rate limited to one active test alert at a time.
app.post('/api/alerts/test', authenticateToken, async (req, res) => {
  try {
    const user = await dbGet('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const active = await alertEngine.getActiveAlert(alertDb, req.user.id);
    if (active) {
      return res.status(400).json({ error: 'You already have an active alert. Resolve it before starting a test.' });
    }
    const hasPrimary = !!(user.emergency_contact_email || user.emergency_contact_phone);
    if (!hasPrimary) {
      return res.status(400).json({ error: 'Add an emergency contact with an email or phone number first, so the test has someone to alert.' });
    }
    const triggerDate = 'test-' + new Date().toISOString().replace(/[:.]/g, '-');
    const vitalsSummary = await alertEngine.buildVitalsSummary(
      alertDb, req.user.id,
      [['resting_hr', 3.1], ['rmssd', 2.8], ['spo2', 2.2]]
    );
    const alert = await alertEngine.createAlert(alertDb, req.user.id, {
      trigger_date: triggerDate,
      start: new Date().toISOString().slice(0, 10),
      end: new Date().toISOString().slice(0, 10),
      days: 3,
      top_signals: [['resting_hr', 3.1], ['rmssd', 2.8], ['spo2', 2.2]],
    }, { vitalsSummary, isTest: true });
    if (!alert) return res.status(500).json({ error: 'Could not create the test alert. Try again.' });
    sendPushNotification(req.user.id, {
      title: 'H-CAR test: Are you okay?',
      body: 'This is a test of the emergency alert system. Open the app to answer.',
      url: '/',
      alertId: alert.id,
    }).catch((e) => console.error('Test check-in push failed:', e.message));
    res.json({
      ok: true,
      alertId: alert.id,
      status: alert.status,
      message: 'Test alert created. The "Are you okay?" check-in should appear in the app now. Answer "No, I need help" to test the contact alert, or wait 5 minutes and the contact will be alerted automatically.',
      smsConfigured: isSmsConfigured(),
    });
  } catch (err) {
    console.error('Test alert error:', err);
    res.status(500).json({ error: 'Failed to create test alert' });
  }
});

// GET /api/alerts/acknowledge?token=... - Emergency contact taps the link
// in the SMS or email to confirm receipt. Public (no login): the random
// token is the authorization. Returns a plain HTML confirmation page.
app.get('/api/alerts/acknowledge', async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).send(ackPage(false, 'That acknowledgment link is missing its token.'));
  try {
    const result = await alertEngine.acknowledgeByToken(alertDb, token, 'contact link');
    if (!result.ok) return res.status(404).send(ackPage(false, result.error));
    const user = await dbGet('SELECT name FROM users WHERE id = $1', [result.alert.user_id]);
    return res.send(ackPage(true, 'Thank you. H-CAR now knows you got the alert for ' + (user ? user.name : 'your contact') + '. Please check in with them right away. If you cannot reach them and you are worried, call your local emergency number.'));
  } catch (err) {
    console.error('Acknowledge error:', err);
    return res.status(500).send(ackPage(false, 'Something went wrong. Please try the link again, or contact the person directly.'));
  }
});

// POST /api/alerts/acknowledge - JSON version of the same acknowledgment.
app.post('/api/alerts/acknowledge', async (req, res) => {
  try {
    const token = req.body.token;
    if (!token) return res.status(400).json({ error: 'Provide the acknowledgment token.' });
    const result = await alertEngine.acknowledgeByToken(alertDb, token, req.body.by || 'api');
    if (!result.ok) return res.status(404).json({ error: result.error });
    res.json({ ok: true, status: result.alert.status, message: 'Acknowledgment recorded. Thank you.' });
  } catch (err) {
    console.error('Acknowledge error:', err);
    res.status(500).json({ error: 'Failed to record acknowledgment' });
  }
});

// Small HTML page shown to an emergency contact after they tap the ack link.
function ackPage(success, message) {
  const title = success ? 'Acknowledgment received' : 'Link not valid';
  const color = success ? '#0E7A68' : '#B42318';
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>H-CAR - ' + title + '</title></head>'
    + '<body style="font-family:system-ui,sans-serif;background:#F4F3EE;color:#16211C;margin:0;padding:32px 20px;">'
    + '<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,0.08);">'
    + '<h1 style="color:' + color + ';font-size:22px;margin:0 0 12px 0;">' + title + '</h1>'
    + '<p style="font-size:16px;line-height:1.6;margin:0;">' + message + '</p>'
    + '<p style="font-size:14px;color:#666;margin:16px 0 0 0;">H-CAR - Human Condition Analysis and Risk. This page confirms receipt only. H-CAR does not diagnose anything. If someone may be in danger, call your local emergency number.</p>'
    + '</div></body></html>';
}

// POST /api/alerts/sms-reply - Twilio webhook for SMS replies.
// A contact who replies YES, OK, ACK, or GOT IT acknowledges the alert.
// Twilio posts form-encoded data (From, Body). Configure the Twilio
// number's messaging webhook to point at this URL.
app.post('/api/alerts/sms-reply', async (req, res) => {
  res.set('Content-Type', 'text/xml');
  try {
    const from = req.body.From || '';
    const body = (req.body.Body || '').trim().toLowerCase();
    const yesWords = ['yes', 'ok', 'ack', 'got it', 'gotit', 'received', 'confirm'];
    if (!yesWords.some((w) => body === w || body.startsWith(w + ' ') || body.startsWith(w + '.'))) {
      return res.send('<Response></Response>');
    }
    const digits = alertEngine.normalizePhone(from);
    if (!digits) return res.send('<Response></Response>');
    // Find the newest alerting alert whose primary or secondary contact phone matches.
    const candidates = await dbAll(
      `SELECT a.* FROM alerts a JOIN users u ON u.id = a.user_id
       WHERE a.status IN ('alerting','escalated','unacknowledged')
       ORDER BY a.created_at DESC LIMIT 20`
    );
    for (const alert of candidates) {
      const user = await dbGet('SELECT emergency_contact_phone, secondary_contact_phone FROM users WHERE id = $1', [alert.user_id]);
      if (!user) continue;
      if (alertEngine.normalizePhone(user.emergency_contact_phone) === digits ||
          alertEngine.normalizePhone(user.secondary_contact_phone) === digits) {
        const result = await alertEngine.acknowledgeByToken(alertDb, alert.ack_token, 'SMS reply from ' + from);
        if (result.ok) console.log('Alert ' + alert.id + ' acknowledged by SMS reply from ' + from + '.');
        break;
      }
    }
    return res.send('<Response></Response>');
  } catch (err) {
    console.error('SMS reply error:', err);
    return res.send('<Response></Response>');
  }
});

// ---- Web push subscription ----
// GET /api/push/vapid-key - Public key the browser needs to subscribe.
app.get('/api/push/vapid-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || null });
});

// POST /api/push/subscribe - Store one browser/device subscription.
app.post('/api/push/subscribe', authenticateToken, async (req, res) => {
  try {
    const sub = req.body.subscription;
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return res.status(400).json({ error: 'Invalid push subscription.' });
    }
    await dbRun(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
       ON CONFLICT(user_id, endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [req.user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth]
    );
    res.json({ ok: true, message: 'Push alerts enabled for this device.' });
  } catch (err) {
    console.error('Push subscribe error:', err);
    res.status(500).json({ error: 'Failed to save push subscription' });
  }
});

// ---- Family Dashboard ----
// Lets users share their health status (not detailed data) with family
// members. Green = all good, yellow = Watch flag, red = Act flag.
// Status only, no RHR, HRV, or other values are shared.

// POST /api/family/invite - Send an invite to a family member by email
app.post('/api/family/invite', authenticateToken, async (req, res) => {
  try {
    const { email, relationship } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email address is required' });
    }
    const emailLower = email.toLowerCase().trim();
    if (!isValidEmail(emailLower)) {
      return res.status(400).json({ error: 'Please enter a valid email address' });
    }
    // Cannot invite yourself
    if (emailLower === req.user.email.toLowerCase()) {
      return res.status(400).json({ error: 'You cannot invite yourself' });
    }
    // Find the user by email
    const targetUser = await dbGet('SELECT id, name, email FROM users WHERE email = $1', [emailLower]);
    if (!targetUser) {
      return res.status(404).json({ error: 'No H-CAR account found with that email' });
    }
    // Check if already connected (either direction, any status)
    const existing = await dbGet(
      `SELECT id, status FROM family_connections
       WHERE (user_id = $1 AND family_member_id = $2) OR (user_id = $2 AND family_member_id = $1)`,
      [req.user.id, targetUser.id]
    );
    if (existing) {
      if (existing.status === 'accepted') {
        return res.status(400).json({ error: 'You are already connected with ' + targetUser.name });
      } else if (existing.status === 'pending') {
        return res.status(400).json({ error: 'An invite is already pending with ' + targetUser.name });
      }
      // If declined, allow re-invite by updating the existing record
      await dbRun(
        `UPDATE family_connections SET user_id = $1, family_member_id = $2, relationship = $3, status = 'pending', created_at = CURRENT_TIMESTAMP WHERE id = $4`,
        [req.user.id, targetUser.id, relationship || 'Family', existing.id]
      );
      return res.json({ message: 'Invite sent to ' + targetUser.name, connectionId: existing.id });
    }
    // Create new pending connection
    const result = await dbRun(
      'INSERT INTO family_connections (user_id, family_member_id, relationship, status) VALUES ($1, $2, $3, $4) RETURNING id',
      [req.user.id, targetUser.id, relationship || 'Family', 'pending']
    );
    res.json({ message: 'Invite sent to ' + targetUser.name, connectionId: result.lastID });
  } catch (err) {
    console.error('Family invite error:', err);
    res.status(500).json({ error: 'Failed to send invite' });
  }
});

// GET /api/family/pending - List pending invites received
app.get('/api/family/pending', authenticateToken, async (req, res) => {
  try {
    const pending = await dbAll(
      `SELECT fc.id, fc.user_id, fc.relationship, fc.created_at, u.name, u.email
       FROM family_connections fc
       JOIN users u ON fc.user_id = u.id
       WHERE fc.family_member_id = $1 AND fc.status = 'pending'
       ORDER BY fc.created_at DESC`,
      [req.user.id]
    );
    res.json({ pending });
  } catch (err) {
    console.error('Family pending error:', err);
    res.status(500).json({ error: 'Failed to load pending invites' });
  }
});

// POST /api/family/accept - Accept an invite
app.post('/api/family/accept', authenticateToken, async (req, res) => {
  try {
    const { connectionId } = req.body;
    if (!connectionId) {
      return res.status(400).json({ error: 'Connection ID is required' });
    }
    // Verify this invite is for the current user and is pending
    const connection = await dbGet(
      'SELECT id, user_id, family_member_id FROM family_connections WHERE id = $1 AND family_member_id = $2 AND status = $3',
      [connectionId, req.user.id, 'pending']
    );
    if (!connection) {
      return res.status(404).json({ error: 'Invite not found or already processed' });
    }
    await dbRun('UPDATE family_connections SET status = $1 WHERE id = $2', ['accepted', connectionId]);
    res.json({ message: 'Invite accepted' });
  } catch (err) {
    console.error('Family accept error:', err);
    res.status(500).json({ error: 'Failed to accept invite' });
  }
});

// POST /api/family/decline - Decline an invite
app.post('/api/family/decline', authenticateToken, async (req, res) => {
  try {
    const { connectionId } = req.body;
    if (!connectionId) {
      return res.status(400).json({ error: 'Connection ID is required' });
    }
    // Verify this invite is for the current user and is pending
    const connection = await dbGet(
      'SELECT id FROM family_connections WHERE id = $1 AND family_member_id = $2 AND status = $3',
      [connectionId, req.user.id, 'pending']
    );
    if (!connection) {
      return res.status(404).json({ error: 'Invite not found or already processed' });
    }
    await dbRun('UPDATE family_connections SET status = $1 WHERE id = $2', ['declined', connectionId]);
    res.json({ message: 'Invite declined' });
  } catch (err) {
    console.error('Family decline error:', err);
    res.status(500).json({ error: 'Failed to decline invite' });
  }
});

// GET /api/family/dashboard - Get family members' status
app.get('/api/family/dashboard', authenticateToken, async (req, res) => {
  try {
    // Get all accepted connections where current user is the viewer
    // (i.e., others sharing their status with me)
    const connections = await dbAll(
      `SELECT fc.id, fc.user_id, fc.relationship, u.name, u.email
       FROM family_connections fc
       JOIN users u ON fc.user_id = u.id
       WHERE fc.family_member_id = $1 AND fc.status = 'accepted'
       ORDER BY u.name ASC`,
      [req.user.id]
    );

    const family = [];
    for (const conn of connections) {
      const memberId = conn.user_id;

      // Check baseline completion (28 days of data)
      const dayCount = await dbGet(
        'SELECT COUNT(DISTINCT date) as count FROM daily_summaries WHERE user_id = $1',
        [memberId]
      );
      const daysSynced = parseInt(dayCount?.count || 0);

      // Get last sync date
      const lastSync = await dbGet(
        'SELECT MAX(date) as last_date FROM daily_summaries WHERE user_id = $1',
        [memberId]
      );
      const lastSyncDate = lastSync?.last_date || null;

      // Check for recent data (within last 7 days)
      let status = 'no_data';
      if (daysSynced === 0 || !lastSyncDate) {
        status = 'no_data';
      } else {
        // Check if baseline is complete (28 days)
        if (daysSynced < 28) {
          status = 'learning';
        } else {
          // Check most recent episode (if any, within last 14 days)
          // end_date is TEXT in YYYY-MM-DD format, compare as date
          const recentEpisode = await dbGet(
            `SELECT is_act, end_date FROM episodes
             WHERE user_id = $1 AND end_date >= TO_CHAR(CURRENT_DATE - INTERVAL '14 days', 'YYYY-MM-DD')
             ORDER BY end_date DESC LIMIT 1`,
            [memberId]
          );
          if (recentEpisode) {
            status = recentEpisode.is_act ? 'act' : 'watch';
          } else {
            status = 'good';
          }
        }
      }

      family.push({
        connectionId: conn.id,
        name: conn.name,
        email: conn.email,
        relationship: conn.relationship || 'Family',
        status: status,
        lastSync: lastSyncDate,
        daysSynced: daysSynced,
      });
    }

    res.json({ family });
  } catch (err) {
    console.error('Family dashboard error:', err);
    res.status(500).json({ error: 'Failed to load family dashboard' });
  }
});

// DELETE /api/family/:connectionId - Remove a family connection
app.delete('/api/family/:connectionId', authenticateToken, async (req, res) => {
  try {
    const connectionId = parseInt(req.params.connectionId);
    if (isNaN(connectionId)) {
      return res.status(400).json({ error: 'Invalid connection ID' });
    }
    // Verify the current user is part of this connection
    const connection = await dbGet(
      'SELECT id FROM family_connections WHERE id = $1 AND (user_id = $2 OR family_member_id = $2)',
      [connectionId, req.user.id]
    );
    if (!connection) {
      return res.status(404).json({ error: 'Connection not found' });
    }
    await dbRun('DELETE FROM family_connections WHERE id = $1', [connectionId]);
    res.json({ message: 'Family connection removed' });
  } catch (err) {
    console.error('Family delete error:', err);
    res.status(500).json({ error: 'Failed to remove family connection' });
  }
});

// ---- Emergency contact alerts ----
// When the detector fires an Act flag (a strong, sustained change),
// H-CAR emails the user's emergency contact. Watch flags never alert
// anyone; only Act reaches another human.
//
// Email goes through plain SMTP via Nodemailer. Configure with:
//   SMTP_HOST, SMTP_PORT (default 587), SMTP_SECURE ("true" for port 465),
//   SMTP_USER, SMTP_PASS, SMTP_FROM (optional, defaults to SMTP_USER)
// If SMTP is not configured, alerts are skipped gracefully and the
// reason is logged; nothing else breaks.

const SIGNAL_LABELS = {
  resting_hr: 'Resting heart rate',
  rmssd: 'Heart rate variability (HRV)',
  spo2: 'Blood oxygen (SpO2)',
  nightly_temperature: 'Skin temperature',
  sleep_duration_h: 'Sleep duration',
  full_sleep_breathing_rate: 'Breathing rate',
};

// top_signals is an array of [signalKey, meanZ] pairs, strongest first.
function describeTopSignals(topSignals) {
  if (!topSignals || topSignals.length === 0) return 'several signals moved away from baseline';
  return topSignals.map(([key, z]) => {
    const label = SIGNAL_LABELS[key] || key.replace(/_/g, ' ');
    return label + ' (change score ' + z + ')';
  }).join(', ');
}

let mailer = null;

function getMailer() {
  if (mailer) return mailer;
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    console.log('Email alerts disabled: SMTP_HOST, SMTP_USER and SMTP_PASS are not all set. Host:', !!host, 'User:', !!user, 'Pass:', !!pass);
    return null;
  }
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (e) {
    console.error('Email alerts disabled: nodemailer is not installed.', e.message);
    return null;
  }
  const port = parseInt(process.env.SMTP_PORT, 10) || 587;
  console.log('Initializing email transport: host=' + host + ', port=' + port + ', user=' + user);
  mailer = nodemailer.createTransport({
    host,
    port,
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    auth: { user, pass },
  });
  return mailer;
}

async function sendEmail(to, subject, text) {
  const transport = getMailer();
  if (!transport) return { sent: false, reason: 'email is not configured on the server (SMTP settings missing)' };
  try {
    console.log('Sending email to ' + to + ' with subject: ' + subject);
    await transport.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text,
    });
    console.log('Email sent successfully to ' + to);
    return { sent: true };
  } catch (e) {
    console.error('Email send failed to ' + to + ':', e.message);
    console.error('SMTP error details:', e);
    // Reset mailer so next attempt will recreate it (in case of transient connection issues)
    mailer = null;
    return { sent: false, reason: 'email send failed: ' + e.message };
  }
}

// ---- SMS alerts (Twilio) ----
// Sends Act alert texts to emergency contacts. Configure with:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
// Twilio has a free trial with $15 credit, enough for hundreds of texts.
// If Twilio is not configured, SMS is skipped gracefully and email
// remains the alert channel. No new dependency: plain HTTPS via axios.
function isSmsConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);
}

async function sendSms(to, body) {
  if (!isSmsConfigured()) {
    return { sent: false, reason: 'SMS is not configured (set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER)' };
  }
  const sid = process.env.TWILIO_ACCOUNT_SID;
  try {
    await axios.post(
      'https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json',
      new URLSearchParams({ To: to, From: process.env.TWILIO_FROM_NUMBER, Body: body }).toString(),
      {
        auth: { username: sid, password: process.env.TWILIO_AUTH_TOKEN },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      }
    );
    console.log('SMS sent to ' + to);
    return { sent: true };
  } catch (e) {
    const detail = (e.response && e.response.data && e.response.data.message) || e.message;
    console.error('SMS send failed to ' + to + ':', detail);
    return { sent: false, reason: 'SMS send failed: ' + detail };
  }
}

// ---- Web push notifications ----
// Used to wake the user's phone when an Act flag fires so they see the
// "Are you okay?" check-in even if the app is not open. Configure with:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (generate with: npx web-push generate-vapid-keys)
// If web-push is not installed or keys are missing, push is skipped.
let webpush = null;
let webpushTried = false;
function getWebPush() {
  if (webpush) return webpush;
  if (webpushTried) return null;
  webpushTried = true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return null;
  try {
    webpush = require('web-push');
    webpush.setVapidDetails('mailto:tfcontracting@shaw.ca', pub, priv);
    return webpush;
  } catch (e) {
    console.log('Push disabled: web-push is not installed.');
    return null;
  }
}
function isPushConfigured() {
  return !!getWebPush();
}

async function sendPushNotification(userId, payload) {
  const wp = getWebPush();
  if (!wp) return { sent: false, reason: 'push is not configured (set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY)' };
  const subs = await dbAll('SELECT * FROM push_subscriptions WHERE user_id = $1', [userId]);
  if (subs.length === 0) return { sent: false, reason: 'no push subscriptions for this user' };
  let sent = 0;
  for (const sub of subs) {
    try {
      await wp.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload)
      );
      sent += 1;
    } catch (e) {
      // 410 Gone / 404 Not Found means the subscription expired; drop it.
      if (e.statusCode === 410 || e.statusCode === 404) {
        await dbRun('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
      } else {
        console.error('Push send failed:', e.message);
      }
    }
  }
  return { sent: sent > 0, count: sent };
}

// Shared context for the alert engine: how to reach people.
function alertContext() {
  return {
    sendEmail,
    sendSms,
    baseUrl: process.env.BASE_URL || 'https://h-car.onrender.com',
    log: (msg) => console.log(msg),
  };
}

// DB adapter for the alert engine (same promise helpers as the rest of the app).
const alertDb = { get: dbGet, all: dbAll, run: dbRun };

// Create an alert for each Act episode that has not been alerted yet.
// Deduplicated by (user, trigger date) in the alerts table, because the
// detector re-creates all episodes on every sync. Episodes already
// emailed under the old email-only system (alerts_sent) are also skipped.
// Creating an alert does NOT contact anyone yet: the user gets 5 minutes
// to answer "Are you okay?" first. Returns { checked, created }.
async function maybeSendActAlerts(userId, mergedEpisodes) {
  const actEpisodes = (mergedEpisodes || []).filter((e) => e.is_act && e.trigger_date);
  if (actEpisodes.length === 0) return { checked: 0, created: 0 };
  const user = await dbGet('SELECT id, name, email, emergency_contact_name, emergency_contact_email, emergency_contact_phone, emergency_contact_relationship, secondary_contact_name, secondary_contact_email, secondary_contact_phone, location_sharing_enabled, last_location_lat, last_location_lng, last_location_address, last_location_updated FROM users WHERE id = $1', [userId]);
  if (!user) return { checked: actEpisodes.length, created: 0 };
  let created = 0;
  for (const ep of actEpisodes) {
    const existing = await dbGet('SELECT 1 AS x FROM alerts WHERE user_id = $1 AND trigger_date = $2', [userId, ep.trigger_date]);
    if (existing) continue;
    const legacy = await dbGet('SELECT 1 AS x FROM alerts_sent WHERE user_id = $1 AND trigger_date = $2', [userId, ep.trigger_date]);
    if (legacy) continue;
    const vitalsSummary = await alertEngine.buildVitalsSummary(alertDb, userId, ep.top_signals);
    const alert = await alertEngine.createAlert(alertDb, userId, ep, { vitalsSummary });
    if (alert) {
      created += 1;
      console.log('Act alert created for user ' + userId + ' (trigger ' + ep.trigger_date + ', alert ' + alert.id + '). Waiting 5 min for the user to answer "Are you okay?".');
      // Wake the user's phone so they see the check-in even if the app is closed.
      sendPushNotification(userId, {
        title: 'H-CAR: Are you okay?',
        body: 'H-CAR detected a serious change from your baseline. Open the app to answer.',
        url: '/',
        alertId: alert.id,
      }).catch((e) => console.error('Check-in push failed:', e.message));
    }
  }
  return { checked: actEpisodes.length, created };
}

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
// Health context the user optionally provides (cycle dates, pregnancy,
// altitude, medications, menopause status) adjusts expectations so
// normal, expected changes are not flagged as abnormal. Without any
// context the detector behaves exactly as before.
async function runDetectorForUser(userId) {
  const rows = await dbAll('SELECT * FROM daily_summaries WHERE user_id = $1 ORDER BY date ASC', [userId]);
  const dayRows = rows.map((r) => ({ date: r.date, vals: rowToDetectorVals(r) }));

  // Build the optional context maps for the detector. Each map is keyed
  // by date and only covers days the user has context for.
  let phaseByDate = {};
  let pregnancyByDate = {};
  let altitudeByDate = {};
  let medChangeByDate = {};
  let sigmaFloorOverrides = {};
  let menopauseStatus = null;
  try {
    const userCtx = await dbGet('SELECT biological_sex, menopause_status FROM users WHERE id = $1', [userId]);
    if (userCtx) {
      menopauseStatus = userCtx.menopause_status || null;
      const periFloor = context.tempSigmaFloorForMenopause(menopauseStatus);
      if (periFloor !== null) {
        sigmaFloorOverrides = { nightly_temperature: periFloor };
      }
      if (userCtx.biological_sex === 'female') {
        const cycleRows = await dbAll(
          'SELECT start_date, end_date FROM menstrual_cycles WHERE user_id = $1 ORDER BY start_date ASC',
          [userId]
        );
        if (cycleRows.length > 0) {
          const cycles = cycleRows.map((r) => ({ start_date: toDateStr(r.start_date), end_date: toDateStr(r.end_date) }));
          for (const row of rows) {
            const phase = cycle.getCyclePhase(cycles, row.date);
            if (phase) phaseByDate[row.date] = phase;
          }
        }
      }
    }
    const pregRows = await dbAll(
      'SELECT start_date, due_date, end_date, status FROM pregnancies WHERE user_id = $1 ORDER BY start_date DESC',
      [userId]
    );
    if (pregRows.length > 0) {
      const pregnancies = pregRows.map((r) => ({
        start_date: toDateStr(r.start_date),
        due_date: toDateStr(r.due_date),
        end_date: toDateStr(r.end_date),
        status: r.status,
      }));
      for (const row of rows) {
        const info = context.pregnancyInfoOn(pregnancies, row.date);
        if (info.pregnant) pregnancyByDate[row.date] = { weeks: info.weeks };
      }
    }
    for (const row of rows) {
      if (row.altitude_m !== null && row.altitude_m !== undefined) {
        altitudeByDate[row.date] = row.altitude_m;
      }
    }
    const medRows = await dbAll('SELECT start_date FROM medications WHERE user_id = $1', [userId]);
    if (medRows.length > 0) {
      const medStarts = medRows.map((r) => toDateStr(r.start_date)).filter(Boolean);
      for (const row of rows) {
        if (context.medChangeRecentOn(medStarts, row.date, 14)) {
          medChangeByDate[row.date] = true;
        }
      }
    }
  } catch (e) {
    // Context is optional. If it fails to load, run the detector
    // without it rather than failing the sync.
    console.error('Health context load failed for user ' + userId + ':', e.message);
    phaseByDate = {};
    pregnancyByDate = {};
    altitudeByDate = {};
    medChangeByDate = {};
    sigmaFloorOverrides = {};
    menopauseStatus = null;
  }

  const result = detector.runPerson(dayRows, {
    phaseByDate,
    pregnancyByDate,
    altitudeByDate,
    medChangeByDate,
    sigmaFloorOverrides,
    menopauseStatus,
  });

  await dbRun('DELETE FROM detector_results WHERE user_id = $1', [userId]);
  await dbRun('DELETE FROM episodes WHERE user_id = $1', [userId]);
  await dbRun('DELETE FROM baselines WHERE user_id = $1', [userId]);

  const actTriggerDates = new Set(result.episodes.filter((e) => e.is_act && e.trigger_date).map((e) => e.trigger_date));
  for (const d of result.dayResults) {
    const dayContext = {
      cyclePhase: d.cyclePhase || null,
      pregnant: !!d.pregnant,
      pregnantWeeks: d.pregnantWeeks !== undefined ? d.pregnantWeeks : null,
      altitudeM: d.altitudeM !== undefined ? d.altitudeM : null,
      medChangeRecent: !!d.medChangeRecent,
      menopauseStatus: d.menopauseStatus || null,
    };
    await dbRun(
      `INSERT INTO detector_results (user_id, date, z_scores, composite, n_off, n_signals, watch, act, in_baseline, scored, cycle_phase, context_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        userId, d.date, JSON.stringify(d.zs), d.composite, d.nOff, d.nSignals,
        d.watch ? 1 : 0, actTriggerDates.has(d.date) ? 1 : 0,
        d.inBaseline ? 1 : 0, d.scored ? 1 : 0,
        d.cyclePhase || null, JSON.stringify(dayContext),
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

  // Create an alert for any new Act episode (deduped by trigger date).
  // Creating an alert does not contact anyone yet: the user gets 5
  // minutes to answer "Are you okay?" first. Never blocks the sync:
  // failures are logged and retried on the next sync.
  let alertsSent = 0;
  try {
    const alertResult = await maybeSendActAlerts(userId, det.mergedEpisodes);
    alertsSent = alertResult.created;
  } catch (e) {
    console.error('Act alert check failed for user ' + userId + ':', e.message);
  }

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
    alertsSent,
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

// ---- Garmin Health API endpoints ----
// Garmin uses OAuth 2.0 with PKCE. The flow:
// 1. Frontend calls GET /api/garmin/connect, gets auth URL + code_verifier
// 2. Frontend redirects user to Garmin auth URL
// 3. Garmin redirects back to /api/garmin/callback with code + state
// 4. Server exchanges code for tokens using code_verifier
// 5. Tokens stored encrypted in garmin_tokens table
//
// Data delivery is PUSH-based: Garmin sends data to our webhook endpoint
// (/api/garmin/webhook) when a user syncs their device. There is no
// polling endpoint for Business Starter tier.

app.get('/api/garmin/connect', authenticateToken, (req, res) => {
  if (!garminHealth.isConfigured()) {
    return res.status(503).json({ error: 'Garmin is not configured yet. The operator must set GARMIN_CLIENT_ID and GARMIN_CLIENT_SECRET.' });
  }
  const codeVerifier = garminHealth.generateCodeVerifier();
  const codeChallenge = garminHealth.generateCodeChallenge(codeVerifier);
  const state = jwt.sign(
    { userId: req.user.id, codeVerifier, nonce: Math.random().toString(36).slice(2) },
    JWT_SECRET,
    { expiresIn: '10m' }
  );
  res.json({ url: garminHealth.getAuthUrl(state, codeChallenge) });
});

// OAuth callback from Garmin. Exchanges the code for tokens using the
// PKCE code_verifier stored in the state JWT, then stores tokens.
app.get('/api/garmin/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const fail = (message) => res.redirect('/?garmin=error&message=' + encodeURIComponent(message));
  if (error) return fail('Garmin sign-in failed: ' + error);
  if (!code || !state) return fail('Missing code or state from Garmin.');
  let payload;
  try {
    payload = jwt.verify(state, JWT_SECRET);
  } catch (e) {
    return fail('The connection request expired. Please try again.');
  }
  try {
    const tokens = await garminHealth.exchangeCode(code, payload.codeVerifier);
    if (!tokens.refresh_token) {
      return fail('Garmin did not return a refresh token. Please try again.');
    }
    // Garmin user ID is returned in the token response or can be fetched
    // from the API. For now, store null and update it when we receive
    // the first webhook push.
    await dbRun(
      `INSERT INTO garmin_tokens (user_id, access_token_enc, refresh_token_enc, expires_at, connected_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT(user_id) DO UPDATE SET
         access_token_enc = EXCLUDED.access_token_enc,
         refresh_token_enc = EXCLUDED.refresh_token_enc,
         expires_at = EXCLUDED.expires_at,
         connected_at = EXCLUDED.connected_at,
         last_sync_error = NULL`,
      [
        payload.userId,
        garminHealth.encryptToken(tokens.access_token),
        garminHealth.encryptToken(tokens.refresh_token),
        Date.now() + (tokens.expires_in || 3600) * 1000,
        new Date().toISOString(),
      ]
    );
    res.redirect('/?garmin=connected');
  } catch (e) {
    console.error('Garmin callback error:', e.message);
    return fail('Could not complete the Garmin connection. Please try again.');
  }
});

app.get('/api/garmin/status', authenticateToken, async (req, res) => {
  try {
    const row = await dbGet('SELECT connected_at, last_sync_at, last_sync_error FROM garmin_tokens WHERE user_id = $1', [req.user.id]);
    res.json({
      connected: !!row,
      connectedAt: row ? row.connected_at : null,
      lastSyncAt: row ? row.last_sync_at : null,
      lastSyncError: row ? row.last_sync_error : null,
      garminConfigured: garminHealth.isConfigured(),
    });
  } catch (err) {
    console.error('Garmin status error:', err);
    res.status(500).json({ error: 'Failed to get Garmin status' });
  }
});

app.post('/api/garmin/disconnect', authenticateToken, async (req, res) => {
  try {
    await dbRun('DELETE FROM garmin_tokens WHERE user_id = $1', [req.user.id]);
    res.json({ message: 'Garmin disconnected. Your stored summaries and detector history are kept; delete your account to remove them.' });
  } catch (err) {
    console.error('Garmin disconnect error:', err);
    res.status(500).json({ error: 'Failed to disconnect Garmin' });
  }
});

// Garmin webhook endpoint. Garmin pushes data here when a user syncs
// their device. Each data type has its own endpoint, or a single endpoint
// receives all types with an X-Record-Type header.
//
// Garmin sends:
//   POST /api/garmin/webhook/dailies
//   POST /api/garmin/webhook/sleep
//   POST /api/garmin/webhook/hrv
//   POST /api/garmin/webhook/pulseox
//   POST /api/garmin/webhook/respiration
//   POST /api/garmin/webhook/skinTemp
//
// Or with a single endpoint:
//   POST /api/garmin/webhook (with X-Record-Type header)
//
// The payload contains a userId (Garmin's ID) and an array of data points.
// We look up the H-CAR user by garmin_user_id, parse the data, and store
// it in daily_summaries. Processing must be idempotent: Garmin may send
// the same data multiple times.
app.post('/api/garmin/webhook/:type?', async (req, res) => {
  try {
    const recordType = req.params.type || req.headers['x-record-type'];
    if (!recordType) {
      return res.status(400).json({ error: 'Missing record type' });
    }

    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    // Parse the payload into H-CAR daily summary format
    const days = garminHealth.parseWebhookPayload(recordType, payload);

    // Find the H-CAR user by Garmin user ID. The payload contains userId
    // in each data point. We use the first one to look up the user.
    let garminUserId = null;
    const dataArrays = ['dailies', 'sleeps', 'hrvSummaries', 'pulseOx', 'allDayRespiration', 'skinTemp'];
    for (const key of dataArrays) {
      if (Array.isArray(payload[key]) && payload[key].length > 0 && payload[key][0].userId) {
        garminUserId = payload[key][0].userId;
        break;
      }
    }

    if (!garminUserId) {
      return res.status(400).json({ error: 'No Garmin user ID in payload' });
    }

    const tokenRow = await dbGet('SELECT user_id FROM garmin_tokens WHERE garmin_user_id = $1', [garminUserId]);
    if (!tokenRow) {
      // User not found by Garmin ID. Try to match by the first webhook:
      // if garmin_user_id is null in the DB, update it from this payload.
      // This handles the case where the user connected but we did not get
      // their Garmin ID during OAuth.
      console.log('Garmin webhook: unknown user ID ' + garminUserId + ', ignoring');
      return res.status(200).json({ message: 'User not found, ignoring' });
    }

    const userId = tokenRow.user_id;
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

    if (upserted > 0) {
      // Re-run detector with the new data
      const det = await runDetectorForUser(userId);
      // Check for new Act episodes and create alerts
      try {
        await maybeSendActAlerts(userId, det.mergedEpisodes);
      } catch (e) {
        console.error('Act alert check failed for Garmin user ' + userId + ':', e.message);
      }
    }

    await dbRun('UPDATE garmin_tokens SET last_sync_at = $1, last_sync_error = NULL WHERE user_id = $2',
      [new Date().toISOString(), userId]);

    res.status(200).json({ message: 'Webhook processed', daysUpserted: upserted });
  } catch (e) {
    console.error('Garmin webhook error:', e);
    res.status(500).json({ error: 'Webhook processing failed: ' + e.message });
  }
});

// Detector status for the dashboard: baseline progress, current status,
// baselines, and recent flags.
app.get('/api/detector/status', authenticateToken, async (req, res) => {
  try {
    const fitbitRow = await dbGet('SELECT last_sync_at FROM fitbit_tokens WHERE user_id = $1', [req.user.id]);
    const garminRow = await dbGet('SELECT last_sync_at FROM garmin_tokens WHERE user_id = $1', [req.user.id]);
    const tokenRow = fitbitRow || garminRow;
    const range = await dbGet('SELECT MIN(date) AS first_date, MAX(date) AS last_date, COUNT(*) AS n_days FROM daily_summaries WHERE user_id = $1', [req.user.id]);
    const baselines = await dbAll('SELECT signal, centre, sigma, n FROM baselines WHERE user_id = $1', [req.user.id]);
    const episodes = await dbAll('SELECT * FROM episodes WHERE user_id = $1 ORDER BY start_date DESC LIMIT 5', [req.user.id]);
    const latest = await dbGet('SELECT * FROM detector_results WHERE user_id = $1 ORDER BY date DESC LIMIT 1', [req.user.id]);

    if (!range || !range.first_date) {
      return res.json({
        connected: !!tokenRow,
        fitbitConnected: !!fitbitRow,
        garminConnected: !!garminRow,
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
      fitbitConnected: !!fitbitRow,
      garminConnected: !!garminRow,
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
      `SELECT s.*, r.composite, r.n_off, r.n_signals, r.watch, r.act, r.in_baseline, r.scored, r.z_scores, r.cycle_phase, r.context_json
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
        altitudeM: r.altitude_m !== undefined ? r.altitude_m : null,
        composite: r.composite,
        nOff: r.n_off,
        nSignals: r.n_signals,
        watch: !!r.watch,
        act: !!r.act,
        inBaseline: !!r.in_baseline,
        scored: !!r.scored,
        zScores: r.z_scores ? JSON.parse(r.z_scores) : {},
        cyclePhase: r.cycle_phase || null,
        context: r.context_json ? JSON.parse(r.context_json) : null,
      })),
    });
  } catch (err) {
    console.error('Days error:', err);
    res.status(500).json({ error: 'Failed to get days' });
  }
});

// ---- Operator endpoints (admin key) ----
// Used by the daily sync cron (Render Cron Job or an external scheduler).
// Header: x-admin-key: <ADMIN_SYNC_KEY>. Accepts env var or fallback key.
const FALLBACK_ADMIN_KEY = 'b1c6546e293100e124074ff727670cafd8d2822841fd57d286db47245830f2d5';

function requireAdminKey(req, res, next) {
  const providedKey = req.headers['x-admin-key'];
  const envKey = process.env.ADMIN_SYNC_KEY;
  if (providedKey === envKey || providedKey === FALLBACK_ADMIN_KEY) {
    next();
  } else {
    return res.status(403).json({ error: 'Forbidden' });
  }
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

// Run the alert escalation sweep on demand. The in-process interval
// handles this while the server is awake, but the free hosting tier
// sleeps when idle, so an external cron should hit this every few
// minutes (same x-admin-key as sync-all) to keep escalations on time.
app.post('/api/admin/process-alerts', requireAdminKey, async (req, res) => {
  try {
    const summary = await alertEngine.processEscalations(alertDb, alertContext());
    res.json(summary);
  } catch (err) {
    console.error('Process-alerts error:', err);
    res.status(500).json({ error: 'Failed to process alerts' });
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
         (SELECT COUNT(*) FROM garmin_tokens) AS garmin_connected,
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
              CASE WHEN EXISTS (SELECT 1 FROM fitbit_tokens f WHERE f.user_id = u.id) THEN 1 ELSE 0 END AS fitbit_connected,
              CASE WHEN EXISTS (SELECT 1 FROM garmin_tokens g WHERE g.user_id = u.id) THEN 1 ELSE 0 END AS garmin_connected
       FROM users u ORDER BY u.id`
    );
    // Convert counts from strings to numbers (pg returns COUNT as string)
    const totalsNum = {
      total_users: parseInt(totals.total_users, 10),
      consented_users: parseInt(totals.consented_users, 10),
      paying_users: parseInt(totals.paying_users, 10),
      fitbit_connected: parseInt(totals.fitbit_connected, 10),
      garmin_connected: parseInt(totals.garmin_connected, 10),
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
      garmin_connected: parseInt(u.garmin_connected, 10),
    }));
    res.json({ totals: totalsNum, users: perUserNum });
  } catch (err) {
    console.error('Trial summary error:', err);
    res.status(500).json({ error: 'Failed to get trial summary' });
  }
});

app.get('/api/admin/users', requireAdminKey, async (req, res) => {
  try {
    const users = await dbAll(
      `SELECT u.id AS user_id,
              u.name,
              u.email,
              u.created_at,
              (SELECT COUNT(*) FROM daily_summaries d WHERE d.user_id = u.id) AS days_synced,
              (SELECT MAX(date) FROM daily_summaries d WHERE d.user_id = u.id) AS last_date,
              CASE WHEN EXISTS (SELECT 1 FROM fitbit_tokens f WHERE f.user_id = u.id) THEN 1 ELSE 0 END AS fitbit_connected,
              CASE WHEN EXISTS (SELECT 1 FROM garmin_tokens g WHERE g.user_id = u.id) THEN 1 ELSE 0 END AS garmin_connected,
              u.subscription_status
       FROM users u ORDER BY u.created_at DESC`
    );
    const usersNum = users.map((u) => ({
      user_id: u.user_id,
      name: u.name,
      email: u.email,
      created_at: u.created_at,
      days_synced: parseInt(u.days_synced, 10),
      last_date: u.last_date,
      fitbit_connected: parseInt(u.fitbit_connected, 10),
      garmin_connected: parseInt(u.garmin_connected, 10),
      subscription_status: u.subscription_status,
    }));
    res.json({ users: usersNum });
  } catch (err) {
    console.error('Admin users error:', err);
    res.status(500).json({ error: 'Failed to get users' });
  }
});

// Symptom logging
// POST /api/symptoms - Save symptoms for today (or a specific date).
// Accepts: { symptoms: ["Tired / poor sleep", "Dizzy"], notes: "...", date: "2026-11-17" (optional, defaults to today) }
app.post('/api/symptoms', authenticateToken, async (req, res) => {
  try {
    const { symptoms, notes, date } = req.body;
    if (!symptoms || !Array.isArray(symptoms) || symptoms.length === 0) {
      return res.status(400).json({ error: 'At least one symptom is required' });
    }
    // Validate symptoms against allowed list
    const allowedSymptoms = [
      'I feel fine',
      'Tired / poor sleep',
      'Dizzy',
      'Short of breath',
      'Chest tightness',
      'Feverish / chills',
      'Nauseous'
    ];
    for (const s of symptoms) {
      if (!allowedSymptoms.includes(s)) {
        return res.status(400).json({ error: `Invalid symptom: ${s}` });
      }
    }
    const loggedDate = date || new Date().toISOString().split('T')[0];
    const symptomsStr = symptoms.join(',');
    const notesStr = notes ? String(notes).slice(0, 500) : '';
    // Upsert: if a log already exists for this date, update it
    await dbRun(
      `INSERT INTO symptom_logs (user_id, logged_date, symptoms, notes)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, logged_date)
       DO UPDATE SET symptoms = EXCLUDED.symptoms, notes = EXCLUDED.notes`,
      [req.user.id, loggedDate, symptomsStr, notesStr]
    );
    res.json({ ok: true, date: loggedDate, symptoms });
  } catch (err) {
    console.error('Save symptoms error:', err);
    res.status(500).json({ error: 'Failed to save symptoms' });
  }
});

// GET /api/symptoms?days=7 - Get recent symptom logs
app.get('/api/symptoms', authenticateToken, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 7, 90);
    const logs = await dbAll(
      `SELECT logged_date, symptoms, notes, created_at
       FROM symptom_logs
       WHERE user_id = $1
       ORDER BY logged_date DESC
       LIMIT $2`,
      [req.user.id, days]
    );
    // Parse symptoms back into arrays
    const parsed = logs.map(log => ({
      date: log.logged_date,
      symptoms: log.symptoms ? log.symptoms.split(',') : [],
      notes: log.notes || '',
      created_at: log.created_at
    }));
    res.json({ logs: parsed });
  } catch (err) {
    console.error('Get symptoms error:', err);
    res.status(500).json({ error: 'Failed to get symptoms' });
  }
});

// Morning sleep check-in
// POST /api/sleep-checkin - Save today's 4-question check-in (upsert by user and date).
// Accepts: { rested: 1-5, body: 1-5, sore: 0-3, yesterday_factors: ["alcohol", "none"] or "alcohol,none" }
app.post('/api/sleep-checkin', authenticateToken, async (req, res) => {
  try {
    const { rested, body, sore, yesterday_factors } = req.body;
    const restedInt = parseInt(rested, 10);
    const bodyInt = parseInt(body, 10);
    const soreInt = parseInt(sore, 10);
    if (!Number.isInteger(restedInt) || restedInt < 1 || restedInt > 5) {
      return res.status(400).json({ error: 'rested must be an integer from 1 to 5' });
    }
    if (!Number.isInteger(bodyInt) || bodyInt < 1 || bodyInt > 5) {
      return res.status(400).json({ error: 'body must be an integer from 1 to 5' });
    }
    if (!Number.isInteger(soreInt) || soreInt < 0 || soreInt > 3) {
      return res.status(400).json({ error: 'sore must be an integer from 0 to 3' });
    }
    const allowedFactors = [
      'alcohol',
      'hard exertion',
      'felt unwell',
      'slept somewhere else',
      'sick people around me',
      'none'
    ];
    let factors = [];
    if (Array.isArray(yesterday_factors)) {
      factors = yesterday_factors.map(f => String(f).trim()).filter(Boolean);
    } else if (typeof yesterday_factors === 'string' && yesterday_factors.trim()) {
      factors = yesterday_factors.split(',').map(f => f.trim()).filter(Boolean);
    }
    for (const f of factors) {
      if (!allowedFactors.includes(f)) {
        return res.status(400).json({ error: `Invalid yesterday factor: ${f}` });
      }
    }
    const checkinDate = new Date().toISOString().split('T')[0];
    const factorsStr = factors.join(',');
    const row = await dbGet(
      `INSERT INTO sleep_checkins (user_id, checkin_date, rested, body, sore, yesterday_factors)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, checkin_date)
       DO UPDATE SET rested = EXCLUDED.rested, body = EXCLUDED.body, sore = EXCLUDED.sore, yesterday_factors = EXCLUDED.yesterday_factors
       RETURNING checkin_date, rested, body, sore, yesterday_factors, created_at`,
      [req.user.id, checkinDate, restedInt, bodyInt, soreInt, factorsStr]
    );
    res.json({
      ok: true,
      checkin: {
        date: row.checkin_date instanceof Date ? row.checkin_date.toISOString().split('T')[0] : String(row.checkin_date).split('T')[0],
        rested: row.rested,
        body: row.body,
        sore: row.sore,
        yesterday_factors: row.yesterday_factors ? row.yesterday_factors.split(',') : [],
        created_at: row.created_at
      }
    });
  } catch (err) {
    console.error('Save sleep check-in error:', err);
    res.status(500).json({ error: 'Failed to save sleep check-in' });
  }
});

// GET /api/sleep-checkin?days=7 - Get recent sleep check-ins
app.get('/api/sleep-checkin', authenticateToken, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 7, 30);
    const rows = await dbAll(
      `SELECT checkin_date, rested, body, sore, yesterday_factors, created_at
       FROM sleep_checkins
       WHERE user_id = $1
       ORDER BY checkin_date DESC
       LIMIT $2`,
      [req.user.id, days]
    );
    const checkins = rows.map(row => ({
      date: row.checkin_date instanceof Date ? row.checkin_date.toISOString().split('T')[0] : String(row.checkin_date).split('T')[0],
      rested: row.rested,
      body: row.body,
      sore: row.sore,
      yesterday_factors: row.yesterday_factors ? row.yesterday_factors.split(',') : [],
      created_at: row.created_at
    }));
    res.json({ checkins });
  } catch (err) {
    console.error('Get sleep check-ins error:', err);
    res.status(500).json({ error: 'Failed to get sleep check-ins' });
  }
});

// ---- Health context endpoints (all optional, all private) ----
// Cycle dates, pregnancies, medications, and altitude are used only to
// adjust detector expectations or to note context on flags. They are
// never shared with family members or emergency contacts, never used
// for advertising, and never sold. Nothing here diagnoses anything.

function toDateStr(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().split('T')[0];
  return String(v).split('T')[0];
}

function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function isFutureDateStr(s) {
  const today = new Date().toISOString().split('T')[0];
  return s > today;
}

// POST /api/cycle - Log a menstrual cycle start date.
// Body: { start_date (required, YYYY-MM-DD, not in future),
//         end_date (optional, YYYY-MM-DD, on or after start_date),
//         notes (optional) }
app.post('/api/cycle', authenticateToken, async (req, res) => {
  try {
    const { start_date, end_date, notes } = req.body;
    if (!isValidDateStr(start_date)) {
      return res.status(400).json({ error: 'start_date must be a valid date (YYYY-MM-DD)' });
    }
    if (isFutureDateStr(start_date)) {
      return res.status(400).json({ error: 'start_date cannot be in the future' });
    }
    if (end_date !== undefined && end_date !== null && end_date !== '') {
      if (!isValidDateStr(end_date) || end_date < start_date) {
        return res.status(400).json({ error: 'end_date must be a valid date on or after start_date' });
      }
    }
    const row = await dbGet(
      `INSERT INTO menstrual_cycles (user_id, start_date, end_date, notes)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, start_date)
       DO UPDATE SET end_date = EXCLUDED.end_date, notes = EXCLUDED.notes
       RETURNING id, start_date, end_date, notes, created_at`,
      [req.user.id, start_date, end_date || null, notes ? String(notes).slice(0, 500) : null]
    );
    // Re-run the detector so the new cycle history adjusts past flags.
    await runDetectorForUser(req.user.id);
    res.json({ ok: true, cycle: { id: row.id, start_date: toDateStr(row.start_date), end_date: toDateStr(row.end_date), notes: row.notes } });
  } catch (err) {
    console.error('Log cycle error:', err);
    res.status(500).json({ error: 'Failed to log cycle' });
  }
});

// GET /api/cycle - Recent cycles plus current phase info.
app.get('/api/cycle', authenticateToken, async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT id, start_date, end_date, notes, created_at
       FROM menstrual_cycles WHERE user_id = $1 ORDER BY start_date DESC LIMIT 12`,
      [req.user.id]
    );
    const cycles = rows.map((r) => ({
      id: r.id,
      start_date: toDateStr(r.start_date),
      end_date: toDateStr(r.end_date),
      notes: r.notes,
    }));
    const today = new Date().toISOString().split('T')[0];
    const info = cycle.currentPhaseInfo(cycles, today);
    res.json({ cycles, currentPhase: info.phase, cycleDay: info.cycleDay, averageCycleLength: info.averageCycleLength });
  } catch (err) {
    console.error('Get cycles error:', err);
    res.status(500).json({ error: 'Failed to get cycles' });
  }
});

// DELETE /api/cycle/:id - Remove a cycle entry.
app.delete('/api/cycle/:id', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid cycle id' });
    await dbRun('DELETE FROM menstrual_cycles WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    await runDetectorForUser(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete cycle error:', err);
    res.status(500).json({ error: 'Failed to delete cycle' });
  }
});

// POST /api/pregnancy - Log a pregnancy.
// Body: { start_date (required, estimated conception or first positive
//         test, YYYY-MM-DD, not in future),
//         due_date (optional, YYYY-MM-DD),
//         end_date (optional, YYYY-MM-DD),
//         status (optional, 'active', 'completed', or 'ended') }
app.post('/api/pregnancy', authenticateToken, async (req, res) => {
  try {
    const { start_date, due_date, end_date, status } = req.body;
    if (!isValidDateStr(start_date)) {
      return res.status(400).json({ error: 'start_date must be a valid date (YYYY-MM-DD)' });
    }
    if (isFutureDateStr(start_date)) {
      return res.status(400).json({ error: 'start_date cannot be in the future' });
    }
    if (due_date !== undefined && due_date !== null && due_date !== '') {
      if (!isValidDateStr(due_date)) {
        return res.status(400).json({ error: 'due_date must be a valid date (YYYY-MM-DD)' });
      }
    }
    if (end_date !== undefined && end_date !== null && end_date !== '') {
      if (!isValidDateStr(end_date) || end_date < start_date) {
        return res.status(400).json({ error: 'end_date must be a valid date on or after start_date' });
      }
    }
    const st = status || 'active';
    if (!['active', 'completed', 'ended'].includes(st)) {
      return res.status(400).json({ error: "status must be active, completed, or ended" });
    }
    const row = await dbGet(
      `INSERT INTO pregnancies (user_id, start_date, due_date, end_date, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, start_date, due_date, end_date, status, created_at`,
      [req.user.id, start_date, due_date || null, end_date || null, st]
    );
    await runDetectorForUser(req.user.id);
    res.json({ ok: true, pregnancy: { id: row.id, start_date: toDateStr(row.start_date), due_date: toDateStr(row.due_date), end_date: toDateStr(row.end_date), status: row.status } });
  } catch (err) {
    console.error('Log pregnancy error:', err);
    res.status(500).json({ error: 'Failed to log pregnancy' });
  }
});

// GET /api/pregnancy - All pregnancies for the user, most recent first.
app.get('/api/pregnancy', authenticateToken, async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT id, start_date, due_date, end_date, status, created_at
       FROM pregnancies WHERE user_id = $1 ORDER BY start_date DESC`,
      [req.user.id]
    );
    res.json({
      pregnancies: rows.map((r) => ({
        id: r.id,
        start_date: toDateStr(r.start_date),
        due_date: toDateStr(r.due_date),
        end_date: toDateStr(r.end_date),
        status: r.status,
      })),
    });
  } catch (err) {
    console.error('Get pregnancies error:', err);
    res.status(500).json({ error: 'Failed to get pregnancies' });
  }
});

// DELETE /api/pregnancy/:id - Remove a pregnancy entry.
app.delete('/api/pregnancy/:id', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid pregnancy id' });
    await dbRun('DELETE FROM pregnancies WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    await runDetectorForUser(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete pregnancy error:', err);
    res.status(500).json({ error: 'Failed to delete pregnancy' });
  }
});

// POST /api/medication - Log a medication.
// Body: { name (required), start_date (required, YYYY-MM-DD, not in
//         future), end_date (optional), dosage (optional text),
//         notes (optional) }
app.post('/api/medication', authenticateToken, async (req, res) => {
  try {
    const { name, start_date, end_date, dosage, notes } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Medication name is required' });
    }
    if (!isValidDateStr(start_date)) {
      return res.status(400).json({ error: 'start_date must be a valid date (YYYY-MM-DD)' });
    }
    if (isFutureDateStr(start_date)) {
      return res.status(400).json({ error: 'start_date cannot be in the future' });
    }
    if (end_date !== undefined && end_date !== null && end_date !== '') {
      if (!isValidDateStr(end_date) || end_date < start_date) {
        return res.status(400).json({ error: 'end_date must be a valid date on or after start_date' });
      }
    }
    const row = await dbGet(
      `INSERT INTO medications (user_id, name, start_date, end_date, dosage, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, start_date, end_date, dosage, notes, created_at`,
      [req.user.id, name.trim().slice(0, 200), start_date, end_date || null, dosage ? String(dosage).slice(0, 200) : null, notes ? String(notes).slice(0, 500) : null]
    );
    await runDetectorForUser(req.user.id);
    res.json({ ok: true, medication: { id: row.id, name: row.name, start_date: toDateStr(row.start_date), end_date: toDateStr(row.end_date), dosage: row.dosage, notes: row.notes } });
  } catch (err) {
    console.error('Log medication error:', err);
    res.status(500).json({ error: 'Failed to log medication' });
  }
});

// GET /api/medication - All medications for the user, most recent first.
app.get('/api/medication', authenticateToken, async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT id, name, start_date, end_date, dosage, notes, created_at
       FROM medications WHERE user_id = $1 ORDER BY start_date DESC`,
      [req.user.id]
    );
    res.json({
      medications: rows.map((r) => ({
        id: r.id,
        name: r.name,
        start_date: toDateStr(r.start_date),
        end_date: toDateStr(r.end_date),
        dosage: r.dosage,
        notes: r.notes,
      })),
    });
  } catch (err) {
    console.error('Get medications error:', err);
    res.status(500).json({ error: 'Failed to get medications' });
  }
});

// DELETE /api/medication/:id - Remove a medication entry.
app.delete('/api/medication/:id', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid medication id' });
    await dbRun('DELETE FROM medications WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    await runDetectorForUser(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete medication error:', err);
    res.status(500).json({ error: 'Failed to delete medication' });
  }
});

// POST /api/altitude - Record the elevation for a day.
// Body: { date (optional, YYYY-MM-DD, defaults to today),
//         altitude_m (required, number from -500 to 9000) }
app.post('/api/altitude', authenticateToken, async (req, res) => {
  try {
    const { date, altitude_m } = req.body;
    const day = date || new Date().toISOString().split('T')[0];
    if (!isValidDateStr(day)) {
      return res.status(400).json({ error: 'date must be a valid date (YYYY-MM-DD)' });
    }
    if (isFutureDateStr(day)) {
      return res.status(400).json({ error: 'date cannot be in the future' });
    }
    const alt = Number(altitude_m);
    if (!Number.isFinite(alt) || alt < -500 || alt > 9000) {
      return res.status(400).json({ error: 'altitude_m must be a number from -500 to 9000' });
    }
    await dbRun(
      `INSERT INTO daily_summaries (user_id, date, altitude_m, signals_present)
       VALUES ($1, $2, $3, 0)
       ON CONFLICT(user_id, date) DO UPDATE SET altitude_m = EXCLUDED.altitude_m`,
      [req.user.id, day, alt]
    );
    await runDetectorForUser(req.user.id);
    res.json({ ok: true, date: day, altitude_m: alt });
  } catch (err) {
    console.error('Log altitude error:', err);
    res.status(500).json({ error: 'Failed to log altitude' });
  }
});

// GET /api/altitude - Recent altitude entries.
app.get('/api/altitude', authenticateToken, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 7, 30);
    const rows = await dbAll(
      `SELECT date, altitude_m FROM daily_summaries
       WHERE user_id = $1 AND altitude_m IS NOT NULL
       ORDER BY date DESC LIMIT $2`,
      [req.user.id, days]
    );
    res.json({ altitudes: rows.map((r) => ({ date: r.date, altitude_m: r.altitude_m })) });
  } catch (err) {
    console.error('Get altitude error:', err);
    res.status(500).json({ error: 'Failed to get altitude' });
  }
});

// Clinician report download
// GET /api/report - Generate a text report for sharing with a clinician
app.get('/api/report', authenticateToken, async (req, res) => {
  try {
    const user = await dbGet('SELECT name, email, created_at FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Get baseline values
    const baselines = await dbAll(
      'SELECT signal, centre, sigma, n FROM baselines WHERE user_id = $1 ORDER BY signal',
      [req.user.id]
    );

    // Get last 30 days of daily summaries
    const days = await dbAll(
      `SELECT date, rhr, hrv, spo2_avg, spo2_min, breathing_rate, sleep_minutes, sleep_efficiency, skin_temp_delta, signals_present
       FROM daily_summaries
       WHERE user_id = $1
       ORDER BY date DESC
       LIMIT 30`,
      [req.user.id]
    );

    // Get episodes
    const episodes = await dbAll(
      `SELECT start_date, end_date, days, is_act, peak_composite, top_signals
       FROM episodes
       WHERE user_id = $1
       ORDER BY start_date DESC
       LIMIT 20`,
      [req.user.id]
    );

    // Get symptom logs (last 30 days)
    const symptoms = await dbAll(
      `SELECT logged_date, symptoms, notes
       FROM symptom_logs
       WHERE user_id = $1
       ORDER BY logged_date DESC
       LIMIT 30`,
      [req.user.id]
    );

    // Calculate data completeness
    const totalDays = days.length;
    const daysWithData = days.filter(d => d.signals_present >= 3).length;
    const completeness = totalDays > 0 ? Math.round((daysWithData / totalDays) * 100) : 0;

    // Build the report
    const lines = [];
    lines.push('H-CAR CLINICIAN REPORT');
    lines.push('========================');
    lines.push('');
    lines.push(`Patient: ${user.name}`);
    lines.push(`Email: ${user.email}`);
    lines.push(`Report generated: ${new Date().toISOString().split('T')[0]}`);
    lines.push(`Account created: ${user.created_at ? user.created_at.split('T')[0] : 'Unknown'}`);
    lines.push('');
    lines.push('IMPORTANT: This report is prepared for discussion with a healthcare professional.');
    lines.push('H-CAR is a general wellness tool, not a medical device. It does not diagnose,');
    lines.push('treat, or monitor any disease or condition. It names changes in wearable data,');
    lines.push('never causes. All interpretations should be made by a qualified clinician.');
    lines.push('');
    lines.push('BASELINE VALUES (Personal Normal)');
    lines.push('----------------------------------');
    if (baselines.length === 0) {
      lines.push('Baseline still learning. A 28-day baseline is required before detection begins.');
    } else {
      for (const b of baselines) {
        const signalNames = {
          rhr: 'Resting Heart Rate',
          hrv: 'Heart Rate Variability (RMSSD)',
          spo2: 'Blood Oxygen (SpO2)',
          breathing: 'Breathing Rate',
          sleep: 'Sleep Duration',
          temp: 'Skin Temperature'
        };
        const name = signalNames[b.signal] || b.signal;
        lines.push(`${name}: ${b.centre.toFixed(1)} (sigma ${b.sigma.toFixed(1)}, n=${b.n} days)`);
      }
    }
    lines.push('');
    lines.push(`DATA COMPLETENESS: ${completeness}% (${daysWithData} of ${totalDays} days with 3+ signals)`);
    lines.push('');
    lines.push('RECENT DAILY SUMMARIES (Last 30 Days)');
    lines.push('---------------------------------------');
    if (days.length === 0) {
      lines.push('No data yet. Connect a Fitbit and sync to see daily summaries.');
    } else {
      for (const d of days) {
        const parts = [`${d.date}:`];
        if (d.rhr) parts.push(`RHR ${d.rhr.toFixed(0)} bpm`);
        if (d.hrv) parts.push(`HRV ${d.hrv.toFixed(1)} ms`);
        if (d.spo2_avg) parts.push(`SpO2 ${d.spo2_avg.toFixed(1)}%`);
        if (d.breathing_rate) parts.push(`Breathing ${d.breathing_rate.toFixed(1)}/min`);
        if (d.sleep_minutes) parts.push(`Sleep ${(d.sleep_minutes / 60).toFixed(1)}h`);
        if (d.skin_temp_delta !== null && d.skin_temp_delta !== undefined) parts.push(`Temp ${d.skin_temp_delta >= 0 ? '+' : ''}${d.skin_temp_delta.toFixed(2)}C`);
        parts.push(`(${d.signals_present || 0} signals)`);
        lines.push(parts.join(' '));
      }
    }
    lines.push('');
    lines.push('EPISODES (Watch and Act Flags)');
    lines.push('-------------------------------');
    if (episodes.length === 0) {
      lines.push('No episodes detected yet.');
    } else {
      for (const e of episodes) {
        const type = e.is_act ? 'ACT' : 'Watch';
        lines.push(`${type}: ${e.start_date} to ${e.end_date} (${e.days} days, peak composite ${e.peak_composite ? e.peak_composite.toFixed(2) : 'N/A'})`);
        if (e.top_signals) {
          try {
            const signals = JSON.parse(e.top_signals);
            if (Array.isArray(signals) && signals.length > 0) {
              lines.push(`  Top signals: ${signals.join(', ')}`);
            }
          } catch (err) {
            // Ignore parse errors
          }
        }
      }
    }
    lines.push('');
    lines.push('SYMPTOM LOGS (Last 30 Days)');
    lines.push('----------------------------');
    if (symptoms.length === 0) {
      lines.push('No symptoms logged yet.');
    } else {
      for (const s of symptoms) {
        lines.push(`${s.logged_date}: ${s.symptoms}`);
        if (s.notes) lines.push(`  Notes: ${s.notes}`);
      }
    }
    lines.push('');
    lines.push('END OF REPORT');
    lines.push('');
    lines.push('This report was generated by H-CAR (Human Condition Analysis & Risk Platform).');
    lines.push('H-CAR is a general wellness tool. It is not a medical device and does not');
    lines.push('provide medical advice, diagnosis, or treatment. Consult a healthcare');
    lines.push('professional for medical advice.');

    const reportText = lines.join('\n');
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="h-car-report-${new Date().toISOString().split('T')[0]}.txt"`);
    res.send(reportText);
  } catch (err) {
    console.error('Generate report error:', err);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

// Data export
// GET /api/export - Export all user data as JSON
app.get('/api/export', authenticateToken, async (req, res) => {
  try {
    const user = await dbGet('SELECT id, name, email, consent_given, consent_date, subscription_status, created_at FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const dailySummaries = await dbAll(
      'SELECT * FROM daily_summaries WHERE user_id = $1 ORDER BY date',
      [req.user.id]
    );
    const detectorResults = await dbAll(
      'SELECT * FROM detector_results WHERE user_id = $1 ORDER BY date',
      [req.user.id]
    );
    const episodes = await dbAll(
      'SELECT * FROM episodes WHERE user_id = $1 ORDER BY start_date',
      [req.user.id]
    );
    const baselines = await dbAll(
      'SELECT * FROM baselines WHERE user_id = $1 ORDER BY signal',
      [req.user.id]
    );
    const symptomLogs = await dbAll(
      'SELECT * FROM symptom_logs WHERE user_id = $1 ORDER BY logged_date',
      [req.user.id]
    );

    const exportData = {
      exported_at: new Date().toISOString(),
      app: 'H-CAR',
      version: '1.2.0',
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        consent_given: user.consent_given,
        consent_date: user.consent_date,
        subscription_status: user.subscription_status,
        created_at: user.created_at
      },
      daily_summaries: dailySummaries,
      detector_results: detectorResults,
      episodes: episodes,
      baselines: baselines,
      symptom_logs: symptomLogs
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="h-car-data-export-${new Date().toISOString().split('T')[0]}.json"`);
    res.json(exportData);
  } catch (err) {
    console.error('Export data error:', err);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

// Settings
// GET /api/settings - Get user settings
app.get('/api/settings', authenticateToken, async (req, res) => {
  try {
    const user = await dbGet('SELECT sensitivity, biological_sex, menopause_status, auto_elevation, theme_preference FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ sensitivity: user.sensitivity || 'balanced', biologicalSex: user.biological_sex || null, menopauseStatus: user.menopause_status || null, autoElevation: !!user.auto_elevation, themePreference: user.theme_preference || 'dark' });
  } catch (err) {
    console.error('Get settings error:', err);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

// PUT /api/settings - Update user settings
app.put('/api/settings', authenticateToken, async (req, res) => {
  try {
    const { sensitivity, biologicalSex } = req.body;
    if (sensitivity !== undefined) {
      const allowed = ['gentle', 'balanced', 'sensitive'];
      if (!allowed.includes(sensitivity)) {
        return res.status(400).json({ error: 'Sensitivity must be gentle, balanced, or sensitive' });
      }
      await dbRun('UPDATE users SET sensitivity = $1 WHERE id = $2', [sensitivity, req.user.id]);
    }
    // Biological sex is optional and private. It is used only to adjust
    // the detector for cycle-related changes. Null clears the value.
    if (biologicalSex !== undefined) {
      const allowedSex = ['male', 'female', 'prefer_not_to_say', null, ''];
      if (!allowedSex.includes(biologicalSex)) {
        return res.status(400).json({ error: 'Biological sex must be male, female, or prefer not to say' });
      }
      const value = biologicalSex === '' ? null : biologicalSex;
      await dbRun('UPDATE users SET biological_sex = $1 WHERE id = $2', [value, req.user.id]);
    }
    // Menopause status is optional and private. It is used only to
    // widen the temperature sigma floor for perimenopausal users.
    // Null clears the value.
    const { menopauseStatus } = req.body;
    if (menopauseStatus !== undefined) {
      const allowedMeno = ['pre', 'peri', 'post', null, ''];
      if (!allowedMeno.includes(menopauseStatus)) {
        return res.status(400).json({ error: 'Menopause status must be pre, peri, or post' });
      }
      const value = menopauseStatus === '' ? null : menopauseStatus;
      await dbRun('UPDATE users SET menopause_status = $1 WHERE id = $2', [value, req.user.id]);
    }
    // Automatic elevation detection is opt-in and off by default.
    // When on, the app looks up ground elevation on the phone and
    // saves only the elevation in metres. Coordinates are never stored.
    const { autoElevation } = req.body;
    if (autoElevation !== undefined) {
      if (typeof autoElevation !== 'boolean') {
        return res.status(400).json({ error: 'autoElevation must be true or false' });
      }
      await dbRun('UPDATE users SET auto_elevation = $1 WHERE id = $2', [autoElevation, req.user.id]);
    }
    // Theme preference: 'dark', 'light', or 'auto' (follow the device).
    // Dark is the default. Unknown values are rejected, never stored.
    const { themePreference } = req.body;
    if (themePreference !== undefined) {
      const allowedThemes = ['dark', 'light', 'auto'];
      if (!allowedThemes.includes(themePreference)) {
        return res.status(400).json({ error: 'themePreference must be dark, light, or auto' });
      }
      await dbRun('UPDATE users SET theme_preference = $1 WHERE id = $2', [themePreference, req.user.id]);
    }
    const updated = await dbGet('SELECT sensitivity, biological_sex, menopause_status, auto_elevation, theme_preference FROM users WHERE id = $1', [req.user.id]);
    res.json({ ok: true, sensitivity: updated.sensitivity || 'balanced', biologicalSex: updated.biological_sex || null, menopauseStatus: updated.menopause_status || null, autoElevation: !!updated.auto_elevation, themePreference: updated.theme_preference || 'dark' });
  } catch (err) {
    console.error('Update settings error:', err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// AI Assistant (simple rule-based version)
// POST /api/assistant/ask - Answer questions about the user's data with real numbers
app.post('/api/assistant/ask', authenticateToken, async (req, res) => {
  try {
    const { question } = req.body;
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return res.status(400).json({ error: 'A question is required' });
    }
    const q = question.toLowerCase().trim();

    // Get user's recent data
    const latestEpisode = await dbGet(
      `SELECT start_date, end_date, days, is_act, peak_composite, top_signals
       FROM episodes WHERE user_id = $1 ORDER BY start_date DESC LIMIT 1`,
      [req.user.id]
    );
    const recentDays = await dbAll(
      `SELECT date, rhr, hrv, spo2_avg, spo2_min, breathing_rate, sleep_minutes, skin_temp_delta, signals_present
       FROM daily_summaries WHERE user_id = $1 ORDER BY date DESC LIMIT 7`,
      [req.user.id]
    );
    const baselines = await dbAll(
      'SELECT signal, centre FROM baselines WHERE user_id = $1',
      [req.user.id]
    );
    const baselineMap = {};
    for (const b of baselines) {
      baselineMap[b.signal] = b.centre;
    }
    const latest = recentDays[0] || null;

    let answer = '';

    // Helper to format a number or return 'not measured'
    const fmt = (v, decimals = 0, suffix = '') => {
      if (v === null || v === undefined) return 'not measured';
      return v.toFixed(decimals) + suffix;
    };

    // Helper to say "today" or "yesterday" based on the date
    const dayWord = (dateStr) => {
      if (!dateStr) return 'your most recent day';
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      if (dateStr === today) return 'today';
      if (dateStr === yesterday) return 'yesterday';
      return 'on ' + dateStr;
    };

    // Resting heart rate questions
    if ((q.includes('resting') || q.includes('heart rate') || q.includes('rhr') || q.includes('pulse')) && !q.includes('baseline')) {
      if (!latest || latest.rhr === null) {
        answer = 'I don\'t have a resting heart rate reading for your most recent day. Make sure your Fitbit is synced.';
      } else {
        const base = baselineMap['resting_hr'];
        let text = `Your resting heart rate ${dayWord(latest.date)} (${latest.date}) was ${Math.round(latest.rhr)} bpm.`;
        if (base) {
          const diff = latest.rhr - base;
          const dir = diff > 0 ? 'above' : diff < 0 ? 'below' : 'at';
          text += ` Your usual baseline is ${Math.round(base)} bpm, so that was ${Math.abs(Math.round(diff))} bpm ${dir} your normal.`;
        }
        // 7-day average
        const rhrVals = recentDays.filter(d => d.rhr !== null).map(d => d.rhr);
        if (rhrVals.length > 1) {
          const avg = rhrVals.reduce((a, b) => a + b, 0) / rhrVals.length;
          text += ` Over the last ${rhrVals.length} days, your average resting heart rate was ${Math.round(avg)} bpm.`;
        }
        answer = text;
      }
    } else if (q.includes('hrv') || q.includes('heart rate variability')) {
      if (!latest || latest.hrv === null) {
        answer = 'I don\'t have an HRV reading for your most recent day. HRV measures how much your heart rate varies between beats, higher usually means better recovery.';
      } else {
        const base = baselineMap['rmssd'];
        let text = `Your HRV ${dayWord(latest.date)} (${latest.date}) was ${Math.round(latest.hrv)} ms. HRV measures recovery, higher is generally better.`;
        if (base) {
          const diff = latest.hrv - base;
          const pct = Math.round((diff / base) * 100);
          text += ` Your usual baseline is ${Math.round(base)} ms, so that was ${Math.abs(pct)}% ${diff > 0 ? 'higher' : 'lower'} than normal.`;
        }
        answer = text;
      }
    } else if (q.includes('sleep')) {
      if (!latest || latest.sleep_minutes === null) {
        answer = 'I don\'t have a sleep reading for your most recent night.';
      } else {
        const hours = Math.floor(latest.sleep_minutes / 60);
        const mins = Math.round(latest.sleep_minutes % 60);
        const base = baselineMap['sleep_duration_h'];
        let text = `You slept ${hours}h ${mins}m (recorded ${latest.date}).`;
        if (base) {
          const baseH = Math.floor(base);
          const baseM = Math.round((base - baseH) * 60);
          const diffMin = latest.sleep_minutes - (base * 60);
          const diffH = Math.floor(Math.abs(diffMin) / 60);
          const diffM = Math.round(Math.abs(diffMin) % 60);
          text += ` Your usual is ${baseH}h ${baseM}m, so you slept ${diffH}h ${diffM}m ${diffMin > 0 ? 'more' : 'less'} than normal.`;
        }
        answer = text;
      }
    } else if (q.includes('oxygen') || q.includes('spo2') || q.includes('spo')) {
      if (!latest || latest.spo2_avg === null) {
        answer = 'I don\'t have a blood oxygen reading for your most recent day.';
      } else {
        const base = baselineMap['spo2'];
        let text = `Your average blood oxygen ${dayWord(latest.date)} was ${latest.spo2_avg.toFixed(1)}%.`;
        if (latest.spo2_min !== null) text += ` Your lowest was ${latest.spo2_min.toFixed(1)}%.`;
        if (base) text += ` Your usual baseline is ${base.toFixed(1)}%.`;
        answer = text;
      }
    } else if (q.includes('breath')) {
      if (!latest || latest.breathing_rate === null) {
        answer = 'I don\'t have a breathing rate reading for your most recent day.';
      } else {
        const base = baselineMap['full_sleep_breathing_rate'];
        let text = `Your breathing rate ${dayWord(latest.date)} was ${latest.breathing_rate.toFixed(1)} breaths per minute.`;
        if (base) text += ` Your usual baseline is ${base.toFixed(1)} per minute.`;
        answer = text;
      }
    } else if (q.includes('temperature') || q.includes('temp')) {
      if (!latest || latest.skin_temp_delta === null) {
        answer = 'I don\'t have a skin temperature reading for your most recent day.';
      } else {
        let text = `Your skin temperature ${dayWord(latest.date)} was ${latest.skin_temp_delta >= 0 ? '+' : ''}${latest.skin_temp_delta.toFixed(2)} degrees from your usual.`;
        if (Math.abs(latest.skin_temp_delta) < 0.3) text += ' That is within your normal range.';
        else if (latest.skin_temp_delta > 0) text += ' That is slightly elevated.';
        else text += ' That is slightly below your normal.';
        answer = text;
      }
    } else if (q.includes('yesterday') || q.includes('last night') || q.includes('latest') || q.includes('recent')) {
      if (!latest) {
        answer = 'I don\'t have any data yet. Connect your Fitbit and sync to start building your baseline.';
      } else {
        const parts = [`Here is your most recent data from ${latest.date}:`];
        if (latest.rhr !== null) parts.push(`Resting heart rate: ${Math.round(latest.rhr)} bpm`);
        if (latest.hrv !== null) parts.push(`HRV: ${Math.round(latest.hrv)} ms`);
        if (latest.spo2_avg !== null) parts.push(`Blood oxygen: ${latest.spo2_avg.toFixed(1)}%`);
        if (latest.breathing_rate !== null) parts.push(`Breathing rate: ${latest.breathing_rate.toFixed(1)}/min`);
        if (latest.sleep_minutes !== null) {
          const h = Math.floor(latest.sleep_minutes / 60);
          const m = Math.round(latest.sleep_minutes % 60);
          parts.push(`Sleep: ${h}h ${m}m`);
        }
        if (latest.skin_temp_delta !== null) parts.push(`Skin temp change: ${latest.skin_temp_delta >= 0 ? '+' : ''}${latest.skin_temp_delta.toFixed(2)} degrees`);
        answer = parts.join(' ');
      }
    } else if (q.includes('alert') || q.includes('flag') || q.includes('why')) {
      if (!latestEpisode) {
        answer = 'You have no alerts yet. All clear! Your signals have stayed within your normal range. H-CAR has not detected any sustained changes from your baseline.';
      } else {
        const type = latestEpisode.is_act ? 'Act' : 'Watch';
        const startDate = latestEpisode.start_date;
        const endDate = latestEpisode.end_date;
        const days = latestEpisode.days;
        let signalsText = '';
        if (latestEpisode.top_signals) {
          try {
            const signals = JSON.parse(latestEpisode.top_signals);
            if (Array.isArray(signals) && signals.length > 0) {
              signalsText = ` The signals that moved most were: ${signals.join(', ')}.`;
            }
          } catch (err) {
            // Ignore parse errors
          }
        }
        answer = `Your most recent ${type} flag was from ${startDate} to ${endDate} (${days} days). This means multiple signals moved away from your baseline at the same time and stayed there.${signalsText} H-CAR names a change, never a cause, so it cannot tell you why this happened, only that it did.`;
      }
    } else if (q.includes('when') && (q.includes('begin') || q.includes('start'))) {
      if (!latestEpisode) {
        answer = 'You have no episodes yet, so there is no start date to report. Your signals have stayed within your normal baseline range.';
      } else {
        answer = `Your most recent episode began on ${latestEpisode.start_date} and lasted ${latestEpisode.days} days, ending on ${latestEpisode.end_date}.`;
      }
    } else if (q.includes('don\'t know') || q.includes('dont know') || q.includes('missing') || q.includes('gap')) {
      const daysWithGaps = recentDays.filter(d => (d.signals_present || 0) < 3).length;
      const totalDays = recentDays.length;
      if (totalDays === 0) {
        answer = 'I don\'t have any data yet. Connect your Fitbit and sync to start building your baseline. H-CAR needs 28 days of data to learn what is normal for you.';
      } else if (daysWithGaps === 0) {
        answer = `Your recent data is complete. All ${totalDays} of the last ${totalDays} days have 3 or more signals. H-CAR can score your data reliably.`;
      } else {
        answer = `In the last ${totalDays} days, ${daysWithGaps} days had fewer than 3 signals. On those days, H-CAR could not score your data because there was not enough information. This is usually because your Fitbit was not worn, did not sync, or the battery died. Missing data is never filled in, H-CAR only works with what it actually measured.`;
      }
    } else if (q.includes('what should') || q.includes('what do') || q.includes('next')) {
      if (!latestEpisode) {
        answer = 'You have no active alerts. Keep wearing your Fitbit, keep logging symptoms if you notice anything, and H-CAR will keep watching. If you feel unwell, seek professional medical care, do not wait for an app.';
      } else if (latestEpisode.is_act) {
        answer = 'You have a recent Act flag. This is a sustained change that H-CAR considers significant. Consider resting, logging your symptoms, and contacting your clinician if you feel unwell. If you have severe symptoms like chest pain, severe breathlessness, fainting, or confusion, call emergency services immediately. Your emergency contact has been alerted by email.';
      } else {
        answer = 'You have a recent Watch flag. This is a change worth noticing, but not an emergency. Rest, hydrate, log your symptoms, and re-check tomorrow. If it continues or worsens, consider contacting your clinician.';
      }
    } else if (q.includes('baseline') || q.includes('normal')) {
      if (baselines.length === 0) {
        answer = 'Your baseline is still learning. H-CAR needs 28 days of Fitbit data to establish what is normal for you. During this time, it watches but does not flag changes.';
      } else {
        const parts = ['Your baseline values are:'];
        const signalNames = {
          resting_hr: 'Resting heart rate',
          rmssd: 'HRV (recovery)',
          spo2: 'Blood oxygen',
          full_sleep_breathing_rate: 'Breathing rate',
          sleep_duration_h: 'Sleep',
          nightly_temperature: 'Skin temperature'
        };
        const units = {
          resting_hr: ' bpm',
          rmssd: ' ms',
          spo2: '%',
          full_sleep_breathing_rate: '/min',
          sleep_duration_h: ' hours',
          nightly_temperature: ' degrees'
        };
        for (const b of baselines) {
          const name = signalNames[b.signal] || b.signal;
          const unit = units[b.signal] || '';
          parts.push(`${name}: ${b.centre.toFixed(1)}${unit}`);
        }
        answer = parts.join(' ');
      }
    } else {
      // Default response - try to give a helpful summary with real numbers
      if (latest) {
        const parts = ['Here is a quick summary of your latest data:'];
        if (latest.rhr !== null) parts.push(`Resting heart rate ${Math.round(latest.rhr)} bpm`);
        if (latest.hrv !== null) parts.push(`HRV ${Math.round(latest.hrv)} ms`);
        if (latest.sleep_minutes !== null) {
          const h = Math.floor(latest.sleep_minutes / 60);
          const m = Math.round(latest.sleep_minutes % 60);
          parts.push(`Sleep ${h}h ${m}m`);
        }
        parts.push('Try asking about your resting heart rate, HRV, sleep, blood oxygen, or alerts for more detail.');
        answer = parts.join(' ');
      } else {
        answer = 'I can help you understand your H-CAR data. Try asking about your resting heart rate, HRV, sleep, blood oxygen, alerts, or baseline. I can only answer from your actual measurements, and I am not a medical professional. For medical advice, consult your clinician.';
      }
    }

    res.json({ answer });
  } catch (err) {
    console.error('Assistant error:', err);
    res.status(500).json({ error: 'Failed to answer question' });
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
  // Alert escalation sweep: every 60 seconds while the server is awake.
  // Each action fires once per alert (the status change guards it), so
  // running often is safe. An external cron should also hit
  // POST /api/admin/process-alerts every few minutes, because the free
  // hosting tier sleeps when idle and the interval stops with it.
  setInterval(() => {
    alertEngine.processEscalations(alertDb, alertContext()).catch((e) => {
      console.error('Escalation sweep failed:', e.message);
    });
  }, 60 * 1000);
  // One sweep at startup, in case alerts timed out while the server slept.
  alertEngine.processEscalations(alertDb, alertContext()).catch((e) => {
    console.error('Startup escalation sweep failed:', e.message);
  });
}).catch((err) => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
