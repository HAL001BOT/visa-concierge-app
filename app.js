const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const app = express();
const db = new Database(path.join(__dirname, 'data.db'));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const PORT = process.env.PORT || 3000;
const CREDENTIALS_KEY = process.env.CREDENTIALS_KEY || 'change-this-32-char-key-now';

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

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false }));

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

app.post('/admin/clients/:id/check', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('UPDATE clients SET last_check_at=CURRENT_TIMESTAMP, last_result=? WHERE id=?')
    .run('Manual check requested (wire to automation worker)', id);
  res.redirect('/admin');
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
