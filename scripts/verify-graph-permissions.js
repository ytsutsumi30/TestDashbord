#!/usr/bin/env node

const { loadEnv } = require("../services/env-loader");
const loaded = loadEnv();
const graph = require("../services/graph");

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const REQUIRED_ROLES = [
  "Files.ReadWrite.All",
  "OnlineMeetingTranscript.Read.All"
];
const OPTIONAL_ROLES = [
  "OnlineMeetingRecording.Read.All"
];

async function main() {
  console.log("Microsoft Graph permission diagnostics");
  console.log(`Loaded env files: ${loaded.loaded.length ? loaded.loaded.join(", ") : "(none)"}`);
  console.log("");

  if (graph.isMock()) {
    console.log("[SKIP] GRAPH_MOCK=true or Graph credentials are incomplete.");
    return;
  }

  let failed = false;
  const tokenResult = await checkToken();
  if (!tokenResult.ok) {
    process.exitCode = 1;
    return;
  }

  failed = !checkTokenRoles(tokenResult.token) || failed;
  failed = !(await checkOneDriveWrite(tokenResult.token)) || failed;
  failed = !(await checkTeamsTranscriptRead(tokenResult.token)) || failed;
  await checkTeamsRecordingList(tokenResult.token);

  console.log("");
  if (failed) {
    console.log("Graph diagnostics failed. Likely causes: missing admin consent, missing application permissions, or an inaccessible MS_USER_UPN drive.");
    process.exitCode = 1;
  } else {
    console.log("Graph diagnostics passed for required checks.");
  }
}

async function checkToken() {
  console.log("1. Client credential token");
  try {
    const token = await graph.getGraphToken();
    if (!token || token.length < 20) throw new Error("token response was empty");
    console.log("[OK] token acquired");
    return { ok: true, token };
  } catch (error) {
    console.log(`[NG] token failed: ${summarizeGraphError(error)}`);
    return { ok: false, token: null };
  }
}

function checkTokenRoles(token) {
  console.log("");
  console.log("2. Application permission roles in access token");
  const roles = parseJwtRoles(token);
  if (!roles.length) {
    console.log("[NG] token has no roles claim. Admin consent is likely not granted.");
    return false;
  }

  console.log(`[OK] roles: ${roles.join(", ")}`);
  const missing = REQUIRED_ROLES.filter(role => !roles.includes(role));
  const optionalMissing = OPTIONAL_ROLES.filter(role => !roles.includes(role));
  if (missing.length) {
    console.log(`[NG] missing required roles: ${missing.join(", ")}`);
    return false;
  }
  if (optionalMissing.length) {
    console.log(`[WARN] missing optional roles: ${optionalMissing.join(", ")} (required for Teams recording download)`);
  }
  return true;
}

async function checkOneDriveWrite(token) {
  console.log("");
  console.log("3. OneDrive write/delete check");
  const userUpn = requireEnv("MS_USER_UPN");
  const drivePath = normalizeDrivePath(process.env.MS_DRIVE_PATH || "/Apps/MeetingMinutes");
  const fileName = `_diagnostics/graph-permission-check-${Date.now()}.txt`;
  const graphPath = [drivePath, fileName].filter(Boolean).join("/");
  const url = `${GRAPH_BASE}/users/${encodeURIComponent(userUpn)}/drive/root:/${encodeGraphPath(graphPath)}:/content`;

  let itemId = null;
  try {
    const response = await graphFetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/plain; charset=utf-8"
      },
      body: `Graph permission diagnostics ${new Date().toISOString()}\n`
    });
    const data = await response.json();
    itemId = data.id;
    console.log(`[OK] uploaded test file: ${data.name || fileName}`);
  } catch (error) {
    console.log(`[NG] OneDrive write failed: ${summarizeGraphError(error)}`);
    return false;
  }

  if (!itemId) return true;
  try {
    const deleteUrl = `${GRAPH_BASE}/users/${encodeURIComponent(userUpn)}/drive/items/${encodeURIComponent(itemId)}`;
    await graphFetch(deleteUrl, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      allowNoContent: true
    });
    console.log("[OK] deleted test file");
    return true;
  } catch (error) {
    console.log(`[WARN] test file delete failed: ${summarizeGraphError(error)}`);
    return true;
  }
}

