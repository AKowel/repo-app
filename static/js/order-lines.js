(function () {
  "use strict";

  var PAGE_SIZE = 500;

  // ── DOM refs ──────────────────────────────────────────────────────────
  var selClient    = document.getElementById("selClient");
  var selDate      = document.getElementById("selDate");
  var inpSearch    = document.getElementById("inpSearch");
  var selChannel   = document.getElementById("selChannel");
  var selItemGroup = document.getElementById("selItemGroup");
  var btnReset     = document.getElementById("btnReset");
  var tbody        = document.getElementById("orderTableBody");
  var tableCount   = document.getElementById("tableCount");
  var pageLabel    = document.getElementById("pageLabel");
  var btnPrev      = document.getElementById("btnPrev");
  var btnNext      = document.getElementById("btnNext");
  var chipClient   = document.getElementById("chipClient");
  var chipDate     = document.getElementById("chipDate");
  var chipTotal    = document.getElementById("chipTotal");
  var chipFiltered = document.getElementById("chipFiltered");
  // Table headers (for sort)
  var thCells = document.querySelectorAll(".data-table th[data-col]");

  var drawer         = document.getElementById("transactionDrawer");
  var drawerBackdrop = document.getElementById("drawerBackdrop");
  var drawerClose    = document.getElementById("drawerClose");
  var drawerTitle    = document.getElementById("drawerTitle");
  var drawerSubtitle = document.getElementById("drawerSubtitle");
  var drawerBody     = document.getElementById("drawerBody");

  // ── State ─────────────────────────────────────────────────────────────
  var allRows      = [];
  var filteredRows = [];
  var currentPage  = 1;
  var sortCol      = null;
  var sortDir      = 1; // 1 = asc, -1 = desc
  var currentMeta  = null;

  // ── Init ──────────────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", function () {
    loadDates();

    selClient.addEventListener("change", loadDates);
    selDate.addEventListener("change", loadData);

    inpSearch.addEventListener("input",    debounce(applyFilters, 250));
    selChannel.addEventListener("change",  applyFilters);
    selItemGroup.addEventListener("change", applyFilters);
    btnReset.addEventListener("click",     resetFilters);

    btnPrev.addEventListener("click", function () { goPage(currentPage - 1); });
    btnNext.addEventListener("click", function () { goPage(currentPage + 1); });

    thCells.forEach(function (th) {
      th.addEventListener("click", function () { sortBy(th.dataset.col); });
    });

    drawerClose.addEventListener("click",   closeDrawer);
    drawerBackdrop.addEventListener("click", closeDrawer);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDrawer(); });
  });

  // ── Load dates ────────────────────────────────────────────────────────
  function loadDates() {
    var client = selClient.value;
    selDate.innerHTML = "<option value=''>Loading…</option>";
    fetch("/api/snapshot-dates?client=" + encodeURIComponent(client) + "&collection=order_lines")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        selDate.innerHTML = "";
        if (!data.ok || !data.dates || !data.dates.length) {
          selDate.innerHTML = "<option value=''>No snapshots available</option>";
          showEmpty("No order line snapshots found for this client.");
          return;
        }
        data.dates.forEach(function (d, i) {
          var opt = document.createElement("option");
          opt.value = d; opt.textContent = d;
          if (i === 0) opt.selected = true;
          selDate.appendChild(opt);
        });
        loadData();
      })
      .catch(function (err) {
        selDate.innerHTML = "<option value=''>Error</option>";
        showError("Failed to load snapshot dates: " + err.message);
      });
  }

  // ── Load order line data ──────────────────────────────────────────────
  function loadData() {
    var client = selClient.value;
    var date   = selDate.value;
    if (!client || !date) return;

    showLoading();
    updateChips(client, date, null, null);

    fetch("/api/order-lines?client=" + encodeURIComponent(client) + "&date=" + encodeURIComponent(date))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) { showError(data.error || "Request failed."); return; }
        allRows     = data.rows || [];
        currentMeta = data.meta;

        // Populate filter dropdowns from filter options
        populateSelect(selChannel,   data.filterOptions && data.filterOptions.channels    || [], "All channels");
        populateSelect(selItemGroup, data.filterOptions && data.filterOptions.item_groups || [], "All groups");

        updateChips(client, date, allRows.length, currentMeta);
        applyFilters();
      })
      .catch(function (err) {
        showError("Failed to load order lines: " + err.message);
      });
  }

  // ── Filter (client-side) ──────────────────────────────────────────────
  function applyFilters() {
    var q    = (inpSearch.value    || "").toLowerCase().trim();
    var chan  = selChannel.value   || "";
    var grp  = selItemGroup.value  || "";

    filteredRows = allRows.filter(function (r) {
      if (q && !(
        String(r.order_number    || "").toLowerCase().includes(q) ||
        String(r.item            || "").toLowerCase().includes(q) ||
        String(r.customer_name   || "").toLowerCase().includes(q)
      )) return false;
      if (chan && String(r.order_channel || "").toLowerCase() !== chan.toLowerCase()) return false;
      if (grp  && String(r.item_group   || "").toLowerCase() !== grp.toLowerCase())  return false;
      return true;
    });

    currentPage = 1;
    if (sortCol) doSort();
    renderTable();
  }

  // ── Sort ──────────────────────────────────────────────────────────────
  function sortBy(col) {
    if (sortCol === col) {
      sortDir = -sortDir;
    } else {
      sortCol = col;
      sortDir = 1;
    }
    // Update aria-sort on headers
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
    var col = sortCol;
    var dir = sortDir;
    filteredRows.sort(function (a, b) {
      var av = a[col] === undefined || a[col] === null ? "" : a[col];
      var bv = b[col] === undefined || b[col] === null ? "" : b[col];
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
    var end    = Math.min(start + PAGE_SIZE, total);
    var slice  = filteredRows.slice(start, end);

    var client = selClient.value;
    var date   = selDate.value;

    chipFiltered.textContent = total < allRows.length ? total.toLocaleString() + " shown" : "";
    tableCount.textContent   = total.toLocaleString() + " row" + (total !== 1 ? "s" : "") + (total < allRows.length ? " (filtered from " + allRows.length.toLocaleString() + ")" : "");
    pageLabel.textContent    = "Page " + currentPage + " of " + pages;
    btnPrev.disabled = currentPage <= 1;
    btnNext.disabled = currentPage >= pages;

    if (!slice.length) {
      tbody.innerHTML = "<tr><td colspan='10'>" + emptyStateHtml("No rows match your filters.") + "</td></tr>";
      return;
    }

    var html = "";
    slice.forEach(function (r) {
      html += "<tr data-order='" + escAttr(r.order_number) + "' data-item='" + escAttr(r.item) + "' data-client='" + escAttr(client) + "' data-date='" + escAttr(date) + "'>";
      html += td(r.order_number);
      html += td(r.order_line);
      html += td(r.item);
      html += td(r.fulfilment_date);
      html += td(r.qty_fulfilled);
      html += td(r.item_group);
      html += td(r.order_channel);
      html += tdLong(r.customer_name);
      html += td(r.picking_location);
      html += td(r.pick_qty);
      html += "</tr>";
    });
    tbody.innerHTML = html;

    tbody.querySelectorAll("tr[data-order]").forEach(function (row) {
      row.addEventListener("click", function () {
        openDrawer(row.dataset.client, row.dataset.date, row.dataset.order, row.dataset.item);
      });
    });
  }

  function td(val)     { return "<td>" + escHtml(val === null || val === undefined ? "—" : val) + "</td>"; }
  function tdLong(val) { return "<td style='max-width:220px' title='" + escAttr(val) + "'>" + escHtml(val || "—") + "</td>"; }

  // ── Pagination ────────────────────────────────────────────────────────
  function goPage(n) {
    var pages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
    currentPage = Math.max(1, Math.min(n, pages));
    renderTable();
  }

  // ── Drawer ────────────────────────────────────────────────────────────
  function openDrawer(client, date, orderNumber, item) {
    drawerTitle.textContent    = "Pick Transactions";
    drawerSubtitle.textContent = "Order " + orderNumber + " · " + item;
    drawerBody.innerHTML       = "<div class='loading-row'><div class='spinner'></div> Loading…</div>";
    drawer.classList.add("drawer--open");
    drawerBackdrop.classList.add("drawer-backdrop--visible");

    var url = "/api/pick-transactions?client=" + encodeURIComponent(client) +
              "&date=" + encodeURIComponent(date) +
              "&order_number=" + encodeURIComponent(orderNumber) +
              "&item=" + encodeURIComponent(item);

    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) { drawerBody.innerHTML = errorHtml(data.error || "Request failed."); return; }
        renderTransactions(data.rows || []);
      })
      .catch(function (err) {
        drawerBody.innerHTML = errorHtml("Failed to load transactions: " + err.message);
      });
  }

  function closeDrawer() {
    drawer.classList.remove("drawer--open");
    drawerBackdrop.classList.remove("drawer-backdrop--visible");
  }

  function renderTransactions(rows) {
    if (!rows.length) {
      drawerBody.innerHTML = emptyStateHtml("No transactions found for this order / item.");
      return;
    }
    var html = "<div class='table-wrap'><table class='data-table'><thead><tr>";
    html += "<th>Picker</th><th>Date</th><th>Item</th><th>Bin</th><th>Qty</th><th>Order</th>";
    html += "</tr></thead><tbody>";
    rows.forEach(function (r) {
      html += "<tr>";
      html += td(r.BTPICU);
      html += td(r.BTPICD);
      html += td(r.BAITEM);
      html += td(r.BABINL);
      html += td(r.BAQTY);
      html += td(r.BTORDN);
      html += "</tr>";
    });
    html += "</tbody></table></div>";
    html += "<p style='margin-top:12px;font-size:0.8rem;color:var(--text-soft)'>" + rows.length.toLocaleString() + " transaction" + (rows.length !== 1 ? "s" : "") + "</p>";
    drawerBody.innerHTML = html;
  }

  // ── Helpers ───────────────────────────────────────────────────────────
  function updateChips(client, date, rowCount, meta) {
    chipClient.textContent  = client || "—";
    chipDate.textContent    = date   || "—";
    chipTotal.textContent   = rowCount !== null ? rowCount.toLocaleString() + " rows" : "—";
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
    applyFilters();
  }

  function showLoading() {
    tbody.innerHTML = "<tr><td colspan='10'><div class='loading-row'><div class='spinner'></div> Loading data…</div></td></tr>";
  }

  function showEmpty(msg) {
    tbody.innerHTML = "<tr><td colspan='10'>" + emptyStateHtml(msg) + "</td></tr>";
    tableCount.textContent = "0 rows";
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

  function escHtml(s)  { return String(s === null || s === undefined ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
  function escAttr(s)  { return String(s || "").replace(/'/g,"&#39;").replace(/"/g,"&quot;"); }

  function debounce(fn, ms) {
    var t;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

})();
