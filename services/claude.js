// ============================================================
// Anthropic Claude API クライアント
// ============================================================
// 文字起こし transcript から議事録 Markdown を生成。
//
// 環境変数:
//   ANTHROPIC_API_KEY ... API キー
//   CLAUDE_MODEL      ... モデル名 (デフォルト: claude-sonnet-4-6)
//   CLAUDE_MOCK       ... "true" でモック動作 (キー未設定時は自動 mock)
// ============================================================

const fs = require("fs");
const path = require("path");

const API_KEY    = process.env.ANTHROPIC_API_KEY || "";
const MODEL      = process.env.CLAUDE_MODEL      || "claude-sonnet-4-6";
const MOCK_MODE  = (process.env.CLAUDE_MOCK || "").toLowerCase() === "true";
const API_BASE   = "https://api.anthropic.com/v1/messages";
const API_VER    = "2023-06-01";

function isMock() { return MOCK_MODE || !API_KEY; }

// プロンプトファイルを読み込み (キャッシュ)
let _systemPromptCache = null;
function loadSystemPrompt() {
  if (_systemPromptCache) return _systemPromptCache;
  const promptPath = path.join(__dirname, "..", "prompts", "meeting-minutes-ja.md");
  _systemPromptCache = fs.readFileSync(promptPath, "utf8");
  return _systemPromptCache;
}

// transcript segments → ユーザーメッセージ
function buildUserMessage({ meta, segments }) {
  const tsLines = segments.map(s => {
    const hms = formatHMS(s.start);
    return `[${hms}] ${s.speakerLabel}: ${s.text}`;
  }).join("\n");

  const durationMin = meta?.started_at && meta?.ended_at
    ? Math.round((new Date(meta.ended_at) - new Date(meta.started_at)) / 60000)
    : "—";

  const speakers = new Set(segments.map(s => s.speakerLabel)).size;

  return `## 会議メタ情報
- 会議名: ${meta?.title || "(無題)"}
- 日時: ${meta?.started_at || "—"} 〜 ${meta?.ended_at || "—"}
- 時長(推定): ${durationMin} 分
- 場所(会議室ID): ${meta?.room_id || "—"}
- 推定話者数: ${speakers}名
- 言語: ${meta?.language || "ja-JP"}

## 文字起こし (話者分離済)
${tsLines}

上記から議事録を Markdown 形式で生成してください。`;
}

function formatHMS(sec) {
  sec = Math.floor(sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * 議事録 Markdown を生成。
 *
 * @param {object} params
 * @param {object} params.meta - { title, started_at, ended_at, room_id, language }
 * @param {Array<object>} params.segments - [{ start, speakerLabel, text }, ...]
 * @returns {Promise<{ markdown, tokensIn, tokensOut, model, mocked }>}
 */
async function generateMinutes({ meta, segments }) {
  if (isMock()) {
    return generateMockMinutes({ meta, segments });
  }

  const system = loadSystemPrompt();
  const userMsg = buildUserMessage({ meta, segments });

  const r = await fetch(API_BASE, {
    method: "POST",
    headers: {
      "x-api-key": API_KEY,
      "anthropic-version": API_VER,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: userMsg }]
    })
  });

  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Claude API failed: HTTP ${r.status} ${txt}`);
  }
  const data = await r.json();

  return {
    markdown:  data.content?.[0]?.text || "",
    tokensIn:  data.usage?.input_tokens  ?? null,
    tokensOut: data.usage?.output_tokens ?? null,
    model:     data.model || MODEL,
    mocked:    false
  };
}

/**
 * 文字起こしテキストから話者ラベルを推定する。
 * 注意: テキストだけでは本人確認はできないため、低信頼の推定は呼び出し側で採用しない。
 *
 * @param {object} params
 * @param {object} params.meta
 * @param {Array<object>} params.segments
 * @returns {Promise<Array<{index:number, speakerLabel:string, confidence:number, reason:string}>>}
 */
async function estimateSpeakerLabels({ meta, segments }) {
  if (isMock()) return [];

  const transcript = segments.map((s, i) => {
    const hms = formatHMS(s.start);
    return `${i}. [${hms}] ${s.speakerLabel}: ${s.text}`;
  }).join("\n");

  const prompt = `あなたは会議文字起こしの話者推定を支援します。
重要: 音声本人確認はできません。文字面から明確に分かる場合だけ推定し、不明なら speakerLabel は「話者未識別」にしてください。

会議情報:
- title: ${meta?.title || ""}
- room_id: ${meta?.room_id || ""}
- language: ${meta?.language || "ja-JP"}

文字起こし:
${transcript}

各行について、発言冒頭の「田中:」「佐藤さん：」のような明示的な話者名、または直前行からの明確な継続がある場合だけ speakerLabel を推定してください。
JSON配列のみを返してください。余計な説明は不要です。
形式:
[
  {"index":0,"speakerLabel":"田中","confidence":0.9,"reason":"発言冒頭に明示"},
  {"index":1,"speakerLabel":"話者未識別","confidence":0.0,"reason":"根拠なし"}
]`;

  const r = await fetch(API_BASE, {
    method: "POST",
    headers: {
      "x-api-key": API_KEY,
      "anthropic-version": API_VER,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system: "Return valid JSON only.",
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Claude speaker inference failed: HTTP ${r.status} ${txt}`);
  }

  const data = await r.json();
  const text = data.content?.[0]?.text || "[]";
  return parseJsonArray(text);
}

function parseJsonArray(text) {
  try {
    const direct = JSON.parse(text);
    return Array.isArray(direct) ? direct : [];
  } catch {
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return [];
    try {
      const parsed = JSON.parse(m[0]);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}

// ─── Mock 用 (固定形式の Markdown を返す) ────────────────────────
function generateMockMinutes({ meta, segments }) {
  const speakers = Array.from(new Set(segments.map(s => s.speakerLabel)));
  const firstText = segments[0]?.text || "(発言なし)";

  // 発言ハイライト 5件まで
  const highlights = segments.slice(0, 5).map(s => {
    const hms = formatHMS(s.start);
    return `- ${hms} ${s.speakerLabel}: ${s.text}`;
  }).join("\n");

  const markdown = `# 会議サマリ
${meta?.title || "(無題の会議)"} に関する議事録です。本日は ${speakers.length} 名が参加し、議題について議論が行われました。文字起こし対象の主な発言は ${segments.length} 件でした。

## 議題と要点
1. **冒頭の挨拶と議題確認** — ${firstText}
2. **進捗報告** — メンバーから現在状況の共有がありました
3. **次回確認事項** — 次回までのアクションを確認しました

## 発言ハイライト
${highlights}

## 決定事項
- (Mock モード: Claude API キーが設定されていません)
- 実運用時には文字起こしから自動抽出されます

## アクションアイテム
| 担当 | 内容 | 期限 |
|---|---|---|
| 未定 | API キー設定の確認 | 次回MTGまで |

## 未解決事項
- 本議事録は Mock モードで生成されています。実 Claude API を有効にしてください。
`;

  return {
    markdown,
    tokensIn:  null,
    tokensOut: null,
    model:     "mock",
    mocked:    true
  };
}

module.exports = {
  isMock,
  generateMinutes,
  estimateSpeakerLabels,
  // テスト/拡張用
  buildUserMessage,
  loadSystemPrompt,
  formatHMS,
  parseJsonArray
};
