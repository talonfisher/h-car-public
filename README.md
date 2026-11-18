# H-CAR Public App

Standalone public signup and payment app for H-CAR (Human Condition Analysis & Risk Platform). Built for deployment to Render's free tier.

## What this is

A self-contained Node.js/Express app that lets customers:
1. Sign up with name, email, password
2. Read and accept the consent form (8 sections, 11 acknowledgment checkboxes, including research use of de-identified data)
3. Pay $5.00 CAD/month via Square Web Payments SDK
4. Connect their Fitbit via the Google Health API
5. Get a daily sync of 6 wearable signals and detector v2 flags (Watch/Act) on their dashboard

This app runs the 40-person paid trial: participants pay $5/month, connect
a Fitbit, and their de-identified data validates the detector.

## What this is NOT (yet)

- **Operator dashboard UI**: Not included. Trial monitoring is via the
  admin API endpoints (`/api/admin/trial-summary`, `/api/admin/sync-all`)
  with the `ADMIN_SYNC_KEY`, or direct database access.
- **Human escalation (Act paging)**: The detector flags Act episodes, but
  no alert is sent to a trusted contact yet. The dashboard shows the flag;
  paging is a follow-up feature.
- **Persistent database**: SQLite on Render Free is ephemeral (see below).
  Migrate to Neon Postgres before the trial starts collecting real data.

## Architecture

- **Server**: Express.js (Node.js 18+)
- **Database**: SQLite (file-based, `hcar.db`). For production with persistent data across deploys, migrate to Neon Postgres (free tier) or Render Postgres.
- **Auth**: JWT tokens (7-day expiry), PBKDF2 password hashing (bcryptjs)
- **Payments**: Square Web Payments SDK (browser) + Square Subscriptions API (server)
- **Wearables**: Google Health API (health.googleapis.com/v4) via OAuth 2.0.
  Reads 6 daily data types (resting heart rate, HRV, SpO2, respiratory
  rate, sleep temperature derivations, sleep). Tokens are AES-256-GCM
  encrypted at rest. See `GOOGLE_SETUP.md`.
- **Detector**: `detector.js`, a faithful port of detector v2 (median + MAD
  baselines, z-scores capped ±4, Watch/Act rules, 14-day lockout and
  episode merging). Verified against the Python reference on identical
  synthetic data; run `node test-detector.js` to re-verify.
- **Security**: Helmet headers (CSP allows the Square SDK and inline
  handlers), CORS, rate limiting (100 req/15min, 5 signups/hour)

