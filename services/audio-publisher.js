// ============================================================
// Audio Publisher
// ============================================================
// Azure Speech から取得可能な音声URLを発行する。
//
// ローカル開発:
//   /public-audio/<token>/<filename> として Express から公開
//   (token は短時間有効・安全なランダム値)
// 本番:
//   Azure Blob Storage に upload して SAS URL を返す
//   (環境変数 PUBLISH_MODE=blob で切替)
// ============================================================

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MODE = (process.env.PUBLISH_MODE || "local").toLowerCase();
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || "http://localhost:3000"; // Tunnel URL に書換える想定
const TOKEN_TTL_MS = 60 * 60 * 1000; // 1時間

// token → { filePath, expiresAt }
const tokenStore = new Map();

function generateToken() {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * 音声ファイルを公開 URL として発行する
 * @param {string} filePath - 元の m4a ファイルパス (絶対パス)
 * @returns {Promise<{ url: string, token: string, expiresAt: string }>}
 */
async function publish(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`audio file not found: ${filePath}`);
  }

  if (MODE === "blob") {
    return await publishToBlob(filePath);
  }
  // local mode
  return publishLocal(filePath);
}

function publishLocal(filePath) {
  const token = generateToken();
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  tokenStore.set(token, { filePath, expiresAt });

  const filename = path.basename(filePath);
  const url = `${PUBLIC_BASE}/public-audio/${token}/${encodeURIComponent(filename)}`;

  console.log(`[publish][local] token=${token} → ${filePath} (expires ${new Date(expiresAt).toISOString()})`);
  return { url, token, expiresAt: new Date(expiresAt).toISOString() };
}

async function publishToBlob(filePath) {
  // Azure Blob Storage アップロード + SAS URL 発行 (本番用)
  const { BlobServiceClient, BlobSASPermissions, generateBlobSASQueryParameters, StorageSharedKeyCredential } = require("@azure/storage-blob");

  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connStr) throw new Error("AZURE_STORAGE_CONNECTION_STRING is required for blob mode");
  const containerName = process.env.AZURE_BLOB_CONTAINER || "transcripts";

  const blobServiceClient = BlobServiceClient.fromConnectionString(connStr);
  const containerClient = blobServiceClient.getContainerClient(containerName);
  await containerClient.createIfNotExists();

  const blobName = `audio/${Date.now()}-${path.basename(filePath)}`;
  const blockBlob = containerClient.getBlockBlobClient(blobName);
  await blockBlob.uploadFile(filePath, {
    blobHTTPHeaders: { blobContentType: "audio/mp4" }
  });

  // SAS URL 発行 (Read のみ、1時間有効)
  const expiresOn = new Date(Date.now() + TOKEN_TTL_MS);
  const accountInfo = parseConnectionString(connStr);
  const cred = new StorageSharedKeyCredential(accountInfo.accountName, accountInfo.accountKey);
  const sas = generateBlobSASQueryParameters({
    containerName,
    blobName,
    permissions: BlobSASPermissions.parse("r"),
    expiresOn
  }, cred).toString();

  const url = `${blockBlob.url}?${sas}`;
  console.log(`[publish][blob] blob=${blobName} (expires ${expiresOn.toISOString()})`);
  return { url, token: blobName, expiresAt: expiresOn.toISOString() };
}

function parseConnectionString(connStr) {
  const obj = {};
  for (const p of connStr.split(";")) {
    const i = p.indexOf("=");
    if (i > 0) obj[p.substring(0, i)] = p.substring(i + 1);
  }
  return { accountName: obj.AccountName, accountKey: obj.AccountKey };
}

/**
 * Express middleware: GET /public-audio/:token/:filename
 *
 * 使用例:
 *   const { localAudioMiddleware } = require("./services/audio-publisher");
 *   app.get("/public-audio/:token/:filename", localAudioMiddleware);
 */
function localAudioMiddleware(req, res) {
  const { token } = req.params;
  const entry = tokenStore.get(token);
  if (!entry) {
    return res.status(404).json({ ok: false, error: "token invalid" });
  }
  if (entry.expiresAt < Date.now()) {
    tokenStore.delete(token);
    return res.status(410).json({ ok: false, error: "token expired" });
  }
  if (!fs.existsSync(entry.filePath)) {
    return res.status(404).json({ ok: false, error: "file gone" });
  }
  res.setHeader("Content-Type", "audio/mp4");
  res.setHeader("Cache-Control", "no-store");
  fs.createReadStream(entry.filePath).pipe(res);
}

/** token を即時失効 (アップロード完了後に呼ぶ) */
function revoke(token) {
  tokenStore.delete(token);
}

/** 期限切れ token を自動掃除 (毎10分) */
setInterval(() => {
  const now = Date.now();
  for (const [t, e] of tokenStore.entries()) {
    if (e.expiresAt < now) tokenStore.delete(t);
  }
}, 10 * 60 * 1000).unref();

module.exports = { publish, localAudioMiddleware, revoke, MODE };
