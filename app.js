const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const app = express();
const DB_PATH = process.env.DB_PATH || (process.env.RENDER ? '/var/data/data.db' : path.join(__dirname, 'data.db'));
const db = new Database(DB_PATH);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const PORT = process.env.PORT || 3000;
const CREDENTIALS_KEY = process.env.CREDENTIALS_KEY || 'change-this-32-char-key-now';
// Worker-polling model (recommended): worker polls this app for queued jobs.
const WORKER_TOKEN = process.env.WORKER_TOKEN || '';

if (CREDENTIALS_KEY.length < 16) {
  throw new Error('CREDENTIALS_KEY must be set and reasonably long.');
}

const ENC_KEY = crypto.createHash('sha256').update(CREDENTIALS_KEY).digest();

function encryptText(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

function decryptText(payload) {
  const [ivB64, tagB64, encB64] = String(payload || '').split('.');
  if (!ivB64 || !tagB64 || !encB64) return '';
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const enc = Buffer.from(encB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false }));

// Needed for worker API JSON bodies
app.use('/api/worker', express.json({ limit: '1mb' }));

// DB bootstrap + lightweight migration
const init = db.transaction(() => {
  db.prepare(`CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    contact_channel TEXT,
    contact_handle TEXT,
    timezone TEXT,
    portal_url TEXT NOT NULL,
    username TEXT NOT NULL,
    password_enc TEXT,
    target_cities TEXT,
    target_months TEXT,
    auto_book INTEGER DEFAULT 0,
    monitoring_active INTEGER DEFAULT 1,
    last_check_at TEXT,
    last_result TEXT,
    notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,                 -- e.g. 'visa_check'
    client_id INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',  -- queued|in_progress|done|error
    result_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT,
    finished_at TEXT,
    lease_expires_at TEXT,
    FOREIGN KEY(client_id) REFERENCES clients(id)
  )`).run();

  const cols = db.prepare(`PRAGMA table_info(clients)`).all().map(c => c.name);
  if (!cols.includes('password_enc')) db.prepare('ALTER TABLE clients ADD COLUMN password_enc TEXT').run();
  if (!cols.includes('monitoring_active')) db.prepare('ALTER TABLE clients ADD COLUMN monitoring_active INTEGER DEFAULT 1').run();
  if (!cols.includes('last_check_at')) db.prepare('ALTER TABLE clients ADD COLUMN last_check_at TEXT').run();
  if (!cols.includes('last_result')) db.prepare('ALTER TABLE clients ADD COLUMN last_result TEXT').run();

  // migrate legacy plaintext password column if it exists
  if (cols.includes('password')) {
    const rows = db.prepare('SELECT id, password, password_enc FROM clients').all();
    const update = db.prepare('UPDATE clients SET password_enc=? WHERE id=?');
    for (const r of rows) {
      if (!r.password_enc && r.password) update.run(encryptText(r.password), r.id);
    }
  }
});
init();

const requireAdmin = (req, res, next) => {
  if (!req.session?.admin) return res.redirect('/admin/login');
  next();
};

const requireWorker = (req, res, next) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  if (!WORKER_TOKEN || token !== WORKER_TOKEN) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
};

app.get('/', (req, res) => res.render('index', { ok: req.query.ok }));

