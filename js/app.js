/* Habitat — App (UI layer) */
"use strict";

import { Store, uid, sha256, DB_KEY, SESSION_KEY } from "./store.js";
import { VERSION, BUILD, VERSION_LABEL } from "./version.js";
import { createMeshViewer } from "./mesh.js";

// ==================== STATE ====================
let ME = null;
let view = "dashboard";
let map = null;
let meshViewer = null;

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

function statusPill(status) {
  const labels = { open: "Open", requested: "Requested", assigned: "Assigned", in_progress: "In Progress", completed: "Completed", accepted: "Accepted" };
  return el("span", `pill ${status}`, labels[status] || status);
}

// ==================== BOOT ====================
function boot() {
  try {
    stampVersion();
    watchForUpdates();
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
  stampVersion();
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
  // Check if we have a token in the URL
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get("token");
  if (token) {
    $("#resetRequestFields").hidden = true;
    $("#resetTokenFields").hidden = false;
  } else {
    $("#resetRequestFields").hidden = false;
    $("#resetTokenFields").hidden = true;
  }
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
      username: f.username ? f.username.value : "",
    });
    Store.setSession(u.id);
    ME = u;
    showApp();
    startTutorial();
    // Show recovery code
    if (u.recoveryCode) {
      showRecoveryCode(u.recoveryCode);
    }
    // Start auto-export
    Store.startAutoExport();
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
    // Check if we have a token (from email link) or need to request one
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get("token");
    if (token) {
      await Store.resetPassword(token, f.next.value);
      showLoginForm();
      toast("Password reset successful. Log in with your new password.", "good");
      // Clean URL
      window.history.replaceState({}, document.title, window.location.pathname);
    } else {
      // Request reset email
      await Store.forgotPassword(f.email.value);
      showLoginForm();
      toast("If an account exists, a password reset email has been sent.", "good");
    }
  } catch (err) {
    authError(err.message || "Reset failed");
  }
}

function showRecoveryCode(code) {
  const body = el("div", "stack");
  body.style.gap = "12px";
  body.appendChild(el("h3", null, "Account Recovery Code"));
  body.appendChild(el("p", "muted", "Save this code in a safe place. If you ever lose access to your account, you can use it to recover it."));
  const codeDisplay = el("div");
  codeDisplay.style.cssText = "background:var(--bg2);border:2px solid var(--green);border-radius:12px;padding:16px;text-align:center;font-family:monospace;font-size:18px;font-weight:700;letter-spacing:2px;color:var(--green)";
  codeDisplay.textContent = code;
  body.appendChild(codeDisplay);
  const copyBtn = el("button", "btn sm", "Copy Code");
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(code).then(() => toast("Copied!", "good"));
  };
  body.appendChild(copyBtn);
  const actions = el("div", "modal-actions");
  const okBtn = el("button", "btn", "I've Saved It");
  actions.appendChild(okBtn);
  body.appendChild(actions);
  const m = modal("Recovery Code", body);
  okBtn.onclick = () => closeModal(m);
  openModal(m);
}

