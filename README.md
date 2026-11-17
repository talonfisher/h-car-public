# H-CAR Public App

Standalone public signup and payment app for H-CAR (Human Condition Analysis & Risk Platform). Built for deployment to Render's free tier.

## What this is

A self-contained Node.js/Express app that lets customers:
1. Sign up with name, email, password
2. Read and accept the 14-section consent form (10 acknowledgment checkboxes)
3. Pay $5.00 CAD/month via Square Web Payments SDK
4. Access their subscription dashboard

## What this is NOT (yet)

- **Fitbit integration**: Not included. The Muse artifact (h-car-multi-user-trial) has the full Fitbit connection via Google Health API and detector v2. This standalone app collects signups and payments; Fitbit connection and health monitoring happen in the Muse app.
- **Detector**: Not included. The detector runs in the Muse artifact.
- **Operator dashboard**: Not included. User management happens via the Muse artifact or direct database access.

## Architecture

- **Server**: Express.js (Node.js 18+)
- **Database**: SQLite (file-based, `hcar.db`). For production with persistent data across deploys, migrate to Neon Postgres (free tier) or Render Postgres.
- **Auth**: JWT tokens (7-day expiry), PBKDF2 password hashing (bcryptjs)
- **Payments**: Square Web Payments SDK (browser) + Square Subscriptions API (server)
- **Security**: Helmet headers, CORS, rate limiting (100 req/15min, 5 signups/hour)

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `SQUARE_ACCESS_TOKEN` | Square Production Access Token (from developer.squareup.com) | `sq0atp-...` |
| `SQUARE_APPLICATION_ID` | Square Application ID (public) | `sq0idp-AjjPPKKmlIAWk17Uf6sQvw` |
| `SQUARE_LOCATION_ID` | Square Location ID | `L5A30BMAGNY4E` |
| `SQUARE_PLAN_VARIATION_ID` | H-CAR Monthly plan variation | `XU5OAQ4SZB4GA4DYN65KZYFD` |
| `JWT_SECRET` | Random string for JWT signing | Generate with `openssl rand -hex 32` |
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
2. **Set up a custom domain** (optional): Buy a domain (e.g., hcar.ca, ~$15/year from Namecheap or Cloudflare) and point it to your Render URL. This is not required for launch.
3. **Migrate the database** to Neon Postgres before you have real paying customers (SQLite data loss on redeploy is unacceptable for production).
4. **Add Fitbit integration**: The detector and Fitbit connection live in the Muse artifact. To bring them into this standalone app, you need to port the Google Health API integration and detector v2 logic. This is a separate project.

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
