(function () {
  "use strict";

  // ── Theme switcher ────────────────────────────────────────────────────
  var THEMES = ["light", "dark", "warm"];

  function applyTheme(theme) {
    if (!THEMES.includes(theme)) theme = "light";
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("repo-theme", theme);
    document.querySelectorAll("[data-theme-target]").forEach(function (btn) {
      btn.classList.toggle("theme-btn--active", btn.dataset.themeTarget === theme);
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    // Wire theme buttons
    document.querySelectorAll("[data-theme-target]").forEach(function (btn) {
      btn.addEventListener("click", function () { applyTheme(btn.dataset.themeTarget); });
    });
    // Sync active state on load
    var saved = localStorage.getItem("repo-theme") || "light";
    document.querySelectorAll("[data-theme-target]").forEach(function (btn) {
      btn.classList.toggle("theme-btn--active", btn.dataset.themeTarget === saved);
    });
  });

  // ── Toast system ──────────────────────────────────────────────────────
  var toastContainer = null;

  function getContainer() {
    if (!toastContainer) {
      toastContainer = document.createElement("div");
      toastContainer.className = "toast-container";
      document.body.appendChild(toastContainer);
    }
    return toastContainer;
  }

  function toast(message, type) {
    if (!message) return;
    var safeType = type === "success" || type === "error" ? type : "info";
    var container = getContainer();
    var el = document.createElement("div");
    el.className = "toast toast--" + safeType;

    if (safeType === "success") {
      el.innerHTML =
        '<span class="toast__tick">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">' +
        '<polyline points="20 6 9 17 4 12"></polyline></svg></span>' +
        '<span class="toast__message">' + escapeHtml(message) + "</span>";
    } else {
      el.innerHTML = '<span class="toast__message">' + escapeHtml(message) + "</span>";
    }

    container.appendChild(el);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { el.classList.add("toast--visible"); });
    });

    var timer = setTimeout(function () { dismissToast(el); }, 3500);
    el.addEventListener("click", function () { clearTimeout(timer); dismissToast(el); });
  }

  function dismissToast(el) {
    el.classList.remove("toast--visible");
    el.addEventListener("transitionend", function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, { once: true });
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  window.RepoApp = { toast: toast };
})();
