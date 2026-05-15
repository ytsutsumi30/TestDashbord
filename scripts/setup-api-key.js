#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const dashboardDir = path.resolve(__dirname, "..");
const rootDir = path.resolve(dashboardDir, "..");
const envFiles = [
  path.join(dashboardDir, ".env"),
  path.join(rootDir, ".env.azure")
];

const rotate = process.argv.includes("--rotate");

function main() {
  const existing = rotate ? "" : findExistingKey();
  const apiKey = existing || generateApiKey();
  for (const envFile of envFiles) {
    upsertEnvValue(envFile, "TESTDASHBOARD_API_KEY", apiKey);
    console.log(`Updated ${envFile}: TESTDASHBOARD_API_KEY=${mask(apiKey)}`);
  }

  console.log("");
  console.log(existing ? "Existing API key preserved." : "New API key generated.");
  console.log("Use this value in Android settings and GitHub Pages backend dialog.");
  console.log("The full key is written only to .env files and is not printed here.");
}

function findExistingKey() {
  for (const envFile of envFiles) {
    const value = readEnvValue(envFile, "TESTDASHBOARD_API_KEY");
    if (value) return value;
  }
  return "";
}

function readEnvValue(envFile, key) {
  if (!fs.existsSync(envFile)) return "";
  const content = fs.readFileSync(envFile, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=(.*)$`));
    if (match) return unquote(match[1].trim());
  }
  return "";
}

function upsertEnvValue(envFile, key, value) {
  const lines = fs.existsSync(envFile)
    ? fs.readFileSync(envFile, "utf8").split(/\r?\n/)
    : [];
  let found = false;
  const next = lines.map(line => {
    if (line.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`))) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) {
    if (next.length && next[next.length - 1] !== "") next.push("");
    next.push("# TestDashboard public API protection");
    next.push(`${key}=${value}`);
  }
  fs.writeFileSync(envFile, next.join("\n").replace(/\n+$/, "\n"), "utf8");
}

function generateApiKey() {
  return crypto.randomBytes(32).toString("base64url");
}

function mask(value) {
  if (!value) return "(empty)";
  if (value.length <= 8) return "set";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (require.main === module) {
  main();
}

module.exports = {
  generateApiKey,
  mask,
  readEnvValue,
  upsertEnvValue
};
