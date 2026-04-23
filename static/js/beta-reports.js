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
const detailDrawer = () => document.getElementById("bDetailDrawer");
const detailDrawerBackdrop = () => document.getElementById("bDetailDrawerBackdrop");
const detailDrawerClose = () => document.getElementById("bDetailDrawerClose");
const detailDrawerTitle = () => document.getElementById("bDetailDrawerTitle");
const detailDrawerSubtitle = () => document.getElementById("bDetailDrawerSubtitle");
const detailDrawerBody = () => document.getElementById("bDetailDrawerBody");

const CLIENT_CHANNELS = window.RepoApp.CLIENT_CHANNELS || {};
const _detailRows = new Map();
let _detailRowCounter = 0;
const WATCHLIST_KEY = "repo-beta-watchlist-skus";
let _watchlistSkus = loadWatchlistSkus();

function fmt(n) {
  return Number(n ?? 0).toLocaleString();
}

function fmtMaybe(n) {
  return n === null || n === undefined || n === "" ? "-" : fmt(n);
}

function loadWatchlistSkus() {
  try {
    const parsed = JSON.parse(localStorage.getItem(WATCHLIST_KEY) || "[]");
    return new Set(Array.isArray(parsed) ? parsed.map((sku) => String(sku || "").trim().toUpperCase()).filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

function saveWatchlistSkus() {
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify([..._watchlistSkus].sort()));
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

function tableHtml(cols, rows, emptyMsg, options = {}) {
  if (!rows || !rows.length) {
    return `<p class="beta-empty">${escHtml(emptyMsg || "No data.")}</p>`;
  }

  const thead = cols.map((col) => `<th>${escHtml(col.label)}</th>`).join("");
  const tbody = rows.map((row) =>
    `<tr${detailRowAttrs(options.detailKind, row)}>${cols.map((col) => {
      const value = row[col.key];
      const html = col.render ? col.render(value, row) : escHtml(value ?? "-");
      return `<td data-label="${escAttr(col.label)}">${html}</td>`;
    }).join("")}</tr>`
  ).join("");

  return `<div class="table-wrap"><table class="data-table mobile-card-table"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`;
}

function detailRowAttrs(kind, row) {
  if (!kind || !row) return "";
  const id = `${kind}:${++_detailRowCounter}`;
  _detailRows.set(id, { kind, row });
  return ` class="beta-detail-row" tabindex="0" data-beta-detail-id="${escAttr(id)}"`;
}

function renderSkuCell(_value, row) {
  const label = row?.sku_label || row?.sku || "-";
  const sku = row?.sku || "";
  const description = row?.description || "";
  if (!description) return escHtml(label);
  return `<span class="beta-sku-label"><strong>${escHtml(sku)}</strong><span>${escHtml(description)}</span></span>`;
}

function renderRecommendation(value) {
  const type = value || "Watch only";
  const tone = type === "Move to PC" || type === "Keep in PC"
    ? "good"
    : type === "Temporary PC"
      ? "warn"
      : type === "Remove from PC"
        ? "bad"
        : "neutral";
  return `<span class="beta-rec beta-rec--${tone}">${escHtml(type)}</span>`;
}

function renderConfidence(value, row) {
  const score = Number(value || 0);
  const label = row?.confidence_label || (score >= 75 ? "High" : score >= 50 ? "Medium" : "Low");
  const tone = label === "High" ? "good" : label === "Medium" ? "warn" : "bad";
  return `<span class="beta-confidence beta-confidence--${tone}">${escHtml(label)} ${fmt(score)}</span>`;
}

function renderReasons(value, row) {
  const reasons = Array.isArray(row?.recommendation_reasons)
    ? row.recommendation_reasons
    : String(value || "").split(";").map((part) => part.trim()).filter(Boolean);
  if (!reasons.length) return "-";
  return `<div class="beta-reasons">${reasons.slice(0, 3).map((reason) => `<span>${escHtml(reason)}</span>`).join("")}</div>`;
}

function renderDelta(value) {
  if (value === null || value === undefined || value === "") return "-";
  const num = Number(value || 0);
  if (num > 0) return `<span class="beta-delta beta-delta--good">${fmt(num)} fewer</span>`;
  if (num < 0) return `<span class="beta-delta beta-delta--bad">${fmt(Math.abs(num))} more</span>`;
  return `<span class="beta-delta">No change</span>`;
}

function renderPinButton(_value, row) {
  const sku = String(row?.sku || "").trim().toUpperCase();
  if (!sku) return "";
  const pinned = _watchlistSkus.has(sku);
  return `<button type="button" class="beta-pin ${pinned ? "beta-pin--on" : ""}" data-beta-pin-sku="${escAttr(sku)}" title="${pinned ? "Remove from watchlist" : "Add to watchlist"}">${pinned ? "Pinned" : "Pin"}</button>`;
}

function renderSource(value) {
  if (!value) return "-";
  if (value === "item_dimensions") return "Item dims";
  if (value === "current_bin_density") return "Current bin density";
  if (value === "pc_bin_density") return "PC bin density";
  return escHtml(value);
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
  _detailRows.clear();
  _detailRowCounter = 0;
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
  renderActions(data.signals?.action_list || []);
  renderConsistent(data.signals?.consistent_candidates || []);
  renderTemporary(data.signals?.temporary_candidates || []);
  renderVolatility(data.signals?.volatility_watchlist || []);
  renderPcReview(data.signals?.pc_review || []);
  renderPatterns(data.signals?.repeat_patterns || []);
  renderTrends(data.signals || {});
  renderPressure(data.pc_pressure || {});
  renderWatchlist();
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
    { key: "sku", label: "SKU", render: renderSkuCell },
    { key: "item_group", label: "Group", render: (value) => escHtml(value || "-") },
    { key: "total_pick_qty", label: "Total Qty", render: (value) => fmt(value) },
    { key: "consistency_score", label: "Consistency", render: (value) => scorePill(value, "good") },
    { key: "volatility_index", label: "Volatility", render: (value) => fmt(value) },
    { key: "latest_period_qty", label: "Latest", render: (value) => fmt(value) },
    { key: "period_values", label: "Periods", render: (value) => renderPeriodStrip(value) },
  ], data.sku_period_matrix || [], "No SKU period rows found.", { detailKind: "sku" });

  el.innerHTML = html;
}

function renderActions(rows) {
  document.getElementById("bTab-actions").innerHTML =
    '<div class="reports-section"><div class="reports-section__title">PC Action List</div></div>' +
    tableHtml([
      { key: "recommendation_type", label: "Action", render: renderRecommendation },
      { key: "sku", label: "SKU", render: renderSkuCell },
      { key: "action_priority_score", label: "Priority", render: (value) => scorePill(value, "good") },
      { key: "confidence_score", label: "Confidence", render: renderConfidence },
      { key: "recommendation_reason", label: "Reason", render: renderReasons },
      { key: "low_level_non_pc_pick_qty", label: "Floor Qty <20", render: (value) => fmt(value) },
      { key: "recommended_bin_size", label: "Best PC Bin", render: (value) => escHtml(value || "-") },
      { key: "current_estimated_replenishments", label: "Current Replens", render: (value) => fmtMaybe(value) },
      { key: "estimated_replenishments_in_pc", label: "PC Replens", render: (value) => fmtMaybe(value) },
      { key: "estimated_replenishments_delta", label: "Benefit", render: renderDelta },
      { key: "_pin", label: "Watch", render: renderPinButton },
    ], rows, "No recommended actions for this window.", { detailKind: "sku" });
}

function renderConsistent(rows) {
  document.getElementById("bTab-consistent").innerHTML =
    '<div class="reports-section"><div class="reports-section__title">Consistent PC Candidates</div></div>' +
    tableHtml([
      { key: "recommendation_type", label: "Action", render: renderRecommendation },
      { key: "signal_score", label: "Signal", render: (value) => scorePill(value, "good") },
      { key: "sku", label: "SKU", render: renderSkuCell },
      { key: "item_group", label: "Group", render: (value) => escHtml(value || "-") },
      { key: "low_level_non_pc_pick_qty", label: "Floor Qty <20", render: (value) => fmt(value) },
      { key: "active_period_count", label: "Active Periods", render: (value, row) => `${fmt(value)} / ${fmt(_betaData?.meta?.period_count || 0)}` },
      { key: "consistency_score", label: "Consistency", render: (value) => scorePill(value, "neutral") },
      { key: "avg_period_pick_qty", label: "Avg/Period", render: (value) => fmt(value) },
      { key: "pc_share", label: "PC Share", render: (value) => renderShareBar(value) },
      { key: "recommended_bin_size", label: "Best PC Bin", render: (value) => escHtml(value || "-") },
      { key: "estimated_replenishments_delta", label: "Benefit", render: renderDelta },
      { key: "current_bin_sizes", label: "Current Bins", render: (value) => escHtml(value || "-") },
      { key: "current_estimated_replenishments", label: "Est. Replens", render: (value) => fmtMaybe(value) },
    ], rows, "No consistent candidates found.", { detailKind: "sku" });
}

function renderTemporary(rows) {
  document.getElementById("bTab-temporary").innerHTML =
    '<div class="reports-section"><div class="reports-section__title">Temporary Spike Candidates</div></div>' +
    tableHtml([
      { key: "recommendation_type", label: "Action", render: renderRecommendation },
      { key: "signal_score", label: "Signal", render: (value) => scorePill(value, "warn") },
      { key: "sku", label: "SKU", render: renderSkuCell },
      { key: "item_group", label: "Group", render: (value) => escHtml(value || "-") },
      { key: "latest_period_qty", label: "Latest Qty", render: (value) => fmt(value) },
      { key: "baseline_avg_period_qty", label: "Baseline Avg", render: (value) => fmt(value) },
      { key: "spike_ratio", label: "Spike Ratio", render: (value) => `${fmt(value)}x` },
      { key: "low_level_non_pc_pick_qty", label: "Floor Qty <20", render: (value) => fmt(value) },
      { key: "active_period_count", label: "Active Periods", render: (value) => fmt(value) },
      { key: "spike_source_label", label: "Spike Source", render: (value) => escHtml(value || "-") },
      { key: "pc_share", label: "PC Share", render: (value) => `${fmt(value)}%` },
      { key: "current_bin_sizes", label: "Current Bins", render: (value) => escHtml(value || "-") },
    ], rows, "No temporary spike candidates found.", { detailKind: "sku" });
}

function renderVolatility(rows) {
  document.getElementById("bTab-volatility").innerHTML =
    '<div class="reports-section"><div class="reports-section__title">Volatility Watchlist</div></div>' +
    tableHtml([
      { key: "recommendation_type", label: "Action", render: renderRecommendation },
      { key: "volatility_score", label: "Score", render: (value) => scorePill(value, "bad") },
      { key: "sku", label: "SKU", render: renderSkuCell },
      { key: "item_group", label: "Group", render: (value) => escHtml(value || "-") },
      { key: "total_pick_qty", label: "Total Qty", render: (value) => fmt(value) },
      { key: "volatility_index", label: "Volatility", render: (value) => fmt(value) },
      { key: "max_period_qty", label: "Max Period", render: (value) => fmt(value) },
      { key: "avg_period_pick_qty", label: "Avg/Period", render: (value) => fmt(value) },
      { key: "latest_period_qty", label: "Latest", render: (value) => fmt(value) },
      { key: "period_values", label: "Periods", render: (value) => renderPeriodStrip(value) },
    ], rows, "No volatile SKUs found.", { detailKind: "sku" });
}

function renderPcReview(rows) {
  document.getElementById("bTab-pc-review").innerHTML =
    '<div class="reports-section"><div class="reports-section__title">Current PC Review</div></div>' +
    tableHtml([
      { key: "recommendation_type", label: "Action", render: renderRecommendation },
      { key: "signal_score", label: "Review", render: (value) => scorePill(value, "warn") },
      { key: "sku", label: "SKU", render: renderSkuCell },
      { key: "item_group", label: "Group", render: (value) => escHtml(value || "-") },
      { key: "pc_pick_qty", label: "PC Qty", render: (value) => fmt(value) },
      { key: "pc_share", label: "PC Share", render: (value) => renderShareBar(value) },
      { key: "consistency_score", label: "Consistency", render: (value) => scorePill(value, "neutral") },
      { key: "volatility_score", label: "Volatility", render: (value) => scorePill(value, "bad") },
      { key: "latest_period_qty", label: "Latest", render: (value) => fmt(value) },
      { key: "active_period_count", label: "Active Periods", render: (value) => fmt(value) },
      { key: "recommendation_reason", label: "Reason", render: renderReasons },
    ], rows, "No existing PC SKUs were picked for this window.", { detailKind: "sku" });
}

function renderPatterns(rows) {
  document.getElementById("bTab-patterns").innerHTML =
    '<div class="reports-section"><div class="reports-section__title">Repeat Pick Patterns</div></div>' +
    tableHtml([
      { key: "sku", label: "SKU", render: renderSkuCell },
      { key: "item_group", label: "Group", render: (value) => escHtml(value || "-") },
      { key: "active_period_count", label: "Active Periods", render: (value, row) => `${fmt(value)} / ${fmt(_betaData?.meta?.period_count || 0)}` },
      { key: "active_period_share", label: "Period Share", render: (value) => `${fmt(value)}%` },
      { key: "consistency_score", label: "Consistency", render: (value) => scorePill(value, "good") },
      { key: "total_pick_qty", label: "Total Qty", render: (value) => fmt(value) },
      { key: "avg_period_pick_qty", label: "Avg/Period", render: (value) => fmt(value) },
      { key: "period_values", label: "Periods", render: (value) => renderPeriodStrip(value) },
    ], rows, "No repeat patterns found.", { detailKind: "sku" });
}

function renderTrends(signals) {
  let html = '<div class="reports-section"><div class="reports-section__title">New Movers</div></div>';
  html += tableHtml([
    { key: "sku", label: "SKU", render: renderSkuCell },
    { key: "recommendation_type", label: "Action", render: renderRecommendation },
    { key: "latest_period_qty", label: "Latest Qty", render: (value) => fmt(value) },
    { key: "baseline_avg_period_qty", label: "Baseline Avg", render: (value) => fmt(value) },
    { key: "spike_ratio", label: "Spike Ratio", render: (value) => `${fmt(value)}x` },
    { key: "spike_source_label", label: "Spike Source", render: (value) => escHtml(value || "-") },
    { key: "confidence_score", label: "Confidence", render: renderConfidence },
  ], signals.new_movers || [], "No new movers found.", { detailKind: "sku" });

  html += '<div class="reports-section"><div class="reports-section__title">Declining PC SKUs</div></div>';
  html += tableHtml([
    { key: "sku", label: "SKU", render: renderSkuCell },
    { key: "recommendation_type", label: "Action", render: renderRecommendation },
    { key: "decline_score", label: "Decline", render: (value) => scorePill(value, "bad") },
    { key: "pc_pick_qty", label: "PC Qty", render: (value) => fmt(value) },
    { key: "latest_period_qty", label: "Latest", render: (value) => fmt(value) },
    { key: "previous_period_qty", label: "Previous", render: (value) => fmt(value) },
    { key: "baseline_avg_period_qty", label: "Baseline Avg", render: (value) => fmt(value) },
    { key: "recommendation_reason", label: "Reason", render: renderReasons },
  ], signals.declining_skus || [], "No declining PC SKUs found.", { detailKind: "sku" });

  html += '<div class="reports-section"><div class="reports-section__title">Changed Since Previous Day</div></div>';
  html += tableHtml([
    { key: "sku", label: "SKU", render: renderSkuCell },
    { key: "latest_day_qty", label: "Latest Day", render: (value) => fmt(value) },
    { key: "previous_day_qty", label: "Previous Day", render: (value) => fmt(value) },
    { key: "day_change_qty", label: "Qty Change", render: (value) => value > 0 ? `+${fmt(value)}` : fmt(value) },
    { key: "day_change_pct", label: "% Change", render: (value) => `${fmt(value)}%` },
    { key: "recommendation_type", label: "Action", render: renderRecommendation },
  ], signals.changed_since_previous_day || [], "No day-over-day movement found.", { detailKind: "sku" });

  html += '<div class="reports-section"><div class="reports-section__title">Weekday Patterns</div></div>';
  html += tableHtml([
    { key: "sku", label: "SKU", render: renderSkuCell },
    { key: "primary_weekday", label: "Main Day", render: (value) => escHtml(value || "-") },
    { key: "primary_weekday_share", label: "Share", render: (value) => `${fmt(value)}%` },
    { key: "total_pick_qty", label: "Total Qty", render: (value) => fmt(value) },
    { key: "recommendation_type", label: "Action", render: renderRecommendation },
    { key: "recommendation_reason", label: "Reason", render: renderReasons },
  ], signals.weekday_patterns || [], "No strong weekday patterns found.", { detailKind: "sku" });

  html += '<div class="reports-section"><div class="reports-section__title">Spike Sources</div></div>';
  html += tableHtml([
    { key: "sku", label: "SKU", render: renderSkuCell },
    { key: "spike_score", label: "Spike", render: (value) => scorePill(value, "warn") },
    { key: "latest_period_qty", label: "Latest Qty", render: (value) => fmt(value) },
    { key: "spike_ratio", label: "Spike Ratio", render: (value) => `${fmt(value)}x` },
    { key: "largest_latest_order_number", label: "Largest Order", render: (value) => escHtml(value || "-") },
    { key: "largest_latest_order_share", label: "Order Share", render: (value) => `${fmt(value)}%` },
    { key: "spike_source_label", label: "Source", render: (value) => escHtml(value || "-") },
  ], signals.spike_sources || [], "No spike-source signals found.", { detailKind: "sku" });

  document.getElementById("bTab-trends").innerHTML = html;
}

function renderPressure(pcPressure) {
  let html = '<div class="reports-section"><div class="reports-section__title">PC Bin Pressure</div></div>';
  html += tableHtml([
    { key: "bin_size", label: "Bin Size" },
    { key: "empty_location_count", label: "Empty Bins", render: (value) => fmt(value) },
    { key: "action_candidate_count", label: "Action SKUs", render: (value) => fmt(value) },
    { key: "candidate_count", label: "All Candidates", render: (value) => fmt(value) },
    { key: "estimated_locations_needed", label: "Est. Need", render: (value) => fmt(value) },
    { key: "pressure_ratio", label: "Pressure", render: (value) => value >= 999 ? "No empty bins" : `${fmt(value)}x` },
    { key: "oversubscribed_by", label: "Over By", render: (value) => fmt(value) },
    { key: "total_candidate_pick_qty", label: "Candidate Qty", render: (value) => fmt(value) },
  ], pcPressure.bin_sizes || [], "No PC bin pressure rows found.");

  html += '<div class="reports-section"><div class="reports-section__title">Bin Conflicts</div></div>';
  html += tableHtml([
    { key: "bin_size", label: "Bin Size" },
    { key: "empty_location_count", label: "Empty Bins", render: (value) => fmt(value) },
    { key: "estimated_locations_needed", label: "Est. Need", render: (value) => fmt(value) },
    { key: "oversubscribed_by", label: "Over By", render: (value) => fmt(value) },
    { key: "top_candidates", label: "Top Candidates", render: (value) => (value || []).map((row) => escHtml(row.sku_label || row.sku)).join("<br>") || "-" },
  ], pcPressure.conflicts || [], "No PC bin conflicts found.");

  document.getElementById("bTab-pressure").innerHTML = html;
}

function getAllSkuRows() {
  const map = new Map();
  const signalGroups = _betaData?.signals || {};
  [
    signalGroups.action_list,
    signalGroups.consistent_candidates,
    signalGroups.temporary_candidates,
    signalGroups.volatility_watchlist,
    signalGroups.pc_review,
    signalGroups.repeat_patterns,
    signalGroups.new_movers,
    signalGroups.declining_skus,
    signalGroups.changed_since_previous_day,
    signalGroups.weekday_patterns,
    signalGroups.spike_sources,
    _betaData?.sku_period_matrix,
  ].forEach((rows) => {
    (rows || []).forEach((row) => {
      if (!row?.sku || map.has(row.sku)) return;
      map.set(row.sku, row);
    });
  });
  return [...map.values()];
}

function renderWatchlist() {
  const rows = getAllSkuRows().filter((row) => _watchlistSkus.has(String(row.sku || "").toUpperCase()));
  document.getElementById("bTab-watchlist").innerHTML =
    '<div class="reports-section"><div class="reports-section__title">Pinned SKUs</div></div>' +
    tableHtml([
      { key: "sku", label: "SKU", render: renderSkuCell },
      { key: "recommendation_type", label: "Action", render: renderRecommendation },
      { key: "confidence_score", label: "Confidence", render: renderConfidence },
      { key: "total_pick_qty", label: "Total Qty", render: (value) => fmt(value) },
      { key: "latest_period_qty", label: "Latest", render: (value) => fmt(value) },
      { key: "day_change_qty", label: "Day Change", render: (value) => value > 0 ? `+${fmt(value)}` : fmt(value) },
      { key: "recommendation_reason", label: "Reason", render: renderReasons },
      { key: "_pin", label: "Watch", render: renderPinButton },
    ], rows, "No pinned SKUs found in the current beta data.", { detailKind: "sku" });
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
      { key: "top_sku_label", label: "Top SKU", render: (value, row) => escHtml(value || row.top_sku || "-") },
      { key: "top_sku_qty", label: "Top SKU Qty", render: (value) => fmt(value) },
    ], rows, "No periods found.", { detailKind: "period" });
}