function logout() {
  Store.commit();
  Store.setSession(null);
  Store.stopAutoExport();
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
  // Universal tab structure for both roles
  const tabs = ["dashboard", "properties", "tasks", "people", "mesh", "map", "profile", "settings"];
  const labels = { dashboard: "Dashboard", properties: "Properties", tasks: "Tasks", people: "People", mesh: "3D Mesh", map: "Map", profile: "Profile", settings: "Settings" };
  tabs.forEach(v => {
    const b = el("button", "navbtn", labels[v]);
    b.dataset.view = v;
    b.onclick = () => go(v);
    nav.appendChild(b);
  });

  // Bottom nav
  const bn = $("#bottomNav");
  bn.innerHTML = "";
  const icons = { dashboard: "📊", properties: "🏠", tasks: "📋", people: "👷", mesh: "🧊", map: "🗺️", profile: "👤", settings: "⚙️" };
  const blabels = { dashboard: "Home", properties: "Properties", tasks: "Tasks", people: "People", mesh: "3D Mesh", map: "Map", profile: "Profile", settings: "Settings" };
  tabs.forEach(v => {
    const b = el("button", "bottom-nav-btn");
    b.dataset.view = v;
    b.innerHTML = `${icons[v]}<span>${blabels[v]}</span>`;
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
  else if (view === "properties") renderProperties();
  else if (view === "tasks") renderTasks();
  else if (view === "people") renderPeople();
  else if (view === "mesh") renderMesh();
  else if (view === "map") renderMap();
  else if (view === "profile") renderProfile();
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
  const overdue = tasks.filter(t => !["completed", "accepted"].includes(t.status) && t.dueDate && new Date(t.dueDate) < new Date(new Date().toDateString()));
  if (overdue.length) {
    const sec = el("div", "card");
    sec.appendChild(el("h3", null, "⚠️ Overdue"));
    overdue.slice(0, 5).forEach(t => sec.appendChild(taskCard(t)));
    wrap.appendChild(sec);
  }

  const doing = tasks.filter(t => t.status === "in_progress" || t.status === "assigned");
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
  head.appendChild(statusPill(t.status));
  card.appendChild(head);

  const meta = el("div", "muted sm");
  const bits = [prop ? prop.name : "", t.dueDate ? `Due: ${t.dueDate}` : "", t.price ? `$${t.price}` : ""].filter(Boolean);
  meta.textContent = bits.join(" · ");
  card.appendChild(meta);

  if (t.description) {
    card.appendChild(el("p", "muted", t.description.slice(0, 120) + (t.description.length > 120 ? "…" : "")));
  }

  const acts = el("div", "card-actions");
  // Owner actions
  if (ME.role === "owner") {
    if (t.status === "requested") {
      const req = Store.db.taskRequests.find(r => r.taskId === t.id && r.status === "pending");
      if (req) {
        const accBtn = el("button", "btn sm", "Accept");
        accBtn.onclick = () => { Store.respondToRequest(req.id, true); toast("Request accepted", "good"); render(); };
        acts.appendChild(accBtn);
        const decBtn = el("button", "btn sm ghost danger", "Decline");
        decBtn.onclick = () => { Store.respondToRequest(req.id, false); toast("Request declined", "info"); render(); };
        acts.appendChild(decBtn);
      }
    }
    if (t.status === "completed") {
      const accBtn = el("button", "btn sm", "Accept & Record");
      accBtn.onclick = () => { Store.acceptTask(t.id); toast("Task accepted and recorded", "good"); render(); };
      acts.appendChild(accBtn);
    }
    if (t.status === "open" || t.status === "requested") {
      const delBtn = el("button", "btn sm ghost danger", "Delete");
      delBtn.onclick = () => {
        if (confirm("Delete this task?")) { Store.deleteTask(t.id); render(); }
      };
      acts.appendChild(delBtn);
    }
  }
  // Worker actions
  if (ME.role === "worker") {
    if (t.status === "open") {
      const reqBtn = el("button", "btn sm", "Request");
      reqBtn.onclick = () => openRequestModal(t);
      acts.appendChild(reqBtn);
    }
    if (t.status === "assigned" && t.assigneeId === ME.id) {
      const startBtn = el("button", "btn sm", "Start");
      startBtn.onclick = () => { Store.setTaskStatus(t.id, "in_progress", ME.id); toast("Task started", "good"); render(); };
      acts.appendChild(startBtn);
    }
    if (t.status === "in_progress" && t.assigneeId === ME.id) {
      const doneBtn = el("button", "btn sm", "Complete");
      doneBtn.onclick = () => openCompleteModal(t);
      acts.appendChild(doneBtn);
    }
  }
  card.appendChild(acts);
  return card;
}

// ==================== PROPERTIES ====================
function renderProperties() {
  const wrap = $("#view-properties");
  wrap.innerHTML = "";

  const hd = el("div", "card");
  hd.style.display = "flex";
  hd.style.justifyContent = "space-between";
  hd.style.alignItems = "center";
  hd.appendChild(el("h2", null, "Properties"));
  if (ME.role === "owner") {
    const addBtn = el("button", "btn sm", "+ Add Property");
    addBtn.onclick = () => openPropertyModal();
    hd.appendChild(addBtn);
  }
  wrap.appendChild(hd);

  const props = Store.propertiesFor(ME);
  if (!props.length) {
    wrap.appendChild(emptyState("No properties yet", ME.role === "owner" ? "Add your first property to get started" : "No properties assigned to you yet", ME.role === "owner" ? "Add Property" : null, ME.role === "owner" ? () => openPropertyModal() : null));
    return;
  }

  const list = el("div", "grid");
  props.forEach(p => {
    const card = el("div", "card");
    card.appendChild(el("h3", null, p.name));
    if (p.address) card.appendChild(el("p", "muted sm", p.address));
    if (p.description) card.appendChild(el("p", "muted", p.description));
    if (p.details) {
      const d = p.details;
      const bits = [];
      if (d.rooms) bits.push(`${d.rooms} rooms`);
      if (d.yearBuilt) bits.push(`Built ${d.yearBuilt}`);
      if (d.squareFootage) bits.push(`${d.squareFootage.toLocaleString()} sqft`);
      if (bits.length) card.appendChild(el("p", "muted sm", bits.join(" · ")));
    }
    const tasks = Store.tasksFor(p.id);
    const openTasks = tasks.filter(t => !["completed", "accepted"].includes(t.status));
    if (openTasks.length) {
      card.appendChild(el("p", "muted sm", `${openTasks.length} open task${openTasks.length > 1 ? "s" : ""}`));
    }
    const acts = el("div", "card-actions");
    const viewBtn = el("button", "btn sm ghost", "View Details");
    viewBtn.onclick = () => openPropertyDetailModal(p);
    acts.appendChild(viewBtn);
    card.appendChild(acts);
    list.appendChild(card);
  });
  wrap.appendChild(list);
}

// ==================== TASKS (Owner) ====================
function renderTasks() {
  const wrap = $("#view-tasks");
  wrap.innerHTML = "";
  const props = Store.propertiesFor(ME);

  const hd = el("div", "card");
  hd.style.display = "flex";
  hd.style.justifyContent = "space-between";
  hd.style.alignItems = "center";
  hd.appendChild(el("h2", null, "Tasks"));
  if (props.length) {
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

// ==================== PEOPLE (Both roles) ====================
function renderPeople() {
  const wrap = $("#view-people");
  wrap.innerHTML = "";

  wrap.appendChild(el("h2", null, "People"));

  // Search bar
  const searchInput = el("input");
  searchInput.type = "search";
  searchInput.placeholder = "Search people...";
  searchInput.style.cssText = "background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;width:100%;margin-bottom:16px";
  wrap.appendChild(searchInput);

  // Recent conversations section
  const msgs = Store.getMessages(ME.id);
  if (msgs.length) {
    const convSec = el("div", "card");
    convSec.appendChild(el("h3", null, "Recent Conversations"));
    const conversations = new Map();
    msgs.forEach(m => {
      const partnerId = m.fromId === ME.id ? m.toId : m.fromId;
      if (!conversations.has(partnerId)) conversations.set(partnerId, []);
      conversations.get(partnerId).push(m);
    });
    const convList = el("div", "grid");
    conversations.forEach((msgs, partnerId) => {
      const partner = Store.user(partnerId);
      const card = el("div", "card");
      card.appendChild(el("h4", null, partner?.name || "Unknown"));
      const last = msgs[msgs.length - 1];
      card.appendChild(el("p", "muted sm", last.text.slice(0, 60)));
      card.appendChild(el("p", "muted sm", relTime(last.createdAt)));
      const acts = el("div", "card-actions");
      const viewBtn = el("button", "btn sm ghost", "View");
      viewBtn.onclick = () => openConversationModal(partnerId);
      acts.appendChild(viewBtn);
      card.appendChild(acts);
      convList.appendChild(card);
    });
    convSec.appendChild(convList);
    wrap.appendChild(convSec);
  }

  // Show users of the opposite role
  const allUsers = ME.role === "owner" ? Store.workers() : Store.db.users.filter(u => u.role === "owner" && u.active).map(u => Store.publicUser(u));

  const list = el("div", "grid");
  const filtered = allUsers.filter(u => {
    const q = searchInput.value.toLowerCase();
    if (!q) return true;
    return (u.name || "").toLowerCase().includes(q) || (u.username || "").toLowerCase().includes(q);
  });

  if (!filtered.length) {
    wrap.appendChild(emptyState("No users found", ME.role === "owner" ? "No workers registered yet" : "No owners registered yet"));
    return;
  }

  filtered.forEach(u => {
    const card = el("div", "card clickable-card");
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `View ${u.name}'s profile`);
    const openProfile = () => openPersonProfile(u.id);
    card.onclick = openProfile;
    card.onkeydown = (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openProfile(); }
    };

    const av = el("span", "avatar", initial(u.name));
    av.style.background = avatarColor(u.id);
    av.style.width = "40px";
    av.style.height = "40px";
    av.style.fontSize = "16px";
    card.appendChild(av);
    card.appendChild(el("h3", null, u.name));
    if (u.username) card.appendChild(el("p", "muted sm", `@${u.username}`));
    card.appendChild(el("p", "muted sm", u.role === "worker" ? "Trade Worker" : "Property Owner"));

    // Show profile info for workers
    if (u.role === "worker") {
      const profile = Store.getWorkerProfile(u.id);
      if (profile) {
        const bits = [];
        if (profile.trade) bits.push(profile.trade);
        if (profile.location) bits.push(profile.location);
        if (profile.rating) bits.push(`⭐ ${profile.rating}`);
        if (bits.length) card.appendChild(el("p", "muted sm", bits.join(" · ")));
        if (profile.bio) card.appendChild(el("p", "muted", profile.bio.slice(0, 100) + (profile.bio.length > 100 ? "…" : "")));
        if (profile.skills && profile.skills.length) {
          card.appendChild(el("p", "muted sm", `Skills: ${profile.skills.join(", ")}`));
        }
      }
      // how much work they have done — the reason to click through
      const stats = Store.jobStats(u.id);
      card.appendChild(el("p", "muted sm job-summary",
        stats.total ? `${stats.done} completed · ${stats.active} in progress` : "No jobs yet"));
    }

    // Show owner info
    if (u.role === "owner") {
      const props = Store.propertiesFor(u);
      card.appendChild(el("p", "muted sm", `${props.length} propert${props.length === 1 ? "y" : "ies"}`));
    }

    const acts = el("div", "card-actions");
    const unread = Store.unreadFrom(ME.id, u.id);
    if (unread) {
      const badge = el("span", "pill unread", String(unread));
      acts.appendChild(badge);
    }
    const msgBtn = el("button", "btn sm ghost", "💬 Message");
    msgBtn.onclick = (ev) => { ev.stopPropagation(); openConversationModal(u.id); };
    acts.appendChild(msgBtn);

    if (ME.role === "owner" && u.role === "worker") {
      const hireBtn = el("button", "btn sm", "Hire");
      hireBtn.onclick = (ev) => { ev.stopPropagation(); openHireModal(u); };
      acts.appendChild(hireBtn);
    }
    if (ME.role === "worker" && u.role === "owner") {
      const reqBtn = el("button", "btn sm", "Request Work");
      reqBtn.onclick = (ev) => { ev.stopPropagation(); openRequestWorkModal(u); };
      acts.appendChild(reqBtn);
    }

    card.appendChild(acts);
    list.appendChild(card);
  });
  wrap.appendChild(list);

  // Wire search
  searchInput.oninput = () => { renderPeople(); };
}

// ==================== PERSON PROFILE ====================
/**
 * A person's page: who they are, the jobs they have done, and a way to
 * message them. Reached by clicking a card in the People list.
 */
function openPersonProfile(userId) {
  const u = Store.user(userId);
  if (!u) return;

  const body = el("div", "stack");
  body.style.gap = "14px";

  // --- header
  const head = el("div", "person-head");
  const av = el("span", "avatar lg", initial(u.name));
  av.style.background = avatarColor(u.id);
  head.appendChild(av);
  const hi = el("div", "person-head-info");
  hi.appendChild(el("h3", null, u.name));
  if (u.username) hi.appendChild(el("p", "muted sm", `@${u.username}`));
  hi.appendChild(el("p", "muted sm", u.role === "worker" ? "Trade Worker" : "Property Owner"));
  const profile = Store.getWorkerProfile(u.id) || {};
  const metaBits = [];
  if (profile.trade) metaBits.push(profile.trade);
  if (u.location || profile.location) metaBits.push(u.location || profile.location);
  if (profile.serviceRadius) metaBits.push(`${profile.serviceRadius} km radius`);
  if (profile.rating) metaBits.push(`⭐ ${profile.rating}`);
  if (metaBits.length) hi.appendChild(el("p", "muted sm", metaBits.join(" · ")));
  if (u.phone) hi.appendChild(el("p", "muted sm", u.phone));
  head.appendChild(hi);
  body.appendChild(head);

  if (profile.bio) body.appendChild(el("p", "muted", profile.bio));
  if (profile.skills && profile.skills.length) {
    body.appendChild(el("p", "muted sm", `Skills: ${profile.skills.join(", ")}`));
  }

  // --- job history (workers)
  if (u.role === "worker") {
    const history = Store.jobHistoryFor(u.id);
    const stats = history.stats;

    const tiles = el("div", "stat-row");
    const tile = (label, value) => {
      const s = el("div", "stat");
      s.appendChild(el("b", null, String(value)));
      s.appendChild(el("span", null, label));
      return s;
    };
    tiles.appendChild(tile("Jobs", stats.total));
    tiles.appendChild(tile("Completed", stats.done));
    tiles.appendChild(tile("In progress", stats.active));
    tiles.appendChild(tile("Properties", Store.propertiesWorkedOn(u.id).length));
    body.appendChild(tiles);

    // types of work done
    body.appendChild(el("h4", null, "Types of work done"));
    if (!stats.trades.length) {
      body.appendChild(el("p", "muted sm", "No jobs recorded yet."));
    } else {
      const chips = el("div", "chips");
      stats.trades.forEach(({ trade, count }) => {
        chips.appendChild(el("span", "chip", `${tradeLabel(trade)} · ${count}`));
      });
      body.appendChild(chips);
    }

    // completed jobs
    body.appendChild(el("h4", null, "Completed jobs"));
    const records = Store.recordsForWorker(u.id);
    if (!history.done.length && !records.length) {
      body.appendChild(el("p", "muted sm", "No completed jobs yet."));
    } else {
      history.done.forEach(t => body.appendChild(jobRow(t)));
      // work the owner filed into the house record (cost, date, notes)
      records.forEach(r => {
        const row = el("div", "job-row");
        const main = el("div", "job-main");
        main.appendChild(el("b", null, r.title));
        const bits = [];
        const prop = Store.property(r.propertyId);
        if (prop) bits.push(prop.name);
        if (r.date) bits.push(new Date(r.date).toLocaleDateString());
        if (r.cost) bits.push(`$${r.cost}`);
        if (bits.length) main.appendChild(el("span", "muted sm", bits.join(" · ")));
        if (r.description) main.appendChild(el("span", "muted sm", r.description));
        row.appendChild(main);
        row.appendChild(el("span", "pill done", "On record"));
        body.appendChild(row);
      });
    }

    // work in flight
    if (history.active.length) {
      body.appendChild(el("h4", null, "Work in progress"));
      history.active.forEach(t => body.appendChild(jobRow(t)));
    }

    // crews this worker runs / belongs to
    const led = Store.crewsLedBy(u.id);
    const member = Store.crewsOf(u.id).filter(c => c.ownerId !== u.id);
    if (led.length || member.length) {
      body.appendChild(el("h4", null, "Crews"));
      const chips = el("div", "chips");
      led.forEach(c => chips.appendChild(el("span", "chip", `${c.name} (leads)`)));
      member.forEach(c => chips.appendChild(el("span", "chip", c.name)));
      body.appendChild(chips);
    }
  }

  // --- owner: properties and hires
  if (u.role === "owner") {
    const props = Store.propertiesFor(u);
    body.appendChild(el("h4", null, "Properties"));
    if (!props.length) body.appendChild(el("p", "muted sm", "No properties listed."));
    props.forEach(p => {
      const row = el("div", "job-row");
      const main = el("div", "job-main");
      main.appendChild(el("b", null, p.name));
      if (p.address) main.appendChild(el("span", "muted sm", p.address));
      row.appendChild(main);
      body.appendChild(row);
    });
  }

  // --- actions
  const actions = el("div", "modal-actions");
  const closeBtn = el("button", "btn ghost", "Close");
  actions.appendChild(closeBtn);

  if (Store.canMessage(ME.id, u.id)) {
    const msgBtn = el("button", "btn", "💬 Message");
    msgBtn.onclick = () => { closeModal(m); openConversationModal(u.id); };
    actions.appendChild(msgBtn);
  }
  if (ME.role === "owner" && u.role === "worker") {
    const hireBtn = el("button", "btn", "Hire");
    hireBtn.onclick = () => { closeModal(m); openHireModal(u); };
    actions.appendChild(hireBtn);
  }
  if (ME.role === "worker" && u.role === "owner") {
    const reqBtn = el("button", "btn", "Request Work");
    reqBtn.onclick = () => { closeModal(m); openRequestWorkModal(u); };
    actions.appendChild(reqBtn);
  }
  body.appendChild(actions);

  const m = modal(`${u.name}`, body);
  closeBtn.onclick = () => closeModal(m);
  openModal(m);
}

/** Human label for a task's category/priority bucket. */
function tradeLabel(key) {
  const map = {
    high: "High priority", normal: "General", low: "Minor",
    plumbing: "Plumbing", electrical: "Electrical", hvac: "HVAC",
    roofing: "Roofing", landscaping: "Landscaping", general: "General",
  };
  return map[key] || (key ? key.charAt(0).toUpperCase() + key.slice(1) : "General");
}

/** One job line inside a profile. */
function jobRow(t) {
  const row = el("div", "job-row");
  const main = el("div", "job-main");
  main.appendChild(el("b", null, t.title));
  const bits = [];
  const prop = Store.property(t.propertyId);
  if (prop) bits.push(prop.name);
  if (t.completedAt) bits.push(new Date(t.completedAt).toLocaleDateString());
  else if (t.dueDate) bits.push(`due ${t.dueDate}`);
  if (bits.length) main.appendChild(el("span", "muted sm", bits.join(" · ")));
  if (t.description) main.appendChild(el("span", "muted sm", t.description));
  row.appendChild(main);
  row.appendChild(statusPill(t.status));
  return row;
}

// ==================== 3D MESH (Both roles) ====================
function renderMesh() {
  const wrap = $("#view-mesh");
  if (meshViewer) return;                 // keep the WebGL context alive
  meshViewer = createMeshViewer(wrap, { me: ME });
}

// ==================== BUILD / VERSION ====================
/**
 * Stamp the running build into the header and the landing page, and offer a
 * reload as soon as a newer service worker takes over. This is how you tell
 * whether the site you are looking at is actually the new deploy.
 */
function stampVersion() {
  const badge = $("#buildBadge");
  if (badge) {
    badge.textContent = VERSION_LABEL;
    badge.title = `Habitat ${VERSION} (build ${BUILD}) — if this is not the version you deployed, reload the page`;
  }
  const landing = $("#landingVersion");
  if (landing) landing.textContent = VERSION_LABEL;
}

function watchForUpdates() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.ready.then((reg) => {
    // a worker is already waiting (a deploy landed while this tab was open)
    if (reg.waiting) showUpdateBanner();
    reg.addEventListener("updatefound", () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener("statechange", () => {
        if (sw.state === "installed" && navigator.serviceWorker.controller) showUpdateBanner();
      });
    });
  });
  // when the new worker takes control, reload once to pick up the new files
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

function showUpdateBanner() {
  const b = $("#updateBanner");
  if (!b || !b.hidden) return;
  b.hidden = false;
  const btn = $("#updateNow");
  if (btn) {
    btn.onclick = () => {
      navigator.serviceWorker.getRegistration().then((reg) => {
        if (reg && reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
        else window.location.reload();
      });
    };
  }
}

// ==================== MAP (Both roles) ====================
const SOLVANG_CA = { lat: 34.5958, lng: -120.1376 };

async function detectLocation() {
  // Try browser geolocation with high accuracy
  if (navigator.geolocation) {
    try {
      const pos = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 8000,
          maximumAge: 60000
        })
      );
      return { lat: pos.coords.latitude, lng: pos.coords.longitude };
    } catch { /* fall through to IP */ }
  }
  // Fallback: IP-based geolocation
  try {
    const res = await fetch("https://ipapi.co/json/");
    if (res.ok) {
      const data = await res.json();
      if (data.latitude && data.longitude) return { lat: data.latitude, lng: data.longitude };
    }
  } catch { /* fall through to default */ }
  // Default: Solvang, CA
  return SOLVANG_CA;
}

