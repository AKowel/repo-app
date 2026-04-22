"use strict";

let _betaData = null;

const PC_ZONE_CHANNEL_CHOICES = [
  { code: "C", label: "Customer Web" },
  { code: "S", label: "Store Replen" },
];

const selClient = () => document.getElementById("bSelClient");
const selMode = () => document.getElementById("bSelMode");
const selCompare = () => document.getElementById("bSelCompare");
const inpDate = () => document.getElementById("bInpDate");
const inpStart = () => document.getElementById("bInpStart");
const inpEnd = () => document.getElementById("bInpEnd");
const selLimit = () => document.getElementById("bSelLimit");
const grpDate = () => document.getElementById("bGrpDate");
const grpRange = () => document.getElementById("bGrpRange");
const grpRangeEnd = () => document.getElementById("bGrpRangeEnd");

const CLIENT_CHANNELS = window.RepoApp.CLIENT_CHANNELS || {};

function fmt(n) {
  return Number(n ?? 0).toLocaleString();
}

function fmtMaybe(n) {
  return n === null || n === undefined || n === "" ? "-" : fmt(n);
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

function tableHtml(cols, rows, emptyMsg) {
  if (!rows || !rows.length) {
    return `<p class="beta-empty">${escHtml(emptyMsg || "No data.")}</p>`;
  }

  const thead = cols.map((col) => `<th>${escHtml(col.label)}</th>`).join("");
  const tbody = rows.map((row) =>
    `<tr>${cols.map((col) => {
      const value = row[col.key];
      const html = col.render ? col.render(value, row) : escHtml(value ?? "-");
      return `<td data-label="${escAttr(col.label)}">${html}</td>`;
    }).join("")}</tr>`
  ).join("");

  return `<div class="table-wrap"><table class="data-table mobile-card-table"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`;
}

function scorePill(value, tone = "neutral") {
  const score = Math.max(0, Math.min(Number(value || 0), 100));
  return `<span class="beta-score beta-score--${escAttr(tone)}">${fmt(score)}</span>`;
}

function renderShareBar(pct) {
  const width = Math.min(Math.max(Number(pct || 0), 0), 100);
  return `<span class="reports-share-bar"><span class="reports-share-bar__fill" style="width:${width}%"></span></span> ${fmt(width)}%`;
}

function renderPeriodStrip(values) {
  const periods = Array.isArray(values) ? values : [];
  if (!periods.length) return "-";
  const max = Math.max(1, ...periods.map((period) => Number(period.pick_qty || 0)));
  return `<div class="beta-period-strip">${periods.map((period) => {
    const qty = Number(period.pick_qty || 0);
    const height = Math.max(qty > 0 ? 12 : 3, Math.round((qty / max) * 28));
    return `<span class="beta-period-pill" title="${escAttr(period.label || period.key)}: ${fmt(qty)}">
      <span class="beta-period-pill__bar" style="height:${height}px"></span>
    </span>`;
  }).join("")}</div>`;
}

function loadingHtml(label) {
  return `<div class="loading-row"><div class="spinner"></div> ${escHtml(label || "Loading...")}</div>`;
}

function errorHtml(msg) {
  return `<div class="alert alert--error" style="margin:16px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>${escHtml(msg)}</div>`;
}

function localYMD(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function yesterdayInputYMD() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return localYMD(date);
}

function applyDateInputLimits() {
  const maxDate = yesterdayInputYMD();
  [inpDate(), inpStart(), inpEnd()].forEach((input) => {
    if (!input) return;
    input.max = maxDate;
    if (input.value && input.value > maxDate) input.value = maxDate;
  });
}

function syncModeUi() {
  const mode = selMode().value;
  grpDate().style.display = mode === "date" ? "" : "none";
  grpRange().style.display = mode === "custom" ? "" : "none";
  grpRangeEnd().style.display = mode === "custom" ? "" : "none";
}

function eventElementTarget(event) {
  const target = event?.target || null;
  if (target && target.nodeType === 1) return target;
  return target?.parentElement || null;
}

function closestFromEvent(event, selector) {
  const target = eventElementTarget(event);
  if (!target || typeof target.closest !== "function") return null;
  return target.closest(selector);
}

function setChip(id, text, visible) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || "";
  el.style.display = (visible === false || !text) ? "none" : "";
}

