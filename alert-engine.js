// alert-engine.js - Life-saving emergency alert engine for H-CAR.
//
// How it works:
//   1. The detector fires an Act flag. H-CAR creates an alert in state
//      "awaiting_user" and shows the user an "Are you okay?" check-in
//      in the app. The user has 5 minutes to answer.
//   2. "Yes, I'm fine" cancels the alert. Nobody is contacted.
//   3. "No, I need help", or 5 minutes of silence, alerts the primary
//      emergency contact by SMS and email. The contact must acknowledge
//      receipt (tap the link in the message, or reply YES to the text).
//   4. No acknowledgment in 15 minutes escalates to the secondary
//      emergency contact (SMS and email).
//   5. No acknowledgment in 30 minutes total marks the alert
//      "unacknowledged". H-CAR logs a prominent warning that a human
//      should call emergency services, and shows a red banner in the
//      app. H-CAR NEVER calls 911 automatically.
//
// Timing is driven by processEscalations(), which runs every 60 seconds
// while the server is awake, opportunistically on alert-status checks,
// and through POST /api/admin/process-alerts (for an external cron,
// because the free hosting tier sleeps when idle).

const crypto = require('crypto');

const USER_CHECKIN_MS = 5 * 60 * 1000;   // user has 5 minutes to answer "Are you okay?"
const ACK_PRIMARY_MS = 15 * 60 * 1000;   // then escalate to the secondary contact
const ACK_TOTAL_MS = 30 * 60 * 1000;     // then mark unacknowledged (human must call 911)

const ACTIVE_STATUSES = ['awaiting_user', 'alerting', 'escalated', 'unacknowledged'];

const SIGNAL_INFO = {
  resting_hr: { label: 'Resting HR', unit: 'bpm', column: 'rhr', decimals: 0 },
  rmssd: { label: 'HRV', unit: 'ms', column: 'hrv', decimals: 0 },
  spo2: { label: 'Blood oxygen', unit: '%', column: 'spo2_avg', decimals: 1 },
  nightly_temperature: { label: 'Skin temp', unit: 'C', column: 'skin_temp_delta', decimals: 2, signed: true },
  sleep_duration_h: { label: 'Sleep', unit: 'h', column: 'sleep_minutes', decimals: 1, minutesToHours: true },
  full_sleep_breathing_rate: { label: 'Breathing', unit: '/min', column: 'breathing_rate', decimals: 1 },
};

function generateAckToken() {
  return crypto.randomBytes(24).toString('hex');
}

function fmtNum(value, decimals, signed) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  let out = Number(value).toFixed(decimals);
  if (signed && Number(value) > 0) out = '+' + out;
  return out;
}

// Pure state machine: given an alert row and the current time, decide
// the next escalation action. Returns one of:
//   'alert_primary', 'escalate_secondary', 'mark_unacknowledged', 'none'
// Exported for unit tests.
function nextAction(alert, nowMs) {
  const now = nowMs || Date.now();
  if (!alert) return 'none';
  if (alert.status === 'awaiting_user') {
    if (now - new Date(alert.created_at).getTime() >= USER_CHECKIN_MS) return 'alert_primary';
    return 'none';
  }
  if (alert.status === 'alerting' || alert.status === 'escalated') {
    if (!alert.primary_alerted_at) return 'none';
    const sincePrimary = now - new Date(alert.primary_alerted_at).getTime();
    if (sincePrimary >= ACK_TOTAL_MS) return 'mark_unacknowledged';
    if (alert.status === 'alerting' && sincePrimary >= ACK_PRIMARY_MS) {
      return alert.has_secondary ? 'escalate_secondary' : 'none';
    }
    return 'none';
  }
  return 'none';
}

