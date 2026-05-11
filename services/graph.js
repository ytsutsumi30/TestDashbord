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

// ─── Teams 会議文字起こし取得 ────────────────────────────────────
/**
 * Microsoft Graph から Teams 会議のトランスクリプト (VTT) を取得し
 * job-processor が扱う segments 配列に変換して返す。
 *
 * 必要権限: OnlineMeetingTranscript.Read.All (Application)
 *
 * @param {string} meetingId    - onlineMeetings の id
 * @param {string} transcriptId - transcripts の id
 * @returns {Promise<{ segments: Array, raw: string, mocked: boolean }>}
 */
async function getTeamsTranscript(meetingId, transcriptId) {
  if (isMock()) {
    console.log(`[graph][MOCK] getTeamsTranscript meetingId=${meetingId} transcriptId=${transcriptId}`);
    return {
      segments: _mockSegments(),
      raw: "",
      mocked: true
    };
  }

  const token = await getGraphToken();
  const url = `${GRAPH_BASE}/communications/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(transcriptId)}/content?$format=text/vtt`;

  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "text/vtt" }
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`getTeamsTranscript failed: HTTP ${r.status} ${txt}`);
  }
  const vttText = await r.text();
  const segments = parseVttToSegments(vttText);
  return { segments, raw: vttText, mocked: false };
}

/**
 * VTT 文字列を segments 配列に変換する。
 *   入力例:
 *     WEBVTT
 *
 *     00:00:01.000 --> 00:00:05.000
 *     <v 田中>こんにちは、本日の会議を始めます。</v>
 *
 * @param {string} vttText
 * @returns {Array<{ start: number, end: number, speakerLabel: string, text: string }>}
 */
function parseVttToSegments(vttText) {
  const segments = [];
  const cueRegex = /(\d{2}:\d{2}:\d{2}[.,]\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*\n([\s\S]*?)(?=\n\n|\n*$)/g;

  let match;
  while ((match = cueRegex.exec(vttText)) !== null) {
    const startSec = _vttTimeToSec(match[1]);
    const endSec   = _vttTimeToSec(match[2]);
    const rawText  = match[3].trim();

    // <v SpeakerName>text</v> 形式をパース
    const vTagMatch = rawText.match(/^<v\s+([^>]+)>([\s\S]*?)<\/v>$/s);
    if (vTagMatch) {
      segments.push({
        start:       startSec,
        end:         endSec,
        speakerLabel: vTagMatch[1].trim(),
        text:        vTagMatch[2].trim()
      });
    } else {
      // タグなし: speakerLabel を "Unknown" として扱う
      const plain = rawText.replace(/<[^>]+>/g, "").trim();
      if (plain) {
        segments.push({ start: startSec, end: endSec, speakerLabel: "Unknown", text: plain });
      }
    }
  }
  return segments;
}

function _vttTimeToSec(ts) {
  // "HH:MM:SS.mmm" or "HH:MM:SS,mmm"
  const cleaned = ts.replace(",", ".");
  const parts = cleaned.split(":");
  const hh = parseFloat(parts[0] || 0);
  const mm = parseFloat(parts[1] || 0);
  const ss = parseFloat(parts[2] || 0);
  return hh * 3600 + mm * 60 + ss;
}

function _mockSegments() {
  return [
    { start: 0,   end: 5,   speakerLabel: "田中",   text: "本日の会議を始めます。先週の進捗から確認させてください。" },
    { start: 6,   end: 12,  speakerLabel: "鈴木",   text: "ご報告します。先週のタスクは予定通り完了しています。" },
    { start: 13,  end: 20,  speakerLabel: "田中",   text: "ありがとうございます。次はシステム統合テストの件はいかがでしょうか。" },
    { start: 21,  end: 30,  speakerLabel: "佐藤",   text: "テストコードを作成中です。今週末には完了できる見込みです。" },
    { start: 31,  end: 38,  speakerLabel: "田中",   text: "了解しました。それでは以上で本日の会議を終了します。" }
  ];
}

module.exports = {
  isMock,
  getGraphToken,
  uploadDocxToOneDrive,
  createShareLink,
  uploadDocxAndShare,
  getTeamsTranscript,
  parseVttToSegments,
  // テスト用
  sanitizeFilename
};
