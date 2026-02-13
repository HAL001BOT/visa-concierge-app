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
  // v1: login + basic blocked/lockout detection.
  // City/month availability parsing can be layered in once we stabilize selectors.
  const payload = JSON.parse(job.payload_json);
  const client = payload.client || {};

  const portalUrl = client.portal_url || 'https://ais.usvisa-info.com/';
  const username = client.username;
  const password = client.password;

  if (!username || !password) {
    return { summary: 'Blocked: missing credentials in payload', details: { stage: 'precheck' } };
  }

  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const details = {
    stage: 'start',
    portalUrl,
    target_cities: client.target_cities,
    target_months: client.target_months
  };

  try {
    await page.goto(portalUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // If already on sign-in page, proceed; otherwise click Sign in.
    const signInLink = page.getByRole('link', { name: /sign in/i });
    if (await signInLink.count()) {
      await signInLink.first().click({ timeout: 15000 });
    }

    // Detect lockout banner text if present.
    const lockout = await page.locator('text=/account is locked/i').first().isVisible().catch(() => false);
    if (lockout) {
      details.stage = 'lockout';
      return { summary: 'Blocked: account locked (cooldown required)', details };
    }

    // Fill credentials
    details.stage = 'fill';
    await page.getByLabel(/email/i).fill(String(username), { timeout: 15000 }).catch(async () => {
      await page.locator('input[type="email"], input[name*="email" i]').first().fill(String(username));
    });
    await page.getByLabel(/password/i).fill(String(password), { timeout: 15000 }).catch(async () => {
      await page.locator('input[type="password"]').first().fill(String(password));
    });

    // Try to accept terms/privacy if checkbox present
    details.stage = 'consent';
    const consent = page.locator('label:has-text("Privacy Policy"), label:has-text("Terms of")').first();
    if (await consent.count()) {
      await consent.click({ timeout: 5000 }).catch(() => {});
    }

    // Submit
    details.stage = 'submit';
    const btn = page.getByRole('button', { name: /sign in/i });
    if (await btn.count()) await btn.first().click({ timeout: 15000 });

    // Wait for navigation or error.
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});

    // CAPTCHA / verification heuristics
    details.stage = 'post';
    const captcha = await page.locator('text=/captcha|verify you are human/i').first().isVisible().catch(() => false);
    if (captcha) return { summary: 'Blocked: CAPTCHA / verification required', details };

    const invalid = await page.locator('text=/invalid|incorrect/i').first().isVisible().catch(() => false);
    if (invalid) return { summary: 'Blocked: invalid credentials', details };

    // At this point we’re logged in OR the site didn’t show an obvious error.
    // We return a conservative summary until calendar parsing is added.
    return {
      summary: `Logged in OK. Next: availability check for ${client.target_months || 'requested months'} in ${client.target_cities || 'requested cities'}`,
      details
    };
  } catch (err) {
    return { summary: `Blocked: automation error (${err.message})`, details: { ...details, stage: details.stage } };
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
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
