# Garmin Health API Setup for H-CAR

This guide explains how to enable Garmin watch support in H-CAR.

## Overview

Garmin does NOT use Google Health. It requires direct integration with the Garmin Health API through the Garmin Connect Developer Program.

**Key differences from Fitbit:**
- Fitbit: Pull-based. H-CAR fetches data from Google Health when user syncs.
- Garmin: Push-based. Garmin sends data to H-CAR's webhook when user's watch syncs.

**What Garmin provides:**
- Resting heart rate (all models)
- HRV / RMSSD (overnight average, most models from 2020+)
- SpO2 / Pulse Ox (models with Pulse Ox sensor)
- Breathing rate (sleep and all-day, newer models)
- Sleep duration and stages (all models)
- Skin temperature (Fenix 7, Epix Gen 2, Forerunner 965, and newer only)

**What Garmin does NOT provide on most models:**
- Skin temperature (only newer models have this sensor)
- H-CAR detector works with 5 signals when skin temp is missing

## Step 1: Apply to Garmin Developer Program

Garmin requires approval before you can access the Health API. This is NOT self-serve.

### Requirements
- **Legal entity:** You must apply as a company, not an individual. Personal-use applications are rejected.
  - Talon Fisher Contracting qualifies as a sole proprietorship.
- **Public website:** https://h-car.onrender.com
- **Public privacy policy:** https://h-car.onrender.com/privacy.html

### Application
1. Go to https://developer.garmin.com/gc-developer-program/
2. Click "Register" or "Apply for Access"
3. Fill out the form:
   - **Company:** Talon Fisher Contracting
   - **Website:** https://h-car.onrender.com
   - **Privacy Policy:** https://h-car.onrender.com/privacy.html
   - **Use case:** Personal health baseline monitoring. H-CAR reads daily summaries from Garmin watches (resting heart rate, HRV, SpO2, breathing rate, sleep, skin temperature when available) to establish a personal baseline and flag sustained changes. Data is never sold. Users consent to data collection and can disconnect at any time.
   - **Data handling:** Data is stored encrypted in a Postgres database. Only daily summaries are stored, not minute-by-minute data. Raw data stays on the user's device; only summaries reach the server.
   - **APIs needed:** Health API (dailies, sleep, HRV, pulseox, respiration, skinTemp)

4. Submit and wait for approval. Timeline is typically 1 to 4 weeks.

### After approval
Garmin will email you with:
- Access to the Developer Portal
- Instructions to create an app

## Step 2: Create an app in the Developer Portal

1. Sign in to the Garmin Developer Portal
2. Go to your team apps page
3. Create a new app:
   - **Type:** Connect Developer - Evaluation (for testing) or Production (for live use)
   - **Name:** H-CAR
   - **Description:** Personal health baseline monitoring from wearable daily summaries
   - **OAuth redirect URL:** https://h-car.onrender.com/api/garmin/callback
   - **APIs:** Select Health API
   - **Data types:** dailies, sleep, hrv, pulseox, respiration, skinTemp, stress

4. Save the app. Garmin will generate:
   - **Client ID** (also called Consumer Key)
   - **Client Secret** (also called Consumer Secret)

5. Copy these credentials. You will need them in Step 3.

## Step 3: Configure H-CAR

Add the Garmin credentials to Render environment variables:

1. Go to Render dashboard: https://dashboard.render.com
2. Select the h-car service
3. Go to Environment tab
4. Add:
   - `GARMIN_CLIENT_ID` = your Garmin Client ID
   - `GARMIN_CLIENT_SECRET` = your Garmin Client Secret
5. Save. Render will redeploy automatically.

Or for local development, add to `.env`:
```
GARMIN_CLIENT_ID=your-garmin-client-id
GARMIN_CLIENT_SECRET=your-garmin-client-secret
```

## Step 4: Configure webhooks in Garmin Developer Portal

Garmin pushes data to your webhook URLs when a user syncs their device. You must register these URLs in the Developer Portal.

1. In the Developer Portal, open your H-CAR app
2. Go to Endpoint Configuration
3. For each data type, set the webhook URL:
   - **Dailies:** https://h-car.onrender.com/api/garmin/webhook/dailies
   - **Sleep:** https://h-car.onrender.com/api/garmin/webhook/sleep
   - **HRV:** https://h-car.onrender.com/api/garmin/webhook/hrv
   - **Pulse Ox:** https://h-car.onrender.com/api/garmin/webhook/pulseox
   - **Respiration:** https://h-car.onrender.com/api/garmin/webhook/respiration
   - **Skin Temp:** https://h-car.onrender.com/api/garmin/webhook/skinTemp
   - **Stress:** https://h-car.onrender.com/api/garmin/webhook/stress

4. Ensure each endpoint is **enabled**
5. Where a delivery mode is offered, select **Push** (not Pull)
6. Save

## Step 5: Test the integration

