"use strict";

let auditTask = null;
let auditSummary = null;
let auditItems = [];
let currentIndex = 0;
let busy = false;
let pollTimer = null;
let preparedPhoto = null;
let photoPreparePromise = null;
let pendingActions = [];
let syncInFlight = false;
let lastSyncError = "";
let loadedFromCache = false;
let memoryPendingActions = [];
let offlineDbPromise = null;
let queueExpanded = false;
let noteToolsExpanded = false;
let cacheSaveTimer = null;
const noteDrafts = new Map();

const TASK_ID = window.EMPTY_BIN_TASK_ID || "";
const PHOTO_MAX_DIMENSION = 1600;
const PHOTO_JPEG_QUALITY = 0.72;
const POLL_INTERVAL_MS = 5 * 60 * 1000;
const COMPACT_AUDIT_BREAKPOINT = 760;
const COMPACT_QUEUE_WINDOW = 10;
const LOCAL_TASK_CACHE_KEY = `repo-empty-bin-task-cache:${TASK_ID}`;
const LOCAL_BOOTSTRAP_TASK_KEY = `repo-empty-bin-bootstrap:${TASK_ID}`;
const OFFLINE_DB_NAME = "repo-app-empty-bin-offline";
const OFFLINE_DB_VERSION = 1;
const OFFLINE_QUEUE_STORE = "empty_bin_pending_checks";

function $(id) {
  return document.getElementById(id);
}

function fmt(n) {
  return Number(n ?? 0).toLocaleString();
}

function escHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escAttr(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function cloneJson(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function nowIso() {
  return new Date().toISOString();
}

function formatDateTimeText(value) {
  const text = String(value || "").trim();
  if (!text) return "-";
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return parsed.toLocaleString();
  return text;
}

function isCompactAuditLayout() {
  return window.matchMedia(`(max-width: ${COMPACT_AUDIT_BREAKPOINT}px)`).matches;
}

function noteDraftFor(location) {
  return noteDrafts.get(String(location || "").trim().toUpperCase()) || "";
}

function setNoteDraft(location, value) {
  const key = String(location || "").trim().toUpperCase();
  if (!key) return;
  const text = String(value || "");
  if (text) noteDrafts.set(key, text);
  else noteDrafts.delete(key);
}

function makeLocalId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isLikelyNetworkError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    !navigator.onLine ||
    message.includes("failed to fetch") ||
    message.includes("networkerror") ||
    message.includes("load failed") ||
    message.includes("network request failed") ||
    message.includes("internet connection") ||
    message.includes("connection was lost")
  );
}

function statusLabel(status) {
  const labels = {
    pending: "Pending",
    checked_empty: "Empty",
    checked_not_empty: "Not empty",
    cleared: "Cleared",
    moved: "Moved",
    skipped: "Skipped",
    cannot_complete: "Cannot complete",
    system_cleared: "System cleared",
    operations_filled: "Operations filled",
  };
  return labels[status] || status || "Pending";
}

function statusTone(status) {
  if (status === "pending") return "pending";
  if (status === "checked_empty" || status === "cleared" || status === "moved" || status === "operations_filled") return "good";
  if (status === "checked_not_empty" || status === "cannot_complete") return "bad";
  if (status === "system_cleared") return "system";
  return "warn";
}

function actionToStatus(action) {
  const map = {
    empty: "checked_empty",
    checked_empty: "checked_empty",
    not_empty: "checked_not_empty",
    checked_not_empty: "checked_not_empty",
    cleared: "cleared",
    moved: "moved",
    skipped: "skipped",
    cannot_complete: "cannot_complete",
  };
  return map[String(action || "").trim()] || "pending";
}

function firstTextValue(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function transactionField(tx, ...keys) {
  if (!tx) return "";
  return firstTextValue(...keys.map((key) => tx?.[key]));
}

function formatLastTransaction(tx) {
  if (!tx) return "Last transaction: none found";
  const date = tx.date_time || tx.Last_DateTime || tx.transaction_date || tx.snapshot_date || "";
  const item = tx.item || tx.Last_Item || "-";
  const qty = fmt(tx.qty ?? tx.Last_Qty ?? 0);
  const reasonValue = tx.reason || tx.Last_Reason || "";
  const reason = reasonValue ? ` | reason ${reasonValue}` : "";
  const order = tx.order_number ? ` | order ${tx.order_number}` : "";
  const userValue = tx.user || tx.Last_User || tx.picker || "";
  const user = userValue ? ` | user ${userValue}` : "";
  return `Last transaction: ${date || "-"} | ${item} | qty ${qty}${reason}${order}${user}`;
}

async function apiJson(url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text || `Request failed with ${resp.status}.`);
  }
  if (!json.ok) throw new Error(json.error || "Request failed.");
  return json;
}

function visibleItems(task) {
  return (task?.items || [])
    .filter((item) => !["system_cleared", "operations_filled"].includes(item.status))
    .slice()
    .sort((a, b) => Number(a.sort_index || 0) - Number(b.sort_index || 0));
}

function checkedCount(items) {
  return items.filter((item) => item.status && item.status !== "pending").length;
}

function pendingCount(items) {
  return items.filter((item) => item.status === "pending").length;
}

function firstPendingIndex(items) {
  const index = items.findIndex((item) => item.status === "pending");
  return index >= 0 ? index : 0;
}

