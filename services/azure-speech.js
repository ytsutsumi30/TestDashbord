// ============================================================
// Azure Speech Service クライアント
// ============================================================
// REST API (Batch transcription v3.1) を使用。
// 仕様: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/batch-transcription
//
// 環境変数:
//   AZURE_SPEECH_KEY     ... サブスクリプションキー
//   AZURE_SPEECH_REGION  ... リージョン (japaneast など)
//   AZURE_SPEECH_MOCK    ... "true" でモック (実APIを叩かない)
// ============================================================

const fs = require("fs");
const path = require("path");

const REGION    = process.env.AZURE_SPEECH_REGION || "japaneast";
const KEY       = process.env.AZURE_SPEECH_KEY    || "";
const MOCK_MODE = (process.env.AZURE_SPEECH_MOCK || "").toLowerCase() === "true";

function isMock() {
  return MOCK_MODE || !KEY;
}

// ─── 1. Transcription Job を submit ──────────────────────────────
async function submitTranscription({
  audioUrl,
  displayName = "meeting-transcription",
  description = "",
  locale = "ja-JP",
  speakersMin = 2,
  speakersMax = 8
}) {
  if (isMock()) {
    const mockJobId = `mock-${Date.now()}`;
    console.log(`[speech][MOCK] submit transcription: jobId=${mockJobId} audioUrl=${audioUrl}`);
    return {
      jobUrl: `mock://transcriptions/${mockJobId}`,
      jobId:  mockJobId,
      status: "NotStarted"
    };
  }

  const url = `https://${REGION}.api.cognitive.microsoft.com/speechtotext/v3.1/transcriptions`;
  const body = {
    displayName,
    description,
    locale,
    contentUrls: [audioUrl],
    properties: {
      diarizationEnabled: true,
      diarization: {
        speakers: { minCount: speakersMin, maxCount: speakersMax }
      },
      wordLevelTimestampsEnabled: true,
      punctuationMode: "DictatedAndAutomatic",
      profanityFilterMode: "Masked"
    }
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`submitTranscription failed: HTTP ${r.status} ${txt}`);
  }
  const data = await r.json();
  // data.self 例: https://japaneast...transcriptions/abc-123
  return {
    jobUrl: data.self,
    jobId:  data.self.split("/").pop(),
    status: data.status
  };
}

// ─── 2. ジョブステータス取得 ─────────────────────────────────────
async function getTranscriptionStatus(jobUrl) {
  if (isMock()) {
    // モックでは 3 回 NotStarted → Running → Succeeded の流れを模擬
    const cnt = (mockCallCount[jobUrl] = (mockCallCount[jobUrl] || 0) + 1);
    if (cnt < 2) return { status: "NotStarted" };
    if (cnt < 3) return { status: "Running"    };
    return { status: "Succeeded" };
  }

  const r = await fetch(jobUrl, {
    headers: { "Ocp-Apim-Subscription-Key": KEY }
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`getTranscriptionStatus failed: HTTP ${r.status} ${txt}`);
  }
  return await r.json();
}
const mockCallCount = {};

// ─── 3. ポーリング (Succeeded/Failed まで待つ) ─────────────────
async function pollUntilDone(jobUrl, { intervalMs = 30_000, timeoutMs = 30 * 60_000 } = {}) {
  const start = Date.now();
  // モックでは間隔短縮
  const sleep = isMock() ? 200 : intervalMs;
  while (true) {
    const s = await getTranscriptionStatus(jobUrl);
    if (s.status === "Succeeded") return s;
    if (s.status === "Failed")    throw new Error(`Transcription Failed: ${JSON.stringify(s.error || s)}`);
    if (Date.now() - start > timeoutMs) throw new Error("Transcription poll timed out");
    await new Promise(r => setTimeout(r, sleep));
  }
}

// ─── 4. 結果ファイルを取得しパース ───────────────────────────────
async function fetchTranscriptionResults(jobUrl) {
  if (isMock()) {
    return [mockTranscript()];
  }

  const filesUrl = `${jobUrl}/files`;
  const r = await fetch(filesUrl, {
    headers: { "Ocp-Apim-Subscription-Key": KEY }
  });
  if (!r.ok) throw new Error(`fetchFiles failed: HTTP ${r.status}`);
  const filesData = await r.json();

  // kind === "Transcription" のファイルを取得
  const transcriptionFiles = (filesData.values || []).filter(f => f.kind === "Transcription");
  const results = [];
  for (const f of transcriptionFiles) {
    const contentUrl = f.links?.contentUrl;
    if (!contentUrl) continue;
    const cr = await fetch(contentUrl);
    if (!cr.ok) continue;
    const json = await cr.json();
    results.push(json);
  }
  return results;
}

