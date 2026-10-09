/* Habitat — 3D property mesh + markers.
 *
 * Records a property's makeup as a 3D point-cloud mesh and lets you pin
 * markers onto it (light switches, outlets, shutoffs, fixtures) that say what
 * each one is and what it does.
 *
 * Two ways to build the mesh:
 *   1. Camera walkthrough — the device camera captures frames; frame
 *      differencing turns changed regions into points, and local texture
 *      variance supplies depth when the camera is nearly still.
 *   2. Photos — pick existing property photos and they are sampled into the
 *      same point cloud, so you get a mesh without holding the camera up.
 *
 * Markers are placed by tapping the mesh: the tap is raycast onto the point
 * cloud and the nearest point becomes the anchor.
 */
"use strict";

import { Store } from "./store.js";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

/* ------------------------------------------------------------- constants */
const MAX_POINTS = 60000;
const FRAME_INTERVAL = 120;
const PROC_WIDTH = 192;
const PROC_HEIGHT = 144;
const GRID_SIZE = 6;
const DEPTH_SCALE = 2.0;
const XY_SCALE = 2.0;
const POINT_SIZE = 0.02;

/* Marker kinds: what you would actually want to record in a house. */
export const MARKER_KINDS = [
  { id: "light_switch", label: "Light switch", icon: "💡", colour: "#fbbf24" },
  { id: "outlet", label: "Power outlet", icon: "🔌", colour: "#67e8f9" },
  { id: "breaker", label: "Breaker / panel", icon: "⚡", colour: "#f87171" },
  { id: "water_shutoff", label: "Water shutoff", icon: "🚰", colour: "#38bdf8" },
  { id: "gas_valve", label: "Gas valve", icon: "🔥", colour: "#fb923c" },
  { id: "thermostat", label: "Thermostat", icon: "🌡️", colour: "#a78bfa" },
  { id: "vent", label: "Vent / duct", icon: "🌀", colour: "#94a3b8" },
  { id: "appliance", label: "Appliance", icon: "🧺", colour: "#34d399" },
  { id: "fixture", label: "Light fixture", icon: "🔆", colour: "#fde047" },
  { id: "damage", label: "Damage / issue", icon: "⚠️", colour: "#ef4444" },
  { id: "note", label: "Note", icon: "📌", colour: "#8fa89a" },
];

export function markerKind(id) {
  return MARKER_KINDS.find(k => k.id === id) || MARKER_KINDS[MARKER_KINDS.length - 1];
}

/* ------------------------------------------------------ frame processing */
/** Turn two camera frames into coloured points. */
function processFrame(prev, curr, width, height) {
  const points = [];
  let totalDiff = 0;
  const pixelCount = curr.data.length / 4;

  for (let i = 0; i < curr.data.length; i += 4) {
    totalDiff += Math.abs(curr.data[i] - prev.data[i]) +
                 Math.abs(curr.data[i + 1] - prev.data[i + 1]) +
                 Math.abs(curr.data[i + 2] - prev.data[i + 2]);
  }
  const isMoving = (totalDiff / pixelCount) > 5;

  for (let gy = 0; gy < height; gy += GRID_SIZE) {
    for (let gx = 0; gx < width; gx += GRID_SIZE) {
      let diffSum = 0, rSum = 0, gSum = 0, bSum = 0, count = 0;
      let lumSum = 0, lumSqSum = 0;

      for (let y = gy; y < Math.min(gy + GRID_SIZE, height); y++) {
        for (let x = gx; x < Math.min(gx + GRID_SIZE, width); x++) {
          const i = (y * width + x) * 4;
          diffSum += Math.abs(curr.data[i] - prev.data[i]) +
                     Math.abs(curr.data[i + 1] - prev.data[i + 1]) +
                     Math.abs(curr.data[i + 2] - prev.data[i + 2]);
          rSum += curr.data[i]; gSum += curr.data[i + 1]; bSum += curr.data[i + 2];
          const lum = 0.299 * curr.data[i] + 0.587 * curr.data[i + 1] + 0.114 * curr.data[i + 2];
          lumSum += lum; lumSqSum += lum * lum;
          count++;
        }
      }
      if (!count) continue;

      const avgDiff = diffSum / (count * 3);
      const variance = Math.max(0, lumSqSum / count - (lumSum / count) ** 2);

      // moving: change magnitude is the depth proxy
      // still: local texture variance is the depth proxy
      let depth;
      if (isMoving) {
        if (avgDiff < 30) continue;
        depth = Math.min(avgDiff / 120, 1);
      } else {
        if (variance < 40) continue;
        depth = Math.min(variance / 900, 1);
      }

      const cx = (gx + GRID_SIZE / 2) / width - 0.5;
      const cy = (gy + GRID_SIZE / 2) / height - 0.5;

      points.push({
        x: (cx * XY_SCALE * (0.4 + depth)) + (Math.random() - 0.5) * 0.01,
        y: (-cy * XY_SCALE * (0.4 + depth)) + (Math.random() - 0.5) * 0.01,
        z: -(depth * DEPTH_SCALE) + (Math.random() - 0.5) * 0.01,
        r: Math.round(rSum / count),
        g: Math.round(gSum / count),
        b: Math.round(bSum / count),
      });
    }
  }
  return points;
}

