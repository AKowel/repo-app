(function () {
  "use strict";

  var THEMES = ["carbon", "terminal", "ember", "light", "frost", "warm"];
  var LEGACY_MAP = { dark: "carbon" }; // migrate old theme names

  function applyTheme(theme) {
    if (LEGACY_MAP[theme]) theme = LEGACY_MAP[theme];
    if (!THEMES.includes(theme)) theme = "carbon";
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("repo-theme", theme);
    document.querySelectorAll("[data-theme-target]").forEach(function (el) {
      el.classList.toggle("tdot--on", el.dataset.themeTarget === theme);
      el.classList.toggle("theme-btn--active", el.dataset.themeTarget === theme);
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("[data-theme-target]").forEach(function (el) {
      el.addEventListener("click", function () { applyTheme(el.dataset.themeTarget); });
    });
    var saved = localStorage.getItem("repo-theme") || "carbon";
    applyTheme(saved);
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
        '<span class="toast__tick"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></span>' +
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

  // ── Settings system ───────────────────────────────────────────────────
  var SETTING_DEFAULTS = {
    'nav-layout':   'B',
    'audit-layout': 'C'
  };

  function getSetting(key) {
    return localStorage.getItem('repo-setting-' + key) || SETTING_DEFAULTS[key];
  }

  function applySetting(key, value) {
    document.documentElement.setAttribute('data-' + key, String(value || ''));
  }

  function saveSetting(key, value) {
    localStorage.setItem('repo-setting-' + key, value);
    applySetting(key, value);
  }

  function syncSettingButtons() {
    document.querySelectorAll('[data-setting]').forEach(function (btn) {
      btn.classList.toggle('settings-option--active', getSetting(btn.dataset.setting) === btn.dataset.value);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    // Apply all settings (data attrs are set in <head> to prevent flash;
    // this ensures JS state stays in sync after any dynamic DOM changes)
    Object.keys(SETTING_DEFAULTS).forEach(function (key) {
      applySetting(key, getSetting(key));
    });

    // Settings modal open/close
    var backdrop = document.getElementById('settingsBackdrop');
    var settingsBtn = document.getElementById('settingsBtn');
    var settingsClose = document.getElementById('settingsClose');

    if (settingsBtn) {
      settingsBtn.addEventListener('click', function () {
        syncSettingButtons();
        if (backdrop) backdrop.hidden = false;
      });
    }
    if (settingsClose) {
      settingsClose.addEventListener('click', function () { if (backdrop) backdrop.hidden = true; });
    }
    if (backdrop) {
      backdrop.addEventListener('click', function (e) {
        if (e.target === backdrop) backdrop.hidden = true;
      });
      backdrop.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') backdrop.hidden = true;
      });
    }

    // Settings choice buttons
    document.querySelectorAll('[data-setting]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        saveSetting(btn.dataset.setting, btn.dataset.value);
        syncSettingButtons();
      });
    });
  });

  var CLIENT_CHANNELS = {
    FANDMKET: {
      B: "Build Your Own",
      C: "Customer Web",
      F: "Fresh only",
      H: "Hamper",
      L: "Large orders",
      N: "Store scan to carton",
      P: "Concierge VIP Orders",
      S: "Store replen",
      W: "Wholesale",
    },
    WESTLAND: {
      B: "Bulk Retail",
      E: "External wooden products",
      F: "Ferts & Chems RAW MATERIAL",
      G: "Growing Media Raw Material",
      L: "Large Retail",
      R: "Retail",
      W: "Wholesale",
    },
  };

  window.RepoApp = { toast: toast, CLIENT_CHANNELS: CLIENT_CHANNELS };
})();
