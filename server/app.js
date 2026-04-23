"use strict";
const path    = require("path");
const fs      = require("fs");
const XLSX    = require("xlsx");
const ExcelJS = require("exceljs");
const express = require("express");
const session = require("express-session");
const { config }          = require("./config");
const { formatDateYMD }   = require("./helpers");
const { SnapshotService } = require("./snapshotService");
const { EmptyBinTaskStore, normalizeLocation: normalizeEmptyBinLocation } = require("./emptyBinStore");

// ── Layout files (itemtracker data dir) ──────────────────────────────────────
const ITEMTRACKER_DATA = path.join(__dirname, "..", "..", "itemtracker", "server", "data");

function loadJsonFile(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

const FANDM_LAYOUT_PATH      = path.join(ITEMTRACKER_DATA, "fandm-layout-v4.7.json");
const LAYOUT_OVERRIDES_PATH  = path.join(ITEMTRACKER_DATA, "layout-overrides.json");
const FANDM_LAYOUT           = loadJsonFile(FANDM_LAYOUT_PATH);
let LAYOUT_OVERRIDES         = loadJsonFile(LAYOUT_OVERRIDES_PATH) || {};
const ASSET_VERSION          = String(Date.now());

const DEFAULT_BIN_SIZES = {
  F2: { height: 310,  width: 650,  depth: 600  },
  F4: { height: 310,  width: 325,  depth: 600  },
  F8: { height: 310,  width: 160,  depth: 300  },
  CG: { height: 1650, width: 1200, depth: 1000 },
  CF: { height: 2200, width: 1200, depth: 1000 },
  CP: { height: 800,  width: 425,  depth: 900  },
  CU: { height: 350,  width: 433,  depth: 900  },
  CL: { height: 350,  width: 1200, depth: 900  },
  CB: { height: 1150, width: 1200, depth: 1000 },
  CR: { height: 510,  width: 675,  depth: 900  },
};

const EMPTY_BIN_CLIENT_CODE = "FANDMKET";

// ── Heatmap helpers ───────────────────────────────────────────────────────────

// Mirrors itemtracker's parseHeatmapLocation — 2-char prefix, 2-digit bay, 2-digit level, 2-digit slot
function parseLocationCode(locationCode) {
  const text   = String(locationCode || "").trim().toUpperCase();
  const digits = text.slice(2).replace(/\D+/g, "");
  return {
    aisle_prefix: text.slice(0, 2),
    bay:          digits.slice(0, 2),
    level:        digits.slice(2, 4),
    slot:         digits.slice(4, 6),
  };
}

function buildZoneIndex(layout) {
  const map = new Map(); // aisle_prefix → zone_key
  for (const zone of (layout?.zones || [])) {
    for (const aisle of (zone.aisles || [])) {
      if (aisle.prefix) map.set(aisle.prefix, zone.zone_key || "");
    }
  }
  return map;
}

function normalizeBinType(raw) {
  const v = String(raw || "").trim().toUpperCase();
  if (v === "P" || v === "PICK" || v.startsWith("PICK")) return "Pick";
  if (v === "B" || v === "BULK" || v.startsWith("BULK")) return "Bulk";
  return "Unknown";
}

function normalizeClientCode(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeBinSizeCode(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeDimensionNumber(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function normalizeBinSizeDimensions(value) {
  if (!value || typeof value !== "object") return null;
  const height = normalizeDimensionNumber(value.height ?? value.height_mm ?? value.h);
  const width  = normalizeDimensionNumber(value.width  ?? value.width_mm  ?? value.w);
  const depth  = normalizeDimensionNumber(value.depth  ?? value.depth_mm  ?? value.d);
  if (!(height > 0) || !(width > 0) || !(depth > 0)) return null;
  return { height, width, depth };
}

function binSizeVolume(dimensions) {
  const dims = normalizeBinSizeDimensions(dimensions);
  return dims ? dims.height * dims.width * dims.depth : 0;
}

function usableBinVolume(dimensions) {
  const volume = binSizeVolume(dimensions);
  return volume > 0 ? Math.round(volume * 0.8) : 0;
}

function getConfiguredBinSizes() {
  const merged = { ...DEFAULT_BIN_SIZES, ...(LAYOUT_OVERRIDES?.bin_sizes || {}) };
  const out = {};
  for (const [rawCode, rawDims] of Object.entries(merged)) {
    const code = normalizeBinSizeCode(rawCode);
    const dims = normalizeBinSizeDimensions(rawDims);
    if (code && dims) out[code] = dims;
  }
  return out;
}

function saveConfiguredBinSize(code, dimensions) {
  const binSizeCode = normalizeBinSizeCode(code);
  const dims = normalizeBinSizeDimensions(dimensions);
  if (!binSizeCode || !dims) return null;

  const latestOverrides = loadJsonFile(LAYOUT_OVERRIDES_PATH) || {};
  const nextOverrides = {
    ...latestOverrides,
    bin_sizes: {
      ...(latestOverrides.bin_sizes && typeof latestOverrides.bin_sizes === "object" ? latestOverrides.bin_sizes : {}),
      [binSizeCode]: dims,
    },
  };

  fs.mkdirSync(path.dirname(LAYOUT_OVERRIDES_PATH), { recursive: true });
  fs.writeFileSync(LAYOUT_OVERRIDES_PATH, JSON.stringify(nextOverrides, null, 2), "utf8");
  LAYOUT_OVERRIDES = nextOverrides;
  return dims;
}

function getCatalogItemDimensions(row) {
  const dims = normalizeBinSizeDimensions({
    height: row?.ITDHGT ?? row?.itdhgt ?? row?.height ?? row?.height_mm ?? row?.item_height_mm,
    width:  row?.ITDWTH ?? row?.itdwth ?? row?.width  ?? row?.width_mm  ?? row?.item_width_mm,
    depth:  row?.ITDDTH ?? row?.itddth ?? row?.depth  ?? row?.depth_mm  ?? row?.item_depth_mm,
  });
  return dims;
}

function buildCatalogDimensionMap(snapshot) {
  const map = new Map();
  for (const row of (snapshot?.items || [])) {
    const sku = String(row?.sku || row?.ITITEM || row?.ititem || "").trim().toUpperCase();
    const dims = getCatalogItemDimensions(row);
    if (sku && dims) map.set(sku, dims);
  }
  return map;
}

function getCatalogItemDescription(row) {
  return String(
    row?.description ||
    row?.description_short ||
    row?.item_description ||
    row?.ITDESC ||
    row?.itdesc ||
    row?.IDESC ||
    row?.idesc ||
    ""
  ).trim();
}

function buildCatalogItemMetaMap(snapshot) {
  const map = new Map();
  for (const row of (snapshot?.items || [])) {
    const sku = String(row?.sku || row?.ITITEM || row?.ititem || "").trim().toUpperCase();
    if (!sku) continue;
    const description = getCatalogItemDescription(row);
    map.set(sku, {
      sku,
      description,
      sku_label: description ? `${sku} - ${description}` : sku,
    });
  }
  return map;
}

function getBinlocLocation(row) {
  return String(row?.BLBINL || row?.bin_location || row?.location || "").trim().toUpperCase();
}

function getBinlocBinSize(row) {
  return normalizeBinSizeCode(row?.BLSCOD || row?.bin_size || row?.bin_size_code || "");
}

function getBinlocRowClientCode(row) {
  return normalizeClientCode(row?.BLCCOD || row?.client_code || row?.Client);
}

function defaultEmptyBinReportDate() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return formatDateYMD(date);
}

function normalizeReportDate(value, fallback = defaultEmptyBinReportDate()) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  const parsed = text ? new Date(text) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) return formatDateYMD(parsed);
  return fallback;
}

function reportDateToCompact(value) {
  return normalizeReportDate(value).replace(/-/g, "");
}

function normalizeCompactDate(value) {
  const text = String(value || "").trim();
  if (!text || text === "0" || text === "00000000") return "";
  if (/^\d{8}$/.test(text)) return text;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text.replace(/-/g, "");
  return "";
}

function compactDateToReportDate(value) {
  const compact = normalizeCompactDate(value);
  return compact ? `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}` : "";
}

function getBinlocCurrentQty(row) {
  return Number(row?.BLQTY || row?.qty || row?.["Item Qty"] || 0);
}

function getBinlocAvailableQty(row) {
  return Number(row?.CALCQTY || row?.available_qty || row?.["Available Qty"] || 0);
}

function isActiveBinlocRow(row) {
  const status = String(row?.BLSTS || row?.status || row?.Status || "Y").trim().toUpperCase();
  return status === "Y";
}

function isEmptyBinlocRow(row) {
  if (!isActiveBinlocRow(row)) return false;
  const currentQty = Number(row?.BLQTY || row?.qty || row?.["Item Qty"] || 0);
  return currentQty <= 0;
}

function getBinlocItemSku(row) {
  return String(row?.BLITEM || row?.sku || row?.["Item SKU"] || "").trim().toUpperCase();
}

function getBinlocItemDescription(row) {
  return String(row?.ITDSC1 || row?.["Item Description"] || row?.item_description || "").trim();
}

function getBinlocLastMoveOutDate(row) {
  return compactDateToReportDate(row?.BLMDTO || row?.last_move_out_date || row?.["Last Move Date Out"]);
}

function getBinlocLastMoveInDate(row) {
  return compactDateToReportDate(row?.BLMDTI || row?.last_move_in_date || row?.["Last Move Date In"]);
}

function serializeEmptyBinLocation(row, extras = {}) {
  const location = getBinlocLocation(row);
  const parts = parseLocationCode(location);
  const levelNum = getLocationLevelNumber(location);
  return {
    location,
    aisle_prefix: parts.aisle_prefix,
    bay: parts.bay,
    level: parts.level,
    level_num: levelNum,
    operating_area: normalizeOperatingArea(row.BLWOPA || row.operating_area || row["Op. Area"]),
    bin_size: getBinlocBinSize(row),
    bin_type: normalizeBinType(row.BLBKPK || row.bin_type || row["Pick / Bulk"]),
    client_code: getBinlocRowClientCode(row),
    item_sku: getBinlocItemSku(row),
    item_description: getBinlocItemDescription(row),
    current_qty: getBinlocCurrentQty(row),
    available_qty: getBinlocAvailableQty(row),
    qty_under_query: Number(row.BLGQTY || row.gross_qty || row["Qty Under Query"] || 0),
    goods_in_pending: Number(row.BLPNDF || row.goods_in_pending || row["Goods In Pending"] || 0),
    pending_from: String(row.BLPNDF || row.pending_from || row["Pending From"] || "").trim(),
    pending_to: String(row.BLPNDT || row.pending_to || row["Pending To"] || "").trim(),
    max_bin_qty: Number(row.BLMAXQ || row.max_bin_qty || 0),
    checked_digit: String(row.BLCHKD || row["Check Digit"] || "").trim(),
    status: String(row.BLSTS || row.Status || "Y").trim().toUpperCase(),
    last_move_out_date: getBinlocLastMoveOutDate(row),
    last_move_in_date: getBinlocLastMoveInDate(row),
    live_empty: isEmptyBinlocRow(row),
    ...extras,
  };
}

function getTransactionLocation(row) {
  return normalizeEmptyBinLocation(row?.WTBINL || row?.BABINL || row?.bin_location || row?.location);
}

function getTransactionDate(row, fallbackDate = "") {
  const compact = normalizeCompactDate(row?.WTCDAT || row?.BTPICD || fallbackDate);
  return compact ? compactDateToReportDate(compact) : "";
}

function serializeEmptyBinTransaction(row, fallbackDate = "") {
  const location = getTransactionLocation(row);
  return {
    snapshot_date: normalizeReportDate(fallbackDate),
    transaction_date: getTransactionDate(row, fallbackDate),
    order_number: String(row?.BTORDN || row?.order_number || "").trim(),
    client_code: normalizeClientCode(row?.WTCCOD || row?.BTCCDE || row?.client_code || ""),
    shipment: String(row?.BTSHPN || row?.shipment || "").trim(),
    picker: String(row?.BTPICU || row?.WTCUSR || row?.picker || row?.user || "").trim(),
    reason: String(row?.WTREAC || row?.reason || "").trim(),
    qty: Number(row?.WTQTY || row?.BAQTY || row?.qty || 0),
    item: String(row?.WTITEM || row?.BAITEM || row?.item || row?.sku || "").trim().toUpperCase(),
    location,
  };
}

async function loadEmptyBinDayContext(client, reportDate) {
  const targetClient = normalizeClientCode(client || EMPTY_BIN_CLIENT_CODE);
  const selectedDate = normalizeReportDate(reportDate);
  const locations = new Set();
  const lastTransactions = new Map();
  let trxMeta = null;
  let trxFromCache = false;
  let trxError = "";

  try {
    const trx = await service.loadSnapshot("pick_transactions", targetClient, selectedDate, { noCache: true });
    trxMeta = trx.meta || null;
    trxFromCache = Boolean(trx.fromCache);
    for (const row of (trx.rows || [])) {
      const item = serializeEmptyBinTransaction(row, selectedDate);
      if (!item.location) continue;
      if (item.client_code && item.client_code !== targetClient) continue;
      if (item.transaction_date && item.transaction_date !== selectedDate) continue;
      locations.add(item.location);
      const existing = lastTransactions.get(item.location);
      if (!existing || String(item.order_number || "").localeCompare(String(existing.order_number || "")) >= 0) {
        lastTransactions.set(item.location, item);
      }
    }
  } catch (err) {
    trxError = String(err.message || err);
  }

  return {
    report_date: selectedDate,
    compact_date: reportDateToCompact(selectedDate),
    client: targetClient,
    transaction_locations: locations,
    last_transactions: lastTransactions,
    pick_transaction_meta: trxMeta,
    pick_transaction_from_cache: trxFromCache,
    pick_transaction_error: trxError,
  };
}

function getEmptyBinDateReason(row, dayContext) {
  if (!dayContext) return "";
  const location = getBinlocLocation(row);
  if (!location) return "";
  const lastMoveOutCompact = normalizeCompactDate(row?.BLMDTO || row?.last_move_out_date || row?.["Last Move Date Out"]);
  const matchedMoveOut = lastMoveOutCompact && lastMoveOutCompact === dayContext.compact_date;
  const matchedTransaction = dayContext.transaction_locations?.has(location);
  if (matchedMoveOut && matchedTransaction) return "move_out_and_pick_transaction";
  if (matchedMoveOut) return "last_move_out";
  if (matchedTransaction) return "pick_transaction";
  return "";
}

function buildEmptyBinFilterOptions(rows) {
  const areas = new Map();
  const binSizes = new Map();
  const binTypes = new Map();
  for (const row of (rows || [])) {
    if (row.operating_area) areas.set(row.operating_area, (areas.get(row.operating_area) || 0) + 1);
    if (row.bin_size) binSizes.set(row.bin_size, (binSizes.get(row.bin_size) || 0) + 1);
    if (row.bin_type) binTypes.set(row.bin_type, (binTypes.get(row.bin_type) || 0) + 1);
  }
  const toOptions = (map, labelKey) => [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([value, count]) => ({ [labelKey]: value, count }));
  return {
    areas: toOptions(areas, "area"),
    bin_sizes: toOptions(binSizes, "bin_size"),
    bin_types: toOptions(binTypes, "bin_type"),
  };
}

function filterEmptyBinRows(rows, query = {}, { dayContext = null, client = EMPTY_BIN_CLIENT_CODE, includeAreaFilters = true } = {}) {
  const area = normalizeOperatingArea(query.area);
  const binSize = normalizeBinSizeCode(query.bin_size || query.binSize);
  const binType = String(query.bin_type || query.binType || "").trim().toUpperCase();
  const search = String(query.search || "").trim().toUpperCase();
  const levelMax = Number.parseInt(query.level_max || query.levelMax || "19", 10);
  const hasLevelMax = Number.isFinite(levelMax);
  const targetClient = normalizeClientCode(client || query.client || EMPTY_BIN_CLIENT_CODE);

  return (rows || [])
    .filter(row => {
      const location = getBinlocLocation(row);
      if (!location || !isEmptyBinlocRow(row)) return false;
      const rowClient = getBinlocRowClientCode(row);
      if (targetClient && rowClient !== targetClient) return false;
      const dayReason = dayContext ? getEmptyBinDateReason(row, dayContext) : "";
      if (dayContext && !dayReason) return false;
      const levelNum = getLocationLevelNumber(location);
      if (hasLevelMax && levelNum > levelMax) return false;
      const serialized = serializeEmptyBinLocation(row);
      if (includeAreaFilters && area && serialized.operating_area !== area) return false;
      if (includeAreaFilters && binSize && serialized.bin_size !== binSize) return false;
      if (includeAreaFilters && binType && String(serialized.bin_type || "").toUpperCase() !== binType) return false;
      if (includeAreaFilters && search && !`${serialized.location} ${serialized.operating_area} ${serialized.bin_size} ${serialized.bin_type} ${serialized.item_sku} ${serialized.item_description}`.toUpperCase().includes(search)) return false;
      return true;
    })
    .map(row => {
      const location = getBinlocLocation(row);
      const sourceReason = dayContext ? getEmptyBinDateReason(row, dayContext) : "";
      return serializeEmptyBinLocation(row, {
        report_date: dayContext?.report_date || normalizeReportDate(query.date || query.report_date),
        source_reason: sourceReason,
        last_transaction: dayContext?.last_transactions?.get(location) || null,
      });
    })
    .sort((a, b) => a.location.localeCompare(b.location));
}

function summarizeEmptyBinTask(task) {
  const items = task?.items || [];
  const pending = items.filter(item => item.status === "pending").length;
  const systemCleared = items.filter(item => item.status === "system_cleared").length;
  const checked = items.filter(item => item.status && item.status !== "pending" && item.status !== "system_cleared").length;
  const photos = items.reduce((sum, item) => sum + ((item.photos || []).length), 0);
  return {
    id: task.id,
    client: task.client,
    type: task.type,
    title: task.title,
    status: task.status,
    assignee: task.assignee,
    source_task_id: task.source_task_id || "",
    created_at: task.created_at,
    updated_at: task.updated_at,
    completed_at: task.completed_at || "",
    total_count: items.length,
    pending_count: pending,
    checked_count: checked,
    system_cleared_count: systemCleared,
    photo_count: photos,
  };
}

async function loadEmptyBinLiveIndex(client) {
  const targetClient = normalizeClientCode(client || EMPTY_BIN_CLIENT_CODE);
  const { rows = [], meta = null, fromCache = false } = await service.loadSnapshot("binloc", targetClient, null, { noCache: true });
  const liveByLocation = new Map();
  const areas = new Map();
  const binSizes = new Map();
  const binTypes = new Map();

  for (const row of rows) {
    const location = getBinlocLocation(row);
    if (!location) continue;
    const rowClient = getBinlocRowClientCode(row);
    if (targetClient && rowClient !== targetClient) continue;
    const serialized = serializeEmptyBinLocation(row);
    liveByLocation.set(location, serialized);
    if (serialized.live_empty) {
      if (serialized.operating_area) areas.set(serialized.operating_area, (areas.get(serialized.operating_area) || 0) + 1);
      if (serialized.bin_size) binSizes.set(serialized.bin_size, (binSizes.get(serialized.bin_size) || 0) + 1);
      if (serialized.bin_type) binTypes.set(serialized.bin_type, (binTypes.get(serialized.bin_type) || 0) + 1);
    }
  }

  const toOptions = (map, labelKey) => [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([value, count]) => ({ [labelKey]: value, count }));

  return {
    rows,
    meta,
    fromCache,
    liveByLocation,
    filters: {
      areas: toOptions(areas, "area"),
      bin_sizes: toOptions(binSizes, "bin_size"),
      bin_types: toOptions(binTypes, "bin_type"),
    },
  };
}

async function findRecentLocationTransactions(client, locations, maxDates = 14) {
  const locSet = new Set([...locations].map(normalizeEmptyBinLocation).filter(Boolean));
  const found = new Map();
  if (!locSet.size) return found;
  const trxDates = (await service.listSnapshotDates("pick_transactions", client).catch(() => []))
    .filter(Boolean)
    .sort()
    .reverse();
  for (const trxDate of trxDates.slice(0, maxDates)) {
    const { rows = [] } = await service.loadSnapshot("pick_transactions", client, trxDate).catch(() => ({ rows: [] }));
    for (const row of rows) {
      const loc = getTransactionLocation(row);
      if (!locSet.has(loc) || found.has(loc)) continue;
      const tx = serializeEmptyBinTransaction(row, trxDate);
      found.set(loc, {
        ...tx,
        snapshot_date: trxDate,
      });
      if (found.size >= locSet.size) return found;
    }
  }
  return found;
}

async function refreshEmptyBinTask(taskId) {
  const task = emptyBinTaskStore.getTask(taskId);
  if (!task) return null;
  const live = await loadEmptyBinLiveIndex(task.client || DEFAULT_CLIENT);
  const updatedTask = emptyBinTaskStore.updateTask(taskId, (existingTask) => {
    for (const item of (existingTask.items || [])) {
      const current = live.liveByLocation.get(normalizeEmptyBinLocation(item.location)) || null;
      item.live = current;
      if (item.status === "pending" && (!current || !current.live_empty)) {
        item.status = "system_cleared";
        item.result = "system_cleared";
        item.system_cleared_at = new Date().toISOString();
        item.system_cleared_reason = current && (current.current_qty > 0 || current.item_sku)
          ? "BINLOC now shows stock in this location."
          : "BINLOC no longer shows this as an empty active location.";
        item.history = item.history || [];
        item.history.push({
          at: item.system_cleared_at,
          action: "system_cleared",
          reason: item.system_cleared_reason,
          live: current,
        });
      }
    }
    return existingTask;
  });
  const trxMap = await findRecentLocationTransactions(task.client || DEFAULT_CLIENT, (updatedTask.items || []).map(item => item.location), 14);
  for (const item of (updatedTask.items || [])) {
    item.last_transaction = trxMap.get(normalizeEmptyBinLocation(item.location)) || item.last_transaction || null;
  }
  return { task: updatedTask, live_meta: live.meta, live_filters: live.filters };
}

function shouldIncludeBinlocHeatmapRow(row, clientCode, pickMap) {
  const location = getBinlocLocation(row);
  if (!location) return false;
  const rowClientCode = getBinlocRowClientCode(row);
  if (rowClientCode && rowClientCode === normalizeClientCode(clientCode)) return true;
  return pickMap.has(location);
}

function buildHottestAisles(rows, topN = 10) {
  const aisleMap = new Map();
  for (const r of rows) {
    const p = r.aisle_prefix;
    if (!p) continue;
    const entry = aisleMap.get(p) || { aisle_prefix: p, pick_count: 0, location_count: 0 };
    entry.pick_count     += Number(r.pick_count || 0);
    entry.location_count += 1;
    aisleMap.set(p, entry);
  }
  return [...aisleMap.values()]
    .sort((a, b) => b.pick_count - a.pick_count)
    .slice(0, topN);
}

function normalizeOperatingArea(value) {
  return String(value || "").trim().toUpperCase();
}

function isPcOperatingArea(value) {
  const area = normalizeOperatingArea(value);
  return area === "PC" || area.startsWith("PC");
}

function getLocationLevelNumber(locationCode) {
  const parts = parseLocationCode(locationCode);
  return Number.parseInt(parts.level || "0", 10) || 0;
}

function safeCeilDiv(numerator, denominator) {
  const num = Number(numerator || 0);
  const den = Number(denominator || 0);
  if (!(num > 0) || !(den > 0)) return null;
  return Math.ceil(num / den);
}

function estimateReplenishments(demand, capacity, { zeroWhenNoDemand = false } = {}) {
  const qty = Number(demand || 0);
  const cap = Number(capacity || 0);
  if (!(cap > 0)) return null;
  if (!(qty > 0)) return zeroWhenNoDemand ? 0 : null;
  return Math.ceil(qty / cap);
}

function roundPct(part, whole) {
  const numerator = Number(part || 0);
  const denominator = Number(whole || 0);
  if (!(numerator > 0) || !(denominator > 0)) return 0;
  return Math.round((numerator / denominator) * 10000) / 100;
}

function medianNumber(values) {
  const nums = (values || []).filter(v => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!nums.length) return 0;
  const mid = Math.floor(nums.length / 2);
  if (nums.length % 2 === 1) return nums[mid];
  return Math.round(((nums[mid - 1] + nums[mid]) / 2) * 100) / 100;
}

function ymdToUtcDate(value) {
  const text = String(value || "").slice(0, 10);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function utcDateToYMD(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + Number(days || 0));
  return next;
}

function betaPeriodInfo(dateText, compareBy = "week") {
  const date = ymdToUtcDate(dateText);
  if (!date) return { key: String(dateText || ""), label: String(dateText || ""), start: String(dateText || ""), end: String(dateText || "") };

  if (compareBy === "month") {
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    return { key, label: key, start: `${key}-01`, end: utcDateToYMD(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0))) };
  }

  const mondayOffset = (date.getUTCDay() + 6) % 7;
  const start = addUtcDays(date, -mondayOffset);
  const end = addUtcDays(start, 6);
  return {
    key: utcDateToYMD(start),
    label: `${utcDateToYMD(start)} to ${utcDateToYMD(end)}`,
    start: utcDateToYMD(start),
    end: utcDateToYMD(end),
  };
}

