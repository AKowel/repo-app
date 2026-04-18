"use strict";
const path    = require("path");
const fs      = require("fs");
const express = require("express");
const session = require("express-session");
const { config }          = require("./config");
const { SnapshotService } = require("./snapshotService");

// ── Layout files (itemtracker data dir) ──────────────────────────────────────
const ITEMTRACKER_DATA = path.join(__dirname, "..", "..", "itemtracker", "server", "data");

function loadJsonFile(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

const FANDM_LAYOUT    = loadJsonFile(path.join(ITEMTRACKER_DATA, "fandm-layout-v4.7.json"));
const LAYOUT_OVERRIDES = loadJsonFile(path.join(ITEMTRACKER_DATA, "layout-overrides.json"));

const CLIENT_CHOICES = [
  { code: "FANDMKET", name: "Fortnum & Mason" },
  { code: "WESTLAND",  name: "Westland" },
];

const DEFAULT_CLIENT = "FANDMKET";

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
    const dates = await service.listSnapshotDates(collection, client);
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
    const availableDates = await service.listSnapshotDates("pick_activity", client);
    const latestDate = availableDates[0] || null;

    const selectedDate = (mode === "date" && date) ? date : latestDate;

    let rows = [], snapshotMeta = {};
    if (selectedDate) {
      const result = await service.loadSnapshot("pick_activity", client, selectedDate);
      rows = result.rows;
      snapshotMeta = result.meta || {};
    }

    // Use the real F&M layout manifest + edited overrides for FANDMKET;
    // fall back to auto-generating from aisle prefixes for other clients.
    let layout, overrides, bin_sizes;
    if (client === "FANDMKET" && FANDM_LAYOUT) {
      layout    = FANDM_LAYOUT;
      overrides = LAYOUT_OVERRIDES || {};
      bin_sizes = LAYOUT_OVERRIDES?.bin_sizes || {};
    } else {
      const aisles = [...new Set(rows.map(r => r.aisle_prefix).filter(Boolean))].sort();
      layout    = { zones: [{ zone_key: "zone_1", zone_label: "Warehouse", aisles: aisles.map(prefix => ({ prefix })) }] };
      overrides = {};
      bin_sizes = {};
    }

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
      heatmap: { rows, layout, overrides, bin_sizes, meta: heatmapMeta, stats: {} }
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
    const { rows: allRows, meta, fromCache } = await service.loadSnapshot("order_lines", client, date || null);

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
    const { rows: allRows, meta, fromCache } = await service.loadSnapshot("pick_transactions", client, date || null);
    const rows = allRows.filter(r =>
      String(r.BTORDN || "").trim() === String(order_number).trim() &&
      String(r.BAITEM || "").trim() === String(item).trim()
    );
    return res.json({ ok: true, rows, meta, fromCache });
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
    for (const col of ["pick_activity", "order_lines", "pick_transactions"]) {
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