function renderMap() {
  const wrap = $("#view-map");
  wrap.innerHTML = "";

  wrap.appendChild(el("h2", null, "Map"));

  const mapDiv = el("div", "map");
  mapDiv.id = "mainMap";
  mapDiv.style.height = "400px";
  wrap.appendChild(mapDiv);

  // Initialize Leaflet map
  if (typeof L !== "undefined") {
    if (map) { map.remove(); map = null; }
    map = L.map("mainMap", { maxZoom: 19 }).setView([SOLVANG_CA.lat, SOLVANG_CA.lng], 16);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors",
      maxZoom: 19
    }).addTo(map);

    // Add markers for properties
    const props = Store.propertiesFor(ME);
    props.forEach(p => {
      if (p.lat != null && p.lng != null) {
        L.marker([p.lat, p.lng]).addTo(map)
          .bindPopup(`<b>${esc(p.name)}</b><br>${esc(p.address || "")}`);
      }
    });

    // Add markers for tasks
    const tasks = Store.tasksForUser(ME);
    tasks.forEach(t => {
      if (t.lat != null && t.lng != null) {
        const color = t.priority === "high" ? "red" : t.priority === "normal" ? "orange" : "green";
        L.circleMarker([t.lat, t.lng], {
          radius: 8,
          fillColor: color,
          color: color,
          fillOpacity: 0.7
        }).addTo(map).bindPopup(`<b>${esc(t.title)}</b><br>${esc(t.description || "")}`);
      }
    });

    // Try to center on user's location
    detectLocation().then(loc => {
      if (map && loc) {
        map.setView([loc.lat, loc.lng], 16);
        L.marker([loc.lat, loc.lng], {
          icon: L.divIcon({ className: "user-location-marker", html: "📍", iconSize: [24, 24] })
        }).addTo(map).bindPopup("You are here");
      }
    });
  } else {
    wrap.appendChild(el("p", "muted", "Map library not loaded. Please check your internet connection."));
  }
}

