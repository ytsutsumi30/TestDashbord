const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const setupApiKey = require("../scripts/setup-api-key");

test("generateApiKey returns a non-trivial URL-safe key", () => {
  const value = setupApiKey.generateApiKey();
  assert.match(value, /^[A-Za-z0-9_-]{32,}$/);
});

test("upsertEnvValue creates and updates env values", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-key-env-"));
  const envPath = path.join(tempDir, ".env");

  setupApiKey.upsertEnvValue(envPath, "TESTDASHBOARD_API_KEY", "first");
  assert.equal(setupApiKey.readEnvValue(envPath, "TESTDASHBOARD_API_KEY"), "first");

  setupApiKey.upsertEnvValue(envPath, "TESTDASHBOARD_API_KEY", "second");
  assert.equal(setupApiKey.readEnvValue(envPath, "TESTDASHBOARD_API_KEY"), "second");

  const occurrences = fs.readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .filter(line => line.startsWith("TESTDASHBOARD_API_KEY="));
  assert.equal(occurrences.length, 1);
});
