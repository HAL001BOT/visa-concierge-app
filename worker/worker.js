#!/usr/bin/env node
/**
 * Visa Concierge polling worker.
 *
 * Polls the Render app for queued jobs and processes them.
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

async function pageInfo(page) {
  const url = page.url();
  const title = await page.title().catch(() => '');
  return { url, title };
}

async function isChallenge(page) {
  return await page.locator('text=/verify you are human|checking your browser|captcha|cloudflare|challenge/i').first()
    .isVisible().catch(() => false);
}

async function isLocked(page) {
  return await page.locator('text=/account is locked/i').first().isVisible().catch(() => false);
}

async function looksLoggedIn(page) {
  // AIS is inconsistent; use multiple hints.
  const hints = [
    /Current Status/i,
    /Schedule Appointment/i,
    /Document Delivery/i,
    /Sign Out|Logout|Cerrar sesi\u00f3n/i
  ];
  for (const h of hints) {
    const ok = await page.locator(`text=${h}`).first().isVisible().catch(() => false);
    if (ok) return true;
  }
  return false;
}

async function ensureMexicoCountrySelected(page, details) {
  // If a country selector is present and contains Mexico, select it.
  const select = page.locator('select').first();
  const hasSelect = await select.isVisible().catch(() => false);
  if (!hasSelect) return;

  const mexOpt = page.locator('option', { hasText: /mexico/i }).first();
  if (!await mexOpt.count().catch(() => 0)) return;

  details.stage = 'country';
  await select.selectOption({ label: /mexico/i }).catch(() => {});
  await clickFirst(page, [/go|submit|continue|next/i]).catch(() => {});
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
}

async function gotoSignIn(page, portalUrl, details) {
  const { origin } = new URL(portalUrl);

  details.stage = 'goto';
  const candidates = [
    `${origin}/en-mx/niv/users/sign_in`,
    `${origin}/en-us/niv/users/sign_in`,
    `${origin}/niv/users/sign_in`,
    `${origin}/users/sign_in`,
    portalUrl
  ];

  for (const u of candidates) {
    await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await ensureMexicoCountrySelected(page, details);

    if (await isChallenge(page)) return;

    const emailInput = page.locator('input[type="email"], input#user_email, input[name*="email" i], input[name*="username" i], input#Email').first();
    const visible = await emailInput.isVisible().catch(() => false);
    if (visible) return;

    // Sometimes sign-in is behind a link.
    await clickFirst(page, [/sign in/i]).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});

    const visibleAfter = await emailInput.isVisible().catch(() => false);
    if (visibleAfter) return;
  }
}

async function doLogin(page, username, password, details) {
  // If already logged in, skip.
  if (await looksLoggedIn(page)) return 'logged_in';

  if (await isChallenge(page)) return 'blocked_challenge';
  if (await isLocked(page)) return 'blocked_lockout';

  details.stage = 'fill';
  const email = page.locator('input[type="email"], input#user_email, input[name*="email" i], input[name*="username" i], input#Email').first();
  await email.waitFor({ state: 'visible', timeout: 30000 });
  await email.fill(String(username));

  const pass = page.locator('input[type="password"], input#user_password').first();
  await pass.waitFor({ state: 'visible', timeout: 30000 });
  await pass.fill(String(password));

  details.stage = 'consent';
  // Best-effort consent
  const consentLabel = page.locator('label:has-text("Privacy Policy"), label:has-text("Terms")').first();
  if (await consentLabel.count().catch(() => 0)) await consentLabel.click({ timeout: 5000 }).catch(() => {});
  const consentInput = page.locator('input#policy_confirmed, input[name*="policy" i][type="checkbox"], input[type="checkbox"]').first();
  if (await consentInput.isVisible().catch(() => false)) {
    const checked = await consentInput.isChecked().catch(() => false);
    if (!checked) await consentInput.check({ timeout: 5000 }).catch(() => {});
  }

  details.stage = 'submit';
  await clickFirst(page, [/sign in/i]).catch(() => {});
  await pass.press('Enter').catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});

  details.stage = 'post';
  if (await isChallenge(page)) return 'blocked_challenge';
  if (await isLocked(page)) return 'blocked_lockout';

  const invalid = await page.locator('text=/invalid|incorrect|wrong.*password|wrong.*email/i').first().isVisible().catch(() => false);
  if (invalid) return 'blocked_invalid_creds';

  if (await looksLoggedIn(page)) return 'logged_in';

  // Still not clearly logged in.
  return 'blocked_login_unknown';
}

async function gotoCalendarPage(page, details) {
  details.stage = 'nav_home';

  // From authenticated landing, we need to reach schedule page.
  // Deterministic strategy:
  // 1) Click Continue (sometimes needed)
  // 2) Click Schedule/Reschedule
  // 3) Otherwise: follow a href containing /schedule/

  for (let i = 0; i < 4; i++) {
    const moved = await clickFirst(page, [/continue|continuar/i]);
    if (!moved) break;
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  }

  details.stage = 'nav_schedule';
  await clickFirst(page, [/reschedule appointment|schedule appointment|reprogramar|programar/i]).catch(() => {});
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});

  // Try direct schedule link
  const schedLink = page.locator('a[href*="/schedule/"]').first();
  if (await schedLink.count().catch(() => 0)) {
    await schedLink.click({ timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  }

  details.stage = 'nav_verify_calendar';
  const consulateDate = page.locator('input#appointments_consulate_appointment_date, input[name*="consulate_appointment_date" i]').first();
  const ascDate = page.locator('input#appointments_asc_appointment_date, input[name*="asc_appointment_date" i]').first();
  const hasAny = await consulateDate.isVisible().catch(() => false) || await ascDate.isVisible().catch(() => false);
  return hasAny;
}

async function setFacility(page, city, details) {
  details.stage = 'facility';

  // Use explicit facility selects if present.
  const sel = page.locator('select#appointments_consulate_facility_id, select#appointments_asc_facility_id, select[name*="facility" i]').first();
  if (!await sel.count().catch(() => 0)) return false;

  // Try selecting by label.
  const ok = await sel.selectOption({ label: new RegExp(city, 'i') }).then(() => true).catch(() => false);
  return ok;
}

async function openDatepicker(page, details) {
  details.stage = 'open_calendar';

  const dateInput = page.locator(
    'input#appointments_consulate_appointment_date, input[name*="consulate_appointment_date" i], ' +
    'input#appointments_asc_appointment_date, input[name*="asc_appointment_date" i]'
  ).first();

  await dateInput.click({ timeout: 15000 });
  await page.waitForTimeout(250);

  const title = page.locator('.ui-datepicker-title').first();
  await title.waitFor({ state: 'visible', timeout: 10000 });

  return { title, next: page.locator('.ui-datepicker-next, a[title*="Next"], a[aria-label*="Next"]').first() };
}

async function scanCalendar(page, desiredMonths, details) {
  details.stage = 'scan_calendar';

  const { title, next } = await openDatepicker(page, details);

  const found = [];
  let safety = 0;
  while (safety++ < 12) {
    const titleText = (await title.innerText().catch(() => '')).trim();

    if (monthInSet(titleText, desiredMonths)) {
      // Enabled day anchors.
      const enabledDays = page.locator('.ui-datepicker-calendar td:not(.ui-datepicker-unselectable):not(.ui-state-disabled) a');
      const count = await enabledDays.count().catch(() => 0);
      if (count > 0) {
        const days = [];
        for (let i = 0; i < Math.min(count, 10); i++) {
          const d = (await enabledDays.nth(i).innerText().catch(() => '')).trim();
          if (d) days.push(d);
        }
        found.push({ month: titleText, days });
      }
    }

    const canNext = await next.isVisible().catch(() => false);
    if (!canNext) break;
    await next.click().catch(() => {});
    await page.waitForTimeout(400);
  }

  return found;
}

async function runVisaCheck(job) {
  const payload = JSON.parse(job.payload_json);
  const client = payload.client || {};

  const portalUrl = client.portal_url || 'https://ais.usvisa-info.com/';
  const username = client.username;
  const password = client.password;

  const targetCities = splitList(client.target_cities);
  const desiredMonths = new Set(splitList(client.target_months).map(normalizeMonthToken));

  if (!username || !password) return { summary: 'Blocked: missing credentials', details: { stage: 'precheck' } };
  if (!targetCities.length || !desiredMonths.size) return { summary: 'Blocked: missing targets (cities/months)', details: { stage: 'precheck' } };

  const details = {
    stage: 'start',
    portalUrl,
    targetCities,
    desiredMonths: Array.from(desiredMonths)
  };

  const { chromium } = require('playwright');
  const path = require('path');
  const fs = require('fs');

  const profilesDir = path.join(__dirname, 'profiles');
  fs.mkdirSync(profilesDir, { recursive: true });
  const userDataDir = path.join(profilesDir, `client-${client.id || 'unknown'}`);

  let context;
  let page;

  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      viewport: { width: 1280, height: 800 }
    });
    page = await context.newPage();

    // STATE: go to sign-in
    await gotoSignIn(page, portalUrl, details);

    if (await isChallenge(page)) {
      return { summary: 'Blocked: verification challenge (CAPTCHA/bot check)', details: { ...details, ...(await pageInfo(page)) } };
    }

    // STATE: login
    details.stage = 'login';
    const loginState = await doLogin(page, username, password, details);

    if (loginState === 'blocked_challenge') {
      return { summary: 'Blocked: verification challenge (CAPTCHA/bot check)', details: { ...details, ...(await pageInfo(page)) } };
    }
    if (loginState === 'blocked_lockout') {
      return { summary: 'Blocked: account locked (cooldown required)', details: { ...details, ...(await pageInfo(page)) } };
    }
    if (loginState === 'blocked_invalid_creds') {
      return { summary: 'Blocked: invalid username/password', details: { ...details, ...(await pageInfo(page)) } };
    }
    if (loginState !== 'logged_in') {
      return { summary: 'Blocked: login did not complete (unknown)', details: { ...details, ...(await pageInfo(page)) } };
    }

    // STATE: navigate to calendar page
    details.stage = 'nav_calendar';
    const okCalendar = await gotoCalendarPage(page, details);
    if (!okCalendar) {
      return { summary: `Blocked: couldn't reach calendar page`, details: { ...details, ...(await pageInfo(page)) } };
    }

    // STATE: check availability
    details.stage = 'availability';
    const foundByCity = [];

    for (const cityRaw of targetCities) {
      const city = cityRaw.trim();
      await setFacility(page, city, details).catch(() => {});

      const perMonth = await scanCalendar(page, desiredMonths, details);
      if (perMonth.length) foundByCity.push({ city, perMonth });
    }

    if (!foundByCity.length) {
      return { summary: `No matches for ${Array.from(desiredMonths).join(', ')} in ${targetCities.join(', ')}`, details };
    }

    // Summarize first hit
    const firstCity = foundByCity[0];
    const firstMonth = firstCity.perMonth[0];
    const days = firstMonth.days?.slice(0, 8) || [];

    return {
      summary: `FOUND: ${firstCity.city} ${firstMonth.month}${days.length ? ` ${days.join(',')}` : ''}`,
      details: { ...details, foundByCity }
    };

  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.match(/x server|display|headed|no usable sandbox/i)) {
      return { summary: 'Blocked: worker has no desktop display for headful browser', details: { ...details, error: msg } };
    }
    return { summary: `Blocked: automation error (${msg})`, details: { ...details, ...(page ? await pageInfo(page) : {}) } };
  } finally {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
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

      try {
        let result;
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
      await sleep(Math.min(POLL_MS * 2, 60000));
    }
  }
}

loop().catch((e) => {
  console.error(e);
  process.exit(1);
});
