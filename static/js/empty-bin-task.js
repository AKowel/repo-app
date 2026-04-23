"use strict";

let auditTask = null;
let auditSummary = null;
let auditItems = [];
let currentIndex = 0;
let busy = false;
let pollTimer = null;

const TASK_ID = window.EMPTY_BIN_TASK_ID || "";

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
  const date = tx.transaction_date || tx.snapshot_date || "";
  const item = tx.item || "-";
  const qty = fmt(tx.qty || 0);
  const order = tx.order_number ? ` | order ${tx.order_number}` : "";
  const user = tx.picker ? ` | by ${tx.picker}` : "";
  return `Last transaction: ${date || "-"} | ${item} | qty ${qty}${order}${user}`;
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
          <input class="fi" id="auditPhoto" type="file" accept="image/*" capture="environment" />
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

function readFileAsDataUrl(file) {
  if (!file) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Could not read image."));
    reader.readAsDataURL(file);
  });
}

async function submitCheck(action) {
  if (busy) return;
  const item = currentItem();
  if (!item || item.status !== "pending") return;
  busy = true;
  const note = $("auditNote")?.value || "";
  const file = $("auditPhoto")?.files?.[0] || null;
  try {
    const imageDataUrl = await readFileAsDataUrl(file);
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