function buildChannelPicker(client) {
  const dropdown = document.getElementById("bChannelDropdown");
  const labels = CLIENT_CHANNELS[client] || CLIENT_CHANNELS.FANDMKET || {};
  dropdown.innerHTML = Object.entries(labels).map(([code, name]) =>
    `<label class="reports-channel-picker__option"><input type="checkbox" value="${escAttr(code)}" /> ${escHtml(name)}</label>`
  ).join("");

  dropdown.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", () => {
      updateChannelLabel();
      loadBetaReports();
    });
  });

  updateChannelLabel();
}

function initChannelPicker() {
  const trigger = document.getElementById("bChannelTrigger");
  const dropdown = document.getElementById("bChannelDropdown");

  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    dropdown.hidden = !dropdown.hidden;
  });
  document.addEventListener("click", () => {
    dropdown.hidden = true;
  });
  dropdown.addEventListener("click", (event) => event.stopPropagation());

  buildChannelPicker(selClient().value);
}

function getSelectedChannels() {
  return [...document.querySelectorAll("#bChannelDropdown input:checked")].map((cb) => cb.value);
}

function updateChannelLabel() {
  const selected = getSelectedChannels();
  document.getElementById("bChannelTrigger").textContent = selected.length === 0 ? "All channels" : selected.join(", ");
}

function getSelectedPcZoneChannels() {
  const selected = [...document.querySelectorAll(".bPcZoneChannelCb:checked")]
    .map((cb) => cb.value)
    .filter((value) => PC_ZONE_CHANNEL_CHOICES.some((choice) => choice.code === value));
  return selected.length ? selected : PC_ZONE_CHANNEL_CHOICES.map((choice) => choice.code);
}

function hideGrp147() {
  return document.getElementById("bHideGrp147")?.checked || false;
}

function buildQuery() {
  const params = new URLSearchParams();
  params.set("client", selClient().value);
  params.set("mode", selMode().value);
  params.set("limit", selLimit().value);
  params.set("compareBy", selCompare().value);

  if (selMode().value === "date") params.set("date", inpDate().value);
  if (selMode().value === "custom") {
    params.set("start", inpStart().value);
    params.set("end", inpEnd().value);
  }

  const channels = getSelectedChannels();
  if (channels.length) params.set("channels", channels.join(","));
  params.set("pc_zone_channels", getSelectedPcZoneChannels().join(","));
  if (hideGrp147()) params.set("hide_group_147", "1");
  return params;
}

function setTabsLoading() {
  document.querySelectorAll(".reports-tab-content").forEach((el) => {
    el.innerHTML = loadingHtml("Loading beta signals...");
  });
}

async function loadBetaReports() {
  setChip("bChipStatus", "Loading...", true);
  document.getElementById("bBtnLoad").disabled = true;
  setTabsLoading();

  try {
    const resp = await fetch("/api/beta-reports-data?" + buildQuery().toString());
    const json = await resp.json();
    if (!json.ok) throw new Error(json.error || "API error");
    _betaData = json;
    renderAll(json);
  } catch (err) {
    setChip("bChipStatus", "Error", true);
    document.getElementById("bTab-overview").innerHTML = errorHtml(err.message || "Request failed.");
  } finally {
    document.getElementById("bBtnLoad").disabled = false;
  }
}

