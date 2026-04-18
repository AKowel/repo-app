"use strict";

/**
 * Escape a value for use in a PocketBase filter expression literal.
 * e.g.  pbLiteral("O'Brien") → "\"O'Brien\""
 */
function pbLiteral(value) {
  return `"${String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Format a Date (or date-like object) as "YYYY-MM-DD".
 */
function formatDateYMD(date) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Return today's date as "YYYY-MM-DD" (local time).
 */
function todayYMD() {
  return formatDateYMD(new Date());
}

/**
 * Safely parse JSON; returns null on failure.
 */
function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

module.exports = { pbLiteral, formatDateYMD, todayYMD, safeJson };
