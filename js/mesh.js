/* Habitat — 3D property reconstruction.
 *
 * Builds a walkable 3D model of a property. Two inputs, one model:
 *
 *   1. Camera scan — monocular visual odometry. Features are tracked between
 *      frames; the median feature displacement gives camera translation and
 *      the divergence of the flow field gives depth, so points land in world
 *      space instead of on a fixed plane. This is the same idea as the
 *      photogrammetry rigs people strap to a headset: walk the room, sweep the
 *      camera slowly, and the room accumulates.
 *
 *   2. Room dimensions — type width x depth x height per room and the model
 *      builds real walls. This is the accurate path, and it is what makes a VR
 *      walkthrough actually work: you can only walk through geometry that
 *      exists.
 *
 * Walkthrough mode drops you inside the model at eye height with movement and
 * look controls (keyboard, drag, or the on-screen thumbstick on a phone).
 * VR mode hands the same scene to a WebXR headset via Three.js.
 *
 * Marker pins attach to the model so you can record what things are and what
 * they do (light switches, shutoffs, fixtures).
 */
"use strict";

import { Store } from "./store.js";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

/* ------------------------------------------------------------- constants */
export const EYE_HEIGHT = 1.62;      // metres, average standing eye level
export const WALL_THICKNESS = 0.12;

const MAX_POINTS = 120000;
const FRAME_INTERVAL = 110;
const PROC_WIDTH = 160;
const PROC_HEIGHT = 120;
const FEATURE_CELL = 8;
const MATCH_RADIUS = 6;
const MIN_MATCHES = 8;
const CALIBRATED_FOV = 60;

/* Marker kinds: what you would actually want to record in a house. */
export const MARKER_KINDS = [
  { id: "light_switch", label: "Light switch", icon: "\u{1F4A1}", colour: "#fbbf24" },
  { id: "outlet", label: "Power outlet", icon: "\u{1F50C}", colour: "#67e8f9" },
  { id: "breaker", label: "Breaker / panel", icon: "\u26A1", colour: "#f87171" },
  { id: "water_shutoff", label: "Water shutoff", icon: "\u{1F6B0}", colour: "#38bdf8" },
  { id: "gas_valve", label: "Gas valve", icon: "\u{1F525}", colour: "#fb923c" },
  { id: "thermostat", label: "Thermostat", icon: "\u{1F321}\uFE0F", colour: "#a78bfa" },
  { id: "vent", label: "Vent / duct", icon: "\u{1F300}", colour: "#94a3b8" },
  { id: "appliance", label: "Appliance", icon: "\u{1F9FA}", colour: "#34d399" },
  { id: "fixture", label: "Light fixture", icon: "\u{1F506}", colour: "#fde047" },
  { id: "door", label: "Door", icon: "\u{1F6AA}", colour: "#c4b5fd" },
  { id: "window", label: "Window", icon: "\u{1FA9F}", colour: "#7dd3fc" },
  { id: "damage", label: "Damage / issue", icon: "\u26A0\uFE0F", colour: "#ef4444" },
  { id: "note", label: "Note", icon: "\u{1F4CC}", colour: "#8fa89a" },
];

export function markerKind(id) {
  return MARKER_KINDS.find(k => k.id === id) || MARKER_KINDS[MARKER_KINDS.length - 1];
}

/* ==================================================================== maths
 * Pure helpers — no DOM, no THREE. Unit-tested headlessly.
 * ==================================================================== */

/** Parse "4.2 x 3.6 x 2.4" (or "4.2x3.6", or "4.2 3.6 2.4") into metres. */
export function parseDimensions(str) {
  if (!str) return null;
  const nums = String(str).match(/\d+(?:[.,]\d+)?/g);
  if (!nums || !nums.length) return null;
  const v = nums.map(n => parseFloat(String(n).replace(",", ".")));
  const w = v[0], d = v[1] != null ? v[1] : v[0], h = v[2] != null ? v[2] : 2.4;
  if (!(w > 0) || !(d > 0) || !(h > 0)) return null;
  return { w: Math.min(w, 200), d: Math.min(d, 200), h: Math.min(h, 20) };
}

/** Axis-aligned bounds of a room centred on (x, z). */
export function roomBounds(room) {
  const hw = (room.w || 4) / 2, hd = (room.d || 4) / 2;
  return {
    minX: room.x - hw, maxX: room.x + hw,
    minZ: room.z - hd, maxZ: room.z + hd,
    minY: room.y || 0, maxY: (room.y || 0) + (room.h || 2.4),
  };
}

/** Is a floor point inside this room (with a little wall clearance)? */
export function pointInRoom(room, x, z, clearance = 0.16) {
  const b = roomBounds(room);
  return x > b.minX + clearance && x < b.maxX - clearance &&
         z > b.minZ + clearance && z < b.maxZ - clearance;
}

/** Total floor area, square metres. */
export function floorArea(rooms) {
  return (rooms || []).reduce((a, r) => a + (r.w || 0) * (r.d || 0), 0);
}

/** Which room contains a point, or the nearest one. */
export function roomAt(rooms, x, z) {
  const list = rooms || [];
  for (const r of list) if (pointInRoom(r, x, z, -WALL_THICKNESS)) return r;
  let best = null, bestD = Infinity;
  for (const r of list) {
    const b = roomBounds(r);
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    const d = (cx - x) ** 2 + (cz - z) ** 2;
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}

/** Can the camera stand at (x, z) without being inside a wall? */
export function canStand(rooms, x, z) {
  if (!rooms || !rooms.length) return true;
  for (const r of rooms) {
    if (pointInRoom(r, x, z, WALL_THICKNESS / 2 + 0.05)) return true;
  }
  return false;
}

/** Floor and ceiling quads for a room, as flat triangle arrays. */
export function roomSurfaces(room, inset = 0) {
  const b = roomBounds(room);
  const x0 = b.minX + inset, x1 = b.maxX - inset;
  const z0 = b.minZ + inset, z1 = b.maxZ - inset;
  const y0 = b.minY, y1 = b.maxY;
  return {
    floor: [x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z0, x1, y0, z1, x0, y0, z1],
    ceiling: [x0, y1, z0, x1, y1, z1, x1, y1, z0, x0, y1, z0, x0, y1, z1, x1, y1, z1],
  };
}

/** Four wall quads for a room, each as two triangles. */
export function roomWalls(room) {
  const b = roomBounds(room);
  const t = WALL_THICKNESS;
  const out = [];
  const quad = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz) =>
    out.push(ax, ay, az, bx, by, bz, cx, cy, cz, ax, ay, az, cx, cy, cz, dx, dy, dz);

  const y0 = b.minY, y1 = b.maxY;
  quad(b.minX - t, y0, b.minZ - t, b.maxX + t, y0, b.minZ - t, b.maxX + t, y1, b.minZ - t, b.minX - t, y1, b.minZ - t);
  quad(b.minX - t, y0, b.maxZ + t, b.minX - t, y1, b.maxZ + t, b.maxX + t, y1, b.maxZ + t, b.maxX + t, y0, b.maxZ + t);
  quad(b.minX - t, y0, b.minZ - t, b.minX - t, y1, b.minZ - t, b.minX - t, y1, b.maxZ + t, b.minX - t, y0, b.maxZ + t);
  quad(b.maxX + t, y0, b.minZ - t, b.maxX + t, y0, b.maxZ + t, b.maxX + t, y1, b.maxZ + t, b.maxX + t, y1, b.minZ - t);
  return out;
}

