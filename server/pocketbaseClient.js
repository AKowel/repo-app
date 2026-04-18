// Verbatim copy of itemtracker/server/pocketbaseClient.js
// Generic PocketBase HTTP client — no app-specific logic.

class PocketBaseError extends Error {
  constructor(message, statusCode = 500, payload = null) {
    super(message);
    this.name = "PocketBaseError";
    this.statusCode = statusCode;
    this.payload = payload;
  }
}

const SUPERUSER_REQUIRED_MESSAGE =
  "PocketBase superuser credentials are required. Set POCKETBASE_ADMIN_EMAIL and POCKETBASE_ADMIN_PASSWORD to a real PocketBase superuser account, then restart the app.";

function looksLikeSuperuserError(error) {
  if (!(error instanceof PocketBaseError)) return false;
  const message = String(error.message || "").toLowerCase();
  return (
    error.statusCode === 403 ||
    message.includes("only superusers can perform this action") ||
    message.includes("only super admins can perform this action") ||
    message.includes("superuser") ||
    message.includes("super admin")
  );
}

function normalizeAdminError(error) {
  if (looksLikeSuperuserError(error)) {
    return new PocketBaseError(SUPERUSER_REQUIRED_MESSAGE, error.statusCode || 403, error.payload);
  }
  return error;
}

class PocketBaseClient {
  constructor({ baseUrl, adminEmail, adminPassword }) {
    this.baseUrl     = String(baseUrl || "").replace(/\/$/, "");
    this.adminEmail  = adminEmail    || "";
    this.adminPassword = adminPassword || "";
    this.adminToken  = null;
  }

  async _request(method, path, { payload, token, query, expectJson = true, headers = {}, body } = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") continue;
        url.searchParams.set(key, String(value));
      }
    }

    const requestHeaders = { Accept: "*/*", ...headers };
    let requestBody = body;
    if (payload !== undefined) {
      requestHeaders["Content-Type"] = "application/json";
      requestBody = JSON.stringify(payload);
    }
    if (token) requestHeaders.Authorization = token;

    const response = await fetch(url, { method, headers: requestHeaders, body: requestBody });

    if (!expectJson) {
      if (!response.ok) {
        const raw = await response.text();
        throw new PocketBaseError(raw || response.statusText, response.status, raw);
      }
      return response;
    }

    const raw = await response.text();
    let parsed = null;
    if (raw) {
      try { parsed = JSON.parse(raw); } catch { parsed = raw; }
    }

    if (!response.ok) {
      const message =
        parsed && typeof parsed === "object" && parsed.message
          ? parsed.message
          : raw || response.statusText || "PocketBase request failed.";
      throw new PocketBaseError(message, response.status, parsed);
    }

    return parsed;
  }

  async authenticateAdmin(force = false) {
    if (this.adminToken && !force) return this.adminToken;
    if (!this.baseUrl || !this.adminEmail || !this.adminPassword) {
      throw new PocketBaseError("PocketBase admin credentials are missing.", 500);
    }
    let auth;
    try {
      auth = await this._request("POST", "/api/collections/_superusers/auth-with-password", {
        payload: { identity: this.adminEmail, password: this.adminPassword }
      });
    } catch (error) {
      throw normalizeAdminError(error);
    }
    if (!auth || !auth.token) {
      throw new PocketBaseError("PocketBase admin authentication did not return a token.", 500);
    }
    this.adminToken = auth.token;
    return this.adminToken;
  }

  async adminRequest(method, path, options = {}) {
    let token = await this.authenticateAdmin(false);
    try {
      return await this._request(method, path, { ...options, token });
    } catch (error) {
      if (error instanceof PocketBaseError) {
        const isAuthError =
          error.statusCode === 401 ||
          error.statusCode === 403 ||
          (typeof error.message === "string" &&
            (error.message.toLowerCase().includes("super admin") ||
             error.message.toLowerCase().includes("token") ||
             error.message.toLowerCase().includes("unauthorized")));
        if (isAuthError) {
          this.adminToken = null;
          token = await this.authenticateAdmin(true);
          try {
            return await this._request(method, path, { ...options, token });
          } catch (retryError) {
            throw normalizeAdminError(retryError);
          }
        }
      }
      throw normalizeAdminError(error);
    }
  }

  async listCollections() {
    const response = await this.adminRequest("GET", "/api/collections", { query: { page: 1, perPage: 200 } });
    return response.items || [];
  }

  async listRecords(collectionName, { filterExpr, sort, page = 1, perPage = 200 } = {}) {
    return this.adminRequest("GET", `/api/collections/${encodeURIComponent(collectionName)}/records`, {
      query: { page, perPage, filter: filterExpr, sort }
    });
  }

  async listAllRecords(collectionName, options = {}) {
    const rows = [];
    let page = 1;
    while (true) {
      const response = await this.listRecords(collectionName, { ...options, page });
      rows.push(...(response.items || []));
      if (page >= (response.totalPages || 1)) break;
      page += 1;
    }
    return rows;
  }

  async getRecord(collectionName, recordId) {
    return this.adminRequest(
      "GET",
      `/api/collections/${encodeURIComponent(collectionName)}/records/${encodeURIComponent(recordId)}`
    );
  }

  async authWithPassword(collectionName, identity, password) {
    return this._request(
      "POST",
      `/api/collections/${encodeURIComponent(collectionName)}/auth-with-password`,
      { payload: { identity, password } }
    );
  }

  async proxyFile(collectionKey, recordId, fileName) {
    return this.adminRequest(
      "GET",
      `/api/files/${encodeURIComponent(collectionKey)}/${encodeURIComponent(recordId)}/${encodeURIComponent(fileName)}`,
      { expectJson: false }
    );
  }
}

module.exports = { PocketBaseClient, PocketBaseError };
