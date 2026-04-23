"use strict";

let _live = null;
let _tasks = [];
let _activeTask = null;
let _activeSummary = null;
let _pollTimer = null;

const selClient = () => document.getElementById("eSelClient");
const selArea = () => document.getElementById("eSelArea");
const selBinSize = () => document.getElementById("eSelBinSize");
const inpDate = () => document.getElementById("eInpDate");
const inpSearch = () => document.getElementById("eInpSearch");
const selLimit = () => document.getElementById("eSelLimit");

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

function setChip(id, text, visible = true) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || "";
  el.style.display = visible && text ? "" : "none";
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
  if (status === "system_cleared") return "system";
  if (status === "checked_empty" || status === "empty_pallet" || status === "moved") return "good";
  if (status === "checked_not_empty" || status === "cannot_complete") return "bad";
  return "warn";
}

function chipStatus(status) {
  return `<span class="empty-status empty-status--${escAttr(statusTone(status))}">${escHtml(statusLabel(status))}</span>`;
}

function formatLastTransaction(tx) {
  if (!tx) return "Last transaction: none found";
  const date = tx.transaction_date || tx.snapshot_date || "";
  const item = tx.item || "-";
  const qty = fmt(tx.qty || 0);
  const order = tx.order_number ? ` · order ${tx.order_number}` : "";
  const user = tx.picker ? ` · by ${tx.picker}` : "";
  return `Last transaction: ${date || "-"} · ${item} · qty ${qty}${order}${user}`;
}

function dateOffsetYmd(offsetDays) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function selectedReportDate() {
  return inpDate()?.value || dateOffsetYmd(-1);
}

function buildLiveQuery() {
  const params = new URLSearchParams();
  params.set("client", selClient().value);
  params.set("date", selectedReportDate());
  params.set("limit", selLimit().value);
  if (selArea().value) params.set("area", selArea().value);
  if (selBinSize().value) params.set("bin_size", selBinSize().value);
  if (inpSearch().value.trim()) params.set("search", inpSearch().value.trim());
  return params;
}

async function apiJson(url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const json = await resp.json();
  if (!json.ok) throw new Error(json.error || "Request failed.");
  return json;
}

function updateSelectOptions(select, options, key, placeholder) {
  const previous = select.value;
  select.innerHTML = `<option value="">${escHtml(placeholder)}</option>` +
    (options || []).slice(0, 150).map((item) =>
      `<option value="${escAttr(item[key])}">${escHtml(item[key])} (${fmt(item.count)})</option>`
    ).join("");
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}

async function loadLive() {
  setChip("eChipStatus", "Loading live BINLOC...");
  try {
    const data = await apiJson("/api/empty-bin/live?" + buildLiveQuery().toString());
    _live = data;
    updateSelectOptions(selArea(), data.meta?.filters?.areas || [], "area", "All areas");
    updateSelectOptions(selBinSize(), data.meta?.filters?.bin_sizes || [], "bin_size", "All sizes");
    renderLive();
    setChip("eChipLive", `${fmt(data.summary.empty_count)} empties on ${data.meta?.report_date || selectedReportDate()}`);
    setChip("eChipStatus", "Live loaded");
  } catch (err) {
    document.getElementById("eTab-live").innerHTML = errorHtml(err.message);
    setChip("eChipStatus", "Error");
  }
}

async function loadTasks() {
  try {
    const params = new URLSearchParams({ client: selClient().value });
    const data = await apiJson("/api/empty-bin/tasks?" + params.toString());
    _tasks = data.tasks || [];
    renderTasks();
    setChip("eChipTasks", `${fmt(_tasks.length)} tasks`, true);
  } catch (err) {
    document.getElementById("eTaskList").innerHTML = errorHtml(err.message);
  }
}

