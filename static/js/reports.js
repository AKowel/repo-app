"use strict";

let _data = null;
const _locExpanded = { above20: true, below20: true };
const _chLocExpanded = {}; // ch -> { above20: bool, below20: bool }

const selClient = () => document.getElementById("rSelClient");
const selMode = () => document.getElementById("rSelMode");
const inpDate = () => document.getElementById("rInpDate");
const inpStart = () => document.getElementById("rInpStart");
const inpEnd = () => document.getElementById("rInpEnd");
const selLimit = () => document.getElementById("rSelLimit");
const selRankBy = () => document.getElementById("rSelRankBy");
const grpDate = () => document.getElementById("rGrpDate");
const grpRange = () => document.getElementById("rGrpRange");
const grpRangeEnd = () => document.getElementById("rGrpRangeEnd");
const detailDrawer = () => document.getElementById("rDetailDrawer");
const detailDrawerBackdrop = () => document.getElementById("rDetailDrawerBackdrop");
const detailDrawerClose = () => document.getElementById("rDetailDrawerClose");
const detailDrawerTitle = () => document.getElementById("rDetailDrawerTitle");
const detailDrawerSubtitle = () => document.getElementById("rDetailDrawerSubtitle");
const detailDrawerBody = () => document.getElementById("rDetailDrawerBody");

function fmt(n) {
  return (n ?? 0).toLocaleString();
}

function fmtMaybe(n) {
  return n === null || n === undefined ? "-" : fmt(n);
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

function renderShareBar(pct) {
  const width = Math.min(Math.max(pct || 0, 0), 100);
  return `<span class="reports-share-bar"><span class="reports-share-bar__fill" style="width:${width}%"></span></span> ${pct}%`;
}

function renderReplenishmentDelta(value) {
  if (value === null || value === undefined) return "-";
  if (value > 0) return `<span class="reports-delta reports-delta--good">${fmt(value)} fewer</span>`;
  if (value < 0) return `<span class="reports-delta reports-delta--bad">${fmt(Math.abs(value))} more</span>`;
  return `<span class="reports-delta">No change</span>`;
}

function renderDetailLink(type, value, label) {
  return `<button type="button" class="reports-detail-link" data-report-detail-type="${escAttr(type)}" data-report-detail-value="${escAttr(value)}">${escHtml(label || value)}</button>`;
}

function tableHtml(cols, rows, emptyMsg) {
  if (!rows || !rows.length) {
    return `<p style="padding:1rem;color:var(--color-text-secondary)">${escHtml(emptyMsg || "No data.")}</p>`;
  }

  const thead = cols.map((col) => `<th>${col.label}</th>`).join("");
  const tbody = rows.map((row) =>
    `<tr>${cols.map((col) => `<td>${col.render ? col.render(row[col.key], row) : escHtml(row[col.key] ?? "-")}</td>`).join("")}</tr>`
  ).join("");

  return `<div class="table-wrap"><table class="data-table"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`;
}

function renderTable(el, cols, rows, emptyMsg) {
  el.innerHTML = tableHtml(cols, rows, emptyMsg);
}

function emptyStateHtml(msg) {
  return "<div class='empty-state'><div class='empty-state__icon'><svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'><circle cx='12' cy='12' r='10'/><line x1='8' y1='12' x2='16' y2='12'/></svg></div><div class='empty-state__title'>No results</div><div class='empty-state__desc'>" + escHtml(msg) + "</div></div>";
}

function errorHtml(msg) {
  return "<div class='alert alert--error' style='margin:16px'><svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'><circle cx='12' cy='12' r='10'/><line x1='12' y1='8' x2='12' y2='12'/><line x1='12' y1='16' x2='12.01' y2='16'/></svg>" + escHtml(msg) + "</div>";
}

function loadingHtml(label) {
  return `<div class="loading-row"><div class="spinner"></div> ${escHtml(label || "Loading...")}</div>`;
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
    if (input.value && input.value > maxDate) {
      input.value = maxDate;
    }
  });
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

function syncModeUi() {
  const mode = selMode().value;
  grpDate().style.display = mode === "date" ? "" : "none";
  grpRange().style.display = mode === "custom" ? "" : "none";
  grpRangeEnd().style.display = mode === "custom" ? "" : "none";
}

const CLIENT_CHANNELS = {
  FANDMKET: {
    B: "Build Your Own",
    C: "Customer Web",
    F: "Fresh only",
    H: "Hamper",
    L: "Large orders",
    N: "Store scan to carton",
    P: "Concierge VIP Orders",
    S: "Store replen",
    W: "Wholesale",
  },
  WESTLAND: {
    B: "Bulk Retail",
    E: "External wooden products",
    F: "Ferts & Chems RAW MATERIAL",
    G: "Growing Media Raw Material",
    L: "Large Retail",
    R: "Retail",
    W: "Wholesale",
  },
};

function buildChannelPicker(client) {
  const dropdown = document.getElementById("rChannelDropdown");
  const labels = CLIENT_CHANNELS[client] || CLIENT_CHANNELS.FANDMKET || {};
  dropdown.innerHTML = Object.entries(labels).map(([code, name]) =>
    `<label class="reports-channel-picker__option"><input type="checkbox" value="${code}" /> ${escHtml(name)}</label>`
  ).join("");

  dropdown.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", () => {
      updateChannelLabel();
      loadReports();
    });
  });

  updateChannelLabel();
}

function initChannelPicker() {
  const trigger = document.getElementById("rChannelTrigger");
  const dropdown = document.getElementById("rChannelDropdown");

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown.hidden = !dropdown.hidden;
  });
  document.addEventListener("click", () => {
    dropdown.hidden = true;
  });
  dropdown.addEventListener("click", (e) => e.stopPropagation());

  buildChannelPicker(selClient().value);
}

function getSelectedChannels() {
  return [...document.querySelectorAll("#rChannelDropdown input:checked")].map((cb) => cb.value);
}

function updateChannelLabel() {
  const selected = getSelectedChannels();
  document.getElementById("rChannelTrigger").textContent = selected.length === 0 ? "All channels" : selected.join(", ");
}

function buildQuery() {
  const params = new URLSearchParams();
  params.set("client", selClient().value);
  params.set("mode", selMode().value);
  params.set("limit", selLimit().value);
  params.set("rankBy", selRankBy().value);

  if (selMode().value === "date") {
    params.set("date", inpDate().value);
  }
  if (selMode().value === "custom") {
    params.set("start", inpStart().value);
    params.set("end", inpEnd().value);
  }

  const channels = getSelectedChannels();
  if (channels.length) params.set("channels", channels.join(","));
  return params;
}

function setChip(id, text, visible) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || "";
  el.style.display = (visible === false || !text) ? "none" : "";
}

async function loadReports() {
  setChip("rChipStatus", "Loading...", true);
  document.getElementById("rBtnLoad").disabled = true;

  try {
    const resp = await fetch("/api/reports-data?" + buildQuery());
    const json = await resp.json();
    if (!json.ok) throw new Error(json.error || "API error");
    _data = json;
    renderAll(json);
  } catch (err) {
    setChip("rChipStatus", "Error: " + err.message, true);
  } finally {
    document.getElementById("rBtnLoad").disabled = false;
  }
}

function renderAll(data) {
  const { meta, summary } = data;
  const clientLabel = selClient().options[selClient().selectedIndex]?.text || meta.client_code;
  setChip("rChipClient", clientLabel, true);

  if (meta.loaded_dates.length === 1) {
    setChip("rChipRange", meta.loaded_dates[0], true);
  } else if (meta.loaded_dates.length > 1) {
    const dates = [...meta.loaded_dates].sort();
    setChip("rChipRange", `${dates[0]} -> ${dates[dates.length - 1]}`, true);
  } else {
    setChip("rChipRange", "No data", true);
  }

  setChip("rChipCoverage", meta.date_count > 1 ? `${meta.date_count} days` : "1 day", meta.date_count > 0);
  setChip("rChipQty", `${fmt(summary.total_pick_qty)} picks`, summary.total_pick_qty > 0);
  setChip("rChipLines", `${fmt(summary.total_line_count)} lines`, summary.total_line_count > 0);
  setChip("rChipStatus", meta.date_count > 0 ? "Loaded" : "No snapshots found", true);

  renderOverview(summary, meta);
  renderTopSkus(data.top_skus, meta.limit, data.high_level_skus);
  renderLocations(data.top_locations);
  renderAisles(data.top_aisles);
  renderStructure(data);
  renderChannels(data.channel_breakdown);
  renderReplenishment(data.replenishment);
  renderPcZone(data.pc_zone, meta);
  renderDaily(data.daily_breakdown);
  renderChannelTabs(data.channel_details || {});
}