// ==================== PROFILE (Both roles) ====================
function renderProfile() {
  const wrap = $("#view-profile");
  wrap.innerHTML = "";

  wrap.appendChild(el("h2", null, "My Profile"));

  const card = el("div", "card");
  card.appendChild(el("h3", null, ME.role === "worker" ? "Worker Profile" : "Owner Profile"));

  // Show username (editable, so the save handler below can read it)
  const usernameField = el("label", "field");
  usernameField.appendChild(el("span", null, "Username"));
  const usernameInput = el("input");
  usernameInput.value = ME.username || "";
  usernameInput.placeholder = "Username";
  usernameInput.style.cssText = "background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;width:100%";
  usernameField.appendChild(usernameInput);
  card.appendChild(usernameField);

  // Common fields for both roles
  const bioInput = el("textarea");
  bioInput.value = (Store.getWorkerProfile(ME.id) || {}).bio || "";
  bioInput.rows = 3;
  bioInput.placeholder = ME.role === "worker" ? "Tell owners about yourself..." : "Tell workers about yourself...";
  bioInput.style.cssText = "background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;width:100%";
  const bioField = el("label", "field");
  bioField.appendChild(el("span", null, "Bio"));
  bioField.appendChild(bioInput);
  card.appendChild(bioField);

  const phoneInput = el("input");
  phoneInput.value = ME.phone || "";
  phoneInput.placeholder = "Phone number";
  phoneInput.style.cssText = "background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;width:100%";
  const phoneField = el("label", "field");
  phoneField.appendChild(el("span", null, "Phone"));
  phoneField.appendChild(phoneInput);
  card.appendChild(phoneField);

  const locInput = el("input");
  locInput.value = ME.location || "";
  locInput.placeholder = "City, State";
  locInput.style.cssText = "background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;width:100%";
  const locField = el("label", "field");
  locField.appendChild(el("span", null, "Location"));
  locField.appendChild(locInput);
  card.appendChild(locField);

  // Worker-specific fields
  if (ME.role === "worker") {
    const profile = Store.getWorkerProfile(ME.id) || {};

    const skillsInput = el("input");
    skillsInput.value = (profile.skills || []).join(", ");
    skillsInput.placeholder = "Plumbing, Electrical, ...";
    skillsInput.style.cssText = "background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;width:100%";
    const skillsField = el("label", "field");
    skillsField.appendChild(el("span", null, "Skills (comma separated)"));
    skillsField.appendChild(skillsInput);
    card.appendChild(skillsField);

    const tradeInput = el("input");
    tradeInput.value = profile.trade || "";
    tradeInput.placeholder = "Plumber, Electrician, ...";
    tradeInput.style.cssText = "background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;width:100%";
    const tradeField = el("label", "field");
    tradeField.appendChild(el("span", null, "Trade"));
    tradeField.appendChild(tradeInput);
    card.appendChild(tradeField);

    const radiusInput = el("input");
    radiusInput.type = "number";
    radiusInput.value = profile.serviceRadius || 25;
    radiusInput.min = 1;
    radiusInput.max = 200;
    radiusInput.style.cssText = "background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;width:100%";
    const radiusField = el("label", "field");
    radiusField.appendChild(el("span", null, "Service Radius (km)"));
    radiusField.appendChild(radiusInput);
    card.appendChild(radiusField);
  }

  // Worker-specific: crews — workers organise themselves into crews.
  // A homeowner never creates one; they hire individual workers instead.
  if (ME.role === "worker") {
    const crewSec = el("div", "card");
    const crewHead = el("div", "row-between");
    crewHead.appendChild(el("h4", null, "My Crews"));
    if (Store.canCreateCrew(ME)) {
      const newCrewBtn = el("button", "btn sm", "+ New Crew");
      newCrewBtn.onclick = () => openCrewModal();
      crewHead.appendChild(newCrewBtn);
    }
    crewSec.appendChild(crewHead);

    const led = Store.crewsLedBy(ME.id);
    const memberOf = Store.crewsOf(ME.id).filter(c => c.ownerId !== ME.id);

    if (!led.length && !memberOf.length) {
      crewSec.appendChild(el("p", "muted sm", "No crews yet. Create one to group workers."));
    }

    led.forEach(c => {
      const row = el("div", "card");
      row.style.padding = "10px";
      row.appendChild(el("b", null, c.name));
      const n = (c.memberIds || []).length;
      row.appendChild(el("p", "muted sm", `${n} member${n === 1 ? "" : "s"} · you lead this crew`));
      const acts = el("div", "card-actions");
      const memBtn = el("button", "btn sm ghost", "Members");
      memBtn.onclick = () => openCrewMembersModal(c.id);
      acts.appendChild(memBtn);
      const delBtn = el("button", "btn sm danger", "Delete");
      delBtn.onclick = () => {
        if (!confirm(`Delete crew "${c.name}"?`)) return;
        Store.deleteCrew(c.id);
        toast("Crew deleted", "info");
        render();
      };
      acts.appendChild(delBtn);
      row.appendChild(acts);
      crewSec.appendChild(row);
    });

    memberOf.forEach(c => {
      const row = el("div", "card");
      row.style.padding = "10px";
      row.appendChild(el("b", null, c.name));
      const lead = Store.user(c.ownerId);
      row.appendChild(el("p", "muted sm", `Member · led by ${lead?.name || "another worker"}`));
      crewSec.appendChild(row);
    });

    wrap.appendChild(crewSec);
  }

  // Owner-specific: show properties and hiring history
  if (ME.role === "owner") {
    const props = Store.propertiesFor(ME);
    if (props.length) {
      const propSec = el("div", "card");
      propSec.appendChild(el("h4", null, "My Properties"));
      props.forEach(p => {
        const row = el("div", "card");
        row.style.padding = "10px";
        row.appendChild(el("b", null, p.name));
        if (p.address) row.appendChild(el("p", "muted sm", p.address));
        const tasks = Store.tasksFor(p.id);
        const openTasks = tasks.filter(t => !["completed", "accepted"].includes(t.status));
        if (openTasks.length) {
          row.appendChild(el("p", "muted sm", `${openTasks.length} open task${openTasks.length > 1 ? "s" : ""}`));
        }
        propSec.appendChild(row);
      });
      wrap.appendChild(propSec);
    }

    // Hiring history
    const hires = Store.getHiresForOwner(ME.id);
    if (hires.length) {
      const hireSec = el("div", "card");
      hireSec.appendChild(el("h4", null, "Hiring History"));
      hires.forEach(h => {
        const worker = Store.user(h.workerId);
        const prop = Store.property(h.propertyId);
        const row = el("div", "card");
        row.style.padding = "10px";
        row.appendChild(el("b", null, worker?.name || "Unknown"));
        row.appendChild(el("p", "muted sm", `${prop?.name || "Unknown"} · ${h.status}`));
        hireSec.appendChild(row);
      });
      wrap.appendChild(hireSec);
    }

    // Completed tasks
    const tasks = Store.tasksForUser(ME);
    const completed = tasks.filter(t => t.status === "accepted" || t.status === "completed");
    if (completed.length) {
      const compSec = el("div", "card");
      compSec.appendChild(el("h4", null, "Completed Tasks"));
      completed.slice(0, 5).forEach(t => {
        const row = el("div", "card");
        row.style.padding = "10px";
        row.appendChild(el("b", null, t.title));
        row.appendChild(el("p", "muted sm", t.status));
        compSec.appendChild(row);
      });
      wrap.appendChild(compSec);
    }
  }

  const saveBtn = el("button", "btn sm", "Save Profile");
  saveBtn.onclick = () => {
    // Update user fields
    const u = Store.idx.users.get(ME.id);
    if (u) {
      u.phone = phoneInput.value;
      u.location = locInput.value;
      const newUsername = usernameInput.value.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
      if (newUsername) u.username = newUsername;
      Store.save();
      ME = Store.user(ME.id);
    }
    // Update worker profile if worker
    if (ME.role === "worker") {
      const profile = Store.getWorkerProfile(ME.id) || {};
      Store.updateWorkerProfile(ME.id, {
        bio: bioInput.value,
        skills: (document.querySelector("input[placeholder='Plumbing, Electrical, ...']")?.value || "").split(",").map(s => s.trim()).filter(Boolean),
        trade: document.querySelector("input[placeholder='Plumber, Electrician, ...']")?.value || "",
        location: locInput.value,
        serviceRadius: parseInt(document.querySelector("input[type='number']")?.value) || 25,
      });
    }
    toast("Profile updated", "good");
  };
  card.appendChild(saveBtn);
  wrap.appendChild(card);
}

