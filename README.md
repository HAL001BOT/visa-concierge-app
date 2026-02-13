# Visa Concierge App (v1)

Simple intake form + admin dashboard draft.

## Features
- Public intake form for client onboarding
- Admin login page
- Admin dashboard listing submitted clients
- **Encrypted credential storage at rest** (AES-256-GCM via `CREDENTIALS_KEY`)
- Per-client monitoring status + manual check controls
- “Send to Bot” action that posts a check request to your automation webhook
- SQLite local storage

## Quick run
```bash
npm install
cp .env.example .env
# edit .env (set ADMIN_PASSWORD + SESSION_SECRET + CREDENTIALS_KEY + bot webhook vars)
npm start
```

Open:
- Intake: `http://localhost:3000/`
- Admin: `http://localhost:3000/admin/login`

## Deploy

### Render (one-click blueprint flow)
1. Create a new **Web Service** from this repo.
2. Build command: `npm install`
3. Start command: `npm start`
4. Add env vars:
   - `ADMIN_PASSWORD`
   - `SESSION_SECRET`
   - `CREDENTIALS_KEY`
   - `DB_PATH=/var/data/data.db` (recommended on Render)
   - `BOT_WEBHOOK_URL`
   - `BOT_WEBHOOK_TOKEN`
5. Add a persistent disk mounted at `/var/data`.

### Railway
1. New Project → Deploy from GitHub repo.
2. Set env vars:
   - `ADMIN_PASSWORD`
   - `SESSION_SECRET`
   - `CREDENTIALS_KEY`
3. Start command: `npm start`

## Bot webhook contract
When you click **Send to Bot**, the app POSTs JSON to `BOT_WEBHOOK_URL` with `Authorization: Bearer <BOT_WEBHOOK_TOKEN>`.
Payload shape:

```json
{
  "event": "visa_check_request",
  "requestedAt": "ISO_DATE",
  "client": {
    "id": 1,
    "full_name": "...",
    "contact_channel": "Telegram",
    "contact_handle": "...",
    "portal_url": "https://ais.usvisa-info.com/",
    "username": "...",
    "password": "...",
    "target_cities": "Mexico City, Guadalajara",
    "target_months": "February, March",
    "auto_book": false
  }
}
```

## Important
This is a starter draft. Before production, add:
- real secrets manager (Vault/1Password/Bitwarden)
- stronger auth (per-user admin accounts + MFA)
- worker queue for actual monitoring jobs
- legal docs + explicit consent capture workflow
