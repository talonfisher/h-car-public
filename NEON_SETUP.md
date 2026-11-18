# Neon Postgres Setup for H-CAR

This guide walks through setting up a Neon Postgres database for H-CAR. Neon offers a free tier with 3GB storage, which is plenty for the 40-person trial.

## Why Neon?

The previous SQLite database was stored on Render's ephemeral filesystem, which is wiped on every deploy and restart. This caused Talon's account (and his $5 subscription) to be lost when the Fitbit update deployed. Neon Postgres is a cloud database that persists across deploys.

## Step 1: Create a Neon Account

1. Go to https://neon.tech
2. Click "Sign Up" or "Get Started"
3. Sign up with GitHub (use the talonfisher account) or with email tfcontracting@shaw.ca
4. Complete the signup flow

## Step 2: Create a Project

1. In the Neon dashboard, click "New Project"
2. Name: `h-car`
3. Region: Choose the closest region (US West - Oregon, or US East - Virginia)
4. Postgres version: Leave at default (16 or 17)
5. Click "Create Project"

## Step 3: Create a Database

1. Neon creates a default database called `neondb`. You can use this, or create a new one:
   - In the Neon dashboard, go to your project
   - Click "Databases" in the sidebar
   - Click "New Database"
   - Name: `hcar`
   - Owner: Leave as default
   - Click "Create"

## Step 4: Get the Connection String

1. In the Neon dashboard, go to your project
2. Click "Connection Details" or "Connect"
3. Select the `hcar` database (or `neondb` if you didn't create a new one)
4. Copy the connection string. It looks like:
   ```
   postgresql://username:password@ep-xxx-xxx.us-east-2.aws.neon.tech/hcar?sslmode=require
   ```
5. **Important**: This connection string contains your password. Keep it secret. Never commit it to GitHub.

## Step 5: Set DATABASE_URL in Render

1. Go to https://dashboard.render.com
2. Find the `h-car` web service
3. Click "Environment" in the sidebar
4. Click "Add Environment Variable"
5. Key: `DATABASE_URL`
6. Value: Paste the Neon connection string from Step 4
7. Click "Save Changes"
8. Render will redeploy the app with the new database connection

## Step 6: Verify the Connection

1. Wait for Render to finish deploying (about 1-2 minutes)
2. Go to https://h-car.onrender.com/api/health
3. You should see:
   ```json
   {
     "status": "ok",
     "app": "H-CAR",
     "version": "1.2.0",
     "googleHealthConfigured": false,
     "database": "postgres"
   }
   ```
4. If you see `"database": "postgres"`, the connection is working.

## Step 7: Create a New Account

Your old account was lost when the SQLite database was wiped. Create a new account:

1. Go to https://h-car.onrender.com
2. Click "Sign Up"
3. Use your email: tfcontracting@shaw.ca
4. Choose a password (8+ characters)
5. Complete the 11 consent checkboxes
6. Complete the $5 payment

## Re-linking Your Square Subscription

If you already paid $5 and have an active Square subscription, you do not need to pay again. After creating your new account:

1. Your Square customer ID is: `30CWJJF2P4CBDKY68RDY6BWC3M`
2. Contact Muse to re-link your subscription to your new account
3. Muse can update the database to link your Square customer ID and subscription ID to your new user account

Alternatively, if you prefer to start fresh:
1. Cancel the old subscription in Square Dashboard (https://app.squareup.com)
2. Create a new account on H-CAR
3. Pay $5 again through the site

## Neon Free Tier Limits

- 3GB storage (plenty for the trial)
- 1 project
- Unlimited queries
- Database never sleeps (unlike Render Free)
- No credit card required

## Troubleshooting

### "Connection failed" error in Render logs
- Check that DATABASE_URL is set correctly in Render
- Verify the connection string includes `?sslmode=require` at the end
- Make sure you copied the full connection string from Neon

### "Database does not exist" error
- Verify the database name in the connection string matches the database you created in Neon
- If you used the default `neondb`, the connection string should end with `/neondb?sslmode=require`
- If you created `hcar`, it should end with `/hcar?sslmode=require`

### Tables not created
- The app creates tables automatically on startup via `initDatabase()`
- Check the Render logs for "Database tables initialized"
- If tables are missing, check the logs for errors

## Cost

Neon Postgres Free Tier: $0/month
- 3GB storage
- 1 project
- Unlimited connections

When you outgrow the free tier (unlikely for the 40-person trial), Neon paid plans start at $19/month.
