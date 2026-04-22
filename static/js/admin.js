(function () {
  "use strict";

  var latestBinSizeRows = [];
  var activeBinSizeEdit = "";

  document.addEventListener("DOMContentLoaded", function () {
    loadStatus();
    loadSnapshotSummary();
    loadBinSizes();
  });

  // ── Status ────────────────────────────────────────────────────────────
  window.loadStatus = function () {
    fetch("/api/admin/status")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) { showErr("pbStatus", data.error); return; }

        // Chips
        document.getElementById("chipUptime").textContent = "Up " + data.uptimeHuman;
        document.getElementById("chipNode").textContent   = "Node " + data.nodeVersion;
        document.getElementById("chipPb").textContent     = data.pocketbase.ok ? "PocketBase ✓" : "PocketBase ✗";
        document.getElementById("chipPb").className       = "chip " + (data.pocketbase.ok ? "chip--success" : "chip--danger");

        // PB status card
        var pbHtml = data.pocketbase.ok
          ? kv("Status",    '<span style="color:var(--success);font-weight:700">Connected ✓</span>') +
            kv("URL",       esc(data.pocketbase.url))
          : kv("Status",    '<span style="color:var(--danger);font-weight:700">Offline ✗</span>') +
            kv("URL",       esc(data.pocketbase.url)) +
            kv("Error",     '<span style="color:var(--danger)">' + esc(data.pocketbase.error) + "</span>");
        document.getElementById("pbStatus").innerHTML = "<div class='kv-list'>" + pbHtml + "</div>";

        // Server info card
        var infoHtml = kv("App name",   esc(data.appName)) +
                       kv("Uptime",     esc(data.uptimeHuman)) +
                       kv("Node",       esc(data.nodeVersion));
        document.getElementById("serverInfo").innerHTML = "<div class='kv-list'>" + infoHtml + "</div>";

        // Cache table
        renderCache(data.cache || []);
      })
      .catch(function (err) {
        showErr("pbStatus", err.message);
        showErr("serverInfo", err.message);
        showErr("cacheTable", err.message);
      });
  };

  function renderCache(entries) {
    var el = document.getElementById("cacheTable");
    if (!entries.length) {
      el.innerHTML = "<div class='empty-state'><div class='empty-state__icon'><svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'><circle cx='12' cy='12' r='10'/></svg></div><div class='empty-state__title'>Cache is empty</div><div class='empty-state__desc'>No snapshots have been loaded yet this session.</div></div>";
      return;
    }
    var html = "<div class='table-wrap'><table class='data-table'><thead><tr><th>Cache Key</th><th>Rows</th><th>Loaded At</th><th>Age</th></tr></thead><tbody>";
    entries.forEach(function (e) {
      html += "<tr><td style='font-family:monospace;font-size:0.8rem'>" + esc(e.key) + "</td><td>" + e.rows.toLocaleString() + "</td><td>" + esc(e.loadedAt) + "</td><td>" + e.ageSeconds + "s</td></tr>";
    });
    html += "</tbody></table></div>";
    el.innerHTML = html;
  }

  // ── Snapshot summary ──────────────────────────────────────────────────
  window.loadSnapshotSummary = function () {
    document.getElementById("snapshotSummary").innerHTML = "<div class='loading-row'><div class='spinner'></div> Querying PocketBase…</div>";
    fetch("/api/admin/snapshot-summary")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) { showErr("snapshotSummary", data.error); return; }
        var html = "<div class='table-wrap'><table class='data-table'><thead><tr><th>Client</th><th>Collection</th><th>Snapshots</th><th>Latest</th><th>Oldest</th></tr></thead><tbody>";
        Object.entries(data.summary).forEach(function ([client, cols]) {
          Object.entries(cols).forEach(function ([col, info]) {
            html += "<tr>";
            html += "<td><strong>" + esc(client) + "</strong></td>";
            html += "<td style='font-size:0.8rem;color:var(--text-soft)'>" + esc(col) + "</td>";
            if (info.error) {
              html += "<td colspan='3' style='color:var(--danger)'>" + esc(info.error) + "</td>";
            } else {
              var countChip = info.count === 0 ? '<span class="chip chip--warning">' + info.count + '</span>' : '<span class="chip chip--success">' + info.count + '</span>';
              html += "<td>" + countChip + "</td>";
              html += "<td>" + esc(info.latest || "—") + "</td>";
              html += "<td>" + esc(info.oldest || "—") + "</td>";
            }
            html += "</tr>";
          });
        });
        html += "</tbody></table></div>";
        document.getElementById("snapshotSummary").innerHTML = html;
      })
      .catch(function (err) { showErr("snapshotSummary", err.message); });
  };

  // Active bin sizes
  window.loadBinSizes = function () {
    var el = document.getElementById("binSizeTable");
    if (!el) return;

    var clientEl = document.getElementById("binSizeClient");
    var client = clientEl ? clientEl.value : "FANDMKET";
    el.innerHTML = "<div class='loading-row'><div class='spinner'></div> Loading active bin sizes...</div>";

    fetch("/api/admin/bin-sizes?client=" + encodeURIComponent(client))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) { showErr("binSizeTable", data.error); return; }
        renderBinSizes(data);
      })
      .catch(function (err) { showErr("binSizeTable", err.message); });
  };

  function renderBinSizes(data) {
    var el = document.getElementById("binSizeTable");
    var rows = data.rows || [];
    var summary = data.summary || {};
    latestBinSizeRows = rows;

    if (!rows.length) {
      el.innerHTML = "<div class='empty-state'><div class='empty-state__title'>No active bin sizes found</div><div class='empty-state__desc'>The latest BINLOC snapshot has no active locations for this client.</div></div>";
      return;
    }

    var html = "<div style='display:flex;flex-wrap:wrap;gap:8px;padding:10px;border-bottom:1px solid var(--border)'>";
    html += "<span class='chip'>Active locations " + fmtInt(summary.active_location_count) + "</span>";
    html += "<span class='chip chip--success'>Sized " + fmtInt(summary.configured_active_bin_size_count) + "</span>";
    html += "<span class='chip " + (summary.missing_active_bin_size_count ? "chip--warning" : "chip--success") + "'>Missing " + fmtInt(summary.missing_active_bin_size_count) + "</span>";
    html += "<span class='chip'>Definitions " + fmtInt(summary.configured_bin_size_count) + "</span>";
    html += "</div>";
    html += "<div id='binSizeEditor' style='display:none'></div>";

    html += "<div class='table-wrap'><table class='data-table'><thead><tr>";
    html += "<th>Bin Size</th><th>Status</th><th>Active Locations</th><th>Height mm</th><th>Width mm</th><th>Depth mm</th><th>Volume mm3</th><th>Usable 80%</th><th>Examples</th>";
    html += "</tr></thead><tbody>";

    rows.forEach(function (row) {
      var status = row.dimensions_configured
        ? "<span class='chip chip--success'>Sized</span>"
        : "<span class='chip chip--warning'>Needs size</span>";
      html += "<tr>";
      if (row.bin_size) {
        html += "<td class='m js-edit-bin-size' data-bin-size='" + attr(row.bin_size) + "' style='cursor:pointer;color:var(--accent)' title='Edit bin size dimensions'><strong>" + esc(row.label || row.bin_size) + "</strong></td>";
      } else {
        html += "<td class='m'><strong>" + esc(row.label || "Unspecified") + "</strong></td>";
      }
      html += "<td>" + status + "</td>";
      html += "<td>" + fmtInt(row.location_count) + "</td>";
      html += "<td>" + fmtMaybe(row.height_mm) + "</td>";
      html += "<td>" + fmtMaybe(row.width_mm) + "</td>";
      html += "<td>" + fmtMaybe(row.depth_mm) + "</td>";
      html += "<td>" + fmtMaybe(row.volume_mm3) + "</td>";
      html += "<td>" + fmtMaybe(row.usable_volume_mm3) + "</td>";
      html += "<td style='font-family:var(--mono);font-size:11px'>" + esc((row.example_locations || []).join(", ")) + "</td>";
      html += "</tr>";
    });

    html += "</tbody></table></div>";
    el.innerHTML = html;
    bindBinSizeEditors(el);
  }

  function bindBinSizeEditors(container) {
    Array.prototype.forEach.call(container.querySelectorAll(".js-edit-bin-size"), function (cell) {
      cell.addEventListener("click", function () {
        openBinSizeEditor(cell.getAttribute("data-bin-size"));
      });
    });
  }

  window.openBinSizeEditor = openBinSizeEditor;
  function openBinSizeEditor(binSize) {
    var code = String(binSize || "").trim().toUpperCase();
    if (!code) return;

    var row = latestBinSizeRows.find(function (entry) {
      return String(entry.bin_size || "").trim().toUpperCase() === code;
    });
    if (!row) return;

    activeBinSizeEdit = code;
    var editor = document.getElementById("binSizeEditor");
    if (!editor) return;

    editor.style.display = "block";
    editor.innerHTML =
      "<form id='binSizeEditForm' style='display:grid;grid-template-columns:minmax(110px,1fr) repeat(3,minmax(100px,130px)) auto auto;gap:8px;align-items:end;padding:10px;border-bottom:1px solid var(--border);background:var(--surface-2)'>" +
        "<div><div class='fl'>Bin Size</div><div class='m' style='font-weight:800'>" + esc(code) + "</div></div>" +
        editInput("Height mm", "binSizeHeight", row.height_mm) +
        editInput("Width mm", "binSizeWidth", row.width_mm) +
        editInput("Depth mm", "binSizeDepth", row.depth_mm) +
        "<button class='btn btn--primary btn--sm' type='submit'>Save</button>" +
        "<button class='btn btn--g btn--sm' type='button' onclick='closeBinSizeEditor()'>Cancel</button>" +
        "<div id='binSizeEditMsg' style='grid-column:1 / -1'></div>" +
      "</form>";

    document.getElementById("binSizeEditForm").addEventListener("submit", function (event) {
      event.preventDefault();
      saveBinSizeEdit();
    });
    document.getElementById("binSizeHeight").focus();
  }

  window.closeBinSizeEditor = function () {
    activeBinSizeEdit = "";
    var editor = document.getElementById("binSizeEditor");
    if (editor) {
      editor.style.display = "none";
      editor.innerHTML = "";
    }
  };

  window.saveBinSizeEdit = function () {
    var code = activeBinSizeEdit;
    var msg = document.getElementById("binSizeEditMsg");
    var height = Number(document.getElementById("binSizeHeight").value);
    var width = Number(document.getElementById("binSizeWidth").value);
    var depth = Number(document.getElementById("binSizeDepth").value);

    if (!(height > 0) || !(width > 0) || !(depth > 0)) {
      if (msg) msg.innerHTML = "<div class='alert alert--error' style='margin:0'>Height, width and depth must be positive mm values.</div>";
      return;
    }

    if (msg) msg.innerHTML = "<div class='loading-row' style='justify-content:flex-start;padding:0'><div class='spinner'></div> Saving...</div>";

    fetch("/api/admin/bin-sizes/" + encodeURIComponent(code), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ height: height, width: width, depth: depth }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) {
          if (msg) msg.innerHTML = "<div class='alert alert--error' style='margin:0'>" + esc(data.error || "Save failed") + "</div>";
          return;
        }
        activeBinSizeEdit = "";
        loadBinSizes();
      })
      .catch(function (err) {
        if (msg) msg.innerHTML = "<div class='alert alert--error' style='margin:0'>" + esc(err.message) + "</div>";
      });
  };

  function editInput(label, id, value) {
    return "<label class='fg' style='margin:0'><div class='fl'>" + esc(label) + "</div><input class='fi' id='" + attr(id) + "' type='number' min='1' step='1' value='" + attr(value || "") + "' /></label>";
  }

  // Snapshot debugger
  window.runDebug = function () {
    var col    = document.getElementById("dbgCollection").value;
    var client = document.getElementById("dbgClient").value;
    var date   = document.getElementById("dbgDate").value;
    var result = document.getElementById("dbgResult");
    result.innerHTML = "<div class='loading-row'><div class='spinner'></div> Loading snapshot…</div>";

    var url = "/api/admin/debug-snapshot?collection=" + encodeURIComponent(col) + "&client=" + encodeURIComponent(client) + (date ? "&date=" + encodeURIComponent(date) : "");
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) {
          result.innerHTML = "<div class='alert alert--error'>" + esc(data.error) + "</div>";
          return;
        }
        var html = "<div class='kv-list' style='margin-bottom:16px'>";
        html += kv("Collection",  esc(data.collection));
        html += kv("Client",      esc(data.client));
        html += kv("Date",        esc(data.date));
        html += kv("From cache",  data.fromCache ? "Yes" : "No");
        html += kv("Row count",   data.rowCount.toLocaleString());
        if (data.meta) {
          html += kv("PB row_count",    esc(data.meta.row_count));
          html += kv("Uploaded at",     esc(data.meta.uploaded_at    || "—"));
          html += kv("Source synced at",esc(data.meta.source_synced_at || "—"));
          if (data.meta.total_pick_count != null) html += kv("Total pick count", esc(data.meta.total_pick_count));
        }
        html += kv("Row keys",    '<code style="font-size:0.8rem">' + esc((data.firstRowKeys || []).join(", ") || "—") + "</code>");
        html += "</div>";

        if (data.sampleRows && data.sampleRows.length) {
          html += "<div class='card__subtitle' style='margin-bottom:8px'>First " + data.sampleRows.length + " row(s):</div>";
          html += "<pre style='font-size:0.78rem;background:var(--surface-2);padding:12px;border-radius:var(--radius-md);overflow-x:auto;color:var(--text);border:1px solid var(--border)'>" + esc(JSON.stringify(data.sampleRows, null, 2)) + "</pre>";
        } else {
          html += "<div class='alert alert--warning'>Snapshot loaded but contains 0 rows.</div>";
        }

        result.innerHTML = html;
      })
      .catch(function (err) {
        result.innerHTML = "<div class='alert alert--error'>" + esc(err.message) + "</div>";
      });
  };

  // ── Helpers ───────────────────────────────────────────────────────────
  function kv(label, valHtml) {
    return "<div class='kv-row'><span class='kv-label'>" + esc(label) + "</span><span class='kv-value'>" + valHtml + "</span></div>";
  }

  function showErr(id, msg) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = "<div class='alert alert--error' style='margin:0'>" + esc(msg) + "</div>";
  }

  function fmtInt(value) {
    var num = Number(value || 0);
    return Number.isFinite(num) ? Math.round(num).toLocaleString() : "0";
  }

  function fmtMaybe(value) {
    if (value === null || value === undefined || value === "") return "&mdash;";
    var num = Number(value);
    return Number.isFinite(num) ? Math.round(num).toLocaleString() : esc(value);
  }

  function attr(s) {
    return esc(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

})();
