"use strict";

// ── State ──────────────────────────────────────────────────────────────────
let _data = null;

// ── DOM refs ───────────────────────────────────────────────────────────────
const selClient   = () => document.getElementById("rSelClient");
const selMode     = () => document.getElementById("rSelMode");
const inpDate     = () => document.getElementById("rInpDate");
const inpStart    = () => document.getElementById("rInpStart");
const inpEnd      = () => document.getElementById("rInpEnd");
const selLimit    = () => document.getElementById("rSelLimit");
const selRankBy   = () => document.getElementById("rSelRankBy");
const grpDate     = () => document.getElementById("rGrpDate");
const grpRange    = () => document.getElementById("rGrpRange");
const grpRangeEnd = () => document.getElementById("rGrpRangeEnd");

// ── Helpers ────────────────────────────────────────────────────────────────
function fmt(n) { return (n ?? 0).toLocaleString(); }
function fmtMaybe(n) { return n === null || n === undefined ? "—" : fmt(n); }

function renderShareBar(pct) {
  const w = Math.min(Math.max(pct || 0, 0), 100);
  return `<span class="reports-share-bar"><span class="reports-share-bar__fill" style="width:${w}%"></span></span> ${pct}%`;
}

function renderReplenishmentDelta(value) {
  if (value === null || value === undefined) return "—";
  if (value > 0) return `<span class="reports-delta reports-delta--good">${fmt(value)} fewer</span>`;
  if (value < 0) return `<span class="reports-delta reports-delta--bad">${fmt(Math.abs(value))} more</span>`;
  return `<span class="reports-delta">No change</span>`;
}

function renderTable(el, cols, rows, emptyMsg) {
  if (!rows || !rows.length) {
    el.innerHTML = `<p style="padding:1rem;color:var(--color-text-secondary)">${emptyMsg || "No data."}</p>`;
    return;
  }
  const thead = cols.map(c => `<th>${c.label}</th>`).join("");
  const tbody = rows.map(row =>
    `<tr>${cols.map(c => `<td>${c.render ? c.render(row[c.key], row) : (row[c.key] ?? "—")}</td>`).join("")}</tr>`
  ).join("");
  el.innerHTML = `<div class="table-wrap"><table class="data-table"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`;
}

// ── Mode UI ────────────────────────────────────────────────────────────────
function syncModeUi() {
  const mode = selMode().value;
  grpDate().style.display     = mode === "date"   ? "" : "none";
  grpRange().style.display    = mode === "custom" ? "" : "none";
  grpRangeEnd().style.display = mode === "custom" ? "" : "none";
}

// ── Channel picker ─────────────────────────────────────────────────────────
const CLIENT_CHANNELS = {
  FANDMKET: {
    B: "Build Your Own", C: "Customer Web",   F: "Fresh only",
    H: "Hamper",         L: "Large orders",   N: "Store scan to carton",
    P: "Concierge VIP Orders", S: "Store replen", W: "Wholesale",
  },
  WESTLAND: {
    B: "Bulk Retail",    E: "External wooden products", F: "Ferts & Chems RAW MATERIAL",
    G: "Growing Media Raw Material", L: "Large Retail", R: "Retail", W: "Wholesale",
  },
};

function buildChannelPicker(client) {
  const dropdown = document.getElementById("rChannelDropdown");
  const labels   = CLIENT_CHANNELS[client] || CLIENT_CHANNELS.FANDMKET || {};
  dropdown.innerHTML = Object.entries(labels).map(([code, name]) =>
    `<label class="reports-channel-picker__option"><input type="checkbox" value="${code}" /> ${name}</label>`
  ).join("");
  dropdown.querySelectorAll("input[type=checkbox]").forEach(cb => {
    cb.addEventListener("change", () => { updateChannelLabel(); loadReports(); });
  });
  updateChannelLabel();
}

