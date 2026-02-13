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

function splitList(s) {
  return String(s || '')
    .split(/,|\n/)
    .map(x => x.trim())
    .filter(Boolean);
}

function normalizeMonthToken(s) {
  const t = String(s || '').trim().toLowerCase();
  const map = {
    jan: 'january', enero: 'january', january: 'january',
    feb: 'february', febrero: 'february', february: 'february',
    mar: 'march', marzo: 'march', march: 'march',
    apr: 'april', abril: 'april', april: 'april',
    may: 'may', mayo: 'may',
    jun: 'june', junio: 'june', june: 'june',
    jul: 'july', julio: 'july', july: 'july',
    aug: 'august', agosto: 'august', august: 'august',
    sep: 'september', septiembre: 'september', september: 'september',
    oct: 'october', octubre: 'october', october: 'october',
    nov: 'november', noviembre: 'november', november: 'november',
    dec: 'december', diciembre: 'december', december: 'december'
  };

  // Handle common typos (e.g. 'febereo') by prefix match
  const key = t.slice(0, 3);
  if (map[t]) return map[t];
  if (map[key]) return map[key];
  if (t.startsWith('feb')) return 'february';
  if (t.startsWith('mar')) return 'march';
  if (t.startsWith('apr') || t.startsWith('abr')) return 'april';
  return t;
}

function monthInSet(monthTitle, desiredSet) {
  const title = String(monthTitle || '').toLowerCase();
  for (const m of desiredSet) {
    if (!m) continue;
    if (title.includes(m)) return true;
  }
  return false;
}