function nextPendingIndex(items, fromIndex) {
  if (!items.length) return 0;
  for (let i = fromIndex + 1; i < items.length; i += 1) {
    if (items[i].status === "pending") return i;
  }
  for (let i = 0; i <= fromIndex; i += 1) {
    if (items[i].status === "pending") return i;
  }
  return Math.min(fromIndex, items.length - 1);
}

function computeSummary(task, summary = null) {
  const items = Array.isArray(task?.items) ? task.items : [];
  return {
    checked_count: items.filter((item) => item.status && !["pending", "system_cleared", "operations_filled"].includes(item.status)).length,
    pending_count: items.filter((item) => item.status === "pending").length,
    system_cleared_count: items.filter((item) => item.status === "system_cleared").length,
    operations_filled_count: items.filter((item) => item.status === "operations_filled").length,
    photo_count: items.reduce((sum, item) => sum + ((item.photos || []).length), 0),
    ...(summary && typeof summary === "object" ? summary : {}),
  };
}

function persistTaskCache() {
  if (!TASK_ID || !auditTask) return;
  try {
    localStorage.setItem(
      LOCAL_TASK_CACHE_KEY,
      JSON.stringify({
        task: auditTask,
        summary: auditSummary || computeSummary(auditTask),
        cachedAt: nowIso(),
      })
    );
  } catch (_) {}
}

function saveTaskCache() {
  if (cacheSaveTimer) clearTimeout(cacheSaveTimer);
  cacheSaveTimer = window.setTimeout(() => {
    cacheSaveTimer = null;
    persistTaskCache();
  }, 24);
}

function loadTaskCache() {
  try {
    const raw = localStorage.getItem(LOCAL_TASK_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.task) return null;
    return parsed;
  } catch {
    return null;
  }
}

function pullBootstrapTask() {
  try {
    const raw = sessionStorage.getItem(LOCAL_BOOTSTRAP_TASK_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(LOCAL_BOOTSTRAP_TASK_KEY);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.task) return null;
    return parsed;
  } catch {
    return null;
  }
}

function openOfflineDb() {
  if (!("indexedDB" in window)) return Promise.resolve(null);
  if (offlineDbPromise) return offlineDbPromise;
  offlineDbPromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OFFLINE_QUEUE_STORE)) {
        const store = db.createObjectStore(OFFLINE_QUEUE_STORE, { keyPath: "id" });
        store.createIndex("taskId", "taskId", { unique: false });
        store.createIndex("taskId_createdAt", ["taskId", "createdAt"], { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open offline storage."));
  }).catch(() => null);
  return offlineDbPromise;
}

async function idbListPendingActions(taskId) {
  const normalizedTaskId = String(taskId || "").trim();
  const db = await openOfflineDb();
  if (!db) {
    return memoryPendingActions
      .filter((entry) => String(entry.taskId || "").trim() === normalizedTaskId)
      .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_QUEUE_STORE, "readonly");
    const store = tx.objectStore(OFFLINE_QUEUE_STORE);
    const index = store.index("taskId");
    const request = index.getAll(normalizedTaskId);
    request.onsuccess = () => {
      const rows = (request.result || []).slice().sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
      resolve(rows);
    };
    request.onerror = () => reject(request.error || new Error("Could not read saved checks."));
  });
}

async function idbPutPendingAction(action) {
  const payload = cloneJson(action);
  const db = await openOfflineDb();
  if (!db) {
    const index = memoryPendingActions.findIndex((row) => row.id === payload.id);
    if (index >= 0) memoryPendingActions[index] = payload;
    else memoryPendingActions.push(payload);
    return payload;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_QUEUE_STORE, "readwrite");
    tx.objectStore(OFFLINE_QUEUE_STORE).put(payload);
    tx.oncomplete = () => resolve(payload);
    tx.onerror = () => reject(tx.error || new Error("Could not save the check offline."));
  });
}

async function idbDeletePendingAction(actionId) {
  const id = String(actionId || "").trim();
  const db = await openOfflineDb();
  if (!db) {
    memoryPendingActions = memoryPendingActions.filter((row) => row.id !== id);
    return;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_QUEUE_STORE, "readwrite");
    tx.objectStore(OFFLINE_QUEUE_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Could not clear the saved check."));
  });
}

async function refreshPendingActions() {
  pendingActions = await idbListPendingActions(TASK_ID);
  return pendingActions;
}

function currentItem() {
  if (!auditItems.length) return null;
  currentIndex = Math.max(0, Math.min(currentIndex, auditItems.length - 1));
  return auditItems[currentIndex];
}

function setHeader() {
  const total = auditItems.length;
  const checked = checkedCount(auditItems);
  const pending = pendingCount(auditItems);
  const autoResolved = Number(auditSummary?.system_cleared_count || 0) + Number(auditSummary?.operations_filled_count || 0);
  const typeLabel = auditTask?.type === "clearing" ? "Clearing task" : "Audit task";
  $("auditTitle").textContent = auditTask?.title || "Empty bin audit";
  $("auditStatusChip").textContent = auditTask?.assignee
    ? `${typeLabel} | ${auditTask.assignee.name || auditTask.assignee.email || "me"}`
    : `${typeLabel} | Unassigned`;
  $("auditProgressChip").textContent = `${checked}/${total || 0} checked`;
  $("auditProgressText").textContent = `${pending} pending, ${checked} checked, ${autoResolved} auto resolved`;
  $("auditProgressBar").style.width = total ? `${Math.round((checked / total) * 100)}%` : "0%";
}

