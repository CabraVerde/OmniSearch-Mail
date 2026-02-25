# OmniSearch Mail — Setup TODO (complete before running the app)

## Step 1 — Create Web OAuth Client for user sign-in

The existing "desktop app" credentials are for the Gmail API only.
Google Sign-In (users logging into the app) needs a separate Web client.

1. Go to: https://console.cloud.google.com/apis/credentials
2. Click **+ Create Credentials → OAuth 2.0 Client ID**
3. Application type: **Web application**
4. Name: `OmniSearch Mail Sign-In`
5. Under **Authorised JavaScript origins** add:
   - `http://localhost:5000` (local dev)
   - Your production URL when deploying (e.g. `https://mail.thegbexchange.com`)
6. Leave **Authorised redirect URIs** blank (GIS doesn't need them)
7. Click **Create** — copy the **Client ID**
   - Looks like: `123456789-abc.apps.googleusercontent.com`

---

## Step 2 — Create .env file

Create a file called `.env` in the project root (same folder as `package.json`).

```env
# Generate with: openssl rand -hex 32
SESSION_SECRET=REPLACE_WITH_GENERATED_SECRET

# From Step 1 (same value in both places)
GOOGLE_CLIENT_ID=REPLACE_WITH_WEB_CLIENT_ID
VITE_GOOGLE_CLIENT_ID=REPLACE_WITH_WEB_CLIENT_ID

# 3 admin emails only
ADMIN_EMAILS=you@thegbexchange.com,admin2@thegbexchange.com,admin3@thegbexchange.com

# VPN exit IP(s) — leave blank during local dev if not on VPN yet
ADMIN_ALLOWED_IPS=

# Map each account index to its mailbox email
GMAIL_ACCOUNT_1_EMAIL=firstmailbox@thegbexchange.com
GMAIL_ACCOUNT_2_EMAIL=secondmailbox@thegbexchange.com

# Paste the full JSON content of each credentials file (minified, on one line)
GMAIL_CREDENTIALS_1={"installed":{"client_id":"...","client_secret":"...","redirect_uris":["http://localhost"]}}
GMAIL_CREDENTIALS_2={"installed":{"client_id":"...","client_secret":"...","redirect_uris":["http://localhost"]}}

# Leave blank now — filled in after Step 3
GMAIL_REFRESH_TOKEN_1=
GMAIL_REFRESH_TOKEN_2=

# Path config (defaults are fine, no need to change)
MAILBOX_GRANTS_PATH=config/MAILBOX_GRANTS.json
AUDIT_LOG_PATH=audit.log
```

**How to minify credentials JSON for the env var:**
```bash
cat your-credentials-file.json | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin)))"
```
Paste the single-line output as the value.

---

## Step 3 — Authorize Gmail accounts (one-time)

This exchanges your credentials for refresh tokens so the app works permanently.

1. Run: `npm run dev`
2. Open `http://localhost:5000`
3. Sign in with your **admin** Google Workspace account
4. In the sidebar, click **Authorize Access** on Account 1
   - A Google OAuth popup opens — sign in as that mailbox account and grant access
5. Repeat for Account 2
6. Both accounts show a green tick ✓

**Capture the refresh tokens** (so they survive server restarts):

When the server authorizes successfully it logs:
```
POST /api/auth/exchange-code 200
```
The refresh token is stored in memory. To extract it, temporarily hit this endpoint
as admin while the server is running:
```
GET /api/auth/status
```
Or look at the terminal — the token is not logged directly.

**Better approach**: add the tokens to `.env` using the `/admin/accounts` route to
confirm authorization, then restart and re-authorize once with logging enabled
(see below), then paste the token into `.env`.

**Temporary token extraction** — run this in the app while authorizing:
- After clicking Authorize and completing OAuth, the server calls `handleAuthCallback`
  which stores the token in `tokenStore[token_N]`
- Add `console.log('REFRESH TOKEN:', tokens.refresh_token)` temporarily to
  `server/gmail.ts` line ~103, run once, copy the token, then remove the log line
- Paste into `.env` as `GMAIL_REFRESH_TOKEN_1` / `GMAIL_REFRESH_TOKEN_2`

---

## Step 4 — Edit MAILBOX_GRANTS.json

File is at: `config/MAILBOX_GRANTS.json`

Replace placeholder emails with your real 8 users. Example:

```json
{
  "alice@thegbexchange.com": ["alice@thegbexchange.com"],
  "bob@thegbexchange.com": ["bob@thegbexchange.com"],
  "carol@thegbexchange.com": ["carol@thegbexchange.com", "accounts@thegbexchange.com"],
  "david@thegbexchange.com": ["david@thegbexchange.com", "accounts@thegbexchange.com"],
  "admin1@thegbexchange.com": ["admin1@thegbexchange.com", "accounts@thegbexchange.com"]
}
```

Rules:
- Key = the user's Google Workspace sign-in email
- Value = array of mailboxes they can search
- Admins listed in `ADMIN_EMAILS` bypass this file entirely

---

## Step 5 — Smoke test checklist

- [ ] `npm run dev` starts without errors (no `SESSION_SECRET` crash)
- [ ] `http://localhost:5000` shows Google Sign-In screen
- [ ] Sign in with admin account → lands in app, shows shield icon in sidebar
- [ ] Sign in with non-admin account (incognito) → no credential upload / authorize buttons visible
- [ ] Non-admin only sees mailboxes listed in their MAILBOX_GRANTS entry
- [ ] Search returns results
- [ ] `GET /admin/audit` returns `{ "lines": [] }` (empty log, confirms admin route works)
- [ ] `GET /admin/audit` from non-admin or non-VPN IP → returns 403
- [ ] Sign out → returns to Google Sign-In screen

---

## Notes

- `.env` → **never commit** (already in `.gitignore` — verify this)
- `config/MAILBOX_GRANTS.json` → safe to commit (no secrets)
- `audit.log` → created in project root on first admin access; rotate in production
- For production deployment:
  - Set `NODE_ENV=production` (enables HTTPS-only cookies)
  - Set `ADMIN_ALLOWED_IPS` to your VPN exit IP
  - Set `TRUST_PROXY=1` if behind nginx/load balancer
  - Add production URL to Google Cloud Console Authorised JavaScript origins