function currentRangeLabel() {
  if (!_betaData?.meta?.loaded_dates?.length) return selClient().options[selClient().selectedIndex]?.text || "";
  const dates = [..._betaData.meta.loaded_dates].sort();
  const client = selClient().options[selClient().selectedIndex]?.text || _betaData.meta.client_code || "";
  if (dates.length === 1) return `${client} - ${dates[0]}`;
  return `${client} - ${dates[0]} to ${dates[dates.length - 1]}`;
}

function detailSection(title, cols, rows, emptyMsg, options = {}) {
  return `
    <div class="reports-section"><div class="reports-section__title">${escHtml(title)}</div></div>
    ${tableHtml(cols, rows, emptyMsg, options)}
  `;
}

function openBetaDetail(id) {
  const detail = _detailRows.get(id);
  if (!detail) return;
  const { kind, row } = detail;

  detailDrawerTitle().textContent = kind === "period"
    ? `Period ${row.label || row.key || ""}`
    : (row.sku_label || row.sku || "SKU detail");
  detailDrawerSubtitle().textContent = currentRangeLabel();
  detailDrawerBody().innerHTML = kind === "period" ? renderPeriodDetail(row) : renderSkuDetail(row);
  detailDrawer().classList.add("drawer--open");
  detailDrawerBackdrop().classList.add("drawer-backdrop--visible");
}