/**
 * Optical flow between two frames, as a grid of per-cell displacement vectors.
 * Flat, textureless cells are skipped — they cannot be tracked.
 */
export function computeFlow(prev, curr, w, h, cell = FEATURE_CELL) {
  const cols = Math.floor(w / cell), rows = Math.floor(h / cell);
  const flow = [];
  for (let cy = 1; cy < rows - 1; cy++) {
    for (let cx = 1; cx < cols - 1; cx++) {
      const px = cx * cell + cell / 2, py = cy * cell + cell / 2;
      const bx = Math.floor(px), by = Math.floor(py);

      // Gradient energy across the whole cell, not one pixel: sampling a
      // single pixel misses any texture whose period lines up with the grid,
      // and single-pixel noise is not a real feature either.
      let grad = 0;
      for (let y = by; y < by + cell && y < h - 1; y += 2) {
        for (let x = bx; x < bx + cell && x < w - 1; x += 2) {
          const i = (y * w + x) * 4;
          grad += Math.abs(curr[i + 4] - curr[i]) + Math.abs(curr[i + w * 4] - curr[i]);
        }
      }
      if (grad < 80) continue;

      let bestDx = 0, bestDy = 0, bestScore = Infinity;
      for (let dy = -MATCH_RADIUS; dy <= MATCH_RADIUS; dy += 2) {
        for (let dx = -MATCH_RADIUS; dx <= MATCH_RADIUS; dx += 2) {
          const qx = bx + dx, qy = by + dy;
          if (qx < 2 || qy < 2 || qx >= w - 2 || qy >= h - 2) continue;
          let score = 0;
          for (let sy = -2; sy <= 2; sy += 2) {
            for (let sx = -2; sx <= 2; sx += 2) {
              const a = ((by + sy) * w + bx + sx) * 4;
              const b = ((qy + sy) * w + qx + sx) * 4;
              score += Math.abs(curr[a] - prev[b]);
            }
          }
          if (score < bestScore) { bestScore = score; bestDx = dx; bestDy = dy; }
        }
      }
      if (bestScore > 400) continue;
      flow.push({ x: px, y: py, dx: bestDx, dy: bestDy });
    }
  }
  return flow;
}

/**
 * Camera motion from a flow field.
 *   tx, ty — median translation in pixels (camera pan)
 *   div    — divergence: positive means the field expands, i.e. moving forward
 *   depth  — rough distance to the scene, from 1/divergence
 */
export function estimateMotion(flow, w, h) {
  if (!flow || flow.length < MIN_MATCHES) {
    return { tx: 0, ty: 0, div: 0, depth: 0, count: flow ? flow.length : 0 };
  }
  const med = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const tx = med(flow.map(f => f.dx));
  const ty = med(flow.map(f => f.dy));

  const cx = w / 2, cy = h / 2;
  let divSum = 0, n = 0;
  for (const f of flow) {
    const rx = f.x - cx, ry = f.y - cy;
    const r = Math.hypot(rx, ry);
    if (r < 6) continue;
    divSum += (rx * f.dx + ry * f.dy) / r;
    n++;
  }
  const div = n ? divSum / n : 0;
  const depth = Math.abs(div) > 0.4 ? Math.min(12, 14 / Math.abs(div)) : 0;
  return { tx, ty, div, depth, count: flow.length };
}

/**
 * Integrate motion into a camera pose. Returns the new pose plus the world
 * points observed this frame.
 */
export function integrateFrame(pose, flow, motion, opts = {}) {
  const {
    scale = 0.012,
    fov = CALIBRATED_FOV,
    width = PROC_WIDTH,
    height = PROC_HEIGHT,
    maxPoints = 900,
  } = opts;

  const next = { ...pose };
  const forward = motion.div * 0.05 * scale * 60;
  const strafe = motion.tx * scale;
  const turn = (motion.tx / width) * (fov * Math.PI / 180) * 0.35;

  next.yaw = (pose.yaw || 0) + turn;
  next.x = (pose.x || 0) + Math.sin(next.yaw) * forward + Math.cos(next.yaw) * strafe;
  next.z = (pose.z || 0) - Math.cos(next.yaw) * forward + Math.sin(next.yaw) * strafe;
  next.y = pose.y || 0;

  const points = [];
  if (motion.depth > 0 && flow.length) {
    const f = (height / 2) / Math.tan((fov * Math.PI / 180) / 2);
    const step = Math.max(1, Math.floor(flow.length / maxPoints));
    const cos = Math.cos(next.yaw), sin = Math.sin(next.yaw);
    for (let i = 0; i < flow.length; i += step) {
      const fl = flow[i];
      const rx = (fl.x - width / 2) / f;
      const ry = -(fl.y - height / 2) / f;
      const d = motion.depth;
      const camX = rx * d, camY = ry * d, camZ = -d;
      points.push({
        x: next.x + (camX * cos - camZ * sin),
        y: next.y + camY,
        z: next.z + (camX * sin + camZ * cos),
        r: 190, g: 200, b: 195,
      });
    }
  }
  return { pose: next, points };
}

/** Centre of a model, used to frame the camera. */
export function modelCentre(rooms, points) {
  const xs = [], zs = [], ys = [];
  (rooms || []).forEach(r => { xs.push(r.x); zs.push(r.z); });
  (points || []).slice(0, 4000).forEach(p => { xs.push(p.x); zs.push(p.z); ys.push(p.y); });
  if (!xs.length) return { x: 0, y: 0, z: 0 };
  const avg = a => a.reduce((s, v) => s + v, 0) / a.length;
  return { x: avg(xs), y: ys.length ? avg(ys) : 0, z: avg(zs) };
}

/* ================================================================== viewer */

export class MeshViewer {
  constructor(container, { me, propertyId = null }) {
    this.container = container;
    this.me = me;
    this.propertyId = propertyId;

    this.stream = null;
    this.video = null;
    this.procCanvas = null;
    this.ctx = null;
    this.frameInterval = null;
    this.lastGray = null;
    this.frameCount = 0;
    this.isScanning = false;

    this.points = [];
    this.rooms = [];
    this.markers = [];
    this.pose = { x: 0, y: 0, z: 0, yaw: 0 };

    this.mode = "orbit";
    this.placeKind = null;

    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.pointsObject = null;
    this.roomGroup = null;
    this.markerGroup = null;
    this.raycaster = new THREE.Raycaster();
    this.animationId = null;
    this.destroyed = false;
    this.meshName = "";
    this.scanMode = "indoor";
    this.walkKeys = {};
    this.walkVel = { x: 0, z: 0 };
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.calibrationWidth = 4;
  }

  async init() {
    this.buildUI();
    try { this.initThree(); }
    catch (e) {
      console.error("mesh: three init failed", e);
      this.setStatus("WebGL is not available on this device.");
    }
    this.refreshMeshList();
    this.refreshMarkerList();
    this.refreshRoomList();
    this.updateVrButton();
  }