/** Sample a still image (a property photo) into mesh points. */
function pointsFromImage(img, maxPoints = 9000) {
  const w = 128, h = 96;
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  let data;
  try { data = ctx.getImageData(0, 0, w, h).data; } catch { return []; }

  const raw = [];
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      raw.push({
        x: (x / w - 0.5) * XY_SCALE,
        y: -(y / h - 0.5) * XY_SCALE * 0.75,
        z: -(lum / 255) * DEPTH_SCALE,
        r, g, b,
      });
    }
  }
  if (raw.length <= maxPoints) return raw;
  const step = raw.length / maxPoints;
  const out = [];
  for (let i = 0; i < raw.length; i += step) out.push(raw[Math.floor(i)]);
  return out;
}

/** Export helpers */
function meshToOBJ(mesh) {
  let s = "# Habitat property mesh\n";
  s += `# ${mesh.points.length} points\n`;
  for (const p of mesh.points) {
    s += `v ${p.x.toFixed(4)} ${p.y.toFixed(4)} ${p.z.toFixed(4)}\n`;
  }
  return s;
}

function meshToPLY(mesh) {
  let s = "ply\nformat ascii 1.0\n";
  s += `element vertex ${mesh.points.length}\n`;
  s += "property float x\nproperty float y\nproperty float z\n";
  s += "property uchar red\nproperty uchar green\nproperty uchar blue\n";
  s += "end_header\n";
  for (const p of mesh.points) {
    s += `${p.x.toFixed(4)} ${p.y.toFixed(4)} ${p.z.toFixed(4)} ${p.r} ${p.g} ${p.b}\n`;
  }
  return s;
}

