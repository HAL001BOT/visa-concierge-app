# Worker (polling)

This worker polls the Render app for queued jobs and processes them.

## Env vars
- `RENDER_APP_URL` (e.g. `https://your-service.onrender.com`)
- `WORKER_TOKEN` (must match Render `WORKER_TOKEN`)
- `POLL_MS` (optional, default 15000)

## Run
```bash
node worker.js
```

## TODO
Wire `runVisaCheck()` to your OpenClaw/Playwright visa automation.
