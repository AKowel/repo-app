"use strict";
const path    = require("path");
const fs      = require("fs");
const express = require("express");
const session = require("express-session");
const { config }          = require("./config");
const { formatDateYMD }   = require("./helpers");
const { SnapshotService } = require("./snapshotService");

// ── Layout files (itemtracker data dir) ──────────────────────────────────────
const ITEMTRACKER_DATA = path.join(__dirname, "..", "..", "itemtracker", "server", "data");

function loadJsonFile(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

const FANDM_LAYOUT     = loadJsonFile(path.join(ITEMTRACKER_DATA, "fandm-layout-v4.7.json"));
const LAYOUT_OVERRIDES = loadJsonFile(path.join(ITEMTRACKER_DATA, "layout-overrides.json"));
const ASSET_VERSION    = String(Date.now());

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

function getBinlocLocation(row) {
  return String(row?.BLBINL || row?.bin_location || row?.location || "").trim().toUpperCase();
}

function getBinlocRowClientCode(row) {
  return normalizeClientCode(row?.BLCCOD || row?.client_code || row?.Client);
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

// ── Service singleton ─────────────────────────────────────────────────────
const service = new SnapshotService({
  pocketbaseUrl:  config.pocketbaseUrl,
  adminEmail:     config.pocketbaseAdminEmail,
  adminPassword:  config.pocketbaseAdminPassword,
});

// ── Express app ───────────────────────────────────────────────────────────
const app = express();

if (config.trustProxy) app.set("trust proxy", 1);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

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
      bin_sizes = LAYOUT_OVERRIDES?.bin_sizes || {};
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
  const { client, date, customer, channel, item_group, q } = req.query;
  if (!client) return res.status(400).json({ ok: false, error: "client param required." });
  try {
    const availableDates = filterCompleteSnapshotDates(await service.listSnapshotDates("order_lines", client));
    const selectedDate = availableDates.includes(String(date || "").trim())
      ? String(date || "").trim()
      : (availableDates[0] || null);

    if (!selectedDate) {
      return res.json({
        ok: true,
        rows: [],
        meta: null,
        fromCache: false,
        totalRows: 0,
        filterOptions: { channels: [], item_groups: [] },
      });
    }

    const { rows: allRows, meta, fromCache } = await service.loadSnapshot("order_lines", client, selectedDate);

    let rows = allRows;
    if (q)          { const ql = q.toLowerCase();   rows = rows.filter(r => String(r.order_number || "").toLowerCase().includes(ql) || String(r.item || "").toLowerCase().includes(ql) || String(r.customer_name || "").toLowerCase().includes(ql)); }
    if (customer)   { const cl = customer.toLowerCase(); rows = rows.filter(r => String(r.customer_name || "").toLowerCase().includes(cl)); }
    if (channel)    { rows = rows.filter(r => String(r.order_channel || "").toLowerCase() === channel.toLowerCase()); }
    if (item_group) { rows = rows.filter(r => String(r.item_group || "").toLowerCase() === item_group.toLowerCase()); }

    // Build distinct filter options from ALL rows (not filtered)
    const channels    = [...new Set(allRows.map(r => r.order_channel).filter(Boolean))].sort();
    const item_groups = [...new Set(allRows.map(r => r.item_group).filter(Boolean))].sort();

    return res.json({ ok: true, rows, meta, fromCache, totalRows: allRows.length, filterOptions: { channels, item_groups } });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
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
  const { client, entity, value, mode, date, start, end, channels } = req.query;
  const targetEntity = entity === "location" ? "location" : (entity === "sku" ? "sku" : "");
  const targetValue  = targetEntity === "location"
    ? String(value || "").trim().toUpperCase()
    : String(value || "").trim().toUpperCase();

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

    const matchingOrderLines = [];
    const matchingOrderKeys  = new Set();
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

        matchingOrderLines.push(normalizedRow);
        matchingOrderKeys.add(buildOrderItemKey(normalizedRow.order_number, normalizedRow.item));
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

        const matchesTarget = targetEntity === "location"
          ? location === targetValue && matchingOrderKeys.has(orderItemKey)
          : sku === targetValue && matchingOrders.has(orderNumber);

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
        });
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
      for (const row of matchingOrderLines) {
        const loc = row.picking_location;
        const entry = locationBreakdownMap.get(loc) || { location: loc, pick_qty: 0, line_count: 0, orders: new Set() };
        entry.pick_qty += Number(row.pick_qty || 0);
        entry.line_count += 1;
        if (row.order_number) entry.orders.add(row.order_number);
        locationBreakdownMap.set(loc, entry);
      }
    } else {
      for (const row of matchingOrderLines) {
        const sku = row.item;
        const entry = skuBreakdownMap.get(sku) || {
          sku,
          item_group: row.item_group || "",
          pick_qty: 0,
          line_count: 0,
          orders: new Set(),
          customers: new Set(),
        };
        entry.pick_qty += Number(row.pick_qty || 0);
        entry.line_count += 1;
        if (row.order_number) entry.orders.add(row.order_number);
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

    const totalPickQty = matchingOrderLines.reduce((sum, row) => sum + Number(row.pick_qty || 0), 0);
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

// ── API: reports data ─────────────────────────────────────────────────────
app.get("/api/reports-data", requireAdminApi, async (req, res) => {
  const { client, mode, date, start, end, channels, rankBy } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 10), 100);
  const rank  = (rankBy === "line_count") ? "line_count" : "pick_qty";

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
            non_pc_pick_qty: 0,
            non_pc_line_count: 0,
            non_pc_order_count: 0,
            pc_pick_share: 0,
            pc_line_share: 0,
            pc_sku_count: 0,
            non_pc_only_sku_count: 0,
            pc_active_location_count: 0,
            pc_capacity_benchmark_units: 0,
          },
          top_pc_skus: [],
          top_non_pc_skus: [],
        },
      });
    }

    // ── Step 2: Load in parallel ──────────────────────────────────────────
    const [orderLineResults, binlocResult] = await Promise.all([
      Promise.all(loadedDates.map(d => service.loadSnapshot("order_lines", client, d).catch(() => ({ rows: [] })))),
      service.loadSnapshot("binloc", client, null).catch(() => ({ rows: [] })),
    ]);

    const rawBinlocRows  = binlocResult.rows || [];
    const binlocAvail    = rawBinlocRows.length > 0;
    const targetClient   = normalizeClientCode(client);

    // ── Step 3: Location enrichment map + SKU capacity model ──────────────
    const FALLBACK_ENRICH = { bin_size: "—", operating_area: "—", max_bin_qty: 0, bin_type: "Unknown", is_pc: false };
    const pickedLocations = new Set();
    for (const snapshot of orderLineResults) {
      for (const row of (snapshot?.rows || [])) {
        const loc = String(row.picking_location || "").trim().toUpperCase();
        if (loc) pickedLocations.add(loc);
      }
    }

    const enrichMap = new Map();
    const skuCapacityMap = new Map();
    const pcCapacityValues = [];
    const pcActiveLocations = new Set();

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
      if (isPcArea && levelNum < HIGH_LEVEL_THRESHOLD && maxBinQty > 0) {
        pcCapacityValues.push(maxBinQty);
        pcActiveLocations.add(loc);
      }

      const sku = String(row.BLITEM || row.sku || "").trim().toUpperCase();
      if (!sku) continue;

      if (!skuCapacityMap.has(sku)) {
        skuCapacityMap.set(sku, {
          low_level_non_pc_capacity: 0,
          low_level_pc_capacity: 0,
          low_level_non_pc_locations: new Set(),
          low_level_pc_locations: new Set(),
        });
      }

      const skuCapacity = skuCapacityMap.get(sku);
      if (levelNum >= HIGH_LEVEL_THRESHOLD) continue;

      if (isPcArea) {
        skuCapacity.low_level_pc_capacity += maxBinQty;
        skuCapacity.low_level_pc_locations.add(loc);
      } else {
        skuCapacity.low_level_non_pc_capacity += maxBinQty;
        skuCapacity.low_level_non_pc_locations.add(loc);
      }
    }

    // ── Step 3.5: Client-specific channel labels ──────────────────────────
    const clientChannelLabels = CHANNEL_LABELS[client] || CHANNEL_LABELS.FANDMKET || {};

    // ── Step 4: Channel filter ────────────────────────────────────────────
    const channelFilter = new Set(
      (channels || "").split(",").map(c => c.trim().toUpperCase()).filter(Boolean)
    );

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

    let totalPickQty    = 0, totalLineCount = 0;
    let highLevelQty    = 0, highLevelLines = 0;
    let pcPickQty       = 0, pcLineCount = 0;
    let nonPcPickQty    = 0, nonPcLineCount = 0;

    const allOrders     = new Set();
    const allSkus       = new Set();
    const allLocations  = new Set();
    const allAisles     = new Set();
    const allChannels   = new Set();
    const allItemGroups = new Set();
    const pcOrders      = new Set();
    const nonPcOrders   = new Set();

    function getOrInit(map, key, init) {
      if (!map.has(key)) map.set(key, init());
      return map.get(key);
    }

    for (let di = 0; di < loadedDates.length; di++) {
      const snapDate = loadedDates[di];
      const rows     = orderLineResults[di]?.rows || [];

      for (const row of rows) {
        const ch = String(row.order_channel || "").trim().toUpperCase();
        if (channelFilter.size > 0 && !channelFilter.has(ch)) continue;

        const sku      = String(row.item           || "").trim().toUpperCase();
        const loc      = String(row.picking_location || "").trim().toUpperCase();
        const grp      = String(row.item_group      || "").trim();
        const ord      = String(row.order_number    || "").trim();
        const qty      = Number(row.pick_qty        || row.qty_fulfilled || 0);
        const parts    = parseLocationCode(loc);
        const pfx      = parts.aisle_prefix;
        const levelNum = parseInt(parts.level, 10) || 0;
        const isHigh   = levelNum >= HIGH_LEVEL_THRESHOLD;
        const enrich   = enrichMap.get(loc) || FALLBACK_ENRICH;
        const isPcArea = Boolean(enrich.is_pc);

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
      low_level_non_pc_locations: new Set(),
      low_level_pc_locations: new Set(),
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
      .map(e => ({ sku: e.sku, high_level_pick_qty: e.high_level_pick_qty,
                   total_pick_qty: e.pick_qty,
                   high_level_share: e.pick_qty > 0 ? Math.round((e.high_level_pick_qty / e.pick_qty) * 10000) / 100 : 0 }));

    const pcCapacityBenchmark = medianNumber(pcCapacityValues);
    const pcZoneNote = !binlocAvail
      ? "PC analysis requires the PI-App to publish warehouse binloc snapshots."
      : pcCapacityBenchmark > 0
        ? `What-if PC estimates use the median active PC max bin qty from binloc (${Math.round(pcCapacityBenchmark).toLocaleString()} units) as the assumed single PC slot capacity.`
        : "BINLOC is available, but no active PC locations with max bin quantity were found for the selected client.";

    const topPcSkus = [...skuMap.values()]
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
          total_pick_qty: e.pick_qty,
          total_line_count: e.line_count,
          order_count: e.orders.size,
          pc_pick_qty: e.pc_pick_qty,
          pc_line_count: e.pc_line_count,
          pc_order_count: e.pc_orders.size,
          pc_location_count: e.pc_locations.size,
          pc_share_of_sku: roundPct(e.pc_pick_qty, e.pick_qty),
          share_of_total_picks: share(e.pc_pick_qty),
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

    const topNonPcSkus = [...skuMap.values()]
      .filter(e => e.pc_pick_qty <= 0)
      .sort(sortRank)
      .slice(0, limit)
      .map(e => {
        const capacity = getSkuCapacity(e.sku);
        const currentReplens = safeCeilDiv(e.pick_qty, capacity.low_level_non_pc_capacity);
        const pcReplens = safeCeilDiv(e.pick_qty, pcCapacityBenchmark);
        return {
          sku: e.sku,
          total_pick_qty: e.pick_qty,
          total_line_count: e.line_count,
          order_count: e.orders.size,
          share_of_total_picks: share(e.pick_qty),
          low_level_non_pc_capacity: capacity.low_level_non_pc_capacity,
          low_level_non_pc_location_count: capacity.low_level_non_pc_locations.size,
          current_estimated_replenishments: currentReplens,
          pc_capacity_benchmark_units: pcCapacityBenchmark,
          estimated_replenishments_in_pc: pcReplens,
          estimated_replenishments_delta: (
            currentReplens != null && pcReplens != null ? currentReplens - pcReplens : null
          ),
        };
      });

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
        limit,
        available_dates: availableDates,
        loaded_dates:    loadedDates,
        missing_dates:   availableDates.filter(d => !loadedDates.includes(d)),
        latest_date:     latestDate,
        date_count:      loadedDates.length,
        binloc_available: binlocAvail,
        channel_labels:  clientChannelLabels,
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
        summary: {
          pc_pick_qty: pcPickQty,
          pc_line_count: pcLineCount,
          pc_order_count: pcOrders.size,
          non_pc_pick_qty: nonPcPickQty,
          non_pc_line_count: nonPcLineCount,
          non_pc_order_count: nonPcOrders.size,
          pc_pick_share: roundPct(pcPickQty, totalPickQty),
          pc_line_share: roundPct(pcLineCount, totalLineCount),
          pc_sku_count: [...skuMap.values()].filter(e => e.pc_pick_qty > 0).length,
          non_pc_only_sku_count: [...skuMap.values()].filter(e => e.pc_pick_qty <= 0).length,
          pc_active_location_count: pcActiveLocations.size,
          pc_capacity_benchmark_units: pcCapacityBenchmark,
        },
        top_pc_skus: topPcSkus,
        top_non_pc_skus: topNonPcSkus,
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ── Admin page ────────────────────────────────────────────────────────────
app.get("/admin", requireAdminPage, (_req, res) => {
  res.render("admin", { clientChoices: CLIENT_CHOICES });
});

// ── API: admin status ─────────────────────────────────────────────────────
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
