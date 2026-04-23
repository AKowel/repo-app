"use strict";

const QUERY_STATUS_POLL_MS = 2500;
const QUERY_RESULT_PREVIEW_LIMIT = 250;

let currentQuery = null;
let currentResult = null;
let pollTimer = null;
let showAllRows = false;
let busy = false;

function $(id) {
  return document.getElementById(id);
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

function fmt(value) {
  return Number(value ?? 0).toLocaleString();
}

async function apiJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text || `Request failed with ${response.status}.`);
  }
  if (!json.ok) throw new Error(json.error || "Request failed.");
  return json;
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function setBusy(nextBusy) {
  busy = Boolean(nextBusy);
  const runButton = $("qcRunButton");
  if (runButton) {
    runButton.disabled = busy;
    runButton.textContent = busy ? "Queueing..." : "Run query";
  }
}

function currentFormState() {
  return {
    query_name: String($("qcQueryName")?.value || "").trim(),
    sql_text: String($("qcSql")?.value || ""),
    max_rows: String($("qcMaxRows")?.value || "").trim() || "2000",
  };
}

function renderStatus(sync, { pendingMessage = "", errorMessage = "" } = {}) {
  const el = $("qcStatus");
  if (!el) return;

  const status = String(sync?.status || "idle").trim().toLowerCase();
  const snapshot = sync?.snapshot || null;
  const job = sync?.job || null;
  const titles = {
    idle: "Ready when you are.",
    queued: "Queued for the warehouse worker.",
    running: "The warehouse worker is running the query now.",
    failed: "The last run failed.",
    ready: "Result is ready.",
  };
  let meta = pendingMessage || "The worker only accepts one read-only SELECT or WITH statement at a time.";
  if (status === "ready" && snapshot) {
    const bits = [
      `${fmt(snapshot.row_count)} rows`,
      `${fmt(snapshot.column_count)} columns`,
    ];
    if (snapshot.uploaded_at) bits.push(`uploaded ${new Date(snapshot.uploaded_at).toLocaleString()}`);
    if (snapshot.truncated) bits.push(`truncated at ${fmt(snapshot.max_rows)} rows`);
    meta = bits.join(" | ");
  } else if (status === "queued" || status === "running") {
    const bits = [];
    if (job?.requested_at) bits.push(`requested ${new Date(job.requested_at).toLocaleString()}`);
    if (job?.requested_by) bits.push(`by ${job.requested_by}`);
    meta = bits.join(" | ") || "Repo-app will refresh this page as soon as the worker publishes the snapshot.";
  } else if (status === "failed") {
    meta = errorMessage || job?.error_text || "The worker reported a failure for this query.";
  }

  el.className = `sql-console-status sql-console-status--${status || "idle"}`;
  el.innerHTML = `
    <div class="sql-console-status__title">${escHtml(titles[status] || titles.idle)}</div>
    <div class="sql-console-status__meta">${escHtml(meta)}</div>
  `;
}

function formatCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function renderResults(result) {
  const el = $("qcResults");
  if (!el) return;
  currentResult = result || null;

  if (!result) {
    el.innerHTML = `<div class="sql-console-empty">Run a query to see the output table here.</div>`;
    return;
  }

  const rows = Array.isArray(result.rows) ? result.rows : [];
  const columns = Array.isArray(result.columns) ? result.columns : [];
  const visibleRows = showAllRows ? rows : rows.slice(0, QUERY_RESULT_PREVIEW_LIMIT);

  el.innerHTML = `
    <section class="sql-console-result-meta">
      <div class="sql-console-result-meta__title">${escHtml(result.query_name || "Query result")}</div>
      <div class="sql-console-result-meta__stats">
        <span>${fmt(result.row_count)} rows</span>
        <span>${fmt(result.column_count)} columns</span>
        ${result.truncated ? `<span>truncated at ${fmt(result.max_rows)} rows</span>` : ""}
      </div>
      ${rows.length > QUERY_RESULT_PREVIEW_LIMIT ? `
        <div class="sql-console-result-meta__actions">
          <button class="btn btn--sm" type="button" data-result-toggle>${showAllRows ? "Show preview only" : `Show all ${fmt(rows.length)} rows`}</button>
        </div>
      ` : ""}
    </section>

    <div class="sql-console-table-wrap">
      <table class="sql-console-table">
        <thead>
          <tr>${columns.map((column) => `<th>${escHtml(column)}</th>`).join("")}</tr>
        </thead>
        <tbody>
          ${visibleRows.map((row) => `
            <tr>
              ${columns.map((column) => `<td title="${escAttr(formatCell(row?.[column]))}">${escHtml(formatCell(row?.[column]))}</td>`).join("")}
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    ${!rows.length ? `<div class="sql-console-empty sql-console-empty--inline">This query returned no rows.</div>` : ""}
  `;
}

async function loadResult(recordId) {
  const params = new URLSearchParams({ record_id: recordId });
  if (currentQuery?.max_rows) params.set("max_rows", String(currentQuery.max_rows));
  const data = await apiJson(`/api/query-console/result?${params.toString()}`);
  renderResults(data.result);
}

async function refreshQueryStatus() {
  if (!currentQuery?.sql_hash) return;
  const params = new URLSearchParams({
    query_name: currentQuery.query_name || "",
    sql_hash: currentQuery.sql_hash || "",
    max_rows: String(currentQuery.max_rows || ""),
  });
  const data = await apiJson(`/api/query-console/status?${params.toString()}`);
  renderStatus(data.sync);

  if (data.sync?.status === "ready" && data.sync?.snapshot?.record_id) {
    stopPolling();
    await loadResult(data.sync.snapshot.record_id);
    window.RepoApp?.toast?.("Query result loaded.", "success");
    return;
  }

  if (data.sync?.status === "failed") {
    stopPolling();
    window.RepoApp?.toast?.(data.sync?.job?.error_text || "The query worker reported a failure.", "error");
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    refreshQueryStatus().catch((error) => {
      stopPolling();
      renderStatus({ status: "failed" }, { errorMessage: error.message || "Could not refresh query status." });
    });
  }, QUERY_STATUS_POLL_MS);
}

async function runQuery() {
  const form = currentFormState();
  if (!form.sql_text.trim()) {
    window.RepoApp?.toast?.("Paste a SQL query first.", "error");
    return;
  }

  stopPolling();
  showAllRows = false;
  renderResults(null);
  renderStatus({ status: "queued" }, { pendingMessage: "Sending this query to the warehouse worker..." });
  setBusy(true);
  try {
    const data = await apiJson("/api/query-console/run", {
      method: "POST",
      body: JSON.stringify(form),
    });
    currentQuery = data.query || null;
    renderStatus(data.sync);

    if (data.sync?.status === "ready" && data.sync?.snapshot?.record_id) {
      await loadResult(data.sync.snapshot.record_id);
      window.RepoApp?.toast?.("Query result loaded.", "success");
      return;
    }

    startPolling();
    window.RepoApp?.toast?.(data.created ? "Query queued for the warehouse worker." : "Using the existing queued worker job.", "info");
  } catch (error) {
    renderStatus({ status: "failed" }, { errorMessage: error.message || "Could not queue the query." });
    renderResults(null);
    window.RepoApp?.toast?.(error.message || "Could not queue the query.", "error");
  } finally {
    setBusy(false);
  }
}

document.addEventListener("click", (event) => {
  if (event.target?.id === "qcRunButton") {
    runQuery().catch(() => {});
    return;
  }

  const toggle = event.target.closest("[data-result-toggle]");
  if (toggle) {
    showAllRows = !showAllRows;
    renderResults(currentResult);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.target?.id !== "qcSql") return;
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    runQuery().catch(() => {});
  }
});

window.addEventListener("beforeunload", () => {
  stopPolling();
});
