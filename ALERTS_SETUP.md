# H-CAR Emergency Alert System - Setup

The alert system works without any new credentials: email is the
fallback channel and every step degrades gracefully. These steps make
it faster and more reliable.

## 0. Email sending (Gmail API) - required for alerts to work

Email is the channel every Act alert and password reset uses. It goes
through the Gmail API over HTTPS, because the Render host cannot reach
`smtp.gmail.com:587` at all (connection timeout, verified 2026-11-27).
SMTP is kept only as a fallback. Sending uses Talon's account,
`talonfisher66@gmail.com`, with ONLY the `gmail.send` scope (send mail,
nothing else). No other account can be used: the setup flow refuses
any Google account but that one.

One-time setup, about 5 minutes:

1. **Register the callback URI.** In Google Cloud Console, open the
   project **H-CAR** (summer-artwork-515101-b9), go to **APIs &
   Services > Credentials**, open the **H-CAR Web Client** OAuth
   client, and under **Authorized redirect URIs** add exactly:
   `https://h-car.onrender.com/api/admin/gmail-auth-callback`
   Save, and wait a few minutes for it to take effect. Without this
   step Google answers `redirect_uri_mismatch`.
2. **Get the consent URL.** With the admin key:
   `GET https://h-car.onrender.com/api/admin/gmail-auth-url`
   Header: `x-admin-key: <ADMIN_SYNC_KEY>`
   It returns `authUrl` (good for 10 minutes), the scope, and the
   account it will send as.
3. **Consent.** Open `authUrl`, sign in as `talonfisher66@gmail.com`,
   and consent to sending mail only. Google may show an
   unverified-app warning because `gmail.send` is a new scope for
   this app: use Advanced to proceed, it is Talon's own app.
4. **Copy the refresh token.** The page Google lands on shows the
   refresh token once. Copy it and paste it into Render as the
   `GMAIL_REFRESH_TOKEN` env var on the `h-car` service, then
   redeploy. The token is never logged and never stored anywhere
   else. Anyone with it can send mail as the account, so keep it
   private.
5. **Verify.** `GET https://h-car.onrender.com/api/admin/smtp-status`
   (admin key): `sender` should read `gmail-api` and
   `gmailApi.verify.ok` should be true. Then tap "Send Test Email"
   in the app (Profile). It waits for the real result and shows the
   failure reason instead of claiming it was sent.

If the token is ever revoked, or the Google account password changes,
repeat the flow: it issues a fresh token. If email ever fails after
setup, the same status endpoint reports the exact error, and the
"Send Test Email" button shows it too.

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

## 4. Diagnosing email delivery

If test emails or password resets never arrive, do NOT guess: ask the
server what is wrong.

- GET `https://h-car.onrender.com/api/admin/smtp-status`
- Header: `x-admin-key: <ADMIN_SYNC_KEY>`

It sends no email. It reports which sender is active (`sender` is
`gmail-api` when the Gmail API is configured, otherwise `smtp`), and
checks both paths: `gmailApi.verify` runs a live Gmail API profile
check (token valid, account shown), and `verify` runs a live SMTP
check. Common results: `gmailApi.verify.ok` false with a 401 or
"invalid_grant" means the refresh token is revoked or wrong, repeat
the section 0 setup flow. "Connection timeout" on the SMTP check is
the known Render network block, not a password problem, and is why
the Gmail API is the primary sender. "Username and Password not
accepted" on the SMTP check means the Gmail app password in Render
is wrong or has spaces in it. The "Send Test Email" button in Profile
now waits for the real result and shows the failure reason instead of
claiming it was sent.

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

- Unit tests (no database needed): `node test-alerts.js` (alert engine),
  `node test-gmail-send.js` (Gmail API sender: message building, auth
  states, honest failure reporting, no live calls).
- In the app: Profile, "Test Full Alert Flow" runs the whole system
  with TEST messages. "Send Test Email" only tests email delivery.
- Alert history in Profile shows every step of every alert.