function closeBetaDetail() {
  detailDrawer().classList.remove("drawer--open");
  detailDrawerBackdrop().classList.remove("drawer-backdrop--visible");
}

function renderSkuDetail(row) {
  const cards = [
    { label: "Recommendation", value: row.recommendation_type || "Watch only", sub: row.confidence_label ? `${row.confidence_label} confidence` : "" },
    { label: "Total Pick Qty", value: fmt(row.total_pick_qty), sub: `${fmt(row.total_line_count)} lines` },
    { label: "Orders", value: fmt(row.order_count), sub: `${fmt(row.location_count)} locations` },
    { label: "PC Share", value: `${fmt(row.pc_share)}%`, sub: `${fmt(row.pc_pick_qty)} PC / ${fmt(row.non_pc_pick_qty)} non-PC` },
    { label: "Floor Qty <20", value: fmt(row.low_level_non_pc_pick_qty), sub: `${fmtMaybe(row.current_estimated_replenishments)} est. replens` },
    { label: "Consistency", value: fmt(row.consistency_score), sub: `${fmt(row.active_period_count)} active periods` },
    { label: "Volatility", value: fmt(row.volatility_score), sub: `Index ${fmt(row.volatility_index)}` },
  ];

  let html = `
    <div class="beta-detail-intro">
      <div class="beta-detail-intro__sku">${escHtml(row.sku || "-")}</div>
      <div class="beta-detail-intro__desc">${escHtml(row.description || "No catalog description found for this SKU.")}</div>
      <div class="beta-detail-intro__actions">
        ${renderRecommendation(row.recommendation_type)}
        ${renderConfidence(row.confidence_score, row)}
        ${renderPinButton(null, row)}
      </div>
    </div>
  `;
  html += renderMetricGrid(cards);
  html += detailSection("Why This Was Flagged", [
    { key: "recommendation_reason", label: "Reason", render: renderReasons },
    { key: "primary_channel_label", label: "Primary Channel", render: (value, record) => value ? `${escHtml(value)} (${fmt(record.primary_channel_share)}%)` : "-" },
    { key: "primary_weekday", label: "Primary Weekday", render: (value, record) => value ? `${escHtml(value)} (${fmt(record.primary_weekday_share)}%)` : "-" },
    { key: "spike_source_label", label: "Spike Source", render: (value) => escHtml(value || "-") },
  ], [row], "No reasons found.");
  html += detailSection("Before / After Replenishment", [
    { key: "current_estimated_replenishments", label: "Current Replens", render: (value) => fmtMaybe(value) },
    { key: "estimated_replenishments_in_pc", label: "PC Replens", render: (value) => fmtMaybe(value) },
    { key: "estimated_replenishments_delta", label: "Benefit", render: renderDelta },
    { key: "recommended_bin_size", label: "Best PC Bin", render: (value) => escHtml(value || "-") },
    { key: "recommended_pc_capacity", label: "Est. PC Cap", render: (value) => fmtMaybe(value) },
    { key: "recommended_empty_locations", label: "Empty Bins", render: (value) => fmtMaybe(value) },
    { key: "capacity_source", label: "Capacity Source", render: renderSource },
  ], [row], "No replenishment comparison available.");
  html += detailSection("Signal Scores", [
    { key: "signal_score", label: "Row Signal", render: (value) => value == null ? "-" : scorePill(value, "warn") },
    { key: "action_priority_score", label: "Priority", render: (value) => scorePill(value, "good") },
    { key: "consistency_score", label: "Consistency", render: (value) => scorePill(value, "good") },
    { key: "spike_score", label: "Spike", render: (value) => scorePill(value, "warn") },
    { key: "volatility_score", label: "Volatility", render: (value) => scorePill(value, "bad") },
    { key: "latest_period_qty", label: "Latest Qty", render: (value) => fmt(value) },
    { key: "baseline_avg_period_qty", label: "Baseline Avg", render: (value) => fmt(value) },
    { key: "spike_ratio", label: "Spike Ratio", render: (value) => `${fmt(value)}x` },
  ], [row], "No signal scores found.");

  html += detailSection("Period Profile", [
    { key: "label", label: "Period" },
    { key: "pick_qty", label: "Pick Qty", render: (value) => fmt(value) },
    { key: "line_count", label: "Lines", render: (value) => fmt(value) },
    { key: "order_count", label: "Orders", render: (value) => fmt(value) },
  ], row.period_values || [], "No period values found.");

  html += detailSection("Channel Breakdown", [
    { key: "channel", label: "Code" },
    { key: "label", label: "Channel" },
    { key: "pick_qty", label: "Pick Qty", render: (value) => fmt(value) },
    { key: "line_count", label: "Lines", render: (value) => fmt(value) },
    { key: "order_count", label: "Orders", render: (value) => fmt(value) },
  ], row.channel_breakdown || [], "No channel breakdown found.");

  html += detailSection("Weekday Breakdown", [
    { key: "label", label: "Weekday" },
    { key: "pick_qty", label: "Pick Qty", render: (value) => fmt(value) },
    { key: "line_count", label: "Lines", render: (value) => fmt(value) },
    { key: "share_of_sku", label: "Share", render: (value) => `${fmt(value)}%` },
  ], row.weekday_breakdown || [], "No weekday breakdown found.");

  html += detailSection("Top Locations", [
    { key: "location", label: "Location" },
    { key: "operating_area", label: "Area" },
    { key: "level_num", label: "Level", render: (value) => fmtMaybe(value) },
    { key: "bin_size", label: "Bin Size", render: (value) => escHtml(value || "-") },
    { key: "bin_type", label: "Bin Type", render: (value) => escHtml(value || "-") },
    { key: "is_pc", label: "PC", render: (value) => value ? "Yes" : "No" },
    { key: "max_bin_qty", label: "Max Qty", render: (value) => fmtMaybe(value) },
    { key: "pick_qty", label: "Pick Qty", render: (value) => fmt(value) },
    { key: "line_count", label: "Lines", render: (value) => fmt(value) },
    { key: "order_count", label: "Orders", render: (value) => fmt(value) },
  ], row.location_breakdown || [], "No location breakdown found.");

  html += detailSection("Current Bin Footprint", [
    { key: "current_bin_sizes", label: "Floor Bins <20", render: (value) => escHtml(value || "-") },
    { key: "low_level_non_pc_capacity", label: "Floor Capacity <20", render: (value) => fmtMaybe(value) },
    { key: "low_level_non_pc_location_count", label: "Floor Locations <20", render: (value) => fmt(value) },
    { key: "pc_bin_sizes", label: "PC Bins <20", render: (value) => escHtml(value || "-") },
    { key: "low_level_pc_capacity", label: "PC Capacity <20", render: (value) => fmtMaybe(value) },
    { key: "low_level_pc_location_count", label: "PC Locations <20", render: (value) => fmt(value) },
  ], [row], "No current bin footprint found.");

  html += detailSection("PC Bin Options", [
    { key: "bin_size", label: "Bin Size" },
    { key: "empty_location_count", label: "Empty Bins", render: (value) => fmt(value) },
    { key: "estimated_pc_capacity", label: "Est. Capacity", render: (value) => fmtMaybe(value) },
    { key: "estimated_replenishments_in_pc", label: "Est. PC Replens", render: (value) => fmtMaybe(value) },
    { key: "estimated_replenishments_delta", label: "Benefit", render: renderDelta },
    { key: "capacity_source", label: "Capacity Source", render: renderSource },
  ], row.pc_bin_options || [], "No PC bin options could be scored.");

  return html;
}