function renderOverview(summary, meta) {
  const el = document.getElementById("rTab-overview");
  const cards = [
    { label: "Total Pick Qty", value: fmt(summary.total_pick_qty), sub: `Avg ${summary.avg_qty_per_line} per line` },
    { label: "Total Lines", value: fmt(summary.total_line_count), sub: `Avg ${summary.avg_lines_per_day} lines/day` },
    { label: "Orders", value: fmt(summary.total_order_count), sub: "" },
    { label: "Active SKUs", value: fmt(summary.active_sku_count), sub: "" },
    { label: "Active Locations", value: fmt(summary.active_location_count), sub: `${fmt(summary.active_aisle_count)} aisles` },
    { label: "Channels", value: fmt(summary.active_channel_count), sub: `${fmt(summary.active_item_group_count)} item groups` },
    { label: "High-Level Picks", value: fmt(summary.high_level_pick_qty), sub: `${summary.high_level_share}% of pick qty (level >= 20)` },
    { label: "Peak Day", value: summary.peak_day_date || "-", sub: summary.peak_day_date ? `${fmt(summary.peak_day_pick_qty)} picks` : "" },
  ];

  let html = "<div class=\"reports-metric-grid\">" +
    cards.map((card) => `
      <div class="reports-metric-card">
        <div class="reports-metric-card__label">${card.label}</div>
        <div class="reports-metric-card__value">${card.value}</div>
        ${card.sub ? `<div class="reports-metric-card__sub">${card.sub}</div>` : ""}
      </div>`).join("") +
    "</div>";

  if (!meta.binloc_available) {
    html += `
      <div class="reports-binloc-notice">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        Operating area, bin type and replenishment estimates require the PI-App to publish warehouse binloc snapshots.
      </div>`;
  }

  el.innerHTML = html;
}

function hideGrp147() {
  return document.getElementById("rHideGrp147")?.checked || false;
}

function renderTopSkus(topSkus, limit, highLevelSkus) {
  const el = document.getElementById("rTab-skus");
  if (hideGrp147()) topSkus = topSkus.filter(r => String(r.item_group) !== "147");
  let html = `<div class="reports-section"><div class="reports-section__title">Top ${limit} SKUs${hideGrp147() ? ' <span style="font-size:10px;font-weight:400;color:var(--text-soft)">(group 147 hidden)</span>' : ''}</div></div>`;

  const cols = [
    { key: "_rank", label: "#", render: (_value, row) => topSkus.indexOf(row) + 1 },
    { key: "sku", label: "SKU", render: (value) => renderDetailLink("sku", value, value) },
    { key: "pick_qty", label: "Pick Qty", render: (value) => fmt(value) },
    { key: "line_count", label: "Lines", render: (value) => fmt(value) },
    { key: "order_count", label: "Orders", render: (value) => fmt(value) },
    { key: "location_count", label: "Locations", render: (value) => fmt(value) },
    { key: "share_of_picks", label: "Share", render: (value) => renderShareBar(value) },
  ];
  html += tableHtml(cols, topSkus, "No data.");

  if (highLevelSkus && highLevelSkus.length) {
    html += '<div class="reports-section"><div class="reports-section__title">Top High-Level SKUs (level >= 20)</div></div>';
    html += tableHtml([
      { key: "sku", label: "SKU", render: (value) => renderDetailLink("sku", value, value) },
      { key: "high_level_pick_qty", label: "High-Level Qty", render: (value) => fmt(value) },
      { key: "total_pick_qty", label: "Total Qty", render: (value) => fmt(value) },
      { key: "high_level_share", label: "HL Share", render: (value) => `${value}%` },
    ], highLevelSkus, "No high-level SKUs.");
  }

  el.innerHTML = html;
}

function toggleLocSection(which) {
  _locExpanded[which] = !_locExpanded[which];
  const sectionEl = document.getElementById(which === "above20" ? "rLocSectionAbove20" : "rLocSectionBelow20");
  const arrowEl = document.getElementById(which === "above20" ? "rLocArrowAbove" : "rLocArrowBelow");
  if (sectionEl) sectionEl.style.display = _locExpanded[which] ? "" : "none";
  if (arrowEl) arrowEl.style.transform = _locExpanded[which] ? "" : "rotate(-90deg)";
}

function renderLocations(topLocations) {
  const el = document.getElementById("rTab-locations");
  if (hideGrp147()) topLocations = topLocations.filter(r => String(r.primary_item_group) !== "147");

  const above20 = topLocations.filter(r => Number(r.level) >= 20);
  const below20 = topLocations.filter(r => Number(r.level) < 20);

  const headerNote = hideGrp147() ? ' <span style="font-size:10px;font-weight:400;color:var(--text-soft)">(group 147 hidden)</span>' : "";
  const chevron = `<svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="flex-shrink:0;transition:transform 0.15s"><polyline points="1,3 5,7 9,3"/></svg>`;

  const locCols = [
    { key: "location", label: "Location", render: (value) => renderDetailLink("location", value, value) },
    { key: "aisle_prefix", label: "Aisle" },
    { key: "level", label: "Level" },
    { key: "operating_area", label: "Area" },
    { key: "bin_size", label: "Bin Size" },
    { key: "bin_type", label: "Bin Type" },
    { key: "max_bin_qty", label: "Max Qty", render: (value) => value ? fmt(value) : "-" },
    { key: "pick_qty", label: "Pick Qty", render: (value) => fmt(value) },
    { key: "line_count", label: "Lines", render: (value) => fmt(value) },
    { key: "sku_count", label: "SKUs", render: (value) => fmt(value) },
  ];

  const aboveArrow = `<span id="rLocArrowAbove" style="display:inline-flex;transition:transform 0.15s;${_locExpanded.above20 ? "" : "transform:rotate(-90deg)"}">${chevron}</span>`;
  const belowArrow = `<span id="rLocArrowBelow" style="display:inline-flex;transition:transform 0.15s;${_locExpanded.below20 ? "" : "transform:rotate(-90deg)"}">${chevron}</span>`;

  let html = `<div class="reports-section"><div class="reports-section__title">Top 100 Locations${headerNote}</div></div>`;

  html += `
    <div class="reports-section" style="cursor:pointer;user-select:none" onclick="toggleLocSection('above20')">
      <div class="reports-section__title" style="display:flex;align-items:center;gap:6px">
        ${aboveArrow}
        Above Level 20
        <span style="font-size:10px;font-weight:400;color:var(--text-soft)">(${above20.length} locations)</span>
      </div>
    </div>
    <div id="rLocSectionAbove20" style="${_locExpanded.above20 ? "" : "display:none"}">
      ${tableHtml(locCols, above20, "No locations at or above level 20.")}
    </div>
    <div class="reports-section" style="cursor:pointer;user-select:none" onclick="toggleLocSection('below20')">
      <div class="reports-section__title" style="display:flex;align-items:center;gap:6px">
        ${belowArrow}
        Below Level 20
        <span style="font-size:10px;font-weight:400;color:var(--text-soft)">(${below20.length} locations)</span>
      </div>
    </div>
    <div id="rLocSectionBelow20" style="${_locExpanded.below20 ? "" : "display:none"}">
      ${tableHtml(locCols, below20, "No locations below level 20.")}
    </div>
  `;

  el.innerHTML = html;
}

function renderAisles(topAisles) {
  const el = document.getElementById("rTab-aisles");
  el.innerHTML = '<div class="reports-section"><div class="reports-section__title">Top 50 Aisles</div></div>' +
    tableHtml([
      { key: "aisle_prefix", label: "Aisle" },
      { key: "pick_qty", label: "Pick Qty", render: (value) => fmt(value) },
      { key: "line_count", label: "Lines", render: (value) => fmt(value) },
      { key: "location_count", label: "Locations", render: (value) => fmt(value) },
      { key: "sku_count", label: "SKUs", render: (value) => fmt(value) },
      { key: "share_of_picks", label: "Share", render: (value) => renderShareBar(value) },
    ], topAisles, "No aisles found.");
}

