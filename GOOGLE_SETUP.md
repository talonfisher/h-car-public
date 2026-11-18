# Google Health API Setup for H-CAR

H-CAR reads Fitbit data through the **Google Health API**
(`health.googleapis.com/v4`), Google's successor to the Fitbit Web API
(sunset November 2026) and the Google Fit REST API (supported only until
end of 2026). Do not build on either legacy API.

This guide covers: creating the Google Cloud project, enabling the API,
configuring OAuth, and setting the Render environment variables. Budget
about 30 minutes the first time.

## What H-CAR reads

| Data type | H-CAR signal | Scope |
|-----------|--------------|-------|
| `daily-resting-heart-rate` | Resting heart rate | health_metrics_and_measurements.readonly |
| `daily-heart-rate-variability` | HRV (RMSSD) | health_metrics_and_measurements.readonly |
| `daily-oxygen-saturation` | SpO2 average + lower bound | health_metrics_and_measurements.readonly |
| `daily-respiratory-rate` | Breathing rate | health_metrics_and_measurements.readonly |
| `daily-sleep-temperature-derivations` | Skin temperature delta | health_metrics_and_measurements.readonly |
| `sleep` | Sleep minutes + efficiency | sleep.readonly |

Full scope URLs:
- `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly`
- `https://www.googleapis.com/auth/googlehealth.sleep.readonly`

## Step 1: Create a Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and sign in with a Google account you control.
2. Click the project picker at the top, then **New Project**.
3. Name it `H-CAR` (project ID is auto-generated, any value is fine).
4. Click **Create** and wait for it to finish, then make sure it is the selected project.

## Step 2: Enable the Google Health API

1. In the Cloud Console, go to **APIs & Services > Library**.
2. Search for **Google Health API** and open it.
3. Click **Enable**.
4. (Direct link: `console.cloud.google.com/apis/library/health.googleapis.com` — replace the project in the URL picker with your H-CAR project.)

## Step 3: Configure the OAuth consent screen

1. Go to **APIs & Services > OAuth consent screen**.
2. Choose **External** user type, click **Create**.
3. Fill in:
   - **App name**: `H-CAR`
   - **User support email**: your email
   - **Developer contact information**: your email
4. Click **Save and Continue**.
5. On **Scopes**, click **Add or Remove Scopes**, paste the two scope URLs above into the filter box one at a time, tick both, click **Update**, then **Save and Continue**.
6. On **Test users**, click **Add Users** and add the Google accounts of your trial participants (up to 100 while the app is in Testing). Click **Save and Continue**.
7. Review the summary and click **Back to Dashboard**. Leave the app in **Testing** for the trial.

> **Testing-mode limit:** while the OAuth app is in Testing, Google revokes
> each user's refresh token after about 7 days, so participants must
> reconnect their Fitbit weekly (the dashboard prompts them). For the
> 40-person trial this is workable but annoying. To remove the limit,
> publish the app and complete Google's verification for these Restricted
> scopes (privacy policy, homepage, per-scope justification, and a
> security assessment). Start that process early; it takes weeks.

## Step 4: Create the OAuth client

1. Go to **APIs & Services > Credentials**.
2. Click **Create Credentials > OAuth client ID**.
3. Application type: **Web application**.
4. Name: `H-CAR web`.
5. Under **Authorized redirect URIs**, click **Add URI** and enter exactly:
   - `https://h-car.onrender.com/api/fitbit/callback`
   - (For local testing also add `http://localhost:3000/api/fitbit/callback`.)
6. Click **Create**. A dialog shows your **Client ID** and **Client Secret**.
   Copy both somewhere safe. You will not see the secret again.

## Step 5: Set the Render environment variables

In the Render dashboard, open the `h-car` web service, go to
**Environment**, and add:

| Variable | Value |
|----------|-------|
| `GOOGLE_CLIENT_ID` | The Client ID from Step 4 |
| `GOOGLE_CLIENT_SECRET` | The Client Secret from Step 4 |
| `BASE_URL` | `https://h-car.onrender.com` (no trailing slash) |
| `TOKEN_ENCRYPTION_KEY` | 64 hex characters, generate with `openssl rand -hex 32` |
| `ADMIN_SYNC_KEY` | Any random string, generate with `openssl rand -hex 32` |

Save. Render redeploys automatically when environment variables change.

> `TOKEN_ENCRYPTION_KEY` encrypts the Google tokens stored in the
> database. If you change it later, existing stored tokens become
> unreadable and every user must reconnect their Fitbit. Generate it
> once and keep it.

## Step 6: Verify the connection

1. Open `https://h-car.onrender.com/api/health`. It should show
   `"googleHealthConfigured": true`.
2. Sign up (or sign in), complete consent and payment, then click
   **Connect Fitbit** on the dashboard.
3. Google asks you to sign in and approve the two readonly scopes.
   Approve them.
4. You land back on the dashboard with "Fitbit connected" and an
   automatic sync. Daily summaries and baseline progress should appear
   within a minute. If your Fitbit has history, the sync pulls up to
   35 days back, which can complete most of the 28-day baseline at once.

## Step 7: Set up the daily sync cron

The app does not sync by itself (Render Free sleeps, so an in-process
timer is unreliable). Set up a daily job that calls the admin endpoint:

- **URL**: `https://h-car.onrender.com/api/admin/sync-all`
- **Method**: POST
- **Header**: `x-admin-key: <your ADMIN_SYNC_KEY>`
- **Schedule**: once a day, morning (e.g., 07:10 America/Vancouver)

Options:
- **Render Cron Job** (paid, from $1/month): Dashboard > New > Cron Job,
  point it at the URL above. Render cron jobs run a command, not an HTTP
  call, so use `curl -X POST -H "x-admin-key: $ADMIN_SYNC_KEY"
  https://h-car.onrender.com/api/admin/sync-all` with the key as a
  cron-job environment variable.
- **cron-job.org** (free): create a job with the URL, POST method, and
  the `x-admin-key` header.

Without the cron, each user must tap **Sync Now** on their dashboard.
The trial still works, but data arrives only when users remember.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `/api/health` shows `googleHealthConfigured: false` | Env vars missing or misspelled | Check Render Environment; redeploy |
| Google shows "redirect_uri_mismatch" | Redirect URI in Google does not match `BASE_URL` + `/api/fitbit/callback` exactly | Fix the URI in Credentials (Step 4) or `BASE_URL` in Render; both must match character for character |
| "Access blocked: H-CAR has not completed the Google verification process" | App is in Testing and the user is not a listed test user | Add their Google account under OAuth consent screen > Test users |
| "Fitbit connection expired. Please reconnect." | Testing-mode refresh token expired (~7 days) or the user revoked access | Reconnect from the dashboard; for a permanent fix, publish + verify the app |
| Sync succeeds but no data | Fitbit has not synced to the Fitbit app, or the user has no recent nights | Open the Fitbit app, pull to sync, wait, then tap Sync Now |
| Sync reports one signal failing | That data type is unavailable for this user/device | Normal: the detector scores days with >= 3 of 6 signals; the missing signal stays null |

## Security notes

- Tokens are encrypted with AES-256-GCM before storage and never leave
  the server except to Google's token and API endpoints.
- The app requests readonly scopes only. It never writes health data.
- The OAuth `state` parameter is a signed short-lived JWT binding the
  flow to the logged-in user, which blocks CSRF and account-linking
  attacks.
- Admin endpoints require `ADMIN_SYNC_KEY`. Keep it out of Git and out
  of chat; it lives only in the Render dashboard.