// Build a human-readable vitals summary from the latest daily summary
// and the user's baselines, for the signals that moved most.
// Example: "Resting HR 120 bpm (usual 75), HRV 8 ms (usual 16)".
// Falls back to change scores when no raw values are available.
async function buildVitalsSummary(db, userId, topSignals) {
  try {
    const latest = await db.get(
      'SELECT * FROM daily_summaries WHERE user_id = $1 ORDER BY date DESC LIMIT 1',
      [userId]
    );
    const baselineRows = await db.all(
      'SELECT signal, centre FROM baselines WHERE user_id = $1',
      [userId]
    );
    const centres = {};
    for (const row of baselineRows) centres[row.signal] = row.centre;
    const parts = [];
    const signals = (topSignals && topSignals.length > 0)
      ? topSignals
      : [['resting_hr', 0], ['rmssd', 0], ['spo2', 0]];
    for (const [key] of signals.slice(0, 4)) {
      const info = SIGNAL_INFO[key];
      if (!info) continue;
      let value = latest ? latest[info.column] : null;
      if (value !== null && value !== undefined && info.minutesToHours) value = value / 60;
      const usual = centres[key] !== undefined && centres[key] !== null
        ? (info.minutesToHours ? centres[key] : centres[key])
        : null;
      const vStr = fmtNum(value, info.decimals, info.signed);
      const uStr = fmtNum(usual, info.decimals, info.signed);
      if (vStr !== null && uStr !== null) {
        parts.push(info.label + ' ' + vStr + ' ' + info.unit + ' (usual ' + uStr + ')');
      } else if (vStr !== null) {
        parts.push(info.label + ' ' + vStr + ' ' + info.unit);
      }
    }
    if (parts.length > 0) return parts.join(', ');
  } catch (e) {
    console.error('buildVitalsSummary failed:', e.message);
  }
  return 'several signals moved away from baseline';
}

function formatLocation(user) {
  if (!user.location_sharing_enabled || !user.last_location_lat || !user.last_location_lng) {
    return null;
  }
  const address = user.last_location_address
    ? user.last_location_address
    : 'Lat ' + user.last_location_lat + ', Lng ' + user.last_location_lng;
  const mapsUrl = 'https://www.google.com/maps?q=' + user.last_location_lat + ',' + user.last_location_lng;
  const updated = user.last_location_updated
    ? new Date(user.last_location_updated).toLocaleString()
    : 'unknown time';
  return { address, mapsUrl, updated };
}

// Build the email and SMS text for one contact alert. Pure function,
// exported for unit tests. level is 'primary' or 'secondary'.
function buildAlertMessages(args) {
  const userName = args.userName;
  const contactName = args.contactName || 'there';
  const alert = args.alert;
  const location = args.location || null;
  const vitalsSummary = args.vitalsSummary || 'several signals moved away from baseline';
  const ackUrl = args.ackUrl;
  const isTest = !!args.isTest;
  const level = args.level || 'primary';
  const testTag = isTest ? '[TEST] ' : '';

  const subject = testTag + 'H-CAR alert: ' + userName + ' needs a check-in';

  const lines = [];
  lines.push('Hi ' + contactName + ',');
  lines.push('');
  if (isTest) {
    lines.push('THIS IS A TEST. ' + userName + ' is testing the H-CAR emergency alert system. No action is needed.');
    lines.push('');
  }
  if (level === 'secondary') {
    lines.push('You are the secondary emergency contact for ' + userName + ' on H-CAR. The primary contact did not respond within 15 minutes, so H-CAR is alerting you now.');
  } else {
    lines.push('You are listed as the emergency contact for ' + userName + ' on H-CAR.');
  }
  lines.push('');
  lines.push('H-CAR detected a serious, sustained change from ' + userName + '\'s personal health baseline (an "Act" flag).');
  lines.push('');
  lines.push('  Change detected: ' + (alert.trigger_date || new Date().toISOString().slice(0, 10)));
  if (alert.episode_start && alert.episode_end) {
    lines.push('  Episode: ' + alert.episode_start + ' to ' + alert.episode_end + ' (' + (alert.episode_days || '?') + ' days)');
  }
  lines.push('  Latest readings: ' + vitalsSummary);
  lines.push('');
  if (location) {
    lines.push('Last known location: ' + location.address);
    lines.push('  Map: ' + location.mapsUrl);
    lines.push('  Last updated: ' + location.updated);
    lines.push('');
  }
  lines.push('Please confirm you got this message by tapping this link:');
  lines.push(ackUrl);
  lines.push('');
  lines.push('What this means: ' + userName + '\'s wearable data has moved away from their usual pattern for several days in a row. H-CAR names a change, never a cause. It does not diagnose anything, and it does not monitor in real time.');
  lines.push('');
  lines.push('What to do: check in with ' + userName + ' right away. If they feel unwell, or you cannot reach them and you are worried, call your local emergency number. Do not wait for the app.');
  lines.push('');
  lines.push('This is an automated message from H-CAR (https://h-car.onrender.com). Please do not reply to this email.');

  // SMS must stay short. Keep it under 1500 characters.
  let sms = testTag + 'H-CAR ALERT: ' + userName + ' has a serious health baseline change. ';
  sms += 'Latest: ' + vitalsSummary + '. ';
  if (location) sms += 'Last location: ' + location.address + ' (' + location.mapsUrl + '). ';
  sms += 'Reply YES if you got this, or tap: ' + ackUrl;
  if (sms.length > 1500) sms = sms.slice(0, 1497) + '...';

  return { subject, text: lines.join('\n'), sms };
}