function renderStructure(data) {
  const el = document.getElementById("rTab-structure");
  let html = "";

  html += '<div class="reports-section"><div class="reports-section__title">Level Breakdown</div></div>';
  html += miniTable([
    { key: "level", label: "Level" },
    { key: "is_high_level", label: "High-Level", render: (value) => value ? "Yes" : "" },
    { key: "pick_qty", label: "Pick Qty", render: (value) => fmt(value) },
    { key: "line_count", label: "Lines", render: (value) => fmt(value) },
    { key: "location_count", label: "Locations", render: (value) => fmt(value) },
    { key: "sku_count", label: "SKUs", render: (value) => fmt(value) },
    { key: "share_of_picks", label: "Share", render: (value) => renderShareBar(value) },
  ], data.level_breakdown);

  html += '<div class="reports-section"><div class="reports-section__title">Bin Size Breakdown</div></div>';
  html += miniTable([
    { key: "bin_size", label: "Bin Size" },
    { key: "pick_qty", label: "Pick Qty", render: (value) => fmt(value) },
    { key: "line_count", label: "Lines", render: (value) => fmt(value) },
    { key: "location_count", label: "Locations", render: (value) => fmt(value) },
    { key: "share_of_picks", label: "Share", render: (value) => renderShareBar(value) },
  ], data.bin_size_breakdown);

  html += '<div class="reports-section"><div class="reports-section__title">Bin Type Breakdown</div></div>';
  html += miniTable([
    { key: "bin_type", label: "Bin Type" },
    { key: "pick_qty", label: "Pick Qty", render: (value) => fmt(value) },
    { key: "line_count", label: "Lines", render: (value) => fmt(value) },
    { key: "location_count", label: "Locations", render: (value) => fmt(value) },
    { key: "share_of_picks", label: "Share", render: (value) => renderShareBar(value) },
  ], data.bin_type_breakdown);

  html += '<div class="reports-section"><div class="reports-section__title">Operating Area Breakdown</div></div>';
  html += miniTable([
    { key: "operating_area", label: "Area" },
    { key: "pick_qty", label: "Pick Qty", render: (value) => fmt(value) },
    { key: "line_count", label: "Lines", render: (value) => fmt(value) },
    { key: "location_count", label: "Locations", render: (value) => fmt(value) },
    { key: "sku_count", label: "SKUs", render: (value) => fmt(value) },
    { key: "share_of_picks", label: "Share", render: (value) => renderShareBar(value) },
  ], data.operating_area_breakdown);

  html += '<div class="reports-section"><div class="reports-section__title">Item Group Breakdown</div></div>';
  html += miniTable([
    { key: "item_group", label: "Item Group" },
    { key: "pick_qty", label: "Pick Qty", render: (value) => fmt(value) },
    { key: "line_count", label: "Lines", render: (value) => fmt(value) },
    { key: "order_count", label: "Orders", render: (value) => fmt(value) },
    { key: "sku_count", label: "SKUs", render: (value) => fmt(value) },
    { key: "share_of_picks", label: "Share", render: (value) => renderShareBar(value) },
  ], data.item_group_breakdown);

  el.innerHTML = html;
}

function miniTable(cols, rows) {
  return tableHtml(cols, rows, "No data.");
}

function renderChannels(channelBreakdown) {
  const el = document.getElementById("rTab-channels");
  el.innerHTML = '<div class="reports-section"><div class="reports-section__title">Channel Breakdown</div></div>' +
    tableHtml([
      { key: "channel", label: "Code" },
      { key: "label", label: "Channel" },
      { key: "pick_qty", label: "Pick Qty", render: (value) => fmt(value) },
      { key: "line_count", label: "Lines", render: (value) => fmt(value) },
      { key: "order_count", label: "Orders", render: (value) => fmt(value) },
      { key: "sku_count", label: "SKUs", render: (value) => fmt(value) },
      { key: "share_of_picks", label: "Share", render: (value) => renderShareBar(value) },
    ], channelBreakdown, "No channels found.");
}

function renderReplenishment(replenishment) {
  const el = document.getElementById("rTab-replenishment");
  const note = replenishment?.note || "";
  let html = '<div class="reports-section"><div class="reports-section__title">Low-Level Replenishment Estimates (level < 20)</div></div>';
  if (note) {
    html += `<div class="reports-binloc-notice">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      ${escHtml(note)}
    </div>`;
  }

  html += tableHtml([
    { key: "location", label: "Location" },
    { key: "aisle_prefix", label: "Aisle" },
    { key: "level", label: "Level" },
    { key: "operating_area", label: "Area" },
    { key: "bin_size", label: "Bin Size" },
    { key: "bin_type", label: "Bin Type" },
    { key: "pick_qty", label: "Pick Qty", render: (value) => fmt(value) },
    { key: "max_bin_qty", label: "Max Bin Qty", render: (value) => value ? fmt(value) : "-" },
    { key: "estimated_replenishments", label: "Est. Replens", render: (value) => value != null ? fmt(value) : "-" },
  ], replenishment?.locations || [], "No replenishment rows found.");

  el.innerHTML = html;
}

function renderPcZone(pcZone, meta) {
  const el = document.getElementById("rTab-pc-zone");
  const summary = pcZone?.summary || {};
  const note = pcZone?.note || "";
  const pcPct = Math.min(Math.max(Number(summary.pc_pick_share || 0), 0), 100);

  let html = '<div class="reports-section"><div class="reports-section__title">PC Zone Mix</div></div>';

  if (note) {
    html += `<div class="reports-binloc-notice">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      ${escHtml(note)}
    </div>`;
  }

  html += `
    <div class="reports-pc-zone-shell">
      <div class="reports-pc-zone-card">
        <div class="reports-pc-zone-card__title">Pick Qty Split</div>
        <div class="reports-pc-zone-pie-row">
          <div class="reports-pc-zone-pie" style="background:conic-gradient(var(--color-primary) 0 ${pcPct}%, rgba(148,163,184,.28) ${pcPct}% 100%)">
            <div class="reports-pc-zone-pie__inner">
              <strong>${pcPct}%</strong>
              <span>from PC</span>
            </div>
          </div>
          <div class="reports-pc-zone-legend">
            <div class="reports-pc-zone-legend__item">
              <span class="reports-pc-zone-legend__swatch reports-pc-zone-legend__swatch--pc"></span>
              <div><strong>PC areas</strong><span>${fmt(summary.pc_pick_qty)} units / ${fmt(summary.pc_line_count)} lines</span></div>
            </div>
            <div class="reports-pc-zone-legend__item">
              <span class="reports-pc-zone-legend__swatch reports-pc-zone-legend__swatch--nonpc"></span>
              <div><strong>Outside PC</strong><span>${fmt(summary.non_pc_pick_qty)} units / ${fmt(summary.non_pc_line_count)} lines</span></div>
            </div>
          </div>
        </div>
      </div>
      <div class="reports-metric-grid reports-metric-grid--compact">
        <div class="reports-metric-card">
          <div class="reports-metric-card__label">PC Orders</div>
          <div class="reports-metric-card__value">${fmt(summary.pc_order_count)}</div>
          <div class="reports-metric-card__sub">${summary.pc_line_share || 0}% of lines touched PC</div>
        </div>
        <div class="reports-metric-card">
          <div class="reports-metric-card__label">SKUs In PC</div>
          <div class="reports-metric-card__value">${fmt(summary.pc_sku_count)}</div>
          <div class="reports-metric-card__sub">${fmt(summary.non_pc_only_sku_count)} active SKUs stayed outside PC</div>
        </div>
        <div class="reports-metric-card">
          <div class="reports-metric-card__label">Active PC Faces</div>
          <div class="reports-metric-card__value">${fmt(summary.pc_active_location_count)}</div>
          <div class="reports-metric-card__sub">Low-level PC locations seen in BINLOC</div>
        </div>
        <div class="reports-metric-card">
          <div class="reports-metric-card__label">Median PC Capacity</div>
          <div class="reports-metric-card__value">${fmtMaybe(summary.pc_capacity_benchmark_units)}</div>
          <div class="reports-metric-card__sub">Assumed single PC slot max bin qty</div>
        </div>
      </div>
    </div>
    <div class="reports-section"><div class="reports-section__title">Top SKUs Currently Picked From PC</div></div>
    ${tableHtml([
      { key: "sku", label: "SKU", render: (value) => renderDetailLink("sku", value, value) },
      { key: "pc_pick_qty", label: "PC Qty", render: (value) => fmt(value) },
      { key: "total_pick_qty", label: "Total Qty", render: (value) => fmt(value) },
      { key: "pc_share_of_sku", label: "PC Share", render: (value) => `${value}%` },
      { key: "pc_order_count", label: "PC Orders", render: (value) => fmt(value) },
      { key: "current_non_pc_replenishments", label: "Current Replens", render: (value) => fmtMaybe(value) },
      { key: "low_level_non_pc_capacity", label: "Non-PC Cap <20", render: (value) => fmtMaybe(value) },
      { key: "extra_replenishments_if_pc_removed", label: "Extra Replens No PC", render: (value) => fmtMaybe(value) },
      { key: "total_replenishments_without_pc", label: "Total Replens No PC", render: (value) => fmtMaybe(value) },
    ], pcZone?.top_pc_skus || [], "No picks were taken from PC locations for the current filters.")}
    <div class="reports-section"><div class="reports-section__title">Top SKUs Not Currently Picked From PC</div></div>
    ${tableHtml([
      { key: "sku", label: "SKU", render: (value) => renderDetailLink("sku", value, value) },
      { key: "total_pick_qty", label: "Total Qty", render: (value) => fmt(value) },
      { key: "order_count", label: "Orders", render: (value) => fmt(value) },
      { key: "share_of_total_picks", label: "Share", render: (value) => renderShareBar(value) },
      { key: "low_level_non_pc_capacity", label: "Current Cap <20", render: (value) => fmtMaybe(value) },
      { key: "current_estimated_replenishments", label: "Current Replens", render: (value) => fmtMaybe(value) },
      { key: "estimated_replenishments_in_pc", label: "Est. Replens In PC", render: (value) => fmtMaybe(value) },
      { key: "estimated_replenishments_delta", label: "PC Impact", render: (value) => renderReplenishmentDelta(value) },
    ], pcZone?.top_non_pc_skus || [], meta?.binloc_available ? "No high-volume non-PC SKUs were found for the current filters." : "BINLOC data is required to estimate PC candidates.")}
  `;

  el.innerHTML = html;
}

