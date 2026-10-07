/* Habitat — clean, working app from scratch */
"use strict";

// ==================== STATE ====================
let ME = null;
let view = "dashboard";
let map = null;

// ==================== HELPERS ====================
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toast(msg, kind = "info", ms = 3000) {
  let host = $(".toast-host");
  if (!host) {
    host = el("div", "toast-host");
    document.body.appendChild(host);
  }
  const n = el("div", `toast ${kind}`);
  n.textContent = msg;
  host.appendChild(n);
  requestAnimationFrame(() => n.classList.add("in"));
  setTimeout(() => { n.classList.remove("in"); setTimeout(() => n.remove(), 300); }, ms);
}

function openModal(node) {
  node.hidden = false;
  document.body.style.overflow = "hidden";
}
function closeModal(node) {
  node.hidden = true;
  document.body.style.overflow = "";
}

function modal(title, bodyNode) {
  const m = el("div", "modal");
  m.hidden = true;
  const back = el("div", "modal-backdrop");
  back.onclick = () => closeModal(m);
  m.appendChild(back);
  const card = el("div", "modal-card");
  const x = el("button", "x", "×");
  x.onclick = () => closeModal(m);
  card.appendChild(x);
  if (title) card.appendChild(el("h3", null, title));
  card.appendChild(bodyNode);
  m.appendChild(card);
  document.body.appendChild(m);
  return m;
}

function initial(name) {
  return (String(name || "?").trim().charAt(0) || "?").toUpperCase();
}

