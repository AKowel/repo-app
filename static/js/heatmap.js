import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const doc = typeof document !== "undefined" ? document : null;
const layoutRoot        = doc?.getElementById("heatmapLayout")          || null;
const canvas            = doc?.getElementById("heatmapCanvas")          || null;
const modeSelect        = doc?.getElementById("heatmapModeSelect")      || null;
const clientSelect      = doc?.getElementById("heatmapClientSelect")    || null;
const dateField         = doc?.getElementById("heatmapDateField")       || null;
const dateSelect        = doc?.getElementById("heatmapDateSelect")      || null;
const metricSelect      = doc?.getElementById("heatmapMetricSelect")    || null;
const searchInput       = doc?.getElementById("heatmapSearchInput")     || null;
const pickedOnlyToggle  = doc?.getElementById("heatmapPickedOnly")      || null;
const occupiedOnlyToggle= doc?.getElementById("heatmapOccupiedOnly")    || null;
const cameraModeSelect  = doc?.getElementById("heatmapCameraModeSelect")|| null;
const colourModeSelect  = doc?.getElementById("heatmapColourModeSelect")|| null;
const levelMinInput     = doc?.getElementById("heatmapLevelMin")        || null;
const levelMaxInput     = doc?.getElementById("heatmapLevelMax")        || null;
const levelResetButton  = doc?.getElementById("heatmapLevelResetButton")|| null;
const resetCameraButton = doc?.getElementById("heatmapResetCameraButton")|| null;
const fullscreenButton  = doc?.getElementById("heatmapFullscreenButton")|| null;
const reloadButton      = doc?.getElementById("heatmapReloadButton")    || null;
const statusChip        = doc?.getElementById("heatmapStatusChip")      || null;
const dateChip          = doc?.getElementById("heatmapDateChip")        || null;
const snapshotStatusChip= doc?.getElementById("heatmapSnapshotStatusChip")|| null;
const locationChip      = doc?.getElementById("heatmapLocationChip")    || null;
const pickChip          = doc?.getElementById("heatmapPickChip")        || null;
const occupiedMetric    = doc?.getElementById("heatmapOccupiedMetric")  || null;
const pickedMetric      = doc?.getElementById("heatmapPickedMetric")    || null;
const snapshotInfo      = doc?.getElementById("heatmapSnapshotInfo")    || null;
const detailCard        = doc?.getElementById("heatmapDetailCard")      || null;
const detailHint        = doc?.getElementById("heatmapDetailHint")      || null;
const hotAislesWrap     = doc?.getElementById("heatmapHotAisles")       || null;
const sceneHint         = doc?.getElementById("heatmapSceneHint")       || null;
const legend            = doc?.querySelector(".heatmap-legend")          || null;
const legendBar         = doc?.querySelector(".heatmap-legend__bar")    || null;
const legendLabels      = Array.from(doc?.querySelectorAll(".heatmap-legend__labels span") || []);
const fpsOverlay        = doc?.getElementById("heatmapFpsOverlay")      || null;
const fpsModeChip       = doc?.getElementById("heatmapFpsModeChip")     || null;

// ── Catalog cache ─────────────────────────────────────────────────────────
const skuDetailCache = new Map();

async function fetchSkuDetail(sku) {
  if (!sku) return null;
  const key = `${getSelectedClient()}::${sku}`;
  if (skuDetailCache.has(key)) return skuDetailCache.get(key);
  try {
    const data = await apiFetch(`/api/catalog/sku/${encodeURIComponent(sku)}?client=${encodeURIComponent(getSelectedClient())}`);
    const detail = data.ok ? (data.sku || null) : null;
    skuDetailCache.set(key, detail);
    return detail;
  } catch {
    return null;
  }
}

function getSelectedClient() {
  return String(clientSelect?.value || "FANDMKET").trim().toUpperCase() || "FANDMKET";
}

// ── Scene settings (localStorage) ─────────────────────────────────────────────

const SETTINGS_STORAGE_KEY = "repo-app.heatmap.settings";
const SETTINGS_DEFAULTS = { rotateSpeed: 1.0, zoomSpeed: 1.0, panSpeed: 1.0, wasdSpeed: 1.0 };
let sceneSettings = { ...SETTINGS_DEFAULTS };

function loadSceneSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) sceneSettings = { ...SETTINGS_DEFAULTS, ...JSON.parse(raw) };
  } catch (_) {}
}

function saveSceneSettings() {
  try { localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(sceneSettings)); } catch (_) {}
}

function applyControlsSettings(controls) {
  if (!controls) return;
  controls.rotateSpeed = sceneSettings.rotateSpeed;
  controls.zoomSpeed   = sceneSettings.zoomSpeed;
  controls.panSpeed    = sceneSettings.panSpeed;
}

function applySceneSettings() {
  applyControlsSettings(sceneState.orbitControls);
  applyControlsSettings(sceneState.topControls);
}

const settingsPanel    = doc?.getElementById("heatmapSettingsPanel") || null;
const settingsButton   = doc?.getElementById("heatmapSettingsButton") || null;
const settingsClose    = doc?.getElementById("heatmapSettingsClose")  || null;
const settingsReset    = doc?.getElementById("heatmapSettingsReset")  || null;
const rotateSpeedInput = doc?.getElementById("rotateSpeedInput")      || null;
const zoomSpeedInput   = doc?.getElementById("zoomSpeedInput")        || null;
const panSpeedInput    = doc?.getElementById("panSpeedInput")         || null;
const wasdSpeedInput   = doc?.getElementById("wasdSpeedInput")        || null;
const rotateSpeedLabel = doc?.getElementById("rotateSpeedLabel")      || null;
const zoomSpeedLabel   = doc?.getElementById("zoomSpeedLabel")        || null;
const panSpeedLabel    = doc?.getElementById("panSpeedLabel")         || null;
const wasdSpeedLabel   = doc?.getElementById("wasdSpeedLabel")        || null;

function syncSettingsPanel() {
  if (rotateSpeedInput) rotateSpeedInput.value = String(sceneSettings.rotateSpeed);
  if (zoomSpeedInput)   zoomSpeedInput.value   = String(sceneSettings.zoomSpeed);
  if (panSpeedInput)    panSpeedInput.value     = String(sceneSettings.panSpeed);
  if (wasdSpeedInput)   wasdSpeedInput.value    = String(sceneSettings.wasdSpeed);
  if (rotateSpeedLabel) rotateSpeedLabel.textContent = sceneSettings.rotateSpeed.toFixed(1);
  if (zoomSpeedLabel)   zoomSpeedLabel.textContent   = sceneSettings.zoomSpeed.toFixed(1);
  if (panSpeedLabel)    panSpeedLabel.textContent     = sceneSettings.panSpeed.toFixed(1);
  if (wasdSpeedLabel)   wasdSpeedLabel.textContent    = sceneSettings.wasdSpeed.toFixed(1) + "×";
}

function wireSettingsPanel() {
  settingsButton?.addEventListener("click", () => {
    if (settingsPanel) settingsPanel.hidden = !settingsPanel.hidden;
  });
  settingsClose?.addEventListener("click", () => {
    if (settingsPanel) settingsPanel.hidden = true;
  });
  settingsReset?.addEventListener("click", () => {
    sceneSettings = { ...SETTINGS_DEFAULTS };
    syncSettingsPanel();
    applySceneSettings();
    saveSceneSettings();
  });

  function makeSliderHandler(inputEl, labelEl, key, suffix) {
    if (!inputEl) return;
    inputEl.addEventListener("input", () => {
      const val = parseFloat(inputEl.value) || SETTINGS_DEFAULTS[key];
      sceneSettings[key] = val;
      if (labelEl) labelEl.textContent = val.toFixed(1) + (suffix || "");
      applySceneSettings();
      saveSceneSettings();
    });
  }

  makeSliderHandler(rotateSpeedInput, rotateSpeedLabel, "rotateSpeed", "");
  makeSliderHandler(zoomSpeedInput,   zoomSpeedLabel,   "zoomSpeed",   "");
  makeSliderHandler(panSpeedInput,    panSpeedLabel,    "panSpeed",    "");
  makeSliderHandler(wasdSpeedInput,   wasdSpeedLabel,   "wasdSpeed",   "×");
}