function renderDaily(dailyBreakdown) {
  const el = document.getElementById("rTab-daily");
  el.innerHTML = '<div class="reports-section"><div class="reports-section__title">Daily Breakdown</div></div>' +
    tableHtml([
      { key: "date", label: "Date" },
      { key: "pick_qty", label: "Pick Qty", render: (value) => fmt(value) },
      { key: "line_count", label: "Lines", render: (value) => fmt(value) },
      { key: "order_count", label: "Orders", render: (value) => fmt(value) },
      { key: "sku_count", label: "SKUs", render: (value) => fmt(value) },
    ], dailyBreakdown, "No daily rows found.");
}

function openDetailDrawer(type, value) {
  detailDrawerTitle().textContent = type === "location" ? `Location ${value}` : `SKU ${value}`;
  detailDrawerSubtitle().textContent = currentRangeLabel();
  detailDrawerBody().innerHTML = loadingHtml("Loading detail...");
  detailDrawer().classList.add("drawer--open");
  detailDrawerBackdrop().classList.add("drawer-backdrop--visible");

  const params = buildQuery();
  params.set("entity", type);
  params.set("value", value);

  fetch("/api/reports-detail?" + params.toString())
    .then((resp) => resp.json())
    .then((data) => {
      if (!data.ok) {
        detailDrawerBody().innerHTML = errorHtml(data.error || "Request failed.");
        return;
      }
      renderDetailDrawer(data);
    })
    .catch((err) => {
      detailDrawerBody().innerHTML = errorHtml("Failed to load detail: " + err.message);
    });
}

function closeDetailDrawer() {
  detailDrawer().classList.remove("drawer--open");
  detailDrawerBackdrop().classList.remove("drawer-backdrop--visible");
}

function currentRangeLabel() {
  if (!_data?.meta?.loaded_dates?.length) return selClient().options[selClient().selectedIndex]?.text || "";
  const dates = [..._data.meta.loaded_dates].sort();
  const client = selClient().options[selClient().selectedIndex]?.text || _data.meta.client_code || "";
  if (dates.length === 1) return `${client} - ${dates[0]}`;
  return `${client} - ${dates[0]} to ${dates[dates.length - 1]}`;
}

function detailNoticeHtml(meta) {
  const missing = meta?.pick_transaction_dates_missing || [];
  if (!missing.length) return "";
  return `<div class="reports-binloc-notice">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    Pick transaction snapshots are missing for ${escHtml(missing.join(", "))}. Picker and transaction sections only show dates that are currently available.
  </div>`;
}

function renderDetailMetricCards(entity, summary) {
  const cards = entity === "location"
    ? [
        { label: "Pick Qty", value: fmt(summary.pick_qty), sub: `${fmt(summary.line_count)} lines` },
        { label: "Orders", value: fmt(summary.order_count), sub: `${fmt(summary.customer_count)} customers` },
        { label: "SKUs", value: fmt(summary.sku_count), sub: `${fmt(summary.picker_count)} pickers` },
        { label: "Transactions", value: fmt(summary.transaction_count), sub: "Matched pick transactions" },
        { label: "Area", value: summary.operating_area || "-", sub: `${summary.bin_type || "-"} / ${summary.bin_size || "-"}` },
        { label: "Level", value: summary.level || "-", sub: summary.aisle_prefix ? `Aisle ${summary.aisle_prefix}` : "" },
        { label: "Max Bin Qty", value: fmtMaybe(summary.max_bin_qty), sub: `Current qty ${fmtMaybe(summary.current_bin_qty)}` },
      ]
    : [
        { label: "Pick Qty", value: fmt(summary.pick_qty), sub: `${fmt(summary.line_count)} lines` },
        { label: "Orders", value: fmt(summary.order_count), sub: `${fmt(summary.customer_count)} customers` },
        { label: "Locations", value: fmt(summary.location_count), sub: `${fmt(summary.picker_count)} pickers` },
        { label: "Transactions", value: fmt(summary.transaction_count), sub: "Matched pick transactions" },
        { label: "Channels", value: fmt(summary.channel_count), sub: `${fmt(summary.item_group_count)} item groups` },
      ];

  return '<div class="reports-metric-grid reports-detail-metric-grid">' +
    cards.map((card) => `
      <div class="reports-metric-card">
        <div class="reports-metric-card__label">${card.label}</div>
        <div class="reports-metric-card__value">${card.value}</div>
        ${card.sub ? `<div class="reports-metric-card__sub">${card.sub}</div>` : ""}
      </div>`).join("") +
    "</div>";
}

function renderSkuCatalogCard(skuDetail) {
  if (!skuDetail) {
    return `<div class="reports-detail-card"><div class="reports-detail-card__title">Item Detail</div><p class="reports-detail-muted">No catalog details or images were found for this SKU.</p></div>`;
  }

  const images = (skuDetail.images || []).map((image) =>
    `<a class="reports-detail-image" href="${escAttr(image.url)}" target="_blank" rel="noreferrer">
      <img src="${escAttr(image.url)}" alt="${escAttr(skuDetail.sku || "SKU image")}" loading="lazy" />
    </a>`
  ).join("");

  return `
    <div class="reports-detail-card reports-detail-card--catalog">
      <div class="reports-detail-card__title">Item Detail</div>
      <div class="reports-detail-catalog">
        <div class="reports-detail-catalog__meta">
          <div class="reports-detail-catalog__sku">${escHtml(skuDetail.sku || "-")}</div>
          <div class="reports-detail-catalog__desc">${escHtml(skuDetail.description || skuDetail.description_short || "No description available.")}</div>
          <div class="reports-detail-catalog__facts">
            <span><strong>Short:</strong> ${escHtml(skuDetail.description_short || "-")}</span>
            <span><strong>Size:</strong> ${escHtml(skuDetail.size || "-")}</span>
            <span><strong>Color:</strong> ${escHtml(skuDetail.color || "-")}</span>
            <span><strong>Barcode:</strong> ${escHtml(skuDetail.barcode || "-")}</span>
          </div>
        </div>
        <div class="reports-detail-gallery">
          ${images || `<div class="reports-detail-muted">No images available.</div>`}
        </div>
      </div>
    </div>
  `;
}

