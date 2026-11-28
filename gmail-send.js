// gmail-send.js - Send H-CAR email through the Gmail API (HTTPS) instead
// of SMTP.
//
// Why this exists: the Render host cannot reach smtp.gmail.com:587 at
// all (connection timeout, verified twice on 2026-11-27 via
// /api/admin/smtp-status). The SMTP settings are all present and
// correct, so it is a network problem, not a password problem. The
// Gmail API goes over regular HTTPS, which the host can already do
// (the Fitbit sync uses it), so it avoids the blocked email port.
//
// Scope is least privilege: ONLY https://www.googleapis.com/auth/gmail.send
// (send mail as the signed-in user). No reading mail, no other access.
// The sender is always Talon's account (talonfisher66@gmail.com); the
// setup callback refuses any other Google account.
//
// Auth: a long-lived OAuth refresh token, stored in the Render env var
// GMAIL_REFRESH_TOKEN (never in a file, never logged, never returned
// except once, on the admin-only setup callback page). The token is
// obtained through the one-time setup flow:
//   GET  /api/admin/gmail-auth-url      (admin key) -> Google consent URL
//   GET  /api/admin/gmail-auth-callback (Google redirects here) -> shows
//        the refresh token once, for the parent to paste into Render.
// The same OAuth client as the Fitbit flow is used ("H-CAR Web Client"),
// so the callback redirect URI must be registered for it in Google
// Cloud Console first:
//   https://h-car.onrender.com/api/admin/gmail-auth-callback
//
// The googleapis library refreshes the access token from the refresh
// token automatically, so sending needs no per-call auth work.

const { google } = require('googleapis');
const crypto = require('crypto');

const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const GMAIL_API_TIMEOUT_MS = 30000;
const AUTH_STATE_TTL_MS = 10 * 60 * 1000; // setup link is good for 10 minutes

// ---- Addresses ----

// Bare address from a possibly display-form address ("Name <a@b>" -> "a@b").
function bareAddress(addr) {
  const m = String(addr || '').match(/<([^<>]+)>/);
  return (m ? m[1] : String(addr || '')).trim();
}

// The account that sends H-CAR mail. Env GMAIL_FROM wins, then the SMTP
// from/user settings (same account), then the known account.
function gmailSenderAddress() {
  return bareAddress(
    process.env.GMAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER || 'talonfisher66@gmail.com'
  );
}

// The From header used on sent mail. Keeps the display name when one is
// configured (e.g. "H-CAR <talonfisher66@gmail.com>").
function gmailFromHeader() {
  const from = process.env.GMAIL_FROM || process.env.SMTP_FROM;
  return from ? String(from).trim() : gmailSenderAddress();
}

function gmailRedirectUri() {
  const base = (process.env.BASE_URL || 'https://h-car.onrender.com').replace(/\/$/, '');
  return base + '/api/admin/gmail-auth-callback';
}

function isGmailApiConfigured() {
  return !!(
    process.env.GMAIL_REFRESH_TOKEN &&
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET
  );
}

// ---- OAuth client ----

function getGmailOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    gmailRedirectUri()
  );
}

function getGmailAuthUrl(state) {
  const client = getGmailOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // forces a fresh refresh token even if already granted
    scope: [GMAIL_SEND_SCOPE],
    state,
  });
}

async function exchangeGmailCode(code) {
  const client = getGmailOAuth2Client();
  const { tokens } = await client.getToken(code);
  return tokens; // { access_token, refresh_token, expiry_date, scope, token_type }
}

// ---- One-time setup state ----
// Random, single-use, 10-minute states for the consent flow. In-memory
// only: the setup is completed in one sitting, and a server restart
// simply means requesting a fresh URL. The state is the credential that
// guards the callback page, so it is never logged and never reused.
const authStates = new Map();

function createGmailAuthState() {
  const state = crypto.randomBytes(24).toString('hex');
  authStates.set(state, Date.now());
  return state;
}