function renderPeriodDetail(row) {
  const cards = [
    { label: "Pick Qty", value: fmt(row.pick_qty), sub: `${fmt(row.line_count)} lines` },
    { label: "Orders", value: fmt(row.order_count), sub: `${fmt(row.sku_count)} SKUs` },
    { label: "PC Share", value: `${fmt(row.pc_share)}%`, sub: `${fmt(row.pc_pick_qty)} PC picks` },
    { label: "Floor Qty <20", value: fmt(row.low_level_non_pc_pick_qty), sub: "outside PC areas" },
    { label: "Days", value: fmt(row.date_count), sub: `${row.start || ""} to ${row.end || ""}` },
    { label: "Top SKU", value: row.top_sku || "-", sub: row.top_sku_description || "" },
  ];

  let html = renderMetricGrid(cards);
  html += detailSection("Top SKUs In This Period", [
    { key: "sku", label: "SKU", render: renderSkuCell },
    { key: "pick_qty", label: "Pick Qty", render: (value) => fmt(value) },
  ], row.top_skus || [], "No top SKUs found for this period.");
  return html;
}

function toggleWatchSku(sku) {
  const normalizedSku = String(sku || "").trim().toUpperCase();
  if (!normalizedSku) return;
  if (_watchlistSkus.has(normalizedSku)) _watchlistSkus.delete(normalizedSku);
  else _watchlistSkus.add(normalizedSku);
  saveWatchlistSkus();
  if (_betaData) renderAll(_betaData);
}

