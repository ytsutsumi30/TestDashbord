// ============================================================
// Microsoft Graph クライアント
// ============================================================
// 議事録 .docx を OneDrive (組織アカウント) へアップロードし、
// 共有リンクを取得する。
//
// 認証フロー: OAuth2 client_credentials (Application permission)
//   必要権限: Files.ReadWrite.All
//
// 環境変数:
//   MS_TENANT_ID     ... Azure AD テナント ID
//   MS_CLIENT_ID     ... App Registration の Application (client) ID
//   MS_CLIENT_SECRET ... Client Secret
//   MS_USER_UPN      ... アップロード先ユーザーのUPN (例: meetingbot@contoso.com)
//   MS_DRIVE_PATH    ... OneDrive内パス (例: /Apps/MeetingMinutes)
//   GRAPH_MOCK       ... "true" でMock動作 (キー未設定時は自動Mock)
// ============================================================

const path = require("path");
const fs = require("fs");

const TENANT_ID  = process.env.MS_TENANT_ID     || "";
const CLIENT_ID  = process.env.MS_CLIENT_ID     || "";
const CLIENT_SEC = process.env.MS_CLIENT_SECRET || "";
const USER_UPN   = process.env.MS_USER_UPN      || "";
const DRIVE_PATH = (process.env.MS_DRIVE_PATH   || "/Apps/MeetingMinutes").replace(/^\/+|\/+$/g, "");
const MOCK       = (process.env.GRAPH_MOCK || "").toLowerCase() === "true";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const TOKEN_URL  = (tenant) => `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

function isMock() {
  return MOCK || !(TENANT_ID && CLIENT_ID && CLIENT_SEC && USER_UPN);
}

// ─── トークン取得 (5分キャッシュ) ─────────────────────────────────
let _tokenCache = null; // { token, expiresAt }
async function getGraphToken() {
  if (_tokenCache && _tokenCache.expiresAt > Date.now() + 300_000) {
    return _tokenCache.token;
  }
  if (isMock()) {
    _tokenCache = { token: "mock-token", expiresAt: Date.now() + 3600_000 };
    return _tokenCache.token;
  }

  const body = new URLSearchParams({
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SEC,
    scope:         "https://graph.microsoft.com/.default",
    grant_type:    "client_credentials"
  });

  const r = await fetch(TOKEN_URL(TENANT_ID), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`getGraphToken failed: HTTP ${r.status} ${txt}`);
  }
  const data = await r.json();
  _tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000)
  };
  return _tokenCache.token;
}

// ─── ファイル名サニタイズ ─────────────────────────────────────
function sanitizeFilename(name) {
  // OneDrive で禁止される文字を除去
  return name.replace(/[\\\/:*?"<>|#%]/g, "_");
}

// ─── docx を OneDrive にアップロード ──────────────────────────
/**
 * @param {object} args
 * @param {string} args.filePath - ローカルの .docx 絶対パス
 * @param {string} args.filename - 保存ファイル名 (任意・既定はベース名)
 * @param {string} args.subFolder - DRIVE_PATH の下にサブフォルダを作る場合
 * @returns {Promise<{ driveItemId, webUrl, name, size, mocked }>}
 */
async function uploadDocxToOneDrive({ filePath, filename, subFolder = "" }) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`file not found: ${filePath}`);
  }
  const buffer = fs.readFileSync(filePath);
  const finalName = sanitizeFilename(filename || path.basename(filePath));

  if (isMock()) {
    console.log(`[graph][MOCK] upload ${finalName} (${buffer.length}B) → /${DRIVE_PATH}/${subFolder ? subFolder + "/" : ""}${finalName}`);
    return {
      driveItemId: `mock-driveitem-${Date.now()}`,
      webUrl:      `https://contoso-my.sharepoint.com/personal/${USER_UPN || "user"}/Documents/${DRIVE_PATH}/${subFolder ? subFolder + "/" : ""}${encodeURIComponent(finalName)}`,
      name:        finalName,
      size:        buffer.length,
      mocked:      true
    };
  }

  const token = await getGraphToken();
  const pathParts = [DRIVE_PATH, subFolder, finalName].filter(Boolean).join("/");
  const url = `${GRAPH_BASE}/users/${encodeURIComponent(USER_UPN)}/drive/root:/${pathParts}:/content`;

  const r = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    },
    body: buffer
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`uploadDocxToOneDrive failed: HTTP ${r.status} ${txt}`);
  }
  const data = await r.json();
  return {
    driveItemId: data.id,
    webUrl:      data.webUrl,
    name:        data.name,
    size:        data.size,
    mocked:      false
  };
}

// ─── 共有リンク作成 (組織内 view) ──────────────────────────────
/**
 * @param {object} args
 * @param {string} args.driveItemId - upload の戻り値 driveItemId
 * @param {string} args.scope       - "organization" | "anonymous" | "users"
 * @param {string} args.type        - "view" | "edit"
 * @returns {Promise<{ shareUrl, type, scope, mocked }>}
 */
async function createShareLink({ driveItemId, scope = "organization", type = "view" }) {
  if (isMock()) {
    return {
      shareUrl: `https://contoso-my.sharepoint.com/:w:/g/personal/mock/${driveItemId}`,
      type, scope,
      mocked: true
    };
  }

  const token = await getGraphToken();
  const url = `${GRAPH_BASE}/users/${encodeURIComponent(USER_UPN)}/drive/items/${driveItemId}/createLink`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type, scope })
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`createShareLink failed: HTTP ${r.status} ${txt}`);
  }
  const data = await r.json();
  return {
    shareUrl: data.link?.webUrl,
    type:     data.link?.type,
    scope:    data.link?.scope,
    mocked:   false
  };
}

// ─── ヘルパー: 1コマンドで「upload + createLink」 ─────────────
async function uploadDocxAndShare({ filePath, filename, subFolder = "" }) {
  const uploaded = await uploadDocxToOneDrive({ filePath, filename, subFolder });
  let share = { shareUrl: null, mocked: uploaded.mocked };
  try {
    share = await createShareLink({ driveItemId: uploaded.driveItemId });
  } catch (err) {
    console.warn(`[graph] createShareLink failed (continuing): ${err.message}`);
  }
  return {
    driveItemId: uploaded.driveItemId,
    webUrl:      uploaded.webUrl,
    shareUrl:    share.shareUrl,
    name:        uploaded.name,
    size:        uploaded.size,
    mocked:      uploaded.mocked
  };
}

module.exports = {
  isMock,
  getGraphToken,
  uploadDocxToOneDrive,
  createShareLink,
  uploadDocxAndShare,
  // テスト用
  sanitizeFilename
};
