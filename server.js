/**
 * Habitat — Backend API Server
 * 
 * A simple Express server for cross-browser account persistence.
 * Deploy free on Render, Railway, or any Node.js hosting.
 * 
 * Environment variables:
 *   PORT - server port (default 3000)
 *   JWT_SECRET - secret for JWT tokens (change in production!)
 * 
 * Run: node server.js
 */

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'habitat-dev-secret-change-in-production';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

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
};

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

// Signup
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Missing fields' });
    if (password.length < 8) return res.status(400).json({ error: 'Password too short' });
    
    const existing = db.users.find(u => u.email === email.toLowerCase());
    if (existing) return res.status(409).json({ error: 'Email already registered' });
    
    const hashed = await bcrypt.hash(password, 10);
    const user = {
      id: uuid(),
      name,
      email: email.toLowerCase(),
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
      createdAt: new Date().toISOString(),
    };
    db.users.push(user);
    
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { ...user, password: undefined } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = db.users.find(u => u.email === (email || '').toLowerCase());
    if (!user) return res.status(404).json({ error: 'No account with that email' });
    
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Wrong password' });
    
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresId: '30d' });
    res.json({ token, user: { ...user, password: undefined } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reset password
app.post('/api/auth/reset', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = db.users.find(u => u.email === (email || '').toLowerCase());
    if (!user) return res.status(404).json({ error: 'No account with that email' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password too short' });
    
    user.password = await bcrypt.hash(password, 10);
    res.json({ success: true });
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
  
  const allowed = ['name', 'phone', 'location', 'bio', 'skills', 'trade', 'serviceRadius'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) user[key] = req.body[key];
  }
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
  res.json(prop);
});

app.delete('/api/properties/:id', auth, (req, res) => {
  const idx = db.properties.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  if (db.properties[idx].ownerId !== req.user.id) return res.status(403).json({ error: 'Not your property' });
  db.properties.splice(idx, 1);
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
  res.json(task);
});

app.put('/api/tasks/:id', auth, (req, res) => {
  const task = db.tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  
  const allowed = ['title', 'description', 'priority', 'status', 'lat', 'lng', 'photoId', 'completionPhotoId', 'dueDate', 'requestedBy', 'acceptedBy', 'price'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) task[key] = req.body[key];
  }
  res.json(task);
});

app.delete('/api/tasks/:id', auth, (req, res) => {
  const idx = db.tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const task = db.tasks[idx];
  const prop = db.properties.find(p => p.id === task.propertyId);
  if (prop?.ownerId !== req.user.id) return res.status(403).json({ error: 'Not your task' });
  db.tasks.splice(idx, 1);
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
  res.json(crew);
});

// ==================== EXPORT/IMPORT ====================

app.post('/api/export', auth, (req, res) => {
  const userId = req.user.id;
  res.json({
    properties: db.properties.filter(p => p.ownerId === userId),
    tasks: db.tasks.filter(t => db.properties.find(p => p.id === t.propertyId)?.ownerId === userId),
    houseRecords: db.houseRecords.filter(r => db.properties.find(p => p.id === r.propertyId)?.ownerId === userId),
    groups: db.groups.filter(g => g.ownerId === userId),
    crews: db.crews.filter(c => c.ownerId === userId),
  });
});

// ==================== START ====================

app.listen(PORT, () => {
  console.log(`Habitat API running on port ${PORT}`);
});