function csvEscape(value) {
  const text = String(value === null || value === undefined ? "" : value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportActionListCsv() {
  const rows = _betaData?.signals?.action_list || [];
  if (!rows.length) {
    window.RepoApp?.toast?.("No action rows to export.", "info");
    return;
  }
  const columns = [
    ["recommendation_type", "Action"],
    ["sku", "SKU"],
    ["description", "Description"],
    ["action_priority_score", "Priority"],
    ["confidence_label", "Confidence"],
    ["recommendation_reason", "Reason"],
    ["low_level_non_pc_pick_qty", "Floor Qty <20"],
    ["recommended_bin_size", "Best PC Bin"],
    ["current_estimated_replenishments", "Current Replens"],
    ["estimated_replenishments_in_pc", "PC Replens"],
    ["estimated_replenishments_delta", "Replens Saved"],
    ["recommended_empty_locations", "Empty Bins"],
    ["primary_channel_label", "Primary Channel"],
    ["primary_weekday", "Primary Weekday"],
  ];
  const csv = [
    columns.map(([, label]) => csvEscape(label)).join(","),
    ...rows.map((row) => columns.map(([key]) => csvEscape(row[key])).join(",")),
  ].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `beta_pc_actions_${_betaData?.meta?.client_code || "client"}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
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
  document.getElementById("bBtnExportActions")?.addEventListener("click", exportActionListCsv);
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
  document.addEventListener("click", (event) => {
    const pinButton = closestFromEvent(event, "[data-beta-pin-sku]");
    if (pinButton) {
      event.preventDefault();
      event.stopPropagation();
      toggleWatchSku(pinButton.dataset.betaPinSku);
      return;
    }
    const row = closestFromEvent(event, "[data-beta-detail-id]");
    if (!row) return;
    if (closestFromEvent(event, "button, a, input, select, textarea")) return;
    openBetaDetail(row.dataset.betaDetailId);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeBetaDetail();
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = closestFromEvent(event, "[data-beta-detail-id]");
    if (!row) return;
    event.preventDefault();
    openBetaDetail(row.dataset.betaDetailId);
  });
  detailDrawerClose()?.addEventListener("click", closeBetaDetail);
  detailDrawerBackdrop()?.addEventListener("click", closeBetaDetail);

  loadBetaReports();
});