// ==================== SETTINGS (Owner) ====================
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
  const importBtn = el("button", "btn ghost sm", "Import Data");
  const importInput = el("input");
  importInput.type = "file";
  importInput.accept = ".json,application/json";
  importInput.style.display = "none";
  importInput.onchange = () => {
    const file = importInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(reader.result);
        if (imported && typeof imported === "object") {
          Store.db = imported;
          Store.reindex();
          Store.save();
          toast("Data imported successfully", "good");
          render();
        } else {
          toast("Invalid data file", "bad");
        }
      } catch {
        toast("Could not parse file", "bad");
      }
    };
    reader.readAsText(file);
  };
  importBtn.onclick = () => importInput.click();
  data.appendChild(importBtn);
  data.appendChild(importInput);
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

  // Last saved timestamp
  const lastSaved = localStorage.getItem("habitat.lastSaved");
  if (lastSaved) {
    const savedDate = new Date(lastSaved);
    wrap.appendChild(el("p", "muted sm", `Last saved: ${savedDate.toLocaleString()}`));
  }
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

  // Photo (optional)
  const photoField = el("label", "field");
  photoField.appendChild(el("span", null, "Photo (optional)"));
  const photoInput = el("input");
  photoInput.type = "file";
  photoInput.accept = "image/*";
  photoInput.style.cssText = "background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;width:100%";
  photoField.appendChild(photoInput);

  // Camera capture button
  const camBtn = el("button", "btn ghost sm", "📷 Take Photo");
  camBtn.onclick = () => openCameraModal((dataUrl) => {
    // Store the captured photo data URL in a hidden field
    photoInput.dataset.captured = dataUrl;
    // Show preview
    const preview = photoField.querySelector(".photo-preview");
    if (preview) preview.remove();
    const img = el("img", "photo-preview");
    img.src = dataUrl;
    img.style.cssText = "max-width:100%;max-height:150px;border-radius:8px;margin-top:8px";
    photoField.appendChild(img);
  });
  photoField.appendChild(camBtn);

  // Photo placeholder
  const placeholder = el("div", "photo-placeholder");
  placeholder.style.cssText = "border:2px dashed var(--line);border-radius:10px;padding:20px;text-align:center;color:var(--dim);font-size:13px;margin-top:8px";
  placeholder.textContent = "📷 No photo attached";
  photoField.appendChild(placeholder);

  // Show preview when file selected
  photoInput.onchange = () => {
    if (photoInput.files.length) {
      placeholder.style.display = "none";
      const reader = new FileReader();
      reader.onload = () => {
        const preview = photoField.querySelector(".photo-preview");
        if (preview) preview.remove();
        const img = el("img", "photo-preview");
        img.src = reader.result;
        img.style.cssText = "max-width:100%;max-height:150px;border-radius:8px;margin-top:8px";
        photoField.appendChild(img);
      };
      reader.readAsDataURL(photoInput.files[0]);
    } else {
      placeholder.style.display = "";
    }
  };

  body.appendChild(photoField);

  // Location map
  const mapField = el("label", "field");
  mapField.appendChild(el("span", null, "Location (click map to set)"));
  const mapDiv = el("div");
  mapDiv.id = "taskMap";
  mapDiv.style.cssText = "height:200px;border-radius:10px;border:1px solid var(--line);overflow:hidden";
  mapField.appendChild(mapDiv);

  // Location display
  const locDisplay = el("p", "muted sm", "No location set");
  mapField.appendChild(locDisplay);

  // Use my location button
  const locBtn = el("button", "btn ghost sm", "📍 Use My Location");
  locBtn.onclick = () => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        pos => {
          lat = pos.coords.latitude;
          lng = pos.coords.longitude;
          locDisplay.textContent = `Location: ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
          if (typeof L !== "undefined" && taskMap) {
            taskMap.setView([lat, lng], 15);
            if (taskMarker) taskMarker.setLatLng([lat, lng]);
            else taskMarker = L.marker([lat, lng], { draggable: true }).addTo(taskMap);
          }
          toast("Location captured", "good");
        },
        () => toast("Location denied", "bad")
      );
    }
  };
  mapField.appendChild(locBtn);
  body.appendChild(mapField);

  // Initialize map after modal is open
  let taskMap = null;
  let taskMarker = null;

  // Actions
  const actions = el("div", "modal-actions");
  const cancelBtn = el("button", "btn ghost", "Cancel");
  const saveBtn = el("button", "btn", task ? "Save" : "Create Task");
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  body.appendChild(actions);

  const m = modal(task ? "Edit Task" : "New Task", body);
  cancelBtn.onclick = () => closeModal(m);

  // Initialize map after modal opens
  setTimeout(() => {
    if (typeof L !== "undefined") {
      taskMap = L.map("taskMap", { maxZoom: 19 }).setView([SOLVANG_CA.lat, SOLVANG_CA.lng], 16);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap contributors",
        maxZoom: 19
      }).addTo(taskMap);

      // Click to place marker
      taskMap.on("click", (e) => {
        lat = e.latlng.lat;
        lng = e.latlng.lng;
        locDisplay.textContent = `Location: ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
        if (taskMarker) {
          taskMarker.setLatLng([lat, lng]);
        } else {
          taskMarker = L.marker([lat, lng], { draggable: true }).addTo(taskMap);
        }
      });

      // If editing, set existing location
      if (task && task.lat != null && task.lng != null) {
        lat = task.lat;
        lng = task.lng;
        taskMap.setView([lat, lng], 15);
        taskMarker = L.marker([lat, lng], { draggable: true }).addTo(taskMap);
        locDisplay.textContent = `Location: ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
      }
    }
  }, 100);

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
      // Handle photo - check for captured photo first, then file input
      const capturedDataUrl = photoInput.dataset.captured;
      const file = photoInput.files[0];

      const createTask = (photoDataUrl) => {
        let photoId = null;
        if (photoDataUrl) {
          const photo = Store.addPhoto({ propertyId: propSel.value, uploaderId: ME.id, dataUrl: photoDataUrl, kind: "issue" });
          photoId = photo.id;
        }
        Store.addTask({ ...data, createdBy: ME.id, photoId });
        closeModal(m);
        toast("Task created", "good");
        render();
      };

      if (capturedDataUrl) {
        // Compress and use captured photo
        compressImage(capturedDataUrl, (compressed) => createTask(compressed));
      } else if (file) {
        const reader = new FileReader();
        reader.onload = () => {
          compressImage(reader.result, (compressed) => createTask(compressed));
        };
        reader.readAsDataURL(file);
      } else {
        // No photo - create task without photo
        createTask(null);
      }
    }
    closeModal(m);
    render();
  };
  openModal(m);
}

// Compress image to reduce storage
function compressImage(dataUrl, callback) {
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const maxWidth = 800;
    const maxHeight = 600;
    let w = img.width;
    let h = img.height;
    if (w > maxWidth) { h = (h * maxWidth) / w; w = maxWidth; }
    if (h > maxHeight) { w = (w * maxHeight) / h; h = maxHeight; }
    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(img, 0, 0, w, h);
    const compressed = canvas.toDataURL("image/jpeg", 0.7);
    callback(compressed);
  };
  img.onerror = () => callback(dataUrl);
  img.src = dataUrl;
}

// Camera capture modal
function openCameraModal(onCapture) {
  const body = el("div", "stack");
  body.style.gap = "12px";

  const video = el("video");
  video.style.cssText = "width:100%;border-radius:10px;background:#000";
  video.autoplay = true;
  video.playsInline = true;
  body.appendChild(video);

  const previewImg = el("img");
  previewImg.style.cssText = "width:100%;border-radius:10px;display:none";
  body.appendChild(previewImg);

  const actions = el("div", "modal-actions");
  const cancelBtn = el("button", "btn ghost", "Cancel");
  const captureBtn = el("button", "btn", "📷 Capture");
  const retakeBtn = el("button", "btn ghost", "Retake");
  retakeBtn.style.display = "none";
  const useBtn = el("button", "btn", "Use Photo");
  useBtn.style.display = "none";
  actions.appendChild(cancelBtn);
  actions.appendChild(captureBtn);
  actions.appendChild(retakeBtn);
  actions.appendChild(useBtn);
  body.appendChild(actions);

  const m = modal("Take Photo", body);
  cancelBtn.onclick = () => {
    if (stream) stream.getTracks().forEach(t => t.stop());
    closeModal(m);
  };

  let stream = null;
  let capturedDataUrl = null;

  // Start camera
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
      .then(s => {
        stream = s;
        video.srcObject = s;
      })
      .catch(() => {
        toast("Camera access denied or not available", "bad");
        closeModal(m);
      });
  } else {
    toast("Camera not supported on this device", "bad");
    closeModal(m);
  }

  captureBtn.onclick = () => {
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    capturedDataUrl = canvas.toDataURL("image/jpeg", 0.8);
    previewImg.src = capturedDataUrl;
    previewImg.style.display = "";
    video.style.display = "none";
    captureBtn.style.display = "none";
    retakeBtn.style.display = "";
    useBtn.style.display = "";
    if (stream) stream.getTracks().forEach(t => t.stop());
  };

  retakeBtn.onclick = () => {
    previewImg.style.display = "none";
    video.style.display = "";
    captureBtn.style.display = "";
    retakeBtn.style.display = "none";
    useBtn.style.display = "none";
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
        .then(s => {
          stream = s;
          video.srcObject = s;
        });
    }
  };

  useBtn.onclick = () => {
    if (capturedDataUrl) {
      onCapture(capturedDataUrl);
    }
    closeModal(m);
  };

  openModal(m);
}

// Worker requests work from an owner
function openRequestWorkModal(owner) {
  const props = Store.propertiesFor(owner);
  if (!props.length) { toast("This owner has no properties yet", "bad"); return; }

  const body = el("div", "stack");
  body.style.gap = "12px";

  body.appendChild(el("p", null, `Request to work for ${owner.name}`));

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

  const msgInput = el("textarea");
  msgInput.placeholder = "Message to owner...";
  msgInput.rows = 3;
  msgInput.style.cssText = "background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;width:100%";
  const msgField = el("label", "field");
  msgField.appendChild(el("span", null, "Message"));
  msgField.appendChild(msgInput);
  body.appendChild(msgField);

  const actions = el("div", "modal-actions");
  const cancelBtn = el("button", "btn ghost", "Cancel");
  const sendBtn = el("button", "btn", "Send Request");
  actions.appendChild(cancelBtn);
  actions.appendChild(sendBtn);
  body.appendChild(actions);

  const m = modal("Request Work", body);
  cancelBtn.onclick = () => closeModal(m);
  sendBtn.onclick = () => {
    try {
      // Create a task request from worker to owner
      const taskId = uid();
      Store.addTask({
        propertyId: propSel.value,
        createdBy: ME.id,
        title: `Work request from ${ME.name}`,
        description: msgInput.value,
        priority: "normal",
        status: "open",
        assigneeId: ME.id,
      });
      // Send message to owner
      Store.sendMessage(ME.id, owner.id, `I'd like to work on your property: ${props.find(p => p.id === propSel.value)?.name}. Message: ${msgInput.value}`);
      closeModal(m);
      toast("Work request sent", "good");
      render();
    } catch (e) {
      toast(e.message, "bad");
    }
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

  const descInput = el("textarea");
  descInput.placeholder = "Description";
  descInput.rows = 2;
  descInput.style.cssText = "background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;width:100%";
  const descField = el("label", "field");
  descField.appendChild(el("span", null, "Description"));
  descField.appendChild(descInput);
  body.appendChild(descField);

  // Details
  const roomsInput = el("input");
  roomsInput.type = "number";
  roomsInput.placeholder = "Rooms";
  roomsInput.style.cssText = "background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;width:100%";
  const roomsField = el("label", "field");
  roomsField.appendChild(el("span", null, "Rooms"));
  roomsField.appendChild(roomsInput);
  body.appendChild(roomsField);

  const yearInput = el("input");
  yearInput.type = "number";
  yearInput.placeholder = "Year Built";
  yearInput.style.cssText = "background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;width:100%";
  const yearField = el("label", "field");
  yearField.appendChild(el("span", null, "Year Built"));
  yearField.appendChild(yearInput);
  body.appendChild(yearField);

  const sqftInput = el("input");
  sqftInput.type = "number";
  sqftInput.placeholder = "Square Footage";
  sqftInput.style.cssText = "background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;width:100%";
  const sqftField = el("label", "field");
  sqftField.appendChild(el("span", null, "Square Footage"));
  sqftField.appendChild(sqftInput);
  body.appendChild(sqftField);

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
    Store.addProperty({
      ownerId: ME.id,
      name: nameInput.value,
      address: addrInput.value,
      description: descInput.value,
      details: { rooms: parseInt(roomsInput.value) || null, yearBuilt: parseInt(yearInput.value) || null, squareFootage: parseInt(sqftInput.value) || null },
      lat, lng,
    });
    closeModal(m);
    toast("Property added", "good");
    render();
  };
  openModal(m);
}

