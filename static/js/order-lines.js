(function () {
  "use strict";

  var PAGE_SIZE = 500;

  // ── DOM refs ──────────────────────────────────────────────────────────
  var selClient     = document.getElementById("selClient");
  var selMode       = document.getElementById("selMode");
  var grpDate       = document.getElementById("grpDate");
  var inpDate       = document.getElementById("inpDate");
  var grpRangeStart = document.getElementById("grpRangeStart");
  var grpRangeEnd   = document.getElementById("grpRangeEnd");
  var inpStart      = document.getElementById("inpStart");
  var inpEnd        = document.getElementById("inpEnd");
  var inpSearch     = document.getElementById("inpSearch");
  var selChannel    = document.getElementById("selChannel");
  var selItemGroup  = document.getElementById("selItemGroup");
  var btnReset      = document.getElementById("btnReset");
  var btnExport     = document.getElementById("btnExport");
  var tbody         = document.getElementById("orderTableBody");
  var tableCount    = document.getElementById("tableCount");
  var pageLabel     = document.getElementById("pageLabel");
  var btnPrev       = document.getElementById("btnPrev");
  var btnNext       = document.getElementById("btnNext");
  var chipClient    = document.getElementById("chipClient");
  var chipDate      = document.getElementById("chipDate");
  var chipTotal     = document.getElementById("chipTotal");
  var chipFiltered  = document.getElementById("chipFiltered");
  var thCells       = document.querySelectorAll("#orderTable th[data-col]");

  var drawer          = document.getElementById("transactionDrawer");
  var drawerBackdrop  = document.getElementById("drawerBackdrop");
  var drawerClose     = document.getElementById("drawerClose");
  var drawerTitle     = document.getElementById("drawerTitle");
  var drawerSubtitle  = document.getElementById("drawerSubtitle");
  var drawerBody      = document.getElementById("drawerBody");

  // ── Modal refs ────────────────────────────────────────────────────────
  var olExportModalBackdrop = document.getElementById("olExportModalBackdrop");
  var olExportModalBody     = document.getElementById("olExportModalBody");
  var olExportModalClose    = document.getElementById("olExportModalClose");
  var olExportModalCancel   = document.getElementById("olExportModalCancel");
  var olExportModalConfirm  = document.getElementById("olExportModalConfirm");

  // ── State ─────────────────────────────────────────────────────────────
  var allRows         = [];
  var filteredRows    = [];
  var currentPage     = 1;
  var sortCol         = null;
  var sortDir         = 1;
  var currentMeta     = null;
  var availableChannels = [];

  // ── Init ──────────────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", function () {
    syncModeUi();
    loadData();

    selClient.addEventListener("change", loadData);
    selMode.addEventListener("change",   function () { syncModeUi(); loadData(); if (!isSingleDate()) prefetchChannels(); });
    inpDate.addEventListener("change",   loadData);
    inpStart.addEventListener("change",  loadData);
    inpEnd.addEventListener("change",    loadData);

    // Single-date: client-side filter on keypress. Multi-date: debounced API call.
    inpSearch.addEventListener("input",    debounce(onFilterChange, 350));
    selChannel.addEventListener("change",  onFilterChange);
    selItemGroup.addEventListener("change", onFilterChange);

    btnReset.addEventListener("click",      resetFilters);
    btnExport.addEventListener("click",     showExportModal);
    olExportModalClose.addEventListener("click",   closeExportModal);
    olExportModalCancel.addEventListener("click",  closeExportModal);
    olExportModalConfirm.addEventListener("click", confirmExport);
    olExportModalBackdrop.addEventListener("click", function (e) {
      if (e.target === olExportModalBackdrop) closeExportModal();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { closeDrawer(); closeExportModal(); }
    });

    btnPrev.addEventListener("click", function () { goPage(currentPage - 1); });
    btnNext.addEventListener("click", function () { goPage(currentPage + 1); });

    thCells.forEach(function (th) {
      th.addEventListener("click", function () { sortBy(th.dataset.col); });
    });

    drawerClose.addEventListener("click",   closeDrawer);
    drawerBackdrop.addEventListener("click", closeDrawer);
  });

  // ── Mode helpers ──────────────────────────────────────────────────────
  function isSingleDate() {
    var m = selMode.value;
    return m === "latest" || m === "date";
  }

  function syncModeUi() {
    var mode = selMode.value;
    grpDate.style.display       = mode === "date"   ? "" : "none";
    grpRangeStart.style.display = mode === "custom" ? "" : "none";
    grpRangeEnd.style.display   = mode === "custom" ? "" : "none";
  }

  // ── Filter routing ────────────────────────────────────────────────────
  function onFilterChange() {
    if (isSingleDate()) {
      applyFiltersClientSide();
    } else {
      // Multi-date: re-fetch with filter params so server does the filtering
      loadData();
    }
  }

  // ── Build query params ────────────────────────────────────────────────
  function buildParams(includeFilters) {
    var p = new URLSearchParams();
    p.set("client", selClient.value);
    p.set("mode",   selMode.value);
    if (selMode.value === "date"   && inpDate.value)  p.set("date",  inpDate.value);
    if (selMode.value === "custom" && inpStart.value) p.set("start", inpStart.value);
    if (selMode.value === "custom" && inpEnd.value)   p.set("end",   inpEnd.value);
    if (includeFilters) {
      if (inpSearch.value.trim())  p.set("q",          inpSearch.value.trim());
      if (selChannel.value)        p.set("channel",    selChannel.value);
      if (selItemGroup.value)      p.set("item_group", selItemGroup.value);
    }
    return p;
  }

  // ── Load data from server ─────────────────────────────────────────────
  function loadData() {
    var client = selClient.value;
    if (!client) return;

    showLoading();
    updateChips(client, null, null);

    // For multi-date, always pass filter params so the server filters during merge
    var params = buildParams(!isSingleDate());

    fetch("/api/order-lines?" + params.toString())
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) { showError(data.error || "Request failed."); return; }

        allRows     = data.rows || [];
        currentMeta = data.meta || {};

        availableChannels = (data.filterOptions && data.filterOptions.channels) || [];
        populateSelect(selChannel,   availableChannels, "All channels");
        populateSelect(selItemGroup, (data.filterOptions && data.filterOptions.item_groups) || [], "All groups");

        var dates = currentMeta.window_dates || currentMeta.loaded_dates || [];
        var dateLabel = dates.length === 1 ? dates[0]
          : dates.length > 1 ? dates[dates.length - 1] + " – " + dates[0]
          : "—";
        updateChips(client, dateLabel, allRows.length);

        if (isSingleDate()) {
          applyFiltersClientSide();
        } else {
          // Multi-date: server already filtered — just render directly
          filteredRows = allRows;
          currentPage  = 1;
          if (sortCol) doSort();
          renderTable();
          renderTruncatedBanner(data.meta);
        }
      })
      .catch(function (err) { showError("Failed to load order lines: " + err.message); });
  }

  // ── Client-side filter (single-date only) ─────────────────────────────
  function applyFiltersClientSide() {
    var q    = (inpSearch.value   || "").toLowerCase().trim();
    var chan  = selChannel.value  || "";
    var grp  = selItemGroup.value || "";

    filteredRows = allRows.filter(function (r) {
      if (q && !(
        String(r.order_number  || "").toLowerCase().includes(q) ||
        String(r.item          || "").toLowerCase().includes(q) ||
        String(r.customer_name || "").toLowerCase().includes(q)
      )) return false;
      if (chan && String(r.order_channel || "").toLowerCase() !== chan.toLowerCase()) return false;
      if (grp  && String(r.item_group   || "").toLowerCase() !== grp.toLowerCase())  return false;
      return true;
    });

    currentPage = 1;
    if (sortCol) doSort();
    renderTable();
    removeTruncatedBanner();
  }

  // ── Truncated hint banner ─────────────────────────────────────────────
  function renderTruncatedBanner(meta) {
    removeTruncatedBanner();
    if (!meta || !meta.truncated) return;
    var total = (meta.window_dates || []).length;
    var banner = document.createElement("div");
    banner.id = "truncatedBanner";
    banner.style.cssText = "margin:0;padding:10px 16px;background:var(--surface-2);border-bottom:1px solid var(--border);font-family:var(--mono);font-size:11px;color:var(--text-soft);display:flex;align-items:center;gap:8px";
    banner.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
      + "Showing latest day only. Enter a search term or select a channel to search across all " + total + " dates in this window.";
    var tw = document.querySelector(".tw");
    if (tw) tw.parentNode.insertBefore(banner, tw);
  }

  function removeTruncatedBanner() {
    var b = document.getElementById("truncatedBanner");
    if (b) b.parentNode.removeChild(b);
  }

  // ── Sort ──────────────────────────────────────────────────────────────
  function sortBy(col) {
    if (sortCol === col) { sortDir = -sortDir; } else { sortCol = col; sortDir = 1; }

    thCells.forEach(function (th) {
      if (th.dataset.col === col) {
        th.setAttribute("aria-sort", sortDir === 1 ? "ascending" : "descending");
        th.querySelector(".sort-icon").textContent = sortDir === 1 ? "↑" : "↓";
      } else {
        th.removeAttribute("aria-sort");
        th.querySelector(".sort-icon").textContent = "↕";
      }
    });
    doSort();
    renderTable();
  }

  function doSort() {
    var col = sortCol, dir = sortDir;
    filteredRows.sort(function (a, b) {
      var av = a[col] == null ? "" : a[col];
      var bv = b[col] == null ? "" : b[col];
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }

  // ── Render table ──────────────────────────────────────────────────────
  function renderTable() {
    var total  = filteredRows.length;
    var pages  = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (currentPage > pages) currentPage = pages;

    var start  = (currentPage - 1) * PAGE_SIZE;
    var slice  = filteredRows.slice(start, Math.min(start + PAGE_SIZE, total));
    var client = selClient.value;
    var dates  = currentMeta && (currentMeta.loaded_dates || currentMeta.window_dates) || [];
    var date   = dates.length ? dates[0] : "";

    chipFiltered.textContent = total < allRows.length ? total.toLocaleString() + " shown" : "";
    tableCount.textContent   = total.toLocaleString() + " row" + (total !== 1 ? "s" : "")
      + (total < allRows.length ? " (filtered from " + allRows.length.toLocaleString() + ")" : "");
    pageLabel.textContent    = "Page " + currentPage + " of " + pages;
    btnPrev.disabled = currentPage <= 1;
    btnNext.disabled = currentPage >= pages;

    if (!slice.length) {
      tbody.innerHTML = "<tr><td colspan='10'>" + emptyStateHtml("No rows match your filters.") + "</td></tr>";
      return;
    }

    var html = "";
    slice.forEach(function (r) {
      var rowDate = r.fulfilment_date || date;
      html += "<tr data-order='" + escAttr(r.order_number) + "' data-item='" + escAttr(r.item)
            + "' data-client='" + escAttr(client) + "' data-date='" + escAttr(rowDate) + "'>";
      html += td(r.order_number) + td(r.order_line) + td(r.item) + td(r.fulfilment_date);
      html += td(r.qty_fulfilled) + td(r.item_group) + td(r.order_channel);
      html += tdLong(r.customer_name) + td(r.picking_location) + td(r.pick_qty);
      html += "</tr>";
    });
    tbody.innerHTML = html;

    tbody.querySelectorAll("tr[data-order]").forEach(function (row) {
      row.addEventListener("click", function () {
        openDrawer(row.dataset.client, row.dataset.date, row.dataset.order, row.dataset.item);
      });
    });
  }

  function td(val)     { return "<td>" + escHtml(val == null ? "—" : val) + "</td>"; }
  function tdLong(val) { return "<td style='max-width:220px' title='" + escAttr(val) + "'>" + escHtml(val || "—") + "</td>"; }

  // ── Pagination ────────────────────────────────────────────────────────
  function goPage(n) {
    var pages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
    currentPage = Math.max(1, Math.min(n, pages));
    renderTable();
  }

  // ── Pre-fetch channels in background when multi-date mode is selected ────
  function prefetchChannels() {
    var p = buildParams(false);
    p.set("metaOnly", "1");
    fetch("/api/order-lines?" + p.toString())
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok && data.filterOptions && data.filterOptions.channels.length) {
          availableChannels = data.filterOptions.channels;
        }
      })
      .catch(function () {});
  }

  // ── Export modal ──────────────────────────────────────────────────────
  function showExportModal() {
    if (!isSingleDate()) {
      // Fetch the full channel list across the entire window before opening
      olExportModalBody.innerHTML = '<p style="font-size:12px;color:var(--text-soft)">Loading available channels…</p>';
      olExportModalBackdrop.hidden = false;

      var p = buildParams(false);
      p.set("metaOnly", "1");
      fetch("/api/order-lines?" + p.toString())
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var chs = (data.filterOptions && data.filterOptions.channels) || availableChannels;
          renderExportModalBody(chs);
        })
        .catch(function () { renderExportModalBody(availableChannels); });
      return;
    }

    if (typeof XLSX === "undefined") { alert("Excel library not loaded. Check your connection and reload."); return; }
    var channels = availableChannels.length ? availableChannels
      : Array.from(new Set(filteredRows.map(function (r) { return r.order_channel; }).filter(Boolean))).sort();
    renderExportModalBody(channels);
    olExportModalBackdrop.hidden = false;
  }

  function renderExportModalBody(channels) {
    var chMap = (window.RepoApp.CLIENT_CHANNELS || {})[selClient.value] || {};
    olExportModalBody.innerHTML = (channels.length === 0
      ? '<p style="margin:0;font-size:12px;color:var(--text-soft)">No channel data available.</p>'
      : '<p style="margin:0 0 12px;font-size:12px;color:var(--text-soft)">Select the channels to include in the export.</p>'
        + '<div style="display:flex;flex-direction:column;gap:8px">'
        + channels.map(function (ch) {
            var desc = chMap[ch] || chMap[ch.toUpperCase()];
            return '<label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer">'
              + '<input type="checkbox" class="olExportChCb" value="' + escAttr(ch) + '" style="accent-color:var(--accent);width:13px;height:13px;cursor:pointer" checked />'
              + '<span><strong>' + escHtml(ch) + '</strong>'
              + (desc ? ' <span style="color:var(--text-soft)">— ' + escHtml(desc) + '</span>' : '')
              + '</span>'
              + '</label>';
          }).join("")
        + '</div>'
        + '<div style="margin-top:14px;display:flex;gap:8px">'
        + '<button class="btn btn--g btn--sm" id="olExportChkAll">All</button>'
        + '<button class="btn btn--g btn--sm" id="olExportChkNone">None</button>'
        + '</div>'
    );

    var allBtn  = document.getElementById("olExportChkAll");
    var noneBtn = document.getElementById("olExportChkNone");
    if (allBtn)  allBtn.addEventListener("click",  function () { document.querySelectorAll(".olExportChCb").forEach(function (cb) { cb.checked = true;  }); });
    if (noneBtn) noneBtn.addEventListener("click", function () { document.querySelectorAll(".olExportChCb").forEach(function (cb) { cb.checked = false; }); });
  }

  function closeExportModal() {
    olExportModalBackdrop.hidden = true;
  }

  function confirmExport() {
    var checked     = Array.from(document.querySelectorAll(".olExportChCb:checked")).map(function (cb) { return cb.value; });
    var allChannels = Array.from(document.querySelectorAll(".olExportChCb")).map(function (cb) { return cb.value; });
    var isAllSelected = checked.length === allChannels.length;

    closeExportModal();

    if (isSingleDate()) {
      var rows = isAllSelected ? filteredRows
        : filteredRows.filter(function (r) { return checked.indexOf(r.order_channel) !== -1; });
      if (!rows.length) { alert("No data to export for the selected channels."); return; }
      buildAndDownloadXlsx(rows, currentMeta, checked, isAllSelected);
      return;
    }

    // Multi-date: fetch binary from server, trigger download via blob URL
    var p = buildParams(false);
    if (!isAllSelected && checked.length) p.set("channels", checked.join(","));
    if (selItemGroup.value) p.set("item_group", selItemGroup.value);

    btnExport.disabled  = true;
    btnExport.innerHTML = "Exporting…";

    fetch("/api/order-lines/export?" + p.toString())
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || r.statusText); });
        var disposition = r.headers.get("Content-Disposition") || "";
        var match = disposition.match(/filename="([^"]+)"/);
        var filename = match ? match[1] : "order-lines.xlsx";
        return r.blob().then(function (blob) { return { blob: blob, filename: filename }; });
      })
      .then(function (obj) {
        var url = URL.createObjectURL(obj.blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = obj.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      })
      .catch(function (err) { alert("Export failed: " + err.message); })
      .finally(function () {
        btnExport.disabled  = false;
        btnExport.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Export .xlsx';
      });
  }

  function buildAndDownloadXlsx(rows, meta, selectedChannels, isAllSelected) {
    if (!rows.length) { alert("No data to export."); return; }

    var dates     = meta && (meta.window_dates || meta.loaded_dates) || [];
    var dateLabel = dates.length === 1 ? dates[0]
      : dates.length > 1 ? dates[dates.length - 1] + "_to_" + dates[0]
      : "export";

    var headers = ["Order No", "Line", "Item", "Date", "Qty", "Item Group", "Channel", "Customer", "Bin", "Pick Qty"];
    var wsData  = [headers].concat(rows.map(function (r) {
      return [r.order_number, r.order_line, r.item, r.fulfilment_date,
              r.qty_fulfilled, r.item_group, r.order_channel, r.customer_name,
              r.picking_location, r.pick_qty];
    }));

    var ws = XLSX.utils.aoa_to_sheet(wsData);
    ws["!cols"] = [
      { wch: 14 }, { wch: 6 }, { wch: 12 }, { wch: 12 }, { wch: 6 },
      { wch: 12 }, { wch: 20 }, { wch: 28 }, { wch: 12 }, { wch: 8 },
    ];

    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Order Lines");

    var chanPart = (!isAllSelected && selectedChannels && selectedChannels.length)
      ? "_" + selectedChannels.join("-") : "";
    XLSX.writeFile(wb, "order-lines_" + selClient.value + "_" + dateLabel + chanPart + ".xlsx");
  }

  // ── Drawer ────────────────────────────────────────────────────────────
  function openDrawer(client, date, orderNumber, item) {
    drawerTitle.textContent    = "Pick Transactions";
    drawerSubtitle.textContent = "Order " + orderNumber + " · " + item;
    drawerBody.innerHTML       = "<div class='loading-row'><div class='spinner'></div> Loading…</div>";
    drawer.classList.add("drawer--open");
    drawerBackdrop.classList.add("drawer-backdrop--visible");

    fetch("/api/pick-transactions?client=" + encodeURIComponent(client)
        + "&date=" + encodeURIComponent(date)
        + "&order_number=" + encodeURIComponent(orderNumber)
        + "&item=" + encodeURIComponent(item))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) { drawerBody.innerHTML = errorHtml(data.error || "Request failed."); return; }
        renderTransactions(data.rows || []);
      })
      .catch(function (err) { drawerBody.innerHTML = errorHtml("Failed: " + err.message); });
  }

  function closeDrawer() {
    drawer.classList.remove("drawer--open");
    drawerBackdrop.classList.remove("drawer-backdrop--visible");
  }

  function renderTransactions(rows) {
    if (!rows.length) { drawerBody.innerHTML = emptyStateHtml("No transactions found."); return; }
    var html = "<div class='table-wrap'><table class='data-table'><thead><tr>"
      + "<th>Picker</th><th>Date</th><th>Item</th><th>Bin</th><th>Qty</th><th>Order</th>"
      + "</tr></thead><tbody>";
    rows.forEach(function (r) {
      html += "<tr>" + td(r.BTPICU) + td(r.BTPICD) + td(r.BAITEM) + td(r.BABINL) + td(r.BAQTY) + td(r.BTORDN) + "</tr>";
    });
    html += "</tbody></table></div><p style='margin-top:12px;font-size:0.8rem;color:var(--text-soft)'>"
          + rows.length.toLocaleString() + " transaction" + (rows.length !== 1 ? "s" : "") + "</p>";
    drawerBody.innerHTML = html;
  }

  // ── Helpers ───────────────────────────────────────────────────────────
  function updateChips(client, dateLabel, rowCount) {
    chipClient.textContent   = client || "—";
    chipDate.textContent     = dateLabel || "—";
    chipTotal.textContent    = rowCount !== null && rowCount !== undefined ? rowCount.toLocaleString() + " rows" : "—";
    chipFiltered.textContent = "";
  }

  function populateSelect(sel, values, allLabel) {
    var current = sel.value;
    sel.innerHTML = "<option value=''>" + escHtml(allLabel) + "</option>";
    values.forEach(function (v) {
      var opt = document.createElement("option");
      opt.value = v; opt.textContent = v;
      if (v === current) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  function resetFilters() {
    inpSearch.value    = "";
    selChannel.value   = "";
    selItemGroup.value = "";
    onFilterChange();
  }

  function showLoading() {
    removeTruncatedBanner();
    tbody.innerHTML = "<tr><td colspan='10'><div class='loading-row'><div class='spinner'></div> Loading data…</div></td></tr>";
  }

  function showError(msg) {
    tbody.innerHTML = "<tr><td colspan='10'>" + errorHtml(msg) + "</td></tr>";
  }

  function emptyStateHtml(msg) {
    return "<div class='empty-state'><div class='empty-state__icon'><svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'><circle cx='12' cy='12' r='10'/><line x1='8' y1='12' x2='16' y2='12'/></svg></div><div class='empty-state__title'>No results</div><div class='empty-state__desc'>" + escHtml(msg) + "</div></div>";
  }

  function errorHtml(msg) {
    return "<div class='alert alert--error' style='margin:16px'><svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'><circle cx='12' cy='12' r='10'/><line x1='12' y1='8' x2='12' y2='12'/><line x1='12' y1='16' x2='12.01' y2='16'/></svg>" + escHtml(msg) + "</div>";
  }

  function escHtml(s)  { return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
  function escAttr(s)  { return String(s || "").replace(/'/g,"&#39;").replace(/"/g,"&quot;"); }
  function debounce(fn, ms) { var t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }

})();