async function loadTask(taskId, { silent = false } = {}) {
  if (!silent) setChip("eChipStatus", "Loading task...");
  const data = await apiJson(`/api/empty-bin/tasks/${encodeURIComponent(taskId)}`);
  _activeTask = data.task;
  _activeSummary = data.summary;
  renderTask();
  renderReport();
  switchTab("task");
  if (!silent) setChip("eChipStatus", "Task loaded");
  startPolling();
}

function startPolling() {
  if (_pollTimer) clearInterval(_pollTimer);
  if (!_activeTask) return;
  _pollTimer = setInterval(() => {
    if (_activeTask?.id) loadTask(_activeTask.id, { silent: true }).catch(() => {});
  }, 5 * 60 * 1000);
}

function renderLive() {
  const rows = _live?.rows || [];
  const meta = _live?.meta || {};
  const daySource = meta.day_source || {};
  const html = `
    <div class="empty-live-head">
      <div>
        <div class="empty-title">FANDMKET empty locations for ${escHtml(meta.report_date || selectedReportDate())}</div>
        <div class="empty-muted">BINLOC ${escHtml(meta.snapshot_date || "latest")} &middot; synced ${escHtml(meta.source_synced_at || "-")} &middot; ${fmt(daySource.pick_transaction_locations || 0)} same-day pick locations</div>
      </div>
      <button class="btn btn--primary btn--sm" id="eBtnCreateTaskInline">Create task from this view</button>
    </div>
    ${daySource.pick_transaction_error ? `<div class="empty-system-banner">Pick transaction snapshot was not available: ${escHtml(daySource.pick_transaction_error)}. BINLOC last-move-out dates are still being used.</div>` : ""}
    ${rows.length ? `<div class="empty-live-list">${rows.map(renderLiveRow).join("")}</div>` : emptyState("No FANDMKET locations that went empty on this date are still empty in live BINLOC.")}
  `;
  document.getElementById("eTab-live").innerHTML = html;
  document.getElementById("eBtnCreateTaskInline")?.addEventListener("click", createTaskFromFilters);
}

function renderLiveRow(row) {
  return `
    <div class="empty-live-row">
      <div>
        <div class="empty-location">${escHtml(row.location)}</div>
        <div class="empty-last-transaction">${escHtml(formatLastTransaction(row.last_transaction))}</div>
        <div class="empty-muted">${escHtml(row.source_reason || "date matched")} &middot; out ${escHtml(row.last_move_out_date || "-")}</div>
        <div class="empty-muted">${escHtml(row.operating_area || "-")} · ${escHtml(row.bin_size || "-")} · level ${escHtml(row.level || "-")}</div>
      </div>
      <div class="empty-live-row__meta">
        <span>${escHtml(row.bin_type || "-")}</span>
        <span>Out ${escHtml(row.last_move_out_date || "-")}</span>
        <span>Max ${fmt(row.max_bin_qty)}</span>
      </div>
    </div>
  `;
}

function renderTasks() {
  const el = document.getElementById("eTaskList");
  if (!_tasks.length) {
    el.innerHTML = emptyState("No empty-bin tasks yet. Create one from the live report.");
    return;
  }
  el.innerHTML = _tasks.map((task) => `
    <div class="empty-task-card ${_activeTask?.id === task.id ? "empty-task-card--active" : ""}" data-empty-task-id="${escAttr(task.id)}" role="button" tabindex="0">
      <span class="empty-task-card__title">${escHtml(task.title)}</span>
      <span class="empty-task-card__meta">${escHtml(task.type === "move_pallets" ? "Move pallets" : "Empty check")} · ${escHtml(task.status)}</span>
      <span class="empty-task-card__counts">${fmt(task.checked_count)} checked · ${fmt(task.pending_count)} pending · ${fmt(task.system_cleared_count)} cleared</span>
      <span class="empty-task-card__assignee">${task.assignee ? `Assigned to ${escHtml(task.assignee.name || task.assignee.email)}` : "Unassigned"}</span>
      <span class="empty-task-card__open">Open task</span>
    </div>
  `).join("");
}