/* --------------------------------------------------------------- viewer */
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
    this.lastFrame = null;
    this.frameCount = 0;
    this.isScanning = false;

    this.points = [];
    this.markers = [];
    this.placeKind = null;      // marker kind currently being placed
    this.selectedMarker = null;

    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.pointsObject = null;
    this.markerGroup = null;
    this.raycaster = new THREE.Raycaster();
    this.animationId = null;
    this.destroyed = false;
    this.meshName = "";
    this.scanMode = "indoor";
  }

  async init() {
    this.buildUI();
    try {
      this.initThree();
    } catch (e) {
      console.error("mesh: three init failed", e);
      this.setStatus("WebGL is not available on this device.");
    }
    this.refreshMeshList();
    this.refreshMarkerList();
  }

  /* --------------------------------------------------------------- UI */
  buildUI() {
    const c = this.container;
    c.innerHTML = "";

    const head = el("div", "row-between");
    head.appendChild(el("h2", null, "3D Property Mesh"));
    c.appendChild(head);
    c.appendChild(el("p", "muted sm",
      "Record your house's makeup as a 3D mesh, then tap the mesh to pin what things are and what they do."));

    // --- controls
    const bar = el("div", "mesh-controls");

    const props = Store.propertiesFor(this.me);
    const propSel = el("select", "mesh-prop");
    propSel.appendChild(el("option", null, "Select a property"));
    propSel.firstChild.value = "";
    props.forEach(p => {
      const o = el("option", null, p.name);
      o.value = p.id;
      propSel.appendChild(o);
    });
    if (this.propertyId) propSel.value = this.propertyId;
    propSel.onchange = () => {
      this.propertyId = propSel.value || null;
      this.stopCamera();
      this.points = [];
      this.markers = [];
      this.updatePointCloud();
      this.refreshMeshList();
      this.refreshMarkerList();
      this.autoName();
    };
    bar.appendChild(this.field("Property", propSel));

    const modeSel = el("select");
    modeSel.appendChild(el("option", null, "Indoor"));
    modeSel.firstChild.value = "indoor";
    const outOpt = el("option", null, "Outdoor");
    outOpt.value = "outdoor";
    modeSel.appendChild(outOpt);
    modeSel.onchange = () => { this.scanMode = modeSel.value; };
    bar.appendChild(this.field("Mode", modeSel));

    const nameInput = el("input");
    nameInput.placeholder = "Mesh name";
    nameInput.oninput = () => { this.meshName = nameInput.value; };
    this.nameInput = nameInput;
    bar.appendChild(this.field("Name", nameInput));
    c.appendChild(bar);

    // --- main: camera + 3D view
    const main = el("div", "mesh-main");

    const camPanel = el("div", "mesh-cam-panel");
    const video = el("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
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
    overlay.appendChild(el("p", "muted sm", "No mesh yet — scan with the camera, or add property photos."));
    viewPanel.appendChild(overlay);
    this.overlay = overlay;

    main.appendChild(viewPanel);
    c.appendChild(main);

    // --- actions
    const actions = el("div", "mesh-actions");
    this.startBtn = this.button("Start camera scan", "btn", () => this.toggleCamera());
    actions.appendChild(this.startBtn);

    this.photosBtn = this.button("Add property photos", "btn ghost", () => this.addFromPhotos());
    actions.appendChild(this.photosBtn);

    this.saveBtn = this.button("Save mesh", "btn ghost", () => this.saveMesh());
    actions.appendChild(this.saveBtn);

    this.objBtn = this.button("OBJ", "btn ghost", () => this.download("obj"));
    actions.appendChild(this.objBtn);

    this.plyBtn = this.button("PLY", "btn ghost", () => this.download("ply"));
    actions.appendChild(this.plyBtn);

    this.clearBtn = this.button("Clear", "btn ghost danger", () => {
      if (!confirm("Clear the current mesh points?")) return;
      this.points = [];
      this.updatePointCloud();
    });
    actions.appendChild(this.clearBtn);

    this.resetBtn = this.button("Reset view", "btn ghost", () => this.resetView());
    actions.appendChild(this.resetBtn);

    c.appendChild(actions);

    // --- marker placement
    const mk = el("div", "card");
    mk.appendChild(el("h4", null, "Markers"));
    mk.appendChild(el("p", "muted sm",
      "Pick a type, then tap the mesh where it is. Markers record what the thing is and what it does."));

    const kindRow = el("div", "marker-kinds");
    this.kindButtons = new Map();
    MARKER_KINDS.forEach(k => {
      const b = el("button", "marker-kind");
      b.appendChild(el("span", null, k.icon));
      b.appendChild(el("span", null, k.label));
      b.style.borderColor = "transparent";
      b.onclick = () => this.chooseKind(k.id);
      this.kindButtons.set(k.id, b);
      kindRow.appendChild(b);
    });
    mk.appendChild(kindRow);

    const hint = el("p", "muted sm", "Pick a marker type to start placing.");
    this.placeHint = hint;
    mk.appendChild(hint);

    const markerList = el("div", "marker-list");
    this.markerList = markerList;
    mk.appendChild(markerList);

    c.appendChild(mk);

    // --- saved meshes
    c.appendChild(el("h3", null, "Saved meshes"));
    const meshList = el("div", "mesh-saved-list");
    this.meshList = meshList;
    c.appendChild(meshList);
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

  setStatus(msg) {
    if (this.statusEl) this.statusEl.textContent = msg || "";
  }

  autoName() {
    if (!this.propertyId) return;
    const p = Store.property(this.propertyId);
    if (!p) return;
    const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
    this.meshName = `${p.name} — ${ts}`;
    if (this.nameInput) this.nameInput.value = this.meshName;
  }

  /* ------------------------------------------------------------ three.js */
  initThree() {
    const test = document.createElement("canvas");
    const gl = test.getContext("webgl") || test.getContext("experimental-webgl");
    if (!gl) throw new Error("WebGL not supported");

    const canvas = this.viewCanvas;
    const w = canvas.parentElement.clientWidth || 600;
    const h = canvas.parentElement.clientHeight || 380;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x08110e);

    this.camera = new THREE.PerspectiveCamera(60, w / h, 0.01, 100);
    this.camera.position.set(0, 0.4, 3);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    const grid = new THREE.GridHelper(4, 20, 0x1e4232, 0x143026);
    grid.position.y = -1;
    this.scene.add(grid);

    this.markerGroup = new THREE.Group();
    this.scene.add(this.markerGroup);

    this.raycaster.params.Points.threshold = 0.05;

    // Tap the mesh to place a marker
    canvas.addEventListener("pointerdown", (ev) => this.onCanvasTap(ev));

    this.updatePointCloud();
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
    this.animationId = requestAnimationFrame(() => this.animate());
    if (this.controls) this.controls.update();
    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
  }

  updatePointCloud() {
    if (!this.scene) return;

    if (this.pointsObject) {
      this.scene.remove(this.pointsObject);
      this.pointsObject.geometry.dispose();
      this.pointsObject.material.dispose();
      this.pointsObject = null;
    }

    if (!this.points.length) {
      if (this.overlay) this.overlay.hidden = false;
      this.updateButtons();
      return;
    }
    if (this.overlay) this.overlay.hidden = true;

    const positions = new Float32Array(this.points.length * 3);
    const colors = new Float32Array(this.points.length * 3);
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
      colors[i * 3] = p.r / 255;
      colors[i * 3 + 1] = p.g / 255;
      colors[i * 3 + 2] = p.b / 255;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.PointsMaterial({
      size: POINT_SIZE, vertexColors: true, sizeAttenuation: true,
    });

    this.pointsObject = new THREE.Points(geo, mat);
    this.scene.add(this.pointsObject);
    this.updateButtons();
  }

  updateButtons() {
    const has = this.points.length > 0;
    [this.saveBtn, this.objBtn, this.plyBtn, this.clearBtn].forEach(b => { if (b) b.disabled = !has; });
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
    this.lastFrame = null;
    this.frameCount = 0;
    this.startBtn.textContent = "Stop camera scan";
    this.camPlaceholder.hidden = true;
    this.setStatus("Scanning…");

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

    if (this.lastFrame) {
      const pts = processFrame(this.lastFrame, frame, PROC_WIDTH, PROC_HEIGHT);
      if (pts.length) this.addPoints(pts);
    }
    this.lastFrame = frame;
    this.frameCount++;
    this.setStatus(`Scanning — ${this.frameCount} frames · ${this.points.length.toLocaleString()} points`);
  }

  addPoints(pts) {
    this.points.push(...pts);
    if (this.points.length > MAX_POINTS) {
      const ratio = MAX_POINTS / this.points.length;
      this.points = this.points.filter(() => Math.random() < ratio);
    }
    this.updatePointCloud();
  }

  /* ------------------------------------------- mesh from existing photos */
  addFromPhotos() {
    if (!this.propertyId) return this.setStatus("Select a property first.");
    const photos = Store.photosFor(this.propertyId);
    if (!photos.length) {
      return this.setStatus("No photos on this property yet — take some first, or use the camera scan.");
    }
    if (!confirm(`Add ${photos.length} property photo(s) to the mesh?`)) return;

    let done = 0;
    const added = [];
    photos.forEach(ph => {
      const img = new Image();
      img.onload = () => {
        added.push(...pointsFromImage(img));
        done++;
        if (done === photos.length) {
          this.addPoints(added);
          this.setStatus(`Added ${added.length.toLocaleString()} points from ${photos.length} photo(s).`);
        }
      };
      img.onerror = () => {
        done++;
        if (done === photos.length && added.length) this.addPoints(added);
      };
      img.src = ph.dataUrl;
    });
  }

  /* ------------------------------------------------------------- markers */
  chooseKind(kindId) {
    this.placeKind = this.placeKind === kindId ? null : kindId;
    this.kindButtons.forEach((b, id) => {
      b.classList.toggle("active", id === this.placeKind);
    });
    if (this.placeHint) {
      if (this.placeKind) {
        const k = markerKind(this.placeKind);
        this.placeHint.textContent = `Tap the mesh to place a ${k.label.toLowerCase()}.`;
      } else {
        this.placeHint.textContent = "Pick a marker type to start placing.";
      }
    }
  }

  onCanvasTap(ev) {
    if (!this.placeKind || !this.pointsObject) return;
    const rect = this.viewCanvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObject(this.pointsObject, false);
    if (!hits.length) return;

    const pt = hits[0].point;
    this.openMarkerForm(this.placeKind, { x: pt.x, y: pt.y, z: pt.z });
  }

  openMarkerForm(kindId, pos) {
    const k = markerKind(kindId);
    const body = el("div", "stack");

    const head = el("p", "muted sm", `${k.icon} ${k.label}`);
    body.appendChild(head);

    const labelIn = el("input");
    labelIn.placeholder = "What is it? (e.g. Kitchen ceiling switch)";
    const labelField = this.field("Label", labelIn);
    body.appendChild(labelField);

    const doesIn = el("textarea");
    doesIn.rows = 3;
    doesIn.placeholder = "What does it do? (e.g. controls the back porch light)";
    const doesField = this.field("What it does", doesIn);
    body.appendChild(doesField);

    const roomIn = el("input");
    roomIn.placeholder = "Room (optional)";
    body.appendChild(this.field("Room", roomIn));

    const actions = el("div", "modal-actions");
    const cancel = this.button("Cancel", "btn ghost", () => closeModal(m));
    const save = this.button("Add marker", "btn", () => {
      const label = labelIn.value.trim();
      if (!label) return toast("Give the marker a label", "bad");
      this.markers.push({
        id: uid(),
        kind: kindId,
        label,
        does: doesIn.value.trim(),
        room: roomIn.value.trim(),
        x: pos.x, y: pos.y, z: pos.z,
        createdAt: new Date().toISOString(),
      });
      closeModal(m);
      this.renderMarkers();
      this.refreshMarkerList();
      toast("Marker added", "good");
    });
    actions.appendChild(cancel);
    actions.appendChild(save);
    body.appendChild(actions);

    const m = modal(`${k.label} marker`, body);
    openModal(m);
    labelIn.focus();
  }

  /** Draw every marker as a coloured dot with a floating label. */
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
        new THREE.SphereGeometry(0.025, 12, 12),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(k.colour) })
      );
      dot.position.set(mk.x, mk.y, mk.z);
      this.markerGroup.add(dot);

      // floating label
      const cv = document.createElement("canvas");
      cv.width = 256; cv.height = 64;
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "rgba(8,17,14,.85)";
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.strokeStyle = k.colour;
      ctx.lineWidth = 3;
      ctx.strokeRect(1.5, 1.5, cv.width - 3, cv.height - 3);
      ctx.fillStyle = "#e8f0ec";
      ctx.font = "bold 26px system-ui, sans-serif";
      ctx.textBaseline = "middle";
      const text = mk.label.length > 16 ? mk.label.slice(0, 15) + "…" : mk.label;
      ctx.fillText(`${k.icon} ${text}`, 12, cv.height / 2);

      const tex = new THREE.CanvasTexture(cv);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
      sprite.position.set(mk.x, mk.y + 0.07, mk.z);
      sprite.scale.set(0.34, 0.085, 1);
      this.markerGroup.add(sprite);
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
      info.appendChild(el("span", "muted xs", bits.join(" · ")));
      if (mk.does) info.appendChild(el("span", "muted sm", mk.does));
      row.appendChild(info);

      const acts = el("div", "card-actions");
      acts.appendChild(this.button("Delete", "btn ghost sm danger", () => {
        if (!confirm(`Delete marker "${mk.label}"?`)) return;
        this.markers = this.markers.filter(x => x.id !== mk.id);
        this.renderMarkers();
        this.refreshMarkerList();
      }));
      row.appendChild(acts);
      list.appendChild(row);
    });
  }

  /* --------------------------------------------------------- save / load */
  saveMesh() {
    if (!this.propertyId) return toast("Select a property first", "bad");
    if (!this.points.length) return toast("Nothing to save yet", "bad");

    const name = (this.meshName || "").trim() || `Mesh ${new Date().toLocaleString()}`;
    Store.addMesh({
      userId: this.me.id,
      propertyId: this.propertyId,
      name,
      mode: this.scanMode,
      points: this.points.map(p => ({
        x: Math.round(p.x * 1000) / 1000,
        y: Math.round(p.y * 1000) / 1000,
        z: Math.round(p.z * 1000) / 1000,
        r: p.r, g: p.g, b: p.b,
      })),
      markers: this.markers.map(mk => ({ ...mk })),
    });

    toast("Mesh saved", "good");
    this.refreshMeshList();
  }

  refreshMeshList() {
    const list = this.meshList;
    if (!list) return;
    list.innerHTML = "";
    const meshes = this.propertyId ? Store.meshesFor(this.propertyId) : [];
    if (!meshes.length) {
      list.appendChild(el("p", "muted sm", "No saved meshes for this property yet."));
      return;
    }
    meshes.forEach(mesh => {
      const row = el("div", "mesh-saved-row");
      const info = el("div", "mesh-saved-info");
      info.appendChild(el("b", null, mesh.name));
      info.appendChild(el("span", "muted xs",
        `${mesh.points.length.toLocaleString()} points · ${(mesh.markers || []).length} markers · ${new Date(mesh.createdAt).toLocaleDateString()}`));
      row.appendChild(info);

      const acts = el("div", "card-actions");
      acts.appendChild(this.button("Load", "btn ghost sm", () => this.loadMesh(mesh.id)));
      acts.appendChild(this.button("Delete", "btn ghost sm danger", () => {
        if (!confirm(`Delete mesh "${mesh.name}"?`)) return;
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
    this.points = mesh.points.map(p => ({ ...p }));
    this.markers = (mesh.markers || []).map(mk => ({ ...mk }));
    this.propertyId = mesh.propertyId;
    this.meshName = mesh.name;
    if (this.nameInput) this.nameInput.value = mesh.name;

    const sel = this.container.querySelector(".mesh-prop");
    if (sel) sel.value = mesh.propertyId;

    this.updatePointCloud();
    this.renderMarkers();
    this.refreshMarkerList();
    this.refreshMeshList();
    toast("Mesh loaded", "good");
  }

  resetView() {
    if (!this.camera || !this.controls) return;
    this.camera.position.set(0, 0.4, 3);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  download(format) {
    if (!this.points.length) return;
    const ts = Date.now();
    const mesh = { points: this.points };
    let text, name;
    if (format === "obj") { text = meshToOBJ(mesh); name = `habitat-mesh-${ts}.obj`; }
    else { text = meshToPLY(mesh); name = `habitat-mesh-${ts}.ply`; }

    const blob = new Blob([text], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  destroy() {
    this.destroyed = true;
    this.stopCamera();
    if (this.animationId) cancelAnimationFrame(this.animationId);
    if (this.resizeHandler) window.removeEventListener("resize", this.resizeHandler);
    if (this.renderer) { this.renderer.dispose(); this.renderer = null; }
    if (this.pointsObject) {
      this.pointsObject.geometry.dispose();
      this.pointsObject.material.dispose();
    }
    this.scene = null; this.camera = null; this.controls = null;
  }
}

/* -------------------------------------------------- self-contained helpers */
/* This module is deliberately standalone: it does not import the UI helpers so
   it can be dropped into the app without touching app.js. */

function $(sel, root = document) { return root.querySelector(sel); }

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function uid() {
  return "m" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
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

export function createMeshViewer(container, options) {
  const v = new MeshViewer(container, options);
  v.init();
  return v;
}
