# Visa Concierge App (v1)

Simple intake form + admin dashboard draft.

## Features
- Public intake form for client onboarding
- Admin login page
- Admin dashboard listing submitted clients
- **Encrypted credential storage at rest** (AES-256-GCM via `CREDENTIALS_KEY`)
- Per-client monitoring status + manual check controls
- SQLite local storage

## Quick run
```bash
npm install
cp .env.example .env
# edit .env (set ADMIN_PASSWORD + SESSION_SECRET + CREDENTIALS_KEY)
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
5. Use a persistent disk if you keep SQLite in production.

### Railway
1. New Project → Deploy from GitHub repo.
2. Set env vars:
   - `ADMIN_PASSWORD`
   - `SESSION_SECRET`
   - `CREDENTIALS_KEY`
3. Start command: `npm start`

## Important
This is a starter draft. Before production, add:
- real secrets manager (Vault/1Password/Bitwarden)
- stronger auth (per-user admin accounts + MFA)
- worker queue for actual monitoring jobs
- legal docs + explicit consent capture workflow
