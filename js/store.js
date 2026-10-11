/* Habitat — Store (data layer) */
"use strict";

const DB_KEY = "habitat.db.v1";
const SESSION_KEY = "habitat.session.v1";
// The backend is deployed live — never fall back to localStorage-only mode.
const API_URL = window.HABITAT_API_URL || "https://habitat-api.loca.lt";
let AUTH_TOKEN = null;
let autoExportInterval = null;

// CSP-safe, no silent fallback: API errors must surface to the user.
async function api(path, opts = {}) {
  try {
    const res = await fetch(API_URL + path, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        ...(AUTH_TOKEN ? { Authorization: "Bearer " + AUTH_TOKEN } : {}),
        ...(opts.headers || {}),
      },
      credentials: "omit",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  } catch (e) {
    // Distinguish network errors (backend not deployed / CORS / DNS) from
    // HTTP errors the server did return. network errors throw a TypeError
    // with no HTTP status — surface the backend URL so the user knows where
    // the request was going.
    const msg = e instanceof TypeError
      ? `Cannot reach the Habitat API backend at ${API_URL}. Check that the server is running and reachable.`
      : (e.message || "Network error — please check your connection");
    throw new Error(msg);
  }
}

async function apiPost(path, data) { return api(path, { method: "POST", body: JSON.stringify(data) }); }
async function apiPut(path, data) { return api(path, { method: "PUT", body: JSON.stringify(data) }); }
async function apiDelete(path) { return api(path, { method: "DELETE" }); }

function uid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  // CSPRNG fallback — never Math.random
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  const hex = Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

// Password hashing now happens server-side (bcrypt).
// No client-side password hashing — the API requires a plaintext password
// over HTTPS and hashes it with bcrypt before storage.

// CSPRNG-based recovery code generation (was Math.random before).
function generateRecoveryCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const segments = [];
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 3; i++) {
    let seg = "";
    for (let j = 0; j < 4; j++) {
      seg += chars[bytes[i * 4 + j] % chars.length];
    }
    segments.push(seg);
  }
  return `HABIT-${segments.join("-")}`;
}

/** Every collection the app expects. Used to seed and to backfill old saves. */
function defaultDb() {
  return {
    users: [],
    properties: [],
    tasks: [],
    photos: [],
    workerProfiles: [],
    taskRequests: [],
    houseRecords: [],
    messages: [],
    hires: [],
    crews: [],
    meshes: [],
    activity: [],
  };
}