function renderFact(label, value, tone = "") {
  return `<div class="audit-fact ${tone ? `audit-fact--${escAttr(tone)}` : ""}"><span>${escHtml(label)}</span><b>${escHtml(value || "-")}</b></div>`;
}

function renderPhotos(item) {
  const photos = item?.photos || [];
  if (!photos.length) return "";
  return `
    <div class="audit-photo-row">
      ${photos.map((photo) => `<a href="${escAttr(photo.url)}" target="_blank" rel="noreferrer"><img src="${escAttr(photo.url)}" alt="Photo for ${escAttr(item.location)}"></a>`).join("")}
    </div>
  `;
}

function resetPreparedPhoto(location = "") {
  preparedPhoto = location ? { location, dataUrl: "", timestamp: "" } : null;
  photoPreparePromise = null;
}

function setPhotoStatus(message, tone = "") {
  const status = $("auditPhotoStatus");
  if (!status) return;
  status.textContent = message || "";
  status.dataset.tone = tone || "";
}

function renderPhotoPreview(dataUrl) {
  const preview = $("auditPhotoPreview");
  if (!preview) return;
  preview.innerHTML = dataUrl
    ? `<img src="${escAttr(dataUrl)}" alt="Compressed audit photo preview">`
    : "";
}

function formatPhotoTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  ].join(" ");
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not load the selected photo."));
    };
    image.src = url;
  });
}

async function compressPhotoWithTimestamp(file) {
  if (!file) return null;
  const image = await loadImageFromFile(file);
  const sourceWidth = image.naturalWidth || image.width || 1;
  const sourceHeight = image.naturalHeight || image.height || 1;
  const scale = Math.min(1, PHOTO_MAX_DIMENSION / Math.max(sourceWidth, sourceHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser could not prepare the photo.");

  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  const timestamp = formatPhotoTimestamp();
  const fontSize = Math.max(22, Math.round(canvas.width * 0.026));
  const padding = Math.round(fontSize * 0.55);
  ctx.font = `700 ${fontSize}px Arial, sans-serif`;
  const metrics = ctx.measureText(timestamp);
  const boxWidth = Math.ceil(metrics.width + padding * 2);
  const boxHeight = Math.ceil(fontSize + padding * 1.8);
  ctx.fillStyle = "rgba(0, 0, 0, 0.62)";
  ctx.fillRect(0, 0, boxWidth, boxHeight);
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "top";
  ctx.fillText(timestamp, padding, padding * 0.8);

  return {
    dataUrl: canvas.toDataURL("image/jpeg", PHOTO_JPEG_QUALITY),
    timestamp,
  };
}

function prepareAuditPhoto(file, location) {
  const activeLocation = String(location || "").trim().toUpperCase();
  if (!file || !activeLocation) {
    resetPreparedPhoto(activeLocation);
    renderPhotoPreview("");
    setPhotoStatus("No photo attached");
    return Promise.resolve(null);
  }

  preparedPhoto = { location: activeLocation, dataUrl: "", timestamp: "" };
  renderPhotoPreview("");
  setPhotoStatus("Compressing photo...", "busy");
  photoPreparePromise = compressPhotoWithTimestamp(file)
    .then((result) => {
      preparedPhoto = {
        location: activeLocation,
        dataUrl: result?.dataUrl || "",
        timestamp: result?.timestamp || "",
      };
      if (currentItem()?.location === activeLocation) {
        renderPhotoPreview(preparedPhoto.dataUrl);
        setPhotoStatus(preparedPhoto.timestamp ? `Photo ready | ${preparedPhoto.timestamp}` : "Photo ready", "ready");
      }
      return preparedPhoto;
    })
    .catch((err) => {
      if (currentItem()?.location === activeLocation) {
        renderPhotoPreview("");
        setPhotoStatus(err.message || "Photo could not be prepared.", "error");
      }
      preparedPhoto = null;
      throw err;
    });
  return photoPreparePromise;
}

function buildPendingAction(location, action, note, imageDataUrl) {
  return {
    id: makeLocalId("ebq"),
    taskId: TASK_ID,
    location: String(location || "").trim().toUpperCase(),
    action: String(action || "").trim(),
    status: actionToStatus(action),
    note: String(note || ""),
    imageDataUrl: String(imageDataUrl || ""),
    createdAt: nowIso(),
    lastAttemptAt: "",
    lastError: "",
  };
}

function localPhotoFromPendingAction(action) {
  if (!action?.imageDataUrl) return null;
  return {
    id: `local_${action.id}`,
    file_name: `${action.location}_offline.jpg`,
    url: action.imageDataUrl,
    mime: "image/jpeg",
    uploaded_at: action.createdAt || nowIso(),
    uploaded_by: auditTask?.assignee || null,
    pending_local: true,
  };
}

function applyPendingActionToTask(task, action) {
  if (!task || !action) return task;
  const location = String(action.location || "").trim().toUpperCase();
  const item = (task.items || []).find((row) => String(row.location || "").trim().toUpperCase() === location);
  if (!item) return task;

  item.status = action.status || item.status;
  item.result = action.status || item.result || "";
  item.note = action.note !== undefined ? String(action.note || "") : item.note;
  item.checked_at = action.createdAt || item.checked_at || "";
  item.checked_by = task.assignee || item.checked_by || null;
  item.local_pending_sync = true;
  item.local_sync_error = String(action.lastError || "");

  if (action.imageDataUrl) {
    const localPhoto = localPhotoFromPendingAction(action);
    item.photos = (item.photos || []).filter((photo) => !photo.pending_local);
    item.photos.push(localPhoto);
  }

  if (task.status !== "completed") task.status = "in_progress";
  return task;
}

function overlayPendingActions(task, actions) {
  const nextTask = cloneJson(task);
  for (const action of (actions || []).slice().sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))) {
    applyPendingActionToTask(nextTask, action);
  }
  return nextTask;
}