function renderDetailSection(title, cols, rows, emptyMsg) {
  return `
    <div class="reports-section"><div class="reports-section__title">${title}</div></div>
    ${tableHtml(cols, rows, emptyMsg)}
  `;
}

function renderDetailDrawer(data) {
  const entity = data.entity;
  const meta = data.meta || {};
  const summary = data.summary || {};
  const transactionsEmptyMsg = (meta.pick_transaction_dates_loaded || []).length
    ? "No pick transactions matched the current filters."
    : "Pick transaction snapshots are not available yet for the selected dates.";

  let html = detailNoticeHtml(meta);
  html += renderDetailMetricCards(entity, summary);

  if (entity === "location") {
    html += renderDetailSection("Top SKUs From This Location", [
      { key: "sku", label: "SKU", render: (value) => renderDetailLink("sku", value, value) },
      { key: "item_group", label: "Group", render: (value) => escHtml(value || "-") },
      { key: "pick_qty", label: "Pick Qty", render: (value) => fmt(value) },
      { key: "line_count", label: "Lines", render: (value) => fmt(value) },
      { key: "order_count", label: "Orders", render: (value) => fmt(value) },
      { key: "customer_count", label: "Customers", render: (value) => fmt(value) },
    ], data.sku_breakdown || [], "No SKU breakdown found for this location.");
  } else {
    html += renderSkuCatalogCard(data.sku_detail);
    html += renderDetailSection("Top Locations For This SKU", [
      { key: "location", label: "Location", render: (value) => renderDetailLink("location", value, value) },
      { key: "pick_qty", label: "Pick Qty", render: (value) => fmt(value) },
      { key: "line_count", label: "Lines", render: (value) => fmt(value) },
      { key: "order_count", label: "Orders", render: (value) => fmt(value) },
    ], data.location_breakdown || [], "No location breakdown found for this SKU.");
  }

  html += renderDetailSection("Picker Breakdown", [
    { key: "picker", label: "Picker" },
    { key: "pick_qty", label: "Pick Qty", render: (value) => fmt(value) },
    { key: "transaction_count", label: "Transactions", render: (value) => fmt(value) },
    { key: "order_count", label: "Orders", render: (value) => fmt(value) },
    { key: "sku_count", label: "SKUs", render: (value) => fmt(value) },
    { key: "location_count", label: "Locations", render: (value) => fmt(value) },
  ], data.picker_breakdown || [], transactionsEmptyMsg);

  html += renderDetailSection(entity === "location" ? "Order Lines Picked From This Location" : "Order Lines For This SKU", [
    { key: "snapshot_date", label: "Snapshot" },
    { key: "order_number", label: "Order" },
    { key: "order_line", label: "Line", render: (value) => fmtMaybe(value) },
    { key: "item", label: "SKU", render: (value) => entity === "location" ? renderDetailLink("sku", value, value) : escHtml(value) },
    { key: "customer_name", label: "Customer", render: (value) => `<span class="reports-detail-nowrap" title="${escAttr(value)}">${escHtml(value || "-")}</span>` },
    { key: "order_channel", label: "Channel" },
    { key: "item_group", label: "Group" },
    { key: "picking_location", label: "Location", render: (value) => entity === "sku" ? renderDetailLink("location", value, value) : escHtml(value) },
    { key: "pick_qty", label: "Pick Qty", render: (value) => fmt(value) },
    { key: "pickers", label: "Picker(s)", render: (value) => value ? escHtml(value) : '<span class="reports-detail-muted">No transactions</span>' },
    { key: "transaction_count", label: "Txn", render: (value) => value ? fmt(value) : "-" },
    { key: "transaction_qty", label: "Txn Qty", render: (value) => value ? fmt(value) : "-" },
  ], data.order_lines || [], "No order lines matched the current filters.");

  html += renderDetailSection(entity === "location" ? "Pick Transactions For This Location" : "Pick Transactions For This SKU", [
    { key: "snapshot_date", label: "Snapshot" },
    { key: "BTPICU", label: "Picker" },
    { key: "BTPICD", label: "Pick Date" },
    { key: "BAITEM", label: "SKU", render: (value) => entity === "location" ? renderDetailLink("sku", value, value) : escHtml(value) },
    { key: "BABINL", label: "Bin", render: (value) => entity === "sku" ? renderDetailLink("location", value, value) : escHtml(value) },
    { key: "BAQTY", label: "Qty", render: (value) => fmt(value) },
    { key: "BTORDN", label: "Order" },
  ], data.pick_transactions || [], transactionsEmptyMsg);

  detailDrawerSubtitle().textContent = currentRangeLabel();
  detailDrawerBody().innerHTML = html || emptyStateHtml("No detail was returned for this selection.");
}

function toggleChLocSection(ch, which) {
  if (!_chLocExpanded[ch]) _chLocExpanded[ch] = { above20: true, below20: true };
  _chLocExpanded[ch][which] = !_chLocExpanded[ch][which];
  const sEl = document.getElementById(`rChLoc-${ch}-${which}`);
  const aEl = document.getElementById(`rChArrow-${ch}-${which}`);
  const open = _chLocExpanded[ch][which];
  if (sEl) sEl.style.display = open ? "" : "none";
  if (aEl) aEl.style.transform = open ? "" : "rotate(-90deg)";
}

function renderChannelDetail(ch, data, el) {
  if (!_chLocExpanded[ch]) _chLocExpanded[ch] = { above20: true, below20: true };

  let topSkus = data.top_skus || [];
  let topLocations = data.top_locations || [];
  if (hideGrp147()) {
    topSkus = topSkus.filter(r => String(r.item_group) !== "147");
    topLocations = topLocations.filter(r => String(r.primary_item_group) !== "147");
  }

  const above20 = topLocations.filter(r => Number(r.level) >= 20);
  const below20 = topLocations.filter(r => Number(r.level) < 20);
  const chevron = `<svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="flex-shrink:0;transition:transform 0.15s"><polyline points="1,3 5,7 9,3"/></svg>`;

  const skuCols = [
    { key: "_rank", label: "#", render: (_v, row) => topSkus.indexOf(row) + 1 },
    { key: "sku", label: "SKU", render: (v) => renderDetailLink("sku", v, v) },
    { key: "item_group", label: "Group" },
    { key: "pick_qty", label: "Pick Qty", render: (v) => fmt(v) },
    { key: "line_count", label: "Lines", render: (v) => fmt(v) },
    { key: "order_count", label: "Orders", render: (v) => fmt(v) },
    { key: "location_count", label: "Locations", render: (v) => fmt(v) },
    { key: "share_of_picks", label: "Channel Share", render: (v) => renderShareBar(v) },
  ];
  const locCols = [
    { key: "location", label: "Location", render: (v) => renderDetailLink("location", v, v) },
    { key: "aisle_prefix", label: "Aisle" },
    { key: "level", label: "Level" },
    { key: "operating_area", label: "Area" },
    { key: "bin_size", label: "Bin Size" },
    { key: "bin_type", label: "Bin Type" },
    { key: "max_bin_qty", label: "Max Qty", render: (v) => v ? fmt(v) : "-" },
    { key: "pick_qty", label: "Pick Qty", render: (v) => fmt(v) },
    { key: "line_count", label: "Lines", render: (v) => fmt(v) },
    { key: "sku_count", label: "SKUs", render: (v) => fmt(v) },
  ];

  const grpNote = hideGrp147() ? ' <span style="font-size:10px;font-weight:400;color:var(--text-soft)">(group 147 hidden)</span>' : "";
  const aboveOpen = _chLocExpanded[ch].above20;
  const belowOpen = _chLocExpanded[ch].below20;
  const aboveArrow = `<span id="rChArrow-${ch}-above20" style="display:inline-flex;transition:transform 0.15s;${aboveOpen ? "" : "transform:rotate(-90deg)"}">${chevron}</span>`;
  const belowArrow = `<span id="rChArrow-${ch}-below20" style="display:inline-flex;transition:transform 0.15s;${belowOpen ? "" : "transform:rotate(-90deg)"}">${chevron}</span>`;

  let html = `<div class="reports-section"><div class="reports-section__title">Top SKUs — ${escHtml(data.label || ch)}${grpNote}</div></div>`;
  html += tableHtml(skuCols, topSkus, "No SKU data for this channel.");

  html += `<div class="reports-section"><div class="reports-section__title">Top Locations — ${escHtml(data.label || ch)}${grpNote}</div></div>`;
  html += `
    <div class="reports-section" style="cursor:pointer;user-select:none" onclick="toggleChLocSection('${escAttr(ch)}','above20')">
      <div class="reports-section__title" style="display:flex;align-items:center;gap:6px">
        ${aboveArrow} Above Level 20
        <span style="font-size:10px;font-weight:400;color:var(--text-soft)">(${above20.length} locations)</span>
      </div>
    </div>
    <div id="rChLoc-${escAttr(ch)}-above20" style="${aboveOpen ? "" : "display:none"}">
      ${tableHtml(locCols, above20, "No locations at or above level 20 for this channel.")}
    </div>
    <div class="reports-section" style="cursor:pointer;user-select:none" onclick="toggleChLocSection('${escAttr(ch)}','below20')">
      <div class="reports-section__title" style="display:flex;align-items:center;gap:6px">
        ${belowArrow} Below Level 20
        <span style="font-size:10px;font-weight:400;color:var(--text-soft)">(${below20.length} locations)</span>
      </div>
    </div>
    <div id="rChLoc-${escAttr(ch)}-below20" style="${belowOpen ? "" : "display:none"}">
      ${tableHtml(locCols, below20, "No locations below level 20 for this channel.")}
    </div>
  `;

  el.innerHTML = html;
}