// ── Constants ────────────────────────────────────────────────────────────────

const BAY_STEP    = 2.6;
const AISLE_HALF  = 1.5;
const SHELF_GAP   = 0.03;
const CAMERA_MODES = new Set(["orbit", "top", "fps"]);
const COLOUR_MODES = new Set(["heatmap", "binsize", "zone", "level"]);

const state = {
  heatmap: null,
  rows: [],
  selectedLocation: "",
  sceneRows: [],
  aisleCoords: new Map(),
  isFullscreen: false,
  cameraMode: CAMERA_MODES.has(cameraModeSelect?.value) ? cameraModeSelect.value : "orbit",
  colourMode: COLOUR_MODES.has(colourModeSelect?.value) ? colourModeSelect.value : "heatmap"
};

const sceneState = {
  renderer: null,
  scene: null,
  camera: null,
  controls: null,
  perspCamera: null,
  topCamera: null,
  fpsCamera: null,
  orbitControls: null,
  topControls: null,
  rackMesh: null,
  raycaster: new THREE.Raycaster(),
  pointer: new THREE.Vector2(),
  selectionBox: null,
  labelGroup: null,
  floorGroup: null,
  movementKeys: new Set(),
  lastFrameAt: 0,
  fpsYaw: 0,
  fpsPitch: 0,
  fpsEditMode: false,
  hasFittedScene: false
};

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function apiFetch(url) {
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function setStatus(message, type) {
  if (!statusChip) return;
  statusChip.textContent = message || "Ready";
  statusChip.className = "chip" + (type === "ok" ? " chip--success" : "");
}

function isFullscreenActive() {
  return Boolean(layoutRoot && document.fullscreenElement === layoutRoot);
}

function isEditableElement(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName);
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function mmToM(value) { return Number(value) > 10 ? Number(value) / 1000 : Number(value); }
function normalizeCameraMode(value) { return CAMERA_MODES.has(value) ? value : "orbit"; }
function normalizeColourMode(value) { return COLOUR_MODES.has(value) ? value : "heatmap"; }

function getActiveSourceRows() {
  return Array.isArray(state.heatmap?.rows) ? state.heatmap.rows : [];
}

function getLevelNumber(row) {
  return Number.parseInt(row?.level || row?.location?.slice(4, 6) || "0", 10) || 0;
}

function getLevelBounds() {
  const minValue = Number.parseInt(levelMinInput?.value || "", 10);
  const maxValue = Number.parseInt(levelMaxInput?.value || "", 10);
  const hasMin = Number.isFinite(minValue);
  const hasMax = Number.isFinite(maxValue);
  if (!hasMin && !hasMax) return { min: null, max: null };
  let min = hasMin ? minValue : null;
  let max = hasMax ? maxValue : null;
  if (min != null && max != null && min > max) [min, max] = [max, min];
  return { min, max };
}

function buildAisleCoords(layout, rows, overrides) {
  const zoneOverrides  = overrides?.zones  || {};
  const aisleOverrides = overrides?.aisles || {};

  const aisleStats = new Map();
  for (const row of rows || []) {
    const prefix = String(row.aisle_prefix || "").trim().toUpperCase();
    if (!prefix) continue;
    const current = aisleStats.get(prefix) || { maxBay: 0 };
    current.maxBay = Math.max(current.maxBay, Number.parseInt(row.bay || "0", 10) || 0);
    aisleStats.set(prefix, current);
  }

  const coords = new Map();
  let zoneOffsetX = 0;
  const aisleSpacing = 5.2;
  const zoneGap = 16;

  for (const [zoneIndex, zone] of (layout?.zones || []).entries()) {
    const zoneKey = zone.zone_key || "";
    const zoneOvr = zoneOverrides[zoneKey] || {};
    if (zoneOvr.active === false) continue;

    const allAisles = zone?.aisles || [];
    const aisles = allAisles.filter(a => (aisleOverrides[a.prefix] || {}).active !== false);

    const xOffset    = Number(zoneOvr.x_offset  || 0);
    const zOffset    = Number(zoneOvr.z_offset   || 0);
    const rotY       = Number(zoneOvr.rotation_y || 0);
    const zoneStartX = zoneOffsetX + xOffset;
    let zoneMaxBay   = 0;

    aisles.forEach((aisle, aisleIndex) => {
      const prefix = aisle.prefix;
      const maxBay = Math.max(20, aisleStats.get(prefix)?.maxBay || 20);
      zoneMaxBay = Math.max(zoneMaxBay, maxBay);
      coords.set(prefix, {
        x: zoneStartX + aisleIndex * aisleSpacing,
        z_origin: zOffset,
        rotation_y: rotY,
        reverse_bay_dir: !!(zoneOvr.reverse_bay_dir || (aisleOverrides[prefix] || {}).reverse_bay_dir),
        zoneIndex,
        zoneKey,
        zoneLabel: zone.zone_label || ""
      });
    });

    const zoneWidth = Math.max(aisles.length - 1, 0) * aisleSpacing + 4;
    zone.layout = {
      x: zoneStartX + zoneWidth / 2 - 2,
      width: zoneWidth,
      depth: Math.max(26, Math.ceil(zoneMaxBay / 2) * 2.4 + 8),
      z_offset: zOffset,
      rotation_y: rotY
    };
    zoneOffsetX += aisles.length * aisleSpacing + zoneGap;
  }

  return coords;
}

function metricValue(row, metricKey) {
  if (metricKey === "pick_qty") return Number(row.pick_qty || 0);
  return Number(row.pick_count || 0);
}

function getCubeSize(row, binSizes, locOverride = {}) {
  const effectiveCode = String(locOverride.bin_size_override || row.bin_size || "").trim().toUpperCase();
  const dims = effectiveCode && binSizes?.[effectiveCode] ? binSizes[effectiveCode] : null;
  return {
    code: effectiveCode,
    w: mmToM(dims?.width  ?? 1050),
    h: mmToM(dims?.height ?? 1050),
    d: mmToM(dims?.depth  ?? 800)
  };
}

function heatColor(row, metricKey, maxMetric) {
  const metric = metricValue(row, metricKey);
  if (metric <= 0) return new THREE.Color(row.sku ? "#567180" : "#2b3742");
  const ratio = Math.min(1, metric / Math.max(1, maxMetric));
  return new THREE.Color().setHSL(0.62 - ratio * 0.62, 0.85, 0.42 + ratio * 0.14);
}

function buildCategoryColorMap(values, saturation = 0.62, lightness = 0.5) {
  const unique = [...new Set((values || []).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
  const colorMap = new Map();
  unique.forEach((value, index) => {
    const hue = unique.length <= 1 ? 0.58 : index / unique.length;
    colorMap.set(value, new THREE.Color().setHSL(hue, saturation, lightness));
  });
  return colorMap;
}

function buildColourContext(sceneRows, overrides) {
  const allRows = state.heatmap?.rows || [];
  const locationOverrides = overrides?.locations || {};
  const levelValues = sceneRows.map(row => row._levelValue);
  return {
    maxMetric: sceneRows.reduce((max, row) => Math.max(max, metricValue(row, metricSelect?.value || "pick_count")), 0),
    binSizeColors: buildCategoryColorMap(allRows.map(row =>
      String(locationOverrides[row.location]?.bin_size_override || row.bin_size || "").trim().toUpperCase()
    )),
    zoneColors: buildCategoryColorMap(allRows.map(row => row.zone_key || "")),
    levelMin: levelValues.length ? Math.min(...levelValues) : 0,
    levelMax: levelValues.length ? Math.max(...levelValues) : 1
  };
}

function getSceneColor(row, colourContext) {
  if (state.colourMode === "binsize") {
    return colourContext.binSizeColors.get(row._effectiveBinSize) || new THREE.Color("#4f6b85");
  }
  if (state.colourMode === "zone") {
    return colourContext.zoneColors.get(row._zoneKey || row.zone_key || "") || new THREE.Color("#44638a");
  }
  if (state.colourMode === "level") {
    const span  = Math.max(1, colourContext.levelMax - colourContext.levelMin);
    const ratio = clamp((row._levelValue - colourContext.levelMin) / span, 0, 1);
    return new THREE.Color().setHSL(0.66 - ratio * 0.66, 0.68, 0.46);
  }
  return heatColor(row, metricSelect?.value || "pick_count", colourContext.maxMetric);
}

function disposeMaterial(material) {
  if (Array.isArray(material)) { material.forEach(disposeMaterial); return; }
  if (material?.map) material.map.dispose();
  material?.dispose?.();
}

function disposeObject3D(object) {
  object?.traverse?.(child => {
    child.geometry?.dispose?.();
    if (child.material) disposeMaterial(child.material);
  });
}

function clearGroup(group) {
  if (!group) return;
  for (const child of [...group.children]) { group.remove(child); disposeObject3D(child); }
}

function updateLegend() {
  if (!legend || !legendBar || legendLabels.length < 3) return;
  legend.hidden = false;
  if (state.colourMode === "level") {
    legendBar.style.background = "linear-gradient(90deg, #3d6fcf 0%, #56c6f0 50%, #eb5a46 100%)";
    legendLabels[0].textContent = "Low"; legendLabels[1].textContent = "Mid"; legendLabels[2].textContent = "High";
    return;
  }
  if (state.colourMode === "binsize") {
    legendBar.style.background = "repeating-linear-gradient(90deg, #4ac0c0 0 18px, #4f7bdc 18px 36px, #8b5ee8 36px 54px, #f0a03c 54px 72px, #e75c56 72px 90px)";
    legendLabels[0].textContent = "Bin"; legendLabels[1].textContent = "Size"; legendLabels[2].textContent = "Groups";
    return;
  }
  if (state.colourMode === "zone") {
    legendBar.style.background = "repeating-linear-gradient(90deg, #3fb878 0 24px, #3d6fcf 24px 48px, #a562d6 48px 72px, #f0b24a 72px 96px)";
    legendLabels[0].textContent = "Zone"; legendLabels[1].textContent = "Colour"; legendLabels[2].textContent = "Map";
    return;
  }
  legendBar.style.background = "linear-gradient(90deg, #3d6fcf 0%, #4fd0c3 45%, #f7c948 74%, #eb5a46 100%)";
  legendLabels[0].textContent = "Cool"; legendLabels[1].textContent = "Warm"; legendLabels[2].textContent = "Hot";
}

function updateSceneModeUi() {
  if (cameraModeSelect) cameraModeSelect.value = state.cameraMode;
  if (colourModeSelect) colourModeSelect.value = state.colourMode;
  if (sceneHint) {
    const title = sceneHint.querySelector("strong");
    const body  = sceneHint.querySelector("span");
    if (state.cameraMode === "top") {
      if (title) title.textContent = "Top-down controls";
      if (body)  body.innerHTML = "Drag to pan, scroll to zoom, use the level filter to isolate floor ranges.";
    } else if (state.cameraMode === "fps") {
      if (title) title.textContent = "FPS controls";
      if (body)  body.innerHTML = sceneState.fpsEditMode
        ? "<code>W A S D</code> move, <code>E</code>/<code>C</code> up-down, <code>Tab</code> resumes mouse look."
        : "<code>W A S D</code> move, mouse look, <code>E</code>/<code>C</code> up-down, <code>Tab</code> edit mode.";
    } else {
      if (title) title.textContent = "Perspective controls";
      if (body)  body.innerHTML = "<code>W A S D</code> pan in full screen, mouse drag orbits, scroll zooms, <code>Esc</code> exits.";
    }
  }
  if (fpsOverlay) fpsOverlay.hidden = state.cameraMode !== "fps";
  if (fpsModeChip) fpsModeChip.textContent = sceneState.fpsEditMode ? "FPS Edit Mode" : "FPS Look Mode";
}

function makeTextSprite(label) {
  const canvasEl = document.createElement("canvas");
  canvasEl.width = 256; canvasEl.height = 96;
  const ctx = canvasEl.getContext("2d");
  ctx.fillStyle = "rgba(12, 20, 35, 0.82)"; ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);
  ctx.strokeStyle = "rgba(136, 173, 255, 0.85)"; ctx.lineWidth = 3;
  ctx.strokeRect(3, 3, canvasEl.width - 6, canvasEl.height - 6);
  ctx.fillStyle = "#f4f7ff"; ctx.font = "700 42px Georgia";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(label, canvasEl.width / 2, canvasEl.height / 2);
  const texture  = new THREE.CanvasTexture(canvasEl);
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite   = new THREE.Sprite(material);
  sprite.scale.set(6, 2.25, 1);
  return sprite;
}

function updateTopCameraFrustum(width, height) {
  if (!sceneState.topCamera) return;
  const zoom = sceneState.topCamera.zoom || 1;
  sceneState.topCamera.left   = width  / -2 / zoom;
  sceneState.topCamera.right  = width  /  2 / zoom;
  sceneState.topCamera.top    = height /  2 / zoom;
  sceneState.topCamera.bottom = height / -2 / zoom;
  sceneState.topCamera.updateProjectionMatrix();
}

function syncFpsRotation() {
  if (!sceneState.fpsCamera) return;
  sceneState.fpsCamera.rotation.order = "YXZ";
  sceneState.fpsCamera.rotation.y = sceneState.fpsYaw;
  sceneState.fpsCamera.rotation.x = sceneState.fpsPitch;
}

function requestFpsPointerLock() {
  if (!canvas || state.cameraMode !== "fps" || sceneState.fpsEditMode) return;
  try { canvas.requestPointerLock(); } catch (_) {}
}

function initScene() {
  if (sceneState.renderer || !canvas) return;
  const width  = canvas.clientWidth  || canvas.parentElement.clientWidth || 1200;
  const height = canvas.clientHeight || 620;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#0b1523");
  scene.fog = new THREE.Fog("#0b1523", 55, 220);

  const perspCamera = new THREE.PerspectiveCamera(52, width / height, 0.1, 1000);
  perspCamera.position.set(38, 42, 58);

  const topCamera = new THREE.OrthographicCamera(width / -2, width / 2, height / 2, height / -2, 0.1, 1200);
  topCamera.position.set(0, 260, 0);
  topCamera.up.set(0, 0, -1);
  topCamera.lookAt(0, 0, 0);
  topCamera.zoom = 2.2;
  updateTopCameraFrustum(width, height);

  const fpsCamera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
  fpsCamera.position.copy(perspCamera.position);
  fpsCamera.rotation.order = "YXZ";

  const orbitControls = new OrbitControls(perspCamera, renderer.domElement);
  orbitControls.enableDamping = true;
  orbitControls.dampingFactor = 0.08;
  orbitControls.maxPolarAngle = Math.PI / 2.1;
  orbitControls.minDistance   = 12;
  orbitControls.maxDistance   = 250;

  const topControls = new OrbitControls(topCamera, renderer.domElement);
  topControls.enableDamping      = true;
  topControls.enableRotate       = false;
  topControls.screenSpacePanning = true;
  topControls.minZoom = 0.25;
  topControls.maxZoom = 16;
  topControls.mouseButtons.LEFT  = THREE.MOUSE.PAN;
  topControls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
  topControls.target.set(0, 0, 0);
  topControls.enabled = false;

  scene.add(new THREE.AmbientLight("#dce6ff", 1.15));
  const keyLight = new THREE.DirectionalLight("#ffffff", 1.15);
  keyLight.position.set(40, 80, 40);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight("#7ab4ff", 0.55);
  fillLight.position.set(-45, 35, -20);
  scene.add(fillLight);

  const grid = new THREE.GridHelper(280, 80, "#24405d", "#162536");
  grid.position.y = -0.1;
  scene.add(grid);

  const selectionBox = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: "#ffffff", wireframe: true })
  );
  selectionBox.visible = false;
  scene.add(selectionBox);

  const labelGroup = new THREE.Group();
  scene.add(labelGroup);
  const floorGroup = new THREE.Group();
  scene.add(floorGroup);

  renderer.domElement.addEventListener("click", handleSceneClick);
  window.addEventListener("resize", resizeScene);
  document.addEventListener("pointerlockchange", () => {
    if (state.cameraMode !== "fps") return;
    if (document.pointerLockElement === canvas) {
      sceneState.fpsEditMode = false;
    } else {
      sceneState.fpsEditMode = true;
      sceneState.movementKeys.clear();
    }
    updateSceneModeUi();
  });
  document.addEventListener("mousemove", event => {
    if (state.cameraMode !== "fps" || sceneState.fpsEditMode || document.pointerLockElement !== canvas) return;
    sceneState.fpsYaw   -= event.movementX * 0.0022;
    sceneState.fpsPitch  = clamp(sceneState.fpsPitch - event.movementY * 0.0018, -Math.PI / 2.1, Math.PI / 2.1);
    syncFpsRotation();
  });

  sceneState.renderer     = renderer;
  sceneState.scene        = scene;
  sceneState.camera       = perspCamera;
  sceneState.controls     = orbitControls;
  sceneState.perspCamera  = perspCamera;
  sceneState.topCamera    = topCamera;
  sceneState.fpsCamera    = fpsCamera;
  sceneState.orbitControls = orbitControls;
  sceneState.topControls  = topControls;
  sceneState.selectionBox = selectionBox;
  sceneState.labelGroup   = labelGroup;
  sceneState.floorGroup   = floorGroup;

  applySceneSettings();
  updateLegend();
  setCameraMode(state.cameraMode);
  animate();
}