function renderAll(data) {
  const meta = data.meta || {};
  const summary = data.summary || {};
  const clientLabel = selClient().options[selClient().selectedIndex]?.text || meta.client_code;

  setChip("bChipClient", clientLabel, true);
  if (meta.loaded_dates?.length === 1) {
    setChip("bChipRange", meta.loaded_dates[0], true);
  } else if (meta.loaded_dates?.length > 1) {
    const dates = [...meta.loaded_dates].sort();
    setChip("bChipRange", `${dates[0]} to ${dates[dates.length - 1]}`, true);
  } else {
    setChip("bChipRange", "No data", true);
  }
  setChip("bChipCoverage", meta.date_count > 1 ? `${fmt(meta.date_count)} days` : "1 day", meta.date_count > 0);
  setChip("bChipQty", `${fmt(summary.total_pick_qty)} picks`, summary.total_pick_qty > 0);
  setChip("bChipPeriods", `${fmt(meta.period_count)} ${meta.compare_by === "month" ? "months" : "weeks"}`, meta.period_count > 0);
  setChip("bChipStatus", meta.date_count > 0 ? "Loaded" : "No snapshots found", true);

  renderOverview(data);
  renderConsistent(data.signals?.consistent_candidates || []);
  renderTemporary(data.signals?.temporary_candidates || []);
  renderVolatility(data.signals?.volatility_watchlist || []);
  renderPcReview(data.signals?.pc_review || []);
  renderPatterns(data.signals?.repeat_patterns || []);
  renderPeriods(data.period_breakdown || []);
}

function renderMetricGrid(cards) {
  return `<div class="reports-metric-grid">${cards.map((card) => `
    <div class="reports-metric-card">
      <div class="reports-metric-card__label">${escHtml(card.label)}</div>
      <div class="reports-metric-card__value">${escHtml(card.value)}</div>
      ${card.sub ? `<div class="reports-metric-card__sub">${escHtml(card.sub)}</div>` : ""}
    </div>`).join("")}</div>`;
}

function renderOverview(data) {
  const el = document.getElementById("bTab-overview");
  const summary = data.summary || {};
  const meta = data.meta || {};
  const cards = [
    { label: "PC-Zone Channel Picks", value: fmt(summary.total_pick_qty), sub: `${fmt(summary.total_line_count)} lines` },
    { label: "Active SKUs", value: fmt(summary.active_sku_count), sub: `${fmt(meta.period_count)} ${meta.compare_by === "month" ? "months" : "weeks"}` },
    { label: "PC Pick Share", value: `${summary.pc_pick_share || 0}%`, sub: `${fmt(summary.pc_pick_qty)} units from PC` },
    { label: "Floor Qty Below 20", value: fmt(summary.low_level_non_pc_pick_qty), sub: "outside PC areas" },
    { label: "Latest Period", value: summary.latest_period_label || "-", sub: `${fmt(summary.latest_period_pick_qty)} picks` },
    { label: "Algorithm", value: "Beta", sub: meta.algorithm_version || "" },
  ];

  let html = renderMetricGrid(cards);
  if (!meta.binloc_available) {
    html += `<div class="reports-binloc-notice">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      BINLOC is not available for this run, so PC area and current-bin capacity scoring will be limited.
    </div>`;
  }

  html += '<div class="reports-section"><div class="reports-section__title">Top SKU Period Matrix</div></div>';
  html += tableHtml([
    { key: "sku", label: "SKU" },
    { key: "item_group", label: "Group", render: (value) => escHtml(value || "-") },
    { key: "total_pick_qty", label: "Total Qty", render: (value) => fmt(value) },
    { key: "consistency_score", label: "Consistency", render: (value) => scorePill(value, "good") },
    { key: "volatility_index", label: "Volatility", render: (value) => fmt(value) },
    { key: "latest_period_qty", label: "Latest", render: (value) => fmt(value) },
    { key: "period_values", label: "Periods", render: (value) => renderPeriodStrip(value) },
  ], data.sku_period_matrix || [], "No SKU period rows found.");

  el.innerHTML = html;
}