function renderChannelTabs(channelDetails) {
  const tabBar = document.getElementById("rTabs");
  const contentWrap = tabBar.closest(".card-edge").querySelector("div[style*='overflow-y']");

  // Remove previously injected channel tabs/panels
  tabBar.querySelectorAll("[data-channel-tab]").forEach(el => el.remove());
  if (contentWrap) contentWrap.querySelectorAll("[data-channel-panel]").forEach(el => el.remove());

  // Sort channels by total pick_qty from channel_breakdown
  const order = (_data?.channel_breakdown || []).map(r => r.channel);
  const sorted = Object.entries(channelDetails).sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));

  for (const [ch, data] of sorted) {
    const tabName = `ch-${ch}`;

    const btn = document.createElement("button");
    btn.className = "tabbtn reports-tab-btn";
    btn.dataset.tab = tabName;
    btn.dataset.channelTab = ch;
    btn.textContent = data.label || ch;
    tabBar.appendChild(btn);

    const panel = document.createElement("div");
    panel.id = `rTab-${tabName}`;
    panel.className = "reports-tab-content";
    panel.dataset.channelPanel = ch;
    if (contentWrap) contentWrap.appendChild(panel);

    renderChannelDetail(ch, data, panel);
  }
}

function showExportModal() {
  if (!_data) { alert("No data loaded yet — click Reload first."); return; }
  const channels = _data.channel_breakdown || [];
  const body = document.getElementById("rExportModalBody");
  body.innerHTML = `
    <p style="margin:0 0 12px;font-size:12px;color:var(--text-soft)">
      General sheets (Summary, SKUs, Locations, Aisles, Structure, Channels, Replenishment, Daily) are always included.
      Select which channel detail sheets to add:
    </p>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${channels.length === 0 ? '<p style="color:var(--text-soft);font-size:12px">No channels in current data.</p>' :
        channels.map(r => `
          <label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer">
            <input type="checkbox" class="rExportChCb" value="${escAttr(r.channel)}"
              style="accent-color:var(--accent);width:13px;height:13px;cursor:pointer" checked />
            <span><strong>${escHtml(r.channel)}</strong> — ${escHtml(r.label || r.channel)}</span>
            <span style="color:var(--text-soft);margin-left:auto">${fmt(r.pick_qty)} picks</span>
          </label>`).join("")
      }
    </div>
    <div style="margin-top:14px;display:flex;gap:8px;align-items:center">
      <button class="btn btn--sm" id="rExportChkAll" type="button">All</button>
      <button class="btn btn--sm" id="rExportChkNone" type="button">None</button>
    </div>
  `;
  document.getElementById("rExportModalBackdrop").hidden = false;

  document.getElementById("rExportChkAll")?.addEventListener("click", () => {
    document.querySelectorAll(".rExportChCb").forEach(cb => { cb.checked = true; });
  });
  document.getElementById("rExportChkNone")?.addEventListener("click", () => {
    document.querySelectorAll(".rExportChCb").forEach(cb => { cb.checked = false; });
  });
}

function closeExportModal() {
  document.getElementById("rExportModalBackdrop").hidden = true;
}

