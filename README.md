# Visa Concierge App (v1)

Simple intake form + admin dashboard draft.

## Features
- Public intake form for client onboarding
- Admin login page
- Admin dashboard listing submitted clients
- SQLite local storage

## Run
```bash
npm install
cp .env.example .env
# edit .env (set ADMIN_PASSWORD + SESSION_SECRET)
node app.js
```

Open:
- Intake: `http://localhost:3000/`
- Admin: `http://localhost:3000/admin/login`

## Important
This is a starter draft. Before production, add:
- encrypted secrets storage
- stronger auth (not single shared password)
- audit logging + role-based access
- legal docs and consent capture workflow