function resizeScene() {
  if (!sceneState.renderer || !canvas) return;
  const width  = canvas.clientWidth  || canvas.parentElement.clientWidth || 1200;
  const height = canvas.clientHeight || 620;
  sceneState.renderer.setSize(width, height, false);
  if (sceneState.perspCamera) { sceneState.perspCamera.aspect = width / height; sceneState.perspCamera.updateProjectionMatrix(); }
  if (sceneState.fpsCamera)   { sceneState.fpsCamera.aspect  = width / height; sceneState.fpsCamera.updateProjectionMatrix(); }
  updateTopCameraFrustum(width, height);
}

function syncOrbitCameraFromFps() {
  if (!sceneState.fpsCamera || !sceneState.perspCamera || !sceneState.orbitControls) return;
  const forward = new THREE.Vector3();
  sceneState.fpsCamera.getWorldDirection(forward);
  const target = sceneState.fpsCamera.position.clone().add(forward.multiplyScalar(18));
  sceneState.perspCamera.position.copy(sceneState.fpsCamera.position);
  sceneState.orbitControls.target.copy(target);
  sceneState.perspCamera.lookAt(target);
  sceneState.orbitControls.update();
}

function syncFpsCameraFromOrbit() {
  if (!sceneState.fpsCamera || !sceneState.perspCamera || !sceneState.orbitControls) return;
  const target = sceneState.orbitControls.target.clone();
  sceneState.fpsCamera.position.copy(sceneState.perspCamera.position);
  sceneState.fpsCamera.lookAt(target);
  const euler = new THREE.Euler().setFromQuaternion(sceneState.fpsCamera.quaternion, "YXZ");
  sceneState.fpsYaw   = euler.y;
  sceneState.fpsPitch = euler.x;
  syncFpsRotation();
}