function openPropertyDetailModal(p) {
  const body = el("div", "stack");
  body.style.gap = "12px";

  body.appendChild(el("h3", null, p.name));
  if (p.address) body.appendChild(el("p", "muted", p.address));
  if (p.description) body.appendChild(el("p", null, p.description));
  if (p.details) {
    const d = p.details;
    const bits = [];
    if (d.rooms) bits.push(`${d.rooms} rooms`);
    if (d.yearBuilt) bits.push(`Built ${d.yearBuilt}`);
    if (d.squareFootage) bits.push(`${d.squareFootage.toLocaleString()} sqft`);
    if (bits.length) body.appendChild(el("p", "muted", bits.join(" · ")));
  }

  // Tasks
  const tasks = Store.tasksFor(p.id);
  if (tasks.length) {
    body.appendChild(el("h4", null, "Tasks"));
    tasks.forEach(t => {
      const row = el("div", "card");
      row.style.padding = "10px";
      row.appendChild(el("b", null, t.title));
      row.appendChild(el("p", "muted sm", `${t.status} · ${t.priority}`));
      body.appendChild(row);
    });
  }

  // House records
  const records = Store.getHouseRecords(p.id);
  if (records.length) {
    body.appendChild(el("h4", null, "House Records"));
    records.forEach(r => {
      const row = el("div", "card");
      row.style.padding = "10px";
      row.appendChild(el("b", null, r.title));
      row.appendChild(el("p", "muted sm", `${r.category} · $${r.cost || 0}`));
      body.appendChild(row);
    });
  }

  const actions = el("div", "modal-actions");
  const closeBtn = el("button", "btn ghost", "Close");
  actions.appendChild(closeBtn);
  body.appendChild(actions);

  const m = modal("Property Details", body);
  closeBtn.onclick = () => closeModal(m);
  openModal(m);
}

