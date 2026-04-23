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
const EMPTY_BINS_REPORT_SNAPSHOT_COLLECTION = "empty_bins_report_snapshots";
const SYNC_JOBS_COLLECTION = "sync_jobs";

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

  async loadSnapshot(collectionKey, clientCode, snapshotDate, { noCache = false } = {}) {
    const resolvedDate = snapshotDate || null;
    const cacheKey = this._cacheKey(collectionKey, clientCode, resolvedDate);

    if (!noCache) {
      const cached = this._cacheGet(cacheKey, resolvedDate || todayYMD());
      if (cached) {
        return { rows: cached.rows, meta: cached.meta, fromCache: true };
      }
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

    if (!noCache) {
      this.cache.set(cacheKey, { loadedAt: Date.now(), rows, meta });
    }
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

  async loadEmptyBinsReportSnapshot(clientCode = "FANDMKET", reportDate, { noCache = false } = {}) {
    const targetClient = String(clientCode || "FANDMKET").trim().toUpperCase();
    const targetDate = String(reportDate || todayYMD()).trim();
    const cacheKey = `empty_bins_report::${targetClient}::${targetDate}`;

    if (!noCache) {
      const cached = this._cacheGet(cacheKey, targetDate);
      if (cached) {
        return { rows: cached.rows, meta: cached.meta, fromCache: true };
      }
    }

    const response = await this.pb.listRecords(EMPTY_BINS_REPORT_SNAPSHOT_COLLECTION, {
      filterExpr: `client_code=${pbLiteral(targetClient)} && report_date=${pbLiteral(targetDate)}`,
      sort: "-uploaded_at",
      perPage: 1,
    }).catch(() => ({ items: [] }));

    const record = (response.items || [])[0] || null;
    if (!record) {
      return { rows: [], meta: null, fromCache: false };
    }

    const rawFile = record.report_file || record.snapshot_file;
    const fileName = Array.isArray(rawFile) ? rawFile[0] : rawFile;
    if (!fileName) {
      return { rows: [], meta: { ...record }, fromCache: false };
    }

    const fileResponse = await this.pb.proxyFile(
      record.collectionId || record.collectionName || EMPTY_BINS_REPORT_SNAPSHOT_COLLECTION,
      record.id,
      fileName
    );
    const buffer = Buffer.from(await fileResponse.arrayBuffer());
    const jsonBuffer = String(fileName).toLowerCase().endsWith(".gz") ? zlib.gunzipSync(buffer) : buffer;
    const parsed = JSON.parse(jsonBuffer.toString("utf8"));
    const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.rows) ? parsed.rows : []);
    const fileMeta = Array.isArray(parsed) ? {} : { ...parsed, rows: undefined };
    const meta = {
      client_code: record.client_code || fileMeta.client_code || targetClient,
      report_date: record.report_date || fileMeta.report_date || targetDate,
      row_count: Number(record.row_count ?? fileMeta.row_count ?? rows.length),
      source: record.source || fileMeta.source || "",
      uploaded_at: record.uploaded_at || fileMeta.uploaded_at || "",
      source_synced_at: record.source_synced_at || fileMeta.source_synced_at || fileMeta.synced_at || "",
      record_id: record.id || "",
    };

    if (!noCache) {
      this.cache.set(cacheKey, { loadedAt: Date.now(), rows, meta });
    }
    return { rows, meta, fromCache: false };
  }

  _normalizeJsonField(value, fallback = {}) {
    if (Array.isArray(fallback)) {
      if (Array.isArray(value)) return value;
    } else if (value && typeof value === "object") {
      return value;
    }
    if (value === null || value === undefined || value === "") return fallback;
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(fallback)) return Array.isArray(parsed) ? parsed : fallback;
        return parsed && typeof parsed === "object" ? parsed : fallback;
      } catch {
        return fallback;
      }
    }
    return fallback;
  }

  serializeSyncJob(record) {
    if (!record) return null;
    return {
      id: String(record.id || ""),
      job_type: String(record.job_type || ""),
      status: String(record.status || "queued"),
      payload: this._normalizeJsonField(record.payload_json, {}),
      result: this._normalizeJsonField(record.result_json, {}),
      requested_by: String(record.requested_by || ""),
      requested_at: String(record.requested_at || record.created || ""),
      claimed_by: String(record.claimed_by || ""),
      claimed_at: String(record.claimed_at || ""),
      completed_at: String(record.completed_at || ""),
      failed_at: String(record.failed_at || ""),
      attempt_count: Number(record.attempt_count || 0),
      error_text: String(record.error_text || ""),
    };
  }

  async getEmptyBinsReportSnapshotMeta(clientCode = "FANDMKET", reportDate) {
    const targetClient = String(clientCode || "FANDMKET").trim().toUpperCase();
    const targetDate = String(reportDate || todayYMD()).trim();
    const response = await this.pb.listRecords(EMPTY_BINS_REPORT_SNAPSHOT_COLLECTION, {
      filterExpr: `client_code=${pbLiteral(targetClient)} && report_date=${pbLiteral(targetDate)}`,
      sort: "-uploaded_at",
      perPage: 1,
    }).catch(() => ({ items: [] }));

    const record = (response.items || [])[0] || null;
    if (!record) return null;
    return {
      client_code: record.client_code || targetClient,
      report_date: record.report_date || targetDate,
      row_count: Number(record.row_count || 0),
      source: record.source || "",
      uploaded_at: record.uploaded_at || "",
      source_synced_at: record.source_synced_at || "",
      record_id: record.id || "",
    };
  }

  async listSyncJobs(jobType, { statuses = [], limit = 30 } = {}) {
    const typeText = String(jobType || "").trim();
    const statusList = Array.isArray(statuses)
      ? statuses.map((value) => String(value || "").trim()).filter(Boolean)
      : [];

    const filterParts = [];
    if (typeText) filterParts.push(`job_type=${pbLiteral(typeText)}`);
    if (statusList.length === 1) {
      filterParts.push(`status=${pbLiteral(statusList[0])}`);
    } else if (statusList.length > 1) {
      filterParts.push(`(${statusList.map((value) => `status=${pbLiteral(value)}`).join(" || ")})`);
    }

    const response = await this.pb.listRecords(SYNC_JOBS_COLLECTION, {
      filterExpr: filterParts.length ? filterParts.join(" && ") : undefined,
      sort: "-requested_at,-created",
      perPage: Math.max(1, Math.min(Number(limit) || 30, 100)),
    }).catch(() => ({ items: [] }));

    return (response.items || []).map((row) => this.serializeSyncJob(row)).filter(Boolean);
  }

  async findLatestEmptyBinsReportJob(clientCode = "FANDMKET", reportDate, { statuses = [], limit = 50 } = {}) {
    const targetClient = String(clientCode || "FANDMKET").trim().toUpperCase();
    const targetDate = String(reportDate || todayYMD()).trim();
    const rows = await this.listSyncJobs("empty_bins_report_by_date", { statuses, limit });
    return rows.find((job) => {
      const payloadClient = String(job?.payload?.client_code || "").trim().toUpperCase();
      const payloadDate = String(job?.payload?.report_date || "").trim();
      return payloadClient === targetClient && payloadDate === targetDate;
    }) || null;
  }

  async ensureEmptyBinsReportJob(clientCode = "FANDMKET", reportDate, requestedBy = "repo-app") {
    const targetClient = String(clientCode || "FANDMKET").trim().toUpperCase();
    const targetDate = String(reportDate || todayYMD()).trim();

    const existing = await this.findLatestEmptyBinsReportJob(targetClient, targetDate, {
      statuses: ["queued", "running"],
      limit: 60,
    });
    if (existing) return { job: existing, created: false };

    const now = new Date().toISOString();
    const created = await this.pb.createRecord(SYNC_JOBS_COLLECTION, {
      job_type: "empty_bins_report_by_date",
      status: "queued",
      payload_json: {
        report_date: targetDate,
        client_code: targetClient,
      },
      result_json: {},
      requested_by: String(requestedBy || "repo-app"),
      requested_at: now,
      attempt_count: 0,
      error_text: "",
    });

    return { job: this.serializeSyncJob(created), created: true };
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