function setCameraMode(mode) {
  const nextMode = normalizeCameraMode(mode);
  if (state.cameraMode === "fps" && nextMode !== "fps") {
    syncOrbitCameraFromFps();
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    sceneState.fpsEditMode = false;
  }

  state.cameraMode = nextMode;

  if (nextMode === "top") {
    sceneState.camera   = sceneState.topCamera;
    sceneState.controls = sceneState.topControls;
    if (sceneState.orbitControls) sceneState.orbitControls.enabled = false;
    if (sceneState.topControls)   sceneState.topControls.enabled   = true;
  } else if (nextMode === "fps") {
    syncFpsCameraFromOrbit();
    sceneState.camera   = sceneState.fpsCamera;
    sceneState.controls = null;
    if (sceneState.orbitControls) sceneState.orbitControls.enabled = false;
    if (sceneState.topControls)   sceneState.topControls.enabled   = false;
    sceneState.fpsEditMode = false;
    requestFpsPointerLock();
  } else {
    sceneState.camera   = sceneState.perspCamera;
    sceneState.controls = sceneState.orbitControls;
    if (sceneState.orbitControls) sceneState.orbitControls.enabled = true;
    if (sceneState.topControls)   sceneState.topControls.enabled   = false;
  }

  updateSceneModeUi();
}

function updateKeyboardMovement(deltaSeconds) {
  if (!sceneState.camera || !sceneState.movementKeys.size || isEditableElement(document.activeElement)) return;

  if (state.cameraMode === "fps") {
    const forward = new THREE.Vector3();
    sceneState.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() > 0) forward.normalize(); else forward.set(0, 0, -1);
    const right    = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const movement = new THREE.Vector3();
    if (sceneState.movementKeys.has("KeyW")) movement.add(forward);
    if (sceneState.movementKeys.has("KeyS")) movement.sub(forward);
    if (sceneState.movementKeys.has("KeyD")) movement.add(right);
    if (sceneState.movementKeys.has("KeyA")) movement.sub(right);
    if (sceneState.movementKeys.has("KeyE")) movement.y += 1;
    if (sceneState.movementKeys.has("KeyC")) movement.y -= 1;
    if (movement.lengthSq() === 0) return;
    movement.normalize().multiplyScalar(Math.max(3, 10 * deltaSeconds) * sceneSettings.wasdSpeed);
    sceneState.camera.position.add(movement);
    return;
  }

  if (!sceneState.controls || !isFullscreenActive()) return;

  if (state.cameraMode === "top") {
    const movement = new THREE.Vector3();
    if (sceneState.movementKeys.has("KeyW")) movement.z -= 1;
    if (sceneState.movementKeys.has("KeyS")) movement.z += 1;
    if (sceneState.movementKeys.has("KeyD")) movement.x += 1;
    if (sceneState.movementKeys.has("KeyA")) movement.x -= 1;
    if (movement.lengthSq() === 0) return;
    movement.normalize().multiplyScalar(Math.max(6, 18 * deltaSeconds) * sceneSettings.wasdSpeed);
    sceneState.topCamera.position.add(movement);
    sceneState.topControls.target.add(movement);
    return;
  }

  const forward = new THREE.Vector3();
  sceneState.camera.getWorldDirection(forward);
  forward.y = 0;
  if (forward.lengthSq() === 0) return;
  forward.normalize();
  const right    = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
  const movement = new THREE.Vector3();
  if (sceneState.movementKeys.has("KeyW")) movement.add(forward);
  if (sceneState.movementKeys.has("KeyS")) movement.sub(forward);
  if (sceneState.movementKeys.has("KeyD")) movement.add(right);
  if (sceneState.movementKeys.has("KeyA")) movement.sub(right);
  if (movement.lengthSq() === 0) return;
  movement.normalize().multiplyScalar(Math.max(8, 18 * deltaSeconds) * sceneSettings.wasdSpeed);
  sceneState.camera.position.add(movement);
  sceneState.controls.target.add(movement);
}

function animate(frameAt = 0) {
  requestAnimationFrame(animate);
  if (!sceneState.renderer) return;
  const now          = frameAt || performance.now();
  const previous     = sceneState.lastFrameAt || now;
  const deltaSeconds = Math.min(0.08, Math.max(0.001, (now - previous) / 1000));
  sceneState.lastFrameAt = now;
  updateKeyboardMovement(deltaSeconds);
  sceneState.orbitControls?.update();
  sceneState.topControls?.update();
  sceneState.renderer.render(sceneState.scene, sceneState.camera);
}

function clearSceneContent() {
  if (sceneState.rackMesh) {
    sceneState.scene.remove(sceneState.rackMesh);
    sceneState.rackMesh.geometry.dispose();
    disposeMaterial(sceneState.rackMesh.material);
    sceneState.rackMesh = null;
  }
  clearGroup(sceneState.labelGroup);
  clearGroup(sceneState.floorGroup);
  if (sceneState.selectionBox) sceneState.selectionBox.visible = false;
  state.sceneRows = [];
}