function openRequestModal(task) {
  const body = el("div", "stack");
  body.style.gap = "12px";

  body.appendChild(el("p", null, `Request to work on: ${task.title}`));

  const msgInput = el("textarea");
  msgInput.placeholder = "Message to owner...";
  msgInput.rows = 3;
  msgInput.style.cssText = "background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;width:100%";
  const msgField = el("label", "field");
  msgField.appendChild(el("span", null, "Message"));
  msgField.appendChild(msgInput);
  body.appendChild(msgField);

  const priceInput = el("input");
  priceInput.type = "number";
  priceInput.placeholder = "Your price ($)";
  priceInput.style.cssText = "background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;width:100%";
  const priceField = el("label", "field");
  priceField.appendChild(el("span", null, "Price"));
  priceField.appendChild(priceInput);
  body.appendChild(priceField);

  const actions = el("div", "modal-actions");
  const cancelBtn = el("button", "btn ghost", "Cancel");
  const sendBtn = el("button", "btn", "Send Request");
  actions.appendChild(cancelBtn);
  actions.appendChild(sendBtn);
  body.appendChild(actions);

  const m = modal("Request Task", body);
  cancelBtn.onclick = () => closeModal(m);
  sendBtn.onclick = () => {
    try {
      Store.requestTask(task.id, ME.id, msgInput.value, parseFloat(priceInput.value) || null);
      closeModal(m);
      toast("Request sent", "good");
      render();
    } catch (e) {
      toast(e.message, "bad");
    }
  };
  openModal(m);
}

function openCompleteModal(task) {
  const body = el("div", "stack");
  body.style.gap = "12px";

  body.appendChild(el("p", null, `Complete task: ${task.title}`));

  const photoInput = el("input");
  photoInput.type = "file";
  photoInput.accept = "image/*";
  photoInput.setAttribute("capture", "environment");
  photoInput.required = true;
  const photoField = el("label", "field");
  photoField.appendChild(el("span", null, "Completion Photo (required)"));
  photoField.appendChild(photoInput);
  body.appendChild(photoField);

  const actions = el("div", "modal-actions");
  const cancelBtn = el("button", "btn ghost", "Cancel");
  const doneBtn = el("button", "btn", "Mark Complete");
  actions.appendChild(cancelBtn);
  actions.appendChild(doneBtn);
  body.appendChild(actions);

  const m = modal("Complete Task", body);
  cancelBtn.onclick = () => closeModal(m);
  doneBtn.onclick = () => {
    if (!photoInput.files.length) { toast("Please attach a completion photo", "bad"); return; }
    const file = photoInput.files[0];
    const reader = new FileReader();
    reader.onload = () => {
      const photo = Store.addPhoto({ propertyId: task.propertyId, taskId: task.id, uploaderId: ME.id, dataUrl: reader.result, kind: "completion" });
      Store.setTaskStatus(task.id, "completed", ME.id);
      Store.updateTask(task.id, { completionPhotoId: photo.id });
      closeModal(m);
      toast("Task completed!", "good");
      render();
    };
    reader.readAsDataURL(file);
  };
  openModal(m);
}

function openHireModal(worker) {
  const props = Store.propertiesFor(ME);
  if (!props.length) { toast("Add a property first", "bad"); return; }

  const body = el("div", "stack");
  body.style.gap = "12px";

  body.appendChild(el("p", null, `Hire ${worker.name}`));

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

  const actions = el("div", "modal-actions");
  const cancelBtn = el("button", "btn ghost", "Cancel");
  const hireBtn = el("button", "btn", "Hire");
  actions.appendChild(cancelBtn);
  actions.appendChild(hireBtn);
  body.appendChild(actions);

  const m = modal("Hire Worker", body);
  cancelBtn.onclick = () => closeModal(m);
  hireBtn.onclick = () => {
    try {
      Store.hireWorker(ME.id, worker.id, propSel.value);
      closeModal(m);
      toast("Worker hired", "good");
      render();
    } catch (e) {
      toast(e.message, "bad");
    }
  };
  openModal(m);
}

