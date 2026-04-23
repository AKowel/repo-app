"use strict";

let auditTask = null;
let auditSummary = null;
let auditItems = [];
let currentIndex = 0;
let busy = false;
let pollTimer = null;
let preparedPhoto = null;
let photoPreparePromise = null;

const TASK_ID = window.EMPTY_BIN_TASK_ID || "";
const PHOTO_MAX_DIMENSION = 1600;
const PHOTO_JPEG_QUALITY = 0.72;

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

function statusLabel(status) {
  const labels = {
    pending: "Pending",
    checked_empty: "Empty",
    checked_not_empty: "Not empty",
    empty_pallet: "Empty pallet",
    move_required: "Needs move",
    moved: "Moved",
    skipped: "Skipped",
    cannot_complete: "Cannot complete",
    system_cleared: "System cleared",
  };
  return labels[status] || status || "Pending";
}

function statusTone(status) {
  if (status === "pending") return "pending";
  if (status === "checked_empty" || status === "empty_pallet" || status === "moved") return "good";
  if (status === "checked_not_empty" || status === "cannot_complete") return "bad";
  if (status === "system_cleared") return "system";
  return "warn";
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
    .filter(item => item.status !== "system_cleared")
    .slice()
    .sort((a, b) => Number(a.sort_index || 0) - Number(b.sort_index || 0));
}

function checkedCount(items) {
  return items.filter(item => item.status && item.status !== "pending").length;
}

function pendingCount(items) {
  return items.filter(item => item.status === "pending").length;
}