async function clickFirst(page, patterns) {
  for (const p of patterns) {
    const btn = page.getByRole('button', { name: p });
    if (await btn.count().catch(() => 0)) {
      await btn.first().click({ timeout: 15000 }).catch(() => {});
      return true;
    }
    const link = page.getByRole('link', { name: p });
    if (await link.count().catch(() => 0)) {
      await link.first().click({ timeout: 15000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function runVisaCheck(job) {
  const payload = JSON.parse(job.payload_json);
  const client = payload.client || {};

  const portalUrl = client.portal_url || 'https://ais.usvisa-info.com/';
  const username = client.username;
  const password = client.password;

  const targetCities = splitList(client.target_cities);
  const desiredMonths = new Set(splitList(client.target_months).map(normalizeMonthToken));

  if (!username || !password) {
    return { summary: 'Blocked: missing credentials in payload', details: { stage: 'precheck' } };
  }
  if (!targetCities.length || !desiredMonths.size) {
    return { summary: 'Blocked: missing targets (cities/months)', details: { stage: 'precheck' } };
  }

  const { chromium } = require('playwright');
  const path = require('path');
  const fs = require('fs');

  const profilesDir = path.join(__dirname, 'profiles');
  fs.mkdirSync(profilesDir, { recursive: true });
  const userDataDir = path.join(profilesDir, `client-${client.id || 'unknown'}`);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 800 }
  });
  const page = await context.newPage();

  const details = {
    stage: 'start',
    portalUrl,
    targetCities,
    desiredMonths: Array.from(desiredMonths)
  };

  try {
    const { origin } = new URL(portalUrl);

    // Try to land on a sign-in form deterministically.
    details.stage = 'goto';
    const signInCandidates = [
      portalUrl,
      `${origin}/en-mx/niv/users/sign_in`,
      `${origin}/en-us/niv/users/sign_in`,
      `${origin}/niv/users/sign_in`,
      `${origin}/users/sign_in`
    ];

    const emailSelector = 'input[type="email"], input#user_email, input[name*="email" i], input[name*="username" i], input#Email';

    for (const u of signInCandidates) {
      await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

      // Country gate: select Mexico if present
      const countrySelectAny = page.locator('select').first();
      const hasSelect = await countrySelectAny.isVisible().catch(() => false);
      if (hasSelect) {
        const mexOpt = page.locator('option', { hasText: /mexico/i }).first();
        if (await mexOpt.count().catch(() => 0)) {
          details.stage = 'country';
          await page.locator('select').first().selectOption({ label: /mexico/i }).catch(() => {});
          await clickFirst(page, [/go|submit|continue|next/i]).catch?.(() => {});
          await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
        }
      }

      const hasEmail = await page.locator(emailSelector).first().isVisible().catch(() => false);
      if (hasEmail) break;

      // Try clicking Sign in
      await clickFirst(page, [/sign in/i]).catch?.(() => {});
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});

      const hasEmailAfter = await page.locator(emailSelector).first().isVisible().catch(() => false);
      if (hasEmailAfter) break;
    }

    // Bot challenge heuristics
    const challenge = await page.locator('text=/verify you are human|checking your browser|captcha|cloudflare|challenge/i').first().isVisible().catch(() => false);
    if (challenge) {
      details.stage = 'challenge';
      return { summary: 'Blocked: verification challenge (CAPTCHA/bot check)', details: { ...details, url: page.url() } };
    }

    const lockout = await page.locator('text=/account is locked/i').first().isVisible().catch(() => false);
    if (lockout) {
      details.stage = 'lockout';
      return { summary: 'Blocked: account locked (cooldown required)', details };
    }

    // Fill credentials
    details.stage = 'fill';
    const emailInput = page.locator(emailSelector).first();
    await emailInput.waitFor({ state: 'visible', timeout: 30000 }).catch(async () => {
      throw new Error(`sign-in form not reachable (url=${page.url()})`);
    });
    await emailInput.fill(String(username));

    const passInput = page.locator('input[type="password"], input#user_password').first();
    await passInput.waitFor({ state: 'visible', timeout: 30000 });
    await passInput.fill(String(password));

    details.stage = 'consent';
    const consent = page.locator('label:has-text("Privacy Policy"), label:has-text("Terms")').first();
    if (await consent.count().catch(() => 0)) await consent.click({ timeout: 5000 }).catch(() => {});

    details.stage = 'submit';
    // Common AIS consent checkbox ids/classes
    const consentInput = page.locator('input#policy_confirmed, input[name*="policy" i][type="checkbox"], input[type="checkbox"]').first();
    if (await consentInput.isVisible().catch(() => false)) {
      const checked = await consentInput.isChecked().catch(() => false);
      if (!checked) await consentInput.check({ timeout: 5000 }).catch(() => {});
    }

    await clickFirst(page, [/sign in/i]).catch(() => {});
    // Fallback: submit by pressing Enter in password field
    await page.locator('input[type="password"], input#user_password').first().press('Enter').catch(() => {});

    // Give it time to redirect
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});

    details.stage = 'post';
    const urlNow = page.url();

    const captcha = await page.locator('text=/captcha|verify you are human|checking your browser|cloudflare|challenge/i').first().isVisible().catch(() => false);
    if (captcha) return { summary: 'Blocked: CAPTCHA / verification required', details: { ...details, url: urlNow } };

    const locked = await page.locator('text=/account is locked/i').first().isVisible().catch(() => false);
    if (locked) return { summary: 'Blocked: account locked (cooldown required)', details: { ...details, url: urlNow } };

    const invalid = await page.locator('text=/invalid|incorrect|wrong.*password|wrong.*email/i').first().isVisible().catch(() => false);
    if (invalid) return { summary: 'Blocked: invalid credentials', details: { ...details, url: urlNow } };

    // Still on sign-in URL after submit can be a false positive (some AIS flows render authenticated landing content here).
    if (/\/users\/sign_in/.test(urlNow)) {
      const looksLoggedIn = await page.locator('text=/Current Status|Schedule Appointment|Continue|Document Delivery/i').first().isVisible().catch(() => false);
      if (!looksLoggedIn) {
        const msg = await page.locator('.alert, .error, .validation-summary-errors, [class*="error" i]').first().innerText().catch(() => '');
        return { summary: `Blocked: login did not complete${msg ? ` (${msg.trim().slice(0,120)})` : ''}`, details: { ...details, url: urlNow } };
      }
      // Otherwise proceed as logged in.
    }

    // If we are still on sign-in, decide whether it's a real failure or we actually landed on the user home.
    if (/\/users\/sign_in/.test(page.url())) {
      const looksLoggedIn = await page.locator('text=/Current Status|Schedule Appointment|Continue|Document Delivery/i').first().isVisible().catch(() => false);
      if (!looksLoggedIn) {
        const msg = await page.locator('.alert, .error, .validation-summary-errors, [class*="error" i]').first().innerText().catch(() => '');
        return { summary: `Blocked: login did not complete${msg ? ` (${msg.trim().slice(0,140)})` : ''}`, details: { ...details, url: page.url() } };
      }
      // If content looks like the authenticated landing page, proceed.
    }

    // Navigate toward appointment page (robust)
    details.stage = 'nav';

    // Prefer direct "Continue" / dashboard actions if present.
    for (let i = 0; i < 4; i++) {
      const moved = await clickFirst(page, [/continue|continuar/i]);
      if (!moved) break;
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    }

    // Try explicit schedule/reschedule links
    await clickFirst(page, [/reschedule appointment|schedule appointment|reprogramar|programar/i]).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});

    // Fallback: click any link whose href contains /schedule/
    const schedLink = page.locator('a[href*="/schedule/"]').first();
    if (await schedLink.count().catch(() => 0)) {
      await schedLink.click({ timeout: 15000 }).catch(() => {});
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    }

    // Verify we can see a date input / datepicker trigger
    const consulateDate = page.locator('input#appointments_consulate_appointment_date, input[name*="consulate_appointment_date" i]').first();
    const ascDate = page.locator('input#appointments_asc_appointment_date, input[name*="asc_appointment_date" i]').first();
    const hasAnyDate = await consulateDate.isVisible().catch(() => false) || await ascDate.isVisible().catch(() => false);
    if (!hasAnyDate) {
      return { summary: `Blocked: couldn't reach calendar page (url=${page.url()})`, details: { ...details, url: page.url() } };
    }

    // Availability per city/month
    details.stage = 'availability';
    const found = [];

    for (const cityRaw of targetCities) {
      const city = cityRaw.trim();

      // Pick facility (try known facility selects first)
      const facilitySelect = page.locator('select#appointments_consulate_facility_id, select[name*="facility" i]').first();
      if (await facilitySelect.count().catch(() => 0)) {
        await facilitySelect.selectOption({ label: new RegExp(city, 'i') }).catch(() => {});
      }

      // Open consulate calendar first; if not present, use ASC.
      const dateInput = page.locator('input#appointments_consulate_appointment_date, input[name*="consulate_appointment_date" i], input#appointments_asc_appointment_date, input[name*="asc_appointment_date" i]').first();
      await dateInput.click({ timeout: 15000 });
      await page.waitForTimeout(250);

      // datepicker title and next
      const title = page.locator('.ui-datepicker-title').first();
      await title.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {
        throw new Error(`calendar did not open (url=${page.url()})`);
      });
      const next = page.locator('.ui-datepicker-next, a[title*="Next"], a[aria-label*="Next"]').first();

      let safety = 0;
      while (safety++ < 12) {
        const titleText = await title.innerText().catch(() => '');
        if (monthInSet(titleText, desiredMonths)) {
          const enabledDays = page.locator('.ui-datepicker-calendar td:not(.ui-datepicker-unselectable):not(.ui-state-disabled) a');
          const count = await enabledDays.count().catch(() => 0);
          if (count > 0) {
            const days = [];
            for (let i = 0; i < Math.min(count, 6); i++) {
              const d = (await enabledDays.nth(i).innerText().catch(() => '')).trim();
              if (d) days.push(d);
            }
            found.push({ city, month: titleText.trim(), days });
          }

          // if this month is desired but no days, still check next month
        }

        // advance month
        const canNext = await next.isVisible().catch(() => false);
        if (!canNext) break;
        await next.click().catch(() => {});
        await page.waitForTimeout(500);
      }
    }

    if (!found.length) {
      return { summary: `No matches for ${Array.from(desiredMonths).join(', ')} in ${targetCities.join(', ')}`, details };
    }

    const first = found[0];
    const dayPart = first.days?.length ? ` ${first.days.join(',')}` : '';
    return {
      summary: `FOUND: ${first.city} ${first.month}${dayPart}`,
      details: { ...details, found }
    };

  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.match(/x server|display|headed|no usable sandbox/i)) {
      return { summary: 'Blocked: worker has no desktop display for headful browser (needs X/Xvfb)', details: { ...details, error: msg } };
    }
    return { summary: `Blocked: automation error (${msg})`, details: { ...details, stage: details.stage } };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
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