  /* ------------------------------------------------------------------ UI */
  buildUI() {
    const c = this.container;
    c.innerHTML = "";

    const head = el("div", "row-between");
    head.appendChild(el("h2", null, "3D Property"));
    c.appendChild(head);
    c.appendChild(el("p", "muted sm",
      "Rebuild your property in 3D, then walk through it \u2014 or put a headset on and walk through it in VR."));

    const tabBar = el("div", "mesh-tabs");
    this.panels = {};
    [["scan", "\u{1F4F7} Scan"], ["rooms", "\u{1F4D0} Rooms"], ["markers", "\u{1F4CC} Markers"]]
      .forEach(([id, label]) => {
        const b = el("button", "mesh-tab", label);
        b.onclick = () => this.showPanel(id);
        this.tabButtons = this.tabButtons || {};
        this.tabButtons[id] = b;
        tabBar.appendChild(b);
      });
    c.appendChild(tabBar);

    const bar = el("div", "mesh-controls");
    const props = Store.propertiesFor(this.me);
    const propSel = el("select", "mesh-prop");
    const none = el("option", null, "Select a property");
    none.value = "";
    propSel.appendChild(none);
    props.forEach(p => {
      const o = el("option", null, p.name);
      o.value = p.id;
      propSel.appendChild(o);
    });
    if (this.propertyId) propSel.value = this.propertyId;
    propSel.onchange = () => {
      this.propertyId = propSel.value || null;
      this.stopCamera();
      this.points = []; this.rooms = []; this.markers = [];
      this.updatePointCloud(); this.renderRooms(); this.renderMarkers();
      this.refreshMeshList(); this.refreshMarkerList(); this.refreshRoomList();
      this.autoName();
    };
    bar.appendChild(this.field("Property", propSel));

    const nameInput = el("input");
    nameInput.placeholder = "Model name";
    nameInput.oninput = () => { this.meshName = nameInput.value; };
    this.nameInput = nameInput;
    bar.appendChild(this.field("Name", nameInput));
    c.appendChild(bar);

    const main = el("div", "mesh-main");

    const camPanel = el("div", "mesh-cam-panel");
    const video = el("video");
    video.autoplay = true; video.playsInline = true; video.muted = true;
    video.className = "mesh-video";
    camPanel.appendChild(video);
    this.video = video;
    const ph = el("div", "mesh-cam-placeholder");
    ph.appendChild(el("p", null, "Camera is off"));
    camPanel.appendChild(ph);
    this.camPlaceholder = ph;
    const status = el("div", "mesh-status");
    camPanel.appendChild(status);
    this.statusEl = status;
    main.appendChild(camPanel);

    const viewPanel = el("div", "mesh-view-panel");
    const canvas = el("canvas");
    canvas.className = "mesh-canvas";
    viewPanel.appendChild(canvas);
    this.viewCanvas = canvas;

    const overlay = el("div", "mesh-overlay");
    overlay.appendChild(el("p", "muted sm", "No model yet \u2014 scan a room, or add room dimensions."));
    viewPanel.appendChild(overlay);
    this.overlay = overlay;

    const walkHud = el("div", "walk-hud");
    walkHud.hidden = true;
    const joy = el("div", "walk-joystick");
    const knob = el("div", "walk-knob");
    joy.appendChild(knob);
    walkHud.appendChild(joy);
    const walkInfo = el("div", "walk-info");
    walkHud.appendChild(walkInfo);
    viewPanel.appendChild(walkHud);
    this.walkHud = walkHud;
    this.joystickEl = joy;
    this.knobEl = knob;
    this.walkInfoEl = walkInfo;

    main.appendChild(viewPanel);
    c.appendChild(main);

    const viewBar = el("div", "mesh-actions");
    this.orbitBtn = this.button("Orbit view", "btn sm", () => this.setMode("orbit"));
    this.walkBtn = this.button("Walk through", "btn ghost sm", () => this.setMode("walk"));
    this.vrBtn = this.button("Enter VR", "btn ghost sm", () => this.enterVR());
    this.vrBtn.hidden = true;
    viewBar.appendChild(this.orbitBtn);
    viewBar.appendChild(this.walkBtn);
    viewBar.appendChild(this.vrBtn);
    this.resetBtn = this.button("Reset view", "btn ghost sm", () => this.resetView());
    viewBar.appendChild(this.resetBtn);
    c.appendChild(viewBar);

    /* ---------------- panel: scan ---------------- */
    const scanPanel = el("div", "mesh-panel");
    this.panels.scan = scanPanel;

    const scanActions = el("div", "mesh-actions");
    this.startBtn = this.button("Start camera scan", "btn", () => this.toggleCamera());
    scanActions.appendChild(this.startBtn);
    this.photosBtn = this.button("Add from photos", "btn ghost", () => this.addFromPhotos());
    scanActions.appendChild(this.photosBtn);
    scanPanel.appendChild(scanActions);

    scanPanel.appendChild(el("p", "muted sm",
      "Walk slowly around the room with the camera pointing ahead. The model builds as you go."));

    const calRow = el("div", "inline-row");
    const calIn = el("input");
    calIn.type = "number";
    calIn.value = this.calibrationWidth;
    calIn.min = 1; calIn.max = 50; calIn.step = 0.1;
    calIn.onchange = () => { this.calibrationWidth = parseFloat(calIn.value) || 4; };
    calRow.appendChild(this.field("Room is about (m)", calIn));
    scanPanel.appendChild(calRow);

    scanPanel.appendChild(el("h3", null, "Saved models"));
    const meshList = el("div", "mesh-saved-list");
    this.meshList = meshList;
    scanPanel.appendChild(meshList);

    /* ---------------- panel: rooms ---------------- */
    const roomPanel = el("div", "mesh-panel");
    this.panels.rooms = roomPanel;
    roomPanel.appendChild(el("p", "muted sm",
      "Type a room's size and it becomes real walls you can walk through. This is the accurate path \u2014 and the one VR needs."));

    const roomForm = el("div", "room-form");
    const rnIn = el("input");
    rnIn.placeholder = "Living room";
    roomForm.appendChild(this.field("Room name", rnIn));
    const rdIn = el("input");
    rdIn.placeholder = "4.2 x 3.6 x 2.4";
    roomForm.appendChild(this.field("Size W x D x H (m)", rdIn));
    roomPanel.appendChild(roomForm);

    const roomBtns = el("div", "mesh-actions");
    roomBtns.appendChild(this.button("Add room", "btn", () => {
      const name = rnIn.value.trim() || `Room ${this.rooms.length + 1}`;
      const dims = parseDimensions(rdIn.value);
      if (!dims) return toast("Enter a size like 4.2 x 3.6 x 2.4", "bad");
      this.addRoom(name, dims);
      rnIn.value = ""; rdIn.value = "";
    }));
    roomBtns.appendChild(this.button("Add whole house", "btn ghost", () => this.addHousePreset()));
    roomBtns.appendChild(this.button("Auto-connect rooms", "btn ghost", () => {
      const n = this.autoConnectRooms();
      toast(n ? `Opened ${n} doorway(s) between rooms` : "No rooms are close enough to connect", n ? "good" : "info");
    }));
    roomPanel.appendChild(roomBtns);

    const roomList = el("div", "room-list");
    this.roomList = roomList;
    roomPanel.appendChild(roomList);

    /* ---------------- panel: markers ---------------- */
    const markerPanel = el("div", "mesh-panel");
    this.panels.markers = markerPanel;
    markerPanel.appendChild(el("p", "muted sm",
      "Pick a type, then tap the model where it is. Each marker records what the thing is and what it does."));

    const kindRow = el("div", "marker-kinds");
    this.kindButtons = new Map();
    MARKER_KINDS.forEach(k => {
      const b = el("button", "marker-kind");
      b.appendChild(el("span", null, k.icon));
      b.appendChild(el("span", null, k.label));
      b.onclick = () => this.chooseKind(k.id);
      this.kindButtons.set(k.id, b);
      kindRow.appendChild(b);
    });
    markerPanel.appendChild(kindRow);

    this.placeHint = el("p", "muted sm", "Pick a marker type to start placing.");
    markerPanel.appendChild(this.placeHint);

    const markerList = el("div", "marker-list");
    this.markerList = markerList;
    markerPanel.appendChild(markerList);

    // attach every panel (each is toggled by showPanel)
    c.appendChild(scanPanel);
    c.appendChild(roomPanel);
    c.appendChild(markerPanel);

    /* ---------------- export ---------------- */
    c.appendChild(el("h3", null, "Export"));
    const exportBar = el("div", "mesh-actions");
    this.saveBtn = this.button("Save model", "btn ghost", () => this.saveMesh());
    exportBar.appendChild(this.saveBtn);
    this.objBtn = this.button("OBJ", "btn ghost", () => this.download("obj"));
    exportBar.appendChild(this.objBtn);
    this.plyBtn = this.button("PLY", "btn ghost", () => this.download("ply"));
    exportBar.appendChild(this.plyBtn);
    this.gltfBtn = this.button("glTF (VR apps)", "btn ghost", () => this.download("gltf"));
    exportBar.appendChild(this.gltfBtn);
    this.clearBtn = this.button("Clear model", "btn ghost danger", () => {
      if (!confirm("Clear the current model?")) return;
      this.points = []; this.rooms = []; this.markers = [];
      this.updatePointCloud(); this.renderRooms(); this.renderMarkers();
      this.refreshRoomList(); this.refreshMarkerList();
    });
    exportBar.appendChild(this.clearBtn);
    c.appendChild(exportBar);

    this.showPanel("scan");
  }