app.post('/intake', (req, res) => {
  const body = req.body;
  db.prepare(`INSERT INTO clients (
    full_name, contact_channel, contact_handle, timezone, portal_url, username, password_enc,
    target_cities, target_months, auto_book, monitoring_active, last_result, notes
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(
      body.full_name,
      body.contact_channel,
      body.contact_handle,
      body.timezone,
      body.portal_url,
      body.username,
      encryptText(body.password),
      body.target_cities,
      body.target_months,
      body.auto_book ? 1 : 0,
      'Onboarded',
      body.notes || ''
    );

  res.redirect('/?ok=1');
});

app.get('/admin/login', (req, res) => res.render('admin-login', { error: null }));
app.post('/admin/login', (req, res) => {
  if ((req.body.password || '') !== ADMIN_PASSWORD) {
    return res.status(401).render('admin-login', { error: 'Invalid password' });
  }
  req.session.admin = true;
  res.redirect('/admin');
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

app.post('/admin/clients/:id/toggle', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT monitoring_active FROM clients WHERE id=?').get(id);
  if (!row) return res.redirect('/admin');
  const next = row.monitoring_active ? 0 : 1;
  db.prepare('UPDATE clients SET monitoring_active=?, last_result=? WHERE id=?')
    .run(next, next ? 'Monitoring resumed' : 'Monitoring paused', id);
  res.redirect('/admin');
});

app.get('/admin/clients/:id/edit', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const client = db.prepare('SELECT * FROM clients WHERE id=?').get(id);
  if (!client) return res.redirect('/admin');
  res.render('admin-edit-client', { client, ok: req.query.ok });
});

app.post('/admin/clients/:id/edit', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM clients WHERE id=?').get(id);
  if (!existing) return res.redirect('/admin');

  const body = req.body;
  const nextPasswordEnc = (body.password && String(body.password).trim())
    ? encryptText(String(body.password))
    : existing.password_enc;

  db.prepare(`UPDATE clients SET
      full_name=?, contact_channel=?, contact_handle=?, timezone=?, portal_url=?, username=?, password_enc=?,
      target_cities=?, target_months=?, auto_book=?, notes=?
    WHERE id=?`).run(
      body.full_name,
      body.contact_channel,
      body.contact_handle,
      body.timezone,
      body.portal_url,
      body.username,
      nextPasswordEnc,
      body.target_cities,
      body.target_months,
      body.auto_book ? 1 : 0,
      body.notes || '',
      id
    );

  db.prepare('UPDATE clients SET last_result=? WHERE id=?').run('Client updated', id);

  res.redirect(`/admin/clients/${id}/edit?ok=1`);
});

app.post('/admin/clients/:id/check', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const client = db.prepare(`
    SELECT id, full_name, contact_channel, contact_handle, timezone, portal_url, username,
           password_enc, target_cities, target_months, auto_book, monitoring_active
    FROM clients
    WHERE id=?
  `).get(id);

  if (!client) return res.redirect('/admin');

  const payload = {
    event: 'visa_check_request',
    requestedAt: new Date().toISOString(),
    client: {
      id: client.id,
      full_name: client.full_name,
      contact_channel: client.contact_channel,
      contact_handle: client.contact_handle,
      timezone: client.timezone,
      portal_url: client.portal_url,
      username: client.username,
      password: decryptText(client.password_enc),
      target_cities: client.target_cities,
      target_months: client.target_months,
      auto_book: !!client.auto_book
    }
  };

  db.prepare('INSERT INTO jobs (kind, client_id, payload_json, status) VALUES (?, ?, ?, ?)')
    .run('visa_check', id, JSON.stringify(payload), 'queued');

  db.prepare('UPDATE clients SET last_check_at=CURRENT_TIMESTAMP, last_result=? WHERE id=?')
    .run('Queued for worker', id);

  res.redirect('/admin');
});

// Worker polling endpoints
app.post('/api/worker/claim', requireWorker, (req, res) => {
  const leaseMinutes = 5;
  const leaseUntil = new Date(Date.now() + leaseMinutes * 60 * 1000).toISOString();

  // Re-queue expired leases
  db.prepare(`UPDATE jobs
              SET status='queued', lease_expires_at=NULL
              WHERE status='in_progress' AND lease_expires_at IS NOT NULL AND lease_expires_at < CURRENT_TIMESTAMP`).run();

  const job = db.prepare(`
    SELECT * FROM jobs
    WHERE status='queued'
    ORDER BY created_at ASC
    LIMIT 1
  `).get();

  if (!job) return res.json({ ok: true, job: null });

  db.prepare(`UPDATE jobs
              SET status='in_progress', started_at=COALESCE(started_at, CURRENT_TIMESTAMP), lease_expires_at=?
              WHERE id=?`).run(leaseUntil, job.id);

  const claimed = db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id);
  res.json({ ok: true, job: claimed });
});

app.post('/api/worker/jobs/:id/complete', requireWorker, (req, res) => {
  try {
    const id = Number(req.params.id);
    const body = req.body || {};
    const status = body.status === 'done' ? 'done' : 'error';
    const resultJson = JSON.stringify(body.result || {});

    db.prepare(`UPDATE jobs SET status=?, result_json=?, finished_at=CURRENT_TIMESTAMP, lease_expires_at=NULL WHERE id=?`)
      .run(status, resultJson, id);

    // Best-effort: write summary into client last_result
    const job = db.prepare('SELECT client_id FROM jobs WHERE id=?').get(id);
    if (job?.client_id) {
      const summary = body.result?.summary || (status === 'done' ? 'Completed' : 'Failed');
      db.prepare('UPDATE clients SET last_check_at=CURRENT_TIMESTAMP, last_result=? WHERE id=?')
        .run(summary, job.client_id);
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: 'bad_request' });
  }
});

app.get('/admin', requireAdmin, (req, res) => {
  const clients = db.prepare(`
    SELECT id, full_name, contact_channel, contact_handle, timezone, portal_url, username,
           target_cities, target_months, auto_book, monitoring_active, last_check_at, last_result,
           notes, created_at
    FROM clients
    ORDER BY created_at DESC
  `).all();
  res.render('admin', { clients });
});

app.listen(PORT, () => {
  console.log(`Visa concierge app running on http://localhost:${PORT}`);
});