function avatarColor(id) {
  let h = 0;
  for (let i = 0; i < String(id).length; i++) h = (h * 31 + String(id).charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 55% 45%)`;
}

function relTime(iso) {
  if (!iso) return "";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return Math.floor(d / 60) + "m ago";
  if (d < 86400) return Math.floor(d / 3600) + "h ago";
  if (d < 604800) return Math.floor(d / 86400) + "d ago";
  return new Date(iso).toLocaleDateString();
}

// ==================== STORE ====================
const DB_KEY = "habitat.db.v1";
const SESSION_KEY = "habitat.session.v1";

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function sha256(text) {
  try {
    const buf = new TextEncoder().encode(text);
    const d = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
  } catch {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
    return h.toString(16);
  }
}

const Store = {
  db: { users: [], properties: [], tasks: [], photos: [], groups: [], activity: [] },
  idx: {},

  load() {
    try {
      const raw = localStorage.getItem(DB_KEY);
      if (raw) this.db = JSON.parse(raw);
    } catch { /* fresh start */ }
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
    for (const u of this.db.users) usersByEmail.set(u.email, u);
    const groupsByMember = new Map();
    for (const g of this.db.groups) {
      for (const mid of g.memberIds || []) {
        if (!groupsByMember.has(mid)) groupsByMember.set(mid, []);
        groupsByMember.get(mid).push(g.id);
      }
    }
    this.idx = {
      users: byId(this.db.users),
      usersByEmail,
      properties: byId(this.db.properties),
      tasks: byId(this.db.tasks),
      photos: byId(this.db.photos),
      groups: byId(this.db.groups),
      propsByOwner: groupBy(this.db.properties, "ownerId"),
      tasksByProperty: groupBy(this.db.tasks, "propertyId"),
      photosByProperty: groupBy(this.db.photos, "propertyId"),
      groupsByOwner: groupBy(this.db.groups, "ownerId"),
      groupsByMember,
    };
  },

  save() {
    try { localStorage.setItem(DB_KEY, JSON.stringify(this.db)); } catch { /* quota */ }
  },

  commit() { this.save(); },

  log(userId, action) {
    this.db.activity.unshift({ id: uid(), at: new Date().toISOString(), userId, action });
    if (this.db.activity.length > 200) this.db.activity.length = 200;
  },

  // Auth
  async signup({ name, email, password, role }) {
    email = (email || "").trim().toLowerCase();
    name = (name || "").trim();
    if (!name || !email || !password) throw new Error("Please fill in all fields.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("That email doesn't look right.");
    if (password.length < 8) throw new Error("Password must be 8+ characters.");
    if (this.idx.usersByEmail.has(email)) throw new Error("That email is already registered.");
    const user = {
      id: uid(), name, email,
      pw: await sha256(password + email),
      role: role === "worker" ? "worker" : "owner",
      active: true, createdAt: new Date().toISOString(), lastSeen: null,
    };
    this.db.users.push(user);
    this.log(user.id, "account.created");
    this.reindex();
    this.save();
    return this.publicUser(user);
  },

  async login(email, password) {
    email = (email || "").trim().toLowerCase();
    const u = this.idx.usersByEmail.get(email);
    if (!u) throw new Error("No account with that email.");
    if (!u.active) throw new Error("This account has been disabled.");
    if (u.pw !== await sha256(password + email)) throw new Error("Wrong password.");
    u.lastSeen = new Date().toISOString();
    this.log(u.id, "account.login");
    this.save();
    return this.publicUser(u);
  },

  async resetPassword(email, next) {
    email = (email || "").trim().toLowerCase();
    const u = this.idx.usersByEmail.get(email);
    if (!u) throw new Error("No account with that email.");
    if (!next || next.length < 8) throw new Error("Password must be 8+ characters.");
    u.pw = await sha256(next + email);
    this.log(u.id, "account.password_reset");
    this.save();
    return this.publicUser(u);
  },

  publicUser(u) {
    if (!u) return null;
    const { pw, ...rest } = u;
    return rest;
  },

  user(id) { return this.publicUser(this.idx.users.get(id)); },

  setSession(id) {
    try {
      if (id) localStorage.setItem(SESSION_KEY, id);
      else localStorage.removeItem(SESSION_KEY);
    } catch { /* ignore */ }
  },
  session() { try { return localStorage.getItem(SESSION_KEY); } catch { return null; } },

  // Properties
  addProperty({ ownerId, name, address, lat, lng, notes }) {
    const p = {
      id: uid(), ownerId, name: (name || "Property").trim(),
      address: address || "", notes: notes || "",
      lat: lat ?? null, lng: lng ?? null,
      workers: [], groups: [], createdAt: new Date().toISOString(),
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
    const myGroups = new Set(this.idx.groupsByMember.get(user.id) || []);
    return this.db.properties.filter(p =>
      p.workers.includes(user.id) || (p.groups || []).some(g => myGroups.has(g)));
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
    this.log(p.ownerId, "property.deleted");
    this.reindex();
    this.save();
  },

  // Tasks
  addTask({ propertyId, createdBy, title, description, lat, lng, priority, assigneeId, dueDate }) {
    const t = {
      id: uid(), propertyId, createdBy,
      title: (title || "Task").trim(), description: description || "",
      lat: lat ?? null, lng: lng ?? null,
      priority: priority || "normal", status: "open",
      assigneeId: assigneeId || null, dueDate: dueDate || null,
      photoId: null, completionPhotoId: null,
      createdAt: new Date().toISOString(), completedAt: null, completedBy: null,
      comments: [],
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
    if (patch.status === "done" && !t.completedAt) t.completedAt = new Date().toISOString();
    if (patch.status && patch.status !== "done") t.completedAt = null;
    this.log(t.createdBy, "task.updated");
    this.save();
    return t;
  },

  setTaskStatus(id, status, userId) {
    const t = this.task(id);
    if (!t) return null;
    t.status = status;
    if (status === "done") { t.completedAt = new Date().toISOString(); t.completedBy = userId; }
    else t.completedAt = null;
    this.log(userId, status === "done" ? "task.completed" : "task.reopened");
    this.save();
    return t;
  },

  deleteTask(id) {
    const t = this.task(id);
    if (!t) return;
    this.db.tasks = this.db.tasks.filter(x => x.id !== id);
    this.log(t.createdBy, "task.deleted");
    this.reindex();
    this.save();
  },

  // Photos
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

  // Groups
  addGroup({ ownerId, name, description, color }) {
    const g = {
      id: uid(), ownerId, name: (name || "Crew").trim(),
      description: description || "", color: color || "#34d399",
      memberIds: [], createdAt: new Date().toISOString(),
    };
    this.db.groups.push(g);
    this.log(ownerId, "group.created");
    this.reindex();
    this.save();
    return g;
  },

  group(id) { return this.idx.groups.get(id) || null; },
  groupsFor(ownerId) { return this.idx.groupsByOwner.get(ownerId) || []; },

  updateGroup(id, patch) {
    const g = this.group(id);
    if (!g) return null;
    Object.assign(g, patch);
    this.log(g.ownerId, "group.updated");
    this.save();
    return g;
  },

  deleteGroup(id) {
    const g = this.group(id);
    if (!g) return;
    this.db.groups = this.db.groups.filter(x => x.id !== id);
    for (const p of this.db.properties) {
      if (p.groups) p.groups = p.groups.filter(x => x !== id);
    }
    this.log(g.ownerId, "group.deleted");
    this.reindex();
    this.save();
  },

  setGroupMembers(groupId, memberIds) {
    const g = this.group(groupId);
    if (!g) return null;
    g.memberIds = [...new Set(memberIds)];
    this.log(g.ownerId, "group.members_set");
    this.reindex();
    this.save();
    return g;
  },

  // Workers
  workers() {
    return this.db.users.filter(u => u.role === "worker").map(u => this.publicUser(u));
  },

  // Stats
  statsFor(user) {
    const tasks = this.tasksForUser(user);
    const props = this.propertiesFor(user);
    const done = tasks.filter(t => t.status === "done");
    const today = new Date(new Date().toDateString());
    return {
      properties: props.length,
      open: tasks.filter(t => t.status === "open").length,
      doing: tasks.filter(t => t.status === "doing").length,
      done: done.length,
      overdue: tasks.filter(t => t.status !== "done" && t.dueDate && new Date(t.dueDate) < today).length,
      photos: this.photosForUser(user).length,
      completion: tasks.length ? Math.round((done.length / tasks.length) * 100) : 0,
    };
  },

  // Demo data
  async createDemoData() {
    const existing = this.idx.usersByEmail.get("demo@habitat.app");
    if (existing) return this.publicUser(existing);

    const owner = await this.signup({ name: "Demo Owner", email: "demo@habitat.app", password: "demo1234", role: "owner" });
    const w1 = await this.signup({ name: "Alex Plumber", email: "alex@habitat.app", password: "demo1234", role: "worker" });
    const w2 = await this.signup({ name: "Sam Electrician", email: "sam@habitat.app", password: "demo1234", role: "worker" });
    const w3 = await this.signup({ name: "Jordan Roofer", email: "jordan@habitat.app", password: "demo1234", role: "worker" });

    const crew = this.addGroup({ ownerId: owner.id, name: "Home Crew", description: "General repairs", color: "#34d399" });
    this.setGroupMembers(crew.id, [w1.id, w2.id]);

    const p1 = this.addProperty({ ownerId: owner.id, name: "Maple Street House", address: "123 Maple St", lat: 34.0522, lng: -118.2437, notes: "Front and back yard" });
    const p2 = this.addProperty({ ownerId: owner.id, name: "Oak Avenue Cottage", address: "456 Oak Ave", lat: 34.0622, lng: -118.2537, notes: "Garden needs work" });
    this.assignGroup(p1.id, crew.id);

    const today = new Date();
    const iso = d => new Date(today.getTime() + d * 86400000).toISOString().slice(0, 10);

    this.addTask({ propertyId: p1.id, createdBy: owner.id, title: "Fix kitchen faucet", description: "The kitchen faucet is leaking from the base. Needs a new cartridge.", priority: "high", lat: 34.0532, lng: -118.2447, assigneeId: w1.id, dueDate: iso(3) });
    this.addTask({ propertyId: p1.id, createdBy: owner.id, title: "Paint living room", description: "Walls need repainting. Color: warm white.", priority: "normal", lat: 34.0512, lng: -118.2427, dueDate: iso(7) });
    this.addTask({ propertyId: p2.id, createdBy: owner.id, title: "Replace roof shingles", description: "Several shingles are missing on the south side.", priority: "high", lat: 34.0632, lng: -118.2547, assigneeId: w3.id, dueDate: iso(-1) });
    this.addTask({ propertyId: p2.id, createdBy: owner.id, title: "Install outdoor lights", description: "Need motion-sensor lights on the back porch.", priority: "low", lat: 34.0612, lng: -118.2527, assigneeId: w2.id, dueDate: iso(14) });
    this.addTask({ propertyId: p1.id, createdBy: owner.id, title: "Trim hedges", description: "Front hedges are overgrown. Trim to 3ft height.", priority: "low", lat: 34.0542, lng: -118.2457, dueDate: iso(21) });

    this.commit();
    return owner;
  },

  assignGroup(propId, groupId) {
    const p = this.property(propId);
    if (!p) return;
    p.groups = p.groups || [];
    if (!p.groups.includes(groupId)) p.groups.push(groupId);
    this.save();
  },
};

// ==================== APP ====================
function boot() {
  try {
    Store.load();
    const sid = Store.session();
    if (sid) {
      const u = Store.user(sid);
      if (u && u.active) {
        ME = u;
        return showApp();
      }
      Store.setSession(null);
    }
    showLanding();
  } catch (e) {
    console.error("Boot failed", e);
    document.body.innerHTML = '<div style="display:grid;place-items:center;min-height:100vh;background:#0a0f0d;color:#e8f0ec;font-family:system-ui;text-align:center;padding:24px;"><div><h1>Something went wrong</h1><p style="color:#8fa89a;margin:12px 0 20px;">Please clear your browser data and try again.</p><button onclick="location.reload()" style="background:#34d399;color:#04150f;border:none;padding:12px 24px;border-radius:10px;font-weight:700;cursor:pointer;">Reload</button></div></div>';
  }
}

// ==================== LANDING ====================
function showLanding() {
  $("#app").hidden = true;
  $("#auth").hidden = true;
  $("#landing").hidden = false;
  wireLanding();
}

function wireLanding() {
  $("#navLoginBtn").onclick = showAuth;
  $("#navSignupBtn").onclick = () => { showAuth(); showSignupForm(); };
  $("#heroGetStartedBtn").onclick = () => { showAuth(); showSignupForm(); };
  $("#heroDemoBtn").onclick = doDemo;
}

async function doDemo() {
  try {
    let demoUser = Store.user("demo_owner");
    if (!demoUser) {
      const email = "demo@habitat.app";
      const existing = Store.idx.usersByEmail.get(email);
      if (existing) {
        demoUser = Store.publicUser(existing);
      } else {
        demoUser = await Store.createDemoData();
      }
    }
    Store.setSession(demoUser.id);
    ME = demoUser;
    showApp();
    toast("Demo account loaded with sample data", "good");
  } catch (e) {
    console.error("Demo failed:", e);
    toast("Could not create demo account", "bad");
  }
}

// ==================== AUTH ====================
function showAuth() {
  $("#landing").hidden = true;
  $("#app").hidden = true;
  $("#auth").hidden = false;
  $("#authPanel").hidden = false;
  $("#loginForm").hidden = false;
  $("#signupForm").hidden = true;
  $("#resetForm").hidden = true;
}

function showSignupForm() {
  $("#loginForm").hidden = true;
  $("#signupForm").hidden = false;
  $("#resetForm").hidden = true;
}

function showLoginForm() {
  $("#loginForm").hidden = false;
  $("#signupForm").hidden = true;
  $("#resetForm").hidden = true;
}

function showResetForm() {
  $("#loginForm").hidden = true;
  $("#signupForm").hidden = true;
  $("#resetForm").hidden = false;
}

function authError(msg) {
  const n = $("#authError");
  n.textContent = msg;
  n.hidden = false;
  setTimeout(() => { n.hidden = true; }, 5000);
}

async function doLogin(e) {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector("button[type=submit]");
  if (btn) { btn.disabled = true; btn.textContent = "Logging in…"; }
  try {
    const u = await Store.login(f.email.value, f.password.value);
    Store.setSession(u.id);
    ME = u;
    showApp();
  } catch (err) {
    authError(err.message || "Login failed");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Log in"; }
  }
}

async function doSignup(e) {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector("button[type=submit]");
  if (btn) { btn.disabled = true; btn.textContent = "Creating account…"; }
  try {
    const u = await Store.signup({
      name: f.name.value, email: f.email.value,
      password: f.password.value, role: f.role.value,
    });
    Store.setSession(u.id);
    ME = u;
    showApp();
    startTutorial();
  } catch (err) {
    authError(err.message || "Signup failed");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Create account"; }
  }
}

async function doReset(e) {
  e.preventDefault();
  const f = e.target;
  if (f.next.value !== f.confirm.value) return authError("Passwords don't match.");
  try {
    await Store.resetPassword(f.email.value, f.next.value);
    showLoginForm();
    toast("Password reset successful. Log in with your new password.", "good");
  } catch (err) {
    authError(err.message || "Reset failed");
  }
}

function logout() {
  Store.commit();
  Store.setSession(null);
  ME = null;
  if (map) { map.remove(); map = null; }
  showLanding();
}

// ==================== APP SHELL ====================
function showApp() {
  $("#landing").hidden = true;
  $("#auth").hidden = true;
  $("#app").hidden = false;
  $("#whoName").textContent = ME.name;
  $("#whoRole").textContent = ME.role === "owner" ? "Property owner" : "Trade worker";
  const av = $("#avatar");
  av.textContent = initial(ME.name);
  av.style.background = avatarColor(ME.id);
  buildNav();
  go("dashboard");
}

function buildNav() {
  const nav = $("#tabs");
  nav.innerHTML = "";
  const tabs = ME.role === "owner"
    ? ["dashboard", "tasks", "map", "people", "settings"]
    : ["dashboard", "tasks", "map", "settings"];
  tabs.forEach(v => {
    const b = el("button", "navbtn", v.charAt(0).toUpperCase() + v.slice(1));
    b.dataset.view = v;
    b.onclick = () => go(v);
    nav.appendChild(b);
  });

  // Bottom nav
  const bn = $("#bottomNav");
  bn.innerHTML = "";
  const icons = { dashboard: "📊", tasks: "📋", map: "🗺️", people: "👷", settings: "⚙️" };
  const labels = { dashboard: "Home", tasks: "Tasks", map: "Map", people: "People", settings: "Settings" };
  tabs.forEach(v => {
    const b = el("button", "bottom-nav-btn");
    b.dataset.view = v;
    b.innerHTML = `${icons[v]}<span>${labels[v]}</span>`;
    b.onclick = () => go(v);
    bn.appendChild(b);
  });
}

function go(v) {
  view = v;
  $$(".navbtn").forEach(b => b.classList.toggle("active", b.dataset.view === v));
  $$(".bottom-nav-btn").forEach(b => b.classList.toggle("active", b.dataset.view === v));
  $$(".view").forEach(s => { s.hidden = s.id !== `view-${v}`; });
  render();
}

// ==================== RENDER ====================
function render() {
  if (!ME) return;
  if (view === "dashboard") renderDashboard();
  else if (view === "tasks") renderTasks();
  else if (view === "map") renderMap();
  else if (view === "people") renderPeople();
  else if (view === "settings") renderSettings();
}

// ==================== DASHBOARD ====================
function renderDashboard() {
  const wrap = $("#view-dashboard");
  wrap.innerHTML = "";
  const props = Store.propertiesFor(ME);
  const tasks = Store.tasksForUser(ME);
  const s = Store.statsFor(ME);

  // Stats
  const stats = el("div", "stats");
  stats.innerHTML = `
    <div class="stat"><b>${s.properties}</b><span>Properties</span></div>
    <div class="stat"><b>${s.open}</b><span>Open</span></div>
    <div class="stat"><b>${s.doing}</b><span>In Progress</span></div>
    <div class="stat"><b>${s.done}</b><span>Done</span></div>
    <div class="stat"><b>${s.overdue}</b><span>Overdue</span></div>
    <div class="stat"><b>${s.photos}</b><span>Photos</span></div>
  `;
  wrap.appendChild(stats);

  // Quick actions
  if (ME.role === "owner" && props.length) {
    const actions = el("div", "card-actions");
    const addBtn = el("button", "btn sm", "+ New Task");
    addBtn.onclick = () => openTaskModal();
    actions.appendChild(addBtn);
    const addPropBtn = el("button", "btn ghost sm", "+ Add Property");
    addPropBtn.onclick = () => openPropertyModal();
    actions.appendChild(addPropBtn);
    wrap.appendChild(actions);
  }

  // Tasks by status
  const overdue = tasks.filter(t => t.status !== "done" && t.dueDate && new Date(t.dueDate) < new Date(new Date().toDateString()));
  if (overdue.length) {
    const sec = el("div", "card");
    sec.appendChild(el("h3", null, "⚠️ Overdue"));
    overdue.slice(0, 5).forEach(t => sec.appendChild(taskCard(t)));
    wrap.appendChild(sec);
  }

  const doing = tasks.filter(t => t.status === "doing");
  if (doing.length) {
    const sec = el("div", "card");
    sec.appendChild(el("h3", null, "In Progress"));
    doing.slice(0, 5).forEach(t => sec.appendChild(taskCard(t)));
    wrap.appendChild(sec);
  }

  const open = tasks.filter(t => t.status === "open");
  if (open.length) {
    const sec = el("div", "card");
    sec.appendChild(el("h3", null, "Open Tasks"));
    open.slice(0, 8).forEach(t => sec.appendChild(taskCard(t)));
    wrap.appendChild(sec);
  }

  if (!tasks.length) {
    wrap.appendChild(emptyState("No tasks yet", "Create your first task to get started", "New Task", () => openTaskModal()));
  }
}

function taskCard(t) {
  const prop = Store.property(t.propertyId);
  const card = el("div", `card task-card pri-${t.priority} st-${t.status}`);
  const head = el("div", "task-head");
  head.appendChild(el("h4", null, t.title));
  head.appendChild(el("span", `pill ${t.status}`, t.status));
  card.appendChild(head);

  const meta = el("div", "muted sm");
  const bits = [prop ? prop.name : "", t.dueDate ? `Due: ${t.dueDate}` : ""].filter(Boolean);
  meta.textContent = bits.join(" · ");
  card.appendChild(meta);

  if (t.description) {
    card.appendChild(el("p", "muted", t.description.slice(0, 120) + (t.description.length > 120 ? "…" : "")));
  }

  const acts = el("div", "card-actions");
  if (t.status === "open") {
    const startBtn = el("button", "btn sm ghost", "Start");
    startBtn.onclick = () => { Store.setTaskStatus(t.id, "doing", ME.id); render(); };
    acts.appendChild(startBtn);
  }
  if (t.status !== "done") {
    const doneBtn = el("button", "btn sm", "Mark Done");
    doneBtn.onclick = () => { Store.setTaskStatus(t.id, "done", ME.id); toast("Task completed!", "good"); render(); };
    acts.appendChild(doneBtn);
  } else {
    const reopenBtn = el("button", "btn sm ghost", "Reopen");
    reopenBtn.onclick = () => { Store.setTaskStatus(t.id, "open", ME.id); render(); };
    acts.appendChild(reopenBtn);
  }
  if (ME.role === "owner") {
    const delBtn = el("button", "btn sm ghost danger", "Delete");
    delBtn.onclick = () => {
      if (confirm("Delete this task?")) { Store.deleteTask(t.id); render(); }
    };
    acts.appendChild(delBtn);
  }
  card.appendChild(acts);
  return card;
}

function emptyState(text, sub, actionLabel, onAction) {
  const d = el("div", "empty");
  d.appendChild(el("p", null, text));
  if (sub) d.appendChild(el("p", "muted sm", sub));
  if (actionLabel && onAction) {
    const b = el("button", "btn", actionLabel);
    b.onclick = onAction;
    d.appendChild(b);
  }
  return d;
}

// ==================== TASKS ====================
function renderTasks() {
  const wrap = $("#view-tasks");
  wrap.innerHTML = "";
  const props = Store.propertiesFor(ME);

  const hd = el("div", "card");
  hd.style.display = "flex";
  hd.style.justifyContent = "space-between";
  hd.style.alignItems = "center";
  hd.appendChild(el("h2", null, "Tasks"));
  if (ME.role === "owner" && props.length) {
    const addBtn = el("button", "btn sm", "+ New Task");
    addBtn.onclick = () => openTaskModal();
    hd.appendChild(addBtn);
  }
  wrap.appendChild(hd);

  if (!props.length) {
    wrap.appendChild(emptyState("No properties yet", "Add a property first to create tasks", "Add Property", () => openPropertyModal()));
    return;
  }

  const tasks = Store.tasksForUser(ME);
  if (!tasks.length) {
    wrap.appendChild(emptyState("No tasks yet", "Create your first task to get started", "New Task", () => openTaskModal()));
    return;
  }

  const list = el("div", "grid");
  tasks.forEach(t => list.appendChild(taskCard(t)));
  wrap.appendChild(list);
}

// ==================== MAP ====================
function renderMap() {
  const wrap = $("#view-map");
  wrap.innerHTML = "";

  const hd = el("div", "card");
  hd.style.display = "flex";
  hd.style.justifyContent = "space-between";
  hd.style.alignItems = "center";
  hd.appendChild(el("h2", null, "Map"));
  const locBtn = el("button", "btn ghost sm", "📍 My Location");
  locBtn.onclick = () => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        pos => { if (map) map.setView([pos.coords.latitude, pos.coords.longitude], 15); },
        () => toast("Location access denied", "bad")
      );
    }
  };
  hd.appendChild(locBtn);
  wrap.appendChild(hd);

  const mapDiv = el("div", "map");
  mapDiv.id = "mapCanvas";
  wrap.appendChild(mapDiv);

  const legend = el("div", "map-legend");
  legend.innerHTML = `
    <span class="lg"><i class="sw" style="background:var(--cyan)"></i>Properties</span>
    <span class="lg"><i class="sw" style="background:var(--red)"></i>High</span>
    <span class="lg"><i class="sw" style="background:var(--gold)"></i>Normal</span>
    <span class="lg"><i class="sw" style="background:var(--green)"></i>Low</span>
  `;
  wrap.appendChild(legend);

  // Init map
  if (typeof L !== "undefined") {
    if (map) map.remove();
    map = L.map(mapDiv).setView([34.0522, -118.2437], 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    const props = Store.propertiesFor(ME);
    const bounds = [];
    props.forEach(p => {
      if (p.lat != null && p.lng != null) {
        L.marker([p.lat, p.lng]).addTo(map).bindPopup(`<b>${esc(p.name)}</b>`);
        bounds.push([p.lat, p.lng]);
      }
      Store.tasksFor(p.id).forEach(t => {
        if (t.lat == null || t.lng == null) return;
        const col = t.status === "done" ? "#6b7280" : t.priority === "high" ? "#f87171" : t.priority === "low" ? "#34d399" : "#fbbf24";
        L.circleMarker([t.lat, t.lng], { radius: 8, color: "#0a0f0d", weight: 2, fillColor: col, fillOpacity: 1 })
          .addTo(map).bindPopup(`<b>${esc(t.title)}</b><br>${t.status} — ${t.priority}`);
        bounds.push([t.lat, t.lng]);
      });
    });
    if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });

    // Click to add task
    map.on("click", e => {
      if (ME.role !== "owner") return;
      openTaskModal(null, e.latlng.lat, e.latlng.lng);
    });
  } else {
    wrap.appendChild(el("p", "muted", "Map library not loaded. Check your internet connection."));
  }
}

// ==================== PEOPLE ====================
function renderPeople() {
  const wrap = $("#view-people");
  wrap.innerHTML = "";

  wrap.appendChild(el("h2", null, "People"));

  if (ME.role === "owner") {
    // Workers
    const workers = Store.workers();
    const sec = el("div", "card");
    sec.appendChild(el("h3", null, "Trade Workers"));
    if (!workers.length) {
      sec.appendChild(el("p", "muted", "No workers registered yet."));
    } else {
      workers.forEach(w => {
        const row = el("div", "card");
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.gap = "12px";
        const av = el("span", "avatar", initial(w.name));
        av.style.background = avatarColor(w.id);
        row.appendChild(av);
        row.appendChild(el("b", null, w.name));
        row.appendChild(el("span", "muted sm", w.email));
        sec.appendChild(row);
      });
    }
    wrap.appendChild(sec);

    // Crews
    const crews = Store.groupsFor(ME.id);
    const crewSec = el("div", "card");
    crewSec.appendChild(el("h3", null, "Crews"));
    if (!crews.length) {
      crewSec.appendChild(el("p", "muted", "No crews yet. Create one to group workers."));
    } else {
      crews.forEach(g => {
        const row = el("div", "card");
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.gap = "12px";
        row.appendChild(el("span", null, g.name));
        row.appendChild(el("span", "muted sm", `${g.memberIds.length} members`));
        crewSec.appendChild(row);
      });
    }
    const newCrewBtn = el("button", "btn ghost sm", "+ New Crew");
    newCrewBtn.onclick = () => openCrewModal();
    crewSec.appendChild(newCrewBtn);
    wrap.appendChild(crewSec);
  } else {
    // Worker view - show assigned properties
    const props = Store.propertiesFor(ME);
    const sec = el("div", "card");
    sec.appendChild(el("h3", null, "My Properties"));
    if (!props.length) {
      sec.appendChild(el("p", "muted", "No properties assigned to you yet."));
    } else {
      props.forEach(p => {
        const row = el("div", "card");
        row.appendChild(el("b", null, p.name));
        row.appendChild(el("p", "muted sm", p.address || ""));
        sec.appendChild(row);
      });
    }
    wrap.appendChild(sec);
  }
}

// ==================== SETTINGS ====================
function renderSettings() {
  const wrap = $("#view-settings");
  wrap.innerHTML = "";

  wrap.appendChild(el("h2", null, "Settings"));

  // Profile
  const prof = el("div", "card");
  prof.appendChild(el("h3", null, "Profile"));
  const nameInput = el("input");
  nameInput.value = ME.name;
  nameInput.style.cssText = "background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;width:100%";
  const nameField = el("label", "field");
  nameField.appendChild(el("span", null, "Name"));
  nameField.appendChild(nameInput);
  prof.appendChild(nameField);
  const saveBtn = el("button", "btn sm", "Save");
  saveBtn.onclick = () => {
    const u = Store.idx.users.get(ME.id);
    if (u) { u.name = nameInput.value; Store.save(); ME = Store.user(ME.id); showApp(); toast("Profile updated", "good"); }
  };
  prof.appendChild(saveBtn);
  wrap.appendChild(prof);

  // Password
  const pw = el("div", "card");
  pw.appendChild(el("h3", null, "Change Password"));
  const cur = el("input");
  cur.type = "password"; cur.placeholder = "Current password";
  cur.style.cssText = "background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;width:100%";
  pw.appendChild(cur);
  const n1 = el("input");
  n1.type = "password"; n1.placeholder = "New password (8+ chars)";
  n1.style.cssText = "background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;width:100%";
  pw.appendChild(n1);
  const pwBtn = el("button", "btn sm", "Change Password");
  pwBtn.onclick = async () => {
    try {
      const u = Store.idx.users.get(ME.id);
      if (!u) return;
      if (u.pw !== await sha256(cur.value + ME.email)) throw new Error("Wrong current password.");
      if (n1.value.length < 8) throw new Error("New password must be 8+ characters.");
      u.pw = await sha256(n1.value + ME.email);
      Store.save();
      toast("Password changed", "good");
      cur.value = n1.value = "";
    } catch (e) {
      toast(e.message, "bad");
    }
  };
  pw.appendChild(pwBtn);
  wrap.appendChild(pw);

  // Tutorial
  const tut = el("div", "card");
  tut.appendChild(el("h3", null, "Tutorial"));
  const tutBtn = el("button", "btn ghost sm", "▶ Take Tour");
  tutBtn.onclick = startTutorial;
  tut.appendChild(tutBtn);
  wrap.appendChild(tut);

  // Data
  const data = el("div", "card");
  data.appendChild(el("h3", null, "Data"));
  const exportBtn = el("button", "btn ghost sm", "Export Data");
  exportBtn.onclick = () => {
    const blob = new Blob([JSON.stringify(Store.db, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "habitat-backup.json";
    a.click();
  };
  data.appendChild(exportBtn);
  const resetBtn = el("button", "btn ghost sm danger", "Reset All Data");
  resetBtn.onclick = () => {
    if (confirm("This will delete ALL your data. Are you sure?")) {
      localStorage.removeItem(DB_KEY);
      localStorage.removeItem(SESSION_KEY);
      location.reload();
    }
  };
  data.appendChild(resetBtn);
  wrap.appendChild(data);
}

// ==================== MODALS ====================
function openTaskModal(task = null, lat = null, lng = null) {
  const props = Store.propertiesFor(ME);
  if (!props.length) { toast("Add a property first", "bad"); return; }

  const body = el("div", "stack");
  body.style.gap = "12px";

  // Property select
  const propSel = el("select");
  propSel.style.cssText = "background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;width:100%";
  props.forEach(p => {
    const o = el("option", null, p.name);
    o.value = p.id;
    propSel.appendChild(o);
  });
  const propField = el("label", "field");
  propField.appendChild(el("span", null, "Property"));
  propField.appendChild(propSel);
  body.appendChild(propField);

  // Title
  const titleInput = el("input");
  titleInput.placeholder = "What needs doing?";
  titleInput.style.cssText = "background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;width:100%";
  if (task) titleInput.value = task.title;
  const titleField = el("label", "field");
  titleField.appendChild(el("span", null, "Task"));
  titleField.appendChild(titleInput);
  body.appendChild(titleField);

  // Description
  const descInput = el("textarea");
  descInput.placeholder = "Describe the work needed…";
  descInput.rows = 3;
  descInput.style.cssText = "background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;width:100%";
  if (task) descInput.value = task.description;
  const descField = el("label", "field");
  descField.appendChild(el("span", null, "Description"));
  descField.appendChild(descInput);
  body.appendChild(descField);

  // Priority
  const prioSel = el("select");
  prioSel.style.cssText = "background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;width:100%";
  [["high", "High"], ["normal", "Normal"], ["low", "Low"]].forEach(([v, l]) => {
    const o = el("option", null, l);
    o.value = v;
    prioSel.appendChild(o);
  });
  if (task) prioSel.value = task.priority;
  const prioField = el("label", "field");
  prioField.appendChild(el("span", null, "Priority"));
  prioField.appendChild(prioSel);
  body.appendChild(prioField);

  // Due date
  const dueInput = el("input");
  dueInput.type = "date";
  dueInput.style.cssText = "background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;width:100%";
  if (task && task.dueDate) dueInput.value = task.dueDate;
  const dueField = el("label", "field");
  dueField.appendChild(el("span", null, "Due Date"));
  dueField.appendChild(dueInput);
  body.appendChild(dueField);

  // Photo
  const photoInput = el("input");
  photoInput.type = "file";
  photoInput.accept = "image/*";
  photoInput.setAttribute("capture", "environment");
  const photoField = el("label", "field");
  photoField.appendChild(el("span", null, "Photo (optional)"));
  photoField.appendChild(photoInput);
  body.appendChild(photoField);

  // Location
  const locBtn = el("button", "btn ghost sm", "📍 Use My Location");
  locBtn.onclick = () => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        pos => { lat = pos.coords.latitude; lng = pos.coords.longitude; toast("Location captured", "good"); },
        () => toast("Location denied", "bad")
      );
    }
  };
  body.appendChild(locBtn);

  // Actions
  const actions = el("div", "modal-actions");
  const cancelBtn = el("button", "btn ghost", "Cancel");
  const saveBtn = el("button", "btn", task ? "Save" : "Create Task");
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  body.appendChild(actions);

  const m = modal(task ? "Edit Task" : "New Task", body);
  cancelBtn.onclick = () => closeModal(m);
  saveBtn.onclick = () => {
    if (!titleInput.value.trim()) { toast("Please enter a task title", "bad"); return; }
    const data = {
      propertyId: propSel.value,
      title: titleInput.value,
      description: descInput.value,
      priority: prioSel.value,
      dueDate: dueInput.value || null,
      lat, lng,
    };
    if (task) {
      Store.updateTask(task.id, data);
      toast("Task updated", "good");
    } else {
      Store.addTask({ ...data, createdBy: ME.id });
      toast("Task created", "good");
    }
    closeModal(m);
    render();
  };
  openModal(m);
}

function openPropertyModal() {
  const body = el("div", "stack");
  body.style.gap = "12px";

  const nameInput = el("input");
  nameInput.placeholder = "Property name";
  nameInput.style.cssText = "background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;width:100%";
  const nameField = el("label", "field");
  nameField.appendChild(el("span", null, "Name"));
  nameField.appendChild(nameInput);
  body.appendChild(nameField);

  const addrInput = el("input");
  addrInput.placeholder = "Address";
  addrInput.style.cssText = "background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;width:100%";
  const addrField = el("label", "field");
  addrField.appendChild(el("span", null, "Address"));
  addrField.appendChild(addrInput);
  body.appendChild(addrField);

  const locBtn = el("button", "btn ghost sm", "📍 Use My Location");
  let lat = null, lng = null;
  locBtn.onclick = () => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        pos => { lat = pos.coords.latitude; lng = pos.coords.longitude; toast("Location captured", "good"); },
        () => toast("Location denied", "bad")
      );
    }
  };
  body.appendChild(locBtn);

  const actions = el("div", "modal-actions");
  const cancelBtn = el("button", "btn ghost", "Cancel");
  const saveBtn = el("button", "btn", "Add Property");
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  body.appendChild(actions);

  const m = modal("Add Property", body);
  cancelBtn.onclick = () => closeModal(m);
  saveBtn.onclick = () => {
    if (!nameInput.value.trim()) { toast("Please enter a property name", "bad"); return; }
    Store.addProperty({ ownerId: ME.id, name: nameInput.value, address: addrInput.value, lat, lng });
    closeModal(m);
    toast("Property added", "good");
    render();
  };
  openModal(m);
}

function openCrewModal() {
  const body = el("div", "stack");
  body.style.gap = "12px";

  const nameInput = el("input");
  nameInput.placeholder = "Crew name";
  nameInput.style.cssText = "background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;width:100%";
  const nameField = el("label", "field");
  nameField.appendChild(el("span", null, "Crew Name"));
  nameField.appendChild(nameInput);
  body.appendChild(nameField);

  const workers = Store.workers();
  const checks = new Map();
  workers.forEach(w => {
    const row = el("label");
    row.style.cssText = "display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--line);border-radius:10px;cursor:pointer";
    const cb = el("input");
    cb.type = "checkbox";
    cb.style.width = "18px";
    cb.style.height = "18px";
    checks.set(w.id, cb);
    row.appendChild(cb);
    const av = el("span", "avatar sm", initial(w.name));
    av.style.background = avatarColor(w.id);
    row.appendChild(av);
    row.appendChild(el("span", null, w.name));
    body.appendChild(row);
  });

  const actions = el("div", "modal-actions");
  const cancelBtn = el("button", "btn ghost", "Cancel");
  const saveBtn = el("button", "btn", "Create Crew");
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  body.appendChild(actions);

  const m = modal("New Crew", body);
  cancelBtn.onclick = () => closeModal(m);
  saveBtn.onclick = () => {
    if (!nameInput.value.trim()) { toast("Please enter a crew name", "bad"); return; }
    const ids = [];
    checks.forEach((cb, id) => { if (cb.checked) ids.push(id); });
    Store.addGroup({ ownerId: ME.id, name: nameInput.value, memberIds: ids });
    closeModal(m);
    toast("Crew created", "good");
    render();
  };
  openModal(m);
}

// ==================== TUTORIAL ====================
const TUTORIAL_STEPS = [
  { title: "Welcome to Habitat! 🌿", text: "Let's take a quick tour. This will only take a minute." },
  { title: "Dashboard", text: "This is your home. See all your tasks, properties, and progress at a glance." },
  { title: "Tasks", text: "Create tasks with photos and locations. Assign them to workers or crews." },
  { title: "Map", text: "See everything on a map. Tap anywhere to add a new task right where it needs to happen." },
  { title: "People", text: "Manage your workers and crews. Assign whole crews to properties at once." },
  { title: "Settings", text: "Update your profile, change your password, or replay this tutorial anytime." },
  { title: "You're all set! 🎉", text: "That's the basics. You can always access this tutorial again from Settings. Enjoy using Habitat!" },
];

let tutorialStep = 0;
let tutorialActive = false;

function startTutorial() {
  tutorialActive = true;
  tutorialStep = 0;
  showTutorialStep();
}

function showTutorialStep() {
  if (!tutorialActive || tutorialStep >= TUTORIAL_STEPS.length) {
    tutorialActive = false;
    $("#tutorialOverlay")?.remove();
    return;
  }
  const step = TUTORIAL_STEPS[tutorialStep];

  let overlay = $("#tutorialOverlay");
  if (!overlay) {
    overlay = el("div");
    overlay.id = "tutorialOverlay";
    overlay.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.7);display:grid;place-items:center;padding:20px";
    document.body.appendChild(overlay);
  }

  overlay.innerHTML = "";
  const card = el("div");
  card.style.cssText = "background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:28px;max-width:400px;width:100%;text-align:center";
  card.appendChild(el("h3", null, step.title));
  card.appendChild(el("p", "muted", step.text));

  const dots = el("div");
  dots.style.cssText = "display:flex;gap:6px;justify-content:center;margin:16px 0";
  TUTORIAL_STEPS.forEach((_, i) => {
    const d = el("span");
    d.style.cssText = `width:8px;height:8px;border-radius:50%;background:${i === tutorialStep ? "var(--green)" : "var(--line2)"}`;
    dots.appendChild(d);
  });
  card.appendChild(dots);

  const actions = el("div");
  actions.style.cssText = "display:flex;gap:10px;justify-content:center";
  const skipBtn = el("button", "btn ghost sm", "Skip");
  skipBtn.onclick = () => { tutorialActive = false; overlay.remove(); };
  actions.appendChild(skipBtn);

  if (tutorialStep < TUTORIAL_STEPS.length - 1) {
    const nextBtn = el("button", "btn sm", "Next");
    nextBtn.onclick = () => { tutorialStep++; showTutorialStep(); };
    actions.appendChild(nextBtn);
  } else {
    const doneBtn = el("button", "btn sm", "Get Started!");
    doneBtn.onclick = () => { tutorialActive = false; overlay.remove(); };
    actions.appendChild(doneBtn);
  }
  card.appendChild(actions);
  overlay.appendChild(card);
}

// ==================== WIRE ====================
function wire() {
  // Auth forms
  $("#loginForm").onsubmit = doLogin;
  $("#signupForm").onsubmit = doSignup;
  $("#resetForm").onsubmit = doReset;
  $("#logoutBtn").onclick = logout;

  // Auth navigation
  $("#toSignup").onclick = showSignupForm;
  $("#toLogin").onclick = showLoginForm;
  $("#toReset").onclick = showResetForm;
  $("#toLogin2").onclick = showLoginForm;

  // Keyboard shortcuts
  addEventListener("keydown", e => {
    if (e.key === "Escape") {
      $$(".modal").forEach(m => { if (!m.hidden) closeModal(m); });
      if (tutorialActive) { tutorialActive = false; $("#tutorialOverlay")?.remove(); }
    }
  });

  // Persist on hide
  addEventListener("visibilitychange", () => { if (document.hidden) Store.commit(); });
  addEventListener("pagehide", () => Store.commit());
}

// ==================== START ====================
function start() {
  wire();
  boot();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