function taskControlsHtml(task, summary) {
  const assigned = Boolean(task.assignee);
  return `
    <div class="empty-task-controls">
      <div>
        <div class="empty-title">${escHtml(task.title)}</div>
        <div class="empty-muted">${fmt(summary.checked_count)} checked · ${fmt(summary.pending_count)} pending · ${fmt(summary.system_cleared_count)} system cleared · ${fmt(summary.photo_count)} photos</div>
      </div>
      <div class="empty-task-actions">
        <button class="btn btn--sm" data-task-action="assign">${assigned ? "Reassign to me" : "Assign to me"}</button>
        <button class="btn btn--sm" data-task-action="drop">Drop task</button>
        <button class="btn btn--sm" data-task-action="followup">Create move task</button>
        <button class="btn btn--primary btn--sm" data-task-action="complete">Complete</button>
      </div>
    </div>
  `;
}

function renderTask() {
  const el = document.getElementById("eTab-task");
  if (!_activeTask) {
    el.innerHTML = emptyState("Open or create a task to start checking locations.");
    return;
  }
  const allItems = (_activeTask.items || []);
  const hiddenSystemCleared = allItems.filter(item => item.status === "system_cleared").length;
  const items = allItems.filter(item => item.status !== "system_cleared").slice().sort((a, b) => {
    const aPending = a.status === "pending" ? 0 : 1;
    const bPending = b.status === "pending" ? 0 : 1;
    return aPending - bPending || a.sort_index - b.sort_index;
  });
  const cards = items.map(renderCheckCard).join("");
  el.innerHTML = taskControlsHtml(_activeTask, _activeSummary || summarizeClientTask(_activeTask)) +
    (hiddenSystemCleared ? `<div class="empty-system-banner">${fmt(hiddenSystemCleared)} locations were cleared by live BINLOC and are hidden from the checking queue. They remain in the report tab.</div>` : "") +
    `<div class="empty-check-list">${cards}</div>`;
}

function summarizeClientTask(task) {
  const items = task.items || [];
  return {
    checked_count: items.filter(item => item.status && item.status !== "pending" && item.status !== "system_cleared").length,
    pending_count: items.filter(item => item.status === "pending").length,
    system_cleared_count: items.filter(item => item.status === "system_cleared").length,
    photo_count: items.reduce((sum, item) => sum + ((item.photos || []).length), 0),
  };
}

function renderCheckCard(item) {
  const pending = item.status === "pending";
  const live = item.live || {};
  const actions = _activeTask?.type === "move_pallets"
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
  const photos = (item.photos || []).map((photo) =>
    `<a class="empty-photo" href="${escAttr(photo.url)}" target="_blank" rel="noreferrer"><img src="${escAttr(photo.url)}" alt="Photo for ${escAttr(item.location)}" /></a>`
  ).join("");
  return `
    <div class="empty-check-card empty-check-card--${escAttr(statusTone(item.status))}" data-location="${escAttr(item.location)}">
      <div class="empty-check-card__top">
        <div>
          <div class="empty-location">${escHtml(item.location)}</div>
          <div class="empty-last-transaction">${escHtml(formatLastTransaction(item.last_transaction))}</div>
          <div class="empty-muted">${escHtml(item.operating_area || "-")} · ${escHtml(item.bin_size || "-")} · ${escHtml(item.bin_type || "-")} · level ${escHtml(item.level || "-")}</div>
        </div>
        ${chipStatus(item.status)}
      </div>
      <div class="empty-facts">
        <span>Live qty ${fmt(live.current_qty ?? item.current_qty_at_create)}</span>
        <span>Live SKU ${escHtml(live.item_sku || "-")}</span>
        <span>${escHtml(formatLastTransaction(item.last_transaction))}</span>
      </div>
      ${item.system_cleared_reason ? `<div class="empty-system-note">${escHtml(item.system_cleared_reason)}</div>` : ""}
      ${item.note ? `<div class="empty-note">${escHtml(item.note)}</div>` : ""}
      ${photos ? `<div class="empty-photo-row">${photos}</div>` : ""}
      ${pending ? `
        <div class="empty-card-inputs">
          <textarea class="fi empty-note-input" placeholder="Optional note"></textarea>
          <input class="fi empty-photo-input" type="file" accept="image/*" capture="environment" />
        </div>
        <div class="empty-card-actions">
          ${actions.map(([action, label]) => `<button class="btn btn--sm ${action === "empty" || action === "moved" ? "btn--primary" : ""}" data-check-action="${escAttr(action)}">${escHtml(label)}</button>`).join("")}
        </div>
      ` : ""}
    </div>
  `;
}