function buildSceneRows(rows, layout, overrides) {
  const allRows           = state.heatmap?.rows || rows || [];
  const coords            = buildAisleCoords(layout, allRows, overrides);
  const binSizes          = state.heatmap?.bin_sizes || {};
  const locationOverrides = overrides?.locations || {};
  const bayOverrides      = overrides?.bays      || {};
  const levelSlotInfo     = new Map();
  const bayLevels         = new Map();
  state.aisleCoords = coords;

  rows.forEach(row => {
    const prefix      = String(row.aisle_prefix || row.location?.slice(0, 2) || "").trim().toUpperCase();
    const bayNumber   = Number.parseInt(row.bay   || "0", 10) || 0;
    const levelNumber = getLevelNumber(row);
    const slotNumber  = Number.parseInt(row.slot  || "1", 10) || 1;
    const bayKey      = `${prefix}${String(bayNumber).padStart(2, "0")}`;
    const levelKey    = `${bayKey}L${levelNumber}`;
    const cube        = getCubeSize(row, binSizes, locationOverrides[row.location] || {});
    const current     = levelSlotInfo.get(levelKey);
    if (!current) {
      levelSlotInfo.set(levelKey, { maxSlot: slotNumber, h: cube.h });
    } else {
      if (slotNumber > current.maxSlot) current.maxSlot = slotNumber;
      if (cube.h > current.h) current.h = cube.h;
    }
    if (!bayLevels.has(bayKey)) bayLevels.set(bayKey, new Set());
    bayLevels.get(bayKey).add(levelNumber);
  });

  const levelBaseY     = new Map();
  const levelHeightMap = new Map();

  bayLevels.forEach((levelsSet, bayKey) => {
    const levels         = [...levelsSet].sort((a, b) => a - b);
    const bayOverride    = bayOverrides[bayKey] || {};
    const customHeights  = Array.isArray(bayOverride.level_heights) ? bayOverride.level_heights : [];
    let cumulativeHeight = 0;
    levels.forEach(levelNumber => {
      const levelKey      = `${bayKey}L${levelNumber}`;
      const defaultHeight = levelSlotInfo.get(levelKey)?.h || 1.05;
      const customHeight  = customHeights[levelNumber - 1];
      const levelHeight   = customHeight != null && customHeight !== "" ? mmToM(customHeight) : defaultHeight;
      levelBaseY.set(levelKey, cumulativeHeight);
      levelHeightMap.set(levelKey, levelHeight);
      cumulativeHeight += levelHeight + SHELF_GAP;
    });
  });

  return rows.flatMap(row => {
    const prefix = String(row.aisle_prefix || row.location?.slice(0, 2) || "").trim().toUpperCase();
    const aisle  = coords.get(prefix);
    if (!aisle) return [];

    const bayNumber   = Number.parseInt(row.bay   || "0", 10) || 0;
    const levelNumber = getLevelNumber(row);
    const slotNumber  = Number.parseInt(row.slot  || "1", 10) || 1;
    const bayKey      = `${prefix}${String(bayNumber).padStart(2, "0")}`;
    const levelKey    = `${bayKey}L${levelNumber}`;
    const locOverride = locationOverrides[row.location] || {};
    const bayOverride = bayOverrides[bayKey] || {};
    const cube        = getCubeSize(row, binSizes, locOverride);

    const bayPair    = Math.ceil(bayNumber / 2);
    const isEvenBay  = bayNumber % 2 === 0;
    const sideSign   = isEvenBay ? 1 : -1;
    const depthSign  = aisle.reverse_bay_dir ? 1 : -1;
    const totalSlots = levelSlotInfo.get(levelKey)?.maxSlot || 1;
    const slotOffset = (slotNumber - 1 - (totalSlots - 1) / 2) * cube.w;
    const rotY       = Number(aisle.rotation_y || 0);
    const extraX     = Number(locOverride.x_offset ?? bayOverride.x_offset ?? 0);
    const extraY     = Number(locOverride.y_offset ?? 0);
    const extraZ     = Number(locOverride.z_offset ?? bayOverride.z_offset ?? 0);
    const floorHeight = Number(bayOverride.floor_height || 0);
    const height     = levelHeightMap.get(levelKey) ?? cube.h;
    let x, z;

    if (rotY === 90 || rotY === -270) {
      x = (aisle.z_origin || 0) + depthSign * (bayPair * BAY_STEP) + slotOffset + extraX;
      z = -(aisle.x + sideSign * AISLE_HALF) + extraZ;
    } else if (rotY === -90 || rotY === 270) {
      x = (aisle.z_origin || 0) - depthSign * (bayPair * BAY_STEP) - slotOffset + extraX;
      z = aisle.x + sideSign * AISLE_HALF + extraZ;
    } else {
      x = aisle.x + sideSign * AISLE_HALF + extraX;
      z = depthSign * -(bayPair * BAY_STEP) + slotOffset + (aisle.z_origin || 0) + extraZ;
    }

    const baseY = levelBaseY.get(levelKey) || 0;
    const y     = baseY + height * 0.5 + extraY + floorHeight;

    return [{
      ...row,
      _position: { x, y, z },
      _size:     { w: cube.w, h: height, d: cube.d },
      _zoneKey:  aisle.zoneKey || row.zone_key || "",
      _levelValue: levelNumber,
      _effectiveBinSize: cube.code || "",
      _bayKey:   bayKey,
      _aisleKey: prefix
    }];
  });
}

function updateSelectionBox() {
  if (!sceneState.selectionBox) return;
  const row = state.selectedLocation
    ? state.sceneRows.find(item => item.location === state.selectedLocation) || null
    : null;
  if (!row) { sceneState.selectionBox.visible = false; return; }
  sceneState.selectionBox.visible = true;
  sceneState.selectionBox.position.set(row._position.x, row._position.y, row._position.z);
  sceneState.selectionBox.scale.set(
    Math.max(0.5, row._size.d + 0.12),
    Math.max(0.5, row._size.h + 0.12),
    Math.max(0.5, row._size.w + 0.12)
  );
}

function buildScene(rows, layout, overrides) {
  clearSceneContent();
  if (!sceneState.scene) return;

  const sceneRows     = buildSceneRows(rows, layout, overrides);
  const colourContext = buildColourContext(sceneRows, overrides);
  state.sceneRows     = sceneRows;

  if (sceneRows.length) {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.12 });
    const mesh     = new THREE.InstancedMesh(geometry, material, sceneRows.length);
    const dummy    = new THREE.Object3D();
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    sceneRows.forEach((row, index) => {
      dummy.position.set(row._position.x, row._position.y, row._position.z);
      dummy.scale.set(row._size.d, row._size.h, row._size.w);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
      mesh.setColorAt(index, getSceneColor(row, colourContext));
    });

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    sceneState.scene.add(mesh);
    sceneState.rackMesh = mesh;
  }

  (layout?.zones || []).forEach((zone, zoneIndex) => {
    const activeAisles = (zone.aisles || []).filter(aisle => state.aisleCoords.has(aisle.prefix));
    if (!activeAisles.length) return;
    const zoneMeta = zone.layout || null;
    if (zoneMeta) {
      const floor = new THREE.Mesh(
        new THREE.BoxGeometry(zoneMeta.width, 0.4, zoneMeta.depth),
        new THREE.MeshPhongMaterial({ color: zoneIndex % 2 === 0 ? "#12243a" : "#142b22", transparent: true, opacity: 0.48 })
      );
      floor.position.set(zoneMeta.x, -0.35, (zoneMeta.z_offset || 0) - zoneMeta.depth / 2 + 4);
      floor.rotation.y = THREE.MathUtils.degToRad(Number(zoneMeta.rotation_y || 0));
      sceneState.floorGroup.add(floor);
      const zoneSprite = makeTextSprite(zone.zone_label || zone.zone_key || "Zone");
      zoneSprite.position.set(zoneMeta.x, 0.8, (zoneMeta.z_offset || 0) + 6);
      sceneState.labelGroup.add(zoneSprite);
    }
    activeAisles.forEach((aisle, index) => {
      if (index % 2 !== 0) return;
      const coord = state.aisleCoords.get(aisle.prefix);
      if (!coord) return;
      const sprite = makeTextSprite(aisle.prefix);
      sprite.position.set(coord.x, 1.4, (coord.z_origin || 0) + 1.5);
      sceneState.labelGroup.add(sprite);
    });
  });

  updateLegend();
  updateSelectionBox();
}

