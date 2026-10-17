const { getRuntimeConfig } = require("../dist/config.js");

const config = getRuntimeConfig();
if (!Number.isFinite(config.CHECK_INTERVAL_MS) || config.CHECK_INTERVAL_MS < 1000) {
    console.error("Polling interval must be a finite number of at least 1000 milliseconds.");
    process.exitCode = 1;
}
