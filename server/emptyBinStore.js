"use strict";

const fs = require("fs");
const path = require("path");

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeLocation(value) {
  return String(value || "").trim().toUpperCase();
}

function safeName(value) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .slice(0, 80) || "file";
}

function userSnapshot(user) {
  if (!user) return null;
  return {
    id: user.id || "",
    name: user.name || user.email || "",
    email: user.email || "",
  };
}

class EmptyBinTaskStore {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.imagesDir = path.join(dataDir, "empty-bin-images");
    this.stateFile = path.join(dataDir, "empty-bin-tasks.json");
    fs.mkdirSync(this.imagesDir, { recursive: true });
  }

  _defaultState() {
    return { version: 1, tasks: [] };
  }

  readState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      return {
        ...this._defaultState(),
        ...(parsed && typeof parsed === "object" ? parsed : {}),
        tasks: Array.isArray(parsed?.tasks) ? parsed.tasks : [],
      };
    } catch {
      return this._defaultState();
    }
  }

  writeState(state) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, this.stateFile);
  }

  listTasks({ client } = {}) {
    const targetClient = String(client || "").trim().toUpperCase();
    const state = this.readState();
    return state.tasks
      .filter(task => !targetClient || String(task.client || "").toUpperCase() === targetClient)
      .sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")));
  }

  getTask(taskId) {
    const state = this.readState();
    return state.tasks.find(task => task.id === taskId) || null;
  }

  findTask(predicate) {
    const state = this.readState();
    return state.tasks.find(predicate) || null;
  }

  updateTask(taskId, updater) {
    const state = this.readState();
    const index = state.tasks.findIndex(task => task.id === taskId);
    if (index < 0) return null;
    const task = state.tasks[index];
    const nextTask = updater(task) || task;
    nextTask.updated_at = nowIso();
    state.tasks[index] = nextTask;
    this.writeState(state);
    return nextTask;
  }

  createTask({ client, type = "empty_check", title, createdBy, sourceTaskId = "", filters = {}, snapshotMeta = {}, items = [] }) {
    const state = this.readState();
    const at = nowIso();
    const task = {
      id: makeId("ebt"),
      client: String(client || "").trim().toUpperCase(),
      type,
      title: title || (
        type === "clearing"
          ? "Clearing task for confirmed empty locations"
          : type === "move_pallets"
            ? "Bring pallets to checked empty locations"
            : "Daily empty bin check"
      ),
      status: "available",
      assignee: null,
      created_by: userSnapshot(createdBy),
      source_task_id: sourceTaskId || "",
      filters,
      snapshot_meta: snapshotMeta,
      created_at: at,
      updated_at: at,
      completed_at: "",
      items: items.map((item, index) => ({
        id: makeId("ebi"),
        sort_index: index + 1,
        location: normalizeLocation(item.location),
        aisle_prefix: item.aisle_prefix || "",
        bay: item.bay || "",
        level: item.level || "",
        level_num: Number(item.level_num || 0),
        operating_area: item.operating_area || "",
        bin_size: item.bin_size || "",
        bin_type: item.bin_type || "",
        client_code: item.client_code || "",
        item_sku: item.item_sku || "",
        item_description: item.item_description || "",
        report_date: item.report_date || filters.report_date || "",
        source_reason: item.source_reason || "",
        current_qty_at_create: Number(item.current_qty || 0),
        available_qty_at_create: Number(item.available_qty || 0),
        qty_under_query: Number(item.qty_under_query || 0),
        goods_in_pending: Number(item.goods_in_pending || 0),
        pending_from: item.pending_from || "",
        pending_to: item.pending_to || "",
        max_bin_qty: Number(item.max_bin_qty || 0),
        last_move_out_date: item.last_move_out_date || "",
        last_move_in_date: item.last_move_in_date || "",
        status: "pending",
        result: "",
        note: "",
        photos: [],
        checked_by: null,
        checked_at: "",
        system_cleared_at: "",
        system_cleared_reason: "",
        live: null,
        last_transaction: item.last_transaction || null,
        history: [],
      })),
    };
    state.tasks.unshift(task);
    this.writeState(state);
    return task;
  }

  assignTask(taskId, user) {
    return this.updateTask(taskId, (task) => {
      task.assignee = userSnapshot(user);
      task.status = "in_progress";
      return task;
    });
  }

  dropTask(taskId, user) {
    return this.updateTask(taskId, (task) => {
      task.assignee = null;
      if (!["completed", "deleted"].includes(task.status)) task.status = "available";
      task.history = task.history || [];
      task.history.push({ at: nowIso(), action: "dropped", user: userSnapshot(user) });
      return task;
    });
  }

  stopTask(taskId, user) {
    return this.updateTask(taskId, (task) => {
      task.assignee = null;
      if (!["completed", "deleted"].includes(task.status)) task.status = "stopped";
      task.history = task.history || [];
      task.history.push({ at: nowIso(), action: "stopped", user: userSnapshot(user) });
      return task;
    });
  }

  completeTask(taskId, user) {
    return this.updateTask(taskId, (task) => {
      task.status = "completed";
      task.completed_at = nowIso();
      task.completed_by = userSnapshot(user);
      return task;
    });
  }

  deleteTask(taskId, user) {
    const state = this.readState();
    const index = state.tasks.findIndex(task => task.id === taskId);
    if (index < 0) return null;
    const [task] = state.tasks.splice(index, 1);
    for (const item of (task.items || [])) {
      for (const photo of (item.photos || [])) {
        const fileName = path.basename(String(photo?.file_name || ""));
        if (!fileName) continue;
        const filePath = path.join(this.imagesDir, fileName);
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (_) {}
      }
    }
    this.writeState(state);
    return {
      ...task,
      deleted_at: nowIso(),
      deleted_by: userSnapshot(user),
    };
  }

  updateLocation(taskId, location, { status, result, note, user }) {
    return this.updateTask(taskId, (task) => {
      const loc = normalizeLocation(location);
      const item = (task.items || []).find(row => normalizeLocation(row.location) === loc);
      if (!item) return task;
      const at = nowIso();
      item.status = status || item.status;
      item.result = result || item.result || status || "";
      item.note = note === undefined ? item.note : String(note || "");
      item.checked_by = userSnapshot(user);
      item.checked_at = at;
      item.history = item.history || [];
      item.history.push({ at, action: item.status, result: item.result, note: item.note, user: userSnapshot(user) });
      if (task.status !== "completed") task.status = "in_progress";
      return task;
    });
  }

  savePhotoFromDataUrl(taskId, location, dataUrl, user) {
    const match = String(dataUrl || "").match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw new Error("Image must be a jpeg, png, or webp data URL.");
    const mime = match[1] === "image/jpg" ? "image/jpeg" : match[1];
    const ext = mime === "image/png" ? "png" : (mime === "image/webp" ? "webp" : "jpg");
    const loc = normalizeLocation(location);
    const fileName = `${safeName(taskId)}_${safeName(loc)}_${Date.now()}.${ext}`;
    const filePath = path.join(this.imagesDir, fileName);
    fs.writeFileSync(filePath, Buffer.from(match[2], "base64"));

    const photo = {
      id: makeId("ebp"),
      file_name: fileName,
      url: `/api/empty-bin/photos/${encodeURIComponent(fileName)}`,
      mime,
      uploaded_at: nowIso(),
      uploaded_by: userSnapshot(user),
    };

    const task = this.updateTask(taskId, (existingTask) => {
      const item = (existingTask.items || []).find(row => normalizeLocation(row.location) === loc);
      if (!item) return existingTask;
      item.photos = item.photos || [];
      item.photos.push(photo);
      item.history = item.history || [];
      item.history.push({ at: photo.uploaded_at, action: "photo_added", photo_id: photo.id, user: photo.uploaded_by });
      return existingTask;
    });
    return { task, photo };
  }

  photoPath(fileName) {
    const safeFile = path.basename(String(fileName || ""));
    return path.join(this.imagesDir, safeFile);
  }
}

module.exports = { EmptyBinTaskStore, normalizeLocation, userSnapshot };