  showPanel(id) {
    Object.entries(this.panels).forEach(([k, p]) => { p.hidden = k !== id; });
    Object.entries(this.tabButtons).forEach(([k, b]) => b.classList.toggle("active", k === id));
    const camPanel = this.container.querySelector(".mesh-cam-panel");
    if (camPanel) camPanel.hidden = id !== "scan";
  }

  field(label, input) {
    const w = el("label", "field");
    w.appendChild(el("span", null, label));
    w.appendChild(input);
    return w;
  }

  button(label, cls, onClick) {
    const b = el("button", cls, label);
    b.onclick = onClick;
    return b;
  }

  setStatus(msg) { if (this.statusEl) this.statusEl.textContent = msg || ""; }

  autoName() {
    if (!this.propertyId) return;
    const p = Store.property(this.propertyId);
    if (!p) return;
    this.meshName = `${p.name} \u2014 ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
    if (this.nameInput) this.nameInput.value = this.meshName;
  }

  /* ------------------------------------------------------------- three.js */
  initThree() {
    const test = document.createElement("canvas");
    if (!(test.getContext("webgl") || test.getContext("experimental-webgl"))) {
      throw new Error("WebGL not supported");
    }
    const canvas = this.viewCanvas;
    const w = canvas.parentElement.clientWidth || 600;
    const h = canvas.parentElement.clientHeight || 360;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x08110e);
    this.scene.fog = new THREE.Fog(0x08110e, 14, 46);

    this.camera = new THREE.PerspectiveCamera(70, w / h, 0.05, 200);
    this.camera.position.set(0, 1.7, 4);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.xr.enabled = true;

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 1, 0);

    const grid = new THREE.GridHelper(20, 40, 0x1e4232, 0x143026);
    this.scene.add(grid);
    this.grid = grid;

    this.roomGroup = new THREE.Group();
    this.scene.add(this.roomGroup);
    this.markerGroup = new THREE.Group();
    this.scene.add(this.markerGroup);

    const amb = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(amb);
    const dir = new THREE.DirectionalLight(0xffffff, 0.75);
    dir.position.set(5, 9, 6);
    this.scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0xffffff, 0.3);
    dir2.position.set(-6, 4, -5);
    this.scene.add(dir2);

    this.raycaster.params.Points.threshold = 0.08;

    canvas.addEventListener("pointerdown", (ev) => this.onCanvasTap(ev));
    this.bindWalkControls();

    this.updatePointCloud();
    this.renderRooms();
    this.animate();

    this.resizeHandler = () => this.onResize();
    window.addEventListener("resize", this.resizeHandler);
  }

  onResize() {
    if (!this.renderer || !this.camera || !this.viewCanvas) return;
    const panel = this.viewCanvas.parentElement;
    if (!panel) return;
    const w = panel.clientWidth, h = panel.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  animate() {
    if (this.destroyed) return;
    if (this.renderer.xr.isPresenting) return;
    this.animationId = requestAnimationFrame(() => this.animate());
    this.stepWalk();
    if (this.mode === "orbit" && this.controls) this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /* ------------------------------------------------------------- geometry */
  updatePointCloud() {
    if (!this.scene) return;
    if (this.pointsObject) {
      this.scene.remove(this.pointsObject);
      this.pointsObject.geometry.dispose();
      this.pointsObject.material.dispose();
      this.pointsObject = null;
    }
    if (!this.points.length) {
      if (this.overlay) this.overlay.hidden = this.rooms.length > 0;
      return;
    }
    if (this.overlay) this.overlay.hidden = true;

    const n = this.points.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const p = this.points[i];
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      col[i * 3] = (p.r || 190) / 255;
      col[i * 3 + 1] = (p.g || 200) / 255;
      col[i * 3 + 2] = (p.b || 195) / 255;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    this.pointsObject = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.03, vertexColors: true, sizeAttenuation: true,
    }));
    this.scene.add(this.pointsObject);
  }

  renderRooms() {
    if (!this.roomGroup) return;
    while (this.roomGroup.children.length) {
      const ch = this.roomGroup.children.pop();
      if (ch.geometry) ch.geometry.dispose();
      if (ch.material) {
        if (ch.material.map) ch.material.map.dispose();
        ch.material.dispose();
      }
    }
    if (!this.rooms.length) {
      if (this.grid) this.grid.visible = true;
      if (this.overlay && !this.points.length) this.overlay.hidden = false;
      return;
    }
    if (this.grid) this.grid.visible = false;
    if (this.overlay) this.overlay.hidden = true;

    const floorMat = new THREE.MeshStandardMaterial({ color: 0x2a4a3a, roughness: 0.9, side: THREE.DoubleSide });
    const ceilMat = new THREE.MeshStandardMaterial({ color: 0x162019, roughness: 1, side: THREE.DoubleSide });
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x9db4a8, roughness: 0.95, side: THREE.DoubleSide });

    this.rooms.forEach(room => {
      const surf = roomSurfaces(room, 0);

      const fg = new THREE.BufferGeometry();
      fg.setAttribute("position", new THREE.Float32BufferAttribute(surf.floor, 3));
      fg.computeVertexNormals();
      this.roomGroup.add(new THREE.Mesh(fg, floorMat));

      const cg = new THREE.BufferGeometry();
      cg.setAttribute("position", new THREE.Float32BufferAttribute(surf.ceiling, 3));
      cg.computeVertexNormals();
      this.roomGroup.add(new THREE.Mesh(cg, ceilMat));

      const wg = new THREE.BufferGeometry();
      wg.setAttribute("position", new THREE.Float32BufferAttribute(roomWalls(room), 3));
      wg.computeVertexNormals();
      this.roomGroup.add(new THREE.Mesh(wg, wallMat));

      this.roomGroup.add(this.makeLabel(room.name, room.x, (room.y || 0) + (room.h || 2.4) - 0.3, room.z, 0.95, "#67e8f9"));
    });
  }

  makeLabel(text, x, y, z, width = 1, colour = "#e8f0ec") {
    const cv = document.createElement("canvas");
    cv.width = 512; cv.height = 128;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "rgba(8,17,14,.78)";
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = colour;
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, cv.width - 4, cv.height - 4);
    ctx.fillStyle = colour;
    ctx.font = "bold 52px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    const t = text.length > 22 ? text.slice(0, 21) + "\u2026" : text;
    ctx.fillText(t, 20, cv.height / 2);
    const tex = new THREE.CanvasTexture(cv);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sp.position.set(x, y, z);
    sp.scale.set(width, width * 0.25, 1);
    return sp;
  }

  /* --------------------------------------------------------------- rooms */
  addRoom(name, dims, at = null) {
    const pos = at || this.nextRoomSlot();
    const room = { id: uid(), name, x: pos.x, z: pos.z, y: 0, w: dims.w, d: dims.d, h: dims.h };
    this.rooms.push(room);
    this.renderRooms();
    this.refreshRoomList();
    this.setStatus(`${this.rooms.length} room(s) \u00B7 ${floorArea(this.rooms).toFixed(1)} m\u00B2`);
    toast(`Added ${name}`, "good");
    return room;
  }

  nextRoomSlot() {
    if (!this.rooms.length) return { x: 0, z: 0 };
    const last = this.rooms[this.rooms.length - 1];
    return { x: last.x + (last.w / 2) + 2.2, z: last.z };
  }

  addHousePreset() {
    const layout = [
      ["Living room", 5.2, 4.2, 2.6],
      ["Kitchen", 3.6, 3.2, 2.6],
      ["Hallway", 1.4, 4.0, 2.6],
      ["Bedroom", 4.2, 3.6, 2.5],
      ["Bathroom", 2.4, 2.2, 2.4],
    ];
    let x = 0;
    layout.forEach(([name, w, d, h]) => {
      this.rooms.push({ id: uid(), name, x, z: 0, y: 0, w, d, h });
      x += w + 2.4;
    });
    this.renderRooms();
    this.refreshRoomList();
    toast("Whole-house layout added \u2014 edit the sizes to match yours", "good");
  }

  autoConnectRooms() {
    let n = 0;
    for (let i = 0; i < this.rooms.length; i++) {
      for (let j = i + 1; j < this.rooms.length; j++) {
        const a = roomBounds(this.rooms[i]), b = roomBounds(this.rooms[j]);
        const gapX = Math.max(0, Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX));
        const gapZ = Math.max(0, Math.max(a.minZ, b.minZ) - Math.min(a.maxZ, b.maxZ));
        if (gapX < 2.6 && gapZ < 2.6) {
          if (gapZ <= gapX) {
            const shift = (gapX / 2) * (b.minX > a.minX ? -1 : 1);
            this.rooms[j].x += shift;
          } else {
            const shift = (gapZ / 2) * (b.minZ > a.minZ ? -1 : 1);
            this.rooms[j].z += shift;
          }
          n++;
        }
      }
    }
    this.renderRooms();
    this.refreshRoomList();
    return n;
  }

  refreshRoomList() {
    const list = this.roomList;
    if (!list) return;
    list.innerHTML = "";
    if (!this.rooms.length) {
      list.appendChild(el("p", "muted sm", "No rooms yet."));
      return;
    }
    this.rooms.forEach(room => {
      const row = el("div", "room-row");
      const info = el("div", "room-info");
      info.appendChild(el("b", null, room.name));
      info.appendChild(el("span", "muted xs",
        `${room.w.toFixed(1)} x ${room.d.toFixed(1)} x ${room.h.toFixed(1)} m \u00B7 ${(room.w * room.d).toFixed(1)} m\u00B2`));
      row.appendChild(info);

      const acts = el("div", "card-actions");
      acts.appendChild(this.button("Walk here", "btn ghost sm", () => this.walkTo(room)));
      acts.appendChild(this.button("Delete", "btn ghost sm danger", () => {
        this.rooms = this.rooms.filter(r => r.id !== room.id);
        this.renderRooms(); this.refreshRoomList();
      }));
      row.appendChild(acts);
      list.appendChild(row);
    });
  }

  /* --------------------------------------------------------- view modes */
  setMode(mode) {
    this.mode = mode;
    const walking = mode === "walk";
    if (this.controls) this.controls.enabled = !walking;
    if (this.walkHud) this.walkHud.hidden = !walking;
    this.walkBtn.classList.toggle("active", walking);
    this.orbitBtn.classList.toggle("active", !walking);

    if (walking) {
      const room = this.rooms[0];
      if (room) this.camera.position.set(room.x, (room.y || 0) + EYE_HEIGHT, room.z);
      else this.camera.position.set(0, EYE_HEIGHT, 0);
      this.lookYaw = 0; this.lookPitch = 0;
      this.applyLook();
      toast(this.rooms.length
        ? "Walking: W/A/S/D or the stick, drag to look"
        : "Add a room first \u2014 then you can walk through it", this.rooms.length ? "info" : "bad");
    } else {
      this.resetView();
    }
  }

  walkTo(room) {
    this.setMode("walk");
    this.camera.position.set(room.x, (room.y || 0) + EYE_HEIGHT, room.z);
    this.applyLook();
  }

  applyLook() {
    if (!this.camera) return;
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.lookPitch, this.lookYaw, 0, "YXZ"));
  }

  bindWalkControls() {
    const canvas = this.viewCanvas;

    addEventListener("keydown", (e) => { this.walkKeys[e.key.toLowerCase()] = true; });
    addEventListener("keyup", (e) => { this.walkKeys[e.key.toLowerCase()] = false; });

    let dragging = false, lastX = 0, lastY = 0;
    canvas.addEventListener("pointerdown", (e) => {
      if (this.mode !== "walk") return;
      if (e.target === this.joystickEl || e.target === this.knobEl) return;
      dragging = true; lastX = e.clientX; lastY = e.clientY;
    });
    addEventListener("pointermove", (e) => {
      if (!dragging || this.mode !== "walk") return;
      this.lookYaw -= (e.clientX - lastX) * 0.005;
      this.lookPitch -= (e.clientY - lastY) * 0.005;
      this.lookPitch = Math.max(-1.3, Math.min(1.3, this.lookPitch));
      lastX = e.clientX; lastY = e.clientY;
      this.applyLook();
    });
    addEventListener("pointerup", () => { dragging = false; });

    let stickId = null, cx = 0, cy = 0;
    const max = 34;
    const setKnob = (dx, dy) => {
      const len = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, max / len);
      this.knobEl.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
      this.walkVel.x = dx / max;
      this.walkVel.z = dy / max;
    };
    this.joystickEl.addEventListener("pointerdown", (e) => {
      stickId = e.pointerId;
      const r = this.joystickEl.getBoundingClientRect();
      cx = r.left + r.width / 2; cy = r.top + r.height / 2;
      try { this.joystickEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      e.stopPropagation();
    });
    this.joystickEl.addEventListener("pointermove", (e) => {
      if (e.pointerId !== stickId) return;
      setKnob(e.clientX - cx, e.clientY - cy);
      e.stopPropagation();
    });
    const release = (e) => {
      if (stickId != null && e.pointerId !== stickId) return;
      stickId = null;
      this.walkVel.x = 0; this.walkVel.z = 0;
      this.knobEl.style.transform = "translate(0,0)";
    };
    this.joystickEl.addEventListener("pointerup", release);
    this.joystickEl.addEventListener("pointercancel", release);
  }

  stepWalk() {
    if (this.mode !== "walk" || !this.camera) return;
    const k = this.walkKeys;
    let f = 0, s = 0;
    if (k["w"] || k["arrowup"]) f += 1;
    if (k["s"] || k["arrowdown"]) f -= 1;
    if (k["a"] || k["arrowleft"]) s -= 1;
    if (k["d"] || k["arrowright"]) s += 1;
    f += -this.walkVel.z;
    s += this.walkVel.x;

    const speed = 1.8 * (k["shift"] ? 2.2 : 1);
    const mag = Math.hypot(f, s);
    if (mag > 0.02) {
      const nx = Math.min(1, mag);
      const dirF = f / mag, dirS = s / mag;
      const sin = Math.sin(this.lookYaw), cos = Math.cos(this.lookYaw);
      const dx = (sin * dirF + cos * dirS) * speed * nx * 0.016;
      const dz = (-cos * dirF + sin * dirS) * speed * nx * 0.016;
      const px = this.camera.position.x + dx;
      const pz = this.camera.position.z + dz;
      if (canStand(this.rooms, px, this.camera.position.z)) this.camera.position.x = px;
      if (canStand(this.rooms, this.camera.position.x, pz)) this.camera.position.z = pz;
      this.camera.position.y = EYE_HEIGHT;
    }
    if (this.walkInfoEl) {
      const room = roomAt(this.rooms, this.camera.position.x, this.camera.position.z);
      this.walkInfoEl.textContent = room ? room.name : "";
    }
  }

  /* ------------------------------------------------------------------ VR */
  async updateVrButton() {
    if (!this.vrBtn) return;
    if (!navigator.xr || !navigator.xr.isSessionSupported) { this.vrBtn.hidden = true; return; }
    try {
      const ok = await navigator.xr.isSessionSupported("immersive-vr");
      this.vrBtn.hidden = !ok;
    } catch { this.vrBtn.hidden = true; }
  }

  async enterVR() {
    if (!navigator.xr) return toast("This browser has no WebXR support", "bad");
    if (!this.rooms.length) return toast("Add room dimensions first \u2014 VR needs walls to walk between", "bad");
    try {
      const session = await navigator.xr.requestSession("immersive-vr", {
        optionalFeatures: ["local-floor", "bounded-floor"],
      });
      this.renderer.xr.setReferenceSpaceType("local-floor");
      await this.renderer.xr.setSession(session);
      const room = this.rooms[0];
      this.camera.position.set(room.x, (room.y || 0) + EYE_HEIGHT, room.z);
      this.applyLook();
      this.renderer.setAnimationLoop(() => {
        this.renderer.render(this.scene, this.camera);
      });
      session.addEventListener("end", () => {
        this.renderer.setAnimationLoop(null);
        this.animate();
      });
      toast("Entered VR \u2014 walk with the controller or your feet", "good");
    } catch (e) {
      console.error("VR failed", e);
      toast("Could not start VR on this device", "bad");
    }
  }

  /* ------------------------------------------------------------- camera */
  async toggleCamera() {
    if (this.isScanning) this.stopCamera();
    else await this.startCamera();
  }

  async startCamera() {
    if (!this.propertyId) return this.setStatus("Select a property first.");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return this.setStatus("Camera is not supported on this device.");
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
    } catch {
      return this.setStatus("Could not access the camera.");
    }
    this.video.srcObject = this.stream;
    await this.video.play();

    this.procCanvas = document.createElement("canvas");
    this.procCanvas.width = PROC_WIDTH;
    this.procCanvas.height = PROC_HEIGHT;
    this.ctx = this.procCanvas.getContext("2d", { willReadFrequently: true });

    this.isScanning = true;
    this.lastGray = null;
    this.frameCount = 0;
    this.pose = { x: 0, y: 0, z: 0, yaw: 0 };
    this.startBtn.textContent = "Stop camera scan";
    this.camPlaceholder.hidden = true;
    this.setStatus("Scanning\u2026");
    this.frameInterval = setInterval(() => this.captureFrame(), FRAME_INTERVAL);
  }

  stopCamera() {
    this.isScanning = false;
    if (this.frameInterval) { clearInterval(this.frameInterval); this.frameInterval = null; }
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    if (this.video) this.video.srcObject = null;
    if (this.startBtn) this.startBtn.textContent = "Start camera scan";
    if (this.camPlaceholder) this.camPlaceholder.hidden = false;
    this.setStatus(this.points.length ? `${this.points.length.toLocaleString()} points captured` : "");
  }

  captureFrame() {
    if (!this.ctx || !this.video || this.video.readyState < 2) return;
    this.ctx.drawImage(this.video, 0, 0, PROC_WIDTH, PROC_HEIGHT);
    const frame = this.ctx.getImageData(0, 0, PROC_WIDTH, PROC_HEIGHT);

    if (this.lastGray) {
      const flow = computeFlow(this.lastGray, frame, PROC_WIDTH, PROC_HEIGHT);
      const motion = estimateMotion(flow, PROC_WIDTH, PROC_HEIGHT);
      const { pose, points } = integrateFrame(this.pose, flow, motion, {
        width: PROC_WIDTH, height: PROC_HEIGHT,
        scale: this.calibrationWidth / 400,
      });
      this.pose = pose;
      if (points.length) this.addPoints(points);
      this.setStatus(`Scanning \u2014 ${this.frameCount} frames \u00B7 ${this.points.length.toLocaleString()} points \u00B7 ${Math.hypot(pose.x, pose.z).toFixed(1)} m`);
    }
    this.lastGray = frame;
    this.frameCount++;
  }

  addPoints(pts) {
    this.points.push(...pts);
    if (this.points.length > MAX_POINTS) {
      const ratio = MAX_POINTS / this.points.length;
      this.points = this.points.filter(() => Math.random() < ratio);
    }
    this.updatePointCloud();
  }

  addFromPhotos() {
    if (!this.propertyId) return this.setStatus("Select a property first.");
    const photos = Store.photosFor(this.propertyId);
    if (!photos.length) return this.setStatus("No photos on this property yet.");
    if (!confirm(`Add ${photos.length} photo(s) to the model?`)) return;

    let done = 0;
    const added = [];
    photos.forEach(ph => {
      const img = new Image();
      img.onload = () => {
        try {
          const cv = document.createElement("canvas");
          cv.width = 96; cv.height = 72;
          const ctx = cv.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, 96, 72);
          const d = ctx.getImageData(0, 0, 96, 72).data;
          for (let y = 0; y < 72; y += 3) {
            for (let x = 0; x < 96; x += 3) {
              const i = (y * 96 + x) * 4;
              const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
              added.push({
                x: (x / 96 - 0.5) * 4,
                y: -(y / 72 - 0.5) * 3,
                z: -(lum / 255) * 3,
                r: d[i], g: d[i + 1], b: d[i + 2],
              });
            }
          }
        } catch { /* skip a photo we cannot read */ }
        done++;
        if (done === photos.length) {
          if (added.length) {
            this.addPoints(added);
            this.setStatus(`Added ${added.length.toLocaleString()} points from ${photos.length} photo(s).`);
          }
        }
      };
      img.onerror = () => {
        done++;
        if (done === photos.length && added.length) this.addPoints(added);
      };
      img.src = ph.dataUrl;
    });
  }

  /* ------------------------------------------------------------ markers */
  chooseKind(kindId) {
    this.placeKind = this.placeKind === kindId ? null : kindId;
    this.kindButtons.forEach((b, id) => b.classList.toggle("active", id === this.placeKind));
    if (this.placeHint) {
      this.placeHint.textContent = this.placeKind
        ? `Tap the model to place a ${markerKind(this.placeKind).label.toLowerCase()}.`
        : "Pick a marker type to start placing.";
    }
  }

  onCanvasTap(ev) {
    if (!this.placeKind || this.mode === "walk") return;
    const rect = this.viewCanvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);

    const targets = [];
    if (this.pointsObject) targets.push(this.pointsObject);
    if (this.roomGroup) targets.push(...this.roomGroup.children);
    if (!targets.length) return;
    const hits = this.raycaster.intersectObjects(targets, false);
    if (!hits.length) return;

    const pt = hits[0].point;
    const room = roomAt(this.rooms, pt.x, pt.z);
    this.openMarkerForm(this.placeKind, { x: pt.x, y: pt.y, z: pt.z }, room ? room.name : "");
  }

  openMarkerForm(kindId, pos, defaultRoom) {
    const k = markerKind(kindId);
    const body = el("div", "stack");
    body.appendChild(el("p", "muted sm", `${k.icon} ${k.label}`));

    const labelIn = el("input");
    labelIn.placeholder = "What is it? (e.g. Kitchen ceiling switch)";
    body.appendChild(this.field("Label", labelIn));

    const doesIn = el("textarea");
    doesIn.rows = 3;
    doesIn.placeholder = "What does it do? (e.g. controls the back porch light)";
    body.appendChild(this.field("What it does", doesIn));

    const roomIn = el("input");
    roomIn.value = defaultRoom || "";
    roomIn.placeholder = "Room";
    body.appendChild(this.field("Room", roomIn));

    const actions = el("div", "modal-actions");
    actions.appendChild(this.button("Cancel", "btn ghost", () => closeModal(m)));
    actions.appendChild(this.button("Add marker", "btn", () => {
      const label = labelIn.value.trim();
      if (!label) return toast("Give the marker a label", "bad");
      this.markers.push({
        id: uid(), kind: kindId, label,
        does: doesIn.value.trim(), room: roomIn.value.trim(),
        x: pos.x, y: pos.y, z: pos.z,
        createdAt: new Date().toISOString(),
      });
      closeModal(m);
      this.renderMarkers();
      this.refreshMarkerList();
      toast("Marker added", "good");
    }));
    body.appendChild(actions);

    const m = modal(`${k.label} marker`, body);
    openModal(m);
    labelIn.focus();
  }

  renderMarkers() {
    if (!this.markerGroup) return;
    while (this.markerGroup.children.length) {
      const ch = this.markerGroup.children.pop();
      if (ch.geometry) ch.geometry.dispose();
      if (ch.material) {
        if (ch.material.map) ch.material.map.dispose();
        ch.material.dispose();
      }
    }
    this.markers.forEach(mk => {
      const k = markerKind(mk.kind);
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.035, 12, 12),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(k.colour) })
      );
      dot.position.set(mk.x, mk.y, mk.z);
      this.markerGroup.add(dot);
      this.markerGroup.add(this.makeLabel(`${k.icon} ${mk.label}`, mk.x, mk.y + 0.15, mk.z, 0.62, k.colour));
    });
  }

  refreshMarkerList() {
    const list = this.markerList;
    if (!list) return;
    list.innerHTML = "";
    if (!this.markers.length) {
      list.appendChild(el("p", "muted sm", "No markers yet."));
      return;
    }
    this.markers.forEach(mk => {
      const k = markerKind(mk.kind);
      const row = el("div", "marker-row");
      const dot = el("span", "marker-dot");
      dot.style.background = k.colour;
      row.appendChild(dot);
      const info = el("div", "marker-info");
      info.appendChild(el("b", null, `${k.icon} ${mk.label}`));
      const bits = [k.label];
      if (mk.room) bits.push(mk.room);
      info.appendChild(el("span", "muted xs", bits.join(" \u00B7 ")));
      if (mk.does) info.appendChild(el("span", "muted sm", mk.does));
      row.appendChild(info);
      row.appendChild(this.button("Delete", "btn ghost sm danger", () => {
        if (!confirm(`Delete marker "${mk.label}"?`)) return;
        this.markers = this.markers.filter(x => x.id !== mk.id);
        this.renderMarkers(); this.refreshMarkerList();
      }));
      list.appendChild(row);
    });
  }

  /* --------------------------------------------------------- save / load */
  saveMesh() {
    if (!this.propertyId) return toast("Select a property first", "bad");
    if (!this.points.length && !this.rooms.length) return toast("Nothing to save yet", "bad");
    const name = (this.meshName || "").trim() || `Model ${new Date().toLocaleString()}`;
    Store.addMesh({
      userId: this.me.id,
      propertyId: this.propertyId,
      name, mode: this.scanMode,
      rooms: this.rooms.map(r => ({ ...r })),
      points: this.points.map(p => ({
        x: Math.round(p.x * 1000) / 1000,
        y: Math.round(p.y * 1000) / 1000,
        z: Math.round(p.z * 1000) / 1000,
        r: p.r, g: p.g, b: p.b,
      })),
      markers: this.markers.map(m => ({ ...m })),
    });
    toast("Model saved", "good");
    this.refreshMeshList();
  }

  refreshMeshList() {
    const list = this.meshList;
    if (!list) return;
    list.innerHTML = "";
    const meshes = this.propertyId ? Store.meshesFor(this.propertyId) : [];
    if (!meshes.length) {
      list.appendChild(el("p", "muted sm", "No saved models for this property yet."));
      return;
    }
    meshes.forEach(mesh => {
      const row = el("div", "mesh-saved-row");
      const info = el("div", "mesh-saved-info");
      info.appendChild(el("b", null, mesh.name));
      const bits = [];
      if ((mesh.rooms || []).length) bits.push(`${mesh.rooms.length} rooms`);
      if ((mesh.points || []).length) bits.push(`${mesh.points.length.toLocaleString()} points`);
      bits.push(`${(mesh.markers || []).length} markers`);
      bits.push(new Date(mesh.createdAt).toLocaleDateString());
      info.appendChild(el("span", "muted xs", bits.join(" \u00B7 ")));
      row.appendChild(info);

      const acts = el("div", "card-actions");
      acts.appendChild(this.button("Load", "btn ghost sm", () => this.loadMesh(mesh.id)));
      acts.appendChild(this.button("Delete", "btn ghost sm danger", () => {
        if (!confirm(`Delete "${mesh.name}"?`)) return;
        Store.deleteMesh(mesh.id);
        this.refreshMeshList();
      }));
      row.appendChild(acts);
      list.appendChild(row);
    });
  }

  loadMesh(meshId) {
    const mesh = Store.mesh(meshId);
    if (!mesh) return;
    this.points = (mesh.points || []).map(p => ({ ...p }));
    this.rooms = (mesh.rooms || []).map(r => ({ ...r }));
    this.markers = (mesh.markers || []).map(m => ({ ...m }));
    this.propertyId = mesh.propertyId;
    this.meshName = mesh.name;
    if (this.nameInput) this.nameInput.value = mesh.name;
    const sel = this.container.querySelector(".mesh-prop");
    if (sel) sel.value = mesh.propertyId;

    this.updatePointCloud();
    this.renderRooms();
    this.renderMarkers();
    this.refreshRoomList();
    this.refreshMarkerList();
    this.refreshMeshList();
    this.resetView();
    toast("Model loaded", "good");
  }

  resetView() {
    if (!this.camera) return;
    const c = modelCentre(this.rooms, this.points);
    const span = Math.max(5, ...this.rooms.map(r => Math.max(r.w, r.d) + 2));
    this.camera.position.set(c.x + span, c.y + span * 0.7, c.z + span);
    if (this.controls) {
      this.controls.target.set(c.x, c.y + 1, c.z);
      this.controls.update();
    }
    if (this.mode === "walk") {
      this.lookYaw = 0; this.lookPitch = 0; this.applyLook();
    }
  }

  /* ------------------------------------------------------------- export */
  download(format) {
    if (!this.points.length && !this.rooms.length) return;
    const ts = Date.now();
    let text, name, type = "text/plain";
    if (format === "obj") { text = this.toOBJ(); name = `habitat-model-${ts}.obj`; }
    else if (format === "gltf") { text = this.toGLTF(); name = `habitat-model-${ts}.gltf`; type = "model/gltf+json"; }
    else { text = this.toPLY(); name = `habitat-model-${ts}.ply`; }

    const blob = new Blob([text], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  toOBJ() {
    let s = "# Habitat 3D property model\n";
    s += `# ${this.rooms.length} rooms, ${this.points.length} points\n`;
    s += "o rooms\n";
    let base = 1;
    const emit = (arr) => {
      for (let i = 0; i < arr.length; i += 3) {
        s += `v ${arr[i].toFixed(4)} ${arr[i + 1].toFixed(4)} ${arr[i + 2].toFixed(4)}\n`;
      }
    };
    const tri = (n) => {
      let f = "";
      for (let i = 0; i < n; i += 3) f += `f ${base + i} ${base + i + 1} ${base + i + 2}\n`;
      base += n;
      return f;
    };
    this.rooms.forEach(room => {
      const surf = roomSurfaces(room, 0);
      emit(surf.floor); s += tri(surf.floor.length / 3);
      emit(surf.ceiling); s += tri(surf.ceiling.length / 3);
      const w = roomWalls(room);
      emit(w); s += tri(w.length / 3);
    });
    if (this.points.length) {
      s += "o pointcloud\n";
      for (const p of this.points) s += `v ${p.x.toFixed(4)} ${p.y.toFixed(4)} ${p.z.toFixed(4)}\n`;
    }
    return s;
  }