function renderConsistent(rows) {
  document.getElementById("bTab-consistent").innerHTML =
    '<div class="reports-section"><div class="reports-section__title">Consistent PC Candidates</div></div>' +
    tableHtml([
      { key: "signal_score", label: "Signal", render: (value) => scorePill(value, "good") },
      { key: "sku", label: "SKU" },
      { key: "item_group", label: "Group", render: (value) => escHtml(value || "-") },
      { key: "low_level_non_pc_pick_qty", label: "Floor Qty <20", render: (value) => fmt(value) },
      { key: "active_period_count", label: "Active Periods", render: (value, row) => `${fmt(value)} / ${fmt(_betaData?.meta?.period_count || 0)}` },
      { key: "consistency_score", label: "Consistency", render: (value) => scorePill(value, "neutral") },
      { key: "avg_period_pick_qty", label: "Avg/Period", render: (value) => fmt(value) },
      { key: "pc_share", label: "PC Share", render: (value) => renderShareBar(value) },
      { key: "current_bin_sizes", label: "Current Bins", render: (value) => escHtml(value || "-") },
      { key: "current_estimated_replenishments", label: "Est. Replens", render: (value) => fmtMaybe(value) },
    ], rows, "No consistent candidates found.");
}

function renderTemporary(rows) {
  document.getElementById("bTab-temporary").innerHTML =
    '<div class="reports-section"><div class="reports-section__title">Temporary Spike Candidates</div></div>' +
    tableHtml([
      { key: "signal_score", label: "Signal", render: (value) => scorePill(value, "warn") },
      { key: "sku", label: "SKU" },
      { key: "item_group", label: "Group", render: (value) => escHtml(value || "-") },
      { key: "latest_period_qty", label: "Latest Qty", render: (value) => fmt(value) },
      { key: "baseline_avg_period_qty", label: "Baseline Avg", render: (value) => fmt(value) },
      { key: "spike_ratio", label: "Spike Ratio", render: (value) => `${fmt(value)}x` },
      { key: "low_level_non_pc_pick_qty", label: "Floor Qty <20", render: (value) => fmt(value) },
      { key: "active_period_count", label: "Active Periods", render: (value) => fmt(value) },
      { key: "pc_share", label: "PC Share", render: (value) => `${fmt(value)}%` },
      { key: "current_bin_sizes", label: "Current Bins", render: (value) => escHtml(value || "-") },
    ], rows, "No temporary spike candidates found.");
}

function renderVolatility(rows) {
  document.getElementById("bTab-volatility").innerHTML =
    '<div class="reports-section"><div class="reports-section__title">Volatility Watchlist</div></div>' +
    tableHtml([
      { key: "volatility_score", label: "Score", render: (value) => scorePill(value, "bad") },
      { key: "sku", label: "SKU" },
      { key: "item_group", label: "Group", render: (value) => escHtml(value || "-") },
      { key: "total_pick_qty", label: "Total Qty", render: (value) => fmt(value) },
      { key: "volatility_index", label: "Volatility", render: (value) => fmt(value) },
      { key: "max_period_qty", label: "Max Period", render: (value) => fmt(value) },
      { key: "avg_period_pick_qty", label: "Avg/Period", render: (value) => fmt(value) },
      { key: "latest_period_qty", label: "Latest", render: (value) => fmt(value) },
      { key: "period_values", label: "Periods", render: (value) => renderPeriodStrip(value) },
    ], rows, "No volatile SKUs found.");
}

function renderPcReview(rows) {
  document.getElementById("bTab-pc-review").innerHTML =
    '<div class="reports-section"><div class="reports-section__title">Current PC Review</div></div>' +
    tableHtml([
      { key: "signal_score", label: "Review", render: (value) => scorePill(value, "warn") },
      { key: "sku", label: "SKU" },
      { key: "item_group", label: "Group", render: (value) => escHtml(value || "-") },
      { key: "pc_pick_qty", label: "PC Qty", render: (value) => fmt(value) },
      { key: "pc_share", label: "PC Share", render: (value) => renderShareBar(value) },
      { key: "consistency_score", label: "Consistency", render: (value) => scorePill(value, "neutral") },
      { key: "volatility_score", label: "Volatility", render: (value) => scorePill(value, "bad") },
      { key: "latest_period_qty", label: "Latest", render: (value) => fmt(value) },
      { key: "active_period_count", label: "Active Periods", render: (value) => fmt(value) },
    ], rows, "No existing PC SKUs were picked for this window.");
}

