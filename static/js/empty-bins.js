"use strict";

let _report = null;
let _tasks = [];
let _activeTask = null;
let _activeSummary = null;
let _pollTimer = null;
let _reportSync = null;
let _reportSyncTimer = null;
let _reportSyncReadyToast = false;
const EMPTY_BIN_BOOTSTRAP_PREFIX = "repo-empty-bin-bootstrap:";

const selClient = () => document.getElementById("eSelClient");
const selArea = () => document.getElementById("eSelArea");
const selBinSize = () => document.getElementById("eSelBinSize");
const inpDate = () => document.getElementById("eInpDate");
const inpSearch = () => document.getElementById("eInpSearch");
const selLimit = () => document.getElementById("eSelLimit");

function fmt(n) {
  return Number(n ?? 0).toLocaleString();
}

function computeTaskSummary(task, summary = null) {
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

function storeBootstrapTask(taskId, task, summary = null) {
  if (!taskId || !task) return;
  try {
    sessionStorage.setItem(
      `${EMPTY_BIN_BOOTSTRAP_PREFIX}${String(taskId).trim()}`,
      JSON.stringify({
        task,
        summary: computeTaskSummary(task, summary),
        cachedAt: new Date().toISOString(),
      })
    );
  } catch (_) {}
}

function formatDateTimeText(value) {
  const text = String(value || "").trim();
  if (!text) return "-";
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return parsed.toLocaleString();
  return text;
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
    cleared: "Cleared",
    operations_filled: "Operations filled",
    stopped: "Stopped",
    skipped: "Skipped",
    system_cleared: "System cleared",
    completed: "Completed",
    available: "Available",
    in_progress: "In progress",
  };
  return labels[status] || status || "Pending";
}

function statusTone(status) {
  if (status === "pending" || status === "available" || status === "in_progress") return "pending";
  if (status === "system_cleared") return "system";
  if (["checked_empty", "cleared", "operations_filled", "completed"].includes(status)) return "good";
  if (status === "checked_not_empty") return "bad";
  return "warn";
}