  toPLY() {
    let s = "ply\nformat ascii 1.0\n";
    s += `element vertex ${this.points.length}\n`;
    s += "property float x\nproperty float y\nproperty float z\n";
    s += "property uchar red\nproperty uchar green\nproperty uchar blue\n";
    s += "end_header\n";
    for (const p of this.points) {
      s += `${p.x.toFixed(4)} ${p.y.toFixed(4)} ${p.z.toFixed(4)} ${p.r || 190} ${p.g || 200} ${p.b || 195}\n`;
    }
    return s;
  }

  /** Minimal glTF 2.0 so the model can be opened in a VR app. */
  toGLTF() {
    const positions = [];
    const indices = [];
    let vi = 0;
    const pushTri = (arr) => {
      for (let i = 0; i < arr.length; i += 3) positions.push(arr[i], arr[i + 1], arr[i + 2]);
      for (let i = 0; i < arr.length / 3; i++) indices.push(vi + i);
      vi += arr.length / 3;
    };
    this.rooms.forEach(room => {
      const surf = roomSurfaces(room, 0);
      pushTri(surf.floor);
      pushTri(surf.ceiling);
      pushTri(roomWalls(room));
    });
    if (!positions.length) this.points.forEach(p => positions.push(p.x, p.y, p.z));

    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], positions[i + k]);
        max[k] = Math.max(max[k], positions[i + k]);
      }
    }
    const hasTris = positions.length > 0 && indices.length > 0;
    const accessors = [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: "VEC3", min, max }];
    const bufferViews = [{ buffer: 0, byteOffset: 0, byteLength: positions.length * 4, target: 34962 }];
    if (hasTris) {
      accessors.push({ bufferView: 1, componentType: 5125, count: indices.length, type: "SCALAR" });
      bufferViews.push({ buffer: 0, byteOffset: positions.length * 4, byteLength: indices.length * 4, target: 34963 });
    }
    const prim = { attributes: { POSITION: 0 }, mode: hasTris ? 4 : 0 };
    if (hasTris) prim.indices = 1;

    return JSON.stringify({
      asset: { version: "2.0", generator: "Habitat" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, name: "Property" }],
      meshes: [{ name: "Property", primitives: [prim] }],
      accessors,
      bufferViews,
      buffers: [{ byteLength: positions.length * 4 + indices.length * 4 }],
      extras: {
        habitat: {
          rooms: this.rooms,
          markers: this.markers.map(m => ({
            kind: m.kind, label: m.label, does: m.does, room: m.room, x: m.x, y: m.y, z: m.z,
          })),
        },
      },
    }, null, 1);
  }

  destroy() {
    this.destroyed = true;
    this.stopCamera();
    if (this.animationId) cancelAnimationFrame(this.animationId);
    if (this.resizeHandler) window.removeEventListener("resize", this.resizeHandler);
    if (this.renderer) {
      try { if (this.renderer.xr.isPresenting) this.renderer.xr.getSession().end(); } catch { /* ignore */ }
      this.renderer.setAnimationLoop(null);
      this.renderer.dispose();
      this.renderer = null;
    }
    if (this.pointsObject) {
      this.pointsObject.geometry.dispose();
      this.pointsObject.material.dispose();
    }
    this.scene = null; this.camera = null; this.controls = null;
  }
}