function applyTaskState(task, summary, { keepIndex = false, advanceAfterLocation = "", source = "server", cloneTask = false } = {}) {
  if (!task) return;
  const previousLocation = advanceAfterLocation || currentItem()?.location || "";
  auditTask = cloneTask ? cloneJson(task) : task;
  auditSummary = computeSummary(auditTask, summary);
  auditItems = visibleItems(auditTask);

  if (!keepIndex) {
    currentIndex = firstPendingIndex(auditItems);
  } else if (previousLocation) {
    const previousIndex = auditItems.findIndex((item) => item.location === previousLocation);
    currentIndex = previousIndex >= 0 ? nextPendingIndex(auditItems, previousIndex) : firstPendingIndex(auditItems);
  } else {
    currentIndex = Math.max(0, Math.min(currentIndex, Math.max(0, auditItems.length - 1)));
  }

  const nextLocation = auditItems[currentIndex]?.location || "";
  if (isCompactAuditLayout() && nextLocation !== previousLocation) {
    noteToolsExpanded = false;
    queueExpanded = false;
  }

  loadedFromCache = source !== "server";
  saveTaskCache();
  renderCurrent();
  renderSyncPanel();
}

function renderSyncPanel() {
  const panel = $("auditSyncPanel");
  if (!panel) return;

  const queueCount = pendingActions.length;
  const online = navigator.onLine;
  let tone = "online";
  let title = "Live sync is connected.";
  let meta = loadedFromCache
    ? "Showing the saved task copy on this device while the page refreshes in the background."
    : "This task is cached on this device, and completed checks will stay in place even if signal drops temporarily.";

  if (!online && queueCount > 0) {
    tone = "offline";
    title = `${fmt(queueCount)} check${queueCount === 1 ? "" : "s"} saved locally while offline.`;
    meta = "You can keep checking locations. Saved checks will sync automatically when the connection comes back.";
  } else if (!online) {
    tone = "offline";
    title = "You are offline.";
    meta = auditTask
      ? "This task stays usable from the saved copy on this device. New checks will queue locally until the connection returns."
      : "No task has been saved on this device yet, so the page needs a connection to load the audit.";
  } else if (syncInFlight && queueCount > 0) {
    tone = "pending";
    title = `Syncing ${fmt(queueCount)} saved check${queueCount === 1 ? "" : "s"}...`;
    meta = "The task flow stays local-first while the server catches up in the background.";
  } else if (lastSyncError && queueCount > 0) {
    tone = "error";
    title = `A saved check needs attention before the queue can finish syncing.`;
    meta = `${lastSyncError} Use Sync now after the connection is stable, or refresh the task if someone else updated it.`;
  } else if (queueCount > 0) {
    tone = "pending";
    title = `${fmt(queueCount)} check${queueCount === 1 ? "" : "s"} still waiting to sync.`;
    meta = "The task is safe on this device. Repo-app will keep trying in the background.";
  }

  const actions = [];
  if (online && queueCount > 0) {
    actions.push(`<button class="btn btn--sm" data-sync-action="sync-now">Sync now</button>`);
  }
  if (online) {
    actions.push(`<button class="btn btn--sm" data-sync-action="refresh">Refresh task</button>`);
  }

  panel.className = `audit-sync-panel audit-sync-panel--${tone}`;
  panel.innerHTML = `
    <div class="audit-sync-panel__title">${escHtml(title)}</div>
    <div class="audit-sync-panel__meta">${escHtml(meta)}</div>
    ${actions.length ? `<div class="audit-sync-panel__actions">${actions.join("")}</div>` : ""}
  `;
}

function renderComplete() {
  const isClearingTask = auditTask?.type === "clearing";
  const primaryLabel = isClearingTask ? "Finish clearing task" : "Finish audit";
  const helpText = isClearingTask
    ? "This will close the clearing task and return you to the task manager."
    : "This will close the audit and automatically create a clearing task for the confirmed empty locations.";
  $("auditMain").innerHTML = `
    <section class="audit-empty">
      <h2>${escHtml(primaryLabel)}</h2>
      <p>${fmt(auditSummary?.checked_count || checkedCount(auditItems))} locations have been checked.</p>
      <div class="audit-empty__note">${escHtml(helpText)}</div>
      <div class="audit-complete-actions">
        <button class="btn btn--primary" data-task-action="complete">${escHtml(primaryLabel)}</button>
        <a class="btn" href="/empty-bins">Back to task list</a>
      </div>
    </section>
    ${renderQueue()}
  `;
}