function renderReport() {
  const el = document.getElementById("eTab-report");
  if (!_activeTask) {
    el.innerHTML = emptyState("Open a task to view the full report.");
    return;
  }
  const rows = _activeTask.items || [];
  el.innerHTML = `
    ${taskControlsHtml(_activeTask, _activeSummary || summarizeClientTask(_activeTask))}
    <div class="empty-report-list">
      ${rows.map(renderReportRow).join("")}
    </div>
  `;
}

function renderReportRow(item) {
  const photos = (item.photos || []).map((photo) =>
    `<a class="empty-photo" href="${escAttr(photo.url)}" target="_blank" rel="noreferrer"><img src="${escAttr(photo.url)}" alt="Photo for ${escAttr(item.location)}" /></a>`
  ).join("");
  return `
    <div class="empty-report-row">
      <div>
        <div class="empty-location">${escHtml(item.location)}</div>
        <div class="empty-last-transaction">${escHtml(formatLastTransaction(item.last_transaction))}</div>
        <div class="empty-muted">${escHtml(item.operating_area || "-")} · ${escHtml(item.bin_size || "-")} · ${escHtml(item.bin_type || "-")}</div>
        ${item.note ? `<div class="empty-note">${escHtml(item.note)}</div>` : ""}
      </div>
      <div>${chipStatus(item.status)}</div>
      <div class="empty-photo-row">${photos || "<span class='empty-muted'>No photos</span>"}</div>
    </div>
  `;
}

function emptyState(message) {
  return `<div class="empty-state"><div class="empty-state__title">Nothing here yet</div><div class="empty-state__desc">${escHtml(message)}</div></div>`;
}

function errorHtml(message) {
  return `<div class="alert alert--error" style="margin:12px">${escHtml(message)}</div>`;
}

function switchTab(name) {
  document.querySelectorAll("#eTabs .reports-tab-btn").forEach((btn) => {
    const active = btn.dataset.tab === name;
    btn.classList.toggle("reports-tab-btn--active", active);
    btn.classList.toggle("tabbtn--on", active);
  });
  document.querySelectorAll("#eTab-live,#eTab-task,#eTab-report").forEach((el) => {
    el.classList.toggle("reports-tab-content--active", el.id === `eTab-${name}`);
  });
}

async function createTaskFromFilters() {
  setChip("eChipStatus", "Creating task...");
  const filters = {};
  filters.date = selectedReportDate();
  if (selArea().value) filters.area = selArea().value;
  if (selBinSize().value) filters.bin_size = selBinSize().value;
  if (inpSearch().value.trim()) filters.search = inpSearch().value.trim();
  try {
    const created = await apiJson("/api/empty-bin/tasks", {
      method: "POST",
      body: JSON.stringify({
        client: selClient().value,
        type: "empty_check",
        title: `Daily empty bin check ${selectedReportDate()}`,
        report_date: selectedReportDate(),
        filters,
        limit: selLimit().value,
      }),
    });
    await apiJson(`/api/empty-bin/tasks/${encodeURIComponent(created.task.id)}/assign`, { method: "POST", body: "{}" });
    await loadTasks();
    await loadTask(created.task.id);
    setChip("eChipStatus", "Task created");
  } catch (err) {
    window.RepoApp?.toast?.(err.message, "error");
    setChip("eChipStatus", "Error");
  }
}

