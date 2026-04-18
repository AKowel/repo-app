"use strict";
const { config }          = require("../server/config");
const { PocketBaseClient } = require("../server/pocketbaseClient");

const REQUIRED = [
  "warehouse_binloc_snapshots",
  "warehouse_pick_activity_snapshots",
  "warehouse_order_line_snapshots",
  "warehouse_pick_transaction_snapshots",
];

(async function () {
  const pb = new PocketBaseClient({
    baseUrl:       config.pocketbaseUrl,
    adminEmail:    config.pocketbaseAdminEmail,
    adminPassword: config.pocketbaseAdminPassword,
  });

  console.log("[verify] Connecting to PocketBase at", config.pocketbaseUrl);

  let collections;
  try {
    collections = await pb.listCollections();
  } catch (err) {
    console.error("[verify] ✗ Could not connect to PocketBase:", err.message);
    process.exit(1);
  }

  const names = new Set(collections.map(c => c.name));
  let allOk = true;

  for (const col of REQUIRED) {
    if (names.has(col)) {
      console.log("[verify] ✓", col);
    } else {
      console.error("[verify] ✗ MISSING:", col);
      allOk = false;
    }
  }

  if (!allOk) {
    console.error("\n[verify] Some required collections are missing. Ensure PI-App has synced at least once.");
    process.exit(1);
  }

  console.log("\n[verify] All required collections present. ✓");
  process.exit(0);
})();