function renderAuditTools(item, { compactLayout, photoReady, photoStatusText, draftNote }) {
  if (!item || item.status !== "pending") return "";

  if (!compactLayout) {
    return `
      <div class="audit-inputs">
        <textarea class="fi audit-note" id="auditNote" placeholder="Optional note">${escHtml(draftNote)}</textarea>
        <div class="audit-photo-picker">
          <button class="audit-camera-btn" type="button" data-photo-trigger>Take photo</button>
          <input id="auditPhoto" type="file" accept="image/*" capture="environment" hidden />
          <div class="audit-photo-status" id="auditPhotoStatus" data-tone="${photoReady ? "ready" : ""}">${escHtml(photoStatusText)}</div>
          <div class="audit-photo-preview" id="auditPhotoPreview">${photoReady ? `<img src="${escAttr(preparedPhoto.dataUrl)}" alt="Compressed audit photo preview">` : ""}</div>
        </div>
      </div>
    `;
  }

  const noteReady = Boolean(String(draftNote || "").trim());
  const summaryParts = [];
  if (noteReady) summaryParts.push("Note ready");
  if (photoReady) summaryParts.push("Photo ready");
  if (!summaryParts.length) summaryParts.push("Optional note or photo");

  return `
    <section class="audit-tools ${noteToolsExpanded ? "audit-tools--open" : ""}">
      <div class="audit-tools__bar">
        <button class="audit-tools__toggle" type="button" data-tools-toggle>${noteToolsExpanded ? "Hide note & photo" : "Add note / photo"}</button>
        <div class="audit-tools__summary">${escHtml(summaryParts.join(" | "))}</div>
      </div>
      ${noteToolsExpanded ? `
        <div class="audit-inputs audit-inputs--compact">
          <textarea class="fi audit-note" id="auditNote" placeholder="Optional note">${escHtml(draftNote)}</textarea>
          <div class="audit-photo-picker">
            <button class="audit-camera-btn" type="button" data-photo-trigger>Take photo</button>
            <input id="auditPhoto" type="file" accept="image/*" capture="environment" hidden />
            <div class="audit-photo-status" id="auditPhotoStatus" data-tone="${photoReady ? "ready" : ""}">${escHtml(photoStatusText)}</div>
            <div class="audit-photo-preview" id="auditPhotoPreview">${photoReady ? `<img src="${escAttr(preparedPhoto.dataUrl)}" alt="Compressed audit photo preview">` : ""}</div>
          </div>
        </div>
      ` : ""}
    </section>
  `;
}

function renderAuditControls({ pending, compactLayout, actionsMarkup }) {
  return `
    <section class="audit-controls ${compactLayout ? "audit-controls--sticky" : ""}">
      <nav class="audit-nav">
        <button class="btn" data-nav-action="prev">Previous</button>
        <button class="btn" ${compactLayout ? "data-queue-toggle" : 'data-nav-action="next-pending"'}>${compactLayout ? (queueExpanded ? "Hide queue" : "Queue") : "Next pending"}</button>
        <button class="btn" data-nav-action="next">Next</button>
      </nav>
      ${pending ? `<div class="audit-actions">${actionsMarkup}</div>` : ""}
    </section>
  `;
}