// Normalize a phone number to digits for comparison (last 10 digits).
function normalizePhone(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  return digits.slice(-10);
}

// ---- Database operations (db is { get, all, run }) ----

async function createAlert(db, userId, episode, opts) {
  opts = opts || {};
  const ackToken = generateAckToken();
  const topSignals = episode.top_signals ? JSON.stringify(episode.top_signals) : null;
  const result = await db.run(
    `INSERT INTO alerts
       (user_id, trigger_date, episode_start, episode_end, episode_days,
        top_signals, vitals_summary, status, ack_token, is_test)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'awaiting_user', $8, $9)
     ON CONFLICT(user_id, trigger_date) DO NOTHING
     RETURNING id`,
    [
      userId,
      episode.trigger_date,
      episode.start || null,
      episode.end || null,
      episode.days || null,
      topSignals,
      opts.vitalsSummary || null,
      ackToken,
      opts.isTest ? 1 : 0,
    ]
  );
  if (!result.lastID) return null; // already exists (dedup)
  return db.get('SELECT * FROM alerts WHERE id = $1', [result.lastID]);
}

async function getActiveAlert(db, userId) {
  return db.get(
    `SELECT * FROM alerts WHERE user_id = $1 AND status IN ('awaiting_user','alerting','escalated','unacknowledged')
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
}

async function getAlertById(db, alertId, userId) {
  return db.get('SELECT * FROM alerts WHERE id = $1 AND user_id = $2', [alertId, userId]);
}

async function getAlertHistory(db, userId, limit) {
  const alerts = await db.all(
    'SELECT * FROM alerts WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
    [userId, limit || 20]
  );
  for (const alert of alerts) {
    alert.escalations = await db.all(
      'SELECT * FROM alert_escalations WHERE alert_id = $1 ORDER BY sent_at ASC',
      [alert.id]
    );
  }
  return alerts;
}

async function recordEscalation(db, alertId, level, channel, recipient, result) {
  await db.run(
    'INSERT INTO alert_escalations (alert_id, level, channel, recipient, result) VALUES ($1, $2, $3, $4, $5)',
    [alertId, level, channel, recipient || null, result || null]
  );
}

// Send one contact alert (email + SMS) and record each step.
// ctx: { sendEmail, sendSms, baseUrl, log }
// contact: { name, email, phone }
// Returns { emailed, smsSent }.
async function notifyContact(db, ctx, alert, user, contact, level) {
  const ackUrl = (ctx.baseUrl || 'https://h-car.onrender.com') + '/api/alerts/acknowledge?token=' + alert.ack_token;
  const location = formatLocation(user);
  const messages = buildAlertMessages({
    userName: user.name,
    contactName: contact.name,
    alert,
    location,
    vitalsSummary: alert.vitals_summary,
    ackUrl,
    isTest: alert.is_test === 1,
    level,
  });
  let emailed = false;
  let smsSent = false;
  if (contact.email) {
    const result = await ctx.sendEmail(contact.email, messages.subject, messages.text);
    emailed = !!result.sent;
    await recordEscalation(db, alert.id, level, 'email', contact.email, emailed ? 'sent' : ('failed: ' + (result.reason || 'unknown')));
    if (ctx.log) ctx.log('Alert ' + alert.id + ' ' + level + ' email to ' + contact.email + ': ' + (emailed ? 'sent' : 'FAILED ' + (result.reason || '')));
  }
  if (contact.phone) {
    const result = await ctx.sendSms(contact.phone, messages.sms);
    smsSent = !!result.sent;
    await recordEscalation(db, alert.id, level, 'sms', contact.phone, smsSent ? 'sent' : ('failed: ' + (result.reason || 'unknown')));
    if (ctx.log) ctx.log('Alert ' + alert.id + ' ' + level + ' SMS to ' + contact.phone + ': ' + (smsSent ? 'sent' : 'FAILED ' + (result.reason || '')));
  }
  return { emailed, smsSent };
}

function primaryContactOf(user) {
  return {
    name: user.emergency_contact_name,
    email: user.emergency_contact_email,
    phone: user.emergency_contact_phone,
    relationship: user.emergency_contact_relationship,
  };
}

function secondaryContactOf(user) {
  return {
    name: user.secondary_contact_name,
    email: user.secondary_contact_email,
    phone: user.secondary_contact_phone,
    relationship: user.secondary_contact_relationship,
  };
}

function hasContact(contact) {
  return !!(contact && (contact.email || contact.phone));
}

// Alert the primary contact now. Sets status to 'alerting'.
async function alertPrimary(db, ctx, alert, user) {
  const contact = primaryContactOf(user);
  if (!hasContact(contact)) {
    await db.run("UPDATE alerts SET status = 'unacknowledged' WHERE id = $1", [alert.id]);
    if (ctx.log) ctx.log('ALERT ' + alert.id + ': no primary emergency contact on file. Marked unacknowledged. User ' + user.id + ' (' + user.name + ') needs a human to check on them.');
    return { contacted: false, reason: 'no primary contact on file' };
  }
  const result = await notifyContact(db, ctx, alert, user, contact, 'primary');
  await db.run("UPDATE alerts SET status = 'alerting', primary_alerted_at = CURRENT_TIMESTAMP WHERE id = $1", [alert.id]);
  return { contacted: true, ...result };
}

// Escalate to the secondary contact. Sets status to 'escalated'.
async function alertSecondary(db, ctx, alert, user) {
  const contact = secondaryContactOf(user);
  if (!hasContact(contact)) return { contacted: false, reason: 'no secondary contact on file' };
  const result = await notifyContact(db, ctx, alert, user, contact, 'secondary');
  await db.run("UPDATE alerts SET status = 'escalated', secondary_alerted_at = CURRENT_TIMESTAMP, escalated_at = CURRENT_TIMESTAMP WHERE id = $1", [alert.id]);
  return { contacted: true, ...result };
}

// No acknowledgment within 30 minutes. H-CAR never calls 911 itself;
// this marks the alert so a human sees the warning and calls.
async function markUnacknowledged(db, ctx, alert, user) {
  await db.run("UPDATE alerts SET status = 'unacknowledged' WHERE id = $1", [alert.id]);
  await recordEscalation(db, alert.id, 'unacknowledged', 'system', null, 'No acknowledgment in 30 minutes. A human should call emergency services.');
  if (ctx.log) ctx.log('*** ALERT ' + alert.id + ' UNACKNOWLEDGED *** User ' + user.id + ' (' + user.name + ') had an Act flag and NO emergency contact acknowledged within 30 minutes. A human should check on them and call emergency services if they cannot be reached. ***');
  return { marked: true };
}

// Record the user's answer to "Are you okay?".
// response: 'fine' cancels the alert, 'need_help' alerts the primary contact now.
// Returns { ok, status } or { ok: false, error }.
async function recordUserResponse(db, ctx, alert, user, response) {
  if (!alert || alert.status !== 'awaiting_user') {
    return { ok: false, error: 'This alert is no longer waiting for your answer.' };
  }
  if (response === 'fine') {
    await db.run(
      "UPDATE alerts SET status = 'cancelled_by_user', user_response = 'fine', user_responded_at = CURRENT_TIMESTAMP, resolved_at = CURRENT_TIMESTAMP WHERE id = $1",
      [alert.id]
    );
    await recordEscalation(db, alert.id, 'user', 'app', null, 'User answered: I am fine. Alert cancelled.');
    return { ok: true, status: 'cancelled_by_user' };
  }
  if (response === 'need_help') {
    await db.run(
      "UPDATE alerts SET user_response = 'need_help', user_responded_at = CURRENT_TIMESTAMP WHERE id = $1",
      [alert.id]
    );
    await recordEscalation(db, alert.id, 'user', 'app', null, 'User answered: I need help. Alerting primary contact now.');
    const fresh = await db.get('SELECT * FROM alerts WHERE id = $1', [alert.id]);
    const result = await alertPrimary(db, ctx, fresh, user);
    return { ok: true, status: 'alerting', contacted: result.contacted };
  }
  return { ok: false, error: 'Unknown response. Use "fine" or "need_help".' };
}

// Acknowledge an alert by its token (link tap or SMS reply).
// Returns { ok, alert } or { ok: false, error }.
async function acknowledgeByToken(db, token, by) {
  const alert = await db.get(
    "SELECT * FROM alerts WHERE ack_token = $1 AND status IN ('alerting','escalated','unacknowledged')",
    [token]
  );
  if (!alert) return { ok: false, error: 'That acknowledgment link is not valid for an active alert.' };
  await db.run(
    "UPDATE alerts SET status = 'acknowledged', acknowledged_at = CURRENT_TIMESTAMP, acknowledged_by = $2, resolved_at = CURRENT_TIMESTAMP WHERE id = $1",
    [alert.id, by || 'contact']
  );
  await recordEscalation(db, alert.id, 'acknowledged', 'link', by || null, 'Emergency contact confirmed receipt.');
  const fresh = await db.get('SELECT * FROM alerts WHERE id = $1', [alert.id]);
  return { ok: true, alert: fresh };
}

// The escalation sweep. Finds every alert in an active state, decides
// the next action from the clock, and acts. Safe to run often; each
// action only fires once per alert because the status changes.
// Returns a summary of what happened.
async function processEscalations(db, ctx) {
  const now = Date.now();
  const active = await db.all(
    `SELECT a.*, u.name AS user_name, u.email AS user_email,
            u.emergency_contact_name, u.emergency_contact_email, u.emergency_contact_phone,
            u.secondary_contact_name, u.secondary_contact_email, u.secondary_contact_phone,
            u.location_sharing_enabled, u.last_location_lat, u.last_location_lng,
            u.last_location_address, u.last_location_updated
     FROM alerts a JOIN users u ON u.id = a.user_id
     WHERE a.status IN ('awaiting_user','alerting','escalated')
     ORDER BY a.created_at ASC`
  );
  const summary = { checked: active.length, alertedPrimary: 0, escalatedSecondary: 0, markedUnacknowledged: 0, actions: [] };
  for (const row of active) {
    const user = {
      id: row.user_id,
      name: row.user_name,
      email: row.user_email,
      emergency_contact_name: row.emergency_contact_name,
      emergency_contact_email: row.emergency_contact_email,
      emergency_contact_phone: row.emergency_contact_phone,
      secondary_contact_name: row.secondary_contact_name,
      secondary_contact_email: row.secondary_contact_email,
      secondary_contact_phone: row.secondary_contact_phone,
      location_sharing_enabled: row.location_sharing_enabled,
      last_location_lat: row.last_location_lat,
      last_location_lng: row.last_location_lng,
      last_location_address: row.last_location_address,
      last_location_updated: row.last_location_updated,
    };
    const alert = { ...row, has_secondary: hasContact(secondaryContactOf(user)) };
    const action = nextAction(alert, now);
    try {
      if (action === 'alert_primary') {
        await alertPrimary(db, ctx, alert, user);
        summary.alertedPrimary += 1;
        summary.actions.push({ alertId: alert.id, action: 'alert_primary' });
      } else if (action === 'escalate_secondary') {
        await alertSecondary(db, ctx, alert, user);
        summary.escalatedSecondary += 1;
        summary.actions.push({ alertId: alert.id, action: 'escalate_secondary' });
      } else if (action === 'mark_unacknowledged') {
        await markUnacknowledged(db, ctx, alert, user);
        summary.markedUnacknowledged += 1;
        summary.actions.push({ alertId: alert.id, action: 'mark_unacknowledged' });
      }
    } catch (e) {
      console.error('Escalation sweep failed for alert ' + alert.id + ':', e.message);
    }
  }
  return summary;
}

module.exports = {
  USER_CHECKIN_MS,
  ACK_PRIMARY_MS,
  ACK_TOTAL_MS,
  ACTIVE_STATUSES,
  SIGNAL_INFO,
  generateAckToken,
  nextAction,
  buildVitalsSummary,
  formatLocation,
  buildAlertMessages,
  normalizePhone,
  createAlert,
  getActiveAlert,
  getAlertById,
  getAlertHistory,
  recordEscalation,
  notifyContact,
  primaryContactOf,
  secondaryContactOf,
  hasContact,
  alertPrimary,
  alertSecondary,
  markUnacknowledged,
  recordUserResponse,
  acknowledgeByToken,
  processEscalations,
};