## API endpoints

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `POST /api/signup` | no | Create account |
| `POST /api/login` | no | Sign in, returns JWT |
| `POST /api/consent` | JWT | Record 11 acknowledgments |
| `POST /api/subscribe` | JWT | Create Square subscription |
| `GET /api/me` | JWT | Current user + subscription status |
| `POST /api/cancel` | JWT | Cancel subscription |
| `GET /api/fitbit/connect` | JWT | Start Google OAuth, returns consent URL |
| `GET /api/fitbit/callback` | state JWT | OAuth return, stores encrypted tokens |
| `GET /api/fitbit/status` | JWT | Fitbit connection status |
| `POST /api/fitbit/disconnect` | JWT | Revoke + delete Fitbit connection |
| `POST /api/fitbit/sync` | JWT | Pull latest summaries, re-run detector |
| `GET /api/detector/status` | JWT | Baseline progress, status, recent flags |
| `GET /api/days?limit=30` | JWT | Recent daily summaries + detector results |
| `POST /api/admin/sync-all` | `x-admin-key` | Sync all connected users (cron) |
| `GET /api/admin/trial-summary` | `x-admin-key` | Trial totals + per-user progress (IDs only) |

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `SQUARE_ACCESS_TOKEN` | Square Production Access Token (from developer.squareup.com) | `sq0atp-...` |
| `SQUARE_APPLICATION_ID` | Square Application ID (public) | `sq0idp-AjjPPKKmlIAWk17Uf6sQvw` |
| `SQUARE_LOCATION_ID` | Square Location ID | `L5A30BMAGNY4E` |
| `SQUARE_PLAN_VARIATION_ID` | H-CAR Monthly plan variation | `XU5OAQ4SZB4GA4DYN65KZYFD` |
| `JWT_SECRET` | Random string for JWT signing | Generate with `openssl rand -hex 32` |
| `GOOGLE_CLIENT_ID` | Google Cloud OAuth client ID (see GOOGLE_SETUP.md) | `...apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | Google Cloud OAuth client secret | `GOCSPX-...` |
| `BASE_URL` | Public URL of the app (used for the OAuth redirect) | `https://h-car.onrender.com` |
| `TOKEN_ENCRYPTION_KEY` | 64 hex chars; encrypts stored Google tokens | Generate with `openssl rand -hex 32` |
| `ADMIN_SYNC_KEY` | Random string guarding /api/admin/* (daily sync cron) | Generate with `openssl rand -hex 32` |
| `PORT` | Server port (Render sets this) | `3000` |

## Deploy to Render (Free Tier)

### Option A: Deploy from GitHub (recommended)

1. Push this directory to a GitHub repository.
2. Go to [render.com](https://render.com) and sign up (free).
3. Click "New" → "Web Service" → connect your GitHub repo.
4. Render auto-detects Node.js. Set:
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Plan: **Free**
5. Add environment variables in the Render dashboard:
   - `SQUARE_ACCESS_TOKEN` (paste from developer.squareup.com)
   - `JWT_SECRET` (generate a random string)
   - The other Square IDs are already in `render.yaml` but can be set manually.
6. Deploy. Your app will be live at `https://h-car.onrender.com` (or similar).

### Option B: Deploy with render.yaml (Blueprint)

1. Push this directory (including `render.yaml`) to GitHub.
2. In Render, click "New" → "Blueprint" → connect the repo.
3. Render reads `render.yaml` and creates the service.
4. Set `SQUARE_ACCESS_TOKEN` in the dashboard (it is marked `sync: false` so Render will prompt for it).

## Limitations of Render Free Tier

- **Spins down after 15 minutes idle.** First request after idle takes ~30-60 seconds to wake. This is acceptable for a launch, but upgrade to Starter ($7/month) when traffic grows.
- **750 hours/month.** Enough for one app running continuously.
- **No persistent disk.** The SQLite database file (`hcar.db`) is stored on the ephemeral filesystem and **will be lost on every deploy and restart**. For production:
  - Option 1: Migrate to Neon Postgres (free tier, 3GB storage, never sleeps).
  - Option 2: Upgrade to Render Starter ($7/month) + Render Postgres ($6/month).
  - Option 3: Accept data loss on deploys during the trial phase (not recommended for paying customers).

## After Deployment

1. **Test signup**: Create a test account, complete consent, and test the $5 payment with a real card (then refund in Square Dashboard).
2. **Set up Google Health API**: Follow `GOOGLE_SETUP.md` to create the
   Google Cloud project, enable the Google Health API, and set
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BASE_URL`,
   `TOKEN_ENCRYPTION_KEY`, and `ADMIN_SYNC_KEY` in Render.
3. **Test Fitbit connect**: Connect a Fitbit, run a sync, and confirm
   daily summaries and baseline progress appear on the dashboard.
4. **Set up the daily sync cron**: Create a Render Cron Job (or a
   cron-job.org job) that POSTs to
   `https://h-car.onrender.com/api/admin/sync-all` every morning with header
   `x-admin-key: <ADMIN_SYNC_KEY>`. Without this, users must tap
   "Sync Now" themselves.
5. **Migrate the database** to Neon Postgres before the trial starts
   collecting real data (SQLite data loss on redeploy is unacceptable
   for trial data).
6. **Set up a custom domain** (optional): Buy a domain (e.g., hcar.ca,
   ~$15/year from Namecheap or Cloudflare) and point it to your Render
   URL. This is not required for launch.

## Local Development

```bash
npm install
cp .env.example .env
# Edit .env with your Square token and JWT secret
npm start
# Open http://localhost:3000
```

## Cost Summary

| Item | Cost |
|------|------|
| Render Free web service | $0/month |
| SQLite database (ephemeral) | $0 |
| Square payment processing | 2.9% + $0.30 per transaction ($0.45 on $5) |
| **Total to launch** | **$0/month** (plus Square fees on payments) |

When ready to scale:
- Render Starter: $7/month (always-on, no sleep)
- Neon Postgres Free: $0 (3GB, persistent)
- Custom domain: ~$15/year