function openConversationModal(partnerId) {
  const partner = Store.user(partnerId);
  if (!partner) return;
  // Privacy: owners and workers may message each other, but a worker can only
  // open a thread with an owner who contacted them first.
  if (!Store.canMessage(ME.id, partnerId)) {
    toast("You cannot message this person yet.", "bad");
    return;
  }
  const msgs = Store.getConversation(ME.id, partnerId);

  const body = el("div", "stack");
  body.style.gap = "12px";

  body.appendChild(el("h3", null, `Conversation with ${partner?.name || "Unknown"}`));

  const msgList = el("div");
  msgList.style.cssText = "max-height:300px;overflow-y:auto;display:grid;gap:8px";
  msgs.forEach(m => {
    const row = el("div");
    row.style.cssText = `padding:8px 12px;border-radius:10px;max-width:80%;${m.fromId === ME.id ? "background:var(--panel3);justify-self:end;" : "background:var(--bg2);"}`;
    row.appendChild(el("p", null, m.text));
    row.appendChild(el("p", "muted sm", relTime(m.createdAt)));
    msgList.appendChild(row);
    if (!m.read && m.toId === ME.id) Store.markMessageRead(m.id);
  });
  body.appendChild(msgList);

  const input = el("input");
  input.placeholder = "Type a message...";
  input.style.cssText = "background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;width:100%";
  body.appendChild(input);

  const actions = el("div", "modal-actions");
  const closeBtn = el("button", "btn ghost", "Close");
  const sendBtn = el("button", "btn", "Send");
  actions.appendChild(closeBtn);
  actions.appendChild(sendBtn);
  body.appendChild(actions);

  const m = modal("Messages", body);
  closeBtn.onclick = () => closeModal(m);
  sendBtn.onclick = () => {
    if (!input.value.trim()) return;
    Store.sendMessage(ME.id, partnerId, input.value);
    input.value = "";
    // Refresh
    closeModal(m);
    openConversationModal(partnerId);
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") sendBtn.click();
  };
  openModal(m);
}

// ==================== CREWS ====================
/** Create a crew. Only workers may do this. */
function openCrewModal() {
  if (!Store.canCreateCrew(ME)) {
    toast("Only trade workers can create crews. As a property owner you hire individual workers instead.", "bad");
    return;
  }

  const body = el("div", "stack");

  const nameInput = el("input");
  nameInput.placeholder = "Crew name";
  nameInput.style.cssText = "background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;width:100%";
  const nameField = el("label", "field");
  nameField.appendChild(el("span", null, "Crew Name"));
  nameField.appendChild(nameInput);
  body.appendChild(nameField);

  const descInput = el("input");
  descInput.placeholder = "What does this crew do?";
  descInput.style.cssText = nameInput.style.cssText;
  const descField = el("label", "field");
  descField.appendChild(el("span", null, "Description (optional)"));
  descField.appendChild(descInput);
  body.appendChild(descField);

  // Pick members from the other workers
  body.appendChild(el("h4", null, "Members"));
  const list = el("div", "stack");
  const checks = new Map();
  const others = Store.workers().filter(w => w.id !== ME.id);
  if (!others.length) {
    list.appendChild(el("p", "muted sm", "No other workers registered yet."));
  }
  others.forEach(w => {
    const row = el("label", "assign-row");
    const cb = el("input");
    cb.type = "checkbox";
    checks.set(w.id, cb);
    row.appendChild(cb);
    const av = el("span", "avatar", initial(w.name));
    av.style.background = avatarColor(w.id);
    av.style.width = "28px"; av.style.height = "28px"; av.style.fontSize = "12px";
    row.appendChild(av);
    row.appendChild(el("span", null, `${w.name}${w.username ? " · @" + w.username : ""}`));
    list.appendChild(row);
  });
  body.appendChild(list);

  const actions = el("div", "modal-actions");
  const cancelBtn = el("button", "btn ghost", "Cancel");
  const createBtn = el("button", "btn", "Create Crew");
  actions.appendChild(cancelBtn);
  actions.appendChild(createBtn);
  body.appendChild(actions);

  const m = modal("New Crew", body);
  cancelBtn.onclick = () => closeModal(m);
  createBtn.onclick = () => {
    const name = nameInput.value.trim();
    if (!name) return toast("Please enter a crew name", "bad");
    const ids = [ME.id];
    checks.forEach((cb, id) => { if (cb.checked) ids.push(id); });
    Store.createCrew(ME.id, name, ids);
    if (descInput.value.trim()) {
      const crews = Store.crewsLedBy(ME.id);
      const last = crews[crews.length - 1];
      if (last) Store.updateCrew(last.id, { description: descInput.value.trim() });
    }
    closeModal(m);
    toast("Crew created", "good");
    render();
  };
  openModal(m);
}

/** Add or remove members of a crew the worker leads. */
function openCrewMembersModal(crewId) {
  const crew = Store.idx.crews.get(crewId);
  if (!crew) return;
  if (crew.ownerId !== ME.id) {
    toast("Only the crew's leader can change its members.", "bad");
    return;
  }

  const body = el("div", "stack");
  const list = el("div", "stack");
  const checks = new Map();
  const workers = Store.workers();
  if (!workers.length) list.appendChild(el("p", "muted sm", "No workers registered yet."));

  workers.forEach(w => {
    const row = el("label", "assign-row");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = (crew.memberIds || []).includes(w.id);
    cb.disabled = w.id === ME.id;      // the leader always stays
    checks.set(w.id, cb);
    row.appendChild(cb);
    const av = el("span", "avatar", initial(w.name));
    av.style.background = avatarColor(w.id);
    av.style.width = "28px"; av.style.height = "28px"; av.style.fontSize = "12px";
    row.appendChild(av);
    row.appendChild(el("span", null, `${w.name}${w.id === ME.id ? " (you — leader)" : ""}`));
    list.appendChild(row);
  });
  body.appendChild(list);

  const actions = el("div", "modal-actions");
  const cancelBtn = el("button", "btn ghost", "Cancel");
  const saveBtn = el("button", "btn", "Save");
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  body.appendChild(actions);

  const m = modal("Crew Members", body);
  cancelBtn.onclick = () => closeModal(m);
  saveBtn.onclick = () => {
    const ids = [ME.id];
    checks.forEach((cb, id) => { if (cb.checked && id !== ME.id) ids.push(id); });
    Store.updateCrew(crewId, { memberIds: [...new Set(ids)] });
    closeModal(m);
    toast("Crew updated", "good");
    render();
  };
  openModal(m);
}

// ==================== TUTORIAL ====================
const TUTORIAL_STEPS = [
  { title: "Welcome to Habitat! 🌿", text: "Let's take a quick tour. This will only take a minute." },
  { title: "Dashboard", text: "This is your home. See all your tasks, properties, and progress at a glance." },
  { title: "Properties", text: "Manage your properties. Add details, photos, and view task history." },
  { title: "Tasks", text: "Create tasks with photos and locations. Workers can request to work on them." },
  { title: "People", text: "Find workers or owners. Message them, hire them, or request work." },
  { title: "Map", text: "See all your properties and tasks on an interactive map." },
  { title: "Profile", text: "Update your bio, skills, and contact information." },
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

  // Auto-save every 30 seconds
  setInterval(() => {
    if (ME) {
      Store.commit();
      localStorage.setItem("habitat.lastSaved", new Date().toISOString());
    }
  }, 30000);
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
