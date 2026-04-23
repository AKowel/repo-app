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
const CUSTOM_QUERY_SNAPSHOT_COLLECTION = "custom_query_snapshots";
const SYNC_JOBS_COLLECTION = "sync_jobs";

const TTL_TODAY_MS = 5 * 60 * 1000;
const TTL_HISTORIC_MS = 4 * 60 * 60 * 1000;
const TTL_CATALOG_MS = 5 * 60 * 1000;
const CUSTOM_QUERY_MAX_ROWS = Math.max(100, Number.parseInt(process.env.CUSTOM_QUERY_MAX_ROWS || "50000", 10) || 50000);
const CUSTOM_QUERY_MAX_SQL_LENGTH = Math.max(1000, Number.parseInt(process.env.CUSTOM_QUERY_MAX_SQL_LENGTH || "50000", 10) || 50000);

function normalizeQueryName(value, fallback = "custom_query") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, 120);
}

function sqlHashText(sqlText) {
  return require("crypto").createHash("sha256").update(String(sqlText || ""), "utf8").digest("hex");
}

function sqlPreviewText(sqlText, maxLength = 400) {
  const text = String(sqlText || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function sanitizeSqlText(sqlText) {
  let text = String(sqlText || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!text) throw new Error("SQL is required.");
  if (text.length > CUSTOM_QUERY_MAX_SQL_LENGTH) {
    throw new Error(`SQL is too long. Max length is ${CUSTOM_QUERY_MAX_SQL_LENGTH} characters.`);
  }
  text = text.replace(/\/\*[\s\S]*?\*\//g, " ");
  text = text.replace(/--[^\n]*/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  while (text.endsWith(";")) text = text.slice(0, -1).trimEnd();
  return text;
}

function validateReadOnlySql(sqlText) {
  const text = sanitizeSqlText(sqlText);
  if (text.includes(";")) throw new Error("Only a single SQL statement is allowed.");
  const firstToken = String(text.split(/\s+/, 1)[0] || "").toUpperCase();
  if (!["SELECT", "WITH"].includes(firstToken)) {
    throw new Error("Only read-only SELECT or WITH queries are allowed.");
  }
  const blockedPatterns = [
    /\bINSERT\b/i,
    /\bUPDATE\b/i,
    /\bDELETE\b/i,
    /\bDROP\b/i,
    /\bALTER\b/i,
    /\bCREATE\b/i,
    /\bMERGE\b/i,
    /\bCALL\b/i,
    /\bEXEC\b/i,
    /\bEXECUTE\b/i,
    /\bGRANT\b/i,
    /\bREVOKE\b/i,
    /\bTRUNCATE\b/i,
    /\bCOMMIT\b/i,
    /\bROLLBACK\b/i,
  ];
  if (blockedPatterns.some((pattern) => pattern.test(text))) {
    throw new Error("Only read-only SQL is allowed in custom query jobs.");
  }
  return text;
}

function coerceCustomQueryMaxRows(value) {
  if (value === undefined || value === null || value === "") return CUSTOM_QUERY_MAX_ROWS;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) throw new Error("Max rows must be a whole number.");
  if (parsed < 1) throw new Error("Max rows must be at least 1.");
  return Math.min(parsed, CUSTOM_QUERY_MAX_ROWS);
}

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

  serializeCustomQuerySnapshot(record) {
    if (!record) return null;
    const meta = this._normalizeJsonField(record.result_meta_json, {});
    const rawFile = record.result_file;
    const fileName = Array.isArray(rawFile) ? rawFile[0] : rawFile;
    return {
      record_id: String(record.id || ""),
      query_name: String(record.query_name || ""),
      row_count: Number(record.row_count || 0),
      column_count: Number(record.column_count || 0),
      uploaded_at: String(record.uploaded_at || record.created || ""),
      source_synced_at: String(record.source_synced_at || ""),
      requested_by: String(record.requested_by || ""),
      sql_hash: String(record.sql_hash || ""),
      sql_preview: String(record.sql_preview || ""),
      truncated: Boolean(meta.truncated),
      max_rows: Number(meta.max_rows || 0),
      columns: Array.isArray(meta.columns) ? meta.columns : [],
      file_name: String(fileName || ""),
    };
  }

  async listCustomQuerySnapshots({ queryName = "", sqlHash = "", maxRows = null, limit = 20 } = {}) {
    const filterParts = [];
    const normalizedName = queryName ? normalizeQueryName(queryName) : "";
    const normalizedHash = String(sqlHash || "").trim();
    if (normalizedName) filterParts.push(`query_name=${pbLiteral(normalizedName)}`);
    if (normalizedHash) filterParts.push(`sql_hash=${pbLiteral(normalizedHash)}`);

    const response = await this.pb.listRecords(CUSTOM_QUERY_SNAPSHOT_COLLECTION, {
      filterExpr: filterParts.length ? filterParts.join(" && ") : undefined,
      sort: "-uploaded_at,-created",
      perPage: Math.max(1, Math.min(Number(limit) || 20, 100)),
    }).catch(() => ({ items: [] }));

    return (response.items || [])
      .map((record) => this.serializeCustomQuerySnapshot(record))
      .filter(Boolean)
      .filter((record) => maxRows === null || Number(record.max_rows || 0) === Number(maxRows || 0));
  }

  async findLatestCustomQuerySnapshot(queryName, sqlHash, { maxRows = null, limit = 20 } = {}) {
    const rows = await this.listCustomQuerySnapshots({ queryName, sqlHash, maxRows, limit });
    return rows[0] || null;
  }

  async loadCustomQuerySnapshot(recordId) {
    const record = await this.pb.getRecord(CUSTOM_QUERY_SNAPSHOT_COLLECTION, String(recordId || "").trim());
    const rawFile = record.result_file;
    const fileName = Array.isArray(rawFile) ? rawFile[0] : rawFile;
    if (!fileName) {
      return {
        meta: this.serializeCustomQuerySnapshot(record),
        query_name: String(record.query_name || ""),
        sql_text: "",
        columns: [],
        rows: [],
      };
    }

    const fileResponse = await this.pb.proxyFile(
      record.collectionId || record.collectionName || CUSTOM_QUERY_SNAPSHOT_COLLECTION,
      record.id,
      fileName
    );
    const buffer = Buffer.from(await fileResponse.arrayBuffer());
    const jsonBuffer = String(fileName).toLowerCase().endsWith(".gz") ? zlib.gunzipSync(buffer) : buffer;
    const parsed = JSON.parse(jsonBuffer.toString("utf8"));
    const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    const columns = Array.isArray(parsed?.columns) ? parsed.columns : [];
    return {
      meta: {
        ...this.serializeCustomQuerySnapshot(record),
        row_count: Number(parsed?.row_count ?? record.row_count ?? rows.length),
        column_count: Number(parsed?.column_count ?? record.column_count ?? columns.length),
        truncated: Boolean(parsed?.truncated ?? this.serializeCustomQuerySnapshot(record)?.truncated),
        max_rows: Number(parsed?.max_rows ?? this.serializeCustomQuerySnapshot(record)?.max_rows ?? 0),
        sql_hash: String(parsed?.sql_hash || record.sql_hash || ""),
        sql_preview: String(parsed?.sql_preview || record.sql_preview || ""),
      },
      query_name: String(parsed?.query_name || record.query_name || ""),
      sql_text: String(parsed?.sql_text || ""),
      columns,
      rows,
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

  async findLatestCustomQueryJob(queryName, sqlHash, { maxRows = null, statuses = [], limit = 50 } = {}) {
    const targetName = normalizeQueryName(queryName);
    const targetHash = String(sqlHash || "").trim();
    const rows = await this.listSyncJobs("custom_query_export", { statuses, limit });
    return rows.find((job) => {
      const payloadName = normalizeQueryName(job?.payload?.query_name, targetName);
      const payloadHash = String(job?.payload?.sql_hash || "").trim();
      const payloadMaxRows = Number(job?.payload?.max_rows || 0);
      return payloadName === targetName &&
        payloadHash === targetHash &&
        (maxRows === null || payloadMaxRows === Number(maxRows || 0));
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

  async ensureCustomQueryJob({ queryName, sqlText, maxRows, requestedBy = "repo-app" } = {}) {
    const normalizedName = normalizeQueryName(queryName);
    const validatedSql = validateReadOnlySql(sqlText);
    const sqlHash = sqlHashText(validatedSql);
    const resolvedMaxRows = coerceCustomQueryMaxRows(maxRows);

    const existingSnapshot = await this.findLatestCustomQuerySnapshot(normalizedName, sqlHash, {
      maxRows: resolvedMaxRows,
      limit: 20,
    });
    if (existingSnapshot) {
      return {
        created: false,
        ready: true,
        query_name: normalizedName,
        sql_hash: sqlHash,
        max_rows: resolvedMaxRows,
        snapshot: existingSnapshot,
        job: null,
      };
    }

    const existingJob = await this.findLatestCustomQueryJob(normalizedName, sqlHash, {
      maxRows: resolvedMaxRows,
      statuses: ["queued", "running"],
      limit: 60,
    });
    if (existingJob) {
      return {
        created: false,
        ready: false,
        query_name: normalizedName,
        sql_hash: sqlHash,
        max_rows: resolvedMaxRows,
        snapshot: null,
        job: existingJob,
      };
    }

    const now = new Date().toISOString();
    const created = await this.pb.createRecord(SYNC_JOBS_COLLECTION, {
      job_type: "custom_query_export",
      status: "queued",
      payload_json: {
        query_name: normalizedName,
        sql_text: validatedSql,
        sql_hash: sqlHash,
        max_rows: resolvedMaxRows,
      },
      result_json: {},
      requested_by: String(requestedBy || "repo-app"),
      requested_at: now,
      attempt_count: 0,
      error_text: "",
    });

    return {
      created: true,
      ready: false,
      query_name: normalizedName,
      sql_hash: sqlHash,
      max_rows: resolvedMaxRows,
      snapshot: null,
      job: this.serializeSyncJob(created),
    };
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
