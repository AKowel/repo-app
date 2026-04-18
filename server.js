"use strict";
const { startServer } = require("./server/app");

startServer().catch((error) => {
  console.error("[repo-app] Server failed to start.");
  console.error(error);
  process.exit(1);
});