function exportToExcel(selectedChannels) {
  if (!_data) { alert("No data loaded yet — click Reload first."); return; }
  if (typeof XLSX === "undefined") { alert("Excel library not loaded. Check your connection and reload."); return; }

  const wb = XLSX.utils.book_new();
  const { meta, summary } = _data;
  const sortedDates = [...(meta.loaded_dates || [])].sort();
  const dateStr = sortedDates.length === 1 ? sortedDates[0]
    : sortedDates.length > 1 ? `${sortedDates[0]} to ${sortedDates[sortedDates.length - 1]}` : "No data";

  const channelLabel = getSelectedChannels().length ? getSelectedChannels().join(", ") : "All channels";
  const rankLabel = selRankBy()?.options[selRankBy().selectedIndex]?.text || "";
  const grp147Label = hideGrp147() ? "Hidden (group 147 excluded)" : "Shown (all groups included)";
  const generatedAt = new Date().toLocaleString();

  // Builds a context block + description rows followed by the column header + data rows
  function makeSheet(title, description, cols, rows) {
    const dataRows = (rows || []).map(row => cols.map(c => {
      const v = row[c.key];
      return (v === null || v === undefined) ? "" : v;
    }));
    const aoa = [
      [title],
      [],
      ["REPORT CONTEXT"],
      ["Client", meta.client_code || ""],
      ["Date Range", dateStr],
      ["Days Included", meta.date_count],
      ["Channels", channelLabel],
      ["Rank By", rankLabel],
      ["Group 147 Filter", grp147Label],
      ["Exported At", generatedAt],
      [],
      ["ABOUT THIS DATA"],
      [description],
      [],
      cols.map(c => c.label),
      ...dataRows,
    ];
    return XLSX.utils.aoa_to_sheet(aoa);
  }

  // Summary — built manually (key/value layout, not a column table)
  const summarySheet = XLSX.utils.aoa_to_sheet([
    ["Summary — Pick Analysis"],
    [],
    ["REPORT CONTEXT"],
    ["Client", meta.client_code || ""],
    ["Date Range", dateStr],
    ["Days Included", meta.date_count],
    ["Channels", channelLabel],
    ["Rank By", rankLabel],
    ["Group 147 Filter", grp147Label],
    ["Exported At", generatedAt],
    [],
    ["ABOUT THIS DATA"],
    ["Top-level pick activity metrics for the selected client and date window. Pick Qty is the total number of units picked. " +
     "Lines is the number of individual order lines fulfilled. Orders is the count of distinct order numbers processed. " +
     "High-Level picks are those taken from storage locations at level 20 or above (upper-rack picking). " +
     "High-Level Share is high-level pick qty as a percentage of all pick qty. " +
     "Peak Day is the single calendar date with the highest pick qty within the window."],
    [],
    ["Metric", "Value"],
    ["Total Pick Qty", summary.total_pick_qty],
    ["Total Lines", summary.total_line_count],
    ["Total Orders", summary.total_order_count],
    ["Avg Qty per Line", summary.avg_qty_per_line],
    ["Avg Lines per Day", summary.avg_lines_per_day],
    ["Active SKUs", summary.active_sku_count],
    ["Active Locations", summary.active_location_count],
    ["Active Aisles", summary.active_aisle_count],
    ["Active Channels", summary.active_channel_count],
    ["Active Item Groups", summary.active_item_group_count],
    ["High-Level Pick Qty (level ≥ 20)", summary.high_level_pick_qty],
    ["High-Level Share %", summary.high_level_share],
    ["Peak Day", summary.peak_day_date || ""],
    ["Peak Day Pick Qty", summary.peak_day_pick_qty],
  ]);
  XLSX.utils.book_append_sheet(wb, summarySheet, "Summary");

  // Top SKUs
  let topSkus = _data.top_skus || [];
  if (hideGrp147()) topSkus = topSkus.filter(r => String(r.item_group) !== "147");
  XLSX.utils.book_append_sheet(wb, makeSheet(
    "Top SKUs — Pick Analysis",
    `The top ${meta.limit || topSkus.length} SKUs ranked by ${rankLabel} across all order lines within the selected date window. ` +
    "Pick Qty is the total units picked for each SKU. Lines is the number of order lines containing that SKU. " +
    "Orders is the count of distinct orders that included the SKU. Locations is how many different storage locations the SKU was picked from. " +
    "Share % is this SKU's pick qty as a percentage of the total pick qty across all SKUs in the window.",
    [
      { key: "sku", label: "SKU" },
      { key: "item_group", label: "Item Group" },
      { key: "pick_qty", label: "Pick Qty" },
      { key: "line_count", label: "Lines" },
      { key: "order_count", label: "Orders" },
      { key: "location_count", label: "Locations" },
      { key: "share_of_picks", label: "Share %" },
    ],
    topSkus
  ), "Top SKUs");

  // High-Level SKUs
  if ((_data.high_level_skus || []).length) {
    XLSX.utils.book_append_sheet(wb, makeSheet(
      "High-Level SKUs — Pick Analysis",
      "SKUs that had at least one pick from a location at level 20 or above (upper-rack / elevated picking). " +
      "High-Level Qty is the number of units picked specifically from those elevated locations. " +
      "Total Qty is the SKU's overall pick qty across all levels. " +
      "HL Share % is high-level qty as a percentage of that SKU's total pick qty — a high value means most picks for that SKU come from upper racking.",
      [
        { key: "sku", label: "SKU" },
        { key: "high_level_pick_qty", label: "High-Level Qty" },
        { key: "total_pick_qty", label: "Total Qty" },
        { key: "high_level_share", label: "HL Share %" },
      ],
      _data.high_level_skus
    ), "High-Level SKUs");
  }

  // Locations split
  let topLocations = _data.top_locations || [];
  if (hideGrp147()) topLocations = topLocations.filter(r => String(r.primary_item_group) !== "147");
  const locCols = [
    { key: "location", label: "Location" },
    { key: "aisle_prefix", label: "Aisle" },
    { key: "level", label: "Level" },
    { key: "operating_area", label: "Area" },
    { key: "bin_size", label: "Bin Size" },
    { key: "bin_type", label: "Bin Type" },
    { key: "max_bin_qty", label: "Max Qty" },
    { key: "pick_qty", label: "Pick Qty" },
    { key: "line_count", label: "Lines" },
    { key: "sku_count", label: "SKUs" },
  ];
  const locDesc = "The top 100 storage locations ranked by pick activity within the selected window. " +
    "Level is the physical height tier of the location (level 1 = ground; higher numbers = upper racking). " +
    "Area is the operating zone the location belongs to. Bin Size and Bin Type describe the physical slot. " +
    "Max Qty is the maximum units the bin can hold as configured in the warehouse system. " +
    "Pick Qty is total units picked from the location. Lines is order lines fulfilled from it. SKUs is the count of distinct products picked from it. " +
    "Primary Item Group is the item group that contributed the most pick qty to this location during the window.";
  XLSX.utils.book_append_sheet(wb, makeSheet(
    "Locations Above Level 20 — Pick Analysis",
    "Filtered to locations at level 20 or above (elevated / upper-rack storage). " + locDesc,
    locCols,
    topLocations.filter(r => Number(r.level) >= 20)
  ), "Locations Above 20");
  XLSX.utils.book_append_sheet(wb, makeSheet(
    "Locations Below Level 20 — Pick Analysis",
    "Filtered to locations below level 20 (ground-level and low-rack storage). " + locDesc,
    locCols,
    topLocations.filter(r => Number(r.level) < 20)
  ), "Locations Below 20");

  // Aisles
  XLSX.utils.book_append_sheet(wb, makeSheet(
    "Top Aisles — Pick Analysis",
    "Pick activity aggregated by aisle prefix (the letter/number group that identifies a warehouse aisle). " +
    "Top 50 aisles are shown, ranked by pick qty. Locations is the count of distinct storage locations in that aisle that were picked from. " +
    "SKUs is the count of distinct products picked from the aisle. Share % is the aisle's pick qty as a percentage of total pick qty.",
    [
      { key: "aisle_prefix", label: "Aisle" },
      { key: "pick_qty", label: "Pick Qty" },
      { key: "line_count", label: "Lines" },
      { key: "location_count", label: "Locations" },
      { key: "sku_count", label: "SKUs" },
      { key: "share_of_picks", label: "Share %" },
    ],
    _data.top_aisles || []
  ), "Aisles");

  // Level Breakdown
  XLSX.utils.book_append_sheet(wb, makeSheet(
    "Level Breakdown — Pick Analysis",
    "Pick activity grouped by storage level number. Level 1 is ground floor; higher numbers are upper racking tiers. " +
    "High-Level flags levels at or above 20 as elevated picking (requiring ladders or high-reach equipment). " +
    "This breakdown shows how pick volume is distributed vertically across the warehouse.",
    [
      { key: "level", label: "Level" },
      { key: "is_high_level", label: "High-Level (≥20)" },
      { key: "pick_qty", label: "Pick Qty" },
      { key: "line_count", label: "Lines" },
      { key: "location_count", label: "Locations" },
      { key: "sku_count", label: "SKUs" },
      { key: "share_of_picks", label: "Share %" },
    ],
    _data.level_breakdown || []
  ), "Level Breakdown");

  // Bin Size
  XLSX.utils.book_append_sheet(wb, makeSheet(
    "Bin Size Breakdown — Pick Analysis",
    "Pick activity grouped by bin size category as configured in the warehouse bin-location (BINLOC) data. " +
    "Bin size typically reflects the physical footprint or capacity class of the storage slot (e.g. S, M, L, XL). " +
    "Share % is that bin size's contribution to total pick qty.",
    [
      { key: "bin_size", label: "Bin Size" },
      { key: "pick_qty", label: "Pick Qty" },
      { key: "line_count", label: "Lines" },
      { key: "location_count", label: "Locations" },
      { key: "share_of_picks", label: "Share %" },
    ],
    _data.bin_size_breakdown || []
  ), "Bin Size");

  // Bin Type
  XLSX.utils.book_append_sheet(wb, makeSheet(
    "Bin Type Breakdown — Pick Analysis",
    "Pick activity grouped by bin type as configured in the warehouse bin-location (BINLOC) data. " +
    "Bin type describes the storage method or slot format (e.g. shelf, pallet, flow-rack, carton). " +
    "Share % is that bin type's contribution to total pick qty.",
    [
      { key: "bin_type", label: "Bin Type" },
      { key: "pick_qty", label: "Pick Qty" },
      { key: "line_count", label: "Lines" },
      { key: "location_count", label: "Locations" },
      { key: "share_of_picks", label: "Share %" },
    ],
    _data.bin_type_breakdown || []
  ), "Bin Type");

  // Operating Area
  XLSX.utils.book_append_sheet(wb, makeSheet(
    "Operating Area Breakdown — Pick Analysis",
    "Pick activity grouped by operating area — the functional zone of the warehouse each location belongs to (e.g. PC, ambient, chilled, bulk). " +
    "Areas are sourced from the BINLOC snapshot. If BINLOC data is unavailable, area values will be blank.",
    [
      { key: "operating_area", label: "Area" },
      { key: "pick_qty", label: "Pick Qty" },
      { key: "line_count", label: "Lines" },
      { key: "location_count", label: "Locations" },
      { key: "sku_count", label: "SKUs" },
      { key: "share_of_picks", label: "Share %" },
    ],
    _data.operating_area_breakdown || []
  ), "Operating Areas");

  // Item Groups
  XLSX.utils.book_append_sheet(wb, makeSheet(
    "Item Group Breakdown — Pick Analysis",
    "Pick activity grouped by item group code — a product classification used in the warehouse management system (WMS). " +
    "Item groups typically represent product categories or departments (e.g. 100 = ambient grocery, 147 = special handling). " +
    "SKUs is the count of distinct products in that group that were picked during the window.",
    [
      { key: "item_group", label: "Item Group" },
      { key: "pick_qty", label: "Pick Qty" },
      { key: "line_count", label: "Lines" },
      { key: "order_count", label: "Orders" },
      { key: "sku_count", label: "SKUs" },
      { key: "share_of_picks", label: "Share %" },
    ],
    _data.item_group_breakdown || []
  ), "Item Groups");

  // Channels
  XLSX.utils.book_append_sheet(wb, makeSheet(
    "Channel Breakdown — Pick Analysis",
    "Pick activity broken down by order channel — the fulfilment route or customer type each order was placed through " +
    "(e.g. B = Build Your Own, C = Customer Web, S = Store Replen, W = Wholesale). " +
    "A single order can only belong to one channel. Share % is that channel's pick qty as a percentage of total pick qty.",
    [
      { key: "channel", label: "Channel Code" },
      { key: "label", label: "Channel Name" },
      { key: "pick_qty", label: "Pick Qty" },
      { key: "line_count", label: "Lines" },
      { key: "order_count", label: "Orders" },
      { key: "sku_count", label: "SKUs" },
      { key: "share_of_picks", label: "Share %" },
    ],
    _data.channel_breakdown || []
  ), "Channels");

  // Replenishment
  XLSX.utils.book_append_sheet(wb, makeSheet(
    "Replenishment Estimates — Pick Analysis",
    "Estimated replenishment counts for low-level locations (level < 20) based on pick demand vs bin capacity. " +
    "Est. Replens is calculated as: Pick Qty ÷ Max Bin Qty, rounded up — representing how many times the bin would need to be refilled " +
    "to satisfy demand during the window. This is an estimate only; actual replenishment frequency depends on stock levels and replenishment rules. " +
    "Requires BINLOC snapshot data to populate Max Bin Qty.",
    [
      { key: "location", label: "Location" },
      { key: "aisle_prefix", label: "Aisle" },
      { key: "level", label: "Level" },
      { key: "operating_area", label: "Area" },
      { key: "bin_size", label: "Bin Size" },
      { key: "bin_type", label: "Bin Type" },
      { key: "pick_qty", label: "Pick Qty" },
      { key: "max_bin_qty", label: "Max Bin Qty" },
      { key: "estimated_replenishments", label: "Est. Replens" },
    ],
    _data.replenishment?.locations || []
  ), "Replenishment");

  // Daily
  XLSX.utils.book_append_sheet(wb, makeSheet(
    "Daily Breakdown — Pick Analysis",
    "Pick activity broken down day by day across the selected date window. Each row is a single calendar date. " +
    "Pick Qty is total units picked on that day. Lines is order lines fulfilled. Orders is distinct order numbers processed. " +
    "SKUs is the count of distinct products picked. Days with no pick snapshot data are excluded from this table.",
    [
      { key: "date", label: "Date" },
      { key: "pick_qty", label: "Pick Qty" },
      { key: "line_count", label: "Lines" },
      { key: "order_count", label: "Orders" },
      { key: "sku_count", label: "SKUs" },
    ],
    _data.daily_breakdown || []
  ), "Daily");

  // Per-channel detail sheets (selected via modal)
  const channelDetails = _data.channel_details || {};
  const channelsToExport = selectedChannels || Object.keys(channelDetails);
  for (const ch of channelsToExport) {
    const det = channelDetails[ch];
    if (!det) continue;
    let chSkus = det.top_skus || [];
    let chLocs = det.top_locations || [];
    if (hideGrp147()) {
      chSkus = chSkus.filter(r => String(r.item_group) !== "147");
      chLocs = chLocs.filter(r => String(r.primary_item_group) !== "147");
    }
    const chLabel = det.label || ch;
    const sheetPrefix = `${ch} -`;
    XLSX.utils.book_append_sheet(wb, makeSheet(
      `Channel ${ch} (${chLabel}) — Top SKUs`,
      `Top SKUs picked for the ${chLabel} (${ch}) channel within the selected date window. ` +
      "Share % is this SKU's pick qty as a percentage of all picks within this channel.",
      [
        { key: "sku", label: "SKU" },
        { key: "item_group", label: "Item Group" },
        { key: "pick_qty", label: "Pick Qty" },
        { key: "line_count", label: "Lines" },
        { key: "order_count", label: "Orders" },
        { key: "location_count", label: "Locations" },
        { key: "share_of_picks", label: "Channel Share %" },
      ],
      chSkus
    ), `${sheetPrefix} Top SKUs`);
    XLSX.utils.book_append_sheet(wb, makeSheet(
      `Channel ${ch} (${chLabel}) — Locations Above 20`,
      `Top 100 locations at level 20 or above used to fulfil ${chLabel} (${ch}) channel orders. ` +
      "Pick Qty and Lines relate only to picks for this channel.",
      locCols,
      chLocs.filter(r => Number(r.level) >= 20)
    ), `${sheetPrefix} Locs ≥20`);
    XLSX.utils.book_append_sheet(wb, makeSheet(
      `Channel ${ch} (${chLabel}) — Locations Below 20`,
      `Top 100 locations below level 20 used to fulfil ${chLabel} (${ch}) channel orders. ` +
      "Pick Qty and Lines relate only to picks for this channel.",
      locCols,
      chLocs.filter(r => Number(r.level) < 20)
    ), `${sheetPrefix} Locs <20`);
  }

  const filename = `pick-analysis_${meta.client_code || "report"}_${sortedDates[0] || "export"}.xlsx`;
  XLSX.writeFile(wb, filename);
}