function initChannelPicker() {
  const trigger  = document.getElementById("rChannelTrigger");
  const dropdown = document.getElementById("rChannelDropdown");

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown.hidden = !dropdown.hidden;
  });
  document.addEventListener("click", () => { dropdown.hidden = true; });
  dropdown.addEventListener("click", (e) => e.stopPropagation());

  buildChannelPicker(selClient().value);
}

function getSelectedChannels() {
  return [...document.querySelectorAll("#rChannelDropdown input:checked")].map(cb => cb.value);
}

function updateChannelLabel() {
  const sel = getSelectedChannels();
  document.getElementById("rChannelTrigger").textContent = sel.length === 0 ? "All channels" : sel.join(", ");
}

// ── Query builder ──────────────────────────────────────────────────────────
function buildQuery() {
  const p = new URLSearchParams();
  p.set("client",  selClient().value);
  p.set("mode",    selMode().value);
  p.set("limit",   selLimit().value);
  p.set("rankBy",  selRankBy().value);
  if (selMode().value === "date")   p.set("date",  inpDate().value);
  if (selMode().value === "custom") { p.set("start", inpStart().value); p.set("end", inpEnd().value); }
  const ch = getSelectedChannels();
  if (ch.length) p.set("channels", ch.join(","));
  return p;
}

// ── Chip helpers ───────────────────────────────────────────────────────────
function setChip(id, text, visible) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || "";
  el.style.display = (visible === false || !text) ? "none" : "";
}