function renderPatterns(rows) {
  document.getElementById("bTab-patterns").innerHTML =
    '<div class="reports-section"><div class="reports-section__title">Repeat Pick Patterns</div></div>' +
    tableHtml([
      { key: "sku", label: "SKU" },
      { key: "item_group", label: "Group", render: (value) => escHtml(value || "-") },
      { key: "active_period_count", label: "Active Periods", render: (value, row) => `${fmt(value)} / ${fmt(_betaData?.meta?.period_count || 0)}` },
      { key: "active_period_share", label: "Period Share", render: (value) => `${fmt(value)}%` },
      { key: "consistency_score", label: "Consistency", render: (value) => scorePill(value, "good") },
      { key: "total_pick_qty", label: "Total Qty", render: (value) => fmt(value) },
      { key: "avg_period_pick_qty", label: "Avg/Period", render: (value) => fmt(value) },
      { key: "period_values", label: "Periods", render: (value) => renderPeriodStrip(value) },
    ], rows, "No repeat patterns found.");
}

function renderPeriods(rows) {
  document.getElementById("bTab-periods").innerHTML =
    '<div class="reports-section"><div class="reports-section__title">Period Breakdown</div></div>' +
    tableHtml([
      { key: "label", label: "Period" },
      { key: "date_count", label: "Days", render: (value) => fmt(value) },
      { key: "pick_qty", label: "Pick Qty", render: (value) => fmt(value) },
      { key: "line_count", label: "Lines", render: (value) => fmt(value) },
      { key: "order_count", label: "Orders", render: (value) => fmt(value) },
      { key: "sku_count", label: "SKUs", render: (value) => fmt(value) },
      { key: "pc_share", label: "PC Share", render: (value) => renderShareBar(value) },
      { key: "low_level_non_pc_pick_qty", label: "Floor Qty <20", render: (value) => fmt(value) },
      { key: "top_sku", label: "Top SKU", render: (value) => escHtml(value || "-") },
      { key: "top_sku_qty", label: "Top SKU Qty", render: (value) => fmt(value) },
    ], rows, "No periods found.");
}

function switchTab(name) {
  document.querySelectorAll(".reports-tab-btn").forEach((btn) => {
    const active = btn.dataset.tab === name;
    btn.classList.toggle("reports-tab-btn--active", active);
    btn.classList.toggle("tabbtn--on", active);
  });
  document.querySelectorAll(".reports-tab-content").forEach((el) => {
    el.classList.toggle("reports-tab-content--active", el.id === `bTab-${name}`);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  applyDateInputLimits();
  syncModeUi();
  initChannelPicker();

  selMode().addEventListener("change", () => {
    syncModeUi();
    loadBetaReports();
  });
  selCompare().addEventListener("change", loadBetaReports);
  selLimit().addEventListener("change", loadBetaReports);
  selClient().addEventListener("change", () => {
    buildChannelPicker(selClient().value);
    loadBetaReports();
  });
  [inpDate(), inpStart(), inpEnd()].forEach((input) => input?.addEventListener("change", loadBetaReports));
  document.getElementById("bBtnLoad").addEventListener("click", loadBetaReports);
  document.getElementById("bHideGrp147")?.addEventListener("change", loadBetaReports);
  document.querySelectorAll(".bPcZoneChannelCb").forEach((cb) => {
    cb.addEventListener("change", () => {
      const checked = [...document.querySelectorAll(".bPcZoneChannelCb:checked")];
      if (!checked.length) {
        cb.checked = true;
        return;
      }
      loadBetaReports();
    });
  });
  document.getElementById("bTabs").addEventListener("click", (event) => {
    const btn = closestFromEvent(event, ".reports-tab-btn");
    if (btn) switchTab(btn.dataset.tab);
  });

  loadBetaReports();
});