function consumeGmailAuthState(state) {
  if (!state || typeof state !== 'string') return false;
  const created = authStates.get(state);
  authStates.delete(state);
  if (!created) return false;
  return Date.now() - created <= AUTH_STATE_TTL_MS;
}

// ---- Message building ----

// RFC 2047 encoded-word for a non-ASCII subject; plain ASCII passes
// through unchanged.
function encodeSubject(subject) {
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;
  return '=?UTF-8?B?' + Buffer.from(subject, 'utf8').toString('base64') + '?=';
}

// Build the RFC 5322 message and base64url-encode it for
// users.messages.send. Plain text, UTF-8.
function buildRawMessage(from, to, subject, text) {
  const lines = [
    'From: ' + from,
    'To: ' + to,
    'Subject: ' + encodeSubject(subject),
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    text,
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

// Test helper: decode a raw message back to readable text.
function decodeRawMessage(raw) {
  return Buffer.from(raw, 'base64url').toString('utf8');
}

// ---- Gmail API calls ----

function gmailClientForTokens(tokens) {
  const client = getGmailOAuth2Client();
  client.setCredentials(tokens);
  return google.gmail({ version: 'v1', auth: client });
}

function gmailClientFromEnv() {
  return gmailClientForTokens({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
}

function apiErrorMessage(e) {
  return (
    (e && e.response && e.response.data && e.response.data.error && e.response.data.error.message) ||
    (e && e.message) ||
    'unknown Gmail API error'
  );
}

// Verify the env refresh token: a getProfile call. Returns the profile
// (emailAddress, messagesTotal). Throws with a plain message on failure.
async function verifyGmailApi() {
  const gmail = gmailClientFromEnv();
  const res = await Promise.race([
    gmail.users.getProfile({ userId: 'me' }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Gmail API check timed out after 30s')), GMAIL_API_TIMEOUT_MS)
    ),
  ]);
  return res.data;
}

// Same check, but with freshly exchanged tokens (used by the setup
// callback to confirm the account before showing the refresh token).
async function getGmailProfile(tokens) {
  const gmail = gmailClientForTokens(tokens);
  const res = await Promise.race([
    gmail.users.getProfile({ userId: 'me' }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Gmail API check timed out after 30s')), GMAIL_API_TIMEOUT_MS)
    ),
  ]);
  return res.data;
}

// Send one email through the Gmail API. Returns { sent: true, via:
// 'gmail-api', id } on success, or { sent: false, reason } on failure.
// Never throws: callers report the returned reason honestly.
// `clientOverride` exists only for tests; production always passes none.
async function sendViaGmailApi(to, subject, text, clientOverride) {
  if (!isGmailApiConfigured() && !clientOverride) {
    return { sent: false, reason: 'Gmail API is not configured (set GMAIL_REFRESH_TOKEN in Render)' };
  }
  const raw = buildRawMessage(gmailFromHeader(), to, subject, text);
  try {
    const gmail = clientOverride || gmailClientFromEnv();
    const res = await Promise.race([
      gmail.users.messages.send({ userId: 'me', requestBody: { raw } }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Gmail API send timed out after 30s')), GMAIL_API_TIMEOUT_MS)
      ),
    ]);
    console.log('Email sent via Gmail API to ' + to + ' (id ' + (res.data && res.data.id) + ')');
    return { sent: true, via: 'gmail-api', id: res.data && res.data.id };
  } catch (e) {
    const detail = apiErrorMessage(e);
    console.error('Gmail API send failed to ' + to + ':', detail);
    return { sent: false, reason: 'Gmail API send failed: ' + detail };
  }
}

module.exports = {
  GMAIL_SEND_SCOPE,
  GMAIL_API_TIMEOUT_MS,
  bareAddress,
  gmailSenderAddress,
  gmailFromHeader,
  gmailRedirectUri,
  isGmailApiConfigured,
  getGmailAuthUrl,
  exchangeGmailCode,
  createGmailAuthState,
  consumeGmailAuthState,
  buildRawMessage,
  decodeRawMessage,
  verifyGmailApi,
  getGmailProfile,
  sendViaGmailApi,
};