function buildBetaPeriods(loadedDates, compareBy = "week") {
  const map = new Map();
  for (const dateText of (loadedDates || [])) {
    const info = betaPeriodInfo(dateText, compareBy);
    if (!info.key) continue;
    const entry = map.get(info.key) || { ...info, dates: [] };
    entry.dates.push(dateText);
    map.set(info.key, entry);
  }
  return [...map.values()]
    .map(period => ({ ...period, dates: [...new Set(period.dates)].sort() }))
    .sort((a, b) => String(a.start || a.key).localeCompare(String(b.start || b.key)));
}

function meanNumber(values) {
  const nums = (values || []).map(Number).filter(Number.isFinite);
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : 0;
}

function standardDeviation(values) {
  const nums = (values || []).map(Number).filter(Number.isFinite);
  if (!nums.length) return 0;
  const avg = meanNumber(nums);
  const variance = nums.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / nums.length;
  return Math.sqrt(variance);
}

function roundNumber(value, decimals = 2) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return 0;
  const factor = 10 ** decimals;
  return Math.round(num * factor) / factor;
}

function yesterdayYMD() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return formatDateYMD(date);
}

function filterCompleteSnapshotDates(availableDates) {
  const cutoff = yesterdayYMD();
  return (availableDates || []).filter(date => String(date || "").trim() && String(date) <= cutoff);
}

function parseYMDDate(text) {
  const value = String(text || "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, m, d] = match;
  return new Date(Number(y), Number(m) - 1, Number(d));
}

function shiftYMD(text, { days = 0, months = 0 } = {}) {
  const date = parseYMDDate(text);
  if (!date) return "";

  if (months) {
    const targetDay = date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() + months);
    const monthEnd = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    date.setDate(Math.min(targetDay, monthEnd));
  }

  if (days) {
    date.setDate(date.getDate() + days);
  }

  return formatDateYMD(date);
}

function resolveSnapshotWindowDates(availableDates, mode, date, start, end, maxDays = 90) {
  const completedDates = filterCompleteSnapshotDates(availableDates);
  const latestDate = completedDates[0] || null;

  if (mode === "custom" && start && end) {
    const s = start < end ? start : end;
    const e = start < end ? end   : start;
    return completedDates.filter(d => d >= s && d <= e).slice(0, maxDays);
  }

  if (mode === "date" && date) {
    return completedDates.includes(date) ? [date] : [];
  }

  const presetOffsets = {
    last_week:      { days: -6 },
    last_2_weeks:   { days: -13 },
    last_month:     { months: -1, days: 1 },
    last_3_months:  { months: -3, days: 1 },
    last_6_months:  { months: -6, days: 1 },
    last_12_months: { months: -12, days: 1 },
  };

  if (latestDate && Object.prototype.hasOwnProperty.call(presetOffsets, mode)) {
    const startDate = shiftYMD(latestDate, presetOffsets[mode]);
    return completedDates.filter(d => d >= startDate && d <= latestDate).slice(0, maxDays);
  }

  return latestDate ? [latestDate] : [];
}

function buildOrderItemKey(orderNumber, item) {
  return `${String(orderNumber || "").trim()}::${String(item || "").trim().toUpperCase()}`;
}

function buildOrderItemLocationKey(orderNumber, item, location) {
  return `${buildOrderItemKey(orderNumber, item)}::${String(location || "").trim().toUpperCase()}`;
}

function normalizeOrderLineForReport(row, snapshotDate) {
  const location = String(row?.picking_location || "").trim().toUpperCase();
  const parts = parseLocationCode(location);
  return {
    ...row,
    snapshot_date:     snapshotDate,
    order_number:      String(row?.order_number || "").trim(),
    order_line:        row?.order_line ?? "",
    item:              String(row?.item || "").trim().toUpperCase(),
    fulfilment_date:   String(row?.fulfilment_date || "").trim() || String(snapshotDate || "").replace(/-/g, ""),
    qty_fulfilled:     Number(row?.qty_fulfilled || 0),
    item_group:        String(row?.item_group || "").trim(),
    order_channel:     String(row?.order_channel || "").trim().toUpperCase(),
    customer_name:     String(row?.customer_name || "").trim(),
    picking_location:  location,
    pick_qty:          Number(row?.pick_qty || row?.qty_fulfilled || 0),
    level:             String(row?.level || parts.level || "").trim(),
  };
}

function mergeReportContext(target, source) {
  if (!source) return target;
  for (const key of ["order_line", "fulfilment_date", "item_group", "order_channel", "customer_name", "picking_location", "level"]) {
    if ((target[key] === undefined || target[key] === null || target[key] === "") && source[key] !== undefined && source[key] !== null && source[key] !== "") {
      target[key] = source[key];
    }
  }
  if (!(Number(target.qty_fulfilled) > 0) && Number(source.qty_fulfilled) > 0) {
    target.qty_fulfilled = Number(source.qty_fulfilled || 0);
  }
  return target;
}

function buildReportOrderLineContext(orderRows, snapshotDate) {
  const byOrderItem = new Map();
  const byOrderItemLocation = new Map();
  const allocationRows = new Map();
  const itemGroupBySku = new Map();

  for (const rawRow of (orderRows || [])) {
    const row = normalizeOrderLineForReport(rawRow, snapshotDate);
    if (!row.order_number || !row.item) continue;
    if (row.item_group && !itemGroupBySku.has(row.item)) itemGroupBySku.set(row.item, row.item_group);

    const orderItemKey = buildOrderItemKey(row.order_number, row.item);
    const locationKey  = buildOrderItemLocationKey(row.order_number, row.item, row.picking_location);

    if (!byOrderItem.has(orderItemKey)) byOrderItem.set(orderItemKey, { ...row });
    else mergeReportContext(byOrderItem.get(orderItemKey), row);

    if (!byOrderItemLocation.has(locationKey)) byOrderItemLocation.set(locationKey, { ...row });
    else mergeReportContext(byOrderItemLocation.get(locationKey), row);

    if (!allocationRows.has(locationKey)) allocationRows.set(locationKey, { ...row });
  }

  return { byOrderItem, byOrderItemLocation, allocationRows, itemGroupBySku };
}

function buildReportActivityRows(orderRows, transactionRows, snapshotDate, { useTransactions = false } = {}) {
  const context = buildReportOrderLineContext(orderRows, snapshotDate);

  if (!useTransactions) {
    return [...context.allocationRows.values()];
  }

  const transactionMap = new Map();
  for (const tx of (transactionRows || [])) {
    const orderNumber = String(tx?.BTORDN || "").trim();
    const item        = String(tx?.BAITEM || "").trim().toUpperCase();
    const location    = String(tx?.BABINL || "").trim().toUpperCase();
    if (!orderNumber || !item) continue;

    const key = buildOrderItemLocationKey(orderNumber, item, location);
    const entry = transactionMap.get(key) || {
      order_number: orderNumber,
      item,
      picking_location: location,
      pick_qty: 0,
    };
    entry.pick_qty += Number(tx?.BAQTY || 0);
    transactionMap.set(key, entry);
  }

  const rows = [];
  for (const entry of transactionMap.values()) {
    const orderItemKey = buildOrderItemKey(entry.order_number, entry.item);
    const locationKey  = buildOrderItemLocationKey(entry.order_number, entry.item, entry.picking_location);
    const rowContext   = context.byOrderItemLocation.get(locationKey) || context.byOrderItem.get(orderItemKey) || {};
    const parts        = parseLocationCode(entry.picking_location);
    const itemGroup    = String(rowContext.item_group || context.itemGroupBySku.get(entry.item) || "").trim();

    rows.push({
      ...rowContext,
      snapshot_date:     snapshotDate,
      order_number:      entry.order_number,
      item:              entry.item,
      fulfilment_date:   rowContext.fulfilment_date || String(snapshotDate || "").replace(/-/g, ""),
      qty_fulfilled:     Number(rowContext.qty_fulfilled || 0),
      item_group:        itemGroup,
      order_channel:     String(rowContext.order_channel || "").trim().toUpperCase(),
      customer_name:     String(rowContext.customer_name || "").trim(),
      picking_location:  entry.picking_location,
      pick_qty:          entry.pick_qty,
      level:             String(rowContext.level || parts.level || "").trim(),
    });
  }

  return rows;
}

const CLIENT_CHOICES = [
  { code: "FANDMKET", name: "Fortnum & Mason" },
  { code: "WESTLAND",  name: "Westland" },
];

const DEFAULT_CLIENT = "FANDMKET";

const CHANNEL_LABELS = {
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

const HIGH_LEVEL_THRESHOLD = 20;
const PC_ZONE_CHANNELS = new Set(["C", "S"]);

// ── Service singleton ─────────────────────────────────────────────────────
const service = new SnapshotService({
  pocketbaseUrl:  config.pocketbaseUrl,
  adminEmail:     config.pocketbaseAdminEmail,
  adminPassword:  config.pocketbaseAdminPassword,
});
const emptyBinTaskStore = new EmptyBinTaskStore({
  dataDir: path.join(__dirname, "data"),
});

// ── Express app ───────────────────────────────────────────────────────────
const app = express();

if (config.trustProxy) app.set("trust proxy", 1);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));

app.use(express.urlencoded({ extended: false, limit: "25mb" }));
app.use(express.json({ limit: "25mb" }));

app.use(
  session({
    name:   "repo-app.sid",
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly:  true,
      sameSite:  config.sessionCookieSameSite,
      secure:    config.sessionCookieSecure,
      maxAge:    14 * 24 * 60 * 60 * 1000, // 14 days
    },
  })
);

app.use(express.static(path.join(__dirname, "..", "static")));
app.use("/vendor/three", express.static(path.join(__dirname, "..", "node_modules", "three")));

// ── Per-request user hydration ────────────────────────────────────────────
app.use(async (req, res, next) => {
  res.locals.appName    = config.appName;
  res.locals.assetVersion = ASSET_VERSION;
  res.locals.currentUser = null;
  const userId = req.session && req.session.userId;
  if (userId) {
    try {
      const user = await service.getUser(userId);
      req.currentUser = user;
      res.locals.currentUser = user;
    } catch {
      req.session.destroy(() => {});
    }
  }
  next();
});

// ── Flash helpers ─────────────────────────────────────────────────────────
function setFlash(req, type, message) {
  if (!req.session) return;
  req.session.flash = { type, message };
}

function getFlash(req) {
  if (!req.session || !req.session.flash) return null;
  const f = req.session.flash;
  delete req.session.flash;
  return f;
}

// ── Auth middleware ───────────────────────────────────────────────────────
function requireAdminPage(req, res, next) {
  if (!req.currentUser) return res.redirect("/login");
  if (!req.currentUser.isAdmin) {
    setFlash(req, "error", "Admin access required.");
    return res.redirect("/login");
  }
  next();
}

function requireAdminApi(req, res, next) {
  if (!req.currentUser) return res.status(401).json({ ok: false, error: "Unauthenticated." });
  if (!req.currentUser.isAdmin) return res.status(403).json({ ok: false, error: "Admin access required." });
  next();
}

// ── Helpers ───────────────────────────────────────────────────────────────
function clientChoicesWithSelected(req) {
  const selected = req.query.client || DEFAULT_CLIENT;
  return { clientChoices: CLIENT_CHOICES, selectedClient: selected };
}

// ── Routes ────────────────────────────────────────────────────────────────

// Health
app.get("/health", (_req, res) => {
  res.json({ ok: true, app: config.appName });
});

// Root
app.get("/", (req, res) => {
  if (req.currentUser && req.currentUser.isAdmin) return res.redirect("/heatmap");
  res.redirect("/login");
});

// Login GET
app.get("/login", (req, res) => {
  if (req.currentUser && req.currentUser.isAdmin) return res.redirect("/heatmap");
  const flash = getFlash(req);
  res.render("login", { flash });
});

// Login POST
app.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    setFlash(req, "error", "Email and password are required.");
    return res.redirect("/login");
  }
  try {
    const user = await service.authenticateUser(String(email).trim(), String(password));
    if (!user.isAdmin) {
      setFlash(req, "error", "This site is restricted to admin users only.");
      return res.redirect("/login");
    }
    req.session.userId = user.id;
    return res.redirect("/heatmap");
  } catch (err) {
    const message =
      err && String(err.message || "").toLowerCase().includes("invalid")
        ? "Invalid email or password."
        : "Login failed. Please try again.";
    setFlash(req, "error", message);
    return res.redirect("/login");
  }
});

// Logout
app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// Heatmap page
app.get("/heatmap", requireAdminPage, (req, res) => {
  const { clientChoices, selectedClient } = clientChoicesWithSelected(req);
  res.render("heatmap", { clientChoices, selectedClient });
});

// Order Lines page
app.get("/order-lines", requireAdminPage, (req, res) => {
  const { clientChoices, selectedClient } = clientChoicesWithSelected(req);
  res.render("order-lines", { clientChoices, selectedClient });
});