function firstPendingIndex(items) {
  const index = items.findIndex(item => item.status === "pending");
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

function setHeader() {
  const total = auditItems.length;
  const checked = checkedCount(auditItems);
  const pending = pendingCount(auditItems);
  $("auditTitle").textContent = auditTask?.title || "Empty bin audit";
  $("auditStatusChip").textContent = auditTask?.assignee
    ? `Assigned: ${auditTask.assignee.name || auditTask.assignee.email || "me"}`
    : "Unassigned";
  $("auditProgressChip").textContent = `${checked}/${total || 0} checked`;
  $("auditProgressText").textContent = `${pending} pending, ${checked} checked, ${auditSummary?.system_cleared_count || 0} cleared by live BINLOC`;
  $("auditProgressBar").style.width = total ? `${Math.round((checked / total) * 100)}%` : "0%";
}

function renderFact(label, value) {
  return `<div class="audit-fact"><span>${escHtml(label)}</span><b>${escHtml(value || "-")}</b></div>`;
}

function renderPhotos(item) {
  const photos = item?.photos || [];
  if (!photos.length) return "";
  return `
    <div class="audit-photo-row">
      ${photos.map(photo => `<a href="${escAttr(photo.url)}" target="_blank" rel="noreferrer"><img src="${escAttr(photo.url)}" alt="Photo for ${escAttr(item.location)}"></a>`).join("")}
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

function currentItem() {
  if (!auditItems.length) return null;
  currentIndex = Math.max(0, Math.min(currentIndex, auditItems.length - 1));
  return auditItems[currentIndex];
}

function renderComplete() {
  $("auditMain").innerHTML = `
    <section class="audit-empty">
      <h2>All checks are complete</h2>
      <p>${fmt(auditSummary?.checked_count || checkedCount(auditItems))} locations have been checked.</p>
      <div class="audit-complete-actions">
        <button class="btn btn--primary" data-task-action="complete">Complete task</button>
        <button class="btn" data-task-action="followup">Create move task</button>
        <a class="btn" href="/empty-bins">Back to task list</a>
      </div>
    </section>
    ${renderQueue()}
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
  const live = item.live || {};
  const positionText = `Location ${currentIndex + 1} of ${auditItems.length}`;
  const actions = auditTask?.type === "move_pallets"
    ? [
        ["moved", "Moved"],
        ["cannot_complete", "Cannot do"],
        ["skipped", "Skip"],
      ]
    : [
        ["empty", "Empty"],
        ["not_empty", "Not empty"],
        ["empty_pallet", "Empty pallet"],
        ["needs_move", "Needs move"],
      ];
  const photoReady = preparedPhoto?.location === item.location && preparedPhoto.dataUrl;
  const photoStatusText = photoReady && preparedPhoto.timestamp
    ? `Photo ready | ${preparedPhoto.timestamp}`
    : "No photo attached";

  $("auditMain").innerHTML = `
    <section class="audit-card" data-current-location="${escAttr(item.location)}">
      <div class="audit-location-head">
        <div>
          <div class="audit-location">${escHtml(item.location)}</div>
          <div class="audit-subline">${escHtml(positionText)} | ${escHtml(item.operating_area || "-")} | ${escHtml(item.bin_size || "-")} | ${escHtml(item.bin_type || "-")} | level ${escHtml(item.level || "-")}</div>
        </div>
        <span class="audit-status audit-status--${escAttr(statusTone(item.status))}">${escHtml(statusLabel(item.status))}</span>
      </div>

      <div class="audit-last">${escHtml(formatLastTransaction(item.last_transaction))}</div>

      <div class="audit-facts">
        ${renderFact("Live qty", fmt(live.current_qty ?? item.current_qty_at_create))}
        ${renderFact("Live SKU", live.item_sku || "-")}
        ${renderFact("Created qty", fmt(item.current_qty_at_create))}
        ${renderFact("Source", item.source_reason || "-")}
      </div>

      ${item.system_cleared_reason ? `<div class="audit-last">${escHtml(item.system_cleared_reason)}</div>` : ""}
      ${item.note ? `<div class="audit-last">${escHtml(item.note)}</div>` : ""}
      ${renderPhotos(item)}

      ${pending ? `
        <div class="audit-inputs">
          <textarea class="fi audit-note" id="auditNote" placeholder="Optional note"></textarea>
          <div class="audit-photo-picker">
            <button class="audit-camera-btn" type="button" data-photo-trigger>Take photo</button>
            <input id="auditPhoto" type="file" accept="image/*" capture="environment" hidden />
            <div class="audit-photo-status" id="auditPhotoStatus" data-tone="${photoReady ? "ready" : ""}">${escHtml(photoStatusText)}</div>
            <div class="audit-photo-preview" id="auditPhotoPreview">${photoReady ? `<img src="${escAttr(preparedPhoto.dataUrl)}" alt="Compressed audit photo preview">` : ""}</div>
          </div>
        </div>
        <div class="audit-actions">
          ${actions.map(([action, label]) => `<button class="audit-action ${action === "empty" || action === "moved" ? "audit-action--primary" : ""}" data-check-action="${escAttr(action)}">${escHtml(label)}</button>`).join("")}
        </div>
      ` : `
        <div class="audit-last">This location is already marked as ${escHtml(statusLabel(item.status))}.</div>
      `}
    </section>

    <nav class="audit-nav">
      <button class="btn" data-nav-action="prev">Previous</button>
      <button class="btn" data-nav-action="next-pending">Next pending</button>
      <button class="btn" data-nav-action="next">Next</button>
    </nav>

    ${pendingCount(auditItems) === 0 ? `
      <section class="audit-empty">
        <p>No pending locations remain.</p>
        <div class="audit-complete-actions">
          <button class="btn btn--primary" data-task-action="complete">Complete task</button>
          <button class="btn" data-task-action="followup">Create move task</button>
        </div>
      </section>
    ` : ""}

    ${renderQueue()}
  `;
}

function renderQueue() {
  if (!auditItems.length) return "";
  return `
    <section class="audit-queue">
      <div class="audit-queue__title">Task queue</div>
      <div class="audit-queue-list">
        ${auditItems.map((item, index) => `
          <button class="audit-queue-item ${index === currentIndex ? "audit-queue-item--active" : ""} ${item.status !== "pending" ? "audit-queue-item--done" : ""}" data-queue-index="${index}">
            ${escHtml(item.location)}
            <br><span>${escHtml(statusLabel(item.status))}</span>
          </button>
        `).join("")}
      </div>
    </section>
  `;
}

async function loadTask({ keepIndex = false, advanceAfterLocation = "" } = {}) {
  const previousLocation = advanceAfterLocation || currentItem()?.location || "";
  const data = await apiJson(`/api/empty-bin/tasks/${encodeURIComponent(TASK_ID)}`);
  auditTask = data.task;
  auditSummary = data.summary;
  auditItems = visibleItems(auditTask);

  if (!keepIndex) {
    currentIndex = firstPendingIndex(auditItems);
  } else if (previousLocation) {
    const previousIndex = auditItems.findIndex(item => item.location === previousLocation);
    currentIndex = previousIndex >= 0 ? nextPendingIndex(auditItems, previousIndex) : firstPendingIndex(auditItems);
  }

  renderCurrent();
}

async function submitCheck(action) {
  if (busy) return;
  const item = currentItem();
  if (!item || item.status !== "pending") return;
  busy = true;
  const note = $("auditNote")?.value || "";
  try {
    if (photoPreparePromise) {
      await photoPreparePromise;
    }
    const imageDataUrl = preparedPhoto?.location === item.location ? preparedPhoto.dataUrl : "";
    await apiJson(`/api/empty-bin/tasks/${encodeURIComponent(TASK_ID)}/locations/${encodeURIComponent(item.location)}/check`, {
      method: "POST",
      body: JSON.stringify({ action, note, image_data_url: imageDataUrl }),
    });
    await loadTask({ keepIndex: true, advanceAfterLocation: item.location });
  } catch (err) {
    $("auditMain").insertAdjacentHTML("afterbegin", `<div class="audit-error">${escHtml(err.message)}</div>`);
  } finally {
    busy = false;
  }
}

async function handleTaskAction(action) {
  if (!action) return;
  const endpoint = {
    complete: `/api/empty-bin/tasks/${encodeURIComponent(TASK_ID)}/complete`,
    followup: `/api/empty-bin/tasks/${encodeURIComponent(TASK_ID)}/create-followup`,
    assign: `/api/empty-bin/tasks/${encodeURIComponent(TASK_ID)}/assign`,
    drop: `/api/empty-bin/tasks/${encodeURIComponent(TASK_ID)}/drop`,
  }[action];
  if (!endpoint) return;
  try {
    const data = await apiJson(endpoint, { method: "POST", body: "{}" });
    if (action === "followup" && data.task?.id) {
      window.location.href = `/empty-bins/tasks/${encodeURIComponent(data.task.id)}`;
      return;
    }
    if (action === "complete") {
      window.location.href = "/empty-bins";
      return;
    }
    await loadTask({ keepIndex: true });
  } catch (err) {
    $("auditMain").insertAdjacentHTML("afterbegin", `<div class="audit-error">${escHtml(err.message)}</div>`);
  }
}

function moveIndex(delta) {
  if (!auditItems.length) return;
  currentIndex = Math.max(0, Math.min(currentIndex + delta, auditItems.length - 1));
  renderCurrent();
}

document.addEventListener("click", (event) => {
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
      renderCurrent();
    }
    return;
  }

  const queueButton = event.target.closest("[data-queue-index]");
  if (queueButton) {
    currentIndex = Number(queueButton.dataset.queueIndex || 0);
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

document.addEventListener("DOMContentLoaded", () => {
  loadTask().catch((err) => {
    $("auditMain").innerHTML = `<div class="audit-error">${escHtml(err.message)}</div>`;
    $("auditStatusChip").textContent = "Error";
  });
  pollTimer = setInterval(() => loadTask({ keepIndex: true }).catch(() => {}), 5 * 60 * 1000);
});

window.addEventListener("beforeunload", () => {
  if (pollTimer) clearInterval(pollTimer);
});
