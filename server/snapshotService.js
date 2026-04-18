"use strict";
const zlib = require("zlib");
const { PocketBaseClient, PocketBaseError } = require("./pocketbaseClient");
const { pbLiteral, todayYMD } = require("./helpers");

const COLLECTIONS = {
  pick_activity:    "warehouse_pick_activity_snapshots",
  order_lines:      "warehouse_order_line_snapshots",
  pick_transactions:"warehouse_pick_transaction_snapshots",
};

// TTLs in milliseconds
const TTL_TODAY_MS    = 5  * 60 * 1000;   // 5 min — PI-App may re-publish today
const TTL_HISTORIC_MS = 4  * 60 * 60 * 1000; // 4 hr — historical data is immutable

class SnapshotService {
  constructor({ pocketbaseUrl, adminEmail, adminPassword }) {
    this.pb    = new PocketBaseClient({ baseUrl: pocketbaseUrl, adminEmail, adminPassword });
    this.cache = new Map();
  }

  // ── Auth helpers ──────────────────────────────────────────────────────────

  isAdminUser(record) {
    return record && record.role === "admin";
  }

  serializeUser(record) {
    return {
      id:      record.id,
      email:   record.email   || "",
      name:    record.name    || record.email || "",
      role:    record.role    || "user",
      isAdmin: this.isAdminUser(record),
    };
  }

  async authenticateUser(email, password) {
    const result = await this.pb.authWithPassword("users", email, password);
    if (!result || !result.record) {
      throw new PocketBaseError("Authentication failed.", 401);
    }
    return this.serializeUser(result.record);
  }

  async getUser(userId) {
    const record = await this.pb.getRecord("users", userId);
    return this.serializeUser(record);
  }

  // ── Snapshot date listing ─────────────────────────────────────────────────

  collectionName(collectionKey) {
    const name = COLLECTIONS[collectionKey];
    if (!name) throw new Error(`Unknown collection key: ${collectionKey}`);
    return name;
  }

  async listSnapshotDates(collectionKey, clientCode) {
    const col = this.collectionName(collectionKey);
    const filter = `client_code=${pbLiteral(clientCode)}`;
    const records = await this.pb.listAllRecords(col, { filterExpr: filter, sort: "-snapshot_date", perPage: 400 });
    return records
      .map(r => r.snapshot_date)
      .filter(Boolean)
      .sort()
      .reverse();
  }

  // ── Snapshot loading + cache ──────────────────────────────────────────────

  _cacheKey(collectionKey, clientCode, snapshotDate) {
    return `${collectionKey}::${clientCode}::${snapshotDate || "__latest__"}`;
  }

  _ttl(snapshotDate) {
    return snapshotDate === todayYMD() ? TTL_TODAY_MS : TTL_HISTORIC_MS;
  }

