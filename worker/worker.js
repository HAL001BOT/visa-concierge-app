#!/usr/bin/env node
/**
 * Simple polling worker for visa-concierge-app.
 *
 * Usage:
 *   RENDER_APP_URL=https://your-render-app.onrender.com \
 *   WORKER_TOKEN=... \
 *   node worker.js
 */

const APP_URL = process.env.RENDER_APP_URL;
const TOKEN = process.env.WORKER_TOKEN;
const POLL_MS = Number(process.env.POLL_MS || 15000);

if (!APP_URL) throw new Error('Missing RENDER_APP_URL');
if (!TOKEN) throw new Error('Missing WORKER_TOKEN');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function api(path, opts = {}) {
  const res = await fetch(`${APP_URL}${path}`, {
    ...opts,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      ...(opts.headers || {})
    }
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

async function runVisaCheck(job) {
  // Placeholder: wire this to your OpenClaw/Playwright automation.
  // job.payload_json has client creds + targets.
  const payload = JSON.parse(job.payload_json);
  const client = payload.client;

  // For now just acknowledge.
  return {
    summary: `Worker received job for ${client.full_name} (${client.target_months})`,
    details: { kind: job.kind, client_id: client.id }
  };
}

async function loop() {
  while (true) {
    try {
      const { ok, job } = await api('/api/worker/claim', { method: 'POST', body: '{}' });
      if (!ok) throw new Error('claim failed');

      if (!job) {
        await sleep(POLL_MS);
        continue;
      }

      let result;
      try {
        if (job.kind === 'visa_check') result = await runVisaCheck(job);
        else result = { summary: `Unknown job kind: ${job.kind}` };

        await api(`/api/worker/jobs/${job.id}/complete`, {
          method: 'POST',
          body: JSON.stringify({ status: 'done', result })
        });
      } catch (err) {
        await api(`/api/worker/jobs/${job.id}/complete`, {
          method: 'POST',
          body: JSON.stringify({ status: 'error', result: { summary: `Worker error: ${err.message}` } })
        });
      }

    } catch (err) {
      // backoff
      await sleep(Math.min(POLL_MS * 2, 60000));
    }
  }
}

loop().catch((e) => {
  console.error(e);
  process.exit(1);
});