async function handleTaskAction(action) {
  if (!_activeTask) return;
  const id = encodeURIComponent(_activeTask.id);
  const endpoint = {
    assign: `/api/empty-bin/tasks/${id}/assign`,
    drop: `/api/empty-bin/tasks/${id}/drop`,
    complete: `/api/empty-bin/tasks/${id}/complete`,
    followup: `/api/empty-bin/tasks/${id}/create-followup`,
  }[action];
  if (!endpoint) return;
  try {
    const data = await apiJson(endpoint, { method: "POST", body: "{}" });
    if (action === "followup") {
      await loadTasks();
      await loadTask(data.task.id);
    } else {
      await loadTasks();
      await loadTask(_activeTask.id, { silent: true });
    }
  } catch (err) {
    window.RepoApp?.toast?.(err.message, "error");
  }
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

async function submitCheck(card, action) {
  const location = card.dataset.location;
  const note = card.querySelector(".empty-note-input")?.value || "";
  const file = card.querySelector(".empty-photo-input")?.files?.[0] || null;
  const imageDataUrl = await readFileAsDataUrl(file);
  try {
    await apiJson(`/api/empty-bin/tasks/${encodeURIComponent(_activeTask.id)}/locations/${encodeURIComponent(location)}/check`, {
      method: "POST",
      body: JSON.stringify({ action, note, image_data_url: imageDataUrl }),
    });
    await loadTask(_activeTask.id, { silent: true });
  } catch (err) {
    window.RepoApp?.toast?.(err.message, "error");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  if (inpDate() && !inpDate().value) inpDate().value = dateOffsetYmd(-1);
  setChip("eChipClient", selClient().options[selClient().selectedIndex]?.text || selClient().value);
  loadLive();
  loadTasks();

  document.getElementById("eBtnLoadLive").addEventListener("click", loadLive);
  document.getElementById("eBtnLoadTasks").addEventListener("click", loadTasks);
  document.getElementById("eBtnCreateTask").addEventListener("click", createTaskFromFilters);
  selClient().addEventListener("change", () => {
    setChip("eChipClient", selClient().options[selClient().selectedIndex]?.text || selClient().value);
    _activeTask = null;
    loadLive();
    loadTasks();
    renderTask();
    renderReport();
  });
  [inpDate(), selArea(), selBinSize(), selLimit()].forEach((el) => el?.addEventListener("change", loadLive));
  inpSearch().addEventListener("keydown", (event) => {
    if (event.key === "Enter") loadLive();
  });

  document.getElementById("eTabs").addEventListener("click", (event) => {
    const btn = event.target.closest(".reports-tab-btn");
    if (btn) switchTab(btn.dataset.tab);
  });
  document.addEventListener("click", (event) => {
    const taskCard = event.target.closest("[data-empty-task-id]");
    if (taskCard) {
      loadTask(taskCard.dataset.emptyTaskId).catch((err) => window.RepoApp?.toast?.(err.message, "error"));
      return;
    }
    const taskAction = event.target.closest("[data-task-action]");
    if (taskAction) {
      handleTaskAction(taskAction.dataset.taskAction);
      return;
    }
    const checkButton = event.target.closest("[data-check-action]");
    if (checkButton) {
      const card = checkButton.closest("[data-location]");
      if (card) submitCheck(card, checkButton.dataset.checkAction);
    }
  });
  document.addEventListener("keydown", (event) => {
    const taskCard = event.target.closest("[data-empty-task-id]");
    if (!taskCard || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    loadTask(taskCard.dataset.emptyTaskId).catch((err) => window.RepoApp?.toast?.(err.message, "error"));
  });
});
