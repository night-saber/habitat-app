/**
 * Habitat — Backend API Server
 * 
 * A simple Express server for cross-browser account persistence.
 * Deploy free on Render, Railway, or any Node.js hosting.
 * 
 * Environment variables:
 *   PORT - server port (default 3000)
 *   JWT_SECRET - secret for JWT tokens (change in production!)
 *   FRONTEND_URL - frontend URL for password reset links (default http://localhost:3000)
 * 
 * Run: node server.js
 */

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'habitat-dev-secret-change-in-production';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ==================== FILE PERSISTENCE ====================
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

function saveToDisk() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('Failed to save to disk:', e);
  }
}

function loadFromDisk() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      Object.assign(db, data);
      console.log('Loaded data from disk');
    }
  } catch (e) {
    console.error('Failed to load from disk:', e);
  }
}

// ==================== IN-MEMORY DATABASE ====================
// In production, replace with PostgreSQL/MongoDB
const db = {
  users: [],
  properties: [],
  tasks: [],
  photos: [],
  groups: [],
  workerProfiles: [],
  taskRequests: [],
  houseRecords: [],
  messages: [],
  hires: [],
  crews: [],
  resetTokens: [],
};

// Load persisted data on startup
loadFromDisk();

// ==================== HELPER FUNCTIONS ====================

function generateUsername(email) {
  const prefix = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  let username = prefix || 'user';
  let counter = 1;
  while (db.users.find(u => u.username === username)) {
    username = `${prefix}${counter}`;
    counter++;
  }
  return username;
}

function generateRecoveryCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const segments = [];
  for (let i = 0; i < 3; i++) {
    let seg = '';
    for (let j = 0; j < 4; j++) {
      seg += chars[Math.floor(Math.random() * chars.length)];
    }
    segments.push(seg);
  }
  return `HABIT-${segments.join('-')}`;
}

function generateResetToken() {
  return uuid() + '-' + uuid();
}

// ==================== AUTH MIDDLEWARE ====================
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ==================== AUTH ROUTES ====================

// Check username availability
app.get('/api/check-username', (req, res) => {
  const username = (req.query.username || '').trim().toLowerCase();
  if (!username) return res.json({ available: false, error: 'Username required' });
  const taken = db.users.some(u => u.username === username);
  res.json({ available: !taken });
});

