(function () {
  "use strict";

  document.addEventListener("DOMContentLoaded", function () {
    loadStatus();
    loadSnapshotSummary();
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

  // ── Snapshot debugger ─────────────────────────────────────────────────
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

  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

})();