const Store = {
  db: defaultDb(),
  idx: {},

  load() {
    // Restore JWT token from localStorage.
    try {
      AUTH_TOKEN = localStorage.getItem("habitat.token") || null;
    } catch { /* ignore */ }
    let stored = null;
    try {
      const raw = localStorage.getItem(DB_KEY);
      if (raw) stored = JSON.parse(raw);
    } catch { /* fresh start */ }
    // Merge over the defaults so a database saved by an older version still
    // has every collection the current code expects (missing keys would
    // otherwise be undefined and break reindex()).
    if (stored && typeof stored === "object") {
      this.db = Object.assign({}, defaultDb(), stored);
      for (const key of Object.keys(defaultDb())) {
        if (!Array.isArray(this.db[key])) this.db[key] = [];
      }
    }
    this.reindex();
  },

  reindex() {
    const byId = arr => { const m = new Map(); for (const r of arr) m.set(r.id, r); return m; };
    const groupBy = (arr, key) => {
      const m = new Map();
      for (const r of arr) {
        const k = r[key];
        if (k == null) continue;
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(r);
      }
      return m;
    };
    const usersByEmail = new Map();
    const usersByUsername = new Map();
    for (const u of this.db.users) {
      usersByEmail.set(u.email, u);
      if (u.username) usersByUsername.set(u.username, u);
    }
    const crewsByMember = new Map();
    for (const c of this.db.crews) {
      for (const mid of c.memberIds || []) {
        if (!crewsByMember.has(mid)) crewsByMember.set(mid, []);
        crewsByMember.get(mid).push(c.id);
      }
    }
    this.idx = {
      users: byId(this.db.users),
      usersByEmail,
      usersByUsername,
      properties: byId(this.db.properties),
      tasks: byId(this.db.tasks),
      photos: byId(this.db.photos),
      workerProfiles: byId(this.db.workerProfiles),
      taskRequests: byId(this.db.taskRequests),
      houseRecords: byId(this.db.houseRecords),
      messages: byId(this.db.messages),
      hires: byId(this.db.hires),
      crews: byId(this.db.crews),
      meshes: byId(this.db.meshes),
      propsByOwner: groupBy(this.db.properties, "ownerId"),
      tasksByProperty: groupBy(this.db.tasks, "propertyId"),
      photosByProperty: groupBy(this.db.photos, "propertyId"),
      profilesByUser: groupBy(this.db.workerProfiles, "userId"),
      requestsByWorker: groupBy(this.db.taskRequests, "workerId"),
      requestsByOwner: groupBy(this.db.taskRequests, "ownerId"),
      recordsByProperty: groupBy(this.db.houseRecords, "propertyId"),
      messagesByUser: groupBy(this.db.messages, "toId"),
      hiresByOwner: groupBy(this.db.hires, "ownerId"),
      hiresByWorker: groupBy(this.db.hires, "workerId"),
      crewsByOwner: groupBy(this.db.crews, "ownerId"),
      meshesByProperty: groupBy(this.db.meshes, "propertyId"),
      crewsByMember,
    };
  },

  save() {
    try { localStorage.setItem(DB_KEY, JSON.stringify(this.db)); }
    catch (e) {
      // Surface storage failures instead of silently swallowing them.
      if (e && e.name === "QuotaExceededError") {
        console.error("localStorage quota exceeded — data not persisted locally");
      }
    }
  },

  commit() { this.save(); },

  log(userId, action) {
    this.db.activity.unshift({ id: uid(), at: new Date().toISOString(), userId, action });
    if (this.db.activity.length > 200) this.db.activity.length = 200;
  },

  // ==================== AUTH ====================
  async signup({ name, email, password, role, phone, location, username }) {
    email = (email || "").trim().toLowerCase();
    name = (name || "").trim();
    if (!name || !email || !password) throw new Error("Please fill in all fields.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("That email doesn't look right.");
    if (password.length < 8) throw new Error("Password must be 8+ characters.");
    
    // API is mandatory — no localStorage fallback for auth.
    const res = await apiPost("/api/auth/signup", { name, email, password, role, username });
    AUTH_TOKEN = res.token;
    localStorage.setItem("habitat.token", res.token);
    // Recovery code is sent via email server-side; never exposed in the UI.
    return res.user;
  },

  async login(emailOrUsername, password) {
    const identifier = (emailOrUsername || "").trim().toLowerCase();
    // API is mandatory — no localStorage fallback for auth.
    const res = await apiPost("/api/auth/login", { email: identifier, password });
    AUTH_TOKEN = res.token;
    localStorage.setItem("habitat.token", res.token);
    return res.user;
  },

  async checkUsername(username) {
    if (!username) return { available: false };
    const normalized = username.trim().toLowerCase();
    return api(`/api/check-username?username=${encodeURIComponent(normalized)}`);
  },

  async forgotPassword(email) {
    email = (email || "").trim().toLowerCase();
    return apiPost("/api/auth/forgot-password", { email });
  },

  async resetPassword(token, password) {
    if (!token) throw new Error("Token required");
    if (!password || password.length < 8) throw new Error("Password must be 8+ characters.");
    return apiPost("/api/auth/reset-password", { token, password });
  },

  async recoverAccount(email, code) {
    email = (email || "").trim().toLowerCase();
    const normalizedCode = (code || "").trim().toUpperCase();
    // Recovery is now server-side only; the API sends a reset link to email.
    const res = await apiPost("/api/auth/forgot-password", { email });
    if (res) return res;
    throw new Error("Could not process recovery request");
  },
  
  async changePassword(currentPassword, newPassword) {
    return apiPost("/api/auth/change-password", { currentPassword, newPassword });
  },

  setToken(token) {
    AUTH_TOKEN = token;
    if (token) localStorage.setItem("habitat.token", token);
    else localStorage.removeItem("habitat.token");
  },
  
  getToken() {
    if (AUTH_TOKEN) return AUTH_TOKEN;
    try { return localStorage.getItem("habitat.token"); } catch { return null; }
  },

  publicUser(u) {
    if (!u) return null;
    const { pw, ...rest } = u;
    return rest;
  },

  user(id) { return this.publicUser(this.idx.users.get(id)); },

  setUser(id, patch) {
    const u = this.idx.users.get(id);
    if (!u) return null;
    Object.assign(u, patch);
    this.save();
    return this.publicUser(u);
  },

  setSession(id) {
    try {
      if (id) localStorage.setItem(SESSION_KEY, id);
      else localStorage.removeItem(SESSION_KEY);
    } catch { /* ignore */ }
  },
  session() { try { return localStorage.getItem(SESSION_KEY); } catch { return null; } },

  // Validate the current token against the server and return the user.
  async checkSession() {
    if (!AUTH_TOKEN) return null;
    try {
      const res = await api("/api/me");
      return res;
    } catch {
      // Token expired or invalid — clear it and return null.
      this.setToken(null);
      return null;
    }
  },

  // ==================== DATA EXPORT/IMPORT ====================
  exportData() {
    return {
      properties: this.db.properties,
      tasks: this.db.tasks,
      houseRecords: this.db.houseRecords,
      crews: this.db.crews,
      meshes: this.db.meshes,
      hires: this.db.hires,
      messages: this.db.messages,
      workerProfiles: this.db.workerProfiles,
      taskRequests: this.db.taskRequests,
      photos: this.db.photos,
      exportedAt: new Date().toISOString(),
    };
  },

  async exportToAPI() {
    if (!AUTH_TOKEN) return null;
    const data = this.exportData();
    return apiPost("/api/export", data);
  },

  async importData(data) {
    if (!data || typeof data !== "object") throw new Error("Invalid data");
    return apiPost("/api/import", data);
  },

  startAutoExport() {
    if (autoExportInterval) clearInterval(autoExportInterval);
    autoExportInterval = setInterval(() => {
      if (AUTH_TOKEN) {
        this.exportToAPI().catch(() => {});
      }
    }, 30000); // Every 30 seconds — syncs local cache to server
  },

  stopAutoExport() {
    if (autoExportInterval) {
      clearInterval(autoExportInterval);
      autoExportInterval = null;
    }
  },

  // ==================== PROPERTIES ====================
  addProperty({ ownerId, name, address, lat, lng, notes, description, details }) {
    const p = {
      id: uid(), ownerId, name: (name || "Property").trim(),
      address: address || "", notes: notes || "",
      description: description || "",
      details: details || {},
      lat: lat ?? null, lng: lng ?? null,
      workers: [], createdAt: new Date().toISOString(),
    };
    this.db.properties.push(p);
    this.log(ownerId, "property.created");
    this.reindex();
    this.save();
    return p;
  },

  property(id) { return this.idx.properties.get(id) || null; },

  propertiesFor(user) {
    if (!user) return [];
    if (user.role === "owner") return this.idx.propsByOwner.get(user.id) || [];
    // Workers: properties they're assigned to or have requested tasks on
    const requestedPropIds = new Set(
      (this.idx.requestsByWorker.get(user.id) || []).map(r => r.propertyId)
    );
    const hiredPropIds = new Set(
      (this.idx.hiresByWorker.get(user.id) || [])
        .filter(h => h.status === "active")
        .map(h => h.propertyId)
    );
    return this.db.properties.filter(p =>
      p.workers.includes(user.id) || requestedPropIds.has(p.id) || hiredPropIds.has(p.id)
    );
  },

  updateProperty(id, patch) {
    const p = this.property(id);
    if (!p) return null;
    Object.assign(p, patch);
    this.log(p.ownerId, "property.updated");
    this.reindex();
    this.save();
    return p;
  },

  deleteProperty(id) {
    const p = this.property(id);
    if (!p) return;
    this.db.properties = this.db.properties.filter(x => x.id !== id);
    this.db.tasks = this.db.tasks.filter(t => t.propertyId !== id);
    this.db.photos = this.db.photos.filter(ph => ph.propertyId !== id);
    this.db.houseRecords = this.db.houseRecords.filter(r => r.propertyId !== id);
    this.log(p.ownerId, "property.deleted");
    this.reindex();
    this.save();
  },

  getPropertyDetails(propertyId) {
    const p = this.property(propertyId);
    if (!p) return null;
    const tasks = this.tasksFor(propertyId);
    const records = this.getHouseRecords(propertyId);
    const photos = this.photosFor(propertyId);
    return { ...p, tasks, records, photos };
  },

  getNearbyProperties(location, radius = 10) {
    if (!location || location.lat == null || location.lng == null) return [];
    const r = radius * 1000; // km to meters
    return this.db.properties
      .filter(p => {
        if (p.lat == null || p.lng == null) return false;
        const d = this.haversine(location.lat, location.lng, p.lat, p.lng);
        return d <= r;
      })
      .map(p => ({ ...p, distance: this.haversine(location.lat, location.lng, p.lat, p.lng) }));
  },

  haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  },

  // ==================== TASKS ====================
  addTask({ propertyId, createdBy, title, description, lat, lng, priority, assigneeId, dueDate, photoId, category }) {
    const t = {
      id: uid(), propertyId, createdBy,
      title: (title || "Task").trim(), description: description || "",
      lat: lat ?? null, lng: lng ?? null,
      priority: priority || "normal", status: "open",
      assigneeId: assigneeId || null, dueDate: dueDate || null,
      photoId: photoId || null, completionPhotoId: null,
      category: category || null,
      requestedBy: null, acceptedBy: null, price: null,
      createdAt: new Date().toISOString(), completedAt: null, completedBy: null,
    };
    this.db.tasks.push(t);
    this.log(createdBy, "task.created");
    this.reindex();
    this.save();
    return t;
  },

  task(id) { return this.idx.tasks.get(id) || null; },
  tasksFor(propertyId) { return this.idx.tasksByProperty.get(propertyId) || []; },

  tasksForUser(user) {
    if (!user) return [];
    if (user.role === "owner") {
      const ids = new Set((this.idx.propsByOwner.get(user.id) || []).map(p => p.id));
      return this.db.tasks.filter(t => ids.has(t.propertyId));
    }
    const propIds = new Set(this.propertiesFor(user).map(p => p.id));
    return this.db.tasks.filter(t => propIds.has(t.propertyId));
  },

  updateTask(id, patch) {
    const t = this.task(id);
    if (!t) return null;
    Object.assign(t, patch);
    if (patch.status === "completed" && !t.completedAt) t.completedAt = new Date().toISOString();
    if (patch.status && patch.status !== "completed") t.completedAt = null;
    this.log(t.createdBy, "task.updated");
    this.save();
    return t;
  },

  setTaskStatus(id, status, userId) {
    const t = this.task(id);
    if (!t) return null;
    t.status = status;
    if (status === "completed") { t.completedAt = new Date().toISOString(); t.completedBy = userId; }
    else t.completedAt = null;
    this.log(userId, status === "completed" ? "task.completed" : "task.status_changed");
    this.save();
    return t;
  },

  deleteTask(id) {
    const t = this.task(id);
    if (!t) return;
    this.db.tasks = this.db.tasks.filter(x => x.id !== id);
    this.db.taskRequests = this.db.taskRequests.filter(r => r.taskId !== id);
    this.log(t.createdBy, "task.deleted");
    this.reindex();
    this.save();
  },

  // ==================== TASK REQUESTS ====================
  requestTask(taskId, workerId, message, price) {
    const t = this.task(taskId);
    if (!t) throw new Error("Task not found.");
    if (t.status !== "open") throw new Error("Task is not open for requests.");
    const existing = this.db.taskRequests.find(r => r.taskId === taskId && r.workerId === workerId);
    if (existing) throw new Error("You already requested this task.");
    const req = {
      id: uid(), propertyId: t.propertyId, taskId, workerId,
      message: message || "", price: price || null,
      status: "pending", createdAt: new Date().toISOString(),
    };
    this.db.taskRequests.push(req);
    t.status = "requested";
    t.requestedBy = workerId;
    this.log(workerId, "task.requested");
    this.reindex();
    this.save();
    return req;
  },

  getRequestsForWorker(workerId) {
    return this.idx.requestsByWorker.get(workerId) || [];
  },

  getRequestsForOwner(ownerId) {
    return this.idx.requestsByOwner.get(ownerId) || [];
  },

  respondToRequest(requestId, accept) {
    const req = this.idx.taskRequests.get(requestId);
    if (!req) return null;
    req.status = accept ? "accepted" : "declined";
    const t = this.task(req.taskId);
    if (t) {
      if (accept) {
        t.status = "assigned";
        t.assigneeId = req.workerId;
        t.acceptedBy = req.workerId;
        t.price = req.price;
      } else {
        t.status = "open";
        t.requestedBy = null;
      }
    }
    this.log(req.workerId, accept ? "request.accepted" : "request.declined");
    this.reindex();
    this.save();
    return req;
  },

  // ==================== WORKER PROFILES ====================
  updateWorkerProfile(userId, data) {
    let profile = (this.idx.profilesByUser.get(userId) || [])[0];
    if (!profile) {
      profile = {
        id: uid(), userId,
        bio: "", skills: [], trade: "",
        location: "", serviceRadius: 25,
        rating: 0, reviewCount: 0, createdAt: new Date().toISOString(),
      };
      this.db.workerProfiles.push(profile);
    }
    Object.assign(profile, data);
    this.log(userId, "profile.updated");
    this.reindex();
    this.save();
    return profile;
  },

  getWorkerProfile(userId) {
    return (this.idx.profilesByUser.get(userId) || [])[0] || null;
  },

  searchWorkers(location, radius = 25) {
    const profiles = this.db.workerProfiles.filter(p => {
      if (!p.location) return false;
      // Simple string match for demo; in production would use geocoding
      return true;
    });
    return profiles.map(p => {
      const user = this.user(p.userId);
      return { ...p, user };
    });
  },

  // ==================== CREWS ====================
  createCrew(ownerId, name, memberIds) {
    const c = {
      id: uid(), ownerId, name: (name || "Crew").trim(),
      memberIds: [...new Set(memberIds)], createdAt: new Date().toISOString(),
    };
    this.db.crews.push(c);
    this.log(ownerId, "crew.created");
    this.reindex();
    this.save();
    return c;
  },

  getCrewsForWorker(workerId) {
    const crewIds = this.idx.crewsByMember.get(workerId) || [];
    return crewIds.map(id => this.idx.crews.get(id)).filter(Boolean);
  },

  getCrewsForOwner(ownerId) {
    return this.idx.crewsByOwner.get(ownerId) || [];
  },

  updateCrew(id, patch) {
    const c = this.idx.crews.get(id);
    if (!c) return null;
    Object.assign(c, patch);
    this.log(c.ownerId, "crew.updated");
    this.reindex();
    this.save();
    return c;
  },

  deleteCrew(id) {
    const c = this.idx.crews.get(id);
    if (!c) return;
    this.db.crews = this.db.crews.filter(x => x.id !== id);
    this.log(c.ownerId, "crew.deleted");
    this.reindex();
    this.save();
  },

  // ==================== HIRING ====================
  hireWorker(ownerId, workerId, propertyId) {
    const existing = this.db.hires.find(h => h.ownerId === ownerId && h.workerId === workerId && h.propertyId === propertyId);
    if (existing) throw new Error("Already hired for this property.");
    const hire = {
      id: uid(), ownerId, workerId, propertyId,
      status: "pending", createdAt: new Date().toISOString(),
    };
    this.db.hires.push(hire);
    this.log(ownerId, "worker.hired");
    this.reindex();
    this.save();
    return hire;
  },

  getHiresForOwner(ownerId) {
    return this.idx.hiresByOwner.get(ownerId) || [];
  },

  getHiresForWorker(workerId) {
    return this.idx.hiresByWorker.get(workerId) || [];
  },

  updateHire(id, patch) {
    const h = this.idx.hires.get(id);
    if (!h) return null;
    Object.assign(h, patch);
    this.log(h.ownerId, "hire.updated");
    this.reindex();
    this.save();
    return h;
  },

  // ==================== HOUSE RECORDS ====================
  acceptTask(taskId) {
    const t = this.task(taskId);
    if (!t) return null;
    if (t.status !== "completed") throw new Error("Task must be completed before accepting.");
    const record = {
      id: uid(), propertyId: t.propertyId,
      title: t.title, description: t.description,
      category: t.priority, cost: t.price,
      date: t.completedAt || new Date().toISOString(),
      workerId: t.completedBy || t.assigneeId,
      notes: "", createdAt: new Date().toISOString(),
    };
    this.db.houseRecords.push(record);
    t.status = "accepted";
    this.log(t.createdBy, "task.accepted");
    this.reindex();
    this.save();
    return record;
  },

  addHouseRecord(propertyId, data, userId) {
    const r = {
      id: uid(), propertyId,
      title: (data.title || "Record").trim(),
      description: data.description || "",
      category: data.category || "general",
      cost: data.cost || null,
      date: data.date || new Date().toISOString(),
      workerId: data.workerId || null,
      notes: data.notes || "",
      createdAt: new Date().toISOString(),
    };
    this.db.houseRecords.push(r);
    this.log(userId || "system", "record.added");
    this.reindex();
    this.save();
    return r;
  },

  getHouseRecords(propertyId) {
    return this.idx.recordsByProperty.get(propertyId) || [];
  },

  // ==================== MESSAGES ====================
  sendMessage(fromId, toId, text) {
    const msg = {
      id: uid(), fromId, toId,
      text: (text || "").trim(),
      read: false, createdAt: new Date().toISOString(),
    };
    this.db.messages.push(msg);
    this.log(fromId, "message.sent");
    this.reindex();
    this.save();
    return msg;
  },

  getMessages(userId) {
    const sent = this.db.messages.filter(m => m.fromId === userId);
    const received = this.idx.messagesByUser.get(userId) || [];
    return [...sent, ...received].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  },

  getConversation(userId1, userId2) {
    return this.db.messages
      .filter(m => (m.fromId === userId1 && m.toId === userId2) || (m.fromId === userId2 && m.toId === userId1))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  },

  markMessageRead(msgId) {
    const m = this.idx.messages.get(msgId);
    if (!m) return;
    m.read = true;
    this.save();
  },

  unreadCount(userId) {
    return this.db.messages.filter(m => m.toId === userId && !m.read).length;
  },

  // ==================== JOB HISTORY ====================
  /**
   * Every task this worker has been assigned, newest first.
   * `done` are finished jobs (what an owner browsing the worker wants to
   * see); `active` is work in flight.
   */
  jobHistoryFor(workerId) {
    if (!workerId) return { done: [], active: [], stats: this.emptyJobStats() };
    const all = this.db.tasks.filter(t => t.assigneeId === workerId || t.completedBy === workerId);
    const done = all
      .filter(t => t.status === "completed" || t.status === "accepted")
      .sort((a, b) => new Date(b.completedAt || b.createdAt) - new Date(a.completedAt || a.createdAt));
    const active = all
      .filter(t => !["completed", "accepted"].includes(t.status))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return { done, active, stats: this.jobStats(workerId, all) };
  },

  emptyJobStats() {
    return { total: 0, done: 0, active: 0, trades: [], firstJob: null, lastJob: null };
  },

  /** Which types of work this worker has done, most frequent first. */
  jobStats(workerId, tasks) {
    if (!tasks) tasks = this.db.tasks.filter(t => t.assigneeId === workerId);
    const done = tasks.filter(t => t.status === "completed" || t.status === "accepted");
    const counts = new Map();
    for (const t of tasks) {
      // prefer the trade/category of the work; fall back to the priority bucket
      const k = t.category || t.trade || t.priority || "general";
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const trades = [...counts.entries()]
      .map(([trade, count]) => ({ trade, count }))
      .sort((a, b) => b.count - a.count);
    const stamps = tasks.map(t => t.completedAt || t.createdAt).filter(Boolean).sort();
    return {
      total: tasks.length,
      done: done.length,
      active: tasks.length - done.length,
      trades,
      firstJob: stamps[0] || null,
      lastJob: stamps[stamps.length - 1] || null,
    };
  },

  /** Work this worker has done that the owner filed into the house record. */
  recordsForWorker(workerId) {
    return this.db.houseRecords
      .filter(r => r.workerId === workerId)
      .sort((a, b) => new Date(b.date || b.createdAt) - new Date(a.date || a.createdAt));
  },

  /** Properties this worker has touched, for the profile header. */
  propertiesWorkedOn(workerId) {
    const ids = new Set();
    for (const t of this.db.tasks) {
      if (t.assigneeId === workerId || t.completedBy === workerId) ids.add(t.propertyId);
    }
    for (const r of this.db.houseRecords) {
      if (r.workerId === workerId) ids.add(r.propertyId);
    }
    for (const p of this.db.properties) {
      if ((p.workers || []).includes(workerId)) ids.add(p.id);
    }
    return [...ids].map(id => this.idx.properties.get(id)).filter(Boolean);
  },

  // ==================== CREWS ====================
  /**
   * Crews are a worker-side concept: workers organise themselves into crews.
   * A homeowner never creates a crew — they hire individual workers, or
   * assign a worker-run crew to one of their properties.
   */
  canCreateCrew(user) {
    return !!user && user.role === "worker";
  },

  /** The crews a worker owns (runs). */
  crewsLedBy(workerId) {
    return this.db.crews.filter(c => c.ownerId === workerId);
  },

  /** Crews this worker is a member of. */
  crewsOf(workerId) {
    return this.getCrewsForWorker(workerId);
  },

  // ==================== 3D MESHES ====================
  /**
   * A mesh records a property's makeup: a coloured point cloud plus markers
   * pinned onto it (light switches, shutoffs, fixtures) describing what each
   * one is and what it does.
   */
  addMesh({ userId, propertyId, name, points, markers, rooms, mode }) {
    const mesh = {
      id: uid(),
      userId,
      propertyId,
      name: (name || "Model").trim(),
      mode: mode || "indoor",
      rooms: rooms || [],          // walkable geometry: W x D x H per room
      points: points || [],        // scanned point cloud
      markers: markers || [],      // pins describing what things are
      createdAt: new Date().toISOString(),
    };
    this.db.meshes.push(mesh);
    this.log(userId, "mesh.created");
    this.reindex();
    this.save();
    return mesh;
  },

  mesh(id) { return this.idx.meshes.get(id) || null; },

  meshesFor(propertyId) { return this.idx.meshesByProperty.get(propertyId) || []; },

  deleteMesh(id) {
    const m = this.idx.meshes.get(id);
    if (!m) return;
    this.db.meshes = this.db.meshes.filter(x => x.id !== id);
    this.log(m.userId, "mesh.deleted");
    this.reindex();
    this.save();
  },

  /** Every marker across a property's meshes, for the property info view. */
  markersFor(propertyId) {
    const out = [];
    for (const mesh of this.meshesFor(propertyId)) {
      for (const mk of (mesh.markers || [])) out.push({ ...mk, meshId: mesh.id, meshName: mesh.name });
    }
    return out;
  },

  // ==================== MESSAGING RULES ====================
  /**
   * Who may message whom: owners and workers can talk to each other, but not
   * to their own role (privacy between users). A worker may only open a
   * thread with an owner who has already contacted them.
   */
  canMessage(viewerId, targetId) {
    const viewer = this.idx.users.get(viewerId);
    const target = this.idx.users.get(targetId);
    if (!viewer || !target || viewer.id === target.id) return false;
    if (viewer.role === target.role) return false;
    if (viewer.role === "owner" && target.role === "worker") return true;
    if (viewer.role === "worker" && target.role === "owner") {
      return this.getConversation(viewerId, targetId).length > 0;
    }
    return false;
  },

  /** Unread messages to `userId`, optionally restricted to one sender. */
  unreadFrom(userId, fromId = null) {
    return this.db.messages.filter(m =>
      m.toId === userId && !m.read && (fromId == null || m.fromId === fromId)
    ).length;
  },

  markConversationRead(userId, otherId) {
    let n = 0;
    for (const m of this.db.messages) {
      if (m.toId === userId && m.fromId === otherId && !m.read) { m.read = true; n++; }
    }
    if (n) this.save();
    return n;
  },

  /** One entry per conversation partner, most recent activity first. */
  conversationsFor(userId) {
    const byPartner = new Map();
    for (const m of this.db.messages) {
      const partner = m.fromId === userId ? m.toId : (m.toId === userId ? m.fromId : null);
      if (!partner) continue;
      const prev = byPartner.get(partner);
      if (!prev || new Date(m.createdAt) > new Date(prev.createdAt)) byPartner.set(partner, m);
    }
    return [...byPartner.entries()]
      .map(([partnerId, last]) => ({
        user: this.user(partnerId),
        last,
        unread: this.unreadFrom(userId, partnerId),
      }))
      .filter(c => c.user)
      .sort((a, b) => new Date(b.last.createdAt) - new Date(a.last.createdAt));
  },

  // ==================== PHOTOS ====================
  addPhoto({ propertyId, taskId, uploaderId, dataUrl, caption, lat, lng, kind }) {
    const ph = {
      id: uid(), propertyId, taskId: taskId || null, uploaderId,
      dataUrl, caption: caption || "", lat: lat ?? null, lng: lng ?? null,
      kind: kind || "issue", at: new Date().toISOString(),
    };
    this.db.photos.push(ph);
    this.reindex();
    this.save();
    return ph;
  },

  photo(id) { return this.idx.photos.get(id) || null; },
  photosFor(propertyId) { return this.idx.photosByProperty.get(propertyId) || []; },

  photosForUser(user) {
    const ids = new Set(this.propertiesFor(user).map(p => p.id));
    return this.db.photos.filter(ph => ids.has(ph.propertyId));
  },

  // ==================== WORKERS ====================
  workers() {
    return this.db.users.filter(u => u.role === "worker").map(u => this.publicUser(u));
  },

  // ==================== STATS ====================
  statsFor(user) {
    const tasks = this.tasksForUser(user);
    const props = this.propertiesFor(user);
    const done = tasks.filter(t => t.status === "accepted" || t.status === "completed");
    const today = new Date(new Date().toDateString());
    return {
      properties: props.length,
      open: tasks.filter(t => t.status === "open").length,
      doing: tasks.filter(t => t.status === "in_progress" || t.status === "assigned").length,
      done: done.length,
      overdue: tasks.filter(t => !["completed", "accepted"].includes(t.status) && t.dueDate && new Date(t.dueDate) < today).length,
      photos: this.photosForUser(user).length,
      completion: tasks.length ? Math.round((done.length / tasks.length) * 100) : 0,
    };
  },

  // ==================== DEMO DATA ====================
  async createDemoData() {
    const existing = this.idx.usersByEmail.get("demo@habitat.app");
    if (existing) return this.publicUser(existing);

    const owner = await this.signup({ name: "Demo Owner", email: "demo@habitat.app", password: "demo1234", role: "owner" });
    const w1 = await this.signup({ name: "Alex Plumber", email: "alex@habitat.app", password: "demo1234", role: "worker", phone: "555-0101", location: "Los Angeles, CA" });
    const w2 = await this.signup({ name: "Sam Electrician", email: "sam@habitat.app", password: "demo1234", role: "worker", phone: "555-0102", location: "Los Angeles, CA" });
    const w3 = await this.signup({ name: "Jordan Roofer", email: "jordan@habitat.app", password: "demo1234", role: "worker", phone: "555-0103", location: "Los Angeles, CA" });

    // Worker profiles
    this.updateWorkerProfile(w1.id, { bio: "Licensed plumber with 10 years experience.", skills: ["Plumbing", "Pipe repair", "Fixture installation"], trade: "Plumber", location: "Los Angeles, CA", serviceRadius: 30 });
    this.updateWorkerProfile(w2.id, { bio: "Certified electrician specializing in residential.", skills: ["Electrical", "Wiring", "Panel upgrades"], trade: "Electrician", location: "Los Angeles, CA", serviceRadius: 25 });
    this.updateWorkerProfile(w3.id, { bio: "Roofing specialist, all roof types.", skills: ["Roofing", "Shingles", "Gutters"], trade: "Roofer", location: "Los Angeles, CA", serviceRadius: 40 });

    // Crew — created and run by a worker, not by the homeowner
    const crew = this.createCrew(w1.id, "Alex's Crew", [w1.id, w2.id]);

    // Properties
    const p1 = this.addProperty({ ownerId: owner.id, name: "Maple Street House", address: "123 Maple St", lat: 34.0522, lng: -118.2437, notes: "Front and back yard", description: "Beautiful 3-bedroom home", details: { rooms: 5, yearBuilt: 1985, squareFootage: 2100 } });
    const p2 = this.addProperty({ ownerId: owner.id, name: "Oak Avenue Cottage", address: "456 Oak Ave", lat: 34.0622, lng: -118.2537, notes: "Garden needs work", description: "Cozy cottage with garden", details: { rooms: 3, yearBuilt: 1972, squareFootage: 1400 } });

    // Assign workers to properties
    p1.workers = [w1.id, w2.id];
    p2.workers = [w3.id];

    const today = new Date();
    const iso = d => new Date(today.getTime() + d * 86400000).toISOString().slice(0, 10);

    // Tasks
    this.addTask({ propertyId: p1.id, createdBy: owner.id, title: "Fix kitchen faucet", description: "The kitchen faucet is leaking from the base. Needs a new cartridge.", priority: "high", category: "plumbing", lat: 34.0532, lng: -118.2447, assigneeId: w1.id, dueDate: iso(3) });
    this.addTask({ propertyId: p1.id, createdBy: owner.id, title: "Paint living room", description: "Walls need repainting. Color: warm white.", priority: "normal", category: "painting", lat: 34.0512, lng: -118.2427, dueDate: iso(7) });
    this.addTask({ propertyId: p2.id, createdBy: owner.id, title: "Replace roof shingles", description: "Several shingles are missing on the south side.", priority: "high", category: "roofing", lat: 34.0632, lng: -118.2547, assigneeId: w3.id, dueDate: iso(-1) });
    this.addTask({ propertyId: p2.id, createdBy: owner.id, title: "Install outdoor lights", description: "Need motion-sensor lights on the back porch.", priority: "low", category: "electrical", lat: 34.0612, lng: -118.2527, assigneeId: w2.id, dueDate: iso(14) });
    this.addTask({ propertyId: p1.id, createdBy: owner.id, title: "Trim hedges", description: "Front hedges are overgrown. Trim to 3ft height.", priority: "low", category: "landscaping", lat: 34.0542, lng: -118.2457, dueDate: iso(21) });

    // A few finished jobs so worker profiles show a real work history
    const finished = [
      { propertyId: p1.id, title: "Repair leaking radiator", description: "Sealed a pinhole leak and bled the system.", priority: "high", category: "plumbing", assigneeId: w1.id, doneBy: w1.id, days: -12 },
      { propertyId: p2.id, title: "Rewire back porch outlet", description: "Replaced a corroded outdoor outlet and GFCI.", priority: "normal", category: "electrical", assigneeId: w2.id, doneBy: w2.id, days: -9 },
      { propertyId: p2.id, title: "Patch roof flashing", description: "Resealed flashing around the chimney.", priority: "normal", category: "roofing", assigneeId: w3.id, doneBy: w3.id, days: -20 },
      { propertyId: p1.id, title: "Unclog kitchen drain", description: "Cleared a blocked drain trap.", priority: "normal", category: "plumbing", assigneeId: w1.id, doneBy: w1.id, days: -4 },
      { propertyId: p2.id, title: "Replace bathroom fan", description: "Swapped a noisy exhaust fan for a quiet unit.", priority: "low", category: "electrical", assigneeId: w2.id, doneBy: w2.id, days: -2 },
    ];
    for (const f of finished) {
      const t = this.addTask({
        propertyId: f.propertyId, createdBy: owner.id, title: f.title,
        description: f.description, priority: f.priority, assigneeId: f.assigneeId,
        dueDate: iso(f.days), category: f.category,
      });
      t.status = "completed";
      t.completedAt = new Date(today.getTime() + f.days * 86400000).toISOString();
      t.completedBy = f.doneBy;
    }

    // House records
    this.addHouseRecord(p1.id, { title: "Fixed main water line", description: "Replaced corroded pipe under sink", category: "plumbing", cost: 350, date: iso(-30), workerId: w1.id, notes: "Warranty: 1 year" });
    this.addHouseRecord(p1.id, { title: "Installed new HVAC filter", description: "Replaced air filter and cleaned vents", category: "hvac", cost: 120, date: iso(-60), workerId: w2.id, notes: "" });

    // Hires
    this.hireWorker(owner.id, w1.id, p1.id);
    this.hireWorker(owner.id, w2.id, p1.id);
    this.hireWorker(owner.id, w3.id, p2.id);

    // Messages
    this.sendMessage(owner.id, w1.id, "Hi Alex, the faucet is still leaking. Can you take a look this week?");
    this.sendMessage(w1.id, owner.id, "Sure, I can come by Thursday afternoon.");
    this.sendMessage(owner.id, w2.id, "Sam, are the porch lights ready to install next week?");
    this.sendMessage(w2.id, owner.id, "Yes — the parts arrive Monday, so Tuesday works.");
    this.sendMessage(owner.id, w3.id, "Jordan, thanks for patching the flashing. Any warranty on that?");

    // The demo button signs in without a password, so seed the known demo
    // accounts into the local store so the UI has data to render. The API
    // signup calls above already registered them server-side.
    this.db.users.push(w1, w2, w3);
    this.reindex();
    this.save();
    return owner;
  },
};

// Export for ES modules and CommonJS
if (typeof module !== "undefined" && module.exports) {
  module.exports = { Store, uid, DB_KEY, SESSION_KEY };
}
export { Store, uid, DB_KEY, SESSION_KEY };