function switchTab(name) {
  document.querySelectorAll(".reports-tab-btn").forEach((btn) => {
    btn.classList.toggle("reports-tab-btn--active", btn.dataset.tab === name);
  });
  document.querySelectorAll(".reports-tab-content").forEach((el) => {
    el.classList.toggle("reports-tab-content--active", el.id === `rTab-${name}`);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  applyDateInputLimits();
  syncModeUi();
  initChannelPicker();

  selMode().addEventListener("change", syncModeUi);
  selClient().addEventListener("change", () => {
    buildChannelPicker(selClient().value);
    loadReports();
  });
  document.getElementById("rBtnLoad").addEventListener("click", loadReports);
  document.getElementById("rBtnExport")?.addEventListener("click", showExportModal);
  document.getElementById("rExportModalClose")?.addEventListener("click", closeExportModal);
  document.getElementById("rExportModalCancel")?.addEventListener("click", closeExportModal);
  document.getElementById("rExportModalBackdrop")?.addEventListener("click", closeExportModal);
  document.querySelector(".rmodal")?.addEventListener("click", (e) => e.stopPropagation());
  document.getElementById("rExportModalConfirm")?.addEventListener("click", () => {
    const selected = [...document.querySelectorAll(".rExportChCb:checked")].map(cb => cb.value);
    closeExportModal();
    exportToExcel(selected);
  });
  document.getElementById("rHideGrp147")?.addEventListener("change", () => {
    if (_data) {
      renderTopSkus(_data.top_skus, _data.meta.limit, _data.high_level_skus);
      renderLocations(_data.top_locations);
    }
  });
  document.getElementById("rTabs").addEventListener("click", (e) => {
    const btn = closestFromEvent(e, ".reports-tab-btn");
    if (btn) switchTab(btn.dataset.tab);
  });

  document.addEventListener("click", (e) => {
    const trigger = closestFromEvent(e, "[data-report-detail-type]");
    if (!trigger) return;
    openDetailDrawer(trigger.dataset.reportDetailType, trigger.dataset.reportDetailValue);
  });

  detailDrawerClose().addEventListener("click", closeDetailDrawer);
  detailDrawerBackdrop().addEventListener("click", closeDetailDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDetailDrawer();
  });

  loadReports();
});