/* ---------------------------------------------- self-contained UI helpers */
function $(sel, root = document) { return root.querySelector(sel); }

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function uid() {
  return "r" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function toast(msg, kind = "info", ms = 2800) {
  let host = $(".toast-host");
  if (!host) { host = el("div", "toast-host"); document.body.appendChild(host); }
  const n = el("div", `toast ${kind}`);
  n.textContent = msg;
  host.appendChild(n);
  requestAnimationFrame(() => n.classList.add("in"));
  setTimeout(() => { n.classList.remove("in"); setTimeout(() => n.remove(), 300); }, ms);
}

function openModal(node) { node.hidden = false; document.body.style.overflow = "hidden"; }
function closeModal(node) { node.hidden = true; document.body.style.overflow = ""; }

function modal(title, bodyNode) {
  const m = el("div", "modal");
  m.hidden = true;
  const back = el("div", "modal-backdrop");
  back.onclick = () => closeModal(m);
  m.appendChild(back);
  const card = el("div", "modal-card");
  const x = el("button", "x", "\u00D7");
  x.onclick = () => closeModal(m);
  card.appendChild(x);
  if (title) card.appendChild(el("h3", null, title));
  card.appendChild(bodyNode);
  m.appendChild(card);
  document.body.appendChild(m);
  return m;
}

export function createMeshViewer(container, options) {
  const v = new MeshViewer(container, options);
  v.init();
  return v;
}
