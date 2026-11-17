const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Client, Environment } = require('square');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://web.squarecdn.com", "https://js.squareup.com"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", "https://connect.squareup.com", "https://web.squarecdn.com"],
      frameSrc: ["https://web.squarecdn.com", "https://js.squareup.com"],
      imgSrc: ["'self'", "data:"],
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

// Database
const db = new sqlite3.Database('./hcar.db', (err) => {
  if (err) console.error('Database error:', err);
  else console.log('Connected to SQLite database');
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
});

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
  res.json({ status: 'ok', app: 'H-CAR', version: '1.0.0' });
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
    const hash = await bcrypt.hash(password, 10);
    db.run(
      'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
      [name, email.toLowerCase(), hash],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Email already registered' });
          }
          return res.status(500).json({ error: 'Signup failed' });
        }
        const token = jwt.sign({ id: this.lastID, email: email.toLowerCase() }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, userId: this.lastID, message: 'Account created' });
      }
    );
  } catch (err) {
    res.status(500).json({ error: 'Signup failed' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  db.get('SELECT * FROM users WHERE email = ?', [email.toLowerCase()], async (err, user) => {
    if (err || !user) {
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
  });
});

// Record consent
app.post('/api/consent', authenticateToken, (req, res) => {
  const { acknowledgments } = req.body;
  if (!acknowledgments || !Array.isArray(acknowledgments) || acknowledgments.length !== 10 || !acknowledgments.every(a => a === true)) {
    return res.status(400).json({ error: 'All 10 acknowledgments must be checked' });
  }
  db.run(
    'UPDATE users SET consent_given = 1, consent_date = ? WHERE id = ?',
    [new Date().toISOString(), req.user.id],
    function(err) {
      if (err) return res.status(500).json({ error: 'Failed to record consent' });
      res.json({ message: 'Consent recorded' });
    }
  );
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
  db.get('SELECT * FROM users WHERE id = ?', [req.user.id], async (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User not found' });
    if (!user.consent_given) return res.status(400).json({ error: 'Consent must be given before subscribing' });
    if (user.subscription_status === 'active' && user.square_subscription_id) {
      return res.json({ message: 'Already subscribed', subscriptionId: user.square_subscription_id });
    }
    try {
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
      db.run(
        'UPDATE users SET square_customer_id = ?, square_subscription_id = ?, subscription_status = ?, subscription_period_end = ? WHERE id = ?',
        [customerId, subscription.id, subscription.status.toLowerCase(), subscription.currentPeriodEnd || null, user.id],
        function(err) {
          if (err) return res.status(500).json({ error: 'Failed to save subscription' });
          res.json({
            message: 'Subscription created',
            subscriptionId: subscription.id,
            status: subscription.status
          });
        }
      );
    } catch (err) {
      console.error('Square error:', err);
      res.status(500).json({ error: 'Payment failed: ' + (err.message || 'Unknown error') });
    }
  });
});

// Get user status
app.get('/api/me', authenticateToken, (req, res) => {
  db.get('SELECT id, name, email, consent_given, subscription_status, subscription_period_end, created_at FROM users WHERE id = ?', [req.user.id], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User not found' });
    res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      consentGiven: !!user.consent_given,
      subscriptionStatus: user.subscription_status,
      subscriptionPeriodEnd: user.subscription_period_end,
      createdAt: user.created_at
    });
  });
});

// Cancel subscription
app.post('/api/cancel', authenticateToken, async (req, res) => {
  db.get('SELECT * FROM users WHERE id = ?', [req.user.id], async (err, user) => {
    if (err || !user || !user.square_subscription_id) {
      return res.status(404).json({ error: 'No active subscription' });
    }
    try {
      await squareClient.subscriptionsApi.cancelSubscription(user.square_subscription_id);
      db.run(
        'UPDATE users SET subscription_status = ? WHERE id = ?',
        ['canceled', user.id]
      );
      res.json({ message: 'Subscription canceled. Access continues until end of paid period.' });
    } catch (err) {
      res.status(500).json({ error: 'Cancel failed: ' + err.message });
    }
  });
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`H-CAR server running on port ${PORT}`);
});