// Signup
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password, role, username: requestedUsername } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Missing fields' });
    if (password.length < 8) return res.status(400).json({ error: 'Password too short' });
    
    const normalizedEmail = email.toLowerCase();
    const existing = db.users.find(u => u.email === normalizedEmail);
    if (existing) return res.status(409).json({ error: 'Email already registered' });
    
    // Generate or validate username
    let username = requestedUsername ? requestedUsername.trim().toLowerCase() : generateUsername(normalizedEmail);
    if (!username) username = generateUsername(normalizedEmail);
    if (db.users.find(u => u.username === username)) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    
    const hashed = await bcrypt.hash(password, 10);
    const recoveryCode = generateRecoveryCode();
    const user = {
      id: uuid(),
      name,
      email: normalizedEmail,
      username,
      password: hashed,
      role: role === 'worker' ? 'worker' : 'owner',
      phone: '',
      location: null,
      bio: '',
      skills: [],
      trade: null,
      serviceRadius: 10,
      rating: 0,
      reviewCount: 0,
      recoveryCode,
      createdAt: new Date().toISOString(),
    };
    db.users.push(user);
    saveToDisk();
    
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { ...user, password: undefined } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Login (email OR username)
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, username, password } = req.body;
    const identifier = (email || username || '').trim().toLowerCase();
    if (!identifier) return res.status(400).json({ error: 'Email or username required' });
    
    const user = db.users.find(u => 
      u.email === identifier || u.username === identifier
    );
    if (!user) return res.status(404).json({ error: 'No account found' });
    
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Wrong password' });
    
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { ...user, password: undefined } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Forgot password - generate reset token and "send" email
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const user = db.users.find(u => u.email === (email || '').toLowerCase());
    if (!user) return res.status(404).json({ error: 'No account with that email' });
    
    // Invalidate any existing tokens for this user
    db.resetTokens = db.resetTokens.filter(t => t.userId !== user.id);
    
    const token = generateResetToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
    db.resetTokens.push({ token, userId: user.id, expiresAt });
    saveToDisk();
    
    // "Send" email (log for now)
    const resetLink = `${FRONTEND_URL}/reset?token=${token}`;
    console.log(`\n=== PASSWORD RESET EMAIL ===`);
    console.log(`To: ${user.email}`);
    console.log(`Subject: Reset your Habitat password`);
    console.log(`Link: ${resetLink}`);
    console.log(`============================\n`);
    
    res.json({ success: true, message: 'Password reset email sent' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reset password with token
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password too short' });
    
    const resetToken = db.resetTokens.find(t => t.token === token);
    if (!resetToken) return res.status(400).json({ error: 'Invalid or expired token' });
    
    if (new Date(resetToken.expiresAt) < new Date()) {
      db.resetTokens = db.resetTokens.filter(t => t.token !== token);
      saveToDisk();
      return res.status(400).json({ error: 'Token expired' });
    }
    
    const user = db.users.find(u => u.id === resetToken.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    user.password = await bcrypt.hash(password, 10);
    db.resetTokens = db.resetTokens.filter(t => t.token !== token);
    saveToDisk();
    
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Account recovery with recovery code
app.post('/api/auth/recover', async (req, res) => {
  try {
    const { email, code } = req.body;
    const user = db.users.find(u => u.email === (email || '').toLowerCase());
    if (!user) return res.status(404).json({ error: 'No account with that email' });
    
    const normalizedCode = (code || '').trim().toUpperCase();
    if (user.recoveryCode !== normalizedCode) {
      return res.status(401).json({ error: 'Invalid recovery code' });
    }
    
    // Generate a new random password
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let newPassword = '';
    for (let i = 0; i < 12; i++) {
      newPassword += chars[Math.floor(Math.random() * chars.length)];
    }
    
    user.password = await bcrypt.hash(newPassword, 10);
    saveToDisk();
    
    res.json({ success: true, password: newPassword });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get current user
app.get('/api/me', auth, (req, res) => {
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ ...user, password: undefined });
});

// Update profile
app.put('/api/me', auth, (req, res) => {
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  const allowed = ['name', 'phone', 'location', 'bio', 'skills', 'trade', 'serviceRadius', 'username'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      if (key === 'username') {
        const newUsername = req.body[key].trim().toLowerCase();
        if (newUsername && newUsername !== user.username) {
          if (db.users.find(u => u.username === newUsername && u.id !== user.id)) {
            return res.status(409).json({ error: 'Username already taken' });
          }
          user.username = newUsername;
        }
      } else {
        user[key] = req.body[key];
      }
    }
  }
  saveToDisk();
  res.json({ ...user, password: undefined });
});

// ==================== PROPERTIES ====================

app.get('/api/properties', auth, (req, res) => {
  const props = req.user.role === 'owner'
    ? db.properties.filter(p => p.ownerId === req.user.id)
    : db.properties.filter(p => 
        p.workers?.includes(req.user.id) || 
        p.groups?.some(g => db.crews.find(c => c.id === g)?.memberIds?.includes(req.user.id))
      );
  res.json(props);
});

app.post('/api/properties', auth, (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only owners can create properties' });
  const prop = {
    id: uuid(),
    ownerId: req.user.id,
    name: req.body.name,
    address: req.body.address || '',
    description: req.body.description || '',
    details: req.body.details || {},
    lat: req.body.lat || null,
    lng: req.body.lng || null,
    workers: [],
    groups: [],
    createdAt: new Date().toISOString(),
  };
  db.properties.push(prop);
  saveToDisk();
  res.json(prop);
});

app.put('/api/properties/:id', auth, (req, res) => {
  const prop = db.properties.find(p => p.id === req.params.id);
  if (!prop) return res.status(404).json({ error: 'Not found' });
  if (prop.ownerId !== req.user.id) return res.status(403).json({ error: 'Not your property' });
  
  const allowed = ['name', 'address', 'description', 'details', 'lat', 'lng'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) prop[key] = req.body[key];
  }
  saveToDisk();
  res.json(prop);
});

app.delete('/api/properties/:id', auth, (req, res) => {
  const idx = db.properties.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  if (db.properties[idx].ownerId !== req.user.id) return res.status(403).json({ error: 'Not your property' });
  db.properties.splice(idx, 1);
  saveToDisk();
  res.json({ success: true });
});

// ==================== TASKS ====================

app.get('/api/tasks', auth, (req, res) => {
  const propIds = req.user.role === 'owner'
    ? db.properties.filter(p => p.ownerId === req.user.id).map(p => p.id)
    : db.properties.filter(p => 
        p.workers?.includes(req.user.id) || 
        p.groups?.some(g => db.crews.find(c => c.id === g)?.memberIds?.includes(req.user.id))
      ).map(p => p.id);
  res.json(db.tasks.filter(t => propIds.includes(t.propertyId)));
});

app.post('/api/tasks', auth, (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only owners can create tasks' });
  const task = {
    id: uuid(),
    propertyId: req.body.propertyId,
    createdBy: req.user.id,
    title: req.body.title,
    description: req.body.description || '',
    priority: req.body.priority || 'normal',
    status: 'open',
    lat: req.body.lat || null,
    lng: req.body.lng || null,
    photoId: req.body.photoId || null,
    completionPhotoId: null,
    requestedBy: null,
    acceptedBy: null,
    price: null,
    dueDate: req.body.dueDate || null,
    createdAt: new Date().toISOString(),
    completedAt: null,
    completedBy: null,
    comments: [],
  };
  db.tasks.push(task);
  saveToDisk();
  res.json(task);
});

app.put('/api/tasks/:id', auth, (req, res) => {
  const task = db.tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  
  const allowed = ['title', 'description', 'priority', 'status', 'lat', 'lng', 'photoId', 'completionPhotoId', 'dueDate', 'requestedBy', 'acceptedBy', 'price'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) task[key] = req.body[key];
  }
  saveToDisk();
  res.json(task);
});

app.delete('/api/tasks/:id', auth, (req, res) => {
  const idx = db.tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const task = db.tasks[idx];
  const prop = db.properties.find(p => p.id === task.propertyId);
  if (prop?.ownerId !== req.user.id) return res.status(403).json({ error: 'Not your task' });
  db.tasks.splice(idx, 1);
  saveToDisk();
  res.json({ success: true });
});

// ==================== WORKERS ====================

app.get('/api/workers', auth, (req, res) => {
  const workers = db.users
    .filter(u => u.role === 'worker')
    .map(u => ({ ...u, password: undefined }));
  res.json(workers);
});

// ==================== MESSAGES ====================

app.get('/api/messages', auth, (req, res) => {
  const msgs = db.messages.filter(m => 
    m.fromId === req.user.id || m.toId === req.user.id
  ).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(msgs);
});

app.post('/api/messages', auth, (req, res) => {
  const msg = {
    id: uuid(),
    fromId: req.user.id,
    toId: req.body.toId,
    text: req.body.text,
    read: false,
    createdAt: new Date().toISOString(),
  };
  db.messages.push(msg);
  saveToDisk();
  res.json(msg);
});

// ==================== HOUSE RECORDS ====================

app.get('/api/house-records', auth, (req, res) => {
  res.json(db.houseRecords.filter(r => r.propertyId === req.query.property_id));
});

app.post('/api/house-records', auth, (req, res) => {
  const record = {
    id: uuid(),
    propertyId: req.body.propertyId,
    title: req.body.title,
    description: req.body.description || '',
    category: req.body.category || 'general',
    cost: req.body.cost || null,
    date: req.body.date || new Date().toISOString().slice(0, 10),
    workerId: req.body.workerId || null,
    notes: req.body.notes || '',
    createdAt: new Date().toISOString(),
  };
  db.houseRecords.push(record);
  saveToDisk();
  res.json(record);
});

// ==================== HIRES ====================

app.get('/api/hires', auth, (req, res) => {
  res.json(db.hires.filter(h => 
    h.ownerId === req.user.id || h.workerId === req.user.id
  ));
});

app.post('/api/hires', auth, (req, res) => {
  const hire = {
    id: uuid(),
    ownerId: req.user.id,
    workerId: req.body.workerId,
    propertyId: req.body.propertyId,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  db.hires.push(hire);
  saveToDisk();
  res.json(hire);
});

// ==================== CREWS ====================

app.get('/api/crews', auth, (req, res) => {
  res.json(db.crews.filter(c => 
    c.ownerId === req.user.id || c.memberIds?.includes(req.user.id)
  ));
});

app.post('/api/crews', auth, (req, res) => {
  const crew = {
    id: uuid(),
    ownerId: req.user.id,
    name: req.body.name,
    description: req.body.description || '',
    color: req.body.color || '#34d399',
    memberIds: req.body.memberIds || [],
    createdAt: new Date().toISOString(),
  };
  db.crews.push(crew);
  saveToDisk();
  res.json(crew);
});

// ==================== EXPORT/IMPORT ====================

// Export all user data
app.get('/api/export', auth, (req, res) => {
  const userId = req.user.id;
  const userProps = db.properties.filter(p => p.ownerId === userId);
  const propIds = new Set(userProps.map(p => p.id));
  
  res.json({
    properties: userProps,
    tasks: db.tasks.filter(t => propIds.has(t.propertyId)),
    houseRecords: db.houseRecords.filter(r => propIds.has(r.propertyId)),
    groups: db.groups.filter(g => g.ownerId === userId),
    crews: db.crews.filter(c => c.ownerId === userId),
    hires: db.hires.filter(h => h.ownerId === userId || h.workerId === userId),
    messages: db.messages.filter(m => m.fromId === userId || m.toId === userId),
    workerProfiles: db.workerProfiles.filter(p => p.userId === userId),
    taskRequests: db.taskRequests.filter(r => r.workerId === userId || r.ownerId === userId),
    exportedAt: new Date().toISOString(),
  });
});

// Import user data
app.post('/api/import', auth, (req, res) => {
  try {
    const userId = req.user.id;
    const data = req.body;
    
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'Invalid data' });
    }
    
    // Merge imported data (don't delete existing, just add/update)
    if (Array.isArray(data.properties)) {
      for (const p of data.properties) {
        if (p.ownerId === userId && !db.properties.find(x => x.id === p.id)) {
          db.properties.push(p);
        }
      }
    }
    if (Array.isArray(data.tasks)) {
      for (const t of data.tasks) {
        if (!db.tasks.find(x => x.id === t.id)) {
          db.tasks.push(t);
        }
      }
    }
    if (Array.isArray(data.houseRecords)) {
      for (const r of data.houseRecords) {
        if (!db.houseRecords.find(x => x.id === r.id)) {
          db.houseRecords.push(r);
        }
      }
    }
    if (Array.isArray(data.crews)) {
      for (const c of data.crews) {
        if (c.ownerId === userId && !db.crews.find(x => x.id === c.id)) {
          db.crews.push(c);
        }
      }
    }
    if (Array.isArray(data.hires)) {
      for (const h of data.hires) {
        if (!db.hires.find(x => x.id === h.id)) {
          db.hires.push(h);
        }
      }
    }
    if (Array.isArray(data.messages)) {
      for (const m of data.messages) {
        if (!db.messages.find(x => x.id === m.id)) {
          db.messages.push(m);
        }
      }
    }
    if (Array.isArray(data.workerProfiles)) {
      for (const p of data.workerProfiles) {
        if (p.userId === userId && !db.workerProfiles.find(x => x.id === p.id)) {
          db.workerProfiles.push(p);
        }
      }
    }
    if (Array.isArray(data.taskRequests)) {
      for (const r of data.taskRequests) {
        if (!db.taskRequests.find(x => x.id === r.id)) {
          db.taskRequests.push(r);
        }
      }
    }
    
    saveToDisk();
    res.json({ success: true, message: 'Data imported successfully' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== START ====================

app.listen(PORT, () => {
  console.log(`Habitat API running on port ${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
});