async function checkTeamsTranscriptRead(token) {
  console.log("");
  console.log("4. Teams transcript read check");
  const meetingId = process.env.GRAPH_DIAGNOSTIC_MEETING_ID || "";
  const transcriptId = process.env.GRAPH_DIAGNOSTIC_TRANSCRIPT_ID || "";
  if (!meetingId || !transcriptId) {
    console.log("[SKIP] set GRAPH_DIAGNOSTIC_MEETING_ID and GRAPH_DIAGNOSTIC_TRANSCRIPT_ID to test real transcript content access.");
    return true;
  }

  const url = `${GRAPH_BASE}/communications/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(transcriptId)}/content?$format=text/vtt`;
  try {
    const response = await graphFetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "text/vtt" }
    });
    const text = await response.text();
    console.log(`[OK] transcript content read (${text.length} chars)`);
    return true;
  } catch (error) {
    console.log(`[NG] Teams transcript read failed: ${summarizeGraphError(error)}`);
    return false;
  }
}

async function checkTeamsRecordingList(token) {
  console.log("");
  console.log("5. Teams recording list check");
  const meetingId = process.env.GRAPH_DIAGNOSTIC_MEETING_ID || "";
  if (!meetingId) {
    console.log("[SKIP] set GRAPH_DIAGNOSTIC_MEETING_ID to test recording list access.");
    return true;
  }

  const userUpn = requireEnv("MS_USER_UPN");
  const url = `${GRAPH_BASE}/users/${encodeURIComponent(userUpn)}/onlineMeetings/${encodeURIComponent(meetingId)}/recordings`;
  try {
    const response = await graphFetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    });
    const data = await response.json();
    console.log(`[OK] recording list read (${Array.isArray(data.value) ? data.value.length : 0} items)`);
    return true;
  } catch (error) {
    console.log(`[WARN] Teams recording list failed: ${summarizeGraphError(error)}`);
    return false;
  }
}

async function graphFetch(url, options = {}) {
  const response = await fetch(url, options);
  if (response.ok || (options.allowNoContent && response.status === 204)) return response;
  const text = await response.text();
  const error = new Error(`HTTP ${response.status} ${text}`);
  error.status = response.status;
  error.body = text;
  throw error;
}

function parseJwtRoles(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return [];
    const payload = JSON.parse(Buffer.from(base64UrlToBase64(parts[1]), "base64").toString("utf8"));
    return Array.isArray(payload.roles) ? payload.roles.slice().sort() : [];
  } catch {
    return [];
  }
}

function summarizeGraphError(error) {
  const message = String(error?.message || error || "");
  const status = error?.status || (message.match(/HTTP\s+(\d+)/)?.[1] ?? "");
  const body = parseErrorBody(error?.body || message);
  const code = body?.error?.code || body?.code || "";
  const graphMessage = body?.error?.message || body?.message || "";
  const hint = permissionHint(status, code, graphMessage || message);
  return [status ? `HTTP ${status}` : "", code, graphMessage || message, hint].filter(Boolean).join(" / ");
}

function permissionHint(status, code, message) {
  const value = `${status} ${code} ${message}`.toLowerCase();
  if (value.includes("authorization_requestdenied") || value.includes("insufficient privileges") || value.includes("accessdenied")) {
    return "hint: grant admin consent for required Microsoft Graph application permissions";
  }
  if (value.includes("unauthorized") || value.includes("401")) {
    return "hint: verify app secret, admin consent, and tenant/client IDs";
  }
  if (value.includes("itemnotfound") || value.includes("resource not found") || value.includes("404")) {
    return "hint: verify MS_USER_UPN, OneDrive provisioning, meetingId, and transcriptId";
  }
  return "";
}

function parseErrorBody(text) {
  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function normalizeDrivePath(value) {
  return String(value || "").replace(/^\/+|\/+$/g, "");
}

function encodeGraphPath(value) {
  return String(value || "")
    .split("/")
    .filter(Boolean)
    .map(part => encodeURIComponent(part))
    .join("/");
}

function requireEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function base64UrlToBase64(value) {
  const padded = String(value).replace(/-/g, "+").replace(/_/g, "/");
  return padded + "=".repeat((4 - padded.length % 4) % 4);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[FATAL] ${summarizeGraphError(error)}`);
    process.exit(1);
  });
}

module.exports = {
  parseJwtRoles,
  summarizeGraphError,
  permissionHint,
  encodeGraphPath,
  normalizeDrivePath
};