function renderCurrent() {
  setHeader();
  const item = currentItem();
  if (!item) {
    renderComplete();
    return;
  }
  if (preparedPhoto?.location !== item.location) {
    resetPreparedPhoto(item.location);
  }

  const pending = item.status === "pending";
  const compactLayout = isCompactAuditLayout();
  const live = item.live || {};
  const positionText = `Location ${currentIndex + 1} of ${auditItems.length}`;
  const isClearingTask = auditTask?.type === "clearing";
  const actions = isClearingTask
    ? [
        ["cleared", "Cleared"],
        ["skipped", "Skip"],
      ]
    : [
        ["empty", "Empty"],
        ["not_empty", "Not empty"],
      ];
  const photoReady = preparedPhoto?.location === item.location && preparedPhoto.dataUrl;
  const draftNote = noteDraftFor(item.location);
  const photoStatusText = photoReady && preparedPhoto.timestamp
    ? `Photo ready | ${preparedPhoto.timestamp}`
    : "No photo attached";
  const liveQty = fmt(live.current_qty ?? item.current_qty_at_create);
  const liveSku = firstTextValue(live.item_sku, item.item_sku, item.last_transaction?.item, item.last_transaction?.Last_Item) || "-";
  const txItem = transactionField(item.last_transaction, "item", "Last_Item") || "-";
  const txReason = transactionField(item.last_transaction, "reason", "Last_Reason") || "-";
  const txUser = transactionField(item.last_transaction, "user", "Last_User", "picker") || "-";
  const txDate = transactionField(item.last_transaction, "date_time", "Last_DateTime", "transaction_date", "snapshot_date") || "-";
  const decisionCopy = isClearingTask
    ? "Confirm when the location has been cleared for follow-up."
    : "Answer the one thing that matters here: is the location still empty right now?";
  const liveCallout = isClearingTask
    ? (live.live_empty === false
        ? "BINLOC now shows stock in this location. It will be marked as Operations filled."
        : "BINLOC still shows this location as empty.")
    : (live.live_empty === false
        ? "Live BINLOC already shows stock in this location."
        : "Live BINLOC still shows this location as empty.");
  const sourceCallout = isClearingTask
    ? "Created from the finished empty-bin audit."
    : (item.source_reason || "Queued from the daily empty-bin report.");
  const localSyncNote = item.local_pending_sync
    ? (
      item.local_sync_error
        ? `<div class="audit-last audit-last--error">${escHtml(item.local_sync_error)}</div>`
        : `<div class="audit-last audit-last--offline">${escHtml(navigator.onLine ? "Saved locally and waiting to sync." : "Saved offline. It will sync automatically when the connection returns.")}</div>`
    )
    : "";
  const actionButtons = actions
    .map(([action, label]) => `<button class="audit-action ${action === "empty" || action === "cleared" ? "audit-action--primary" : ""}" data-check-action="${escAttr(action)}">${escHtml(label)}</button>`)
    .join("");

  $("auditMain").innerHTML = `
    <section class="audit-card ${compactLayout ? "audit-card--compact" : ""}" data-current-location="${escAttr(item.location)}">
      <div class="audit-card__hero">
        <div>
          <div class="audit-location">${escHtml(item.location)}</div>
          <div class="audit-subline">${escHtml(positionText)} | ${escHtml(item.operating_area || "-")} | ${escHtml(item.bin_size || "-")} | ${escHtml(item.bin_type || "-")} | level ${escHtml(item.level || "-")}</div>
        </div>
        <span class="audit-status audit-status--${escAttr(statusTone(item.status))}">${escHtml(statusLabel(item.status))}</span>
      </div>

      <div class="audit-callout ${live.live_empty === false ? "audit-callout--warn" : "audit-callout--ok"}">
        <div class="audit-callout__title">${escHtml(decisionCopy)}</div>
        <div class="audit-callout__meta">${escHtml(liveCallout)}</div>
      </div>

      <div class="audit-facts audit-facts--summary">
        ${renderFact("Live qty", liveQty, "strong")}
        ${renderFact("Live SKU", liveSku)}
        ${renderFact("Last item", txItem)}
        ${renderFact("Last user", txUser)}
      </div>

      <div class="audit-inline-notes">
        <div class="audit-last">${escHtml(`Last reason | ${txReason}`)}</div>
        <div class="audit-last">${escHtml(`Last time | ${txDate}`)}</div>
      </div>

      <div class="audit-facts">
        ${renderFact("Created qty", fmt(item.current_qty_at_create))}
        ${renderFact("Source", sourceCallout)}
        ${renderFact("Report date", item.report_date || "-")}
        ${renderFact("Task type", isClearingTask ? "Clearing" : "Audit")}
      </div>

      ${item.system_cleared_reason ? `<div class="audit-last">${escHtml(item.system_cleared_reason)}</div>` : ""}
      ${item.note ? `<div class="audit-last">${escHtml(item.note)}</div>` : ""}
      ${localSyncNote}
      ${renderPhotos(item)}

      ${pending ? `
        ${renderAuditTools(item, { compactLayout, photoReady, photoStatusText, draftNote })}
      ` : `
        <div class="audit-last">This location is already marked as ${escHtml(statusLabel(item.status))}.</div>
      `}
    </section>

    ${renderAuditControls({ pending, compactLayout, actionsMarkup: actionButtons })}

    ${pendingCount(auditItems) === 0 ? `
      <section class="audit-empty">
        <p>No pending locations remain.</p>
        <div class="audit-complete-actions">
          <button class="btn btn--primary" data-task-action="complete">${escHtml(isClearingTask ? "Finish clearing task" : "Finish audit")}</button>
        </div>
      </section>
    ` : ""}

    ${renderQueue()}
  `;
}

function renderQueue() {
  if (!auditItems.length) return "";
  const compactLayout = isCompactAuditLayout();
  const shouldCompact = compactLayout && !queueExpanded;
  const total = auditItems.length;
  let startIndex = 0;
  let endIndex = total;
  let visibleQueueItems = auditItems;

  if (shouldCompact) {
    const halfWindow = Math.floor(COMPACT_QUEUE_WINDOW / 2);
    startIndex = Math.max(0, currentIndex - halfWindow);
    endIndex = Math.min(total, startIndex + COMPACT_QUEUE_WINDOW);
    startIndex = Math.max(0, endIndex - COMPACT_QUEUE_WINDOW);
    visibleQueueItems = auditItems.slice(startIndex, endIndex);
  }

  return `
    <section class="audit-queue ${compactLayout ? "audit-queue--compact" : ""}">
      <div class="audit-queue__head">
        <div class="audit-queue__title">Task queue</div>
        ${compactLayout && total > COMPACT_QUEUE_WINDOW ? `<button class="btn btn--sm" type="button" data-queue-toggle>${queueExpanded ? "Show less" : "Show all"}</button>` : ""}
      </div>
      ${shouldCompact ? `<div class="audit-queue__summary">Showing ${startIndex + 1}-${endIndex} of ${total} locations</div>` : ""}
      <div class="audit-queue-list ${compactLayout ? "audit-queue-list--compact" : ""}">
        ${visibleQueueItems.map((item, index) => {
          const actualIndex = shouldCompact ? startIndex + index : index;
          return `
          <button class="audit-queue-item ${actualIndex === currentIndex ? "audit-queue-item--active" : ""} ${item.status !== "pending" ? "audit-queue-item--done" : ""} ${item.local_pending_sync ? "audit-queue-item--local" : ""}" data-queue-index="${actualIndex}">
            ${escHtml(item.location)}
            <br><span>${escHtml(statusLabel(item.status))}</span>
            ${item.local_pending_sync ? `<span class="audit-queue-item__meta">${escHtml(item.local_sync_error ? "Needs sync attention" : "Saved locally")}</span>` : ""}
          </button>
        `;
        }).join("")}
      </div>
    </section>
  `;
}

