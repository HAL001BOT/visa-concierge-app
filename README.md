# Visa Concierge App (v1)

Simple intake form + admin dashboard draft.

## Features
- Public intake form for client onboarding
- Admin login page
- Admin dashboard listing submitted clients
- **Encrypted credential storage at rest** (AES-256-GCM via `CREDENTIALS_KEY`)
- Per-client monitoring status + manual check controls
- Queue a job from the admin dashboard
- Worker polling API (worker pulls queued jobs; no inbound access to worker required)
- SQLite local storage

## Quick run
```bash
npm install
cp .env.example .env
# edit .env (set ADMIN_PASSWORD + SESSION_SECRET + CREDENTIALS_KEY + WORKER_TOKEN)
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
   - `WORKER_TOKEN`
5. Add a persistent disk mounted at `/var/data`.

### Railway
1. New Project → Deploy from GitHub repo.
2. Set env vars:
   - `ADMIN_PASSWORD`
   - `SESSION_SECRET`
   - `CREDENTIALS_KEY`
3. Start command: `npm start`

## Worker polling API (recommended)
Why: the worker makes **outbound** HTTPS requests to Render, so you don’t expose your home machine / worker to the public internet.

### Auth
Set `WORKER_TOKEN` in Render. Worker calls with:
`Authorization: Bearer <WORKER_TOKEN>`

### Claim a job
`POST /api/worker/claim`
Returns `{ job: null }` when empty, or a claimed job.

### Complete a job
`POST /api/worker/jobs/:id/complete`
Body:
```json
{ "status": "done", "result": { "summary": "...", "details": {} } }
```

### Job payload
Each job contains `payload_json` with:
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
