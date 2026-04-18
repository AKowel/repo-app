"use strict";
const zlib = require("zlib");
const { PocketBaseClient, PocketBaseError } = require("./pocketbaseClient");
const { pbLiteral, todayYMD } = require("./helpers");

const COLLECTIONS = {
  pick_activity: "warehouse_pick_activity_snapshots",
  order_lines: "warehouse_order_line_snapshots",
  pick_transactions: "warehouse_pick_transaction_snapshots",
  binloc: "warehouse_binloc_snapshots",
};

const ITEM_CATALOG_SNAPSHOT_COLLECTION = "item_catalog_snapshots";
const ITEM_CATALOG_IMAGE_COLLECTION = "item_catalog_images";

const TTL_TODAY_MS = 5 * 60 * 1000;
const TTL_HISTORIC_MS = 4 * 60 * 60 * 1000;
const TTL_CATALOG_MS = 5 * 60 * 1000;

class SnapshotService {
  constructor({ pocketbaseUrl, adminEmail, adminPassword }) {
    this.pb = new PocketBaseClient({ baseUrl: pocketbaseUrl, adminEmail, adminPassword });
    this.cache = new Map();
    this.catalogCache = new Map();
  }

  isAdminUser(record) {
    return record && record.role === "admin";
  }

  serializeUser(record) {
    return {
      id: record.id,
      email: record.email || "",
      name: record.name || record.email || "",
      role: record.role || "user",
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

  collectionName(collectionKey) {
    const name = COLLECTIONS[collectionKey];
    if (!name) throw new Error(`Unknown collection key: ${collectionKey}`);
    return name;
  }

  isWarehouseScopedCollection(collectionKey) {
    return collectionKey === "binloc";
  }

  async listSnapshotDates(collectionKey, clientCode) {
    const col = this.collectionName(collectionKey);
    const filter = this.isWarehouseScopedCollection(collectionKey)
      ? undefined
      : `client_code=${pbLiteral(clientCode)}`;
    const records = await this.pb.listAllRecords(col, {
      filterExpr: filter,
      sort: "-snapshot_date",
      perPage: 400,
    });
    return [...new Set(
      records
        .map((record) => record.snapshot_date)
        .filter(Boolean)
    )].sort().reverse();
  }

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

  async _fetchSnapshotRecord(collectionKey, collectionName, clientCode, snapshotDate) {
    const filterParts = [];
    if (!this.isWarehouseScopedCollection(collectionKey)) {
      filterParts.push(`client_code=${pbLiteral(clientCode)}`);
    }

    let sort = "-uploaded_at";
    if (snapshotDate) {
      filterParts.push(`snapshot_date=${pbLiteral(snapshotDate)}`);
    } else {
      sort = "-snapshot_date,-uploaded_at";
    }

    const response = await this.pb.listRecords(collectionName, {
      filterExpr: filterParts.length ? filterParts.join(" && ") : undefined,
      sort,
      perPage: 1,
    });
    return (response.items || [])[0] || null;
  }

  async loadSnapshot(collectionKey, clientCode, snapshotDate) {
    const resolvedDate = snapshotDate || null;
    const cacheKey = this._cacheKey(collectionKey, clientCode, resolvedDate);
    const cached = this._cacheGet(cacheKey, resolvedDate || todayYMD());
    if (cached) {
      return { rows: cached.rows, meta: cached.meta, fromCache: true };
    }

    const collectionName = this.collectionName(collectionKey);
    const record = await this._fetchSnapshotRecord(collectionKey, collectionName, clientCode, resolvedDate);
    if (!record) {
      return { rows: [], meta: null, fromCache: false };
    }

    const rawFile = record.snapshot_file;
    const fileName = Array.isArray(rawFile) ? rawFile[0] : rawFile;
    if (!fileName) {
      return { rows: [], meta: { ...record }, fromCache: false };
    }

    const fileResponse = await this.pb.proxyFile(record.collectionId || collectionName, record.id, fileName);
    const buffer = Buffer.from(await fileResponse.arrayBuffer());

    let jsonBuffer = buffer;
    if (String(fileName).toLowerCase().endsWith(".gz")) {
      jsonBuffer = zlib.gunzipSync(buffer);
    }

    const parsed = JSON.parse(jsonBuffer.toString("utf8"));
    const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.rows) ? parsed.rows : []);
    const fileMeta = Array.isArray(parsed) ? {} : { ...parsed, rows: undefined };

    const meta = {
      client_code: record.client_code,
      snapshot_date: record.snapshot_date,
      row_count: record.row_count,
      uploaded_at: record.uploaded_at,
      source_synced_at: record.source_synced_at,
      total_pick_count: fileMeta.total_pick_count ?? null,
      total_pick_qty: fileMeta.total_pick_qty ?? null,
    };

    this.cache.set(cacheKey, { loadedAt: Date.now(), rows, meta });
    return { rows, meta, fromCache: false };
  }