function recolorScene() {
  updateLegend();
  if (!sceneState.rackMesh || !state.sceneRows.length) return;
  const colourContext = buildColourContext(state.sceneRows, state.heatmap?.overrides || {});
  state.sceneRows.forEach((row, index) => {
    sceneState.rackMesh.setColorAt(index, getSceneColor(row, colourContext));
  });
  if (sceneState.rackMesh.instanceColor) sceneState.rackMesh.instanceColor.needsUpdate = true;
  updateSelectionBox();
}

function fitCamera() {
  if (!sceneState.perspCamera || !sceneState.topCamera || !sceneState.fpsCamera) return;

  if (!state.sceneRows.length) {
    sceneState.perspCamera.position.set(38, 42, 58);
    sceneState.orbitControls?.target.set(0, 0, 0);
    sceneState.orbitControls?.update();
    sceneState.topCamera.position.set(0, 260, 0);
    sceneState.topCamera.zoom = 2.2;
    sceneState.topControls?.target.set(0, 0, 0);
    updateTopCameraFrustum(canvas?.clientWidth || 1200, canvas?.clientHeight || 620);
    sceneState.topControls?.update();
    sceneState.fpsCamera.position.set(24, 2.2, 24);
    sceneState.fpsCamera.lookAt(0, 2, 0);
    const defaultEuler = new THREE.Euler().setFromQuaternion(sceneState.fpsCamera.quaternion, "YXZ");
    sceneState.fpsYaw   = defaultEuler.y;
    sceneState.fpsPitch = defaultEuler.x;
    syncFpsRotation();
    updateSelectionBox();
    return;
  }

  const minX = Math.min(...state.sceneRows.map(r => r._position.x - r._size.d / 2));
  const maxX = Math.max(...state.sceneRows.map(r => r._position.x + r._size.d / 2));
  const minY = Math.min(...state.sceneRows.map(r => r._position.y - r._size.h / 2));
  const maxY = Math.max(...state.sceneRows.map(r => r._position.y + r._size.h / 2));
  const minZ = Math.min(...state.sceneRows.map(r => r._position.z - r._size.w / 2));
  const maxZ = Math.max(...state.sceneRows.map(r => r._position.z + r._size.w / 2));
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const spanX   = Math.max(8, maxX - minX);
  const spanY   = Math.max(4, maxY - minY);
  const spanZ   = Math.max(8, maxZ - minZ);
  const radius  = Math.max(spanX, spanZ, spanY * 1.4);
  const sceneWidth  = canvas?.clientWidth  || canvas?.parentElement?.clientWidth || 1200;
  const sceneHeight = canvas?.clientHeight || 620;

  sceneState.perspCamera.position.set(centerX + radius * 0.9, maxY + Math.max(12, radius * 0.55), centerZ + radius * 0.9);
  sceneState.orbitControls?.target.set(centerX, centerY * 0.65, centerZ);
  sceneState.orbitControls?.update();

  sceneState.topControls?.target.set(centerX, centerY, centerZ);
  sceneState.topCamera.position.set(centerX, maxY + 260, centerZ);
  sceneState.topCamera.zoom = clamp(
    Math.min(sceneWidth / (spanX + 12), sceneHeight / (spanZ + 12)),
    sceneState.topControls?.minZoom ?? 0.25, sceneState.topControls?.maxZoom ?? 16
  );
  updateTopCameraFrustum(sceneWidth, sceneHeight);
  sceneState.topControls?.update();

  sceneState.fpsCamera.position.set(
    centerX + Math.max(6, spanX * 0.35), Math.max(minY + 1.75, 1.75), centerZ + Math.max(6, spanZ * 0.35)
  );
  sceneState.fpsCamera.lookAt(centerX, Math.max(minY + 1.5, centerY * 0.45), centerZ);
  const fpsEuler = new THREE.Euler().setFromQuaternion(sceneState.fpsCamera.quaternion, "YXZ");
  sceneState.fpsYaw   = fpsEuler.y;
  sceneState.fpsPitch = fpsEuler.x;
  syncFpsRotation();
  updateSelectionBox();
}

function getFilteredRows() {
  const sourceRows = getActiveSourceRows();
  if (!sourceRows.length) return [];
  const query        = String(searchInput?.value || "").trim().toUpperCase();
  const pickedOnly   = Boolean(pickedOnlyToggle?.checked);
  const occupiedOnly = Boolean(occupiedOnlyToggle?.checked);
  const { min, max } = getLevelBounds();

  return sourceRows.filter(row => {
    const levelNumber = getLevelNumber(row);
    if (min != null && levelNumber < min) return false;
    if (max != null && levelNumber > max) return false;
    if (pickedOnly  && !(Number(row.pick_count || 0) > 0 || Number(row.pick_qty || 0) > 0)) return false;
    if (occupiedOnly && !String(row.sku || "").trim()) return false;
    if (!query) return true;
    const haystack = [row.location, row.sku, row.aisle_prefix, row.zone_key].join(" ").toUpperCase();
    return haystack.includes(query);
  });
}

function renderHotAisles(rows) {
  if (!hotAislesWrap) return;
  const byAisle = new Map();
  rows.forEach(row => {
    const aisle = row.aisle_prefix || "Unknown";
    const item  = byAisle.get(aisle) || { aisle_prefix: aisle, pick_count: 0, pick_qty: 0 };
    item.pick_count += Number(row.pick_count || 0);
    item.pick_qty   += Number(row.pick_qty   || 0);
    byAisle.set(aisle, item);
  });

  const hottest = Array.from(byAisle.values())
    .sort((a, b) => metricSelect?.value === "pick_qty"
      ? Number(b.pick_qty || 0) - Number(a.pick_qty || 0)
      : Number(b.pick_count || 0) - Number(a.pick_count || 0))
    .slice(0, 8);

  if (!hottest.length) {
    hotAislesWrap.innerHTML = '<p style="color:var(--text-xsoft);font-size:0.85rem">No aisle heat data for the current filters.</p>';
    return;
  }

  hotAislesWrap.innerHTML = hottest.map(row => `
    <div class="heatmap-hot-aisle">
      <strong>${escapeHtml(row.aisle_prefix)}</strong>
      <span>${Number(row.pick_count || 0).toLocaleString()} picks</span>
      <span>${Number(row.pick_qty || 0).toLocaleString()} units</span>
    </div>`).join("");
}

function renderSnapshotInfo(meta = {}) {
  if (!snapshotInfo) return;
  const availableDates = Array.isArray(meta.available_pick_dates) ? meta.available_pick_dates.filter(Boolean) : [];
  const latestDate     = String(meta.latest_pick_snapshot_date || meta.pick_snapshot_date || "").trim();
  const snapshotMeta   = meta.pick_snapshot_meta || {};
  const uploadedAt     = String(snapshotMeta.uploaded_at      || "").trim();
  const sourceSyncedAt = String(snapshotMeta.source_synced_at || "").trim();

  if (!availableDates.length) {
    snapshotInfo.innerHTML = [
      "<strong>No pick snapshots published yet.</strong>",
      "<span>Restart the PI-App sync machine or wait for the next publish window.</span>"
    ].join("");
    return;
  }

  snapshotInfo.innerHTML = [
    `<strong>Snapshot: ${escapeHtml(latestDate || "Latest available")}</strong>`,
    `<span>${availableDates.length.toLocaleString()} total pick day(s) available.</span>`,
    uploadedAt     ? `<span>Uploaded: ${escapeHtml(uploadedAt)}.</span>`    : "",
    sourceSyncedAt ? `<span>Synced: ${escapeHtml(sourceSyncedAt)}.</span>`  : ""
  ].filter(Boolean).join("");
}