async function loadTask({ keepIndex = false, advanceAfterLocation = "", silent = false } = {}) {
  const previousLocation = advanceAfterLocation || currentItem()?.location || "";
  await refreshPendingActions();
  try {
    const data = await apiJson(`/api/empty-bin/tasks/${encodeURIComponent(TASK_ID)}`);
    const task = overlayPendingActions(data.task, pendingActions);
    applyTaskState(task, computeSummary(task, data.summary), {
      keepIndex,
      advanceAfterLocation: previousLocation,
      source: "server",
      cloneTask: false,
    });
    lastSyncError = "";
  } catch (err) {
    const cached = loadTaskCache() || pullBootstrapTask();
    if (cached?.task) {
      const task = overlayPendingActions(cached.task, pendingActions);
      applyTaskState(task, computeSummary(task, cached.summary), {
        keepIndex,
        advanceAfterLocation: previousLocation,
        source: "cache",
        cloneTask: false,
      });
      if (!silent && !navigator.onLine) {
        window.RepoApp?.toast?.("Showing the saved task copy while you are offline.", "info");
      }
      return;
    }
    throw err;
  }
}

async function syncPendingQueue({ force = false } = {}) {
  if (syncInFlight || !TASK_ID) return;
  await refreshPendingActions();
  if (!pendingActions.length) {
    lastSyncError = "";
    renderSyncPanel();
    return;
  }
  if (!navigator.onLine) {
    renderSyncPanel();
    return;
  }

  syncInFlight = true;
  renderSyncPanel();
  try {
    let queue = await refreshPendingActions();
    while (queue.length) {
      const action = queue[0];
      if (action.lastError && !force) {
        lastSyncError = action.lastError;
        break;
      }
      try {
        const data = await apiJson(`/api/empty-bin/tasks/${encodeURIComponent(TASK_ID)}/locations/${encodeURIComponent(action.location)}/check`, {
          method: "POST",
          body: JSON.stringify({
            action: action.action,
            note: action.note,
            image_data_url: action.imageDataUrl,
          }),
        });
        await idbDeletePendingAction(action.id);
        queue = await refreshPendingActions();
        const task = overlayPendingActions(data.task, queue);
        applyTaskState(task, computeSummary(task, data.summary), {
          keepIndex: true,
          advanceAfterLocation: action.location,
          source: "server",
          cloneTask: false,
        });
        lastSyncError = "";
      } catch (err) {
        if (isLikelyNetworkError(err)) {
          break;
        }
        const failedAction = {
          ...action,
          lastError: String(err.message || err),
          lastAttemptAt: nowIso(),
        };
        await idbPutPendingAction(failedAction);
        queue = await refreshPendingActions();
        lastSyncError = failedAction.lastError;
        break;
      }
    }
  } finally {
    syncInFlight = false;
    renderSyncPanel();
  }
}

async function submitCheck(action) {
  if (busy) return;
  const item = currentItem();
  if (!item || item.status !== "pending") return;
  busy = true;
  try {
    if (photoPreparePromise) {
      await photoPreparePromise;
    }
    const note = noteDraftFor(item.location);
    const imageDataUrl = preparedPhoto?.location === item.location ? preparedPhoto.dataUrl : "";
    const pendingAction = buildPendingAction(item.location, action, note, imageDataUrl);
    await idbPutPendingAction(pendingAction);
    await refreshPendingActions();

    const localTask = cloneJson(auditTask);
    applyPendingActionToTask(localTask, pendingAction);
    applyTaskState(localTask, computeSummary(localTask), {
      keepIndex: true,
      advanceAfterLocation: item.location,
      source: "cache",
      cloneTask: false,
    });
    setNoteDraft(item.location, "");
    noteToolsExpanded = false;

    if ($("auditPhoto")) $("auditPhoto").value = "";
    resetPreparedPhoto();
    renderPhotoPreview("");
    setPhotoStatus("No photo attached");
    renderSyncPanel();

    if (navigator.onLine) {
      syncPendingQueue().catch(() => {});
    }
  } catch (err) {
    window.RepoApp?.toast?.(err.message || "The check could not be saved.", "error");
  } finally {
    busy = false;
  }
}

function storeBootstrapTask(taskId, task, summary) {
  try {
    sessionStorage.setItem(
      `repo-empty-bin-bootstrap:${String(taskId || "").trim()}`,
      JSON.stringify({
        task,
        summary: computeSummary(task, summary),
        cachedAt: nowIso(),
      })
    );
  } catch (_) {}
}

async function handleTaskAction(action) {
  if (!action) return;
  if (!navigator.onLine && ["complete", "assign", "drop", "stop"].includes(action)) {
    window.RepoApp?.toast?.("Reconnect before changing task assignment or completion.", "error");
    return;
  }

  const endpoint = {
    complete: `/api/empty-bin/tasks/${encodeURIComponent(TASK_ID)}/complete`,
    assign: `/api/empty-bin/tasks/${encodeURIComponent(TASK_ID)}/assign`,
    drop: `/api/empty-bin/tasks/${encodeURIComponent(TASK_ID)}/drop`,
    stop: `/api/empty-bin/tasks/${encodeURIComponent(TASK_ID)}/stop`,
  }[action];
  if (!endpoint) return;
  try {
    const data = await apiJson(endpoint, { method: "POST", body: "{}" });
    if (action === "complete") {
      if (data.full_clearing_task?.id) {
        storeBootstrapTask(data.full_clearing_task.id, data.full_clearing_task, computeSummary(data.full_clearing_task, data.clearing_task));
        window.location.href = `/empty-bins/tasks/${encodeURIComponent(data.full_clearing_task.id)}`;
        return;
      }
      window.location.href = "/empty-bins";
      return;
    }
    if (action === "stop") {
      window.location.href = "/empty-bins";
      return;
    }
    applyTaskState(data.task, computeSummary(data.task, data.summary), {
      keepIndex: true,
      source: "server",
    });
  } catch (err) {
    window.RepoApp?.toast?.(err.message || "That task action failed.", "error");
  }
}

