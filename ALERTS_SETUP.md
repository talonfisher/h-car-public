# H-CAR Emergency Alert System - Setup

The alert system works without any new credentials: email is the
fallback channel and every step degrades gracefully. These three
optional steps make it faster and more reliable.

## 1. SMS alerts (Twilio) - recommended

Without this, contacts are alerted by email only. With it, they also
get a text message, and they can acknowledge by replying YES.

1. Sign up at https://www.twilio.com/try-twilio (free trial, $15 credit).
2. Get a phone number (trial numbers work for verified numbers; a paid
   number, about $1/month, texts anyone).
3. In the Twilio console, find your Account SID and Auth Token.
4. In Render, set these environment variables on the h-car service:
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_FROM_NUMBER` (your Twilio number, e.g. +12505550100)
5. In the Twilio console, set the number's messaging webhook to:
   `https://h-car.onrender.com/api/alerts/sms-reply`
   (POST). This lets a contact acknowledge by replying YES, OK, or ACK.
6. Redeploy (Render redeploys automatically when env vars change).
7. Verify: in the app, Profile, tap "Test Full Alert Flow", then tap
   "No, I need help". Your contact should get a TEST text and email.

## 2. Push alerts (VAPID keys) - recommended

Without this, the "Are you okay?" check-in only appears when the app
is open. With it, the phone wakes the user even when the app is closed.

1. On any machine with Node: `npx web-push generate-vapid-keys`
2. In Render, set on the h-car service:
   - `VAPID_PUBLIC_KEY`
   - `VAPID_PRIVATE_KEY`
3. Redeploy. In the app, Profile, tap "Enable Push Alerts on This
   Device" and allow notifications.

## 3. Escalation cron - recommended

The server sweeps for timed-out alerts every 60 seconds while awake,
but the free Render tier sleeps when idle, so the sweep stops with it.
An external cron keeps escalations on time:

- POST `https://h-car.onrender.com/api/admin/process-alerts`
- Header: `x-admin-key: <ADMIN_SYNC_KEY>`
- Every 5 minutes is plenty (the windows are 5, 15, and 30 minutes).

Any free cron service works (cron-job.org, UptimeRobot, or Render Cron).
Without it, escalations still happen: the sweep runs on server startup
and on every alert-status check (every 30 seconds while any user has
the app open), so the worst case is a delay while the server sleeps.

## How the flow works

1. An Act flag fires. The user gets 5 minutes to answer "Are you
   okay?" in the app (and a push notification if enabled).
2. "Yes, I'm fine" cancels the alert. Nobody is contacted.
3. "No, I need help", or 5 minutes of silence, alerts the primary
   emergency contact by SMS and email.
4. The contact confirms receipt by tapping the link in the message or
   replying YES to the text.
5. No confirmation in 15 minutes escalates to the secondary contact.
6. No confirmation in 30 minutes marks the alert unacknowledged: the
   app shows a red banner and the server logs a prominent warning that
   a human should call emergency services. H-CAR never calls 911
   automatically.

## Testing

- Unit tests (no database needed): `node test-alerts.js`
- In the app: Profile, "Test Full Alert Flow" runs the whole system
  with TEST messages. "Send Test Email" only tests email delivery.
- Alert history in Profile shows every step of every alert.