function renderStats(rows) {
  const meta        = state.heatmap?.meta || {};
  const occupied    = rows.filter(r => r.sku).length;
  const picked      = rows.filter(r => Number(r.pick_count || 0) > 0 || Number(r.pick_qty || 0) > 0).length;
  const picks       = rows.reduce((sum, r) => sum + Number(r.pick_count || 0), 0);
  const latestDate  = String(meta.latest_pick_snapshot_date || meta.pick_snapshot_date || "").trim();
  const availableDates = Array.isArray(meta.available_pick_dates) ? meta.available_pick_dates.filter(Boolean) : [];

  if (occupiedMetric) occupiedMetric.textContent = occupied.toLocaleString();
  if (pickedMetric)   pickedMetric.textContent   = picked.toLocaleString();
  if (locationChip)   locationChip.textContent   = `${rows.length.toLocaleString()} locations`;
  if (pickChip)       pickChip.textContent        = `${picks.toLocaleString()} picks`;

  if (dateChip) {
    dateChip.textContent = !availableDates.length ? "No pick snapshots yet"
      : latestDate ? `Snapshot ${latestDate}` : "Snapshot unavailable";
  }
  if (snapshotStatusChip) {
    snapshotStatusChip.textContent = !availableDates.length
      ? "Waiting for snapshots" : `${availableDates.length} day(s) available`;
  }

  renderSnapshotInfo(meta);
  renderHotAisles(rows);
}

function renderSelectionPlaceholder(message) {
  if (!detailCard) return;
  detailCard.innerHTML = `<strong class="heatmap-detail-card__empty">${escapeHtml(message)}</strong>`;
}

function renderSkuBlock(sku, catalogDetail) {
  if (!sku) return `<span style="color:var(--text-xsoft)">Empty location</span>`;
  const desc  = catalogDetail?.description_short || catalogDetail?.description || "";
  const img   = catalogDetail?.images?.[0];
  const imgHtml = img
    ? `<img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.caption || sku)}"
          style="max-width:100%;max-height:140px;border-radius:var(--radius-sm);object-fit:contain;background:var(--surface-2);display:block;margin-bottom:8px">`
    : "";
  return `
    ${imgHtml}
    <strong style="color:var(--text);font-size:0.95rem">${escapeHtml(sku)}</strong>
    ${desc ? `<p style="color:var(--text-soft);font-size:0.8rem;margin:4px 0 0;line-height:1.4">${escapeHtml(desc)}</p>` : ""}
  `;
}

function renderSelection(row) {
  if (!detailCard || !detailHint) return;
  if (!row) {
    detailHint.textContent = "Click a rack cube in the scene to inspect it.";
    renderSelectionPlaceholder("No location selected yet.");
    return;
  }

  detailHint.textContent = `Selected: ${row.location}`;

  // Render immediately with basic info, then enrich async with catalog data
  const topSkus = Array.isArray(row.top_skus) ? row.top_skus : [];

  const baseHtml = (skuBlock, topSkusHtml) => `
    <div class="heatmap-detail-head">
      <div>
        <div class="card__subtitle">Location</div>
        <h3 style="margin:4px 0 0;font-size:1.4rem;color:var(--text)">${escapeHtml(row.location)}</h3>
      </div>
    </div>
    <div class="heatmap-detail-grid">
      <div><span>Aisle</span><strong>${escapeHtml(row.aisle_prefix || "—")}</strong></div>
      <div><span>Bay</span><strong>${escapeHtml(row.bay || "—")}</strong></div>
      <div><span>Level</span><strong>${escapeHtml(row.level || "—")}</strong></div>
      <div><span>Slot</span><strong>${escapeHtml(row.slot || "—")}</strong></div>
      <div><span>Pick count</span><strong>${Number(row.pick_count || 0).toLocaleString()}</strong></div>
      <div><span>Pick qty</span><strong>${Number(row.pick_qty || 0).toLocaleString()}</strong></div>
    </div>
    <div>
      <div class="card__subtitle" style="margin-bottom:6px">Current SKU</div>
      ${skuBlock}
    </div>
    <div>
      <div class="card__subtitle" style="margin-bottom:6px">Top Picked SKUs</div>
      ${topSkusHtml}
    </div>
  `;

  // Initial render — no catalog data yet
  detailCard.innerHTML = baseHtml(
    row.sku ? `<strong style="color:var(--text)">${escapeHtml(row.sku)}</strong>` : `<span style="color:var(--text-xsoft)">Empty location</span>`,
    topSkus.length
      ? `<div class="heatmap-top-skus">${topSkus.map(item => `<span class="chip">${escapeHtml(item.sku)} — ${Number(item.pick_count || 0)} picks</span>`).join("")}</div>`
      : `<p style="color:var(--text-xsoft);font-size:0.85rem;margin:0">No picked SKU activity in this location.</p>`
  );

  // Capture the location so we can bail if selection changes before fetch completes
  const capturedLocation = row.location;

  // Fetch catalog data for current SKU + top SKUs in parallel
  const skusToFetch = [...new Set([row.sku, ...topSkus.map(t => t.sku)].filter(Boolean))];
  if (!skusToFetch.length) return;

  Promise.all(skusToFetch.map(s => fetchSkuDetail(s))).then(details => {
    // Bail if user has clicked a different location while we were fetching
    if (state.selectedLocation !== capturedLocation) return;

    const detailMap = new Map(skusToFetch.map((s, i) => [s, details[i]]));
    const currentDetail = row.sku ? detailMap.get(row.sku) : null;

    const topSkusEnrichedHtml = topSkus.length
      ? `<div class="heatmap-top-skus">${topSkus.map(item => {
          const d = detailMap.get(item.sku);
          const desc = d?.description_short || d?.description || "";
          return `<span class="chip" title="${escapeHtml(desc)}">${escapeHtml(item.sku)} — ${Number(item.pick_count || 0)} picks</span>`;
        }).join("")}</div>`
      : `<p style="color:var(--text-xsoft);font-size:0.85rem;margin:0">No picked SKU activity in this location.</p>`;

    detailCard.innerHTML = baseHtml(
      renderSkuBlock(row.sku, currentDetail),
      topSkusEnrichedHtml
    );
  }).catch(() => { /* catalog fetch failed silently — basic info already shown */ });
}

function applyFilters({ refit = false } = {}) {
  if (!state.heatmap) return;
  state.colourMode = normalizeColourMode(colourModeSelect?.value || state.colourMode);
  const rows = getFilteredRows();
  const selectedRow = state.selectedLocation
    ? rows.find(r => r.location === state.selectedLocation) || null
    : null;

  state.rows = rows;
  renderStats(rows);
  buildScene(rows, state.heatmap.layout, state.heatmap.overrides || {});

  if (refit || !sceneState.hasFittedScene) {
    fitCamera();
    sceneState.hasFittedScene = true;
  } else {
    updateSelectionBox();
  }

  if (state.selectedLocation && !selectedRow) {
    state.selectedLocation = "";
    renderSelection(null);
  } else if (selectedRow) {
    renderSelection(selectedRow);
  }

  if (!rows.length) { setStatus("No locations match the current filters"); return; }
  setStatus(`${rows.length.toLocaleString()} locations in view`, "ok");
}

function handleSceneClick(event) {
  if (state.cameraMode === "fps" && !sceneState.fpsEditMode) { requestFpsPointerLock(); return; }
  if (!canvas || !sceneState.camera || !sceneState.rackMesh || !state.sceneRows.length) return;

  const rect = canvas.getBoundingClientRect();
  sceneState.pointer.x =  ((event.clientX - rect.left) / rect.width)  * 2 - 1;
  sceneState.pointer.y = -((event.clientY - rect.top)  / rect.height) * 2 + 1;
  sceneState.raycaster.setFromCamera(sceneState.pointer, sceneState.camera);
  const hits = sceneState.raycaster.intersectObject(sceneState.rackMesh);
  if (!hits.length) return;
  const row = state.sceneRows[hits[0].instanceId];
  if (!row) return;
  state.selectedLocation = row.location;
  updateSelectionBox();
  renderSelection(row);
}

function updateDateOptions(availableDates, selectedDate) {
  if (!dateSelect) return;
  const current = dateSelect.value;
  dateSelect.innerHTML = "";
  const dates = Array.from(new Set((availableDates || []).filter(Boolean)));
  if (!dates.length) {
    const opt = document.createElement("option");
    opt.value = ""; opt.textContent = "No snapshots yet";
    dateSelect.appendChild(opt);
    dateSelect.value = "";
    return;
  }
  dates.forEach(date => {
    const opt = document.createElement("option");
    opt.value = date; opt.textContent = date;
    dateSelect.appendChild(opt);
  });
  const resolved = selectedDate || current || dates[0] || "";
  dateSelect.value = dates.includes(resolved) ? resolved : dates[0];
}

