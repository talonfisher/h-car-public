// test-alerts.js - Unit tests for the H-CAR life-saving alert engine.
// Run: node test-alerts.js
// No database needed: pure functions plus an in-memory mock DB.
const assert = require('assert');
const engine = require('./alert-engine');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      return out.then(() => { passed += 1; console.log('PASS ' + name); })
        .catch((e) => { failed += 1; console.log('FAIL ' + name + ': ' + e.message); });
    }
    passed += 1;
    console.log('PASS ' + name);
  } catch (e) {
    failed += 1;
    console.log('FAIL ' + name + ': ' + e.message);
  }
  return Promise.resolve();
}

// ---- In-memory mock DB implementing { get, all, run } for the engine ----
function makeMockDb() {
  const tables = { alerts: [], alert_escalations: [], daily_summaries: [], baselines: [], users: [] };
  let nextId = 1;
  const db = {
    tables,
    async get(sql, params) {
      if (sql.includes('FROM alerts WHERE id')) {
        return tables.alerts.find((a) => a.id === params[0]) || null;
      }
      if (sql.includes('FROM alerts WHERE ack_token')) {
        return tables.alerts.find((a) => a.ack_token === params[0] && ['alerting', 'escalated', 'unacknowledged'].includes(a.status)) || null;
      }
      if (sql.includes('FROM alerts WHERE user_id') && sql.includes('status IN')) {
        const act = tables.alerts.filter((a) => a.user_id === params[0] && ['awaiting_user', 'alerting', 'escalated', 'unacknowledged'].includes(a.status));
        act.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        return act[0] || null;
      }
      if (sql.includes('FROM daily_summaries')) {
        const rows = tables.daily_summaries.filter((r) => r.user_id === params[0]);
        rows.sort((a, b) => (a.date < b.date ? 1 : -1));
        return rows[0] || null;
      }
      return null;
    },
    async all(sql, params) {
      if (sql.includes('FROM baselines')) return tables.baselines.filter((r) => r.user_id === params[0]);
      if (sql.includes('FROM alert_escalations')) return tables.alert_escalations.filter((r) => r.alert_id === params[0]);
      if (sql.includes('FROM alerts a JOIN users')) {
        return tables.alerts
          .filter((a) => ['awaiting_user', 'alerting', 'escalated'].includes(a.status))
          .map((a) => ({ ...a, ...(tables.users.find((u) => u.id === a.user_id) || {}) }));
      }
      if (sql.includes('FROM alerts WHERE user_id')) {
        return tables.alerts.filter((a) => a.user_id === params[0]).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      }
      return [];
    },
    async run(sql, params) {
      if (sql.includes('INSERT INTO alerts')) {
        const existing = tables.alerts.find((a) => a.user_id === params[0] && a.trigger_date === params[1]);
        if (existing) return { lastID: undefined, changes: 0 };
        const row = {
          id: nextId++, user_id: params[0], trigger_date: params[1],
          episode_start: params[2], episode_end: params[3], episode_days: params[4],
          top_signals: params[5], vitals_summary: params[6], status: 'awaiting_user',
          ack_token: params[7], is_test: params[8],
          created_at: new Date().toISOString(),
          user_response: null, user_responded_at: null, primary_alerted_at: null,
          secondary_alerted_at: null, acknowledged_at: null, acknowledged_by: null,
          escalated_at: null, resolved_at: null,
        };
        tables.alerts.push(row);
        return { lastID: row.id, changes: 1 };
      }
      if (sql.includes('INSERT INTO alert_escalations')) {
        tables.alert_escalations.push({ id: nextId++, alert_id: params[0], level: params[1], channel: params[2], recipient: params[3], result: params[4], sent_at: new Date().toISOString() });
        return { changes: 1 };
      }
      if (sql.startsWith("UPDATE alerts SET status = 'alerting'")) {
        const a = tables.alerts.find((x) => x.id === params[0]);
        if (a) { a.status = 'alerting'; a.primary_alerted_at = new Date().toISOString(); }
        return { changes: 1 };
      }
      if (sql.startsWith("UPDATE alerts SET status = 'escalated'")) {
        const a = tables.alerts.find((x) => x.id === params[0]);
        if (a) { a.status = 'escalated'; a.secondary_alerted_at = new Date().toISOString(); a.escalated_at = new Date().toISOString(); }
        return { changes: 1 };
      }
      if (sql.startsWith("UPDATE alerts SET status = 'unacknowledged'")) {
        const a = tables.alerts.find((x) => x.id === params[0]);
        if (a) a.status = 'unacknowledged';
        return { changes: 1 };
      }
      if (sql.includes("status = 'cancelled_by_user'")) {
        const a = tables.alerts.find((x) => x.id === params[0]);
        if (a) { a.status = 'cancelled_by_user'; a.user_response = 'fine'; a.user_responded_at = new Date().toISOString(); a.resolved_at = new Date().toISOString(); }
        return { changes: 1 };
      }
      if (sql.includes("user_response = 'need_help'")) {
        const a = tables.alerts.find((x) => x.id === params[0]);
        if (a) { a.user_response = 'need_help'; a.user_responded_at = new Date().toISOString(); }
        return { changes: 1 };
      }
      if (sql.includes("status = 'acknowledged'")) {
        const a = tables.alerts.find((x) => x.id === params[0]);
        if (a) { a.status = 'acknowledged'; a.acknowledged_by = params[1]; a.acknowledged_at = new Date().toISOString(); a.resolved_at = new Date().toISOString(); }
        return { changes: 1 };
      }
      return { changes: 0 };
    },
  };
  return db;
}