  _cacheGet(key, snapshotDate) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.loadedAt > this._ttl(snapshotDate)) {
      this.cache.delete(key);
      return null;
    }
    return entry;
  }

  async _fetchSnapshotRecord(col, clientCode, snapshotDate) {
    let filterParts = [`client_code=${pbLiteral(clientCode)}`];
    let sort = "-uploaded_at";
    if (snapshotDate) {
      filterParts.push(`snapshot_date=${pbLiteral(snapshotDate)}`);
    } else {
      sort = "-snapshot_date,-uploaded_at";
    }
    const response = await this.pb.listRecords(col, {
      filterExpr: filterParts.join(" && "),
      sort,
      perPage: 1,
    });
    return (response.items || [])[0] || null;
  }

  async loadSnapshot(collectionKey, clientCode, snapshotDate) {
    const resolvedDate = snapshotDate || null;
    const cacheKey = this._cacheKey(collectionKey, clientCode, resolvedDate);

    const cached = this._cacheGet(cacheKey, resolvedDate || todayYMD());
    if (cached) return { rows: cached.rows, meta: cached.meta, fromCache: true };

    const col    = this.collectionName(collectionKey);
    const record = await this._fetchSnapshotRecord(col, clientCode, resolvedDate);

    if (!record) {
      return { rows: [], meta: null, fromCache: false };
    }

    // PocketBase file fields come back as arrays of filenames — take the first.
    const rawFile  = record.snapshot_file;
    const fileName = Array.isArray(rawFile) ? rawFile[0] : rawFile;
    if (!fileName) {
      return { rows: [], meta: { ...record }, fromCache: false };
    }

    // Download the file via superuser proxy
    const fileResponse = await this.pb.proxyFile(record.collectionId || col, record.id, fileName);
    const buffer = Buffer.from(await fileResponse.arrayBuffer());

    // Decompress if gzip (filename ends .gz)
    let jsonBuf = buffer;
    if (String(fileName).endsWith(".gz")) {
      jsonBuf = zlib.gunzipSync(buffer);
    }

    const parsed = JSON.parse(jsonBuf.toString("utf8"));

    // Pick activity snapshots are stored as { rows: [...], total_pick_count, ... }
    // Order line and pick transaction snapshots are stored as plain arrays.
    // Normalise both to a flat rows array.
    const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.rows) ? parsed.rows : []);

    // Merge any extra summary fields from the file into meta (e.g. total_pick_count)
    const fileMeta = Array.isArray(parsed) ? {} : { ...parsed, rows: undefined };

    const meta = {
      client_code:       record.client_code,
      snapshot_date:     record.snapshot_date,
      row_count:         record.row_count,
      uploaded_at:       record.uploaded_at,
      source_synced_at:  record.source_synced_at,
      total_pick_count:  fileMeta.total_pick_count  ?? null,
      total_pick_qty:    fileMeta.total_pick_qty    ?? null,
    };

    this.cache.set(cacheKey, { loadedAt: Date.now(), rows, meta });
    return { rows, meta, fromCache: false };
  }

  // ── Catalog lookup ────────────────────────────────────────────────────────

  async getSkuDetail(sku, clientCode = "FANDMKET") {
    if (!sku) return null;
    const s = String(sku).trim().toUpperCase();

    // Fetch catalog record and images in parallel
    const [catalogResp, imageRecords] = await Promise.all([
      this.pb.listRecords("item_catalog_snapshots", {
        filterExpr: `sku=${pbLiteral(s)} && client_code=${pbLiteral(clientCode)}`,
        perPage: 1,
      }).catch(() => ({ items: [] })),
      this.pb.listAllRecords("item_catalog_images", {
        filterExpr: `sku=${pbLiteral(s)} && client_code=${pbLiteral(clientCode)}`,
        sort: "-uploaded_at",
        perPage: 20,
      }).catch(() => []),
    ]);

    const catalogRecord = (catalogResp.items || [])[0] || null;

    const images = imageRecords.map(row => {
      const rawFile = row.image;
      const fileName = Array.isArray(rawFile) ? rawFile[0] : rawFile;
      if (!fileName) return null;
      const collId = row.collectionId || row.collectionName || "item_catalog_images";
      return {
        id:          row.id,
        caption:     row.caption || "",
        uploaded_at: row.uploaded_at || "",
        // Routed through repo-app's own proxy so the browser doesn't need PB creds
        url: `/api/files/${encodeURIComponent(row.id)}?collection=${encodeURIComponent(collId)}&name=${encodeURIComponent(fileName)}`,
        _collectionId: collId,
        _fileName:     fileName,
      };
    }).filter(Boolean);

    if (!catalogRecord && !images.length) return null;

    return {
      sku:               s,
      description:       catalogRecord?.description       || "",
      description_short: catalogRecord?.description_short || "",
      size:              catalogRecord?.size              || "",
      color:             catalogRecord?.color             || "",
      barcode:           catalogRecord?.barcode           || "",
      active:            catalogRecord?.active            ?? true,
      images,
      image_count: images.length,
      has_images:  images.length > 0,
    };
  }

  async proxySkuImage(imageId, collectionKey, fileName) {
    return this.pb.proxyFile(collectionKey, imageId, fileName);
  }
}

module.exports = { SnapshotService, COLLECTIONS };