// ── API: snapshot dates ───────────────────────────────────────────────────
app.get("/api/snapshot-dates", requireAdminApi, async (req, res) => {
  const { client, collection } = req.query;
  if (!client || !collection) {
    return res.status(400).json({ ok: false, error: "client and collection params required." });
  }
  try {
    const dates = filterCompleteSnapshotDates(await service.listSnapshotDates(collection, client));
    return res.json({ ok: true, dates });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ── API: heatmap data (3D) ────────────────────────────────────────────────
app.get("/api/heatmap-data", requireAdminApi, async (req, res) => {
  const { client, mode, date } = req.query;
  if (!client) return res.status(400).json({ ok: false, error: "client param required." });
  try {
    // ── Layout + overrides ──────────────────────────────────────────────────
    let layout, overrides, bin_sizes;
    if (client === "FANDMKET" && FANDM_LAYOUT) {
      layout    = FANDM_LAYOUT;
      overrides = LAYOUT_OVERRIDES || {};
      bin_sizes = getConfiguredBinSizes();
    } else {
      layout    = { zones: [{ zone_key: "zone_1", zone_label: "Warehouse", aisles: [] }] };
      overrides = {};
      bin_sizes = {};
    }

    const zoneIndex = buildZoneIndex(layout);

    // ── Snapshot dates ──────────────────────────────────────────────────────
    const availableDates = filterCompleteSnapshotDates(await service.listSnapshotDates("pick_activity", client));
    const latestDate     = availableDates[0] || null;
    const selectedDate   = (mode === "date" && availableDates.includes(date)) ? date : latestDate;

    // ── Load snapshots in parallel ──────────────────────────────────────────
    const [pickResult, binlocResult] = await Promise.all([
      selectedDate
        ? service.loadSnapshot("pick_activity", client, selectedDate)
        : Promise.resolve({ rows: [], meta: {} }),
      service.loadSnapshot("binloc", client, null)
        .catch(() => ({ rows: [], meta: {} })),   // graceful if no binloc snapshot
    ]);

    const pickRows      = pickResult.rows  || [];
    const snapshotMeta  = pickResult.meta  || {};
    const rawBinlocRows = binlocResult.rows || [];

    // ── Build pick map (location → pick row) ────────────────────────────────
    const pickMap = new Map();
    for (const row of pickRows) {
      const loc = String(row.location || "").trim().toUpperCase();
      if (loc) pickMap.set(loc, row);
    }

    const binlocRows = rawBinlocRows.filter(row => shouldIncludeBinlocHeatmapRow(row, client, pickMap));

    // ── Build base location map from binloc ─────────────────────────────────
    const locationMap = new Map();

    for (const row of binlocRows) {
      const loc = getBinlocLocation(row);
      if (!loc) continue;
      const status = String(row.BLSTS || row.status || "Y").trim().toUpperCase();
      if (status && status !== "Y") continue;          // skip inactive locations

      const parts   = parseLocationCode(loc);
      const pickRow = pickMap.get(loc) || {};
      const zoneKey = pickRow.zone_key || zoneIndex.get(parts.aisle_prefix) || "";
      const binSize = String(row.BLSCOD || row.bin_size || "").trim().toUpperCase();

      locationMap.set(loc, {
        location:     loc,
        aisle_prefix: pickRow.aisle_prefix || parts.aisle_prefix,
        bay:          pickRow.bay          || parts.bay,
        level:        pickRow.level        || parts.level,
        slot:         pickRow.slot         || parts.slot,
        zone_key:     zoneKey,
        sku:          String(row.BLITEM || row.sku || "").trim(),
        qty:          Number(row.BLQTY  || row.qty  || 0),
        status:       status || "Y",
        bin_size:     binSize,
        bin_type:     normalizeBinType(row.BLBKPK || row.bin_type || ""),
        max_bin_qty:  Number(row.BLMAXQ || row.max_bin_qty || 0),
        pick_count:   Number(pickRow.pick_count   || 0),
        pick_qty:     Number(pickRow.pick_qty     || 0),
        picker_count: Number(pickRow.picker_count || 0),
        top_skus:     pickRow.top_skus     || [],
        is_virtual:   false,
      });
    }

    // ── Add any picked locations not in binloc ──────────────────────────────
    for (const [loc, pickRow] of pickMap) {
      if (locationMap.has(loc)) continue;
      const parts   = parseLocationCode(loc);
      const zoneKey = pickRow.zone_key || zoneIndex.get(parts.aisle_prefix) || "";
      locationMap.set(loc, {
        location:     loc,
        aisle_prefix: pickRow.aisle_prefix || parts.aisle_prefix,
        bay:          pickRow.bay          || parts.bay,
        level:        pickRow.level        || parts.level,
        slot:         pickRow.slot         || parts.slot,
        zone_key:     zoneKey,
        sku:          pickRow.sku          || "",
        qty:          0,
        status:       "Y",
        bin_size:     pickRow.bin_size     || "",
        bin_type:     "Unknown",
        max_bin_qty:  0,
        pick_count:   Number(pickRow.pick_count   || 0),
        pick_qty:     Number(pickRow.pick_qty     || 0),
        picker_count: Number(pickRow.picker_count || 0),
        top_skus:     pickRow.top_skus     || [],
        is_virtual:   false,
      });
    }

    // ── Add virtual locations from overrides (admin-created) ────────────────
    for (const vl of (overrides.virtual_locations || [])) {
      const loc = String(vl.location || "").trim().toUpperCase();
      if (!loc || locationMap.has(loc)) continue;
      const parts   = parseLocationCode(loc);
      const zoneKey = zoneIndex.get(parts.aisle_prefix) || "";
      locationMap.set(loc, {
        location:     loc,
        aisle_prefix: parts.aisle_prefix,
        bay:          parts.bay,
        level:        parts.level,
        slot:         parts.slot,
        zone_key:     zoneKey,
        sku:          "",
        qty:          0,
        status:       "Y",
        bin_size:     String(vl.bin_size  || "").trim().toUpperCase(),
        bin_type:     normalizeBinType(vl.bin_type || ""),
        max_bin_qty:  Number(vl.max_bin_qty || 0),
        pick_count:   0,
        pick_qty:     0,
        picker_count: 0,
        top_skus:     [],
        is_virtual:   true,
      });
    }

    // ── Fallback: no binloc — build phantom rows from overrides.locations ────
    // This ensures all edited/positioned locations appear in the scene even
    // before the PI-App starts publishing warehouse_binloc_snapshots.
    if (!binlocRows.length && overrides.locations) {
      for (const loc of Object.keys(overrides.locations)) {
        if (locationMap.has(loc)) continue;
        const parts   = parseLocationCode(loc);
        if (!parts.aisle_prefix) continue;
        const zoneKey = zoneIndex.get(parts.aisle_prefix) || "";
        locationMap.set(loc, {
          location:     loc,
          aisle_prefix: parts.aisle_prefix,
          bay:          parts.bay,
          level:        parts.level,
          slot:         parts.slot,
          zone_key:     zoneKey,
          sku:          "",
          qty:          0,
          status:       "Y",
          bin_size:     "",
          bin_type:     "Unknown",
          max_bin_qty:  0,
          pick_count:   0,
          pick_qty:     0,
          picker_count: 0,
          top_skus:     [],
          is_virtual:   false,
        });
      }
    } else if (!binlocRows.length) {
      // Non-FANDMKET with no binloc: populate layout aisles from pick data
      const aisles = [...new Set(pickRows.map(r => r.aisle_prefix).filter(Boolean))].sort();
      if (layout.zones[0]) layout.zones[0].aisles = aisles.map(prefix => ({ prefix }));
    }

    const rows = Array.from(locationMap.values());

    // ── known_bin_sizes ─────────────────────────────────────────────────────
    const known_bin_sizes = [...new Set(rows.map(r => r.bin_size).filter(Boolean))].sort();

    // ── Stats ───────────────────────────────────────────────────────────────
    const stats = {
      location_count:          rows.length,
      occupied_location_count: rows.filter(r => r.sku).length,
      picked_location_count:   rows.filter(r => r.pick_count > 0 || r.pick_qty > 0).length,
      total_pick_count:        rows.reduce((s, r) => s + (r.pick_count || 0), 0),
      total_pick_qty:          rows.reduce((s, r) => s + (r.pick_qty   || 0), 0),
      hottest_aisles:          buildHottestAisles(rows),
    };

    const heatmapMeta = {
      available_pick_dates:      availableDates,
      pick_snapshot_date:        selectedDate || "",
      latest_pick_snapshot_date: latestDate   || "",
      pick_range_mode:           mode || "latest",
      pick_available_day_count:  selectedDate ? 1 : 0,
      pick_loaded_dates:         selectedDate ? [selectedDate] : [],
      pick_missing_dates:        [],
      pick_snapshot_meta:        snapshotMeta,
    };

    return res.json({
      ok: true,
      heatmap: { rows, layout, overrides, bin_sizes, known_bin_sizes, meta: heatmapMeta, stats }
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ── API: catalog SKU detail ───────────────────────────────────────────────
app.get("/api/catalog/sku/:sku", requireAdminApi, async (req, res) => {
  const sku    = String(req.params.sku || "").trim();
  const client = String(req.query.client || "FANDMKET").trim();
  if (!sku) return res.status(400).json({ ok: false, error: "sku param required." });
  try {
    const detail = await service.getSkuDetail(sku, client);
    if (!detail) return res.status(404).json({ ok: false, error: "SKU not found." });
    return res.json({ ok: true, sku: detail });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ── API: file proxy (catalog images via PocketBase) ───────────────────────
app.get("/api/files/:imageId", requireAdminApi, async (req, res) => {
  const imageId       = String(req.params.imageId || "").trim();
  const collectionKey = String(req.query.collection || "").trim();
  const fileName      = String(req.query.name || "").trim();
  if (!imageId || !collectionKey || !fileName) {
    return res.status(400).json({ ok: false, error: "imageId, collection and name params required." });
  }
  try {
    const fileResponse = await service.proxySkuImage(imageId, collectionKey, fileName);
    const contentType  = fileResponse.headers?.get("content-type") || "application/octet-stream";
    const buffer       = Buffer.from(await fileResponse.arrayBuffer());
    res.set("Content-Type", contentType);
    res.set("Cache-Control", "public, max-age=86400");
    return res.send(buffer);
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ── API: order lines ──────────────────────────────────────────────────────
app.get("/api/order-lines", requireAdminApi, async (req, res) => {
  const { client, mode, date, start, end, customer, channel, channels, item_group, q, noTruncate, metaOnly } = req.query;
  // channels = comma-separated list for multi-channel export; channel = single value for filter dropdown
  const channelSet = channels ? new Set(channels.split(",").map(s => s.trim().toLowerCase()).filter(Boolean))
                   : channel  ? new Set([channel.toLowerCase()])
                   : null;
  if (!client) return res.status(400).json({ ok: false, error: "client param required." });
  try {
    const availableDates = filterCompleteSnapshotDates(await service.listSnapshotDates("order_lines", client));

    const loadedDates = resolveSnapshotWindowDates(availableDates, mode || "latest", date, start, end, 366);

    if (!loadedDates.length) {
      return res.json({
        ok: true, rows: [], meta: { loaded_dates: [] }, fromCache: false,
        totalRows: 0, filterOptions: { channels: [], item_groups: [] },
      });
    }

    // metaOnly: scan all dates in batches to collect distinct filter options
    if (metaOnly === "1") {
      const allChannels   = new Set();
      const allItemGroups = new Set();
      const BATCH = 14;
      for (let i = 0; i < loadedDates.length; i += BATCH) {
        const batch = loadedDates.slice(i, i + BATCH);
        const batchResults = await Promise.all(
          batch.map(d => service.loadSnapshot("order_lines", client, d).catch(() => ({ rows: [] })))
        );
        for (const { rows: dr = [] } of batchResults) {
          for (const r of dr) {
            if (r.order_channel) allChannels.add(r.order_channel);
            if (r.item_group)    allItemGroups.add(r.item_group);
          }
        }
      }
      return res.json({
        ok: true, rows: [],
        meta: { window_dates: loadedDates },
        filterOptions: {
          channels:    [...allChannels].sort(),
          item_groups: [...allItemGroups].sort(),
        },
      });
    }

    const isMultiDate  = loadedDates.length > 1;
    const hasFilter    = !!(q || customer || channelSet || item_group);
    const forceAll     = noTruncate === "1";

    const datesToLoad = (isMultiDate && !hasFilter && !forceAll) ? [loadedDates[0]] : loadedDates;
    const truncated   = isMultiDate && !hasFilter && !forceAll;

    const ql = q        ? q.toLowerCase()        : null;
    const cl = customer ? customer.toLowerCase() : null;

    let totalRawRows = 0;
    const rows = [];
    let filterOptionsRows = null;

    for (const d of datesToLoad) {
      const { rows: dateRows = [] } = await service.loadSnapshot("order_lines", client, d).catch(() => ({ rows: [] }));
      totalRawRows += dateRows.length;
      if (!filterOptionsRows) filterOptionsRows = dateRows;

      if (isMultiDate) {
        for (const r of dateRows) {
          if (ql && !(String(r.order_number || "").toLowerCase().includes(ql) || String(r.item || "").toLowerCase().includes(ql) || String(r.customer_name || "").toLowerCase().includes(ql))) continue;
          if (cl && !String(r.customer_name || "").toLowerCase().includes(cl)) continue;
          if (channelSet && !channelSet.has(String(r.order_channel || "").toLowerCase())) continue;
          if (item_group && String(r.item_group || "").toLowerCase() !== item_group.toLowerCase()) continue;
          rows.push(r);
        }
      } else {
        rows.push(...dateRows);
      }
    }

    let finalRows = rows;
    if (!isMultiDate) {
      if (ql)          finalRows = finalRows.filter(r => String(r.order_number || "").toLowerCase().includes(ql) || String(r.item || "").toLowerCase().includes(ql) || String(r.customer_name || "").toLowerCase().includes(ql));
      if (cl)          finalRows = finalRows.filter(r => String(r.customer_name || "").toLowerCase().includes(cl));
      if (channelSet)  finalRows = finalRows.filter(r => channelSet.has(String(r.order_channel || "").toLowerCase()));
      if (item_group)  finalRows = finalRows.filter(r => String(r.item_group || "").toLowerCase() === item_group.toLowerCase());
    }

    const optionSource = filterOptionsRows || [];
    const availableChannels = [...new Set(optionSource.map(r => r.order_channel).filter(Boolean))].sort();
    const item_groups = [...new Set(optionSource.map(r => r.item_group).filter(Boolean))].sort();

    return res.json({
      ok: true,
      rows: isMultiDate ? rows : finalRows,
      meta: { loaded_dates: datesToLoad, window_dates: loadedDates, truncated },
      fromCache: false,
      totalRows: totalRawRows,
      filterOptions: { channels: availableChannels, item_groups },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ── API: order lines export (streaming XLSX via ExcelJS — O(1) memory) ───────
app.get("/api/order-lines/export", requireAdminApi, async (req, res) => {
  const { client, mode, date, start, end, channels, item_group } = req.query;
  if (!client) return res.status(400).json({ ok: false, error: "client param required." });
  try {
    const availableDates = filterCompleteSnapshotDates(await service.listSnapshotDates("order_lines", client));
    const loadedDates    = resolveSnapshotWindowDates(availableDates, mode || "latest", date, start, end, 366);

    if (!loadedDates.length) {
      return res.status(404).json({ ok: false, error: "No data found for the selected window." });
    }

    const channelSet  = channels   ? new Set(channels.split(",").map(s => s.trim().toLowerCase()).filter(Boolean)) : null;
    const itemGroupLc = item_group ? item_group.toLowerCase() : null;

    const dates     = loadedDates;
    const dateLabel = dates.length === 1 ? dates[0] : `${dates[dates.length - 1]}_to_${dates[0]}`;
    const chanPart  = (channelSet && channelSet.size) ? `_${[...channelSet].join("-")}` : "";
    const filename  = `order-lines_${client}_${dateLabel}${chanPart}.xlsx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const workbook  = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: false, useSharedStrings: false });
    const worksheet = workbook.addWorksheet("Order Lines");
    worksheet.columns = [
      { header: "Order No",  key: "a", width: 16 },
      { header: "Line",      key: "b", width: 7  },
      { header: "Item",      key: "c", width: 14 },
      { header: "Date",      key: "d", width: 13 },
      { header: "Qty",       key: "e", width: 7  },
      { header: "Item Group",key: "f", width: 14 },
      { header: "Channel",   key: "g", width: 22 },
      { header: "Customer",  key: "h", width: 30 },
      { header: "Bin",       key: "i", width: 14 },
      { header: "Pick Qty",  key: "j", width: 9  },
    ];

    const BATCH = 7;
    for (let i = 0; i < loadedDates.length; i += BATCH) {
      const batch = loadedDates.slice(i, i + BATCH);
      const batchResults = await Promise.all(
        batch.map(d => service.loadSnapshot("order_lines", client, d, { noCache: true }).catch(() => ({ rows: [] })))
      );
      for (const { rows = [] } of batchResults) {
        for (const r of rows) {
          if (channelSet  && !channelSet.has(String(r.order_channel || "").toLowerCase())) continue;
          if (itemGroupLc && String(r.item_group || "").toLowerCase() !== itemGroupLc)     continue;
          worksheet.addRow([
            r.order_number, r.order_line, r.item, r.fulfilment_date,
            r.qty_fulfilled, r.item_group, r.order_channel, r.customer_name,
            r.picking_location, r.pick_qty,
          ]).commit();
        }
      }
    }

    await worksheet.commit();
    await workbook.commit();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: String(err.message || err) });
    else res.end();
  }
});

// ── API: pick transactions ────────────────────────────────────────────────
app.get("/api/pick-transactions", requireAdminApi, async (req, res) => {
  const { client, date, order_number, item } = req.query;
  if (!client || !order_number || !item) {
    return res.status(400).json({ ok: false, error: "client, order_number and item params required." });
  }
  try {
    const availableDates = filterCompleteSnapshotDates(await service.listSnapshotDates("pick_transactions", client));
    const selectedDate = availableDates.includes(String(date || "").trim())
      ? String(date || "").trim()
      : (availableDates[0] || null);

    if (!selectedDate) {
      return res.json({ ok: true, rows: [], meta: null, fromCache: false });
    }

    const { rows: allRows, meta, fromCache } = await service.loadSnapshot("pick_transactions", client, selectedDate);
    const rows = allRows.filter(r =>
      String(r.BTORDN || "").trim() === String(order_number).trim() &&
      String(r.BAITEM || "").trim() === String(item).trim()
    );
    return res.json({ ok: true, rows, meta, fromCache });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ── API: reports detail drawer ────────────────────────────────────────────
app.get("/api/reports-detail", requireAdminApi, async (req, res) => {
  const { client, entity, value, mode, date, start, end, channels, hide_group_147, hideGroup147: hideGroup147Camel } = req.query;
  const targetEntity = entity === "location" ? "location" : (entity === "sku" ? "sku" : "");
  const targetValue  = targetEntity === "location"
    ? String(value || "").trim().toUpperCase()
    : String(value || "").trim().toUpperCase();
  const hideGroup147 = hide_group_147 === "1" || hideGroup147Camel === "1";

  if (!client || !targetEntity || !targetValue) {
    return res.status(400).json({ ok: false, error: "client, entity and value params required." });
  }

  try {
    const availableDates = filterCompleteSnapshotDates(await service.listSnapshotDates("order_lines", client));
    const loadedDates    = resolveSnapshotWindowDates(availableDates, mode, date, start, end);
    const latestDate     = availableDates[0] || null;

    if (!loadedDates.length) {
      return res.json({
        ok: true,
        entity: targetEntity,
        value: targetValue,
        meta: {
          client_code: client,
          available_dates: availableDates,
          loaded_dates: [],
          latest_date: latestDate,
          date_count: 0,
          channel_filter: [],
          pick_transaction_dates_available: [],
          pick_transaction_dates_loaded: [],
        },
        summary: null,
        order_lines: [],
        pick_transactions: [],
        picker_breakdown: [],
        sku_breakdown: [],
        location_breakdown: [],
        sku_detail: null,
      });
    }

    const channelFilter = new Set(
      String(channels || "")
        .split(",")
        .map(c => c.trim().toUpperCase())
        .filter(Boolean)
    );

    const [orderLineResults, trxAvailableDates, rawBinloc] = await Promise.all([
      Promise.all(loadedDates.map(d => service.loadSnapshot("order_lines", client, d).catch(() => ({ rows: [] })))),
      service.listSnapshotDates("pick_transactions", client).then(filterCompleteSnapshotDates).catch(() => []),
      service.loadSnapshot("binloc", client, null).catch(() => ({ rows: [] })),
    ]);
    const orderLineContextByDate = new Map(
      loadedDates.map((d, i) => [d, buildReportOrderLineContext(orderLineResults[i]?.rows || [], d)])
    );

    const matchingOrderLines = [];
    const matchingOrderLineKeys = new Set();
    const matchingOrders     = new Set();
    const matchingSkus       = new Set();
    const matchingLocations  = new Set();
    const matchingChannels   = new Set();
    const matchingGroups     = new Set();
    const matchingCustomers  = new Set();

    for (let i = 0; i < loadedDates.length; i++) {
      const snapshotDate = loadedDates[i];
      const rows = orderLineResults[i]?.rows || [];
      for (const row of rows) {
        const orderChannel = String(row.order_channel || "").trim().toUpperCase();
        if (channelFilter.size > 0 && !channelFilter.has(orderChannel)) continue;

        const sku      = String(row.item || "").trim().toUpperCase();
        const location = String(row.picking_location || "").trim().toUpperCase();
        const matchesTarget = targetEntity === "location" ? location === targetValue : sku === targetValue;
        if (!matchesTarget) continue;

        const normalizedRow = {
          ...row,
          snapshot_date:     snapshotDate,
          order_number:      String(row.order_number || "").trim(),
          item:              sku,
          picking_location:  location,
          order_channel:     orderChannel,
          item_group:        String(row.item_group || "").trim(),
          customer_name:     String(row.customer_name || "").trim(),
          pick_qty:          Number(row.pick_qty || row.qty_fulfilled || 0),
        };
        if (hideGroup147 && normalizedRow.item_group === "147") continue;

        const matchingLineKey = buildOrderItemLocationKey(
          normalizedRow.order_number,
          normalizedRow.item,
          normalizedRow.picking_location
        );
        if (matchingOrderLineKeys.has(matchingLineKey)) continue;
        matchingOrderLineKeys.add(matchingLineKey);

        matchingOrderLines.push(normalizedRow);
        matchingOrders.add(normalizedRow.order_number);
        if (normalizedRow.item) matchingSkus.add(normalizedRow.item);
        if (normalizedRow.picking_location) matchingLocations.add(normalizedRow.picking_location);
        if (normalizedRow.order_channel) matchingChannels.add(normalizedRow.order_channel);
        if (normalizedRow.item_group) matchingGroups.add(normalizedRow.item_group);
        if (normalizedRow.customer_name) matchingCustomers.add(normalizedRow.customer_name);
      }
    }

    const pickTransactionDatesLoaded = loadedDates.filter(d => trxAvailableDates.includes(d));
    const pickTransactionResults = await Promise.all(
      pickTransactionDatesLoaded.map(d => service.loadSnapshot("pick_transactions", client, d).catch(() => ({ rows: [] })))
    );

    const matchingTransactions = [];
    for (let i = 0; i < pickTransactionDatesLoaded.length; i++) {
      const snapshotDate = pickTransactionDatesLoaded[i];
      const rows = pickTransactionResults[i]?.rows || [];
      for (const row of rows) {
        const orderNumber = String(row.BTORDN || "").trim();
        const sku         = String(row.BAITEM || "").trim().toUpperCase();
        const location    = String(row.BABINL || "").trim().toUpperCase();
        const orderItemKey = buildOrderItemKey(orderNumber, sku);
        const dateContext = orderLineContextByDate.get(snapshotDate) || {};
        const reportContext =
          dateContext.byOrderItemLocation?.get(buildOrderItemLocationKey(orderNumber, sku, location)) ||
          dateContext.byOrderItem?.get(orderItemKey) ||
          {};
        const txChannel = String(reportContext.order_channel || "").trim().toUpperCase();
        const txItemGroup = String(reportContext.item_group || dateContext.itemGroupBySku?.get(sku) || "").trim();

        if (channelFilter.size > 0 && !channelFilter.has(txChannel)) continue;
        if (hideGroup147 && txItemGroup === "147") continue;

        const matchesTarget = targetEntity === "location"
          ? location === targetValue
          : sku === targetValue;

        if (!matchesTarget) continue;

        matchingTransactions.push({
          ...row,
          snapshot_date: snapshotDate,
          BTORDN: orderNumber,
          BAITEM: sku,
          BABINL: location,
          BTPICU: String(row.BTPICU || "").trim(),
          BTPICD: String(row.BTPICD || "").trim(),
          BAQTY:  Number(row.BAQTY || 0),
          order_channel: txChannel,
          item_group: txItemGroup,
          customer_name: String(reportContext.customer_name || "").trim(),
          order_line: reportContext.order_line ?? "",
        });

        if (orderNumber) matchingOrders.add(orderNumber);
        if (sku) matchingSkus.add(sku);
        if (location) matchingLocations.add(location);
        if (txChannel) matchingChannels.add(txChannel);
        if (reportContext.item_group) matchingGroups.add(String(reportContext.item_group).trim());
        if (reportContext.customer_name) matchingCustomers.add(String(reportContext.customer_name).trim());
      }
    }

    const exactLineTransactionMap = new Map();
    const orderItemTransactionMap = new Map();
    for (const row of matchingTransactions) {
      const exactKey = buildOrderItemLocationKey(row.BTORDN, row.BAITEM, row.BABINL);
      const fallbackKey = buildOrderItemKey(row.BTORDN, row.BAITEM);
      const picker = String(row.BTPICU || "").trim() || "Unknown";
      const qty = Number(row.BAQTY || 0);

      for (const [targetMap, key] of [[exactLineTransactionMap, exactKey], [orderItemTransactionMap, fallbackKey]]) {
        const entry = targetMap.get(key) || {
          pickers: new Set(),
          transaction_count: 0,
          transaction_qty: 0,
        };
        entry.pickers.add(picker);
        entry.transaction_count += 1;
        entry.transaction_qty += qty;
        targetMap.set(key, entry);
      }
    }

    for (let i = 0; i < matchingOrderLines.length; i++) {
      const row = matchingOrderLines[i];
      const exactEntry = exactLineTransactionMap.get(
        buildOrderItemLocationKey(row.order_number, row.item, row.picking_location)
      );
      const fallbackEntry = orderItemTransactionMap.get(buildOrderItemKey(row.order_number, row.item));
      const selectedEntry = exactEntry || fallbackEntry || null;

      matchingOrderLines[i] = {
        ...row,
        pick_qty: exactEntry ? exactEntry.transaction_qty : row.pick_qty,
        pickers: selectedEntry ? [...selectedEntry.pickers].sort((a, b) => a.localeCompare(b)).join(", ") : "",
        transaction_count: (selectedEntry?.transaction_count ?? 0),
        transaction_qty: (selectedEntry?.transaction_qty ?? 0),
      };
    }

    const pickerMap = new Map();
    for (const row of matchingTransactions) {
      const picker = String(row.BTPICU || "").trim() || "Unknown";
      const entry = pickerMap.get(picker) || {
        picker,
        transaction_count: 0,
        pick_qty: 0,
        orders: new Set(),
        skus: new Set(),
        locations: new Set(),
      };
      entry.transaction_count += 1;
      entry.pick_qty += Number(row.BAQTY || 0);
      if (row.BTORDN) entry.orders.add(row.BTORDN);
      if (row.BAITEM) entry.skus.add(row.BAITEM);
      if (row.BABINL) entry.locations.add(row.BABINL);
      pickerMap.set(picker, entry);
    }

    const pickerBreakdown = [...pickerMap.values()]
      .map(entry => ({
        picker: entry.picker,
        transaction_count: entry.transaction_count,
        pick_qty: entry.pick_qty,
        order_count: entry.orders.size,
        sku_count: entry.skus.size,
        location_count: entry.locations.size,
      }))
      .sort((a, b) => b.pick_qty - a.pick_qty || b.transaction_count - a.transaction_count || a.picker.localeCompare(b.picker));

    const binlocRows = rawBinloc?.rows || [];
    const locationBinlocRow = targetEntity === "location"
      ? binlocRows.find(row => {
          const rowLocation = getBinlocLocation(row);
          const rowClient   = getBinlocRowClientCode(row);
          return rowLocation === targetValue && (!rowClient || rowClient === normalizeClientCode(client));
        }) || null
      : null;

    const locationBreakdownMap = new Map();
    const skuBreakdownMap = new Map();
    if (targetEntity === "sku") {
      const sourceRows = matchingTransactions.length ? matchingTransactions : matchingOrderLines;
      for (const row of sourceRows) {
        const loc = matchingTransactions.length ? row.BABINL : row.picking_location;
        const entry = locationBreakdownMap.get(loc) || { location: loc, pick_qty: 0, line_count: 0, orders: new Set() };
        entry.pick_qty += Number(matchingTransactions.length ? row.BAQTY : row.pick_qty || 0);
        entry.line_count += 1;
        if (row.BTORDN || row.order_number) entry.orders.add(row.BTORDN || row.order_number);
        locationBreakdownMap.set(loc, entry);
      }
    } else {
      const sourceRows = matchingTransactions.length ? matchingTransactions : matchingOrderLines;
      for (const row of sourceRows) {
        const sku = matchingTransactions.length ? row.BAITEM : row.item;
        const entry = skuBreakdownMap.get(sku) || {
          sku,
          item_group: row.item_group || "",
          pick_qty: 0,
          line_count: 0,
          orders: new Set(),
          customers: new Set(),
        };
        if (!entry.item_group && row.item_group) entry.item_group = row.item_group;
        entry.pick_qty += Number(matchingTransactions.length ? row.BAQTY : row.pick_qty || 0);
        entry.line_count += 1;
        if (row.BTORDN || row.order_number) entry.orders.add(row.BTORDN || row.order_number);
        if (row.customer_name) entry.customers.add(row.customer_name);
        skuBreakdownMap.set(sku, entry);
      }
    }

    const locationBreakdown = [...locationBreakdownMap.values()]
      .map(entry => ({
        location: entry.location,
        pick_qty: entry.pick_qty,
        line_count: entry.line_count,
        order_count: entry.orders.size,
      }))
      .sort((a, b) => b.pick_qty - a.pick_qty || b.line_count - a.line_count || a.location.localeCompare(b.location))
      .slice(0, 25);

    const skuBreakdown = [...skuBreakdownMap.values()]
      .map(entry => ({
        sku: entry.sku,
        item_group: entry.item_group,
        pick_qty: entry.pick_qty,
        line_count: entry.line_count,
        order_count: entry.orders.size,
        customer_count: entry.customers.size,
      }))
      .sort((a, b) => b.pick_qty - a.pick_qty || b.line_count - a.line_count || a.sku.localeCompare(b.sku))
      .slice(0, 25);

    const totalPickQty = matchingTransactions.length
      ? matchingTransactions.reduce((sum, row) => sum + Number(row.BAQTY || 0), 0)
      : matchingOrderLines.reduce((sum, row) => sum + Number(row.pick_qty || 0), 0);
    const transactionCount = matchingTransactions.length;

    const summary = targetEntity === "location"
      ? {
          location: targetValue,
          aisle_prefix: parseLocationCode(targetValue).aisle_prefix,
          level: parseLocationCode(targetValue).level,
          operating_area: String(locationBinlocRow?.BLWOPA || locationBinlocRow?.operating_area || "").trim().toUpperCase() || "—",
          bin_size: String(locationBinlocRow?.BLSCOD || locationBinlocRow?.bin_size || "").trim().toUpperCase() || "—",
          bin_type: normalizeBinType(locationBinlocRow?.BLBKPK || locationBinlocRow?.bin_type || ""),
          max_bin_qty: Number(locationBinlocRow?.BLMAXQ || locationBinlocRow?.max_bin_qty || 0),
          current_bin_qty: Number(locationBinlocRow?.BLQTY || locationBinlocRow?.qty || 0),
          pick_qty: totalPickQty,
          line_count: matchingOrderLines.length,
          order_count: matchingOrders.size,
          sku_count: matchingSkus.size,
          picker_count: pickerBreakdown.length,
          customer_count: matchingCustomers.size,
          transaction_count: transactionCount,
        }
      : {
          sku: targetValue,
          pick_qty: totalPickQty,
          line_count: matchingOrderLines.length,
          order_count: matchingOrders.size,
          location_count: matchingLocations.size,
          picker_count: pickerBreakdown.length,
          channel_count: matchingChannels.size,
          item_group_count: matchingGroups.size,
          customer_count: matchingCustomers.size,
          transaction_count: transactionCount,
        };

    const skuDetail = targetEntity === "sku"
      ? await service.getSkuDetail(targetValue, client).catch(() => null)
      : null;

    matchingOrderLines.sort((a, b) =>
      String(b.snapshot_date || "").localeCompare(String(a.snapshot_date || "")) ||
      String(a.order_number || "").localeCompare(String(b.order_number || "")) ||
      Number(a.order_line || 0) - Number(b.order_line || 0)
    );

    matchingTransactions.sort((a, b) =>
      String(b.snapshot_date || "").localeCompare(String(a.snapshot_date || "")) ||
      String(b.BTPICD || "").localeCompare(String(a.BTPICD || "")) ||
      String(a.BTORDN || "").localeCompare(String(b.BTORDN || ""))
    );

    return res.json({
      ok: true,
      entity: targetEntity,
      value: targetValue,
      meta: {
        client_code: client,
        available_dates: availableDates,
        loaded_dates: loadedDates,
        latest_date: latestDate,
        date_count: loadedDates.length,
        channel_filter: [...channelFilter],
        pick_transaction_dates_available: trxAvailableDates,
        pick_transaction_dates_loaded: pickTransactionDatesLoaded,
        pick_transaction_dates_missing: loadedDates.filter(d => !pickTransactionDatesLoaded.includes(d)),
      },
      summary,
      order_lines: matchingOrderLines,
      pick_transactions: matchingTransactions,
      picker_breakdown: pickerBreakdown,
      sku_breakdown: skuBreakdown,
      location_breakdown: locationBreakdown,
      sku_detail: skuDetail,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ── Reports page ──────────────────────────────────────────────────────────
app.get("/reports", requireAdminPage, (req, res) => {
  const { clientChoices, selectedClient } = clientChoicesWithSelected(req);
  res.render("reports", { clientChoices, selectedClient });
});

app.get("/beta-reports", requireAdminPage, (req, res) => {
  const { clientChoices, selectedClient } = clientChoicesWithSelected(req);
  res.render("beta-reports", { clientChoices, selectedClient });
});

app.get("/empty-bins", requireAdminPage, (req, res) => {
  const { clientChoices } = clientChoicesWithSelected(req);
  const fandmChoice = clientChoices.find(c => normalizeClientCode(c.code) === EMPTY_BIN_CLIENT_CODE) ||
    { code: EMPTY_BIN_CLIENT_CODE, name: "Fortnum & Mason" };
  res.render("empty-bins", { clientChoices: [fandmChoice], selectedClient: EMPTY_BIN_CLIENT_CODE });
});

// ── API: reports data ─────────────────────────────────────────────────────
app.get("/api/reports-data", requireAdminApi, async (req, res) => {
  const { client, mode, date, start, end, channels, rankBy, pc_zone_channels, hide_group_147, hideGroup147: hideGroup147Camel } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 10), 100);
  const rank  = (rankBy === "line_count") ? "line_count" : "pick_qty";
  const hideGroup147 = hide_group_147 === "1" || hideGroup147Camel === "1";

  if (!client) return res.status(400).json({ ok: false, error: "client param required." });

  try {
    // ── Step 1: Resolve dates ─────────────────────────────────────────────
    const availableDates = filterCompleteSnapshotDates(await service.listSnapshotDates("order_lines", client));
    const latestDate     = availableDates[0] || null;

    const loadedDates = resolveSnapshotWindowDates(availableDates, mode, date, start, end);

    if (!loadedDates.length) {
      return res.json({
        ok: true,
        meta: { client_code: client, mode: mode || "latest", rank_by: rank, limit,
                hide_group_147: hideGroup147,
                available_dates: availableDates, loaded_dates: [], missing_dates: [],
                latest_date: latestDate, date_count: 0, binloc_available: false,
                channel_labels: CHANNEL_LABELS[client] || CHANNEL_LABELS.FANDMKET || {} },
        summary: { total_pick_qty:0, total_line_count:0, total_order_count:0,
                   active_sku_count:0, active_location_count:0, active_aisle_count:0,
                   active_channel_count:0, active_item_group_count:0,
                   avg_qty_per_line:0, avg_lines_per_day:0,
                   peak_day_date:null, peak_day_pick_qty:0,
                   high_level_pick_qty:0, high_level_line_count:0, high_level_share:0 },
        top_skus:[], top_locations:[], top_aisles:[], high_level_skus:[],
        level_breakdown:[], bin_size_breakdown:[], bin_type_breakdown:[],
        operating_area_breakdown:[], item_group_breakdown:[], channel_breakdown:[],
        daily_breakdown:[],
        replenishment: { note:"No data loaded.", locations:[] },
        pc_zone: {
          note: "No data loaded.",
          summary: {
            pc_pick_qty: 0,
            pc_line_count: 0,
            pc_order_count: 0,
            low_level_pc_pick_qty: 0,
            low_level_pc_line_count: 0,
            non_pc_pick_qty: 0,
            non_pc_line_count: 0,
            non_pc_order_count: 0,
            low_level_non_pc_pick_qty: 0,
            low_level_non_pc_line_count: 0,
            pc_pick_share: 0,
            pc_line_share: 0,
            pc_sku_count: 0,
            non_pc_only_sku_count: 0,
            pc_active_location_count: 0,
            pc_low_level_location_count: 0,
            pc_low_level_empty_location_count: 0,
            pc_low_level_occupied_location_count: 0,
            pc_empty_bin_size_count: 0,
            pc_capacity_benchmark_units: 0,
            item_dimension_sku_count: 0,
          },
          availability: {
            empty_location_count: 0,
            occupied_location_count: 0,
            total_low_level_location_count: 0,
            bin_sizes: [],
            sample_locations: [],
          },
          top_pc_skus: [],
          top_non_pc_skus: [],
        },
      });
    }

    // ── Step 2: Load in parallel ──────────────────────────────────────────
    const trxAvailableDatesPromise = service.listSnapshotDates("pick_transactions", client)
      .then(filterCompleteSnapshotDates)
      .catch(() => []);

    const trxAvailableDates = await trxAvailableDatesPromise;

    const [orderLineResults, pickTransactionResults, binlocResult, catalogResult] = await Promise.all([
      Promise.all(loadedDates.map(d => service.loadSnapshot("order_lines", client, d).catch(() => ({ rows: [] })))),
      Promise.all(loadedDates.map(d =>
        trxAvailableDates.includes(d)
          ? service.loadSnapshot("pick_transactions", client, d).catch(() => ({ rows: [] }))
          : Promise.resolve({ rows: [] })
      )),
      service.loadSnapshot("binloc", client, null).catch(() => ({ rows: [] })),
      service.loadCatalogSnapshot(client).catch(() => ({ snapshot: null, meta: null })),
    ]);

    const activityResults = loadedDates.map((d, i) => {
      const useTransactions = trxAvailableDates.includes(d);
      return {
        rows: buildReportActivityRows(
          orderLineResults[i]?.rows || [],
          pickTransactionResults[i]?.rows || [],
          d,
          { useTransactions }
        ),
        using_transactions: useTransactions,
      };
    });

    const pickTransactionDatesLoaded = loadedDates.filter((d, i) =>
      trxAvailableDates.includes(d) && (pickTransactionResults[i]?.rows || []).length > 0
    );
    const pickTransactionDatesMissing = loadedDates.filter(d => !trxAvailableDates.includes(d));
    const pickQtySource = pickTransactionDatesMissing.length
      ? (pickTransactionDatesLoaded.length ? "mixed" : "order_lines_fallback")
      : "pick_transactions";

    const rawBinlocRows  = binlocResult.rows || [];
    const binlocAvail    = rawBinlocRows.length > 0;
    const targetClient   = normalizeClientCode(client);
    const configuredBinSizes = getConfiguredBinSizes();
    const itemDimensionMap = buildCatalogDimensionMap(catalogResult?.snapshot);

    // ── Step 3: Location enrichment map + SKU capacity model ──────────────
    const FALLBACK_ENRICH = { bin_size: "—", operating_area: "—", max_bin_qty: 0, bin_type: "Unknown", is_pc: false };
    const pickedLocations = new Set();
    for (const snapshot of activityResults) {
      for (const row of (snapshot?.rows || [])) {
        const loc = String(row.picking_location || "").trim().toUpperCase();
        if (loc) pickedLocations.add(loc);
      }
    }

    const enrichMap = new Map();
    const skuCapacityMap = new Map();
    const pcCapacityValues = [];
    const pcActiveLocations = new Set();
    const emptyPcBinSizeMap = new Map();
    const emptyPcLocations = [];
    let pcLowLevelLocationCount = 0;
    let pcLowLevelEmptyLocationCount = 0;
    let pcLowLevelOccupiedLocationCount = 0;

    for (const row of rawBinlocRows) {
      const loc = getBinlocLocation(row);
      if (!loc) continue;

      const rowClientCode = getBinlocRowClientCode(row);
      const includeForClient = !rowClientCode || rowClientCode === targetClient || pickedLocations.has(loc);
      if (!includeForClient) continue;

      const operatingArea = normalizeOperatingArea(row.BLWOPA || row.operating_area);
      const maxBinQty     = Number(row.BLMAXQ || row.max_bin_qty || 0);
      const binType       = normalizeBinType(row.BLBKPK || row.bin_type || "");
      const isPcArea      = isPcOperatingArea(operatingArea);
      const status        = String(row.BLSTS || row.status || "Y").trim().toUpperCase();
      const levelNum      = getLocationLevelNumber(loc);
      const binSize       = getBinlocBinSize(row);
      const binDims       = configuredBinSizes[binSize] || null;
      const binUsableVolume = usableBinVolume(binDims);
      const currentQty    = Number(row.BLQTY || row.qty || row["Item Qty"] || 0);
      const adjustedQty   = Number(row.BLADJQ || row.item_adjust || 0);
      const pickedQty     = Number(row.BLPICQ || row.item_picked || 0);
      const kitQty        = Number(row.BLKITQ || 0);
      const sku           = String(row.BLITEM || row.sku || "").trim().toUpperCase();
      const isEmptyLocation = currentQty <= 0 && adjustedQty <= 0 && pickedQty <= 0 && kitQty <= 0;
      const enrichRecord  = {
        bin_size:       String(row.BLSCOD || row.bin_size || "").trim().toUpperCase() || "—",
        operating_area: operatingArea || "—",
        max_bin_qty:    maxBinQty,
        bin_type:       binType,
        is_pc:          isPcArea,
        source_client_code: rowClientCode,
      };

      const existingEnrich = enrichMap.get(loc);
      if (!existingEnrich || (!existingEnrich.source_client_code && rowClientCode) || rowClientCode === targetClient) {
        enrichMap.set(loc, enrichRecord);
      }

      if (status !== "Y") continue;
      if (isPcArea && levelNum < HIGH_LEVEL_THRESHOLD) {
        pcLowLevelLocationCount++;
        if (isEmptyLocation) {
          pcLowLevelEmptyLocationCount++;
          const key = binSize || "â€”";
          const entry = emptyPcBinSizeMap.get(key) || {
            bin_size: key,
            bin_type: binType,
            location_count: 0,
            dimensions_configured: Boolean(binDims),
            height_mm: binDims ? binDims.height : null,
            width_mm: binDims ? binDims.width : null,
            depth_mm: binDims ? binDims.depth : null,
            volume_mm3: binDims ? binSizeVolume(binDims) : null,
            usable_volume_mm3: binUsableVolume || null,
            example_locations: [],
          };
          entry.location_count++;
          if (entry.example_locations.length < 8) entry.example_locations.push(loc);
          emptyPcBinSizeMap.set(key, entry);
          if (emptyPcLocations.length < 100) {
            const parts = parseLocationCode(loc);
            emptyPcLocations.push({
              location: loc,
              aisle_prefix: parts.aisle_prefix,
              level: parts.level,
              bin_size: key,
              bin_type: binType,
              height_mm: binDims ? binDims.height : null,
              width_mm: binDims ? binDims.width : null,
              depth_mm: binDims ? binDims.depth : null,
              usable_volume_mm3: binUsableVolume || null,
            });
          }
        } else {
          pcLowLevelOccupiedLocationCount++;
        }
      }
      if (isPcArea && levelNum < HIGH_LEVEL_THRESHOLD && maxBinQty > 0) {
        pcCapacityValues.push(maxBinQty);
        pcActiveLocations.add(loc);
      }

      if (!sku) continue;

      if (!skuCapacityMap.has(sku)) {
        skuCapacityMap.set(sku, {
          low_level_non_pc_capacity: 0,
          low_level_pc_capacity: 0,
          low_level_non_pc_usable_volume_mm3: 0,
          low_level_pc_usable_volume_mm3: 0,
          low_level_non_pc_locations: new Set(),
          low_level_pc_locations: new Set(),
          low_level_non_pc_bin_sizes: new Set(),
          low_level_pc_bin_sizes: new Set(),
        });
      }

      const skuCapacity = skuCapacityMap.get(sku);
      if (levelNum >= HIGH_LEVEL_THRESHOLD) continue;

      if (isPcArea) {
        skuCapacity.low_level_pc_capacity += maxBinQty;
        skuCapacity.low_level_pc_usable_volume_mm3 += binUsableVolume;
        skuCapacity.low_level_pc_locations.add(loc);
        if (binSize) skuCapacity.low_level_pc_bin_sizes.add(binSize);
      } else {
        skuCapacity.low_level_non_pc_capacity += maxBinQty;
        skuCapacity.low_level_non_pc_usable_volume_mm3 += binUsableVolume;
        skuCapacity.low_level_non_pc_locations.add(loc);
        if (binSize) skuCapacity.low_level_non_pc_bin_sizes.add(binSize);
      }
    }

    // ── Step 3.5: Client-specific channel labels ──────────────────────────
    const clientChannelLabels = CHANNEL_LABELS[client] || CHANNEL_LABELS.FANDMKET || {};

    // ── Step 4: Channel filter ────────────────────────────────────────────
    const channelFilter = new Set(
      (channels || "").split(",").map(c => c.trim().toUpperCase()).filter(Boolean)
    );
    const requestedPcZoneChannels = new Set(
      String(pc_zone_channels || "")
        .split(",")
        .map(c => c.trim().toUpperCase())
        .filter(c => PC_ZONE_CHANNELS.has(c))
    );
    const pcZoneChannelFilter = requestedPcZoneChannels.size > 0
      ? requestedPcZoneChannels
      : new Set(PC_ZONE_CHANNELS);

    // ── Step 5: Aggregate ─────────────────────────────────────────────────
    const skuMap          = new Map();
    const locationMap     = new Map();
    const aisleMap        = new Map();
    const levelMap        = new Map();
    const binSizeMap      = new Map();
    const binTypeMap      = new Map();
    const opAreaMap       = new Map();
    const itemGroupMap    = new Map();
    const channelMap      = new Map();
    const channelDetailMap = new Map(); // ch -> { skuMap, locationMap }
    const dailyMap        = new Map();
    const pcZoneSkuMap    = new Map();

    let totalPickQty    = 0, totalLineCount = 0;
    let highLevelQty    = 0, highLevelLines = 0;
    let pcPickQty       = 0, pcLineCount = 0;
    let nonPcPickQty    = 0, nonPcLineCount = 0;
    let pcZoneTotalPickQty = 0, pcZoneTotalLineCount = 0;
    let pcZonePcPickQty    = 0, pcZonePcLineCount = 0;
    let pcZoneNonPcPickQty = 0, pcZoneNonPcLineCount = 0;
    let pcZoneLowLevelPcPickQty = 0, pcZoneLowLevelPcLineCount = 0;
    let pcZoneLowLevelNonPcPickQty = 0, pcZoneLowLevelNonPcLineCount = 0;

    const allOrders     = new Set();
    const allSkus       = new Set();
    const allLocations  = new Set();
    const allAisles     = new Set();
    const allChannels   = new Set();
    const allItemGroups = new Set();
    const pcOrders      = new Set();
    const nonPcOrders   = new Set();
    const pcZonePcOrders    = new Set();
    const pcZoneNonPcOrders = new Set();

    function getOrInit(map, key, init) {
      if (!map.has(key)) map.set(key, init());
      return map.get(key);
    }

    function recordPcZoneActivity({ sku, grp, loc, ord, qty, isPcArea, levelNum }) {
      pcZoneTotalPickQty += qty;
      pcZoneTotalLineCount++;
      const isLowLevel = levelNum < HIGH_LEVEL_THRESHOLD;
      const entry = getOrInit(pcZoneSkuMap, sku, () => ({
        sku,
        item_group: grp,
        pick_qty: 0,
        line_count: 0,
        orders: new Set(),
        pc_pick_qty: 0,
        pc_line_count: 0,
        pc_orders: new Set(),
        pc_locations: new Set(),
        non_pc_pick_qty: 0,
        non_pc_line_count: 0,
        non_pc_orders: new Set(),
        low_level_pc_pick_qty: 0,
        low_level_pc_line_count: 0,
        low_level_pc_orders: new Set(),
        low_level_non_pc_pick_qty: 0,
        low_level_non_pc_line_count: 0,
        low_level_non_pc_orders: new Set(),
      }));

      entry.pick_qty += qty;
      entry.line_count++;
      if (ord) entry.orders.add(ord);

      if (isPcArea) {
        pcZonePcPickQty += qty;
        pcZonePcLineCount++;
        if (ord) pcZonePcOrders.add(ord);
        entry.pc_pick_qty += qty;
        entry.pc_line_count++;
        if (ord) entry.pc_orders.add(ord);
        if (loc) entry.pc_locations.add(loc);
        if (isLowLevel) {
          pcZoneLowLevelPcPickQty += qty;
          pcZoneLowLevelPcLineCount++;
          entry.low_level_pc_pick_qty += qty;
          entry.low_level_pc_line_count++;
          if (ord) entry.low_level_pc_orders.add(ord);
        }
      } else {
        pcZoneNonPcPickQty += qty;
        pcZoneNonPcLineCount++;
        if (ord) pcZoneNonPcOrders.add(ord);
        entry.non_pc_pick_qty += qty;
        entry.non_pc_line_count++;
        if (ord) entry.non_pc_orders.add(ord);
        if (isLowLevel) {
          pcZoneLowLevelNonPcPickQty += qty;
          pcZoneLowLevelNonPcLineCount++;
          entry.low_level_non_pc_pick_qty += qty;
          entry.low_level_non_pc_line_count++;
          if (ord) entry.low_level_non_pc_orders.add(ord);
        }
      }
    }

    for (let di = 0; di < loadedDates.length; di++) {
      const snapDate = loadedDates[di];
      const rows     = activityResults[di]?.rows || [];

      for (const row of rows) {
        const ch = String(row.order_channel || "").trim().toUpperCase();
        const sku      = String(row.item           || "").trim().toUpperCase();
        const loc      = String(row.picking_location || "").trim().toUpperCase();
        const grp      = String(row.item_group      || "").trim();
        const ord      = String(row.order_number    || "").trim();
        const qty      = Number(row.pick_qty        || row.qty_fulfilled || 0);
        if (hideGroup147 && grp === "147") continue;
        const parts    = parseLocationCode(loc);
        const pfx      = parts.aisle_prefix;
        const levelNum = parseInt(parts.level, 10) || 0;
        const isHigh   = levelNum >= HIGH_LEVEL_THRESHOLD;
        const enrich   = enrichMap.get(loc) || FALLBACK_ENRICH;
        const isPcArea = Boolean(enrich.is_pc);

        if (pcZoneChannelFilter.has(ch)) {
          recordPcZoneActivity({ sku, grp, loc, ord, qty, isPcArea, levelNum });
        }

        if (channelFilter.size > 0 && !channelFilter.has(ch)) continue;

        totalPickQty  += qty;
        totalLineCount++;
        if (isHigh) { highLevelQty += qty; highLevelLines++; }
        if (isPcArea) {
          pcPickQty += qty;
          pcLineCount++;
          pcOrders.add(ord);
        } else {
          nonPcPickQty += qty;
          nonPcLineCount++;
          nonPcOrders.add(ord);
        }
        allOrders.add(ord); allSkus.add(sku); allLocations.add(loc);
        allAisles.add(pfx); allChannels.add(ch); allItemGroups.add(grp);

        // skuMap
        const skuE = getOrInit(skuMap, sku, () => ({
          sku, item_group: grp, pick_qty:0, line_count:0, orders: new Set(), locations: new Set(),
          aisles: new Set(), high_level_pick_qty: 0, operating_areas: new Set(),
          pc_pick_qty: 0, pc_line_count: 0, pc_orders: new Set(), pc_locations: new Set(),
          non_pc_pick_qty: 0, non_pc_line_count: 0, non_pc_orders: new Set(),
        }));
        skuE.pick_qty += qty; skuE.line_count++; skuE.orders.add(ord);
        skuE.locations.add(loc); skuE.aisles.add(pfx);
        if (isHigh) skuE.high_level_pick_qty += qty;
        if (enrich.operating_area && enrich.operating_area !== "—") skuE.operating_areas.add(enrich.operating_area);
        if (isPcArea) {
          skuE.pc_pick_qty += qty;
          skuE.pc_line_count++;
          skuE.pc_orders.add(ord);
          skuE.pc_locations.add(loc);
        } else {
          skuE.non_pc_pick_qty += qty;
          skuE.non_pc_line_count++;
          skuE.non_pc_orders.add(ord);
        }

        // locationMap
        const locE = getOrInit(locationMap, loc, () => ({
          location: loc, aisle_prefix: pfx, level: parts.level, level_num: levelNum,
          operating_area: enrich.operating_area, bin_size: enrich.bin_size,
          bin_type: enrich.bin_type, max_bin_qty: enrich.max_bin_qty,
          pick_qty: 0, line_count: 0, skus: new Set(), orders: new Set(),
          item_group_picks: new Map(),
        }));
        locE.pick_qty += qty; locE.line_count++; locE.skus.add(sku); locE.orders.add(ord);
        locE.item_group_picks.set(grp, (locE.item_group_picks.get(grp) || 0) + qty);

        // aisleMap
        const aisleE = getOrInit(aisleMap, pfx, () => ({
          aisle_prefix: pfx, pick_qty:0, line_count:0, locations: new Set(), skus: new Set(),
        }));
        aisleE.pick_qty += qty; aisleE.line_count++; aisleE.locations.add(loc); aisleE.skus.add(sku);

        // levelMap
        const lvlE = getOrInit(levelMap, levelNum, () => ({
          level: parts.level, level_num: levelNum, is_high_level: isHigh,
          pick_qty:0, line_count:0, locations: new Set(), skus: new Set(),
        }));
        lvlE.pick_qty += qty; lvlE.line_count++; lvlE.locations.add(loc); lvlE.skus.add(sku);

        // binSizeMap
        const bsKey = enrich.bin_size || "—";
        const bsE   = getOrInit(binSizeMap, bsKey, () => ({ bin_size: bsKey, pick_qty:0, line_count:0, locations: new Set() }));
        bsE.pick_qty += qty; bsE.line_count++; bsE.locations.add(loc);

        // binTypeMap
        const btKey = enrich.bin_type || "Unknown";
        const btE   = getOrInit(binTypeMap, btKey, () => ({ bin_type: btKey, pick_qty:0, line_count:0, locations: new Set() }));
        btE.pick_qty += qty; btE.line_count++; btE.locations.add(loc);

        // opAreaMap
        const oaKey = enrich.operating_area || "—";
        const oaE   = getOrInit(opAreaMap, oaKey, () => ({ operating_area: oaKey, pick_qty:0, line_count:0, locations: new Set(), skus: new Set() }));
        oaE.pick_qty += qty; oaE.line_count++; oaE.locations.add(loc); oaE.skus.add(sku);

        // itemGroupMap
        const igE = getOrInit(itemGroupMap, grp, () => ({ item_group: grp, pick_qty:0, line_count:0, orders: new Set(), skus: new Set() }));
        igE.pick_qty += qty; igE.line_count++; igE.orders.add(ord); igE.skus.add(sku);

        // channelMap
        const chE = getOrInit(channelMap, ch, () => ({ channel: ch, label: clientChannelLabels[ch] || ch, pick_qty:0, line_count:0, orders: new Set(), skus: new Set() }));
        chE.pick_qty += qty; chE.line_count++; chE.orders.add(ord); chE.skus.add(sku);

        // channelDetailMap — per-channel top SKUs & locations
        const chDet = getOrInit(channelDetailMap, ch, () => ({ skuMap: new Map(), locationMap: new Map() }));
        const chDetSku = getOrInit(chDet.skuMap, sku, () => ({
          sku, item_group: grp, pick_qty: 0, line_count: 0, orders: new Set(), locations: new Set(),
        }));
        chDetSku.pick_qty += qty; chDetSku.line_count++; chDetSku.orders.add(ord); chDetSku.locations.add(loc);
        const chDetLoc = getOrInit(chDet.locationMap, loc, () => ({
          location: loc, aisle_prefix: pfx, level: parts.level, level_num: levelNum,
          operating_area: enrich.operating_area, bin_size: enrich.bin_size,
          bin_type: enrich.bin_type, max_bin_qty: enrich.max_bin_qty,
          pick_qty: 0, line_count: 0, skus: new Set(), item_group_picks: new Map(),
        }));
        chDetLoc.pick_qty += qty; chDetLoc.line_count++; chDetLoc.skus.add(sku);
        chDetLoc.item_group_picks.set(grp, (chDetLoc.item_group_picks.get(grp) || 0) + qty);

        // dailyMap
        const dayE = getOrInit(dailyMap, snapDate, () => ({ date: snapDate, pick_qty:0, line_count:0, orders: new Set(), skus: new Set() }));
        dayE.pick_qty += qty; dayE.line_count++; dayE.orders.add(ord); dayE.skus.add(sku);
      }
    }

    // ── Step 6: Replenishment (low-level only) ────────────────────────────
    const replenishmentList = [];
    for (const [loc, e] of locationMap) {
      if (e.level_num >= HIGH_LEVEL_THRESHOLD) continue;
      const maxBinQty = e.max_bin_qty || 0;
      replenishmentList.push({
        location:               loc,
        aisle_prefix:           e.aisle_prefix,
        level:                  e.level,
        operating_area:         e.operating_area,
        bin_size:               e.bin_size,
        bin_type:               e.bin_type,
        pick_qty:               e.pick_qty,
        max_bin_qty:            maxBinQty,
        estimated_replenishments: maxBinQty > 0 ? Math.ceil(e.pick_qty / maxBinQty) : null,
      });
    }
    replenishmentList.sort((a, b) => b.pick_qty - a.pick_qty);

    // ── Step 7: Sort, slice, compute shares ───────────────────────────────
    const sortRank = (a, b) => b[rank] - a[rank];
    const share    = (v) => totalPickQty > 0 ? Math.round((v / totalPickQty) * 10000) / 100 : 0;
    const getSkuCapacity = (sku) => skuCapacityMap.get(sku) || {
      low_level_non_pc_capacity: 0,
      low_level_pc_capacity: 0,
      low_level_non_pc_usable_volume_mm3: 0,
      low_level_pc_usable_volume_mm3: 0,
      low_level_non_pc_locations: new Set(),
      low_level_pc_locations: new Set(),
      low_level_non_pc_bin_sizes: new Set(),
      low_level_pc_bin_sizes: new Set(),
    };

    const topSkus = [...skuMap.values()]
      .sort(sortRank).slice(0, limit)
      .map(e => ({ sku: e.sku, item_group: e.item_group, pick_qty: e.pick_qty, line_count: e.line_count,
                   order_count: e.orders.size, location_count: e.locations.size,
                   aisle_count: e.aisles.size, share_of_picks: share(e.pick_qty) }));

    const topLocations = [...locationMap.values()]
      .sort(sortRank).slice(0, 100)
      .map(e => {
        let primaryItemGroup = '';
        let maxGrpQty = 0;
        for (const [g, q] of e.item_group_picks) { if (q > maxGrpQty) { maxGrpQty = q; primaryItemGroup = g; } }
        return { location: e.location, aisle_prefix: e.aisle_prefix, level: e.level,
                 operating_area: e.operating_area, bin_size: e.bin_size,
                 bin_type: e.bin_type, max_bin_qty: e.max_bin_qty,
                 pick_qty: e.pick_qty, line_count: e.line_count, sku_count: e.skus.size,
                 primary_item_group: primaryItemGroup };
      });

    const topAisles = [...aisleMap.values()]
      .sort(sortRank).slice(0, 50)
      .map(e => ({ aisle_prefix: e.aisle_prefix, pick_qty: e.pick_qty, line_count: e.line_count,
                   location_count: e.locations.size, sku_count: e.skus.size, share_of_picks: share(e.pick_qty) }));

    const levelBreakdown = [...levelMap.values()]
      .sort((a, b) => a.level_num - b.level_num)
      .map(e => ({ level: e.level, pick_qty: e.pick_qty, line_count: e.line_count,
                   location_count: e.locations.size, sku_count: e.skus.size,
                   share_of_picks: share(e.pick_qty), is_high_level: e.is_high_level }));

    const binSizeBreakdown = [...binSizeMap.values()]
      .sort(sortRank)
      .map(e => ({ bin_size: e.bin_size, pick_qty: e.pick_qty, line_count: e.line_count,
                   location_count: e.locations.size, share_of_picks: share(e.pick_qty) }));

    const binTypeBreakdown = [...binTypeMap.values()]
      .sort(sortRank)
      .map(e => ({ bin_type: e.bin_type, pick_qty: e.pick_qty, line_count: e.line_count,
                   location_count: e.locations.size, share_of_picks: share(e.pick_qty) }));

    const opAreaBreakdown = [...opAreaMap.values()]
      .sort(sortRank)
      .map(e => ({ operating_area: e.operating_area, pick_qty: e.pick_qty, line_count: e.line_count,
                   location_count: e.locations.size, sku_count: e.skus.size, share_of_picks: share(e.pick_qty) }));

    const itemGroupBreakdown = [...itemGroupMap.values()]
      .sort(sortRank)
      .map(e => ({ item_group: e.item_group, pick_qty: e.pick_qty, line_count: e.line_count,
                   order_count: e.orders.size, sku_count: e.skus.size, share_of_picks: share(e.pick_qty) }));

    const channelBreakdown = [...channelMap.values()]
      .sort(sortRank)
      .map(e => ({ channel: e.channel, label: e.label, pick_qty: e.pick_qty, line_count: e.line_count,
                   order_count: e.orders.size, sku_count: e.skus.size, share_of_picks: share(e.pick_qty) }));

    const channelDetails = {};
    for (const [ch, det] of channelDetailMap) {
      const chTotal = channelMap.get(ch)?.pick_qty || 0;
      const chShare = (v) => chTotal > 0 ? Math.round((v / chTotal) * 10000) / 100 : 0;
      channelDetails[ch] = {
        label: clientChannelLabels[ch] || ch,
        top_skus: [...det.skuMap.values()]
          .sort(sortRank).slice(0, limit)
          .map(e => ({ sku: e.sku, item_group: e.item_group, pick_qty: e.pick_qty,
                       line_count: e.line_count, order_count: e.orders.size,
                       location_count: e.locations.size, share_of_picks: chShare(e.pick_qty) })),
        top_locations: [...det.locationMap.values()]
          .sort(sortRank).slice(0, 100)
          .map(e => {
            let primaryItemGroup = ""; let maxGrpQty = 0;
            for (const [g, q] of e.item_group_picks) { if (q > maxGrpQty) { maxGrpQty = q; primaryItemGroup = g; } }
            return { location: e.location, aisle_prefix: e.aisle_prefix, level: e.level,
                     operating_area: e.operating_area, bin_size: e.bin_size, bin_type: e.bin_type,
                     max_bin_qty: e.max_bin_qty, pick_qty: e.pick_qty, line_count: e.line_count,
                     sku_count: e.skus.size, primary_item_group: primaryItemGroup };
          }),
      };
    }

    const dailyBreakdown = [...dailyMap.values()]
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(e => ({ date: e.date, pick_qty: e.pick_qty, line_count: e.line_count,
                   order_count: e.orders.size, sku_count: e.skus.size }));

    const highLevelSkus = [...skuMap.values()]
      .filter(e => e.high_level_pick_qty > 0)
      .sort((a, b) => b.high_level_pick_qty - a.high_level_pick_qty)
      .slice(0, 50)
      .map(e => ({ sku: e.sku, item_group: e.item_group, high_level_pick_qty: e.high_level_pick_qty,
                   total_pick_qty: e.pick_qty,
                   high_level_share: e.pick_qty > 0 ? Math.round((e.high_level_pick_qty / e.pick_qty) * 10000) / 100 : 0 }));

    const pcCapacityBenchmark = medianNumber(pcCapacityValues);
    const pcZoneNote = !binlocAvail
      ? "PC analysis requires the PI-App to publish warehouse binloc snapshots."
      : emptyPcBinSizeMap.size > 0
        ? "PC recommendations use empty low-level Peak Capacity locations from BINLOC. Capacity is estimated from item dimensions when available, otherwise from the SKU's current low-level bin density."
        : "BINLOC is available, but no empty low-level Peak Capacity locations were found for the selected client.";
    const pcZoneShare = (v) => pcZoneTotalPickQty > 0 ? Math.round((v / pcZoneTotalPickQty) * 10000) / 100 : 0;
    const emptyPcBinSizes = [...emptyPcBinSizeMap.values()]
      .sort((a, b) => b.location_count - a.location_count || String(a.bin_size).localeCompare(String(b.bin_size)));
    const availablePcBinTypes = emptyPcBinSizes.filter(bin => bin.usable_volume_mm3 > 0);

    function estimateSkuUnitVolumeMm3(sku, capacity) {
      const itemDims = itemDimensionMap.get(sku);
      const itemVolume = binSizeVolume(itemDims);
      if (itemVolume > 0) {
        return { unit_volume_mm3: itemVolume, source: "item_dimensions" };
      }
      if (capacity.low_level_non_pc_capacity > 0 && capacity.low_level_non_pc_usable_volume_mm3 > 0) {
        return {
          unit_volume_mm3: capacity.low_level_non_pc_usable_volume_mm3 / capacity.low_level_non_pc_capacity,
          source: "current_bin_density",
        };
      }
      return { unit_volume_mm3: 0, source: "" };
    }

    function scorePcBinOptions(sku, demandQty, currentReplens, capacity) {
      const unitEstimate = estimateSkuUnitVolumeMm3(sku, capacity);
      const options = [];
      for (const bin of availablePcBinTypes) {
        const estimatedCapacity = unitEstimate.unit_volume_mm3 > 0
          ? Math.floor(Number(bin.usable_volume_mm3 || 0) / unitEstimate.unit_volume_mm3)
          : 0;
        if (!(estimatedCapacity > 0)) continue;
        const estimatedReplens = safeCeilDiv(demandQty, estimatedCapacity);
        options.push({
          bin_size: bin.bin_size,
          empty_location_count: bin.location_count,
          estimated_pc_capacity: estimatedCapacity,
          estimated_replenishments_in_pc: estimatedReplens,
          replenishment_delta: (
            currentReplens != null && estimatedReplens != null ? currentReplens - estimatedReplens : null
          ),
          capacity_source: unitEstimate.source,
        });
      }

      options.sort((a, b) =>
        (b.replenishment_delta ?? -999999) - (a.replenishment_delta ?? -999999) ||
        b.estimated_pc_capacity - a.estimated_pc_capacity ||
        b.empty_location_count - a.empty_location_count ||
        String(a.bin_size).localeCompare(String(b.bin_size))
      );
      return options;
    }

    const topPcSkus = [...pcZoneSkuMap.values()]
      .filter(e => e.pc_pick_qty > 0)
      .sort((a, b) => {
        const aMetric = rank === "line_count" ? a.pc_line_count : a.pc_pick_qty;
        const bMetric = rank === "line_count" ? b.pc_line_count : b.pc_pick_qty;
        return bMetric - aMetric || b.pick_qty - a.pick_qty;
      })
      .slice(0, limit)
      .map(e => {
        const capacity = getSkuCapacity(e.sku);
        const currentNonPcReplenishments = estimateReplenishments(
          e.non_pc_pick_qty,
          capacity.low_level_non_pc_capacity,
          { zeroWhenNoDemand: true }
        );
        const totalReplenishmentsWithoutPc = estimateReplenishments(
          e.pick_qty,
          capacity.low_level_non_pc_capacity
        );
        return {
          sku: e.sku,
          item_group: e.item_group,
          total_pick_qty: e.pick_qty,
          total_line_count: e.line_count,
          order_count: e.orders.size,
          pc_pick_qty: e.pc_pick_qty,
          pc_line_count: e.pc_line_count,
          pc_order_count: e.pc_orders.size,
          pc_location_count: e.pc_locations.size,
          low_level_pc_pick_qty: e.low_level_pc_pick_qty,
          low_level_pc_line_count: e.low_level_pc_line_count,
          low_level_pc_order_count: e.low_level_pc_orders.size,
          pc_share_of_sku: roundPct(e.pc_pick_qty, e.pick_qty),
          share_of_total_picks: pcZoneShare(e.pc_pick_qty),
          current_non_pc_pick_qty: e.non_pc_pick_qty,
          low_level_non_pc_capacity: capacity.low_level_non_pc_capacity,
          low_level_non_pc_location_count: capacity.low_level_non_pc_locations.size,
          low_level_pc_capacity: capacity.low_level_pc_capacity,
          low_level_pc_location_count: capacity.low_level_pc_locations.size,
          current_non_pc_replenishments: currentNonPcReplenishments,
          extra_replenishments_if_pc_removed: (
            totalReplenishmentsWithoutPc == null
              ? null
              : Math.max(totalReplenishmentsWithoutPc - (currentNonPcReplenishments ?? 0), 0)
          ),
          total_replenishments_without_pc: totalReplenishmentsWithoutPc,
        };
      });

    const topNonPcSkus = [...pcZoneSkuMap.values()]
      .filter(e => e.low_level_non_pc_pick_qty > 0)
      .map(e => {
        const capacity = getSkuCapacity(e.sku);
        const currentReplens = safeCeilDiv(e.low_level_non_pc_pick_qty, capacity.low_level_non_pc_capacity);
        const binOptions = scorePcBinOptions(e.sku, e.low_level_non_pc_pick_qty, currentReplens, capacity);
        const bestOption = binOptions[0] || null;
        return {
          sku: e.sku,
          item_group: e.item_group,
          total_pick_qty: e.pick_qty,
          total_line_count: e.line_count,
          order_count: e.orders.size,
          share_of_total_picks: pcZoneShare(e.low_level_non_pc_pick_qty),
          low_level_non_pc_pick_qty: e.low_level_non_pc_pick_qty,
          low_level_non_pc_line_count: e.low_level_non_pc_line_count,
          low_level_non_pc_order_count: e.low_level_non_pc_orders.size,
          low_level_non_pc_capacity: capacity.low_level_non_pc_capacity,
          low_level_non_pc_location_count: capacity.low_level_non_pc_locations.size,
          current_bin_sizes: [...capacity.low_level_non_pc_bin_sizes].sort().join(", "),
          current_estimated_replenishments: currentReplens,
          recommended_bin_size: bestOption?.bin_size || "",
          recommended_empty_locations: bestOption?.empty_location_count ?? null,
          recommended_pc_capacity: bestOption?.estimated_pc_capacity ?? null,
          estimated_replenishments_in_pc: bestOption?.estimated_replenishments_in_pc ?? null,
          estimated_replenishments_delta: bestOption?.replenishment_delta ?? null,
          capacity_source: bestOption?.capacity_source || "",
          pc_bin_options: binOptions.slice(0, 5),
        };
      })
      .sort((a, b) => {
        const aImpact = a.estimated_replenishments_delta ?? -999999;
        const bImpact = b.estimated_replenishments_delta ?? -999999;
        return bImpact - aImpact || b.low_level_non_pc_pick_qty - a.low_level_non_pc_pick_qty || a.sku.localeCompare(b.sku);
      })
      .slice(0, limit);

    const peakDay = dailyBreakdown.reduce((best, d) => (!best || d.pick_qty > best.pick_qty) ? d : best, null);

    const avgQtyPerLine  = totalLineCount > 0 ? Math.round((totalPickQty / totalLineCount) * 100) / 100 : 0;
    const avgLinesPerDay = loadedDates.length > 0 ? Math.round((totalLineCount / loadedDates.length) * 10) / 10 : 0;
    const hlShare        = totalPickQty > 0 ? Math.round((highLevelQty / totalPickQty) * 10000) / 100 : 0;

    return res.json({
      ok: true,
      meta: {
        client_code:     client,
        mode:            mode || "latest",
        rank_by:         rank,
        hide_group_147:  hideGroup147,
        limit,
        available_dates: availableDates,
        loaded_dates:    loadedDates,
        missing_dates:   availableDates.filter(d => !loadedDates.includes(d)),
        latest_date:     latestDate,
        date_count:      loadedDates.length,
        binloc_available: binlocAvail,
        channel_labels:  clientChannelLabels,
        pc_zone_channels: [...pcZoneChannelFilter],
        pick_qty_source: pickQtySource,
        pick_transaction_dates_available: trxAvailableDates,
        pick_transaction_dates_loaded: pickTransactionDatesLoaded,
        pick_transaction_dates_missing: pickTransactionDatesMissing,
      },
      summary: {
        total_pick_qty:         totalPickQty,
        total_line_count:       totalLineCount,
        total_order_count:      allOrders.size,
        active_sku_count:       allSkus.size,
        active_location_count:  allLocations.size,
        active_aisle_count:     allAisles.size,
        active_channel_count:   allChannels.size,
        active_item_group_count: allItemGroups.size,
        avg_qty_per_line:       avgQtyPerLine,
        avg_lines_per_day:      avgLinesPerDay,
        peak_day_date:          peakDay?.date || null,
        peak_day_pick_qty:      peakDay?.pick_qty || 0,
        high_level_pick_qty:    highLevelQty,
        high_level_line_count:  highLevelLines,
        high_level_share:       hlShare,
      },
      top_skus:                topSkus,
      top_locations:           topLocations,
      top_aisles:              topAisles,
      high_level_skus:         highLevelSkus,
      level_breakdown:         levelBreakdown,
      bin_size_breakdown:      binSizeBreakdown,
      bin_type_breakdown:      binTypeBreakdown,
      operating_area_breakdown: opAreaBreakdown,
      item_group_breakdown:    itemGroupBreakdown,
      channel_breakdown:       channelBreakdown,
      channel_details:         channelDetails,
      daily_breakdown:         dailyBreakdown,
      replenishment: {
        note: binlocAvail
          ? "Estimates based on BLMAXQ from binloc snapshot."
          : "Operating area, bin type and replenishment estimates require the PI-App to publish warehouse binloc snapshots.",
        locations: replenishmentList,
      },
      pc_zone: {
        note: pcZoneNote,
        channels: [...pcZoneChannelFilter],
        summary: {
          pc_pick_qty: pcZonePcPickQty,
          pc_line_count: pcZonePcLineCount,
          pc_order_count: pcZonePcOrders.size,
          low_level_pc_pick_qty: pcZoneLowLevelPcPickQty,
          low_level_pc_line_count: pcZoneLowLevelPcLineCount,
          non_pc_pick_qty: pcZoneNonPcPickQty,
          non_pc_line_count: pcZoneNonPcLineCount,
          non_pc_order_count: pcZoneNonPcOrders.size,
          low_level_non_pc_pick_qty: pcZoneLowLevelNonPcPickQty,
          low_level_non_pc_line_count: pcZoneLowLevelNonPcLineCount,
          pc_pick_share: roundPct(pcZonePcPickQty, pcZoneTotalPickQty),
          pc_line_share: roundPct(pcZonePcLineCount, pcZoneTotalLineCount),
          pc_sku_count: [...pcZoneSkuMap.values()].filter(e => e.pc_pick_qty > 0).length,
          non_pc_only_sku_count: [...pcZoneSkuMap.values()].filter(e => e.pc_pick_qty <= 0).length,
          pc_active_location_count: pcActiveLocations.size,
          pc_low_level_location_count: pcLowLevelLocationCount,
          pc_low_level_empty_location_count: pcLowLevelEmptyLocationCount,
          pc_low_level_occupied_location_count: pcLowLevelOccupiedLocationCount,
          pc_empty_bin_size_count: emptyPcBinSizes.length,
          pc_capacity_benchmark_units: pcCapacityBenchmark,
          item_dimension_sku_count: itemDimensionMap.size,
        },
        availability: {
          empty_location_count: pcLowLevelEmptyLocationCount,
          occupied_location_count: pcLowLevelOccupiedLocationCount,
          total_low_level_location_count: pcLowLevelLocationCount,
          bin_sizes: emptyPcBinSizes,
          sample_locations: emptyPcLocations,
        },
        top_pc_skus: topPcSkus,
        top_non_pc_skus: topNonPcSkus,
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// API: beta reports data
app.get("/api/beta-reports-data", requireAdminApi, async (req, res) => {
  const { client, mode, date, start, end, channels, pc_zone_channels, compareBy, hide_group_147, hideGroup147: hideGroup147Camel } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 10), 100);
  const compare = compareBy === "month" ? "month" : "week";
  const hideGroup147 = hide_group_147 === "1" || hideGroup147Camel === "1";

  if (!client) return res.status(400).json({ ok: false, error: "client param required." });

  try {
    const availableDates = filterCompleteSnapshotDates(await service.listSnapshotDates("order_lines", client));
    const latestDate = availableDates[0] || null;
    const loadedDates = resolveSnapshotWindowDates(
      availableDates,
      mode || "last_3_months",
      date,
      start,
      end,
      366
    );
    const periods = buildBetaPeriods(loadedDates, compare);
    const periodKeys = periods.map(period => period.key);
    const periodByDate = new Map();
    for (const period of periods) {
      for (const periodDate of period.dates) periodByDate.set(periodDate, period.key);
    }

    const clientChannelLabels = CHANNEL_LABELS[client] || CHANNEL_LABELS.FANDMKET || {};
    const channelFilter = new Set(
      String(channels || "").split(",").map(c => c.trim().toUpperCase()).filter(Boolean)
    );
    const requestedPcZoneChannels = new Set(
      String(pc_zone_channels || "")
        .split(",")
        .map(c => c.trim().toUpperCase())
        .filter(c => PC_ZONE_CHANNELS.has(c))
    );
    const pcZoneChannelFilter = requestedPcZoneChannels.size
      ? requestedPcZoneChannels
      : new Set(PC_ZONE_CHANNELS);

    if (!loadedDates.length) {
      return res.json({
        ok: true,
        meta: {
          client_code: client,
          mode: mode || "last_3_months",
          compare_by: compare,
          limit,
          hide_group_147: hideGroup147,
          available_dates: availableDates,
          loaded_dates: [],
          latest_date: latestDate,
          date_count: 0,
          period_count: 0,
          periods: [],
          channel_labels: clientChannelLabels,
          channels: [...channelFilter],
          pc_zone_channels: [...pcZoneChannelFilter],
          binloc_available: false,
          algorithm_version: "pc-zone-beta-2026-04-22-a",
        },
        summary: {
          total_pick_qty: 0,
          total_line_count: 0,
          active_sku_count: 0,
          pc_pick_qty: 0,
          non_pc_pick_qty: 0,
          pc_pick_share: 0,
          low_level_non_pc_pick_qty: 0,
          latest_period_label: "",
          latest_period_pick_qty: 0,
        },
        signals: {
          action_list: [],
          consistent_candidates: [],
          temporary_candidates: [],
          volatility_watchlist: [],
          pc_review: [],
          repeat_patterns: [],
          new_movers: [],
          declining_skus: [],
          changed_since_previous_day: [],
          weekday_patterns: [],
          spike_sources: [],
        },
        pc_pressure: { bin_sizes: [], conflicts: [] },
        period_breakdown: [],
        sku_period_matrix: [],
      });
    }

    const trxAvailableDates = await service.listSnapshotDates("pick_transactions", client)
      .then(filterCompleteSnapshotDates)
      .catch(() => []);

    const [orderLineResults, pickTransactionResults, binlocResult, catalogResult] = await Promise.all([
      Promise.all(loadedDates.map(d => service.loadSnapshot("order_lines", client, d).catch(() => ({ rows: [] })))),
      Promise.all(loadedDates.map(d =>
        trxAvailableDates.includes(d)
          ? service.loadSnapshot("pick_transactions", client, d).catch(() => ({ rows: [] }))
          : Promise.resolve({ rows: [] })
      )),
      service.loadSnapshot("binloc", client, null).catch(() => ({ rows: [] })),
      service.loadCatalogSnapshot(client).catch(() => ({ snapshot: null, meta: null })),
    ]);

    const targetClient = normalizeClientCode(client);
    const rawBinlocRows = binlocResult.rows || [];
    const binlocAvail = rawBinlocRows.length > 0;
    const catalogMetaMap = buildCatalogItemMetaMap(catalogResult?.snapshot);
    const itemDimensionMap = buildCatalogDimensionMap(catalogResult?.snapshot);
    const configuredBinSizes = getConfiguredBinSizes();
    const emptyPcBinSizeMap = new Map();
    const enrichMap = new Map();
    const skuInventoryMap = new Map();

    function initSkuInventory() {
      return {
        low_level_non_pc_capacity: 0,
        low_level_pc_capacity: 0,
        low_level_non_pc_usable_volume_mm3: 0,
        low_level_pc_usable_volume_mm3: 0,
        low_level_non_pc_locations: new Set(),
        low_level_pc_locations: new Set(),
        low_level_non_pc_bin_sizes: new Set(),
        low_level_pc_bin_sizes: new Set(),
      };
    }

    function getSkuInventory(sku) {
      if (!skuInventoryMap.has(sku)) skuInventoryMap.set(sku, initSkuInventory());
      return skuInventoryMap.get(sku);
    }

    function getSkuMeta(sku) {
      const normalizedSku = String(sku || "").trim().toUpperCase();
      return catalogMetaMap.get(normalizedSku) || {
        sku: normalizedSku,
        description: "",
        sku_label: normalizedSku,
      };
    }

    function getOrInit(map, key, init) {
      if (!map.has(key)) map.set(key, init());
      return map.get(key);
    }

    function addEmptyPcBin(row, loc, binSize, binType, binDims, binUsableVolume) {
      const key = binSize || "-";
      const entry = emptyPcBinSizeMap.get(key) || {
        bin_size: key,
        bin_type: binType,
        empty_location_count: 0,
        dimensions_configured: Boolean(binDims),
        height_mm: binDims ? binDims.height : null,
        width_mm: binDims ? binDims.width : null,
        depth_mm: binDims ? binDims.depth : null,
        usable_volume_mm3: binUsableVolume || null,
        example_locations: [],
      };
      entry.empty_location_count++;
      if (entry.example_locations.length < 8) entry.example_locations.push(loc);
      emptyPcBinSizeMap.set(key, entry);
    }

    for (const row of rawBinlocRows) {
      const loc = getBinlocLocation(row);
      if (!loc) continue;
      const rowClientCode = getBinlocRowClientCode(row);
      if (rowClientCode && rowClientCode !== targetClient) continue;

      const operatingArea = normalizeOperatingArea(row.BLWOPA || row.operating_area);
      const binSize = getBinlocBinSize(row);
      const binType = normalizeBinType(row.BLBKPK || row.bin_type || "");
      const maxBinQty = Number(row.BLMAXQ || row.max_bin_qty || 0);
      const levelNum = getLocationLevelNumber(loc);
      const isPc = isPcOperatingArea(operatingArea);
      const status = String(row.BLSTS || row.status || "Y").trim().toUpperCase();
      const currentQty = Number(row.BLQTY || row.qty || row["Item Qty"] || 0);
      const adjustedQty = Number(row.BLADJQ || row.item_adjust || 0);
      const pickedQty = Number(row.BLPICQ || row.item_picked || 0);
      const kitQty = Number(row.BLKITQ || 0);
      const isEmptyLocation = currentQty <= 0 && adjustedQty <= 0 && pickedQty <= 0 && kitQty <= 0;
      const binDims = configuredBinSizes[binSize] || null;
      const binUsableVolume = usableBinVolume(binDims);

      enrichMap.set(loc, {
        operating_area: operatingArea || "-",
        bin_size: binSize || "-",
        bin_type: binType,
        max_bin_qty: maxBinQty,
        is_pc: isPc,
        level_num: levelNum,
      });

      if (status === "Y" && isPc && levelNum < HIGH_LEVEL_THRESHOLD && isEmptyLocation) {
        addEmptyPcBin(row, loc, binSize, binType, binDims, binUsableVolume);
      }

      const sku = String(row.BLITEM || row.sku || "").trim().toUpperCase();
      if (!sku || levelNum >= HIGH_LEVEL_THRESHOLD) continue;

      const inv = getSkuInventory(sku);
      if (isPc) {
        inv.low_level_pc_capacity += maxBinQty;
        inv.low_level_pc_usable_volume_mm3 += binUsableVolume;
        inv.low_level_pc_locations.add(loc);
        if (binSize) inv.low_level_pc_bin_sizes.add(binSize);
      } else {
        inv.low_level_non_pc_capacity += maxBinQty;
        inv.low_level_non_pc_usable_volume_mm3 += binUsableVolume;
        inv.low_level_non_pc_locations.add(loc);
        if (binSize) inv.low_level_non_pc_bin_sizes.add(binSize);
      }
    }

    const skuMap = new Map();
    const periodMap = new Map(periods.map(period => [period.key, {
      key: period.key,
      label: period.label,
      start: period.start,
      end: period.end,
      date_count: period.dates.length,
      pick_qty: 0,
      line_count: 0,
      pc_pick_qty: 0,
      non_pc_pick_qty: 0,
      low_level_non_pc_pick_qty: 0,
      orders: new Set(),
      skus: new Set(),
      sku_qty: new Map(),
    }]));

    let totalPickQty = 0;
    let totalLineCount = 0;
    let pcPickQty = 0;
    let nonPcPickQty = 0;
    let lowLevelNonPcPickQty = 0;
    const activeSkus = new Set();

    function getBetaSku(sku, grp) {
      if (!skuMap.has(sku)) {
        skuMap.set(sku, {
          sku,
          item_group: grp || "",
          pick_qty: 0,
          line_count: 0,
          pc_pick_qty: 0,
          non_pc_pick_qty: 0,
          low_level_pc_pick_qty: 0,
          low_level_non_pc_pick_qty: 0,
          orders: new Set(),
          locations: new Set(),
          pc_locations: new Set(),
          non_pc_locations: new Set(),
          channels: new Set(),
          active_days: new Set(),
          daily_qty: new Map(),
          weekday_qty: new Map(),
          weekday_lines: new Map(),
          order_qty: new Map(),
          customer_qty: new Map(),
          period_qty: new Map(),
          period_lines: new Map(),
          period_orders: new Map(),
          period_order_qty: new Map(),
          channel_breakdown: new Map(),
          location_breakdown: new Map(),
        });
      }
      const entry = skuMap.get(sku);
      if (!entry.item_group && grp) entry.item_group = grp;
      return entry;
    }

    for (let di = 0; di < loadedDates.length; di++) {
      const snapDate = loadedDates[di];
      const periodKey = periodByDate.get(snapDate);
      const periodEntry = periodMap.get(periodKey);
      const useTransactions = trxAvailableDates.includes(snapDate);
      const activityRows = buildReportActivityRows(
        orderLineResults[di]?.rows || [],
        pickTransactionResults[di]?.rows || [],
        snapDate,
        { useTransactions }
      );

      for (const row of activityRows) {
        const ch = String(row.order_channel || "").trim().toUpperCase();
        if (!pcZoneChannelFilter.has(ch)) continue;
        if (channelFilter.size && !channelFilter.has(ch)) continue;

        const sku = String(row.item || "").trim().toUpperCase();
        const qty = Number(row.pick_qty || 0);
        if (!sku || !(qty > 0)) continue;

        const grp = String(row.item_group || "").trim();
        if (hideGroup147 && grp === "147") continue;

        const loc = String(row.picking_location || "").trim().toUpperCase();
        const enrich = enrichMap.get(loc) || {
          operating_area: "-",
          bin_size: "-",
          bin_type: "Unknown",
          max_bin_qty: 0,
          is_pc: false,
          level_num: getLocationLevelNumber(loc),
        };
        const levelNum = enrich.level_num || getLocationLevelNumber(loc);
        const isLowLevel = levelNum < HIGH_LEVEL_THRESHOLD;
        const isPc = Boolean(enrich.is_pc);
        const ord = String(row.order_number || "").trim();
        const customer = String(row.customer_name || "").trim();
        const snapDateObj = ymdToUtcDate(snapDate);
        const weekday = snapDateObj ? snapDateObj.getUTCDay() : null;

        totalPickQty += qty;
        totalLineCount++;
        activeSkus.add(sku);
        if (isPc) pcPickQty += qty;
        else nonPcPickQty += qty;
        if (isLowLevel && !isPc) lowLevelNonPcPickQty += qty;

        const skuEntry = getBetaSku(sku, grp);
        skuEntry.pick_qty += qty;
        skuEntry.line_count++;
        if (isPc) {
          skuEntry.pc_pick_qty += qty;
          if (loc) skuEntry.pc_locations.add(loc);
          if (isLowLevel) skuEntry.low_level_pc_pick_qty += qty;
        } else {
          skuEntry.non_pc_pick_qty += qty;
          if (loc) skuEntry.non_pc_locations.add(loc);
          if (isLowLevel) skuEntry.low_level_non_pc_pick_qty += qty;
        }
        if (ord) skuEntry.orders.add(ord);
        if (loc) skuEntry.locations.add(loc);
        if (ch) skuEntry.channels.add(ch);
        skuEntry.active_days.add(snapDate);
        skuEntry.daily_qty.set(snapDate, (skuEntry.daily_qty.get(snapDate) || 0) + qty);
        if (weekday !== null) {
          skuEntry.weekday_qty.set(weekday, (skuEntry.weekday_qty.get(weekday) || 0) + qty);
          skuEntry.weekday_lines.set(weekday, (skuEntry.weekday_lines.get(weekday) || 0) + 1);
        }
        if (ord) skuEntry.order_qty.set(ord, (skuEntry.order_qty.get(ord) || 0) + qty);
        if (customer) skuEntry.customer_qty.set(customer, (skuEntry.customer_qty.get(customer) || 0) + qty);
        if (ch) {
          const channelEntry = getOrInit(skuEntry.channel_breakdown, ch, () => ({
            channel: ch,
            label: clientChannelLabels[ch] || ch,
            pick_qty: 0,
            line_count: 0,
            orders: new Set(),
          }));
          channelEntry.pick_qty += qty;
          channelEntry.line_count++;
          if (ord) channelEntry.orders.add(ord);
        }
        if (loc) {
          const locEntry = getOrInit(skuEntry.location_breakdown, loc, () => ({
            location: loc,
            operating_area: enrich.operating_area,
            bin_size: enrich.bin_size,
            bin_type: enrich.bin_type,
            max_bin_qty: enrich.max_bin_qty,
            level_num: levelNum,
            is_pc: isPc,
            pick_qty: 0,
            line_count: 0,
            orders: new Set(),
          }));
          locEntry.pick_qty += qty;
          locEntry.line_count++;
          if (ord) locEntry.orders.add(ord);
        }
        skuEntry.period_qty.set(periodKey, (skuEntry.period_qty.get(periodKey) || 0) + qty);
        skuEntry.period_lines.set(periodKey, (skuEntry.period_lines.get(periodKey) || 0) + 1);
        if (!skuEntry.period_orders.has(periodKey)) skuEntry.period_orders.set(periodKey, new Set());
        if (ord) skuEntry.period_orders.get(periodKey).add(ord);
        if (ord) {
          const periodOrderMap = getOrInit(skuEntry.period_order_qty, periodKey, () => new Map());
          periodOrderMap.set(ord, (periodOrderMap.get(ord) || 0) + qty);
        }

        if (periodEntry) {
          periodEntry.pick_qty += qty;
          periodEntry.line_count++;
          if (isPc) periodEntry.pc_pick_qty += qty;
          else periodEntry.non_pc_pick_qty += qty;
          if (isLowLevel && !isPc) periodEntry.low_level_non_pc_pick_qty += qty;
          if (ord) periodEntry.orders.add(ord);
          periodEntry.skus.add(sku);
          periodEntry.sku_qty.set(sku, (periodEntry.sku_qty.get(sku) || 0) + qty);
        }
      }
    }

    function serializeInventory(sku) {
      const inv = skuInventoryMap.get(sku) || initSkuInventory();
      return {
        low_level_non_pc_capacity: inv.low_level_non_pc_capacity,
        low_level_pc_capacity: inv.low_level_pc_capacity,
        low_level_non_pc_usable_volume_mm3: inv.low_level_non_pc_usable_volume_mm3,
        low_level_pc_usable_volume_mm3: inv.low_level_pc_usable_volume_mm3,
        low_level_non_pc_location_count: inv.low_level_non_pc_locations.size,
        low_level_pc_location_count: inv.low_level_pc_locations.size,
        current_bin_sizes: [...inv.low_level_non_pc_bin_sizes].sort().join(", "),
        pc_bin_sizes: [...inv.low_level_pc_bin_sizes].sort().join(", "),
      };
    }

    const latestPeriodKey = periodKeys[periodKeys.length - 1] || "";
    const previousPeriodKey = periodKeys[periodKeys.length - 2] || "";
    const loadedDatesAscending = [...loadedDates].sort();
    const latestLoadedDate = loadedDatesAscending[loadedDatesAscending.length - 1] || "";
    const previousLoadedDate = loadedDatesAscending[loadedDatesAscending.length - 2] || "";
    const availablePcBinTypes = [...emptyPcBinSizeMap.values()]
      .filter(bin => Number(bin.usable_volume_mm3 || 0) > 0)
      .sort((a, b) =>
        Number(b.empty_location_count || 0) - Number(a.empty_location_count || 0) ||
        String(a.bin_size).localeCompare(String(b.bin_size))
      );
    const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

    function estimateSkuUnitVolumeMm3(sku, inventory) {
      const itemDims = itemDimensionMap.get(sku);
      const itemVolume = binSizeVolume(itemDims);
      if (itemVolume > 0) {
        return { unit_volume_mm3: itemVolume, capacity_source: "item_dimensions" };
      }
      if (inventory.low_level_non_pc_capacity > 0 && inventory.low_level_non_pc_usable_volume_mm3 > 0) {
        return {
          unit_volume_mm3: inventory.low_level_non_pc_usable_volume_mm3 / inventory.low_level_non_pc_capacity,
          capacity_source: "current_bin_density",
        };
      }
      if (inventory.low_level_pc_capacity > 0 && inventory.low_level_pc_usable_volume_mm3 > 0) {
        return {
          unit_volume_mm3: inventory.low_level_pc_usable_volume_mm3 / inventory.low_level_pc_capacity,
          capacity_source: "pc_bin_density",
        };
      }
      return { unit_volume_mm3: 0, capacity_source: "" };
    }

    function scorePcBinOptions(sku, demandQty, currentReplens, inventory) {
      const unitEstimate = estimateSkuUnitVolumeMm3(sku, inventory);
      const options = [];
      for (const bin of availablePcBinTypes) {
        const estimatedCapacity = unitEstimate.unit_volume_mm3 > 0
          ? Math.floor(Number(bin.usable_volume_mm3 || 0) / unitEstimate.unit_volume_mm3)
          : 0;
        if (!(estimatedCapacity > 0)) continue;
        const estimatedReplens = safeCeilDiv(demandQty, estimatedCapacity);
        options.push({
          bin_size: bin.bin_size,
          empty_location_count: bin.empty_location_count,
          estimated_pc_capacity: estimatedCapacity,
          estimated_replenishments_in_pc: estimatedReplens,
          estimated_replenishments_delta: (
            currentReplens != null && estimatedReplens != null ? currentReplens - estimatedReplens : null
          ),
          estimated_pc_locations_needed: estimatedCapacity > 0 ? Math.max(1, safeCeilDiv(demandQty, estimatedCapacity) || 1) : null,
          capacity_source: unitEstimate.capacity_source,
        });
      }
      options.sort((a, b) =>
        (b.estimated_replenishments_delta ?? -999999) - (a.estimated_replenishments_delta ?? -999999) ||
        b.estimated_pc_capacity - a.estimated_pc_capacity ||
        b.empty_location_count - a.empty_location_count ||
        String(a.bin_size).localeCompare(String(b.bin_size))
      );
      return options;
    }

    function confidenceLabel(score) {
      if (score >= 75) return "High";
      if (score >= 50) return "Medium";
      return "Low";
    }

    const skuRows = [...skuMap.values()].map(entry => {
      const periodValues = periodKeys.map(key => Number(entry.period_qty.get(key) || 0));
      const nonZeroValues = periodValues.filter(value => value > 0);
      const activePeriodCount = nonZeroValues.length;
      const activePeriodRatio = periodKeys.length ? activePeriodCount / periodKeys.length : 0;
      const avgPeriodPickQty = meanNumber(periodValues);
      const stdevPeriodPickQty = standardDeviation(periodValues);
      const volatilityIndex = avgPeriodPickQty > 0 ? stdevPeriodPickQty / avgPeriodPickQty : 0;
      const latestPeriodQty = Number(entry.period_qty.get(latestPeriodKey) || 0);
      const previousPeriodQty = Number(entry.period_qty.get(previousPeriodKey) || 0);
      const baselineValues = periodKeys.slice(0, Math.max(periodKeys.length - 1, 0)).map(key => Number(entry.period_qty.get(key) || 0));
      const baselineAvgPeriodQty = meanNumber(baselineValues);
      const maxPeriodQty = Math.max(0, ...periodValues);
      const pcShare = roundPct(entry.pc_pick_qty, entry.pick_qty);
      const inventory = serializeInventory(entry.sku);
      const currentReplens = safeCeilDiv(entry.low_level_non_pc_pick_qty, inventory.low_level_non_pc_capacity);
      const lowCvScore = Math.max(0, 1 - Math.min(volatilityIndex, 1.6) / 1.6);
      const volumeScore = Math.min(entry.pick_qty / 500, 1);
      const orderRepeatScore = Math.min(entry.orders.size / 40, 1);
      const consistencyScore = Math.round(
        (activePeriodRatio * 42) + (lowCvScore * 32) + (volumeScore * 20) + (orderRepeatScore * 6)
      );
      const denominator = Math.max(baselineAvgPeriodQty, 1);
      const spikeRatio = latestPeriodQty > 0 ? latestPeriodQty / denominator : 0;
      const spikeScore = Math.round(
        (Math.max(0, Math.min(spikeRatio - 1, 6)) * 17) +
        (Math.min(latestPeriodQty / 120, 1) * 28) +
        ((1 - activePeriodRatio) * 22) +
        ((1 - Math.min(pcShare, 100) / 100) * 10)
      );
      const volatilityScore = Math.round(
        (Math.min(volatilityIndex / 1.7, 1) * 55) +
        ((Math.min(maxPeriodQty / Math.max(avgPeriodPickQty, 1), 5) / 5) * 20) +
        (Math.min(entry.pick_qty / 500, 1) * 25)
      );
      const skuMeta = getSkuMeta(entry.sku);
      const latestDayQty = Number(entry.daily_qty.get(latestLoadedDate) || 0);
      const previousDayQty = Number(entry.daily_qty.get(previousLoadedDate) || 0);
      const dayChangeQty = latestDayQty - previousDayQty;
      const dayChangePct = previousDayQty > 0 ? roundNumber((dayChangeQty / previousDayQty) * 100, 1) : (latestDayQty > 0 ? 100 : 0);
      const latestOrderMap = entry.period_order_qty.get(latestPeriodKey) || new Map();
      const latestOrderValues = [...latestOrderMap.entries()].sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0));
      const largestLatestOrder = latestOrderValues[0] || ["", 0];
      const largestLatestOrderShare = latestPeriodQty > 0 ? roundPct(largestLatestOrder[1], latestPeriodQty) : 0;
      const spikeSource = latestPeriodQty > 0 && spikeRatio >= 2
        ? (largestLatestOrderShare >= 50 ? "single_order" : (latestOrderValues.slice(0, 3).reduce((sum, row) => sum + Number(row[1] || 0), 0) / latestPeriodQty >= 0.75 ? "few_orders" : "broad_demand"))
        : "none";
      const spikeSourceLabel = spikeSource === "single_order"
        ? `Single order ${largestLatestOrder[0]} drove ${largestLatestOrderShare}% of latest period`
        : spikeSource === "few_orders"
          ? "A small number of orders drove the latest spike"
          : spikeSource === "broad_demand"
            ? "Spike appears spread across multiple orders"
            : "";
      const channelBreakdown = [...entry.channel_breakdown.values()]
        .sort((a, b) => b.pick_qty - a.pick_qty || String(a.channel).localeCompare(String(b.channel)))
        .map(channel => ({
          channel: channel.channel,
          label: channel.label,
          pick_qty: channel.pick_qty,
          line_count: channel.line_count,
          order_count: channel.orders.size,
          share_of_sku: roundPct(channel.pick_qty, entry.pick_qty),
        }));
      const primaryChannel = channelBreakdown[0] || null;
      const locationBreakdown = [...entry.location_breakdown.values()]
        .sort((a, b) => b.pick_qty - a.pick_qty || String(a.location).localeCompare(String(b.location)))
        .slice(0, 20)
        .map(location => ({
          location: location.location,
          operating_area: location.operating_area,
          bin_size: location.bin_size,
          bin_type: location.bin_type,
          max_bin_qty: location.max_bin_qty,
          level_num: location.level_num,
          is_pc: location.is_pc,
          pick_qty: location.pick_qty,
          line_count: location.line_count,
          order_count: location.orders.size,
        }));
      const weekdayBreakdown = [...entry.weekday_qty.entries()]
        .map(([weekday, qty]) => ({
          weekday: Number(weekday),
          label: weekdayNames[Number(weekday)] || String(weekday),
          pick_qty: qty,
          line_count: entry.weekday_lines.get(weekday) || 0,
          share_of_sku: roundPct(qty, entry.pick_qty),
        }))
        .sort((a, b) => b.pick_qty - a.pick_qty || a.weekday - b.weekday);
      const primaryWeekday = weekdayBreakdown[0] || null;
      const isNewMover = periodKeys.length >= 3 && latestPeriodQty > 0 && baselineAvgPeriodQty <= Math.max(10, latestPeriodQty * 0.35) && activePeriodCount <= Math.max(2, Math.ceil(periodKeys.length * 0.45));
      const declineRatio = baselineAvgPeriodQty > 0 ? latestPeriodQty / baselineAvgPeriodQty : 1;
      const isDeclining = entry.pc_pick_qty > 0 && periodKeys.length >= 2 && latestPeriodQty < previousPeriodQty && declineRatio <= 0.6;
      const declineScore = isDeclining ? Math.round((1 - Math.max(0, declineRatio)) * 70 + Math.min(entry.pc_pick_qty / 200, 1) * 30) : 0;
      const pcBinOptions = scorePcBinOptions(entry.sku, entry.low_level_non_pc_pick_qty, currentReplens, inventory);
      const bestPcBinOption = pcBinOptions[0] || null;
      const estimatedReplensDelta = bestPcBinOption?.estimated_replenishments_delta ?? null;
      const pickTransactionCoverage = loadedDates.length ? loadedDates.filter(d => trxAvailableDates.includes(d)).length / loadedDates.length : 0;
      const confidenceScore = Math.round(
        (Math.min(periodKeys.length / 8, 1) * 20) +
        (pickTransactionCoverage * 25) +
        (activePeriodRatio * 20) +
        (Math.min(entry.pick_qty / 400, 1) * 15) +
        (binlocAvail ? 10 : 0) +
        ((bestPcBinOption?.capacity_source || itemDimensionMap.has(entry.sku)) ? 10 : 0)
      );
      const reasonParts = [];
      if (activePeriodCount > 0) reasonParts.push(`Active in ${activePeriodCount}/${periodKeys.length || 1} ${compare === "month" ? "months" : "weeks"}`);
      if (entry.low_level_non_pc_pick_qty > 0) reasonParts.push(`${entry.low_level_non_pc_pick_qty.toLocaleString()} picks below level 20 outside PC`);
      if (estimatedReplensDelta != null && estimatedReplensDelta > 0) reasonParts.push(`${estimatedReplensDelta.toLocaleString()} fewer estimated replenishments in ${bestPcBinOption.bin_size}`);
      if (spikeRatio >= 2) reasonParts.push(`${roundNumber(spikeRatio, 1)}x latest-period spike`);
      if (primaryChannel) reasonParts.push(`${primaryChannel.share_of_sku}% ${primaryChannel.label}`);
      if (primaryWeekday && primaryWeekday.share_of_sku >= 45) reasonParts.push(`${primaryWeekday.share_of_sku}% picked on ${primaryWeekday.label}s`);
      if (isDeclining) reasonParts.push("Latest period is materially below baseline");

      let recommendationType = "Watch only";
      if (isDeclining && entry.pc_pick_qty > 0 && consistencyScore < 60) {
        recommendationType = "Remove from PC";
      } else if (entry.pc_pick_qty > 0 && consistencyScore >= 60 && volatilityScore < 70) {
        recommendationType = "Keep in PC";
      } else if (entry.low_level_non_pc_pick_qty > 0 && isNewMover) {
        recommendationType = "Temporary PC";
      } else if (entry.low_level_non_pc_pick_qty > 0 && spikeScore >= 70 && consistencyScore < 68) {
        recommendationType = "Temporary PC";
      } else if (entry.low_level_non_pc_pick_qty > 0 && consistencyScore >= 65) {
        recommendationType = "Move to PC";
      }

      const recommendationRank = {
        "Move to PC": 5,
        "Temporary PC": 4,
        "Keep in PC": 3,
        "Remove from PC": 2,
        "Watch only": 1,
      }[recommendationType] || 1;
      const actionPriorityScore = Math.round(
        (recommendationRank * 12) +
        (consistencyScore * 0.26) +
        (spikeScore * 0.18) +
        (volatilityScore * 0.08) +
        (Math.min(Math.max(estimatedReplensDelta || 0, 0), 20) * 1.4) +
        (confidenceScore * 0.18)
      );

      return {
        sku: entry.sku,
        sku_label: skuMeta.sku_label,
        description: skuMeta.description,
        item_group: entry.item_group,
        total_pick_qty: entry.pick_qty,
        total_line_count: entry.line_count,
        order_count: entry.orders.size,
        location_count: entry.locations.size,
        pc_pick_qty: entry.pc_pick_qty,
        non_pc_pick_qty: entry.non_pc_pick_qty,
        low_level_pc_pick_qty: entry.low_level_pc_pick_qty,
        low_level_non_pc_pick_qty: entry.low_level_non_pc_pick_qty,
        pc_share: pcShare,
        active_day_count: entry.active_days.size,
        active_period_count: activePeriodCount,
        active_period_share: roundNumber(activePeriodRatio * 100, 1),
        avg_period_pick_qty: roundNumber(avgPeriodPickQty, 2),
        stdev_period_pick_qty: roundNumber(stdevPeriodPickQty, 2),
        volatility_index: roundNumber(volatilityIndex, 3),
        latest_period_qty: latestPeriodQty,
        previous_period_qty: previousPeriodQty,
        baseline_avg_period_qty: roundNumber(baselineAvgPeriodQty, 2),
        max_period_qty: maxPeriodQty,
        spike_ratio: roundNumber(spikeRatio, 2),
        spike_source: spikeSource,
        spike_source_label: spikeSourceLabel,
        largest_latest_order_number: largestLatestOrder[0],
        largest_latest_order_qty: Number(largestLatestOrder[1] || 0),
        largest_latest_order_share: largestLatestOrderShare,
        latest_day_qty: latestDayQty,
        previous_day_qty: previousDayQty,
        day_change_qty: dayChangeQty,
        day_change_pct: dayChangePct,
        consistency_score: Math.max(0, Math.min(consistencyScore, 100)),
        spike_score: Math.max(0, Math.min(spikeScore, 100)),
        volatility_score: Math.max(0, Math.min(volatilityScore, 100)),
        confidence_score: Math.max(0, Math.min(confidenceScore, 100)),
        confidence_label: confidenceLabel(confidenceScore),
        recommendation_type: recommendationType,
        recommendation_reason: reasonParts.slice(0, 5).join("; "),
        recommendation_reasons: reasonParts,
        action_priority_score: Math.max(0, Math.min(actionPriorityScore, 100)),
        is_new_mover: isNewMover,
        is_declining: isDeclining,
        decline_score: Math.max(0, Math.min(declineScore, 100)),
        current_estimated_replenishments: currentReplens,
        recommended_bin_size: bestPcBinOption?.bin_size || "",
        recommended_empty_locations: bestPcBinOption?.empty_location_count ?? null,
        recommended_pc_capacity: bestPcBinOption?.estimated_pc_capacity ?? null,
        estimated_replenishments_in_pc: bestPcBinOption?.estimated_replenishments_in_pc ?? null,
        estimated_replenishments_delta: estimatedReplensDelta,
        estimated_pc_locations_needed: bestPcBinOption?.estimated_pc_locations_needed ?? null,
        capacity_source: bestPcBinOption?.capacity_source || "",
        pc_bin_options: pcBinOptions.slice(0, 5),
        period_values: periodKeys.map((key, index) => ({
          key,
          label: periods[index]?.label || key,
          pick_qty: Number(entry.period_qty.get(key) || 0),
          line_count: Number(entry.period_lines.get(key) || 0),
          order_count: entry.period_orders.get(key)?.size || 0,
        })),
        channel_count: entry.channels.size,
        channels: [...entry.channels].sort(),
        channel_breakdown: channelBreakdown,
        primary_channel: primaryChannel?.channel || "",
        primary_channel_label: primaryChannel?.label || "",
        primary_channel_share: primaryChannel?.share_of_sku || 0,
        location_breakdown: locationBreakdown,
        weekday_breakdown: weekdayBreakdown,
        primary_weekday: primaryWeekday?.label || "",
        primary_weekday_share: primaryWeekday?.share_of_sku || 0,
        ...inventory,
      };
    });

    const bySignal = (field, fallback = "total_pick_qty") => (a, b) =>
      Number(b[field] || 0) - Number(a[field] || 0) ||
      Number(b[fallback] || 0) - Number(a[fallback] || 0) ||
      String(a.sku).localeCompare(String(b.sku));

    const consistentCandidates = skuRows
      .filter(row => row.low_level_non_pc_pick_qty > 0 && row.active_period_count >= Math.min(3, periodKeys.length || 3))
      .map(row => ({
        ...row,
        signal_score: Math.round(
          (row.consistency_score * 0.58) +
          (Math.min(row.low_level_non_pc_pick_qty / 300, 1) * 24) +
          ((1 - Math.min(row.pc_share, 100) / 100) * 18)
        ),
      }))
      .sort(bySignal("signal_score"))
      .slice(0, limit);

    const temporaryCandidates = skuRows
      .filter(row => row.low_level_non_pc_pick_qty > 0 && row.latest_period_qty > 0)
      .map(row => ({
        ...row,
        signal_score: Math.round(
          (row.spike_score * 0.62) +
          (Math.min(row.low_level_non_pc_pick_qty / 220, 1) * 22) +
          ((1 - Math.min(row.pc_share, 100) / 100) * 16)
        ),
      }))
      .sort(bySignal("signal_score", "latest_period_qty"))
      .slice(0, limit);

    const volatilityWatchlist = skuRows
      .filter(row => row.total_pick_qty > 0)
      .sort(bySignal("volatility_score"))
      .slice(0, limit);

    const pcReview = skuRows
      .filter(row => row.pc_pick_qty > 0)
      .map(row => ({
        ...row,
        signal_score: Math.round(
          ((100 - row.consistency_score) * 0.45) +
          (row.volatility_score * 0.35) +
          (Math.min(row.pc_pick_qty / 250, 1) * 20)
        ),
      }))
      .sort(bySignal("signal_score", "pc_pick_qty"))
      .slice(0, limit);

    const repeatPatterns = skuRows
      .filter(row => row.active_period_count >= Math.min(3, periodKeys.length || 3))
      .sort((a, b) =>
        b.active_period_count - a.active_period_count ||
        b.consistency_score - a.consistency_score ||
        b.total_pick_qty - a.total_pick_qty ||
        a.sku.localeCompare(b.sku)
      )
      .slice(0, limit);

    const actionList = skuRows
      .filter(row => row.recommendation_type && row.recommendation_type !== "Watch only")
      .sort((a, b) =>
        b.action_priority_score - a.action_priority_score ||
        b.confidence_score - a.confidence_score ||
        b.total_pick_qty - a.total_pick_qty ||
        a.sku.localeCompare(b.sku)
      )
      .slice(0, limit);

    const newMovers = skuRows
      .filter(row => row.is_new_mover)
      .sort((a, b) =>
        b.latest_period_qty - a.latest_period_qty ||
        b.spike_score - a.spike_score ||
        a.sku.localeCompare(b.sku)
      )
      .slice(0, limit);

    const decliningSkus = skuRows
      .filter(row => row.is_declining)
      .sort((a, b) =>
        b.decline_score - a.decline_score ||
        b.pc_pick_qty - a.pc_pick_qty ||
        a.sku.localeCompare(b.sku)
      )
      .slice(0, limit);

    const changedSincePreviousDay = skuRows
      .filter(row => row.latest_day_qty > 0 || row.previous_day_qty > 0)
      .sort((a, b) =>
        Math.abs(b.day_change_qty) - Math.abs(a.day_change_qty) ||
        b.latest_day_qty - a.latest_day_qty ||
        a.sku.localeCompare(b.sku)
      )
      .slice(0, limit);

    const weekdayPatterns = skuRows
      .filter(row => row.primary_weekday_share >= 45 && row.active_day_count >= 2)
      .sort((a, b) =>
        b.primary_weekday_share - a.primary_weekday_share ||
        b.total_pick_qty - a.total_pick_qty ||
        a.sku.localeCompare(b.sku)
      )
      .slice(0, limit);

    const spikeSources = skuRows
      .filter(row => row.spike_source && row.spike_source !== "none")
      .sort((a, b) =>
        b.spike_score - a.spike_score ||
        b.latest_period_qty - a.latest_period_qty ||
        a.sku.localeCompare(b.sku)
      )
      .slice(0, limit);

    const pcPressureMap = new Map();
    for (const bin of emptyPcBinSizeMap.values()) {
      pcPressureMap.set(bin.bin_size, {
        bin_size: bin.bin_size,
        bin_type: bin.bin_type,
        empty_location_count: bin.empty_location_count,
        candidate_count: 0,
        action_candidate_count: 0,
        estimated_locations_needed: 0,
        total_candidate_pick_qty: 0,
        top_candidates: [],
        example_locations: bin.example_locations,
      });
    }
    for (const row of skuRows.filter(row => row.recommended_bin_size)) {
      const pressure = getOrInit(pcPressureMap, row.recommended_bin_size, () => ({
        bin_size: row.recommended_bin_size,
        bin_type: "",
        empty_location_count: row.recommended_empty_locations || 0,
        candidate_count: 0,
        action_candidate_count: 0,
        estimated_locations_needed: 0,
        total_candidate_pick_qty: 0,
        top_candidates: [],
        example_locations: [],
      }));
      pressure.candidate_count++;
      if (row.recommendation_type !== "Watch only") pressure.action_candidate_count++;
      pressure.estimated_locations_needed += Number(row.estimated_pc_locations_needed || 1);
      pressure.total_candidate_pick_qty += Number(row.low_level_non_pc_pick_qty || 0);
      if (pressure.top_candidates.length < 8) {
        pressure.top_candidates.push({
          sku: row.sku,
          sku_label: row.sku_label,
          recommendation_type: row.recommendation_type,
          low_level_non_pc_pick_qty: row.low_level_non_pc_pick_qty,
          estimated_locations_needed: row.estimated_pc_locations_needed,
        });
      }
    }
    const pcPressureRows = [...pcPressureMap.values()]
      .map(row => ({
        ...row,
        pressure_ratio: row.empty_location_count > 0
          ? roundNumber(row.estimated_locations_needed / row.empty_location_count, 2)
          : (row.estimated_locations_needed > 0 ? 999 : 0),
        oversubscribed_by: Math.max(Number(row.estimated_locations_needed || 0) - Number(row.empty_location_count || 0), 0),
      }))
      .sort((a, b) =>
        b.pressure_ratio - a.pressure_ratio ||
        b.total_candidate_pick_qty - a.total_candidate_pick_qty ||
        String(a.bin_size).localeCompare(String(b.bin_size))
      );
    const pcPressureConflicts = pcPressureRows.filter(row => row.oversubscribed_by > 0 || row.action_candidate_count > row.empty_location_count);

    const periodBreakdown = [...periodMap.values()].map(period => {
      const topSkus = [...period.sku_qty.entries()]
        .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0) || String(a[0]).localeCompare(String(b[0])))
        .slice(0, 10)
        .map(([sku, qty]) => {
          const skuMeta = getSkuMeta(sku);
          return {
            sku,
            sku_label: skuMeta.sku_label,
            description: skuMeta.description,
            pick_qty: qty,
          };
        });
      const topSku = topSkus[0]?.sku || "";
      const topSkuMeta = getSkuMeta(topSku);
      return {
        key: period.key,
        label: period.label,
        start: period.start,
        end: period.end,
        date_count: period.date_count,
        pick_qty: period.pick_qty,
        line_count: period.line_count,
        order_count: period.orders.size,
        sku_count: period.skus.size,
        pc_pick_qty: period.pc_pick_qty,
        non_pc_pick_qty: period.non_pc_pick_qty,
        low_level_non_pc_pick_qty: period.low_level_non_pc_pick_qty,
        pc_share: roundPct(period.pc_pick_qty, period.pick_qty),
        top_sku: topSku,
        top_sku_label: topSkuMeta.sku_label,
        top_sku_description: topSkuMeta.description,
        top_sku_qty: topSkus[0]?.pick_qty || 0,
        top_skus: topSkus,
      };
    });

    const skuPeriodMatrix = skuRows
      .slice()
      .sort((a, b) => b.total_pick_qty - a.total_pick_qty || a.sku.localeCompare(b.sku))
      .slice(0, limit)
      .map(row => ({
        sku: row.sku,
        sku_label: row.sku_label,
        description: row.description,
        item_group: row.item_group,
        total_pick_qty: row.total_pick_qty,
        consistency_score: row.consistency_score,
        volatility_index: row.volatility_index,
        latest_period_qty: row.latest_period_qty,
        period_values: row.period_values,
      }));

    return res.json({
      ok: true,
      meta: {
        client_code: client,
        mode: mode || "last_3_months",
        compare_by: compare,
        limit,
        hide_group_147: hideGroup147,
        available_dates: availableDates,
        loaded_dates: loadedDates,
        latest_date: latestDate,
        date_count: loadedDates.length,
        period_count: periods.length,
        periods,
        channel_labels: clientChannelLabels,
        channels: [...channelFilter],
        pc_zone_channels: [...pcZoneChannelFilter],
        binloc_available: binlocAvail,
        pick_transaction_dates_available: trxAvailableDates,
        pick_transaction_dates_loaded: loadedDates.filter(d => trxAvailableDates.includes(d)),
        algorithm_version: "pc-zone-beta-2026-04-22-a",
      },
      summary: {
        total_pick_qty: totalPickQty,
        total_line_count: totalLineCount,
        active_sku_count: activeSkus.size,
        pc_pick_qty: pcPickQty,
        non_pc_pick_qty: nonPcPickQty,
        pc_pick_share: roundPct(pcPickQty, totalPickQty),
        low_level_non_pc_pick_qty: lowLevelNonPcPickQty,
        latest_period_label: periods[periods.length - 1]?.label || "",
        latest_period_pick_qty: periodMap.get(latestPeriodKey)?.pick_qty || 0,
      },
      signals: {
        action_list: actionList,
        consistent_candidates: consistentCandidates,
        temporary_candidates: temporaryCandidates,
        volatility_watchlist: volatilityWatchlist,
        pc_review: pcReview,
        repeat_patterns: repeatPatterns,
        new_movers: newMovers,
        declining_skus: decliningSkus,
        changed_since_previous_day: changedSincePreviousDay,
        weekday_patterns: weekdayPatterns,
        spike_sources: spikeSources,
      },
      pc_pressure: {
        bin_sizes: pcPressureRows,
        conflicts: pcPressureConflicts,
      },
      period_breakdown: periodBreakdown,
      sku_period_matrix: skuPeriodMatrix,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.get("/api/empty-bin/live", requireAdminApi, async (req, res) => {
  const client = EMPTY_BIN_CLIENT_CODE;
  const reportDate = normalizeReportDate(req.query.date || req.query.report_date);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 25), 1000);
  try {
    const [live, dayContext] = await Promise.all([
      loadEmptyBinLiveIndex(client),
      loadEmptyBinDayContext(client, reportDate),
    ]);
    const optionRows = filterEmptyBinRows(live.rows, req.query, {
      client,
      dayContext,
      includeAreaFilters: false,
    });
    const filteredRows = filterEmptyBinRows(live.rows, req.query, { client, dayContext });
    return res.json({
      ok: true,
      meta: {
        client,
        report_date: reportDate,
        snapshot_date: live.meta?.snapshot_date || "",
        source_synced_at: live.meta?.source_synced_at || live.meta?.uploaded_at || "",
        row_count: live.rows.length,
        from_cache: live.fromCache,
        filters: buildEmptyBinFilterOptions(optionRows),
        day_source: {
          type: "binloc_last_move_out_or_pick_transactions",
          pick_transaction_row_count: dayContext.pick_transaction_meta?.row_count ?? null,
          pick_transaction_locations: dayContext.transaction_locations.size,
          pick_transaction_from_cache: dayContext.pick_transaction_from_cache,
          pick_transaction_error: dayContext.pick_transaction_error,
        },
      },
      summary: {
        empty_count: filteredRows.length,
        returned_count: Math.min(filteredRows.length, limit),
      },
      rows: filteredRows.slice(0, limit),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.get("/api/empty-bin/tasks", requireAdminApi, (req, res) => {
  const client = EMPTY_BIN_CLIENT_CODE;
  const tasks = emptyBinTaskStore.listTasks({ client }).map(summarizeEmptyBinTask);
  return res.json({ ok: true, tasks });
});

app.post("/api/empty-bin/tasks", requireAdminApi, async (req, res) => {
  const client = EMPTY_BIN_CLIENT_CODE;
  const type = req.body?.type === "move_pallets" ? "move_pallets" : "empty_check";
  const title = String(req.body?.title || "").trim();
  const limit = Math.min(Math.max(parseInt(req.body?.limit, 10) || 200, 25), 1000);
  const filters = req.body?.filters && typeof req.body.filters === "object" ? req.body.filters : {};
  const reportDate = normalizeReportDate(req.body?.report_date || filters.date || filters.report_date);
  const requestedLocations = Array.isArray(req.body?.locations)
    ? req.body.locations.map(normalizeEmptyBinLocation).filter(Boolean)
    : [];

  try {
    const [live, dayContext] = await Promise.all([
      loadEmptyBinLiveIndex(client),
      loadEmptyBinDayContext(client, reportDate),
    ]);
    let rows;
    if (requestedLocations.length) {
      rows = requestedLocations
        .map(location => live.liveByLocation.get(location))
        .filter(row => row && row.live_empty)
        .filter(row => getEmptyBinDateReason(row, dayContext))
        .map(row => ({ ...row, report_date: reportDate, source_reason: getEmptyBinDateReason(row, dayContext), last_transaction: dayContext.last_transactions.get(row.location) || null }));
    } else {
      rows = filterEmptyBinRows(live.rows, { ...filters, date: reportDate }, { client, dayContext }).slice(0, limit);
    }

    if (!rows.length) {
      return res.status(400).json({ ok: false, error: "No FANDMKET locations that went empty on this date are still empty in BINLOC." });
    }

    const task = emptyBinTaskStore.createTask({
      client,
      type,
      title: title || `Daily empty bin check ${reportDate}`,
      createdBy: req.currentUser,
      filters: requestedLocations.length
        ? { selected_locations: requestedLocations, report_date: reportDate }
        : { ...filters, report_date: reportDate },
      snapshotMeta: { ...(live.meta || {}), report_date: reportDate, day_source: "binloc_last_move_out_or_pick_transactions" },
      items: rows,
    });
    return res.json({ ok: true, task: summarizeEmptyBinTask(task), full_task: task });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.get("/api/empty-bin/tasks/:taskId", requireAdminApi, async (req, res) => {
  try {
    const refreshed = await refreshEmptyBinTask(req.params.taskId);
    if (!refreshed) return res.status(404).json({ ok: false, error: "Task not found." });
    return res.json({
      ok: true,
      task: refreshed.task,
      summary: summarizeEmptyBinTask(refreshed.task),
      live_meta: refreshed.live_meta,
      live_filters: refreshed.live_filters,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.post("/api/empty-bin/tasks/:taskId/assign", requireAdminApi, (req, res) => {
  const task = emptyBinTaskStore.assignTask(req.params.taskId, req.currentUser);
  if (!task) return res.status(404).json({ ok: false, error: "Task not found." });
  return res.json({ ok: true, task, summary: summarizeEmptyBinTask(task) });
});

app.post("/api/empty-bin/tasks/:taskId/drop", requireAdminApi, (req, res) => {
  const task = emptyBinTaskStore.dropTask(req.params.taskId, req.currentUser);
  if (!task) return res.status(404).json({ ok: false, error: "Task not found." });
  return res.json({ ok: true, task, summary: summarizeEmptyBinTask(task) });
});

app.post("/api/empty-bin/tasks/:taskId/complete", requireAdminApi, (req, res) => {
  const task = emptyBinTaskStore.completeTask(req.params.taskId, req.currentUser);
  if (!task) return res.status(404).json({ ok: false, error: "Task not found." });
  return res.json({ ok: true, task, summary: summarizeEmptyBinTask(task) });
});

app.post("/api/empty-bin/tasks/:taskId/create-followup", requireAdminApi, async (req, res) => {
  try {
    const refreshed = await refreshEmptyBinTask(req.params.taskId);
    if (!refreshed) return res.status(404).json({ ok: false, error: "Task not found." });
    const task = refreshed.task;
    const items = (task.items || [])
      .filter(item => ["checked_empty", "empty_pallet", "move_required"].includes(item.status))
      .filter(item => item.live?.live_empty !== false)
      .map(item => item.live || item);
    if (!items.length) {
      return res.status(400).json({ ok: false, error: "No checked empty locations still need a follow-up move task." });
    }
    const followup = emptyBinTaskStore.createTask({
      client: task.client,
      type: "move_pallets",
      title: req.body?.title || `Bring pallets for ${task.title}`,
      createdBy: req.currentUser,
      sourceTaskId: task.id,
      filters: { source_task_id: task.id },
      snapshotMeta: refreshed.live_meta || {},
      items,
    });
    return res.json({ ok: true, task: summarizeEmptyBinTask(followup), full_task: followup });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.post("/api/empty-bin/tasks/:taskId/locations/:location/check", requireAdminApi, (req, res) => {
  const action = String(req.body?.action || req.body?.status || "").trim();
  const statusMap = {
    empty: "checked_empty",
    checked_empty: "checked_empty",
    not_empty: "checked_not_empty",
    checked_not_empty: "checked_not_empty",
    empty_pallet: "empty_pallet",
    needs_move: "move_required",
    move_required: "move_required",
    moved: "moved",
    skipped: "skipped",
    cannot_complete: "cannot_complete",
  };
  const status = statusMap[action];
  if (!status) return res.status(400).json({ ok: false, error: "Valid check action required." });

  try {
    let task = emptyBinTaskStore.updateLocation(req.params.taskId, req.params.location, {
      status,
      result: status,
      note: req.body?.note,
      user: req.currentUser,
    });
    if (!task) return res.status(404).json({ ok: false, error: "Task or location not found." });

    let photo = null;
    if (req.body?.image_data_url) {
      const saved = emptyBinTaskStore.savePhotoFromDataUrl(req.params.taskId, req.params.location, req.body.image_data_url, req.currentUser);
      task = saved.task || task;
      photo = saved.photo;
    }

    return res.json({ ok: true, task, summary: summarizeEmptyBinTask(task), photo });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.get("/api/empty-bin/photos/:fileName", requireAdminPage, (req, res) => {
  const filePath = emptyBinTaskStore.photoPath(req.params.fileName);
  if (!fs.existsSync(filePath)) return res.status(404).send("Not found");
  return res.sendFile(filePath);
});

// Admin page
app.get("/admin", requireAdminPage, (_req, res) => {
  res.render("admin", { clientChoices: CLIENT_CHOICES });
});

// API: admin active bin size dimensions
app.get("/api/admin/bin-sizes", requireAdminApi, async (req, res) => {
  const client = normalizeClientCode(req.query.client || DEFAULT_CLIENT);
  try {
    const configuredBinSizes = getConfiguredBinSizes();
    const { rows: rawRows = [], meta, fromCache } = await service.loadSnapshot("binloc", client, null);
    const activeBySize = new Map();

    let activeLocationCount = 0;
    let activeLocationsWithoutSize = 0;

    for (const row of rawRows) {
      const rowClientCode = getBinlocRowClientCode(row);
      if (rowClientCode && rowClientCode !== client) continue;

      const status = String(row.BLSTS || row.status || "Y").trim().toUpperCase();
      if (status && status !== "Y") continue;

      const location = getBinlocLocation(row);
      if (!location) continue;

      activeLocationCount++;

      const binSize = getBinlocBinSize(row);
      if (!binSize) activeLocationsWithoutSize++;

      const key = binSize || "__blank__";
      const entry = activeBySize.get(key) || {
        bin_size: binSize,
        label: binSize || "Unspecified",
        location_count: 0,
        example_locations: [],
      };
      entry.location_count++;
      if (entry.example_locations.length < 8) entry.example_locations.push(location);
      activeBySize.set(key, entry);
    }

    const rows = [...activeBySize.values()]
      .map(entry => {
        const dims = configuredBinSizes[entry.bin_size] || null;
        const volume = dims ? dims.height * dims.width * dims.depth : null;
        return {
          ...entry,
          dimensions_configured: Boolean(dims),
          height_mm: dims ? dims.height : null,
          width_mm:  dims ? dims.width  : null,
          depth_mm:  dims ? dims.depth  : null,
          volume_mm3: volume,
          usable_volume_mm3: volume ? Math.round(volume * 0.8) : null,
        };
      })
      .sort((a, b) => {
        if (!a.bin_size && b.bin_size) return 1;
        if (a.bin_size && !b.bin_size) return -1;
        return String(a.bin_size || "").localeCompare(String(b.bin_size || ""));
      });

    const configuredActiveCount = rows.filter(row => row.dimensions_configured).length;

    return res.json({
      ok: true,
      client,
      meta,
      fromCache,
      summary: {
        active_location_count: activeLocationCount,
        active_bin_size_count: rows.length,
        configured_active_bin_size_count: configuredActiveCount,
        missing_active_bin_size_count: rows.length - configuredActiveCount,
        active_locations_without_bin_size: activeLocationsWithoutSize,
        configured_bin_size_count: Object.keys(configuredBinSizes).length,
        default_bin_size_count: Object.keys(DEFAULT_BIN_SIZES).length,
        tracker_overrides_loaded: Boolean(LAYOUT_OVERRIDES),
      },
      rows,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ── API: admin status ─────────────────────────────────────────────────────
app.put("/api/admin/bin-sizes/:code", requireAdminApi, (req, res) => {
  const code = normalizeBinSizeCode(req.params.code);
  if (!code || !/^[A-Z0-9_-]{1,20}$/.test(code)) {
    return res.status(400).json({ ok: false, error: "Valid bin size code required." });
  }

  const dimensions = normalizeBinSizeDimensions(req.body || {});
  if (!dimensions) {
    return res.status(400).json({ ok: false, error: "Height, width and depth must be positive mm values." });
  }

  try {
    const saved = saveConfiguredBinSize(code, dimensions);
    const volume = saved.height * saved.width * saved.depth;
    return res.json({
      ok: true,
      bin_size: code,
      height_mm: saved.height,
      width_mm: saved.width,
      depth_mm: saved.depth,
      volume_mm3: volume,
      usable_volume_mm3: Math.round(volume * 0.8),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.get("/api/admin/status", requireAdminApi, async (req, res) => {
  const uptime  = process.uptime();
  const cacheEntries = [...service.cache.entries()].map(([key, val]) => ({
    key,
    rows:      val.rows ? val.rows.length : 0,
    loadedAt:  new Date(val.loadedAt).toISOString(),
    ageSeconds: Math.round((Date.now() - val.loadedAt) / 1000),
  }));

  // Test PocketBase connectivity
  let pbOk = false;
  let pbError = null;
  try {
    await service.pb.authenticateAdmin(true);
    pbOk = true;
  } catch (err) {
    pbError = String(err.message || err);
  }

  return res.json({
    ok: true,
    uptime:       Math.round(uptime),
    uptimeHuman:  formatUptime(uptime),
    pocketbase:   { ok: pbOk, error: pbError, url: config.pocketbaseUrl },
    cache:        cacheEntries,
    nodeVersion:  process.version,
    appName:      config.appName,
  });
});

// ── API: admin snapshot debug ─────────────────────────────────────────────
app.get("/api/admin/debug-snapshot", requireAdminApi, async (req, res) => {
  const { client, date, collection } = req.query;
  const col = collection || "pick_activity";
  if (!client) return res.status(400).json({ ok: false, error: "client param required." });
  try {
    const { rows, meta, fromCache } = await service.loadSnapshot(col, client, date || null);
    return res.json({
      ok:        true,
      collection: col,
      client,
      date:      date || "(latest)",
      fromCache,
      rowCount:  rows.length,
      meta,
      sampleRows: rows.slice(0, 3),
      firstRowKeys: rows[0] ? Object.keys(rows[0]) : [],
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ── API: admin snapshot dates (all collections) ───────────────────────────
app.get("/api/admin/snapshot-summary", requireAdminApi, async (req, res) => {
  const results = {};
    for (const client of CLIENT_CHOICES.map(c => c.code)) {
      results[client] = {};
      for (const col of ["pick_activity", "order_lines", "pick_transactions", "binloc"]) {
        try {
          const dates = await service.listSnapshotDates(col, client);
          results[client][col] = { count: dates.length, latest: dates[0] || null, oldest: dates[dates.length - 1] || null };
        } catch (err) {
          results[client][col] = { error: String(err.message || err) };
      }
    }
  }
  return res.json({ ok: true, summary: results });
});

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, `${s}s`].filter(Boolean).join(" ");
}

// ── Error handler ─────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error("[repo-app] Unhandled error:", err);
  const status = err.status || err.statusCode || 500;
  if (req.accepts("html")) {
    return res.status(status).render("error", { error: { status, message: err.message || "Something went wrong." } });
  }
  return res.status(status).json({ ok: false, error: err.message || "Internal error." });
});

// ── Start ─────────────────────────────────────────────────────────────────
async function startServer() {
  await new Promise((resolve, reject) => {
    app.listen(config.port, config.host, (err) => {
      if (err) return reject(err);
      console.log(`[repo-app] Listening on http://${config.host}:${config.port}`);
      resolve();
    });
  });
}

module.exports = { app, startServer };