function syncModeUi() {
  if (!modeSelect) return;
  const mode     = String(modeSelect.value || "latest").trim().toLowerCase();
  const showDate = mode === "date";
  if (dateField) dateField.hidden = !showDate;
}

function buildHeatmapQuery() {
  const params = new URLSearchParams();
  params.set("client", getSelectedClient());
  const mode = String(modeSelect?.value || "latest").trim().toLowerCase();
  params.set("mode", mode);
  if (mode === "date") {
    const selectedDate = String(dateSelect?.value || "").trim();
    if (selectedDate) params.set("date", selectedDate);
  }
  return `?${params.toString()}`;
}

// ── Location code parsing ─────────────────────────────────────────────────
// Mirrors itemtracker's parseHeatmapLocation exactly:
// strip non-digits from position 2 onwards, then bay=0-2, level=2-4, slot=4-6
function parseLocationCode(loc) {
  const text   = String(loc || "").trim().toUpperCase();
  const digits = text.slice(2).replace(/\D+/g, "");
  if (text.length < 4 || digits.length < 4) return null;
  return {
    aisle_prefix: text.slice(0, 2),
    bay:          digits.slice(0, 2),
    level:        digits.slice(2, 4),
    slot:         digits.slice(4, 6),
  };
}

// Expand heatmap.rows to include every location present in overrides.locations
// that has no pick activity — these appear in the scene with pick_count=0.
function augmentRowsFromOverrides(heatmap) {
  const overrideLocations = heatmap.overrides?.locations;
  if (!overrideLocations) return;

  const existingLocs = new Set((heatmap.rows || []).map(r => r.location));
  const phantomRows  = [];

  for (const loc of Object.keys(overrideLocations)) {
    if (existingLocs.has(loc)) continue;
    const parsed = parseLocationCode(loc);
    if (!parsed) continue;
    phantomRows.push({
      location:     loc,
      aisle_prefix: parsed.aisle_prefix,
      bay:          parsed.bay,
      level:        parsed.level,
      slot:         parsed.slot,
      pick_count:   0,
      pick_qty:     0,
      picker_count: 0,
      top_skus:     [],
      sku:          "",
      bin_size:     "",
      zone_key:     "",
    });
  }

  heatmap.rows.push(...phantomRows);
}

async function loadHeatmap() {
  syncModeUi();
  setStatus("Loading heatmap...");
  try {
    const query = buildHeatmapQuery();
    const data  = await apiFetch(`/api/heatmap-data${query}`);
    if (!data.ok) throw new Error(data.error || "API error");
    state.heatmap = data.heatmap || { rows: [], layout: { zones: [] }, meta: {}, stats: {}, overrides: {}, bin_sizes: {} };
    const meta = state.heatmap.meta || {};
    updateDateOptions(meta.available_pick_dates || [], meta.pick_snapshot_date || meta.latest_pick_snapshot_date || "");
    applyFilters({ refit: true });

    if (!Array.isArray(meta.available_pick_dates) || !meta.available_pick_dates.length) {
      renderSelectionPlaceholder("No pick snapshots published yet. Restart the PI-App sync machine.");
      if (hotAislesWrap) hotAislesWrap.innerHTML = "";
      setStatus("No pick snapshots available");
      return;
    }

    if (!state.selectedLocation) renderSelection(null);
  } catch (error) {
    setStatus("Could not load heatmap");
    renderSelectionPlaceholder(error.message || "Could not load the picking heatmap.");
    renderSnapshotInfo({});
    if (hotAislesWrap) hotAislesWrap.innerHTML = "";
    window.RepoApp?.toast(error.message || "Could not load the picking heatmap", "error");
  }
}

function refreshFullscreenState() {
  state.isFullscreen = isFullscreenActive();
  if (layoutRoot) layoutRoot.classList.toggle("is-fullscreen", state.isFullscreen);
  if (fullscreenButton) fullscreenButton.textContent = state.isFullscreen ? "Exit full screen" : "Full screen";
  if (!state.isFullscreen) sceneState.movementKeys.clear();
  window.setTimeout(resizeScene, 40);
}

async function toggleFullscreen() {
  if (!layoutRoot) return;
  try {
    if (isFullscreenActive()) await document.exitFullscreen();
    else                      await layoutRoot.requestFullscreen();
  } catch (error) {
    window.RepoApp?.toast(error.message || "Could not toggle full screen", "error");
  }
}

function handleKeyDown(event) {
  if (isEditableElement(event.target)) return;

  if (event.code === "Digit1") { event.preventDefault(); setCameraMode("orbit"); return; }
  if (event.code === "Digit2") { event.preventDefault(); setCameraMode("top");   return; }
  if (event.code === "Digit3") { event.preventDefault(); setCameraMode("fps");   return; }
  if (event.code === "KeyR")   { event.preventDefault(); fitCamera();             return; }

  if (state.cameraMode === "fps" && event.code === "Tab") {
    event.preventDefault();
    sceneState.fpsEditMode = !sceneState.fpsEditMode;
    if (sceneState.fpsEditMode) {
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    } else {
      requestFpsPointerLock();
    }
    updateSceneModeUi();
    return;
  }

  if (state.cameraMode === "fps" && event.code === "Escape") {
    sceneState.fpsEditMode = true;
    sceneState.movementKeys.clear();
    if (document.pointerLockElement === canvas) { event.preventDefault(); document.exitPointerLock(); }
    updateSceneModeUi();
    return;
  }

  const movementKeys = state.cameraMode === "fps"
    ? ["KeyW", "KeyA", "KeyS", "KeyD", "KeyE", "KeyC"]
    : isFullscreenActive() ? ["KeyW", "KeyA", "KeyS", "KeyD"] : [];
  if (!movementKeys.includes(event.code)) return;
  event.preventDefault();
  sceneState.movementKeys.add(event.code);
}

function handleKeyUp(event) {
  if (!["KeyW", "KeyA", "KeyS", "KeyD", "KeyE", "KeyC"].includes(event.code)) return;
  sceneState.movementKeys.delete(event.code);
}

function wireEvents() {
  clientSelect?.addEventListener("change", loadHeatmap);
  modeSelect?.addEventListener("change",   () => { syncModeUi(); loadHeatmap(); });
  dateSelect?.addEventListener("change",   () => {
    if (String(modeSelect?.value || "latest").trim().toLowerCase() === "date") loadHeatmap();
  });
  metricSelect?.addEventListener("change",        loadHeatmap);
  searchInput?.addEventListener("input",          () => applyFilters());
  pickedOnlyToggle?.addEventListener("change",    () => applyFilters());
  occupiedOnlyToggle?.addEventListener("change",  () => applyFilters());
  cameraModeSelect?.addEventListener("change",    () => setCameraMode(cameraModeSelect.value));
  colourModeSelect?.addEventListener("change",    () => {
    state.colourMode = normalizeColourMode(colourModeSelect.value);
    recolorScene();
    updateSceneModeUi();
  });
  levelMinInput?.addEventListener("input",        () => applyFilters());
  levelMaxInput?.addEventListener("input",        () => applyFilters());
  levelResetButton?.addEventListener("click",     () => {
    if (levelMinInput) levelMinInput.value = "";
    if (levelMaxInput) levelMaxInput.value = "";
    applyFilters();
  });
  resetCameraButton?.addEventListener("click",    fitCamera);
  reloadButton?.addEventListener("click",         loadHeatmap);
  fullscreenButton?.addEventListener("click",     toggleFullscreen);
  document.addEventListener("fullscreenchange",   refreshFullscreenState);
  document.addEventListener("keydown",            handleKeyDown);
  document.addEventListener("keyup",              handleKeyUp);
}

if (canvas) {
  loadSceneSettings();
  syncSettingsPanel();
  wireSettingsPanel();
  initScene();
  syncModeUi();
  refreshFullscreenState();
  wireEvents();
  loadHeatmap();
}