function chipStatus(status) {
  return `<span class="empty-status empty-status--${escAttr(statusTone(status))}">${escHtml(statusLabel(status))}</span>`;
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

function buildReportQuery() {
  const params = new URLSearchParams();
  params.set("client", selClient().value);
  params.set("date", selectedReportDate());
  params.set("limit", selLimit().value);
  if (selArea().value) params.set("area", selArea().value);
  if (selBinSize().value) params.set("bin_size", selBinSize().value);
  if (inpSearch().value.trim()) params.set("search", inpSearch().value.trim());
  return params;
}

function buildReportSyncQuery() {
  const params = new URLSearchParams();
  params.set("date", selectedReportDate());
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

function updateSelectOptions(select, options, key, placeholder) {
  if (!select) return;
  const previous = select.value;
  select.innerHTML = `<option value="">${escHtml(placeholder)}</option>` +
    (options || []).slice(0, 150).map((item) =>
      `<option value="${escAttr(item[key])}">${escHtml(item[key])} (${fmt(item.count)})</option>`
    ).join("");
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}

function setCreateTaskEnabled(enabled) {
  const button = document.getElementById("eBtnCreateTask");
  if (!button) return;
  button.disabled = !enabled;
}

function stopReportSyncPolling() {
  if (_reportSyncTimer) clearInterval(_reportSyncTimer);
  _reportSyncTimer = null;
}

function shouldPollReportSync(sync) {
  const status = String(sync?.status || "").trim().toLowerCase();
  return !Boolean(sync?.snapshot?.available) && (status === "queued" || status === "running");
}

function startReportSyncPolling() {
  stopReportSyncPolling();
  if (!shouldPollReportSync(_reportSync)) return;
  _reportSyncTimer = setInterval(() => {
    loadReportSyncStatus({ silent: true }).catch(() => {});
  }, 4000);
}

function renderReportSyncStatus() {
  const el = document.getElementById("eReportSyncStatus");
  if (!el) return;

  if (!_reportSync) {
    el.innerHTML = `
      <div class="empty-sync-banner empty-sync-banner--idle">
        <div class="empty-sync-banner__title">Checking daily report status...</div>
      </div>
    `;
    return;
  }

  const snapshot = _reportSync.snapshot || {};
  const job = _reportSync.job || null;
  const status = String(_reportSync.status || "").trim().toLowerCase();

  if (snapshot.available) {
    el.innerHTML = `
      <div class="empty-sync-banner empty-sync-banner--ready">
        <div class="empty-sync-banner__title">Daily empty-bin report is ready for ${escHtml(_reportSync.report_date || selectedReportDate())}.</div>
        <div class="empty-sync-banner__meta">
          ${fmt(snapshot.row_count)} rows | uploaded ${escHtml(formatDateTimeText(snapshot.uploaded_at))} | synced ${escHtml(formatDateTimeText(snapshot.source_synced_at))}
        </div>
      </div>
    `;
    return;
  }

  if (status === "queued" || status === "running") {
    const requested = job?.requested_at ? `Requested ${escHtml(formatDateTimeText(job.requested_at))}` : "Request queued";
    const claimed = job?.claimed_at ? ` | Started ${escHtml(formatDateTimeText(job.claimed_at))}` : "";
    el.innerHTML = `
      <div class="empty-sync-banner empty-sync-banner--pending">
        <div class="empty-sync-banner__title">Daily empty-bin report is ${escHtml(status)} for ${escHtml(_reportSync.report_date || selectedReportDate())}.</div>
        <div class="empty-sync-banner__meta">${requested}${claimed} | Requested by ${escHtml(job?.requested_by || "-")}</div>
        <div class="empty-sync-banner__note">Tasks are created from the daily report snapshot once it arrives.</div>
      </div>
    `;
    return;
  }

  if (status === "failed" && job) {
    el.innerHTML = `
      <div class="empty-sync-banner empty-sync-banner--failed">
        <div class="empty-sync-banner__title">The last daily empty-bin report request failed for ${escHtml(_reportSync.report_date || selectedReportDate())}.</div>
        <div class="empty-sync-banner__meta">Failed ${escHtml(formatDateTimeText(job.failed_at || job.completed_at || job.requested_at))} | Attempt ${fmt(job.attempt_count || 0)}</div>
        <div class="empty-sync-banner__note">${escHtml(job.error_text || "The local sync agent reported a failure.")}</div>
      </div>
    `;
    return;
  }

  el.innerHTML = `
    <div class="empty-sync-banner empty-sync-banner--idle">
      <div class="empty-sync-banner__title">No daily empty-bin report snapshot has been loaded for ${escHtml(_reportSync.report_date || selectedReportDate())} yet.</div>
      <div class="empty-sync-banner__note">Request the daily report first, then create the audit from that exact snapshot.</div>
    </div>
  `;
}

async function loadReportSyncStatus({ silent = false } = {}) {
  const previousAvailable = Boolean(_reportSync?.snapshot?.available);
  try {
    const data = await apiJson("/api/empty-bin/report-sync-status?" + buildReportSyncQuery().toString());
    _reportSync = data.sync || null;
    renderReportSyncStatus();
    startReportSyncPolling();
    const nextAvailable = Boolean(_reportSync?.snapshot?.available);
    if (!previousAvailable && nextAvailable) {
      await loadSourceReport();
      if (_reportSyncReadyToast) {
        window.RepoApp?.toast?.("Daily empty-bin report loaded.", "success");
        _reportSyncReadyToast = false;
      }
    }
  } catch (err) {
    stopReportSyncPolling();
    document.getElementById("eReportSyncStatus").innerHTML = errorHtml(err.message);
    if (!silent) window.RepoApp?.toast?.(err.message, "error");
  }
}

async function requestReportSync(force = false) {
  setChip("eChipStatus", "Requesting daily report...");
  try {
    const data = await apiJson("/api/empty-bin/report-sync-request", {
      method: "POST",
      body: JSON.stringify({ report_date: selectedReportDate(), force }),
    });
    _reportSync = data.sync || null;
    renderReportSyncStatus();
    startReportSyncPolling();
    if (data.created) {
      _reportSyncReadyToast = true;
      window.RepoApp?.toast?.("Daily empty-bin report requested.", "success");
      setChip("eChipStatus", "Report requested");
    } else if (_reportSync?.snapshot?.available) {
      _reportSyncReadyToast = false;
      window.RepoApp?.toast?.("Daily empty-bin report is already available.", "success");
      setChip("eChipStatus", "Report ready");
      await loadSourceReport();
    } else {
      _reportSyncReadyToast = true;
      window.RepoApp?.toast?.(`Daily empty-bin report is already ${_reportSync?.status || "queued"}.`, "info");
      setChip("eChipStatus", "Using existing request");
    }
  } catch (err) {
    window.RepoApp?.toast?.(err.message, "error");
    setChip("eChipStatus", "Request failed");
  }
}

async function loadSourceReport() {
  setChip("eChipStatus", "Loading daily report...");
  try {
    const data = await apiJson("/api/empty-bin/report?" + buildReportQuery().toString());
    _report = data;
    updateSelectOptions(selArea(), data.meta?.filters?.areas || [], "area", "All areas");
    updateSelectOptions(selBinSize(), data.meta?.filters?.bin_sizes || [], "bin_size", "All sizes");
    renderSourceReport();
    setCreateTaskEnabled(Boolean(data.rows?.length));
    setChip("eChipReport", `${fmt(data.summary?.returned_count || data.rows?.length || 0)} report rows`);
    setChip("eChipStatus", "Report loaded");
  } catch (err) {
    _report = null;
    setCreateTaskEnabled(false);
    setChip("eChipReport", "");
    const notReady = String(err.message || "").includes("No daily empty-bin report snapshot is available");
    document.getElementById("eTab-daily").innerHTML = notReady
      ? emptyState(`Request the daily empty-bin report for ${selectedReportDate()} to load locations.`)
      : errorHtml(err.message);
    setChip("eChipStatus", notReady ? "Report needed" : "Report error");
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

function jumpToTaskWorkspace() {
  const workspace = document.getElementById("eTaskWorkspace");
  if (!workspace) return;
  const run = () => workspace.scrollIntoView({ behavior: "smooth", block: "start" });
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else setTimeout(run, 0);
}

async function loadTask(taskId, { silent = false, jump = true } = {}) {
  try {
    if (!silent) setChip("eChipStatus", "Loading task...");
    const data = await apiJson(`/api/empty-bin/tasks/${encodeURIComponent(taskId)}`);
    _activeTask = data.task;
    _activeSummary = data.summary;
    renderTask();
    renderCompletedReport();
    switchTab("task");
    if (!silent) setChip("eChipStatus", "Task loaded");
    if (!silent && jump) jumpToTaskWorkspace();
    startPolling();
  } catch (err) {
    setChip("eChipStatus", "Task failed to load");
    document.getElementById("eTab-task").innerHTML = errorHtml(err.message);
    switchTab("task");
    throw err;
  }
}

function startPolling() {
  if (_pollTimer) clearInterval(_pollTimer);
  if (!_activeTask) return;
  _pollTimer = setInterval(() => {
    if (_activeTask?.id) loadTask(_activeTask.id, { silent: true, jump: false }).catch(() => {});
  }, 5 * 60 * 1000);
}

function renderSourceReport() {
  const rows = _report?.rows || [];
  const meta = _report?.meta || {};
  const createDisabled = !rows.length;
  const html = `
    <div class="empty-live-head">
      <div>
        <div class="empty-title">Daily empty-bin report for ${escHtml(meta.report_date || selectedReportDate())}</div>
        <div class="empty-muted">Uploaded ${escHtml(formatDateTimeText(meta.uploaded_at))} | synced ${escHtml(formatDateTimeText(meta.source_synced_at))} | ${fmt(meta.row_count || rows.length)} locations in snapshot</div>
      </div>
      <button class="btn btn--primary btn--sm" id="eBtnCreateTaskInline" ${createDisabled ? "disabled" : ""}>Create task from report</button>
    </div>
    ${rows.length ? `<div class="empty-live-list">${rows.map(renderSourceRow).join("")}</div>` : emptyState("No locations matched the daily report filters for this date.")}
  `;
  document.getElementById("eTab-daily").innerHTML = html;
  document.getElementById("eBtnCreateTaskInline")?.addEventListener("click", createTaskFromFilters);
}

function renderSourceRow(row) {
  const liveState = row.live_empty === null || row.live_empty === undefined
    ? "Live status unavailable"
    : row.live_empty
      ? "Still empty in BINLOC"
      : "Now filled in BINLOC";
  return `
    <div class="empty-live-row">
      <div>
        <div class="empty-location">${escHtml(row.location)}</div>
        <div class="empty-last-transaction">${escHtml(formatLastTransaction(row.last_transaction))}</div>
        <div class="empty-muted">${escHtml(row.operating_area || "-")} | ${escHtml(row.bin_size || "-")} | ${escHtml(row.bin_type || "-")} | level ${escHtml(row.level || "-")}</div>
      </div>
      <div class="empty-live-row__meta">
        <span>${escHtml(liveState)}</span>
        <span>Live qty ${fmt(row.current_qty)}</span>
        <span>SKU ${escHtml(row.item_sku || "-")}</span>
      </div>
    </div>
  `;
}

function renderTasks() {
  const el = document.getElementById("eTaskList");
  if (!_tasks.length) {
    el.innerHTML = emptyState("No empty-bin tasks yet. Create one from the daily report.");
    return;
  }
  el.innerHTML = _tasks.map((task) => {
    const autoResolvedCount = Number(task.operations_filled_count || 0) + Number(task.system_cleared_count || 0);
    const typeLabel = task.type === "clearing" ? "Clearing task" : "Audit task";
    const stopLabel = task.status === "stopped" ? "Stopped" : "Stop";
    return `
      <article class="empty-task-card ${_activeTask?.id === task.id ? "empty-task-card--active" : ""}">
        <div class="empty-task-card__head">
          <div>
            <span class="empty-task-card__title">${escHtml(task.title)}</span>
            <span class="empty-task-card__meta">${escHtml(typeLabel)} | ${escHtml(task.status)}</span>
          </div>
          ${chipStatus(task.status)}
        </div>
        <span class="empty-task-card__counts">${fmt(task.checked_count)} checked | ${fmt(task.pending_count)} pending | ${fmt(autoResolvedCount)} auto resolved</span>
        <span class="empty-task-card__assignee">${task.assignee ? `Assigned to ${escHtml(task.assignee.name || task.assignee.email)}` : "Unassigned"}</span>
        <div class="empty-task-card__actions">
          <button class="btn btn--sm" data-empty-task-open="${escAttr(task.id)}">${task.type === "clearing" ? "Open clearing" : "Open audit"}</button>
          <button class="btn btn--sm" data-empty-task-stop="${escAttr(task.id)}">${escHtml(stopLabel)}</button>
          <button class="btn btn--sm" data-empty-task-delete="${escAttr(task.id)}">Delete</button>
        </div>
      </article>
    `;
  }).join("");
}

function summarizeClientTask(task) {
  return computeTaskSummary(task);
}

function taskControlsHtml(task, summary) {
  const assigned = Boolean(task.assignee);
  const typeLabel = task.type === "clearing" ? "Clearing task" : "Audit task";
  const autoResolvedCount = Number(summary.operations_filled_count || 0) + Number(summary.system_cleared_count || 0);
  return `
    <div class="empty-task-controls">
      <div>
        <div class="empty-title">${escHtml(task.title)}</div>
        <div class="empty-muted">${escHtml(typeLabel)} | ${fmt(summary.checked_count)} checked | ${fmt(summary.pending_count)} pending | ${fmt(autoResolvedCount)} auto resolved | ${fmt(summary.photo_count)} photos</div>
      </div>
      <div class="empty-task-actions">
        <button class="btn btn--sm" data-task-action="assign">${assigned ? "Reassign to me" : "Assign to me"}</button>
        <button class="btn btn--sm" data-task-action="drop">Drop task</button>
        <button class="btn btn--sm" data-task-action="stop">Stop</button>
        <button class="btn btn--sm" data-task-action="delete">Delete</button>
        <button class="btn btn--primary btn--sm" data-task-action="complete">${task.type === "clearing" ? "Finish" : "Complete"}</button>
      </div>
    </div>
  `;
}

function renderTask() {
  const el = document.getElementById("eTab-task");
  if (!_activeTask) {
    el.innerHTML = emptyState("Open a task from the manager to review it here.");
    return;
  }
  const allItems = _activeTask.items || [];
  const autoResolved = allItems.filter((item) => ["system_cleared", "operations_filled"].includes(item.status)).length;
  const items = allItems.filter((item) => !["system_cleared", "operations_filled"].includes(item.status)).slice().sort((a, b) => {
    const aPending = a.status === "pending" ? 0 : 1;
    const bPending = b.status === "pending" ? 0 : 1;
    return aPending - bPending || a.sort_index - b.sort_index;
  });
  const cards = items.map(renderCheckCard).join("");
  const autoResolvedCopy = _activeTask.type === "clearing"
    ? `${fmt(autoResolved)} locations already show stock in BINLOC and are marked as Operations filled.`
    : `${fmt(autoResolved)} locations were cleared by live BINLOC and are hidden from the checking queue. They remain in the report tab.`;
  el.innerHTML = taskControlsHtml(_activeTask, _activeSummary || summarizeClientTask(_activeTask)) +
    (autoResolved ? `<div class="empty-system-banner">${autoResolvedCopy}</div>` : "") +
    `<div class="empty-check-list">${cards || emptyState("No pending locations remain in this task.")}</div>`;
}

function renderCheckCard(item) {
  const pending = item.status === "pending";
  const live = item.live || {};
  const isClearingTask = _activeTask?.type === "clearing";
  const actions = isClearingTask
    ? [["cleared", "Cleared"], ["skipped", "Skip"]]
    : [["empty", "Empty"], ["not_empty", "Not empty"]];
  const photos = (item.photos || []).map((photo) =>
    `<a class="empty-photo" href="${escAttr(photo.url)}" target="_blank" rel="noreferrer"><img src="${escAttr(photo.url)}" alt="Photo for ${escAttr(item.location)}" /></a>`
  ).join("");
  return `
    <div class="empty-check-card empty-check-card--${escAttr(statusTone(item.status))}" data-location="${escAttr(item.location)}">
      <div class="empty-check-card__top">
        <div>
          <div class="empty-location">${escHtml(item.location)}</div>
          <div class="empty-last-transaction">${escHtml(formatLastTransaction(item.last_transaction))}</div>
          <div class="empty-muted">${escHtml(item.operating_area || "-")} | ${escHtml(item.bin_size || "-")} | ${escHtml(item.bin_type || "-")} | level ${escHtml(item.level || "-")}</div>
        </div>
        ${chipStatus(item.status)}
      </div>
      <div class="empty-facts">
        <span>Live qty ${fmt(live.current_qty ?? item.current_qty_at_create)}</span>
        <span>Live SKU ${escHtml(live.item_sku || item.item_sku || "-")}</span>
        <span>${escHtml(isClearingTask ? (live.live_empty === false ? "Operations have filled the location" : "Still showing as empty") : (item.source_reason || "Awaiting audit"))}</span>
      </div>
      ${item.system_cleared_reason ? `<div class="empty-system-note">${escHtml(item.system_cleared_reason)}</div>` : ""}
      ${item.note ? `<div class="empty-note">${escHtml(item.note)}</div>` : ""}
      ${photos ? `<div class="empty-photo-row">${photos}</div>` : ""}
      ${pending ? `
        <div class="empty-card-inputs">
          <textarea class="fi empty-note-input" placeholder="Optional note"></textarea>
          <input class="fi empty-photo-input" type="file" accept="image/*" capture="environment" />
        </div>
        <div class="empty-card-actions empty-card-actions--two">
          ${actions.map(([action, label]) => `<button class="btn btn--sm ${action === "empty" || action === "cleared" ? "btn--primary" : ""}" data-check-action="${escAttr(action)}">${escHtml(label)}</button>`).join("")}
        </div>
      ` : ""}
    </div>
  `;
}

function renderCompletedReport() {
  const el = document.getElementById("eTab-report");
  if (!_activeTask) {
    el.innerHTML = emptyState("Open a task to view the full report.");
    return;
  }
  const rows = _activeTask.items || [];
  el.innerHTML = `
    ${taskControlsHtml(_activeTask, _activeSummary || summarizeClientTask(_activeTask))}
    <div class="empty-report-list">
      ${rows.map(renderCompletedRow).join("")}
    </div>
  `;
}

function renderCompletedRow(item) {
  const photos = (item.photos || []).map((photo) =>
    `<a class="empty-photo" href="${escAttr(photo.url)}" target="_blank" rel="noreferrer"><img src="${escAttr(photo.url)}" alt="Photo for ${escAttr(item.location)}" /></a>`
  ).join("");
  return `
    <div class="empty-report-row">
      <div>
        <div class="empty-location">${escHtml(item.location)}</div>
        <div class="empty-last-transaction">${escHtml(formatLastTransaction(item.last_transaction))}</div>
        <div class="empty-muted">${escHtml(item.operating_area || "-")} | ${escHtml(item.bin_size || "-")} | ${escHtml(item.bin_type || "-")}</div>
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
  document.querySelectorAll("#eTab-daily,#eTab-task,#eTab-report").forEach((el) => {
    el.classList.toggle("reports-tab-content--active", el.id === `eTab-${name}`);
  });
}

async function createTaskFromFilters() {
  if (!_report?.rows?.length) {
    window.RepoApp?.toast?.("Load the daily empty-bin report first.", "error");
    return;
  }

  setChip("eChipStatus", "Creating task...");
  const filters = { date: selectedReportDate() };
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
    const assigned = await apiJson(`/api/empty-bin/tasks/${encodeURIComponent(created.task.id)}/assign`, {
      method: "POST",
      body: "{}",
    });
    storeBootstrapTask(created.task.id, assigned.task, assigned.summary);
    window.location.href = `/empty-bins/tasks/${encodeURIComponent(created.task.id)}`;
  } catch (err) {
    window.RepoApp?.toast?.(err.message, "error");
    setChip("eChipStatus", "Error");
  }
}

async function handleTaskAction(action) {
  if (!_activeTask) return;
  const id = encodeURIComponent(_activeTask.id);

  if (action === "delete") {
    if (!window.confirm("Delete this task and its saved photos?")) return;
    try {
      await apiJson(`/api/empty-bin/tasks/${id}`, { method: "DELETE" });
      _activeTask = null;
      _activeSummary = null;
      renderTask();
      renderCompletedReport();
      await loadTasks();
      switchTab("daily");
      window.RepoApp?.toast?.("Task deleted.", "success");
    } catch (err) {
      window.RepoApp?.toast?.(err.message, "error");
    }
    return;
  }

  const endpoint = {
    assign: `/api/empty-bin/tasks/${id}/assign`,
    drop: `/api/empty-bin/tasks/${id}/drop`,
    stop: `/api/empty-bin/tasks/${id}/stop`,
    complete: `/api/empty-bin/tasks/${id}/complete`,
  }[action];
  if (!endpoint) return;

  try {
    const data = await apiJson(endpoint, { method: "POST", body: "{}" });
    await loadTasks();
    if (action === "complete" && data.full_clearing_task?.id) {
      storeBootstrapTask(data.full_clearing_task.id, data.full_clearing_task, data.clearing_task);
      window.location.href = `/empty-bins/tasks/${encodeURIComponent(data.full_clearing_task.id)}`;
      return;
    }
    if (action === "complete" || action === "stop") {
      _activeTask = null;
      _activeSummary = null;
      renderTask();
      renderCompletedReport();
      switchTab("daily");
      window.RepoApp?.toast?.(action === "stop" ? "Task stopped." : "Task completed.", "success");
      return;
    }
    await loadTask(_activeTask.id, { silent: true, jump: false });
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
    await loadTask(_activeTask.id, { silent: true, jump: false });
  } catch (err) {
    window.RepoApp?.toast?.(err.message, "error");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  if (inpDate() && !inpDate().value) inpDate().value = dateOffsetYmd(-1);
  setChip("eChipClient", selClient().options[selClient().selectedIndex]?.text || selClient().value);
  renderReportSyncStatus();
  renderTask();
  renderCompletedReport();
  setCreateTaskEnabled(false);
  loadReportSyncStatus().catch(() => {});
  loadSourceReport();
  loadTasks();

  document.getElementById("eBtnLoadReport").addEventListener("click", () => {
    loadReportSyncStatus().catch(() => {});
    loadSourceReport();
  });
  document.getElementById("eBtnRequestReport").addEventListener("click", () => requestReportSync(false));
  document.getElementById("eBtnLoadTasks").addEventListener("click", loadTasks);
  document.getElementById("eBtnCreateTask").addEventListener("click", createTaskFromFilters);

  selClient().addEventListener("change", () => {
    setChip("eChipClient", selClient().options[selClient().selectedIndex]?.text || selClient().value);
    _activeTask = null;
    _reportSyncReadyToast = false;
    loadReportSyncStatus().catch(() => {});
    loadSourceReport();
    loadTasks();
    renderTask();
    renderCompletedReport();
  });

  inpDate()?.addEventListener("change", () => {
    _reportSyncReadyToast = false;
    loadReportSyncStatus().catch(() => {});
    loadSourceReport();
  });

  [selArea(), selBinSize(), selLimit()].forEach((el) => el?.addEventListener("change", loadSourceReport));
  inpSearch().addEventListener("keydown", (event) => {
    if (event.key === "Enter") loadSourceReport();
  });

  document.getElementById("eTabs").addEventListener("click", (event) => {
    const btn = event.target.closest(".reports-tab-btn");
    if (btn) switchTab(btn.dataset.tab);
  });

  document.addEventListener("click", (event) => {
    const openTaskButton = event.target.closest("[data-empty-task-open]");
    if (openTaskButton) {
      const taskId = openTaskButton.dataset.emptyTaskOpen;
      if (taskId) window.location.href = `/empty-bins/tasks/${encodeURIComponent(taskId)}`;
      return;
    }

    const stopTaskButton = event.target.closest("[data-empty-task-stop]");
    if (stopTaskButton) {
      const taskId = stopTaskButton.dataset.emptyTaskStop;
      const selectedTask = _tasks.find((task) => task.id === taskId);
      if (selectedTask) {
        _activeTask = selectedTask;
        handleTaskAction("stop");
      }
      return;
    }

    const deleteTaskButton = event.target.closest("[data-empty-task-delete]");
    if (deleteTaskButton) {
      const taskId = deleteTaskButton.dataset.emptyTaskDelete;
      const selectedTask = _tasks.find((task) => task.id === taskId);
      if (selectedTask) {
        _activeTask = selectedTask;
        handleTaskAction("delete");
      }
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
});