function makeUser(overrides) {
  return Object.assign({
    id: 1, name: 'Talon Fisher', email: 'tfcontracting@shaw.ca',
    emergency_contact_name: 'Meagan Fisher',
    emergency_contact_email: 'meaganbourquin@gmail.com',
    emergency_contact_phone: '(250) 218-1784',
    emergency_contact_relationship: 'Wife',
    secondary_contact_name: 'Denise Bourquin',
    secondary_contact_email: 'denise@example.com',
    secondary_contact_phone: '(250) 555-0100',
    secondary_contact_relationship: 'Mother-in-law',
    location_sharing_enabled: true,
    last_location_lat: 49.6869, last_location_lng: -124.9977,
    last_location_address: '4314 Minto Road, Courtenay, BC',
    last_location_updated: new Date().toISOString(),
  }, overrides || {});
}

function makeCtx(sent) {
  return {
    sendEmail: async (to, subject, text) => { sent.push({ channel: 'email', to, subject, text }); return { sent: true }; },
    sendSms: async (to, body) => { sent.push({ channel: 'sms', to, body }); return { sent: true }; },
    baseUrl: 'https://h-car.onrender.com',
    log: () => {},
  };
}

async function main() {
  const now = Date.now();

  await test('nextAction: awaiting_user inside 5 min window -> none', () => {
    const a = { status: 'awaiting_user', created_at: new Date(now - 4 * 60 * 1000).toISOString() };
    assert.strictEqual(engine.nextAction(a, now), 'none');
  });

  await test('nextAction: awaiting_user past 5 min -> alert_primary', () => {
    const a = { status: 'awaiting_user', created_at: new Date(now - 6 * 60 * 1000).toISOString() };
    assert.strictEqual(engine.nextAction(a, now), 'alert_primary');
  });

  await test('nextAction: alerting at 10 min -> none', () => {
    const a = { status: 'alerting', primary_alerted_at: new Date(now - 10 * 60 * 1000).toISOString(), has_secondary: true };
    assert.strictEqual(engine.nextAction(a, now), 'none');
  });

  await test('nextAction: alerting at 16 min with secondary -> escalate_secondary', () => {
    const a = { status: 'alerting', primary_alerted_at: new Date(now - 16 * 60 * 1000).toISOString(), has_secondary: true };
    assert.strictEqual(engine.nextAction(a, now), 'escalate_secondary');
  });

  await test('nextAction: alerting at 16 min without secondary -> none', () => {
    const a = { status: 'alerting', primary_alerted_at: new Date(now - 16 * 60 * 1000).toISOString(), has_secondary: false };
    assert.strictEqual(engine.nextAction(a, now), 'none');
  });

  await test('nextAction: alerting at 31 min -> mark_unacknowledged', () => {
    const a = { status: 'alerting', primary_alerted_at: new Date(now - 31 * 60 * 1000).toISOString(), has_secondary: true };
    assert.strictEqual(engine.nextAction(a, now), 'mark_unacknowledged');
  });

  await test('nextAction: escalated at 31 min -> mark_unacknowledged', () => {
    const a = { status: 'escalated', primary_alerted_at: new Date(now - 31 * 60 * 1000).toISOString(), has_secondary: true };
    assert.strictEqual(engine.nextAction(a, now), 'mark_unacknowledged');
  });

  await test('nextAction: acknowledged/cancelled -> none', () => {
    assert.strictEqual(engine.nextAction({ status: 'acknowledged' }, now), 'none');
    assert.strictEqual(engine.nextAction({ status: 'cancelled_by_user' }, now), 'none');
    assert.strictEqual(engine.nextAction({ status: 'unacknowledged' }, now), 'none');
    assert.strictEqual(engine.nextAction(null, now), 'none');
  });

  await test('buildAlertMessages: email has name, vitals, location, ack link', () => {
    const m = engine.buildAlertMessages({
      userName: 'Talon Fisher', contactName: 'Meagan Fisher',
      alert: { trigger_date: '2026-11-21', episode_start: '2026-11-19', episode_end: '2026-11-21', episode_days: 3 },
      location: { address: '4314 Minto Road, Courtenay, BC', mapsUrl: 'https://www.google.com/maps?q=49.68,-124.99', updated: 'Nov 21, 2026' },
      vitalsSummary: 'Resting HR 120 bpm (usual 75), HRV 8 ms (usual 16)',
      ackUrl: 'https://h-car.onrender.com/api/alerts/acknowledge?token=abc123',
      isTest: false, level: 'primary',
    });
    assert.ok(m.subject.includes('Talon Fisher'), 'subject names the user');
    assert.ok(m.text.includes('Meagan Fisher'), 'email greets the contact');
    assert.ok(m.text.includes('Resting HR 120 bpm (usual 75)'), 'email has vitals');
    assert.ok(m.text.includes('4314 Minto Road'), 'email has location');
    assert.ok(m.text.includes('token=abc123'), 'email has ack link');
    assert.ok(!m.text.includes('—'), 'no em dashes in email');
    assert.ok(m.sms.length <= 1500, 'SMS under 1500 chars');
    assert.ok(m.sms.includes('Reply YES'), 'SMS invites YES reply');
    assert.ok(!m.sms.includes('—'), 'no em dashes in SMS');
  });

  await test('buildAlertMessages: test and secondary variants', () => {
    const m = engine.buildAlertMessages({
      userName: 'Talon Fisher', contactName: 'Denise Bourquin',
      alert: { trigger_date: '2026-11-21' },
      location: null, vitalsSummary: 'Resting HR 120 bpm (usual 75)',
      ackUrl: 'https://x/?token=t', isTest: true, level: 'secondary',
    });
    assert.ok(m.subject.startsWith('[TEST]'), 'test subject tagged');
    assert.ok(m.text.includes('THIS IS A TEST'), 'test body tagged');
    assert.ok(m.text.includes('secondary emergency contact'), 'secondary wording present');
    assert.ok(!m.text.includes('Last known location'), 'no location block when sharing off');
  });

  await test('normalizePhone: strips formatting, keeps last 10 digits', () => {
    assert.strictEqual(engine.normalizePhone('(250) 218-1784'), '2502181784');
    assert.strictEqual(engine.normalizePhone('+1 (250) 218-1784'), '2502181784');
    assert.strictEqual(engine.normalizePhone('250-218-1784'), '2502181784');
    assert.strictEqual(engine.normalizePhone(null), '');
  });

  await test('formatLocation: returns null when sharing is off', () => {
    assert.strictEqual(engine.formatLocation(makeUser({ location_sharing_enabled: false })), null);
    assert.strictEqual(engine.formatLocation(makeUser({ last_location_lat: null })), null);
    const loc = engine.formatLocation(makeUser());
    assert.ok(loc.address.includes('Minto Road'));
    assert.ok(loc.mapsUrl.includes('49.6869'));
  });

  await test('buildVitalsSummary: formats latest values vs baselines', async () => {
    const db = makeMockDb();
    db.tables.daily_summaries.push({ user_id: 1, date: '2026-11-21', rhr: 120, hrv: 8, spo2_avg: 94.2, breathing_rate: 18.5, sleep_minutes: 186, skin_temp_delta: 0.45 });
    db.tables.baselines.push(
      { user_id: 1, signal: 'resting_hr', centre: 75 },
      { user_id: 1, signal: 'rmssd', centre: 16 },
      { user_id: 1, signal: 'spo2', centre: 95.5 },
      { user_id: 1, signal: 'sleep_duration_h', centre: 6.8 },
    );
    const s = await engine.buildVitalsSummary(db, 1, [['resting_hr', 3.1], ['rmssd', 2.8], ['spo2', 2.2], ['sleep_duration_h', 1.9]]);
    assert.ok(s.includes('Resting HR 120 bpm (usual 75)'), 'RHR line: ' + s);
    assert.ok(s.includes('HRV 8 ms (usual 16)'), 'HRV line: ' + s);
    assert.ok(s.includes('Blood oxygen 94.2 % (usual 95.5)'), 'SpO2 line: ' + s);
    assert.ok(s.includes('Sleep 3.1 h (usual 6.8)'), 'Sleep line: ' + s);
  });

  await test('buildVitalsSummary: falls back gracefully with no data', async () => {
    const db = makeMockDb();
    const s = await engine.buildVitalsSummary(db, 1, [['resting_hr', 3.1]]);
    assert.strictEqual(s, 'several signals moved away from baseline');
  });

  await test('full flow: create, user says fine, nobody contacted', async () => {
    const db = makeMockDb();
    const sent = [];
    const ctx = makeCtx(sent);
    const user = makeUser();
    db.tables.users.push(user);
    const alert = await engine.createAlert(db, 1, { trigger_date: '2026-11-21', start: '2026-11-19', end: '2026-11-21', days: 3, top_signals: [['resting_hr', 3.1]] }, { vitalsSummary: 'Resting HR 120 bpm (usual 75)' });
    assert.ok(alert, 'alert created');
    assert.strictEqual(alert.status, 'awaiting_user');
    const res = await engine.recordUserResponse(db, ctx, alert, user, 'fine');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, 'cancelled_by_user');
    assert.strictEqual(sent.length, 0, 'no contact messages sent');
    const after = await engine.getActiveAlert(db, 1);
    assert.strictEqual(after, null, 'no active alert left');
  });

  await test('full flow: user needs help, primary alerted by email and SMS', async () => {
    const db = makeMockDb();
    const sent = [];
    const ctx = makeCtx(sent);
    const user = makeUser();
    db.tables.users.push(user);
    const alert = await engine.createAlert(db, 1, { trigger_date: '2026-11-21', start: '2026-11-19', end: '2026-11-21', days: 3, top_signals: [] }, { vitalsSummary: 'Resting HR 120 bpm (usual 75)' });
    const res = await engine.recordUserResponse(db, ctx, alert, user, 'need_help');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, 'alerting');
    assert.strictEqual(sent.length, 2, 'email + SMS sent');
    assert.strictEqual(sent[0].channel, 'email');
    assert.strictEqual(sent[0].to, 'meaganbourquin@gmail.com');
    assert.strictEqual(sent[1].channel, 'sms');
    assert.ok(sent[1].body.includes('Talon Fisher'));
    assert.ok(sent[1].body.includes('token='), 'SMS has ack link');
  });

  await test('full flow: silence escalates primary, then secondary, then unacknowledged', async () => {
    const db = makeMockDb();
    const sent = [];
    const ctx = makeCtx(sent);
    const user = makeUser();
    db.tables.users.push(user);
    const alert = await engine.createAlert(db, 1, { trigger_date: '2026-11-21', start: '2026-11-19', end: '2026-11-21', days: 3, top_signals: [] }, { vitalsSummary: 'Resting HR 120 bpm (usual 75)' });
    // Age the alert 6 minutes: sweep alerts primary.
    db.tables.alerts[0].created_at = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    let summary = await engine.processEscalations(db, ctx);
    assert.strictEqual(summary.alertedPrimary, 1, 'primary alerted after 5 min silence');
    assert.strictEqual(db.tables.alerts[0].status, 'alerting');
    assert.strictEqual(sent.length, 2, 'primary got email + SMS');
    // Age primary alert to 16 minutes: sweep escalates to secondary.
    db.tables.alerts[0].primary_alerted_at = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    summary = await engine.processEscalations(db, ctx);
    assert.strictEqual(summary.escalatedSecondary, 1, 'secondary alerted after 15 min no ack');
    assert.strictEqual(db.tables.alerts[0].status, 'escalated');
    assert.strictEqual(sent.length, 4, 'secondary got email + SMS');
    assert.strictEqual(sent[2].to, 'denise@example.com');
    // Age primary alert to 31 minutes: sweep marks unacknowledged.
    db.tables.alerts[0].primary_alerted_at = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    summary = await engine.processEscalations(db, ctx);
    assert.strictEqual(summary.markedUnacknowledged, 1, 'marked unacknowledged after 30 min');
    assert.strictEqual(db.tables.alerts[0].status, 'unacknowledged');
    assert.strictEqual(sent.length, 4, 'no new messages at unacknowledged step');
  });

  await test('full flow: acknowledgment by token resolves the alert', async () => {
    const db = makeMockDb();
    const sent = [];
    const ctx = makeCtx(sent);
    const user = makeUser();
    db.tables.users.push(user);
    const alert = await engine.createAlert(db, 1, { trigger_date: '2026-11-21', start: '2026-11-19', end: '2026-11-21', days: 3, top_signals: [] }, { vitalsSummary: 'Resting HR 120 bpm (usual 75)' });
    await engine.alertPrimary(db, ctx, alert, user);
    const bad = await engine.acknowledgeByToken(db, 'wrong-token', 'contact link');
    assert.strictEqual(bad.ok, false, 'wrong token rejected');
    const good = await engine.acknowledgeByToken(db, alert.ack_token, 'contact link');
    assert.strictEqual(good.ok, true);
    assert.strictEqual(good.alert.status, 'acknowledged');
    const again = await engine.acknowledgeByToken(db, alert.ack_token, 'contact link');
    assert.strictEqual(again.ok, false, 'already-acknowledged token rejected');
  });

  await test('dedup: same trigger date creates only one alert', async () => {
    const db = makeMockDb();
    const a1 = await engine.createAlert(db, 1, { trigger_date: '2026-11-21' }, {});
    const a2 = await engine.createAlert(db, 1, { trigger_date: '2026-11-21' }, {});
    assert.ok(a1, 'first created');
    assert.strictEqual(a2, null, 'second deduped');
    assert.strictEqual(db.tables.alerts.length, 1);
  });

  await test('no primary contact: alert goes straight to unacknowledged', async () => {
    const db = makeMockDb();
    const sent = [];
    const ctx = makeCtx(sent);
    const user = makeUser({ emergency_contact_email: null, emergency_contact_phone: null });
    db.tables.users.push(user);
    const alert = await engine.createAlert(db, 1, { trigger_date: '2026-11-21' }, {});
    const res = await engine.alertPrimary(db, ctx, alert, user);
    assert.strictEqual(res.contacted, false);
    assert.strictEqual(db.tables.alerts[0].status, 'unacknowledged');
  });

  await test('no em dashes anywhere in generated messages', () => {
    const m = engine.buildAlertMessages({
      userName: 'Talon Fisher', contactName: 'Meagan Fisher',
      alert: { trigger_date: '2026-11-21', episode_start: '2026-11-19', episode_end: '2026-11-21', episode_days: 3 },
      location: { address: '4314 Minto Road', mapsUrl: 'https://maps.example.com', updated: 'now' },
      vitalsSummary: 'Resting HR 120 bpm (usual 75)',
      ackUrl: 'https://x/?token=t', isTest: false, level: 'primary',
    });
    assert.ok(!m.subject.includes('—') && !m.text.includes('—') && !m.sms.includes('—'));
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed.');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Test runner crashed:', e);
  process.exit(1);
});
