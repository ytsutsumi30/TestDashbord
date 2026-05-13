const fs = require("fs");
const path = require("path");

function loadEnv(options = {}) {
  const override = options.override === true;
  const cwd = options.cwd || path.join(__dirname, "..");
  const candidates = options.paths || [
    path.join(cwd, ".env"),
    path.join(cwd, "..", ".env.azure")
  ];
  const loaded = [];
  const keys = [];

  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    const content = fs.readFileSync(envPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const parsed = parseEnvLine(line);
      if (!parsed) continue;
      const { key, value } = parsed;
      if (override || process.env[key] == null) {
        process.env[key] = value;
        keys.push(key);
      }
    }
    loaded.push(envPath);
  }

  return { loaded, keys };
}

function parseEnvLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const index = trimmed.indexOf("=");
  if (index <= 0) return null;
  const key = trimmed.slice(0, index).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  const value = unquote(trimmed.slice(index + 1).trim());
  return { key, value };
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

module.exports = { loadEnv, parseEnvLine };