### Test with a real Garmin device
1. Sign up for H-CAR at https://h-car.onrender.com (or use an existing account)
2. Click "Connect Garmin" on the dashboard
3. Sign in with your Garmin account
4. Grant permissions (make sure to grant historical data permission if asked)
5. You will be redirected back to H-CAR
6. Open Garmin Connect on your phone and sync your watch
7. Garmin will push data to H-CAR's webhook
8. Check the H-CAR dashboard. Data should appear within a few minutes.

### Verify data is flowing
- Dashboard should show "Garmin: Connected" with a connection date
- After syncing your watch, "Last data received" should update
- Daily summaries should appear in the Trends tab
- Baseline progress should advance

## How it works

### OAuth flow (OAuth 2.0 with PKCE)
1. User clicks "Connect Garmin" in H-CAR
2. H-CAR generates a PKCE code verifier and challenge
3. User is redirected to Garmin's authorization page
4. User signs in and grants permissions
5. Garmin redirects back to H-CAR with an authorization code
6. H-CAR exchanges the code for access and refresh tokens
7. Tokens are encrypted and stored in the `garmin_tokens` table

### Data flow (push-based)
1. User wears Garmin watch during the day and night
2. User opens Garmin Connect app (or watch syncs automatically)
3. Garmin processes the data and pushes it to H-CAR's webhook URLs
4. H-CAR receives the webhook, parses the data, and stores it in `daily_summaries`
5. H-CAR re-runs the detector with the new data
6. If an Act episode is detected, H-CAR creates an alert (user gets 5 minutes to respond)

### Data mapping
| Garmin field | H-CAR field | Notes |
|--------------|-------------|-------|
| dailies.restingHeartRate | rhr | Beats per minute |
| hrv.lastNightAvg | hrv | RMSSD in milliseconds |
| sleep.averageSpO2Value | spo2_avg | Percent |
| sleep.lowestSpO2Value | spo2_min | Percent |
| sleep.averageRespirationValue | breathing_rate | Breaths per minute |
| sleep.durationInSeconds | sleep_minutes | Converted to minutes |
| skinTemp.averageDeviation | skin_temp_delta | Degrees Celsius, newer models only |

## Supported Garmin models

Any Garmin watch that syncs with Garmin Connect and provides health data should work. This includes:
- **Forerunner series:** 55, 165, 255, 265, 955, 965
- **Fenix series:** 6, 7, 8, Epix Gen 2, Epix Pro
- **Venu series:** 2, 3, 4
- **Vivoactive series:** 4, 5
- **Instinct series:** 2, 3
- **Approach, Descent, and others**

**Skin temperature** is available on:
- Fenix 7 series and newer
- Epix Gen 2 and newer
- Forerunner 965
- Venu 3 and newer

Older models do not have a skin temperature sensor. H-CAR works with 5 signals when skin temp is missing.

## Costs

Garmin Health API access is **free** for approved companies. Garmin says "approved companies get free access."

There are no per-user fees at the Business Starter tier. If H-CAR grows to thousands of users, Garmin may ask you to move to Business Enterprise tier, but the terms are negotiated case by case.

## Limitations

1. **Approval required:** You cannot test with real Garmin devices until Garmin approves your application. This takes 1 to 4 weeks.
2. **Push only (Starter tier):** Business Starter tier is push only. H-CAR cannot fetch historical data on demand. Users must sync their watch to send data.
3. **No historical data (Starter tier):** Business Starter does not include historical backfill. Users start with 0 days of data when they connect. Enterprise tier includes 1 month of history.
4. **No skin temp on older models:** Most Garmin watches from before 2022 do not measure skin temperature. H-CAR works without it.
5. **Webhook reliability:** If H-CAR's webhook endpoint is down when Garmin tries to deliver data, Garmin will retry, but there is no guarantee of delivery. Render Free tier sleeps after 15 minutes of inactivity, which could cause missed webhooks. Consider upgrading to Render Starter ($7/month) for always-on webhooks.

## Troubleshooting

### "Garmin is not configured yet"
- GARMIN_CLIENT_ID or GARMIN_CLIENT_SECRET is not set in Render environment variables.
- Check Render dashboard, Environment tab, and verify both variables are set.
- Redeploy after setting variables.

### User connects but no data appears
- Check that webhooks are configured correctly in Garmin Developer Portal.
- Verify the webhook URLs are correct and endpoints are enabled.
- Ask the user to open Garmin Connect and manually sync their watch.
- Check Render logs for webhook errors.

### Webhook returns 404
- The webhook URL in Garmin Developer Portal does not match H-CAR's endpoint.
- Verify the URL is https://h-car.onrender.com/api/garmin/webhook/dailies (or the specific data type).

### "User not found" in webhook logs
- The Garmin user ID in the webhook payload does not match any user in the `garmin_tokens` table.
- This can happen if the user connected before the `garmin_user_id` column was populated.
- Solution: User should disconnect and reconnect their Garmin account.

## References

- Garmin Connect Developer Program: https://developer.garmin.com/gc-developer-program/
- Garmin Health API documentation: Available in Developer Portal after approval
- OAuth 2.0 PKCE specification: https://datatracker.ietf.org/doc/html/rfc7636
