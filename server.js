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

    // Sensitivity setting (gentle, balanced, sensitive). Default balanced.
    // Gentle requires 4 signals for Watch (fewer alerts). Sensitive requires 2 signals (more alerts).
    // Balanced requires 3 signals (the tested default).
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS sensitivity TEXT DEFAULT 'balanced'`);

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

// ---- Emergency contact endpoints ----
// The person H-CAR alerts by email when an Act flag fires. Watch flags
// never alert anyone; only Act reaches another human.

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

app.get('/api/emergency-contact', authenticateToken, async (req, res) => {
  try {
    const user = await dbGet('SELECT emergency_contact_name, emergency_contact_email, emergency_contact_phone, emergency_contact_relationship, location_sharing_enabled, last_location_lat, last_location_lng, last_location_address, last_location_updated FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      name: user.emergency_contact_name || null,
      email: user.emergency_contact_email || null,
      phone: user.emergency_contact_phone || null,
      relationship: user.emergency_contact_relationship || null,
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
    const name = (req.body.name || '').trim();
    const email = (req.body.email || '').trim();
    const phone = (req.body.phone || '').trim();
    const relationship = (req.body.relationship || '').trim();
    // All fields blank clears the contact.
    if (!name && !email && !phone && !relationship) {
      await dbRun('UPDATE users SET emergency_contact_name = NULL, emergency_contact_email = NULL, emergency_contact_phone = NULL, emergency_contact_relationship = NULL WHERE id = $1', [req.user.id]);
      return res.json({ message: 'Emergency contact removed.', contact: { name: null, email: null, phone: null, relationship: null } });
    }
    if (!name) return res.status(400).json({ error: 'Please enter your contact\'s name.' });
    if (!email) return res.status(400).json({ error: 'Please enter your contact\'s email address. Alerts are sent by email.' });
    if (!isValidEmail(email)) return res.status(400).json({ error: 'That email address does not look valid.' });
    await dbRun(
      'UPDATE users SET emergency_contact_name = $1, emergency_contact_email = $2, emergency_contact_phone = $3, emergency_contact_relationship = $4 WHERE id = $5',
      [name, email, phone || null, relationship || null, req.user.id]
    );
    res.json({ message: 'Emergency contact saved.', contact: { name, email, phone: phone || null, relationship: relationship || null } });
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
    const result = await sendEmail(user.emergency_contact_email, subject, text);
    if (!result.sent) {
      return res.status(503).json({ error: 'Test alert could not be sent: ' + result.reason });
    }
    res.json({ message: 'Test alert sent to ' + user.emergency_contact_email + '.' });
  } catch (err) {
    console.error('Test alert error:', err);
    res.status(500).json({ error: 'Failed to send test alert' });
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

async function sendActAlert(user, episode) {
  const contactName = user.emergency_contact_name || 'there';
  const signals = describeTopSignals(episode.top_signals);
  const subject = 'H-CAR alert: ' + user.name + ' has a serious baseline change';
  
  // Build the email text
  const textParts = [
    'Hi ' + contactName + ',',
    '',
    'You are listed as the emergency contact for ' + user.name + ' on H-CAR.',
    '',
    'H-CAR detected a serious, sustained change from ' + user.name + '\'s personal health baseline (an "Act" flag).',
    '',
    '  Change detected: ' + episode.trigger_date,
    '  Episode: ' + episode.start + ' to ' + episode.end + ' (' + episode.days + ' days)',
    '  Signals that moved most: ' + signals,
    '',
  ];

  // Include last known location if user opted into emergency-only location sharing
  if (user.location_sharing_enabled && user.last_location_lat && user.last_location_lng) {
    const locationStr = user.last_location_address 
      ? user.last_location_address 
      : 'Lat: ' + user.last_location_lat + ', Lng: ' + user.last_location_lng;
    const updatedStr = user.last_location_updated 
      ? new Date(user.last_location_updated).toLocaleString() 
      : 'Unknown';
    textParts.push('Last known location: ' + locationStr);
    textParts.push('  Coordinates: ' + user.last_location_lat + ', ' + user.last_location_lng);
    textParts.push('  Last updated: ' + updatedStr);
    textParts.push('');
  }

  textParts.push('What this means: ' + user.name + '\'s wearable data has moved away from their usual pattern for several days in a row. H-CAR names a change, never a cause. It does not diagnose anything, and it does not monitor in real time.');
  textParts.push('');
  textParts.push('What to do: check in with ' + user.name + '. If they feel unwell, or you cannot reach them and you are worried, call your local emergency number. Do not wait for the app.');
  textParts.push('');
  textParts.push('This is an automated message from H-CAR (https://h-car.onrender.com). Please do not reply to this email.');

  const text = textParts.join('\n');
  return sendEmail(user.emergency_contact_email, subject, text);
}

// Send an alert for each Act episode that has not been alerted yet.
// Deduplicated by (user, trigger date) in alerts_sent, because the
// detector re-creates all episodes on every sync. Failures are not
// recorded, so the next sync retries. Returns { checked, sent }.
async function maybeSendActAlerts(userId, mergedEpisodes) {
  const actEpisodes = (mergedEpisodes || []).filter((e) => e.is_act && e.trigger_date);
  if (actEpisodes.length === 0) return { checked: 0, sent: 0 };
  const user = await dbGet('SELECT id, name, email, emergency_contact_name, emergency_contact_email, emergency_contact_phone, emergency_contact_relationship, location_sharing_enabled, last_location_lat, last_location_lng, last_location_address, last_location_updated FROM users WHERE id = $1', [userId]);
  if (!user || !user.emergency_contact_email) {
    console.log('Act alert skipped for user ' + userId + ': no emergency contact email on file.');
    return { checked: actEpisodes.length, sent: 0 };
  }
  let sent = 0;
  for (const ep of actEpisodes) {
    const already = await dbGet('SELECT 1 AS x FROM alerts_sent WHERE user_id = $1 AND trigger_date = $2', [userId, ep.trigger_date]);
    if (already) continue;
    const result = await sendActAlert(user, ep);
    if (result.sent) {
      await dbRun(
        'INSERT INTO alerts_sent (user_id, trigger_date, sent_at, recipient_email, status) VALUES ($1, $2, $3, $4, $5) ON CONFLICT(user_id, trigger_date) DO NOTHING',
        [userId, ep.trigger_date, new Date().toISOString(), user.emergency_contact_email, 'sent']
      );
      sent += 1;
      console.log('Act alert sent for user ' + userId + ' (trigger ' + ep.trigger_date + ') to ' + user.emergency_contact_email + '.');
    } else {
      console.log('Act alert NOT sent for user ' + userId + ' (trigger ' + ep.trigger_date + '): ' + result.reason);
    }
  }
  return { checked: actEpisodes.length, sent };
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

  // Alert the emergency contact about any new Act episode (deduped by
  // trigger date in alerts_sent). Never blocks the sync: failures are
  // logged and retried on the next sync.
  let alertsSent = 0;
  try {
    const alertResult = await maybeSendActAlerts(userId, det.mergedEpisodes);
    alertsSent = alertResult.sent;
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
    const user = await dbGet('SELECT sensitivity FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ sensitivity: user.sensitivity || 'balanced' });
  } catch (err) {
    console.error('Get settings error:', err);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

// PUT /api/settings - Update user settings
app.put('/api/settings', authenticateToken, async (req, res) => {
  try {
    const { sensitivity } = req.body;
    if (sensitivity !== undefined) {
      const allowed = ['gentle', 'balanced', 'sensitive'];
      if (!allowed.includes(sensitivity)) {
        return res.status(400).json({ error: 'Sensitivity must be gentle, balanced, or sensitive' });
      }
      await dbRun('UPDATE users SET sensitivity = $1 WHERE id = $2', [sensitivity, req.user.id]);
    }
    res.json({ ok: true, sensitivity: sensitivity || 'balanced' });
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

    // Resting heart rate questions
    if ((q.includes('resting') || q.includes('heart rate') || q.includes('rhr') || q.includes('pulse')) && !q.includes('baseline')) {
      if (!latest || latest.rhr === null) {
        answer = 'I don\'t have a resting heart rate reading for your most recent day. Make sure your Fitbit is synced.';
      } else {
        const base = baselineMap['resting_hr'];
        let text = `Your resting heart rate yesterday (${latest.date}) was ${Math.round(latest.rhr)} bpm.`;
        if (base) {
          const diff = latest.rhr - base;
          const dir = diff > 0 ? 'above' : diff < 0 ? 'below' : 'at';
          text += ` Your usual baseline is ${Math.round(base)} bpm, so yesterday was ${Math.abs(Math.round(diff))} bpm ${dir} your normal.`;
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
        let text = `Your HRV yesterday (${latest.date}) was ${Math.round(latest.hrv)} ms. HRV measures recovery, higher is generally better.`;
        if (base) {
          const diff = latest.hrv - base;
          const pct = Math.round((diff / base) * 100);
          text += ` Your usual baseline is ${Math.round(base)} ms, so yesterday was ${Math.abs(pct)}% ${diff > 0 ? 'higher' : 'lower'} than normal.`;
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
        let text = `You slept ${hours}h ${mins}m on the night of ${latest.date}.`;
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
        let text = `Your average blood oxygen yesterday was ${latest.spo2_avg.toFixed(1)}%.`;
        if (latest.spo2_min !== null) text += ` Your lowest was ${latest.spo2_min.toFixed(1)}%.`;
        if (base) text += ` Your usual baseline is ${base.toFixed(1)}%.`;
        answer = text;
      }
    } else if (q.includes('breath')) {
      if (!latest || latest.breathing_rate === null) {
        answer = 'I don\'t have a breathing rate reading for your most recent day.';
      } else {
        const base = baselineMap['full_sleep_breathing_rate'];
        let text = `Your breathing rate yesterday was ${latest.breathing_rate.toFixed(1)} breaths per minute.`;
        if (base) text += ` Your usual baseline is ${base.toFixed(1)} per minute.`;
        answer = text;
      }
    } else if (q.includes('temperature') || q.includes('temp')) {
      if (!latest || latest.skin_temp_delta === null) {
        answer = 'I don\'t have a skin temperature reading for your most recent day.';
      } else {
        let text = `Your skin temperature yesterday was ${latest.skin_temp_delta >= 0 ? '+' : ''}${latest.skin_temp_delta.toFixed(2)} degrees from your usual.`;
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

    // Always add disclaimer
    answer += '\n\nThis is not medical advice. H-CAR is a general wellness tool, not a medical device. It does not diagnose or treat any condition. If you feel unwell, seek professional medical care.';

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
}).catch((err) => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