function moveIndex(delta) {
  if (!auditItems.length) return;
  currentIndex = Math.max(0, Math.min(currentIndex + delta, auditItems.length - 1));
  noteToolsExpanded = false;
  queueExpanded = false;
  renderCurrent();
}

document.addEventListener("click", (event) => {
  const toolsToggle = event.target.closest("[data-tools-toggle]");
  if (toolsToggle) {
    noteToolsExpanded = !noteToolsExpanded;
    renderCurrent();
    return;
  }

  const queueToggle = event.target.closest("[data-queue-toggle]");
  if (queueToggle) {
    queueExpanded = !queueExpanded;
    renderCurrent();
    return;
  }

  const syncButton = event.target.closest("[data-sync-action]");
  if (syncButton) {
    const action = syncButton.dataset.syncAction;
    if (action === "sync-now") {
      syncPendingQueue({ force: true }).catch(() => {});
    }
    if (action === "refresh") {
      loadTask({ keepIndex: true }).catch((err) => {
        window.RepoApp?.toast?.(err.message || "Could not refresh the task.", "error");
      });
    }
    return;
  }

  const photoButton = event.target.closest("[data-photo-trigger]");
  if (photoButton) {
    $("auditPhoto")?.click();
    return;
  }

  const checkButton = event.target.closest("[data-check-action]");
  if (checkButton) {
    submitCheck(checkButton.dataset.checkAction);
    return;
  }

  const navButton = event.target.closest("[data-nav-action]");
  if (navButton) {
    const action = navButton.dataset.navAction;
    if (action === "prev") moveIndex(-1);
    if (action === "next") moveIndex(1);
    if (action === "next-pending") {
      currentIndex = nextPendingIndex(auditItems, currentIndex);
      noteToolsExpanded = false;
      queueExpanded = false;
      renderCurrent();
    }
    return;
  }

  const queueButton = event.target.closest("[data-queue-index]");
  if (queueButton) {
    currentIndex = Number(queueButton.dataset.queueIndex || 0);
    noteToolsExpanded = false;
    renderCurrent();
    return;
  }

  const taskButton = event.target.closest("[data-task-action]");
  if (taskButton) {
    handleTaskAction(taskButton.dataset.taskAction);
  }
});

document.addEventListener("change", (event) => {
  if (event.target?.id !== "auditPhoto") return;
  const item = currentItem();
  const file = event.target.files?.[0] || null;
  prepareAuditPhoto(file, item?.location || "").catch(() => {});
});

document.addEventListener("input", (event) => {
  if (event.target?.id !== "auditNote") return;
  const item = currentItem();
  setNoteDraft(item?.location || "", event.target.value || "");
});

window.addEventListener("online", () => {
  renderSyncPanel();
  window.RepoApp?.toast?.("Connection restored. Syncing saved checks...", "success");
  loadTask({ keepIndex: true, silent: true }).catch(() => {});
  syncPendingQueue().catch(() => {});
});

window.addEventListener("offline", () => {
  renderSyncPanel();
  window.RepoApp?.toast?.("You are offline. Checks will stay saved on this device.", "info");
});

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await refreshPendingActions();
    const bootstrap = pullBootstrapTask();
    if (bootstrap?.task) {
      const task = overlayPendingActions(bootstrap.task, pendingActions);
      applyTaskState(task, computeSummary(task, bootstrap.summary), { source: "cache", cloneTask: false });
    } else {
      const cached = loadTaskCache();
      if (cached?.task) {
        const task = overlayPendingActions(cached.task, pendingActions);
        applyTaskState(task, computeSummary(task, cached.summary), { source: "cache", cloneTask: false });
      }
    }

    renderSyncPanel();
    await loadTask({ keepIndex: Boolean(auditTask), silent: Boolean(auditTask) });
    if (navigator.onLine && pendingActions.length) {
      syncPendingQueue().catch(() => {});
    }
  } catch (err) {
    if (!auditTask) {
      $("auditMain").innerHTML = `<div class="audit-error">${escHtml(err.message)}</div>`;
      $("auditStatusChip").textContent = "Error";
    } else {
      window.RepoApp?.toast?.(err.message || "Could not refresh the task.", "error");
    }
    renderSyncPanel();
  }

  pollTimer = setInterval(() => {
    if (!navigator.onLine) return;
    loadTask({ keepIndex: true, silent: true }).catch(() => {});
    if (pendingActions.length) syncPendingQueue().catch(() => {});
  }, POLL_INTERVAL_MS);
});

window.addEventListener("beforeunload", () => {
  if (pollTimer) clearInterval(pollTimer);
  if (cacheSaveTimer) {
    clearTimeout(cacheSaveTimer);
    cacheSaveTimer = null;
    persistTaskCache();
  }
});

let lastCompactLayout = isCompactAuditLayout();
window.addEventListener("resize", () => {
  const compactLayout = isCompactAuditLayout();
  if (compactLayout === lastCompactLayout) return;
  lastCompactLayout = compactLayout;
  queueExpanded = false;
  noteToolsExpanded = false;
  if (auditTask) renderCurrent();
});
