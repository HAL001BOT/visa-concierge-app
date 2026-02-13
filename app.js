const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const db = new Database(path.join(__dirname, 'data.db'));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({ secret: process.env.SESSION_SECRET || 'dev-secret-change-me', resave: false, saveUninitialized: false }));

// DB bootstrap
const init = db.transaction(() => {
  db.prepare(`CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    contact_channel TEXT,
    contact_handle TEXT,
    timezone TEXT,
    portal_url TEXT NOT NULL,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    target_cities TEXT,
    target_months TEXT,
    auto_book INTEGER DEFAULT 0,
    notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`).run();
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
    full_name, contact_channel, contact_handle, timezone, portal_url, username, password,
    target_cities, target_months, auto_book, notes
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      body.full_name,
      body.contact_channel,
      body.contact_handle,
      body.timezone,
      body.portal_url,
      body.username,
      body.password,
      body.target_cities,
      body.target_months,
      body.auto_book ? 1 : 0,
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

app.get('/admin', requireAdmin, (req, res) => {
  const clients = db.prepare('SELECT * FROM clients ORDER BY created_at DESC').all();
  res.render('admin', { clients });
});

app.listen(PORT, () => {
  console.log(`Visa concierge app running on http://localhost:${PORT}`);
});