// ─── 5. Azure Speech 形式 → 内部 segments[] 形式へ変換 ──────────
function toSegments(azureResultJson) {
  // recognizedPhrases[] の構造を内部用に整形
  const phrases = azureResultJson.recognizedPhrases || [];
  return phrases.map((p, i) => ({
    index:    i,
    start:    parseDuration(p.offset),         // 秒
    duration: parseDuration(p.duration),
    end:      parseDuration(p.offset) + parseDuration(p.duration),
    speakerId: p.speaker ?? null,
    speakerLabel: p.speaker != null ? `Speaker ${p.speaker}` : "Unknown",
    text:     (p.nBest && p.nBest[0] && p.nBest[0].display) || "",
    confidence: (p.nBest && p.nBest[0] && p.nBest[0].confidence) || null
  }));
}

// "PT3.2S" → 3.2 のような ISO 8601 期間文字列のパース
function parseDuration(iso) {
  if (!iso) return 0;
  // "PT0S", "PT3.2S", "PT1M5.5S", "PT1H2M3S" 等
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/.exec(iso);
  if (!m) return 0;
  const h = parseFloat(m[1] || "0");
  const min = parseFloat(m[2] || "0");
  const s = parseFloat(m[3] || "0");
  return h * 3600 + min * 60 + s;
}

// ─── モック用の固定 transcript JSON ─────────────────────────────
function mockTranscript() {
  return {
    source: "MOCK",
    timestamp: new Date().toISOString(),
    durationInTicks: 60_000_000_0, // 1分
    duration: "PT60S",
    combinedRecognizedPhrases: [
      { channel: 0, lexical: "", itn: "", maskedITN: "",
        display: "本日のテスト会議の議事を開始します。本日の議題は新製品リリースの進捗です。リリース日は来月15日を予定しています。承知しました。" }
    ],
    recognizedPhrases: [
      {
        recognitionStatus: "Success",
        speaker: 1,
        channel: 0,
        offset: "PT0S",
        duration: "PT4S",
        offsetInTicks: 0,
        durationInTicks: 40_000_000,
        nBest: [{ confidence: 0.95, lexical: "", itn: "", maskedITN: "",
                  display: "本日のテスト会議の議事を開始します。" }]
      },
      {
        recognitionStatus: "Success",
        speaker: 2,
        channel: 0,
        offset: "PT4.5S",
        duration: "PT3S",
        offsetInTicks: 45_000_000,
        durationInTicks: 30_000_000,
        nBest: [{ confidence: 0.92, lexical: "", itn: "", maskedITN: "",
                  display: "承知しました。" }]
      },
      {
        recognitionStatus: "Success",
        speaker: 1,
        channel: 0,
        offset: "PT8S",
        duration: "PT6S",
        offsetInTicks: 80_000_000,
        durationInTicks: 60_000_000,
        nBest: [{ confidence: 0.93, lexical: "", itn: "", maskedITN: "",
                  display: "本日の議題は新製品リリースの進捗です。リリース日は来月15日を予定しています。" }]
      }
    ]
  };
}

// ─── 6. 全プロセスを束ねるヘルパー ─────────────────────────────
async function transcribeAudio({ audioUrl, displayName, locale = "ja-JP" }) {
  const job = await submitTranscription({ audioUrl, displayName, locale });
  const status = await pollUntilDone(job.jobUrl);
  const results = await fetchTranscriptionResults(job.jobUrl);
  const segments = results.flatMap(toSegments);
  return {
    jobId: job.jobId,
    jobUrl: job.jobUrl,
    status: status.status,
    speakerCount: new Set(segments.map(s => s.speakerId).filter(s => s != null)).size,
    wordCount: segments.reduce((a, s) => a + (s.text?.length || 0), 0),
    raw: results,
    segments
  };
}

module.exports = {
  isMock,
  submitTranscription,
  getTranscriptionStatus,
  pollUntilDone,
  fetchTranscriptionResults,
  toSegments,
  transcribeAudio
};