// ── Load ───────────────────────────────────────────────────────────────────
async function loadReports() {
  setChip("rChipStatus", "Loading…", true);
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

// ── Render all ─────────────────────────────────────────────────────────────
function renderAll(data) {
  const { meta, summary } = data;

  const clientLabel = selClient().options[selClient().selectedIndex]?.text || meta.client_code;
  setChip("rChipClient", clientLabel, true);

  if (meta.loaded_dates.length === 1) {
    setChip("rChipRange", meta.loaded_dates[0], true);
  } else if (meta.loaded_dates.length > 1) {
    const dates = [...meta.loaded_dates].sort();
    setChip("rChipRange", `${dates[0]} → ${dates[dates.length - 1]}`, true);
  } else {
    setChip("rChipRange", "No data", true);
  }

  setChip("rChipCoverage", meta.date_count > 1 ? `${meta.date_count} days` : "1 day", meta.date_count > 0);
  setChip("rChipQty",   `${fmt(summary.total_pick_qty)} picks`, summary.total_pick_qty > 0);
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
}

// ── Tab: Overview ──────────────────────────────────────────────────────────
function renderOverview(summary, meta) {
  const el = document.getElementById("rTab-overview");
  const cards = [
    { label: "Total Pick Qty",    value: fmt(summary.total_pick_qty),          sub: `Avg ${summary.avg_qty_per_line} per line` },
    { label: "Total Lines",       value: fmt(summary.total_line_count),         sub: `Avg ${summary.avg_lines_per_day} lines/day` },
    { label: "Orders",            value: fmt(summary.total_order_count),         sub: "" },
    { label: "Active SKUs",       value: fmt(summary.active_sku_count),          sub: "" },
    { label: "Active Locations",  value: fmt(summary.active_location_count),     sub: `${fmt(summary.active_aisle_count)} aisles` },
    { label: "Channels",          value: fmt(summary.active_channel_count),      sub: `${fmt(summary.active_item_group_count)} item groups` },
    { label: "High-Level Picks",  value: fmt(summary.high_level_pick_qty),       sub: `${summary.high_level_share}% of pick qty (level ≥ 20)` },
    { label: "Peak Day",          value: summary.peak_day_date || "—",          sub: summary.peak_day_date ? `${fmt(summary.peak_day_pick_qty)} picks` : "" },
  ];

  let html = '<div class="reports-metric-grid">' +
    cards.map(c => `
      <div class="reports-metric-card">
        <div class="reports-metric-card__label">${c.label}</div>
        <div class="reports-metric-card__value">${c.value}</div>
        ${c.sub ? `<div class="reports-metric-card__sub">${c.sub}</div>` : ""}
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

// ── Tab: Top SKUs ──────────────────────────────────────────────────────────
function renderTopSkus(topSkus, limit, highLevelSkus) {
  const el = document.getElementById("rTab-skus");
  let html = '<div class="reports-section"><div class="reports-section__title">Top ' + limit + ' SKUs</div></div>';

  const skuCols = [
    { key: "_rank",          label: "#",          render: (_, __, i) => i + 1 },
    { key: "sku",            label: "SKU" },
    { key: "pick_qty",       label: "Pick Qty",   render: v => fmt(v) },
    { key: "line_count",     label: "Lines",      render: v => fmt(v) },
    { key: "order_count",    label: "Orders",     render: v => fmt(v) },
    { key: "location_count", label: "Locations",  render: v => fmt(v) },
    { key: "share_of_picks", label: "Share",      render: v => renderShareBar(v) },
  ];

  const skuColsWithIndex = skuCols.map(c => c.key === "_rank"
    ? { ...c, render: (v, row) => (topSkus.indexOf(row) + 1) }
    : c);

  const skuTbody = topSkus.length ? topSkus.map((row, i) =>
    `<tr>${skuColsWithIndex.map(c => `<td>${c.render ? c.render(row[c.key], row, i) : (row[c.key] ?? "—")}</td>`).join("")}</tr>`
  ).join("") : `<tr><td colspan="${skuCols.length}">No data.</td></tr>`;

  html += `<div class="table-wrap"><table class="data-table"><thead><tr>${skuCols.map(c => `<th>${c.label}</th>`).join("")}</tr></thead><tbody>${skuTbody}</tbody></table></div>`;

  if (highLevelSkus && highLevelSkus.length) {
    html += '<div class="reports-section"><div class="reports-section__title">Top High-Level SKUs (level ≥ 20)</div></div>';
    const hlCols = [
      { key: "sku",                label: "SKU" },
      { key: "high_level_pick_qty",label: "High-Level Qty",  render: v => fmt(v) },
      { key: "total_pick_qty",     label: "Total Qty",       render: v => fmt(v) },
      { key: "high_level_share",   label: "HL Share",        render: v => `${v}%` },
    ];
    const hlTbody = highLevelSkus.map(row =>
      `<tr>${hlCols.map(c => `<td>${c.render ? c.render(row[c.key], row) : (row[c.key] ?? "—")}</td>`).join("")}</tr>`
    ).join("");
    html += `<div class="table-wrap"><table class="data-table"><thead><tr>${hlCols.map(c => `<th>${c.label}</th>`).join("")}</tr></thead><tbody>${hlTbody}</tbody></table></div>`;
  }

  el.innerHTML = html;
}

// ── Tab: Locations ─────────────────────────────────────────────────────────
function renderLocations(topLocations) {
  const el = document.getElementById("rTab-locations");
  el.innerHTML = '<div class="reports-section"><div class="reports-section__title">Top 100 Locations</div></div>';
  const cols = [
    { key: "location",       label: "Location" },
    { key: "aisle_prefix",   label: "Aisle" },
    { key: "level",          label: "Level" },
    { key: "operating_area", label: "Area" },
    { key: "bin_size",       label: "Bin Size" },
    { key: "bin_type",       label: "Bin Type" },
    { key: "max_bin_qty",    label: "Max Qty",  render: v => v ? fmt(v) : "—" },
    { key: "pick_qty",       label: "Pick Qty", render: v => fmt(v) },
    { key: "line_count",     label: "Lines",    render: v => fmt(v) },
    { key: "sku_count",      label: "SKUs",     render: v => fmt(v) },
  ];
  renderTable(el.appendChild(document.createElement("div")), cols, topLocations);
}

// ── Tab: Aisles ────────────────────────────────────────────────────────────
function renderAisles(topAisles) {
  const el = document.getElementById("rTab-aisles");
  el.innerHTML = '<div class="reports-section"><div class="reports-section__title">Top 50 Aisles</div></div>';
  const cols = [
    { key: "aisle_prefix",  label: "Aisle" },
    { key: "pick_qty",      label: "Pick Qty",  render: v => fmt(v) },
    { key: "line_count",    label: "Lines",     render: v => fmt(v) },
    { key: "location_count",label: "Locations", render: v => fmt(v) },
    { key: "sku_count",     label: "SKUs",      render: v => fmt(v) },
    { key: "share_of_picks",label: "Share",     render: v => renderShareBar(v) },
  ];
  renderTable(el.appendChild(document.createElement("div")), cols, topAisles);
}

// ── Tab: Structure ─────────────────────────────────────────────────────────
function renderStructure(data) {
  const el = document.getElementById("rTab-structure");
  let html = "";

  // Level breakdown
  html += '<div class="reports-section"><div class="reports-section__title">Level Breakdown</div></div>';
  const lvlCols = [
    { key: "level",          label: "Level" },
    { key: "is_high_level",  label: "High-Level", render: v => v ? "✓" : "" },
    { key: "pick_qty",       label: "Pick Qty",    render: v => fmt(v) },
    { key: "line_count",     label: "Lines",       render: v => fmt(v) },
    { key: "location_count", label: "Locations",   render: v => fmt(v) },
    { key: "sku_count",      label: "SKUs",        render: v => fmt(v) },
    { key: "share_of_picks", label: "Share",       render: v => renderShareBar(v) },
  ];
  html += _miniTable(lvlCols, data.level_breakdown);

  // Bin Size breakdown
  html += '<div class="reports-section"><div class="reports-section__title">Bin Size Breakdown</div></div>';
  const bsCols = [
    { key: "bin_size",       label: "Bin Size" },
    { key: "pick_qty",       label: "Pick Qty",  render: v => fmt(v) },
    { key: "line_count",     label: "Lines",     render: v => fmt(v) },
    { key: "location_count", label: "Locations", render: v => fmt(v) },
    { key: "share_of_picks", label: "Share",     render: v => renderShareBar(v) },
  ];
  html += _miniTable(bsCols, data.bin_size_breakdown);

  // Bin Type breakdown
  html += '<div class="reports-section"><div class="reports-section__title">Bin Type Breakdown</div></div>';
  const btCols = [
    { key: "bin_type",       label: "Bin Type" },
    { key: "pick_qty",       label: "Pick Qty",  render: v => fmt(v) },
    { key: "line_count",     label: "Lines",     render: v => fmt(v) },
    { key: "location_count", label: "Locations", render: v => fmt(v) },
    { key: "share_of_picks", label: "Share",     render: v => renderShareBar(v) },
  ];
  html += _miniTable(btCols, data.bin_type_breakdown);

  // Operating Area breakdown
  html += '<div class="reports-section"><div class="reports-section__title">Operating Area Breakdown</div></div>';
  const oaCols = [
    { key: "operating_area", label: "Area" },
    { key: "pick_qty",       label: "Pick Qty",  render: v => fmt(v) },
    { key: "line_count",     label: "Lines",     render: v => fmt(v) },
    { key: "location_count", label: "Locations", render: v => fmt(v) },
    { key: "sku_count",      label: "SKUs",      render: v => fmt(v) },
    { key: "share_of_picks", label: "Share",     render: v => renderShareBar(v) },
  ];
  html += _miniTable(oaCols, data.operating_area_breakdown);

  // Item Group breakdown
  html += '<div class="reports-section"><div class="reports-section__title">Item Group Breakdown</div></div>';
  const igCols = [
    { key: "item_group",    label: "Item Group" },
    { key: "pick_qty",      label: "Pick Qty",  render: v => fmt(v) },
    { key: "line_count",    label: "Lines",     render: v => fmt(v) },
    { key: "order_count",   label: "Orders",    render: v => fmt(v) },
    { key: "sku_count",     label: "SKUs",      render: v => fmt(v) },
    { key: "share_of_picks",label: "Share",     render: v => renderShareBar(v) },
  ];
  html += _miniTable(igCols, data.item_group_breakdown);

  el.innerHTML = html;
}

function _miniTable(cols, rows) {
  if (!rows || !rows.length) return `<p style="padding:.5rem 1rem;color:var(--color-text-secondary)">No data.</p>`;
  const thead = cols.map(c => `<th>${c.label}</th>`).join("");
  const tbody = rows.map(row =>
    `<tr>${cols.map(c => `<td>${c.render ? c.render(row[c.key], row) : (row[c.key] ?? "—")}</td>`).join("")}</tr>`
  ).join("");
  return `<div class="table-wrap"><table class="data-table"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`;
}

// ── Tab: Channels ──────────────────────────────────────────────────────────
function renderChannels(channelBreakdown) {
  const el = document.getElementById("rTab-channels");
  el.innerHTML = '<div class="reports-section"><div class="reports-section__title">Channel Breakdown</div></div>';
  const cols = [
    { key: "channel",       label: "Code" },
    { key: "label",         label: "Channel" },
    { key: "pick_qty",      label: "Pick Qty",  render: v => fmt(v) },
    { key: "line_count",    label: "Lines",     render: v => fmt(v) },
    { key: "order_count",   label: "Orders",    render: v => fmt(v) },
    { key: "sku_count",     label: "SKUs",      render: v => fmt(v) },
    { key: "share_of_picks",label: "Share",     render: v => renderShareBar(v) },
  ];
  renderTable(el.appendChild(document.createElement("div")), cols, channelBreakdown);
}

// ── Tab: Replenishment ─────────────────────────────────────────────────────
function renderReplenishment(replenishment) {
  const el = document.getElementById("rTab-replenishment");
  const note = replenishment?.note || "";
  let html = `<div class="reports-section"><div class="reports-section__title">Low-Level Replenishment Estimates (level &lt; 20)</div></div>`;
  if (note) {
    html += `<div class="reports-binloc-notice">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      ${note}
    </div>`;
  }
  el.innerHTML = html;

  const cols = [
    { key: "location",               label: "Location" },
    { key: "aisle_prefix",           label: "Aisle" },
    { key: "level",                  label: "Level" },
    { key: "operating_area",         label: "Area" },
    { key: "bin_size",               label: "Bin Size" },
    { key: "bin_type",               label: "Bin Type" },
    { key: "pick_qty",               label: "Pick Qty",     render: v => fmt(v) },
    { key: "max_bin_qty",            label: "Max Bin Qty",  render: v => v ? fmt(v) : "—" },
    { key: "estimated_replenishments", label: "Est. Replens", render: v => v != null ? fmt(v) : "—" },
  ];
  renderTable(el.appendChild(document.createElement("div")), cols, replenishment?.locations || []);
}

// ── Tab: Daily ─────────────────────────────────────────────────────────────
function renderPcZone(pcZone, meta) {
  const el = document.getElementById("rTab-pc-zone");
  const summary = pcZone?.summary || {};
  const note = pcZone?.note || "";
  const pcPct = Math.min(Math.max(Number(summary.pc_pick_share || 0), 0), 100);

  let html = '<div class="reports-section"><div class="reports-section__title">PC Zone Mix</div></div>';

  if (note) {
    html += `<div class="reports-binloc-notice">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      ${note}
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
              <div><strong>PC areas</strong><span>${fmt(summary.pc_pick_qty)} units · ${fmt(summary.pc_line_count)} lines</span></div>
            </div>
            <div class="reports-pc-zone-legend__item">
              <span class="reports-pc-zone-legend__swatch reports-pc-zone-legend__swatch--nonpc"></span>
              <div><strong>Outside PC</strong><span>${fmt(summary.non_pc_pick_qty)} units · ${fmt(summary.non_pc_line_count)} lines</span></div>
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
    <div id="rPcTopSkus"></div>
    <div class="reports-section"><div class="reports-section__title">Top SKUs Not Currently Picked From PC</div></div>
    <div id="rPcTopNonPc"></div>
  `;

  el.innerHTML = html;

  const currentPcCols = [
    { key: "sku",                                label: "SKU" },
    { key: "pc_pick_qty",                        label: "PC Qty",              render: v => fmt(v) },
    { key: "total_pick_qty",                     label: "Total Qty",           render: v => fmt(v) },
    { key: "pc_share_of_sku",                    label: "PC Share",            render: v => `${v}%` },
    { key: "pc_order_count",                     label: "PC Orders",           render: v => fmt(v) },
    { key: "current_non_pc_replenishments",      label: "Current Replens",     render: v => fmtMaybe(v) },
    { key: "low_level_non_pc_capacity",          label: "Non-PC Cap <20",      render: v => fmtMaybe(v) },
    { key: "extra_replenishments_if_pc_removed", label: "Extra Replens No PC", render: v => fmtMaybe(v) },
    { key: "total_replenishments_without_pc",    label: "Total Replens No PC", render: v => fmtMaybe(v) },
  ];

  const candidateCols = [
    { key: "sku",                              label: "SKU" },
    { key: "total_pick_qty",                   label: "Total Qty",          render: v => fmt(v) },
    { key: "order_count",                      label: "Orders",             render: v => fmt(v) },
    { key: "share_of_total_picks",             label: "Share",              render: v => renderShareBar(v) },
    { key: "low_level_non_pc_capacity",        label: "Current Cap <20",    render: v => fmtMaybe(v) },
    { key: "current_estimated_replenishments", label: "Current Replens",    render: v => fmtMaybe(v) },
    { key: "estimated_replenishments_in_pc",   label: "Est. Replens In PC", render: v => fmtMaybe(v) },
    { key: "estimated_replenishments_delta",   label: "PC Impact",          render: v => renderReplenishmentDelta(v) },
  ];

  renderTable(
    document.getElementById("rPcTopSkus"),
    currentPcCols,
    pcZone?.top_pc_skus || [],
    "No picks were taken from PC locations for the current filters."
  );

  renderTable(
    document.getElementById("rPcTopNonPc"),
    candidateCols,
    pcZone?.top_non_pc_skus || [],
    meta?.binloc_available
      ? "No high-volume non-PC SKUs were found for the current filters."
      : "BINLOC data is required to estimate PC candidates."
  );
}

function renderDaily(dailyBreakdown) {
  const el = document.getElementById("rTab-daily");
  el.innerHTML = '<div class="reports-section"><div class="reports-section__title">Daily Breakdown</div></div>';
  const cols = [
    { key: "date",       label: "Date" },
    { key: "pick_qty",   label: "Pick Qty",  render: v => fmt(v) },
    { key: "line_count", label: "Lines",     render: v => fmt(v) },
    { key: "order_count",label: "Orders",    render: v => fmt(v) },
    { key: "sku_count",  label: "SKUs",      render: v => fmt(v) },
  ];
  renderTable(el.appendChild(document.createElement("div")), cols, dailyBreakdown);
}

// ── Tab switching ──────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll(".reports-tab-btn").forEach(b => b.classList.toggle("reports-tab-btn--active", b.dataset.tab === name));
  document.querySelectorAll(".reports-tab-content").forEach(el => {
    el.classList.toggle("reports-tab-content--active", el.id === `rTab-${name}`);
  });
}

// ── Init ───────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  syncModeUi();
  initChannelPicker();

  selMode().addEventListener("change", syncModeUi);
  selClient().addEventListener("change", () => { buildChannelPicker(selClient().value); loadReports(); });
  document.getElementById("rBtnLoad").addEventListener("click", loadReports);
  document.getElementById("rTabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".reports-tab-btn");
    if (btn) switchTab(btn.dataset.tab);
  });

  loadReports();
});