  async loadCatalogSnapshot(clientCode = "FANDMKET") {
    const targetClient = String(clientCode || "FANDMKET").trim().toUpperCase();
    const cached = this.catalogCache.get(targetClient);

    if (cached && Date.now() - cached.checkedAt < TTL_CATALOG_MS) {
      return { snapshot: cached.snapshot, meta: cached.meta, fromCache: true };
    }

    const response = await this.pb.listRecords(ITEM_CATALOG_SNAPSHOT_COLLECTION, {
      filterExpr: `client_code=${pbLiteral(targetClient)}`,
      sort: "-imported_at",
      perPage: 1,
    }).catch(() => ({ items: [] }));

    const record = (response.items || [])[0] || null;
    if (!record) {
      return { snapshot: null, meta: null, fromCache: false };
    }

    if (cached && cached.recordId === String(record.id || "")) {
      cached.checkedAt = Date.now();
      return { snapshot: cached.snapshot, meta: cached.meta, fromCache: true };
    }

    const rawFile = record.catalog_file;
    const fileName = Array.isArray(rawFile) ? rawFile[0] : rawFile;
    if (!fileName) {
      return { snapshot: null, meta: null, fromCache: false };
    }

    const fileResponse = await this.pb.proxyFile(
      record.collectionId || record.collectionName || ITEM_CATALOG_SNAPSHOT_COLLECTION,
      record.id,
      fileName
    );
    const buffer = Buffer.from(await fileResponse.arrayBuffer());
    const jsonBuffer = String(fileName).toLowerCase().endsWith(".gz") ? zlib.gunzipSync(buffer) : buffer;
    const snapshot = JSON.parse(jsonBuffer.toString("utf8"));

    const meta = {
      client_code: record.client_code || targetClient,
      row_count: Number(record.row_count || 0),
      source_row_count: Number(record.source_row_count || 0),
      duplicate_sku_count: Number(record.duplicate_sku_count || 0),
      imported_at: record.imported_at || "",
      generated_at: record.generated_at || "",
      source_name: record.source_name || "",
      sheet_name: record.sheet_name || "",
      record_id: record.id || "",
    };

    this.catalogCache.set(targetClient, {
      recordId: String(record.id || ""),
      checkedAt: Date.now(),
      snapshot,
      meta,
    });

    return { snapshot, meta, fromCache: false };
  }

  async getSkuDetail(sku, clientCode = "FANDMKET") {
    if (!sku) return null;
    const normalizedSku = String(sku).trim().toUpperCase();
    const normalizedClient = String(clientCode || "FANDMKET").trim().toUpperCase();

    const [catalogState, imageRecords] = await Promise.all([
      this.loadCatalogSnapshot(normalizedClient).catch(() => ({ snapshot: null, meta: null })),
      this.pb.listAllRecords(ITEM_CATALOG_IMAGE_COLLECTION, {
        filterExpr: `sku=${pbLiteral(normalizedSku)} && client_code=${pbLiteral(normalizedClient)}`,
        sort: "-uploaded_at",
        perPage: 20,
      }).catch(() => []),
    ]);

    const catalogItem = (catalogState.snapshot?.items || []).find(
      (item) => String(item?.sku || "").trim().toUpperCase() === normalizedSku
    ) || null;

    const images = imageRecords.map((row) => {
      const rawFile = row.image;
      const fileName = Array.isArray(rawFile) ? rawFile[0] : rawFile;
      if (!fileName) return null;
      const collectionId = row.collectionId || row.collectionName || ITEM_CATALOG_IMAGE_COLLECTION;
      return {
        id: row.id,
        caption: row.caption || "",
        uploaded_at: row.uploaded_at || "",
        url: `/api/files/${encodeURIComponent(row.id)}?collection=${encodeURIComponent(collectionId)}&name=${encodeURIComponent(fileName)}`,
        _collectionId: collectionId,
        _fileName: fileName,
      };
    }).filter(Boolean);

    if (!catalogItem && !images.length) return null;

    const barcodes = Array.isArray(catalogItem?.barcodes)
      ? catalogItem.barcodes.filter(Boolean)
      : [];

    return {
      sku: normalizedSku,
      description: catalogItem?.description || catalogItem?.description_short || "",
      description_short: catalogItem?.description_short || "",
      size: catalogItem?.size || "",
      color: catalogItem?.color || "",
      barcode: catalogItem?.barcode || barcodes[0] || "",
      barcodes,
      active: catalogItem?.active ?? true,
      images,
      image_count: images.length,
      has_images: images.length > 0,
      catalog_meta: catalogState.meta || null,
    };
  }

  async proxySkuImage(imageId, collectionKey, fileName) {
    return this.pb.proxyFile(collectionKey, imageId, fileName);
  }
}

module.exports = { SnapshotService, COLLECTIONS };
